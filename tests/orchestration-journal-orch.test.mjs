// Orchestration events of the journal (stage-5-contract.md §8): strict data schemas, replay rules (each conflict
// leaves the state untouched), revision, planReviewPaused, pendingCheckpoint, parseJournal classification and the
// RunWriter methods on a real store. Temp directories only (prefix canvastty-ledger-).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { applyRecord, buildRecord, canonical, isValidEventData, parseJournal } from "../src/main/services/orchestration/journal.ts";
import { createRun, readRun } from "../src/main/services/orchestration/store.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-ledger-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sha = (s) => createHash("sha256").update(s).digest("hex");
const ref = (s) => ({ sha256: sha(s), bytes: Buffer.byteLength(s) });
const oid = (c) => c.repeat(40);
const TS = "2026-09-23T00:00:00.000Z";
const RUN = randomUUID();

const intentData = (turnId) => ({ turnId, commandId: null, role: "lead", provider: "codex", mode: "m", sessionId: null, task: ref("task") });
const finishedData = (turnId, outcome = "completed") => ({
  turnId, outcome, nextTurnAllowed: outcome === "completed", sessionId: null, contract: { status: "verified", errors: [] },
  report: { status: "valid", ref: ref("report"), storeError: null },
  transport: { outcome: outcome === "contract_violation" ? "completed" : outcome, exitCode: 0, signal: null, groupCleared: true }
});
const checkFinished = (checkRunId, status = "passed") => ({
  checkRunId, status, reason: status === "not_verified" ? "timeout" : null, exitCode: status === "failed" ? 1 : status === "passed" ? 0 : null,
  signal: null, groupCleared: true, treeAfter: oid("a"), output: null, outputDropped: 0, evidenceFingerprint: sha("ev"), durationMs: 5
});

// Replays events one by one through applyRecord, like parseJournal does.
function builder() {
  let state = null;
  let prev = null;
  const records = [];
  const make = (type, data) => buildRecord(prev, RUN, TS, type, data).record;
  const b = {
    records,
    get state() { return state; },
    ev(type, data) {
      assert.ok(isValidEventData(type, data), `${type} data must be schema-valid: ${JSON.stringify(data)}`);
      const rec = make(type, data);
      state = applyRecord(state, rec);
      records.push(rec);
      prev = rec;
      return rec;
    },
    // The rule must throw replay_conflict and leave the state exactly as it was.
    conflict(type, data, message) {
      assert.ok(isValidEventData(type, data), `${type} data must be schema-valid (the conflict is a replay rule)`);
      const before = structuredClone(state);
      assert.throws(() => applyRecord(state, make(type, data)), (e) => e.code === "replay_conflict", message);
      assert.deepEqual(state, before, `${message}: state unchanged`);
    },
    // orch.turn + turn.intent (+ turn.finished unless outcome is null); returns turnId
    turn(purpose, stage = null, round = null, outcome = "completed") {
      const turnId = randomUUID();
      b.ev("orch.turn", { turnId, purpose, stage, round, planVersion: state.orch.plan?.version ?? null, clarificationVersion: state.orch.clarifications });
      b.ev("turn.intent", intentData(turnId));
      if (outcome) b.ev("turn.finished", finishedData(turnId, outcome));
      return turnId;
    },
    plan(stageCount = 2) {
      const turnId = b.turn("plan");
      const version = (state.orch.plan?.version ?? 0) + 1;
      b.ev("plan.recorded", { turnId, version, plan: ref(`plan ${version}`), firstStage: Object.keys(state.orch.accepted).length + 1, stageCount });
      return turnId;
    },
    review(stage, verdict, round = 1) {
      const turnId = b.turn(stage === null ? "final_review" : "review", stage, stage === null ? null : round);
      b.ev("review.recorded", review(turnId, stage, verdict));
      return turnId;
    },
    command(status = null) {
      const commandId = randomUUID();
      b.ev("command.received", { commandId, kind: "cmd", payloadHash: sha(commandId) });
      if (status) b.ev("command.completed", { commandId, result: { status, code: null } });
      return commandId;
    }
  };
  b.ev("run.created", { goal: ref("goal") });
  b.ev("workspace.created", { sourcePathSha256: sha("src"), baseline: { commit: oid("b"), tree: oid("a") }, head: null });
  return b;
}
const review = (turnId, stage, verdict) => ({
  turnId, stage, verdict, findings: null, findingsKey: sha("[]"), findingsCount: 0, clarificationVersion: 0, runKey: sha("run")
});

// ---------- schemas ----------

const U = () => randomUUID();
const VALID = {
  "orch.turn": [
    { turnId: U(), purpose: "plan", stage: null, round: null, planVersion: null, clarificationVersion: 0 },
    { turnId: U(), purpose: "execute", stage: 1, round: 2, planVersion: 1, clarificationVersion: 3 },
    { turnId: U(), purpose: "review", stage: 2, round: 1, planVersion: 2, clarificationVersion: 0 },
    { turnId: U(), purpose: "final_review", stage: null, round: null, planVersion: 1, clarificationVersion: 1 }
  ],
  "plan.recorded": [{ turnId: U(), version: 1, plan: ref("p"), firstStage: 1, stageCount: 50 }],
  "review.recorded": [
    { ...review(U(), 1, "accept"), findings: ref("f"), findingsCount: 50 },
    review(U(), 3, "question"),
    review(U(), null, "complete"),
    review(U(), null, "replan")
  ],
  "question.asked": [{ questionId: U(), turnId: U(), text: ref("q") }],
  "question.answered": [{ questionId: U(), commandId: U(), text: ref("a") }],
  "check.assessed": [
    { checkRunId: U(), stage: 1, round: 1, checkKey: sha("k"), runKey: sha("r") },
    { checkRunId: U(), stage: null, round: null, checkKey: sha("k"), runKey: sha("r") }
  ],
  "stage.accepted": [{ stage: 1, reviewTurnId: U(), tree: oid("a") }, { stage: 2, reviewTurnId: U(), tree: "c".repeat(64) }],
  "clarification.added": [{ version: 1, commandId: U(), text: ref("c") }],
  "limits.changed": [
    { commandId: U(), kind: "turns", value: 41 }, { commandId: U(), kind: "roundsPerStage", value: 1 },
    { commandId: U(), kind: "replans", value: 4 }, { commandId: U(), kind: "runMs", value: 14_400_001 }
  ],
  "recovery.decided": [
    { commandId: U(), action: "accept", turnId: U() }, { commandId: U(), action: "retry_turn", turnId: U() },
    { commandId: U(), action: "reset_to_checkpoint", turnId: U() }
  ]
};
const BAD = {
  "orch.turn": [
    { purpose: "chat" }, { stage: 1 }, { round: 1 }, { purpose: "execute" }, { purpose: "review", stage: 1 },
    { purpose: "execute", stage: 0, round: 1 }, { purpose: "execute", stage: 1, round: 1.5 }, { planVersion: 0 },
    { clarificationVersion: -1 }, { clarificationVersion: null }, { turnId: "X" }
  ],
  "plan.recorded": [{ version: 0 }, { stageCount: 0 }, { stageCount: 51 }, { firstStage: 0 }, { plan: null }, { plan: { sha256: sha("x") } }],
  "review.recorded": [
    { verdict: "complete" }, { stage: null, verdict: "accept" }, { stage: null, verdict: "fix" }, { stage: 0 },
    { findingsCount: 51 }, { findingsCount: -1 }, { findingsKey: "abc" }, { runKey: null }, { findings: "text" },
    { clarificationVersion: -1 }, { verdict: "ACCEPT" }
  ],
  "question.asked": [{ questionId: "q1" }, { turnId: null }, { text: null }],
  "question.answered": [{ commandId: null }, { text: { sha256: sha("x"), bytes: 65_537 } }],
  "check.assessed": [{ stage: 1, round: null }, { stage: null, round: 1 }, { stage: 0, round: 1 }, { checkKey: "K" }, { checkRunId: "c" }],
  "stage.accepted": [{ stage: 0 }, { tree: "a".repeat(39) }, { tree: sha("x").toUpperCase() }, { reviewTurnId: null }],
  "clarification.added": [{ version: 0 }, { commandId: null }, { text: null }],
  "limits.changed": [{ kind: "noProgressRounds" }, { kind: "leadTurnMs" }, { value: 0 }, { value: 1.5 }, { value: "5" }],
  "recovery.decided": [{ action: "reset" }, { turnId: null }, { commandId: null }]
};

test("every orchestration event schema accepts its examples and rejects extra, missing and bad fields", () => {
  for (const [type, examples] of Object.entries(VALID)) {
    for (const data of examples) {
      assert.ok(isValidEventData(type, data), `${type} valid: ${JSON.stringify(data)}`);
      assert.equal(isValidEventData(type, { ...data, extra: 1 }), false, `${type} extra field`);
      for (const key of Object.keys(data)) {
        const { [key]: _drop, ...missing } = data;
        assert.equal(isValidEventData(type, missing), false, `${type} missing ${key}`);
        assert.equal(isValidEventData(type, { ...data, [key]: undefined }), false, `${type} undefined ${key}`);
      }
    }
    for (const patch of BAD[type]) {
      assert.equal(isValidEventData(type, { ...examples[0], ...patch }), false, `${type} bad: ${JSON.stringify(patch)}`);
    }
    assert.equal(isValidEventData(type, null), false);
    assert.equal(isValidEventData(type, []), false);
  }
});

// ---------- replay rules ----------

test("orch.turn precedes its turn.intent, is unique, and a bare turn.intent stays valid", () => {
  const b = builder();
  const bare = randomUUID();
  b.ev("turn.intent", intentData(bare)); // Р1–Р4 style: no orch.turn
  assert.equal(b.state.turns[bare].status, "in_flight");
  assert.deepEqual(b.state.orch.turns, {});
  const orchData = (turnId) => ({ turnId, purpose: "plan", stage: null, round: null, planVersion: null, clarificationVersion: 0 });
  b.conflict("orch.turn", orchData(bare), "orch.turn after its intent");
  const id = randomUUID();
  b.ev("orch.turn", orchData(id));
  // seq: the record's position (stage 13 counts environment preparations per executor turn by it)
  assert.deepEqual(b.state.orch.turns[id], { purpose: "plan", stage: null, round: null, planVersion: null, clarificationVersion: 0, seq: b.state.lastSeq });
  b.conflict("orch.turn", orchData(id), "orch.turn twice");
  b.ev("turn.intent", intentData(id));
});

test("plan.recorded: a completed plan turn, versions in order, firstStage after the accepted stages", () => {
  const b = builder();
  const plan = (turnId, patch = {}) => ({ turnId, version: 1, plan: ref("p"), firstStage: 1, stageCount: 2, ...patch });
  b.conflict("plan.recorded", plan(randomUUID()), "unknown turn");
  const bare = randomUUID();
  b.ev("turn.intent", intentData(bare));
  b.ev("turn.finished", finishedData(bare));
  b.conflict("plan.recorded", plan(bare), "turn without orch.turn");
  b.conflict("plan.recorded", plan(b.turn("review", 1, 1)), "review turn");
  b.conflict("plan.recorded", plan(b.turn("plan", null, null, null)), "turn in flight");
  b.conflict("plan.recorded", plan(b.turn("plan", null, null, "invalid_report")), "turn not completed");
  const t1 = b.turn("plan");
  b.conflict("plan.recorded", plan(t1, { version: 2 }), "version skips");
  b.conflict("plan.recorded", plan(t1, { firstStage: 2 }), "firstStage not after accepted");
  b.ev("plan.recorded", plan(t1));
  assert.deepEqual(b.state.orch.plan, { version: 1, turnId: t1, ref: ref("p"), firstStage: 1, stageCount: 2, seq: b.records.at(-1).seq });
  b.conflict("plan.recorded", plan(t1, { version: 2 }), "same turn twice");
  const t2 = b.turn("plan");
  b.conflict("plan.recorded", plan(t2), "version repeats");
  b.ev("plan.recorded", plan(t2, { version: 2, stageCount: 1 }));
  assert.equal(b.state.orch.plan.version, 2);
});

test("review.recorded: review with its turn's stage, final_review without one, completed, once per turn", () => {
  const b = builder();
  b.plan();
  b.conflict("review.recorded", review(b.turn("execute", 1, 1), 1, "accept"), "execute turn");
  b.conflict("review.recorded", review(b.turn("review", 1, 1, null), 1, "accept"), "turn in flight");
  b.conflict("review.recorded", review(b.turn("review", 1, 1, "timeout"), 1, "accept"), "turn not completed");
  const r = b.turn("review", 1, 1);
  b.conflict("review.recorded", review(r, 2, "accept"), "another stage");
  b.conflict("review.recorded", review(r, null, "complete"), "final verdict on a stage review");
  const fin = b.turn("final_review");
  b.conflict("review.recorded", review(fin, 1, "accept"), "stage on a final review");
  b.ev("review.recorded", review(r, 1, "fix"));
  b.conflict("review.recorded", review(r, 1, "accept"), "twice");
  b.ev("review.recorded", review(fin, null, "complete"));
  assert.deepEqual(b.state.orch.reviews.map((x) => [x.turnId, x.stage, x.verdict]), [[r, 1, "fix"], [fin, null, "complete"]]);
  assert.ok(b.state.orch.reviews[0].seq < b.state.orch.reviews[1].seq);
  assert.equal(b.state.orch.reviews[1].seq, b.records.at(-1).seq);
});

test("question.asked / question.answered: a finished turn, one open question, answered by an open command", () => {
  const b = builder();
  const q = (turnId, questionId = randomUUID()) => ({ questionId, turnId, text: ref("why?") });
  b.conflict("question.asked", q(randomUUID()), "unknown turn");
  b.conflict("question.asked", q(b.turn("plan", null, null, null)), "turn in flight");
  const t = b.turn("plan", null, null, "invalid_report"); // finished, not necessarily completed
  const asked = q(t);
  b.ev("question.asked", asked);
  assert.deepEqual(b.state.orch.question, { questionId: asked.questionId, turnId: t, ref: ref("why?"), answered: false, seq: b.records.at(-1).seq,
    answerRef: null, answeredSeq: null });
  b.conflict("question.asked", q(b.turn("plan")), "second open question");
  const answer = (questionId, commandId) => ({ questionId, commandId, text: ref("because") });
  const cmd = b.command();
  b.conflict("question.answered", answer(randomUUID(), cmd), "other question");
  b.conflict("question.answered", answer(asked.questionId, randomUUID()), "unknown command");
  b.conflict("question.answered", answer(asked.questionId, b.command("accepted")), "completed command");
  b.ev("question.answered", answer(asked.questionId, cmd));
  assert.deepEqual([b.state.orch.question.answered, b.state.orch.question.answerRef, b.state.orch.question.answeredSeq],
    [true, ref("because"), b.records.at(-1).seq]);
  assert.equal(b.state.orch.answers, 1);
  assert.deepEqual(b.state.orch.answerSeqs, [b.records.at(-1).seq]);
  b.conflict("question.answered", answer(asked.questionId, b.command()), "answered twice");
  b.conflict("question.asked", q(t, asked.questionId), "same questionId again");
  b.ev("question.asked", q(t));
  assert.equal(b.state.orch.question.answered, false);
  assert.equal(b.state.orch.answers, 1);
});

test("check.assessed: only a finished check, once", () => {
  const b = builder();
  const started = (checkRunId) => ({
    checkRunId, checkId: "unit", commandSha256: sha("cmd"), base: { commit: oid("b"), tree: oid("a") }, treeBefore: oid("a"), profileSha256: sha("p")
  });
  const assess = (checkRunId) => ({ checkRunId, stage: 1, round: 1, checkKey: sha("k"), runKey: sha("r") });
  const c = randomUUID();
  b.conflict("check.assessed", assess(c), "unknown check");
  b.ev("check.started", started(c));
  b.conflict("check.assessed", assess(c), "check in flight");
  // a reopened writer marks it not_verified(interrupted) without check.finished: still not assessable
  const interrupted = structuredClone(b.state);
  interrupted.checks[c].status = "not_verified";
  interrupted.checks[c].reason = "interrupted";
  assert.throws(() => applyRecord(interrupted, buildRecord(b.records.at(-1), RUN, TS, "check.assessed", assess(c)).record),
    (e) => e.code === "replay_conflict");
  b.ev("check.finished", checkFinished(c, "failed"));
  b.ev("check.assessed", assess(c));
  assert.deepEqual(b.state.orch.assessed[c], { stage: 1, round: 1, checkKey: sha("k"), runKey: sha("r"), seq: b.records.at(-1).seq });
  b.conflict("check.assessed", assess(c), "twice");
});

test("stage.accepted: next stage within the plan, by an accept review of that stage; pendingCheckpoint until checkpoint.created", () => {
  const b = builder();
  const acc = (stage, reviewTurnId) => ({ stage, reviewTurnId, tree: oid("c") });
  const early = b.turn("review", 1, 1);
  b.ev("review.recorded", review(early, 1, "accept"));
  b.conflict("stage.accepted", acc(1, early), "no plan");
  b.plan(1);
  const fix = b.review(1, "fix");
  b.conflict("stage.accepted", acc(1, fix), "fix review");
  const ok = b.review(1, "accept", 2);
  b.conflict("stage.accepted", acc(2, ok), "stage not next");
  b.conflict("stage.accepted", acc(1, randomUUID()), "unknown review");
  b.ev("stage.accepted", acc(1, ok));
  assert.deepEqual(b.state.orch.accepted, { 1: { reviewTurnId: ok, tree: oid("c"), seq: b.records.at(-1).seq } });
  assert.equal(b.state.orch.pendingCheckpoint, 1);
  const r2 = b.review(2, "accept");
  b.conflict("stage.accepted", acc(2, r2), "beyond the plan (1 stage)");
  b.ev("checkpoint.created", { stage: 1, commit: oid("d"), tree: oid("c"), parent: oid("b") });
  assert.equal(b.state.orch.pendingCheckpoint, null);
  // a replan continues the numbering after the accepted stages
  b.plan(2);
  assert.equal(b.state.orch.plan.firstStage, 2);
  b.ev("stage.accepted", acc(2, r2));
  assert.equal(b.state.orch.pendingCheckpoint, 2);
  const r3 = b.review(3, "accept");
  b.conflict("stage.accepted", acc(3, r3), "stage 2 has no checkpoint yet");
  b.ev("checkpoint.created", { stage: 2, commit: oid("e"), tree: oid("c"), parent: oid("d") });
  b.ev("stage.accepted", acc(3, r3));
  b.conflict("stage.accepted", acc(4, b.review(4, "accept")), "beyond the replan");
});

test("clarification.added, limits.changed and recovery.decided", () => {
  const b = builder();
  const clar = (version, commandId) => ({ version, commandId, text: ref(`c${version}`) });
  b.conflict("clarification.added", clar(2, b.command()), "version skips");
  b.conflict("clarification.added", clar(1, randomUUID()), "unknown command");
  b.ev("clarification.added", clar(1, b.command()));
  b.conflict("clarification.added", clar(1, b.command()), "version repeats");
  b.ev("clarification.added", clar(2, b.command()));
  assert.equal(b.state.orch.clarifications, 2);
  assert.deepEqual(b.state.orch.clarificationRefs, [ref("c1"), ref("c2")]);
  assert.equal(b.state.orch.clarificationSeqs.length, 2);
  assert.equal(b.state.orch.clarificationSeqs[1], b.records.at(-1).seq);

  b.conflict("limits.changed", { commandId: b.command("rejected"), kind: "turns", value: 50 }, "completed command");
  b.ev("limits.changed", { commandId: b.command(), kind: "turns", value: 50 });
  b.ev("limits.changed", { commandId: b.command(), kind: "runMs", value: 1000 });
  b.ev("limits.changed", { commandId: b.command(), kind: "turns", value: 60 });
  assert.deepEqual(b.state.orch.limitOverrides, { turns: 60, runMs: 1000 });

  const dec = (turnId, commandId, action = "accept") => ({ commandId, action, turnId });
  const done = b.turn("execute", 1, 1);
  const lost = b.turn("execute", 1, 2, null);
  b.conflict("recovery.decided", dec(done, b.command()), "completed turn");
  b.conflict("recovery.decided", dec(lost, b.command()), "in-flight turn");
  const pending = b.command(); // received, not completed: recovered as unfinished
  b.ev("run.recovered", { unfinishedTurns: [lost], unfinishedCommands: Object.keys(b.state.commands).filter((id) => b.state.commands[id].status === "received"), previousStatus: "preparing" });
  assert.equal(b.state.pausedReason, "outcome_unknown");
  b.conflict("recovery.decided", dec(lost, pending), "unfinished command");
  b.ev("recovery.decided", dec(lost, b.command(), "retry_turn"));
  assert.deepEqual(b.state.orch.recoveryDecisions, { [lost]: "retry_turn" });
  b.conflict("recovery.decided", dec(lost, b.command(), "accept"), "second decision");
});

test("revision counts run.status and accepted command.completed, not run.recovered; planReviewPaused", () => {
  const b = builder();
  assert.equal(b.state.orch.revision, 0);
  b.ev("run.status", { status: "running", reason: null });
  b.ev("run.status", { status: "paused", reason: "plan_review" }); // no plan yet
  assert.equal(b.state.orch.planReviewPaused, false);
  b.ev("run.status", { status: "running", reason: null });
  b.command("accepted");
  b.command("rejected");
  b.command(); // received only
  assert.equal(b.state.orch.revision, 4);
  b.plan();
  b.ev("run.status", { status: "paused", reason: "user_request" });
  assert.equal(b.state.orch.planReviewPaused, false);
  b.ev("run.status", { status: "paused", reason: "plan_review" });
  assert.equal(b.state.orch.planReviewPaused, true);
  assert.equal(b.state.orch.revision, 6);
  assert.deepEqual(b.state.orch.lastPausedSeq, { plan_review: b.records.at(-1).seq, user_request: b.records.at(-2).seq });
  b.ev("run.status", { status: "running", reason: null });
  b.ev("run.recovered", { unfinishedTurns: [], unfinishedCommands: Object.keys(b.state.commands).filter((id) => b.state.commands[id].status === "received"), previousStatus: "running" });
  assert.equal(b.state.status, "paused");
  assert.equal(b.state.orch.revision, 7, "run.recovered changes the status without a run.status record");
  b.plan(); // version 2: a later plan_review pause does not matter, and the flag never resets
  assert.equal(b.state.orch.planReviewPaused, true);

  const c = builder();
  c.plan();
  c.plan();
  c.ev("run.status", { status: "paused", reason: "plan_review" });
  assert.equal(c.state.orch.planReviewPaused, false, "only a pause on plan version 1 counts");
});

test("parseJournal: a hand-built line that breaks an orchestration rule is corrupt(replay_conflict) at that line", () => {
  const b = builder();
  const t = b.plan();
  const good = Buffer.from(b.records.map((r) => canonical(r) + "\n").join(""));
  assert.equal(parseJournal(good, RUN).integrity.status, "ok");
  assert.deepEqual(parseJournal(good, RUN).state.orch, b.state.orch);
  const { line } = buildRecord(b.records.at(-1), RUN, TS, "plan.recorded", { turnId: t, version: 2, plan: ref("again"), firstStage: 1, stageCount: 1 });
  const parsed = parseJournal(Buffer.concat([good, line]), RUN);
  assert.deepEqual(parsed.integrity, { status: "corrupt", detail: { line: b.records.length + 1, offset: good.length, code: "replay_conflict" } });
  assert.deepEqual(parsed.state.orch, b.state.orch, "state of the valid prefix");
  const extra = buildRecord(b.records.at(-1), RUN, TS, "orch.turn",
    { turnId: randomUUID(), purpose: "plan", stage: null, round: null, planVersion: null, clarificationVersion: 0, note: "x" }).line;
  assert.equal(parseJournal(Buffer.concat([good, extra]), RUN).integrity.detail.code, "invalid_event");
});

// ---------- the writer ----------

const result = (outcome = "completed") => ({
  outcome, nextTurnAllowed: outcome === "completed", sessionId: null,
  report: { status: "valid", value: { stages: [{ title: "t", task: "do" }], question: null } },
  contract: { status: "verified", errors: [] },
  transport: { outcome, process: { exitCode: 0, signal: null, groupCleared: true } }
});
const rejected = (code) => (e) => e?.code === "invalid_input" && (code === undefined || e.detail?.code === code);

test("RunWriter records every orchestration event after replay validation; rejected ones write nothing", async () => {
  const root = fs.mkdtempSync(path.join(TMP, "w-"));
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "goal" });
  await w.recordWorkspaceCreated({ sourcePathSha256: sha("src"), baseline: { commit: oid("b"), tree: oid("a") }, head: null });
  await w.setRunStatus("running", null);
  const turn = async (purpose, stage = null, round = null) => {
    const turnId = randomUUID();
    await w.recordOrchTurn({ turnId, purpose, stage, round, planVersion: w.state().orch.plan?.version ?? null, clarificationVersion: w.state().orch.clarifications });
    await w.recordTurnIntent({ turnId, commandId: null, role: purpose === "execute" ? "executor" : "lead", provider: "codex", mode: "m", sessionId: null, task: purpose });
    await w.recordTurnResult(turnId, result());
    return turnId;
  };
  const plan = await turn("plan");
  const planRef = await w.putText("the plan");
  const lastSeq = w.state().lastSeq;
  await assert.rejects(w.recordPlan({ turnId: plan, version: 2, plan: planRef, firstStage: 1, stageCount: 1 }), rejected("replay_conflict"));
  await assert.rejects(w.recordPlan({ turnId: plan, version: 1, plan: planRef, firstStage: 1 }), rejected());
  await assert.rejects(w.recordOrchTurn({ turnId: plan, purpose: "plan", stage: null, round: null, planVersion: null, clarificationVersion: 0 }), rejected("replay_conflict"));
  assert.equal(w.state().lastSeq, lastSeq, "nothing written");
  await w.recordPlan({ turnId: plan, version: 1, plan: { ...planRef, extra: "dropped" }, firstStage: 1, stageCount: 1, extra: "dropped" });
  await turn("execute", 1, 1);

  const checkRunId = randomUUID();
  await w.recordCheckStarted({ checkRunId, checkId: "unit", commandSha256: sha("cmd"), base: { commit: oid("b"), tree: oid("a") }, treeBefore: oid("a"), profileSha256: sha("p") });
  await assert.rejects(w.recordCheckAssessed({ checkRunId, stage: 1, round: 1, checkKey: sha("k"), runKey: sha("r") }), rejected("replay_conflict"));
  await w.recordCheckFinished(checkFinished(checkRunId));
  await w.recordCheckAssessed({ checkRunId, stage: 1, round: 1, checkKey: sha("k"), runKey: sha("r") });

  const rev = await turn("review", 1, 1);
  const q = randomUUID();
  await w.recordQuestion({ questionId: q, turnId: rev, text: await w.putText("which one?") });
  const cmd = randomUUID();
  await w.recordCommand(cmd, "answer", { q });
  await w.recordAnswer({ questionId: q, commandId: cmd, text: await w.putText("this one") });
  await w.completeCommand(cmd, { status: "accepted", code: null });
  await w.recordReview({ ...review(rev, 1, "accept"), findings: await w.putText("[]") });
  await w.recordStageAccepted({ stage: 1, reviewTurnId: rev, tree: oid("c") });
  assert.equal(w.state().orch.pendingCheckpoint, 1);
  await w.recordCheckpoint({ stage: 1, commit: oid("d"), tree: oid("c"), parent: oid("b") });
  const c2 = randomUUID();
  await w.recordCommand(c2, "clarify", {});
  await w.recordClarification({ version: 1, commandId: c2, text: await w.putText("also docs") });
  await w.recordLimitsChanged({ commandId: c2, kind: "replans", value: 5 });
  await assert.rejects(w.recordRecoveryDecision({ commandId: c2, action: "accept", turnId: rev }), rejected("replay_conflict"));
  await w.completeCommand(c2, { status: "accepted", code: null });
  await w.setRunStatus("paused", "user_request");
  const state = w.state();
  await w.close();

  const read = await readRun(root, runId);
  assert.equal(read.integrity.status, "ok");
  assert.deepEqual(read.state.orch, state.orch, "replay of the file equals the writer's state");
  const o = read.state.orch;
  assert.equal(o.revision, 4, "running, 2 accepted commands, paused");
  assert.deepEqual({ ...o.plan, seq: undefined }, { version: 1, turnId: plan, ref: planRef, firstStage: 1, stageCount: 1, seq: undefined });
  assert.deepEqual([o.clarifications, o.answers, o.question.answered, o.pendingCheckpoint], [1, 1, true, null]);
  assert.deepEqual(o.limitOverrides, { replans: 5 });
  assert.deepEqual(Object.keys(o.accepted), ["1"]);
  assert.equal(Object.keys(o.turns).length, 3);
  const types = fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).type);
  for (const t of ["orch.turn", "plan.recorded", "review.recorded", "question.asked", "question.answered", "check.assessed", "stage.accepted", "clarification.added", "limits.changed"]) {
    assert.ok(types.includes(t), t);
  }
});

test("finish.result: QA version and observed id are validated; older results with bound still read", () => {
  const base = { intentId: randomUUID(), status: "done", established: false, evidence: ref("e"), commit: oid("c") };
  for (const version of ["confirmed", "mismatch", "not_reported", "invalid", "not_checked"]) assert.ok(isValidEventData("finish.result", { ...base, version }), version);
  assert.ok(isValidEventData("finish.result", { ...base, version: "mismatch", observed: oid("d") }));
  assert.ok(isValidEventData("finish.result", { ...base, observed: null }));
  assert.ok(isValidEventData("finish.result", { ...base, bound: true }), "an older journal");
  assert.equal(isValidEventData("finish.result", { ...base, version: "bound" }), false);
  assert.equal(isValidEventData("finish.result", { ...base, observed: "abc123" }), false, "only a full commit id");
  assert.equal(isValidEventData("finish.result", { ...base, observed: oid("C") }), false);
});
