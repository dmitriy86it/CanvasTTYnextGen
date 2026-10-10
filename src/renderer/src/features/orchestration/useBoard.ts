// B2: the task board as the renderer sees it (stage-b-board.md §6). main keeps the board and works out the facts of
// the runs of its tasks; the statuses come from the same shared function (boardStatuses) everywhere. The board is read
// again when a run changes (the runs map of useOrchestration) and after every change made here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionBounds } from "../../../../shared/contracts";
import type { OrchestrationResult } from "../../../../shared/orchestration";
import { boardStatuses, overlapsOf, type AutopilotBudget, type Overlap, type BoardTask, type BoardTaskInput, type BoardTaskPatch, type BoardView, type TaskStatus } from "../../../../shared/taskBoard";
import type { Orchestration } from "./useOrchestration";

export function useBoard(orch: Orchestration) {
  const api = window.canvasTTY.orchestration;
  const [view, setView] = useState<BoardView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const asked = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    const n = ++asked.current;
    const r = await api.board().catch((e: unknown) => ({ ok: false as const, code: "ipc_failed", message: String(e) }));
    if (n !== asked.current) return; // an older answer after a newer question
    if (r.ok) { setView(r.value); setFailed(null); } else setFailed(r.code);
  }, [api]);
  // a run that changes (status, phase, permission) changes its task: read again, at most every 300 ms
  const runs = orch.runs;
  useEffect(() => {
    if (!runs) return;
    const id = window.setTimeout(() => void reload(), 300);
    return () => window.clearTimeout(id);
  }, [runs, reload]);

  // B4: while an autopilot of a link is on, its steps (a take, a stop) may change nothing the runs show: read every 2 s
  const anyOn = !!view && (Object.values(view.autopilot ?? {}).some((s) => s.on)
    || !!view.heads?.some((h) => h.merges.some((m) => m.status === "preparing" || m.status === "running")) // C1: a merge has no run on a link
    || !!view.queued?.some((q) => !q.failed)); // C2: a start in the queue begins in main when a place frees
  useEffect(() => {
    if (!anyOn) return;
    const id = window.setInterval(() => void reload(), 2000);
    return () => window.clearInterval(id);
  }, [anyOn, reload]);

  // B4: a run the board's autopilot started in main is on its link there, not here yet — its card, its notifications and
  // the Dock badge follow the link's latest run: read the canvas again, once per run not seen on a link
  const askedRuns = useRef(new Set<string>());
  const { canvas, reload: reloadCanvas } = orch;
  useEffect(() => {
    if (!view) return;
    const known = new Set(canvas.links.flatMap((l) => l.runIds));
    const fresh = view.facts.filter((f) => !known.has(f.runId) && !askedRuns.current.has(f.runId));
    if (!fresh.length) return;
    for (const f of fresh) askedRuns.current.add(f.runId);
    void reloadCanvas();
  }, [view, canvas, reloadCanvas]);

  // C2: a place with the board's merged head waits for its dependencies there (decision 9)
  const statuses = useMemo(() => (view ? boardStatuses(view.board, view.facts, view.heads ?? []) : new Map<string, TaskStatus>()), [view]);
  const overlaps = useMemo(() => (view ? overlapsOf(view.board, view.facts, statuses, view.heads ?? []) : new Map<string, Overlap[]>()), [view, statuses]);
  // C2: a start that went to the queue changes no run: the goal dialog says so
  useEffect(() => {
    const onQueued = () => void reload();
    window.addEventListener("raoden:board-queued", onQueued);
    return () => window.removeEventListener("raoden:board-queued", onQueued);
  }, [reload]);
  // the task of a run (agent cards, the summary): from the facts main read in its goal
  const taskOfRun = useCallback((runId: string): BoardTask | null => {
    const f = view?.facts.find((x) => x.runId === runId);
    return (f?.taskId && view?.board.tasks.find((t) => t.id === f.taskId)) || null;
  }, [view]);

  const act = useCallback(async <T,>(call: () => Promise<OrchestrationResult<T>>): Promise<OrchestrationResult<T>> => {
    const r = await call().catch((e: unknown) => ({ ok: false as const, code: "ipc_failed", message: String(e) }));
    await reload();
    return r;
  }, [reload]);

  return {
    view, failed, statuses, overlaps, taskOfRun, reload,
    create: (input: BoardTaskInput) => act(() => api.boardCreate(input)),
    update: (id: string, patch: BoardTaskPatch) => act(() => api.boardUpdate(id, patch)),
    archive: (id: string, archived: boolean) => act(() => api.boardArchive(id, archived)),
    remove: (id: string, dependents: string[] = []) => act(() => api.boardRemove(id, dependents)),
    accept: (id: string) => act(() => api.boardAccept(id)),
    place: (workspaceId: string, bounds: SessionBounds | null) => act(() => api.boardPlace(workspaceId, bounds)),
    autopilot: (linkId: string, on: boolean, language: "ru" | "en") => act(() => api.boardAutopilot(linkId, on, language)),
    budget: (linkId: string, budget: AutopilotBudget | null) => act(() => api.boardBudget(linkId, budget)),
    // C1: merges into the board's merged head and the person's actions on it
    merge: (taskId: string, language: "ru" | "en") => act(() => api.boardMerge(taskId, language)),
    mergeAll: (workspaceId: string, project: string, language: "ru" | "en") => act(() => api.boardMergeAll(workspaceId, project, language)),
    resolve: (runId: string, confirm: boolean) => act(() => api.boardMergeResolve(runId, confirm)),
    skip: (runId: string) => act(() => api.boardMergeSkip(runId)),
    openMerge: (runId: string) => act(() => api.boardMergeOpen(runId)),
    head: (action: "branch" | "apply" | "new" | "update", workspaceId: string, project: string, language: "ru" | "en" = "en") => act(() => api.boardHead(action, workspaceId, project, language)),
    // C2 (decision 12): a start waiting for a place — over the limit now, or out of the queue
    queue: (action: "run" | "cancel", taskId: string) => act(() => api.boardQueue(action, taskId))
  };
}

export type Board = ReturnType<typeof useBoard>;
