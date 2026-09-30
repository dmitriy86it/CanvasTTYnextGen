// The next step of the orchestration cycle (stage-5-contract.md §5): a pure function of the replayed journal, the goal
// and a snapshot of the copy. Everything it looks at is in the journal, so the decision is the same before and after a
// restart; the service only carries it out.
import type { FailureClass, FinishStep, PausedReason, RunState } from "./journal.ts";
import type { AgentAccess } from "./access.ts";
import type { PrepareStep } from "./prepare.ts";
import { detectLoop, normalizeFinding } from "./progress.ts";
import type { RoundFacts } from "./progress.ts";
import type { TurnPurpose } from "./agents.ts";

export type LimitKind = "turns" | "roundsPerStage" | "replans" | "noProgressRounds" | "runMs" | "leadTurnMs" | "executorTurnMs";
export type RunLimits = Record<LimitKind, number>;
export const DEFAULT_LIMITS: Readonly<RunLimits> = Object.freeze({
  turns: 40, roundsPerStage: 8, replans: 3, noProgressRounds: 3,
  runMs: 4 * 3600_000, leadTurnMs: 20 * 60_000, executorTurnMs: 45 * 60_000
});

// The goal as recorded in run.created (canonical JSON text).
export interface Goal {
  v: 1;
  text: string;
  criteria: string[];
  checks: string[];
  reviewPlan: boolean;
  limits: RunLimits;
  createdAt: number;
  requestKey?: string; // the application's create-request identity (stage-7-contract.md §1.1); not used by the cycle
  commands?: string[]; // stage 12: the user's check command lines; checks[i] is `cmd-${i + 1}`
  workMode?: "project" | "copy" | "worktree"; // stage 12; absent: the managed copy of stages 3–11
  // stage 13, copied from the project profile when the goal is created (the run keeps what it started with)
  mode?: "autopilot" | "steps";
  prepare?: { steps: PrepareStep[] }; // run by CanvasTTY when needed; absent or empty: nothing is prepared
  finish?: GoalFinish;
  access?: AgentAccess;
}
export interface GoalFinish {
  commit: { message: string } | null;
  push: { remote: string; branch: string; remoteUrl: string | null } | null;
  qa: { environment: string; command: string; verify: string; reportsVersion?: boolean } | null; // absent: false
}

export interface Snapshot {
  tree: string;
  runKey: string;
  checkKeys: Readonly<Record<string, string>>; // per required check id
}

export type Action =
  | { kind: "none" }
  | { kind: "pause"; reason: PausedReason; detail: string }
  | { kind: "checkpoint"; stage: number; tree: string }
  | { kind: "turn"; purpose: TurnPurpose; stage: number | null; round: number | null }
  | { kind: "check"; checkId: string; stage: number | null; round: number | null }
  | { kind: "accept"; stage: number; reviewTurnId: string }
  | { kind: "complete" }
  // stage 13
  | { kind: "prepare"; reason: "start" | "check" }
  | { kind: "finish"; step: FinishStep }
  | { kind: "establish"; step: FinishStep; intentId: string };

export interface CycleInput {
  state: RunState;
  goal: Goal;
  limits: RunLimits; // the goal's, with limits.changed applied
  snapshot: Snapshot;
  now: number;
  findingsOf(reviewTurnId: string): readonly string[]; // the review's findings as recorded (texts/)
}

// A result that says nothing about the state: the operation itself did not complete, so the check runs again.
const UNFINISHED: readonly string[] = ["stopped", "interrupted", "store_failed"];

export function effectiveLimits(goal: Goal, state: RunState): RunLimits {
  return { ...goal.limits, ...state.orch.limitOverrides } as RunLimits;
}

type Review = RunState["orch"]["reviews"][number];

// Rule 2. Past the run's deadline nothing is done at all, internal steps included: a late answer cannot turn an
// expired run into completed. A spent turn budget stops only the next external operation (a turn or a check);
// checkpoint, stage.accepted and completed still go through, so a run that finished within its turns completes.
// While an operation runs, the deadline is the service's timer (§7), not this function.
export function nextAction(input: CycleInput): Action {
  const { state, goal, limits, now } = input;
  if (state.status !== "running") return { kind: "none" };
  if (now - goal.createdAt >= limits.runMs) return { kind: "pause", reason: "limit_reached", detail: "runMs" };
  const action = decide(input);
  if (action.kind !== "turn" && action.kind !== "check") return action;
  if (Object.keys(state.turns).length >= limits.turns) return { kind: "pause", reason: "limit_reached", detail: "turns" };
  return action;
}

function decide(input: CycleInput): Action {
  const { state, goal, limits, snapshot } = input;
  const orch = state.orch;
  if (state.status !== "running") return { kind: "none" };
  const pause = (reason: PausedReason, detail: string): Action => ({ kind: "pause", reason, detail });

  const turn = (purpose: TurnPurpose, stage: number | null, round: number | null): Action => ({ kind: "turn", purpose, stage, round });

  if (orch.pendingCheckpoint !== null) {
    return { kind: "checkpoint", stage: orch.pendingCheckpoint, tree: orch.accepted[String(orch.pendingCheckpoint)].tree };
  }
  if (orch.question && !orch.question.answered) return pause("awaiting_answer", orch.question.questionId);

  // Stage 13: the environment is prepared before the first turn. A failed preparation pauses once with what is
  // missing; after the person resumes from that pause it runs again. An interrupted one simply runs again.
  const prepares = orch.prepares;
  if (goal.prepare?.steps.length && !prepares.some((p) => p.reason === "start")) return { kind: "prepare", reason: "start" };
  const lastPrep = prepares.at(-1);
  if (lastPrep && lastPrep.status === "failed") {
    const reason = pauseFor(lastPrep.class ?? "environment");
    if ((orch.lastPausedSeq[reason] ?? -1) < (lastPrep.finishedSeq ?? 0)) return pause(reason, `prepare step ${lastPrep.failed}`);
    return { kind: "prepare", reason: lastPrep.reason };
  }
  // interrupted by a crash, or stopped by the application's exit or the deadline: it did not finish, so it runs again
  // (a Stop by the person ends the run, so nothing follows it)
  if (lastPrep && (lastPrep.status === "interrupted" || lastPrep.status === "stopped")) return { kind: "prepare", reason: lastPrep.reason };
  // results of checks from before a finished preparation describe another environment
  const preparedSeq = Math.max(-1, ...prepares.filter((p) => p.status === "done").map((p) => p.finishedSeq ?? -1));

  // Step by step: after every accepted (and checkpointed) stage the run stops until the person continues.
  if (goal.mode === "steps") {
    const lastAccepted = Math.max(-1, ...Object.values(orch.accepted).map((a) => a.seq));
    if (lastAccepted > (orch.lastPausedSeq["stage_done"] ?? -1)) return pause("stage_done", `stage ${Object.keys(orch.accepted).length}`);
  }

  const planVersion = orch.plan?.version ?? 0;
  const meta = (turnId: string) => orch.turns[turnId];
  const completed = (turnId: string) => state.turns[turnId]?.status === "completed";
  const inPlan = (r: Review) => meta(r.turnId)?.planVersion === planVersion;
  const leadReviews = orch.reviews.filter(inPlan);
  const replan = (): Action => {
    // planVersion plans exist; the next one is replan number planVersion
    if (planVersion > limits.replans) return pause("limit_reached", "replans");
    return turn("plan", null, null);
  };
  if (!orch.plan || leadReviews.at(-1)?.verdict === "replan") return replan();
  if (goal.reviewPlan && planVersion === 1 && !orch.planReviewPaused) return pause("plan_review", "plan version 1");

  // Checks: the latest completed result on the key of the state as it is now.
  const current = (checkId: string) => {
    let best: { status: string; seq: number; class: FailureClass | null } | null = null;
    for (const [checkRunId, a] of Object.entries(orch.assessed)) {
      const c = state.checks[checkRunId];
      if (!c || c.checkId !== checkId || a.checkKey !== snapshot.checkKeys[checkId]) continue;
      if (c.status === "not_verified" && UNFINISHED.includes(c.reason ?? "")) continue;
      if (a.seq < preparedSeq) continue;
      const cls = orch.classified[checkRunId] ?? null;
      // a failure of the environment or outside the project the person resumed from: the check runs again
      if (cls && cls !== "code" && (orch.lastPausedSeq[pauseFor(cls)] ?? -1) > a.seq) continue;
      if (!best || a.seq > best.seq) best = { status: c.status, seq: a.seq, class: c.status === "failed" ? cls : null };
    }
    return best;
  };
  const missingCheck = goal.checks.find((id) => current(id) === null);
  // Stage 13: a check that failed because of the environment or of something outside is not a task for the executor:
  // the environment is prepared once more (when there is a preparation), otherwise the run pauses with the cause.
  for (const id of goal.checks) {
    const c = current(id);
    if (!c || c.status !== "failed" || !c.class || c.class === "code") continue;
    // at most one such preparation per executor turn: a check that breaks its own environment again is the person's
    const lastExec = Math.max(-1, ...Object.values(orch.turns).filter((t) => t.purpose === "execute").map((t) => t.seq));
    if (c.class === "environment" && goal.prepare?.steps.length && !prepares.some((p) => p.reason === "check" && (p.seq > c.seq || p.seq > lastExec))) {
      return { kind: "prepare", reason: "check" };
    }
    return pause(pauseFor(c.class), id);
  }
  const allPassed = goal.checks.every((id) => current(id)?.status === "passed");
  const answeredAfter = (r: Review) => orch.question !== null && orch.question.turnId === r.turnId && orch.question.answeredSeq !== null;

  const accepted = Object.keys(orch.accepted).length;
  const plan = orch.plan;
  const total = plan.firstStage - 1 + plan.stageCount;

  if (accepted < total) {
    const s = accepted + 1;
    const stageTurns = (purpose: TurnPurpose) => Object.keys(orch.turns)
      .filter((id) => orch.turns[id].purpose === purpose && orch.turns[id].stage === s && orch.turns[id].planVersion === planVersion);
    const execs = stageTurns("execute");
    const reviews = leadReviews.filter((r) => r.stage === s);
    const lastExec = execs.at(-1);
    const round = execs.length;
    const execDone = (id: string) => completed(id) || orch.recoveryDecisions[id] === "accept";
    const roundReviews = reviews.filter((r) => meta(r.turnId).round === round);
    const lastReview = roundReviews.at(-1);
    const reviewFresh = lastReview !== undefined && lastReview.runKey === snapshot.runKey && !answeredAfter(lastReview);

    const needExecute = lastExec === undefined || !execDone(lastExec)
      || (reviewFresh && (lastReview.verdict === "fix" || (lastReview.verdict === "accept" && !allPassed)));
    if (needExecute) {
      if (round + 1 > limits.roundsPerStage) return pause("limit_reached", "roundsPerStage");
      const loop = round >= 1 ? loopOf(input, reviews) : null;
      if (loop) return pause("loop_suspected", loop);
      return turn("execute", s, round + 1);
    }
    if (missingCheck !== undefined) return { kind: "check", checkId: missingCheck, stage: s, round };
    if (!reviewFresh) return turn("review", s, round);
    // fresh review of this round: accept with every required check passed (fix and failing accept went above)
    return { kind: "accept", stage: s, reviewTurnId: lastReview.turnId };
  }

  if (missingCheck !== undefined) return { kind: "check", checkId: missingCheck, stage: null, round: null };
  const finals = leadReviews.filter((r) => r.stage === null);
  const last = finals.at(-1);
  const fresh = last !== undefined && last.runKey === snapshot.runKey
    && last.clarificationVersion === orch.clarifications && !answeredAfter(last);
  if (!fresh) return turn("final_review", null, null);
  if (last.verdict === "complete") return allPassed ? finishOrComplete(input) : replan(); // the lead cannot waive a check
  return turn("final_review", null, null); // replan and an open question were handled above
}

const pauseFor = (cls: FailureClass): PausedReason => (cls === "external" ? "external_failure" : "needs_user_action");

// Stage 13: the actions after success the goal asked for, in order (commit, push, QA), then completed. Each is about
// the checked tree now: a commit made for another tree, and a push or QA of another commit, are done again. An action
// with an unknown outcome is established first and never repeated on its own; a QA deploy's is established (its
// verification is the person's command, not known to be read-only) only after the person resumes from the pause that
// says so. A failed or unconfirmed one pauses, and only the person's resume tries it again. The run is completed only
// when every asked action is confirmed done.
const FINISH_ORDER: readonly FinishStep[] = ["commit", "push", "qa"];
type FinishRecord = RunState["orch"]["finish"][number];

// The confirmed commit of the checked tree `tree` (older journals record no tree: their commit counts).
export function currentCommit(state: RunState, tree: string): FinishRecord | null {
  const last = state.orch.finish.filter((f) => f.step === "commit").at(-1);
  return last && last.status === "done" && (last.tree === undefined || last.tree === tree) ? last : null;
}

function finishOrComplete(input: CycleInput): Action {
  const { state, goal, snapshot } = input;
  const orch = state.orch;
  const commit = currentCommit(state, snapshot.tree);
  const current = (f: FinishRecord) => f.step === "commit" ? commit === f : commit !== null && f.commit === commit.commit;
  const pausedAfter = (seq: number) => (orch.lastPausedSeq["finish_unconfirmed"] ?? -1) >= seq;
  for (const step of FINISH_ORDER) {
    if (!goal.finish?.[step]) continue;
    const last = orch.finish.filter((f) => f.step === step).at(-1);
    if (!last) return { kind: "finish", step };
    if (last.status === "done") {
      if (current(last)) continue;
      return { kind: "finish", step };
    }
    if (last.status === "outcome_unknown" || last.status === "in_flight") {
      if (step === "qa" && !pausedAfter(last.seq)) return { kind: "pause", reason: "finish_unconfirmed", detail: "qa: outcome unknown" };
      return { kind: "establish", step, intentId: last.intentId };
    }
    if (!pausedAfter(last.resultSeq ?? 0)) return { kind: "pause", reason: "finish_unconfirmed", detail: step };
    return last.status === "unknown" ? { kind: "establish", step, intentId: last.intentId } : { kind: "finish", step };
  }
  return { kind: "complete" };
}

// §10 loop detection over the reviewed rounds of stage s under the current plan; a loop the user already resumed
// from (paused(loop_suspected) after the last review) is not raised again until the next review.
function loopOf(input: CycleInput, reviews: readonly Review[]): string | null {
  const { state, goal, limits } = input;
  const orch = state.orch;
  const last = reviews.at(-1);
  if (!last) return null;
  if ((orch.lastPausedSeq["loop_suspected"] ?? -1) > last.seq) return null;
  // the last review of each round, in round order
  const byRound = new Map<number, Review>();
  for (const r of reviews) byRound.set(orch.turns[r.turnId].round as number, r);
  const ordered = [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  const inputs = [...orch.clarificationSeqs, ...orch.answerSeqs];
  const facts: RoundFacts[] = ordered.map((r, i) => {
    const prevSeq = i === 0 ? -1 : ordered[i - 1].seq;
    const failing = goal.checks.filter((id) => {
      let best: { status: string; seq: number } | null = null;
      for (const [checkRunId, a] of Object.entries(orch.assessed)) {
        const c = state.checks[checkRunId];
        if (!c || c.checkId !== id || a.runKey !== r.runKey || a.seq > r.seq) continue;
        if (!best || a.seq > best.seq) best = { status: c.status, seq: a.seq };
      }
      return best?.status !== "passed";
    });
    return {
      runKey: r.runKey, failing, findings: input.findingsOf(r.turnId).map(normalizeFinding), findingsKey: r.findingsKey,
      userInput: inputs.some((q) => q > prevSeq && q < r.seq), accepted: false
    };
  });
  return detectLoop(facts, limits.noProgressRounds);
}
