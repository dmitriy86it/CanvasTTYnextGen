// Run journal v1 (docs/agent-orchestration/implementation/stage-2-contract.md): canonical JSON, record hash,
// strict event schemas, byte-level parsing with ok/torn_tail/corrupt classification and a pure replay.
// Nothing here touches the file system; store.ts owns files, locks and the writer.
import { createHash } from "node:crypto";
import type { ReportStatus, TurnOutcome } from "./types.ts";
import { applyPlan, changeIdsOf, emptyBook, factsOf, personIdsOf, planProblems } from "./conditions.ts";
import { replayFindings } from "./findings.ts";
import type { Applied, PlanChoices } from "./findings.ts";
import type { ConditionMark, PlanText, RequirementMark, Status } from "./conditions.ts";

export const JOURNAL_VERSION = 1; // new runs, unless the run asks for v2 (journal-v2-format.md, behind a dev flag in A1)
// A4 (journal-v2-format.md §3.4, §2.9): v2 for the person's runs — new native runs written in v2 without the
// development flag, and the journals of A1–A3 development builds (formatPreview) shown read only. The one switch of
// that; off until the real series on real CLIs.
export const JOURNAL_V2_BY_DEFAULT = false;
// The highest journal version this build reads and writes as its own: above it a journal is a newer version's (A0).
export const MAX_JOURNAL_VERSION = 2;
// The highest minReaderVersion this build can read: a newer journal that declares it is replayed by the rules of that
// version (v1 or v2), its unknown fields ignored.
export const READER_VERSION = 2;
// The first record of a v2 journal declares it (journal-v2-format.md §3.1): a build that reads v1 only (1.5.7, A0)
// shows it read only, never as a state it would get wrong.
export const V2_MIN_READER_VERSION = 2;
// check.started.profileSha256 of a check run in the user's login shell without a sandbox (userCheck.ts, stage 12)
export const NO_SANDBOX_SHA256 = createHash("sha256").update("canvastty:no-sandbox:user-shell").digest("hex");
export const ZERO_HASH = "0".repeat(64);
export const MAX_LINE_BYTES = 64 * 1024; // one record, without '\n'
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
export const MAX_TEXT_BYTES = 65_536;

export const RUN_STATUSES = ["preparing", "running", "pausing", "paused", "stopping", "stopped", "completed", "failed"] as const;
export const TERMINAL_STATUSES: readonly string[] = ["stopped", "completed", "failed"];
// ARCHITECTURE-PROPOSAL §7. Parameters (awaiting_answer{questionId}, protocol_error{kind}, limit_reached{kind})
// are not part of run.status v1: the reason is the bare name.
export const PAUSED_REASONS = [
  "user_request", "step_done", "plan_review", "awaiting_answer", "recovered", "outcome_unknown", "invalid_report",
  "protocol_error", "limit_reached", "permission_denied", "loop_suspected", "lead_modified_tree", "environment_error",
  "shared_git_tampered", "journal_corrupt", "sandbox_unavailable",
  // stage 13
  "stage_done", "external_failure", "needs_user_action", "finish_unconfirmed",
  "app_closed" // the application closed while the run worked (older journals say user_request)
] as const;
// v2 only (journal-v2-format.md §2.1): waiting for the decision on the lead's proposed check commands, and for the
// person's confirmation of push/QA of a run without checks; A1.1: a lead's check the sandbox refused (§2.6).
// A3 (§2.8): the tree changed during two reviews in a row; a disputed finding or a person condition waits for the
// person. A4 (5h §3.6): a plan proposal that drops conditions or requirements waits for the person.
export const PAUSED_REASONS_V2 = [...PAUSED_REASONS, "awaiting_checks_decision", "awaiting_finish_confirmation", "check_needs_permissions",
  "tree_changed_during_review", "awaiting_person_decision", "coverage_lost"] as const;
const TURN_OUTCOMES: readonly string[] = ["completed", "invalid_report", "delivery_failed", "failed", "stopped", "timeout",
  "protocol_error", "cleanup_unverified", "harness_error"];
const REPORT_STATUSES: readonly string[] = ["valid", "invalid_json", "schema_mismatch", "missing", "too_large", "not_checked"];

export type RunStatus = (typeof RUN_STATUSES)[number];
export type PausedReason = (typeof PAUSED_REASONS_V2)[number];
export type TextRef = { sha256: string; bytes: number };
export type ProviderOutcome = TurnOutcome | "contract_violation";

export type EventType =
  | "run.created"
  | "run.status"
  | "command.received"
  | "command.completed"
  | "turn.intent"
  | "turn.finished"
  | "run.recovered"
  | "journal.tail_repaired"
  | "workspace.created"
  | "snapshot.created"
  | "checkpoint.created"
  | "workspace.restore_started"
  | "workspace.restore_failed"
  | "workspace.restored"
  | "check.started"
  | "check.finished"
  | "orch.turn"
  | "plan.recorded"
  | "review.recorded"
  | "question.asked"
  | "question.answered"
  | "check.assessed"
  | "stage.accepted"
  | "clarification.added"
  | "limits.changed"
  | "recovery.decided"
  // stage 13
  | "prepare.started"
  | "prepare.finished"
  | "check.classified"
  | "permission.granted"
  | "permission.applied"
  | "finish.intent"
  | "finish.result"
  // journal v2 (A1)
  | "checks.proposed"
  | "checks.decided"
  | "checks.amended" // A1.1
  | "finish.confirmed"
  | "review.assessed" // A3
  | "review.discarded"
  | "plan.proposed" // A4
  | "plan.decided"
  | "person.decided";

export const STAGE13_EVENTS = ["prepare.started", "prepare.finished", "check.classified", "permission.granted",
  "permission.applied", "finish.intent", "finish.result"] as const;
export type Stage13Event = (typeof STAGE13_EVENTS)[number];
export const V2_EVENTS = ["checks.proposed", "checks.decided", "finish.confirmed", "checks.amended", "review.assessed", "review.discarded",
  "plan.proposed", "plan.decided", "person.decided"] as const;
export type V2Event = (typeof V2_EVENTS)[number];

export type CommandResult = { status: "accepted" | "rejected"; code: string | null };

export interface JournalRecord {
  v: 1 | 2;
  minReaderVersion?: number; // v2: the first record only
  formatPreview?: true; // v2: the first record of a journal written by a development build of A1–A3 (A4 writes none)
  seq: number;
  ts: string;
  runId: string;
  type: EventType;
  prevHash: string;
  hash: string;
  data: Record<string, unknown>;
}

export interface TurnState {
  status: "in_flight" | "outcome_unknown" | ProviderOutcome;
  commandId: string | null;
  role: "lead" | "executor" | "reviewer"; // reviewer: v2 only (A3)
  provider: "codex" | "claude";
  mode: string;
  sessionId: string | null; // from turn.intent, replaced by turn.finished
  task: TextRef;
  nextTurnAllowed: boolean;
  report: { status: ReportStatus; ref: TextRef | null; storeError: ReportStoreError | null } | null;
}

// Why a report the provider produced was not stored (stage-2-contract.md, review fixes): never truncated or emptied.
export type ReportStoreError = "too_large" | "write_failed";

export interface CommandState {
  status: "received" | "completed" | "unfinished";
  kind: string;
  payloadHash: string;
  result: CommandResult | null;
}

// Workspace facts (stage-3-contract.md): only Git object ids and numbers; the source path lives in workspace.json.
export interface WorkspaceSnapshot { kind: "recovery" | "intermediate"; ref: string; commit: string; tree: string }
export interface WorkspaceRestore { target: string; targetCommit: string; recoveryCommit: string }
// A restore that started writing and was not confirmed: the copy is partially restored or its state is unknown.
export interface WorkspaceFailedRestore extends WorkspaceRestore { result: "partial" | "unknown" }
export interface WorkspaceState {
  sourcePathSha256: string;
  baseline: { commit: string; tree: string };
  head: string | null;
  checkpoints: Record<string, { commit: string; tree: string; parent: string }>; // key: stage number as a string
  snapshots: WorkspaceSnapshot[];
  current: { commit: string; tree: string }; // the applicable base of the copy: baseline, then confirmed checkpoints and restores
  pendingRestore: WorkspaceRestore | null; // restore_started without restored: the copy's state is unknown
  failedRestore: WorkspaceFailedRestore | null; // the last attempt left the copy partial or unknown; pendingRestore stays
  lastRestore: WorkspaceRestore | null;
}

// Project checks run in the managed copy (stage-4-contract.md). A check that started and was never finished stays
// not_verified(interrupted) after reopening: nothing is re-run automatically.
export type CheckStatus = "passed" | "failed" | "not_verified";
export type NotVerifiedReason =
  | "sandbox_unavailable" | "spawn_failed" | "timeout" | "stopped" | "output_limit"
  | "cleanup_unverified" | "deps_changed" | "tree_changed" | "workspace_unverified"
  | "restore_incomplete" | "interrupted" | "store_failed";

export interface CheckState {
  checkId: string;
  status: CheckStatus | "in_flight";
  reason: NotVerifiedReason | null;
  base: { commit: string; tree: string };
  treeBefore: string;
  treeAfter: string | null;
  profileSha256: string;
  commandSha256: string;
  exitCode: number | null;
  signal: string | null;
  groupCleared: boolean | null;
  output: TextRef | null;
  outputDropped: number;
  evidenceFingerprint: string | null;
  durationMs: number | null;
}

export type CompletionKind = "confirmed" | "no_checks";
export interface RunState {
  runId: string;
  version: 1 | 2; // the first record's v (journal-v2-format.md §1)
  preview: boolean; // v2 written by a development build of A1–A3 (formatPreview)
  completion: { kind: CompletionKind; basis: TextRef } | null; // v2: the completed status' result of the completion function
  status: RunStatus;
  pausedReason: PausedReason | null;
  lastSeq: number;
  lastHash: string;
  goal: TextRef;
  turns: Record<string, TurnState>;
  commands: Record<string, CommandState>;
  workspace: WorkspaceState | null;
  checks: Record<string, CheckState>; // key: checkRunId
  orch: OrchState;
}

// Orchestration events (stage-5-contract.md §8): the data of each event exactly as written to the journal.
export type TurnPurpose = "plan" | "execute" | "review" | "final_review";
export type LimitKind = "turns" | "roundsPerStage" | "replans" | "runMs";
export type ReviewVerdict = "accept" | "fix" | "replan" | "question" | "complete";
export type RecoveryAction = "accept" | "retry_turn" | "reset_to_checkpoint";
export interface OrchTurnData {
  turnId: string; purpose: TurnPurpose; stage: number | null; round: number | null;
  planVersion: number | null; clarificationVersion: number;
  tree?: string | null; // v2, A3 (§2.8): the tree before a reviewer's turn, null for any other turn; absent in A1–A2
}
export interface PlanRecordedData { turnId: string; version: number; plan: TextRef; firstStage: number; stageCount: number; conditionsAssigned?: number }
// conditionsAssigned absent: a plan of A1's form or of v1 (no conditions; journal-v2-format.md §2.7)
// base: the first number C<base> its new conditions take (v2: from the records' conditionsAssigned, proposals included);
// proposed: in force by the person's plan.decided(accept) of a proposal (A4)
export interface PlanState { version: number; turnId: string; ref: TextRef; firstStage: number; stageCount: number; conditionsAssigned?: number; seq: number; base?: number; proposed?: true }
// A4 (5h §2.4, §3.6): a plan that drops conditions or requirements, waiting for the person; never in force by itself
export interface ProposalState {
  turnId: string; ref: TextRef; firstStage: number; stageCount: number; conditionsAssigned: number; base: number; seq: number;
  decision: { decision: "accept" | "return"; commandId: string; choices: TextRef; note: TextRef | null; runKey: string; tree: string; seq: number } | null;
}
// A4 (5h §3.5, journal-v2-format.md §2.9): the person's decision outside a plan — on whose command, about which state
// (runKey, tree) and what. disputed: target is the item {reviewTurnId, index}; finding the new number (new) or the
// chosen candidate (repeat), reopened whether the repeat opened it again.
export type PersonSubject = "condition" | "finding" | "disputed";
export interface PersonDecision {
  commandId: string; subject: PersonSubject; target: string | { reviewTurnId: string; index: number };
  decision: "met" | "not_met" | "close" | "to_wish" | "new" | "repeat"; finding: string | null; reopened: boolean | null;
  runKey: string; tree: string; seq: number;
}
export interface ReviewRecordedData {
  turnId: string; stage: number | null; verdict: ReviewVerdict; findings: TextRef | null; findingsKey: string;
  findingsCount: number; clarificationVersion: number; runKey: string;
}
// A3 (5h §2.4): the reviewer's result — its report and what the application did with it. Replayed into orch.reviews
// with the verdict it amounts to (request none: accept / complete) and these refs; the application, not a verdict,
// decides the stage (§2.8).
export type ReviewRequest = "none" | "replan" | "question";
export interface ReviewAssessedData {
  turnId: string; stage: number | null; request: ReviewRequest; report: TextRef; applied: TextRef; clarificationVersion: number; runKey: string;
}
export interface ReviewDiscardedData { turnId: string; treeBefore: string; treeAfter: string }
export interface QuestionAskedData { questionId: string; turnId: string; text: TextRef }
export interface QuestionAnsweredData { questionId: string; commandId: string; text: TextRef }
export interface CheckAssessedData { checkRunId: string; stage: number | null; round: number | null; checkKey: string; runKey: string }
export interface StageAcceptedData { stage: number; reviewTurnId: string; tree: string }
export interface ClarificationAddedData { version: number; commandId: string; text: TextRef }
export interface LimitsChangedData { commandId: string; kind: LimitKind; value: number }
export interface RecoveryDecidedData { commandId: string; action: RecoveryAction; turnId: string }

// Stage 13 facts.
export type FailureClass = "code" | "environment" | "external" | "sandbox"; // sandbox: v2 only (journal-v2-format.md §2.6)
export type FinishStep = "commit" | "push" | "qa";
export type FinishStatus = "done" | "failed" | "not_done" | "unknown";
export type QaVersion = "confirmed" | "mismatch" | "not_reported" | "invalid" | "not_checked";
export interface PrepareState {
  prepareId: string; reason: "start" | "check"; steps: TextRef; seq: number;
  status: "in_flight" | "interrupted" | "done" | "not_needed" | "failed" | "stopped";
  failed: number | null; class: FailureClass | null; output: TextRef | null; finishedSeq: number | null;
  locks?: Record<string, string>; before?: string; after?: string;
}
export interface FinishState {
  intentId: string; step: FinishStep; params: TextRef; seq: number;
  // in_flight: the action may be running now; outcome_unknown: it was started and the application ended before its
  // result was recorded — never repeated before its real outcome is established
  status: "in_flight" | "outcome_unknown" | FinishStatus;
  established: boolean; evidence: TextRef | null; commit: string | null; resultSeq: number | null;
  tree?: string | null; // absent in older journals
  // QA: what the verification established about the deployed version, and the commit id it reported (validated)
  version?: QaVersion; observed?: string | null;
}

export interface OrchState {
  // run.status records plus command.completed(accepted). The status change implied by run.recovered is NOT counted:
  // it is not a run.status record, and counting it would make revision depend on how often the run was reopened.
  revision: number;
  turns: Record<string, Omit<OrchTurnData, "turnId"> & { seq: number }>; // from orch.turn
  plan: PlanState | null;
  plans: PlanState[]; // every plan.recorded, in order (A2: the conditions of accepted stages come from earlier plans)
  planReviewPaused: boolean; // a run.status paused(plan_review) was applied while the plan was version 1; never reset
  reviews: (ReviewRecordedData & { seq: number; assessed?: { request: ReviewRequest; report: TextRef; applied: TextRef } })[]; // in journal order; findings kept so a fix task can quote them
  accepted: Record<string, { reviewTurnId: string; tree: string; seq: number }>; // key: stage number as a string
  pendingCheckpoint: number | null; // the accepted stage whose checkpoint.created is not in the journal yet
  clarifications: number; // version of the clarifications
  clarificationRefs: TextRef[]; // texts of clarification.added, in version order
  clarificationSeqs: number[];
  question: { // the last one
    questionId: string; turnId: string; ref: TextRef; answered: boolean; seq: number;
    answerRef: TextRef | null; answeredSeq: number | null;
  } | null;
  answers: number;
  answerSeqs: number[]; // seq of every question.answered
  lastPausedSeq: Partial<Record<PausedReason, number>>; // seq of the last run.status paused(<reason>)
  assessed: Record<string, { stage: number | null; round: number | null; checkKey: string; runKey: string; seq: number }>;
  limitOverrides: Partial<Record<LimitKind, number>>;
  recoveryDecisions: Record<string, RecoveryAction>; // turnId -> action
  // stage 13
  prepares: PrepareState[];
  classified: Record<string, FailureClass>; // checkRunId -> class of its failure
  grants: Record<string, { grantId: string; scope: "run" | "project"; seq: number }>; // fingerprint -> the grant
  applied: number;
  finish: FinishState[];
  // journal v2 (journal-v2-format.md §2.1)
  lastOrchTurn: string | null;
  checksProposal: { turnId: string; ref: TextRef; count: number; sandboxNetwork: SandboxNetwork; seq: number } | null;
  checksDecision: { decision: "accept" | "edit"; by: "autopilot" | "person"; commandId: string | null; ref: TextRef; count: number; seq: number } | null;
  confirmations: FinishConfirmation[];
  // A1.1 (§2.6): the checks the person let run without the sandbox, or changed (line: the new command line)
  amended: Record<string, { commandId: string; line: TextRef; seq: number }>;
  // A3 (§2.8, 5h §3.1.1): reviews dropped because the tree changed during them, and the person's leave for one more
  // reviewer turn of a key (resume/step from tree_changed_during_review, recovery.decided of a reviewer's turn)
  discarded: Record<string, { treeBefore: string; treeAfter: string; seq: number }>;
  reviewPermits: { key: string; seq: number }[];
  // A4: the next free condition number C<n> (plans and proposals take theirs), every plan proposal in order, the
  // person's decisions, and the commands whose decision record is in the journal (5h §3.5: accepted after a crash)
  nextCondition: number;
  proposals: ProposalState[];
  person: PersonDecision[];
  decidedCommands: string[];
}
export type SandboxNetwork = "denied" | "open";
export type FinishDecision = "confirm" | "decline";
export interface FinishConfirmation { commandId: string; tree: string; commit: string | null; push: FinishDecision | null; qa: FinishDecision | null; seq: number }

export type CorruptCode =
  | "invalid_json"
  | "invalid_utf8"
  | "non_canonical"
  | "unsupported_version"
  | "invalid_event"
  | "bad_seq"
  | "bad_prev_hash"
  | "bad_hash"
  | "wrong_run"
  | "line_too_large"
  | "journal_too_large"
  | "invalid_transition"
  | "replay_conflict";

export type ChainIntegrity =
  | { status: "ok" }
  | { status: "torn_tail"; detail: { offset: number; bytes: number } }
  | { status: "corrupt"; detail: { line: number; offset: number; code: CorruptCode; phase?: "texts" } }; // line is 1-based; phase: v2 second stage
// newer_version: written by a newer version (acceptance-review-spec.md §2.2): only its hash chain is checked (chain), no
// record is replayed, and nothing may write to it. fallback: it declared minReaderVersion this build can read, but a
// record did not replay by v1 rules (line, code), so it is shown like any other newer journal.
// newer_version_compatible: a newer journal whose first record declares minReaderVersion ≤ READER_VERSION: replayed by
// v1 rules (unknown fields ignored), shown whole, and still never written (acceptance-review-spec.md §2.2.1).
// version_changed: a record of another v than the first one (the version and minReaderVersion are the first record's).
export type NewerFallback = { line: number; code: "unknown_record" | "invalid_event" | "replay_conflict" | "version_changed" };
export type JournalIntegrity = ChainIntegrity
  | { status: "newer_version"; detail: { version: number; chain: ChainIntegrity; fallback?: NewerFallback; preview?: true } }
  | { status: "newer_version_compatible"; detail: { version: number; minReaderVersion: number; chain: ChainIntegrity; skipped: number } };

export class JournalError extends Error {
  readonly code: CorruptCode;

  constructor(code: CorruptCode, message: string) {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const RECORD_KEYS = ["data", "hash", "prevHash", "runId", "seq", "ts", "type", "v"];

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export const isSha256 = (v: unknown): v is string => typeof v === "string" && SHA256.test(v);
// A Git object id: SHA-1 (40 hex) or SHA-256 (64 hex) repositories.
export const isGitOid = (v: unknown): v is string => typeof v === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v);
const SNAPSHOT_REF = /^refs\/canvastty\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/recovery-[1-9]\d{0,8}|snapshot\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const RESTORE_TARGET = /^(?:baseline|stage-[1-9]\d{0,8})$/;
const isRestore = (v: unknown) => exactKeys(v, ["target", "targetCommit", "recoveryCommit"]) && typeof v.target === "string"
  && RESTORE_TARGET.test(v.target) && isGitOid(v.targetCommit) && isGitOid(v.recoveryCommit);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isPos = (v: unknown): v is number => isInt(v) && v >= 1;
const isNonNeg = (v: unknown): v is number => isInt(v) && v >= 0;
const TURN_PURPOSES: readonly string[] = ["plan", "execute", "review", "final_review"];
const STAGE_VERDICTS: readonly string[] = ["accept", "fix", "replan", "question"];
const FINAL_VERDICTS: readonly string[] = ["complete", "replan", "question"];
const LIMIT_KINDS: readonly string[] = ["turns", "roundsPerStage", "replans", "runMs"];
const RECOVERY_ACTIONS: readonly string[] = ["accept", "retry_turn", "reset_to_checkpoint"];
const FAILURE_CLASSES: readonly string[] = ["code", "environment", "external"];
const FINISH_STEPS: readonly string[] = ["commit", "push", "qa"];
const FINISH_STATUSES: readonly string[] = ["done", "failed", "not_done", "unknown"];
const QA_VERSIONS: readonly QaVersion[] = ["confirmed", "mismatch", "not_reported", "invalid", "not_checked"];
const PREPARE_STATUSES: readonly string[] = ["done", "not_needed", "failed", "stopped"];
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const strOrNull = (v: unknown, max: number) => v === null || str(v, max);
const oneOf = (v: unknown, list: readonly string[]) => typeof v === "string" && list.includes(v);
// Lenient validation of a compatible newer record (minReaderVersion): every object a key check accepted is noted with
// the keys it knows, extra keys are allowed, and the record is then projected onto those keys. null: v1 (strict).
let known: WeakMap<object, Set<string>> | null = null;
const note = (o: Record<string, unknown>, keys: readonly string[]): true => {
  const set = known!.get(o) ?? new Set<string>();
  for (const k of keys) set.add(k);
  known!.set(o, set);
  return true;
};
const exactKeys = (o: unknown, keys: readonly string[]): o is Record<string, unknown> =>
  known ? isRecord(o) && keys.every((k) => Object.hasOwn(o, k)) && note(o, keys)
    : isRecord(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
// All of `keys` and nothing but them and `optional` (fields added later: older journals stay valid).
const keysWithin = (o: unknown, keys: readonly string[], optional: readonly string[]): o is Record<string, unknown> =>
  known ? isRecord(o) && keys.every((k) => Object.hasOwn(o, k)) && note(o, [...keys, ...optional])
    : isRecord(o) && keys.every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => keys.includes(k) || optional.includes(k));
const isLocks = (v: unknown) => isRecord(v) && Object.keys(v).length <= 16
  && Object.entries(v).every(([k, x]) => k.length > 0 && k.length <= 100 && isSha256(x));

export const isTextRef = (v: unknown): v is TextRef =>
  exactKeys(v, ["sha256", "bytes"]) && isSha256(v.sha256) && isInt(v.bytes) && v.bytes >= 0 && v.bytes <= MAX_TEXT_BYTES;

// Keys sorted by UTF-16 code units, no whitespace, strings and numbers as JSON.stringify.
// Throws TypeError for anything that is not string/boolean/null/finite number/array/plain object.
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) out += (i ? "," : "") + canonical(value[i]); // a hole is undefined: throws
    return out + "]";
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("canonical JSON: not a plain object");
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  throw new TypeError(`canonical JSON: unsupported ${typeof value}`);
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

const DATA_SCHEMAS: Record<Exclude<EventType, V2Event>, (d: Record<string, unknown>) => boolean> = {
  "run.created": (d) => exactKeys(d, ["goal"]) && isTextRef(d.goal),
  "run.status": (d) => exactKeys(d, ["status", "reason"]) && oneOf(d.status, RUN_STATUSES)
    && (d.status === "paused" ? oneOf(d.reason, PAUSED_REASONS) : d.reason === null),
  "command.received": (d) => exactKeys(d, ["commandId", "kind", "payloadHash"]) && isUuid(d.commandId)
    && str(d.kind, 64) && (d.kind as string).length > 0 && isSha256(d.payloadHash),
  "command.completed": (d) => exactKeys(d, ["commandId", "result"]) && isUuid(d.commandId)
    && exactKeys(d.result, ["status", "code"]) && oneOf(d.result.status, ["accepted", "rejected"]) && strOrNull(d.result.code, 64),
  "turn.intent": (d) => exactKeys(d, ["turnId", "commandId", "role", "provider", "mode", "sessionId", "task"])
    && isUuid(d.turnId) && (d.commandId === null || isUuid(d.commandId)) && oneOf(d.role, ["lead", "executor"])
    && oneOf(d.provider, ["codex", "claude"]) && str(d.mode, 64) && strOrNull(d.sessionId, 128) && isTextRef(d.task),
  "turn.finished": (d) => exactKeys(d, ["turnId", "outcome", "nextTurnAllowed", "sessionId", "contract", "report", "transport"])
    && isUuid(d.turnId) && (oneOf(d.outcome, TURN_OUTCOMES) || d.outcome === "contract_violation")
    && typeof d.nextTurnAllowed === "boolean" && (!d.nextTurnAllowed || d.outcome === "completed")
    && strOrNull(d.sessionId, 128)
    && exactKeys(d.contract, ["status", "errors"]) && oneOf(d.contract.status, ["verified", "violated"])
    && Array.isArray(d.contract.errors) && d.contract.errors.length <= 16 && d.contract.errors.every((e) => str(e, 256))
    && exactKeys(d.report, ["status", "ref", "storeError"]) && oneOf(d.report.status, REPORT_STATUSES)
    && (d.report.ref === null || isTextRef(d.report.ref))
    && (d.report.storeError === null || oneOf(d.report.storeError, ["too_large", "write_failed"]))
    // a report that was not stored has no ref and never allows a next turn; a valid stored report has a ref
    && (d.report.storeError === null || (d.report.ref === null && d.nextTurnAllowed === false))
    && (d.report.status !== "valid" || d.report.storeError !== null || d.report.ref !== null)
    && exactKeys(d.transport, ["outcome", "exitCode", "signal", "groupCleared"]) && oneOf(d.transport.outcome, TURN_OUTCOMES)
    && (d.transport.exitCode === null || isInt(d.transport.exitCode)) && strOrNull(d.transport.signal, 64)
    && typeof d.transport.groupCleared === "boolean",
  "run.recovered": (d) => exactKeys(d, ["unfinishedTurns", "unfinishedCommands", "previousStatus"])
    && Array.isArray(d.unfinishedTurns) && d.unfinishedTurns.every(isUuid)
    && Array.isArray(d.unfinishedCommands) && d.unfinishedCommands.every(isUuid) && oneOf(d.previousStatus, RUN_STATUSES),
  "workspace.created": (d) => exactKeys(d, ["sourcePathSha256", "baseline", "head"]) && isSha256(d.sourcePathSha256)
    && exactKeys(d.baseline, ["commit", "tree"]) && isGitOid(d.baseline.commit) && isGitOid(d.baseline.tree)
    && (d.head === null || isGitOid(d.head)),
  "snapshot.created": (d) => exactKeys(d, ["kind", "ref", "commit", "tree"]) && oneOf(d.kind, ["recovery", "intermediate"])
    && typeof d.ref === "string" && SNAPSHOT_REF.test(d.ref)
    && (d.kind === "recovery") === d.ref.includes("/recovery-") && isGitOid(d.commit) && isGitOid(d.tree),
  "checkpoint.created": (d) => exactKeys(d, ["stage", "commit", "tree", "parent"]) && isInt(d.stage) && d.stage >= 1
    && isGitOid(d.commit) && isGitOid(d.tree) && isGitOid(d.parent),
  "workspace.restore_started": (d) => isRestore(d),
  "workspace.restore_failed": (d) => exactKeys(d, ["target", "targetCommit", "recoveryCommit", "result"])
    && isRestore({ target: d.target, targetCommit: d.targetCommit, recoveryCommit: d.recoveryCommit })
    && oneOf(d.result, ["partial", "unknown"]),
  "workspace.restored": (d) => isRestore(d),
  "check.started": (d) => exactKeys(d, ["checkRunId", "checkId", "commandSha256", "base", "treeBefore", "profileSha256"])
    && isUuid(d.checkRunId) && isCheckId(d.checkId) && isSha256(d.commandSha256) && isSha256(d.profileSha256)
    && exactKeys(d.base, ["commit", "tree"]) && isGitOid(d.base.commit) && isGitOid(d.base.tree) && isGitOid(d.treeBefore),
  "check.finished": (d) => exactKeys(d, ["checkRunId", "status", "reason", "exitCode", "signal", "groupCleared",
    "treeAfter", "output", "outputDropped", "evidenceFingerprint", "durationMs"])
    && isUuid(d.checkRunId) && oneOf(d.status, CHECK_STATUSES)
    && (d.reason === null ? d.status !== "not_verified" : d.status === "not_verified" && oneOf(d.reason, NOT_VERIFIED_REASONS))
    && (d.exitCode === null || isInt(d.exitCode)) && strOrNull(d.signal, 64) && typeof d.groupCleared === "boolean"
    && (d.treeAfter === null || isGitOid(d.treeAfter)) && (d.output === null || isTextRef(d.output))
    && isInt(d.outputDropped) && d.outputDropped >= 0 && isSha256(d.evidenceFingerprint)
    && isInt(d.durationMs) && d.durationMs >= 0
    // a verdict of the tool itself: it ran to its own end with the process group cleared
    && (d.status !== "passed" || (d.exitCode === 0 && d.groupCleared === true))
    && (d.status !== "failed" || (d.exitCode !== null && d.exitCode !== 0 && d.groupCleared === true)),
  "journal.tail_repaired": (d) => exactKeys(d, ["offset", "bytes", "sha256", "quarantine"]) && isInt(d.offset) && d.offset >= 0
    && isInt(d.bytes) && d.bytes > 0 && isSha256(d.sha256) && typeof d.quarantine === "string"
    && /^torn-\d+-[0-9a-f]{64}\.bin$/.test(d.quarantine),
  // plan and final_review have no stage/round; execute and review have both
  "orch.turn": (d) => exactKeys(d, ["turnId", "purpose", "stage", "round", "planVersion", "clarificationVersion"])
    && isUuid(d.turnId) && oneOf(d.purpose, TURN_PURPOSES)
    && (d.purpose === "plan" || d.purpose === "final_review" ? d.stage === null && d.round === null : isPos(d.stage) && isPos(d.round))
    && (d.planVersion === null || isPos(d.planVersion)) && isNonNeg(d.clarificationVersion),
  "plan.recorded": (d) => exactKeys(d, ["turnId", "version", "plan", "firstStage", "stageCount"]) && isUuid(d.turnId)
    && isPos(d.version) && isTextRef(d.plan) && isPos(d.firstStage) && isInt(d.stageCount) && d.stageCount >= 1 && d.stageCount <= 50,
  "review.recorded": (d) => exactKeys(d, ["turnId", "stage", "verdict", "findings", "findingsKey", "findingsCount",
    "clarificationVersion", "runKey"]) && isUuid(d.turnId)
    && (d.stage === null ? oneOf(d.verdict, FINAL_VERDICTS) : isPos(d.stage) && oneOf(d.verdict, STAGE_VERDICTS))
    && (d.findings === null || isTextRef(d.findings)) && isSha256(d.findingsKey)
    && isInt(d.findingsCount) && d.findingsCount >= 0 && d.findingsCount <= 50 && isNonNeg(d.clarificationVersion) && isSha256(d.runKey),
  "question.asked": (d) => exactKeys(d, ["questionId", "turnId", "text"]) && isUuid(d.questionId) && isUuid(d.turnId) && isTextRef(d.text),
  "question.answered": (d) => exactKeys(d, ["questionId", "commandId", "text"]) && isUuid(d.questionId) && isUuid(d.commandId)
    && isTextRef(d.text),
  // a final check (all stages accepted) has neither stage nor round
  "check.assessed": (d) => exactKeys(d, ["checkRunId", "stage", "round", "checkKey", "runKey"]) && isUuid(d.checkRunId)
    && (d.stage === null ? d.round === null : isPos(d.stage) && isPos(d.round)) && isSha256(d.checkKey) && isSha256(d.runKey),
  "stage.accepted": (d) => exactKeys(d, ["stage", "reviewTurnId", "tree"]) && isPos(d.stage) && isUuid(d.reviewTurnId) && isGitOid(d.tree),
  "clarification.added": (d) => exactKeys(d, ["version", "commandId", "text"]) && isPos(d.version) && isUuid(d.commandId)
    && isTextRef(d.text),
  "limits.changed": (d) => exactKeys(d, ["commandId", "kind", "value"]) && isUuid(d.commandId) && oneOf(d.kind, LIMIT_KINDS)
    && isPos(d.value),
  "recovery.decided": (d) => exactKeys(d, ["commandId", "action", "turnId"]) && isUuid(d.commandId)
    && oneOf(d.action, RECOVERY_ACTIONS) && isUuid(d.turnId),
  "prepare.started": (d) => exactKeys(d, ["prepareId", "reason", "steps"]) && isUuid(d.prepareId)
    && oneOf(d.reason, ["start", "check"]) && isTextRef(d.steps),
  // locks: sha256 of the lock files after it; before/after: the work folder's trees around it (what it changed)
  "prepare.finished": (d) => keysWithin(d, ["prepareId", "status", "failed", "class", "output"], ["locks", "before", "after"]) && isUuid(d.prepareId)
    && (d.locks === undefined || isLocks(d.locks)) && (d.before === undefined || isGitOid(d.before)) && (d.after === undefined || isGitOid(d.after))
    && oneOf(d.status, PREPARE_STATUSES) && (d.failed === null || isNonNeg(d.failed))
    && (d.class === null || oneOf(d.class, FAILURE_CLASSES)) && (d.status === "failed") === (d.failed !== null)
    && (d.output === null || isTextRef(d.output)),
  "check.classified": (d) => exactKeys(d, ["checkRunId", "class"]) && isUuid(d.checkRunId) && oneOf(d.class, FAILURE_CLASSES),
  "permission.granted": (d) => exactKeys(d, ["grantId", "scope", "provider", "kind", "tool", "fingerprint", "summary"])
    && isUuid(d.grantId) && oneOf(d.scope, ["run", "project"]) && oneOf(d.provider, ["codex", "claude"])
    && str(d.kind, 40) && str(d.tool, 120) && isSha256(d.fingerprint) && isTextRef(d.summary),
  "permission.applied": (d) => exactKeys(d, ["grantId", "fingerprint", "scope"]) && typeof d.grantId === "string" && d.grantId.length <= 64
    && isSha256(d.fingerprint) && oneOf(d.scope, ["run", "project"]),
  "finish.intent": (d) => exactKeys(d, ["intentId", "step", "params"]) && isUuid(d.intentId) && oneOf(d.step, FINISH_STEPS) && isTextRef(d.params),
  // tree: the checked tree the action was for; version/observed (QA): the version contract's outcome and the validated
  // id reported; bound: older journals only (whether the verification mentioned the commit — never a confirmation)
  "finish.result": (d) => keysWithin(d, ["intentId", "status", "established", "evidence", "commit"], ["tree", "bound", "version", "observed"]) && isUuid(d.intentId)
    && (d.tree === undefined || d.tree === null || isGitOid(d.tree)) && (d.bound === undefined || d.bound === null || typeof d.bound === "boolean")
    && (d.version === undefined || oneOf(d.version, QA_VERSIONS)) && (d.observed === undefined || d.observed === null || isGitOid(d.observed))
    && oneOf(d.status, FINISH_STATUSES) && typeof d.established === "boolean" && (d.evidence === null || isTextRef(d.evidence))
    && (d.commit === null || isGitOid(d.commit))
};

// Journal v2 (journal-v2-format.md §2): v1's records, run.status with the completion result, and the A1 records.
// Records the document gives to A2–A4 are not here: in a v2 journal of this build they are invalid_event.
const FINISH_DECISIONS: readonly string[] = ["confirm", "decline"];
const DATA_SCHEMAS_V2: Record<string, (d: Record<string, unknown>) => boolean> = {
  ...DATA_SCHEMAS,
  "run.status": (d) => exactKeys(d, ["status", "reason", "completion"]) && oneOf(d.status, RUN_STATUSES)
    && (d.status === "paused" ? oneOf(d.reason, PAUSED_REASONS_V2) : d.reason === null)
    && (d.status === "completed" ? exactKeys(d.completion, ["kind", "basis"]) && oneOf(d.completion.kind, ["confirmed", "no_checks"]) && isTextRef(d.completion.basis)
      : d.completion === null),
  // A2 (§2.7): conditionsAssigned, absent only in a plan of A1's form
  "plan.recorded": (d) => exactKeys(d, Object.hasOwn(d, "conditionsAssigned") ? ["turnId", "version", "plan", "firstStage", "stageCount", "conditionsAssigned"] : ["turnId", "version", "plan", "firstStage", "stageCount"])
    && isUuid(d.turnId) && isPos(d.version) && isTextRef(d.plan) && isPos(d.firstStage) && isInt(d.stageCount) && d.stageCount >= 1 && d.stageCount <= 50
    && (d.conditionsAssigned === undefined || (isInt(d.conditionsAssigned) && d.conditionsAssigned >= 0 && d.conditionsAssigned <= 600)),
  "checks.proposed": (d) => exactKeys(d, ["turnId", "proposal", "count", "sandboxNetwork"]) && isUuid(d.turnId) && isTextRef(d.proposal)
    && isInt(d.count) && d.count >= 0 && d.count <= 16 && oneOf(d.sandboxNetwork, ["denied", "open"]),
  "checks.decided": (d) => exactKeys(d, ["proposalTurnId", "decision", "by", "commandId", "checks", "count"]) && isUuid(d.proposalTurnId)
    && oneOf(d.decision, ["accept", "edit"]) && oneOf(d.by, ["autopilot", "person"]) && (d.commandId === null || isUuid(d.commandId))
    && isTextRef(d.checks) && isInt(d.count) && d.count >= 0 && d.count <= 16,
  "finish.confirmed": (d) => exactKeys(d, ["commandId", "tree", "commit", "push", "qa"]) && isUuid(d.commandId) && isGitOid(d.tree)
    && (d.commit === null || isGitOid(d.commit)) && (d.push === null || oneOf(d.push, FINISH_DECISIONS))
    && (d.qa === null || oneOf(d.qa, FINISH_DECISIONS)) && (d.push !== null || d.qa !== null),
  // A1.1 (§2.6): a lead's check the sandbox refused, replaced by the person's line (unchanged or not): from then on a
  // person's command, without the sandbox
  "checks.amended": (d) => exactKeys(d, ["commandId", "checkId", "line"]) && isUuid(d.commandId) && isCheckId(d.checkId)
    && isTextRef(d.line),
  "check.classified": (d) => exactKeys(d, ["checkRunId", "class"]) && isUuid(d.checkRunId) && oneOf(d.class, [...FAILURE_CLASSES, "sandbox"]),
  // A3 (§2.8): the reviewer's role; the tree before a turn
  "turn.intent": (d) => exactKeys(d, ["turnId", "commandId", "role", "provider", "mode", "sessionId", "task"])
    && isUuid(d.turnId) && (d.commandId === null || isUuid(d.commandId)) && oneOf(d.role, ["lead", "executor", "reviewer"])
    && oneOf(d.provider, ["codex", "claude"]) && str(d.mode, 64) && strOrNull(d.sessionId, 128) && isTextRef(d.task),
  "orch.turn": (d) => keysWithin(d, ["turnId", "purpose", "stage", "round", "planVersion", "clarificationVersion"], ["tree"])
    && isUuid(d.turnId) && oneOf(d.purpose, TURN_PURPOSES)
    && (d.purpose === "plan" || d.purpose === "final_review" ? d.stage === null && d.round === null : isPos(d.stage) && isPos(d.round))
    && (d.planVersion === null || isPos(d.planVersion)) && isNonNeg(d.clarificationVersion)
    && (d.tree === undefined || d.tree === null || isGitOid(d.tree)),
  "review.assessed": (d) => exactKeys(d, ["turnId", "stage", "request", "report", "applied", "clarificationVersion", "runKey"]) && isUuid(d.turnId)
    && (d.stage === null || isPos(d.stage)) && oneOf(d.request, ["none", "replan", "question"]) && isTextRef(d.report) && isTextRef(d.applied)
    && isNonNeg(d.clarificationVersion) && isSha256(d.runKey),
  "review.discarded": (d) => exactKeys(d, ["turnId", "treeBefore", "treeAfter"]) && isUuid(d.turnId) && isGitOid(d.treeBefore) && isGitOid(d.treeAfter),
  // A4 (5h §2.4, journal-v2-format.md §2.9): a plan proposal, the person's decision on it, the person's decision outside
  // a plan — each decision with the state (runKey) and tree the person decided on
  "plan.proposed": (d) => exactKeys(d, ["turnId", "plan", "firstStage", "stageCount", "conditionsAssigned"]) && isUuid(d.turnId) && isTextRef(d.plan)
    && isPos(d.firstStage) && isInt(d.stageCount) && d.stageCount >= 1 && d.stageCount <= 50
    && isInt(d.conditionsAssigned) && d.conditionsAssigned >= 0 && d.conditionsAssigned <= 600,
  "plan.decided": (d) => exactKeys(d, ["commandId", "proposalTurnId", "decision", "version", "choices", "note", "runKey", "tree"]) && isUuid(d.commandId)
    && isUuid(d.proposalTurnId) && isTextRef(d.choices) && isSha256(d.runKey) && isGitOid(d.tree)
    && (d.decision === "accept" ? isPos(d.version) && d.note === null : d.decision === "return" && d.version === null && (d.note === null || isTextRef(d.note))),
  "person.decided": (d) => exactKeys(d, ["commandId", "subject", "target", "decision", "finding", "reopened", "runKey", "tree"]) && isUuid(d.commandId)
    && isSha256(d.runKey) && isGitOid(d.tree) && (
      d.subject === "condition" ? isConditionId(d.target) && oneOf(d.decision, ["met", "not_met"]) && d.finding === null && d.reopened === null
        : d.subject === "finding" ? isFindingId(d.target) && oneOf(d.decision, ["close", "to_wish"]) && d.finding === null && d.reopened === null
          : d.subject === "disputed" && exactKeys(d.target, ["reviewTurnId", "index"]) && isUuid(d.target.reviewTurnId) && isNonNeg(d.target.index)
            && (d.target.index as number) < 50 && isFindingId(d.finding) && (d.decision === "new" ? d.reopened === null : d.decision === "repeat" && typeof d.reopened === "boolean"))
};
const isConditionId = (v: unknown): v is string => typeof v === "string" && /^C[1-9]\d{0,5}$/.test(v);
const isFindingId = (v: unknown): v is string => typeof v === "string" && /^F[1-9]\d{0,5}$/.test(v);
const schemasOf = (version: number): Record<string, (d: Record<string, unknown>) => boolean> => version === 2 ? DATA_SCHEMAS_V2 : DATA_SCHEMAS;

export function isValidEventData(type: string, data: unknown, version = 1): boolean {
  const schemas = schemasOf(version);
  return Object.hasOwn(schemas, type) && isRecord(data) && schemas[type](data);
}

// The envelope keys a v2 journal's first record adds (journal-v2-format.md §1).
export interface FirstRecordHead { minReaderVersion: number; formatPreview?: true }

// Record without "hash" -> hash -> line. The caller checks MAX_LINE_BYTES. version 2: head goes into the first record.
export function buildRecord(prev: { seq: number; hash: string } | null, runId: string, ts: string, type: EventType,
  data: Record<string, unknown>, version: 1 | 2 = 1, head: FirstRecordHead | null = null): { record: JournalRecord; line: Buffer } {
  const body = { v: version, seq: prev ? prev.seq + 1 : 0, ts, runId, type, prevHash: prev ? prev.hash : ZERO_HASH, data,
    ...(prev === null && head ? head : {}) };
  const record: JournalRecord = { ...body, hash: sha256Hex(canonical(body)) };
  return { record, line: Buffer.from(canonical(record) + "\n", "utf8") };
}

const conflict = (message: string): never => { throw new JournalError("replay_conflict", message); };

// Applies one schema-valid record to `state` IN PLACE (null only for seq 0) and returns it.
// Every check runs before any mutation: on a throw `state` is unchanged. Throws JournalError(replay_conflict | invalid_transition). Transitions are the service's job, except leaving a terminal status.
export function applyRecord(state: RunState | null, rec: JournalRecord): RunState {
  const d = rec.data;
  if (state === null) {
    if (rec.type !== "run.created") conflict("the first record must be run.created");
    return {
      runId: rec.runId, version: rec.v, preview: rec.formatPreview === true, completion: null,
      status: "preparing", pausedReason: null, lastSeq: rec.seq, lastHash: rec.hash,
      goal: d.goal as TextRef, turns: {}, commands: {}, workspace: null, checks: {},
      orch: {
        revision: 0, turns: {}, plan: null, plans: [], planReviewPaused: false, reviews: [], accepted: {}, pendingCheckpoint: null,
        clarifications: 0, clarificationRefs: [], clarificationSeqs: [], question: null, answers: 0, answerSeqs: [],
        lastPausedSeq: {}, assessed: {}, limitOverrides: {}, recoveryDecisions: {},
        prepares: [], classified: {}, grants: {}, applied: 0, finish: [],
        lastOrchTurn: null, checksProposal: null, checksDecision: null, confirmations: [], amended: {}, discarded: {}, reviewPermits: [],
        nextCondition: 1, proposals: [], person: [], decidedCommands: []
      }
    };
  }
  switch (rec.type) {
    case "run.created":
      conflict("run.created is allowed only at seq 0");
      break;
    case "run.status":
      if (TERMINAL_STATUSES.includes(state.status)) throw new JournalError("invalid_transition", `run is ${state.status}`);
      if (state.version === 2 && d.status === "completed") completedAllowed(state, d.completion as { kind: CompletionKind });
      if (state.version === 2) state.completion = d.status === "completed" ? { ...(d.completion as { kind: CompletionKind; basis: TextRef }) } : null;
      // A3 (5h §3.1.1): continuing from tree_changed_during_review is the person's leave for one more reviewer turn
      if (d.status === "running" && state.status === "paused" && state.pausedReason === "tree_changed_during_review") {
        const last = lastReviewerTurn(state);
        if (last) state.orch.reviewPermits.push({ key: reviewKey(state.orch.turns[last]), seq: rec.seq });
      }
      state.status = d.status as RunStatus;
      state.pausedReason = d.reason as PausedReason | null;
      state.orch.revision++;
      if (d.status === "paused") state.orch.lastPausedSeq[d.reason as PausedReason] = rec.seq;
      if (d.reason === "plan_review" && state.orch.plan?.version === 1) state.orch.planReviewPaused = true;
      break;
    case "command.received": {
      const id = d.commandId as string;
      if (Object.hasOwn(state.commands, id)) conflict(`command ${id} received twice`);
      state.commands[id] = { status: "received", kind: d.kind as string, payloadHash: d.payloadHash as string, result: null };
      break;
    }
    case "command.completed": {
      const cmd = state.commands[d.commandId as string];
      if (!cmd || cmd.status === "completed") conflict(`command ${String(d.commandId)} cannot be completed`);
      cmd.status = "completed";
      cmd.result = { ...(d.result as CommandResult) };
      if (cmd.result.status === "accepted") state.orch.revision++;
      break;
    }
    case "turn.intent": {
      const id = d.turnId as string;
      if (Object.hasOwn(state.turns, id)) conflict(`turn ${id} started twice`);
      if (proposalWaits(state)) conflict("a turn while the proposed check commands wait for a decision");
      if (planProposalWaits(state)) conflict("a turn while a plan proposal waits for the person");
      if (d.role === "reviewer") reviewerTurnAllowed(state, id);
      state.turns[id] = {
        status: "in_flight", commandId: d.commandId as string | null, role: d.role as TurnState["role"],
        provider: d.provider as TurnState["provider"], mode: d.mode as string, sessionId: d.sessionId as string | null,
        task: d.task as TextRef, nextTurnAllowed: false, report: null
      };
      break;
    }
    case "turn.finished": {
      const turn = state.turns[d.turnId as string];
      if (!turn || turn.status !== "in_flight") conflict(`turn ${String(d.turnId)} is not in flight`);
      const report = d.report as { status: ReportStatus; ref: TextRef | null; storeError: ReportStoreError | null };
      turn.status = d.outcome as ProviderOutcome;
      turn.nextTurnAllowed = d.nextTurnAllowed as boolean;
      turn.sessionId = d.sessionId as string | null;
      turn.report = { status: report.status, ref: report.ref, storeError: report.storeError };
      break;
    }
    case "run.recovered": {
      const pending = unfinishedWork(state);
      if (d.previousStatus !== state.status || !sameSet(d.unfinishedTurns as string[], pending.turns)
        || !sameSet(d.unfinishedCommands as string[], pending.commands)) {
        conflict("run.recovered does not match the unfinished work");
      }
      for (const id of pending.turns) state.turns[id].status = "outcome_unknown";
      for (const id of pending.commands) state.commands[id].status = "unfinished";
      if (!TERMINAL_STATUSES.includes(state.status)) {
        state.status = "paused";
        state.pausedReason = pending.turns.length > 0 ? "outcome_unknown" : "recovered";
      }
      break;
    }
    case "journal.tail_repaired":
      break;
    case "workspace.created": {
      if (state.workspace) conflict("workspace created twice");
      const b = d.baseline as { commit: string; tree: string };
      state.workspace = {
        sourcePathSha256: d.sourcePathSha256 as string, baseline: { commit: b.commit, tree: b.tree }, head: d.head as string | null,
        checkpoints: {}, snapshots: [], current: { commit: b.commit, tree: b.tree },
        pendingRestore: null, failedRestore: null, lastRestore: null
      };
      break;
    }
    case "snapshot.created": {
      const ws = state.workspace ?? conflict("snapshot without a workspace");
      if (ws.snapshots.some((x) => x.ref === d.ref)) conflict(`snapshot ${String(d.ref)} recorded twice`);
      if ((d.ref as string).includes("/recovery-") && !(d.ref as string).startsWith(`refs/canvastty/${state.runId}/`)) {
        conflict("recovery snapshot of another run");
      }
      ws.snapshots.push({ kind: d.kind as WorkspaceSnapshot["kind"], ref: d.ref as string, commit: d.commit as string, tree: d.tree as string });
      break;
    }
    case "checkpoint.created": {
      const ws = state.workspace ?? conflict("checkpoint without a workspace");
      // the copy's content is not confirmed while a restore is unfinished, so no stage can be accepted from it
      if (ws.pendingRestore) conflict("checkpoint while a restore is unfinished");
      const stage = d.stage as number;
      const count = Object.keys(ws.checkpoints).length;
      // stages are sequential; each checkpoint's parent is the previous checkpoint, the first one's is the baseline
      if (stage !== count + 1) conflict(`checkpoint stage ${stage} out of order (next is ${count + 1})`);
      const expectedParent = stage === 1 ? ws.baseline.commit : ws.checkpoints[String(stage - 1)].commit;
      if (d.parent !== expectedParent) conflict(`checkpoint ${stage} parent is not the previous checkpoint`);
      ws.checkpoints[String(stage)] = { commit: d.commit as string, tree: d.tree as string, parent: d.parent as string };
      ws.current = { commit: d.commit as string, tree: d.tree as string };
      if (state.orch.pendingCheckpoint === stage) state.orch.pendingCheckpoint = null;
      break;
    }
    case "workspace.restore_started": {
      const ws = state.workspace ?? conflict("restore without a workspace");
      // a new attempt is allowed only after the previous one was recorded as failed
      if (ws.pendingRestore && !ws.failedRestore) conflict("a restore is already in progress");
      const r = d as unknown as WorkspaceRestore;
      const target = r.target === "baseline" ? ws.baseline.commit : ws.checkpoints[r.target.slice("stage-".length)]?.commit;
      if (target !== r.targetCommit) conflict(`restore target ${r.target} does not match the journal`);
      if (!ws.snapshots.some((x) => x.kind === "recovery" && x.commit === r.recoveryCommit)) conflict("restore without its recovery snapshot");
      ws.pendingRestore = { target: r.target, targetCommit: r.targetCommit, recoveryCommit: r.recoveryCommit };
      ws.failedRestore = null;
      break;
    }
    case "workspace.restored": {
      const ws = state.workspace ?? conflict("restore without a workspace");
      // a failed attempt is not a restore: only a new, explicitly started attempt can be confirmed
      if (ws.failedRestore) conflict("workspace.restored after a failed attempt; start a new restore");
      const p = ws.pendingRestore ?? conflict("workspace.restored without the matching restore_started");
      if (p.target !== d.target || p.targetCommit !== d.targetCommit || p.recoveryCommit !== d.recoveryCommit) {
        conflict("workspace.restored does not match the restore in progress");
      }
      const targetTree = p.target === "baseline" ? ws.baseline.tree : ws.checkpoints[p.target.slice("stage-".length)].tree;
      ws.lastRestore = p;
      ws.pendingRestore = null;
      ws.failedRestore = null;
      ws.current = { commit: p.targetCommit, tree: targetTree };
      break;
    }
    case "check.started": {
      const ws = state.workspace ?? conflict("check without a workspace");
      if (ws.pendingRestore) conflict("check while a restore is unfinished");
      if (state.checks[d.checkRunId as string]) conflict(`check ${String(d.checkRunId)} started twice`);
      if (state.version === 2) checkOfDecidedSet(state, d.checkId as string, d.profileSha256 as string);
      if (planProposalWaits(state)) conflict("a check while a plan proposal waits for the person");
      const base = d.base as { commit: string; tree: string };
      // the check runs on the applicable base of the copy, the one confirmed events left in place
      if (base.commit !== ws.current.commit || base.tree !== ws.current.tree) conflict("check base is not the current base of the copy");
      state.checks[d.checkRunId as string] = {
        checkId: d.checkId as string, status: "in_flight", reason: null, base: { commit: base.commit, tree: base.tree },
        treeBefore: d.treeBefore as string, treeAfter: null, profileSha256: d.profileSha256 as string,
        commandSha256: d.commandSha256 as string, exitCode: null, signal: null, groupCleared: null,
        output: null, outputDropped: 0, evidenceFingerprint: null, durationMs: null
      };
      break;
    }
    case "check.finished": {
      const check = state.checks[d.checkRunId as string];
      if (!check || check.status !== "in_flight") conflict(`check ${String(d.checkRunId)} is not in flight`);
      check.status = d.status as CheckStatus;
      check.reason = d.reason as NotVerifiedReason | null;
      check.exitCode = d.exitCode as number | null;
      check.signal = d.signal as string | null;
      check.groupCleared = d.groupCleared as boolean;
      check.treeAfter = d.treeAfter as string | null;
      check.output = d.output as TextRef | null;
      check.outputDropped = d.outputDropped as number;
      check.evidenceFingerprint = d.evidenceFingerprint as string;
      check.durationMs = d.durationMs as number;
      break;
    }
    case "workspace.restore_failed": {
      const ws = state.workspace ?? conflict("restore without a workspace");
      const p = ws.pendingRestore ?? conflict("workspace.restore_failed without the matching restore_started");
      if (p.target !== d.target || p.targetCommit !== d.targetCommit || p.recoveryCommit !== d.recoveryCommit) {
        conflict("workspace.restore_failed does not match the restore in progress");
      }
      // the copy is partial or unknown: pendingRestore stays, current does not move, no stage can be accepted
      ws.failedRestore = { ...p, result: d.result as WorkspaceFailedRestore["result"] };
      break;
    }
    default:
      applyOrchRecord(state, rec);
  }
  state.lastSeq = rec.seq;
  state.lastHash = rec.hash;
  return state;
}

// Orchestration events (stage-5-contract.md §8), same rule: every check before any mutation.
function applyOrchRecord(state: RunState, rec: JournalRecord): void {
  const d = rec.data;
  const o = state.orch;
  // A command decision is written before its command.completed (stage-5-contract.md §6).
  const openCommand = (kind?: string) => {
    const c = state.commands[d.commandId as string];
    if (c?.status !== "received") conflict(`command ${String(d.commandId)} is not in progress`);
    if (kind && c.kind !== kind) conflict(`command ${String(d.commandId)} is not ${kind}`);
  };
  // v2: proposed check commands without a decision: only the commands' records and run.status until it (§2.1)
  if (proposalWaits(state) && rec.type !== "checks.decided") conflict(`${rec.type} while the proposed check commands wait for a decision`);
  // A4 (5h §3.6 p. 2): a plan proposal waiting for the person: only its decision (and the commands, run.status)
  if (planProposalWaits(state) && rec.type !== "plan.decided") conflict(`${rec.type} while a plan proposal waits for the person`);
  // 5h §3.5: the commands whose decision is in the journal (a command left without its end is accepted after a crash)
  const decision = () => { if (!o.decidedCommands.includes(d.commandId as string)) o.decidedCommands.push(d.commandId as string); };
  const completedTurn = (id: string, purposes: readonly string[]) => {
    const t = o.turns[id];
    if (!t || !purposes.includes(t.purpose)) conflict(`turn ${id} is not a ${purposes.join("/")} turn`);
    if (state.turns[id]?.status !== "completed") conflict(`turn ${id} did not complete`);
    return t;
  };
  switch (rec.type) {
    case "orch.turn": {
      const id = d.turnId as string;
      // written before turn.intent; a bare turn.intent (without orch.turn) stays valid
      if (Object.hasOwn(o.turns, id) || Object.hasOwn(state.turns, id)) conflict(`orch.turn ${id} is not before its intent`);
      // the final form of v2 (A4, §3.4): every orch.turn says its tree (null but for the reviewer)
      if (finalForm(state) && d.tree === undefined) throw new JournalError("invalid_event", "orch.turn without its tree");
      o.lastOrchTurn = id;
      o.turns[id] = {
        purpose: d.purpose as TurnPurpose, stage: d.stage as number | null, round: d.round as number | null,
        planVersion: d.planVersion as number | null, clarificationVersion: d.clarificationVersion as number, seq: rec.seq,
        ...(d.tree === undefined ? {} : { tree: d.tree as string | null })
      };
      break;
    }
    case "plan.recorded": {
      completedTurn(d.turnId as string, ["plan"]);
      // v2: the plan of the turn that proposed check commands is recorded only after they are accepted, with no other
      // turn in between; after «Изменить» that turn's plan is dropped (journal-v2-format.md §2.4)
      if (o.checksProposal?.turnId === d.turnId) {
        if (o.checksDecision?.decision !== "accept") conflict("the plan of a proposal that was not accepted");
        if (o.lastOrchTurn !== d.turnId) conflict("another turn between the accepted proposal and its plan");
      }
      if (o.plan?.turnId === d.turnId) conflict(`turn ${String(d.turnId)} already recorded a plan`);
      if (d.version !== (o.plan?.version ?? 0) + 1) conflict(`plan version ${String(d.version)} out of order`);
      if (d.firstStage !== Object.keys(o.accepted).length + 1) conflict("plan firstStage is not the next stage");
      // A2 (journal-v2-format.md §2.7): once a plan has conditions, a plan without them would drop them unseen
      if (o.plans.some((x) => x.conditionsAssigned !== undefined) && d.conditionsAssigned === undefined) conflict("a plan without conditions after a plan with them");
      if (o.proposals.some((p) => p.turnId === d.turnId)) conflict(`turn ${String(d.turnId)} proposed its plan`);
      o.plan = {
        version: d.version as number, turnId: d.turnId as string, ref: d.plan as TextRef,
        firstStage: d.firstStage as number, stageCount: d.stageCount as number,
        ...(d.conditionsAssigned === undefined ? {} : { conditionsAssigned: d.conditionsAssigned as number, base: o.nextCondition }), seq: rec.seq
      };
      o.nextCondition += (d.conditionsAssigned as number | undefined) ?? 0;
      o.plans.push(o.plan);
      break;
    }
    // A4 (5h §3.6): a plan that drops conditions or requirements is a proposal; the plan in force stays until the
    // person decides. Its new conditions take their numbers now, so C<n> always means one text.
    case "plan.proposed": {
      completedTurn(d.turnId as string, ["plan"]);
      if (o.lastOrchTurn !== d.turnId) conflict("the proposal is not of the last turn");
      if (o.plan?.turnId === d.turnId || o.proposals.some((p) => p.turnId === d.turnId) || o.checksProposal?.turnId === d.turnId) conflict(`turn ${String(d.turnId)} already has its result`);
      if (d.firstStage !== Object.keys(o.accepted).length + 1) conflict("proposal firstStage is not the next stage");
      o.proposals.push({ turnId: d.turnId as string, ref: d.plan as TextRef, firstStage: d.firstStage as number, stageCount: d.stageCount as number,
        conditionsAssigned: d.conditionsAssigned as number, base: o.nextCondition, seq: rec.seq, decision: null });
      o.nextCondition += d.conditionsAssigned as number;
      break;
    }
    case "plan.decided": {
      const p = o.proposals.at(-1);
      if (!p || p.decision !== null || p.turnId !== d.proposalTurnId) conflict("the decision is not about the waiting proposal");
      openCommand("plan.decide");
      decision();
      p!.decision = { decision: d.decision as "accept" | "return", commandId: d.commandId as string, choices: d.choices as TextRef,
        note: d.note as TextRef | null, runKey: d.runKey as string, tree: d.tree as string, seq: rec.seq };
      if (d.decision === "accept") {
        if (d.version !== (o.plan?.version ?? 0) + 1) conflict(`plan version ${String(d.version)} out of order`);
        if (p!.firstStage !== Object.keys(o.accepted).length + 1) conflict("the proposal's firstStage is not the next stage");
        o.plan = { version: d.version as number, turnId: p!.turnId, ref: p!.ref, firstStage: p!.firstStage, stageCount: p!.stageCount,
          conditionsAssigned: p!.conditionsAssigned, base: p!.base, seq: rec.seq, proposed: true };
        o.plans.push(o.plan);
      }
      break;
    }
    // A4 (5h §3.5): a person's decision outside a plan, by command; what it is about is checked against the texts
    case "person.decided": {
      openCommand("person.decide");
      const t = d.target as PersonDecision["target"];
      if (d.subject === "disputed") {
        const id = (t as { reviewTurnId: string }).reviewTurnId;
        if (!o.reviews.some((r) => r.turnId === id && r.assessed)) conflict(`no reviewer's result ${id} for the disputed item`);
        if (o.person.some((x) => x.subject === "disputed" && typeof x.target === "object" && x.target.reviewTurnId === id && x.target.index === (t as { index: number }).index)) {
          conflict("the disputed item was already decided");
        }
      }
      decision();
      o.person.push({ commandId: d.commandId as string, subject: d.subject as PersonSubject,
        target: typeof t === "string" ? t : { reviewTurnId: t.reviewTurnId, index: t.index },
        decision: d.decision as PersonDecision["decision"], finding: d.finding as string | null, reopened: d.reopened as boolean | null,
        runKey: d.runKey as string, tree: d.tree as string, seq: rec.seq });
      break;
    }
    case "review.recorded": {
      // A4 (§3.4): the final form of v2 never has it — only the A1–A2 development journals the lead reviewed
      if (finalForm(state)) throw new JournalError("invalid_event", "review.recorded in a journal of the final v2 form");
      // A3 (§2.8): a journal is reviewed by the lead (A1–A2) or by the reviewer, never both
      if (Object.values(state.turns).some((x) => x.role === "reviewer")) conflict("a lead's review in a journal the reviewer reviews");
      const t = completedTurn(d.turnId as string, d.stage === null ? ["final_review"] : ["review"]);
      if (t.stage !== d.stage) conflict(`review stage ${String(d.stage)} is not the turn's stage`);
      if (o.reviews.some((r) => r.turnId === d.turnId)) conflict(`turn ${String(d.turnId)} already recorded a review`);
      o.reviews.push({ ...(d as unknown as ReviewRecordedData), seq: rec.seq });
      break;
    }
    case "question.asked": {
      const id = d.turnId as string;
      const status = state.turns[id]?.status;
      if (!o.turns[id] || status === undefined || status === "in_flight" || status === "outcome_unknown") {
        conflict(`turn ${id} is not a finished orchestration turn`);
      }
      if (o.question && !o.question.answered) conflict("another question is open");
      if (o.question?.questionId === d.questionId) conflict(`question ${String(d.questionId)} asked twice`);
      o.question = { questionId: d.questionId as string, turnId: id, ref: d.text as TextRef, answered: false, seq: rec.seq,
        answerRef: null, answeredSeq: null };
      break;
    }
    case "question.answered": {
      const q = o.question ?? conflict("no question is open");
      if (q.answered || q.questionId !== d.questionId) conflict(`question ${String(d.questionId)} is not open`);
      openCommand();
      decision();
      q.answered = true;
      q.answerRef = d.text as TextRef;
      q.answeredSeq = rec.seq;
      o.answers++;
      o.answerSeqs.push(rec.seq);
      break;
    }
    case "check.assessed": {
      const id = d.checkRunId as string;
      // evidenceFingerprint is set only by check.finished: an interrupted check (never finished) cannot be assessed,
      // even though the reopened writer shows it as not_verified(interrupted)
      if (!state.checks[id] || state.checks[id].evidenceFingerprint === null) conflict(`check ${id} is not finished`);
      if (Object.hasOwn(o.assessed, id)) conflict(`check ${id} assessed twice`);
      o.assessed[id] = {
        stage: d.stage as number | null, round: d.round as number | null, checkKey: d.checkKey as string,
        runKey: d.runKey as string, seq: rec.seq
      };
      break;
    }
    case "stage.accepted": {
      const stage = d.stage as number;
      const plan = o.plan ?? conflict("stage accepted without a plan");
      if (stage !== Object.keys(o.accepted).length + 1) conflict(`stage ${stage} is not the next stage`);
      if (stage > plan.firstStage - 1 + plan.stageCount) conflict(`stage ${stage} is beyond the plan`);
      // rule 3 of the cycle checkpoints an accepted stage before anything else
      if (o.pendingCheckpoint !== null) conflict(`stage ${o.pendingCheckpoint} has no checkpoint yet`);
      if (!o.reviews.some((r) => r.turnId === d.reviewTurnId && r.verdict === "accept" && r.stage === stage)) {
        conflict(`no accept review of stage ${stage} by turn ${String(d.reviewTurnId)}`);
      }
      o.accepted[String(stage)] = { reviewTurnId: d.reviewTurnId as string, tree: d.tree as string, seq: rec.seq };
      o.pendingCheckpoint = state.workspace?.checkpoints[String(stage)] ? null : stage;
      break;
    }
    case "clarification.added":
      if (d.version !== o.clarifications + 1) conflict(`clarification version ${String(d.version)} out of order`);
      openCommand();
      decision();
      o.clarifications++;
      o.clarificationRefs.push(d.text as TextRef);
      o.clarificationSeqs.push(rec.seq);
      break;
    case "limits.changed":
      openCommand();
      decision();
      o.limitOverrides[d.kind as LimitKind] = d.value as number;
      break;
    case "recovery.decided": {
      const id = d.turnId as string;
      if (state.turns[id]?.status !== "outcome_unknown") conflict(`turn ${id} is not outcome_unknown`);
      if (Object.hasOwn(o.recoveryDecisions, id)) conflict(`turn ${id} already has a recovery decision`);
      openCommand();
      decision();
      o.recoveryDecisions[id] = d.action as RecoveryAction;
      // A3 (5h §3.1.1): retrying a reviewer's turn of unknown outcome is leave for exactly one more turn of its key
      if (state.turns[id].role === "reviewer" && d.action !== "accept" && o.turns[id]) o.reviewPermits.push({ key: reviewKey(o.turns[id]), seq: rec.seq });
      break;
    }
    case "prepare.started": {
      if (o.prepares.some((p) => p.prepareId === d.prepareId)) conflict(`prepare ${String(d.prepareId)} started twice`);
      // One left in flight by an earlier process (reopening marks it interrupted in memory; the journal has no record
      // of the reopening): a writer starts a new one only then, so replay marks it the same way.
      for (const p of o.prepares) if (p.status === "in_flight") p.status = "interrupted";
      o.prepares.push({
        prepareId: d.prepareId as string, reason: d.reason as PrepareState["reason"], steps: d.steps as TextRef, seq: rec.seq,
        status: "in_flight", failed: null, class: null, output: null, finishedSeq: null
      });
      break;
    }
    case "prepare.finished": {
      const p = o.prepares.find((x) => x.prepareId === d.prepareId);
      if (!p || p.status !== "in_flight") conflict(`prepare ${String(d.prepareId)} is not in flight`);
      p!.status = d.status as PrepareState["status"];
      p!.failed = d.failed as number | null;
      p!.class = d.class as FailureClass | null;
      p!.output = d.output as TextRef | null;
      p!.finishedSeq = rec.seq;
      if (d.locks !== undefined) p!.locks = d.locks as Record<string, string>;
      if (d.before !== undefined) p!.before = d.before as string;
      if (d.after !== undefined) p!.after = d.after as string;
      break;
    }
    case "check.classified": {
      const id = d.checkRunId as string;
      const c = state.checks[id];
      if (!c || c.status !== "failed") conflict(`check ${id} is not a finished failed check`);
      if (Object.hasOwn(o.classified, id)) conflict(`check ${id} classified twice`);
      if (d.class === "sandbox" && c.profileSha256 === NO_SANDBOX_SHA256) conflict(`check ${id} ran without a sandbox`);
      o.classified[id] = d.class as FailureClass;
      break;
    }
    case "permission.granted": {
      const fp = d.fingerprint as string;
      if (o.grants[fp]) conflict("the same action is granted twice");
      o.grants[fp] = { grantId: d.grantId as string, scope: d.scope as "run" | "project", seq: rec.seq };
      break;
    }
    case "permission.applied":
      o.applied++;
      break;
    case "finish.intent": {
      if (o.finish.some((f) => f.intentId === d.intentId)) conflict(`finish intent ${String(d.intentId)} recorded twice`);
      if (state.version === 2 && (d.step === "push" || d.step === "qa") && o.checksDecision?.count === 0) {
        // a run without checks: push and QA only after the person confirmed them, after the last commit (§2.2)
        const commitSeq = Math.max(-1, ...o.finish.filter((f) => f.step === "commit" && f.status === "done").map((f) => f.resultSeq ?? -1));
        if (!o.confirmations.some((c) => c[d.step as "push" | "qa"] === "confirm" && c.seq > commitSeq)) conflict(`${String(d.step)} of a run without checks was not confirmed`);
      }
      if (o.finish.some((f) => f.status === "in_flight" || f.status === "outcome_unknown")) conflict("an earlier action after success has no result");
      o.finish.push({
        intentId: d.intentId as string, step: d.step as FinishStep, params: d.params as TextRef, seq: rec.seq,
        status: "in_flight", established: false, evidence: null, commit: null, resultSeq: null
      });
      break;
    }
    case "finish.result": {
      const f = o.finish.find((x) => x.intentId === d.intentId);
      if (!f || (f.status !== "in_flight" && f.status !== "outcome_unknown" && f.status !== "unknown")) conflict(`finish intent ${String(d.intentId)} has a result`);
      // a result established after the application ended is marked so; a live one never is. An intent the earlier
      // process left in flight is outcome_unknown only in the reopened writer's memory, so replay sees it in_flight.
      if (f!.status !== "in_flight" && !d.established) conflict("finish.result established does not match the intent's state");
      f!.status = d.status as FinishStatus;
      f!.established = d.established as boolean;
      f!.evidence = d.evidence as TextRef | null;
      f!.commit = d.commit as string | null;
      f!.resultSeq = rec.seq;
      if (d.tree !== undefined) f!.tree = d.tree as string | null;
      if (d.version !== undefined) f!.version = d.version as QaVersion;
      if (d.observed !== undefined) f!.observed = d.observed as string | null;
      break;
    }
    // journal v2 (journal-v2-format.md §2.1)
    case "checks.proposed": {
      completedTurn(d.turnId as string, ["plan"]);
      if (o.checksProposal) conflict("check commands were already proposed");
      if (o.plan) conflict("check commands are proposed only by the first plan");
      if (o.lastOrchTurn !== d.turnId) conflict("the proposal is not of the last turn");
      o.checksProposal = { turnId: d.turnId as string, ref: d.proposal as TextRef, count: d.count as number, sandboxNetwork: d.sandboxNetwork as SandboxNetwork, seq: rec.seq };
      break;
    }
    case "checks.decided": {
      const p = o.checksProposal ?? conflict("no proposed check commands");
      if (o.checksDecision) conflict("the proposed check commands were already decided");
      if (p.turnId !== d.proposalTurnId) conflict("the decision is about another proposal");
      const auto = d.by === "autopilot";
      if (auto !== (d.commandId === null) || (auto && d.decision !== "accept")) conflict("an autopilot decision is an acceptance without a command");
      // A1.1 (§7 Q1, Q2): no command proposed — nothing to run, the network rule does not apply
      if (auto && p.sandboxNetwork !== "denied" && p.count !== 0) conflict("the autopilot accepts proposed commands only when the checks' sandbox denies the network");
      if (d.decision === "accept" && d.count !== p.count) conflict("an acceptance changes the number of commands");
      if (!auto) { openCommand("checks.decide"); decision(); }
      o.checksDecision = { decision: d.decision as "accept" | "edit", by: d.by as "autopilot" | "person", commandId: d.commandId as string | null,
        ref: d.checks as TextRef, count: d.count as number, seq: rec.seq };
      break;
    }
    case "checks.amended": {
      const id = d.checkId as string;
      const decided = o.checksDecision ?? conflict("an amendment without decided check commands");
      openCommand("check.amend");
      if (!Array.from({ length: decided.count }, (_, i) => `cmd-${i + 1}`).includes(id)) conflict(`check ${id} is not one of the decided commands`);
      if (Object.hasOwn(o.amended, id)) conflict(`check ${id} was already amended`);
      // only after the sandbox refused it: its latest finished run is classified "sandbox"
      const runs = Object.entries(state.checks).filter(([, c]) => c.checkId === id && c.status !== "in_flight");
      const last = runs.at(-1)?.[0];
      if (!last || o.classified[last] !== "sandbox") conflict(`check ${id} was not refused by the sandbox`);
      decision();
      o.amended[id] = { commandId: d.commandId as string, line: d.line as TextRef, seq: rec.seq };
      break;
    }
    case "finish.confirmed":
      openCommand("finish.confirm");
      decision();
      o.confirmations.push({ commandId: d.commandId as string, tree: d.tree as string, commit: d.commit as string | null,
        push: d.push as FinishDecision | null, qa: d.qa as FinishDecision | null, seq: rec.seq });
      break;
    // A3 (5h §3.10, journal-v2-format.md §2.8): one result record per reviewer's turn, only for the last orch.turn
    case "review.assessed": {
      const id = d.turnId as string;
      const t = reviewerResultOf(state, id);
      if (state.turns[id].status !== "completed") conflict(`turn ${id} did not complete`);
      if (t.stage !== d.stage) conflict(`review stage ${String(d.stage)} is not the turn's stage`);
      const ref = state.turns[id].report?.ref;
      if (!ref || ref.sha256 !== (d.report as TextRef).sha256 || ref.bytes !== (d.report as TextRef).bytes) conflict(`the assessed report is not turn ${id}'s report`);
      if (d.clarificationVersion !== t.clarificationVersion) conflict("the assessed clarification version is not the turn's");
      const request = d.request as ReviewRequest;
      o.reviews.push({
        turnId: id, stage: d.stage as number | null, verdict: request === "none" ? (d.stage === null ? "complete" : "accept") : request,
        findings: null, findingsKey: "", findingsCount: 0, clarificationVersion: d.clarificationVersion as number, runKey: d.runKey as string, seq: rec.seq,
        assessed: { request, report: d.report as TextRef, applied: d.applied as TextRef }
      });
      break;
    }
    case "review.discarded": {
      const id = d.turnId as string;
      const t = reviewerResultOf(state, id);
      const status = state.turns[id].status;
      if (status === "in_flight" || status === "outcome_unknown") conflict(`turn ${id} has not finished`);
      if (d.treeBefore !== t.tree || d.treeAfter === d.treeBefore) conflict("a discarded review whose tree did not change");
      o.discarded[id] = { treeBefore: d.treeBefore as string, treeAfter: d.treeAfter as string, seq: rec.seq };
      break;
    }
  }
}

// A3: the key of a reviewer's turn for the count of discarded reviews (5h §3.1.1): plan version, purpose, stage.
export const reviewKey = (t: { planVersion: number | null; purpose: TurnPurpose; stage: number | null }): string => `${t.planVersion ?? 0}:${t.purpose}:${t.stage ?? "final"}`;
const lastReviewerTurn = (state: RunState): string | null =>
  Object.keys(state.orch.turns).filter((id) => state.turns[id]?.role === "reviewer").sort((a, b) => state.orch.turns[a].seq - state.orch.turns[b].seq).at(-1) ?? null;
// A reviewer's turn (A3): v2 only, a review purpose with the tree before it, and not in a journal the lead reviewed.
function reviewerTurnAllowed(state: RunState, id: string): void {
  if (state.version !== 2) conflict("a reviewer's turn in a v1 journal");
  const t = state.orch.turns[id];
  if (!t || (t.purpose !== "review" && t.purpose !== "final_review")) conflict(`turn ${id} of the reviewer is not a review`);
  if (typeof t.tree !== "string") conflict(`the reviewer's turn ${id} has no tree`);
  if (state.orch.reviews.some((r) => !r.assessed)) conflict("a reviewer's turn in a journal the lead reviews");
}
// The reviewer's turn a result record is about: the last orch.turn, with no result yet.
function reviewerResultOf(state: RunState, id: string): RunState["orch"]["turns"][string] {
  const o = state.orch;
  const t = o.turns[id];
  if (!t || state.turns[id]?.role !== "reviewer") conflict(`turn ${id} is not a reviewer's turn`);
  if (o.lastOrchTurn !== id) conflict(`turn ${id} is not the last turn`);
  if (o.reviews.some((r) => r.turnId === id) || Object.hasOwn(o.discarded, id)) conflict(`turn ${id} already has a result`);
  return t;
}

// v2: proposed check commands without a decision: no turn, no check and no plan until it (journal-v2-format.md §2.1).
const proposalWaits = (state: RunState) => state.orch.checksProposal !== null && state.orch.checksDecision === null;
// A4 (5h §3.6 p. 2): a plan proposal without the person's decision: no turn and no check until it.
export const planProposalWaits = (state: RunState): boolean => state.orch.proposals.at(-1)?.decision === null;
// A4 (§3.4): a v2 journal of the final form (not written by a development build of A1–A3)
const finalForm = (state: RunState): boolean => state.version === 2 && !state.preview;

// v2: a check of the decided set only (cmd-1…cmd-n); "the network is denied" cannot be said of a check run without a
// sandbox. A goal with its own commands has no decision: its set is in the goal text (second stage).
function checkOfDecidedSet(state: RunState, checkId: string, profileSha256: string): void {
  const o = state.orch;
  if (proposalWaits(state)) conflict("a check while the proposed check commands wait for a decision");
  if (o.checksDecision && !Array.from({ length: o.checksDecision.count }, (_, i) => `cmd-${i + 1}`).includes(checkId)) {
    conflict(`check ${checkId} is not one of the decided commands`);
  }
  // the lead's commands of an accepted proposal run in the profile, unless the person let one out (§2.6); an edited
  // set says per line who wrote it — its texts (second stage)
  if (o.checksProposal?.sandboxNetwork === "denied" && o.checksDecision?.decision === "accept" && profileSha256 === NO_SANDBOX_SHA256
    && !Object.hasOwn(o.amended, checkId)) conflict("a check without a sandbox in a run whose checks deny the network");
}

// The latest assessed result of each of the checks `ids`: passed for every one (journal-v2-format.md §2.3).
export function checksPassed(state: RunState, ids: readonly string[]): boolean {
  return ids.every((id) => {
    let best: { status: string; seq: number } | null = null;
    for (const [checkRunId, a] of Object.entries(state.orch.assessed)) {
      const c = state.checks[checkRunId];
      if (c?.checkId === id && (!best || a.seq > best.seq)) best = { status: c.status, seq: a.seq };
    }
    return best?.status === "passed";
  });
}

// v2: run.status(completed) only as the completion function allows it — the part decidable from the records (the
// rest, from the texts, is textsConflict below). journal-v2-format.md §2.3, A1.
function completedAllowed(state: RunState, completion: { kind: CompletionKind }): void {
  const o = state.orch;
  if (proposalWaits(state)) conflict("completed while the proposed check commands wait for a decision");
  if (planProposalWaits(state)) conflict("completed while a plan proposal waits for the person");
  if (o.finish.some((f) => f.status === "in_flight" || f.status === "outcome_unknown" || f.status === "unknown")) conflict("completed with an action after success without its result");
  if (!o.plan || Object.keys(o.accepted).length < o.plan.firstStage - 1 + o.plan.stageCount) conflict("completed with a stage of the plan not accepted");
  const last = o.lastOrchTurn;
  if (!last || o.turns[last]?.purpose !== "final_review" || !o.reviews.some((r) => r.turnId === last && r.verdict === "complete")) {
    conflict("completed without a final review that completes the run");
  }
  const decided = o.checksDecision;
  const expected: CompletionKind = decided?.count === 0 ? "no_checks" : "confirmed";
  if (completion.kind !== expected) conflict(`completed ${completion.kind}, the checks say ${expected}`);
  if (decided && !checksPassed(state, Array.from({ length: decided.count }, (_, i) => `cmd-${i + 1}`))) conflict("completed confirmed with a check that did not pass");
}

// v2, the second stage of reading: the rules that need the texts (journal-v2-format.md §2.1 and §2.3, their A1 part —
// the goal's commands, the proposal, the decision and the completion's kind and checks). A violation: corrupt with
// phase "texts". ponytail: finish.intent params against the confirmation and the A2–A4 rules come with their records.
export interface V2Texts {
  goal: { commands?: unknown; mode?: unknown; criteria?: unknown };
  proposal: { checks: { id: string; command: string }[] } | null;
  decision: { checks: { id: string; command: string; origin: string }[] } | null;
  // A2 (§2.7): the texts of o.plans in their order, the lead's review answers (turn.finished.report) by turn, and the
  // completed status' basis
  plans?: PlanText[];
  reports?: Record<string, unknown>;
  basis?: CompletionBasis | null;
  applied?: Record<string, Applied>; // A3 (§2.8): the applied texts of review.assessed, by turn
  choices?: Record<string, PlanChoices>; // A4: the person's choices of the accepted proposals, by their turn
  // A4 (§2.3): the params of push and QA of a run without checks, by intent — about the tree and commit confirmed
  finishParams?: Record<string, { tree?: unknown; commit?: unknown }>;
}
export interface CompletionBasis {
  checks: { id: string; checkRunId: string | null }[]; runKey: string; checkKeys: Record<string, string>;
  requirements?: { id: string; conditions: string[]; met: boolean }[];
}
export function textsConflict(state: RunState, t: V2Texts): string | null {
  const o = state.orch;
  const own = Array.isArray(t.goal.commands) ? t.goal.commands as unknown[] : null;
  const numbered = (xs: { id: string }[], n: number) => xs.length === n && xs.every((x, i) => x.id === `cmd-${i + 1}`);
  if (o.checksProposal) {
    if (own?.length !== 0) return "check commands proposed for a goal that has its own";
    if (!t.proposal || !numbered(t.proposal.checks, o.checksProposal.count)) return "the proposal's lines do not match its record";
  } else if (own?.length === 0 && (o.plan || Object.keys(state.checks).length)) return "a plan or a check of a goal without commands and without a decision";
  const d = o.checksDecision;
  if (d) {
    if (!t.decision || !t.proposal || !numbered(t.decision.checks, d.count)) return "the decision's lines do not match its record";
    if (d.by === "autopilot" && t.goal.mode !== undefined && t.goal.mode !== "autopilot") return "an autopilot decision in step mode";
    const proposed = t.proposal.checks.map((c) => c.command);
    if (d.decision === "accept" && t.decision.checks.some((c, i) => c.command !== proposed[i])) return "an acceptance that is not the proposal";
    if (t.decision.checks.some((c) => c.origin !== (proposed.includes(c.command) ? "lead" : "person"))) return "an origin against the rule";
    // A1.1 (§2.6): a lead's line of a run whose checks deny the network runs in the profile unless the person let it out
    const lead = new Set(t.decision.checks.filter((c) => c.origin === "lead").map((c) => c.id));
    if (o.checksProposal?.sandboxNetwork === "denied" && Object.values(state.checks).some((c) => lead.has(c.checkId) && c.profileSha256 === NO_SANDBOX_SHA256 && !Object.hasOwn(o.amended, c.checkId))) {
      return "a lead's check without the sandbox";
    }
  }
  const why = t.plans ? conditionsConflict(state, t, d ? d.count : own?.length ?? 0) : null;
  if (why) return why;
  // A3 (§2.8): the reviewer's results applied by the rules; no stage accepted and no completion past an open blocking
  // finding or a disputed item
  // (A4: also a journal whose accepted proposal carries choices before any review)
  if (t.plans && t.applied && (o.reviews.some((r) => r.assessed) || o.proposals.some((p) => p.decision?.decision === "accept"))) {
    const f = replayFindings(state, { plans: t.plans, reports: t.reports ?? {}, applied: t.applied, choices: t.choices ?? {} });
    if (f.problem) return f.problem;
  }
  // A4 (§2.3): push and QA of a run without checks deliver what the person confirmed — the same tree and commit
  for (const [intentId, params] of Object.entries(t.finishParams ?? {})) {
    const f = o.finish.find((x) => x.intentId === intentId)!;
    const commitSeq = Math.max(-1, ...o.finish.filter((x) => x.step === "commit" && x.status === "done" && (x.resultSeq ?? -1) < f.seq).map((x) => x.resultSeq ?? -1));
    const ok = o.confirmations.some((c) => c.seq > commitSeq && c.seq < f.seq && c[f.step as "push" | "qa"] === "confirm" && c.tree === params.tree && c.commit === params.commit);
    if (!ok) return `${f.step} of a run without checks delivers another tree or commit than the person confirmed`;
  }
  if (state.completion) {
    const n = d ? d.count : own?.length ?? 0;
    if ((state.completion.kind === "no_checks") !== (n === 0)) return `completed ${state.completion.kind} with ${n} check commands`;
    if (state.completion.kind === "confirmed" && !checksPassed(state, Array.from({ length: n }, (_, i) => `cmd-${i + 1}`))) return "completed confirmed with a command that did not pass";
  }
  return null;
}

// A2 (journal-v2-format.md §2.7): the plans number and carry over their conditions by the rules, a stage with "change"
// conditions was accepted on a review that marked each met, and a completed run with conditions has evidence of each
// condition on the tree it completed on and the final review's met for each requirement.
function conditionsConflict(state: RunState, t: V2Texts, commands: number): string | null {
  const o = state.orch;
  const plans = t.plans!;
  if (plans.length !== o.plans.length) return "the plans' texts are missing";
  const criteria = Array.isArray(t.goal.criteria) ? t.goal.criteria.length : 0;
  const checkIds = Array.from({ length: commands }, (_, i) => `cmd-${i + 1}`);
  const book = emptyBook();
  for (const [i, p] of o.plans.entries()) {
    const text = plans[i];
    // a plan without conditionsAssigned has no conditions: applyPlan below refuses any it numbers
    if (p.conditionsAssigned !== undefined) {
      if (text.stages.some((s) => !s.conditions)) return `plan v${p.version}: a stage without conditions`;
      // A4 (5h §3.6): only a proposal the person accepted drops a condition or a requirement
      if (!p.proposed && ((text.dropped ?? []).length || (text.dropRequirements ?? []).length)) return `plan v${p.version}: drops without the person's decision`;
      const stages = text.stages.map((s) => ({ conditions: s.conditions!.map((c) => ("keep" in c ? { keep: c.keep } : { text: c.text, covers: c.covers, evidence: c.evidence })) }));
      const problems = planProblems(stages, { dropped: text.dropped ?? [], dropRequirements: text.dropRequirements ?? [] }, book, p.firstStage, criteria, checkIds);
      if (problems.length) return `plan v${p.version}: ${problems[0]}`;
    }
    try { applyPlan(book, { firstStage: p.firstStage, text, conditionsAssigned: p.conditionsAssigned ?? null, base: p.base }); } catch (e) { return `plan v${p.version}: ${(e as Error).message}`; }
  }
  if (!o.plans.some((p) => p.conditionsAssigned !== undefined)) return null;
  // A4 (5h §3.5): a person's decision about a condition is about a person condition of the plans
  for (const d of o.person) if (d.subject === "condition" && book.defs.get(d.target as string)?.evidence.kind !== "person") return `a person's decision about ${String(d.target)}, not a person condition`;
  const marksOf = (turnId: string): ConditionMark[] => {
    const c = (t.reports?.[turnId] as { conditions?: unknown } | undefined)?.conditions;
    return Array.isArray(c) ? c as ConditionMark[] : [];
  };
  for (const [stage, a] of Object.entries(o.accepted)) {
    const marks = marksOf(a.reviewTurnId);
    for (const id of changeIdsOf(book, Number(stage))) {
      const m = marks.find((x) => x.id === id);
      if (m?.status !== "met" || !m.paths?.length) return `stage ${stage} accepted while its review did not mark ${id} met`;
    }
    for (const id of personIdsOf(book, Number(stage))) if (personStatus(state, id, Number(stage), a.seq) !== "met") return `stage ${stage} accepted without the person's met for ${id}`;
  }
  if (!state.completion || !book.conditioned) return null;
  const basis = t.basis;
  if (!basis) return "completed without its basis";
  const final = o.reviews.filter((r) => r.stage === null).at(-1);
  if (!final || final.runKey !== basis.runKey) return "completed on another tree than its final review";
  // a condition's check counts only for the tree the run completed on (a stale result is no evidence); its runKey may be
  // older — a tree seen before (A → B → A) or another command's change keeps the checkKey and is not rerun
  const check = (cmd: string): Status => {
    const id = basis.checks.find((c) => c.id === cmd)?.checkRunId ?? null;
    const a = id ? o.assessed[id] : undefined;
    return id && a && state.checks[id]?.status === "passed" && state.checks[id].checkId === cmd && a.checkKey === basis.checkKeys[cmd] ? "met" : "not_met";
  };
  const finalMarks = (t.reports?.[final.turnId] as { requirements?: unknown } | undefined)?.requirements;
  const facts = factsOf(book, criteria, {
    check, marks: (stage) => (o.accepted[String(stage)] ? marksOf(o.accepted[String(stage)].reviewTurnId) : null),
    finalMarks: Array.isArray(finalMarks) ? finalMarks as RequirementMark[] : null,
    person: (id, stage) => personStatus(state, id, stage)
  });
  // A4: a requirement the person dropped is not met and needs no evidence; it never counts as met
  const unmet = facts.conditions.find((c) => c.status !== "met") ?? facts.requirements.find((r) => r.status !== "met" && r.status !== "dropped");
  return unmet ? `completed while ${unmet.id} has no evidence` : null;
}

// A4 (5h §3.5): the person's decision about a person condition, in force until the next executor turn of its stage (a
// new turn there asks again): the last one after that turn. before: only decisions recorded before that seq.
export function personStatus(state: RunState, id: string, stage: number, before = Number.MAX_SAFE_INTEGER): Status {
  const o = state.orch;
  const lastExec = Math.max(-1, ...Object.values(o.turns).filter((t) => t.purpose === "execute" && t.stage === stage && t.seq < before).map((t) => t.seq));
  const d = o.person.filter((x) => x.subject === "condition" && x.target === id && x.seq > lastExec && x.seq < before).at(-1);
  return d ? d.decision as Status : "not_checked";
}

// In-flight turns and received-but-not-completed commands, in journal order.
export const CHECK_STATUSES: readonly string[] = ["passed", "failed", "not_verified"];
export const NOT_VERIFIED_REASONS: readonly string[] = [
  "sandbox_unavailable", "spawn_failed", "timeout", "stopped", "output_limit",
  "cleanup_unverified", "deps_changed", "tree_changed", "workspace_unverified",
  "restore_incomplete", "interrupted", "store_failed"
];
const isCheckId = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(v);

// A check whose start is in the journal without its result: after reopening it is not_verified(interrupted), decided
// here rather than by a new event, so no journal schema changes and nothing is re-run. Not applied to a live writer.
export function markInterruptedChecks(state: RunState): string[] {
  const interrupted = Object.keys(state.checks).filter((id) => state.checks[id].status === "in_flight");
  for (const id of interrupted) {
    state.checks[id].status = "not_verified";
    state.checks[id].reason = "interrupted";
  }
  return interrupted;
}

// Stage 13, the same rule for the application's own operations on reopening: a preparation without its end is
// interrupted (it can simply run again), an action after success without its result is outcome_unknown — its real
// outcome is established before anything else, and it is never repeated on its own.
export function markInterruptedOperations(state: RunState): void {
  for (const p of state.orch.prepares) if (p.status === "in_flight") p.status = "interrupted";
  for (const f of state.orch.finish) if (f.status === "in_flight") f.status = "outcome_unknown";
}

export function unfinishedWork(state: RunState): { turns: string[]; commands: string[] } {
  return {
    turns: Object.keys(state.turns).filter((id) => state.turns[id].status === "in_flight"),
    commands: Object.keys(state.commands).filter((id) => state.commands[id].status === "received")
  };
}

// Whether opening the run records run.recovered (store.openRun): work left unfinished, or the run left neither paused
// nor finished — its process ended without shutdown.
export function needsRecovery(state: RunState): boolean {
  const pending = unfinishedWork(state);
  return pending.turns.length > 0 || pending.commands.length > 0 || (!TERMINAL_STATUSES.includes(state.status) && state.status !== "paused");
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));

// Pure and deterministic (ts is ignored). Records must already be chain-checked (parseJournal does that).
export function replay(records: readonly JournalRecord[]): RunState {
  let state: RunState | null = null;
  for (const rec of records) state = applyRecord(state, rec);
  if (state === null) return conflict("empty journal");
  return state;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }) // a BOM must fail JSON.parse, not vanish;

// One complete line (without '\n') -> record, checked against the previous record. Throws JournalError.
// version > JOURNAL_VERSION: a newer journal's line; only the envelope and the chain are checked, not its event schema.
// own: a journal of this build (v1, or v2): the exact envelope and the event schema of its version; a v2 first record
// carries minReaderVersion 2 — and formatPreview true when a development build of A1–A3 wrote it —, no other record
// does (journal-v2-format.md §1, §3.4).
export function parseLine(bytes: Uint8Array, runId: string, prev: { seq: number; hash: string } | null, version = JOURNAL_VERSION,
  own = version === JOURNAL_VERSION): JournalRecord {
  if (bytes.length > MAX_LINE_BYTES) throw new JournalError("line_too_large", `line of ${bytes.length} bytes`);
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new JournalError("invalid_utf8", "line is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new JournalError("invalid_json", "line is not JSON");
  }
  if (!isRecord(value)) throw new JournalError("invalid_event", "record is not an object");
  if (value.v !== version) throw new JournalError(own && version === 2 ? "invalid_event" : "unsupported_version", `version ${String(value.v)}`);
  let canon: string | null = null;
  try {
    canon = canonical(value);
  } catch { /* e.g. 1e999 parsed as Infinity */ }
  if (canon !== text) throw new JournalError("non_canonical", "line is not canonical JSON");
  const head = version === 2 && prev === null ? { minReaderVersion: V2_MIN_READER_VERSION, ...(Object.hasOwn(value, "formatPreview") ? { formatPreview: true } : {}) } : {};
  const envelope = own ? exactKeys(value, [...RECORD_KEYS, ...Object.keys(head)]) && Object.entries(head).every(([k, v]) => value[k] === v)
      && isValidEventData(String(value.type), value.data, version)
    : RECORD_KEYS.every((k) => Object.hasOwn(value, k)) && isRecord(value.data);
  if (!envelope || !isInt(value.seq) || typeof value.ts !== "string" || !ISO_TS.test(value.ts)
    || typeof value.runId !== "string" || !isSha256(value.prevHash) || !isSha256(value.hash)
    || typeof value.type !== "string") {
    throw new JournalError("invalid_event", `record does not match the v${version} schema`);
  }
  const rec = value as unknown as JournalRecord;
  if (rec.runId !== runId) throw new JournalError("wrong_run", "record belongs to another run");
  if (rec.seq !== (prev ? prev.seq + 1 : 0)) throw new JournalError("bad_seq", `seq ${rec.seq}`);
  if (rec.prevHash !== (prev ? prev.hash : ZERO_HASH)) throw new JournalError("bad_prev_hash", "prevHash breaks the chain");
  const { hash, ...body } = rec;
  if (sha256Hex(canonical(body)) !== hash) throw new JournalError("bad_hash", "hash does not match the record");
  return rec;
}

export interface ParsedJournal {
  records: JournalRecord[]; // valid prefix
  state: RunState | null; // replay of the valid prefix
  integrity: JournalIntegrity;
  validBytes: number; // end of the last valid line, including its '\n'
}

// ok: every line valid and nothing after the last '\n'. torn_tail: only the final fragment lacks '\n'.
// corrupt: a '\n'-terminated line fails, or there is no valid run.created at all (empty file, lone fragment).
// How a build reads journals: the highest own version and the highest minReaderVersion it can replay. The defaults
// are this build's; { maxVersion: 1, readerVersion: 1 } reads as 1.5.7 (A0) did.
// previewReadOnly: a journal of an A1–A3 development build (formatPreview) is shown read only, never replayed — once v2
// is the person's (JOURNAL_V2_BY_DEFAULT, journal-v2-format.md §3.4).
export interface ReaderOptions { maxVersion?: number; readerVersion?: number; previewReadOnly?: boolean }

export function parseJournal(buf: Uint8Array, runId: string, opts: ReaderOptions = {}): ParsedJournal {
  const records: JournalRecord[] = [];
  let state: RunState | null = null;
  let offset = 0;
  let line = 1;
  const corrupt = (code: CorruptCode): ParsedJournal =>
    ({ records, state, integrity: { status: "corrupt", detail: { line, offset, code } }, validBytes: offset });
  const newer = newerVersion(buf, opts.maxVersion, opts.previewReadOnly);
  // newer only by previewReadOnly (its version is this build's own): an A1–A3 development journal, said as such
  if (newer !== null) return parseNewerJournal(buf, runId, newer, opts.readerVersion ?? READER_VERSION, newer <= (opts.maxVersion ?? MAX_JOURNAL_VERSION));
  if (buf.length > MAX_JOURNAL_BYTES) return corrupt("journal_too_large");
  const version = firstVersion(buf) === 2 ? 2 : JOURNAL_VERSION; // by the first record; a mismatch later is the line's error
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl < 0) {
      if (state === null) return corrupt("replay_conflict");
      return { records, state, integrity: { status: "torn_tail", detail: { offset, bytes: buf.length - offset } }, validBytes: offset };
    }
    try {
      const prev = records.length ? records[records.length - 1] : null;
      const rec = parseLine(buf.subarray(offset, nl), runId, prev, version, true);
      state = applyRecord(state, rec); // throws before mutating, so a conflict leaves the previous state
      records.push(rec);
    } catch (error) {
      if (error instanceof JournalError) return corrupt(error.code);
      throw error;
    }
    offset = nl + 1;
    line++;
  }
  if (state === null) return corrupt("replay_conflict");
  return { records, state, integrity: { status: "ok" }, validBytes: offset };
}

// The first line as JSON (also one without its '\n'), or null: unreadable, too large, not an object.
function firstRecord(buf: Uint8Array): Record<string, unknown> | null {
  const nl = buf.indexOf(0x0a);
  const end = nl < 0 ? buf.length : nl;
  if (end > MAX_LINE_BYTES) return null;
  try {
    const v: unknown = JSON.parse(utf8.decode(buf.subarray(0, end)));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}
const firstVersion = (buf: Uint8Array): unknown => firstRecord(buf)?.v;

// minReaderVersion of a newer journal's first record: an integer, or null (absent, not an integer, unreadable).
export function minReaderVersion(buf: Uint8Array): number | null {
  const m = firstRecord(buf)?.minReaderVersion;
  return isInt(m) ? m : null;
}

// A compatible newer record as a reader of `version` reads it: its event data of that version with the fields it does
// not know left out. null: its type or data is not that version's.
function asVersion(rec: JournalRecord, version: 1 | 2): JournalRecord | null {
  known = new WeakMap();
  try {
    if (!isValidEventData(rec.type, rec.data, version)) return null;
    const seen = known;
    const project = (v: unknown): unknown => Array.isArray(v) ? v.map(project)
      : isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => !seen.has(v) || seen.get(v)!.has(k)).map(([k, x]) => [k, project(x)]))
        : v;
    return { v: version, seq: rec.seq, ts: rec.ts, runId: rec.runId, type: rec.type, prevHash: rec.prevHash, hash: rec.hash, data: project(rec.data) as Record<string, unknown> } as JournalRecord;
  } finally {
    known = null;
  }
}

// The version of a journal this build does not write (its first line, also one without its '\n'; only that line is
// looked at, the rest is never parsed as events):
// - an integer v above maxVersion (MAX_JOURNAL_VERSION: v2 is this build's own);
// - v2 with formatPreview (an A1–A3 development build's) once v2 is the person's: shown read only, not replayed (A4,
//   journal-v2-format.md §3.4). The final form of v2 (no formatPreview) is this build's own.
// null: any other journal — also a first line torn inside its JSON, whose version cannot be read: it stays corrupt.
export function newerVersion(buf: Uint8Array, maxVersion = MAX_JOURNAL_VERSION, previewReadOnly = JOURNAL_V2_BY_DEFAULT): number | null {
  const first = firstRecord(buf);
  const v = first?.v;
  if (!isInt(v) || v <= JOURNAL_VERSION) return null;
  return v > maxVersion || (v === 2 && previewReadOnly && first!.formatPreview === true) ? v : null;
}

// A0 bridge (acceptance-review-spec.md §2.2): the valid prefix of the chain (seq, prevHash, hash, runId, one version),
// with state null. Records keep their own types and data; nothing is replayed (no applyRecord).
function parseNewerJournal(buf: Uint8Array, runId: string, version: number, readerVersion: number, preview = false): ParsedJournal {
  const min = minReaderVersion(buf);
  // v2 here is a development journal of A1–A3 shown read only (§3.4): the records as they are, no computed state
  if (preview) return parseRawNewerJournal(buf, runId, version, true);
  if (min !== null && min >= 1 && min <= Math.min(readerVersion, READER_VERSION)) {
    const compatible = parseCompatibleJournal(buf, runId, version, min);
    if (!("fallback" in compatible)) return compatible;
    const raw = parseRawNewerJournal(buf, runId, version);
    return compatible.fallback ? withFallback(raw, compatible.fallback) : raw;
  }
  return parseRawNewerJournal(buf, runId, version);
}

const withFallback = (p: ParsedJournal, fallback: NewerFallback): ParsedJournal =>
  p.integrity.status === "newer_version" ? { ...p, integrity: { status: "newer_version", detail: { ...p.integrity.detail, fallback } } } : p;

// minReaderVersion ≤ READER_VERSION: the chain is checked as for any newer journal (skipped records included), and each
// record is replayed by v1 rules (its unknown fields ignored). A record of a type v1 does not know is skipped only when
// it says skippable: true (the boolean); a known type is applied whatever it says. Any other record v1 cannot apply (an
// unknown type without the mark, data v1 rejects, a replay conflict) or a record of another v sends the whole journal
// back to the raw view, with where and why.
// fallback null: nothing was replayed (the chain fails on the first record, or the file is over the limit): the raw
// view says why through its chain, not as a record v1 could not apply.
function parseCompatibleJournal(buf: Uint8Array, runId: string, version: number, min: number): ParsedJournal | { fallback: NewerFallback | null } {
  const readAs = min as 1 | 2;
  const schemas = schemasOf(readAs);
  const records: JournalRecord[] = [];
  let state: RunState | null = null;
  let offset = 0;
  let line = 1;
  let skipped = 0;
  const done = (chain: ChainIntegrity): ParsedJournal | { fallback: NewerFallback | null } => state === null ? { fallback: null }
    : { records, state, integrity: { status: "newer_version_compatible", detail: { version, minReaderVersion: min, chain, skipped } }, validBytes: offset };
  if (buf.length > MAX_JOURNAL_BYTES) return { fallback: null };
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl < 0) return done({ status: "torn_tail", detail: { offset, bytes: buf.length - offset } });
    let rec: JournalRecord;
    try {
      rec = parseLine(buf.subarray(offset, nl), runId, records.at(-1) ?? null, version);
    } catch (error) {
      if (error instanceof JournalError && error.code === "unsupported_version" && line > 1) return { fallback: { line, code: "version_changed" } };
      if (error instanceof JournalError) return done({ status: "corrupt", detail: { line, offset, code: error.code } });
      throw error;
    }
    if (!Object.hasOwn(schemas, rec.type) && (rec as { skippable?: unknown }).skippable === true) {
      skipped++;
      records.push(rec);
      offset = nl + 1;
      line++;
      continue;
    }
    const own = asVersion(rec, readAs);
    if (!own) return { fallback: { line, code: Object.hasOwn(schemas, rec.type) ? "invalid_event" : "unknown_record" } };
    try {
      state = applyRecord(state, own);
    } catch (error) {
      if (error instanceof JournalError) return { fallback: { line, code: "replay_conflict" } };
      throw error;
    }
    records.push(rec);
    offset = nl + 1;
    line++;
  }
  return done({ status: "ok" });
}

// Only the envelope and the chain: the records as they are, state null.
// preview: the journal of an A1–A3 development build (§3.4), labelled so rather than as a newer version's
function parseRawNewerJournal(buf: Uint8Array, runId: string, version: number, preview = false): ParsedJournal {
  const records: JournalRecord[] = [];
  let offset = 0;
  let line = 1;
  const done = (chain: ChainIntegrity): ParsedJournal =>
    ({ records, state: null, integrity: { status: "newer_version", detail: { version, chain, ...(preview ? { preview: true as const } : {}) } }, validBytes: offset });
  if (buf.length > MAX_JOURNAL_BYTES) return done({ status: "corrupt", detail: { line, offset, code: "journal_too_large" } });
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl < 0) return done({ status: "torn_tail", detail: { offset, bytes: buf.length - offset } });
    try {
      records.push(parseLine(buf.subarray(offset, nl), runId, records.at(-1) ?? null, version));
    } catch (error) {
      if (error instanceof JournalError) return done({ status: "corrupt", detail: { line, offset, code: error.code } });
      throw error;
    }
    offset = nl + 1;
    line++;
  }
  return done({ status: "ok" });
}

// The goal of a newer journal: its run.created keeps the v1 schema (acceptance-review-spec.md §2.1). null otherwise.
export function newerGoal(records: readonly JournalRecord[]): TextRef | null {
  const first = records[0];
  return first?.type === "run.created" && isValidEventData("run.created", first.data) ? (first.data as { goal: TextRef }).goal : null;
}
