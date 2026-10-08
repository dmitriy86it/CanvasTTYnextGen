// The renderer's run model (runModel.ts) and the orchestration strings: pure checks, no Electron.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  activeRole,
  activityGap,
  agentState,
  availableActions,
  commandOf,
  createIdKeeper,
  digest,
  formatText,
  historyLines,
  mergeActivity,
  newerStamp,
  outcomeOf,
  nextStepKey,
  parsePlan,
  pauseEnding,
  runHeadline
} from "../src/renderer/src/features/orchestration/runModel.ts";
import { t } from "../src/renderer/src/lib/i18n.ts";
import { parseCanvasLayerId, agentLayerId } from "../src/renderer/src/features/workspace/canvasSelectionGesture.ts";

const view = (over = {}) => ({ runId: "r", status: "running", reason: null, revision: 3, stage: 0, turns: 1, halted: false, active: null, ...over });

test("only the commands a state allows are offered", () => {
  assert.deepEqual(availableActions(view()), ["pause", "stop", "clarify"]);
  assert.deepEqual(availableActions(view({ status: "preparing" })), ["stop"]);
  assert.deepEqual(availableActions(view({ status: "pausing" })), ["keep_running", "stop", "clarify"]);
  assert.deepEqual(availableActions(view({ status: "paused", reason: "plan_review" })), ["resume", "step", "stop", "clarify"]);
  assert.deepEqual(availableActions(view({ status: "paused", reason: "awaiting_answer" })), ["answer", "stop", "clarify"]);
  assert.deepEqual(availableActions(view({ status: "paused", reason: "limit_reached" })), ["raise_limit", "stop", "clarify"]);
  assert.deepEqual(availableActions(view({ status: "paused", reason: "outcome_unknown" })), ["recover", "stop", "clarify"]);
  assert.deepEqual(availableActions(view({ status: "paused", reason: "invalid_report" })), ["step", "stop", "clarify"]);
  assert.deepEqual(availableActions(view({ status: "paused", reason: "journal_corrupt" })), ["stop"]);
  assert.deepEqual(availableActions(view({ status: "paused", reason: "lead_modified_tree" })), ["stop", "clarify"]);
  for (const status of ["stopping", "stopped", "completed", "failed"]) assert.deepEqual(availableActions(view({ status })), []);
  assert.deepEqual(availableActions(view({ halted: true })), [], "a halted run takes no command until it is reopened");
});

test("a card is working only while its own role holds the turn", () => {
  const exec = view({ active: { kind: "turn", purpose: "execute" } });
  assert.equal(activeRole(exec), "executor");
  assert.equal(agentState("executor", exec), "working");
  assert.equal(agentState("lead", exec), "waiting");
  const plan = view({ active: { kind: "turn", purpose: "plan" } });
  assert.equal(agentState("lead", plan), "working");
  assert.equal(activeRole(view({ active: { kind: "check", checkId: "node-test" } })), "check");
  assert.equal(agentState("lead", null), "idle");
  assert.equal(agentState("lead", view({ status: "paused" })), "paused");
  assert.equal(agentState("executor", view({ status: "completed" })), "completed");
});

test("the journal folds into plan, open question, checks and the final verdict", () => {
  const plan = { sha256: "a".repeat(64), bytes: 10 };
  const q = { sha256: "b".repeat(64), bytes: 5 };
  const rec = (seq, type, data) => ({ seq, ts: "2026-09-24T00:00:00.000Z", type, data });
  const records = [
    rec(0, "run.created", {}),
    rec(1, "plan.recorded", { plan, version: 1, stageCount: 2 }),
    rec(2, "question.asked", { questionId: "q1", text: q }),
    rec(3, "question.answered", { questionId: "q1" }),
    rec(4, "question.asked", { questionId: "q2", text: q }),
    rec(5, "check.started", { checkRunId: "c1", checkId: "node-test" }),
    rec(6, "check.finished", { checkRunId: "c1", status: "passed", reason: null }),
    rec(7, "review.recorded", { verdict: "complete", stage: null, findingsCount: 0 })
  ];
  const d = digest(records);
  assert.deepEqual(d.plan, plan);
  assert.equal(d.question.questionId, "q2");
  assert.deepEqual(d.checks, [{ checkRunId: "c1", checkId: "node-test", status: "passed", reason: null }]);
  assert.equal(d.finalVerdict, "complete");
  const lines = historyLines(records);
  assert.ok(!lines.some((l) => l.seq === 0), "bookkeeping stays out of the lines");
  assert.deepEqual(lines.find((l) => l.seq === 7).parts, { verdict: "complete", stage: null, findingsCount: 0 });
  assert.equal(lines.find((l) => l.seq === 7).text, undefined, "a review without findings has nothing to open");
  assert.deepEqual(parsePlan('{"stages":[{"title":"A","task":"do a"},{"x":1}]}'), [{ title: "A", task: "do a" }]);
  assert.deepEqual(parsePlan("not json"), []);
});

test("history lines open the executor report, the lead's findings and the check output by their journal refs", () => {
  const ref = (c) => ({ sha256: c.repeat(64), bytes: 9 });
  const rec = (seq, type, data) => ({ seq, ts: "2026-09-24T00:00:00.000Z", type, data });
  const lines = historyLines([
    rec(1, "orch.turn", { turnId: "t1", purpose: "execute", stage: 1, round: 1 }),
    rec(2, "turn.finished", { turnId: "t1", outcome: "completed", report: { status: "valid", ref: ref("a"), storeError: null } }),
    rec(3, "check.started", { checkRunId: "c1", checkId: "node-test" }),
    rec(4, "check.finished", { checkRunId: "c1", status: "failed", reason: null, exitCode: 1, output: ref("b"), outputDropped: 0 }),
    rec(5, "orch.turn", { turnId: "t2", purpose: "review", stage: 1, round: 1 }),
    rec(6, "turn.finished", { turnId: "t2", outcome: "completed", report: { status: "valid", ref: ref("c"), storeError: null } }),
    rec(7, "review.recorded", { verdict: "fix", stage: 1, findingsCount: 2, findings: ref("d") }),
    rec(8, "orch.turn", { turnId: "t3", purpose: "execute", stage: 1, round: 2 }),
    rec(9, "turn.finished", { turnId: "t3", outcome: "invalid_report", report: { status: "invalid", ref: null, storeError: null } }),
    rec(10, "check.finished", { checkRunId: "c2", status: "not_verified", reason: "timeout", exitCode: null, output: null, outputDropped: 0 })
  ]);
  const at = (seq) => lines.find((l) => l.seq === seq);
  assert.deepEqual(at(2).text, { kind: "report", ref: ref("a"), missing: "valid" });
  assert.equal(at(2).kind, "report");
  assert.equal(at(6), undefined, "the lead's own report is the review line");
  assert.deepEqual(at(4).parts, { status: "failed", reason: null, exitCode: 1, outputDropped: 0, checkId: "node-test" });
  assert.deepEqual(at(4).text, { kind: "output", ref: ref("b"), missing: null });
  assert.deepEqual(at(7).text, { kind: "findings", ref: ref("d"), missing: null });
  assert.deepEqual(at(9).text, { kind: "report", ref: null, missing: "invalid" }, "no text kept: said, not hidden");
  assert.equal(at(9).kind, "turn_failed");
  assert.equal(at(10).text.ref, null);
  assert.deepEqual(formatText("findings", '["a","b"]'), { items: ["a", "b"], body: "" });
  assert.deepEqual(formatText("report", '{"summary":"did it","done":true}'), { items: ["did it"], body: '{\n  "done": true\n}' });
  assert.deepEqual(formatText("output", "not ok 1"), { items: [], body: "not ok 1" });
});

test("a retry after a transport failure repeats the id; an answer from main ends it", async () => {
  let n = 0;
  const ids = createIdKeeper(() => `id${++n}`);
  const key = "link:a:b";
  assert.equal(ids.idFor(key), "id1");
  assert.equal(ids.idFor(key), "id1");
  assert.notEqual(ids.idFor("link:a:c"), "id1", "another pair is another action");
  ids.settle(key);
  assert.equal(ids.idFor(key), "id3");

  assert.deepEqual((await outcomeOf(() => Promise.reject(new Error("gone")))).outcome, { kind: "transport", message: "gone" });
  assert.deepEqual((await outcomeOf(async () => ({ ok: false, code: "link_busy", message: "" }))).outcome, { kind: "refused", code: "link_busy" });
  assert.deepEqual((await outcomeOf(async () => ({ ok: true, value: { status: "rejected", code: "stale_revision" } }))).outcome,
    { kind: "rejected", code: "stale_revision" });
  assert.deepEqual((await outcomeOf(async () => ({ ok: true, value: { status: "accepted", code: null } }))).outcome, { kind: "accepted" });
  assert.deepEqual((await outcomeOf(async () => ({ ok: true, value: { runId: "x", created: true } }))).outcome, { kind: "accepted" });
});

test("(seq, tick) never goes back", () => {
  assert.equal(newerStamp({ seq: 5, tick: 0 }, null), true);
  assert.equal(newerStamp({ seq: 5, tick: 1 }, { seq: 5, tick: 0 }), true);
  assert.equal(newerStamp({ seq: 6, tick: 0 }, { seq: 5, tick: 3 }), true);
  assert.equal(newerStamp({ seq: 5, tick: 0 }, { seq: 5, tick: 0 }), false);
  assert.equal(newerStamp({ seq: 4, tick: 9 }, { seq: 5, tick: 0 }), false);
});

test("agent cards are canvas layers of their own kind", () => {
  assert.deepEqual(parseCanvasLayerId(agentLayerId("a1")), { kind: "agent", targetId: "a1" });
  assert.equal(parseCanvasLayerId("agent:"), null);
});

test("every status, reason and refusal main can send has a string in every locale", () => {
  const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const codes = new Set();
  for (const file of ["main/services/orchestration/manager.ts", "main/services/orchestration/canvasStore.ts", "main/services/orchestration/boardStore.ts", "main/ipc/orchestrationIpc.ts"]) {
    for (const m of src(file).matchAll(/refuse\("([a-z_]+)"/g)) codes.add(m[1]);
  }
  for (const m of src("main/services/orchestration/orchestrationService.ts").matchAll(/reject\("([a-z_]+)"|code: "([a-z_]+)"/g)) codes.add(m[1] ?? m[2]);
  // Preparation of a project repository (git.ts) reaches the goal dialog as a refusal too.
  for (const c of ["not_a_repository", "unsupported_repository", "submodules_unsupported", "lfs_unsupported", "nested_repository", "operation_in_progress"]) codes.add(c);
  const checkReasons = [...src("main/services/orchestration/journal.ts").match(/export type NotVerifiedReason =([^;]+);/)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(checkReasons.length >= 12);
  const commandKinds = [...src("shared/orchestration.ts").match(/export type OrchestrationRunCommand =([\s\S]+?)\n\n/)[1].matchAll(/kind: "([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(commandKinds.length >= 9);
  const statuses = ["preparing", "running", "pausing", "paused", "stopping", "stopped", "completed", "failed"];
  const service = src("main/services/orchestration/orchestrationService.ts");
  const reasons = new Set(["user_request", "step_done", "plan_review", "awaiting_answer", "recovered", "outcome_unknown", "invalid_report",
    "protocol_error", "limit_reached", "permission_denied", "loop_suspected", "lead_modified_tree", "environment_error",
    "shared_git_tampered", "journal_corrupt", "sandbox_unavailable", "stage_done", "external_failure", "needs_user_action", "finish_unconfirmed", "app_closed"]);
  for (const r of reasons) assert.ok(service.includes(`"${r}"`), `reason ${r} is one the service uses`);
  for (const locale of ["ru", "en"]) {
    for (const c of codes) assert.ok(t(locale, `orchError_${c}`), `${locale}: orchError_${c}`);
    for (const k of checkReasons) assert.ok(t(locale, `orchCheckReason_${k}`), `${locale}: orchCheckReason_${k}`);
    for (const k of commandKinds) assert.ok(t(locale, `orchCommand_${k}`), `${locale}: orchCommand_${k}`);
    for (const k of ["report", "findings", "output"]) assert.ok(t(locale, `orchShow_${k}`), `${locale}: orchShow_${k}`);
    for (const k of ["not_checked", "missing", "invalid"]) assert.ok(t(locale, `orchTextWhy_${k}`), `${locale}: orchTextWhy_${k}`);
    for (const s of statuses) assert.ok(t(locale, `orchStatus_${s}`), `${locale}: orchStatus_${s}`);
    for (const r of reasons) assert.ok(t(locale, `orchReason_${r}`), `${locale}: orchReason_${r}`);
    for (const k of ["plan", "turn", "turn_failed", "report", "review", "question", "answered", "stage_accepted", "clarified", "limit", "check", "recovered", "status"]) {
      assert.ok(t(locale, `orchLine_${k}`), `${locale}: orchLine_${k}`);
    }
  }
});

test("stage 12: a waiting CLI prompt heads the summary; a run in the project folder is not taken from a checkpoint", () => {
  const permission = { requestId: "p1", role: "executor", kind: "tool", tool: "Bash", options: ["allow_once", "deny"] };
  assert.deepEqual(runHeadline(view({ permission })), { headline: "awaiting_permission", next: "permission" });
  assert.equal(runHeadline(view({ status: "stopped", permission })).headline, "stopped", "a stopped run has no prompt to answer");
  assert.equal(runHeadline(view({ status: "completed", workMode: "project" })).next, "review_in_place");
  assert.equal(runHeadline(view({ status: "completed", workMode: "copy" })).next, "take_result");
  for (const locale of ["ru", "en"]) for (const k of ["review_in_place", "take_result", "permission"]) assert.ok(t(locale, `orchNext_${k}`), `${locale}: orchNext_${k}`);
  assert.deepEqual(commandOf("permission", { requestId: "p1", decision: "allow_once", answers: { q: ["a"] } }),
    { kind: "permission", requestId: "p1", decision: "allow_once", answers: { q: ["a"] } });
  assert.deepEqual(commandOf("permission", {}), { kind: "permission", requestId: "", decision: "deny" }, "no decision is never an allow");
});

test("activity: batches merge in id order, duplicates once, a hole is noticed", () => {
  const e = (id) => ({ id, ts: "t", role: "lead", kind: "message", text: String(id) });
  assert.deepEqual(mergeActivity([e(1), e(2)], [e(3), e(4)]).map((x) => x.id), [1, 2, 3, 4]);
  assert.deepEqual(mergeActivity([e(1), e(3)], [e(2), e(3)]).map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(mergeActivity([e(1), e(2)], [e(3)], 2).map((x) => x.id), [2, 3], "the cap keeps the newest");
  assert.equal(activityGap([e(1), e(2)], [e(3)]), false);
  assert.equal(activityGap([e(1), e(2)], [e(5)]), true);
  assert.equal(activityGap([], [e(5)]), false, "nothing shown yet: no hole");
});

// ---- how a turn ended (TurnResult.ending, kept flat in the turn_finished activity entry) ----

const ENDING_STEPS = ["ok", "harness", "supervisor_error", "delivery", "timeout", "stop", "protocol_parse", "multiple_terminal_events",
  "events_after_terminal", "no_terminal_event", "stream_held_until_cleanup", "stream_held_abandoned", "stream_held_capped", "relay_failed", "relay_incomplete",
  "held_after_supervisor_exit", "stream_unknown", "terminal_failure", "protocol_stop", "exit_code", "session_mismatch",
  "invalid_report", "cleanup_failed"];
const finished = (text, detail, id = 1) => ({ id, ts: "2026-09-29T00:00:00.000Z", turnId: "t", role: "lead", provider: "codex", kind: "turn_finished", text, ...(detail ? { detail } : {}) });

test("pauseEnding: the step of the turn the run is paused for; nothing for older entries or another reason", () => {
  const paused = (reason) => view({ status: "paused", reason });
  assert.equal(pauseEnding(paused("protocol_error"), [finished("protocol_error", { endStep: "stream_held_until_cleanup" })]), "stream_held_until_cleanup");
  assert.equal(pauseEnding(paused("protocol_error"), [finished("contract_violation", { endStep: "ok" })]), null, "contract checked after a clean transport");
  assert.equal(pauseEnding(paused("environment_error"), [finished("cleanup_unverified", { endStep: "cleanup_failed" })]), "cleanup_failed");
  assert.equal(pauseEnding(paused("protocol_error"), [finished("protocol_error")]), null, "an entry written by 1.5.5 has no endStep");
  assert.equal(pauseEnding(paused("protocol_error"), []), null);
  assert.equal(pauseEnding(paused("environment_error"), [finished("protocol_error", { endStep: "no_terminal_event" })]), null, "the pause is not this turn's");
  assert.equal(pauseEnding(paused("environment_error"), [finished("completed", { endStep: "ok" })]), null);
  assert.equal(pauseEnding(view({ status: "running" }), [finished("protocol_error", { endStep: "protocol_parse" })]), null);
  const newest = [finished("protocol_error", { endStep: "protocol_parse" }, 1), finished("protocol_error", { endStep: "stream_held_until_cleanup" }, 2)];
  assert.equal(pauseEnding(paused("protocol_error"), newest), "stream_held_until_cleanup", "the newest turn decides");
});

test("ending steps have words in both locales; a held stream or a failed cleanup is not called a protocol violation by the CLI", () => {
  for (const locale of ["ru", "en"]) {
    for (const step of ENDING_STEPS) {
      const text = t(locale, `orchEnding_${step}`);
      assert.ok(typeof text === "string" && text.length > 0, `${locale}: orchEnding_${step}`);
    }
    for (const step of ["stream_held_until_cleanup", "stream_held_abandoned", "cleanup_failed", "relay_failed", "relay_incomplete"]) assert.doesNotMatch(t(locale, `orchEnding_${step}`), /нарушил протокол|broke the protocol/);
    // no promise that a retry is safe: the next step says the cause comes first
    assert.doesNotMatch(t(locale, "orchReason_protocol_error"), /нарушил протокол|broke the protocol/);
  }
  assert.match(t("ru", "orchNext_protocol_error"), /не гарантирует/);
  assert.match(t("en", "orchNext_protocol_error"), /may give the same result/);
  // the pause keeps its actions: a step or a stop, as before
  assert.deepEqual(availableActions(view({ status: "paused", reason: "protocol_error" })), ["step", "stop", "clarify"]);
  assert.equal(runHeadline(view({ status: "paused", reason: "protocol_error" })).next, "protocol_error");
});

test("pauseEnding: a pause that came later, for another cause, never shows an older turn's step", () => {
  const status = (id, st, reason) => ({ id, ts: "2026-09-29T00:00:00.000Z", turnId: null, role: "run", provider: null, kind: "status", text: "", detail: { status: st, reason } });
  const paused = view({ status: "paused", reason: "environment_error" });
  const timedOut = finished("timeout", { endStep: "timeout" }, 1);
  // resumed, then paused again (an unfinished restore) before any new turn
  assert.equal(pauseEnding(paused, [timedOut, status(2, "paused", "environment_error"), status(3, "running", null), status(4, "paused", "environment_error")]), null);
  // paused for another reason after the turn
  assert.equal(pauseEnding(view({ status: "paused", reason: "protocol_error" }),
    [finished("protocol_error", { endStep: "protocol_parse" }, 1), status(2, "paused", "limit_reached"), status(3, "paused", "protocol_error")]), null);
  // the turn's own pause, with pausing on the way: still its step
  assert.equal(pauseEnding(paused, [timedOut, status(2, "pausing", null), status(3, "paused", "environment_error")]), "timeout");
});

test("app-side output failures are said as the application's, and each holder has its own words", () => {
  for (const locale of ["ru", "en"]) {
    for (const step of ["relay_failed", "relay_incomplete", "held_after_supervisor_exit", "stream_unknown"]) {
      assert.match(t(locale, `orchEnding_${step}`), locale === "ru" ? /сбой приложения.*вина не CLI/ : /application failure.*not the CLI's fault/, step);
    }
    assert.notEqual(t(locale, "orchEnding_stream_held_until_cleanup"), t(locale, "orchEnding_stream_held_abandoned"));
  }
  assert.match(t("ru", "orchEnding_stream_held_until_cleanup"), /из группы CLI/);
  assert.match(t("ru", "orchEnding_stream_held_abandoned"), /вне группы CLI/);
  for (const locale of ["ru", "en"]) assert.doesNotMatch(t(locale, "orchEnding_stream_held_capped"), /вне группы|outside/, "the writer is not known");
});

test("an application failure is not sent to fix the environment: its own next step, no promise of a safe retry", () => {
  const paused = view({ status: "paused", reason: "environment_error" });
  for (const step of ["relay_failed", "relay_incomplete", "held_after_supervisor_exit", "stream_unknown"]) {
    assert.equal(nextStepKey(paused, [finished("harness_error", { endStep: step })]), "app_failure", step);
  }
  assert.equal(nextStepKey(paused, [finished("cleanup_unverified", { endStep: "cleanup_failed" })]), "environment_error");
  assert.equal(nextStepKey(paused, []), "environment_error", "no ending recorded: as before");
  assert.match(t("ru", "orchNext_app_failure"), /сбой приложения.*может дать тот же результат/);
  assert.match(t("en", "orchNext_app_failure"), /application failure.*may give the same result/);
});
