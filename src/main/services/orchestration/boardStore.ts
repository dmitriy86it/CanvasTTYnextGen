// The task board's file: <userData>/orchestration/board.json (stage-b-board.md §3). It holds only what the person
// set — tasks, their order and dependencies, an accepted result — never a status. Written atomically (tmp + rename)
// through one queue; a damaged file is set aside and the board starts empty (runs keep their link to tasks in their
// goals); a file of a newer version is never written: the board is read only. Builds up to 1.5.13 neither read nor
// write this file, so a rollback keeps it as it is (canvas.json would not: 1.5.12 writes back only the keys it knows).
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { BOARD_VERSION, type Board, type BoardTask, type BoardTaskInput, type BoardTaskPatch } from "../../../shared/taskBoard.ts";

class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const refuse = (code: string, message: string): never => { throw new Refusal(code, message); };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^T-(\d{1,6})$/;
const MAX_TASKS = 2000;
const empty = (): Board => ({ v: BOARD_VERSION, tasks: [], counters: {} });
const text = (v: unknown, max: number) => typeof v === "string" && v.trim() !== "" && v.length <= max && !v.includes("\0");
const time = (v: unknown) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));

function isTask(t: unknown): t is BoardTask {
  const o = t as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  const acc = o.accepted as Record<string, unknown> | null;
  return typeof o.id === "string" && UUID.test(o.id) && typeof o.key === "string" && KEY.test(o.key)
    && typeof o.workspaceId === "string" && WORKSPACE_ID.test(o.workspaceId) && typeof o.project === "string" && isAbsolute(o.project)
    && text(o.title, 200) && text(o.text, 8000) && Array.isArray(o.criteria) && o.criteria.length >= 1 && o.criteria.length <= 32
    && o.criteria.every((c) => text(c, 500)) && Array.isArray(o.dependsOn) && o.dependsOn.every((d) => typeof d === "string" && UUID.test(d))
    && typeof o.order === "number" && Number.isFinite(o.order) && time(o.createdAt) && time(o.updatedAt)
    && (o.archivedAt === null || time(o.archivedAt))
    && (acc === null || (typeof acc === "object" && typeof acc.runId === "string" && UUID.test(acc.runId) && time(acc.at)));
}

export type TaskInput = BoardTaskInput;

export interface BoardRead { board: Board; readOnly: null | "newer_version" | "damaged_unmoved"; }

// usedKeys(workspaceId): the largest n of the T-<n> the runs of that workspace name in their goals. A new number is
// above it as well as above the file's counter, so a number is not given twice even after the file was lost.
export function createBoardStore(file: string, usedKeys: (workspaceId: string) => Promise<number> = async () => 0) {
  let cache: BoardRead | null = null;
  let first: Promise<BoardRead> | null = null; // the first read, shared: two loads at once would race the cache
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<BoardRead> {
    if (cache) return cache;
    first ??= readBoard();
    const r = await first;
    cache ??= r; // a save after the first read has set it already
    return cache;
  }

  async function readBoard(): Promise<BoardRead> {
    // a write cut short leaves its tmp file next to the board: the board itself is the old or the new one, whole
    const dir = dirname(file);
    for (const n of await readdir(dir).catch(() => [] as string[])) {
      if (n.startsWith(`${basename(file)}.`) && n.endsWith(".tmp")) await rm(join(dir, n), { force: true }).catch(() => {});
    }
    const raw = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
    if (raw === null) return { board: empty(), readOnly: null };
    let v: { v?: unknown; tasks?: unknown; counters?: unknown } | null = null;
    try { v = JSON.parse(raw); } catch { v = null; }
    if (v && typeof v.v === "number" && v.v > BOARD_VERSION) {
      // a newer version's board: shown as far as its tasks read, never written
      const tasks = Array.isArray(v.tasks) ? v.tasks.filter(isTask) : [];
      return { board: { v: BOARD_VERSION, tasks, counters: {} }, readOnly: "newer_version" };
    }
    const counters = v?.counters && typeof v.counters === "object" && !Array.isArray(v.counters)
      ? Object.fromEntries(Object.entries(v.counters as Record<string, unknown>).filter(([k, n]) => WORKSPACE_ID.test(k) && Number.isSafeInteger(n) && (n as number) >= 0)) as Record<string, number>
      : null;
    // a task written by hand without accepted or archivedAt has neither (never half a board: one bad task sets it aside)
    const tasks = Array.isArray(v?.tasks) ? v.tasks.map((t) => (t && typeof t === "object" ? { accepted: null, archivedAt: null, ...t } : t)) : null;
    if (v?.v === BOARD_VERSION && tasks?.every(isTask) && counters) {
      return { board: { v: BOARD_VERSION, tasks: tasks as BoardTask[], counters }, readOnly: null };
    }
    // damaged: set aside whole (nothing is dropped from it), the board starts empty
    const aside = `${file}.damaged-${randomUUID()}`;
    const moved = await rename(file, aside).then(() => true, () => false);
    return { board: empty(), readOnly: moved ? null : "damaged_unmoved" };
  }

  // The cache follows the file: a failed write leaves both as they were and the caller gets store_failed.
  async function save(next: Board): Promise<void> {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      refuse("store_failed", `the board could not be saved: ${(error as NodeJS.ErrnoException)?.code ?? "error"}`);
    }
    cache = { board: next, readOnly: null };
  }

  function change<T>(fn: (b: Board) => Promise<{ next: Board | null; value: T }>): Promise<T> {
    const run = queue.then(async () => {
      const r = await load();
      if (r.readOnly === "newer_version") refuse("board_newer_version", "the board was written by a newer version of Raoden Loom: read only");
      if (r.readOnly) refuse("board_unavailable", "the damaged board could not be set aside: read only");
      const { next, value } = await fn(r.board);
      if (next) await save(next);
      return value;
    });
    queue = run.catch(() => {});
    return run;
  }

  const checkInput = (b: Board, input: TaskInput, self: string | null): Required<TaskInput> => {
    if (typeof input?.workspaceId !== "string" || !WORKSPACE_ID.test(input.workspaceId)) refuse("invalid_task", "workspaceId");
    if (typeof input.project !== "string" || !isAbsolute(input.project)) refuse("invalid_task", "project must be an absolute path");
    if (!text(input.title, 200)) refuse("invalid_task", "title: 1..200 characters");
    if (!text(input.text, 8000)) refuse("invalid_task", "text: 1..8000 characters");
    if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 32 || !input.criteria.every((c) => text(c, 500))) {
      refuse("invalid_task", "criteria: 1..32 lines of 1..500 characters");
    }
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    for (const d of dependsOn) {
      const dep = b.tasks.find((t) => t.id === d);
      if (!dep || dep.workspaceId !== input.workspaceId || d === self) refuse("invalid_task", `dependsOn: ${d} is not a task of this workspace`);
    }
    if (self && reaches(b, dependsOn, self)) refuse("task_cycle", "the dependencies would make a cycle");
    return { ...input, criteria: [...input.criteria], dependsOn };
  };

  return {
    read: async (): Promise<BoardRead> => { await queue; return load(); },

    create: (input: TaskInput) => change(async (b) => {
      if (b.tasks.length >= MAX_TASKS) refuse("too_many_tasks", `at most ${MAX_TASKS} tasks`);
      const ok = checkInput(b, input, null);
      const inFile = Math.max(b.counters[ok.workspaceId] ?? 0, ...b.tasks.filter((t) => t.workspaceId === ok.workspaceId).map((t) => Number(KEY.exec(t.key)![1])));
      const n = Math.max(inFile, await usedKeys(ok.workspaceId)) + 1;
      if (n > 999_999) refuse("too_many_tasks", "task numbers end at T-999999 in this workspace");
      const at = new Date().toISOString();
      const order = Math.max(0, ...b.tasks.filter((t) => t.workspaceId === ok.workspaceId).map((t) => t.order)) + 1;
      const task: BoardTask = { id: randomUUID(), key: `T-${n}`, ...ok, order, createdAt: at, updatedAt: at, archivedAt: null, accepted: null };
      return { next: { ...b, tasks: [...b.tasks, task], counters: { ...b.counters, [ok.workspaceId]: n } }, value: task };
    }),

    // A task's text and requirements may change after runs (decision 4): the runs keep their own goal.
    update: (id: string, patch: BoardTaskPatch) => change(async (b) => {
      const t = b.tasks.find((x) => x.id === id) ?? refuse("task_not_found", `no task ${id}`);
      const ok = checkInput(b, { ...t, ...patch }, id);
      if (patch.order !== undefined && !Number.isFinite(patch.order)) refuse("invalid_task", "order");
      const next: BoardTask = { ...t, ...ok, ...(patch.order !== undefined ? { order: patch.order } : {}), updatedAt: new Date().toISOString() };
      return { next: { ...b, tasks: b.tasks.map((x) => (x.id === id ? next : x)) }, value: next };
    }),

    archive: (id: string, archived: boolean) => change(async (b) => {
      const t = b.tasks.find((x) => x.id === id) ?? refuse("task_not_found", `no task ${id}`);
      const next = { ...t, archivedAt: archived ? new Date().toISOString() : null, updatedAt: new Date().toISOString() };
      return { next: { ...b, tasks: b.tasks.map((x) => (x.id === id ? next : x)) }, value: next };
    }),

    // Only a task without runs is deleted (one with runs is archived); its dependents lose it openly — the caller showed them.
    // hasRuns is asked inside the queue: a run created after the question finds the task gone (manager taskOk)
    remove: (id: string, hasRuns: () => Promise<boolean>) => change(async (b) => {
      if (!b.tasks.some((x) => x.id === id)) refuse("task_not_found", `no task ${id}`);
      if (await hasRuns()) refuse("task_has_runs", "a task with runs is archived, not deleted");
      const tasks = b.tasks.filter((x) => x.id !== id).map((x) => (x.dependsOn.includes(id) ? { ...x, dependsOn: x.dependsOn.filter((d) => d !== id) } : x));
      return { next: { ...b, tasks }, value: null };
    }),

    // «Accept the result»: the caller has checked that runId is the task's latest run, completed without checks.
    accept: (id: string, runId: string) => change(async (b) => {
      const t = b.tasks.find((x) => x.id === id) ?? refuse("task_not_found", `no task ${id}`);
      if (!UUID.test(runId)) refuse("invalid_task", "runId");
      if (t.accepted?.runId === runId) return { next: null, value: t };
      const next = { ...t, accepted: { runId, at: new Date().toISOString() }, updatedAt: new Date().toISOString() };
      return { next: { ...b, tasks: b.tasks.map((x) => (x.id === id ? next : x)) }, value: next };
    })
  };
}

// Would `self` be reached from `from` along the dependencies?
function reaches(b: Board, from: readonly string[], self: string): boolean {
  const seen = new Set<string>();
  const stack = [...from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === self) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(b.tasks.find((t) => t.id === id)?.dependsOn ?? []));
  }
  return false;
}
