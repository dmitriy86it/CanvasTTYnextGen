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
  workMode: OrchestrationWorkMode; // a new project: "copy" (UX audit 2026-10-05, PR 5); a saved profile keeps its own
  checks: string[]; // the project's check commands
  prepare: { steps: OrchestrationPrepareStep[]; auto: boolean }; // auto: the autopilot runs the needed steps itself
  env: { direnv: boolean }; // apply an allowed .envrc (direnv) on top of the login shell
  access: { claude: string; codex: string }; // access.ts modes
  models?: OrchestrationRoleModels; // journal v2; absent — every role as in the CLI
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
// The model of each role, passed to that role's CLI for one thread or one run; null — as in the CLI: nothing is passed,
// the CLI's own configuration decides. The reviewer is the lead's CLI in a new session.
export interface OrchestrationRoleModels { lead: string | null; executor: string | null; reviewer: string | null }
// What Codex offers this account (model/list, no model turn) and the model its configuration names (config/read).
// ids: every model of the list, hidden ones included (a hidden one is still available); shown: the picker's own.
export interface OrchestrationCodexModels { ok: boolean; error: string | null; ids: string[]; shown: string[]; configModel: string | null; checkedAt: string }
export interface OrchestrationProfileInfo {
  profile: OrchestrationProjectProfile;
  saved: boolean;
  // journal v2 (development flag until A4): the check commands of a goal may be left empty, the lead proposes them
  optionalChecks?: boolean;
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
  // journal v2: the model of a role for this goal, over the project setting; null — as in the CLI (nothing is passed)
  models?: Partial<OrchestrationRoleModels>;
  language?: "ru" | "en"; // the interface language: agents write the texts the person reads in it
  // A CLI that does not offer the project's rights mode, run «as in my terminal» for this run only (confirmed by the
  // person in the dialog); the project settings stay as they are, the goal records the rights it ran with
  accessOverride?: Partial<Record<"claude" | "codex", "terminal">>;
  // B1 (journal v2 only, journal-v2-format.md §2.10): the board task this run works on. Older builds ignore it; it
  // changes nothing in the run, it only links the run to its task.
  task?: OrchestrationTaskRef;
  // B4 (owner's decision 11; journal v2, a separate copy only): start the copy from the result branch of the task `key`
  // this task depends on, at `commit` — instead of the project's working folder. The folder is not touched.
  base?: OrchestrationBaseRef;
}
export interface OrchestrationBaseRef { branch: string; commit: string; key: string }

import type { AutopilotBudget, AutopilotState, BoardPlace, BoardTask, BoardTaskInput, BoardTaskPatch, BoardView } from "./taskBoard.ts";

// A task of the board, as a run's goal names it: its id in orchestration/board.json and its number for people.
export interface OrchestrationTaskRef { id: string; key: string }

export interface OrchestrationCreateRequest {
  requestId: string; // UUID chosen by the renderer; it becomes the runId, so a repeat never creates a second run
  source: string; // absolute path of the project's Git repository (its top level)
  goal: OrchestrationGoalInput;
  // B3 (§4.2): the goal's task waits for other tasks (not «Done», or their result not where it would see it) and the
  // person confirmed «Start anyway». Without it such a start is refused (task_not_ready); the board's autopilot never
  // sets it. Not part of the request's identity.
  anyway?: boolean;
  // B4: the person chose to start without the branch a dependency's result is in (the working folder, another mode)
  withoutBase?: boolean;
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
  // journal v2 (journal-v2-format.md §2.1): «Принять» / «Изменить» of the lead's proposed check commands, and the
  // person's push/QA decision of a run completed without checks, for the tree and commit shown in the dialog
  | { kind: "checks.decide"; decision: "accept" | "edit"; checks?: string[] }
  | { kind: "finish.confirm"; tree: string; commit: string | null; push: "confirm" | "decline" | null; qa: "confirm" | "decline" | null }
  | { kind: "check.amend"; checkId: string; line: string }
  // A4 (journal-v2-format.md §2.9): the person's decisions, each about the state shown to them (runKey): a disputed
  // finding (new / repeat of a candidate), a person condition (met / not met), an open finding (close / to wish); and
  // a plan proposal that drops conditions or requirements (accept with a choice for each affected finding / return)
  | OrchestrationPersonDecide
  | OrchestrationPlanDecide
  | {
    kind: "permission"; requestId: string; decision: OrchestrationPermissionOption; answers?: Record<string, string[]>;
    content?: Record<string, unknown>; // an MCP form's values (accept)
    feedback?: string; // why a plan is sent back (Claude ExitPlanMode, deny)
  };

export type OrchestrationPersonDecide =
  | { kind: "person.decide"; subject: "disputed"; target: { reviewTurnId: string; index: number }; decision: "new" | "repeat"; finding: string | null; runKey: string }
  | { kind: "person.decide"; subject: "condition"; target: string; decision: "met" | "not_met"; finding: null; runKey: string }
  | { kind: "person.decide"; subject: "finding"; target: string; decision: "close" | "to_wish"; finding: null; runKey: string };
export interface OrchestrationPlanChoice { id: string; choice: "move" | "close" | "to_wish"; stage: number | null; condition: string | null }
export type OrchestrationPlanDecide =
  | { kind: "plan.decide"; proposalTurnId: string; decision: "accept"; choices: OrchestrationPlanChoice[]; note: null; runKey: string }
  | { kind: "plan.decide"; proposalTurnId: string; decision: "return"; choices: []; note: string | null; runKey: string };

// A4 (5h §3.5, §3.6, §4): what the person decides now, about the state they see — runKey and tree go with the decision;
// another state refuses it and shows the new one. disputed: the items waiting, with the closed candidates' texts;
// conditions: the person conditions asked now; findings: whether an open finding may be closed or made a wish on this
// pause; proposal: the plan proposal on coverage_lost, what it drops and what that leaves.
export interface OrchestrationDecisions {
  runKey: string; tree: string;
  disputed: { reviewTurnId: string; index: number; problem: string; evidence: string; paths: string[]; candidates: { id: string; problem: string; paths: string[] }[] }[];
  conditions: { id: string; text: string; stage: number }[];
  findings: boolean;
  proposal: null | {
    proposalTurnId: string;
    stages: { stage: number; title: string; conditions: string[] }[];
    dropped: { id: string; text: string; covers: string[]; why: string }[];
    dropRequirements: { id: string; text: string; why: string }[];
    uncovered: string[]; // requirements left without a condition in force, dropped with the proposal
    findings: { id: string; problem: string; condition: string }[]; // open blocking findings of dropped conditions: a choice each
  };
}

// A permission prompt or question of an agent's CLI, waiting for the person (stage 12). The CLI's own prompt: CanvasTTY
// only carries it, never answers it by itself. Texts are sanitized (no secrets, paths relative to the work folder).
// allow_run / allow_project (stage 13): CanvasTTY remembers the decision for exactly this action (same tool and
// parameters) for the rest of the run, or for the project; the CLI is told "allow once" each time.
// allow_readonly_run (1.5.13): offered after more than 3 prompts of read-only commands in a run (readOnly.ts); every
// later read-only command of this run is allowed without a dialog. Kept in memory: a restart asks again.
export type OrchestrationPermissionOption = "allow_once" | "allow_session" | "allow_run" | "allow_project" | "allow_readonly_run" | "deny";
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
  role: "lead" | "executor" | "reviewer";
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
  // B3 (§5.3 п. 4): why the CLI asks, as it said it (Claude: decision_reason_type / decision_reason; Codex: reason)
  why?: { type: string | null; text: string | null };
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
  // journal v2, on the pause awaiting_checks_decision: the lead's proposal (numbered by the application)
  proposal?: { checks: { id: string; command: string; why: string; source: string[] }[]; none: string | null } | null;
  // journal v2, on the pause awaiting_finish_confirmation: the tree and commit the decision is about (finish.confirm's
  // payload) and the steps the goal asked for
  confirm?: { tree: string | null; commit: string | null; push: boolean; qa: boolean } | null;
  // A1.1, on the pause check_needs_permissions: the lead's check the sandbox refused; check.amend is about it
  refused?: { checkId: string; command: string } | null;
  // A4: on a pause where the person decides (awaiting_person_decision, coverage_lost, or one a finding may be decided on)
  decisions?: OrchestrationDecisions | null;
  // journal v2: a plan proposal waits for the person's decision (whatever the pause); clarify and raise_limit are
  // refused until it is decided
  proposalWaits?: boolean;
  // A run whose journal a newer version of the application wrote (acceptance-review-spec.md §2.2): shown read-only
  // (status paused, reason newer_version), never opened or changed here. chain: the hash chain of what was read.
  // compatible: its journal declares minReaderVersion this build reads, so the view is its whole state (status and
  // reason as journaled), still read-only. fallback: it declared that, but a record did not replay by v1 rules
  // (line, code), so only its goal and records are shown.
  newer?: {
    version: number; chain: "ok" | "torn_tail" | "corrupt"; goal: string | null;
    compatible?: boolean; fallback?: { line: number; code: string } | null;
    preview?: boolean; // A4: a journal of an A1–A3 development build, shown read only once v2 is the person's
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
  models?: OrchestrationRoleModels | null; // the models the goal chose (null: as in the CLI); what ran is in the activity
  checks: { id: string; title: string; status: "passed" | "failed" | "not_verified" | "not_run"; class: "code" | "environment" | "external" | "sandbox" | null }[]; // the latest result of each
  prepare: { status: string; failed: string | null; class: "code" | "environment" | "external" | "sandbox" | null; command: string | null; output: { sha256: string; bytes: number } | null } | null;
  // version (QA): what the verification established about the deployed version (see OrchestrationQaVersion);
  // observed: the commit id the verification reported (only a validated id, never other output)
  // declined (journal v2): the person declined this step of a run completed without checks
  finish: { step: "commit" | "push" | "qa"; asked: boolean; status: string; established: boolean; commit: string | null; evidence: string | null; version?: OrchestrationQaVersion | null; observed?: string | null; declined?: boolean }[];
  grantsApplied: number;
  // journal v2 (journal-v2-format.md §2.3): a completed run's kind; no_checks is never shown as confirmed
  completion?: "confirmed" | "no_checks" | null;
  // journal v2: where the check commands came from — the goal, the lead's proposal as accepted, or edited by the person
  checksFrom?: "goal" | "proposal" | "edited" | null;
  // journal v2, A2 (journal-v2-format.md §2.7): requirements and readiness conditions with their evidence; null — the run
  // has none (v1, or a plan of A1's form)
  conditions?: OrchestrationConditions | null;
  // journal v2, A3 (journal-v2-format.md §2.8): the reviewer's findings; null — the lead reviews (v1, A1–A2 journals)
  findings?: OrchestrationFindings | null;
  // UX audit 2026-10-05, Н7: the limits and what is spent of them (the journal and the goal; tokens are in the activity).
  // calls: model calls (turns) per role; startedAt, deadlineAt: ms since the epoch; reached: the limit a limit_reached
  // pause stopped at
  budget?: {
    calls: Record<"lead" | "executor" | "reviewer", number>;
    limits: Record<OrchestrationLimitKind, number>;
    used: { turns: number; replans: number };
    startedAt: number; deadlineAt: number;
    reached: OrchestrationLimitKind | null;
  };
}

// F<n>: a finding of the reviewer, numbered by the application, never renumbered. stage: the stage that owns an open
// one now (null: the next plan's, or a closed one). history: what each review did with it, on which state and tree.
export interface OrchestrationFindings {
  items: {
    id: string; severity: "blocking" | "wish"; status: "open" | "closed"; condition: string | null; stage: number | null;
    problem: string; evidence: string; closeWhen: string; paths: string[]; possibleRepeatOf: string | null;
    // A4: by person — the person's command did it (closed_by_person, to_wish, moved; a disputed item's decision)
    history: {
      kind: "opened" | "closed" | "reopened" | "refused" | "disputed" | "unchanged" | "closed_by_person" | "to_wish" | "moved" | "decided";
      reviewTurnId: string | null; index: number | null; runKey: string; tree: string; reason: string | null; by: "reviewer" | "person"; note: string | null;
    }[];
    downgraded: boolean; // A4: a blocking finding the person made a wish — never shown as fixed
  }[];
  disputed: { reviewTurnId: string; index: number; problem: string; candidates: string[] }[]; // waiting for the person
  openBlocking: number;
}

// dropped (A4): a requirement the person dropped — shown as such, never as met
export type OrchestrationConditionStatus = "met" | "not_met" | "not_checked" | "dropped";
// R<n>: the n-th criterion of the goal. C<n>: a condition of the plans, numbered by the application. The proof of a
// condition is a check run (its output) or the lead's review answer; met counts conditions in force that are met.
// A4: evidence person — the person's decision (its command); stale — change evidence of an accepted stage whose files
// changed since (5h §3.7), counted only as the final review confirms it; dropped — the conditions and requirements the
// person dropped (plan.decided), with the lead's why.
export interface OrchestrationConditions {
  requirements: { id: string; text: string; conditions: string[]; status: OrchestrationConditionStatus; why?: string | null }[];
  conditions: {
    id: string; text: string; covers: string[]; stage: number; status: OrchestrationConditionStatus; stale?: boolean;
    evidence: { kind: "check"; check: string; command: string | null } | { kind: "change" } | { kind: "person" };
    proof: { checkRunId: string; output: { sha256: string; bytes: number } | null } | { reviewTurnId: string; paths: string[]; note: string }
      | { commandId: string; decision: "met" | "not_met" } | null;
  }[];
  dropped: { id: string; text: string; covers: string[]; why: string }[];
  met: number;
  total: number;
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
export type OrchestrationActivityRole = "lead" | "executor" | "reviewer" | "check" | "run";
export type OrchestrationActivityKind =
  | "task_sent" | "process_started" | "process_exited" | "session" | "thinking" | "message" | "tool_started" | "tool_finished"
  | "file_read" | "file_changed" | "subagent" | "usage" | "refusal" | "error" | "stderr" | "turn_finished"
  | "check_started" | "check_finished" | "check_output" | "status" | "truncated"
  | "permission_requested" | "permission_decided"
  | "permission_applied" | "prepare_started" | "prepare_finished" | "external_action" // stage 13
  | "report_note"; // stage A gate: the application's note about a model's report (a mark left out)
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

// «Забрать результат» (UX audit 2026-10-05, top-10 #10): the run's changes into the project, by the application.
// Only for a separate copy or worktree, a run that is completed, stopped or paused, with changes. Kept in a file of the
// run's workspace (taken.json), never in the journal.
export interface OrchestrationTake {
  mode: "copy" | "worktree";
  from: "checkpoint" | "current"; // the last checkpoint; without one the working copy as it is now
  stage: number | null; // the checkpoint's stage
  files: number; // changed against the run's base
  allowed: boolean; // the run's status allows it and there are changes
  suggested: string; // a free branch name: raoden/<goal>-<id>
  runBranch: string | null; // worktree: the run's branch as it is named now
  branch: { name: string; at: string } | null; // taken into this branch (this result)
  applied: { at: string } | null; // applied to the project folder (this result)
}
export type OrchestrationTakeInput = { action: "branch"; name: string } | { action: "apply" };
export interface OrchestrationTakeOutcome {
  // created / renamed: the branch is there; applied; already: this result was taken that way before (nothing done);
  // branch_exists: the name is taken (nothing done); invalid_name; conflict: «apply» does not fit the project's files now
  // (nothing written); unavailable: the run's status or mode does not allow it
  result: "created" | "renamed" | "applied" | "already" | "branch_exists" | "invalid_name" | "conflict" | "unavailable";
  files?: string[]; // conflict: the files the patch does not fit
  detail?: string; // conflict: git's words
  take: OrchestrationTake;
}

// Readiness of a goal before any model turn (stage 11): what the application can check, what is prepared, what the
// agents can do. A blocker refuses the start; a confirm item needs the user's explicit acknowledgement.
export type OrchestrationReadinessLevel = "ok" | "info" | "warning" | "confirm" | "blocker";
export interface OrchestrationReadinessItem {
  // stable: platform, clis, env, git, workdir, busy, stack, laravel, commands, command_<n>, tests, model, permissions;
  // before the start: auth_codex, auth_claude, model_claude, sandbox, sandbox_git, and with full: source, source_prepare, source_<n>
  id: string;
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
  expanded?: { width: number; height: number }; // the size "Expand" returns to (1.5.13); absent: the default expanded size
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
// A4 (journal-v2-format.md §2.9): a closed finding the person closed — its last opening or closing event is the
// person's close (later events, a disputed repeat or its refusal, do not change who closed it).
export function closedByPerson(f: { status: string; history: readonly { kind: string }[] }): boolean {
  return f.status === "closed" && f.history.filter((h) => ["opened", "reopened", "closed", "closed_by_person"].includes(h.kind)).at(-1)?.kind === "closed_by_person";
}

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
  // expanded: the size "Expand" returns to — undefined keeps the saved one
  moveAgent(agentId: string, bounds: OrchestrationBounds, expanded?: OrchestrationBounds["size"]): Promise<OrchestrationResult<OrchestrationAgentCard>>;
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
  startOnLink(input: { linkId: string; requestId: string; goal: OrchestrationGoalInput; anyway?: boolean; withoutBase?: boolean }): Promise<OrchestrationResult<{ runId: string; created: boolean }>>;
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
  take(runId: string): Promise<OrchestrationResult<OrchestrationTake>>;
  takeResult(runId: string, input: OrchestrationTakeInput): Promise<OrchestrationResult<OrchestrationTakeOutcome>>;
  // B1: the task board (stage-b-board.md). board(): the board as stored and the facts of its tasks' runs; the statuses
  // are worked out by boardStatuses (shared/taskBoard.ts). boardAccept: «Accept the result» of a run completed without checks.
  board(): Promise<OrchestrationResult<BoardView>>;
  boardCreate(input: BoardTaskInput): Promise<OrchestrationResult<BoardTask>>;
  boardUpdate(id: string, patch: BoardTaskPatch): Promise<OrchestrationResult<BoardTask>>;
  boardArchive(id: string, archived: boolean): Promise<OrchestrationResult<BoardTask>>;
  // dependents: the tasks the person was shown as losing this dependency (task_has_dependents otherwise)
  boardRemove(id: string, dependents?: string[]): Promise<OrchestrationResult<null>>;
  boardAccept(id: string): Promise<OrchestrationResult<BoardTask>>;
  boardPlace(workspaceId: string, bounds: BoardPlace | null): Promise<OrchestrationResult<null>>; // B2: the card's place, null: hidden
  // B4: the board's autopilot of a link on or off (never stored); its budget in board.json (null: the default)
  boardAutopilot(linkId: string, on: boolean, language: "ru" | "en"): Promise<OrchestrationResult<AutopilotState | null>>;
  boardBudget(linkId: string, budget: AutopilotBudget | null): Promise<OrchestrationResult<null>>;
  // The same checks the start makes, without starting anything (no model, no run).
  // full: «Проверить сейчас» — also the preparation and the commands on the source (a temporary work folder), within timeoutMs
  readiness(input: { linkId: string; commands: string[]; workMode: OrchestrationWorkMode; models?: Partial<OrchestrationRoleModels>; accessOverride?: Partial<Record<"claude" | "codex", "terminal">>; full?: boolean; timeoutMs?: number }): Promise<OrchestrationResult<OrchestrationReadiness>>;
  // The models Codex offers (model/list and config/read, no model turn), kept for the application's session; refresh:
  // ask Codex again (the «Обновить» button).
  codexModels(linkId: string, refresh?: boolean): Promise<OrchestrationResult<OrchestrationCodexModels>>;
  // Stage 13: the project settings of a link's lead project, and what the CLIs report they loaded there (no model turn).
  profile(linkId: string, capabilities?: boolean): Promise<OrchestrationResult<OrchestrationProfileInfo>>; // capabilities: asks the CLIs (settings only)
  // confirmTerminal: the person confirmed the warning of "as in my terminal" (needed to switch a CLI to it; not saved)
  saveProfile(linkId: string, profile: OrchestrationProjectProfile & { confirmTerminal?: boolean }): Promise<OrchestrationResult<OrchestrationProjectProfile>>;
  // mcpReady: also check that Codex connects this project MCP server (an ephemeral thread, no turn; trusted folders only)
  probe(linkId: string, options?: { mcpReady?: string }): Promise<OrchestrationResult<OrchestrationEnvironmentReport>>;
}
