// Pure decisions of the orchestration cycle (stage-5-contract.md §5, §10): nextAction over a hand-built replayed state,
// state keys and loop detection. No Store, no copy, no processes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, nextAction } from "../src/main/services/orchestration/cycle.ts";
import { checkKey, detectLoop, findingsKey, runKey } from "../src/main/services/orchestration/progress.ts";

const goal = (extra = {}) => ({ v: 1, text: "g", criteria: ["c"], checks: ["unit"], reviewPlan: false, limits: { ...DEFAULT_LIMITS }, createdAt: 0, ...extra });
const snap = (k = "K1") => ({ tree: "t", runKey: k, checkKeys: { unit: `ck-${k}` } });

// A run with a one-stage plan; helpers append facts the way replay would.
function run() {
  const s = {
    status: "running", turns: {}, checks: {},
    orch: {
      revision: 1, turns: {}, plan: { version: 1, turnId: "p", ref: null, firstStage: 1, stageCount: 1 }, planReviewPaused: false,
      reviews: [], accepted: {}, pendingCheckpoint: null, clarifications: 0, clarificationRefs: [], clarificationSeqs: [],
      question: null, answers: 0, answerSeqs: [], lastPausedSeq: {}, assessed: {}, limitOverrides: {}, recoveryDecisions: {},
      prepares: [], classified: {}, grants: {}, applied: 0, finish: []
    }
  };
  let seq = 10;
  const addTurn = (id, purpose, stage, round) => {
    s.turns[id] = { status: "completed" };
    s.orch.turns[id] = { purpose, stage, round, planVersion: 1, clarificationVersion: s.orch.clarifications };
  };
  addTurn("p", "plan", null, null);
  return {
    s,
    exec(id, round) { addTurn(id, "execute", 1, round); },
    check(id, status, k) { s.checks[id] = { checkId: "unit", status, reason: null }; s.orch.assessed[id] = { stage: 1, round: 1, checkKey: `ck-${k}`, runKey: k, seq: ++seq }; },
    review(id, verdict, k, stage = 1, round = 1) {
      addTurn(id, stage === null ? "final_review" : "review", stage, round);
      s.orch.reviews.push({ turnId: id, stage, verdict, runKey: k, findingsKey: "f", clarificationVersion: s.orch.clarifications, seq: ++seq });
    }
  };
}
const next = (s, g = goal(), k = "K1") => nextAction({ state: s, goal: g, limits: { ...g.limits, ...s.orch.limitOverrides }, snapshot: snap(k), now: 1, findingsOf: () => [] });

test("a stage goes execute → check → review → accept on the current keys", () => {
  const r = run();
  assert.deepEqual(next(r.s), { kind: "turn", purpose: "execute", stage: 1, round: 1 });
  r.exec("e1", 1);
  assert.deepEqual(next(r.s), { kind: "check", checkId: "unit", stage: 1, round: 1 });
  r.check("c1", "passed", "K1");
  assert.deepEqual(next(r.s), { kind: "turn", purpose: "review", stage: 1, round: 1 });
  r.review("r1", "accept", "K1");
  assert.deepEqual(next(r.s), { kind: "accept", stage: 1, reviewTurnId: "r1" });
  // the copy changed after the review: the check result and the review are stale
  assert.deepEqual(next(r.s, goal(), "K2"), { kind: "check", checkId: "unit", stage: 1, round: 1 });
});

test("the lead cannot accept a stage while a required check fails", () => {
  const r = run();
  r.exec("e1", 1);
  r.check("c1", "failed", "K1");
  r.review("r1", "accept", "K1");
  assert.deepEqual(next(r.s), { kind: "turn", purpose: "execute", stage: 1, round: 2 });
});

test("a stopped or interrupted check is not a result; a new checkRunId on the same key is not a new state", () => {
  const r = run();
  r.exec("e1", 1);
  r.check("c1", "not_verified", "K1");
  r.s.checks.c1.reason = "stopped";
  assert.equal(next(r.s).kind, "check");
  r.check("c2", "passed", "K1");
  r.check("c3", "passed", "K1");
  const def = { id: "unit", commandSha256: "x", executableSha256: "e1" };
  const deps = { lockfileSha256: null, realpath: "/n", stamp: "s" };
  assert.equal(runKey("t", [def], deps), runKey("t", [{ ...def }], { ...deps }));
  assert.notEqual(checkKey("t", def, deps), checkKey("t", def, { ...deps, stamp: "s2" }), "deps are part of the key");
  assert.notEqual(checkKey("t", def, deps), checkKey("t", { ...def, executableSha256: "e2" }, deps), "so is the program's content");
  assert.notEqual(runKey("t", [def], deps), runKey("t", [{ ...def, executableSha256: "e2" }], deps));
  assert.deepEqual(next(r.s), { kind: "turn", purpose: "review", stage: 1, round: 1 });
});

test("rule 2 stops external operations only; a run within its budget still completes", () => {
  const r = run();
  r.exec("e1", 1);
  const g = goal({ limits: { ...DEFAULT_LIMITS, turns: 2 } });
  assert.deepEqual(next(r.s, g), { kind: "pause", reason: "limit_reached", detail: "turns" }, "not even a check");
  r.check("c1", "passed", "K1");
  r.review("r1", "accept", "K1");
  r.s.orch.accepted["1"] = { reviewTurnId: "r1", tree: "t" };
  r.review("f1", "complete", "K1", null, null);
  assert.deepEqual(next(r.s, g), { kind: "complete" });
  r.s.orch.limitOverrides.turns = 99;
  assert.deepEqual(next(r.s, g), { kind: "complete" });
});

test("a clarification makes the final review stale", () => {
  const r = run();
  r.exec("e1", 1);
  r.check("c1", "passed", "K1");
  r.review("r1", "accept", "K1");
  r.s.orch.accepted["1"] = { reviewTurnId: "r1", tree: "t" };
  r.review("f1", "complete", "K1", null, null);
  r.s.orch.clarifications = 1;
  assert.deepEqual(next(r.s), { kind: "turn", purpose: "final_review", stage: null, round: null });
});

test("findingsKey ignores order, case and spacing; detectLoop finds the three §10 patterns", () => {
  assert.equal(findingsKey(["B  thing", "a"]), findingsKey(["A", "b thing"]));
  const round = (runKey, findings, failing = ["unit"]) => ({ runKey, failing, findings, findingsKey: findingsKey(findings), userInput: false, accepted: false });
  assert.equal(detectLoop([round("A", ["x"])], 3), null);
  assert.equal(detectLoop([round("A", ["x"]), round("B", ["x"])], 10), "same_findings");
  assert.equal(detectLoop([round("A", ["x"]), round("B", ["x", "y"]), round("A", ["x", "y", "z"])], 10), "repeated_state");
  assert.equal(detectLoop([round("A", ["x"]), round("B", ["x", "y"]), round("C", ["x", "y", "z"])], 2), "no_progress");
  // progress: a finding closed, a failing check passing on a new state, or user input
  assert.equal(detectLoop([round("A", ["x", "y"]), round("B", ["x"])], 10), null);
  assert.equal(detectLoop([round("A", ["x"]), round("B", ["x"], [])], 10), null);
  assert.equal(detectLoop([round("A", ["x"]), { ...round("B", ["x"]), userInput: true }], 10), null);
});

test("past the run's deadline nothing is done, not even completing a finished run", () => {
  const r = run();
  r.exec("e1", 1);
  r.check("c1", "passed", "K1");
  r.review("r1", "accept", "K1");
  r.s.orch.accepted["1"] = { reviewTurnId: "r1", tree: "t" };
  r.review("f1", "complete", "K1", null, null);
  const g = goal({ limits: { ...DEFAULT_LIMITS, runMs: 1 } });
  assert.deepEqual(next(r.s, g), { kind: "pause", reason: "limit_reached", detail: "runMs" });
  r.s.orch.pendingCheckpoint = 1;
  assert.deepEqual(next(r.s, g), { kind: "pause", reason: "limit_reached", detail: "runMs" }, "nor a pending checkpoint");
  r.s.orch.limitOverrides.runMs = 1000;
  assert.equal(next(r.s, g).kind, "checkpoint");
});
