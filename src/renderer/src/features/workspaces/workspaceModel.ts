// Project workspaces in the renderer (docs/agent-orchestration/implementation/workspaces-spec.md §5–§6). Pure rules:
// which workspace an item is shown in, the switcher's counts from the application's own state, the linked groups a
// move or "arrange by workspace" offers, and the camera saver that always names the workspace it saves for.
import { COMMON_WORKSPACE_ID, type CameraState, type WorkspacesState } from "../../../../shared/contracts.ts";
import type { OrchestrationCanvas, OrchestrationFolderHolder } from "../../../../shared/orchestration.ts";
import { workspaceOf } from "../../../../shared/workspaceOwnership.ts";
import type { ActivityState } from "../orchestration/runStatus.ts";

export { runOwners, workspaceOf } from "../../../../shared/workspaceOwnership.ts";

export const knownWorkspaces = (state: WorkspacesState) => (id: string): boolean => state.workspaces.some((w) => w.id === id);

export interface WorkspaceCounts {
  runs: number; // orchestration runs at work
  cli: number; // agent CLIs at work in terminals
  attention: number; // runs waiting for the person, terminals asking for approval
  shells: number; // open shells: shown in the hint, never counted as work
}
export const NO_COUNTS: WorkspaceCounts = { runs: 0, cli: 0, attention: 0, shells: 0 };
const AT_WORK: readonly ActivityState[] = ["starting", "working", "checking", "waiting_agent", "stopping"];

export function workspaceCounts(input: {
  sessions: readonly { provider: string; status: string; exitCode: number | null; workspaceId?: string }[];
  runs: readonly { runId: string; state: ActivityState | null }[]; // the latest run of each link, as the widget shows it
  owner: (runId: string) => string;
  known: (id: string) => boolean;
}): Record<string, WorkspaceCounts> {
  const out: Record<string, WorkspaceCounts> = {};
  const add = (id: string, k: keyof WorkspaceCounts) => { out[id] = { ...(out[id] ?? NO_COUNTS), [k]: (out[id]?.[k] ?? 0) + 1 }; };
  for (const s of input.sessions) {
    const ws = workspaceOf(s, input.known);
    if (s.exitCode !== null) continue; // an ended process is neither work nor an open shell
    if (s.provider === "terminal") add(ws, "shells");
    else if (s.status === "needs_approval") add(ws, "attention");
    else if (s.status === "working") add(ws, "cli");
  }
  for (const r of input.runs) {
    if (r.state === "waiting_user") add(input.owner(r.runId), "attention");
    else if (r.state && AT_WORK.includes(r.state)) add(input.owner(r.runId), "runs");
  }
  return out;
}

// Closing a workspace asks first while it has work to stop: a link's latest run owned by it that is not finished
// (paused included), a live agent CLI, or any live terminal whose card was closed without a confirmed exit. An open
// shell is not work (§6); hiding never stops anything anyway.
// Wider than the switcher's counts on purpose: a paused run is not counted there, but closing still offers to stop it.
export function closeHasWork(input: {
  workspaceId: string;
  sessions: readonly { provider: string; exitCode: number | null; workspaceId?: string; closeUnconfirmed?: boolean }[];
  links: readonly { runIds: readonly string[] }[];
  owner: (runId: string) => string;
  runStatus: (runId: string) => string | undefined;
  known: (id: string) => boolean;
}): boolean {
  const { workspaceId: id } = input;
  return input.links.some((l) => { const r = l.runIds.at(-1); return !!r && input.owner(r) === id && closeCountsRun(input.runStatus(r)); })
    || input.sessions.some((s) => workspaceOf(s, input.known) === id && s.exitCode === null && (s.provider !== "terminal" || !!s.closeUnconfirmed));
}

// A bounds change never changes where the card belongs: the owner stays the one it had.
export function withBounds<T extends { workspaceId?: string }>(current: T | null, bounds: T): T {
  if (!current) return bounds;
  const { workspaceId: _ignored, ...rest } = bounds;
  return (current.workspaceId === undefined ? rest : { ...rest, workspaceId: current.workspaceId }) as T;
}

// The run holding a project folder, as main names it (folder_busy refusal, readiness "busy" facts); its workspace is
// main's owner, shown as "common" when this window does not know it. Anything malformed: null (no hint).
export function folderHolderOf(x: unknown, known: (id: string) => boolean): OrchestrationFolderHolder | null {
  const h = x as Partial<OrchestrationFolderHolder> | null | undefined;
  if (typeof h?.runId !== "string" || typeof h.workspaceId !== "string" || typeof h.runReadable !== "boolean") return null;
  return { runId: h.runId, workspaceId: known(h.workspaceId) ? h.workspaceId : COMMON_WORKSPACE_ID, runReadable: h.runReadable };
}

// The cards joined to this one by links, itself included (main applies the same rule and checks it again).
export function linkedGroup(canvas: OrchestrationCanvas, agentId: string): string[] {
  const group = new Set([agentId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const l of canvas.links) {
      if (group.has(l.fromAgentId) !== group.has(l.toAgentId)) { group.add(l.fromAgentId); group.add(l.toAgentId); grew = true; }
    }
  }
  return canvas.agents.map((a) => a.agentId).filter((id) => group.has(id));
}

export const UNFINISHED = ["preparing", "running", "pausing", "paused", "stopping"];

// Closing a workspace: a run counts as work while it is unfinished, and also while its state is not known (the snapshot
// is loading or could not be read) — an unknown state is never taken for "no work".
// What closing a workspace sees of a run: a newer version's run (acceptance-review-spec.md §2.2) is not work here — it
// runs nowhere in this version, hiding does not touch it and a stop of it is refused.
export function closeRunStatus(view: { status: string; newer?: unknown } | undefined): string | undefined {
  return view?.newer ? "newer_version" : view?.status;
}
export function closeCountsRun(status: string | undefined): boolean {
  return status === undefined || UNFINISHED.includes(status);
}

// "Arrange by workspace": the terminals and linked agent groups of one workspace, grouped by their folder. Only a
// proposal: nothing is checked, nothing moves until the person confirms.
export interface ArrangeItem { key: string; kind: "terminal" | "agents"; ids: string[]; label: string; blocked: boolean }
export interface ArrangeGroup { folder: string; items: ArrangeItem[] }
export function arrangeGroups(input: {
  workspaceId: string;
  known: (id: string) => boolean;
  sessions: readonly { id: string; title: string; cwd: string; workspaceId?: string }[];
  canvas: OrchestrationCanvas;
  runStatus: (runId: string) => string | undefined;
}): ArrangeGroup[] {
  const byFolder = new Map<string, ArrangeItem[]>();
  const put = (folder: string, item: ArrangeItem) => byFolder.set(folder, [...(byFolder.get(folder) ?? []), item]);
  for (const s of input.sessions) {
    if (workspaceOf(s, input.known) === input.workspaceId) put(s.cwd, { key: `terminal:${s.id}`, kind: "terminal", ids: [s.id], label: s.title, blocked: false });
  }
  const seen = new Set<string>();
  for (const a of input.canvas.agents) {
    if (seen.has(a.agentId) || workspaceOf(a, input.known) !== input.workspaceId) continue;
    const ids = linkedGroup(input.canvas, a.agentId);
    ids.forEach((id) => seen.add(id));
    const links = input.canvas.links.filter((l) => ids.includes(l.fromAgentId));
    const blocked = links.some((l) => l.runIds.some((r) => UNFINISHED.includes(input.runStatus(r) ?? "")));
    const lead = input.canvas.agents.find((x) => ids.includes(x.agentId) && x.role === "lead") ?? a;
    put(lead.project, { key: `agents:${ids.join(",")}`, kind: "agents", ids, label: ids.length > 1 ? "Codex → Claude" : a.provider, blocked });
  }
  return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, items]) => ({ folder, items }));
}

// A moved card or group keeps its own layout; where it would cover a card of the target workspace (HOME included), the
// whole set is shifted right to the first free place. Nothing else on the target canvas moves.
export interface Box { position: { x: number; y: number }; size: { width: number; height: number } }
const GAP = 24;
const covers = (a: Box, b: Box, dx: number): boolean => a.position.x + dx < b.position.x + b.size.width + GAP
  && b.position.x < a.position.x + dx + a.size.width + GAP
  && a.position.y < b.position.y + b.size.height + GAP && b.position.y < a.position.y + a.size.height + GAP;
export function roomFor(moving: readonly Box[], occupied: readonly Box[], step = 40, maxSteps = 1_000): number {
  for (let i = 0; i <= maxSteps; i++) {
    const dx = i * step;
    if (moving.every((m) => occupied.every((o) => !covers(m, o, dx)))) return dx;
  }
  return 0; // ponytail: no free place within 40 000 px to the right; the cards keep their coordinates
}

export const folderName = (path: string | null): string => (path ? path.split("/").filter(Boolean).at(-1) ?? path : "");

// Saves the camera of a workspace some time after its last change. Each pending write carries the id of the
// workspace it was made in, so a write that fires after a switch goes to that workspace, never to the new one; a switch
// flushes it at once.
export function createCameraSaver(write: (id: string, camera: CameraState) => void, delayMs = 500,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    set: (fn, ms) => window.setTimeout(fn, ms), clear: (t) => window.clearTimeout(t as number)
  }) {
  let pending: { id: string; camera: CameraState; timer: unknown } | null = null;
  const flush = (): void => {
    if (!pending) return;
    const { id, camera, timer } = pending;
    pending = null;
    timers.clear(timer);
    write(id, camera);
  };
  return {
    schedule(id: string, camera: CameraState): void {
      if (pending && pending.id !== id) flush();
      if (pending) timers.clear(pending.timer);
      pending = { id, camera, timer: timers.set(flush, delayMs) };
    },
    flush
  };
}

export const isCommon = (id: string): boolean => id === COMMON_WORKSPACE_ID;
