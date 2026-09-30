// Agents of the orchestration cycle (stage-5-contract.md §3). The service talks to an AgentAdapter only: `prepare`
// decides before anything is journaled whether this turn can run at all, `start` runs it after turn.intent is on disk.
// The real adapter is built on startProviderTurn (stage 1): the lead is Codex structured-readonly (proven). The
// executor is Claude structured-edit (stage-6-contract.md §2-3), a CANDIDATE mode: it runs only when the config names
// an executor and allows candidates; its limits are CLI permission policy, not a proven isolation boundary. Without an
// executor, an executor turn is refused as unsupported instead of being presented as one.
import type { AgentAccess } from "./access.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildNativeTurn, buildProviderTurn, startNativeTurn, startProviderTurn } from "./providers.ts";
import type { NativeTurnInput, ProviderTurnInput, ProviderTurnResult } from "./providers.ts";
import { DEFAULT_TURN_LIMITS } from "./turn.ts";
import type { AnswerSchema, SupervisorLaunch, TurnObserver, TurnOutcome, TurnResult } from "./types.ts";
import type { AskPerson } from "./sessions.ts";

export type TurnPurpose = "plan" | "execute" | "review" | "final_review";
export type AgentRole = "lead" | "executor";

export interface AgentTurnRequest {
  purpose: TurnPurpose;
  role: AgentRole;
  cwd: string; // the managed copy (stage 3)
  task: string;
  schema: AnswerSchema;
  sessionId: string | null; // resume of the same role's session
  timeoutMs: number;
  ask?: AskPerson; // stage 12: where the CLI's permission prompts and questions go (the person); required by sessions
  access?: AgentAccess; // stage 13: the run's rights mode per CLI
}

export interface AgentTurn {
  sessionId: string | null;
  stop(): void;
  result: Promise<ProviderTurnResult>;
}

export type AgentPrepared =
  | { ok: true; provider: "codex" | "claude"; mode: string; start(observer?: TurnObserver): AgentTurn }
  | { ok: false; reason: "unsupported_capability" | "unavailable"; detail: string };

export interface AgentAdapter {
  prepare(req: AgentTurnRequest): AgentPrepared;
}

// A turn that never produced a provider result (start threw, the adapter rejected): harness_error, never a next turn.
export function failedTurnResult(outcome: TurnOutcome, reason: string, sessionId: string | null = null): ProviderTurnResult {
  const transport: TurnResult = {
    outcome, transport: { status: "failed", reason }, report: { status: "not_checked" },
    delivery: { status: "unconfirmed", errors: [] }, sessionId, sessionEvent: null, sessionMismatch: false,
    stopCause: null, nextTurnAllowed: false,
    process: { exitCode: null, signal: null, stdoutEnded: false, signalsToLeader: [], groupCleared: true, supervisorExitCode: null, supervisorDone: false },
    counters: { stdoutBytes: 0, frames: 0, keptEvents: 0, droppedEvents: 0, droppedEventBytes: 0, stderrBytes: 0, stderrDroppedBytes: 0, droppedDiagnostics: 0 },
    history: [], terminal: null, errors: [], stderr: { head: "", tail: "", bytes: 0, droppedBytes: 0 },
    diagnostics: [{ at: 0, what: reason.slice(0, 200) }], timeline: [], pids: { supervisor: null, pgid: null }, reportFile: null
  };
  return {
    outcome, nextTurnAllowed: false, sessionId, report: { status: "not_checked" },
    contract: { status: "violated", errors: [reason.slice(0, 256)], expected: { sessionId }, actual: { sessionId } },
    transport
  };
}

export interface ProviderAgentsConfig {
  // The lead's CLI and its environment; everything else of the turn is decided per request.
  lead: Pick<ProviderTurnInput, "cli" | "cliVersion" | "env" | "model" | "modelParams">;
  // Claude structured-edit; allowCandidate must be true for the candidate mode to run at all.
  executor?: Pick<ProviderTurnInput, "cli" | "cliVersion" | "env" | "model" | "maxBudgetUsd"> & { allowCandidate?: boolean };
  launch: SupervisorLaunch;
  attemptRoot: string; // absolute; one fresh directory per Codex turn (schema and report files)
}

export function createProviderAgents(cfg: ProviderAgentsConfig): AgentAdapter {
  return {
    prepare(req) {
      if (req.role === "executor") return prepareExecutor(cfg, req);
      if (cfg.lead.cli.provider !== "codex") {
        return { ok: false, reason: "unsupported_capability", detail: `the lead runs only as Codex structured-readonly, not ${cfg.lead.cli.provider}` };
      }
      const input: ProviderTurnInput = {
        ...cfg.lead, mode: "structured-readonly", cwd: req.cwd, schema: req.schema, task: req.task,
        attemptDir: join(cfg.attemptRoot, randomUUID()),
        session: req.sessionId ? { kind: "resume", id: req.sessionId } : { kind: "new" },
        limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: req.timeoutMs }
      };
      const built = buildProviderTurn(input); // pure: refuses unsupported versions, launchers and input
      if (!built.ok) return { ok: false, reason: "unavailable", detail: `${built.reason}: ${built.detail}` };
      return {
        ok: true, provider: "codex", mode: "structured-readonly",
        start(observer) {
          mkdirSync(input.attemptDir as string, { recursive: false, mode: 0o700 });
          const turn = startProviderTurn(input, cfg.launch, observer);
          if (!turn.ok) throw new Error(`${turn.reason}: ${turn.detail}`);
          return { sessionId: turn.sessionId, stop: turn.stop, result: turn.result };
        }
      };
    }
  };
}

function prepareExecutor(cfg: ProviderAgentsConfig, req: AgentTurnRequest): AgentPrepared {
  if (!cfg.executor) {
    return {
      ok: false, reason: "unsupported_capability",
      detail: "no executor configured: Claude structured-no-tools cannot change the working copy (stage-5-contract.md §3)"
    };
  }
  const { allowCandidate, ...executor } = cfg.executor;
  if (executor.cli.provider !== "claude") {
    return { ok: false, reason: "unsupported_capability", detail: `the executor runs only as Claude structured-edit, not ${executor.cli.provider}` };
  }
  const input: ProviderTurnInput = {
    ...executor, mode: "structured-edit", candidate: allowCandidate === true, cwd: req.cwd, schema: req.schema, task: req.task,
    session: req.sessionId ? { kind: "resume", id: req.sessionId } : { kind: "new" },
    limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: req.timeoutMs }
  };
  const built = buildProviderTurn(input);
  if (!built.ok) return { ok: false, reason: "unavailable", detail: `${built.reason}: ${built.detail}` };
  // A new session gets the id chosen by this build, not a fresh one on start.
  const started: ProviderTurnInput = input.session.kind === "resume" ? input : { ...input, session: { kind: "new", id: built.sessionId as string } };
  return {
    ok: true, provider: "claude", mode: "structured-edit",
    start(observer) {
      const turn = startProviderTurn(started, cfg.launch, observer);
      if (!turn.ok) throw new Error(`${turn.reason}: ${turn.detail}`);
      return { sessionId: turn.sessionId, stop: turn.stop, result: turn.result };
    }
  };
}

// ---------------- stage 12: the CLIs as the user runs them ----------------
// Codex and Claude with the user's own configuration and environment in the work folder. Roles are duties written into
// the task; no tool is removed for a role. A turn without a person to ask (no `ask`) is refused: a prompt must never
// be answered by nobody.
export interface NativeAgentsConfig {
  clis: Record<"codex" | "claude", { cli: ProviderTurnInput["cli"]; cliVersion: string }>;
  roles: { lead: "codex" | "claude"; executor: "codex" | "claude" };
  env: Readonly<Record<"codex" | "claude", Readonly<Record<string, string>>>>; // the login-shell environment of the work folder
  launch: SupervisorLaunch;
  clientVersion: string;
}

export function createNativeAgents(cfg: NativeAgentsConfig): AgentAdapter {
  return {
    prepare(req) {
      const provider = cfg.roles[req.role];
      if (!req.ask) return { ok: false, reason: "unavailable", detail: "no one to ask the CLI's permission prompts" };
      const input: NativeTurnInput = {
        cli: cfg.clis[provider].cli, cliVersion: cfg.clis[provider].cliVersion, cwd: req.cwd, env: cfg.env[provider],
        task: req.task, schema: req.schema, ask: req.ask, clientVersion: cfg.clientVersion,
        session: req.sessionId ? { kind: "resume", id: req.sessionId } : { kind: "new" },
        limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: req.timeoutMs },
        ...(req.access ? { access: req.access } : {})
      };
      const built = buildNativeTurn(input);
      if (!built.ok) return { ok: false, reason: "unavailable", detail: `${built.reason}: ${built.detail}` };
      // Claude: the session id chosen by this build; Codex: the thread id comes from the app-server.
      const started: NativeTurnInput = input.session.kind === "new" && built.sessionId ? { ...input, session: { kind: "new", id: built.sessionId } } : input;
      return {
        ok: true, provider, mode: "native",
        start(observer) {
          const turn = startNativeTurn(started, cfg.launch, observer);
          if (!turn.ok) throw new Error(`${turn.reason}: ${turn.detail}`);
          return { sessionId: turn.sessionId, stop: turn.stop, result: turn.result };
        }
      };
    }
  };
}
