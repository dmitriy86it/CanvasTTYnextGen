// Owner of the application's runs (stage-7-contract.md): one OrchestrationService handle per run, held by this
// process only, so a run has one owner and one writer. Nothing is opened or started on construction: a run is opened
// on an explicit command, created on an explicit create, and after a restart it stays as the journal left it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  OrchestrationActivityEvent,
  OrchestrationCatalog,
  OrchestrationChanges,
  OrchestrationDiff,
  OrchestrationCreateRequest,
  OrchestrationHistoryPage,
  OrchestrationResult,
  OrchestrationRunEvent,
  OrchestrationRunSnapshot
} from "../../../shared/orchestration.ts";
import type { AvailableProviderCli, ProviderCliRegistry } from "../providerCliRegistry.ts";
import { createActivityLog, createRunActivity } from "./activity.ts";
import { createNativeAgents, createProviderAgents } from "./agents.ts";
import { applyDirenv, captureLoginEnv } from "./loginEnv.ts";
import { assessReadiness, platformItem, suggestCommands, testDbItem } from "./readiness.ts";
import { accessMapping, claudeModesFromHelp, codexModesFor } from "./access.ts";
import type { AgentAccess } from "./access.ts";
import { commitMessage } from "./finish.ts";
import { laravelTestDb, neededSteps, worktreeSteps } from "./prepare.ts";
import { probeClaude, probeCodex } from "./probe.ts";
import { createProfileStore, currentBranch, gitRemotes, suggestProfile, validateProfile } from "./profile.ts";
import { NATIVE_PROTOCOL_CHECKED, parseCliVersion } from "./providers.ts";
import type { AgentAdapter } from "./agents.ts";
import { checkPreparedDeps, createRegistry } from "./checks.ts";
import type { CheckRegistry, PreparedDeps } from "./checks.ts";
import { DEFAULT_LIMITS } from "./cycle.ts";
import type { Goal } from "./cycle.ts";
import { MAX_JOURNAL_BYTES, MAX_LINE_BYTES, MAX_TEXT_BYTES, TERMINAL_STATUSES, canonical, isSha256, isTextRef, isUuid, needsRecovery, newerGoal, newerVersion, parseJournal, unfinishedWork } from "./journal.ts";
import type { JournalRecord, RunState, TextRef } from "./journal.ts";
import { conditionsView, createOrchestrationService, decidedGoal, loadConditions, progressOf, runView } from "./orchestrationService.ts";
import type { CommandOutcome, GoalInput, RunCommand, RunHandle } from "./orchestrationService.ts";
import { readRun, readText } from "./store.ts";
import type { RunReadResult } from "./store.ts";
import type { SupervisorLaunch } from "./types.ts";
import { diffTreeNames, diffTreePath, openWorkspace, readWorkspacePlace } from "./workspace.ts";
import type { CloneDir } from "./workspace.ts";
import { canvasFile, createCanvasStore, folderHolder } from "./canvasStore.ts";
import { COMMON_WORKSPACE_ID } from "../../../shared/contracts.ts";
import { orchestrationAvailable } from "../../../shared/orchestration.ts";
import type {
  OrchestrationAgentLink,
  OrchestrationBounds,
  OrchestrationEnvironmentReport,
  OrchestrationFolderHolder,
  OrchestrationGoalInput,
  OrchestrationProfileInfo,
  OrchestrationProjectProfile,
  OrchestrationProviderKind
} from "../../../shared/orchestration.ts";

const run = promisify(execFile);
const MAX_HISTORY_PAGE = 200;

// Written by a newer version: read-only here, whether its records replay by v1 rules or not.
const newerIntegrity = (status: string): boolean => status === "newer_version" || status === "newer_version_compatible";

export interface RunManagerDeps {
  root: string; // <userData>/orchestration
  // Resolved when a run is created or opened, never on construction.
  gitPath(): string;
  launch(): SupervisorLaunch;
  nodePath(): string; // the node-test check's program (its own real path)
  agents(attemptRoot: string): Promise<AgentAdapter>; // runs of stages 4–11 (goals whose checks are catalog ids)
  cloneDir?: CloneDir; // tests only: the clone of a dependency folder
  // Stage 12: the CLIs as the user runs them in a terminal of `project`. Absent: new goals with commands are refused.
  // Stage 13: direnv — apply the project's allowed .envrc (the project profile's choice).
  // direnvCwd: a worktree run's folder (direnv applies there); worktreePending: a worktree run not created yet.
  native?(project: string, opts?: NativeOpts): Promise<NativeRuntime>;
  // Journal v2 for new native runs and optional check commands (journal-v2-format.md §3.4): until A4 only the
  // development flag CANVASTTY_JOURNAL_V2, which a packaged build ignores.
  journalV2?: boolean;
  // A1.1: the lead's proposed checks in the check profile (absent: where Seatbelt is); tests only otherwise
  leadSandbox?: false | { realHome?: string };
  stopGraceMs?: number;
  // Project workspaces: may a card be placed in (or moved to) this workspace? Absent: only the common canvas.
  workspaceOpen?(workspaceId: string): boolean;
  // Does this workspace exist (hidden ones included)? A card of an unknown one is on the common canvas. Missing in a
  // plain-JS caller: every id counts as its own workspace (the raw comparison of before).
  workspaceKnown(workspaceId: string): boolean;
  appVersion?(): string; // written down when a newer version's link is let go
  // The machine's platform (process.platform by default). Where orchestrationAvailable() is false nothing new is
  // linked, started or continued; existing runs are read, stopped and unlinked. Engine tests on Linux pass "darwin".
  platform?: string;
}

export interface NativeOpts { direnv: boolean; direnvCwd?: string; worktreePending?: boolean }

export interface NativeRuntime {
  agents: AgentAdapter;
  shell: string; // real path of the user's login shell (runs the check commands)
  env: Record<string, string>; // its environment in the project folder
  versions: Record<"codex" | "claude", string>; // `--version` lines
  // Stage 13
  executables?: Record<"codex" | "claude", string>; // for the environment probe
  direnv?: string; // DirenvState
  claudeHelp?(): Promise<string>; // `claude --help`: the permission modes this version offers
}

type R<T> = OrchestrationResult<T>;
class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const refuse = (code: string, message: string): never => { throw new Refusal(code, message); };
async function result<T>(fn: () => Promise<T>): Promise<R<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const code = error instanceof Refusal ? error.code
      : typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "internal_error";
    const failed = { ok: false as const, code, message: String((error as Error)?.message ?? error).slice(0, 500) };
    const held = error as Partial<OrchestrationFolderHolder>;
    return code === "folder_busy" && typeof held.runId === "string" && typeof held.workspaceId === "string" && typeof held.runReadable === "boolean"
      ? { ...failed, runId: held.runId, workspaceId: held.workspaceId, runReadable: held.runReadable } : failed;
  }
}

// The check catalog is the application's, not the renderer's: one id, a fixed program and argv.
export const CHECK_CATALOG: OrchestrationCatalog = { checks: [{ id: "node-test", title: "node --test" }] };
const MAX_ACTIVITY_PAGE = 500;
function checkRegistry(node: string): CheckRegistry {
  return createRegistry([{ id: "node-test", title: "node --test", executable: node, argv: ["--test"], timeoutMs: 600_000, maxOutputBytes: 65_536 }]);
}

// Dependencies the user prepared in the project itself: package-lock.json and a real node_modules next to it.
async function preparedDeps(source: string): Promise<PreparedDeps> {
  const lock = join(source, "package-lock.json");
  const nm = join(source, "node_modules");
  const lockBytes = await readFile(lock).catch(() => refuse("deps_unavailable", "the project has no package-lock.json at its top level"));
  const st = await stat(nm).catch(() => null);
  if (!st?.isDirectory() || (await realpath(nm)) !== nm) refuse("deps_unavailable", "the project has no installed node_modules of its own");
  return checkPreparedDeps({ lockfileRelPath: "package-lock.json", lockfileSha256: createHash("sha256").update(lockBytes).digest("hex"), nodeModulesPath: nm });
}

export function createRunManager(deps: RunManagerDeps) {
  const handles = new Map<string, RunHandle>();
  const runRuntimes = new Map<string, NativeRuntime>(); // the native runs held: their runtime (resume checks the test database)
  const opening = new Map<string, Promise<RunHandle>>();
  const stopping = new Map<string, Promise<void>>(); // a stop of a run not held, until it is accepted or its handle closed
  // An unfinished creation and the identity of the request that started it (§1.1).
  const creating = new Map<string, { key: string; p: Promise<{ runId: string; created: boolean }> }>();
  const watchers = new Map<string, Set<(e: OrchestrationRunEvent) => void>>();
  let closing = false;
  const known = (id: string) => deps.workspaceKnown?.(id) ?? true;
  const canvas = createCanvasStore(canvasFile(deps.root), known); // reads nothing until asked
  const activityLog = createActivityLog(deps.root); // reads nothing until asked
  const profiles = createProfileStore(deps.root); // reads nothing until asked
  const direnvOf = async (project: string) => ({ direnv: (await profiles.get(project))?.env.direnv ?? true });
  const runtimes = new Map<string, { at: number; value: Parameters<typeof assessReadiness>[0]["runtime"] }>();
  const activityWatchers = new Map<string, Set<(e: OrchestrationActivityEvent) => void>>();
  // A link is busy while one of its runs can still act or be resumed: deleting it then needs a Stop first.
  const BUSY = ["preparing", "running", "pausing", "paused", "stopping"];
  const busy = async (link: OrchestrationAgentLink): Promise<boolean | "unreadable" | "newer"> => {
    for (const runId of link.runIds) {
      const s = await result(() => snapshot(runId));
      if (s.ok && s.value.view.newer) return "newer"; // its state is unknown here: fail closed, and say why
      if (s.ok && BUSY.includes(s.value.view.status)) return true;
      if (!s.ok && await exists(runId)) return "unreadable"; // a journal that cannot be read may belong to a run at work: fail closed
    }
    return false;
  };
  // A run exists once its journal does (a link's reserved id may name a run that was never created, §3.1).
  const exists = (runId: string): Promise<boolean> =>
    stat(join(deps.root, "runs", runId, "journal.jsonl")).then(() => true, () => false);

  const workspaceOk = (id: string) => {
    if (!(deps.workspaceOpen ?? ((w: string) => w === COMMON_WORKSPACE_ID))(id)) refuse("workspace_unavailable", "no such open workspace");
  };
  const notOpen = () => { if (closing) refuse("shutting_down", "the application is closing"); };
  const platform = deps.platform ?? process.platform;
  // Before any CLI, login shell, prepared dependency or model call.
  const platformOk = () => {
    if (!orchestrationAvailable(platform)) refuse("unsupported_platform", `orchestration is available only on macOS: project checks need its Seatbelt sandbox (this is ${platform})`);
  };
  const runIdOk = (runId: unknown): string => (isUuid(runId) ? runId : refuse("invalid_argument", "runId must be a UUID"));

  const activityFanout = new Map<string, () => void>();
  function watchActivity(runId: string, listener: (e: OrchestrationActivityEvent) => void): () => void {
    let set = activityWatchers.get(runId);
    if (!set) {
      activityWatchers.set(runId, (set = new Set()));
      const own = set;
      activityFanout.set(runId, activityLog.subscribe(runId, (entries) => {
        for (const l of own) { try { l({ runId, entries }); } catch { /* the listener's own failure */ } }
      }));
    }
    set.add(listener);
    const own = set;
    return () => {
      own.delete(listener);
      if (!own.size && activityWatchers.get(runId) === own) {
        activityWatchers.delete(runId);
        activityFanout.get(runId)?.();
        activityFanout.delete(runId);
      }
    };
  }

  function own(h: RunHandle): RunHandle {
    handles.set(h.runId, h);
    watch(h);
    return h;
  }
  function watch(h: RunHandle): () => void {
    return h.onChange((seq) => {
      const set = watchers.get(h.runId);
      if (!set?.size) return;
      const event = { runId: h.runId, seq, tick: h.tick(), view: h.view() };
      for (const l of set) l(event);
    });
  }

  // native (stage 12): the user's own CLIs, environment and check commands. Otherwise the restricted runtime of
  // stages 4–11, kept for the runs made with it (their journal promises that contract) and for its tests.
  // worktree: the run's worktree folder, or "pending" before it is created; direnv applies in that folder (RT-10.4)
  async function serviceWith(source: string, native: boolean, worktree: string | null = null): Promise<{ svc: ReturnType<typeof createOrchestrationService>; rt: NativeRuntime | null }> {
    const root = deps.root;
    const attemptRoot = join(root, "attempts");
    if (native) {
      if (!deps.native) refuse("provider_unavailable", "this application has no native agent runtime");
      const rt = await deps.native!(source, { ...(await direnvOf(source)), ...(worktree === "pending" ? { worktreePending: true } : worktree ? { direnvCwd: worktree } : {}) });
      return { rt, svc: createOrchestrationService({
        root, gitPath: deps.gitPath(), agents: rt.agents, stopGraceMs: deps.stopGraceMs, journalV2: deps.journalV2 === true,
        activity: (runId) => createRunActivity(activityLog, runId),
        // Saved "for this project" decisions: this project's profile only.
        grants: {
          list: async () => (await profiles.get(source))?.grants ?? [],
          add: async (g) => { await profiles.addGrant(source, g); }
        },
        checks: {
          registry: checkRegistry(deps.nodePath()), deps: null, launch: deps.launch(), shell: { shell: rt.shell, env: rt.env },
          ...(deps.leadSandbox !== undefined ? { leadSandbox: deps.leadSandbox } : {})
        },
        ...(deps.cloneDir ? { cloneDir: deps.cloneDir } : {})
      }) };
    }
    const [checksDeps, agents] = [await preparedDeps(source), await deps.agents(attemptRoot)];
    await mkdir(attemptRoot, { recursive: true, mode: 0o700 }); // after the refusals: a refused run leaves nothing
    return { rt: null, svc: createOrchestrationService({
      root, gitPath: deps.gitPath(), agents, stopGraceMs: deps.stopGraceMs,
      activity: (runId) => createRunActivity(activityLog, runId),
      checks: { registry: checkRegistry(deps.nodePath()), deps: checksDeps, launch: deps.launch() }
    }) };
  }

  // A run on disk that this process does not hold yet: opened (run.recovered), nothing started.
  async function handleFor(runId: string): Promise<RunHandle> {
    for (let s; (s = stopping.get(runId)); ) await s; // a stop without the runtime owns the journal until it is decided
    const held = handles.get(runId);
    if (held) return held;
    let p = opening.get(runId);
    if (!p) {
      p = (async () => {
        const state = continuable(await readRun(deps.root, runId).catch(() => refuse("run_not_found", `run ${runId} not found`)));
        const ws = await openWorkspace({ root: deps.root, runId, gitPath: deps.gitPath() });
        const goal = JSON.parse((await readText(deps.root, runId, state.goal)).toString("utf8")) as { commands?: unknown };
        await activityLog.open(runId);
        const { svc, rt } = await serviceWith(ws.sourcePath, Array.isArray(goal.commands), ws.mode === "worktree" ? ws.repo : null);
        if (rt) runRuntimes.set(runId, rt);
        return own(await svc.openRun(runId));
      })().finally(() => opening.delete(runId));
      opening.set(runId, p);
    }
    return p;
  }

  // Stop of a run this process does not hold: nothing of it runs here, so the stop only has to be journaled and needs
  // no agent, CLI, login shell or prepared dependencies (a run paused before a restart stays stoppable when its CLI is
  // gone or of another version). The run is opened without its runtime (an agent turn or a check refuses) and no other
  // command reaches that handle: while the stop is decided, `stopping` holds every other command and opening of the run
  // (handleFor, a second stop), and the handle is not in `handles`. Accepted: kept as the run's handle (a stopping or
  // stopped run accepts no other command). Otherwise closed, and the next command opens the run with its runtime.
  // Called only when the run is neither held nor being opened; `stopping` is set before the first await.
  async function stopUnheld(runId: string, input: { commandId: string; expectedRevision: number; command: RunCommand }): Promise<CommandOutcome> {
    let release!: () => void;
    stopping.set(runId, new Promise<void>((r) => { release = r; }));
    try {
      const state = continuable(await readRun(deps.root, runId).catch(() => refuse("run_not_found", `run ${runId} not found`)));
      const goal = JSON.parse((await readText(deps.root, runId, state.goal)).toString("utf8")) as { commands?: unknown };
      await activityLog.open(runId);
      const unused = realpathSync(process.execPath); // stands for the check programs, never run by this handle
      const svc = createOrchestrationService({
        root: deps.root, gitPath: deps.gitPath(), stopGraceMs: deps.stopGraceMs,
        agents: { prepare: () => refuse("provider_unavailable", "the run was opened only to stop it") },
        activity: (id) => createRunActivity(activityLog, id),
        checks: { registry: checkRegistry(unused), deps: null, launch: deps.launch(), ...(Array.isArray(goal.commands) ? { shell: { shell: unused, env: {} } } : {}) }
      });
      const h = await svc.openRun(runId);
      const unwatch = watch(h); // the stop's own changes reach the watchers
      let outcome: CommandOutcome;
      try {
        outcome = await h.command(input);
      } catch (error) {
        unwatch();
        await h.close().catch(() => {});
        throw error;
      }
      if (outcome.status === "accepted") handles.set(runId, h);
      else { unwatch(); await h.close(); }
      return outcome;
    } finally {
      stopping.delete(runId);
      release();
    }
  }

  async function snapshot(runId: string): Promise<OrchestrationRunSnapshot> {
    const read = await readRun(deps.root, runId).catch(() => refuse("run_not_found", `run ${runId} not found`));
    const held = handles.get(runId); // after the read: the handle's state as it is now
    if (held) return { seq: held.seq(), tick: held.tick(), view: held.view(), integrity: read.integrity.status, open: true };
    if (read.integrity.status === "newer_version") return newerSnapshot(runId, read.integrity.detail);
    if (read.integrity.status === "newer_version_compatible") return compatibleSnapshot(runId, read.state!, read.integrity.detail);
    if (!read.state) refuse("journal_corrupt", "the run's journal has no valid start");
    const st = read.state!;
    // Where it works and what is done, as the open run would show it (UX-5): from the marker, the goal and the journal.
    const place = await readWorkspacePlace(deps.root, runId).catch(() => null);
    const goal = await readText(deps.root, runId, st.goal).then((b) => decidedGoal(deps.root, runId, st, JSON.parse(b.toString("utf8")) as Goal), () => null);
    // A2: the conditions as their texts say, with the latest result of each check (nobody holds the run's tree now)
    const readJson = async <T>(ref: TextRef): Promise<T> => JSON.parse((await readText(deps.root, runId, ref)).toString("utf8")) as T;
    const conditions = goal && st.version === 2 ? await loadConditions(st, readJson).then((c) => conditionsView(st, goal, c, null), () => null) : undefined;
    const view = runView(st, false, null, {
      ...(place ? { workMode: place.mode, workDir: place.repo } : {}),
      ...(goal ? { progress: { ...progressOf(st, goal, place?.branch ?? null), ...(conditions !== undefined ? { conditions } : {}) } } : {})
    });
    // Not held by this process, yet left running, pausing or with work in flight: the process that ran it ended without
    // shutdown. Shown as opening it will record it (run.recovered): paused, outcome_unknown if a turn was in flight,
    // otherwise recovered, so the actions offered are the ones that command will accept. Nothing is written or started,
    // and revision is the same (run.recovered does not count).
    if (needsRecovery(st) && !TERMINAL_STATUSES.includes(st.status)) {
      Object.assign(view, { status: "paused", reason: unfinishedWork(st).turns.length > 0 ? "outcome_unknown" : "recovered" });
    }
    return { seq: st.lastSeq, tick: 0, view, integrity: read.integrity.status, open: false };
  }

  // A0 bridge (acceptance-review-spec.md §2.2): a run written by a newer version is listed and its history read, and
  // nothing else: no open, recovery, stop, command or CLI. Shown as paused (it may still go on in that version) with the
  // goal of its run.created, never as a damaged journal.
  async function newerSnapshot(runId: string, detail: { version: number; chain: { status: "ok" | "torn_tail" | "corrupt" }; fallback?: { line: number; code: string } }): Promise<OrchestrationRunSnapshot> {
    const records = await journal(runId);
    const goal = await newerGoalText(runId, records);
    const place = await readWorkspacePlace(deps.root, runId).catch(() => null);
    return {
      seq: records.at(-1)?.seq ?? 0, tick: 0, integrity: "newer_version", open: false,
      view: {
        runId, status: "paused", reason: "newer_version", revision: 0, stage: null, turns: 0, halted: false, active: null,
        ...(place ? { workMode: place.mode, workDir: place.repo } : {}),
        newer: { version: detail.version, chain: detail.chain.status, goal, ...(detail.fallback ? { fallback: detail.fallback } : {}) }
      }
    };
  }
  const newerGoalText = async (runId: string, records: JournalRecord[]): Promise<string | null> => {
    const ref = newerGoal(records);
    return ref ? readText(deps.root, runId, ref).then((b) => {
      const g = JSON.parse(b.toString("utf8")) as { text?: unknown };
      return typeof g.text === "string" ? g.text : null;
    }).catch(() => null) : null;
  };
  // A newer journal that declares minReaderVersion this build reads: its whole state by v1 rules, as journaled (no
  // recovery is shown or recorded), and still nothing but reading: it is never opened, stopped or continued here.
  async function compatibleSnapshot(runId: string, st: RunState, detail: { version: number; chain: { status: "ok" | "torn_tail" | "corrupt" }; skipped: number }): Promise<OrchestrationRunSnapshot> {
    const place = await readWorkspacePlace(deps.root, runId).catch(() => null);
    const goalJson = await readText(deps.root, runId, st.goal).then((b) => JSON.parse(b.toString("utf8")) as Goal, () => null);
    const view = runView(st, false, null, {
      ...(place ? { workMode: place.mode, workDir: place.repo } : {}),
      ...(goalJson ? { progress: progressOf(st, goalJson, place?.branch ?? null) } : {})
    });
    const goal = typeof (goalJson as { text?: unknown } | null)?.text === "string" ? (goalJson as { text: string }).text : null;
    return {
      seq: st.lastSeq, tick: 0, integrity: "newer_version_compatible", open: false,
      view: { ...view, active: null, permission: null, pendingPermissions: 0, newer: { version: detail.version, chain: detail.chain.status, goal, compatible: true, skipped: detail.skipped } }
    };
  }
  // The state of a run this version can open and change; a newer version's run is refused without touching it.
  function continuable(read: RunReadResult) {
    if (newerIntegrity(read.integrity.status)) refuse("run_newer_version", "the run was created by a newer version of the application");
    return read.state ?? refuse("journal_corrupt", "the run's journal has no valid start");
  }

  async function journal(runId: string): Promise<JournalRecord[]> {
    const file = join(deps.root, "runs", runId, "journal.jsonl");
    const size = (await stat(file).catch(() => refuse("run_not_found", `run ${runId} not found`))).size;
    if (size > MAX_JOURNAL_BYTES) {
      // Over the limit: never read whole. A newer version's journal still shows the records of its first 64 KiB.
      const fh = await open(file, "r").catch(() => refuse("run_not_found", `run ${runId} not found`));
      const head = Buffer.alloc(MAX_LINE_BYTES + 1);
      try { await fh.read(head, 0, head.length, 0); } finally { await fh.close(); }
      return newerVersion(head) === null ? [] : parseJournal(head, runId).records;
    }
    const buf = await readFile(file).catch(() => refuse("run_not_found", `run ${runId} not found`));
    return parseJournal(buf, runId).records; // ponytail: parses the whole journal (≤64 MiB) per page; index by seq if it gets slow
  }

  // A create request's identity: the project's canonical path (realpath: trailing slashes, `.`/`..`, symlinks and
  // /var = /private/var give one project) and the normalized goal. Reading the path is the only effect.
  async function requestIdentity(req: OrchestrationCreateRequest): Promise<{ key: string; source: string }> {
    const source = await realpath(req.source).catch(() => refuse("invalid_source", "the project directory does not exist"));
    const g = req.goal;
    const key = createHash("sha256").update(canonical({
      source, goal: {
        text: g.text, criteria: g.criteria, checks: g.checks, reviewPlan: g.reviewPlan ?? false, limits: { ...DEFAULT_LIMITS, ...(g.limits ?? {}) },
        ...(g.commands ? { commands: g.commands } : {}), ...(g.workMode ? { workMode: g.workMode } : {}),
        ...(g.mode ? { mode: g.mode } : {}), ...(g.finish ? { finish: g.finish } : {})
      }
    })).digest("hex");
    return { key, source };
  }
  const conflict = () => refuse("request_conflict", "this requestId belongs to another create request");

  // The explicit command that starts a run: created, then driven automatically. requestId is the runId.
  async function createRun(req: OrchestrationCreateRequest): Promise<{ runId: string; created: boolean }> {
    notOpen();
    platformOk();
    const runId = runIdOk(req.requestId);
    const { key, source } = await requestIdentity(req);
    // From here to creating.set nothing awaits: one attempt per requestId, joined only by an identical request, and
    // none admitted once shutdown() has begun (it awaits only the attempts registered before it).
    notOpen();
    const running = creating.get(runId);
    if (running) return running.key === key ? running.p : conflict();
    const p = (async () => {
      const existing = await readRun(deps.root, runId).catch(() => null);
      // a journal this version cannot continue (a newer version's, a damaged one) is refused before any agent or CLI
      if (existing && (!existing.state || newerIntegrity(existing.integrity.status))) continuable(existing); // run_newer_version or journal_corrupt
      if (existing?.state) {
        const stored = JSON.parse((await readText(deps.root, runId, existing.state.goal)).toString("utf8")) as Record<string, unknown>;
        return stored.requestKey === key ? { runId, created: false } : conflict();
      }
      // The catalog is checked before anything is resolved (no agent, no CLI version probe).
      const native = Array.isArray(req.goal.commands) || req.goal.mode !== undefined;
      if (!native) for (const id of req.goal.checks) if (!CHECK_CATALOG.checks.some((c) => c.id === id)) refuse("unknown_check", `no check with id ${id}`);
      await activityLog.open(runId);
      const workMode = req.goal.workMode ?? (req.goal.mode ? (await profiles.get(source))?.workMode ?? "project" : undefined);
      const { svc, rt } = await serviceWith(source, native, workMode === "worktree" ? "pending" : null);
      const { prepareAuto, ...goal } = await resolveGoal(source, runId, req.goal, rt);
      own(await svc.createRun({ source, goal, runId, requestKey: key, prepareAuto }));
      if (rt) runRuntimes.set(runId, rt);
      return { runId, created: true };
    })();
    creating.set(runId, { key, p });
    // Only concurrent identical requests share the attempt; a later one finds the run on disk (created: false).
    void p.finally(() => creating.delete(runId)).catch(() => {});
    return p;
  }

  // Stage 13: a goal with a mode takes what the dialog does not ask from the project profile (saved, or the suggestion
  // from the repository, saved on this first start so later decisions have a place). The actions after success run
  // only when this goal asks for them, and push and QA only with a remote/branch and a QA process set in the profile.
  // A Laravel project's tests never on a database that may be production: checked again here, not only in the dialog.
  // dir: the project, or the run's worktree on resume (fresh: it has no .env yet, the preparation copies .env.example)
  async function refuseUnsafeTestDb(dir: string, workMode: string | undefined, rt: NativeRuntime | null, fresh = workMode === "worktree"): Promise<void> {
    if (!rt || workMode === "copy" || workMode === undefined || !(await suggestCommands(dir)).laravel) return;
    const item = testDbItem(await laravelTestDb(dir, undefined, { env: rt.env, worktree: fresh }));
    if (item.level === "blocker") refuse("test_database_unsafe", item.detail);
  }
  async function resolveGoal(source: string, runId: string, g: OrchestrationGoalInput, rt: NativeRuntime | null): Promise<GoalInput & { prepareAuto?: boolean }> {
    const { mode, finish, ...rest } = g;
    if (!mode) {
      if (finish) refuse("invalid_goal", "actions after success need a run mode");
      await refuseUnsafeTestDb(source, rest.workMode, rt);
      return rest;
    }
    const profile = (await profiles.get(source)) ?? await profiles.save(source, await suggestProfile(source));
    await refuseUnsafeTestDb(source, rest.workMode ?? profile.workMode, rt);
    if (finish?.push && !profile.finish.push) refuse("finish_not_configured", "push: no remote and branch in the project settings");
    if (finish?.qa && !profile.finish.qa) refuse("finish_not_configured", "QA: no environment, command and verification in the project settings");
    // QA deploys a confirmed commit of the checked state and its verification gets that commit
    if (finish?.qa && !finish.commit) refuse("invalid_goal", "QA needs the commit action");
    const any = finish && (finish.commit || finish.push || finish.qa);
    const workMode = rest.workMode ?? profile.workMode;
    // The rights the installed CLIs offer now: a mode saved for another version is refused, never passed on a guess.
    const access = profile.access as AgentAccess;
    // Never narrowed on the quiet: another mode would give the agents other rights than the person chose.
    if (rt && access.claude !== "terminal") {
      const help = rt.claudeHelp ? await rt.claudeHelp().catch(() => "") : "";
      const version = parseCliVersion("claude", rt.versions.claude) ?? rt.versions.claude.slice(0, 60);
      if (!help.trim()) refuse("access_unsupported", `Claude ${access.claude}: could not read --help of Claude ${version} to confirm the mode`);
      if (!claudeModesFromHelp(help).includes(access.claude)) refuse("access_unsupported", `Claude ${access.claude}: Claude ${version} does not offer this mode`);
    }
    if (rt && access.codex !== "terminal") {
      const version = parseCliVersion("codex", rt.versions.codex);
      if (!codexModesFor(NATIVE_PROTOCOL_CHECKED.codex.includes(version ?? "")).includes(access.codex)) {
        refuse("access_unsupported", `Codex ${access.codex}: the protocol of Codex ${version ?? rt.versions.codex.slice(0, 60)} was not compared`);
      }
    }
    // A separate copy and a worktree start without the project's ignored files: the dependency folders are cloned from
    // the project when their lock files match (cloneDependencies), the rest is prepared in them.
    const steps = !profile.prepare.auto ? []
      : workMode === "project" ? profile.prepare.steps : await worktreeSteps(source, profile.prepare.steps);
    return {
      ...rest, mode,
      // journal v2: commands left empty on purpose — the lead proposes them
      commands: rest.commands?.length || (deps.journalV2 && rest.commands) ? rest.commands : profile.checks,
      workMode,
      ...(steps.length ? { prepare: { steps } } : {}),
      prepareAuto: profile.prepare.auto,
      access,
      ...(any ? {
        finish: {
          commit: finish!.commit || finish!.push ? { message: commitMessage(g.text, runId) } : null,
          push: finish!.push ? profile.finish.push : null,
          qa: finish!.qa ? profile.finish.qa : null
        }
      } : {})
    };
  }

  async function leadProject(linkId: string): Promise<string> {
    const c = await canvas.read(exists);
    const link = c.links.find((l) => l.linkId === linkId) ?? refuse("link_not_found", "no such link");
    return (c.agents.find((a) => a.agentId === link.fromAgentId) ?? refuse("link_not_found", "the link has no lead")).project;
  }
  const nativeOf = (project: string) =>
    deps.native ? deps.native(project, undefined).catch(() => null) : Promise.resolve(null);

  async function changeTarget(runId: string) {
    const read = await readRun(deps.root, runId).catch(() => refuse("run_not_found", `run ${runId} not found`));
    const st = continuable(read);
    if (!st.workspace) refuse("run_not_found", "the run has no working copy");
    const ws = await openWorkspace({ root: deps.root, runId, gitPath: deps.gitPath() });
    const live = handles.get(runId)?.latestTree() ?? null;
    const lastCheck = Object.values(st.checks).at(-1);
    const cps = Object.keys(st.workspace!.checkpoints).map(Number).sort((a, b) => a - b);
    const target: { tree: string; at: OrchestrationChanges["at"]; ts: string | null } = live ? { tree: live.tree, at: "live_snapshot", ts: live.at }
      : lastCheck ? { tree: lastCheck.treeAfter ?? lastCheck.treeBefore, at: "last_check", ts: null }
        : cps.length ? { tree: st.workspace!.checkpoints[String(cps.at(-1))].tree, at: "checkpoint", ts: null }
          : { tree: st.workspace!.baseline.tree, at: "baseline", ts: null };
    return { ws, st, target };
  }

  return {
    catalog: () => result(async (): Promise<OrchestrationCatalog> => ({
      ...CHECK_CATALOG,
      providers: {
        lead: { provider: "codex", mode: "native", protocol: "codex app-server" },
        executor: { provider: "claude", mode: "native", protocol: "claude -p stream-json (host permission prompts)" }
      }
    })),

    list: () => result(async () => {
      const names = await readdir(join(deps.root, "runs")).catch(() => [] as string[]);
      const out: OrchestrationRunSnapshot[] = [];
      for (const id of names.filter(isUuid).sort()) {
        const s = await result(() => snapshot(id));
        if (s.ok) out.push(s.value);
      }
      return out;
    }),

    get: (runId: string) => result(() => snapshot(runIdOk(runId))),

    create: (req: OrchestrationCreateRequest) => result(() => createRun(req)),

    canvas: () => result(() => canvas.read(exists)),
    // workspaceId: always sent over IPC; a direct call without one places the card on the common canvas.
    createAgent: (input: { agentId: string; provider: OrchestrationProviderKind; project: string; bounds: OrchestrationBounds; workspaceId?: string }) =>
      result(() => {
        platformOk();
        const workspaceId = input.workspaceId ?? COMMON_WORKSPACE_ID;
        workspaceOk(workspaceId);
        return canvas.createAgent({ ...input, workspaceId });
      }),
    moveAgentGroup: (agentIds: string[], workspaceId: string) =>
      result(async () => { workspaceOk(workspaceId); await canvas.moveGroup(agentIds, workspaceId, busy); return canvas.read(exists); }),
    moveAgent: (agentId: string, bounds: OrchestrationBounds) => result(() => canvas.moveAgent(agentId, bounds)),
    deleteAgent: (agentId: string) => result(() => canvas.deleteAgent(agentId, busy)),
    createLink: (input: { linkId: string; fromAgentId: string; toAgentId: string }) => result(() => { platformOk(); return canvas.createLink(input); }),
    deleteLink: (linkId: string) => result(() => canvas.deleteLink(linkId, busy)),
    // Only a link that holds a newer version's run (busy says "newer" for that run), and only its own run.
    releaseNewerLink: (input: { commandId: string; linkId: string; runId: string }) =>
      result(() => canvas.releaseNewer({ ...input, appVersion: deps.appVersion?.() ?? "unknown" }, busy)),
    startOnLink: (input: { linkId: string; requestId: string; goal: OrchestrationGoalInput }) => result(() => {
      notOpen();
      platformOk();
      return canvas.startOnLink(input.linkId, input.requestId, busy, exists, (source) => createRun({ requestId: input.requestId, source, goal: input.goal }));
    }),

    command: (runId: string, input: { commandId: string; expectedRevision: number; command: RunCommand }) => result(async (): Promise<CommandOutcome> => {
      notOpen();
      // Only Stop here: any other command opens the run with its runtime (the CLIs, the login shell) to continue it.
      if (input.command?.kind !== "stop") platformOk();
      if (input.command?.kind === "stop") {
        // An opening or another stop under way decides first whether this process holds the run: one owner of its journal.
        for (let p; (p = stopping.get(runIdOk(runId)) ?? opening.get(runId)); ) await p.catch(() => {});
        if (!handles.has(runId)) return stopUnheld(runId, input);
      }
      const h = await handleFor(runIdOk(runId));
      // the environment or the files may have changed while the run waited: checked again before the next turn or check
      const rt = runRuntimes.get(runId);
      if (input.command?.kind === "resume" && rt) {
        const place = await readWorkspacePlace(deps.root, runId);
        await refuseUnsafeTestDb(place.repo, place.mode, rt, place.mode === "worktree" && !(await stat(join(place.repo, ".env")).then(() => true, () => false)));
      }
      return h.command(input);
    }),

    // Records from fromSeq on (the journal starts at 0); the next page starts at the last seq + 1.
    history: (runId: string, fromSeq: number, limit: number) => result(async (): Promise<OrchestrationHistoryPage> => {
      const records = await journal(runIdOk(runId));
      const after = records.filter((r) => r.seq >= fromSeq);
      const page = after.slice(0, Math.min(limit, MAX_HISTORY_PAGE));
      return {
        records: page.map((r) => ({ seq: r.seq, ts: r.ts, type: r.type, data: r.data })),
        lastSeq: records.at(-1)?.seq ?? 0, more: after.length > page.length
      };
    }),

    // Only a text this run's journal refers to; never a path.
    text: (runId: string, sha256: string) => result(async () => {
      runIdOk(runId);
      if (!isSha256(sha256)) refuse("invalid_argument", "sha256 must be 64 lowercase hex digits");
      const ref = findRef(await journal(runId), sha256) ?? refuse("text_not_found", "the run's journal does not refer to this text");
      if (ref.bytes > MAX_TEXT_BYTES) refuse("text_too_large", "text is larger than a text record");
      // A file error (permissions, I/O) is said as such, not as an errno with a path.
      const text = await readText(deps.root, runId, ref).catch((error: { code?: string }) =>
        error?.code === "text_missing" || error?.code === "text_corrupt" ? Promise.reject(error) : refuse("text_unreadable", "the text file could not be read"));
      return { text: text.toString("utf8") };
    }),

    // Stored and live activity of a run (stage 11): never a path outside the copy, never the CLI's own files.
    activity: (runId: string, afterId: number, limit: number) => result(async () => {
      runIdOk(runId);
      if (!(await exists(runId))) refuse("run_not_found", `run ${runId} not found`);
      return activityLog.page(runId, afterId, Math.min(limit, MAX_ACTIVITY_PAGE));
    }),
    watchActivity: (runId: string, listener: (e: OrchestrationActivityEvent) => void) => watchActivity(runIdOk(runId), listener),

    // What changed in the copy against the baseline, from Git objects (the newest tree this process read, else the last
    // check's, else the last checkpoint). Nothing is read from the working copy and nothing is written.
    changes: (runId: string) => result(async (): Promise<OrchestrationChanges> => {
      const { ws, st, target } = await changeTarget(runIdOk(runId));
      const names = await diffTreeNames(ws, st.workspace!.baseline.tree, target.tree);
      const checkpoints = Object.entries(st.workspace!.checkpoints).map(([stage, c]) => ({
        stage: Number(stage), ref: `refs/canvastty/${runId}/stage-${stage}`, commit: c.commit
      })).sort((a, b) => a.stage - b.stage);
      return {
        base: "baseline", at: target.at, atTs: target.ts, files: names.files, truncated: names.truncated, checkpoints,
        baselineRef: `refs/canvastty/${runId}/baseline`, transferred: false
      };
    }),
    // One file's diff, only for a path the change list of this run names.
    diff: (runId: string, path: string) => result(async (): Promise<OrchestrationDiff> => {
      const { ws, st, target } = await changeTarget(runIdOk(runId));
      const names = await diffTreeNames(ws, st.workspace!.baseline.tree, target.tree);
      if (!names.files.some((f) => f.path === path)) refuse("invalid_argument", "the path is not in this run's changes");
      const d = await diffTreePath(ws, st.workspace!.baseline.tree, target.tree, path);
      return { path, text: d.text, truncated: d.truncated };
    }),

    // The checks the start would make, and more, without starting anything (no model call, no run, no file written).
    // The runtime (CLI versions, the login shell's environment) is measured at most every 30 s per project.
    readiness: (input: { linkId: string; commands: string[]; workMode: "project" | "copy" | "worktree" }) => result(async () => {
      const c = await canvas.read(exists);
      const link = c.links.find((l) => l.linkId === input.linkId) ?? refuse("link_not_found", "no such link");
      const lead = c.agents.find((a) => a.agentId === link.fromAgentId) ?? refuse("link_not_found", "the link has no lead");
      const holder = await folderHolder(c, lead.project, link.linkId, busy, known);
      // Nothing is measured where a run could not finish: no CLI and no login shell for a start that is refused anyway.
      if (!orchestrationAvailable(platform)) return { ready: false, items: [platformItem(platform)] };
      const profile = (await profiles.get(lead.project)) ?? await suggestProfile(lead.project);
      const key = `${input.workMode === "worktree" ? "worktree" : "folder"}:${lead.project}`;
      const cached = runtimes.get(key);
      const measured = cached && Date.now() - cached.at < 30_000 ? cached.value
        : await (deps.native ? deps.native(lead.project, { direnv: profile.env.direnv, worktreePending: input.workMode === "worktree" }) : Promise.reject(new Refusal("provider_unavailable", "no native agent runtime"))).then(
          (rt) => ({ ok: true as const, versions: rt.versions, env: rt.env, shell: rt.shell, direnv: rt.direnv }),
          (e) => ({ ok: false as const, code: typeof e?.code === "string" ? e.code : "provider_unavailable", detail: String(e?.message ?? e) }));
      runtimes.set(key, { at: Date.now(), value: measured });
      let gitPath: string | null = null;
      try { gitPath = deps.gitPath(); } catch { gitPath = null; }
      const r = await assessReadiness({
        project: lead.project, commands: input.commands, workMode: input.workMode, platform, gitPath, optionalChecks: deps.journalV2 === true,
        prepare: profile.prepare,
        runtime: measured, checkedVersions: NATIVE_PROTOCOL_CHECKED, busy: holder !== null
      });
      // the same run a start would be refused for (folder_busy), so the renderer can name it and go to its workspace
      return holder ? { ...r, items: r.items.map((i) => (i.id === "busy" ? { ...i, facts: { ...i.facts, ...holder } } : i)) } : r;
    }),

    // Stage 13: the project's profile for the settings dialog — saved or suggested from the repository — and facts of the
    // repository. With `capabilities` (the settings dialog only) also what the installed CLIs offer: their own --help and
    // protocol version, measured by starting them (no model); without it only the terminal mode is listed.
    profile: (linkId: string, capabilities = false) => result(async (): Promise<OrchestrationProfileInfo> => {
      const project = await leadProject(linkId);
      const saved = await profiles.get(project);
      const profile = saved ?? await suggestProfile(project);
      const rt = capabilities && orchestrationAvailable(platform) ? await nativeOf(project) : null;
      const help = rt?.claudeHelp ? await rt.claudeHelp().catch(() => "") : "";
      const codexChecked = !!rt && NATIVE_PROTOCOL_CHECKED.codex.includes(parseCliVersion("codex", rt.versions.codex) ?? "");
      let gitPath: string | null = null;
      try { gitPath = deps.gitPath(); } catch { gitPath = null; }
      const s = await suggestCommands(project);
      return {
        profile, saved: saved !== null, ...(deps.journalV2 ? { optionalChecks: true } : {}),
        capabilities: {
          claude: claudeModesFromHelp(help).map((mode) => ({ mode, mapping: accessMapping("claude", mode) })),
          codex: codexModesFor(codexChecked).map((mode) => ({ mode, mapping: accessMapping("codex", mode) }))
        },
        facts: {
          stack: s.stack, laravel: s.laravel,
          remotes: gitPath ? await gitRemotes(gitPath, project) : [], branch: gitPath ? await currentBranch(gitPath, project) : null,
          needed: (await neededSteps(project, profile.prepare.steps)).map((n) => n.step.command)
        }
      };
    }),
    // Saved as the person set it. Grants can only be kept or removed here (a new one comes from a permission answer),
    // and the push target's URL is the remote's own, read here.
    saveProfile: (linkId: string, input: unknown) => result(async (): Promise<OrchestrationProjectProfile> => {
      notOpen();
      const project = await leadProject(linkId);
      const p = validateProfile(input);
      const before = (await profiles.get(project))?.grants ?? [];
      const keep = new Set(p.grants.map((g) => g.id));
      let push = p.finish.push;
      if (push) {
        const remote = (await gitRemotes(deps.gitPath(), project)).find((r) => r.name === push!.remote) ?? refuse("invalid_profile", `no remote ${push.remote} in the project`);
        push = { ...push, remoteUrl: remote.url };
      }
      runtimes.delete(`folder:${project}`);
      runtimes.delete(`worktree:${project}`);
      return profiles.save(project, { ...p, grants: before.filter((g) => keep.has(g.id)), finish: { ...p.finish, push } });
    }),
    // What the CLIs report they loaded for this project, asked without a model turn. Only on the person's request.
    probe: (linkId: string, options: { mcpReady?: string } = {}) => result(async (): Promise<OrchestrationEnvironmentReport> => {
      notOpen();
      platformOk();
      const project = await leadProject(linkId);
      if (!deps.native) refuse("provider_unavailable", "no native agent runtime");
      const rt = await deps.native!(project, await direnvOf(project));
      if (!rt.executables) refuse("provider_unavailable", "this runtime cannot be probed");
      const input = (p: "codex" | "claude") => ({ executable: rt.executables![p], cwd: project, env: rt.env });
      const [claude, codex] = await Promise.all([probeClaude(input("claude")),
        probeCodex(input("codex"), options.mcpReady)]);
      return {
        checkedAt: new Date().toISOString(),
        providers: [{ provider: "claude", ...claude }, { provider: "codex", ...codex }],
        shell: { shell: rt.shell, direnv: rt.direnv ?? "off", pathEntries: (rt.env.PATH ?? "").split(":").filter(Boolean).length }
      };
    }),

    // Events for the run from now on, and the state they start from. Returns the unsubscribe.
    async watch(runId: string, listener: (e: OrchestrationRunEvent) => void): Promise<{ snapshot: R<OrchestrationRunSnapshot>; unwatch(): void }> {
      const read = await result(() => snapshot(runIdOk(runId)));
      if (!read.ok) return { snapshot: read, unwatch() {} };
      let set = watchers.get(runId);
      if (!set) watchers.set(runId, (set = new Set()));
      set.add(listener);
      // Taken in the same synchronous step as the add: every later event is newer than this snapshot, none is lost.
      const h = handles.get(runId);
      const snap: R<OrchestrationRunSnapshot> = h ? { ok: true, value: { ...read.value, seq: h.seq(), tick: h.tick(), view: h.view(), open: true } } : read;
      const own = set;
      return { snapshot: snap, unwatch: () => { own.delete(listener); if (!own.size && watchers.get(runId) === own) watchers.delete(runId); } };
    },

    watcherCount: () => [...watchers.values()].reduce((n, s) => n + s.size, 0), // tests and diagnostics
    activityWatcherCount: () => [...activityWatchers.values()].reduce((n, s) => n + s.size, 0),
    openCount: () => handles.size,

    // Application exit: each run's operation is stopped through its own stop(), a running run is left paused and its
    // writer closed. Terminal sessions and anything else of the application are not touched here.
    async shutdown(): Promise<void> {
      closing = true;
      await Promise.allSettled([...[...creating.values()].map((c) => c.p), ...opening.values(), ...stopping.values()]);
      await Promise.allSettled([...handles.values()].map((h) => h.shutdown()));
      handles.clear();
      runRuntimes.clear();
      watchers.clear();
    }
  };
}

export type RunManager = ReturnType<typeof createRunManager>;

function findRef(records: readonly JournalRecord[], sha256: string): TextRef | null {
  const walk = (v: unknown): TextRef | null => {
    if (isTextRef(v)) return v.sha256 === sha256 ? v : null;
    if (Array.isArray(v)) { for (const x of v) { const f = walk(x); if (f) return f; } return null; }
    if (v && typeof v === "object") { for (const x of Object.values(v)) { const f = walk(x); if (f) return f; } }
    return null;
  };
  for (const r of records) { const f = walk(r.data); if (f) return f; }
  return null;
}

// ---------- the application's provider adapters ----------

// First line of `<cli> --version`, measured when a run is created or opened (the provider refuses other versions).
async function cliVersion(cli: AvailableProviderCli): Promise<string> {
  const { stdout } = await run(cli.executable, ["--version"], { timeout: 20_000, env: { PATH: cli.environment.PATH ?? "", HOME: process.env.HOME ?? "" } });
  return stdout.trim().split("\n")[0] ?? "";
}

const cliEnv = (provider: "codex" | "claude", home: string): Record<string, string> => ({
  HOME: home, USER: process.env.USER ?? "", LOGNAME: process.env.USER ?? "", LANG: process.env.LANG ?? "C.UTF-8",
  ...(provider === "codex" ? { CODEX_HOME: process.env.CODEX_HOME ?? join(home, ".codex") } : {})
});

// The combination the application runs (stage-7-contract.md §1.2): the versions, models and budget of the accepted
// real runs of stage 6 (Codex lead 0.155.1, gpt-6-astra, effort high; Claude executor 2.1.281, claude-sonnet-5,
// $1 per turn). Exact versions only; Claude 2.1.282 is admitted for native sessions only (its probe did not run this path);
// other versions providers.ts knows as candidates (Claude 2.1.280) are refused here.
export const APP_PROVIDERS = Object.freeze({
  codex: Object.freeze({ versions: Object.freeze(["0.155.1"]), model: "gpt-6-astra", reasoningEffort: "high" }),
  claude: Object.freeze({ versions: Object.freeze(["2.1.281"]), model: "claude-sonnet-5", maxBudgetUsd: 1 })
});

// Codex lead (structured-readonly) and Claude executor (structured-edit, a candidate mode: stage-6-contract.md).
export function providerAgents(input: {
  clis: ProviderCliRegistry | { get(p: "codex" | "claude"): AvailableProviderCli | { state: "unavailable" } };
  launch: () => SupervisorLaunch;
  home: string;
  env?: Partial<Record<"codex" | "claude", Record<string, string>>>; // test providers only
  versions?: Partial<Record<"codex" | "claude", string>>; // test providers only: skip the --version call
}) {
  return async (attemptRoot: string): Promise<AgentAdapter> => {
    const cli = (p: "codex" | "claude"): AvailableProviderCli => {
      const r = input.clis.get(p);
      return r.state === "available" ? r as AvailableProviderCli : refuse("provider_unavailable", `${p} CLI not found`);
    };
    const codex = cli("codex"), claude = cli("claude");
    const [cv, lv] = await Promise.all([
      input.versions?.codex ?? cliVersion(codex), input.versions?.claude ?? cliVersion(claude)
    ].map((v) => Promise.resolve(v).catch(() => refuse("provider_unavailable", "a provider CLI did not report its version"))));
    for (const [p, line] of [["codex", cv], ["claude", lv]] as const) {
      if (!(APP_PROVIDERS[p].versions as readonly string[]).includes(parseCliVersion(p, line) ?? "")) {
        refuse("unsupported_version", `${p} ${line.slice(0, 80)} is not a version the application runs (${APP_PROVIDERS[p].versions.join(", ")})`);
      }
    }
    return createProviderAgents({
      lead: {
        cli: codex, cliVersion: cv, env: { ...cliEnv("codex", input.home), ...input.env?.codex },
        model: APP_PROVIDERS.codex.model, modelParams: { reasoningEffort: APP_PROVIDERS.codex.reasoningEffort }
      },
      executor: {
        cli: claude, cliVersion: lv, env: { ...cliEnv("claude", input.home), ...input.env?.claude },
        model: APP_PROVIDERS.claude.model, maxBudgetUsd: APP_PROVIDERS.claude.maxBudgetUsd, allowCandidate: true
      },
      launch: input.launch(), attemptRoot
    });
  };
}

// A program on the application's PATH plus the usual install locations (a packaged app starts with a short PATH).
export function findProgram(name: string, envPath = process.env.PATH ?? ""): string | null {
  for (const dir of [...envPath.split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
    if (!dir.startsWith("/")) continue;
    try {
      const real = realpathSync(join(dir, name));
      accessSync(real, fsConstants.X_OK);
      if (statSync(real).isFile()) return real;
    } catch { /* not here */ }
  }
  return null;
}

// Development E2E only (index.ts reads the directory through developmentEnv; a packaged build never gets here): a
// command whose kind is named by a file in `dir` is carried out as usual, then its answer is dropped once (the file is
// removed) and the renderer sees a failed IPC call, as if the reply were lost after main accepted the command.
export function dropCommandReplies(manager: RunManager, dir: string): RunManager {
  return {
    ...manager,
    command: async (...args: Parameters<RunManager["command"]>) => {
      const answer = await manager.command(...args);
      try { await unlink(join(dir, args[1].command.kind)); } catch { return answer; }
      throw new Error("E2E: the reply to this command was dropped");
    }
  };
}

// Development and smoke runs only (index.ts reads the path through developmentEnv; a packaged build never gets here):
// fake CLIs described by a JSON file {codex|claude: {executable, version, path, env}}.
export function testProviderAgents(file: string, launch: () => SupervisorLaunch) {
  const cfg = JSON.parse(readFileSync(file, "utf8")) as Record<"codex" | "claude", { executable: string; version: string; path: string; env: Record<string, string> }>;
  const cli = (p: "codex" | "claude"): AvailableProviderCli => ({
    state: "available", provider: p, executable: cfg[p].executable, launcher: "native", environment: { PATH: cfg[p].path }, checked: []
  });
  return providerAgents({
    clis: { get: cli }, launch, home: cfg.codex.env.HOME ?? "/nonexistent",
    env: { codex: cfg.codex.env, claude: cfg.claude.env }, versions: { codex: cfg.codex.version, claude: cfg.claude.version }
  });
}

// ---------- stage 12: the CLIs as the user runs them ----------

// The user's CLIs (whatever version is installed), their login-shell environment in the project folder and their
// login shell for the check commands. Measured when a run is created or opened, never on construction.
export function nativeRuntime(input: {
  clis: ProviderCliRegistry | { get(p: "codex" | "claude"): AvailableProviderCli | { state: "unavailable" } };
  launch: () => SupervisorLaunch;
  baseEnv: () => Record<string, string>; // what a CanvasTTY terminal starts with (terminalEnvironment)
  clientVersion: string;
}) {
  return async (project: string, opts?: NativeOpts): Promise<NativeRuntime> => {
    const cli = (p: "codex" | "claude"): AvailableProviderCli => {
      const r = input.clis.get(p);
      return r.state === "available" ? r as AvailableProviderCli : refuse("provider_unavailable", `${p} CLI not found`);
    };
    const codex = cli("codex"), claude = cli("claude");
    const [cv, lv] = await Promise.all([cliVersion(codex), cliVersion(claude)]
      .map((v) => v.catch(() => refuse("provider_unavailable", "a provider CLI did not report its version"))));
    for (const [p, line] of [["codex", cv], ["claude", lv]] as const) {
      if (!parseCliVersion(p, line)) refuse("provider_unavailable", `cannot read the ${p} version from "${line.slice(0, 80)}"`);
    }
    const le = await captureLoginEnv({ cwd: project, base: input.baseEnv() });
    if (!le.ok) refuse("environment_error", `the login shell ${le.shell} gave no environment (${le.reason}): ${le.detail}`);
    const de = await applyDirenv({ cwd: opts?.direnvCwd ?? project, env: (le as Extract<typeof le, { ok: true }>).env, enabled: opts?.direnv ?? false, pending: opts?.worktreePending });
    const env = de.env;
    const shell = await realpath(le.shell).catch(() => refuse("environment_error", `the login shell ${le.shell} does not exist`));
    return {
      executables: { codex: codex.executable, claude: claude.executable }, direnv: de.direnv,
      claudeHelp: () => run(claude.executable, ["--help"], { timeout: 20_000, env, cwd: project, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout),
      agents: createNativeAgents({
        clis: { codex: { cli: codex, cliVersion: cv }, claude: { cli: claude, cliVersion: lv } },
        roles: { lead: "codex", executor: "claude" }, env: { codex: env, claude: env }, launch: input.launch(), clientVersion: input.clientVersion
      }),
      shell, env, versions: { codex: cv, claude: lv }
    };
  };
}

// Development and smoke runs only: the fake CLIs of testProviderAgents speaking the stage 12 protocols, with the
// file's environments instead of a login shell (a test must not depend on the developer's rc files).
// shell: the default shell of checks and preparation when the file names none (a hermetic smoke: a shell without login).
export function testNativeRuntime(file: string, launch: () => SupervisorLaunch, shell?: string) {
  const cfg = JSON.parse(readFileSync(file, "utf8")) as Record<"codex" | "claude", { executable: string; version: string; path: string; env: Record<string, string> }>
    & { shell?: string; checkEnv?: Record<string, string> };
  const cli = (p: "codex" | "claude"): AvailableProviderCli => ({
    state: "available", provider: p, executable: cfg[p].executable, launcher: "native", environment: { PATH: cfg[p].path }, checked: []
  });
  const envOf = (p: "codex" | "claude") => ({ PATH: cfg[p].path, ...cfg[p].env });
  return async (): Promise<NativeRuntime> => ({
    agents: createNativeAgents({
      clis: { codex: { cli: cli("codex"), cliVersion: cfg.codex.version }, claude: { cli: cli("claude"), cliVersion: cfg.claude.version } },
      roles: { lead: "codex", executor: "claude" }, env: { codex: envOf("codex"), claude: envOf("claude") }, launch: launch(), clientVersion: "test"
    }),
    executables: { codex: cfg.codex.executable, claude: cfg.claude.executable }, direnv: "off",
    claudeHelp: () => run(cfg.claude.executable, ["--help"], { timeout: 20_000, env: envOf("claude") }).then((r) => r.stdout),
    shell: cfg.shell ?? shell ?? "/bin/sh",
    env: cfg.checkEnv ?? { PATH: cfg.codex.path, HOME: cfg.codex.env.HOME ?? "/nonexistent" },
    versions: { codex: cfg.codex.version, claude: cfg.claude.version }
  });
}
