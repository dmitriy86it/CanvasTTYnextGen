// The next step of the orchestration cycle (stage-5-contract.md §5): a pure function of the replayed journal, the goal
// and a snapshot of the copy. Everything it looks at is in the journal, so the decision is the same before and after a
// restart; the service only carries it out.
import { checksPassed } from "./journal.ts";
import type { CompletionKind, FailureClass, FinishStep, PausedReason, RunState } from "./journal.ts";
import type { AgentAccess } from "./access.ts";
import type { PrepareStep } from "./prepare.ts";
import { detectLoop, findingsKey, normalizeFinding } from "./progress.ts";
import { planProposalWaits, reviewKey } from "./journal.ts";
import { conditionBlockers } from "./conditions.ts";
import type { ConditionBlocker, ConditionFacts } from "./conditions.ts";
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
  commands?: string[]; // stage 12: the user's check command lines; checks[i] is `cmd-${i + 1}`. Journal v2: may be
  // empty, and then the lead proposes them (journal-v2-format.md §2.4); the service passes the decided set here
  workMode?: "project" | "copy" | "worktree"; // stage 12; absent: the managed copy of stages 3–11
  // stage 13, copied from the project profile when the goal is created (the run keeps what it started with)
  mode?: "autopilot" | "steps";
  prepare?: { steps: PrepareStep[] }; // run by CanvasTTY when needed; absent or empty: nothing is prepared
  finish?: GoalFinish;
  access?: AgentAccess;
  models?: Partial<Record<"lead" | "executor" | "reviewer", string>>; // journal v2 only (checkGoal)
  language?: "ru" | "en"; // the interface language at creation: the person-facing texts are asked for in it
  // A1.1, the service's own (never in the goal text): the decided checks that run in the check profile — the lead's
  // lines the person did not let out of it (journal-v2-format.md §2.6)
  sandboxed?: string[];
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
  | { kind: "establish"; step: FinishStep; intentId: string }
  // journal v2 (journal-v2-format.md §2.4): the autopilot accepts the proposed check commands; the plan of the turn
  // that proposed them is recorded after they are accepted
  | { kind: "accept_checks" }
  | { kind: "record_plan"; turnId: string }
  // A3 (5h §3.1.1): the reviewer's last turn has no result and the tree is no longer the one it reviewed
  | { kind: "discard"; turnId: string };

export interface CycleInput {
  state: RunState;
  goal: Goal;
  limits: RunLimits; // the goal's, with limits.changed applied
  snapshot: Snapshot;
  now: number;
  findingsOf(reviewTurnId: string): readonly string[]; // the review's findings as recorded (texts/)
  // journal v2, A2 (journal-v2-format.md §2.7), from the texts: whether a review left a "change" condition of its stage
  // unmet, and whether the conditions and requirements block completion now. Absent: no condition rule applies.
  // A4: person(stage) — the stage's person conditions by the person's decisions in force: all met, one not met, one to
  // ask (5h §3.5); null: the stage has none.
  conditions?: { stageUnmet(stage: number, reviewTurnId: string): boolean; finalUnmet: boolean; person?(stage: number): "met" | "not_met" | "ask" | null };
  // journal v2, A3 (journal-v2-format.md §2.8), from the applied texts: an open blocking finding the stage owns, any
  // open blocking finding, a disputed item waiting for the person. Absent: the lead reviews (v1, A1–A2 journals).
  findings?: { stageHeld(stage: number): boolean; anyHeld: boolean; disputed: boolean };
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
  // A4: a decision the run waits for is the person's, even past the deadline — otherwise nothing could ever decide it
  // (5h §3.6 p. 2; a waiting proposal admits no other record)
  if (planProposalWaits(state)) return { kind: "pause", reason: "coverage_lost", detail: state.orch.proposals.at(-1)!.turnId };
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

  const turn = (purpose: TurnPurpose, stage: number | null, round: number | null): Action => {
    // A3 (5h §3.1.1): one automatic retry after a discarded review of a key; then — and after each turn the person
    // allowed — the person decides. Only the discards in a row count: a reviewer's turn of the key that was not
    // discarded (applied, or ended otherwise) starts the count again.
    if (input.findings && (purpose === "review" || purpose === "final_review")) {
      const key = reviewKey({ planVersion: orch.plan?.version ?? null, purpose, stage });
      const ofKey = Object.keys(orch.turns).filter((id) => state.turns[id]?.role === "reviewer" && reviewKey(orch.turns[id]) === key);
      const kept = Math.max(-1, ...ofKey.filter((id) => !Object.hasOwn(orch.discarded, id)).map((id) => orch.turns[id].seq));
      const permit = Math.max(kept, ...orch.reviewPermits.filter((x) => x.key === key).map((x) => x.seq));
      const permitted = orch.reviewPermits.some((x) => x.key === key && x.seq === permit);
      const dropped = ofKey.filter((id) => Object.hasOwn(orch.discarded, id) && orch.turns[id].seq > permit).length;
      if (dropped >= (permitted ? 1 : 2)) return pause("tree_changed_during_review", key);
    }
    return { kind: "turn", purpose, stage, round };
  };

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
    if (lastAccepted > (orch.lastPausedSeq.stage_done ?? -1)) return pause("stage_done", `stage ${Object.keys(orch.accepted).length}`);
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
  // Journal v2, a goal without check commands (journal-v2-format.md §2.4): the first plan turn proposes them and nothing
  // else runs until they are decided. After «Изменить» that turn's plan is dropped and a new plan turn follows.
  const p = orch.checksProposal;
  if (p && !orch.checksDecision) return autoAccepts(goal, p.sandboxNetwork, p.count) ? { kind: "accept_checks" } : pause("awaiting_checks_decision", p.turnId);
  if (p && orch.checksDecision?.decision === "accept" && !orch.plan) return { kind: "record_plan", turnId: p.turnId };
  // A4 (5h §3.6 p. 2): a plan proposal that drops conditions or requirements waits for the person before anything else
  if (planProposalWaits(state)) return pause("coverage_lost", orch.proposals.at(-1)!.turnId);
  // A3 (§2.8): a disputed finding is the person's decision; until then nothing goes on (the autopilot too)
  if (input.findings?.disputed) return pause("awaiting_person_decision", "disputed finding");
  // A3 (5h §3.1.1): a review of a tree that changed under it is dropped before anything is decided on it
  const lastId = orch.lastOrchTurn;
  if (input.findings && lastId && state.turns[lastId]?.role === "reviewer" && !["in_flight", "outcome_unknown"].includes(state.turns[lastId].status)
    && !orch.reviews.some((r) => r.turnId === lastId) && !Object.hasOwn(orch.discarded, lastId) && orch.turns[lastId].tree !== snapshot.tree) {
    return { kind: "discard", turnId: lastId };
  }
  // A4 (5h §3.6 p. 3): «Вернуть лиду» — a plan turn with the person's note; it spends no replan
  const returned = orch.proposals.at(-1)?.decision;
  if (returned?.decision === "return" && !Object.values(orch.turns).some((t) => t.purpose === "plan" && t.seq > returned.seq)) return turn("plan", null, null);
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

    const person = input.conditions?.person?.(s) ?? null;
    const needExecute = lastExec === undefined || !execDone(lastExec)
      || (reviewFresh && (lastReview.verdict === "fix" || (lastReview.verdict === "accept"
        && (!allPassed || !!input.conditions?.stageUnmet(s, lastReview.turnId) || !!input.findings?.stageHeld(s) || person === "not_met"))));
    if (needExecute) {
      if (round + 1 > limits.roundsPerStage) return pause("limit_reached", "roundsPerStage");
      const loop = round >= 1 ? loopOf(input, reviews) : null;
      if (loop) return pause("loop_suspected", loop);
      return turn("execute", s, round + 1);
    }
    if (missingCheck !== undefined) return { kind: "check", checkId: missingCheck, stage: s, round };
    if (!reviewFresh) return turn("review", s, round);
    // A4 (5h §3.5): a person condition is asked only about finished work — everything else of the stage is met now
    if (person === "ask") return pause("awaiting_person_decision", `stage ${s} condition`);
    // fresh review of this round: accept with every required check passed (fix and failing accept went above)
    return { kind: "accept", stage: s, reviewTurnId: lastReview.turnId };
  }

  if (missingCheck !== undefined) return { kind: "check", checkId: missingCheck, stage: null, round: null };
  const finals = leadReviews.filter((r) => r.stage === null);
  const last = finals.at(-1);
  const fresh = last !== undefined && last.runKey === snapshot.runKey
    && last.clarificationVersion === orch.clarifications && !answeredAfter(last);
  if (!fresh) return turn("final_review", null, null);
  // the lead cannot waive a check, nor a condition or a requirement without its evidence (A2): a new plan says why
  if (last.verdict === "complete") return allPassed && !input.conditions?.finalUnmet && !input.findings?.anyHeld ? finishOrComplete(input) : replan();
  return turn("final_review", null, null); // replan and an open question were handled above
}

const pauseFor = (cls: FailureClass): PausedReason => (cls === "external" ? "external_failure" : cls === "sandbox" ? "check_needs_permissions" : "needs_user_action");

// Owner's decision 5i §7 p. 5: the autopilot accepts proposed check commands by itself only when the sandbox the checks
// run in denies the network (A1.1: the lead's commands run in the check profile). Decision A1.1 Q1: no command
// proposed — nothing would run, the rule does not apply: the autopilot goes on to the result without checks. Step by
// step the person always decides.
export function autoAccepts(goal: Pick<Goal, "mode">, sandboxNetwork: "denied" | "open", count = 1): boolean {
  return (goal.mode ?? "autopilot") === "autopilot" && (sandboxNetwork === "denied" || count === 0);
}

// Journal v2: the plan turn proposes check commands — the first one of a goal without commands, before any proposal.
export function proposesChecks(state: RunState, goal: Pick<Goal, "commands">): boolean {
  return state.version === 2 && goal.commands?.length === 0 && state.orch.checksProposal === null;
}

// A run of journal v2 whose decided set of check commands is empty: completed without checks (§2.3).
export const withoutChecks = (state: RunState): boolean => state.version === 2 && state.orch.checksDecision?.count === 0;

// The person's push/QA decision of a run without checks for this tree and commit (journal-v2-format.md §2.1): the last
// one recorded after the commit; another tree or commit is not covered by it.
export function confirmationFor(state: RunState, tree: string, commit: string | null) {
  const commitSeq = Math.max(-1, ...state.orch.finish.filter((f) => f.step === "commit" && f.status === "done").map((f) => f.resultSeq ?? -1));
  return state.orch.confirmations.filter((c) => c.seq > commitSeq && c.tree === tree && c.commit === commit).at(-1) ?? null;
}

export type CompletionBlocker = "checks_undecided" | "plan_proposal_pending" | "stage_not_accepted" | "check_not_passed" | "final_report_stale" | "finish_pending" | "finish_awaiting_person"
  | ConditionBlocker | "blocking_open" | "disputed_pending";
// The completion function, its A1 part (journal-v2-format.md §2.3): the run may be completed only when its checks
// passed — or it has none by decision (no_checks) — every stage is accepted, the final review completes it, and every
// action after success the goal asked for is done for the current commit or declined by the person.
// A2: and every condition in force has its evidence and every requirement is met (conditions: the facts from the texts,
// null when no condition rule applies — v1 or a plan of A1's form).
// A3: and no blocking finding is open, nor a disputed item waits (findings: from the applied texts, null when the lead
// reviews). A4: and no plan proposal waits for the person; the blockers in the order of journal-v2-format.md §2.3.
export function completion(state: RunState, goal: Goal, snapshot: Pick<Snapshot, "tree" | "runKey">, conditions: ConditionFacts | null = null,
  findings: { open: number; disputed: number } | null = null):
  { allowed: true; kind: CompletionKind } | { allowed: false; blockers: CompletionBlocker[] } {
  const o = state.orch;
  const blockers: CompletionBlocker[] = [];
  if (o.checksProposal && !o.checksDecision) blockers.push("checks_undecided");
  if (planProposalWaits(state)) blockers.push("plan_proposal_pending");
  if (findings && findings.disputed > 0) blockers.push("disputed_pending");
  if (!o.plan || Object.keys(o.accepted).length < o.plan.firstStage - 1 + o.plan.stageCount) blockers.push("stage_not_accepted");
  const byConditions = conditionBlockers(conditions);
  if (byConditions.includes("condition_unmet")) blockers.push("condition_unmet");
  if (!checksPassed(state, goal.checks)) blockers.push("check_not_passed");
  if (byConditions.includes("requirement_unmet")) blockers.push("requirement_unmet");
  if (findings && findings.open > 0) blockers.push("blocking_open");
  const final = o.reviews.filter((r) => r.stage === null && o.turns[r.turnId]?.planVersion === o.plan?.version).at(-1);
  if (final?.verdict !== "complete" || final.runKey !== snapshot.runKey || final.clarificationVersion !== o.clarifications) blockers.push("final_report_stale");
  const commit = currentCommit(state, snapshot.tree);
  const confirmed = withoutChecks(state) ? confirmationFor(state, snapshot.tree, commit?.commit ?? null) : null;
  for (const step of FINISH_ORDER) {
    if (!goal.finish?.[step]) continue;
    if (step !== "commit" && withoutChecks(state)) {
      if (!confirmed?.[step]) { blockers.push("finish_awaiting_person"); continue; }
      if (confirmed[step] === "decline") continue;
    }
    const last = o.finish.filter((f) => f.step === step).at(-1);
    const done = last?.status === "done" && (step === "commit" ? last === commit : commit !== null && last.commit === commit.commit);
    if (!done) blockers.push("finish_pending");
  }
  return blockers.length ? { allowed: false, blockers } : { allowed: true, kind: goal.checks.length === 0 ? "no_checks" : "confirmed" };
}

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
  const pausedAfter = (seq: number) => (orch.lastPausedSeq.finish_unconfirmed ?? -1) >= seq;
  // v2 without checks: push and QA only as the person decided for this tree and commit, even in the autopilot
  const person = withoutChecks(state) ? confirmationFor(state, snapshot.tree, commit?.commit ?? null) : null;
  for (const step of FINISH_ORDER) {
    if (!goal.finish?.[step]) continue;
    if (step !== "commit" && withoutChecks(state)) {
      if (!person) return { kind: "pause", reason: "awaiting_finish_confirmation", detail: step };
      if (person[step] === "decline") continue;
    }
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
  if ((orch.lastPausedSeq.loop_suspected ?? -1) > last.seq) return null;
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
      // A3: a reviewer's round is keyed by the open blocking findings of the stage (5h §3.3)
      runKey: r.runKey, failing, findings: input.findingsOf(r.turnId).map(normalizeFinding), findingsKey: r.assessed ? findingsKey(input.findingsOf(r.turnId)) : r.findingsKey,
      userInput: inputs.some((q) => q > prevSeq && q < r.seq), accepted: false
    };
  });
  return detectLoop(facts, limits.noProgressRounds);
}
