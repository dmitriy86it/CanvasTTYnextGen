// Injectable test agents for the orchestration cycle (stage-5-contract.md §3). No CLI, no model: each turn follows a
// script. A turn may edit files, but only inside the temporary copy it was given (req.cwd); anything else throws.
// Production code never imports this file.
//
// createTestAgents(handlers): handlers[purpose] is an action or (req, n) => action, n = 1-based count for that purpose.
// action: {
//   report?: object          the structured answer (valid by default when given)
//   outcome?: TurnOutcome     default "completed"; anything else is reported with report status "not_checked"
//   delayMs?: number          before the turn settles
//   hold?: Promise            the turn settles only after this resolves (then delayMs)
//   edit?: (repo) => void     applied to the copy just before the turn settles
//   ignoreStop?: boolean      stop() is recorded but the turn still settles as scripted (a late answer)
//   refuse?: string           prepare() refuses with unsupported_capability and this detail
//   throwOnStart?: boolean
// }
import { randomUUID } from "node:crypto";
import path from "node:path";
import { failedTurnResult } from "../../../src/main/services/orchestration/agents.ts";

export function createTestAgents(handlers) {
  const counts = {};
  const sessions = {};
  const log = []; // { purpose, role, task, timeoutMs, sessionId, stopped, settled }
  let active = 0;
  const agents = {
    log,
    get active() { return active; },
    prepare(req) {
      counts[req.purpose] = (counts[req.purpose] ?? 0) + 1;
      const h = handlers[req.purpose];
      if (h === undefined) throw new Error(`test agents: no handler for ${req.purpose}`);
      const action = typeof h === "function" ? h(req, counts[req.purpose]) : h;
      if (action.refuse) return { ok: false, reason: "unsupported_capability", detail: action.refuse };
      return {
        ok: true, provider: req.role === "lead" ? "codex" : "claude", mode: "test",
        start() {
          if (action.throwOnStart) throw new Error("test agents: start failed");
          const sessionId = req.sessionId ?? (sessions[req.role] ??= randomUUID());
          const entry = { purpose: req.purpose, role: req.role, task: req.task, timeoutMs: req.timeoutMs, sessionId, stopped: false, settled: false };
          log.push(entry);
          active++;
          let settle;
          const result = new Promise((resolve) => { settle = resolve; });
          const finish = (r) => {
            if (entry.settled) return;
            entry.settled = true;
            active--;
            settle(r);
          };
          (async () => {
            if (action.hold) await action.hold;
            if (action.delayMs) await new Promise((r) => setTimeout(r, action.delayMs));
            if (entry.settled) return;
            if (action.edit) action.edit(guarded(req.cwd));
            finish(turnResult(action.outcome ?? "completed", action.report, sessionId));
          })().catch((e) => finish(failedTurnResult("harness_error", String(e?.message ?? e), sessionId)));
          return {
            sessionId,
            stop() {
              entry.stopped = true;
              if (!action.ignoreStop) finish(turnResult("stopped", undefined, sessionId));
            },
            result
          };
        }
      };
    }
  };
  return agents;
}

function turnResult(outcome, report, sessionId) {
  const r = failedTurnResult(outcome, outcome === "completed" ? "test turn" : `test turn: ${outcome}`, sessionId);
  const ok = outcome === "completed";
  r.transport.outcome = outcome;
  r.transport.transport = { status: ok ? "completed" : outcome === "stopped" ? "stopped" : "failed", reason: null };
  r.transport.process.exitCode = ok ? 0 : null;
  r.transport.process.supervisorDone = true;
  r.contract = { status: "verified", errors: [], expected: { sessionId }, actual: { sessionId } };
  r.report = ok && report !== undefined ? { status: "valid", value: report } : { status: ok ? "missing" : "not_checked" };
  r.transport.report = r.report;
  r.outcome = ok && report === undefined ? "invalid_report" : outcome;
  r.transport.outcome = r.outcome;
  r.nextTurnAllowed = r.outcome === "completed";
  r.transport.nextTurnAllowed = r.nextTurnAllowed;
  return r;
}

// fs helpers confined to the copy: a path outside it is a test bug, not something to allow.
function guarded(repo) {
  const inside = (rel) => {
    const p = path.resolve(repo, rel);
    if (p !== repo && !p.startsWith(repo + path.sep)) throw new Error(`test agents: ${rel} is outside the copy`);
    return p;
  };
  return { repo, path: inside };
}

// Ready-made reports.
export const plan = (...stages) => ({ stages: stages.map((s) => typeof s === "string" ? { title: s, task: `do ${s}` } : s), question: null });
export const executed = (summary = "done") => ({ summary, done: true });
export const review = (verdict, findings = [], question = null) => ({ verdict, findings, question });
