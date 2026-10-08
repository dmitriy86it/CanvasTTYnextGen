// Agent cards and links on the canvas (stage-8-contract.md §3, ARCHITECTURE-PROPOSAL §10). One JSON file next to the
// runs, written atomically through one queue. It holds no run state: a run is found by id in its own journal, so moving
// a card never touches a run's revision. Every rule of a link is checked here, not in the renderer.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type {
  OrchestrationAgentCard,
  OrchestrationAgentLink,
  OrchestrationBounds,
  OrchestrationCanvas,
  OrchestrationProviderKind,
  OrchestrationReleasedNewerRun
} from "../../../shared/orchestration.ts";
import { COMMON_WORKSPACE_ID } from "../../../shared/contracts.ts";
import { runOwners, workspaceOf } from "../../../shared/workspaceOwnership.ts";

class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const refuse = (code: string, message: string): never => { throw new Refusal(code, message); };

export const ROLE_OF: Readonly<Record<OrchestrationProviderKind, "lead" | "executor">> = Object.freeze({ codex: "lead", claude: "executor" });
const MAX_AGENTS = 200;
const MAX_COORD = 10_000_000;
const EMPTY: OrchestrationCanvas = { agents: [], links: [], owners: {} };
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isReleased = (r: unknown): r is OrchestrationReleasedNewerRun => {
  const o = r as Record<string, unknown> | null;
  return typeof o === "object" && o !== null && [o.runId, o.linkId, o.commandId].every((x) => typeof x === "string" && UUID.test(x))
    && [o.folder, o.releasedAt, o.appVersion].every((x) => typeof x === "string" && x.length <= 4096);
};

export const workspaceOfCard = (card: OrchestrationAgentCard | undefined): string => card?.workspaceId ?? COMMON_WORKSPACE_ID;

// The workspace of each run of these links is written down before the links move or go (workspaces-spec.md §2): the
// run keeps the workspace it was started in, a later move of its cards does not take its history along.
function ownersFixed(c: OrchestrationCanvas, links: readonly OrchestrationAgentLink[]): Record<string, string> {
  const owners = { ...(c.owners ?? {}) };
  for (const l of links) {
    const ws = workspaceOfCard(c.agents.find((a) => a.agentId === l.fromAgentId));
    for (const id of l.runIds) owners[id] ??= ws;
  }
  return owners;
}

// The cards joined to this one by links, itself included: they move between workspaces only together.
export function agentGroup(c: OrchestrationCanvas, agentId: string): Set<string> {
  const group = new Set([agentId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const l of c.links) {
      if (group.has(l.fromAgentId) !== group.has(l.toAgentId)) { group.add(l.fromAgentId); group.add(l.toAgentId); grew = true; }
    }
  }
  return group;
}

// Is a link busy: one of its runs can still act or be resumed. "unreadable": busy because its journal cannot be read.
// "newer": a run a newer version wrote (acceptance-review-spec.md §2.2); it holds its link and folder here, and this
// version cannot stop it.
export type Busy = (l: OrchestrationAgentLink) => Promise<boolean | "unreadable" | "newer">;
const refuseBusy = (b: boolean | "unreadable" | "newer", code: string, message: string): void => {
  if (b === "newer") refuse("link_newer_run", "a run of this link was created by a newer version; change the link there");
  if (b) refuse(code, message);
};
// folder_busy names the run that holds the folder; runReadable false: its journal cannot be read, so its state is unknown.
export interface FolderHolder { runId: string; workspaceId: string; runReadable: boolean }

// Stage 12: one active run per project folder, whatever link started it. The caller's busy rule is asked run by run, so
// the run that holds the folder is named, with its owner workspace by the rule of runOwners (workspaces-spec.md §2).
export async function folderHolder(c: OrchestrationCanvas, project: string, exceptLinkId: string, busy: Busy,
  known: (workspaceId: string) => boolean): Promise<FolderHolder | null> {
  const owner = runOwners(c, known);
  for (const other of c.links) {
    if (other.linkId === exceptLinkId || c.agents.find((a) => a.agentId === other.fromAgentId)?.project !== project) continue;
    for (const runId of other.runIds) {
      const b = await busy({ ...other, runIds: [runId] });
      if (b) return { runId, workspaceId: owner(runId), runReadable: b !== "unreadable" };
    }
  }
  return null;
}

function checkBounds(b: OrchestrationBounds): OrchestrationBounds {
  const nums = [b.position.x, b.position.y, b.size.width, b.size.height];
  if (!nums.every((n) => Number.isFinite(n) && Math.abs(n) <= MAX_COORD) || b.size.width <= 0 || b.size.height <= 0) {
    refuse("invalid_argument", "bounds must be finite and positive");
  }
  return { position: { x: b.position.x, y: b.position.y }, size: { width: b.size.width, height: b.size.height } };
}

// known(id): does this workspace exist? A card of an unknown one is on the common canvas (workspaces-spec.md §1).
export function createCanvasStore(file: string, known: (workspaceId: string) => boolean = (id) => id === COMMON_WORKSPACE_ID) {
  let cache: OrchestrationCanvas | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<OrchestrationCanvas> {
    if (cache) return cache;
    const raw = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
    let parsed: OrchestrationCanvas = EMPTY;
    if (raw !== null) {
      try {
        const v = JSON.parse(raw) as { v?: number } & OrchestrationCanvas;
        if (v.v === 1 && Array.isArray(v.agents) && Array.isArray(v.links)) {
          const owners: Record<string, string> = {};
          if (v.owners && typeof v.owners === "object" && !Array.isArray(v.owners)) {
            for (const [runId, ws] of Object.entries(v.owners)) if (typeof ws === "string" && WORKSPACE_ID.test(ws)) owners[runId] = ws;
          }
          const released = Array.isArray(v.releasedNewerRuns) ? v.releasedNewerRuns.filter(isReleased) : [];
          parsed = { agents: v.agents, links: v.links, owners, ...(released.length ? { releasedNewerRuns: released } : {}) };
        }
      } catch { /* a damaged file starts empty; it is kept aside below */ }
      if (parsed === EMPTY) await rename(file, `${file}.damaged-${randomUUID()}`).catch(() => {});
    }
    cache = parsed;
    return cache;
  }

  // The cache follows the file: a write that fails leaves both as they were, and the caller gets store_failed.
  async function save(next: OrchestrationCanvas): Promise<void> {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(tmp, JSON.stringify({ v: 1, ...next }), { mode: 0o600 });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      refuse("store_failed", `the canvas could not be saved: ${(error as NodeJS.ErrnoException)?.code ?? "error"}`);
    }
    cache = next;
  }

  // One change at a time: read, decide, write. A refusal leaves the file as it was.
  function change<T>(fn: (c: OrchestrationCanvas) => Promise<{ next: OrchestrationCanvas | null; value: T }>): Promise<T> {
    const run = queue.then(async () => {
      const { next, value } = await fn(await load());
      if (next) await save(next);
      return value;
    });
    queue = run.catch(() => {});
    return run;
  }

  const agentOf = (c: OrchestrationCanvas, id: string) => c.agents.find((a) => a.agentId === id) ?? refuse("agent_not_found", "no such agent card");
  const linkOf = (c: OrchestrationCanvas, id: string) => c.links.find((l) => l.linkId === id) ?? refuse("link_not_found", "no such link");

  const withRuns = (c: OrchestrationCanvas, runIds: (l: OrchestrationAgentLink) => string[]): OrchestrationCanvas =>
    ({ ...c, links: c.links.map((l) => ({ ...l, runIds: runIds(l) })) });

  return {
    // exists(runId): a reserved run id whose run was never created (the process ended between the reservation and
    // the creation, or the creation was refused and the reservation could not be taken back) is not shown.
    read: (exists: (runId: string) => Promise<boolean>) => queue.then(async (): Promise<OrchestrationCanvas> => {
      const c = await load();
      const known = new Map<string, boolean>();
      for (const id of [...c.links.flatMap((l) => l.runIds), ...Object.keys(c.owners ?? {})]) if (!known.has(id)) known.set(id, await exists(id));
      const owners = Object.fromEntries(Object.entries(c.owners ?? {}).filter(([id]) => known.get(id)));
      const shown = withRuns(c, (l) => l.runIds.filter((id) => known.get(id)));
      return Object.keys(owners).length ? { ...shown, owners }
        : { agents: shown.agents, links: shown.links, ...(c.releasedNewerRuns?.length ? { releasedNewerRuns: c.releasedNewerRuns } : {}) };
    }),

    createAgent: (input: { agentId: string; provider: OrchestrationProviderKind; project: string; bounds: OrchestrationBounds; workspaceId: string }) =>
      change<OrchestrationAgentCard>(async (c) => {
        if (!WORKSPACE_ID.test(input.workspaceId)) refuse("invalid_argument", "workspaceId is not a workspace id");
        if (!isAbsolute(input.project)) refuse("invalid_project", "the project folder must be an absolute path");
        const project = await realpath(input.project).catch(() => refuse("invalid_project", "the project folder does not exist"));
        if (!(await stat(project)).isDirectory()) refuse("invalid_project", "the project path is not a folder");
        const bounds = checkBounds(input.bounds);
        const same = c.agents.find((a) => a.agentId === input.agentId);
        if (same) {
          if (same.provider !== input.provider || same.project !== project || workspaceOfCard(same) !== input.workspaceId) {
            refuse("request_conflict", "this agent id belongs to another card");
          }
          return { next: null, value: same };
        }
        if (c.agents.length >= MAX_AGENTS) refuse("too_many_agents", `at most ${MAX_AGENTS} agent cards`);
        const card: OrchestrationAgentCard = {
          agentId: input.agentId, provider: input.provider, role: ROLE_OF[input.provider], project, bounds, createdAt: new Date().toISOString(),
          workspaceId: input.workspaceId
        };
        return { next: { ...c, agents: [...c.agents, card] }, value: card };
      }),

    moveAgent: (agentId: string, bounds: OrchestrationBounds, expanded?: OrchestrationBounds["size"]) => change<OrchestrationAgentCard>(async (c) => {
      const card = { ...agentOf(c, agentId), bounds: checkBounds(bounds), ...(expanded ? { expanded: checkBounds({ position: { x: 0, y: 0 }, size: expanded }).size } : {}) };
      return { next: { ...c, agents: c.agents.map((a) => (a.agentId === agentId ? card : a)) }, value: card };
    }),

    // busy(link) says whether a link has a run that still owns processes or can be resumed (stage-8-contract.md §3).
    deleteAgent: (agentId: string, busy: Busy) => change<null>(async (c) => {
      agentOf(c, agentId);
      const links = c.links.filter((l) => l.fromAgentId === agentId || l.toAgentId === agentId);
      for (const l of links) refuseBusy(await busy(l), "link_active_run", "stop the run of this card's link first");
      return {
        next: { ...c, agents: c.agents.filter((a) => a.agentId !== agentId), links: c.links.filter((l) => !links.includes(l)), owners: ownersFixed(c, links) },
        value: null
      };
    }),

    createLink: (input: { linkId: string; fromAgentId: string; toAgentId: string }) => change<OrchestrationAgentLink>(async (c) => {
      const same = c.links.find((l) => l.linkId === input.linkId);
      if (same) {
        if (same.fromAgentId !== input.fromAgentId || same.toAgentId !== input.toAgentId) refuse("request_conflict", "this link id belongs to another link");
        return { next: null, value: same };
      }
      if (input.fromAgentId === input.toAgentId) refuse("link_self", "a card cannot be linked to itself");
      const from = agentOf(c, input.fromAgentId), to = agentOf(c, input.toAgentId);
      if (from.role !== "lead" || to.role !== "executor") refuse("link_roles", "a link goes from the Codex lead to the Claude executor");
      if (c.links.some((l) => l.fromAgentId === from.agentId && l.toAgentId === to.agentId)) refuse("link_duplicate", "these cards are already linked");
      if (from.project !== to.project) refuse("link_projects", "both cards must work in the same project folder");
      if (workspaceOf(from, known) !== workspaceOf(to, known)) refuse("link_workspaces", "both cards must be in the same workspace");
      const link: OrchestrationAgentLink = { ...input, createdAt: new Date().toISOString(), runIds: [] };
      return { next: { ...c, links: [...c.links, link] }, value: link };
    }),

    deleteLink: (linkId: string, busy: Busy) => change<null>(async (c) => {
      const link = linkOf(c, linkId);
      refuseBusy(await busy(link), "link_active_run", "stop the run of this link first");
      return { next: { ...c, links: c.links.filter((l) => l.linkId !== linkId), owners: ownersFixed(c, [link]) }, value: null };
    }),

    // A link held by a newer version's run is let go (acceptance-review-spec.md §2.2.1): the link is
    // removed, which frees its folder, its runs keep their workspace (ownersFixed), and the release is written down so a
    // later version finds its run without a link. The named run must be the link's and, by busy(), a newer version's;
    // other newer runs of the link are let go with it (one entry each, one commandId); any other run of the link that is
    // busy here refuses it. A repeat of commandId answers the same entry.
    releaseNewer: (input: { commandId: string; linkId: string; runId: string; appVersion: string }, busy: Busy) =>
      change<OrchestrationReleasedNewerRun>(async (c) => {
        if (![input.commandId, input.linkId, input.runId].every((x) => typeof x === "string" && UUID.test(x))) refuse("invalid_argument", "commandId, linkId and runId must be UUIDs");
        const done = c.releasedNewerRuns?.filter((r) => r.commandId === input.commandId) ?? [];
        if (done.length) {
          const same = done.find((r) => r.linkId === input.linkId && r.runId === input.runId);
          return same ? { next: null, value: same } : refuse("request_conflict", "this commandId belongs to another release");
        }
        const link = linkOf(c, input.linkId);
        if (!link.runIds.includes(input.runId)) refuse("link_run_mismatch", "the run is not this link's");
        if (await busy({ ...link, runIds: [input.runId] }) !== "newer") refuse("run_not_newer", "only a newer version's run is let go this way");
        const newer = [input.runId];
        for (const other of link.runIds.filter((id) => id !== input.runId)) {
          const b = await busy({ ...link, runIds: [other] });
          if (b === "newer") newer.push(other);
          else if (b) refuse("link_active_run", "another run of this link is not finished");
        }
        const releasedAt = new Date().toISOString();
        const folder = agentOf(c, link.fromAgentId).project;
        const entries = newer.map((runId): OrchestrationReleasedNewerRun => ({ runId, linkId: link.linkId, folder, releasedAt, appVersion: input.appVersion, commandId: input.commandId }));
        return {
          next: { ...c, links: c.links.filter((l) => l.linkId !== link.linkId), owners: ownersFixed(c, [link]), releasedNewerRuns: [...(c.releasedNewerRuns ?? []), ...entries] },
          value: entries[0]
        };
      }),

    // A linked group moves whole, and only while none of its links has a run that is not finished (a paused run
    // included): such a run still owns its folder and processes. `agentIds` is the group the person confirmed; a group
    // that changed since is refused. The runs of its links keep their workspace (ownersFixed).
    moveGroup: (agentIds: readonly string[], workspaceId: string, busy: Busy) =>
      change<OrchestrationCanvas>(async (c) => {
        if (!WORKSPACE_ID.test(workspaceId)) refuse("invalid_argument", "workspaceId is not a workspace id");
        if (agentIds.length === 0) refuse("invalid_argument", "no cards to move");
        for (const id of agentIds) agentOf(c, id);
        const group = agentGroup(c, agentIds[0]);
        if (group.size !== new Set(agentIds).size || agentIds.some((id) => !group.has(id))) refuse("group_changed", "the linked group changed; look at it again");
        const links = c.links.filter((l) => group.has(l.fromAgentId));
        for (const l of links) refuseBusy(await busy(l), "group_active_run", "a run of this group is not finished");
        const next: OrchestrationCanvas = {
          ...c,
          owners: ownersFixed(c, links),
          agents: c.agents.map((a) => (group.has(a.agentId) ? { ...a, workspaceId } : a))
        };
        return { next, value: next };
      }),

    // A run on a link (stage-8-contract.md §3.1). Inside the queue, so two starts of one link cannot both pass the busy
    // check. The run id (= requestId) is written into the link first, durably, and only then is the run created:
    //   - the reservation cannot be written → store_failed, no run;
    //   - the run is created → it is already the link's, nothing more has to be written, a restart finds it there;
    //   - the creation is refused and no run with this id exists → the reservation is taken back (if that write fails,
    //     read() hides a run id without a run, and busy() does not count it);
    //   - request_conflict: the id belongs to another request, the reservation is taken back.
    // A repeat of the same request (its id is already reserved) goes to create() again, which answers idempotently.
    // The request's own run is left out of the busy check; any other active run of the link refuses the start.
    startOnLink: (linkId: string, requestId: string, busy: Busy,
      exists: (runId: string) => Promise<boolean>,
      create: (source: string) => Promise<{ runId: string; created: boolean }>) => change<{ runId: string; created: boolean }>(async (c) => {
      const link = linkOf(c, linkId);
      const lead = agentOf(c, link.fromAgentId);
      refuseBusy(await busy({ ...link, runIds: link.runIds.filter((id) => id !== requestId) }), "link_busy", "this link already has an active run");
      // Stage 12: agents work in the project folder itself, so one active run per folder: their changes never interleave.
      const holder = await folderHolder(c, lead.project, linkId, busy, known);
      if (holder) throw Object.assign(new Refusal("folder_busy", "another run works in this project folder now"), holder);
      const reserved = link.runIds.includes(requestId);
      let current = c;
      // The reservation and the run's workspace are one write: the run is never created without its owner, and a
      // repeat of the request keeps the owner it was reserved with.
      if (!reserved || !c.owners?.[requestId]) {
        current = {
          ...(reserved ? c : withRuns(c, (l) => (l.linkId === linkId ? [...l.runIds, requestId] : l.runIds))),
          owners: { ...(c.owners ?? {}), [requestId]: c.owners?.[requestId] ?? workspaceOfCard(lead) }
        };
        await save(current);
      }
      try {
        return { next: null, value: await create(lead.project) };
      } catch (error) {
        // run_newer_version: the id names a newer version's run, never this request's
        const conflict = error instanceof Error && ["request_conflict", "run_newer_version"].includes((error as { code?: string }).code ?? "");
        if (!reserved && (conflict || !(await exists(requestId)))) {
          // an owner written before this request (an existing run's, e.g. a newer version's) stays
          const { [requestId]: _, ...without } = current.owners ?? {};
          const owners = c.owners?.[requestId] ? current.owners ?? {} : without;
          await save({ ...withRuns(current, (l) => (l.linkId === linkId ? l.runIds.filter((id) => id !== requestId) : l.runIds)), owners }).catch(() => {});
        }
        throw error;
      }
    })
  };
}

export type CanvasStore = ReturnType<typeof createCanvasStore>;
export const canvasFile = (root: string): string => join(root, "canvas.json");
