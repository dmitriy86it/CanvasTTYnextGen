// Which workspace a card or a run belongs to (workspaces-spec.md §1–§2). The same rules in main (removal checks) and
// in the renderer (what each canvas shows, the switcher's counts, the history): an unknown or missing id is the
// common canvas, so nothing is ever hidden because its workspace is gone.
import { COMMON_WORKSPACE_ID } from "./contracts.ts";
import type { OrchestrationCanvas } from "./orchestration.ts";

export function workspaceOf(item: { workspaceId?: string } | null | undefined, known: (id: string) => boolean): string {
  const id = item?.workspaceId;
  return id && known(id) ? id : COMMON_WORKSPACE_ID;
}

// runId -> owning workspace: the owner written with the reservation, else the workspace of the link's lead card
// (runs started before workspaces), else the common canvas.
export function runOwners(canvas: OrchestrationCanvas, known: (id: string) => boolean): (runId: string) => string {
  const byLink = new Map<string, string>();
  for (const l of canvas.links) {
    const ws = workspaceOf(canvas.agents.find((a) => a.agentId === l.fromAgentId), known);
    for (const id of l.runIds) byLink.set(id, ws);
  }
  return (runId) => {
    const own = canvas.owners?.[runId];
    if (own) return known(own) ? own : COMMON_WORKSPACE_ID;
    return byLink.get(runId) ?? COMMON_WORKSPACE_ID;
  };
}
