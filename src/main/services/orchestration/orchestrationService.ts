// OrchestrationService (stage-5-contract.md): one run from a goal to `completed` — plan, executor, the allowed stage-4
// checks, lead review, fix or checkpoint, next stage, final review. What to do next is decided by cycle.ts from the
// replayed journal only; this file carries it out, one external operation at a time, and journals every decision
// before the action it leads to. Not wired to app start, UI or IPC.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunActivity } from "./activity.ts";
import type { AgentAdapter, AgentRole, AgentTurn, TurnPurpose } from "./agents.ts";
import { failedTurnResult } from "./agents.ts";
import { commandSha256, createRegistry, resolveCheck } from "./checks.ts";
import type { CheckRegistry, PreparedDeps } from "./checks.ts";
import type { SandboxApi } from "./checkRunner.ts";
import { sandboxSupport } from "./sandbox.ts";
import { currentExecutableSha256, inspectPreparedDeps, startProjectCheck } from "./checkService.ts";
import type { ProjectCheckResult } from "./checkService.ts";
import { DEFAULT_LIMITS, completion, confirmationFor, currentCommit, effectiveLimits, nextAction, proposesChecks, withoutChecks } from "./cycle.ts";
import type { Action, Goal, LimitKind, RunLimits, Snapshot } from "./cycle.ts";
import { canonical, personStatus, planProposalWaits } from "./journal.ts";
import type { CommandResult, CompletionBasis, CompletionKind, PausedReason, ReviewRequest, RunState, RunStatus, SandboxNetwork, TextRef } from "./journal.ts";
import { byReviewer, openBlocking, ownerOf, planReview, replayFindings } from "./findings.ts";
import type { Applied, Finding, FindingsReplay, PlanChoices, ReportFinding } from "./findings.ts";
import { checkKey, findingsKey, runKey } from "./progress.ts";
import type { CheckDef, DepsFacts } from "./progress.ts";
import type { ProviderTurnResult } from "./providers.ts";
import { SAFE_MODEL } from "./providers.ts";
import { compileSchema, validateAnswer } from "./schema.ts";
import { applyRestore, inspectWorkspaceRefs, matchesCheckpointIntent, prepareRestore } from "./snapshots.ts";
import { createCheckpoint } from "./snapshots.ts";
import { StoreError, conditionTexts, createRun as storeCreateRun, openRun as storeOpenRun, readText } from "./store.ts";
import type { RunWriter, StoreIo } from "./store.ts";
import type { AnswerSchema, SupervisorLaunch } from "./types.ts";
import { endingDetail, sanitize } from "./activity.ts";
import { readOnlyCommand } from "./readOnly.ts";
import type { AskPerson, PermissionAsk, PermissionReply } from "./sessions.ts";
import { startShellCheck } from "./userCheck.ts";
import type { ShellCheckResult } from "./userCheck.ts";
import type { OrchestrationConditions, OrchestrationDecisions, OrchestrationFindings, OrchestrationGrant, OrchestrationPermissionRequest, OrchestrationPersonDecide,
  OrchestrationPlanChoice, OrchestrationPlanDecide, OrchestrationQaVersion, OrchestrationRunProgress } from "../../../shared/orchestration.ts";
import { closedByPerson } from "../../../shared/orchestration.ts";
import { bookOf, changeIdsOf, conditionBlockers, decidedMarks, factsOf, finalMarksProblems, ignoredMarks, numberPlan, personIdsOf, planProblems, reportConditions, requirementIds, stageMarksProblems, unchangedPaths } from "./conditions.ts";
import type { ConditionFacts, ConditionMark, ConditionsBook, PlanReportV2, PlanText, RequirementMark, Status } from "./conditions.ts";
import { WorkspaceError, cloneDependencies, createWorkspace, diffPaths, diffTreeNames, inPlace, openWorkspace, readCommit, readDependencyRecord, readIncompleteRestore, snapshotCopyTree, verifyWorkspace } from "./workspace.ts";
import type { CloneDir } from "./workspace.ts";
import type { AgentAccess } from "./access.ts";
import { isClaudeAccess, isCodexAccess } from "./access.ts";
import type { GoalFinish } from "./cycle.ts";
import { commitLine, findCommitLine, pushLine, qaEnv, qaVersion, remoteHead, remoteHeadLine, remoteUrlLine, remoteUrlsMatch, resultOid } from "./finish.ts";
import type { CommitParams, PushParams, QaParams } from "./finish.ts";
import { validateForm } from "./forms.ts";
import type { FailureClass, FinishStep } from "./journal.ts";
import { classifyFailure, installsNothing, lockFingerprints, neededSteps, sandboxRefused } from "./prepare.ts";
import { NO_SANDBOX_SHA256 } from "./journal.ts";
import type { PrepareStep } from "./prepare.ts";
import { grantFingerprint } from "./profile.ts";
import { runShell } from "./shellRun.ts";
import type { ShellRunResult } from "./shellRun.ts";
import type { Workspace } from "./workspace.ts";

export interface GoalInput {
  text: string;
  criteria: readonly string[];
  checks: readonly string[];
  reviewPlan?: boolean;
  limits?: Partial<RunLimits>;
  commands?: readonly string[]; // stage 12: the project's own check commands; then `checks` is empty
  workMode?: "project" | "copy" | "worktree";
  // stage 13 (from the project profile and the goal dialog)
  mode?: "autopilot" | "steps";
  prepare?: { steps: readonly PrepareStep[] };
  finish?: GoalFinish;
  access?: AgentAccess;
  // journal v2 only: the model of a role (absent or a role left out: as in the CLI). A v1 journal has no place for it
  // that a reader of 1.5.7 would not drop silently (it would run the role with the CLI's model).
  models?: Partial<Record<AgentRole, string>>;
  // the interface language when the goal was created: the texts the person reads (plan, findings, notes, questions)
  // are asked for in it. Absent (an older goal): no language is asked for.
  language?: "ru" | "en";
  // B1, journal v2 only: the board task this run works on (journal-v2-format.md §2.10)
  task?: { id: string; key: string };
  // B4 (owner's decision 11), journal v2 and a separate copy only: the copy starts from this commit — the result branch
  // of the task `key` this run's task depends on — instead of the project's working folder
  base?: { branch: string; commit: string; key: string };
}

// Stage 12: the checks of a goal with commands are those command lines, run by the user's login shell.
const CHECK_TIMEOUT_MS = 30 * 60_000;
// A1.1: a check in the check profile runs `<shell> -c <line>` (the login environment is passed in; the shell's start
// files would only be refused their writes) — another command, so another key: a result in the sandbox never stands
// for the same line run without it.
export function shellRegistry(shell: string, commands: readonly string[], sandboxed: readonly string[] = []): CheckRegistry {
  if (commands.length === 0) return Object.freeze({ commands: Object.freeze([]) }); // journal v2: no commands (yet), nothing to run
  return createRegistry(commands.map((line, i) => ({
    id: `cmd-${i + 1}`, title: line.slice(0, 200), executable: shell, argv: sandboxed.includes(`cmd-${i + 1}`) ? ["-c", line] : ["-ilc", line],
    timeoutMs: CHECK_TIMEOUT_MS, maxOutputBytes: 65_536
  })));
}

export interface OrchestrationDeps {
  root: string;
  // Journal v2 for new native runs (journal-v2-format.md §3.4): until A4 only behind the development flag
  // CANVASTTY_JOURNAL_V2; it allows a goal without check commands, whose lead proposes them.
  journalV2?: boolean;
  gitPath: string;
  agents: AgentAdapter;
  // registry/deps/sandbox: the node-test check of stages 4–11. shell (stage 12): the user's login shell (its real path)
  // and environment, for goals whose checks are their own commands; deps is then null (the project keeps its own).
  checks: {
    registry: CheckRegistry; deps: PreparedDeps | null; launch: SupervisorLaunch; sandbox?: SandboxApi; shell?: { shell: string; env: Record<string, string> };
    // A1.1 (journal-v2-format.md §2.6): the lead's proposed commands run in the check profile — where Seatbelt is
    // (absent: by the platform); false: never (they wait for the person, as in A1); realHome: tests only
    leadSandbox?: false | { realHome?: string };
  };
  clock?: () => number;
  stopGraceMs?: number;
  storeIo?: StoreIo; // tests only
  // Observation (stage 11): a sink per run. Optional, and nothing the cycle decides depends on it.
  activity?: (runId: string) => RunActivity;
  // Stage 13: the permission decisions the person saved for the run's project (the project profile). Only the
  // project's own grants; absent: nothing is saved beyond the run.
  grants?: { list(): Promise<readonly OrchestrationGrant[]>; add(grant: Omit<OrchestrationGrant, "id" | "grantedAt">): Promise<void> };
  cloneDir?: CloneDir; // tests only: the clone of a dependency folder (cloneDependencies)
}

export type RunCommand =
  | { kind: "pause_after_turn"; on: boolean }
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "step" }
  | { kind: "answer"; questionId: string; text: string }
  | { kind: "clarify"; text: string }
  | { kind: "recover"; action: "accept" | "retry_turn" | "reset_to_checkpoint"; confirm?: boolean }
  | { kind: "raise_limit"; limit: LimitKind; value: number }
  | { kind: "dismiss" }
  // journal v2 (journal-v2-format.md §2.1): «Принять» / «Изменить» of the proposed check commands, and the person's
  // push/QA decision of a run without checks for the tree and commit they saw
  | { kind: "checks.decide"; decision: "accept" | "edit"; checks?: string[] }
  | { kind: "finish.confirm"; tree: string; commit: string | null; push: "confirm" | "decline" | null; qa: "confirm" | "decline" | null }
  // A1.1 (§2.6): a lead's check the sandbox refused — run it without the sandbox (no line) or as the person's line
  | { kind: "check.amend"; checkId: string; line: string }
  // A4 (journal-v2-format.md §2.9): the person's decisions, about the state they saw (runKey)
  | OrchestrationPersonDecide
  | OrchestrationPlanDecide
  | { kind: "permission"; requestId: string; decision: PermissionDecision; answers?: Record<string, string[]>; content?: Record<string, unknown>; feedback?: string };
// What the person can answer: the CLI's own options, plus remembering exactly this action for the run or the project.
export type PermissionDecision = PermissionReply["decision"] | "allow_run" | "allow_project" | "allow_readonly_run";

export type CommandOutcome = CommandResult | { status: "in_progress" };

export interface RunView {
  runId: string;
  status: RunStatus;
  reason: PausedReason | null;
  revision: number;
  stage: number | null; // the stage being worked on; null before a plan and in the final phase
  turns: number;
  halted: boolean; // a journal write failed: nothing more is done until the run is reopened
  active: null | { kind: "turn"; purpose: TurnPurpose } | { kind: "check"; checkId: string } | { kind: "prepare" } | { kind: "finish"; step: FinishStep };
  permission?: OrchestrationPermissionRequest | null;
  pendingPermissions?: number;
  workMode?: "project" | "copy" | "worktree";
  workDir?: string;
  progress?: RunProgress; // stage 13: what is done and confirmed, for the top of the panel and the result
  // journal v2, on the pause awaiting_checks_decision: the lead's proposal the person accepts or edits
  proposal?: ChecksProposalText | null;
  // journal v2, on the pause awaiting_finish_confirmation: what the person confirms push/QA for (the payload of
  // finish.confirm) and which steps the goal asked for
  confirm?: { tree: string | null; commit: string | null; push: boolean; qa: boolean } | null;
  // A1.1, on the pause check_needs_permissions: the lead's check the sandbox refused (journal-v2-format.md §2.6)
  refused?: { checkId: string; command: string } | null;
  // A4: what the person decides on this pause, about the state shown (journal-v2-format.md §2.9)
  decisions?: OrchestrationDecisions | null;
}

// Facts from the journal (and the goal), never from an agent's own report.
export interface RunProgress {
  mode: "autopilot" | "steps";
  branch: string | null; // worktree mode: the run's branch
  access: AgentAccess | null;
  models?: Record<AgentRole, string | null>; // journal v2: the goal's models (null: as in the CLI)
  checks: { id: string; title: string; status: "passed" | "failed" | "not_verified" | "not_run"; class: FailureClass | null }[]; // the latest result of each
  prepare: { status: string; failed: string | null; class: FailureClass | null; command: string | null; output: TextRef | null } | null;
  finish: { step: FinishStep; asked: boolean; status: string; established: boolean; commit: string | null; evidence: string | null; version?: OrchestrationQaVersion | null; observed?: string | null; declined?: boolean }[];
  grantsApplied: number;
  // journal v2 (journal-v2-format.md §2.3): the completed run's kind — no_checks is never shown as confirmed
  completion?: CompletionKind | null;
  // journal v2: where the run's check commands came from — the goal, or the lead's proposal (accepted / edited)
  checksFrom?: "goal" | "proposal" | "edited" | null;
  conditions?: OrchestrationConditions | null; // A2 (journal-v2-format.md §2.7)
  budget?: RunBudget; // UX audit Н7: limits and what is spent of them
}
export type RunBudget = NonNullable<OrchestrationRunProgress["budget"]>;

export interface RunHandle {
  readonly runId: string;
  view(): RunView;
  seq(): number; // lastSeq of the journal: the position change notifications refer to
  // Changes of the view since the record at seq() (active operation, halted); 0 right after every record. (seq, tick)
  // orders the views of this handle; it is not journaled and starts at 0 when a run is opened (stage-7-contract.md §2.2).
  tick(): number;
  command(input: { commandId: string; expectedRevision: number; command: RunCommand }): Promise<CommandOutcome>;
  // After every durable journal record and every change of active or halted; view(), seq() and tick() are current when
  // it is called. Returns the unsubscribe.
  onChange(listener: (seq: number) => void): () => void;
  // The newest tree of the working copy this handle has read (a snapshot before a decision or after a lead turn).
  latestTree(): { tree: string; at: string } | null;
  idle(): Promise<void>;
  // Application exit (stage-7-contract.md): stops the active operation through its own stop(), starts nothing new,
  // leaves a running run paused(app_closed) and closes. Nothing is repeated on the next start.
  shutdown(): Promise<void>;
  close(): Promise<void>;
}

// The view of a run from its journal state; also for a run nobody has open (halted false, nothing active).
export function runView(st: RunState, halted = false, active: RunView["active"] = null,
  extra: Pick<RunView, "permission" | "pendingPermissions" | "workMode" | "workDir" | "progress" | "proposal" | "confirm" | "refused" | "decisions"> = {}): RunView {
  const accepted = Object.keys(st.orch.accepted).length;
  const total = st.orch.plan ? st.orch.plan.firstStage - 1 + st.orch.plan.stageCount : 0;
  return {
    runId: st.runId, status: st.status, reason: st.pausedReason, revision: st.orch.revision,
    stage: st.orch.plan && accepted < total ? accepted + 1 : null,
    turns: Object.keys(st.turns).length, halted, active, ...extra
  };
}

export class OrchestrationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OrchestrationError";
    this.code = code;
  }
}
// The next process of an operation was not started (admit()): an expected end, never an error of the environment.
class Refused extends OrchestrationError {
  constructor(why: string) { super("not_admitted", why); }
}

const DEFAULT_STOP_GRACE_MS = 20_000;
const RAISABLE: readonly LimitKind[] = ["turns", "roundsPerStage", "replans", "runMs"];
const RESUMABLE: readonly string[] = ["user_request", "step_done", "plan_review", "permission_denied", "loop_suspected", "environment_error", "recovered",
  "app_closed", "stage_done", "external_failure", "needs_user_action", "finish_unconfirmed", "tree_changed_during_review"];
const STEP_ONLY: readonly string[] = ["invalid_report", "protocol_error"];
const STOP_ONLY: readonly string[] = ["lead_modified_tree", "shared_git_tampered", "journal_corrupt", "sandbox_unavailable"];
// A4 (journal-v2-format.md §2.9): the pauses an open finding may be closed or made a wish on by the person — where the
// run waits for the person anyway; never a pause of another decision (checks, push/QA, a plan proposal, recovery)
const FINDING_PAUSES: readonly string[] = [...RESUMABLE, ...STEP_ONLY, "limit_reached", "awaiting_answer", "awaiting_person_decision"];
const ACTIVE: readonly string[] = ["preparing", "running", "pausing", "paused"];
const MAX_CHECK_OUTPUT_IN_TASK = 1500;
// UX audit PR 2: what the person reads in the panel is written by the agents — in the interface's language. Ids (F1, C1),
// paths, commands and code stay as they are.
const LANGUAGE_NAME = { ru: "Russian", en: "English" } as const;
export const languageLine = (language: "ru" | "en"): string =>
  `Language: write every text the person reads — plan titles and tasks, questions, notes, why, findings' problem and closeWhen, `
  + `condition texts — in ${LANGUAGE_NAME[language]}. Keep ids (R1, C1, F1), file paths, commands and code as they are.`;

// ---------- reports (§4) ----------

const str = (min: number, max: number): AnswerSchema => ({ type: "string", minLength: min, maxLength: max });
const findingsSchema = (verdicts: string[]): AnswerSchema => ({
  type: "object", additionalProperties: false, required: ["verdict", "findings", "question"],
  properties: {
    verdict: { type: "string", enum: verdicts },
    findings: { type: "array", items: str(1, 1000) },
    question: { type: ["string", "null"], maxLength: 2000 }
  }
});
export const REPORT_SCHEMAS: Readonly<Record<TurnPurpose, AnswerSchema>> = Object.freeze({
  plan: {
    type: "object", additionalProperties: false, required: ["stages", "question"],
    properties: {
      stages: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["title", "task"], properties: { title: str(1, 200), task: str(1, 4000) } }
      },
      question: { type: ["string", "null"], maxLength: 2000 }
    }
  },
  execute: {
    type: "object", additionalProperties: false, required: ["summary", "done"],
    properties: { summary: { type: "string", maxLength: 4000 }, done: { type: "boolean" } }
  },
  review: findingsSchema(["accept", "fix", "replan", "question"]),
  final_review: findingsSchema(["complete", "replan", "question"])
});
// Journal v2, A2 (journal-v2-format.md §2.7): every stage of a plan states its readiness conditions — new ones or the
// plan in force's carried over (keep) — flat, as the schema subset has no anyOf. dropped and dropRequirements (5h §2.3)
// make the plan a proposal the person decides (A4).
const CONDITION_ITEM: AnswerSchema = {
  type: "object", additionalProperties: false, required: ["keep", "text", "covers", "evidence"],
  properties: {
    keep: { type: ["string", "null"], maxLength: 16 },
    text: { type: ["string", "null"], maxLength: 500 },
    covers: { type: ["array", "null"], items: str(1, 16) },
    evidence: {
      type: ["object", "null"], additionalProperties: false, required: ["kind", "check"],
      properties: { kind: { type: "string", enum: ["check", "change", "person"] }, check: { type: ["string", "null"], maxLength: 16 } }
    }
  }
};
const PLAN_V2_BASE: AnswerSchema = {
  type: "object", additionalProperties: false, required: ["stages", "dropped", "dropRequirements", "question"],
  properties: {
    stages: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["title", "task", "conditions"], properties: { title: str(1, 200), task: str(1, 4000), conditions: { type: "array", items: CONDITION_ITEM } } }
    },
    dropped: { type: "array", items: { type: "object", additionalProperties: false, required: ["condition", "why"], properties: { condition: str(1, 16), why: str(1, 500) } } },
    dropRequirements: { type: "array", items: { type: "object", additionalProperties: false, required: ["requirement", "why"], properties: { requirement: str(1, 16), why: str(1, 500) } } },
    question: { type: ["string", "null"], maxLength: 2000 }
  }
};
// The lead's review in A1–A2 journals (it still reviews): the marks of the stage's "change" conditions, and in the
// final review one for every requirement (journal-v2-format.md §2.7).
const MARK = (status: string[]): AnswerSchema["properties"] => ({ id: str(1, 16), status: { type: "string", enum: status }, note: { type: "string", maxLength: 1000 } });
export const REVIEW_V2_SCHEMA: AnswerSchema = {
  ...REPORT_SCHEMAS.review, required: ["verdict", "findings", "question", "conditions"],
  properties: {
    ...REPORT_SCHEMAS.review.properties,
    conditions: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "status", "paths", "note"], properties: { ...MARK(["met", "not_met"]), paths: { type: "array", items: str(1, 500) } } } }
  }
};
export const FINAL_V2_SCHEMA: AnswerSchema = {
  ...REPORT_SCHEMAS.final_review, required: ["verdict", "findings", "question", "requirements"],
  properties: {
    ...REPORT_SCHEMAS.final_review.properties,
    requirements: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "status", "note"], properties: MARK(["met", "not_met"]) } }
  }
};
// A3 (journal-v2-format.md §2.8): the reviewer's report — no verdict (the application decides the stage), findings with
// their numbers and a flat relation (the subset has no anyOf), a request instead.
const FINDING_ITEM: AnswerSchema = {
  type: "object", additionalProperties: false, required: ["id", "severity", "condition", "problem", "evidence", "closeWhen", "status", "paths", "relation"],
  properties: {
    id: { type: ["string", "null"], maxLength: 16 }, severity: { type: "string", enum: ["blocking", "wish"] }, condition: { type: ["string", "null"], maxLength: 16 },
    problem: str(1, 2000), evidence: { type: "string", maxLength: 2000 }, closeWhen: str(1, 1000), status: { type: "string", enum: ["open", "closed"] },
    paths: { type: "array", items: str(1, 500) },
    relation: {
      type: ["object", "null"], additionalProperties: false, required: ["repeatOf", "distinctFrom", "why"],
      properties: { repeatOf: { type: ["string", "null"], maxLength: 16 }, distinctFrom: { type: ["string", "null"], maxLength: 16 }, why: { type: ["string", "null"], maxLength: 1000 } }
    }
  }
};
export const REVIEWER_SCHEMA: AnswerSchema = {
  type: "object", additionalProperties: false, required: ["conditions", "findings", "request", "question"],
  properties: {
    conditions: REVIEW_V2_SCHEMA.properties!.conditions, findings: { type: "array", items: FINDING_ITEM },
    request: { type: "string", enum: ["none", "replan", "question"] }, question: { type: ["string", "null"], maxLength: 2000 }
  }
};
export const FINAL_REVIEWER_SCHEMA: AnswerSchema = {
  ...REVIEWER_SCHEMA, required: [...REVIEWER_SCHEMA.required!, "requirements"],
  properties: { ...REVIEWER_SCHEMA.properties, requirements: FINAL_V2_SCHEMA.properties!.requirements }
};
// Journal v2: the first plan turn of a goal without check commands also proposes them — or says why there are none
// (journal-v2-format.md §2.1, «Поле checks отчёта плана»). Every other plan turn of a v2 journal answers checks: null
// (PLAN_V2_SCHEMA): a proposal there is an invalid report. v1 journals keep the plan schema above.
export const PLAN_PROPOSAL_SCHEMA: AnswerSchema = {
  ...PLAN_V2_BASE,
  required: ["stages", "dropped", "dropRequirements", "question", "checks"],
  properties: {
    ...PLAN_V2_BASE.properties,
    checks: {
      type: ["object", "null"], additionalProperties: false, required: ["checks", "none"],
      properties: {
        checks: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["command", "why", "source"], properties: { command: str(1, 1000), why: str(1, 500), source: { type: "array", items: str(1, 500) } } }
        },
        none: { type: ["string", "null"], maxLength: 500 }
      }
    }
  }
};
export const PLAN_V2_SCHEMA: AnswerSchema = {
  ...PLAN_V2_BASE, required: ["stages", "dropped", "dropRequirements", "question", "checks"], properties: { ...PLAN_V2_BASE.properties, checks: { type: "null" } }
};
const schemaOf = (purpose: TurnPurpose, st: RunState, goal: Goal): AnswerSchema => st.version !== 2 ? REPORT_SCHEMAS[purpose]
  : purpose === "plan" ? (proposesChecks(st, goal) ? PLAN_PROPOSAL_SCHEMA : PLAN_V2_SCHEMA)
    : purpose === "review" ? (byReviewer(st) ? REVIEWER_SCHEMA : REVIEW_V2_SCHEMA) : purpose === "final_review" ? (byReviewer(st) ? FINAL_REVIEWER_SCHEMA : FINAL_V2_SCHEMA)
      : REPORT_SCHEMAS[purpose];
// Stage A gate: the ids a review may mark, in its schema (structured output keeps the model to them): the stage's own
// "change" conditions, the stale ones a final review confirms, the requirements in force. No id at all: no mark
// (maxItems 0, never an empty enum).
const marksOf = (list: AnswerSchema, ids: readonly string[]): AnswerSchema => ids.length
  ? { ...list, items: { ...list.items!, properties: { ...list.items!.properties, id: { type: "string", enum: [...ids] } } } }
  : { ...list, maxItems: 0 };
export function narrowMarks(schema: AnswerSchema, conditions: readonly string[] | null, requirements: readonly string[] | null): AnswerSchema {
  const p = schema.properties!;
  return compileSchema({ ...schema, properties: {
    ...p,
    ...(conditions && p.conditions ? { conditions: marksOf(p.conditions, conditions) } : {}),
    ...(requirements && p.requirements ? { requirements: marksOf(p.requirements, requirements) } : {})
  } });
}
for (const s of [...Object.values(REPORT_SCHEMAS), PLAN_PROPOSAL_SCHEMA, PLAN_V2_SCHEMA, REVIEW_V2_SCHEMA, FINAL_V2_SCHEMA, REVIEWER_SCHEMA, FINAL_REVIEWER_SCHEMA]) compileSchema(s); // a schema the engine would refuse fails at load

interface PlanReport { stages: { title: string; task: string }[]; question: string | null }
interface ProposedCheck { command: string; why: string; source: string[] }
// checks.proposed.proposal (journal-v2-format.md §2.1)
export interface ChecksProposalText { checks: (ProposedCheck & { id: string })[]; none: string | null }
interface PlanProposalReport extends PlanReport { checks: { checks: ProposedCheck[]; none: string | null } | null }
interface ReviewReport { verdict: string; findings: string[]; question: string | null }
// confirm: a final review's stale conditions, the only ones it marks
interface ReviewMarks { conditions?: ConditionMark[]; requirements?: RequirementMark[]; findings?: ReportFinding[]; confirm?: string[] }
interface ReviewerReport { conditions: ConditionMark[]; requirements?: RequirementMark[]; findings: ReportFinding[]; request: ReviewRequest; question: string | null }

// What the Р1 schema subset cannot say: counts and "question iff verdict question".
function reportProblem(purpose: TurnPurpose, value: unknown, schema: AnswerSchema = REPORT_SCHEMAS[purpose]): string | null {
  const proposal = schema === PLAN_PROPOSAL_SCHEMA;
  const errors = validateAnswer(schema, value);
  if (errors.length) return errors.slice(0, 3).join("; ");
  if (purpose === "plan") {
    const p = value as PlanReport;
    if (p.question !== null && p.question.trim() === "") return "question must be null or non-empty";
    if (p.question === null && (p.stages.length < 1 || p.stages.length > 50)) return "a plan has 1..50 stages";
  }
  if (proposal) {
    // a proposal with the plan, never with a question: the answer first, then a plan turn that proposes
    const c = (value as PlanProposalReport).checks;
    if ((c === null) !== ((value as PlanReport).question !== null)) return "checks are proposed with the plan, and only without a question";
    if (c) {
      const lines = c.checks.map((x) => x.command.trim());
      if (lines.length > 16) return "at most 16 check commands";
      if (lines.some((l) => !LINE(l)) || new Set(lines).size !== lines.length) return "check commands: distinct lines of 1..1000 characters";
      if (c.checks.some((x) => x.why.trim() === "")) return "every proposed command says why";
      if (c.checks.some((x) => x.source.length > 16 || x.source.some((f) => f.startsWith("/") || f.split("/").includes("..")))) return "source: up to 16 relative paths";
      if ((c.none !== null && c.none.trim() !== "") !== (lines.length === 0)) return "none says why exactly when no command is proposed";
    }
  }
  if (schema === REVIEWER_SCHEMA || schema === FINAL_REVIEWER_SCHEMA) {
    const r = value as ReviewerReport;
    if (r.findings.length > 50) return "at most 50 findings";
    if ((r.request === "question") !== (r.question !== null && r.question.trim() !== "")) return "question is required exactly for request question";
    return null;
  }
  if (purpose === "review" || purpose === "final_review") {
    const r = value as ReviewReport;
    if (r.findings.length > 50) return "at most 50 findings";
    if ((r.verdict === "question") !== (r.question !== null && r.question.trim() !== "")) return "question is required exactly for verdict question";
  }
  return null;
}

// ---------- goal (§2) ----------

// v2: a journal v2 run, where the check commands may be left empty for the lead to propose (journal-v2-format.md §0).
function checkGoal(input: GoalInput, registryOf: (commands: string[] | null) => CheckRegistry, now: number, v2 = false): Goal {
  const bad = (m: string): never => { throw new OrchestrationError("invalid_goal", m); };
  let commands: string[] | null = null;
  if (input?.commands !== undefined) {
    if (!Array.isArray(input.commands) || input.commands.length < (v2 ? 0 : 1) || input.commands.length > 16
      || input.commands.some((c) => typeof c !== "string" || c.trim() === "" || c.length > 1000 || c.includes("\0"))) bad("commands: 1..16 command lines of 1..1000 characters");
    if (Array.isArray(input.checks) && input.checks.length > 0) bad("checks and commands exclude each other");
    commands = input.commands.map((c) => c.trim());
    input = { ...input, checks: commands.map((_, i) => `cmd-${i + 1}`) };
  }
  if (input.workMode !== undefined && !["project", "copy", "worktree"].includes(input.workMode)) bad("workMode must be project, worktree or copy");
  if (input.mode !== undefined && input.mode !== "autopilot" && input.mode !== "steps") bad("mode must be autopilot or steps");
  const stage13 = input.mode !== undefined || input.prepare !== undefined || input.finish !== undefined || input.access !== undefined;
  if (stage13 && !commands) bad("a goal with a mode, preparation, actions after success or rights needs its check commands");
  const prepare = input.prepare === undefined ? undefined : checkPrepare(input.prepare, bad);
  const finish = input.finish === undefined ? undefined : checkFinish(input.finish, bad);
  if (finish && (finish.commit || finish.push || finish.qa) && input.workMode === "copy") bad("actions after success need the project folder or a worktree");
  if (input.access !== undefined && (!isClaudeAccess(input.access?.claude) || !isCodexAccess(input.access?.codex))) bad("access: unknown mode");
  const models = input.models === undefined ? undefined : checkModels(input.models, v2, bad);
  if (input.language !== undefined && input.language !== "ru" && input.language !== "en") bad("language must be ru or en");
  const task = input.task === undefined ? undefined : checkTask(input.task, v2, bad);
  const base = input.base === undefined ? undefined : checkBase(input.base, v2, input.workMode, bad);
  const registry = registryOf(commands);
  if (typeof input?.text !== "string" || input.text.trim() === "" || input.text.length > 8000) bad("text must be 1..8000 characters");
  if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 32
    || input.criteria.some((c) => typeof c !== "string" || c.trim() === "" || c.length > 500)) bad("criteria: 1..32 strings of 1..500");
  if (!Array.isArray(input.checks) || input.checks.length < (commands?.length === 0 ? 0 : 1) || input.checks.length > 16 || new Set(input.checks).size !== input.checks.length) {
    bad("checks: 1..16 distinct check ids");
  }
  for (const id of input.checks) resolveCheck(registry, id); // unknown_check
  const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
  for (const [k, v] of Object.entries(limits)) {
    if (!(k in DEFAULT_LIMITS) || !Number.isSafeInteger(v) || v < 1) bad(`limit ${k} must be a positive integer`);
  }
  if (input.reviewPlan !== undefined && typeof input.reviewPlan !== "boolean") bad("reviewPlan must be a boolean");
  return {
    v: 1, text: input.text, criteria: [...input.criteria], checks: [...input.checks],
    reviewPlan: input.mode === "steps" ? true : input.reviewPlan ?? false, // step by step always shows the plan first
    limits: limits as RunLimits, createdAt: now,
    ...(commands ? { commands } : {}), ...(input.workMode ? { workMode: input.workMode } : {}),
    ...(input.mode ? { mode: input.mode } : {}), ...(prepare ? { prepare } : {}), ...(finish ? { finish } : {}),
    ...(input.access ? { access: { claude: input.access.claude, codex: input.access.codex } } : {}),
    ...(models ? { models } : {}), ...(input.language ? { language: input.language } : {}), ...(task ? { task } : {}),
    ...(base ? { base } : {})
  };
}

// B4: a base for a separate copy (C2: or a worktree) — a branch of the project and the commit it named when the run was asked for (the
// commit is what the copy starts from: a branch moved later changes nothing here)
function checkBase(b: unknown, v2: boolean, workMode: GoalInput["workMode"], bad: (m: string) => never): { branch: string; commit: string; key: string } {
  const o = b as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => !["branch", "commit", "key"].includes(k))) bad("base must be { branch, commit, key }");
  if (typeof o!.branch !== "string" || !/^[A-Za-z0-9._\/-]{1,200}$/.test(o!.branch) || o!.branch.includes("..")) bad("base.branch must be a branch name");
  if (typeof o!.commit !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(o!.commit)) bad("base.commit must be a full commit id");
  if (typeof o!.key !== "string" || !/^T-\d{1,6}$/.test(o!.key)) bad("base.key must be T-<n>");
  if (!v2) bad("base: recorded only in a journal v2 goal");
  if (workMode !== "copy" && workMode !== "worktree") bad("base: a separate copy or a worktree only"); // C2: a worktree too
  return { branch: o!.branch as string, commit: o!.commit as string, key: o!.key as string };
}

// B1: a board task in the goal — journal v2 only, like models (a v1 goal is read by 1.5.7 without a schema)
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function checkTask(t: unknown, v2: boolean, bad: (m: string) => never): { id: string; key: string } {
  const o = t as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => k !== "id" && k !== "key")) bad("task must be { id, key }");
  if (typeof o!.id !== "string" || !TASK_ID.test(o!.id)) bad("task.id must be a UUID");
  if (typeof o!.key !== "string" || !/^T-\d{1,6}$/.test(o!.key)) bad("task.key must be T-<n>");
  if (!v2) bad("task: a board task is recorded only in a journal v2 goal");
  return { id: o!.id as string, key: o!.key as string };
}

function checkModels(m: GoalInput["models"], v2: boolean, bad: (m: string) => never): Partial<Record<AgentRole, string>> | undefined {
  if (!m || typeof m !== "object" || Array.isArray(m)) bad("models must be an object");
  const out: Partial<Record<AgentRole, string>> = {};
  for (const [role, name] of Object.entries(m!)) {
    if (role !== "lead" && role !== "executor" && role !== "reviewer") bad(`models: unknown role ${role}`);
    if (typeof name !== "string" || !SAFE_MODEL.test(name)) bad(`models.${role}: model name is not allowed`);
    out[role as AgentRole] = name;
  }
  if (Object.keys(out).length && !v2) bad("models: a role's model is recorded only in a journal v2 goal");
  return Object.keys(out).length ? out : undefined;
}

const LINE = (v: unknown) => typeof v === "string" && v.trim() !== "" && v.length <= 1000 && !/[\0\r\n]/.test(v);
function checkPrepare(p: GoalInput["prepare"], bad: (m: string) => never): { steps: PrepareStep[] } {
  if (!p || !Array.isArray(p.steps) || p.steps.length > 12) bad("prepare: up to 12 steps");
  return {
    steps: p!.steps.map((x) => {
      if (!x || !LINE(x.command) || (x.unless !== null && (typeof x.unless !== "string" || x.unless === "" || x.unless.startsWith("/") || x.unless.split("/").includes("..")))) bad("prepare step: {command, unless}");
      return { command: x.command.trim(), unless: x.unless };
    })
  };
}
function checkFinish(f: GoalFinish, bad: (m: string) => never): GoalFinish {
  if (!f || typeof f !== "object") bad("finish must be an object");
  const name = (v: unknown) => typeof v === "string" && /^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(v) && !v.includes("..");
  if (f.commit !== null && (!f.commit || typeof f.commit.message !== "string" || f.commit.message.trim() === "" || f.commit.message.length > 4000)) bad("finish.commit: {message}");
  if (f.push !== null && (!f.push || !name(f.push.remote) || !name(f.push.branch))) bad("finish.push: {remote, branch}");
  if (f.push && !f.commit) bad("a push needs the commit");
  if (f.qa !== null && (!f.qa || !LINE(f.qa.environment) || !LINE(f.qa.command) || !LINE(f.qa.verify)
    || (f.qa.reportsVersion !== undefined && typeof f.qa.reportsVersion !== "boolean"))) bad("finish.qa: {environment, command, verify, reportsVersion?}");
  return {
    commit: f.commit ? { message: f.commit.message } : null,
    push: f.push ? { remote: f.push.remote, branch: f.push.branch, remoteUrl: typeof f.push.remoteUrl === "string" ? f.push.remoteUrl : null } : null,
    qa: f.qa ? { environment: f.qa.environment.trim(), command: f.qa.command.trim(), verify: f.qa.verify.trim(), reportsVersion: f.qa.reportsVersion === true } : null
  };
}

function registryFor(deps: OrchestrationDeps, commands: readonly string[] | null, sandboxed: readonly string[] = []): CheckRegistry {
  if (!commands) return deps.checks.registry;
  if (!deps.checks.shell) throw new OrchestrationError("environment_error", "no login shell for the project's check commands");
  return shellRegistry(deps.checks.shell.shell, commands, sandboxed);
}

// The goal with the check commands decided for it (journal v2: checks.decided of a goal without commands); any other
// goal as recorded.
// A1.1 (§2.6): with the person's amendments, and which of them run in the check profile.
export async function decidedGoal(root: string, runId: string, st: RunState, goal: Goal): Promise<Goal> {
  const d = st.orch.checksDecision;
  if (!d) return goal;
  const text = JSON.parse((await readText(root, runId, d.ref)).toString("utf8")) as { checks: DecidedCheck[] };
  const amended: Record<string, string> = {};
  for (const [id, a] of Object.entries(st.orch.amended)) amended[id] = JSON.parse((await readText(root, runId, a.line)).toString("utf8")) as string;
  return decided(goal, text.checks, amended, st.orch.checksProposal?.sandboxNetwork === "denied");
}
interface DecidedCheck { id: string; command: string; origin: "lead" | "person" }
// the effective lines (an amendment's line replaces the decided one) and the lead's lines still in the profile
const decided = (goal: Goal, checks: readonly DecidedCheck[], amended: Readonly<Record<string, string>>, profile: boolean): Goal =>
  withCommands(goal, checks.map((c) => amended[c.id] ?? c.command),
    profile ? checks.filter((c) => c.origin === "lead" && !Object.hasOwn(amended, c.id)).map((c) => c.id) : []);
const withCommands = (goal: Goal, commands: string[], sandboxed: string[] = []): Goal => ({ ...goal, commands, checks: commands.map((_, i) => `cmd-${i + 1}`), sandboxed });

// ---------- service ----------

export function createOrchestrationService(deps: OrchestrationDeps) {
  const clock = deps.clock ?? (() => Date.now());
  return {
    // prepareAuto: the profile's automatic preparation (only what the dependency line says; not part of the goal)
    async createRun(input: { source: string; goal: GoalInput; runId?: string; requestKey?: string; prepareAuto?: boolean }): Promise<RunHandle> {
      // journal v2: native runs only (structured modes stay v1, 5h §2.1)
      const v2 = deps.journalV2 === true && Array.isArray(input.goal?.commands);
      const goal = checkGoal(input.goal, (commands) => registryFor(deps, commands), clock(), v2);
      if (input.requestKey !== undefined) goal.requestKey = input.requestKey;
      const runId = input.runId ?? randomUUID();
      const writer = await storeCreateRun(deps.root, runId, { goal: canonical(goal), version: v2 ? 2 : 1, io: deps.storeIo });
      let ws: Workspace;
      try {
        ws = await createWorkspace({ root: deps.root, runId, source: input.source, gitPath: deps.gitPath, mode: goal.workMode ?? "copy",
          ...(goal.base ? { from: goal.base.commit } : {}) });
        await writer.recordWorkspaceCreated({
          sourcePathSha256: createHash("sha256").update(ws.sourcePath).digest("hex"),
          baseline: { commit: ws.baseline.commit, tree: ws.baseline.tree }, head: ws.head
        });
      } catch (error) {
        await writer.setRunStatus("failed", null).catch(() => {});
        await writer.close().catch(() => {});
        throw error;
      }
      const run = controller(deps, clock, writer, ws, goal, input.prepareAuto);
      await run.start();
      return run.handle;
    },

    // After a restart: the store has already written run.recovered; nothing is started until a command says so.
    async openRun(runId: string): Promise<RunHandle> {
      const writer = await storeOpenRun(deps.root, runId, { io: deps.storeIo });
      try {
        const goal = await decidedGoal(deps.root, runId, writer.state(), JSON.parse((await readText(deps.root, runId, writer.state().goal)).toString("utf8")) as Goal);
        const ws = await openWorkspace({ root: deps.root, runId, gitPath: deps.gitPath });
        const st = writer.state();
        // 5h §3.5, journal-v2-format.md §2.5: a decision already in a v2 journal stands — its command was accepted; recover
        // only with its decision for every turn of unknown outcome. pause/resume/stop write no decision of their own, and
        // a v1 journal keeps its rule: interrupted.
        const decidedBy = new Set(st.version === 2 ? st.orch.decidedCommands : []);
        const undecided = Object.keys(st.turns).some((t) => st.turns[t].status === "outcome_unknown" && !st.orch.recoveryDecisions[t]);
        for (const [id, c] of Object.entries(st.commands)) {
          if (c.status !== "unfinished") continue;
          const ok = decidedBy.has(id) && !(c.kind === "recover" && undecided);
          await writer.completeCommand(id, ok ? { status: "accepted", code: null } : { status: "rejected", code: "interrupted" });
        }
        const run = controller(deps, clock, writer, ws, goal);
        await run.reopen();
        return run.handle;
      } catch (error) {
        await writer.close().catch(() => {});
        throw error;
      }
    }
  };
}

type Active = { kind: "turn"; purpose: TurnPurpose; stop(): void } | { kind: "check"; checkId: string; stop(): void }
  | { kind: "prepare"; stop(): void } | { kind: "finish"; step: FinishStep; stop(): void };

function controller(deps: OrchestrationDeps, clock: () => number, writer: RunWriter, ws: Workspace, goal: Goal, prepareAuto?: boolean) {
  const { root } = deps;
  const runId = writer.runId;
  const stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  let registry = registryFor(deps, goal.commands ?? null, goal.sandboxed);
  let commands = goal.checks.map((id) => resolveCheck(registry, id));
  // journal v2: the decided check commands become the run's own (checks.decided, A1.1: checks.amended)
  const adoptGoal = (next: Goal) => {
    goal = next;
    registry = registryFor(deps, goal.commands ?? [], goal.sandboxed);
    commands = goal.checks.map((id) => resolveCheck(registry, id));
  };
  // A1.1: where Seatbelt is, the lead's commands run in the check profile (journal-v2-format.md §2.6)
  const leadSandbox = deps.checks.leadSandbox ?? (sandboxSupport().supported ? {} : false);
  // Check definitions as they are now: the executable's content is hashed again at every decision (§10), so a
  // replaced program makes earlier results and the reviews that saw them stale.
  let checkDefs: CheckDef[] = [];
  const currentDefs = async (): Promise<CheckDef[]> => Promise.all(commands.map(async (c) => ({
    id: c.id, commandSha256: commandSha256(c), executableSha256: await currentExecutableSha256(c)
  })));

  let active: Active | null = null;
  let driving = false;
  let stepBudget: number | null = null;
  let halted = false;
  let stopTimer: NodeJS.Timeout | null = null;
  // An operation we stop ourselves (§7): the run's deadline or the turn's own timeout. The pause it leads to is set
  // once — when the operation's result is in, or after stopGraceMs without it — and a late result continues nothing.
  type Abort = "deadline" | "turn_timeout" | "shutdown";
  let shuttingDown = false;
  let abort: Abort | null = null;
  let abortSettled = false;
  let abortTimer: NodeJS.Timeout | null = null;
  let opTimers: NodeJS.Timeout[] = [];
  let commandChain: Promise<unknown> = Promise.resolve();
  const waiters: (() => void)[] = [];
  const notify = () => { if (!driving && !active) while (waiters.length) waiters.shift()!(); };

  const state = () => writer.state();
  // Observation: every call guarded, a failure switches it off for this run and changes nothing else.
  let activity: RunActivity | null = null;
  try { activity = deps.activity?.(runId) ?? null; } catch { activity = null; }
  const observe = <T,>(fn: (a: RunActivity) => T): T | null => {
    if (!activity) return null;
    try { return fn(activity); } catch { activity = null; return null; }
  };
  let shownStatus = "";
  let latest: { tree: string; at: string } | null = null;
  // Notifications: every record (tick back to 0) and every change of what view() shows besides the journal (tick + 1).
  let tick = 0;
  const changeListeners = new Set<(seq: number) => void>();
  const emit = () => {
    const st = state();
    const key = `${st.status}:${st.pausedReason ?? ""}`;
    // journal v2: a run completed without checks never says just "completed" (journal-v2-format.md §2.3)
    if (key !== shownStatus) { shownStatus = key; observe((a) => a.status(st.completion?.kind === "no_checks" ? "completed_no_checks" : st.status, st.pausedReason)); }
    for (const l of changeListeners) { try { l(st.lastSeq); } catch { /* a listener's failure is its own */ } }
  };
  writer.onAppend(() => { tick = 0; emit(); });
  const touch = () => { tick++; emit(); };
  const deadline = () => goal.createdAt + effectiveLimits(goal, state()).runMs;

  // ---------- permission prompts of the CLIs (stage 12) ----------
  // A turn's CLI asks; the request waits here, is shown in the view and answered only by the person's command. The
  // turn's own deadline is held by the session while it waits. A request lives as long as its turn: after a restart
  // there is nothing to answer (the CLI is gone), so it is kept in memory only; the activity log keeps its history.
  const permissions = new Map<string, { view: OrchestrationPermissionRequest; reply: (r: PermissionReply) => void; turnRole: AgentRole; fingerprint: string | null; ask: PermissionAsk }>();
  const turnOf = () => Object.keys(state().turns).at(-1) ?? null;
  // Kinds a saved decision may cover: a permission for one action. Questions, plans and forms are always the person's.
  const GRANTABLE = ["command", "file_change", "permissions", "tool"];
  // 1.5.13: prompts of read-only commands in this run (readOnly.ts) and the person's "read-only until the run ends"
  const readOnly = { asks: 0, allowed: false };
  const readOnlyAsk = (ask: PermissionAsk): boolean => {
    if (ask.alwaysAsk || !(ask.kind === "command" || ask.tool === "Bash")) return false;
    const command = (ask.input as { command?: unknown } | null)?.command;
    return readOnlyCommand(typeof command === "string" ? command : ask.summary);
  };
  async function savedGrant(fingerprint: string): Promise<{ grantId: string; scope: "run" | "project" } | null> {
    const inRun = state().orch.grants[fingerprint];
    if (inRun) return { grantId: inRun.grantId, scope: inRun.scope };
    const list = await deps.grants?.list().catch(() => []) ?? [];
    const g = list.find((x) => x.fingerprint === fingerprint);
    return g ? { grantId: g.id, scope: "project" } : null;
  }
  // B3 (§5.3): why the CLI asked, as it said it (sanitized): in the feed and on the request
  const whyText = (ask: PermissionAsk): Record<string, string | null> =>
    (ask.why ? { reasonType: ask.why.type === null ? null : sanitize(ask.why.type, ws.repo, 64).text, reason: ask.why.text === null ? null : sanitize(ask.why.text, ws.repo, 300).text } : {});
  function askPerson(role: AgentRole): AskPerson {
    const provider = role === "executor" ? "claude" as const : "codex" as const; // the reviewer runs the lead's CLI (A3)
    const asked: AskPerson = async (ask: PermissionAsk, signal: AbortSignal) => {
      // a prompt the CLI says must reach the person is never answered by a saved decision, nor offered to be saved
      const fingerprint = GRANTABLE.includes(ask.kind) && !ask.alwaysAsk ? grantFingerprint(provider, ask.kind, ask.tool, ask.input) : null;
      // The same action the person already allowed for this run or project: allowed again without a new dialog, and
      // the use is recorded in the history. The CLI gets "allow once" — its own rules are not changed.
      const ro = readOnlyAsk(ask);
      if (ro && readOnly.allowed && !signal.aborted) {
        observe((a) => a.permission(role, provider, turnOf(), "applied", `${sanitize(ask.tool, ws.repo, 120).text || ask.kind}: ${sanitize(ask.summary, ws.repo, 300).text}`, { scope: "readonly_run", kind: ask.kind }));
        return { decision: "allow_once" };
      }
      if (ro) readOnly.asks++;
      const saved = fingerprint ? await savedGrant(fingerprint) : null;
      if (saved && fingerprint && !signal.aborted) {
        const tool = sanitize(ask.tool, ws.repo, 120).text || ask.kind;
        await j(() => writer.recordEvent("permission.applied", { grantId: saved.grantId.slice(0, 64), fingerprint, scope: saved.scope })).catch(() => {});
        observe((a) => a.permission(role, provider, turnOf(), "applied", `${tool}: ${sanitize(ask.summary, ws.repo, 300).text}`, { scope: saved.scope, kind: ask.kind }));
        return { decision: "allow_once" };
      }
      return new Promise<PermissionReply>((resolve, reject) => {
        const requestId = randomUUID();
        const detail = ask.input === undefined ? null : sanitize(typeof ask.input === "string" ? ask.input : JSON.stringify(ask.input, null, 1), ws.repo, 1500).text;
        const options = [...ask.options] as OrchestrationPermissionRequest["options"];
        if (fingerprint && options.includes("allow_once")) options.splice(options.indexOf("deny"), 0, "allow_run", ...(deps.grants ? ["allow_project" as const] : []));
        if (ro && readOnly.asks > 3 && options.includes("deny")) options.splice(options.indexOf("deny"), 0, "allow_readonly_run");
        const view: OrchestrationPermissionRequest = {
          requestId, role, provider, kind: ask.kind, tool: sanitize(ask.tool, ws.repo, 120).text || ask.kind,
          summary: sanitize(ask.summary, ws.repo, 600).text, detail, options,
          questions: (ask.questions ?? []).slice(0, 8).map((q) => ({
            id: q.id.slice(0, 200), question: sanitize(q.question, ws.repo, 600).text, multiple: q.multiple, other: q.other,
            options: q.options.slice(0, 12).map((o) => sanitize(o, ws.repo, 200).text), ...(q.secret ? { secret: true } : {})
          })),
          ...(ask.alwaysAsk ? { alwaysAsk: true } : {}),
          ...(ask.why ? { why: { type: ask.why.type === null ? null : sanitize(ask.why.type, ws.repo, 64).text, text: ask.why.text === null ? null : sanitize(ask.why.text, ws.repo, 300).text } } : {}),
          askedAt: new Date(clock()).toISOString(),
          ...(ask.form ? { form: ask.form } : {}), ...(ask.plan !== undefined ? { plan: sanitize(ask.plan, ws.repo, 20_000).text } : {}),
          ...(ask.server !== undefined ? { server: sanitize(ask.server, ws.repo, 120).text } : {})
        };
        const done = () => { permissions.delete(requestId); touch(); };
        permissions.set(requestId, { view, turnRole: role, fingerprint, ask, reply: (r) => { done(); resolve(r); } });
        observe((a) => a.permission(role, provider, turnOf(), "requested", `${view.tool}: ${view.summary}`, { requestId, kind: view.kind, ...whyText(ask) }));
        signal.addEventListener("abort", () => {
          if (!permissions.has(requestId)) return;
          done();
          observe((a) => a.permission(role, provider, turnOf(), "withdrawn", view.tool, { requestId }));
          reject(new Error("withdrawn"));
        }, { once: true });
        touch();
      });
    };
    // the host's own answer (1.5.13: a sandboxed read the CLI could not parse): recorded apart from the person's
    asked.noted = (ask) => observe((a) => a.permission(role, provider, turnOf(), "applied",
      `${sanitize(ask.tool, ws.repo, 120).text || ask.kind}: ${sanitize(ask.summary, ws.repo, 300).text}`, { scope: "sandbox_static", kind: ask.kind, ...whyText(ask) }));
    return asked;
  }
  // A1.1 (§2.6): the lead's check the sandbox refused last, still in the profile — what check.amend is about
  const refusedCheck = (st: RunState): { checkId: string; command: string } | null => {
    for (const id of goal.sandboxed ?? []) {
      const last = Object.entries(st.checks).filter(([, c]) => c.checkId === id && c.status !== "in_flight").at(-1)?.[0];
      if (last && st.orch.classified[last] === "sandbox") return { checkId: id, command: goal.commands?.[Number(id.slice(4)) - 1] ?? "" };
    }
    return null;
  };
  const viewExtra = () => {
    const first = permissions.values().next().value;
    const st = state();
    return {
      permission: first?.view ?? null, pendingPermissions: permissions.size, workMode: ws.mode, workDir: ws.repo,
      progress: { ...progressOf(st, goal, ws.branch), ...(st.version === 2 ? { conditions: shownConditions, findings: shownFindings } : {}) },
      ...(st.pausedReason === "awaiting_checks_decision" ? { proposal: proposalText } : {}),
      ...(st.pausedReason === "check_needs_permissions" ? { refused: refusedCheck(st) } : {}),
      ...(st.version === 2 && st.status === "paused" && shownDecisions ? { decisions: shownDecisions } : {}),
      // a plan proposal waits for the person on another pause (after a crash): only Continue leads to it
      ...(st.version === 2 && planProposalWaits(st) ? { proposalWaits: true } : {}),
      ...(st.pausedReason === "awaiting_finish_confirmation" ? {
        confirm: { tree: latest?.tree ?? null, commit: latest ? currentCommit(st, latest.tree)?.commit ?? null : null, push: !!goal.finish?.push, qa: !!goal.finish?.qa }
      } : {})
    };
  };

  // setTimeout fires at once for a delay above 2^31-1 ms; a longer wait is capped (no operation lasts 24 days).
  const delay = (ms: number) => Math.min(Math.max(0, ms), 2_147_483_647);
  function armOperation(turnTimeoutMs: number | null): void {
    // The deadline is the service's clock, not the timer's: a timer that fires early (the clock held, the system time set
    // back) waits for what is left; only a clock past the deadline stops the operation — the same clock admit() reads.
    const atDeadline = () => {
      if (clock() < deadline()) opTimers.push(setTimeout(atDeadline, delay(deadline() - clock())));
      else abortActive("deadline");
    };
    opTimers.push(setTimeout(atDeadline, delay(deadline() - clock())));
    if (turnTimeoutMs !== null) opTimers.push(setTimeout(() => abortActive("turn_timeout"), delay(turnTimeoutMs)));
  }
  function disarmOperation(): void {
    for (const t of opTimers) clearTimeout(t);
    opTimers = [];
  }
  function abortActive(why: Abort): void {
    if (!active || abort !== null || halted || state().status === "stopping") return; // a user stop owns it already
    abort = why;
    active.stop();
    abortTimer = setTimeout(() => { abortTimer = null; settleAbort().catch(() => {}).finally(notify); }, stopGraceMs);
  }
  async function settleAbort(): Promise<void> {
    if (abortTimer) { clearTimeout(abortTimer); abortTimer = null; }
    if (abort === null || abortSettled || halted) return;
    abortSettled = true;
    const now = state().status;
    if (now === "stopping") return finishStop();
    if (now === "running" || now === "pausing") {
      await setStatus("paused", abort === "deadline" ? "limit_reached" : abort === "shutdown" ? "app_closed" : "environment_error");
    }
  }

  // Any failed journal write: the writer is poisoned (stage 2), so nothing more can be recorded. Stop what runs.
  function halt(error: unknown): void {
    if (halted) return;
    halted = true;
    void error;
    touch();
    active?.stop();
  }
  // Only a failed append poisons the writer (stage 2); a refused event or an unstored report does not.
  const POISONING = ["write_failed", "writer_poisoned", "writer_closed"];
  async function j<T>(write: () => Promise<T>): Promise<T> {
    if (halted) throw new OrchestrationError("store_failed", "the journal is not writable");
    try {
      return await write();
    } catch (error) {
      if (!(error instanceof StoreError) || POISONING.includes(error.code)) halt(error);
      throw error;
    }
  }
  // A4: a v2 pause is shown with what the person decides on it from its first view (computed before it is written, so no
  // view of the pause goes without its decisions, and none carries another pause's)
  const setStatus = async (status: RunStatus, reason: PausedReason | null = null): Promise<void> => {
    if (status === "paused" && state().version === 2) shownDecisions = shuttingDown ? null : await decisionsView(reason).catch(() => null);
    return j(() => writer.setRunStatus(status, reason));
  };

  // ---------- the driver: one external operation at a time ----------

  function schedule(): void {
    if (driving || halted) return;
    driving = true;
    // Anything unexpected in the cycle (Git, the file system) stops it in a state the user can see and resume from.
    drive().catch(async () => {
      if (!halted && state().status === "running") await setStatus("paused", shuttingDown ? "app_closed" : "environment_error").catch(() => {});
    }).finally(async () => {
      driving = false;
      if (!halted && !active && !shuttingDown && state().status === "running") schedule();
      else notify();
    });
  }

  async function drive(): Promise<void> {
    for (;;) {
      if (halted) return;
      const st = state();
      if (st.status === "stopping") return finishStop();
      if (st.status === "pausing") { await setStatus("paused", "user_request"); return; }
      if (st.status !== "running") return;
      if (shuttingDown) { await setStatus("paused", "app_closed"); return; }
      const decided = await decide();
      if (halted || state().status !== "running") continue; // a command changed the status meanwhile
      const action = decided.action;
      try {
        switch (action.kind) {
          case "none":
            return;
          case "pause":
            await setStatus("paused", action.reason);
            return;
          case "complete":
            await complete(decided.snapshot!);
            return;
          case "accept_checks":
            await decideChecks(null, "accept", null);
            continue;
          case "record_plan":
            await recordProposedPlan(action.turnId);
            continue;
          case "discard":
            await j(() => writer.recordEvent("review.discarded", { turnId: action.turnId, treeBefore: state().orch.turns[action.turnId].tree, treeAfter: decided.snapshot!.tree }));
            continue;
          case "checkpoint":
            await doCheckpoint(action.stage, action.tree);
            continue;
          case "accept":
            await j(() => writer.recordStageAccepted({ stage: action.stage, reviewTurnId: action.reviewTurnId, tree: decided.snapshot!.tree }));
            continue;
          case "turn":
            await runTurn(action, decided.snapshot!);
            // A2: the conditions as shown, after the turn (a pause in it does not reach decide())
            shownConditions = await viewConditions(null);
            shownFindings = findingsView(state(), await conds());
            touch();
            break;
          case "check":
            await runCheck(action);
            break;
          case "prepare":
            await runPrepare(action.reason);
            break;
          case "finish":
            await runFinish(action.step, decided.snapshot!);
            break;
          case "establish":
            await establish(action.step, action.intentId);
            break;
        }
      } catch (error) {
        // a next process the admission rule refused: the operation recorded what it knows, the pause is decided below
        if (!(error instanceof Refused)) throw error;
      }
      // after one external operation
      if (halted) return;
      if (abort !== null) {
        await settleAbort();
        abort = null;
        abortSettled = false;
        return;
      }
      const now = state().status;
      if (now === "stopping") return finishStop();
      if (now === "pausing") { await setStatus("paused", "user_request"); return; }
      if (now === "running" && stepBudget !== null && --stepBudget <= 0) {
        stepBudget = null;
        await setStatus("paused", "step_done");
        return;
      }
    }
  }

  // Integrity (§11), then the snapshot the decision and its keys are about.
  async function decide(): Promise<{ action: Action; snapshot: Snapshot | null }> {
    const st = state();
    const pause = (reason: PausedReason, detail: string) => ({ action: { kind: "pause", reason, detail } as Action, snapshot: null });
    if (!st.workspace) return pause("environment_error", "no workspace in the journal");
    if (st.workspace.pendingRestore || await readIncompleteRestore(ws).catch(() => true)) return pause("environment_error", "an unfinished restore");
    try {
      await verifyWorkspace(ws);
    } catch (error) {
      if (error instanceof WorkspaceError) {
        return pause(error.code === "restore_incomplete" ? "environment_error" : "shared_git_tampered", error.code);
      }
      throw error;
    }
    const refs = await inspectWorkspaceRefs(ws, st.workspace);
    // §12: a checkpoint published before checkpoint.created failed is the one ref that may be taken over, and only if it
    // is exactly what the recorded intent (stage.accepted) produces. The checkpoint action then records it (reused).
    const pending = st.orch.pendingCheckpoint;
    const unjournaled = [];
    for (const r of refs.unjournaled) {
      if (pending !== null && r.name === `stage-${pending}`) {
        const parent = pending === 1 ? st.workspace.baseline.commit : st.workspace.checkpoints[String(pending - 1)]?.commit;
        const tree = st.orch.accepted[String(pending)]?.tree;
        if (parent !== undefined && tree !== undefined && await matchesCheckpointIntent(ws, pending, r.commit, { tree, parent })) continue;
      }
      unjournaled.push(r);
    }
    if (unjournaled.length || refs.missing.length) return pause("shared_git_tampered", "source refs differ from the journal");
    const snapshot = await takeSnapshot(st);
    await loadFindings();
    const c = await conds();
    // A4 (5h §3.7): the "change" evidence of accepted stages whose files changed since their checkpoint
    const stale = c ? await staleOn(st, c, snapshot.tree) : null;
    const facts = conditionFacts(st, goal, c, snapshot.checkKeys, stale);
    shownConditions = conditionsView(st, goal, c, snapshot.checkKeys, stale);
    shownFindings = findingsView(st, c);
    const action = nextAction({
      state: st, goal, limits: effectiveLimits(goal, st), snapshot, now: clock(),
      findingsOf: (turnId) => findingsCache.get(turnId) ?? [],
      // A2: a stage is accepted only with each of its "change" conditions met in that review; the final review completes
      // only with no condition blocker (journal-v2-format.md §2.7)
      ...(facts && c ? {
        conditions: {
          stageUnmet: (stage: number, turnId: string) => changeIdsOf(c.book, stage).some((id) => marksIn(c.reports, turnId).find((m) => m.id === id)?.status !== "met"),
          finalUnmet: conditionBlockers(facts).length > 0,
          // A4 (5h §3.5): the person conditions of a stage, by the person's decisions in force
          person: (stage: number) => {
            const ids = personIdsOf(c.book, stage);
            if (!ids.length) return null;
            const said = ids.map((id) => personStatus(st, id, stage));
            return said.includes("not_met") ? "not_met" : said.every((x) => x === "met") ? "met" : "ask";
          }
        }
      } : {}),
      // A3: the open blocking findings and the disputed items, from the applied texts (journal-v2-format.md §2.8)
      ...(c?.findings ? { findings: findingsInput(st, c) } : {})
    });
    return { action, snapshot };
  }

  // A4 (5h §3.7): which "change" evidence of the accepted stages is stale on `tree` — a path its mark names changed
  // since the stage's checkpoint. Its condition then counts only as the final review confirms it.
  async function staleOn(st: RunState, c: ConditionTexts, tree: string): Promise<(id: string) => boolean> {
    const out = new Set<string>();
    for (const [stage, a] of Object.entries(st.orch.accepted)) {
      const ids = changeIdsOf(c.book, Number(stage));
      if (!ids.length) continue;
      const changed = new Set((await diffTreeNames(ws, st.workspace?.checkpoints[stage]?.tree ?? a.tree, tree, Number.MAX_SAFE_INTEGER)).files.map((f) => f.path));
      for (const id of ids) if (marksIn(c.reports, a.reviewTurnId).find((m) => m.id === id)?.paths.some((x) => changed.has(x))) out.add(id);
    }
    return (id) => out.has(id);
  }

  async function takeSnapshot(st: RunState): Promise<Snapshot> {
    // Prepared dependencies exist only for the node-test check of stages 4–11; the user's own commands run against the
    // project's own dependencies (in the tree, or ignored like vendor/ and node_modules/).
    const prepared = deps.checks.deps;
    const d = prepared ? await inspectPreparedDeps(ws, prepared) : null; // links node_modules before the tree is read (stage 4)
    const facts: DepsFacts = !prepared || !d ? { lockfileSha256: null, realpath: "", stamp: "" } : d.ok
      ? { lockfileSha256: prepared.lockfileSha256, realpath: d.realpath, stamp: d.stamp }
      : { lockfileSha256: prepared.lockfileSha256, realpath: "", stamp: `refused:${createHash("sha256").update(canonical(JSON.parse(JSON.stringify(d.detail ?? null)))).digest("hex")}` };
    const tree = await snapshotCopyTree(ws, st.workspace!.current.tree);
    latest = { tree, at: new Date(clock()).toISOString() };
    checkDefs = await currentDefs();
    const checkKeys: Record<string, string> = {};
    for (const c of checkDefs) checkKeys[c.id] = checkKey(tree, c, facts);
    return { tree, runKey: runKey(tree, checkDefs, facts), checkKeys };
  }

  // ---------- A4: the person's decisions (5h §3.5, §3.6; journal-v2-format.md §2.9) ----------

  let shownDecisions: OrchestrationDecisions | null = null;
  // What the person decides on this pause, about the state of the work now (its runKey and tree go with the decision).
  // pausing: the reason of a pause about to be written (setStatus); otherwise the pause the run is on.
  async function decisionsView(pausing: PausedReason | null = null): Promise<OrchestrationDecisions | null> {
    const st = state();
    if (st.version !== 2 || (pausing === null && st.status !== "paused")) return null;
    const reason: string = pausing ?? st.pausedReason ?? "";
    const c = await conds();
    const book = c?.findings?.book ?? null;
    const proposal = reason === "coverage_lost" && planProposalWaits(st) ? st.orch.proposals.at(-1)! : null;
    const findings = !!book && FINDING_PAUSES.includes(reason) && [...book.list.values()].some((f) => f.status === "open");
    if (!c || (reason !== "awaiting_person_decision" && !proposal && !findings)) return null;
    const snap = await takeSnapshot(st);
    const said = (r: unknown, i: number) => ((r as { findings?: ReportFinding[] } | undefined)?.findings ?? [])[i];
    const disputed = reason !== "awaiting_person_decision" || !book ? [] : book.disputed.map((d) => {
      const f = said(c.reports[d.turnId], d.index);
      return { reviewTurnId: d.turnId, index: d.index, problem: f?.problem ?? d.problem, evidence: f?.evidence ?? "", paths: f?.paths ?? [],
        candidates: d.candidates.map((id) => ({ id, problem: book.list.get(id)?.problem ?? "", paths: book.list.get(id)?.paths ?? [] })) };
    });
    const stage = Object.keys(st.orch.accepted).length + 1;
    const conditions = reason !== "awaiting_person_decision" ? [] : personIdsOf(c.book, stage).filter((id) => personStatus(st, id, stage) === "not_checked")
      .map((id) => ({ id, text: c.book.defs.get(id)!.text, stage }));
    let shown: OrchestrationDecisions["proposal"] = null;
    if (proposal) {
      const text = await readJson<PlanText>(proposal.ref);
      const drops = new Set((text.dropped ?? []).map((x) => x.condition));
      const inForce = [...c.book.stages.values()].flat().filter((id) => !drops.has(id));
      shown = {
        proposalTurnId: proposal.turnId,
        stages: text.stages.map((x, i) => ({ stage: proposal.firstStage + i, title: x.title, conditions: (x.conditions ?? []).map((k) => ("keep" in k ? k.keep : k.id)) })),
        dropped: (text.dropped ?? []).map((x) => ({ id: x.condition, text: c.book.defs.get(x.condition)?.text ?? "", covers: c.book.defs.get(x.condition)?.covers ?? [], why: x.why })),
        dropRequirements: (text.dropRequirements ?? []).map((x) => ({ id: x.requirement, text: goal.criteria[Number(x.requirement.slice(1)) - 1] ?? "", why: x.why })),
        uncovered: goal.criteria.map((_, i) => `R${i + 1}`).filter((r) => !c.book.droppedRequirements.has(r)
          && [...drops].some((id) => c.book.defs.get(id)?.covers.includes(r)) && !inForce.some((id) => c.book.defs.get(id)?.covers.includes(r))),
        findings: book ? openBlocking(book).filter((f) => f.condition !== null && drops.has(f.condition)).map((f) => ({ id: f.id, problem: f.problem, condition: f.condition! })) : []
      };
    }
    return { runKey: snap.runKey, tree: snap.tree, disputed, conditions, findings, proposal: shown };
  }
  const showDecisions = async () => { shownDecisions = await decisionsView().catch(() => null); touch(); };

  // A2 (journal-v2-format.md §2.7): the plans' conditions and the lead's review answers, from texts/ (content-addressed:
  // each read once). shownConditions: as the last decision saw them, for the view.
  const jsonCache = new Map<string, unknown>();
  const readJson: ReadJson = async <T>(ref: TextRef): Promise<T> => {
    if (!jsonCache.has(ref.sha256)) jsonCache.set(ref.sha256, JSON.parse((await readText(root, runId, ref)).toString("utf8")));
    return jsonCache.get(ref.sha256) as T;
  };
  const conds = async (): Promise<ConditionTexts | null> => (state().version === 2 ? loadConditions(state(), readJson) : null);
  let shownConditions: OrchestrationConditions | null = null;
  // The conditions as shown between decisions: stale evidence (A4, 5h §3.7) on the tree last seen
  const viewConditions = async (checkKeys: Readonly<Record<string, string>> | null): Promise<OrchestrationConditions | null> => {
    const c = await conds();
    const tree = latest?.tree;
    return conditionsView(state(), goal, c, checkKeys, c && tree ? await staleOn(state(), c, tree).catch(() => null) : null);
  };
  let shownFindings: OrchestrationFindings | null = null;

  // Findings of past reviews, read once from texts/ (the journal holds only the reference).
  const findingsCache = new Map<string, string[]>();
  async function loadFindings(): Promise<void> {
    for (const r of state().orch.reviews) {
      if (findingsCache.has(r.turnId)) continue;
      if (r.assessed) {
        // A3 (5h §3.3): a reviewer's round is the stage's open blocking findings and unmet conditions after it
        const c = (await conds())!;
        const unmet = r.stage === null ? [] : changeIdsOf(c.book, r.stage).filter((id) => marksIn(c.reports, r.turnId).find((m) => m.id === id)?.status !== "met");
        findingsCache.set(r.turnId, [...(c.findings?.openAfter.get(r.turnId) ?? []), ...unmet]);
        continue;
      }
      const ref = r.findings;
      findingsCache.set(r.turnId, ref ? JSON.parse((await readText(root, runId, ref)).toString("utf8")) as string[] : []);
    }
  }

  // ---------- turns ----------

  // The schema the CLI is offered: a review of a v2 journal with conditions may mark only the ids it decides (narrowMarks).
  async function turnSchema(action: Extract<Action, { kind: "turn" }>, snapshot: Snapshot): Promise<AnswerSchema> {
    const st = state();
    const base = schemaOf(action.purpose, st, goal);
    if (st.version !== 2 || (action.purpose !== "review" && action.purpose !== "final_review")) return base;
    const c = await conds();
    if (!c?.book.conditioned) return base;
    const requirements = requirementIds(goal.criteria.length).filter((r) => !c.book.droppedRequirements.has(r));
    if (action.purpose === "review") return narrowMarks(base, changeIdsOf(c.book, action.stage!), null);
    const stale = await staleOn(st, c, snapshot.tree);
    const confirm = Object.keys(st.orch.accepted).flatMap((n) => changeIdsOf(c.book, Number(n))).filter((id) => stale(id));
    return narrowMarks(base, byReviewer(st) ? confirm : null, requirements);
  }

  async function runTurn(action: Extract<Action, { kind: "turn" }>, snapshot: Snapshot): Promise<void> {
    const st = state();
    // A3 (§2.8): the reviewer reviews a v2 journal the lead did not review — a new session of the lead's CLI each time
    const role: AgentRole = action.purpose === "execute" ? "executor" : action.purpose !== "plan" && byReviewer(st) ? "reviewer" : "lead";
    const limits = effectiveLimits(goal, st);
    // the report is checked against the purpose's schema; the CLI is offered the narrowed one (turnSchema)
    const schema = schemaOf(action.purpose, st, goal);
    const offered = await turnSchema(action, snapshot);
    const request = {
      purpose: action.purpose, role, cwd: ws.repo, task: await buildTask(action, snapshot),
      schema: offered, ...(offered !== schema ? { accept: schema } : {}), sessionId: role === "reviewer" ? null : sessionFor(st, role),
      // the role's own limit, cut to what is left of the run: the deadline is not extended by a long turn
      timeoutMs: Math.max(1, Math.min(role === "executor" ? limits.executorTurnMs : limits.leadTurnMs, deadline() - clock())),
      ask: askPerson(role), ...(goal.access ? { access: goal.access } : {}), ...(ws.mode !== "project" ? { ownFolder: true } : {}),
      ...(goal.models?.[role] ? { model: goal.models[role] } : {})
    };
    const roleTimeoutMs = role === "executor" ? limits.executorTurnMs : limits.leadTurnMs;
    const prepared = deps.agents.prepare(request);
    if (!prepared.ok) {
      await setStatus("paused", "permission_denied");
      return;
    }
    const turnId = randomUUID();
    await j(() => writer.recordOrchTurn({
      turnId, purpose: action.purpose, stage: action.stage, round: action.round,
      planVersion: st.orch.plan?.version ?? null, clarificationVersion: st.orch.clarifications,
      // A3 (§2.8): the tree a reviewer's turn reviews; every turn of a journal the reviewer reviews says it
      ...(st.version === 2 && byReviewer(st) ? { tree: role === "reviewer" ? snapshot.tree : null } : {})
    }));
    await j(() => writer.recordTurnIntent({
      turnId, commandId: null, role, provider: prepared.provider, mode: prepared.mode, sessionId: request.sessionId, task: request.task
    }));

    const watched = observe((a) => a.turn({
      turnId, role, provider: prepared.provider, purpose: action.purpose, stage: action.stage, round: action.round, cwd: ws.repo,
      taskBytes: Buffer.byteLength(request.task), taskPreview: request.task,
      taskSha256: createHash("sha256").update(request.task).digest("hex")
    }));
    let result: ProviderTurnResult;
    if (state().status === "stopping") {
      result = failedTurnResult("stopped", "stopped before the turn started", request.sessionId);
    } else {
      let turn: AgentTurn | null = null;
      try {
        turn = prepared.start(watched?.observer);
      } catch (error) {
        result = failedTurnResult("harness_error", `start failed: ${String((error as Error)?.message ?? error)}`, request.sessionId);
      }
      if (turn) {
        const t = turn;
        active = { kind: "turn", purpose: action.purpose, stop: () => t.stop() };
        touch();
        armOperation(roleTimeoutMs);
        if (state().status === "stopping" || halted) t.stop(); // a stop that landed between the intent and here
        result = await t.result.catch((e) => failedTurnResult("harness_error", String((e as Error)?.message ?? e), t.sessionId));
        disarmOperation();
        active = null;
        touch();
      }
    }
    result = result!;
    const reportValue = result.report.value as Record<string, unknown> | undefined;
    const doneFlag = action.purpose === "execute" && typeof reportValue?.done === "boolean" ? reportValue.done : null;
    const verdict = typeof reportValue?.verdict === "string" ? reportValue.verdict : null;
    const finishedTurn = result;
    observe(() => watched?.finished(finishedTurn.outcome, {
      purpose: action.purpose, report: finishedTurn.report.status, reportedDone: doneFlag, verdict,
      question: typeof reportValue?.question === "string" && reportValue.question.trim() !== "",
      ...endingDetail(finishedTurn.transport?.ending)
    }));
    let reportStored = true;
    try {
      await j(() => writer.recordTurnResult(turnId, result));
    } catch (error) {
      // report_not_stored: turn.finished is written without the report and forbids the next turn (stage 2)
      if (!(error instanceof StoreError && error.code === "report_not_stored")) return;
      reportStored = false;
    }
    if (halted || state().status !== "running" && state().status !== "pausing") return; // a late result: a fact, no continuation
    if (abort !== null) return; // stopped by the deadline or its timeout: the result is a fact, nothing follows from it

    if (role === "reviewer") {
      // 5h §3.1: a review of a tree that changed during it is dropped before anything else is concluded from it
      const after = await snapshotCopyTree(ws, state().workspace!.current.tree);
      latest = { tree: after, at: new Date(clock()).toISOString() };
      if (after !== snapshot.tree) { await j(() => writer.recordEvent("review.discarded", { turnId, treeBefore: snapshot.tree, treeAfter: after })); return; }
    }
    if (role === "lead") {
      const after = await snapshotCopyTree(ws, state().workspace!.current.tree);
      latest = { tree: after, at: new Date(clock()).toISOString() };
      // In the project folder the lead has the user's own tools (stage 12): a change it makes is its right, shown in
      // Changes and reviewed like any other; only a separate copy keeps the lead read-only.
      if (after !== snapshot.tree && !inPlace(ws.mode)) { await setStatus("paused", "lead_modified_tree"); return; }
    }
    const outcomePause = pauseForOutcome(result, stoppedByUs());
    if (outcomePause) { await setStatus("paused", outcomePause); return; }
    if (!reportStored) { await setStatus("paused", "invalid_report"); return; }
    const value = result.report.value;
    if (reportProblem(action.purpose, value, schema) !== null) { await setStatus("paused", "invalid_report"); return; }

    if (action.purpose === "plan") {
      const p = value as PlanReport;
      if (p.question !== null) return askQuestion(turnId, p.question);
      // A2: the plan's conditions by their rules (journal-v2-format.md §2.7); a violation records nothing, and the next
      // plan turn is told what was wrong
      if (st.version === 2 && (await planViolations(value as PlanReportV2, schema)).length) { await setStatus("paused", "invalid_report"); return; }
      if (schema === PLAN_PROPOSAL_SCHEMA) return proposeChecks(turnId, (value as PlanProposalReport).checks!);
      if (st.version === 2) return recordPlanV2(turnId, value as PlanReportV2);
      const ref = await j(() => writer.putText(canonical({ stages: p.stages, question: p.question })));
      await j(() => writer.recordPlan({
        turnId, version: (state().orch.plan?.version ?? 0) + 1, plan: ref,
        firstStage: Object.keys(state().orch.accepted).length + 1, stageCount: p.stages.length
      }));
    } else if (role === "reviewer") {
      const r = value as ReviewerReport;
      const plan = await reviewerPlan(action, r, snapshot.tree, snapshot.runKey);
      if (!plan.applied) { await setStatus("paused", "invalid_report"); return; }
      const report = state().turns[turnId].report!.ref!;
      const applied: Applied = { report, conditionsMet: r.conditions.filter((m) => m.status === "met").map((m) => m.id), ...plan.applied };
      const ref = await j(() => writer.putText(canonical(applied)));
      await j(() => writer.recordEvent("review.assessed", {
        turnId, stage: action.stage, request: r.request, report, applied: ref, clarificationVersion: state().orch.turns[turnId].clarificationVersion, runKey: snapshot.runKey
      }));
      await noteIgnored(role, prepared.provider, turnId, { ...r, ...(plan.confirm ? { confirm: plan.confirm } : {}) }, snapshot.tree);
      if (r.request === "question") return askQuestion(turnId, r.question as string);
    } else if (action.purpose === "review" || action.purpose === "final_review") {
      const r = value as ReviewReport;
      // A2: the lead's marks — each "change" condition of the stage with paths the run changed, each requirement in the
      // final review — before anything of the review is recorded (journal-v2-format.md §2.7)
      if (st.version === 2 && (await reviewViolations(action, value, latest?.tree ?? snapshot.tree)).length) { await setStatus("paused", "invalid_report"); return; }
      const findings = [...new Set(r.findings.map((f) => f.trim()))];
      const ref = findings.length ? await j(() => writer.putText(canonical(findings))) : null;
      findingsCache.set(turnId, findings);
      await j(() => writer.recordReview({
        turnId, stage: action.stage, verdict: r.verdict as never, findings: ref, findingsKey: findingsKey(findings),
        findingsCount: findings.length, clarificationVersion: state().orch.turns[turnId].clarificationVersion, runKey: snapshot.runKey
      }));
      if (st.version === 2) await noteIgnored(role, prepared.provider, turnId, value as ReviewMarks, latest?.tree ?? snapshot.tree);
      if (r.verdict === "question") return askQuestion(turnId, r.question as string);
    }
  }

  // What a recorded review gave besides what it decides, said in the feed and never counted: a mark of a check or person
  // condition (ignoredMarks), of a requirement the person dropped, and files a met mark names that did not change.
  async function noteIgnored(role: AgentRole, provider: "codex" | "claude", turnId: string, r: ReviewMarks, tree: string): Promise<void> {
    const c = await conds();
    if (!c?.book.conditioned) return;
    const note = (text: string, detail: Record<string, string>) => observe((a) => a.reportNote(role, provider, turnId, text, detail));
    const marks = r.conditions ?? [];
    for (const x of ignoredMarks(marks, c.book)) note(`${x.id} marked: not counted, it is met by ${x.by === "check" ? "its command" : "the person"}`, { ignoredMark: x.id, by: x.by });
    for (const m of r.requirements ?? []) if (c.book.droppedRequirements.has(m.id)) note(`${m.id} marked: not counted, dropped by the person`, { ignoredMark: m.id, by: "dropped" });
    let kept = decidedMarks(marks, c.book);
    if (r.confirm) {
      for (const m of kept) if (!r.confirm.includes(m.id)) note(`${m.id} marked: not counted, nothing to confirm`, { ignoredMark: m.id, by: "unconfirmed" });
      kept = kept.filter((m) => r.confirm!.includes(m.id));
    }
    const changedSince = async (from: string) => new Set((await diffTreeNames(ws, from, tree, Number.MAX_SAFE_INTEGER)).files.map((f) => f.path));
    if (kept.some((m) => m.status === "met")) {
      const changed = await changedSince(state().workspace!.baseline.tree);
      for (const x of unchangedPaths(kept, changed)) note(`${x.id}: ${x.paths.join(", ")} not changed: not its evidence`, { ignoredMark: x.id, by: "unchanged", paths: x.paths.join(", ") });
    }
    // a finding the review closed: the files it named that did not change since it was opened
    for (const f of r.findings ?? []) {
      const known = f.id !== null && f.status === "closed" ? c.findings?.book.list.get(f.id) : undefined;
      if (known?.severity !== "blocking" || f.paths.length === 0) continue;
      const changed = await changedSince(known.openTree);
      const extra = f.paths.filter((p) => !changed.has(p));
      if (extra.length && extra.length < f.paths.length) note(`${f.id}: ${extra.join(", ")} not changed: not its evidence`, { ignoredMark: known.id, by: "unchanged", paths: extra.join(", ") });
    }
  }

  function stoppedByUs(): boolean {
    return state().status === "stopping";
  }

  async function askQuestion(turnId: string, text: string): Promise<void> {
    const ref = await j(() => writer.putText(text));
    await j(() => writer.recordQuestion({ questionId: randomUUID(), turnId, text: ref }));
  }

  // ---------- journal v2: proposed check commands, completion (journal-v2-format.md §2) ----------

  // The proposal with the numbers the application gives its lines; the plan of the turn waits for the decision.
  async function proposeChecks(turnId: string, c: NonNullable<PlanProposalReport["checks"]>): Promise<void> {
    const text: ChecksProposalText = { checks: c.checks.map((x, i) => ({ id: `cmd-${i + 1}`, command: x.command.trim(), why: x.why, source: x.source })), none: c.none };
    const ref = await j(() => writer.putText(canonical(text)));
    proposalText = text;
    // A1.1: the lead's commands run in the check profile, which denies the network (but this machine's): the
    // autopilot may accept them itself. Without Seatbelt they would run in the user's shell: the person decides (A1).
    const sandboxNetwork: SandboxNetwork = leadSandbox ? "denied" : "open";
    await j(() => writer.recordEvent("checks.proposed", { turnId, proposal: ref, count: text.checks.length, sandboxNetwork }));
  }
  let proposalText: ChecksProposalText | null = null;
  const loadProposal = async (): Promise<ChecksProposalText | null> => {
    const p = state().orch.checksProposal;
    if (p && !proposalText) proposalText = JSON.parse((await readText(root, runId, p.ref)).toString("utf8")) as ChecksProposalText;
    return proposalText;
  };

  // «Принять» (the proposal as it is) or «Изменить» (the person's lines); commandId null: the autopilot's acceptance.
  async function decideChecks(commandId: string | null, decision: "accept" | "edit", edited: string[] | null): Promise<void> {
    const p = state().orch.checksProposal!;
    const proposed = (await loadProposal())!.checks.map((x) => x.command);
    const lines = decision === "accept" ? proposed : edited!;
    const text = { checks: lines.map((command, i): DecidedCheck => ({ id: `cmd-${i + 1}`, command, origin: proposed.includes(command) ? "lead" : "person" })) };
    const ref = await j(() => writer.putText(canonical(text)));
    await j(() => writer.recordEvent("checks.decided", { proposalTurnId: p.turnId, decision, by: commandId ? "person" : "autopilot", commandId, checks: ref, count: lines.length }));
    adoptGoal(decided(goal, text.checks, {}, p.sandboxNetwork === "denied"));
  }

  // The plan of the turn whose proposal was accepted: its report without the proposal.
  async function recordProposedPlan(turnId: string): Promise<void> {
    const report = JSON.parse((await readText(root, runId, state().turns[turnId].report!.ref!)).toString("utf8")) as PlanReportV2;
    await recordPlanV2(turnId, report);
  }

  // ---------- A2: the plan's conditions and the lead's marks (journal-v2-format.md §2.7) ----------

  // What is wrong with a v2 plan: the shape of its conditions, then 5h §2.3 against the plans in force. A proposal's
  // "check" conditions name the proposed commands; any other plan's, the run's own.
  async function planViolations(report: PlanReportV2, schema: AnswerSchema): Promise<string[]> {
    const c = (await conds())!;
    const { stages, problems } = reportConditions(report);
    const proposing = schema === PLAN_PROPOSAL_SCHEMA;
    const checkIds = proposing ? ((report as unknown as PlanProposalReport).checks?.checks ?? []).map((_, i) => `cmd-${i + 1}`) : goal.checks;
    // A4: dropping is decided by the person after the check commands are; the plan that proposes them drops nothing
    if (proposing && (report.dropped.length || report.dropRequirements.length)) problems.push("the plan that proposes check commands drops nothing: propose dropping in a later plan");
    return [...problems, ...planProblems(stages, report, c.book, Object.keys(state().orch.accepted).length + 1, goal.criteria.length, checkIds, await returnedConditions())];
  }
  // A4 (5h §3.8): the conditions of accepted stages a refused final review returns to the work — the next plan keeps or
  // drops each: those without evidence in force on the final review's tree (stale and not confirmed, not met), covering
  // a requirement it marked not met, or bound to an open blocking finding. Empty unless the last review of the plan in
  // force is a final one that did not complete the run.
  async function returnedConditions(): Promise<Set<string>> {
    const st = state();
    const c = await conds();
    const id = finalReview(st);
    const last = st.orch.reviews.filter(inForce(st)).at(-1);
    if (!c || !id || last?.turnId !== id || !last.assessed || !c.book.conditioned) return new Set();
    const tree = st.orch.turns[id]?.tree;
    // the checks the final review was given: the latest result of each command before it (run on its tree)
    const keys: Record<string, string> = {};
    for (const [run, a] of Object.entries(st.orch.assessed).sort((x, y) => x[1].seq - y[1].seq)) {
      if (a.seq < st.orch.turns[id].seq && st.checks[run]) keys[st.checks[run].checkId] = a.checkKey;
    }
    const facts = conditionFacts(st, goal, c, keys, tree ? await staleOn(st, c, tree) : null);
    const report = c.reports[id] as { requirements?: RequirementMark[] } | undefined;
    const notMet = new Set((report?.requirements ?? []).filter((m) => m.status === "not_met").map((m) => m.id));
    const open = new Set((c.findings ? openBlocking(c.findings.book) : []).map((f) => f.condition));
    const accepted = Object.keys(st.orch.accepted).length;
    return new Set((facts?.conditions ?? []).filter((x) => x.stage <= accepted && (x.status !== "met" || open.has(x.id)
      || c.book.defs.get(x.id)!.covers.some((r) => notMet.has(r)))).map((x) => x.id));
  }
  // The plan with the numbers the application gives its new conditions; one that drops a condition or a requirement is a
  // proposal the person decides (A4, 5h §3.6): plan.proposed, the plan in force stays.
  async function recordPlanV2(turnId: string, report: PlanReportV2): Promise<void> {
    // a proposal of A1's form accepted before this version: its plan has no conditions, and is recorded so (§2.7)
    if (report.stages.some((x) => !Array.isArray(x.conditions))) {
      const ref = await j(() => writer.putText(canonical({ stages: report.stages.map(({ title, task }) => ({ title, task })), question: null })));
      await j(() => writer.recordPlan({ turnId, version: (state().orch.plan?.version ?? 0) + 1, plan: ref, firstStage: Object.keys(state().orch.accepted).length + 1, stageCount: report.stages.length }));
      return;
    }
    const { text, assigned } = numberPlan(report, reportConditions(report).stages, state().orch.nextCondition);
    const ref = await j(() => writer.putText(canonical(text)));
    if (text.dropped?.length || text.dropRequirements?.length) {
      await j(() => writer.recordEvent("plan.proposed", { turnId, plan: ref, firstStage: Object.keys(state().orch.accepted).length + 1, stageCount: text.stages.length, conditionsAssigned: assigned }));
      return;
    }
    await j(() => writer.recordPlan({
      turnId, version: (state().orch.plan?.version ?? 0) + 1, plan: ref,
      firstStage: Object.keys(state().orch.accepted).length + 1, stageCount: text.stages.length, conditionsAssigned: assigned
    }));
  }
  // The lead's marks of a review it answered with a verdict about the work (accept, fix; complete in the final review).
  async function reviewViolations(action: Extract<Action, { kind: "turn" }>, value: unknown, tree: string): Promise<string[]> {
    const c = (await conds())!;
    if (action.purpose === "final_review") {
      const r = value as ReviewReport & { requirements: RequirementMark[] };
      // a plan of A1's form has no conditions: the condition rules do not apply to it (§2.7)
      return r.verdict === "complete" && c.book.conditioned ? finalMarksProblems(r.requirements, goal.criteria.length, c.book.droppedRequirements) : [];
    }
    const r = value as ReviewReport & { conditions: ConditionMark[] };
    if (r.verdict !== "accept" && r.verdict !== "fix") return [];
    const changed = new Set((await diffTreeNames(ws, state().workspace!.baseline.tree, tree, Number.MAX_SAFE_INTEGER)).files.map((f) => f.path));
    return stageMarksProblems(decidedMarks(r.conditions, c.book), changeIdsOf(c.book, action.stage!), changed);
  }

  // A3 (journal-v2-format.md §2.8): the reviewer's report against the conditions and the findings now — the violations
  // (invalid_report), or what the application does with it. tree: the reviewed one.
  async function reviewerPlan(action: Extract<Action, { kind: "turn" }>, r: ReviewerReport, tree: string, key: string): Promise<{ problems: string[]; applied: Omit<Applied, "report" | "conditionsMet"> | null; confirm: string[] | null }> {
    const c = (await conds())!;
    const book = c.findings!.book;
    const problems: string[] = [];
    let confirm: string[] | null = null;
    const changedSince = async (from: string) => new Set((await diffTreeNames(ws, from, tree, Number.MAX_SAFE_INTEGER)).files.map((f) => f.path));
    if (action.purpose === "final_review") {
      // A4 (5h §3.7): the final review confirms the stale evidence of accepted stages — a mark for each, none else; met
      // names files changed since the run started
      const stale = await staleOn(state(), c, tree);
      const ids = Object.keys(state().orch.accepted).flatMap((s) => changeIdsOf(c.book, Number(s))).filter((id) => stale(id));
      confirm = ids;
      // stage A gate: a mark of a condition with nothing to confirm is extra — a final review's mark counts only for a
      // stale one (factsOf: confirmed) — left out, said in the feed
      const marks = decidedMarks(r.conditions, c.book).filter((m) => ids.includes(m.id));
      if (r.request === "none") problems.push(...stageMarksProblems(marks, ids, await changedSince(state().workspace!.baseline.tree)));
      if (r.request === "none" && c.book.conditioned) problems.push(...finalMarksProblems(r.requirements ?? [], goal.criteria.length, c.book.droppedRequirements));
    } else if (r.request === "none") {
      problems.push(...stageMarksProblems(decidedMarks(r.conditions, c.book), changeIdsOf(c.book, action.stage!), await changedSince(state().workspace!.baseline.tree)));
    }
    const diffs = new Map<string, Set<string>>();
    for (const f of book.list.values()) for (const t of [f.openTree, f.closeTree]) if (t && !diffs.has(t)) diffs.set(t, await changedSince(t));
    const planned = planReview(book, r.findings, {
      turnId: "", seq: 0, runKey: key, tree, stage: action.stage, changedSince: (t) => diffs.get(t) ?? new Set(),
      stageConditions: action.stage === null ? null : c.book.stages.get(action.stage) ?? [], conditions: [...c.book.defs.keys()]
    });
    problems.push(...planned.problems);
    return { problems, applied: problems.length ? null : planned.applied, confirm };
  }
  // The reviewer's last turn the application did not apply (invalid_report): what was wrong, recomputed from its report.
  async function rejectedReview(snapshot: Snapshot): Promise<string[]> {
    const st = state();
    const id = st.orch.lastOrchTurn;
    const t = id ? st.orch.turns[id] : null;
    const ref = id ? st.turns[id]?.report?.ref : null;
    if (!id || !t || !ref || st.turns[id].role !== "reviewer" || st.orch.reviews.some((r) => r.turnId === id) || Object.hasOwn(st.orch.discarded, id)) return [];
    const report = await readJson<ReviewerReport>(ref);
    const shape = reportProblem(t.purpose, report, schemaOf(t.purpose, st, goal));
    return shape ? [shape] : (await reviewerPlan({ kind: "turn", purpose: t.purpose, stage: t.stage, round: t.round }, report, t.tree ?? snapshot.tree, snapshot.runKey)).problems;
  }

  // run.status(completed) of a v2 journal: only as the completion function allows, with its kind and what it was
  // decided on (journal-v2-format.md §2.3). A cycle that disagrees with it never completes the run.
  async function complete(snapshot: Snapshot): Promise<void> {
    const st = state();
    if (st.version !== 2) return setStatus("completed");
    const cs = await conds();
    const facts = conditionFacts(st, goal, cs, snapshot.checkKeys, cs ? await staleOn(st, cs, snapshot.tree) : null);
    const f = cs?.findings ?? null;
    const c = completion(st, goal, snapshot, facts, f && { open: openBlocking(f.book).length, disputed: f.book.disputed.length });
    if (!c.allowed) { await setStatus("paused", "environment_error"); return; }
    const progress = progressOf(st, goal, ws.branch);
    // the run on the tree it completes on (A2: the evidence the facts above counted, never one of another tree)
    const passed = (id: string) => checkOn(st, id, snapshot.checkKeys).checkRunId;
    const basis = {
      kind: c.kind, checks: goal.checks.map((id, i) => ({ id, command: goal.commands?.[i] ?? id, checkRunId: passed(id) })),
      runKey: snapshot.runKey, checkKeys: snapshot.checkKeys, tree: snapshot.tree,
      finalTurnId: st.orch.reviews.filter((r) => r.stage === null).at(-1)?.turnId ?? null,
      // A2: R → C → evidence (the checks above, the reviews in the journal)
      ...(facts ? { requirements: facts.requirements.map((r) => ({ id: r.id, conditions: r.conditions, met: r.status === "met", ...(r.status === "dropped" ? { dropped: true } : {}) })) } : {}),
      // A4 (journal-v2-format.md §2.9): what the person decided instead of evidence — never counted as met
      ...(cs && (cs.book.dropped.size || cs.book.droppedRequirements.size || f?.book.downgraded.length || st.orch.person.length) ? {
        person: {
          droppedConditions: [...cs.book.dropped.keys()], droppedRequirements: [...cs.book.droppedRequirements.keys()], downgraded: [...(f?.book.downgraded ?? [])],
          closedByPerson: [...(f?.book.list.values() ?? [])].filter(closedByPerson).map((x) => x.id),
          conditions: (facts?.conditions ?? []).filter((x) => cs.book.defs.get(x.id)?.evidence.kind === "person").map((x) => ({ id: x.id, status: x.status }))
        }
      } : {}),
      finish: progress.finish.filter((f) => f.asked).map((f) => ({ step: f.step, status: f.status, declined: f.declined ?? false, commit: f.commit }))
    };
    const ref = await j(() => writer.putText(canonical(basis)));
    await j(() => writer.setRunStatus("completed", null, { kind: c.kind as CompletionKind, basis: ref }));
  }

  // §11: a session is resumed from the role's last completed turn; after a turn of unknown outcome a new one starts.
  function sessionFor(st: RunState, role: AgentRole): string | null {
    const ids = Object.keys(st.turns).filter((id) => st.turns[id].role === role);
    const lastId = ids.at(-1);
    if (lastId && st.turns[lastId].status === "outcome_unknown") return null;
    for (let i = ids.length - 1; i >= 0; i--) {
      const t = st.turns[ids[i]];
      if (t.status === "completed" && t.sessionId) return t.sessionId;
    }
    return null;
  }

  // ---------- checks ----------

  async function runCheck(action: Extract<Action, { kind: "check" }>): Promise<void> {
    let handle: { stop(): void; result: Promise<ProjectCheckResult | ShellCheckResult> };
    try {
      const shell = deps.checks.shell;
      handle = goal.commands && shell
        ? startShellCheck({
          ws, command: resolveCheck(registry, action.checkId), env: shell.env, writer, launch: deps.checks.launch, state: state(), clock,
          // a lead's line of a denied run runs in the profile whatever this opening's leadSandbox says (review S1-2): with
          // no Seatbelt the self-test fails and nothing runs
          ...(goal.sandboxed?.includes(action.checkId) ? { sandbox: { root, realHome: leadSandbox ? leadSandbox.realHome : undefined } } : {})
        })
        : startProjectCheck({
          ws, registry, id: action.checkId, deps: deps.checks.deps!, writer,
          launch: deps.checks.launch, state: state(), sandbox: deps.checks.sandbox
        });
    } catch {
      await setStatus("paused", "environment_error");
      return;
    }
    active = { kind: "check", checkId: action.checkId, stop: () => handle.stop() };
    touch();
    observe((a) => a.check("check_started", action.checkId, { checkId: action.checkId, stage: action.stage, round: action.round }));
    const checkStartedAt = clock();
    armOperation(null); // the check's own timeout is the runner's (registry)
    if (state().status === "stopping" || halted) handle.stop();
    const res = await handle.result;
    observe((a) => {
      const rec = state().checks[res.checkRunId];
      a.check("check_finished", `${action.checkId}: ${res.status}${res.reason ? ` (${res.reason})` : ""}`, {
        checkId: action.checkId, status: res.status, reason: res.reason ?? null, exitCode: rec?.exitCode ?? null,
        durationMs: rec?.durationMs ?? clock() - checkStartedAt, outputDropped: rec?.outputDropped ?? 0,
        outputSha256: rec?.output?.sha256 ?? null
      });
    });
    disarmOperation();
    active = null;
    touch();
    if (res.reason === "store_failed") halt(new OrchestrationError("store_failed", "the check result was not journaled"));
    if (halted || (state().status !== "running" && state().status !== "pausing")) return;
    if (abort !== null) return; // stopped by the deadline: not assessed, the check runs again after raise_limit
    if (res.reason === "sandbox_unavailable") { await setStatus("paused", "sandbox_unavailable"); return; }
    if (!state().checks[res.checkRunId]) { await setStatus("paused", "environment_error"); return; } // refused before it started
    if (res.status === "not_verified" && res.reason === "stopped") return; // not ours: nothing to assess
    const tree = res.copy.treeBefore as string;
    const facts: DepsFacts = { lockfileSha256: deps.checks.deps?.lockfileSha256 ?? null, realpath: res.deps?.realpath ?? "", stamp: res.deps?.stamp ?? "" };
    // the result is about the program preflight hashed, not about whatever is at the path now
    // (a user's shell command reports no hash of its own: the shell's hash from the snapshot stands)
    const defs = checkDefs.map((c) => c.id === action.checkId && res.executableSha256 ? { ...c, executableSha256: res.executableSha256 } : c);
    const def = defs.find((c) => c.id === action.checkId)!;
    await j(() => writer.recordCheckAssessed({
      checkRunId: res.checkRunId, stage: action.stage, round: action.round,
      checkKey: checkKey(tree, def, facts), runKey: runKey(tree, defs, facts)
    }));
    // Stage 13: what a failure says about its cause; an environment or outside failure never goes to the executor.
    if (res.status === "failed" && goal.commands) {
      const out = state().checks[res.checkRunId]?.output;
      const text = out ? (await readText(root, runId, out).catch(() => Buffer.from(""))).toString("utf8") : `${res.output.head}\n${res.output.tail}`;
      // A1.1 (§2.6): a check in the profile that failed the way the sandbox refuses is not the code's failure
      const inProfile = state().checks[res.checkRunId]?.profileSha256 !== NO_SANDBOX_SHA256;
      const cls = inProfile && sandboxRefused(text) ? "sandbox" : classifyFailure(text, state().checks[res.checkRunId]?.exitCode ?? null);
      await j(() => writer.recordEvent("check.classified", { checkRunId: res.checkRunId, class: cls }));
      if (cls !== "code") observe((a) => a.check("check_output", `${action.checkId}: ${cls === "sandbox" ? "refused by the sandbox (the network or a write outside the work folder)" : cls === "external" ? "outside failure (network or a remote service)" : "environment not ready"}`, { checkId: action.checkId, class: cls }));
    }
  }

  // ---------- stage 13: environment preparation ----------

  // The profile's steps that are needed now (what they make is missing, or their lock file changed since they were
  // installed), one after another in the user's shell. The trees of the work folder around them say what they changed
  // (never committed as the run's own work); the lock files' fingerprints after them say what they installed.
  async function runPrepare(reason: "start" | "check"): Promise<void> {
    const shell = deps.checks.shell;
    if (!shell) { await setStatus("paused", "environment_error"); return; }
    const all = goal.prepare?.steps ?? [];
    // the lock files of the folders cloned from the project count as installed, as the preparation's own records do
    const cloned = Object.fromEntries((await readDependencyRecord(ws)).filter((d) => d.result === "cloned" && d.lock && d.sha256).map((d) => [d.lock, d.sha256]));
    const known = Object.assign(cloned, ...state().orch.prepares.map((p) => p.locks ?? {})) as Record<string, string>;
    const needed = await neededSteps(ws.repo, all, known);
    const prepareId = randomUUID();
    const plan = await j(() => writer.putText(canonical(needed.map(({ step, index }) => ({ index, command: step.command, unless: step.unless })))));
    await j(() => writer.recordEvent("prepare.started", { prepareId, reason, steps: plan }));
    const treeNow = () => snapshotCopyTree(ws, state().workspace!.current.tree).catch(() => undefined);
    const before = needed.length ? await treeNow() : undefined;
    // Steps with nothing to install (installsNothing: the project's manifest asks for nothing) succeed without running.
    const nothing: number[] = [];
    for (const [i, step] of all.entries()) if (!needed.some((n) => n.index === i) && await installsNothing(ws.repo, step).catch(() => false)) nothing.push(i);
    for (const i of nothing) observe((a) => a.prepare("prepare_finished", `${all[i].command}: nothing to install`, { step: i, nothing: true }));
    // The preparation's outcome in the feed: status, the failed step's command and exit code, the last 40 lines of what
    // it said (the same text as the journal's output).
    const finish = async (status: string, failed: number | null, cls: FailureClass | null, output: TextRef | null, said: { text?: string; exitCode?: number | null } = {}) => {
      const after = before !== undefined ? await treeNow() : undefined;
      const locks = status === "done" || status === "not_needed" ? await lockFingerprints(ws.repo, all).catch(() => ({})) : {};
      await j(() => writer.recordEvent("prepare.finished", {
        prepareId, status, failed, class: cls, output,
        ...(Object.keys(locks).length ? { locks } : {}), ...(before && after ? { before, after } : {})
      }));
      const command = failed !== null ? all[failed]?.command ?? null : null;
      observe((a) => a.prepare("prepare_finished", `preparation ${status}${command ? `: ${command}${typeof said.exitCode === "number" ? ` (exit ${said.exitCode})` : ""}` : ""}`, {
        summary: true, status, ...(failed !== null ? { failed, command, class: cls } : {}), ...(typeof said.exitCode === "number" ? { exitCode: said.exitCode } : {}),
        ...(said.text ? { output: said.text.split("\n").slice(-40).join("\n").slice(-8000) } : {})
      }));
    };
    if (needed.length === 0) {
      await finish("not_needed", null, null, null);
      return;
    }
    for (const { step, index } of needed) {
      observe((a) => a.prepare("prepare_started", step.command, { step: index }));
      let r: ShellRunResult;
      try {
        r = await shellOp({ kind: "prepare" }, step.command, shell.env, 30 * 60_000);
      } catch (error) {
        // the next step was not admitted: the preparation did not finish, so it runs again once the run continues
        if (error instanceof Refused && !halted) await finish("stopped", null, null, null);
        throw error;
      }
      if (halted) return; // a result after the journal closed (shutdown did not wait for it): nothing more is done
      const output = r.output.bytes > 0 ? await j(() => writer.putText(r.output.text)).catch(() => null) : null;
      const ok = r.exitCode === 0 && r.signal === null && !r.spawnError;
      observe((a) => a.prepare("prepare_finished", `${step.command}: ${ok ? "done" : r.stopCause ? "stopped" : `exit ${r.exitCode ?? r.signal ?? "?"}`}`,
        { step: index, exitCode: r.exitCode, ok, durationMs: r.durationMs, ...(r.stopCause ? { stopped: true } : {}) }));
      if (r.stopCause === "user" || state().status === "stopping" || abort !== null) { await finish("stopped", null, null, output); return; }
      if (!ok) {
        await finish("failed", index, r.spawnError ? "environment" : classifyFailure(r.output.text, r.exitCode) === "external" ? "external" : "environment", output,
          { text: r.spawnError ?? r.output.text, exitCode: r.exitCode });
        return;
      }
    }
    // Done only when what the steps were for is there now (the lock files as they are after the install).
    const steps = needed.map((n) => n.step);
    const still = await neededSteps(ws.repo, steps, await lockFingerprints(ws.repo, steps));
    if (still.length) {
      const text = `still missing after preparation: ${still.map((x) => x.step.unless).join(", ")}`;
      const missing = await j(() => writer.putText(text));
      await finish("failed", needed[still[0].index]?.index ?? still[0].index, "environment", missing, { text });
      return;
    }
    await finish("done", null, null, null);
  }

  // The one rule for starting the next process of the run's own operations (a preparation step, the remote's address,
  // a commit, a push and its ls-remote, a QA deploy and its verification, a confirmation after a restart): nothing
  // starts once the journal is closed, the application is closing, the person stopped the run, or the run's time is up
  // (reached now, or it stopped the operation that just ended). A late success of that operation changes none of it.
  function admit(): void {
    const st = state().status;
    const why = halted ? "the journal is closed" : shuttingDown ? "the application is closing"
      : st === "stopping" || st === "stopped" ? "the person stopped the run"
        : abort !== null || clock() >= deadline() ? "the run's time limit was reached"
          : st !== "running" && st !== "pausing" ? `the run is ${st}` : null;
    if (why) throw new Refused(why);
  }

  // One shell line of the application's own operations (preparation, actions after success), stoppable like a turn.
  async function shellOp(kind: { kind: "prepare" } | { kind: "finish"; step: FinishStep }, line: string, env: Record<string, string>, timeoutMs: number): Promise<ShellRunResult> {
    admit();
    const r = runShell({ shell: deps.checks.shell!.shell, line, cwd: ws.repo, env, launch: deps.checks.launch, timeoutMs, maxOutputBytes: 65_536, clock });
    active = { ...kind, stop: () => r.stop() } as Active;
    touch();
    armOperation(null);
    if (state().status === "stopping" || halted) r.stop();
    const out = await r.result;
    disarmOperation();
    active = null;
    touch();
    return out;
  }

  // ---------- stage 13: actions after success ----------

  // The QA verification, with a new empty result file each time (in the run's folder, never the project): what an
  // earlier verification wrote cannot confirm this one. Three facts kept apart: whether it passed (exit), what it
  // reported (observed) and whether that is the delivered commit (version). Without the contract nothing is read.
  async function qaVerify(p: QaParams, env: Record<string, string>): Promise<{ status: "done" | "unknown"; version?: OrchestrationQaVersion; observed?: string | null; text: string }> {
    admit(); // no result file either
    const dir = join(deps.root, "runs", runId, "qa");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${randomUUID()}.result`);
    await (await open(file, "wx", 0o600)).close();
    try {
      const v = await shellOp({ kind: "finish", step: "qa" }, p.verify, { ...env, ...qaEnv(p), CANVASTTY_QA_RESULT: file }, 10 * 60_000);
      if (v.exitCode !== 0 || v.spawnError) return { status: "unknown", text: `verification: exit ${v.exitCode ?? v.signal ?? "?"}\n${v.output.tail}` };
      if (!p.reportsVersion) return { status: "done", version: "not_checked", observed: null, text: "verification: exit 0\nversion: not checked (the verification does not follow the version contract)" };
      const q = qaVersion(await readReport(file), p.commit);
      const basis = q.version === "confirmed" ? `reported ${q.observed}, the delivered commit`
        : q.version === "mismatch" ? `reported ${q.observed}, expected ${p.commit}`
          : q.version === "not_reported" ? "no commit id in $CANVASTTY_QA_RESULT" : "$CANVASTTY_QA_RESULT does not start with a full commit id";
      return { status: q.version === "confirmed" ? "done" : "unknown", ...q, text: `verification: exit 0\nversion: ${q.version} (${basis})` };
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }
  // The first 4 KB of the result file, or null when it is gone or not a plain file.
  async function readReport(file: string): Promise<string | null> {
    const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
    if (!fh) return null;
    try {
      if (!(await fh.stat()).isFile()) return null;
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally { await fh.close(); }
  }

  // A finish line whose facts come back through result files (finish.ts): `count` new empty files in the run's folder
  // for this attempt only (never an earlier attempt's), named in the line; read only after a clean exit that nobody
  // stopped, and removed whatever happens. A result that is missing, not a plain file or over the limit is null.
  async function finishOp(step: FinishStep, count: number, line: (files: string[]) => string, env: Record<string, string>, timeoutMs: number): Promise<{ r: ShellRunResult; results: (string | null)[] }> {
    admit(); // no result files either
    const dir = join(deps.root, "runs", runId, "finish");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const files = Array.from({ length: count }, (_, i) => join(dir, `${id}-${i}.out`));
    try {
      for (const f of files) await (await open(f, "wx", 0o600)).close();
      const r = await shellOp({ kind: "finish", step }, line(files), env, timeoutMs);
      const clean = r.exitCode === 0 && !r.spawnError && !r.stopCause;
      const results: (string | null)[] = [];
      for (const f of files) results.push(clean ? await readResult(f) : null);
      return { r, results };
    } finally {
      await Promise.all(files.map((f) => rm(f, { force: true }).catch(() => undefined)));
    }
  }
  async function readResult(file: string): Promise<string | null> {
    const LIMIT = 65_536;
    const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
    if (!fh) return null;
    try {
      if (!(await fh.stat()).isFile()) return null;
      const buf = Buffer.alloc(LIMIT + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return bytesRead > LIMIT ? null : buf.subarray(0, bytesRead).toString("utf8"); // over the limit: incomplete
    } finally { await fh.close(); }
  }

  async function runFinish(step: FinishStep, snapshot: Snapshot): Promise<void> {
    const shell = deps.checks.shell;
    if (!shell || !inPlace(ws.mode)) { await setStatus("paused", "environment_error"); return; }
    const f = goal.finish!;
    const env = shell.env;
    const needsUser = async (why: string, output?: string) => {
      observe((a) => a.finish(step, "blocked", output ? `${why}\n${output}` : why, {}));
      await setStatus("paused", "needs_user_action");
    };
    let params: CommitParams | PushParams | QaParams;
    let line: string;
    let nothing = false; // a commit with no change of the run: done, and said so
    let leftOut: string[] = [];
    // push and QA deliver the confirmed commit of the tree that was checked, never an older one
    const commitNow = currentCommit(state(), snapshot.tree)?.commit ?? null;
    if (step === "commit") {
      let paths = await diffPaths(ws, state().workspace!.baseline.tree, snapshot.tree);
      if (ws.mode === "project") {
        // Only what the run changed. A path the person had uncommitted changes in at the start cannot be split from
        // them: the person decides (nothing is committed on a guess).
        const dirty = ws.head ? await diffPaths(ws, `${ws.head}^{tree}`, state().workspace!.baseline.tree) : [];
        const mixed = paths.filter((p) => dirty.includes(p));
        if (mixed.length) return needsUser(`these files had your own uncommitted changes before the run: ${mixed.slice(0, 10).join(", ")}`);
      }
      // What the environment preparation made (a lock file an install wrote, a copied .env) is not the run's work: left
      // out, unless something changed it again afterwards, which only the person can sort out.
      const byPrep = new Map<string, "prep" | "changed">();
      for (const p of state().orch.prepares) {
        if (!p.before || !p.after) continue;
        const made = await diffPaths(ws, p.before, p.after);
        if (!made.length) continue;
        const later = new Set(await diffPaths(ws, p.after, snapshot.tree));
        for (const x of made) byPrep.set(x, later.has(x) ? "changed" : "prep");
      }
      const reworked = paths.filter((p) => byPrep.get(p) === "changed");
      if (reworked.length) return needsUser(`these files were made by the environment preparation and changed again afterwards: ${reworked.slice(0, 10).join(", ")}`);
      leftOut = paths.filter((p) => byPrep.get(p) === "prep");
      paths = paths.filter((p) => !byPrep.has(p));
      params = { message: f.commit!.message, paths, runId, tree: snapshot.tree };
      nothing = paths.length === 0;
      line = nothing ? "true" : commitLine(params, "<result file>"); // as shown; the line run names its own file
    } else if (step === "push") {
      if (!commitNow) return needsUser("there is no confirmed commit of the checked state to push");
      params = { remote: f.push!.remote, branch: f.push!.branch, commit: commitNow, tree: snapshot.tree };
      // The remote's address is part of what the person allowed: a changed one (a push URL or a rewrite included) is
      // asked again.
      const allowed = f.push!.remoteUrl;
      if (typeof allowed !== "string" || !allowed) return needsUser(`the allowed address of ${f.push!.remote} is not saved; save the project settings again`);
      const { r: u, results: [fetch, push] } = await finishOp(step, 2, ([a, b]) => remoteUrlLine(f.push!.remote, a, b), env, 60_000);
      if (u.stopCause) admit(); // stopped by the person or the run's time: that ends it, not a question
      if (fetch === null || push === null) return needsUser(`the address query of ${f.push!.remote} failed: exit ${u.exitCode ?? u.signal ?? u.spawnError ?? "?"}${u.exitCode === 0 ? ", no complete result" : ""}`, u.output.tail);
      if (!remoteUrlsMatch(fetch, push, allowed)) {
        const got = [...new Set(`${fetch}\n${push}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
        return needsUser(`the address of ${f.push!.remote} is not the one you allowed: got ${got.length ? got.slice(0, 10).join(", ") : "none"}`);
      }
      line = pushLine(params);
    } else {
      if (!commitNow) return needsUser("QA deploys a confirmed commit of the checked state, and there is none");
      params = { environment: f.qa!.environment, command: f.qa!.command, verify: f.qa!.verify, commit: commitNow, branch: f.push?.branch ?? ws.branch, tree: snapshot.tree, reportsVersion: f.qa!.reportsVersion === true };
      line = f.qa!.command;
    }
    admit(); // an action that will not start is not recorded as started
    const intentId = randomUUID();
    const paramsRef = await j(() => writer.putText(canonical(params)));
    await j(() => writer.recordEvent("finish.intent", { intentId, step, params: paramsRef }));
    observe((a) => a.finish(step, "started", step === "qa" ? `${(params as QaParams).environment}: ${line}` : line, {}));
    const stepEnv = step === "qa" ? { ...env, ...qaEnv(params as QaParams) } : env;
    // A process the admission rule refused after the intent (a Stop or the deadline in between): while the journal is
    // the run's own, what did not start is recorded so, and what did run stays unconfirmed; when the application is
    // closing nothing more is written (reopening finds the intent without a result: outcome_unknown).
    const notStarted = (error: unknown, what: string): string => {
      if (!(error instanceof Refused) || halted || shuttingDown) throw error;
      return `${what}: not started (${error.message})`;
    };
    let r: ShellRunResult;
    let made: string | null = null; // the commit id git wrote
    try {
      if (step === "commit" && !nothing) ({ r, results: [made] } = await finishOp(step, 1, ([out]) => commitLine(params as CommitParams, out), stepEnv, 30 * 60_000));
      else r = await shellOp({ kind: "finish", step }, line, stepEnv, 30 * 60_000);
    } catch (error) {
      const text = notStarted(error, step);
      const evidence = await j(() => writer.putText(text));
      await j(() => writer.recordEvent("finish.result", { intentId, status: "not_done", established: false, evidence, commit: null, tree: snapshot.tree }));
      observe((a) => a.finish(step, "not_done", text, { commit: null }));
      throw error;
    }
    let status: "done" | "failed" | "unknown" = r.exitCode === 0 && !r.spawnError ? "done" : r.stopCause ? "unknown" : "failed";
    let commit: string | null = null;
    let qa: { version?: OrchestrationQaVersion; observed?: string | null } = {};
    let evidenceText = r.output.text;
    if (step === "commit" && status === "done") {
      commit = nothing ? null : resultOid(made);
      if (!nothing && !commit) status = "unknown";
      evidenceText = commit ? `commit ${commit}` : nothing ? "nothing to commit" : `commit made, id not confirmed by its result file\n${r.output.tail}`;
      if (commit) {
        // the commit must hold exactly the checked content of these paths (a hook may have changed or added files)
        const off = await commitDiffers(commit, (params as CommitParams).paths ?? [], snapshot.tree);
        if (off.length) { status = "failed"; evidenceText = `commit ${commit} does not hold the checked content: ${off.slice(0, 20).join(", ")}`; }
      }
      if (leftOut.length) evidenceText += `\nleft out (made by the environment preparation): ${leftOut.slice(0, 20).join(", ")}`;
    } else if (step === "push" && status === "done") {
      // confirmed only by the remote itself
      commit = (params as PushParams).commit;
      const check = await finishOp(step, 1, ([out]) => remoteHeadLine(params as PushParams, out), env, 120_000).catch((e: unknown) => notStarted(e, "ls-remote"));
      if (typeof check === "string") {
        status = "unknown"; // pushed, not confirmed: after the person resumes only the ls-remote runs
        evidenceText = `push: exit 0\n${check}`;
      } else {
        const listed = check.results[0];
        const head = listed === null ? null : remoteHead(listed, (params as PushParams).branch);
        status = head === (params as PushParams).commit ? "done" : listed !== null ? "failed" : "unknown";
        evidenceText = `${(params as PushParams).remote} refs/heads/${(params as PushParams).branch} = ${head ?? "absent"}`;
      }
    } else if (step === "qa") {
      commit = (params as QaParams).commit;
      if (status === "done") {
        // the deploy command's own success is not the proof: the configured verification is. A deploy that went
        // through and a verification that did not pass or did not confirm the version is "deployed, not confirmed":
        // after the person resumes, only the verification runs again, never the deploy.
        const verified = await qaVerify(params as QaParams, env).catch((e: unknown) => notStarted(e, "verification"));
        if (typeof verified === "string") {
          status = "unknown"; // deployed, not confirmed
          evidenceText = `deploy: exit 0\n${verified}`;
        } else {
          const { status: s, text, ...v } = verified;
          status = s;
          qa = v;
          evidenceText = `deploy: exit 0\n${text}`;
        }
      }
    }
    const evidence = await j(() => writer.putText(evidenceText.slice(-60_000) || "(no output)"));
    await j(() => writer.recordEvent("finish.result", { intentId, status, established: false, evidence, commit, tree: snapshot.tree, ...qa }));
    observe((a) => a.finish(step, status, evidenceText.slice(0, 300), { commit }));
  }

  // Paths where a commit and the checked tree disagree: a committed path whose content is not the checked one, or a
  // path in the commit that was not to be committed.
  async function commitDiffers(commit: string, paths: readonly string[], tree: string): Promise<string[]> {
    const want = new Set(paths);
    const content = (await diffPaths(ws, tree, commit)).filter((p) => want.has(p));
    const extra = await diffPaths(ws, `${commit}^`, commit).then((xs) => xs.filter((p) => !want.has(p)), () => [] as string[]); // a root commit has no parent
    return [...content, ...extra];
  }

  // After the application ended during an action: only its confirmation runs, never the action. The commit found by
  // its trailer must hold the checked content; a QA verification runs only after the person resumed (cycle).
  async function establish(step: FinishStep, intentId: string): Promise<void> {
    const shell = deps.checks.shell;
    if (!shell) { await setStatus("paused", "environment_error"); return; }
    const intent = state().orch.finish.find((x) => x.intentId === intentId)!;
    const params = JSON.parse((await readText(root, runId, intent.params)).toString("utf8")) as CommitParams & PushParams & QaParams;
    observe((a) => a.finish(step, "establishing", "checking what actually happened", {}));
    let status: "done" | "not_done" | "unknown" | "failed";
    let commit: string | null = null;
    let qa: { version?: OrchestrationQaVersion; observed?: string | null } = {};
    let text: string;
    if (step === "commit") {
      const { r, results: [found] } = await finishOp(step, 1, ([out]) => findCommitLine(runId, out), shell.env, 60_000);
      commit = resultOid(found);
      // an empty result is "no such commit"; anything else that is not one id is not an answer
      status = commit ? "done" : found === "" ? "not_done" : "unknown";
      text = commit ? `commit ${commit} found by its trailer` : found === "" ? "no commit of this run in HEAD" : `git log gave no answer: exit ${r.exitCode ?? r.signal ?? "?"}\n${r.output.tail}`;
      if (commit && params.tree && Array.isArray(params.paths)) {
        const off = await commitDiffers(commit, params.paths, params.tree);
        if (off.length) { status = "failed"; text += `, but it does not hold the checked content: ${off.slice(0, 20).join(", ")}`; }
      }
    } else if (step === "push") {
      const { results: [listed] } = await finishOp(step, 1, ([out]) => remoteHeadLine(params, out), shell.env, 120_000);
      const head = listed === null ? null : remoteHead(listed, params.branch);
      status = listed === null ? "unknown" : head === params.commit ? "done" : "not_done";
      commit = params.commit;
      text = `${params.remote} refs/heads/${params.branch} = ${listed !== null ? head ?? "absent" : "unreachable"}`;
    } else {
      commit = params.commit;
      // the same verification and contract as after the deploy; a failing one cannot tell "not deployed" from
      // "deployed broken"
      const { status: s, text: t, ...v } = await qaVerify(params, shell.env);
      status = s;
      qa = v;
      text = t;
    }
    const evidence = await j(() => writer.putText(text));
    await j(() => writer.recordEvent("finish.result", { intentId, status, established: true, evidence, commit, tree: params.tree ?? null, ...qa }));
    observe((a) => a.finish(step, status, `established: ${text.slice(0, 300)}`, { commit }));
  }

  // ---------- checkpoint and restore ----------

  async function doCheckpoint(stage: number, tree: string): Promise<void> {
    try {
      const cp = await createCheckpoint(ws, stage, { expectedTree: tree });
      await j(() => writer.recordCheckpoint({ stage: cp.stage, commit: cp.commit, tree: cp.tree, parent: cp.parent }));
    } catch (error) {
      if (halted) throw error;
      const code = (error as { code?: string }).code;
      await setStatus("paused", code === "checkpoint_conflict" ? "shared_git_tampered" : "environment_error");
    }
  }

  async function resetToCheckpoint(): Promise<void> {
    const wsState = state().workspace!;
    const stages = Object.keys(wsState.checkpoints).map(Number).sort((a, b) => a - b);
    const last = stages.at(-1);
    const target = last === undefined
      ? { name: "baseline" as const, commit: wsState.baseline.commit }
      : { name: `stage-${last}` as `stage-${number}`, commit: wsState.checkpoints[String(last)].commit };
    const base = await readCommit(ws, wsState.current.commit);
    const prepared = await prepareRestore(ws, target, base);
    await j(() => writer.recordSnapshot({ kind: "recovery", ref: prepared.recovery.ref, commit: prepared.recovery.commit, tree: prepared.recovery.tree }));
    const restore = { target: prepared.target, targetCommit: prepared.targetCommit, recoveryCommit: prepared.recoveryCommit };
    await j(() => writer.recordRestoreStarted(restore));
    try {
      await applyRestore(ws, prepared);
    } catch (error) {
      await j(() => writer.recordRestoreFailed({ ...restore, result: "unknown" }));
      throw error;
    }
    await j(() => writer.recordRestored(restore));
  }

  // ---------- stop ----------

  async function finishStop(): Promise<void> {
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (!halted && state().status === "stopping") await setStatus("stopped");
  }

  // ---------- tasks ----------

  async function buildTask(action: Extract<Action, { kind: "turn" }>, snapshot: Snapshot): Promise<string> {
    await loadFindings();
    const st = state();
    const text = async (ref: TextRef | null) => ref ? (await readText(root, runId, ref)).toString("utf8") : "";
    // A3 (5h §3.2): the reviewer gets no executor's report or task and no lead's conversation
    const reviewer = action.purpose !== "plan" && action.purpose !== "execute" && byReviewer(st);
    const parts: string[] = [
      `Role: ${action.purpose === "execute" ? "executor" : reviewer ? "reviewer" : "lead"}. Purpose: ${action.purpose}.`,
      ...(goal.language ? [languageLine(goal.language)] : []),
      `Goal:\n${goal.text}`,
      `Acceptance criteria (fixed; you cannot change them):\n${goal.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
      goal.commands?.length === 0
        ? (st.orch.checksProposal ? "This run has no check commands: the person accepted none. Your review alone accepts a stage; the result is shown as completed without checks."
          : "No check commands are set for this run yet: in this plan you propose them (see below).")
        : goal.commands
          ? `Required checks (CanvasTTY runs these commands itself in the work folder after the executor's turn; your own statements do not count):\n${goal.commands.map((c, i) => `${goal.checks[i]}: ${c}`).join("\n")}`
          : `Required checks (run by CanvasTTY in a sandbox; your own statements do not count): ${goal.checks.join(", ")}`,
      ...(inPlace(ws.mode) ? [[
        ws.mode === "worktree"
          ? `Work place: a Git worktree of the user's project on branch ${ws.branch} (your working directory), exactly as in their terminal. `
            + "Ignored files (dependencies, .env) are prepared there separately. Your tools and permissions are the user's own CLI settings; a prompt goes to the user."
          : "Work place: the user's own project folder (your working directory), exactly as in their terminal. It may hold the user's "
            + "uncommitted changes: keep them. Your tools and permissions are the user's own CLI settings; a prompt goes to the user.",
        action.purpose === "execute"
          ? `Your duty: implement the current stage. The lead plans${byReviewer(st) ? "; an independent reviewer reviews" : " and reviews"}.`
          : reviewer ? "Your duty: review the work independently. Do not change any file: a review of a tree that changes is dropped."
            : `Your duty: plan${byReviewer(st) ? "" : " and review"}; the executor implements the stages. Do not implement the stages yourself.`
      ].join("\n")] : []),
      ...modeLines(),
      rulesFor(action.purpose, reviewer),
      budgetLine(action)
    ];
    if (st.orch.clarifications > 0) parts.push(`User clarifications (${st.orch.clarifications}):\n${await clarificationTexts()}`);
    if (action.purpose === "plan" && proposesChecks(st, goal)) {
      parts.push(["Check commands to propose (the checks field of your report):",
        "- Inspect the project and propose the commands that verify this goal: its own test, build, lint or type-check commands, "
          + "one shell command line each, as the person runs them in a terminal of the project (at most 16).",
        "- For every command say why it verifies the goal (why) and which files show it exists (source: relative paths, e.g. package.json, composer.json, Makefile).",
        "- If the project has no command that can verify this goal, propose none: checks: [] and say why in none.",
        "- The person accepts or edits your proposal before any work starts; nothing runs until then. Do not ask a question in the same report: "
          + "if you need an answer first, ask it with checks: null and propose in the next plan."].join("\n"));
    }
    if (st.orch.question?.answered && (st.turns[st.orch.question.turnId]?.role === "reviewer") === reviewer) parts.push(`Answer to your question: ${await text(st.orch.question.answerRef)}`);
    if (st.orch.plan) {
      const plan = JSON.parse(await text(st.orch.plan.ref)) as PlanReport;
      const accepted = Object.keys(st.orch.accepted).length;
      parts.push(`Plan v${st.orch.plan.version}, stages accepted: ${accepted}:\n` + plan.stages
        .map((s, i) => `${st.orch.plan!.firstStage + i}. ${s.title}`).join("\n"));
      if (action.stage !== null) {
        const s = plan.stages[action.stage - st.orch.plan.firstStage];
        if (s) parts.push(`Current stage ${action.stage} (round ${action.round}): ${s.title}${reviewer ? "" : `\n${s.task}`}`);
      }
    }
    const lastReview = st.orch.reviews.at(-1);
    const findingsOf = (r: typeof lastReview) => (r ? findingsCache.get(r.turnId) ?? [] : []).map((f) => `- ${f}`).join("\n");
    // A repeated round of a stage: the results of the required checks on the copy as it is now go with the findings,
    // whatever the review said (an accept with failing checks, or no useful findings, sends the stage back too).
    const repeat = action.purpose === "execute" && (action.round ?? 1) > 1;
    const isReplan = action.purpose === "plan" && st.orch.plan !== null;
    if (lastReview && action.purpose === "execute" && !lastReview.assessed) {
      const findings = findingsOf(lastReview);
      if (findings) parts.push(`Findings of the last review (verdict ${lastReview.verdict}):\n${findings}`);
    }
    // A3: the reviewer's request says why (its open blocking findings come with findingLines)
    if (isReplan && lastReview?.assessed) {
      parts.push(`Why a new plan is needed: the reviewer's last review of plan v${st.orch.plan!.version}`
        + `${lastReview.stage === null ? " (the final review)" : ` (stage ${lastReview.stage})`} ${lastReview.assessed.request === "replan" ? "asked for a new plan" : "left the goal unmet"}.`);
      // stage A gate: what it found not met, in its words — a condition no change can prove is dropped (with why) or
      // replaced, never kept as it is
      const c = await conds();
      const notMet = c ? marksIn(c.reports, lastReview.turnId).filter((m) => m.status === "not_met") : [];
      if (notMet.length) parts.push(`Conditions it marked not met:\n${notMet.map((m) => `- ${m.id}: ${m.note}`).join("\n")}\n`
        + "A condition it says no changed file can prove is not kept as it is: drop it with why, and add a check condition instead when it matters.");
    }
    if (isReplan && lastReview && !lastReview.assessed) {
      parts.push(`Why a new plan is needed: the last review of plan v${st.orch.plan!.version} returned ${lastReview.verdict}` +
        `${lastReview.stage === null ? " in the final review" : ` on stage ${lastReview.stage}`}.` +
        `${findingsOf(lastReview) ? `\nIts findings:\n${findingsOf(lastReview)}` : ""}`);
    }
    if (action.purpose === "review" || action.purpose === "final_review" || repeat || isReplan) {
      parts.push(`Check results on the current state of the copy (results of other states are not shown):\n${await checkLines(snapshot)}`);
    }
    if (st.version === 2) parts.push(...await conditionLines(action, snapshot));
    if (byReviewer(st)) parts.push(...await findingLines(action, snapshot, reviewer));
    parts.push(`Answer only with the JSON object the schema describes.`);
    return parts.join("\n\n");
  }

  // A2 (journal-v2-format.md §2.7): requirements and readiness conditions, as each role needs them.
  async function conditionLines(action: Extract<Action, { kind: "turn" }>, snapshot: Snapshot): Promise<string[]> {
    const st = state();
    const c = (await conds())!;
    const stale = await staleOn(st, c, snapshot.tree);
    const facts = conditionFacts(st, goal, c, snapshot.checkKeys, stale);
    const said: Record<Status, string> = { met: "met", not_met: "not met", not_checked: "not checked yet", dropped: "dropped by the person" };
    const line = (id: string) => {
      const d = c.book.defs.get(id)!;
      const fact = facts?.conditions.find((x) => x.id === id);
      return `- ${id} [covers ${d.covers.join(", ") || "nothing"}; ${d.evidence.kind === "check" ? `check ${d.evidence.check}` : d.evidence.kind}]: ${d.text} — ${said[fact?.status ?? "not_checked"]}`
        + `${fact?.stale ? " (its files changed since its stage was accepted: to confirm)" : ""}`;
    };
    const dropped = [...c.book.droppedRequirements.keys()];
    const reqs = `Requirements (R<n> is acceptance criterion n, fixed):\n${goal.criteria.map((t, i) => `R${i + 1}: ${t}${dropped.includes(`R${i + 1}`) ? " — dropped by the person" : ""}`).join("\n")}`;
    const stages = [...c.book.stages.entries()].sort((a, b) => a[0] - b[0]);
    if (action.purpose === "plan") {
      const first = Object.keys(st.orch.accepted).length + 1;
      const accepted = stages.filter(([n]) => n < first).flatMap(([, ids]) => ids);
      const returned = await returnedConditions();
      const open = stages.filter(([n]) => n >= first).flatMap(([, ids]) => ids);
      const out = [[reqs,
        "Readiness conditions: every stage of your plan lists 1..12 of them in conditions; the application numbers new ones C<n>.",
        "- A new condition: {keep: null, text, covers: [the requirement ids it proves], evidence}. evidence {kind: \"check\", check: \"cmd-<n>\"} is met when "
          + "that check command passes on the work; {kind: \"change\", check: null} is met when the review marks it met, naming the files changed for it; "
          + "{kind: \"person\", check: null} is met when the person says so — only for what nobody but the person can judge.",
        // stage A gate, attempt 3: "a file remains unchanged" as a change condition — no review can ever prove it
        "- A change condition is proven only by files the run changes. A statement that something does not change (a file or a path stays as it "
          + "is) is never a change condition: make it a check condition with a command that verifies it, or leave it out of the conditions.",
        "- Every requirement in force is covered by at least one condition: of an accepted stage, kept, or new.",
        "- To give up a condition or a requirement, list it in dropped [{condition, why}] or dropRequirements [{requirement, why}]. Such a plan is a "
          + "proposal: the person accepts it or returns it to you, and the plan in force stays until then. Never drop silently: a condition still to be "
          + "met that is neither kept nor dropped, or a requirement left uncovered, makes the plan invalid.",
        ...(accepted.filter((id) => !returned.has(id)).length ? ["Conditions of accepted stages (in force; they count for coverage):", ...accepted.filter((id) => !returned.has(id)).map(line)] : []),
        ...(returned.size ? ["Conditions of accepted stages the final review returned to the work (no evidence in force, a requirement not met, or an open blocking "
          + "finding): keep each one in a stage of your plan, or drop it:", ...[...returned].map(line)] : []),
        ...(open.length ? ["Conditions still to be met: keep each one in a stage of your plan as {keep: \"C<n>\", text: null, covers: null, evidence: null}, or drop it:", ...open.map(line)] : []),
        ...(c.book.dropped.size ? [`Dropped by the person: ${[...c.book.dropped.keys()].join(", ")}.`] : [])
      ].join("\n")];
      const rejected = await rejectedPlan();
      if (rejected.length) out.push(`Your previous plan was not accepted by the application:\n${rejected.map((x) => `- ${x}`).join("\n")}`);
      // A4 (5h §3.6 p. 3): the person returned the last proposal — told until a plan is recorded after it (a plan turn
      // the application refused does not use the note up)
      const back = st.orch.proposals.at(-1)?.decision;
      if (back?.decision === "return" && !st.orch.plans.some((p) => p.seq > back.seq)) {
        const was = await readJson<PlanText>(st.orch.proposals.at(-1)!.ref);
        const what = [...(was.dropped ?? []).map((x) => x.condition), ...(was.dropRequirements ?? []).map((x) => x.requirement)].join(", ");
        out.push(`The person returned your proposal to drop ${what}: the plan in force stays.${back.note ? ` Their note: ${(await readText(root, runId, back.note)).toString("utf8")}` : ""}`);
      }
      const unmet = facts?.requirements.filter((r) => r.status !== "met").map((r) => r.id) ?? [];
      if (st.orch.plan && finalReview(st) && unmet.length) out.push(`The run could not complete: no evidence yet for ${unmet.join(", ")}. Plan the work that gives it.`);
      return out;
    }
    if (action.stage !== null) {
      const own = c.book.stages.get(action.stage) ?? [];
      const out = [[reqs, `Readiness conditions of stage ${action.stage}:`, ...own.map(line)].join("\n")];
      const last = stageReview(st, action.stage);
      const notes = marksIn(c.reports, last).filter((m) => m.status === "not_met");
      if (action.purpose === "execute" && notes.length) out.push(`Not met in the last review:\n${notes.map((m) => `- ${m.id}: ${m.note}`).join("\n")}`);
      if (action.purpose === "review") {
        // exactly the ids the schema offers (turnSchema): the others are named apart, never as something to mark
        const change = changeIdsOf(c.book, action.stage);
        const others = own.filter((id) => !change.includes(id));
        out.push(change.length
          ? `In conditions give one mark for each of ${change.join(", ")} (the change conditions of this stage): {id, status: met | not_met, paths, note}; `
            + "met names the files this run changed that show it (paths are checked against the changes since the run started). No other condition is marked."
          : "conditions stays empty: this stage has no change condition to mark.");
        if (others.length) out.push(`Do not mark ${others.join(", ")}: a check condition is met only by its command passing, a person condition only by the person.`);
        out.push("The stage is accepted only when every condition of it is met and every check passes.");
      }
      return out;
    }
    const confirm = stages.flatMap(([n, ids]) => (st.orch.accepted[String(n)] ? ids : [])).filter((id) => facts?.conditions.find((x) => x.id === id)?.stale);
    return [[reqs, "Readiness conditions in force:", ...stages.flatMap(([, ids]) => ids).map(line)].join("\n"),
      "In requirements give one mark for every requirement in force (not the ones dropped by the person): {id, status: met | not_met, note}. "
        + "The run completes only when every requirement in force is met and covered by a met condition.",
      // A4 (5h §3.7): evidence of an accepted stage whose files changed since — confirmed here, or it does not count
      confirm.length
        ? `In conditions give one mark for each of ${confirm.join(", ")} (files changed since its stage was accepted): {id, status: met | not_met, paths, note}; `
          + "met names the files this run changed that show it still holds. No other condition is marked."
        : "conditions stays empty: no condition needs to be confirmed."];
  }

  // A3 (5h §3.2, journal-v2-format.md §2.8): the findings as each role needs them. The executor: the open blocking ones of
  // its stage. The plan: every open blocking one. The reviewer: the changed paths and every finding with its state, then
  // how to answer.
  async function findingLines(action: Extract<Action, { kind: "turn" }>, snapshot: Snapshot, reviewer: boolean): Promise<string[]> {
    const st = state();
    const c = (await conds())!;
    const book = c.findings!.book;
    // A4 (5h §3.4 p. 4): the person's past decisions about a finding go with it
    const PERSON: Record<string, string> = { closed_by_person: "closed it", to_wish: "made it a wish", moved: "moved it", decided: "decided a possible repeat of it",
      reopened: "opened it again as a repeat", refused: "refused it as a repeat", opened: "opened it from a disputed item" };
    const byPerson = (f: Finding) => {
      const said = f.history.filter((h) => h.by === "person").map((h) => PERSON[h.kind] ?? h.kind);
      return said.length ? `; the person ${[...new Set(said)].join(", ")}` : "";
    };
    const say = (f: Finding) => `- ${f.id} [${f.severity}${f.condition ? `, ${f.condition}` : ""}; ${f.status}${f.paths.length ? `; ${f.paths.join(", ")}` : ""}${byPerson(f)}]: ${f.problem}`
      + `${f.evidence ? `\n  evidence: ${f.evidence}` : ""}\n  close when: ${f.closeWhen}`;
    if (action.purpose === "execute") {
      const own = heldBy(st, c, action.stage!);
      return own.length ? [`Open blocking findings of this stage (fix each; only the reviewer closes them):\n${own.map(say).join("\n")}`] : [];
    }
    if (action.purpose === "plan") {
      const open = openBlocking(book);
      return open.length ? [`Open blocking findings of the run (the new plan must leave the work to fix them):\n${open.map(say).join("\n")}`] : [];
    }
    if (!reviewer) return [];
    const changed = async (from: string, label: string) => {
      const d = await diffTreeNames(ws, from, snapshot.tree, 500);
      return `Paths changed ${label}${d.truncated ? " (the list is cut)" : ""}:\n${d.files.map((f) => `- ${f.path}`).join("\n") || "(none)"}`;
    };
    const start = action.stage === null || action.stage === 1 ? null : st.workspace!.checkpoints[String(action.stage - 1)]?.tree ?? null;
    const out = [
      ...(start ? [await changed(start, `since stage ${action.stage} started`)] : []),
      await changed(st.workspace!.baseline.tree, "since the run started")
    ];
    const findings = [...book.list.values()];
    const since = async (f: Finding) => {
      if (f.status !== "closed") return "";
      const d = new Set((await diffTreeNames(ws, f.closeTree!, snapshot.tree, Number.MAX_SAFE_INTEGER)).files.map((x) => x.path));
      return f.paths.some((p) => d.has(p)) ? " (its paths changed since it was closed)" : " (its paths did not change since it was closed)";
    };
    const lines: string[] = [];
    for (const f of findings) lines.push(`${say(f)}${await since(f)}`);
    out.push(lines.length ? `Findings of this run (numbered by the application; never renumber them):\n${lines.join("\n")}` : "Findings of this run: none yet.");
    out.push([
      "How to answer (findings):",
      "- Every problem you see is a finding {id, severity, condition, problem, evidence, closeWhen, status, paths, relation}. A new one has id null: "
        + "the application gives it the next number. Name an existing one by its id with its status now: open, or closed when it is fixed.",
      "- severity blocking stops the stage until the finding is closed; wish does not block. The severity and condition of a finding never change.",
      "- A new blocking finding names the files it is about (paths). Closing a blocking one names the files changed for it since it was opened (paths); "
        + "it cannot be closed on the state it was opened on.",
      "- A new blocking finding about the files of a closed one that did not change since: say relation {repeatOf: \"F<n>\", distinctFrom: null, why: null} "
        + "when it is that one again, or {repeatOf: null, distinctFrom: \"F<n>\", why} when it is another problem; otherwise relation null.",
      "- request: none (the application decides the stage by the checks, the conditions and the open blocking findings), replan when the plan "
        + "itself cannot work, question (with question) when only the person can answer.",
      ...(action.stage !== null ? ["- A change condition no file changed by the run can prove (for example, that a file stays unchanged): mark it "
        + "not_met with a note saying so and answer request replan — never met without paths."] : []),
      ...(await rejectedReview(snapshot)).map((x, i) => `${i === 0 ? "Your previous report was not accepted by the application:\n" : ""}- ${x}`)
    ].join("\n"));
    return out;
  }

  // The last plan turn the application did not accept for its plan (invalid_report): what was wrong, recomputed from its
  // report and the plans now (5h §2.3, «Перечень нарушений»).
  async function rejectedPlan(): Promise<string[]> {
    const st = state();
    const lastPlan = Object.entries(st.orch.turns).filter(([, t]) => t.purpose === "plan").sort((a, b) => b[1].seq - a[1].seq)[0]?.[0];
    const ref = lastPlan ? st.turns[lastPlan]?.report?.ref : null;
    if (!lastPlan || !ref || st.orch.plans.some((p) => p.turnId === lastPlan) || st.orch.checksProposal?.turnId === lastPlan || st.orch.question?.turnId === lastPlan) return [];
    const report = await readJson<PlanReportV2 & { checks?: unknown }>(ref);
    const schema = report.checks ? PLAN_PROPOSAL_SCHEMA : PLAN_V2_SCHEMA;
    const shape = reportProblem("plan", report, schema);
    return shape ? [shape] : planViolations(report, schema);
  }

  // Stage 13: how independently to work, what CanvasTTY itself prepares and does after success.
  function modeLines(): string[] {
    if (!goal.commands) return [];
    const out: string[] = [];
    out.push(goal.mode === "steps"
      ? "Mode: step by step. The person reviews the plan and continues the run after each accepted stage."
      : "Mode: autopilot. Work on your own: inspect the project, choose reversible technical options yourself, prepare what the "
        + "work needs within your rights, run the project's checks when useful, fix and check again. Ask the person (the question "
        + "field of your report) only when required data is missing, a significant decision is ambiguous, or an action is outside "
        + "the rights you have.");
    if (goal.prepare?.steps.length) {
      out.push(`CanvasTTY prepares the environment itself when it is missing (${goal.prepare.steps.map((x) => x.command).join("; ")}). `
        + "Do not upgrade dependencies or change lock files unless the task needs it; never install dependencies inside a test.");
    }
    const actions = [goal.finish?.commit ? "commit the changes" : "", goal.finish?.push ? `push to ${goal.finish.push.remote}/${goal.finish.push.branch}` : "",
      goal.finish?.qa ? `deploy to ${goal.finish.qa.environment}` : ""].filter(Boolean);
    out.push(actions.length
      ? `After success CanvasTTY itself will ${actions.join(", then ")} and confirm each. Do not commit, push or deploy yourself.`
      : "Leave the changes uncommitted: do not commit, push or deploy.");
    return [out.join("\n")];
  }

  // The rules the service applies, stated to the agent that has to live with them (stage-6-contract.md §5.3).
  function rulesFor(purpose: TurnPurpose, reviewer = false): string {
    const checks = goal.checks.join(", ");
    const stage = goal.checks.length === 0 ? "A stage is accepted when the lead's review accepts it: this run has no check commands."
      : `A stage is accepted only when every required check (${checks}) passes on the copy after that stage, `
      + "and the lead's review accepts it. An accept while a required check fails does not advance the stage: it goes back to the executor.";
    const final = "After the last stage a final review is mandatory: it is a separate lead turn, and the run completes only when "
      + "it answers complete with every required check passing.";
    if (purpose === "plan") {
      return ["Rules for the plan:",
        inPlace(ws.mode)
          ? "- Inspect the project yourself before writing the plan; inspection and planning are part of your work, not a stage."
          : "- Inspect the project yourself (read-only) before writing the plan; inspection and planning are part of your work, not a stage.",
        `- ${stage}`,
        "- Therefore every stage must leave the copy in a state that passes all required checks. Never plan a stage that only "
          + "inspects, plans or verifies and changes nothing when the checks cannot pass yet: it can never be accepted.",
        "- Choose the smallest plan that fits: a small task is one stage. Use several stages only when each of them passes the checks on its own.",
        `- ${final} Leave turns for it in the budget below.`].join("\n");
    }
    if (purpose === "execute") {
      return ["Rules for this turn:",
        "- Implement the current stage completely in this turn, including the inspection you need; there is no separate turn for reading.",
        `- ${stage} CanvasTTY runs the checks after your turn; your own report does not count.`].join("\n");
    }
    if (reviewer) {
      return ["Rules for this review:", "- You are an independent reviewer in a new session: judge the work by the files in the folder and the check results, not by anyone's word.",
        `- A stage is accepted by the application only when every required check passes, every condition of the stage is met and no blocking finding of it is open.`,
        ...(purpose === "final_review" ? [`- ${final.replace("lead turn", "review")}`] : [])].join("\n");
    }
    if (purpose === "review") return ["Rules for this review:", `- ${stage}`, "- Use fix with concrete findings when a check fails; use replan when the plan itself cannot pass."].join("\n");
    return ["Rules for the final review:", `- ${final}`].join("\n");
  }

  // The budget as the service counts it now: the goal's limits with the user's changes (limits.changed) applied.
  function budgetLine(action: Extract<Action, { kind: "turn" }>): string {
    const st = state();
    const limits = effectiveLimits(goal, st);
    const used = Object.keys(st.turns).length; // turns recorded before this one
    const planVersion = st.orch.plan?.version ?? 0;
    const minutes = Math.max(0, Math.floor((deadline() - clock()) / 60_000));
    return [`Budget: this is turn ${used + 1} of at most ${limits.turns} (${limits.turns - used - 1} left after it; `
      + "the final review needs one of them, a fix round needs an executor turn and a review).",
      `Replans used: ${Math.max(0, planVersion - 1)} of ${limits.replans}${action.purpose === "plan" && planVersion > 0 ? " (this plan is one of them)" : ""}. `
      + `Rounds per stage: at most ${limits.roundsPerStage}${action.round !== null ? ` (this is round ${action.round})` : ""}. `
      + `Time left for the run: about ${minutes} min.`].join("\n");
  }

  async function clarificationTexts(): Promise<string> {
    const refs = state().orch.clarificationRefs;
    const out: string[] = [];
    for (const ref of refs) out.push(`- ${(await readText(root, runId, ref)).toString("utf8")}`);
    return out.join("\n") || `(${state().orch.clarifications} recorded)`;
  }

  async function checkLines(snapshot: Snapshot): Promise<string> {
    const st = state();
    const lines: string[] = [];
    for (const id of goal.checks) {
      let best: { checkRunId: string; seq: number } | null = null;
      for (const [checkRunId, a] of Object.entries(st.orch.assessed)) {
        if (st.checks[checkRunId]?.checkId === id && a.checkKey === snapshot.checkKeys[id] && (!best || a.seq > best.seq)) best = { checkRunId, seq: a.seq };
      }
      if (!best) { lines.push(`- ${id}: not run on this state`); continue; }
      const c = st.checks[best.checkRunId];
      let tail = "";
      if (c.output) tail = (await readText(root, runId, c.output)).toString("utf8").slice(-MAX_CHECK_OUTPUT_IN_TASK);
      lines.push(`- ${id}: ${c.status}${c.reason ? `(${c.reason})` : ""}${tail ? `\n${tail}` : ""}`);
    }
    return lines.join("\n");
  }

  // ---------- commands ----------

  async function command(input: { commandId: string; expectedRevision: number; command: RunCommand }): Promise<CommandOutcome> {
    const next = commandChain.then(() => handleCommand(input));
    commandChain = next.catch(() => {});
    return next;
  }

  async function handleCommand({ commandId, expectedRevision, command: cmd }: { commandId: string; expectedRevision: number; command: RunCommand }): Promise<CommandOutcome> {
    if (halted) return { status: "rejected", code: "store_failed" };
    const kind = typeof (cmd as { kind?: unknown })?.kind === "string" ? (cmd as { kind: string }).kind : "invalid";
    let check;
    try {
      check = await j(() => writer.recordCommand(commandId, kind.slice(0, 64), { expectedRevision, command: cmd }));
    } catch (error) {
      if (error instanceof StoreError && error.code === "invalid_input") return { status: "rejected", code: "invalid_command" };
      return { status: "rejected", code: "store_failed" };
    }
    if (check.status === "duplicate_completed") return check.result;
    if (check.status === "duplicate_in_progress") return { status: "in_progress" };
    if (check.status === "command_id_reused") return { status: "rejected", code: "command_id_reused" };
    let result: CommandResult;
    const pausedFor = state().pausedReason; // A4: a decision on awaiting_person_decision goes on by itself
    try {
      result = await apply(commandId, expectedRevision, cmd);
    } catch (error) {
      if (halted) return { status: "rejected", code: "store_failed" };
      result = { status: "rejected", code: error instanceof OrchestrationError ? error.code : "command_failed" };
    }
    try {
      await j(() => writer.completeCommand(commandId, result));
    } catch {
      return { status: "rejected", code: "store_failed" };
    }
    // v2 decisions: the run goes on only after its command.completed (journal-v2-format.md §2.4); a failure here leaves
    // the decision recorded and the run paused, which reopen() turns into paused(recovered)
    const goesOn = cmd.kind === "checks.decide" || cmd.kind === "finish.confirm" || cmd.kind === "check.amend" || cmd.kind === "plan.decide"
      || (cmd.kind === "person.decide" && pausedFor === "awaiting_person_decision");
    if (result.status === "accepted" && goesOn) {
      try {
        await setStatus("running");
      } catch {
        return result; // accepted, as the journal says; the store halted the run (I2-5)
      }
    }
    if (result.status === "accepted") after(cmd);
    if (result.status === "accepted" && cmd.kind === "person.decide" && !goesOn) await showDecisions(); // still paused: what is left to decide
    return result;
  }

  const reject = (code: string): CommandResult => ({ status: "rejected", code });
  const ok: CommandResult = { status: "accepted", code: null };

  // The decision goes to the journal first; the action (scheduling, stopping a process) follows in after().
  async function apply(commandId: string, expectedRevision: number, cmd: RunCommand): Promise<CommandResult> {
    const st = state();
    if (st.orch.revision !== expectedRevision) return reject("stale_revision");
    const status = st.status, reason = st.pausedReason ?? "";
    switch (cmd?.kind) {
      case "pause_after_turn":
        if (typeof cmd.on !== "boolean") return reject("invalid_command");
        if (cmd.on && status === "running") { await setStatus("pausing"); return ok; }
        if (!cmd.on && status === "pausing") { await setStatus("running"); return ok; }
        return reject("invalid_state");
      case "stop":
        if (!ACTIVE.includes(status)) return reject("invalid_state");
        await setStatus("stopping");
        return ok;
      case "resume":
      case "step":
        if (status !== "paused" || STOP_ONLY.includes(reason)) return reject("invalid_state");
        if (!RESUMABLE.includes(reason) && !(cmd.kind === "step" && STEP_ONLY.includes(reason))) return reject("invalid_state");
        await setStatus("running");
        return ok;
      case "answer": {
        const q = st.orch.question;
        if (status !== "paused" || reason !== "awaiting_answer") return reject("invalid_state");
        if (!q || q.answered || q.questionId !== cmd.questionId) return reject("unknown_question");
        if (typeof cmd.text !== "string" || cmd.text.trim() === "" || cmd.text.length > 8000) return reject("invalid_command");
        const ref = await j(() => writer.putText(cmd.text));
        await j(() => writer.recordAnswer({ questionId: q.questionId, commandId, text: ref }));
        await setStatus("running");
        return ok;
      }
      case "clarify": {
        // on the person's decisions of journal v2 only that decision and Stop (journal-v2-format.md §2.1)
        if (!ACTIVE.includes(status) || ["journal_corrupt", "awaiting_checks_decision", "awaiting_finish_confirmation", "check_needs_permissions", "awaiting_person_decision", "coverage_lost"].includes(reason)
          || (st.version === 2 && planProposalWaits(st))) return reject("invalid_state"); // A4: a waiting proposal is the person's first
        if (typeof cmd.text !== "string" || cmd.text.trim() === "" || cmd.text.length > 8000) return reject("invalid_command");
        const ref = await j(() => writer.putText(cmd.text));
        await j(() => writer.recordClarification({ version: st.orch.clarifications + 1, commandId, text: ref }));
        return ok;
      }
      case "raise_limit": {
        if (status !== "paused" || reason !== "limit_reached" || (st.version === 2 && planProposalWaits(st))) return reject("invalid_state");
        const current = effectiveLimits(goal, st);
        if (!RAISABLE.includes(cmd.limit) || !Number.isSafeInteger(cmd.value) || cmd.value <= current[cmd.limit]) return reject("invalid_command");
        if (cmd.limit === "runMs" && goal.createdAt + cmd.value <= clock()) return reject("invalid_command"); // still expired
        await j(() => writer.recordLimitsChanged({ commandId, kind: cmd.limit as "turns", value: cmd.value }));
        await setStatus("paused", "user_request");
        return ok;
      }
      case "recover": {
        if (status !== "paused" || reason !== "outcome_unknown") return reject("invalid_state");
        if (!["accept", "retry_turn", "reset_to_checkpoint"].includes(cmd.action)) return reject("invalid_command");
        if (cmd.action === "reset_to_checkpoint" && cmd.confirm !== true) return reject("confirm_required");
        if (cmd.action === "reset_to_checkpoint" && inPlace(ws.mode)) return reject("invalid_state"); // never written into the project
        const unknown = Object.keys(st.turns).filter((id) => st.turns[id].status === "outcome_unknown" && !st.orch.recoveryDecisions[id]);
        if (unknown.length === 0) return reject("invalid_state");
        for (const turnId of unknown) await j(() => writer.recordRecoveryDecision({ commandId, action: cmd.action, turnId }));
        if (cmd.action === "reset_to_checkpoint") {
          try {
            await resetToCheckpoint();
          } catch (error) {
            if (halted) throw error;
            await setStatus("paused", "environment_error");
            return ok; // the decision is recorded and acted on; the restore's own events say how far it got
          }
        }
        await setStatus("paused", "user_request");
        return ok;
      }
      case "dismiss":
        return ["stopped", "completed", "failed"].includes(status) ? ok : reject("invalid_state");
      case "checks.decide": {
        if (status !== "paused" || reason !== "awaiting_checks_decision" || !st.orch.checksProposal || st.orch.checksDecision) return reject("invalid_state");
        let lines: string[] | null = null;
        if (cmd.decision === "edit") {
          if (!Array.isArray(cmd.checks) || cmd.checks.length > 16 || cmd.checks.some((c) => typeof c !== "string" || !LINE(c.trim()))) return reject("invalid_command");
          lines = cmd.checks.map((c) => c.trim());
          if (new Set(lines).size !== lines.length) return reject("invalid_command");
        } else if (cmd.decision !== "accept" || cmd.checks !== undefined) return reject("invalid_command");
        await decideChecks(commandId, cmd.decision, lines);
        return ok; // run.status(running) follows command.completed (journal-v2-format.md §2.4), in command()
      }
      case "check.amend": {
        // A1.1 (§2.6): only the person, only for a lead's check the sandbox refused, once per check. Always with the
        // person's line (unchanged is a decision too): it becomes the person's command, without the sandbox. There is no
        // "run the lead's command without the sandbox" (owner's decision on S1-4: the refusal is seen in the output only)
        if (status !== "paused" || reason !== "check_needs_permissions") return reject("invalid_state");
        const refused = refusedCheck(st);
        if (typeof cmd.checkId !== "string" || cmd.checkId !== refused?.checkId) return reject("invalid_state");
        if (typeof cmd.line !== "string" || !LINE(cmd.line.trim())) return reject("invalid_command");
        const line = cmd.line.trim();
        const ref = await j(() => writer.putText(canonical(line)));
        await j(() => writer.recordEvent("checks.amended", { commandId, checkId: cmd.checkId, line: ref }));
        adoptGoal(withCommands(goal, (goal.commands ?? []).map((c, i) => (`cmd-${i + 1}` === cmd.checkId ? line : c)),
          (goal.sandboxed ?? []).filter((id) => id !== cmd.checkId)));
        return ok;
      }
      case "finish.confirm": {
        if (status !== "paused" || reason !== "awaiting_finish_confirmation" || !withoutChecks(st)) return reject("invalid_state");
        const asked = (step: "push" | "qa") => !!goal.finish?.[step];
        const valid = (step: "push" | "qa", v: unknown) => asked(step) ? v === "confirm" || v === "decline" : v === null;
        if (!valid("push", cmd.push) || !valid("qa", cmd.qa) || typeof cmd.tree !== "string" || (cmd.commit !== null && typeof cmd.commit !== "string")) return reject("invalid_command");
        // what the person saw must be what is here now: the tree of the work and its commit
        const tree = await snapshotCopyTree(ws, st.workspace!.current.tree);
        const commit = currentCommit(st, tree)?.commit ?? null;
        if (confirmationFor(st, tree, commit)) return reject("invalid_state");
        if (cmd.tree !== tree || cmd.commit !== commit) {
          // the work changed during the pause: the view shows it now and the person decides again (§2.5)
          latest = { tree, at: new Date(clock()).toISOString() };
          touch();
          return reject("stale_revision");
        }
        await j(() => writer.recordEvent("finish.confirmed", { commandId, tree, commit, push: cmd.push, qa: cmd.qa }));
        return ok;
      }
      case "person.decide":
        return personDecide(commandId, cmd);
      case "plan.decide":
        return planDecide(commandId, cmd);
      case "permission": {
        const p = permissions.get(cmd.requestId);
        if (!p) return reject("unknown_request");
        if (!p.view.options.includes(cmd.decision as never)) return reject("invalid_command");
        let answers: Record<string, string[]> | undefined;
        if (cmd.answers !== undefined) {
          const a = cmd.answers as unknown;
          const ids = new Set(p.view.questions.map((q) => q.id));
          if (!a || typeof a !== "object" || Array.isArray(a) || Object.entries(a).some(([k, v]) => !ids.has(k) || !Array.isArray(v)
            || v.length > 12 || v.some((x) => typeof x !== "string" || x.length > 2000))) return reject("invalid_command");
          answers = a as Record<string, string[]>;
        }
        let content: Record<string, unknown> | undefined;
        if (p.view.kind === "elicitation" && cmd.decision === "allow_once" && p.view.form?.mode === "form") {
          const checked = validateForm(p.view.form.fields, cmd.content ?? {});
          if (!checked.ok) return reject("invalid_form");
          content = checked.content;
        }
        if (cmd.feedback !== undefined && (typeof cmd.feedback !== "string" || cmd.feedback.length > 4000)) return reject("invalid_command");
        // Remembered decisions: journaled with their scope; a project one is saved in the project's profile too.
        if ((cmd.decision === "allow_run" || cmd.decision === "allow_project") && p.fingerprint) {
          const scope = cmd.decision === "allow_run" ? "run" as const : "project" as const;
          if (scope === "project") {
            try {
              await deps.grants!.add({ provider: p.view.provider, kind: p.view.kind, tool: p.view.tool, summary: p.view.summary, fingerprint: p.fingerprint });
            } catch { return reject("profile_failed"); }
          }
          if (!state().orch.grants[p.fingerprint]) {
            const summary = await j(() => writer.putText(`${p.view.tool}: ${p.view.summary}`));
            await j(() => writer.recordEvent("permission.granted", {
              grantId: randomUUID(), scope, provider: p.view.provider, kind: p.view.kind.slice(0, 40), tool: p.view.tool.slice(0, 120), fingerprint: p.fingerprint, summary
            }));
          }
        }
        if (cmd.decision === "allow_readonly_run") readOnly.allowed = true;
        const decision = cmd.decision === "allow_run" || cmd.decision === "allow_project" || cmd.decision === "allow_readonly_run" ? "allow_once" : cmd.decision;
        observe((act) => act.permission(p.turnRole, p.view.provider, turnOf(), "decided", `${p.view.tool}: ${cmd.decision}`, { requestId: cmd.requestId, decision: cmd.decision }));
        p.reply({ decision, ...(answers ? { answers } : {}), ...(content ? { content } : {}), ...(typeof cmd.feedback === "string" ? { feedback: cmd.feedback } : {}) });
        return ok;
      }
      default:
        return reject("invalid_command");
    }
  }

  // ---------- A4: the person's decisions (5h §3.5, §3.6; journal-v2-format.md §2.9) ----------

  // The state the person decides on: the copy as it is now. A decision about another state than they saw (the work
  // changed while the dialog was open) is refused; the view shows the new state and they decide again.
  async function seen(runKeyShown: unknown): Promise<Snapshot | null> {
    const snap = await takeSnapshot(state());
    if (snap.runKey === runKeyShown) return snap;
    await showDecisions();
    return null;
  }

  async function personDecide(commandId: string, cmd: OrchestrationPersonDecide): Promise<CommandResult> {
    const st = state();
    const reason = st.pausedReason ?? "";
    if (st.version !== 2 || st.status !== "paused") return reject("invalid_state");
    const c = await conds();
    const book = c?.findings?.book;
    let finding: string | null = null;
    let reopened: boolean | null = null;
    let target: string | { reviewTurnId: string; index: number };
    if (cmd.subject === "disputed") {
      const t = cmd.target as { reviewTurnId?: unknown; index?: unknown };
      const item = book?.disputed.find((d) => d.turnId === t?.reviewTurnId && d.index === t?.index);
      if (reason !== "awaiting_person_decision" || !book || !item) return reject("invalid_state");
      if (cmd.decision === "new" && cmd.finding === null) finding = `F${book.next}`;
      else if (cmd.decision === "repeat" && typeof cmd.finding === "string" && item.candidates.includes(cmd.finding)) {
        const f = book.list.get(cmd.finding)!;
        if (f.status !== "closed") return reject("invalid_state");
        // the rule of opening again by id (5h §3.4), about the state the item was reported on: another state than the
        // one it was closed on, and one of its own paths changed since it was closed
        const review = st.orch.reviews.find((r) => r.turnId === item.turnId)!;
        const tree = st.orch.turns[item.turnId]?.tree ?? null;
        const changed = tree ? new Set((await diffTreeNames(ws, f.closeTree!, tree, Number.MAX_SAFE_INTEGER)).files.map((x) => x.path)) : new Set<string>();
        finding = f.id;
        reopened = review.runKey !== f.closeRunKey && f.paths.some((x) => changed.has(x));
      } else return reject("invalid_command");
      target = { reviewTurnId: item.turnId, index: item.index };
    } else if (cmd.subject === "condition") {
      const stage = Object.keys(st.orch.accepted).length + 1;
      if (reason !== "awaiting_person_decision" || !c || typeof cmd.target !== "string" || !personIdsOf(c.book, stage).includes(cmd.target)) return reject("invalid_state");
      if ((cmd.decision !== "met" && cmd.decision !== "not_met") || cmd.finding !== null) return reject("invalid_command");
      target = cmd.target;
    } else if (cmd.subject === "finding") {
      const f = typeof cmd.target === "string" ? book?.list.get(cmd.target) : undefined;
      if (!FINDING_PAUSES.includes(reason) || !f || f.status !== "open") return reject("invalid_state");
      if ((cmd.decision !== "close" && cmd.decision !== "to_wish") || cmd.finding !== null || (cmd.decision === "to_wish" && f.severity !== "blocking")) return reject("invalid_command");
      target = f.id;
    } else return reject("invalid_command");
    const snap = await seen(cmd.runKey);
    if (!snap) return reject("stale_revision");
    await j(() => writer.recordEvent("person.decided", { commandId, subject: cmd.subject, target, decision: cmd.decision, finding, reopened, runKey: snap.runKey, tree: snap.tree }));
    shownFindings = findingsView(state(), await conds());
    shownConditions = await viewConditions(snap.checkKeys);
    return ok; // on awaiting_person_decision the run goes on after command.completed; elsewhere it stays paused
  }

  async function planDecide(commandId: string, cmd: OrchestrationPlanDecide): Promise<CommandResult> {
    const st = state();
    const p = st.orch.proposals.at(-1);
    if (st.version !== 2 || st.status !== "paused" || st.pausedReason !== "coverage_lost" || !p || p.decision !== null || cmd.proposalTurnId !== p.turnId) return reject("invalid_state");
    const c = (await conds())!;
    const text = await readJson<PlanText>(p.ref);
    let choices: PlanChoices = { findings: [] };
    let note: string | null = null;
    if (cmd.decision === "accept") {
      if (cmd.note !== null || !Array.isArray(cmd.choices)) return reject("invalid_command");
      // 5h §3.6 p. 4: one choice for every open blocking finding of a dropped condition, nothing else
      const drops = new Set((text.dropped ?? []).map((x) => x.condition));
      const affected = (c.findings ? openBlocking(c.findings.book) : []).filter((f) => f.condition !== null && drops.has(f.condition)).map((f) => f.id).sort();
      const last = p.firstStage + p.stageCount - 1;
      const newIds = new Set(text.stages.flatMap((x) => (x.conditions ?? []).map((k) => ("keep" in k ? k.keep : k.id))));
      const valid = (x: OrchestrationPlanChoice) => x && typeof x.id === "string" && (x.choice === "close" || x.choice === "to_wish"
        ? x.stage === null && x.condition === null
        : x.choice === "move" && (x.condition === null ? Number.isSafeInteger(x.stage) && x.stage! >= p.firstStage && x.stage! <= last : x.stage === null && newIds.has(x.condition)));
      if (!cmd.choices.every(valid) || JSON.stringify(cmd.choices.map((x) => x.id).sort()) !== JSON.stringify(affected)) return reject("invalid_command");
      // the defensive check of 5h §3.6 p. 3: the proposal still holds against the state now
      const stages = text.stages.map((x) => ({ conditions: (x.conditions ?? []).map((k) => ("keep" in k ? { keep: k.keep } : { text: k.text, covers: k.covers, evidence: k.evidence })) }));
      if (planProblems(stages, { dropped: text.dropped ?? [], dropRequirements: text.dropRequirements ?? [] }, c.book, p.firstStage, goal.criteria.length, goal.checks, await returnedConditions()).length) return reject("invalid_state");
      choices = { findings: cmd.choices.map((x) => ({ id: x.id, choice: x.choice, stage: x.stage, condition: x.condition })) };
    } else if (cmd.decision === "return") {
      if (!Array.isArray(cmd.choices) || cmd.choices.length || (cmd.note !== null && (typeof cmd.note !== "string" || cmd.note.length > 4000))) return reject("invalid_command");
      note = cmd.note?.trim() ? cmd.note.trim() : null;
    } else return reject("invalid_command");
    const snap = await seen(cmd.runKey);
    if (!snap) return reject("stale_revision");
    const choicesRef = await j(() => writer.putText(canonical(choices)));
    const noteRef = note === null ? null : await j(() => writer.putText(note!));
    await j(() => writer.recordEvent("plan.decided", {
      commandId, proposalTurnId: p.turnId, decision: cmd.decision, version: cmd.decision === "accept" ? (st.orch.plan?.version ?? 0) + 1 : null,
      choices: choicesRef, note: noteRef, runKey: snap.runKey, tree: snap.tree
    }));
    return ok; // run.status(running) follows command.completed, in command()
  }

  // Actions after the decision is journaled. Stop never waits for the operation here: the command returns now.
  function after(cmd: RunCommand): void {
    if (cmd.kind === "stop") {
      stepBudget = null;
      if (active) {
        active.stop();
        stopTimer = setTimeout(() => { stopTimer = null; finishStop().catch(() => {}).finally(notify); }, stopGraceMs);
      } else if (!driving) {
        finishStop().catch(() => {}).finally(notify);
      }
      return;
    }
    if (cmd.kind === "step") stepBudget = 1;
    if (cmd.kind === "checks.decide" || cmd.kind === "finish.confirm" || cmd.kind === "check.amend" || cmd.kind === "plan.decide" || cmd.kind === "person.decide") stepBudget = null;
    if (cmd.kind === "resume") stepBudget = null;
    if (state().status === "running") schedule();
  }

  const handle: RunHandle = {
    runId,
    view() {
      return runView(state(), halted,
        active === null ? null : active.kind === "turn" ? { kind: "turn", purpose: active.purpose } : active.kind === "check" ? { kind: "check", checkId: active.checkId }
          : active.kind === "prepare" ? { kind: "prepare" } : { kind: "finish", step: active.step },
        viewExtra());
    },
    seq: () => state().lastSeq,
    tick: () => tick,
    command,
    onChange: (listener) => { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
    latestTree: () => latest,
    idle() {
      return new Promise<void>((resolve) => { waiters.push(resolve); notify(); });
    },
    async shutdown() {
      shuttingDown = true;
      if (active) abortActive("shutdown");
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([handle.idle(), new Promise<void>((r) => { timer = setTimeout(r, stopGraceMs + 1000); })]);
      clearTimeout(timer);
      if (!halted && ["running", "pausing"].includes(state().status)) await setStatus("paused", state().status === "pausing" ? "user_request" : "app_closed").catch(() => {});
      await handle.close();
    },
    async close() {
      halted = true; // a late result of an operation shutdown stopped continues nothing and starts nothing
      if (stopTimer) clearTimeout(stopTimer);
      if (abortTimer) clearTimeout(abortTimer);
      disarmOperation();
      await writer.close();
    }
  };

  return {
    handle,
    // After a restart (journal-v2-format.md §2.5): a decision recorded before the end, its run still paused on the
    // question, goes back to the person as recovered (opening never continues a run); a question still open gets what
    // it is about into the view.
    async reopen() {
      const st = state();
      const decided = (st.pausedReason === "awaiting_checks_decision" && st.orch.checksDecision !== null)
        || (st.pausedReason === "awaiting_finish_confirmation" && (st.orch.confirmations.at(-1)?.seq ?? -1) > (st.orch.lastPausedSeq.awaiting_finish_confirmation ?? -1))
        // A4: the person decided on the proposal, or about what the pause asked (5h §3.5)
        || (st.pausedReason === "coverage_lost" && !planProposalWaits(st))
        || (st.pausedReason === "awaiting_person_decision" && (st.orch.person.at(-1)?.seq ?? -1) > (st.orch.lastPausedSeq.awaiting_person_decision ?? -1))
        || (st.pausedReason === "check_needs_permissions" && Math.max(-1, ...Object.values(st.orch.amended).map((a) => a.seq)) > (st.orch.lastPausedSeq.check_needs_permissions ?? -1));
      if (decided) await setStatus("paused", "recovered");
      if (state().pausedReason === "awaiting_checks_decision") await loadProposal();
      if (state().pausedReason === "awaiting_finish_confirmation") latest = { tree: await snapshotCopyTree(ws, st.workspace!.current.tree), at: new Date(clock()).toISOString() };
      shownConditions = await viewConditions(await shownCheckKeys(state(), readJson).catch(() => null));
      shownFindings = findingsView(state(), await conds());
      await showDecisions();
    },
    async start() {
      await setStatus("running");
      // A copy or a worktree of a native run: the project's dependency folders, before any preparation (stages 4–11
      // link node_modules themselves).
      if (!deps.checks.deps && ws.mode !== "project") {
        // What becomes of each folder: cloned; installed by a step of the preparation (its result is a later
        // prepare_finished of that step); or nothing installs it, and why.
        const steps = goal.prepare?.steps ?? [];
        const said: Record<string, string> = { cloned: "cloned from the project", install: "installed in the copy", auto_off: "not installed: automatic preparation is off",
          no_step: "not installed: no install step", not_needed: "not needed" };
        const dirs: (Awaited<ReturnType<typeof cloneDependencies>>[number] & { plan: string; step: number })[] = [];
        for (const d of (await cloneDependencies(ws, deps.cloneDir).catch(() => [])).filter((x) => x.reason !== "already in the copy")) {
          const step = steps.findIndex((s) => s.unless === d.dir || !!s.unless?.startsWith(`${d.dir}/`));
          // a step with nothing to install leaves no folder: not needed, nothing is waited for
          const empty = step >= 0 && await installsNothing(ws.repo, steps[step]).catch(() => false);
          const plan = d.result === "cloned" ? "cloned" : step >= 0 && !empty ? "install" : d.result === "skipped" || empty ? "not_needed" : prepareAuto === false ? "auto_off" : "no_step";
          dirs.push({ ...d, plan, step });
        }
        if (dirs.length) {
          observe((a) => a.prepare("prepare_finished", dirs.map((d) => `${d.dir}: ${said[d.plan]}${d.result === "installed" ? ` (${d.reason})` : ""}`).join("; "),
            { dependencies: true, ...Object.fromEntries(dirs.flatMap((d) => [[d.dir, d.plan], ...(d.plan === "install" ? [[`step:${d.dir}`, d.step]] : [])])) }));
        }
      }
      schedule();
    }
  };
}

// Stage 13: the run's progress as facts of the journal: the latest result of every check (and whether it is about the
// current state), the preparation, the actions after success with their confirmation.
export function progressOf(st: RunState, goal: Goal, branch: string | null): RunProgress {
  const checks = goal.checks.map((id, i) => {
    let best: { checkRunId: string; seq: number } | null = null;
    for (const [checkRunId, a] of Object.entries(st.orch.assessed)) {
      if (st.checks[checkRunId]?.checkId === id && (!best || a.seq > best.seq)) best = { checkRunId, seq: a.seq };
    }
    const c = best ? st.checks[best.checkRunId] : null;
    return {
      id, title: goal.commands?.[i] ?? id, status: (c?.status === "in_flight" ? "not_run" : c?.status ?? "not_run") as RunProgress["checks"][number]["status"],
      class: best ? st.orch.classified[best.checkRunId] ?? null : null
    };
  });
  const p = st.orch.prepares.at(-1);
  // a decline stands for the commit it was given on: a new commit asks again (journal-v2-format.md §2.1)
  const commitSeq = Math.max(-1, ...st.orch.finish.filter((f) => f.step === "commit" && f.status === "done").map((f) => f.resultSeq ?? -1));
  const confirmed = st.orch.confirmations.filter((c) => c.seq > commitSeq).at(-1);
  return {
    mode: goal.mode ?? "autopilot", branch, access: goal.access ?? null, checks,
    ...(goal.models ? { models: { lead: goal.models.lead ?? null, executor: goal.models.executor ?? null, reviewer: goal.models.reviewer ?? null } } : {}),
    // the failed step's command (the goal's steps) and the preparation's output, for the run panel to say why
    prepare: p ? { status: p.status, failed: p.failed === null ? null : String(p.failed), class: p.class,
      command: p.failed === null ? null : goal.prepare?.steps[p.failed]?.command ?? null, output: p.output } : null,
    finish: (["commit", "push", "qa"] as const).map((step) => {
      const last = st.orch.finish.filter((f) => f.step === step).at(-1);
      return {
        step, asked: !!goal.finish?.[step], status: last?.status ?? "not_started", established: last?.established ?? false, commit: last?.commit ?? null,
        ...(step !== "commit" && confirmed?.[step] === "decline" ? { declined: true } : {}),
        evidence: last?.evidence?.sha256 ?? null,
        // an older QA result that passed without the contract (bound included) never confirmed a version
        ...(step === "qa" && last ? { version: last.version ?? (last.status === "done" ? "not_checked" : null), observed: last.observed ?? null } : {})
      };
    }),
    grantsApplied: st.orch.applied,
    ...(st.version === 2 ? {
      completion: st.completion?.kind ?? null,
      checksFrom: st.orch.checksDecision ? (st.orch.checksDecision.decision === "edit" ? "edited" as const : "proposal" as const) : st.orch.checksProposal ? null : "goal" as const
    } : {}),
    budget: budgetOf(st, goal)
  };
}

// UX audit 2026-10-05, Н7: what the run has spent of its limits, from the journal and the goal. Model calls are the
// turns (each one is one CLI run); reached: the limit a limit_reached pause stopped at, by the same rules as the cycle.
export function budgetOf(st: RunState, goal: Goal, now = Date.now()): RunBudget {
  const limits = effectiveLimits(goal, st);
  const calls = { lead: 0, executor: 0, reviewer: 0 };
  for (const t of Object.values(st.turns)) calls[t.role] += 1;
  const used = Object.keys(st.turns).length;
  const replans = Math.max(0, (st.orch.plan?.version ?? 0) - 1);
  const reached = st.status !== "paused" || st.pausedReason !== "limit_reached" ? null
    : now - goal.createdAt >= limits.runMs ? "runMs" : used >= limits.turns ? "turns" : (st.orch.plan?.version ?? 0) > limits.replans ? "replans" : "roundsPerStage";
  return {
    calls, startedAt: goal.createdAt, deadlineAt: goal.createdAt + limits.runMs, reached,
    limits: { turns: limits.turns, runMs: limits.runMs, replans: limits.replans, roundsPerStage: limits.roundsPerStage },
    used: { turns: used, replans }
  };
}

// ---------- A2: requirements and readiness conditions (journal-v2-format.md §2.7) ----------

type ReadJson = <T>(ref: TextRef) => Promise<T>;
export interface ConditionTexts { book: ConditionsBook; reports: Record<string, unknown>; findings: FindingsReplay | null }
// The plans' conditions and the lead's review answers of a run, from its texts (the same reading as the store's check).
export async function loadConditions(st: RunState, read: ReadJson): Promise<ConditionTexts> {
  const t = await conditionTexts(st, read);
  return {
    book: bookOf(st.orch.plans.map((p, i) => ({ firstStage: p.firstStage, text: t.plans![i], conditionsAssigned: p.conditionsAssigned ?? null, base: p.base }))), reports: t.reports!,
    // A3: the findings of a journal the reviewer reviews (journal-v2-format.md §2.8); A4: with the person's choices
    findings: byReviewer(st) ? replayFindings(st, { plans: t.plans!, reports: t.reports!, applied: t.applied!, choices: t.choices ?? {} }) : null
  };
}
// A3: the findings as the run panel shows them (journal-v2-format.md §2.8); null when the lead reviews.
export function findingsView(st: RunState, c: ConditionTexts | null): OrchestrationFindings | null {
  if (!c?.findings) return null;
  const owners = ownersOf(st, c);
  const book = c.findings.book;
  return {
    items: [...book.list.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).map((f) => ({
      id: f.id, severity: f.severity, status: f.status, condition: f.condition, stage: f.status === "open" ? ownerOf(f, owners) : null,
      problem: f.problem, evidence: f.evidence, closeWhen: f.closeWhen, paths: f.paths, possibleRepeatOf: f.possibleRepeatOf,
      history: f.history.map((h) => ({ kind: h.kind, reviewTurnId: h.turnId, index: h.index, runKey: h.runKey, tree: h.tree, reason: h.reason ?? null,
        by: h.by ?? "reviewer" as const, note: h.note ?? null })),
      downgraded: book.downgraded.includes(f.id)
    })),
    disputed: book.disputed.map((d) => ({ reviewTurnId: d.turnId, index: d.index, problem: d.problem, candidates: d.candidates })),
    openBlocking: openBlocking(book).length
  };
}
// Who owns an open finding now, by the plans in force (5h §3.4).
const ownersOf = (st: RunState, c: ConditionTexts) => ({ stages: c.book.stages, accepted: Object.keys(st.orch.accepted).length, recorded: st.orch.plans });
const heldBy = (st: RunState, c: ConditionTexts, stage: number): Finding[] => openBlocking(c.findings!.book).filter((f) => ownerOf(f, ownersOf(st, c)) === stage);
const findingsInput = (st: RunState, c: ConditionTexts) => ({
  stageHeld: (stage: number) => heldBy(st, c, stage).length > 0, anyHeld: openBlocking(c.findings!.book).length > 0, disputed: c.findings!.book.disputed.length > 0
});
const marksIn = (reports: Record<string, unknown>, turnId: string | null): ConditionMark[] => {
  const c = turnId ? (reports[turnId] as { conditions?: unknown } | undefined)?.conditions : undefined;
  return Array.isArray(c) ? c as ConditionMark[] : [];
};
// The latest result of a command on the tree a decision is about. checkKeys null (the tree is not known here): the latest
// result, unless an executor turn came after it — then it may be of an older tree, and nothing is concluded from it.
function checkOn(st: RunState, cmd: string, checkKeys: Readonly<Record<string, string>> | null): { status: Status; checkRunId: string | null } {
  let best: { id: string; seq: number } | null = null;
  for (const [id, a] of Object.entries(st.orch.assessed)) {
    if (st.checks[id]?.checkId !== cmd || (checkKeys && a.checkKey !== checkKeys[cmd])) continue;
    if (!best || a.seq > best.seq) best = { id, seq: a.seq };
  }
  if (!best || (!checkKeys && Object.values(st.orch.turns).some((t) => t.purpose === "execute" && t.seq > best!.seq))) return { status: "not_checked", checkRunId: null };
  return { status: st.checks[best.id].status === "passed" ? "met" : "not_met", checkRunId: best.id };
}
const inForce = (st: RunState) => (r: { turnId: string }) => st.orch.turns[r.turnId]?.planVersion === st.orch.plan?.version;
// The review a stage's "change" conditions are judged by: the one it was accepted on, otherwise its latest under the plan.
const stageReview = (st: RunState, stage: number): string | null =>
  st.orch.accepted[String(stage)]?.reviewTurnId ?? st.orch.reviews.filter((r) => r.stage === stage && inForce(st)(r)).at(-1)?.turnId ?? null;
const finalReview = (st: RunState): string | null => st.orch.reviews.filter((r) => r.stage === null && inForce(st)(r)).at(-1)?.turnId ?? null;

// The tree a run nobody decides on is shown on: a completed run's, from its basis; otherwise null (the latest result).
export async function shownCheckKeys(st: RunState, read: ReadJson): Promise<Readonly<Record<string, string>> | null> {
  return st.completion ? (await read<CompletionBasis>(st.completion.basis)).checkKeys : null;
}

// The facts the cycle and the completion function decide on; null: no condition rule applies (v1, A1's plan form).
// stale (A4, 5h §3.7): the evidence of accepted stages whose files changed since — then the last final review's mark
// of it counts; null: not known here (nobody holds the run's tree), the evidence stands.
export function conditionFacts(st: RunState, goal: Goal, c: ConditionTexts | null, checkKeys: Readonly<Record<string, string>> | null,
  stale: ((id: string) => boolean) | null = null): ConditionFacts | null {
  if (st.version !== 2 || !c?.book.conditioned) return null;
  const final = (c.reports[finalReview(st) ?? ""] as { requirements?: unknown } | undefined)?.requirements;
  return factsOf(c.book, goal.criteria.length, {
    check: (cmd) => checkOn(st, cmd, checkKeys).status,
    marks: (stage) => { const id = stageReview(st, stage); return id ? marksIn(c.reports, id) : null; },
    finalMarks: Array.isArray(final) ? final as RequirementMark[] : null,
    person: (id, stage) => personStatus(st, id, stage),
    ...(stale ? { stale, confirmed: (id: string) => marksIn(c.reports, finalReview(st)).find((m) => m.id === id)?.status ?? null } : {})
  });
}

// A4 (5h §3.7) for a run nobody holds: its copy's tree is not read (a view writes nothing), so the "change" evidence
// of an accepted stage an executor turn came after may be stale — not counted until the final review confirms it.
export function possiblyStale(st: RunState, c: ConditionTexts): (id: string) => boolean {
  const out = new Set<string>();
  for (const [stage, a] of Object.entries(st.orch.accepted)) {
    if (!Object.values(st.orch.turns).some((t) => t.purpose === "execute" && t.seq > a.seq)) continue;
    for (const id of changeIdsOf(c.book, Number(stage))) out.add(id);
  }
  return (id) => out.has(id);
}

// The same facts as shown: every requirement and condition with its proof (journal-v2-format.md §2.7, «Показ»).
export function conditionsView(st: RunState, goal: Goal, c: ConditionTexts | null, checkKeys: Readonly<Record<string, string>> | null,
  stale: ((id: string) => boolean) | null = null): OrchestrationConditions | null {
  const f = conditionFacts(st, goal, c, checkKeys, stale);
  if (!f || !c) return null;
  const conditions = f.conditions.map((x): OrchestrationConditions["conditions"][number] => {
    const d = c.book.defs.get(x.id)!;
    let proof: OrchestrationConditions["conditions"][number]["proof"] = null;
    if (d.evidence.kind === "check") {
      const run = checkOn(st, d.evidence.check, checkKeys).checkRunId;
      if (run) proof = { checkRunId: run, output: st.checks[run]?.output ?? null };
    } else if (d.evidence.kind === "person") {
      // A4: the person's decision in force, by its command
      const said = personStatus(st, x.id, x.stage);
      const by = st.orch.person.filter((p) => p.subject === "condition" && p.target === x.id).at(-1);
      if (by && (said === "met" || said === "not_met")) proof = { commandId: by.commandId, decision: said };
    } else {
      const review = stageReview(st, x.stage);
      const m = marksIn(c.reports, review).find((y) => y.id === x.id);
      if (review && m) proof = { reviewTurnId: review, paths: [...m.paths], note: m.note };
    }
    const evidence = d.evidence.kind === "check"
      ? { kind: "check" as const, check: d.evidence.check, command: goal.commands?.[Number(d.evidence.check.slice(4)) - 1] ?? null } : { kind: d.evidence.kind };
    return { id: x.id, text: d.text, covers: [...d.covers], stage: x.stage, status: x.status, ...(x.stale ? { stale: true } : {}), evidence, proof };
  });
  return {
    // A4: a requirement or condition the person dropped says so, with the lead's why — never as met
    requirements: f.requirements.map((r, i) => ({ id: r.id, text: goal.criteria[i], conditions: r.conditions, status: r.status,
      ...(r.status === "dropped" ? { why: c.book.droppedRequirements.get(r.id) ?? null } : {}) })),
    conditions,
    dropped: [...c.book.dropped.entries()].map(([id, why]) => ({ id, text: c.book.defs.get(id)?.text ?? "", covers: [...(c.book.defs.get(id)?.covers ?? [])], why })),
    met: conditions.filter((x) => x.status === "met").length, total: conditions.length
  };
}

// §11 outcome mapping. A stop we asked for is not an environment problem: the stop flow finishes the run.
function pauseForOutcome(r: ProviderTurnResult, stoppedByUs: boolean): PausedReason | null {
  switch (r.outcome) {
    case "completed": return null;
    case "invalid_report": return "invalid_report";
    case "protocol_error":
    case "contract_violation": return "protocol_error";
    case "stopped": return stoppedByUs ? null : "environment_error";
    default: return "environment_error";
  }
}
