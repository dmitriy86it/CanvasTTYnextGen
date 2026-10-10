// The task board (stage B, docs/agent-orchestration/implementation/stage-b-board.md). What the person set is kept in
// orchestration/board.json; a task's status is never kept: it is worked out here from the task's runs, by the same
// rules for the board, the agent cards, the activity widget and the summary (the cycle's principle 8).
import type { OrchestrationBaseRef, OrchestrationGoalInput, OrchestrationProjectProfile, OrchestrationRunStatus, OrchestrationRunView, OrchestrationTurnPurpose, OrchestrationWorkMode } from "./orchestration.ts";

export const BOARD_VERSION = 1;

export interface BoardTask {
  id: string; // UUID, permanent
  key: string; // "T-<n>": its number in the workspace for people; n is never reused
  workspaceId: string; // the owner, like a run's; it does not follow the cards
  project: string; // the project folder (realpath): only a link of this folder runs it
  title: string; // 1..200
  text: string; // 1..8000, becomes goal.text
  criteria: string[]; // 1..32 × 1..500, become goal.criteria
  dependsOn: string[]; // tasks of the same workspace, no cycles
  order: number; // its place in the queue
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  // «Accept the result» (owner's decision 2): the person's decision about one run completed without checks. It counts
  // only while that run is the task's latest and its journal says completed / no_checks (taskStatus checks both), so
  // editing the file can never make a confirmed «Done», nor «accepted» of another run.
  accepted: { runId: string; at: string } | null;
}

export interface BoardTaskInput {
  workspaceId: string;
  project: string;
  title: string;
  text: string;
  criteria: string[];
  dependsOn?: string[];
}
export type BoardTaskPatch = Partial<Pick<BoardTaskInput, "title" | "text" | "criteria" | "dependsOn">> & { order?: number };

// What main gives the renderer: the board as stored (readOnly: a newer version's file, or a damaged one that could not
// be set aside) and the facts of the runs that name a task.
export interface BoardView {
  board: Board;
  readOnly: null | "newer_version" | "damaged_unmoved";
  facts: RunTaskFacts[];
  autopilot: Record<string, AutopilotState>; // linkId → the board's autopilot of that link, as main holds it now
  heads?: BoardHead[]; // C1: the board's merged head of each workspace and project that has one
}

// C1 (stage-c-parallel.md §4): the board's merged head — a ref of the project outside refs/heads that only a merge run
// moves — and the merge runs into it, as their v3 journals say (never board.json: principle 8).
export interface BoardHead {
  workspaceId: string;
  project: string;
  ref: string; // refs/raoden/board/<workspaceId>/<n>
  n: number;
  commit: string;
  merges: BoardMerge[]; // into this head, the newest first
}
export type BoardMergeStatus = "preparing" | "running" | "paused" | "completed" | "stopped" | "failed";
export interface BoardMerge {
  runId: string;
  board: string; // the head's ref
  base: string; // the head it was built on
  task: { id: string; key: string; runId: string; commit: string };
  status: BoardMergeStatus;
  // paused: merge_conflict | merge_checks_failed | merge_prepare_failed | merge_prepare_changed | recovered;
  // stopped: skipped | interrupted; failed: head_moved | error; completed: null | already (the result was in the head)
  reason: string | null;
  detail: string | null;
  completion: "confirmed" | "no_checks" | null;
  conflicts: string[];
  outside: string[]; // files out of the conflict the resolution changed (the mechanical condition)
  interference: boolean; // the checks failed twice: possibly another task's port or process
  retrying: boolean; // the first checks failed; the retry waits for the project to be quiet
  dir: string | null; // the merge copy, where the person resolves
  createdAt: number;
}

// A task's mark on the board (§4.4): its latest merge into the current head of its place — of its current run (a task
// run again is a new result: an older merge says nothing of it)
export type MergeMark = { kind: "in_board"; checks: boolean } | { kind: "merging" } | { kind: "not_merged"; reason: string; waits: boolean; runId: string } | null;
export const mergeOfTask = (head: Pick<BoardHead, "merges"> | null | undefined, taskId: string, runId?: string | null): BoardMerge | undefined =>
  head?.merges.find((x) => x.task.id === taskId && (runId === undefined || x.task.runId === runId));
export function mergeMark(taskId: string, head: BoardHead | undefined, runId?: string | null): MergeMark {
  const m = mergeOfTask(head, taskId, runId);
  if (!m) return null;
  if (m.status === "completed") return { kind: "in_board", checks: m.completion === "confirmed" };
  if (m.status === "preparing" || m.status === "running") return { kind: "merging" };
  return { kind: "not_merged", reason: m.reason ?? m.status, waits: m.status === "paused", runId: m.runId };
}

// B4 (§5.1): the board's autopilot of a link. on — never stored (a restart turns it off); the budget is board.json's;
// used — the runs it started since it was turned on and their working minutes; stop — why it turned itself off last.
// parallel (C1, §2.1): tasks at once, 1..4, in a separate copy only; absent: 2
export interface AutopilotBudget { runs: number; minutes: number; parallel?: number }
export const AUTOPILOT_BUDGET: AutopilotBudget = { runs: 5, minutes: 240 };
export const AUTOPILOT_PARALLEL = 2;
export const parallelOf = (b: AutopilotBudget): number => (Number.isInteger(b.parallel) && b.parallel! >= 1 && b.parallel! <= 4 ? b.parallel! : AUTOPILOT_PARALLEL);
export type AutopilotStopCode = "all_done" | "others_wait" | "budget_runs" | "budget_minutes" | "run_stopped" | "run_failed" | "limit_reached"
  | "run_paused" | "run_unreadable" | "settings_changed" | "grant_added" | "not_ready" | "take_failed" | "start_failed" | "worktree_base" | "link_gone" | "task_gone"
  | "head_moved" | "merge_failed";
export interface AutopilotWaiting { key: string; reason: TaskReason | null; waitsFor: string[] }
export interface AutopilotStop { code: AutopilotStopCode; detail: string | null; key: string | null; at: string; waiting?: AutopilotWaiting[] }
export interface AutopilotState {
  on: boolean;
  budget: AutopilotBudget;
  used: { runs: number; minutes: number };
  waits: string | null; // on, and waiting: for what (a run, the person)
  stop: AutopilotStop | null;
}

export interface Board {
  v: typeof BOARD_VERSION;
  tasks: BoardTask[];
  counters: Record<string, number>; // workspaceId → the last n given
  // B2: where the board card is on each workspace's canvas (absent: not shown there). Here and not in canvas.json:
  // 1.5.12/1.5.13 write canvas.json back with the keys they know only (stage-b-board.md §6).
  places?: Record<string, BoardPlace>;
  // B4: the budget of the board's autopilot of each link (only the budget: whether it is on is never stored)
  autopilot?: Record<string, AutopilotBudget>;
}
export interface BoardPlace { position: { x: number; y: number }; size: { width: number; height: number } }

// What the board needs of one run: from its view (the snapshot every screen reads) and its journal, worked out in main.
export interface RunTaskFacts {
  runId: string;
  taskId: string | null; // goal.task.id
  taskKey: string | null; // goal.task.key
  // the goal's createdAt: the latest run of a task is its current one. ponytail: the wall clock of the start; a clock
  // set back between two runs of one task would order them wrong (a journal sequence across runs does not exist)
  createdAt: number;
  workspaceId: string; // the run's owner (canvas.json owners): only its workspace's tasks count it
  status: OrchestrationRunStatus | "unreadable";
  reason: string | null;
  newer: boolean; // a newer version's journal: read only
  halted: boolean; // running, but stopped by a condition in main (the view's halted)
  limit: string | null; // the limit a limit_reached pause stopped at (view.progress.budget.reached)
  completion: "confirmed" | "no_checks" | null;
  phase: "work" | "review"; // the active turn's, else the last turn's (no column flickers between turns)
  permission: boolean; // a permission request waits for the person
  workMode: OrchestrationWorkMode | null;
  // «Take the result» of its current result (taken.json): the branch made and the commit it points to, applied or not
  taken: { branch: string | null; commit?: string | null; applied: boolean } | null;
  board?: string | null; // C1: the board head ref its copy started from (goal.base.branch), else null
}

export type TaskColumn = "queue" | "work" | "review" | "done";
export type TaskReason =
  | "run_unreadable" | "waits_permission" | "waits_answer" | "waits_decision" | "limit_reached" | "waits_task"
  | "waits_result" | "waits_merge" | "last_stopped" | "last_failed" | "no_checks" | "stopping" | "run_newer" | "paused_other";

export interface TaskStatus {
  column: TaskColumn;
  done: "confirmed" | "accepted" | null; // «Done» confirmed by checks, or accepted by the person without checks
  reason: TaskReason | null;
  waitsFor: string[]; // the keys of the tasks it waits for (waits_task, waits_result, waits_merge)
  cycle: boolean; // waits_task because its dependencies make a cycle (a hand-edited board.json)
  attempts: number;
  current: string | null; // runId of the latest run
  completion: "confirmed" | "no_checks" | null;
  // B3 (§4.2): what its dependencies are now, whatever its own column: «waits_task» (one not «Done», or a cycle),
  // «waits_result» (a result where this task would not see it), or null — ready. main refuses a start without «Start
  // anyway» unless it is null; the board offers «Start» or «Start anyway» by it.
  depsWait: { reason: "waits_task" | "waits_result" | "waits_merge"; waitsFor: string[]; cycle: boolean } | null;
  // B3 (§4.2): a «Done» task on a dependency that is not «Done» now — never rolled back, only said: «changed» (it was
  // «Done» when this task's run started, then lost it), «not_ready» (it was not: this task was started anyway). It goes
  // on to the tasks after it. Recomputing a result is stage D.
  depsNote: null | "changed" | "not_ready";
}

const REVIEW_PURPOSES: readonly OrchestrationTurnPurpose[] = ["review", "final_review"];
const DECISIONS = new Set(["plan_review", "awaiting_checks_decision", "awaiting_finish_confirmation", "awaiting_person_decision",
  "coverage_lost", "check_needs_permissions", "finish_unconfirmed"]);

// The column of a run that works: a check or a review turn is «Review», anything else «Work». Between turns, the last
// turn's purpose (from the journal) decides.
export function runPhase(view: Pick<OrchestrationRunView, "active">, lastPurpose: OrchestrationTurnPurpose | null): "work" | "review" {
  const a = view.active;
  if (a?.kind === "check") return "review";
  if (a?.kind === "turn") return REVIEW_PURPOSES.includes(a.purpose) ? "review" : "work";
  if (a) return "work";
  return lastPurpose && REVIEW_PURPOSES.includes(lastPurpose) ? "review" : "work";
}

const isDone = (s: TaskStatus | undefined) => !!s?.done;

// The statuses of all tasks of a board from the facts of all runs. Dependencies are followed without trusting the file:
// the tasks on a cycle (a hand-edited board.json) are found first; one not started waits («waits_task», cycle), and
// nothing loops. A run counts for a task of its own workspace only.
export function boardStatuses(board: Pick<Board, "tasks">, facts: readonly RunTaskFacts[]): Map<string, TaskStatus> {
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const depsOf = (t: BoardTask) => t.dependsOn.filter((d) => byId.has(d));
  const runsOf = new Map<string, RunTaskFacts[]>();
  for (const f of facts) {
    const t = f.taskId ? byId.get(f.taskId) : undefined;
    if (t && f.workspaceId === t.workspaceId) runsOf.set(t.id, [...(runsOf.get(t.id) ?? []), f]);
  }
  // ponytail: a search from each task, O(n·(n+e)); the board holds at most 2000 tasks of a few dependencies each
  const onCycle = new Set<string>();
  for (const t of board.tasks) {
    const seen = new Set<string>();
    const stack = depsOf(t);
    while (stack.length) {
      const id = stack.pop()!;
      if (id === t.id) { onCycle.add(t.id); break; }
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...depsOf(byId.get(id)!));
    }
  }
  const out = new Map<string, TaskStatus>();
  const statusOf = (id: string): TaskStatus => {
    const known = out.get(id);
    if (known) return known;
    const task = byId.get(id)!;
    const mine = own(task, runsOf.get(id) ?? []);
    // a task off every cycle depends only on tasks off cycles or on them (never recursed into): this ends
    const depsWait: TaskStatus["depsWait"] = onCycle.has(id)
      ? { reason: "waits_task", cycle: true, waitsFor: depsOf(task).filter((d) => onCycle.has(d)).map((d) => byId.get(d)!.key) }
      : dependencies(depsOf(task).map((d) => [byId.get(d)!, statusOf(d)] as const), runsOf);
    let s: TaskStatus = { ...mine, depsWait };
    if (s.done && !onCycle.has(id)) s = { ...s, depsNote: noteOf(task, s, depsOf(task).map((d) => [byId.get(d)!, statusOf(d)] as const), runsOf) };
    // the queue shows what it waits for; a task at work or in review keeps its run's reason
    else if (depsWait && s.column === "queue" && s.reason !== "run_newer") s = { ...s, reason: depsWait.reason, waitsFor: depsWait.waitsFor, cycle: depsWait.cycle };
    out.set(id, s);
    return s;
  };
  for (const t of board.tasks) statusOf(t.id);
  return out;
}

// A task by its own runs only.
export function own(task: Pick<BoardTask, "accepted">, runs: readonly RunTaskFacts[]): TaskStatus {
  const sorted = [...runs].sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  const base = { attempts: sorted.length, waitsFor: [] as string[], cycle: false, done: null, depsWait: null, depsNote: null };
  const current = sorted.at(-1);
  if (!current) return { ...base, column: "queue", reason: null, current: null, completion: null };
  const readable = [...sorted].reverse().find((r) => r.status !== "unreadable" && !r.newer);
  const head = { ...base, current: current.runId, completion: current.completion };
  if (current.newer) return { ...head, column: "queue", reason: "run_newer" };
  if (current.status === "unreadable") {
    // the column of the last run that can be read, the reason of this one
    const prev = readable ? own({ accepted: null }, [readable]) : null;
    return { ...head, column: prev?.column === "done" ? "review" : prev?.column ?? "queue", reason: "run_unreadable" };
  }
  const phase: TaskColumn = current.phase === "review" ? "review" : "work";
  switch (current.status) {
    case "completed": {
      if (current.completion === "confirmed") return { ...head, column: "done", done: "confirmed", reason: null };
      if (current.completion === "no_checks") {
        return task.accepted?.runId === current.runId ? { ...head, column: "done", done: "accepted", reason: null } : { ...head, column: "review", reason: "no_checks" };
      }
      return { ...head, column: "review", reason: "paused_other" }; // a completed run without its completion kind: not «Done»
    }
    case "stopped": return { ...head, column: "queue", reason: "last_stopped" };
    case "failed": return { ...head, column: "queue", reason: "last_failed" };
    case "stopping": case "pausing": return { ...head, column: phase, reason: "stopping" };
    case "paused": {
      const r = current.reason ?? "";
      const reason: TaskReason = current.permission ? "waits_permission" : r === "awaiting_answer" ? "waits_answer"
        : DECISIONS.has(r) ? "waits_decision" : r === "limit_reached" ? "limit_reached" : "paused_other";
      return { ...head, column: phase, reason };
    }
    default: return { ...head, column: phase, reason: current.permission ? "waits_permission" : current.halted ? "paused_other" : null }; // preparing, running
  }
}

// What a task's dependencies make it wait for: the tasks not «Done», then a result that is not where a dependent task
// would see it (stage-b-board.md §5.2, the base rule); null — ready.
function dependencies(deps: readonly (readonly [BoardTask, TaskStatus])[], runsOf: Map<string, RunTaskFacts[]>): TaskStatus["depsWait"] {
  const notDone = deps.filter(([, d]) => !isDone(d)).map(([t]) => t.key);
  if (notDone.length) return { reason: "waits_task", waitsFor: notDone, cycle: false };
  const where = deps.map(([t, d]) => [t, resultOf(runsOf.get(t.id)?.find((r) => r.runId === d.current))] as const);
  const notTaken = where.filter(([, w]) => w === "none").map(([t]) => t.key);
  if (notTaken.length) return { reason: "waits_result", waitsFor: notTaken, cycle: false };
  // owner's decision 11: a result in a branch is the base of a separate copy — one of them, and nothing else to join
  // with it; a second result (another branch, or one in the folder) would need a merge: stage C, the person's
  if (where.some(([, w]) => w === "branch") && where.length > 1) return { reason: "waits_merge", waitsFor: where.map(([t]) => t.key), cycle: false };
  return null;
}

// A «Done» task's dependencies now: one not «Done» was «Done» by a run before this task's run started (it changed after),
// or it never was (this task was started anyway); a dependency's own note goes on to the tasks after it.
function noteOf(task: BoardTask, s: TaskStatus, deps: readonly (readonly [BoardTask, TaskStatus])[], runsOf: Map<string, RunTaskFacts[]>): TaskStatus["depsNote"] {
  const since = runsOf.get(task.id)?.find((r) => r.runId === s.current)?.createdAt ?? Infinity;
  // the dependency's latest run before this task's run started, and it ended «Done» (review of B3: not any earlier one)
  const wasDone = (t: BoardTask) => {
    const r = (runsOf.get(t.id) ?? []).filter((x) => x.createdAt < since).sort((a, b) => a.createdAt - b.createdAt).at(-1);
    return !!r && r.status === "completed" && (r.completion === "confirmed" || (r.completion === "no_checks" && t.accepted?.runId === r.runId));
  };
  const notes = deps.map(([t, d]) => (!isDone(d) ? (wasDone(t) ? "changed" : "not_ready") : d.depsNote));
  return notes.includes("not_ready") ? "not_ready" : notes.includes("changed") ? "changed" : null;
}

// Where a dependency's result is for a task after it: in the project folder (it worked there, or its result was applied),
// in a branch of the project only («Create a branch»), or not taken at all.
function resultOf(run: RunTaskFacts | undefined): "folder" | "branch" | "none" {
  if (!run || (run.workMode !== "copy" && run.workMode !== "worktree") || run.taken?.applied) return "folder";
  return run.taken?.branch && run.taken.commit ? "branch" : "none";
}

// B4 (owner's decision 11): what a task's separate copy starts from — the working folder (null), or the one dependency
// result that is in a branch only. Asked only of a task without a reason (all dependencies «Done», nothing to merge).
export function baseOf(task: Pick<BoardTask, "dependsOn">, board: Pick<Board, "tasks">, statuses: ReadonlyMap<string, TaskStatus>,
  facts: readonly RunTaskFacts[]): { branch: string; commit: string; key: string } | null {
  for (const id of task.dependsOn) {
    const dep = board.tasks.find((t) => t.id === id);
    const run = facts.find((f) => f.runId === statuses.get(id)?.current);
    if (dep && run && resultOf(run) === "branch") return { branch: run.taken!.branch!, commit: run.taken!.commit!, key: dep.key };
  }
  return null;
}

// B4 (§5.1): the board's autopilot takes, of the tasks of the link's workspace and the lead's folder, not archived, in
// the queue without a reason and never tried (a retry after stopped or failed is the person's), the first by order.
export function nextTask(board: Pick<Board, "tasks">, statuses: ReadonlyMap<string, TaskStatus>, at: { workspaceId: string; project: string }): BoardTask | null {
  return board.tasks.filter((t) => {
    const s = statuses.get(t.id);
    // a dependency «Done» on a shaky base (its own dependency changed, or it was started anyway) is the person's call
    return t.workspaceId === at.workspaceId && t.project === at.project && !t.archivedAt && s?.column === "queue" && s.reason === null && s.attempts === 0
      && !t.dependsOn.some((d) => statuses.get(d)?.depsNote);
  }).sort((a, b) => a.order - b.order)[0] ?? null;
}

// Why there is no next task: every task of the place «Done», or the ones left wait (their keys with their reasons)
export function idleOf(board: Pick<Board, "tasks">, statuses: ReadonlyMap<string, TaskStatus>, at: { workspaceId: string; project: string }):
  { allDone: boolean; waiting: { key: string; reason: TaskReason | null; waitsFor: string[] }[] } {
  const mine = board.tasks.filter((t) => t.workspaceId === at.workspaceId && t.project === at.project && !t.archivedAt);
  const left = mine.filter((t) => !statuses.get(t.id)?.done);
  return { allDone: left.length === 0, waiting: left.map((t) => ({ key: t.key, reason: statuses.get(t.id)?.reason ?? null, waitsFor: statuses.get(t.id)?.waitsFor ?? [] })) };
}

// Owner's decision 8: in the board's autopilot, a task that became «Done» (confirmed or accepted) gets its result taken
// as a branch in the project — the safe action that touches no working folder. Nothing to do for a run in the project
// folder (its changes are there) or one whose result is in a branch already. The call is B4's.
export function autoTakeOnDone(status: TaskStatus, run: Pick<RunTaskFacts, "runId" | "workMode" | "taken"> | undefined): "branch" | null {
  if (!status.done || !run || run.runId !== status.current) return null;
  if (run.workMode !== "copy" && run.workMode !== "worktree") return null;
  return run.taken?.branch ? null : "branch";
}

// B4 (§5.1): what a start takes from the project settings — the same for the goal dialog (its defaults, which the
// person may change) and for the board's autopilot (as they are). Main fills the rest in (resolveGoal: rights,
// preparation). The actions after success: the commit only, as the dialog offers it, never in a separate copy.
export function profileGoal(profile: Pick<OrchestrationProjectProfile, "checks" | "workMode" | "finish" | "models">) {
  return {
    commands: [...profile.checks],
    workMode: profile.workMode,
    finish: { commit: profile.finish.commit, push: false, qa: false },
    models: profile.models ?? { lead: null, executor: null, reviewer: null }
  };
}

// The goal of a task's start by the autopilot: the task's text and requirements, the settings as they are, in the
// autopilot mode, from the base its dependency left (owner's decision 11).
export function goalFor(task: Pick<BoardTask, "id" | "key" | "text" | "criteria">, profile: Pick<OrchestrationProjectProfile, "checks" | "workMode" | "finish" | "models">,
  opts: { optionalChecks: boolean; language: "ru" | "en"; base: OrchestrationBaseRef | null }): OrchestrationGoalInput {
  const p = profileGoal(profile);
  const finish = p.workMode !== "copy" && p.finish.commit ? { finish: p.finish } : {};
  return {
    ...(opts.optionalChecks ? { models: p.models } : {}),
    text: task.text, criteria: [...task.criteria], checks: [], commands: p.commands, workMode: p.workMode, mode: "autopilot", reviewPlan: false,
    language: opts.language, task: { id: task.id, key: task.key }, ...finish, limits: {},
    ...(opts.base && p.workMode === "copy" ? { base: opts.base } : {})
  };
}

// B4 (§5.2): the pauses of a run the autopilot waits through — the person answers, the run goes on
const WAIT_PAUSES = new Set(["awaiting_answer", "plan_review", "awaiting_checks_decision", "awaiting_finish_confirmation", "awaiting_person_decision",
  "stage_done", "step_done"]);
const ACTIVE = new Set(["created", "preparing", "running", "pausing", "stopping"]);

// The working time of a run by its journal: from its first record, without the pauses that wait for the person, to its
// end or now. A permission request is not journaled: it counts as work (§5.2 — the budget ends sooner, never later).
export function activeMs(records: readonly { ts: string; type: string; data: Record<string, unknown> }[], now: number): number {
  let total = 0;
  let from: number | null = records.length ? Date.parse(records[0]!.ts) : null;
  for (const r of records) {
    if (r.type !== "run.status") continue;
    const at = Date.parse(r.ts);
    const status = String(r.data.status ?? "");
    const working = status !== "paused" ? ACTIVE.has(status) : !WAIT_PAUSES.has(String(r.data.reason ?? ""));
    if (from !== null && !working) { total += Math.max(0, at - from); from = null; } else if (from === null && working) from = at;
  }
  return total + (from !== null ? Math.max(0, now - from) : 0);
}

export type AutopilotStep =
  | { kind: "wait"; why: string }
  | { kind: "take"; runId: string; key: string }
  | { kind: "start"; task: BoardTask; base: OrchestrationBaseRef | null }
  | { kind: "off"; code: AutopilotStopCode; detail: string | null; key: string | null; waiting?: AutopilotWaiting[] };

// B4 (§5.2): what the board's autopilot of a link does next, from the board and the facts of the runs alone (the
// settings, the readiness and the start itself are main's). last: the run it started last (null: none yet).
export function autopilotStep(board: Pick<Board, "tasks">, facts: readonly RunTaskFacts[], at: { workspaceId: string; project: string; workMode: OrchestrationWorkMode },
  last: string | null, used: { runs: number; ms: number }, budget: AutopilotBudget): AutopilotStep {
  const statuses = boardStatuses(board, facts);
  const run = last ? facts.find((f) => f.runId === last) : undefined;
  const task = run?.taskId ? board.tasks.find((t) => t.id === run.taskId) : undefined;
  if (last && !run) return { kind: "wait", why: "run" }; // its journal is not there yet
  if (run && !task) return { kind: "off", code: "task_gone", detail: run.taskKey, key: run.taskKey };
  if (run && task) {
    const key = task.key;
    if (run.newer || run.status === "unreadable") return { kind: "off", code: "run_unreadable", detail: null, key };
    if (run.permission) return { kind: "wait", why: "permission" };
    if (run.status === "stopped") return { kind: "off", code: "run_stopped", detail: run.reason, key };
    if (run.status === "failed") return { kind: "off", code: "run_failed", detail: run.reason, key };
    if (run.status === "paused") {
      if (WAIT_PAUSES.has(run.reason ?? "")) return { kind: "wait", why: "person" };
      return run.reason === "limit_reached" ? { kind: "off", code: "limit_reached", detail: run.limit, key } : { kind: "off", code: "run_paused", detail: run.reason, key };
    }
    if (run.status !== "completed") return run.halted ? { kind: "off", code: "run_paused", detail: run.reason, key } : { kind: "wait", why: "run" };
    const s = statuses.get(task.id)!;
    if (s.current === run.runId && s.reason === "no_checks") return { kind: "wait", why: "accept" };
    if (s.current === run.runId && !s.done) return { kind: "off", code: "run_paused", detail: run.reason, key };
    if (autoTakeOnDone(s, run) === "branch") return { kind: "take", runId: run.runId, key };
  }
  const next = nextTask(board, statuses, at);
  // another run of this place goes on (the person's, another link's): what it leaves may free the next task
  // (a run paused for another reason waits for nobody: the others wait, said as such)
  const busyHere = facts.some((f) => (ACTIVE.has(f.status) || f.permission || (f.status === "paused" && WAIT_PAUSES.has(f.reason ?? "")))
    && board.tasks.some((t) => t.id === f.taskId && t.workspaceId === at.workspaceId && t.project === at.project));
  if (!next && busyHere) return { kind: "wait", why: "run" };
  if (!next) {
    const idle = idleOf(board, statuses, at);
    if (idle.allDone) return { kind: "off", code: "all_done", detail: null, key: null };
    const detail = idle.waiting.map((w) => (w.waitsFor.length ? `${w.key} (${w.reason}: ${w.waitsFor.join(", ")})` : `${w.key} (${w.reason ?? "-"})`)).join("; ");
    return { kind: "off", code: "others_wait", detail, key: null, waiting: idle.waiting };
  }
  // the budget is asked before a start only: a last run that ends the board ends it «all done»
  if (used.runs >= budget.runs) return { kind: "off", code: "budget_runs", detail: String(budget.runs), key: null };
  if (used.ms >= budget.minutes * 60_000) return { kind: "off", code: "budget_minutes", detail: String(budget.minutes), key: null };
  const base = baseOf(next, board, statuses, facts);
  // a worktree starts from HEAD: from a ref is stage C (§5.2); a copy takes the branch (owner's decision 11)
  if (base && at.workMode !== "copy") return { kind: "off", code: "worktree_base", detail: base.key, key: next.key };
  return { kind: "start", task: next, base };
}

// C1 (stage-c-parallel.md §2, §4.5, §8): the board's autopilot of a link in a separate copy, with N slots and the board's
// merged head. One action per step, from the board, the facts of the runs and the head alone:
// - head: there is something to start or merge and no head yet — main starts it from the working folder;
// - take: a task «Done» by a run in a copy gets its result branch (decision 8), as in B;
// - merge: a task «Done», started from this head, not in it and never merged into it — one at a time, the oldest first;
// - start: a free slot and a task without a reason (its dependencies, if any, in the head), from the head.
// It waits while a run or a merge goes on or the person is asked; it is off, with a reason, when nothing goes on and
// nothing waits for the person. started: the runs it started (stops of those decide); slots count every run of the place.
export type AutopilotParallelStep = AutopilotStep | { kind: "head" } | { kind: "merge"; taskId: string; key: string; runId: string; commit: string };
const MERGE_ACTIVE = new Set(["preparing", "running"]);
export function autopilotParallelStep(board: Pick<Board, "tasks">, facts: readonly RunTaskFacts[], at: { workspaceId: string; project: string },
  started: readonly string[], used: { runs: number; ms: number }, budget: AutopilotBudget, head: BoardHead | null): AutopilotParallelStep {
  const statuses = boardStatuses(board, facts);
  const place = board.tasks.filter((t) => t.workspaceId === at.workspaceId && t.project === at.project);
  const mergeOf = (taskId: string) => mergeOfTask(head, taskId, statuses.get(taskId)?.current ?? null);
  const inHead = (taskId: string) => mergeOf(taskId)?.status === "completed";
  let halt: { code: AutopilotStopCode; detail: string | null; key: string | null } | null = null;
  let person: string | null = null; // what the person is asked: a permission, a decision in a run, «Accept the result», a merge
  // the runs it started: a stop or a failure takes no new task; a question of the person waits
  for (const id of started) {
    const run = facts.find((f) => f.runId === id);
    if (!run) return { kind: "wait", why: "run" }; // its journal is not there yet
    const task = board.tasks.find((t) => t.id === run.taskId);
    if (!task) { halt ??= { code: "task_gone", detail: run.taskKey, key: run.taskKey }; continue; }
    const s = statuses.get(task.id)!;
    if (s.current !== run.runId) continue; // a later run of the task (the person's) is the person's
    const key = task.key;
    if (run.newer || run.status === "unreadable") halt ??= { code: "run_unreadable", detail: null, key };
    else if (run.permission) person ??= "permission";
    else if (run.status === "stopped") halt ??= { code: "run_stopped", detail: run.reason, key };
    else if (run.status === "failed") halt ??= { code: "run_failed", detail: run.reason, key };
    else if (run.status === "paused") {
      if (WAIT_PAUSES.has(run.reason ?? "")) person ??= "person";
      else halt ??= run.reason === "limit_reached" ? { code: "limit_reached", detail: run.limit, key } : { code: "run_paused", detail: run.reason, key };
    } else if (run.status !== "completed") { if (run.halted) halt ??= { code: "run_paused", detail: run.reason, key }; }
    else if (s.reason === "no_checks") person ??= "accept";
    else if (!s.done) halt ??= { code: "run_paused", detail: run.reason, key };
    else if (autoTakeOnDone(s, run) === "branch") return { kind: "take", runId: run.runId, key };
  }
  // the merges: one at a time; a paused one waits for the person, the head moved by someone else ends it
  const merges = head?.merges ?? [];
  const merging = merges.some((m) => MERGE_ACTIVE.has(m.status));
  if (merges.some((m) => m.status === "paused")) person ??= "merge";
  // the head moved by someone else: only while that is the latest merge (a later one went on from the new value)
  const moved = merges[0]?.status === "failed" && merges[0].reason === "head_moved" ? merges[0] : undefined;
  if (moved) halt ??= { code: "head_moved", detail: moved.task.key, key: moved.task.key };
  // a «Done» task whose merge failed or was interrupted is not in the result and nothing will merge it: the person
  // decides (§4.3); «Пропустить» is the person's decision already
  for (const t of place) {
    const m = statuses.get(t.id)?.done && !t.archivedAt ? mergeOf(t.id) : undefined;
    if (m && m !== moved && (m.status === "failed" || (m.status === "stopped" && m.reason !== "skipped"))) halt ??= { code: "merge_failed", detail: m.reason, key: t.key };
  }
  const retrying = merges.some((m) => m.retrying);
  // what is «Done», started from this head and not in it yet: the oldest first (reconciliation, §4.5)
  const pending = place.map((t) => ({ t, s: statuses.get(t.id)!, run: facts.find((f) => f.runId === statuses.get(t.id)?.current) }))
    .filter(({ t, s, run }) => s.done && run && head && run.board === head.ref && run.workMode === "copy" && !mergeOf(t.id)
      && (run.taken?.commit || autoTakeOnDone(s, run) === "branch"))
    .sort((a, b) => a.run!.createdAt - b.run!.createdAt);
  const take = pending.find(({ s, run }) => autoTakeOnDone(s, run) === "branch");
  if (take) return { kind: "take", runId: take.run!.runId, key: take.t.key };
  const ready = pending.find(({ run }) => run!.taken?.commit);
  // a stop takes no new task, but what is «Done» still goes into the head; not onto a head moved by someone else
  if (ready && !merging && !merges.some((m) => m.status === "paused") && !moved) {
    return { kind: "merge", taskId: ready.t.id, key: ready.t.key, runId: ready.run!.runId, commit: ready.run!.taken!.commit! };
  }
  // the slots: every run of the place that is not over (a pause holds its copy and may go on)
  const SLOT = new Set(["created", "preparing", "running", "pausing", "stopping", "paused"]);
  const busy = facts.filter((f) => place.some((t) => t.id === f.taskId) && (SLOT.has(f.status) || f.permission
    || (f.status === "completed" && statuses.get(f.taskId!)?.reason === "no_checks" && statuses.get(f.taskId!)?.current === f.runId))).length;
  const goingOn = busy > 0 || merging || (pending.length > 0 && !moved);
  if (halt) return goingOn || person ? { kind: "wait", why: "run" } : { kind: "off", ...halt };
  // a task without a reason, never tried; a dependency counts once it is in the head (owner's decision 9), or its result
  // is in the working folder (it worked there, or was applied) — the head starts from that folder. ponytail: a folder
  // result that came after the head started is not in it; «Начать новый итог доски» takes it in
  const resultIn = (d: string) => resultOf(facts.find((f) => f.runId === statuses.get(d)?.current)) === "folder";
  const next = place.filter((t) => {
    const s = statuses.get(t.id);
    if (!s || t.archivedAt || s.column !== "queue" || s.attempts !== 0 || t.dependsOn.some((d) => statuses.get(d)?.depsNote)) return false;
    if (!t.dependsOn.length) return s.reason === null;
    return t.dependsOn.every((d) => !board.tasks.some((x) => x.id === d) || (statuses.get(d)?.done && (inHead(d) || resultIn(d))));
  }).sort((a, b) => a.order - b.order)[0] ?? null;
  // a merge's checks wait to be retried while the project is quiet: no new task meanwhile (§2.3)
  if (next && busy < parallelOf(budget) && !retrying) {
    if (used.runs >= budget.runs) return goingOn ? { kind: "wait", why: "run" } : { kind: "off", code: "budget_runs", detail: String(budget.runs), key: null };
    if (used.ms >= budget.minutes * 60_000) return goingOn ? { kind: "wait", why: "run" } : { kind: "off", code: "budget_minutes", detail: String(budget.minutes), key: null };
    if (!head) return { kind: "head" };
    return { kind: "start", task: next, base: { branch: head.ref, commit: head.commit, key: "T-0" } };
  }
  if (goingOn || next || person) return { kind: "wait", why: person ?? "run" };
  const idle = idleOf(board, statuses, at);
  if (idle.allDone) return { kind: "off", code: "all_done", detail: null, key: null };
  const detail = idle.waiting.map((w) => (w.waitsFor.length ? `${w.key} (${w.reason}: ${w.waitsFor.join(", ")})` : `${w.key} (${w.reason ?? "-"})`)).join("; ");
  return { kind: "off", code: "others_wait", detail, key: null, waiting: idle.waiting };
}
