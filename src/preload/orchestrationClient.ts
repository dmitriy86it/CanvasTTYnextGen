// window.canvasTTY.orchestration (stage-7-contract.md §3). No electron import: preload/index.ts passes its ipcRenderer
// calls in, tests pass fakes.
import { IPC } from "../shared/contracts.ts";
import { orchestrationAvailable } from "../shared/orchestration.ts";
import type {
  OrchestrationActivityEvent,
  OrchestrationApi,
  OrchestrationResult,
  OrchestrationRunEvent,
  OrchestrationRunSnapshot
} from "../shared/orchestration.ts";

export interface OrchestrationIpc {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, listener: (payload: OrchestrationRunEvent | OrchestrationActivityEvent) => void): void;
}

type Stamp = readonly [number, number];
const newer = (a: Stamp, b: Stamp) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

export function createOrchestrationClient(ipc: OrchestrationIpc, platform: string): OrchestrationApi {
  // Listeners per run on this page. The first one asks main for the page's one subscription (watch); the others only
  // read the current state (get); the last one to leave releases it (unwatch).
  const runs = new Map<string, Set<(e: OrchestrationRunEvent) => void>>();
  const activity = new Map<string, Set<(e: OrchestrationActivityEvent) => void>>();
  // One channel: a run state has `view`, an activity batch has `entries`.
  ipc.on(IPC.orchestrationEvent, (e) => {
    if (e && Array.isArray((e as OrchestrationActivityEvent).entries)) {
      for (const l of activity.get(e.runId) ?? []) { try { l(e as OrchestrationActivityEvent); } catch { /* its own */ } }
      return;
    }
    for (const deliver of runs.get(e?.runId) ?? []) deliver(e as OrchestrationRunEvent);
  });

  return {
    available: orchestrationAvailable(platform),
    catalog: () => ipc.invoke(IPC.orchestrationCatalog),
    list: () => ipc.invoke(IPC.orchestrationList),
    get: (runId) => ipc.invoke(IPC.orchestrationGet, runId),
    create: (request) => ipc.invoke(IPC.orchestrationCreate, request),
    command: (request) => ipc.invoke(IPC.orchestrationCommand, request),
    history: (runId, fromSeq, limit) => ipc.invoke(IPC.orchestrationHistory, runId, fromSeq, limit),
    text: (runId, sha256) => ipc.invoke(IPC.orchestrationText, runId, sha256),
    canvas: () => ipc.invoke(IPC.orchestrationCanvas),
    createAgent: (input) => ipc.invoke(IPC.orchestrationAgentCreate, input),
    moveAgent: (agentId, bounds) => ipc.invoke(IPC.orchestrationAgentMove, agentId, bounds),
    deleteAgent: (agentId) => ipc.invoke(IPC.orchestrationAgentDelete, agentId),
    moveAgentGroup: (agentIds, workspaceId) => ipc.invoke(IPC.orchestrationAgentGroupMove, agentIds, workspaceId),
    createLink: (input) => ipc.invoke(IPC.orchestrationLinkCreate, input),
    deleteLink: (linkId) => ipc.invoke(IPC.orchestrationLinkDelete, linkId),
    releaseNewerLink: (input) => ipc.invoke(IPC.orchestrationLinkReleaseNewer, input),
    startOnLink: (input) => ipc.invoke(IPC.orchestrationLinkStart, input),
    activity: (runId, afterId, limit) => ipc.invoke(IPC.orchestrationActivity, runId, afterId, limit),
    changes: (runId) => ipc.invoke(IPC.orchestrationChanges, runId),
    diff: (runId, path) => ipc.invoke(IPC.orchestrationDiff, runId, path),
    take: (runId) => ipc.invoke(IPC.orchestrationTake, runId),
    takeResult: (runId, input) => ipc.invoke(IPC.orchestrationTakeResult, runId, input),
    readiness: (input) => ipc.invoke(IPC.orchestrationReadiness, input),
    profile: (linkId, capabilities) => ipc.invoke(IPC.orchestrationProfileGet, linkId, capabilities === true),
    saveProfile: (linkId, profile) => ipc.invoke(IPC.orchestrationProfileSave, linkId, profile),
    codexModels: (linkId, refresh) => ipc.invoke(IPC.orchestrationCodexModels, linkId, refresh === true),
    probe: (linkId, options) => (options === undefined ? ipc.invoke(IPC.orchestrationProbe, linkId) : ipc.invoke(IPC.orchestrationProbe, linkId, options)),
    onActivity(runId, listener) {
      let set = activity.get(runId);
      if (!set) activity.set(runId, (set = new Set()));
      set.add(listener);
      const own = set;
      return () => { own.delete(listener); if (!own.size && activity.get(runId) === own) activity.delete(runId); };
    },

    // The snapshot first, then only newer states: events that arrive before the snapshot wait for it, and anything not
    // newer than what the listener already has is dropped, so the listener never goes back to an older state.
    watch(runId, listener) {
      let set = runs.get(runId);
      const first = !set;
      if (!set) runs.set(runId, (set = new Set()));
      let active = true;
      let last: Stamp | null = null;
      let waiting: OrchestrationRunEvent[] | null = [];
      const emit = (e: OrchestrationRunEvent) => {
        const stamp: Stamp = [e.seq, e.tick ?? 0];
        if (!active || (last && !newer(stamp, last))) return;
        last = stamp;
        listener(e);
      };
      const deliver = (e: OrchestrationRunEvent) => { if (waiting) waiting.push(e); else emit(e); };
      set.add(deliver);
      const leave = () => {
        if (!active) return;
        active = false;
        const own = runs.get(runId);
        if (!own?.delete(deliver) || own.size > 0) return;
        runs.delete(runId);
        void ipc.invoke(IPC.orchestrationUnwatch, runId);
      };
      const snapshot: Promise<OrchestrationResult<OrchestrationRunSnapshot>> = ipc
        .invoke(first ? IPC.orchestrationWatch : IPC.orchestrationGet, runId)
        .then((r: OrchestrationResult<OrchestrationRunSnapshot>) => {
          const queued = waiting ?? [];
          waiting = null;
          if (r?.ok) {
            emit({ runId, seq: r.value.seq, tick: r.value.tick, view: r.value.view });
            for (const e of queued) emit(e);
          } else {
            leave();
          }
          return r;
        });
      return { snapshot, unwatch: leave };
    }
  };
}
