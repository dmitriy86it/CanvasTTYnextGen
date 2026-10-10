// C1: the board's merged head and the merge runs into it (stage-c-parallel.md §4, §5.2). The application merges, without
// a model, in a separate copy of its own: a merge run is a run of the workspace with a journal v3 (minReaderVersion 3),
// so 1.5.8–1.5.16 show it «created by a newer version» and never continue it, and it stands on no link (§5.3).
// - the head (refs/raoden/board/<workspace>/<n>) starts once from the working folder and moves only through a merge
//   run, only after its required checks, only from the head it was built on;
// - a conflict, or checks that fail twice, pause the run for the person in its copy; nothing is lost: the task's branch,
//   the head and the copy stay as they were;
// - the working folder, its index, HEAD and branches are never written (workspace.ts, «the board's merged head»).
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardHead, BoardMerge, BoardMergeStatus } from "../../../shared/taskBoard.ts";
import type { CheckWriter } from "./checkRunner.ts";
import { resolveCheck } from "./checks.ts";
import { MAX_TEXT_BYTES, buildRecord, canonical, isTextRef, newerVersion, parseJournal, sha256Hex } from "./journal.ts";
import type { EventType, JournalRecord, RunState, TextRef } from "./journal.ts";
import { shellRegistry } from "./orchestrationService.ts";
import type { SupervisorLaunch } from "./types.ts";
import { startShellCheck } from "./userCheck.ts";
import { neededSteps, worktreeSteps } from "./prepare.ts";
import type { PrepareStep } from "./prepare.ts";
import { runShell } from "./shellRun.ts";
import {
  BOARD_REF, WorkspaceError, advanceBoardRef, applyBoard, boardBranch, boardRefCommit, boardRefs, changedPaths, cloneDependencies, commitMerge, readDependencyRecord,
  behindBy, createWorkspace, diffPaths, isAncestor, mergeIntoCopy, onHeadLine, openBoardRepo, openWorkspace, projectBranch, projectHead, snapshotCopyTree, startBoardRef
} from "./workspace.ts";
import type { BoardRepo, Workspace } from "./workspace.ts";

export const MERGE_JOURNAL_VERSION = 3;

export interface BoardMergeDeps {
  root: string; // <userData>/orchestration
  gitPath(): string;
  own(runId: string, workspaceId: string): Promise<void>; // canvas.json owners: the merge run's workspace
  checks(project: string): Promise<string[] | null>; // the project's required check commands; null: no saved settings
  // the project's preparation (its profile): its steps run in the merge copy when needed, as in a task's copy
  prepare?(project: string): Promise<{ auto: boolean; steps: PrepareStep[] }>;
  shell(project: string): Promise<{ shell: string; env: Record<string, string> }>; // the login shell of the project
  launch(): SupervisorLaunch;
  quiet(project: string): Promise<boolean>; // no run of the project is in a turn now (the retry of failed checks)
  retryWaitMs?: number; // the longest wait for quiet before the retry (10 min)
  retryPollMs?: number;
  changed?(): void; // something to show changed
}

interface Goal {
  v: 3; kind: "merge"; text: string; createdAt: number; workspaceId: string; project: string;
  merge: { board: string; base: string; task: { id: string; key: string; runId: string; commit: string }; source?: "head" };
}

const Q = (ws: string, project: string) => `${ws}\0${project}`;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MARKERS = /^(<{7}|>{7}) /m;

class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const refuse = (code: string, message: string): never => { throw new Refusal(code, message); };

export function createBoardMerge(deps: BoardMergeDeps) {
  const queues = new Map<string, Promise<unknown>>();
  const working = new Set<string>(); // merge runs this process drives now
  const changedCache = new Map<string, string[]>();
  const runDir = (runId: string) => join(deps.root, "runs", runId);
  const journalFile = (runId: string) => join(runDir(runId), "journal.jsonl");

  // One head, one merge at a time: start, resolution, skip — read, decide, write.
  function inQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    queues.set(key, next.catch(() => {}));
    return next;
  }

  // HOME of the application's Git here: an empty folder of its own (temporary indexes of a head's start live in it)
  let home: Promise<string> | null = null;
  async function withRepo<T>(project: string, fn: (r: BoardRepo) => Promise<T>): Promise<T> {
    home ??= mkdtemp(join(tmpdir(), "raoden-board-"));
    return fn(await openBoardRepo(project, deps.gitPath(), await home));
  }

  // ---------- the journal v3 ----------
  async function records(runId: string): Promise<JournalRecord[] | null> {
    const buf = await readFile(journalFile(runId)).catch(() => null);
    if (!buf || newerVersion(buf) !== MERGE_JOURNAL_VERSION) return null;
    const p = parseJournal(buf, runId); // above this build's own v2: the chain checked, nothing replayed
    return p.integrity.status === "newer_version" && p.integrity.detail.chain.status !== "corrupt" ? p.records : null;
  }
  async function putText(runId: string, content: string | Uint8Array): Promise<TextRef> {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    if (buf.length > MAX_TEXT_BYTES) refuse("text_too_large", "text over the limit");
    const ref = { sha256: sha256Hex(buf), bytes: buf.length };
    const dir = join(runDir(runId), "texts");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.tmp-${randomUUID()}`);
    const fh = await open(tmp, "wx", 0o600);
    try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
    await rename(tmp, join(dir, ref.sha256));
    return ref;
  }
  async function append(runId: string, type: string, data: Record<string, unknown>): Promise<void> {
    const recs = await records(runId);
    if (!recs && type !== "run.created") refuse("journal_unreadable", "the merge run's journal cannot be read");
    const last = recs?.at(-1) ?? null;
    const { line } = buildRecord(last ? { seq: last.seq, hash: last.hash } : null, runId, new Date().toISOString(), type as EventType, data,
      MERGE_JOURNAL_VERSION as 2, last ? null : { minReaderVersion: MERGE_JOURNAL_VERSION });
    const fh = await open(journalFile(runId), last ? "a" : "wx", 0o600);
    try { await fh.write(line); await fh.sync(); } finally { await fh.close(); }
    deps.changed?.();
  }
  const status = (runId: string, s: BoardMergeStatus, reason: string | null = null, extra: Record<string, unknown> = {}) =>
    append(runId, "run.status", { status: s, reason, ...extra });

  // ---------- the state of a merge run, from its journal alone ----------
  const goals = new Map<string, Goal>();
  async function goalOf(runId: string, recs: JournalRecord[]): Promise<Goal | null> {
    const known = goals.get(runId);
    if (known) return known;
    const ref = recs[0]?.type === "run.created" ? (recs[0].data as { goal?: unknown }).goal : null;
    if (!isTextRef(ref)) return null;
    const g = await readFile(join(runDir(runId), "texts", ref.sha256), "utf8").then((t) => JSON.parse(t) as Goal, () => null);
    if (g?.kind !== "merge" || !BOARD_REF.test(g.merge?.board ?? "") || !OID.test(g.merge?.task?.commit ?? "")) return null;
    goals.set(runId, g);
    return g;
  }
  async function stateOf(runId: string): Promise<(BoardMerge & { goal: Goal; committed: string | null; auto: string | null }) | null> {
    const recs = await records(runId);
    if (!recs) return null;
    const goal = await goalOf(runId, recs);
    if (!goal) return null;
    const s: BoardMerge & { goal: Goal; committed: string | null; auto: string | null } = {
      runId, board: goal.merge.board, base: goal.merge.base, task: goal.merge.task, ...(goal.merge.source === "head" ? { source: "head" as const } : {}),
      status: "preparing", reason: null, detail: null,
      completion: null, conflicts: [], outside: [], interference: false, retrying: false, dir: null, createdAt: goal.createdAt, goal, committed: null, auto: null
    };
    for (const r of recs) {
      const d = r.data as Record<string, unknown>;
      const type: string = r.type;
      if (type === "run.status") {
        s.status = d.status as BoardMergeStatus;
        s.reason = typeof d.reason === "string" ? d.reason : null;
        s.detail = typeof d.detail === "string" ? d.detail : null;
        s.interference = d.interference === true;
        if (d.completion === "confirmed" || d.completion === "no_checks") s.completion = d.completion;
      } else if (type === "merge.prepared") {
        s.conflicts = Array.isArray(d.conflicts) ? d.conflicts.filter((x): x is string => typeof x === "string") : [];
        s.auto = typeof d.auto === "string" ? d.auto : null;
        s.dir = typeof d.dir === "string" ? d.dir : null;
      } else if (type === "merge.resolved") s.outside = Array.isArray(d.outside) ? d.outside.filter((x): x is string => typeof x === "string") : [];
      else if (type === "merge.committed") s.committed = typeof d.commit === "string" ? d.commit : null;
      // the first checks failed, the retry waits for the project to be quiet: no new task starts meanwhile (§2.3)
      if (type === "merge.checked") s.retrying = d.attempt === 1 && d.passed === false;
      else if (type === "run.status" || type === "merge.resolved") s.retrying = false;
    }
    if (s.status !== "running") s.retrying = false;
    return s;
  }
  async function all(): Promise<NonNullable<Awaited<ReturnType<typeof stateOf>>>[]> {
    const names = await readdir(join(deps.root, "runs")).catch(() => [] as string[]);
    const out = [];
    for (const id of names) {
      const head = await readFile(journalFile(id)).then((b) => b.subarray(0, 4096), () => null).catch(() => null);
      if (!head || newerVersion(head) !== MERGE_JOURNAL_VERSION) continue;
      const s = await stateOf(id);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || b.runId.localeCompare(a.runId));
  }

  // ---------- recovery (§4.6): once, before anything else of this process ----------
  // A run left preparing or running by an ended process: moved head after merge.committed → completed; a merge prepared
  // → paused (recovered), the person checks again or skips; nothing prepared → stopped (interrupted).
  let recovering: Promise<void> | null = null;
  const recovered = () => (recovering ??= (async () => {
    for (const s of await all()) {
      if (s.status !== "preparing" && s.status !== "running") continue;
      if (working.has(s.runId)) continue;
      await inQueue(Q(s.goal.workspaceId, s.goal.project), async () => {
        const now = await withRepo(s.goal.project, (r) => boardRefCommit(r, s.board)).catch(() => null);
        if (s.committed && now === s.committed) {
          await append(s.runId, "merge.advanced", { from: s.base, to: s.committed });
          await status(s.runId, "completed", null, { completion: (await lastChecked(s.runId)) ? "confirmed" : "no_checks" });
        } else if (s.auto) await status(s.runId, "paused", "recovered");
        else await status(s.runId, "stopped", "interrupted");
      }).catch(() => {});
    }
  })());
  const lastChecked = async (runId: string) => {
    const recs = await records(runId) ?? [];
    return (recs.filter((r) => (r.type as string) === "merge.checked").at(-1)?.data as { passed?: unknown } | undefined)?.passed === true;
  };

  // ---------- the checks of the merged tree (§4.2 step 4) ----------
  // The project's required commands, one by one through the project's check queue (userCheck.ts), on the copy's tree,
  // which must be the tree that will be committed. null: the project has no commands.
  async function runChecks(runId: string, ws: Workspace, project: string, tree: string, attempt: number): Promise<boolean | null> {
    const commands = await deps.checks(project);
    if (commands === null) throw new Refusal("merge_no_settings", "the project's settings are not saved");
    if (!commands.length) return null;
    const { shell, env } = await deps.shell(project);
    const registry = shellRegistry(shell, commands);
    const writer: CheckWriter = {
      putText: (c) => putText(runId, c),
      recordCheckStarted: (d) => append(runId, "check.started", d as unknown as Record<string, unknown>),
      recordCheckFinished: (d) => append(runId, "check.finished", d as unknown as Record<string, unknown>)
    };
    const state = { workspace: { current: { commit: ws.baseline.commit, tree: ws.baseline.tree } } } as unknown as RunState;
    const results: { command: string; status: string; exitCode: number | null; reason: string | null }[] = [];
    for (const [i, line] of commands.entries()) {
      const r = await startShellCheck({ ws, command: resolveCheck(registry, `cmd-${i + 1}`), env, writer, launch: deps.launch(), state }).result;
      // a verdict about another tree is none
      const status = r.copy.treeBefore !== tree ? "not_verified" : r.status;
      results.push({ command: line, status, exitCode: r.process.exitCode, reason: r.copy.treeBefore !== tree ? "tree_changed" : r.reason });
    }
    const passed = results.every((r) => r.status === "passed");
    await append(runId, "merge.checked", { attempt, passed, results });
    return passed;
  }

  // The project's preparation in the merge copy, by the same rule as a task's copy (prepare.ts): the steps whose result
  // is missing or stale, the folders cloned from the project counting as installed. null: done; else what failed.
  async function prepare(runId: string, ws: Workspace, project: string): Promise<string | null> {
    const p = await deps.prepare?.(project);
    if (!p?.auto || !p.steps.length) return null;
    const cloned = Object.fromEntries((await readDependencyRecord(ws)).filter((d) => d.result === "cloned" && d.lock && d.sha256).map((d) => [d.lock!, d.sha256!]));
    const needed = await neededSteps(ws.repo, await worktreeSteps(project, p.steps), cloned);
    if (!needed.length) return null;
    const { shell, env } = await deps.shell(project);
    for (const { step } of needed) {
      const r = await runShell({ shell, line: step.command, cwd: ws.repo, env, launch: deps.launch(), timeoutMs: 30 * 60_000, maxOutputBytes: 65_536 }).result;
      const ok = r.exitCode === 0 && r.signal === null && !r.spawnError;
      await append(runId, "prepare.finished", { command: step.command, exitCode: r.exitCode, ok, output: r.output.bytes ? await putText(runId, r.output.text) : null });
      if (!ok) return `${step.command}: ${r.spawnError ?? `exit ${r.exitCode ?? r.signal}`}`;
    }
    return null;
  }

  // the checks (one retry when no run of the project is in a turn, at most after retryWaitMs), the commit, the head
  async function finish(runId: string, ws: Workspace, g: Goal, tree: string): Promise<void> {
    // the settings removed while the merge waited for the person: it waits again, never moves the head unchecked
    if (await deps.checks(g.project) === null) return status(runId, "paused", "merge_no_settings");
    // the dependencies of the merged code (its lock files are the merged ones): cloned from the project, else prepared
    await cloneDependencies(ws).catch(() => []);
    const failed = await prepare(runId, ws, g.project);
    if (failed) return status(runId, "paused", "merge_prepare_failed", { detail: failed });
    // the preparation must leave the tree to commit as it is (a lock file it rewrote would make every check «another tree»)
    const after = await snapshotCopyTree(ws, ws.baseline.tree);
    if (after !== tree) return status(runId, "paused", "merge_prepare_changed", { detail: (await diffPaths(ws, tree, after)).slice(0, 20).join(", ") });
    let passed = await runChecks(runId, ws, g.project, tree, 1);
    if (passed === false) {
      const until = Date.now() + (deps.retryWaitMs ?? 10 * 60_000);
      while (Date.now() < until && !(await deps.quiet(g.project).catch(() => true))) await new Promise((r) => setTimeout(r, deps.retryPollMs ?? 5000));
      passed = await runChecks(runId, ws, g.project, tree, 2);
      if (passed === false) return status(runId, "paused", "merge_checks_failed", { interference: true });
    }
    const commit = await commitMerge(ws, tree, [g.merge.base, g.merge.task.commit], g.merge.source === "head"
      ? `Raoden Loom: update the board's result from HEAD\n\nRaoden-Merge: ${runId}\nRaoden-Head: ${g.merge.task.commit}\n`
      : `Raoden Loom: merge ${g.merge.task.key} into the board's result\n\nRaoden-Merge: ${runId}\nRaoden-Task: ${g.merge.task.key} ${g.merge.task.runId}\n`);
    await append(runId, "merge.committed", { commit, tree });
    try {
      await advanceBoardRef(ws, g.merge.board, commit, g.merge.base);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "ref_conflict") return status(runId, "failed", "head_moved", { detail: g.merge.board });
      throw error;
    }
    await append(runId, "merge.advanced", { from: g.merge.base, to: commit });
    await status(runId, "completed", null, { completion: passed === null ? "no_checks" : "confirmed" });
  }

  async function drive(runId: string, g: Goal): Promise<void> {
    working.add(runId);
    try {
      await status(runId, "running");
      const ws = await createWorkspace({ root: deps.root, runId, source: g.project, gitPath: deps.gitPath(), mode: "copy", from: g.merge.base });
      const { conflicts } = await mergeIntoCopy(ws, g.merge.task.commit);
      const auto = await snapshotCopyTree(ws, ws.baseline.tree);
      await append(runId, "merge.prepared", { conflicts, auto, dir: ws.repo });
      if (conflicts.length) return status(runId, "paused", "merge_conflict");
      await finish(runId, ws, g, auto);
    } catch (error) {
      await status(runId, "failed", "error", { detail: String((error as Error)?.message ?? error).slice(0, 500) }).catch(() => {});
    } finally { working.delete(runId); }
  }

  const head = (workspaceId: string, project: string) => withRepo(project, async (r) => (await boardRefs(r, workspaceId)).at(-1) ?? null);

  // A merge into the current head — of a task's result, or (source "head") of the project's HEAD as it is now: its run is
  // created now, the merge goes on in the background. Refused while another merge into this head goes on or waits for
  // the person (one at a time, §4.2); a result in the head already starts nothing (§4.6).
  const begin = (input: { workspaceId: string; project: string; task: { id: string; key: string }; taskRunId: string; commit: string; language: "ru" | "en" },
    source: "head" | null) =>
    new Promise<{ runId: string } | { already: true }>((resolve, reject) => {
      if (!source && !OID.test(input.commit)) return reject(new Refusal("invalid_argument", "commit"));
      // recovery first, outside this queue: it queues its own work there
      void recovered().then(() => inQueue(Q(input.workspaceId, input.project), async () => {
        const h = await head(input.workspaceId, input.project) ?? refuse("no_head", "the board has no merged head");
        // a head's ref is named per repository (refs/raoden/board/<workspace>/<n>): two projects of a workspace may share it
        const open = (await all()).find((m) => m.board === h.ref && m.goal.project === input.project && !["completed", "stopped", "failed"].includes(m.status));
        if (open) refuse("merge_busy", `${open.task.key} is being merged or waits for you`);
        // the checks of the merged code are the project's saved ones, never guessed (§4.2)
        if (await deps.checks(input.project) === null) refuse("merge_no_settings", "the project's settings are not saved");
        const commit = source ? await withRepo(input.project, projectHead) ?? refuse("no_project_head", "the project has no commit") : input.commit;
        const already = await withRepo(input.project, (r) => isAncestor(r, commit, h.commit));
        if (already && source) refuse("head_current", "the board's result has the project's HEAD already");
        if (source && !(await withRepo(input.project, (r) => onHeadLine(r, h.commit, commit)))) refuse("head_other_line", "HEAD is on another line than the board's result started from");
        const runId = randomUUID();
        const g: Goal = {
          v: 3, kind: "merge", createdAt: Date.now(), workspaceId: input.workspaceId, project: input.project,
          text: source ? (input.language === "ru" ? "Обновление итога доски от HEAD" : "Update of the board's result from HEAD")
            : input.language === "ru" ? `Объединение ${input.task.key} в итог доски` : `Merge ${input.task.key} into the board's result`,
          merge: { board: h.ref, base: h.commit, task: { ...input.task, runId: input.taskRunId, commit }, ...(source ? { source } : {}) }
        };
        await deps.own(runId, input.workspaceId);
        await mkdir(runDir(runId), { recursive: true, mode: 0o700 });
        const ref = await putText(runId, canonical(g));
        await append(runId, "run.created", { goal: ref });
        try {
          // already in the head (§4.6): a run that says so, so the task is marked and nothing asks to merge it again
          if (already) await status(runId, "completed", "already");
          else await status(runId, "preparing");
        } catch (error) {
          await status(runId, "failed", "error", { detail: String((error as Error)?.message ?? error).slice(0, 500) }).catch(() => {});
          throw error;
        }
        if (already) return resolve({ already: true });
        resolve({ runId });
        // in the background: the queue is free once the run is «preparing», which keeps the next merge out (one at a time)
        void drive(runId, g);
      })).catch(reject);
    });

  return {
    recovered,
    // Is this run a merge run (its journal is v3 and its goal a merge)? The list of runs leaves them out: the board shows
    // them. A v3 journal of anything else is a newer version's run, listed read only as before.
    async isMerge(runId: string): Promise<boolean> {
      const buf = await readFile(journalFile(runId)).then((b) => b.subarray(0, 4096), () => null);
      return !!buf && newerVersion(buf) === MERGE_JOURNAL_VERSION && (await stateOf(runId)) !== null;
    },
    head,
    // Is a merge into a head of this project going on (§3.1: a run in the project folder waits for it)?
    active: async (project: string) => {
      const real = await realpath(project).catch(() => project);
      return (await all()).some((m) => m.goal.project === real && (m.status === "preparing" || m.status === "running"));
    },
    // the head of a place, started from the working folder if it has none (§4.1)
    ensureHead: (workspaceId: string, project: string) => inQueue(Q(workspaceId, project), () => withRepo(project, async (r) =>
      (await boardRefs(r, workspaceId)).at(-1) ?? { n: 1, ...(await startBoardRef(r, workspaceId, 1)) })),
    // «Начать новую общую вершину»: the next n, from the working folder; the old one stays for history
    newHead: (workspaceId: string, project: string) => inQueue(Q(workspaceId, project), () => withRepo(project, async (r) => {
      const n = ((await boardRefs(r, workspaceId)).at(-1)?.n ?? 0) + 1;
      return { n, ...(await startBoardRef(r, workspaceId, n)) };
    })),

    // The heads of these places with the merges into each (the newest first)
    async heads(places: readonly { workspaceId: string; project: string }[]): Promise<BoardHead[]> {
      await recovered();
      const merges = await all();
      const out: BoardHead[] = [];
      for (const p of places) {
        const h = await head(p.workspaceId, p.project).catch(() => null);
        if (!h) continue;
        // C2 (decision 13): the person's commits after the head started, read from HEAD only
        // another line checked out (a branch that does not go on from the head's start) is not «behind»: never offered
        const { behind, branch, otherLine } = await withRepo(p.project, async (r) => {
          const now = await projectHead(r);
          const on = !!now && await onHeadLine(r, h.commit, now);
          return { behind: on ? await behindBy(r, h.commit, now!) : null, branch: await projectBranch(r), otherLine: !!now && !on };
        }).catch(() => ({ behind: null, branch: null, otherLine: false }));
        out.push({ workspaceId: p.workspaceId, project: p.project, ref: h.ref, n: h.n, commit: h.commit, behind, branch, ...(otherLine ? { otherLine } : {}),
          merges: merges.filter((m) => m.board === h.ref && m.goal.project === p.project).map(({ goal: _g, committed: _c, auto: _a, ...m }) => m) });
      }
      return out;
    },

    // A merge of a task's result into the current head: its run is created now, the merge goes on in the background.
    // Refused while another merge into this head goes on or waits for the person (one at a time, §4.2); a result in the
    // head already starts nothing (§4.6).
    merge: (input: { workspaceId: string; project: string; task: { id: string; key: string }; taskRunId: string; commit: string; language: "ru" | "en" }) =>
      begin(input, null),
    // C2 (owner's decision 13): «Обновить итог от текущего HEAD» — the project's HEAD merged into the head by the same
    // merge run: in a copy, checked, moved only from the expected value; a conflict waits for the person. Only read: HEAD.
    fromHead: (input: { workspaceId: string; project: string; language: "ru" | "en" }) =>
      begin({ ...input, task: { id: "HEAD", key: "HEAD" }, taskRunId: "", commit: "" }, "head"),

    // «Готово, проверить» (§4.3): the copy as the person left it, the mechanical condition, then checks, commit, head.
    // outside: files out of the conflict the resolution changed — needs «Да, я менял и их» (confirm).
    resolve: async (runId: string, confirm: boolean): Promise<{ result: "checking" } | { result: "unresolved"; files: string[] } | { result: "confirm"; files: string[] }> => {
      const s = await stateOf(runId) ?? refuse("run_not_found", "no such merge run");
      if (s.status !== "paused" || !s.auto) refuse("merge_not_paused", "the merge does not wait for the person");
      return inQueue(Q(s.goal.workspaceId, s.goal.project), async () => {
        const now = await stateOf(runId);
        if (now?.status !== "paused") refuse("merge_not_paused", "the merge does not wait for the person");
        const ws = await openWorkspace({ root: deps.root, runId, gitPath: deps.gitPath() });
        const unresolved: string[] = [];
        for (const f of s.conflicts) {
          const text = await readFile(join(ws.repo, f), "utf8").catch(() => "");
          if (MARKERS.test(text)) unresolved.push(f);
        }
        if (unresolved.length) return { result: "unresolved" as const, files: unresolved };
        const tree = await snapshotCopyTree(ws, ws.baseline.tree);
        const changed = await diffPaths(ws, s.auto!, tree);
        // a conflict without markers (binary, modify/delete, rename, another marker size) left as the merge left it:
        // the person confirms it, as files out of the conflict — never committed unnoticed
        const untouched = s.conflicts.filter((p) => !changed.includes(p));
        const outside = [...changed.filter((p) => !s.conflicts.includes(p)), ...untouched];
        if (outside.length && !confirm) return { result: "confirm" as const, files: outside };
        await append(runId, "merge.resolved", { by: "person", tree, outside });
        await status(runId, "running");
        working.add(runId);
        void (async () => {
          try { await finish(runId, ws, s.goal, tree); } catch (error) {
            await status(runId, "failed", "error", { detail: String((error as Error)?.message ?? error).slice(0, 500) }).catch(() => {});
          } finally { working.delete(runId); }
        })();
        return { result: "checking" as const };
      });
    },

    // «Пропустить»: the task stays «Done», not in the head; its copy stays for a look
    skip: async (runId: string): Promise<void> => {
      const s = await stateOf(runId) ?? refuse("run_not_found", "no such merge run");
      await inQueue(Q(s.goal.workspaceId, s.goal.project), async () => {
        // a merge that waits for the person, or one that failed or was interrupted (a failure that repeats has no other way out)
        const now = await stateOf(runId);
        if (!(now?.status === "paused" || now?.status === "failed" || (now?.status === "stopped" && now.reason !== "skipped"))) refuse("merge_not_paused", "the merge does not wait for the person");
        await status(runId, "stopped", "skipped");
      });
    },

    // «Создать ветку из итога доски»: a new name at the head, create-only; «Применить» onto the working folder
    branch: (workspaceId: string, project: string) => withRepo(project, async (r) => {
      const h = (await boardRefs(r, workspaceId)).at(-1) ?? refuse("no_head", "the board has no merged head");
      const name = `raoden/board-${h.n}-${h.commit.slice(0, 8)}`;
      await boardBranch(r, name, h.commit);
      return { name, commit: h.commit };
    }),
    apply: (workspaceId: string, project: string) => withRepo(project, async (r) => {
      const h = (await boardRefs(r, workspaceId)).at(-1) ?? refuse("no_head", "the board has no merged head");
      // C2: after an update from HEAD, the changes on top of the HEAD it took in (the newest such merge)
      const updated = (await all()).find((m) => m.board === h.ref && m.goal.project === project && m.goal.merge.source === "head" && m.status === "completed" && m.reason !== "already");
      return applyBoard(r, h.commit, updated?.task.commit);
    }),
    // the merges into a head as their journals say, newest first (no recovery awaited: safe inside other queues);
    // project: the head's — another project of the workspace may have a head of the same name
    mergesInto: async (ref: string, project?: string): Promise<BoardMerge[]> => (await all()).filter((m) => m.board === ref && (project === undefined || m.goal.project === project)),
    copyOf: async (runId: string): Promise<string | null> => (await stateOf(runId))?.dir ?? null,
    // C2 (§4.7): the paths changed between two commits of a project (a run's base and its last checkpoint); kept, as
    // commits never change. ponytail: the cache grows with the checkpoints seen in this process (a few per run)
    changed: async (project: string, from: string, to: string): Promise<string[]> => {
      const key = `${project}\0${from}\0${to}`;
      const known = changedCache.get(key);
      if (known) return known;
      const paths = (await withRepo(project, (r) => changedPaths(r, from, to))).slice(0, 2000);
      changedCache.set(key, paths);
      return paths;
    },
    exists: (runId: string) => stat(journalFile(runId)).then(() => true, () => false)
  };
}

export type BoardMergeApi = ReturnType<typeof createBoardMerge>;
