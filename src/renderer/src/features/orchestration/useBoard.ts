// B2: the task board as the renderer sees it (stage-b-board.md §6). main keeps the board and works out the facts of
// the runs of its tasks; the statuses come from the same shared function (boardStatuses) everywhere. The board is read
// again when a run changes (the runs map of useOrchestration) and after every change made here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionBounds } from "../../../../shared/contracts";
import type { OrchestrationResult } from "../../../../shared/orchestration";
import { boardStatuses, type BoardTask, type BoardTaskInput, type BoardTaskPatch, type BoardView, type TaskStatus } from "../../../../shared/taskBoard";
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

  const statuses = useMemo(() => (view ? boardStatuses(view.board, view.facts) : new Map<string, TaskStatus>()), [view]);
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
    view, failed, statuses, taskOfRun, reload,
    create: (input: BoardTaskInput) => act(() => api.boardCreate(input)),
    update: (id: string, patch: BoardTaskPatch) => act(() => api.boardUpdate(id, patch)),
    archive: (id: string, archived: boolean) => act(() => api.boardArchive(id, archived)),
    remove: (id: string) => act(() => api.boardRemove(id)),
    accept: (id: string) => act(() => api.boardAccept(id)),
    place: (workspaceId: string, bounds: SessionBounds | null) => act(() => api.boardPlace(workspaceId, bounds))
  };
}

export type Board = ReturnType<typeof useBoard>;
