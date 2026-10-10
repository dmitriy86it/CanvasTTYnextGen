// Owner of the application's runs (stage-7-contract.md): one OrchestrationService handle per run, held by this
// process only, so a run has one owner and one writer. Nothing is opened or started on construction: a run is opened
// on an explicit command, created on an explicit create, and after a restart it stays as the journal left it.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  OrchestrationActivityEvent,
  OrchestrationCatalog,
  OrchestrationCanvas,
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
import { assessReadiness, modelItem, platformItem, suggestCommands, testDbItem } from "./readiness.ts";
import { PREFLIGHT_TIMEOUT_MS, authItems, sandboxItems, sourceChecks } from "./preflight.ts";
import { accessMapping } from "./access.ts";
import { claudeInit, clisItem, codexSchema, createCapabilityCache, probeClaude as probeClaudeCaps, probeCodex as probeCodexCaps, startProblems, startWarnings } from "./capabilities.ts";
import type { Capabilities } from "./capabilities.ts";
import type { AgentAccess } from "./access.ts";
import { commitMessage } from "./finish.ts";
import { laravelTestDb, neededSteps, worktreeSteps } from "./prepare.ts";
import { codexModels, probeClaude, probeCodex } from "./probe.ts";
import { createProfileStore, currentBranch, gitRemotes, suggestProfile, validateProfile } from "./profile.ts";
import { parseCliVersion } from "./providers.ts";
import type { AgentAdapter } from "./agents.ts";
import { checkPreparedDeps, createRegistry } from "./checks.ts";
import type { CheckRegistry, PreparedDeps } from "./checks.ts";
import { DEFAULT_LIMITS } from "./cycle.ts";
import type { Goal } from "./cycle.ts";
import { MAX_JOURNAL_BYTES, MAX_LINE_BYTES, MAX_TEXT_BYTES, TERMINAL_STATUSES, canonical, isSha256, isTextRef, isUuid, needsRecovery, newerGoal, newerVersion, parseJournal, unfinishedWork } from "./journal.ts";
import type { JournalRecord, RunState, TextRef } from "./journal.ts";
import { conditionsView, createOrchestrationService, decidedGoal, findingsView, loadConditions, possiblyStale, progressOf, runView, shownCheckKeys } from "./orchestrationService.ts";
import type { CommandOutcome, GoalInput, RunCommand, RunHandle } from "./orchestrationService.ts";
import { readRun, readText } from "./store.ts";
import type { RunReadResult } from "./store.ts";
import type { SupervisorLaunch } from "./types.ts";
import { BOARD_REF, applyToProject, branchCommit, branchNameOk, diffTreeNames, diffTreePath, openWorkspace, readTaken, readWorkspacePlace, snapshotCopyTree, takeToBranch, writeTaken } from "./workspace.ts";
import type { CloneDir } from "./workspace.ts";
import { canvasFile, createCanvasStore, folderHolder } from "./canvasStore.ts";
import type { RunMode } from "./canvasStore.ts";
import { createBoardMerge } from "./boardMerge.ts";
import { createBoardStore } from "./boardStore.ts";
import type { TaskInput } from "./boardStore.ts";
import { boardStatuses, runPhase, type BoardHead } from "../../../shared/taskBoard.ts";
import { AUTOPILOT_BUDGET, baseOf, type AutopilotBudget, type BoardPlace, type BoardTask, type BoardView, type RunTaskFacts } from "../../../shared/taskBoard.ts";
import type { OrchestrationTurnPurpose, OrchestrationWorkMode } from "../../../shared/orchestration.ts";
import { runOwners, workspaceOf } from "../../../shared/workspaceOwnership.ts";
import { createBoardAutopilot } from "./boardAutopilot.ts";
import { COMMON_WORKSPACE_ID } from "../../../shared/contracts.ts";
import { orchestrationAvailable } from "../../../shared/orchestration.ts";
import type {
  OrchestrationAgentLink,
  OrchestrationBounds,
  OrchestrationEnvironmentReport,
  OrchestrationFolderHolder,
  OrchestrationGoalInput,
  OrchestrationCodexModels,
  OrchestrationRoleModels,
  OrchestrationProfileInfo,
  OrchestrationProjectProfile,
  OrchestrationProviderKind,
  OrchestrationReadinessItem,
  OrchestrationTake,
  OrchestrationTakeInput,
  OrchestrationTakeOutcome
} from "../../../shared/orchestration.ts";

const run = promisify(execFile);

// A branch name's part from the goal: Latin letters and digits, Cyrillic transliterated, the rest a dash; up to 32.
const CYR: Record<string, string> = Object.fromEntries("а:a б:b в:v г:g д:d е:e ё:e ж:zh з:z и:i й:i к:k л:l м:m н:n о:o п:p р:r с:s т:t у:u ф:f х:h ц:c ч:ch ш:sh щ:sch ъ: ы:y ь: э:e ю:yu я:ya".split(" ").map((p) => p.split(":")));
export function branchSlug(text: string): string {
  const latin = [...text.toLowerCase()].map((c) => CYR[c] ?? c).join("");
  const slug = latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return slug || "result";
}
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
  // the Claude capability probe's waits: the first, and the one retry in the background (default 30 s and 90 s)
  claudeProbeMs?: { first: number; retry: number };
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
  codexEnv?: Record<string, string>; // Codex's environment where it is not `env` (the fake CLIs of a test runtime)
  claudeEnv?: Record<string, string>; // the same for Claude
}

type R<T> = OrchestrationResult<T>;
// model/list and config/read of Codex (codexModels): an app-server start and two lists, no thread
const MODELS_MS = 20_000;
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
  // B1: the tasks a create is under way for, from its first line: a removal asked meanwhile is refused (§3.3)
  const startingTasks = new Map<string, number>();
  const startingRuns = new Map<string, Set<string>>(); // taskId → the requests being created for it (B4: one run of a task)
  const watchers = new Map<string, Set<(e: OrchestrationRunEvent) => void>>();
  let closing = false;
  const known = (id: string) => deps.workspaceKnown?.(id) ?? true;
  const canvas = createCanvasStore(canvasFile(deps.root), known); // reads nothing until asked
  // B1: the task board (stage-b-board.md §3); a task's number is above every T-<n> its workspace's runs name
  const board = createBoardStore(join(deps.root, "board.json"), async (workspaceId) => {
    const facts = await taskFacts();
    return Math.max(0, ...facts.filter((f) => f.taskKey && f.workspaceId === workspaceId).map((f) => Number(f.taskKey!.slice(2))));
  });
  const activityLog = createActivityLog(deps.root); // reads nothing until asked
  const profiles = createProfileStore(deps.root); // reads nothing until asked
  const direnvOf = async (project: string) => ({ direnv: (await profiles.get(project))?.env.direnv ?? true });
  const runtimes = new Map<string, { at: number; value: Parameters<typeof assessReadiness>[0]["runtime"] & { claudeHelp?: () => Promise<string> } }>();
  // What the installed CLIs can do, probed once per program, version and modification time (capabilities.ts): the
  // same answer for the readiness and the start, never a list of versions.
  const capabilityCache = createCapabilityCache(join(deps.root, "cli-capabilities.json"));
  const capabilitiesOf = async (rt: { executables?: Record<"codex" | "claude", string>; versions: Record<"codex" | "claude", string>; env: Readonly<Record<string, string>>; codexEnv?: Readonly<Record<string, string>>; claudeEnv?: Readonly<Record<string, string>>; claudeHelp?: () => Promise<string> }): Promise<Capabilities | null> => {
    if (!rt.executables) return null; // a runtime without the programs (stages 4–11): nothing to probe
    const ex = rt.executables;
    const claudeProbe = (ms: number) => async () =>
      probeClaudeCaps({ version: rt.versions.claude, help: rt.claudeHelp ? await rt.claudeHelp().catch(() => "") : "", init: claudeInit(ex.claude, rt.claudeEnv ?? rt.env, ms) });
    const [codex, claude] = await Promise.all([
      capabilityCache.get({ provider: "codex", executable: ex.codex, version: rt.versions.codex },
        () => probeCodexCaps({ version: rt.versions.codex, schema: codexSchema(ex.codex, rt.codexEnv ?? rt.env) })),
      // a probe with no answer in time is tried once more in the background, slower (CliCapability.unconfirmed)
      capabilityCache.get({ provider: "claude", executable: ex.claude, version: rt.versions.claude },
        claudeProbe(deps.claudeProbeMs?.first ?? 30_000), claudeProbe(deps.claudeProbeMs?.retry ?? 90_000))
    ]);
    return { codex, claude };
  };
  // The rights a goal runs with: the project's, with this goal's one-run choice of «Как в моём терминале» over them
  // (the project settings stay as they are).
  const accessFor = (profileAccess: AgentAccess, over?: Partial<Record<"claude" | "codex", "terminal">>): AgentAccess => ({ ...profileAccess, ...(over ?? {}) });
  // «Проверить сейчас»: the sign-in (per CLI program, a minute) and the sandbox self-test (ten minutes) are asked again
  // only when older; the dialog asks the readiness on every change of its commands
  const preflightKept = new Map<string, { at: number; items: Promise<OrchestrationReadinessItem[]> }>();
  const kept = (key: string, ms: number, make: () => Promise<OrchestrationReadinessItem[]>): Promise<OrchestrationReadinessItem[]> => {
    const k = preflightKept.get(key);
    if (k && Date.now() - k.at < ms) return k.items;
    const items = make();
    preflightKept.set(key, { at: Date.now(), items });
    return items;
  };
  // What Codex offers (model/list, config/read; no model turn), per Codex program and folder, for the application's
  // session: asked again only by «Обновить» (refresh). A failed answer is not kept.
  const codexModelLists = new Map<string, Promise<OrchestrationCodexModels>>();
  const codexModelsAt = (executable: string, cwd: string, env: Readonly<Record<string, string>>, refresh = false): Promise<OrchestrationCodexModels> => {
    const key = `${executable}\0${cwd}`;
    const kept = codexModelLists.get(key);
    if (kept && !refresh) return kept;
    const p = codexModels({ executable, cwd, env: { ...env }, timeoutMs: MODELS_MS });
    codexModelLists.set(key, p);
    void p.then((r) => { if (!r.ok && codexModelLists.get(key) === p) codexModelLists.delete(key); });
    return p;
  };
  // The roles' models of a goal: the project's setting, then the goal's own choice over it.
  const roleModels = (profile: { models?: OrchestrationRoleModels } | null, over?: Partial<OrchestrationRoleModels>): OrchestrationRoleModels =>
    ({ lead: null, executor: null, reviewer: null, ...(profile?.models ?? {}), ...(over ?? {}) });
  // Codex plays the lead and (journal v2) the reviewer, a new session of the lead's CLI.
  const codexRoles = (): ("lead" | "reviewer")[] => (deps.journalV2 ? ["lead", "reviewer"] : ["lead"]);
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
  // C1 (§3.1): where a run works — its workspace marker, else its goal (a run being created has no marker yet)
  const runMode: RunMode = async (runId) => (await readWorkspacePlace(deps.root, runId).catch(() => null))?.mode ?? (await metaOf(runId)).goalWorkMode;
  // C1: the board's merged head and its merge runs (stage-c-parallel.md §4)
  const merges = createBoardMerge({
    root: deps.root, gitPath: () => deps.gitPath(), launch: () => deps.launch(),
    own: async (runId, workspaceId) => { await canvas.own(runId, workspaceId); },
    checks: async (project) => ((await profiles.get(project)) ?? await suggestProfile(project)).checks,
    shell: async (project) => {
      if (!deps.native) refuse("provider_unavailable", "no native runtime for the checks");
      const rt = await deps.native!(project, await direnvOf(project));
      return { shell: rt.shell, env: rt.env };
    },
    // ponytail: no run held here is in a turn — of any project
    quiet: async () => ![...handles.values()].some((h) => h.view().active?.kind === "turn")
  });

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
    // A3: and the findings
    const texts = goal && st.version === 2 ? await loadConditions(st, readJson).catch(() => null) : undefined;
    const conditions = texts === undefined ? undefined : texts && goal
      ? conditionsView(st, goal, texts, await shownCheckKeys(st, readJson).catch(() => null), st.status === "completed" ? null : possiblyStale(st, texts)) : null;
    const findings = texts === undefined ? undefined : findingsView(st, texts);
    const view = runView(st, false, null, {
      ...(place ? { workMode: place.mode, workDir: place.repo } : {}),
      ...(goal ? { progress: { ...progressOf(st, goal, place?.branch ?? null), ...(conditions !== undefined ? { conditions, findings } : {}) } } : {})
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
  async function newerSnapshot(runId: string, detail: { version: number; chain: { status: "ok" | "torn_tail" | "corrupt" }; fallback?: { line: number; code: string }; preview?: true }): Promise<OrchestrationRunSnapshot> {
    const records = await journal(runId);
    const goal = await newerGoalText(runId, records);
    const place = await readWorkspacePlace(deps.root, runId).catch(() => null);
    return {
      seq: records.at(-1)?.seq ?? 0, tick: 0, integrity: "newer_version", open: false,
      view: {
        runId, status: "paused", reason: "newer_version", revision: 0, stage: null, turns: 0, halted: false, active: null,
        ...(place ? { workMode: place.mode, workDir: place.repo } : {}),
        newer: { version: detail.version, chain: detail.chain.status, goal, ...(detail.fallback ? { fallback: detail.fallback } : {}), ...(detail.preview ? { preview: true } : {}) }
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
        ...(g.mode ? { mode: g.mode } : {}), ...(g.finish ? { finish: g.finish } : {}), ...(g.models ? { models: g.models } : {}),
        ...(g.task ? { task: g.task } : {}), // only when there: the keys of runs created before B1 stay as they were
        ...(g.base ? { base: g.base } : {})
      }
    })).digest("hex");
    return { key, source };
  }
  const conflict = () => refuse("request_conflict", "this requestId belongs to another create request");

  // The explicit command that starts a run: created, then driven automatically. requestId is the runId.
  // inQueue: the canvas of a start on a link, inside the canvas queue (canvas.read would wait for that very queue)
  async function createRun(req: OrchestrationCreateRequest, inQueue?: OrchestrationCanvas): Promise<{ runId: string; created: boolean }> {
    const taskId = typeof req?.goal?.task?.id === "string" ? req.goal.task.id : null;
    if (!taskId) return createRunFor(req);
    startingTasks.set(taskId, (startingTasks.get(taskId) ?? 0) + 1);
    const mine = startingRuns.get(taskId) ?? new Set<string>();
    startingRuns.set(taskId, mine);
    const added = !mine.has(req.requestId);
    mine.add(req.requestId);
    try { return await createRunFor(req, inQueue); } finally {
      if (added) { mine.delete(req.requestId); if (!mine.size) startingRuns.delete(taskId); }
      const left = startingTasks.get(taskId)! - 1;
      if (left) startingTasks.set(taskId, left); else startingTasks.delete(taskId);
    }
  }
  async function createRunFor(req: OrchestrationCreateRequest, inQueue?: OrchestrationCanvas): Promise<{ runId: string; created: boolean }> {
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
      await taskOk(source, runId, req.goal, req.anyway === true, inQueue, req.withoutBase === true); // a repeat of a created run is answered above, whatever became of the task
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
    const { mode, finish, models: over, accessOverride: _override, ...given } = g;
    const chosen = roleModels(await profiles.get(source), over);
    const models = Object.fromEntries(Object.entries(chosen).filter(([, m]) => m !== null)) as Partial<Record<keyof OrchestrationRoleModels, string>>;
    // a role's model is recorded only in a journal v2 goal: never dropped on the quiet in a v1 one
    if (Object.keys(models).length && !deps.journalV2) refuse("invalid_goal", "a role's model needs journal v2");
    // Before the first model call: a Codex role's model (chosen, or the configuration's) that this account is not offered
    if (rt?.executables) {
      const item = modelItem(await codexModelsAt(rt.executables.codex, source, rt.codexEnv ?? rt.env), chosen, codexRoles());
      if (item.level === "blocker") refuse("model_unavailable", `Codex: model ${String(item.facts?.model)} is not available to your account. Choose another model in the project settings`);
    }
    const rest: Omit<GoalInput, "mode" | "finish"> = { ...given, ...(Object.keys(models).length ? { models } : {}) };
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
    // The rights the installed CLIs offer now, by the same rule as the readiness (startProblems): a mode the CLI does not
    // offer is refused, never passed on a guess and never narrowed on the quiet.
    const access = accessFor(profile.access as AgentAccess, g.accessOverride);
    const caps = rt ? await capabilitiesOf(rt) : null;
    const problem = caps ? startProblems(caps, access, chosen, codexRoles())[0] : undefined;
    if (problem) refuse(problem.id.startsWith("access_") ? "access_unsupported" : "model_unsupported", problem.detail);
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

  // «Забрать результат»: what would be taken (the last checkpoint, or the working copy as it is now) and what was.
  // One at a time per run: a second click waits for the first and then finds it done.
  const taking = new Map<string, Promise<unknown>>();
  async function takeState(runId: string) {
    const view = (await snapshot(runId)).view;
    const read = await readRun(deps.root, runId).catch(() => refuse("run_not_found", `run ${runId} not found`));
    const st = continuable(read);
    if (!st.workspace) refuse("run_not_found", "the run has no working copy");
    const ws = await openWorkspace({ root: deps.root, runId, gitPath: deps.gitPath() });
    if (ws.mode === "project") refuse("take_unavailable", "the changes are in the project folder already");
    const cps = Object.keys(st.workspace!.checkpoints).map(Number).sort((a, b) => a - b);
    const stage = cps.at(-1) ?? null;
    const tree = stage !== null ? st.workspace!.checkpoints[String(stage)].tree : await snapshotCopyTree(ws, st.workspace!.baseline.tree);
    const files = (await diffTreeNames(ws, st.workspace!.baseline.tree, tree)).files.length;
    const taken = await readTaken(ws);
    const goalJson = await readText(deps.root, runId, st.goal).then((b) => JSON.parse(b.toString("utf8")) as { text?: unknown; base?: unknown }, () => ({} as { text?: unknown; base?: unknown }));
    const goalText = String(goalJson.text ?? "");
    const fromBranch = !!goalJson.base; // B4: a copy started from a dependency's branch
    const runBranch = ws.mode === "worktree" ? taken?.branch?.name ?? ws.branch : null;
    const base = `raoden/${branchSlug(goalText)}-${runId.slice(0, 8)}`;
    let suggested = base;
    for (let n = 2; n < 50 && await branchCommit(ws, suggested) !== null && suggested !== runBranch; n++) suggested = `${base}-${n}`;
    const info: OrchestrationTake = {
      mode: ws.mode as "copy" | "worktree", from: stage !== null ? "checkpoint" : "current", stage, files,
      // a completed run without changes is taken too (review of B4): its branch is the next task's base, else the chain stops
      allowed: ["completed", "stopped", "paused"].includes(view.status) && !view.newer && (files > 0 || view.status === "completed"),
      suggested: taken?.branch && ws.mode === "worktree" ? taken.branch.name : suggested, runBranch,
      branch: taken?.branch && taken.branch.tree === tree ? { name: taken.branch.name, at: taken.branch.at } : null,
      applied: taken?.applied && taken.applied.tree === tree ? { at: taken.applied.at } : null
    };
    return { ws, st, tree, taken, info, fromBranch, message: commitMessage(goalText || "Raoden Loom run", runId) };
  }
  async function takeResult(runId: string, input: OrchestrationTakeInput): Promise<OrchestrationTakeOutcome> {
    const { ws, st, tree, taken, info, fromBranch, message } = await takeState(runId);
    const done = async (result: OrchestrationTakeOutcome["result"], extra: Partial<OrchestrationTakeOutcome> = {}) => ({ result, ...extra, take: (await takeState(runId)).info });
    if (!info.allowed) return { result: "unavailable", take: info };
    const at = new Date().toISOString();
    if (input?.action === "branch") {
      if (info.branch && (ws.mode === "copy" || info.branch.name === input.name)) return { result: "already", take: info };
      if (typeof input.name !== "string" || !(await branchNameOk(ws, input.name))) return { result: "invalid_name", take: info };
      const from = ws.mode === "worktree" ? info.runBranch! : undefined;
      if (input.name !== from && await branchCommit(ws, input.name) !== null) return { result: "branch_exists", take: info };
      const made = await takeToBranch(ws, { name: input.name, tree, message, ...(from ? { from } : {}) });
      await writeTaken(ws, { v: 1, ...taken, branch: { name: input.name, commit: made.commit, tree, at } });
      return done(made.renamed ? "renamed" : "created");
    }
    if (input?.action === "apply") {
      if (info.applied) return { result: "already", take: info };
      // its changes are on top of the branch it started from: applied alone they would leave out the tasks before it
      // (review of B4); the branch holds the whole chain. ponytail: applying a chain to the folder is stage C
      if (fromBranch) return { result: "unavailable", detail: "started from a dependency's branch: take it as a branch (it holds the chain)", take: info };
      const r = await applyToProject(ws, st.workspace!.baseline.tree, tree);
      if (!r.applied) return { result: "conflict", files: r.files, detail: r.detail, take: info };
      await writeTaken(ws, { v: 1, ...taken, applied: { tree, at } });
      return done("applied");
    }
    return refuse("invalid_argument", "action must be branch or apply");
  }

  // B1: what the board needs of each run (stage-b-board.md §2.3). The task and the time come from the goal of the
  // journal's first record (run.created), so a run of a newer version, an unreadable or a damaged one keeps its task.
  // The facts of a run not held here are kept while its journal and taken.json are the same (size, mtime); a held run
  // has state the journal does not (the active turn, a permission request), so it is read each time.
  const goalMeta = new Map<string, { taskId: string | null; taskKey: string | null; createdAt: number; goalWorkMode: OrchestrationWorkMode | null; board: string | null }>();
  const factsCache = new Map<string, { stamp: string; facts: RunTaskFacts }>();
  async function metaOf(runId: string) {
    const known = goalMeta.get(runId);
    if (known) return known;
    const fh = await open(join(deps.root, "runs", runId, "journal.jsonl"), "r").catch(() => null);
    let first: { type?: unknown; data?: { goal?: unknown } } | null = null;
    if (fh) {
      try {
        const buf = Buffer.alloc(MAX_LINE_BYTES + 1);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const line = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0];
        first = JSON.parse(line);
      } catch { first = null; } finally { await fh.close().catch(() => {}); }
    }
    const ref = first?.type === "run.created" && isTextRef(first.data?.goal) ? first.data.goal : null;
    const g = ref ? await readText(deps.root, runId, ref).then((b) => JSON.parse(b.toString("utf8")) as { task?: { id?: unknown; key?: unknown }; createdAt?: unknown; workMode?: unknown; base?: { branch?: unknown } }, () => null) : null;
    const meta = {
      taskId: typeof g?.task?.id === "string" && isUuid(g.task.id) ? g.task.id : null,
      taskKey: typeof g?.task?.key === "string" && /^T-\d{1,6}$/.test(g.task.key) ? g.task.key : null,
      createdAt: typeof g?.createdAt === "number" ? g.createdAt : 0,
      // the goal's work mode: the run's own when its work folder's marker cannot be read
      goalWorkMode: g?.workMode === "project" || g?.workMode === "copy" || g?.workMode === "worktree" ? g.workMode as OrchestrationWorkMode : null,
      // C1: the board's merged head its copy started from
      board: typeof g?.base?.branch === "string" && BOARD_REF.test(g.base.branch) ? g.base.branch : null
    };
    if (g) goalMeta.set(runId, meta); // a goal text not readable yet (a run being created) is asked again next time
    return meta;
  }
  async function runTaskFacts(runId: string, owner: (runId: string) => string): Promise<RunTaskFacts> {
    const dir = join(deps.root, "runs", runId);
    const stamp = await Promise.all([stat(join(dir, "journal.jsonl")), stat(join(dir, "workspace", "taken.json"))].map((p) => p.then((s) => `${s.size}:${s.mtimeMs}`, () => "-"))).then((a) => a.join("|"));
    const workspaceId = owner(runId);
    const cached = factsCache.get(runId);
    if (cached && cached.stamp === stamp && !handles.has(runId)) return { ...cached.facts, workspaceId };
    const { goalWorkMode, ...meta } = await metaOf(runId);
    const snap = await result(() => snapshot(runId));
    const unreadable: RunTaskFacts = { runId, ...meta, workspaceId, status: "unreadable", reason: null, newer: false, halted: false, limit: null,
      completion: null, phase: "work", permission: false, workMode: null, taken: null };
    let facts = unreadable;
    if (snap.ok && snap.value.integrity !== "corrupt") {
      const view = snap.value.view;
      const st = view.newer ? null : (await readRun(deps.root, runId).catch(() => null))?.state ?? null;
      if (st || view.newer) {
        const last = st ? Object.values(st.orch.turns).sort((a, b) => b.seq - a.seq)[0] : undefined;
        const workMode = view.workMode ?? goalWorkMode;
        let taken: RunTaskFacts["taken"] = null;
        if (workMode === "copy" || workMode === "worktree") {
          // ponytail: taken.json as written, not matched to the current tree (a finished run's tree does not move)
          const raw = await readFile(join(dir, "workspace", "taken.json"), "utf8").catch(() => null);
          try {
            const t = raw ? JSON.parse(raw) as { v?: number; branch?: { name?: unknown; commit?: unknown }; applied?: unknown } : null;
            taken = t?.v === 1 ? {
              branch: typeof t.branch?.name === "string" ? t.branch.name : null,
              commit: typeof t.branch?.commit === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(t.branch.commit) ? t.branch.commit : null, applied: !!t.applied
            } : null;
          } catch { taken = null; }
        }
        facts = {
          runId, ...meta, workspaceId, status: view.status, reason: view.reason, newer: !!view.newer, halted: !!view.halted,
          limit: view.progress?.budget?.reached ?? null, completion: view.progress?.completion ?? null,
          phase: runPhase(view, (last?.purpose as OrchestrationTurnPurpose | undefined) ?? null),
          permission: !!view.permission, workMode, taken
        };
      }
    }
    // a held run's facts include what only this process knows (the active turn, a permission): never kept. ponytail: a
    // text of a run not held that is damaged after its facts were kept shows as before until the journal changes
    if (!handles.has(runId)) factsCache.set(runId, { stamp, facts });
    return facts;
  }
  async function taskFacts(inQueue?: OrchestrationCanvas): Promise<RunTaskFacts[]> {
    const names = await readdir(join(deps.root, "runs")).catch(() => [] as string[]);
    const out: RunTaskFacts[] = [];
    const owner = runOwners(inQueue ?? await canvas.read(exists), known);
    for (const id of names.filter(isUuid).sort()) out.push(await runTaskFacts(id, owner));
    return out;
  }
  async function boardView(): Promise<BoardView> {
    const r = await board.read();
    const places = [...new Map(r.board.tasks.map((t) => [`${t.workspaceId}\0${t.project}`, { workspaceId: t.workspaceId, project: t.project }])).values()];
    const heads = await merges.heads(places).catch(() => [] as BoardHead[]);
    return { board: r.board, readOnly: r.readOnly, facts: (await taskFacts()).filter((f) => f.taskId || f.taskKey), autopilot: await autopilot.state(), ...(heads.length ? { heads } : {}) };
  }
  // C1 (§4.5): «Объединить» — a task «Done» in a separate copy into its place's head (started if it has none); its result
  // branch is made first, if it has none (the same as decision 8)
  async function mergeTask(taskId: string, language: "ru" | "en"): Promise<{ runId: string } | { already: true }> {
    notOpen();
    platformOk();
    const { board: b } = await board.read();
    const t = b.tasks.find((x) => x.id === taskId) ?? refuse("task_not_found", `no task ${taskId}`);
    const st = boardStatuses(b, await taskFacts()).get(t.id)!;
    if (!st.done || !st.current) refuse("merge_unavailable", `${t.key} is not «Done»`);
    let run = (await taskFacts()).find((f) => f.runId === st.current);
    if (run?.workMode !== "copy") refuse("merge_unavailable", "only a result of a separate copy is merged");
    if (!run!.taken?.commit) {
      const info = await takeState(run!.runId);
      const made = await takeResult(run!.runId, { action: "branch", name: info.info.suggested });
      if (!["created", "already"].includes(made.result)) refuse("take_failed", made.result);
      run = (await taskFacts()).find((f) => f.runId === st.current);
    }
    await merges.ensureHead(t.workspaceId, t.project);
    return merges.merge({ workspaceId: t.workspaceId, project: t.project, task: { id: t.id, key: t.key }, taskRunId: run!.runId, commit: run!.taken!.commit!, language });
  }
  // a place of the board: a project folder some task of the board names (realpath), never any path
  async function placeProject(project: string): Promise<string> {
    const real = await realpath(project).catch(() => refuse("invalid_argument", "no such project folder"));
    if (!(await board.read()).board.tasks.some((t) => t.project === real)) refuse("invalid_argument", "no task of the board in this folder");
    return real;
  }
  // «Объединить все» (§4.5): the tasks «Done» that started from the head and are not in it, one after another in the
  // background, the oldest first; a merge that does not complete (conflict, checks) ends the series
  async function mergeAll(workspaceId: string, project: string, language: "ru" | "en"): Promise<{ tasks: string[] }> {
    notOpen();
    const h = await merges.head(workspaceId, project) ?? refuse("no_head", "the board has no merged head");
    const { board: b } = await board.read();
    const facts = await taskFacts();
    const statuses = boardStatuses(b, facts);
    const into = await merges.mergesInto(h.ref);
    const todo = b.tasks.map((t) => ({ t, run: facts.find((f) => f.runId === statuses.get(t.id)?.current) }))
      .filter(({ t, run }) => t.workspaceId === workspaceId && t.project === project && statuses.get(t.id)?.done && run?.workMode === "copy" && run.board === h.ref
        && !into.some((m) => m.task.id === t.id && m.status === "completed"))
      .sort((a, z) => a.run!.createdAt - z.run!.createdAt).map(({ t }) => t);
    void (async () => {
      for (const t of todo) {
        const r = await result(() => mergeTask(t.id, language));
        if (!r.ok) return;
        if (!("runId" in r.value)) continue;
        const id = r.value.runId;
        for (;;) {
          await new Promise((res) => setTimeout(res, 1000));
          const m = (await merges.mergesInto(h.ref)).find((x) => x.runId === id);
          if (m?.status === "completed") break;
          if (!m || !["preparing", "running"].includes(m.status)) return;
        }
      }
    })();
    return { tasks: todo.map((t) => t.key) };
  }
  // «Accept the result» (owner's decision 2): only of the task's latest run, completed without checks by its journal
  async function acceptTask(taskId: string): Promise<BoardTask> {
    const { board: b } = await board.read();
    if (!b.tasks.some((t) => t.id === taskId)) refuse("task_not_found", `no task ${taskId}`);
    const facts = await taskFacts();
    const st = boardStatuses(b, facts).get(taskId)!;
    const run = facts.find((f) => f.runId === st.current);
    if (run?.status !== "completed" || run.completion !== "no_checks") refuse("accept_unavailable", "only a result completed without checks is accepted");
    return board.accept(taskId, run!.runId);
  }
  // A task being deleted or archived: marked before its change waits in the board's queue, so a start that reads the
  // board as last saved (peek) does not pass in between and leave a run of a task that is gone (review of B3)
  const leavingTasks = new Map<string, number>();
  async function leaving<T>(id: string, on: boolean, change: () => Promise<T>): Promise<T> {
    if (!on) return change();
    leavingTasks.set(id, (leavingTasks.get(id) ?? 0) + 1);
    try { return await change(); } finally {
      const left = leavingTasks.get(id)! - 1;
      if (left) leavingTasks.set(id, left); else leavingTasks.delete(id);
    }
  }
  // A goal naming a task: the task is on the board, of this project, not archived; and ready (every dependency «Done»,
  // its result where this run would see it), whatever the task's own column, unless the person confirmed «Start anyway»
  // (§4.2). The board as last saved (peek): a start on a link runs inside the canvas queue, and a change of the board
  // may wait for the canvas (a new number, a deletion) — waiting for the board's queue here would wait both ways.
  // ponytail: checked before the run is created, not under a lock with it; a dependency added in between is not seen
  // B4: also one run of a task at a time, of the workspace that owns the task (the link's lead's, or the common one for
  // a start not on a link), and a base (decision 11) only from the branch a dependency's result was taken into.
  async function taskOk(source: string, runId: string, goal: OrchestrationGoalInput, anyway: boolean, inQueue?: OrchestrationCanvas, withoutBase = false): Promise<void> {
    const task = goal.task;
    if (!task) { if (goal.base) refuse("invalid_base", "a base is given only for a task of the board"); return; }
    if (leavingTasks.has(task.id)) refuse("task_changing", "the task is being deleted or archived");
    // inside the canvas queue the board as last saved; elsewhere after the board's queue (a change in it is seen)
    const b = (inQueue ? await board.peek() : await board.read()).board;
    const t = b.tasks.find((x) => x.id === task.id);
    if (!t || t.key !== task.key) refuse("task_not_found", `no task ${task.key} on the board`);
    if (await realpath(t!.project).catch(() => t!.project) !== source) refuse("task_project", "the task belongs to another project folder");
    if (t!.archivedAt) refuse("task_archived", "the task is archived");
    const c = inQueue ?? await canvas.read(exists);
    if (runOwners(c, known)(runId) !== t!.workspaceId) refuse("task_workspace", `${t!.key} belongs to another workspace`);
    const facts = await taskFacts(c);
    // another run of the task: active by its journal, or being created now (two starts at once, review of B4)
    if ([...(startingRuns.get(t!.id) ?? [])].some((id) => id !== runId)
      || facts.some((f) => f.taskId === t!.id && f.runId !== runId && f.status !== "unreadable" && !TERMINAL_STATUSES.includes(f.status))) {
      refuse("task_active_run", `${t!.key} has an active run`);
    }
    // C1: from the board's merged head of the task's place, as it is now; a dependency counts once it is in the head
    // (owner's decision 9 of stage C) — B's rule of results in branches does not apply then
    if (goal.base && BOARD_REF.test(goal.base.branch)) {
      const h = await merges.head(t!.workspaceId, source).catch(() => null);
      if (!h || h.ref !== goal.base.branch || h.commit !== goal.base.commit || goal.base.key !== "T-0") refuse("invalid_base", "the base is not the board's merged head as it is now");
      if (anyway) return;
      const into = await merges.mergesInto(h!.ref);
      const statuses = boardStatuses(b, facts);
      const out = t!.dependsOn.map((d) => b.tasks.find((x) => x.id === d)).filter((d): d is BoardTask => !!d)
        .filter((d) => !statuses.get(d.id)?.done || into.find((m) => m.task.id === d.id)?.status !== "completed").map((d) => d.key);
      if (out.length) refuse("task_not_ready", `${t!.key} waits for ${out.join(", ")} in the board's result: start anyway?`);
      return;
    }
    if (goal.base) {
      const from = b.tasks.filter((d) => t!.dependsOn.includes(d.id) && d.key === goal.base!.key);
      const statuses = boardStatuses(b, facts);
      const ok = from.some((d) => {
        const run = facts.find((f) => f.runId === statuses.get(d.id)?.current);
        return run?.taken?.branch === goal.base!.branch && run.taken.commit === goal.base!.commit;
      });
      if (!ok) refuse("invalid_base", `the base is not the branch of a result of what ${t!.key} depends on`);
    }
    if (anyway) return;
    const statusesNow = boardStatuses(b, facts);
    const wait = statusesNow.get(t!.id)?.depsWait;
    if (wait) refuse("task_not_ready", `${t!.key} waits for ${wait.waitsFor.join(", ")}: start anyway?`);
    // a dependency's result in a branch only (decision 11) is seen by a separate copy from that branch alone: a start
    // without it (another mode, or the working folder chosen) goes without that result — the person says so (withoutBase)
    const inBranch = !goal.base && !withoutBase && baseOf(t!, b, statusesNow, facts);
    if (inBranch) refuse("task_not_ready", `the result of ${inBranch.key} is in the branch ${inBranch.branch} only: start from it, or start anyway?`);
  }

  const api = {
    // B1: the board and the facts of the runs of its tasks; the renderer works the statuses out (taskStatus)
    board: () => result(boardView),
    // B4: the board's autopilot of a link (§5): on or off, and its budget in board.json
    boardAutopilot: (linkId: string, on: boolean, language: "ru" | "en") => result(async () => {
      if (on) { platformOk(); notOpen(); if (deps.journalV2 !== true) refuse("journal_v1", "the board's autopilot needs journal v2 (goal.task)"); }
      await autopilot.set(linkId, on, language);
      return (await autopilot.state())[linkId] ?? null;
    }),
    boardBudget: (linkId: string, budget: AutopilotBudget | null) => result(() => board.budget(linkId, budget)),
    boardCreate: (input: TaskInput) => result(async () => {
      workspaceOk(input?.workspaceId);
      return board.create({ ...input, project: await realpath(input.project).catch(() => refuse("invalid_task", "the project folder does not exist")) });
    }),
    boardUpdate: (id: string, patch: Parameters<typeof board.update>[1]) => result(() => board.update(id, patch)),
    boardArchive: (id: string, archived: boolean) => result(() => leaving(id, archived, () => board.archive(id, archived, () => startingTasks.has(id)))),
    // a run being created counts: its journal may not be there yet (stage-b-board.md §3.3)
    boardRemove: (id: string, dependents: string[] = []) => result(() => leaving(id, true,
      () => board.remove(id, async () => startingTasks.has(id) || (await taskFacts()).some((f) => f.taskId === id), dependents))),
    boardAccept: (id: string) => result(() => acceptTask(id)),
    boardPlace: (workspaceId: string, bounds: BoardPlace | null) => result(() => { workspaceOk(workspaceId); return board.place(workspaceId, bounds); }),
    // C1 (stage-c-parallel.md §4): «Объединить», «Объединить все», a paused merge's «Готово, проверить» and «Пропустить»,
    // and the person's actions on the head — never automatic
    boardMerge: (taskId: string, language: "ru" | "en" = "en") => result(() => mergeTask(taskId, language)),
    boardMergeAll: (workspaceId: string, project: string, language: "ru" | "en" = "en") => result(async () => mergeAll(workspaceId, await placeProject(project), language)),
    boardMergeResolve: (runId: string, confirm: boolean) => result(() => { notOpen(); return merges.resolve(runIdOk(runId), confirm === true); }),
    boardMergeSkip: (runId: string) => result(() => merges.skip(runIdOk(runId))),
    boardMergeDir: (runId: string) => result(() => merges.copyOf(runIdOk(runId))),
    boardHeadBranch: (workspaceId: string, project: string) => result(async () => { notOpen(); return merges.branch(workspaceId, await placeProject(project)); }),
    boardHeadApply: (workspaceId: string, project: string) => result(async () => { notOpen(); return merges.apply(workspaceId, await placeProject(project)); }),
    boardHeadNew: (workspaceId: string, project: string) => result(async () => { notOpen(); workspaceOk(workspaceId); return merges.newHead(workspaceId, await placeProject(project)); }),

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
        if (await merges.isMerge(id)) continue; // C1: a merge run is shown on the board, not as a newer version's run
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
    moveAgent: (agentId: string, bounds: OrchestrationBounds, expanded?: OrchestrationBounds["size"]) => result(() => canvas.moveAgent(agentId, bounds, expanded)),
    deleteAgent: (agentId: string) => result(() => canvas.deleteAgent(agentId, busy)),
    createLink: (input: { linkId: string; fromAgentId: string; toAgentId: string }) => result(() => { platformOk(); return canvas.createLink(input); }),
    deleteLink: (linkId: string) => result(() => canvas.deleteLink(linkId, busy)),
    // Only a link that holds a newer version's run (busy says "newer" for that run), and only its own run.
    releaseNewerLink: (input: { commandId: string; linkId: string; runId: string }) =>
      result(() => canvas.releaseNewer({ ...input, appVersion: deps.appVersion?.() ?? "unknown" }, busy)),
    startOnLink: (input: { linkId: string; requestId: string; goal: OrchestrationGoalInput; anyway?: boolean; withoutBase?: boolean }) => result(() => {
      notOpen();
      platformOk();
      return (async () => {
        // C1 (§3.1): a run in a separate copy is held off only by a run that is not in one
        const project = await leadProject(input.linkId);
        const mode = input.goal?.workMode ?? (input.goal?.mode ? ((await profiles.get(project)) ?? await suggestProfile(project)).workMode : undefined);
        return canvas.startOnLink(input.linkId, input.requestId, busy, exists,
          (source, current) => createRun({ requestId: input.requestId, source, goal: input.goal, ...(input.anyway ? { anyway: true } : {}), ...(input.withoutBase ? { withoutBase: true } : {}) }, current),
          mode === "copy" ? runMode : null);
      })();
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

    take: (runId: string) => result(async () => (await takeState(runIdOk(runId))).info),
    takeResult: (runId: string, input: OrchestrationTakeInput) => result(async () => {
      runIdOk(runId);
      while (taking.has(runId)) await taking.get(runId)!.catch(() => {});
      const p = takeResult(runId, input);
      taking.set(runId, p);
      try { return await p; } finally { taking.delete(runId); }
    }),

    // The checks the start would make, and more, without starting anything (no model call, no run, no file written).
    // The runtime (CLI versions, the login shell's environment) is measured at most every 30 s per project.
    // full («Проверить сейчас»): also the preparation and the commands on the source, in a temporary work folder of the
    // chosen mode (never in the project folder), within timeoutMs for all of them.
    readiness: (input: { linkId: string; commands: string[]; workMode: "project" | "copy" | "worktree"; models?: Partial<OrchestrationRoleModels>; accessOverride?: Partial<Record<"claude" | "codex", "terminal">>; full?: boolean; timeoutMs?: number }) => result(async () => {
      const c = await canvas.read(exists);
      const link = c.links.find((l) => l.linkId === input.linkId) ?? refuse("link_not_found", "no such link");
      const lead = c.agents.find((a) => a.agentId === link.fromAgentId) ?? refuse("link_not_found", "the link has no lead");
      const holder = await folderHolder(c, lead.project, link.linkId, busy, known, input.workMode === "copy" ? runMode : null);
      // Nothing is measured where a run could not finish: no CLI and no login shell for a start that is refused anyway.
      if (!orchestrationAvailable(platform)) return { ready: false, items: [platformItem(platform)] };
      const profile = (await profiles.get(lead.project)) ?? await suggestProfile(lead.project);
      const key = `${input.workMode === "worktree" ? "worktree" : "folder"}:${lead.project}`;
      const cached = runtimes.get(key);
      const measured = cached && Date.now() - cached.at < 30_000 ? cached.value
        : await (deps.native ? deps.native(lead.project, { direnv: profile.env.direnv, worktreePending: input.workMode === "worktree" }) : Promise.reject(new Refusal("provider_unavailable", "no native agent runtime"))).then(
          (rt) => ({ ok: true as const, versions: rt.versions, env: rt.env, shell: rt.shell, direnv: rt.direnv, ...(rt.executables ? { executables: rt.executables } : {}), ...(rt.codexEnv ? { codexEnv: rt.codexEnv } : {}), ...(rt.claudeEnv ? { claudeEnv: rt.claudeEnv } : {}), ...(rt.claudeHelp ? { claudeHelp: rt.claudeHelp } : {}) }),
          (e) => ({ ok: false as const, code: typeof e?.code === "string" ? e.code : "provider_unavailable", detail: String(e?.message ?? e) }));
      runtimes.set(key, { at: Date.now(), value: measured });
      let gitPath: string | null = null;
      try { gitPath = deps.gitPath(); } catch { gitPath = null; }
      // the CLIs' capabilities (probed once per version): the CLIs' item, and what would refuse the start as blockers
      const caps = measured.ok ? await capabilitiesOf(measured) : null;
      const r = await assessReadiness({
        project: lead.project, commands: input.commands, workMode: input.workMode, platform, gitPath, optionalChecks: deps.journalV2 === true,
        prepare: profile.prepare,
        runtime: measured, busy: holder !== null, ...(caps ? { clis: clisItem(caps) } : {})
      });
      if (caps) {
        const access = accessFor(profile.access as AgentAccess, input.accessOverride);
        const blockers = startProblems(caps, access, roleModels(profile, input.models), codexRoles());
        // the one-run choice of the person, said as such (wider rights for this run only)
        const chosenHere = (["claude", "codex"] as const).filter((p) => input.accessOverride?.[p] === "terminal" && profile.access[p] !== "terminal")
          .map((p): OrchestrationReadinessItem => ({ id: `access_${p}_once`, level: "info", detail: `${p}: as in the terminal, for this run only`, facts: { provider: p, version: caps[p].version, mode: profile.access[p] } }));
        r.items.splice(Math.max(0, r.items.length - 1), 0, ...blockers, ...startWarnings(caps, access), ...chosenHere);
        r.ready = r.ready && blockers.length === 0;
      }
      // the roles' models: the same check the start makes (no model turn); "permissions" stays the last item
      if (measured.ok && measured.executables) {
        const item = modelItem(await codexModelsAt(measured.executables.codex, lead.project, measured.codexEnv ?? measured.env), roleModels(profile, input.models), codexRoles());
        r.items.splice(Math.max(0, r.items.length - 1), 0, item);
        r.ready = r.ready && item.level !== "blocker";
      }
      // before the start, without a model call: the sign-in, Claude's model (no list without a turn), the check sandbox
      if (measured.ok) {
        const rt = measured;
        const extra = [
          ...await kept(`auth:${rt.executables?.codex ?? ""}:${rt.executables?.claude ?? ""}`, 60_000, () => authItems(rt)),
          { id: "model_claude", level: "info" as const, detail: "Claude's model is not checked before the start" },
          ...(deps.leadSandbox === false ? [] : await kept(`sandbox:${rt.shell}`, 10 * 60_000, () => {
            let gitPath: string | null = null;
            try { gitPath = deps.gitPath(); } catch { gitPath = null; }
            return sandboxItems({ launch: deps.launch(), root: deps.root, realHome: deps.leadSandbox ? deps.leadSandbox.realHome : undefined, gitPath, rt });
          })),
          ...(input.full && gitPath ? (await sourceChecks({
            project: lead.project, workMode: input.workMode, commands: input.commands, prepare: profile.prepare, rt, launch: deps.launch(),
            gitPath, cloneDir: deps.cloneDir, timeoutMs: input.timeoutMs ?? PREFLIGHT_TIMEOUT_MS
          })).items : [])
        ];
        r.items.splice(Math.max(0, r.items.length - 1), 0, ...extra);
        r.ready = r.ready && !extra.some((i) => i.level === "blocker");
      }
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
      const caps = rt ? await capabilitiesOf(rt) : null;
      let gitPath: string | null = null;
      try { gitPath = deps.gitPath(); } catch { gitPath = null; }
      const s = await suggestCommands(project);
      return {
        profile, saved: saved !== null, ...(deps.journalV2 ? { optionalChecks: true } : {}),
        capabilities: {
          claude: (caps?.claude.modes ?? ["terminal"]).map((mode) => ({ mode, mapping: accessMapping("claude", mode) })),
          codex: (caps?.codex.modes ?? ["terminal"]).map((mode) => ({ mode, mapping: accessMapping("codex", mode) }))
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
      const saved = await profiles.get(project);
      // "As in my terminal" lets the agents do all the person can (network, SSH tunnels, any file): switched on only
      // with its warning confirmed; a mode already saved stays as it is.
      const toTerminal = (["claude", "codex"] as const).filter((k) => p.access[k] === "terminal" && saved?.access[k] !== "terminal");
      if (toTerminal.length && (input as { confirmTerminal?: unknown }).confirmTerminal !== true) {
        refuse("terminal_not_confirmed", `"as in my terminal" for ${toTerminal.join(", ")} needs the warning confirmed`);
      }
      const before = saved?.grants ?? [];
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
    // The models Codex offers for the settings and the goal (model/list, config/read; no model turn). refresh: «Обновить».
    codexModels: (linkId: string, refresh = false) => result(async (): Promise<OrchestrationCodexModels> => {
      notOpen();
      platformOk();
      const project = await leadProject(linkId);
      if (!deps.native) refuse("provider_unavailable", "no native agent runtime");
      const rt = await deps.native!(project, await direnvOf(project));
      if (!rt.executables) refuse("provider_unavailable", "this runtime cannot be asked for its models");
      return codexModelsAt(rt.executables!.codex, project, rt.codexEnv ?? rt.env, refresh);
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
      autopilot.shutdown();
      await Promise.allSettled([...[...creating.values()].map((c) => c.p), ...opening.values(), ...stopping.values()]);
      await Promise.allSettled([...handles.values()].map((h) => h.shutdown()));
      handles.clear();
      runRuntimes.clear();
      watchers.clear();
    }
  };
  const autopilot = createBoardAutopilot({
    view: async () => { const r = await board.read(); return { board: r.board, facts: await taskFacts() }; },
    link: async (linkId) => {
      const c = await canvas.read(exists);
      const link = c.links.find((l) => l.linkId === linkId);
      const lead = link && c.agents.find((a) => a.agentId === link.fromAgentId);
      return lead ? { workspaceId: workspaceOf(lead, known), project: lead.project } : null;
    },
    profile: async (project) => (await profiles.get(project)) ?? await suggestProfile(project),
    optionalChecks: deps.journalV2 === true,
    journal: async (runId) => (await journal(runId)).map((r) => ({ ts: r.ts, type: r.type, data: r.data })),
    readiness: (input) => api.readiness(input),
    start: (input) => api.startOnLink(input),
    take: async (runId) => {
      const info = await api.take(runId);
      return info.ok ? api.takeResult(runId, { action: "branch", name: info.value.suggested }) : info;
    },
    // C1: the head of a place with its merges, its start, a merge into it
    head: async (workspaceId, project) => (await merges.heads([{ workspaceId, project }]))[0] ?? null,
    ensureHead: async (workspaceId, project) => { await merges.ensureHead(workspaceId, project); },
    merge: (input) => result(() => merges.merge(input)),
    newId: () => randomUUID(),
    now: () => Date.now()
  }, async (linkId) => (await board.read()).board.autopilot?.[linkId] ?? AUTOPILOT_BUDGET);
  return api;
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
    executables: { codex: cfg.codex.executable, claude: cfg.claude.executable }, direnv: "off", codexEnv: envOf("codex"), claudeEnv: envOf("claude"),
    claudeHelp: () => run(cfg.claude.executable, ["--help"], { timeout: 20_000, env: envOf("claude") }).then((r) => r.stdout),
    shell: cfg.shell ?? shell ?? "/bin/sh",
    env: cfg.checkEnv ?? { PATH: cfg.codex.path, HOME: cfg.codex.env.HOME ?? "/nonexistent" },
    versions: { codex: cfg.codex.version, claude: cfg.claude.version }
  });
}
