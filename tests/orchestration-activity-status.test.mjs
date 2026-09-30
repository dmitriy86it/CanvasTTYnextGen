// What a run is doing and what it ended with (runStatus.ts): the rules behind the home widget, the agent cards and the
// run summary. Pure checks with anonymised fixtures shaped like real journals; no Electron, no CLI.
import assert from "node:assert/strict";
import test from "node:test";
import {
  activityRuns, isServiceEntry, outcomeKey, reportParts, roleStatus, runStatus, stateLabel, summaryModel
} from "../src/renderer/src/features/orchestration/runStatus.ts";
import { t } from "../src/renderer/src/lib/i18n.ts";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const ts = (s) => new Date(T0 + s * 1000).toISOString();
const view = (over = {}) => ({ runId: "run-a", status: "running", reason: null, revision: 3, stage: 3, turns: 7, halted: false, active: null, ...over });
const turn = (purpose) => ({ kind: "turn", purpose });
let id = 0;
const entry = (role, kind, text = "", s = 0, turnId = `${role}-t`, detail = {}) => ({ id: ++id, ts: ts(s), turnId, role, provider: role === "lead" ? "codex" : role === "executor" ? "claude" : null, kind, text, detail });
const titles = ["Модель данных", "Импорт", "Интерфейс анализа"];
const titleMap = { 1: titles[0], 2: titles[1], 3: titles[2] };
const input = (v, entries = [], now = T0 + 5_000) => ({ view: v, entries, open: true, stageTitles: titleMap, now });

test("the lead reviewing a stage is said with the stage's title; the executor that finished waits for the review", () => {
  const entries = [
    entry("executor", "task_sent", "", 0, "e1"), entry("executor", "process_started", "", 1, "e1"), entry("executor", "turn_finished", "completed", 2, "e1"),
    entry("lead", "task_sent", "", 3, "l1"), entry("lead", "process_started", "", 3, "l1"), entry("lead", "tool_started", "npm test --  --reporter=dot", 4, "l1", { tool: "Bash" })
  ];
  const v = view({ active: turn("review") });
  const run = runStatus("ru", input(v, entries));
  assert.equal(run.state, "checking");
  assert.equal(run.doing, "Codex проверяет этап 3: Интерфейс анализа");
  assert.match(run.now, /^Инструмент: npm test/);
  const exec = roleStatus("ru", "executor", input(v, entries));
  assert.equal(exec.state, "waiting_agent", "the task is not done while the lead reviews");
  assert.equal(exec.doing, "Claude закончил ход и ждёт ревью");
  assert.notEqual(exec.state, "completed");
  assert.equal(roleStatus("ru", "lead", input(v, entries)).doing, "Codex проверяет этап 3: Интерфейс анализа");
});

test("a turn just given shows no action of the previous turn; a started process is said as such", () => {
  const old = [entry("lead", "task_sent", "", 0, "plan"), entry("lead", "process_started", "", 1, "plan"), entry("lead", "process_exited", "", 2, "plan"), entry("lead", "turn_finished", "completed", 3, "plan")];
  const review = runStatus("ru", input(view({ active: turn("review") }), old));
  assert.equal(review.state, "starting");
  assert.equal(review.now, null, "not the plan turn's 'process exited'");
  assert.equal(roleStatus("ru", "lead", input(view({ active: turn("review") }), old)).now, null);
  const started = [...old, entry("lead", "task_sent", "", 4, "rev"), entry("lead", "process_started", "", 5, "rev")];
  const r = runStatus("ru", input(view({ active: turn("review") }), started));
  assert.equal(r.state, "checking");
  assert.equal(r.now, "Процесс CLI запущен");
});

test("a permission request says what is needed; the other participant is not shown as needing the person", () => {
  const perm = { requestId: "q", role: "executor", provider: "claude", kind: "command", tool: "Bash", summary: "rm -rf build", detail: null, options: ["allow_once", "deny"], questions: [], askedAt: ts(0) };
  const v = view({ active: turn("execute"), permission: perm });
  const run = runStatus("ru", input(v));
  assert.equal(run.state, "waiting_user");
  assert.equal(run.wait, "Требуется разрешение на команду");
  assert.equal(roleStatus("ru", "executor", input(v)).state, "waiting_user");
  assert.equal(roleStatus("ru", "lead", input(v)).state, "waiting_agent");
});

test("silence is reported as silence after 30 s of a running CLI, never as hung", () => {
  const entries = [entry("executor", "process_started", "", 0, "e1"), entry("executor", "thinking", "", 1, "e1")];
  const v = view({ active: turn("execute") });
  assert.equal(runStatus("ru", input(v, entries, T0 + 10_000)).quiet, null);
  const quiet = runStatus("ru", input(v, entries, T0 + 41_000)).quiet;
  assert.equal(quiet, "Нет новых событий 40 с");
  assert.doesNotMatch(JSON.stringify(runStatus("ru", input(v, entries, T0 + 600_000))), /завис|hung|stuck/i);
  assert.equal(runStatus("ru", input(v, entries)).now, "Рассуждает", "a reasoning event is only a marker, never its text");
});

test("service hooks are never the current action", () => {
  const entries = [entry("lead", "process_started", "", 0, "l1"), entry("lead", "message", "{\"x\":1}", 1, "l1"), entry("lead", "tool_started", "hook sessionStart", 2, "l1", { tool: "hook" })];
  assert.ok(isServiceEntry(entries[2]));
  assert.equal(runStatus("ru", input(view({ active: turn("plan") }), entries)).now, "Пишет сообщение");
});

test("the widget: one row per run, two projects side by side, a question in one does not hide the other", () => {
  const perm = { requestId: "q", role: "lead", provider: "codex", kind: "question", tool: "ask", summary: "", detail: null, options: ["allow_once", "deny"], questions: [], askedAt: ts(0) };
  const r = activityRuns("ru", {
    links: [{ linkId: "L1", fromAgentId: "a1", runIds: ["old", "r1"] }, { linkId: "L2", fromAgentId: "b1", runIds: ["r2"] }, { linkId: "L3", fromAgentId: "c1", runIds: ["r3"] }, { linkId: "L4", fromAgentId: "a1", runIds: [] }],
    agents: [{ agentId: "a1", project: "/work/alpha" }, { agentId: "b1", project: "/work/beta-with-a-very-long-folder-name" }, { agentId: "c1", project: "/work/gamma" }],
    runs: {
      r1: { view: view({ runId: "r1", active: turn("plan"), permission: perm }), open: true },
      r2: { view: view({ runId: "r2", active: turn("execute") }), open: true },
      r3: { view: view({ runId: "r3", status: "completed", active: null }), open: false }
    },
    entries: (runId) => (runId === "r2" ? [entry("executor", "process_started", "", 0, "e1")] : []), lastRecordAt: () => null, runErrors: {}, stageTitles: () => titleMap, now: T0
  });
  assert.deepEqual(r.active.map((x) => x.project).sort(), ["alpha", "beta-with-a-very-long-folder-name"]);
  assert.deepEqual(r.active.find((x) => x.project === "alpha").line.state, "waiting_user");
  assert.deepEqual(r.active.find((x) => x.project.startsWith("beta")).line.state, "working");
  assert.equal(r.active.find((x) => x.project === "alpha").roles.length, 2, "participants inside the one row");
  assert.deepEqual(r.recent.map((x) => x.runId), ["r3"]);
});

test("the widget: a run not loaded yet or failing to load is never empty or done", () => {
  const r = activityRuns("ru", {
    links: [{ linkId: "L1", fromAgentId: "a1", runIds: ["r1"] }, { linkId: "L2", fromAgentId: "a1", runIds: ["r2"] }],
    agents: [{ agentId: "a1", project: "/p" }], runs: {}, entries: () => [], lastRecordAt: () => null,
    runErrors: { r2: true }, stageTitles: () => null, now: T0
  });
  assert.deepEqual(r.active.map((x) => x.load).sort(), ["error", "loading"]);
  assert.equal(r.recent.length, 0);
});

// A journal shaped like a real three-stage run: stage 3 needed two rounds, the final review completes with remarks.
const ref = (n) => ({ sha256: String(n).padStart(64, "0"), bytes: 10 });
function journal({ end = "completed", finalVerdict = "complete", withPlan = true } = {}) {
  let seq = 0;
  const rec = (type, data) => ({ seq: seq++, ts: ts(seq * 10), type, data });
  const out = [rec("run.created", { goal: ref(1) }), rec("run.status", { status: "running", reason: null })];
  if (withPlan) out.push(rec("orch.turn", { turnId: "p", purpose: "plan", stage: null }), rec("plan.recorded", { plan: ref(2), stageCount: 3, firstStage: 1, version: 1 }));
  const stage = (n, rounds) => {
    for (let r = 1; r <= rounds; r++) {
      out.push(rec("orch.turn", { turnId: `e${n}${r}`, purpose: "execute", stage: n, round: r }));
      out.push(rec("turn.finished", { turnId: `e${n}${r}`, outcome: "completed", report: { ref: ref(100 + n * 10 + r) } }));
      out.push(rec("check.started", { checkRunId: `c${n}${r}`, checkId: "cmd-1" }), rec("check.finished", { checkRunId: `c${n}${r}`, status: "passed" }));
      out.push(rec("orch.turn", { turnId: `v${n}${r}`, purpose: "review", stage: n, round: r }));
      out.push(rec("review.recorded", { stage: n, verdict: r === rounds ? "accept" : "fix", findingsCount: 1, findings: ref(200 + n * 10 + r) }));
    }
    out.push(rec("stage.accepted", { stage: n }), rec("checkpoint.created", { stage: n, commit: "c".repeat(40) }));
  };
  stage(1, 1); stage(2, 1);
  if (end === "completed") {
    stage(3, 2);
    out.push(rec("orch.turn", { turnId: "f", purpose: "final_review", stage: null }), rec("turn.finished", { turnId: "f", outcome: "completed", report: { ref: ref(300) } }));
    out.push(rec("review.recorded", { stage: null, verdict: finalVerdict, findingsCount: 2, findings: ref(301) }));
  } else {
    out.push(rec("orch.turn", { turnId: "e31", purpose: "execute", stage: 3, round: 1 }));
  }
  out.push(rec("run.status", { status: end, reason: end === "stopped" ? "user_request" : end === "failed" ? "environment_error" : end === "paused" ? "limit_reached" : null }));
  return out;
}
const progress = { mode: "autopilot", branch: null, access: null, checks: [{ id: "cmd-1", title: "npm run check", status: "passed", class: null }], prepare: null, grantsApplied: 0,
  finish: [{ step: "commit", asked: false, status: "not_started", established: false, commit: null, evidence: null }] };

test("the summary: stages, check commands and remarks are counted apart, from the journal", () => {
  const v = view({ status: "completed", active: null, progress });
  const m = summaryModel(v, journal(), { planTitles: () => titles });
  assert.deepEqual(m.stages.map((s) => [s.n, s.title, s.state, s.rounds]), [[1, "Модель данных", "done", 1], [2, "Импорт", "done", 1], [3, "Интерфейс анализа", "done", 2]]);
  assert.deepEqual(m.stageCounts, { done: 3, total: 3 });
  assert.deepEqual(m.checks, [{ id: "cmd-1", title: "npm run check", status: "passed", runs: 4 }], "one check command run four times, not four tests");
  assert.deepEqual(m.checkCounts, { passed: 1, total: 1 });
  assert.equal(m.finalVerdict, "complete");
  assert.deepEqual(m.finalFindings, ref(301));
  assert.deepEqual(m.stages[2].report, ref(132), "the executor's last report of the stage");
  assert.equal(outcomeKey(v, m.finalVerdict), "completed");
  assert.match(t("ru", "orchSumChecks_count"), /команды проверки/i);
  assert.doesNotMatch(t("ru", "orchSumChecks_count"), /тест/);
});

test("completed, paused, stopped and failed give different outcomes; only a complete final review is the goal reached", () => {
  const keys = ["completed", "paused", "stopped", "failed"].map((end) => {
    const v = view({ status: end, reason: null, active: null });
    return outcomeKey(v, summaryModel(v, journal({ end }), { planTitles: () => titles }).finalVerdict);
  });
  assert.deepEqual(keys, ["completed", "paused", "stopped", "failed"]);
  const unconfirmed = view({ status: "completed", active: null });
  assert.equal(outcomeKey(unconfirmed, summaryModel(unconfirmed, journal({ finalVerdict: "fix" }), { planTitles: () => titles }).finalVerdict), "completed_unconfirmed");
  const stopped = summaryModel(view({ status: "stopped" }), journal({ end: "stopped" }), { planTitles: () => titles });
  assert.deepEqual(stopped.stages.map((s) => s.state), ["done", "done", "not_checked"]);
  for (const k of ["completed", "completed_unconfirmed", "paused", "stopped", "failed", "active"]) {
    for (const locale of ["ru", "en"]) assert.ok(t(locale, `orchSumOutcome_${k}`), `${locale} ${k}`);
  }
  assert.notEqual(t("ru", "orchSumOutcome_stopped"), t("ru", "orchSumOutcome_failed"));
  assert.match(t("ru", "orchSumScope"), /не ко всему проекту/);
});

test("an old journal without a plan, progress or texts still gives a summary without inventing anything", () => {
  const old = journal({ withPlan: false }).filter((r) => r.type !== "run.created");
  const m = summaryModel(view({ status: "completed", active: null }), old, null);
  assert.equal(m.goal, null);
  assert.equal(m.stageCounts, null, "no plan: no stage total");
  assert.ok(m.stages.every((s) => s.title === null));
  assert.equal(m.finish, null, "no progress in the view: the actions after success are not specified");
  assert.deepEqual(m.checks.map((c) => c.title), ["cmd-1"], "no title from main: the journal's id");
  assert.deepEqual(summaryModel(null, [], null).stages, null);
});

test("stored reports are read as text and lists, never shown as JSON", () => {
  const p = reportParts(JSON.stringify({ verdict: "complete", findings: ["a", { file: "x" }], question: null, nextStep: "run the migration" }));
  assert.equal(p.verdict, "complete");
  assert.deepEqual(p.findings, ["a", "{\"file\":\"x\"}"]);
  assert.equal(p.next, "run the migration");
  assert.equal(p.question, null);
  assert.deepEqual(reportParts(JSON.stringify({ summary: "did it", done: false })), { summary: "did it", done: false, verdict: null, findings: [], question: null, next: null, other: [], text: null });
  assert.equal(reportParts("plain words").text, "plain words");
});

test("every state has words in both languages", () => {
  for (const s of ["starting", "working", "checking", "waiting_agent", "waiting_user", "paused", "stopping", "completed", "stopped", "failed"]) {
    for (const locale of ["ru", "en"]) assert.ok(stateLabel(locale, s), `${locale} ${s}`);
  }
  for (const k of ["command", "file_change", "permissions", "tool", "question", "plan", "elicitation"]) for (const locale of ["ru", "en"]) assert.ok(t(locale, `orchWait_perm_${k}`));
  for (const p of ["plan", "execute", "review", "final_review"]) for (const locale of ["ru", "en"]) assert.ok(t(locale, `orchNow_${p}`));
});
