// Recovery of orchestration runs (stage-5-contract.md §12) on the real store: a child process writes through a writer
// and exits without close (its lock generation stays unreleased with a dead pid), then this process reopens the run.
// Temp directories only (prefix canvastty-ledger-); the only processes started are this file's own children.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { openRun, readRun } from "../src/main/services/orchestration/store.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-ledger-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const STORE = new URL("../src/main/services/orchestration/store.ts", import.meta.url).href;

const sha = (s) => createHash("sha256").update(s).digest("hex");
const oid = (c) => c.repeat(40);

// The child: createRun, the steps of `mode`, then process.exit without close (a crash as far as the journal knows).
const CHILD = `
import { createHash } from "node:crypto";
import { createRun } from ${JSON.stringify(STORE)};
const [mode, root, runId] = process.argv.slice(1);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const oid = (c) => c.repeat(40);
const id = () => crypto.randomUUID();
const w = await createRun(root, runId, { goal: "goal" });
await w.recordWorkspaceCreated({ sourcePathSha256: sha("src"), baseline: { commit: oid("b"), tree: oid("a") }, head: null });
await w.setRunStatus("running", null);
const result = { outcome: "completed", nextTurnAllowed: true, sessionId: null, report: { status: "valid", value: { ok: true } },
  contract: { status: "verified", errors: [] }, transport: { outcome: "completed", process: { exitCode: 0, signal: null, groupCleared: true } } };
const turn = async (purpose, stage, round, finish = true) => {
  const turnId = id();
  await w.recordOrchTurn({ turnId, purpose, stage, round, planVersion: w.state().orch.plan?.version ?? null, clarificationVersion: 0 });
  await w.recordTurnIntent({ turnId, commandId: null, role: purpose === "execute" ? "executor" : "lead", provider: "codex", mode: "m", sessionId: null, task: purpose });
  if (finish) await w.recordTurnResult(turnId, result);
  return turnId;
};
const plan = await turn("plan", null, null);
await w.recordPlan({ turnId: plan, version: 1, plan: await w.putText("plan"), firstStage: 1, stageCount: 2 });
const cmd = id();
await w.recordCommand(cmd, "clarify", {});
await w.recordClarification({ version: 1, commandId: cmd, text: await w.putText("more") });
await w.completeCommand(cmd, { status: "accepted", code: null });
if (mode === "turn") {
  await turn("execute", 1, 1, false);
} else if (mode === "orch-only") {
  await w.recordOrchTurn({ turnId: id(), purpose: "execute", stage: 1, round: 1, planVersion: 1, clarificationVersion: 1 });
} else if (mode === "check") {
  await turn("execute", 1, 1);
  await w.recordCheckStarted({ checkRunId: id(), checkId: "unit", commandSha256: sha("cmd"), base: { commit: oid("b"), tree: oid("a") },
    treeBefore: oid("a"), profileSha256: sha("p") });
} else if (mode === "accepted") {
  await turn("execute", 1, 1);
  const review = await turn("review", 1, 1);
  await w.recordReview({ turnId: review, stage: 1, verdict: "accept", findings: null, findingsKey: sha("[]"), findingsCount: 0,
    clarificationVersion: 1, runKey: sha("run") });
  await w.recordStageAccepted({ stage: 1, reviewTurnId: review, tree: oid("c") });
} else if (mode === "paused") {
  await w.setRunStatus("paused", "plan_review");
} else {
  throw new Error("unknown mode " + mode);
}
process.stdout.write("done\\n");
process.exit(0);
`;

async function crashedRun(mode) {
  const root = fs.mkdtempSync(path.join(TMP, `${mode}-`));
  const runId = randomUUID();
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, mode, root, runId], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, err);
  assert.equal(out, "done\n");
  const before = await readRun(root, runId);
  assert.equal(before.integrity.status, "ok");
  return { root, runId, before: before.state };
}
const journal = (root, runId) => fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rejected = (e) => e?.code === "invalid_input" && e.detail?.code === "replay_conflict";

test("orch.turn + turn.intent in flight: run.recovered, outcome_unknown, paused(outcome_unknown); a decision is recorded once", async () => {
  const { root, runId, before } = await crashedRun("turn");
  const [turnId] = Object.keys(before.turns).filter((id) => before.turns[id].status === "in_flight");
  assert.ok(before.orch.turns[turnId]);
  const w = await openRun(root, runId);
  const s = w.state();
  assert.equal(journal(root, runId).at(-1).type, "run.recovered");
  assert.deepEqual(journal(root, runId).at(-1).data.unfinishedTurns, [turnId]);
  assert.equal(s.turns[turnId].status, "outcome_unknown");
  assert.deepEqual([s.status, s.pausedReason], ["paused", "outcome_unknown"]);
  assert.deepEqual(s.orch, before.orch, "orchestration state is untouched by recovery (revision included)");
  const cmd = randomUUID();
  await w.recordCommand(cmd, "recover", { action: "retry_turn" });
  await w.recordRecoveryDecision({ commandId: cmd, action: "retry_turn", turnId });
  await assert.rejects(w.recordRecoveryDecision({ commandId: cmd, action: "accept", turnId }), rejected);
  await w.completeCommand(cmd, { status: "accepted", code: null });
  await w.setRunStatus("paused", "user_request");
  const after = w.state();
  await w.close();
  assert.deepEqual(after.orch.recoveryDecisions, { [turnId]: "retry_turn" });
  assert.equal(after.orch.revision, before.orch.revision + 2);
  const w2 = await openRun(root, runId);
  assert.deepEqual(w2.state(), after, "a clean reopen of a paused run writes nothing and replays the same state");
  await w2.close();
});

test("orch.turn without turn.intent: the turn never started, nothing unfinished, paused(recovered)", async () => {
  const { root, runId, before } = await crashedRun("orch-only");
  const orphan = Object.keys(before.orch.turns).find((id) => !before.turns[id]);
  assert.ok(orphan, "the orch.turn has no intent");
  const w = await openRun(root, runId);
  const s = w.state();
  const rec = journal(root, runId).at(-1);
  assert.equal(rec.type, "run.recovered");
  assert.deepEqual(rec.data, { unfinishedTurns: [], unfinishedCommands: [], previousStatus: "running" });
  assert.deepEqual([s.status, s.pausedReason], ["paused", "recovered"]);
  assert.equal(s.turns[orphan], undefined);
  assert.deepEqual(s.orch, before.orch);
  await assert.rejects(w.recordOrchTurn({ turnId: orphan, purpose: "execute", stage: 1, round: 1, planVersion: 1, clarificationVersion: 1 }), rejected);
  await w.close();
});

test("a check started without its result is not_verified(interrupted), cannot be assessed, and the journal stays valid", async () => {
  const { root, runId, before } = await crashedRun("check");
  const [checkRunId] = Object.keys(before.checks);
  // readRun already shows it interrupted; only check.finished sets the fingerprint
  assert.deepEqual([before.checks[checkRunId].reason, before.checks[checkRunId].evidenceFingerprint], ["interrupted", null]);
  const w = await openRun(root, runId);
  assert.deepEqual([w.state().checks[checkRunId].status, w.state().checks[checkRunId].reason], ["not_verified", "interrupted"]);
  assert.deepEqual([w.state().status, w.state().pausedReason], ["paused", "recovered"]);
  const n = journal(root, runId).length;
  await assert.rejects(w.recordCheckAssessed({ checkRunId, stage: 1, round: 1, checkKey: sha("k"), runKey: sha("r") }), rejected);
  assert.equal(journal(root, runId).length, n);
  await w.close();
  const read = await readRun(root, runId);
  assert.equal(read.integrity.status, "ok");
  assert.equal(read.state.checks[checkRunId].reason, "interrupted");
});

test("stage.accepted without checkpoint.created stays pending across reopen until the checkpoint is recorded", async () => {
  const { root, runId, before } = await crashedRun("accepted");
  assert.equal(before.orch.pendingCheckpoint, 1);
  const w = await openRun(root, runId);
  assert.equal(w.state().orch.pendingCheckpoint, 1);
  assert.deepEqual(w.state().orch, before.orch);
  await w.close();
  const w2 = await openRun(root, runId); // already paused: nothing written
  assert.equal(w2.state().orch.pendingCheckpoint, 1);
  await w2.recordCheckpoint({ stage: 1, commit: oid("d"), tree: oid("c"), parent: oid("b") });
  assert.equal(w2.state().orch.pendingCheckpoint, null);
  await w2.close();
  assert.equal((await readRun(root, runId)).state.orch.pendingCheckpoint, null);
});

test("OrchState and revision replay identically across repeated reopen; a paused crash is not recovered", async () => {
  const { root, runId, before } = await crashedRun("paused");
  assert.equal(before.orch.planReviewPaused, true);
  const n = journal(root, runId).length;
  const states = [];
  for (let i = 0; i < 3; i++) {
    const w = await openRun(root, runId);
    states.push(w.state());
    await w.close();
  }
  assert.equal(journal(root, runId).length, n, "no run.recovered for a paused run without unfinished work");
  for (const s of states) assert.deepEqual(s, before);
  assert.equal(before.orch.revision, 3, "running, the accepted clarify command, paused");
});
