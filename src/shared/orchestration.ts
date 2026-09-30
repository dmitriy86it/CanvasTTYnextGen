// Orchestration over IPC (docs/agent-orchestration/implementation/stage-7-contract.md). Plain data only: the renderer
// names runs, checks and commands by id; executables, argv, environment, the supervisor, paths of the application's
// own files and the provider adapters are chosen in main.

export type OrchestrationRunStatus =
  | "preparing" | "running" | "pausing" | "paused" | "stopping" | "stopped" | "completed" | "failed";
export type OrchestrationTurnPurpose = "plan" | "execute" | "review" | "final_review";
export type OrchestrationLimitKind = "turns" | "roundsPerStage" | "replans" | "runMs";
export type OrchestrationRunLimitKind = OrchestrationLimitKind | "noProgressRounds" | "leadTurnMs" | "executorTurnMs";

// Where the agents work: the project folder itself, as in the user's terminal (default, stage 12), a separate Git
// worktree on its own branch (stage 13, explicit), or the managed copy of stages 3–11 (older runs).
export type OrchestrationWorkMode = "project" | "worktree" | "copy";

// Stage 13. How much the run does on its own: autopilot (plan, prepare, fix and re-check without stopping; asks only
// when data is missing, a significant ambiguous decision or an action outside the granted rights) or step by step
// (the plan is shown and the run stops after each stage).
export type OrchestrationRunMode = "autopilot" | "steps";
export interface OrchestrationPrepareStep { command: string; unless: string | null }
// A permission decision the person saved for the project: applied without a new dialog only to the same provider,
// tool and parameters (fingerprint); never to another project.
export interface OrchestrationGrant {
  id: string;
  provider: "codex" | "claude";
  kind: string;
  tool: string;
  summary: string;
  fingerprint: string;
  grantedAt: string;
}
// The one-time setup of a project, filled from facts of the repository and corrected by the user.
export interface OrchestrationProjectProfile {
  v: 1;
  workMode: "project" | "worktree";
  checks: string[]; // the project's check commands
  prepare: { steps: OrchestrationPrepareStep[]; auto: boolean }; // auto: the autopilot runs the needed steps itself
  env: { direnv: boolean }; // apply an allowed .envrc (direnv) on top of the login shell
  access: { claude: string; codex: string }; // access.ts modes
  finish: {
    commit: boolean;
    push: { remote: string; branch: string; remoteUrl: string | null } | null;
    // reportsVersion: the verification follows the version contract — it writes the identifier of the version it
    // observed on the environment (a commit id) to the file named by $CANVASTTY_QA_RESULT; CanvasTTY compares it with
    // the expected commit ($CANVASTTY_COMMIT). Without it a passing verification never confirms a version.
    qa: { environment: string; command: string; verify: string; reportsVersion?: boolean } | null;
  };
  grants: OrchestrationGrant[];
  savedAt: string | null; // null: suggested from the repository, never saved
}
export interface OrchestrationAccessOption { mode: string; mapping: string }
export interface OrchestrationProfileInfo {
  profile: OrchestrationProjectProfile;
  saved: boolean;
  capabilities: { claude: OrchestrationAccessOption[]; codex: OrchestrationAccessOption[] };
  facts: { stack: string; laravel: boolean; remotes: { name: string; url: string }[]; branch: string | null; needed: string[] };
}
// What each CLI reports it loaded, asked without a model turn (stage 13). confirmed: said by the CLI itself.
// An MCP server as the CLI reports it: found in its configuration; connection: the CLI's runtime state (null: not
// checked — Codex reports it only inside a thread); auth: sign-in state (Codex: "unsupported" for servers without
// sign-in, which says nothing about the connection); tools: the names the CLI discovered.
export interface OrchestrationMcpServer { name: string; connection: string | null; auth: string | null; tools: string[] }
// Why a list is not the CLI's whole list — a fixed code, never the CLI's words.
export type OrchestrationListIncomplete = "timeout" | "request_failed" | "cli_exited" | "page_failed" | "no_list" | "cursor_unreadable" | "cursor_repeats" | "page_limit";
// One request of the environment probe, timed on a monotonic clock from the probe's start (ms). Only these fields:
// never the request's parameters, the CLI's output or its error text. allottedMs: how long it could wait (the rest of
// the probe's one deadline); leftMs: what was left of it afterwards. outcome: answered; protocol_error (the CLI refused
// it); wait_expired (no answer by the deadline); late (answered at or after the deadline, not used); cli_exited (the
// process ended first); not_sent (the time was up before it).
export type OrchestrationProbeOutcome = "answered" | "protocol_error" | "wait_expired" | "late" | "cli_exited" | "not_sent";
export interface OrchestrationProbeTiming { method: string; page: number | null; startMs: number; durationMs: number; allottedMs: number; leftMs: number; outcome: OrchestrationProbeOutcome }
// complete: the item is the CLI's whole list (MCP servers); false: partial or not received (incomplete says why)
export interface OrchestrationEnvironmentItem { id: string; value: string; confirmed: boolean; note?: string; servers?: OrchestrationMcpServer[]; complete?: boolean; incomplete?: OrchestrationListIncomplete }
// Readiness of one project MCP server of Codex, asked for explicitly: the project layer loaded (trusted folder), the
// server in the effective configuration, and — only then — an ephemeral thread without a turn for its runtime state.
export interface OrchestrationMcpReadiness {
  server: string;
  projectLayer: "enabled" | "disabled" | "absent";
  disabledReason: string | null;
  inProjectLayer: boolean; // the server is defined in this folder's .codex/config.toml, not only elsewhere
  inConfig: boolean;
  threadStarted: boolean;
  status: OrchestrationMcpServer | null; // from the thread's list when a thread ran, else from the list without one
  error: string | null;
}
export interface OrchestrationEnvironmentReport {
  checkedAt: string;
  providers: { provider: "codex" | "claude"; ok: boolean; error: string | null; items: OrchestrationEnvironmentItem[]; readiness?: OrchestrationMcpReadiness; timing?: OrchestrationProbeTiming[]; limitMs?: number }[];
  shell: { shell: string | null; direnv: string; pathEntries: number };
}

export interface OrchestrationGoalInput {
  text: string;
  criteria: string[];
  checks: string[]; // ids from catalog(); empty when `commands` names the checks
  // Stage 12: the project's own check commands (`php artisan test`), run in the user's login shell in the work folder.
  commands?: string[];
  workMode?: OrchestrationWorkMode;
  reviewPlan?: boolean; // pause after the plan for the user to look at it
  limits?: Partial<Record<OrchestrationRunLimitKind, number>>;
  // Stage 13 (from the dialog; the rest comes from the saved project profile in main)
  mode?: OrchestrationRunMode;
  finish?: { commit: boolean; push: boolean; qa: boolean }; // this goal's actions after success, each explicitly chosen
}

export interface OrchestrationCreateRequest {
  requestId: string; // UUID chosen by the renderer; it becomes the runId, so a repeat never creates a second run
  source: string; // absolute path of the project's Git repository (its top level)
  goal: OrchestrationGoalInput;
}

export type OrchestrationRunCommand =
  | { kind: "pause_after_turn"; on: boolean }
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "step" }
  | { kind: "answer"; questionId: string; text: string }
  | { kind: "clarify"; text: string }
  | { kind: "recover"; action: "accept" | "retry_turn" | "reset_to_checkpoint"; confirm?: boolean }
  | { kind: "raise_limit"; limit: OrchestrationLimitKind; value: number }
  | { kind: "dismiss" }
  | {
    kind: "permission"; requestId: string; decision: OrchestrationPermissionOption; answers?: Record<string, string[]>;
    content?: Record<string, unknown>; // an MCP form's values (accept)
    feedback?: string; // why a plan is sent back (Claude ExitPlanMode, deny)
  };

// A permission prompt or question of an agent's CLI, waiting for the person (stage 12). The CLI's own prompt: CanvasTTY
// only carries it, never answers it by itself. Texts are sanitized (no secrets, paths relative to the work folder).
// allow_run / allow_project (stage 13): CanvasTTY remembers the decision for exactly this action (same tool and
// parameters) for the rest of the run, or for the project; the CLI is told "allow once" each time.
export type OrchestrationPermissionOption = "allow_once" | "allow_session" | "allow_run" | "allow_project" | "deny";
export interface OrchestrationFormField {
  name: string;
  title: string;
  description: string;
  type: "string" | "number" | "integer" | "boolean" | "enum" | "multi";
  format: "email" | "uri" | "date" | "date-time" | null;
  options: { value: string; label: string }[];
  minimum: number | null;
  maximum: number | null;
  minLength: number | null;
  maxLength: number | null;
  minItems: number | null;
  maxItems: number | null;
  required: boolean;
  default: string | number | boolean | string[] | null; // the server's own default, nothing else
}
export type OrchestrationForm =
  | { mode: "form"; fields: OrchestrationFormField[] }
  | { mode: "url"; url: string } // the server asks the person to open a page (sign-in, consent)
  | { mode: "unsupported"; reason: string };
export interface OrchestrationPermissionRequest {
  requestId: string;
  role: "lead" | "executor";
  provider: "codex" | "claude";
  // permission: command, file_change, permissions, tool; a question of the task: question, plan; a form: elicitation
  kind: "command" | "file_change" | "permissions" | "tool" | "question" | "elicitation" | "plan";
  tool: string;
  summary: string;
  detail: string | null; // the tool input, bounded
  options: OrchestrationPermissionOption[];
  questions: { id: string; question: string; options: string[]; multiple: boolean; other: boolean; secret?: boolean }[];
  askedAt: string;
  // The CLI requires the person for this request (a user ask rule, a safety check), or its parameters do not say
  // exactly what is allowed (a Codex file change without paths): a saved decision is never applied or offered.
  alwaysAsk?: boolean;
  form?: OrchestrationForm | null; // elicitation
  plan?: string | null; // plan: the plan the agent wants to leave plan mode with
  server?: string | null; // elicitation: the MCP server
}

export interface OrchestrationCommandRequest {
  runId: string;
  commandId: string; // UUID; a repeat returns the recorded result and does nothing again
  expectedRevision: number;
  command: OrchestrationRunCommand;
}

export interface OrchestrationRunView {
  runId: string;
  status: OrchestrationRunStatus;
  reason: string | null;
  revision: number;
  stage: number | null;
  turns: number;
  halted: boolean;
  active: null | { kind: "turn"; purpose: OrchestrationTurnPurpose } | { kind: "check"; checkId: string }
    | { kind: "prepare" } | { kind: "finish"; step: "commit" | "push" | "qa" };
  permission?: OrchestrationPermissionRequest | null; // the oldest request waiting for the person
  pendingPermissions?: number;
  workMode?: OrchestrationWorkMode;
  workDir?: string; // where the agents work: the project folder (project mode) or the copy
  progress?: OrchestrationRunProgress;
  // A run whose journal a newer version of the application wrote (acceptance-review-spec.md §2.2): shown read-only
  // (status paused, reason newer_version), never opened or changed here. chain: the hash chain of what was read.
  // compatible: its journal declares minReaderVersion this build reads, so the view is its whole state (status and
  // reason as journaled), still read-only. fallback: it declared that, but a record did not replay by v1 rules
  // (line, code), so only its goal and records are shown.
  newer?: {
    version: number; chain: "ok" | "torn_tail" | "corrupt"; goal: string | null;
    compatible?: boolean; fallback?: { line: number; code: string } | null;
    skipped?: number; // compatible: records of types this build does not know, marked skippable, left out of the state
  };
}

// QA version evidence, kept apart from "the verification command exited 0":
// confirmed — the verification follows the version contract and reported the expected commit;
// mismatch — it reported another commit; not_reported — it follows the contract but wrote nothing;
// invalid — it wrote something that is not a commit id; not_checked — no version contract (an older or plain
// command): the check passed, the version is not confirmed.
export type OrchestrationQaVersion = "confirmed" | "mismatch" | "not_reported" | "invalid" | "not_checked";

// Stage 13: what is done and confirmed, from the journal only (never an agent's own report).
export interface OrchestrationRunProgress {
  mode: OrchestrationRunMode;
  branch: string | null;
  access: { claude: string; codex: string } | null;
  checks: { id: string; title: string; status: "passed" | "failed" | "not_verified" | "not_run"; class: "code" | "environment" | "external" | null }[]; // the latest result of each
  prepare: { status: string; failed: string | null; class: "code" | "environment" | "external" | null } | null;
  // version (QA): what the verification established about the deployed version (see OrchestrationQaVersion);
  // observed: the commit id the verification reported (only a validated id, never other output)
  finish: { step: "commit" | "push" | "qa"; asked: boolean; status: string; established: boolean; commit: string | null; evidence: string | null; version?: OrchestrationQaVersion | null; observed?: string | null }[];
  grantsApplied: number;
}

// seq: the journal position the view belongs to (not the revision); tick: changes of the view since that record that
// the journal does not hold (the operation started or ended, halted). (seq, tick) orders the snapshots and events of one
// watch; after a new watch (a reload, a restart) its snapshot is the new base. Events carry the same stamp.
export interface OrchestrationRunSnapshot {
  seq: number;
  tick: number;
  view: OrchestrationRunView;
  integrity: "ok" | "torn_tail" | "corrupt" | "newer_version" | "newer_version_compatible";
  open: boolean; // held by this application process (the run's only writer)
}

export interface OrchestrationRunEvent {
  runId: string;
  seq: number;
  tick: number;
  view: OrchestrationRunView;
}

export interface OrchestrationHistoryRecord {
  seq: number;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

export interface OrchestrationHistoryPage {
  records: OrchestrationHistoryRecord[];
  lastSeq: number; // of the whole valid journal
  more: boolean; // records after the last one returned
}

export interface OrchestrationCatalog {
  checks: { id: string; title: string }[];
  // What the application runs for each role (fixed in main; shown in the overview, never chosen by the renderer).
  providers?: {
    lead: OrchestrationParticipantInfo;
    executor: OrchestrationParticipantInfo;
  };
}
export interface OrchestrationParticipantInfo {
  provider: "codex" | "claude";
  mode: "native"; // stage 12: the CLI with the user's own configuration (model, tools, permissions)
  protocol: string; // "codex app-server" | "claude -p stream-json (host permission prompts)"
}

// ---------- observation of a run (live activity of the managed sessions) ----------
// Built in main from the CLIs' structured events, sanitized (no environment, auth or argv; paths relative to the
// working copy), bounded and persisted separately from the journal. Never the model's hidden reasoning: a reasoning
// event is only a marker without its text.
export type OrchestrationActivityRole = "lead" | "executor" | "check" | "run";
export type OrchestrationActivityKind =
  | "task_sent" | "process_started" | "process_exited" | "session" | "thinking" | "message" | "tool_started" | "tool_finished"
  | "file_read" | "file_changed" | "subagent" | "usage" | "refusal" | "error" | "stderr" | "turn_finished"
  | "check_started" | "check_finished" | "check_output" | "status" | "truncated"
  | "permission_requested" | "permission_decided"
  | "permission_applied" | "prepare_started" | "prepare_finished" | "external_action"; // stage 13
export interface OrchestrationActivityEntry {
  id: number; // per run, increasing; the renderer dedupes by it
  ts: string;
  turnId: string | null;
  role: OrchestrationActivityRole;
  provider: "codex" | "claude" | null;
  kind: OrchestrationActivityKind;
  text: string; // sanitized, bounded
  detail?: Record<string, string | number | boolean | null>;
}
export interface OrchestrationActivityPage {
  entries: OrchestrationActivityEntry[];
  lastId: number; // the newest id kept for the run (0: none)
  more: boolean; // entries after the last one returned
  // Where the record is known to be incomplete: the application ended while a turn ran (nothing after afterId was
  // observed), or entries were dropped by the size limits.
  gaps: { afterId: number; reason: "app_restarted" | "dropped" | "write_failed" }[];
  firstId: number; // oldest id still kept (older ones were dropped by the limit)
}
export interface OrchestrationActivityEvent {
  runId: string;
  entries: OrchestrationActivityEntry[];
}

// What changed in the working copy against the run's base, from Git objects only (nothing is read from the copy).
export interface OrchestrationChanges {
  base: "baseline";
  at: "live_snapshot" | "last_check" | "checkpoint" | "baseline"; // which tree of the copy the list describes
  atTs: string | null;
  files: { path: string; status: "added" | "modified" | "deleted" | "renamed" | "type_changed" }[];
  truncated: boolean;
  checkpoints: { stage: number; ref: string; commit: string }[];
  baselineRef: string;
  transferred: false; // the application never moves changes into the source project
}
export interface OrchestrationDiff { path: string; text: string; truncated: boolean }

// Readiness of a goal before any model turn (stage 11): what the application can check, what is prepared, what the
// agents can do. A blocker refuses the start; a confirm item needs the user's explicit acknowledgement.
export type OrchestrationReadinessLevel = "ok" | "info" | "warning" | "confirm" | "blocker";
export interface OrchestrationReadinessItem {
  id: string; // stable: platform, clis, env, git, workdir, busy, stack, laravel, commands, command_<n>, tests, permissions
  level: OrchestrationReadinessLevel;
  detail: string; // facts found (English, short); the renderer shows its own words by id and level
  facts?: Record<string, string | number | boolean | null>;
}
export interface OrchestrationReadiness {
  ready: boolean; // no blocker
  items: OrchestrationReadinessItem[];
}

// Agent cards and links on the canvas (stage-8-contract.md §3). Held in main; geometry is separate from every run.
export type OrchestrationProviderKind = "codex" | "claude";
export interface OrchestrationBounds {
  position: { x: number; y: number };
  size: { width: number; height: number };
}
export interface OrchestrationAgentCard {
  agentId: string;
  provider: OrchestrationProviderKind;
  role: "lead" | "executor"; // Codex leads, Claude executes (MVP)
  project: string; // realpath of the project folder
  bounds: OrchestrationBounds;
  createdAt: string;
  workspaceId?: string; // absent: the common canvas (cards made before workspaces)
}
export interface OrchestrationAgentLink {
  linkId: string;
  fromAgentId: string; // the lead
  toAgentId: string; // the executor
  createdAt: string;
  runIds: string[]; // the link's runs, oldest first; the last one is shown
}
export interface OrchestrationCanvas {
  agents: OrchestrationAgentCard[];
  links: OrchestrationAgentLink[];
  // The workspace each run belongs to, written with the run's reservation and never moved after it. A run missing
  // here belongs to the workspace of the link that holds it, else to the common canvas.
  owners?: Record<string, string>;
  // Links let go of newer versions' runs (releaseNewerLink): a later version finds its run without a link here.
  releasedNewerRuns?: OrchestrationReleasedNewerRun[];
}

export interface OrchestrationReleasedNewerRun {
  runId: string;
  linkId: string;
  folder: string; // the project folder the link held
  releasedAt: string;
  appVersion: string; // the version that let it go
  commandId: string;
}

// folder_busy: the run that holds the project folder (by main's busy rule), its owner workspace (unknown → common) and
// whether its journal could be read (false: busy because its state is unknown). The readiness item "busy" carries the
// same three in its facts.
export interface OrchestrationFolderHolder { runId: string; workspaceId: string; runReadable: boolean }
export type OrchestrationResult<T> = { ok: true; value: T }
  | ({ ok: false; code: string; message: string } & Partial<OrchestrationFolderHolder>);

// Where a run can finish. Every project check runs in the Seatbelt sandbox (sandbox-exec), which exists only on macOS
// (arm64 and x64 alike); elsewhere a run would spend model turns and then pause at its first check for good. So the
// application starts, continues and links nothing there (code unsupported_platform); existing runs stay readable and
// can be stopped.
export function orchestrationAvailable(platform: string): boolean {
  return platform === "darwin";
}

export interface OrchestrationApi {
  available: boolean; // orchestrationAvailable() on this machine: the renderer greys out what main would refuse
  catalog(): Promise<OrchestrationResult<OrchestrationCatalog>>;
  list(): Promise<OrchestrationResult<OrchestrationRunSnapshot[]>>;
  get(runId: string): Promise<OrchestrationResult<OrchestrationRunSnapshot>>;
  create(request: OrchestrationCreateRequest): Promise<OrchestrationResult<{ runId: string; created: boolean }>>;
  command(request: OrchestrationCommandRequest): Promise<OrchestrationResult<{ status: "accepted" | "rejected" | "in_progress"; code: string | null }>>;
  history(runId: string, fromSeq: number, limit: number): Promise<OrchestrationResult<OrchestrationHistoryPage>>;
  text(runId: string, sha256: string): Promise<OrchestrationResult<{ text: string }>>;
  canvas(): Promise<OrchestrationResult<OrchestrationCanvas>>;
  createAgent(input: { agentId: string; provider: OrchestrationProviderKind; project: string; bounds: OrchestrationBounds; workspaceId: string }): Promise<OrchestrationResult<OrchestrationAgentCard>>;
  moveAgent(agentId: string, bounds: OrchestrationBounds): Promise<OrchestrationResult<OrchestrationAgentCard>>;
  deleteAgent(agentId: string): Promise<OrchestrationResult<null>>;
  // Moves a whole linked group to another workspace; agentIds must be exactly the group the person saw. Refused while
  // one of its links has a run that is not finished (paused included). The owners of its runs stay.
  moveAgentGroup(agentIds: string[], workspaceId: string): Promise<OrchestrationResult<OrchestrationCanvas>>;
  createLink(input: { linkId: string; fromAgentId: string; toAgentId: string }): Promise<OrchestrationResult<OrchestrationAgentLink>>;
  deleteLink(linkId: string): Promise<OrchestrationResult<null>>;
  // A link held by a newer version's run is let go here (acceptance-review-spec.md §2.2.1): the
  // link is removed and its folder freed, the run's files stay as they are. A repeat of commandId answers the same.
  releaseNewerLink(input: { commandId: string; linkId: string; runId: string }): Promise<OrchestrationResult<OrchestrationReleasedNewerRun>>;
  // Creates a run on the link: the source is the lead card's project, chosen in main.
  startOnLink(input: { linkId: string; requestId: string; goal: OrchestrationGoalInput }): Promise<OrchestrationResult<{ runId: string; created: boolean }>>;
  // The listener gets the run's current state first (the snapshot, as an event), then only newer states in order;
  // `snapshot` is the same result. One main subscription per run and page, however many listeners. unwatch() stops it.
  // Activity batches of the run travel on the same subscription (onActivity listeners get them while it is held).
  watch(runId: string, listener: (event: OrchestrationRunEvent) => void): {
    snapshot: Promise<OrchestrationResult<OrchestrationRunSnapshot>>;
    unwatch(): void;
  };
  // Stored activity from afterId on (0: from the oldest kept), up to limit entries.
  activity(runId: string, afterId: number, limit: number): Promise<OrchestrationResult<OrchestrationActivityPage>>;
  // New activity entries while a watch of the run is held on this page. Returns the unsubscribe.
  onActivity(runId: string, listener: (event: OrchestrationActivityEvent) => void): () => void;
  changes(runId: string): Promise<OrchestrationResult<OrchestrationChanges>>;
  diff(runId: string, path: string): Promise<OrchestrationResult<OrchestrationDiff>>;
  // The same checks the start makes, without starting anything (no model, no run).
  readiness(input: { linkId: string; commands: string[]; workMode: OrchestrationWorkMode }): Promise<OrchestrationResult<OrchestrationReadiness>>;
  // Stage 13: the project settings of a link's lead project, and what the CLIs report they loaded there (no model turn).
  profile(linkId: string, capabilities?: boolean): Promise<OrchestrationResult<OrchestrationProfileInfo>>; // capabilities: asks the CLIs (settings only)
  saveProfile(linkId: string, profile: OrchestrationProjectProfile): Promise<OrchestrationResult<OrchestrationProjectProfile>>;
  // mcpReady: also check that Codex connects this project MCP server (an ephemeral thread, no turn; trusted folders only)
  probe(linkId: string, options?: { mcpReady?: string }): Promise<OrchestrationResult<OrchestrationEnvironmentReport>>;
}
