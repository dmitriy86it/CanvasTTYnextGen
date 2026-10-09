// The task board (stage B, docs/agent-orchestration/implementation/stage-b-board.md). What the person set is kept in
// orchestration/board.json; a task's status is never kept: it is worked out here from the task's runs, by the same
// rules for the board, the agent cards, the activity widget and the summary (the cycle's principle 8).
import type { OrchestrationRunStatus, OrchestrationRunView, OrchestrationTurnPurpose, OrchestrationWorkMode } from "./orchestration.ts";

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
}

export interface Board {
  v: typeof BOARD_VERSION;
  tasks: BoardTask[];
  counters: Record<string, number>; // workspaceId → the last n given
  // B2: where the board card is on each workspace's canvas (absent: not shown there). Here and not in canvas.json:
  // 1.5.12/1.5.13 write canvas.json back with the keys they know only (stage-b-board.md §6).
  places?: Record<string, BoardPlace>;
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
  const wasDone = (t: BoardTask) => (runsOf.get(t.id) ?? []).some((r) => r.createdAt < since && r.status === "completed"
    && (r.completion === "confirmed" || (r.completion === "no_checks" && t.accepted?.runId === r.runId)));
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
