// B4: the board's autopilot of a link (stage-b-board.md §5). It does nothing the «Start» button would not do with the
// same settings: the same start on the link (a requestId kept until answered), the same readiness first (no model turn),
// «Take the result → Create a branch» when a task became «Done» (owner's decision 8), a dependent copy from that branch
// (decision 11). It answers no question and passes no right on: a permission request is a wait (§5.3).
// Whether it is on lives here only: a restart of the application turns it off.
import type { OrchestrationGoalInput, OrchestrationProjectProfile, OrchestrationReadiness, OrchestrationResult, OrchestrationTakeOutcome } from "../../../shared/orchestration.ts";
import {
  activeMs, autopilotParallelStep, autopilotStep, goalFor,
  type AutopilotBudget, type BoardHead, type AutopilotState, type AutopilotStop, type AutopilotStopCode, type AutopilotWaiting, type Board, type RunTaskFacts
} from "../../../shared/taskBoard.ts";

type R<T> = OrchestrationResult<T>;
type Records = { ts: string; type: string; data: Record<string, unknown> }[];

export interface BoardAutopilotDeps {
  view(): Promise<{ board: Board; facts: RunTaskFacts[] }>;
  link(linkId: string): Promise<{ workspaceId: string; project: string } | null>;
  profile(project: string): Promise<OrchestrationProjectProfile>;
  optionalChecks: boolean;
  journal(runId: string): Promise<Records>;
  readiness(input: { linkId: string; commands: string[]; workMode: OrchestrationProjectProfile["workMode"]; models?: OrchestrationGoalInput["models"] }): Promise<R<OrchestrationReadiness>>;
  start(input: { linkId: string; requestId: string; goal: OrchestrationGoalInput }): Promise<R<{ runId: string }>>;
  take(runId: string): Promise<R<OrchestrationTakeOutcome>>;
  // C1 (stage-c-parallel.md §4): the board's merged head of a place with its merges, its start, a merge into it
  head(workspaceId: string, project: string): Promise<BoardHead | null>;
  ensureHead(workspaceId: string, project: string): Promise<void>;
  merge(input: { workspaceId: string; project: string; task: { id: string; key: string }; taskRunId: string; commit: string; language: "ru" | "en" }): Promise<R<{ runId: string } | { already: true }>>;
  newId(): string;
  now(): number;
}

interface Live {
  language: "ru" | "en";
  project: string;
  print: string; // the profile's fingerprint when turned on
  grants: OrchestrationProjectProfile["grants"];
  started: string[];
  pending: string | null; // a start asked and not answered yet (a refusal clears it; an error turns the autopilot off)
  waits: string | null;
  busy: boolean;
}

// §5.1: the settings a start takes, and the project's saved permissions — any change turns the autopilot off
const fingerprint = (p: OrchestrationProjectProfile): string => JSON.stringify({
  access: p.access, workMode: p.workMode, models: p.models ?? null, finish: p.finish, checks: p.checks, prepare: p.prepare, env: p.env,
  grants: p.grants.map((g) => `${g.provider}:${g.kind}:${g.fingerprint}`).sort()
});

// A start that is refused for a while only: the link or the folder holds another run, which the autopilot waits out
const LATER = new Set(["link_busy", "folder_busy"]);

// ponytail: one timer polls every link that is on (1.5 s); a run's events would wake it sooner if it ever matters
export function createBoardAutopilot(deps: BoardAutopilotDeps, budgetOf: (linkId: string) => Promise<AutopilotBudget>, tickMs = 1500) {
  const live = new Map<string, Live>();
  const stops = new Map<string, AutopilotStop>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function off(linkId: string, code: AutopilotStopCode, detail: string | null, key: string | null, waiting?: AutopilotWaiting[]): void {
    live.delete(linkId);
    stops.set(linkId, { code, detail: detail?.slice(0, 400) ?? null, key, at: new Date(deps.now()).toISOString(), ...(waiting ? { waiting: waiting.slice(0, 20) } : {}) });
    if (!live.size && timer) { clearInterval(timer); timer = null; }
  }

  async function used(l: Live): Promise<{ runs: number; ms: number }> {
    let ms = 0;
    for (const id of l.started) ms += activeMs(await deps.journal(id).catch(() => []), deps.now());
    return { runs: l.started.length, ms };
  }

  async function tick(linkId: string): Promise<void> {
    const l = live.get(linkId);
    if (!l || l.busy) return;
    l.busy = true;
    try { await step(linkId, l); } catch (error) {
      if (live.get(linkId) === l) off(linkId, "start_failed", String((error as Error)?.message ?? error), null);
    } finally { l.busy = false; }
  }

  async function step(linkId: string, l: Live): Promise<void> {
    const at = await deps.link(linkId);
    if (!at || at.project !== l.project) return off(linkId, "link_gone", null, null);
    const profile = await deps.profile(at.project);
    const { board, facts } = await deps.view();
    if (live.get(linkId) !== l) return; // turned off meanwhile
    // C1: a separate copy goes with N slots and the board's merged head; the project folder and a worktree as in B
    const next = profile.workMode === "copy"
      ? autopilotParallelStep(board, facts, at, l.started, await used(l), await budgetOf(linkId), await deps.head(at.workspaceId, at.project))
      : autopilotStep(board, facts, { ...at, workMode: profile.workMode }, l.started.at(-1) ?? null, await used(l), await budgetOf(linkId));
    l.waits = next.kind === "wait" ? next.why : null;
    if (next.kind === "wait") return;
    if (next.kind === "off") return off(linkId, next.code, next.detail, next.key, next.waiting);
    if (next.kind === "head") { await deps.ensureHead(at.workspaceId, at.project); return; }
    if (next.kind === "merge") {
      const r = await deps.merge({ workspaceId: at.workspaceId, project: at.project, task: { id: next.taskId, key: next.key }, taskRunId: next.runId, commit: next.commit, language: l.language });
      // another merge into this head goes on or waits for the person: the next step sees it
      if (!r.ok && r.code !== "merge_busy") return off(linkId, "merge_failed", r.code, next.key);
      return;
    }
    if (next.kind === "take") {
      const r = await deps.take(next.runId);
      if (!r.ok) return off(linkId, "take_failed", r.code, next.key);
      if (!["created", "renamed", "already"].includes(r.value.result)) return off(linkId, "take_failed", r.value.result, next.key);
      return;
    }
    // before a start: the settings as when it was turned on, then the same readiness as the dialog's
    if (fingerprint(profile) !== l.print) {
      const added = profile.grants.filter((g) => !l.grants.some((o) => o.id === g.id));
      return added.length ? off(linkId, "grant_added", added.map((g) => `${g.provider}: ${g.summary}`).join("; "), next.task.key)
        : off(linkId, "settings_changed", null, next.task.key);
    }
    const goal = goalFor(next.task, profile, { optionalChecks: deps.optionalChecks, language: l.language, base: next.base });
    if (!l.pending) {
      const ready = await deps.readiness({ linkId, commands: goal.commands ?? [], workMode: profile.workMode, ...(goal.models ? { models: goal.models } : {}) });
      if (!ready.ok && LATER.has(ready.code)) { l.waits = "run"; return; }
      if (!ready.ok) return off(linkId, "not_ready", ready.code, next.task.key);
      // a blocker refuses the start; a «confirm» item needs the person's acknowledgement, which the autopilot never gives
      const stop = ready.value.items.find((i) => i.level === "blocker" || i.level === "confirm");
      if (stop && stop.id === "busy") { l.waits = "run"; return; }
      if (stop) return off(linkId, "not_ready", `${stop.id}: ${stop.detail}`, next.task.key);
      l.pending = deps.newId();
    }
    if (live.get(linkId) !== l) return;
    // ponytail: turned off while this start waits in the canvas queue, the run still starts (the person sees it on the
    // link; a new autopilot does not count or take it)
    const r = await deps.start({ linkId, requestId: l.pending, goal });
    if (!r.ok) {
      if (LATER.has(r.code)) { l.pending = null; l.waits = "run"; return; }
      return off(linkId, "start_failed", r.code, next.task.key);
    }
    l.pending = null;
    l.started.push(r.value.runId);
  }

  return {
    // on: from now, with the profile as it is now; off: the run that goes on goes on, no new one starts
    async set(linkId: string, on: boolean, language: "ru" | "en" = "en"): Promise<void> {
      if (!on) { live.delete(linkId); stops.delete(linkId); if (!live.size && timer) { clearInterval(timer); timer = null; } return; }
      if (live.has(linkId)) return;
      const at = await deps.link(linkId);
      if (!at) throw Object.assign(new Error("no such link"), { code: "link_not_found" });
      const profile = await deps.profile(at.project);
      live.set(linkId, { language, project: at.project, print: fingerprint(profile), grants: profile.grants, started: [], pending: null, waits: null, busy: false });
      stops.delete(linkId);
      // the first step on the next beat; the timer alone never keeps the process up
      timer ??= setInterval(() => { for (const id of live.keys()) void tick(id); }, tickMs);
      timer.unref?.();
    },
    async state(): Promise<Record<string, AutopilotState>> {
      const out: Record<string, AutopilotState> = {};
      for (const id of new Set([...live.keys(), ...stops.keys()])) {
        const l = live.get(id);
        const u = l ? await used(l) : { runs: 0, ms: 0 };
        out[id] = { on: !!l, budget: await budgetOf(id), used: { runs: u.runs, minutes: Math.floor(u.ms / 60_000) }, waits: l?.waits ?? null, stop: stops.get(id) ?? null };
      }
      return out;
    },
    tick, // tests: one step now
    shutdown(): void { live.clear(); if (timer) { clearInterval(timer); timer = null; } }
  };
}

