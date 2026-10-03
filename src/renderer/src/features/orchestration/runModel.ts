// The renderer's view of a run (stage-8-contract.md §2). Pure: no IPC, no React, testable under node. Main decides every
// command; this only says which buttons make sense for a view, reads the journal pages into lines, keeps a command's or
// a create request's id stable across a retry of the same action, and tells a transport failure from a refusal.
import type {
  OrchestrationActivityEntry,
  OrchestrationHistoryRecord,
  OrchestrationPermissionOption,
  OrchestrationQaVersion,
  OrchestrationResult,
  OrchestrationPersonDecide,
  OrchestrationPlanDecide,
  OrchestrationRunCommand,
  OrchestrationRunView
} from "../../../../shared/orchestration.ts";
import type { LocaleId } from "../../../../shared/contracts.ts";
import { t, type TranslationKey } from "../../lib/i18n.ts";

// The same sets the service uses (orchestrationService.ts); the service still decides.
const RESUMABLE = ["user_request", "step_done", "plan_review", "permission_denied", "loop_suspected", "environment_error", "recovered",
  "stage_done", "external_failure", "needs_user_action", "finish_unconfirmed", "app_closed", "tree_changed_during_review"];
const STEP_ONLY = ["invalid_report", "protocol_error"];
const STOP_ONLY = ["lead_modified_tree", "shared_git_tampered", "journal_corrupt", "sandbox_unavailable"];
export const ACTIVE_STATUSES = ["preparing", "running", "pausing", "paused", "stopping"];
export const TERMINAL_STATUSES = ["stopped", "completed", "failed"];

export type RunAction = "pause" | "keep_running" | "resume" | "step" | "stop" | "answer" | "clarify" | "raise_limit" | "recover" | "permission"
  | "checks_decide" | "finish_confirm" // journal v2: the person's decisions, with Stop the only actions on their pauses
  | "check_amend" // A1.1: a lead's check the sandbox refused — the person's line in its place (edited or not)
  | "person_decide" | "plan_decide"; // A4: the person's decisions (journal-v2-format.md §2.9)

// Where orchestration is unavailable (orchestrationAvailable() false, main refuses with unsupported_platform) its entry
// points stay visible but inactive, with this hint: new agent cards, linking, a new goal (and so autopilot).
export function orchestrationEntry(available: boolean): { disabled: boolean; hint: "orchUnavailablePlatform" | null } {
  return available ? { disabled: false, hint: null } : { disabled: true, hint: "orchUnavailablePlatform" };
}
// This window's answer (preload). Without the API (a server render in tests, a harness) the items stay as before: main
// refuses on its own anyway.
export function orchestrationAvailableHere(): boolean {
  return (globalThis as { window?: { canvasTTY?: { orchestration?: { available?: boolean } } } }).window?.canvasTTY?.orchestration?.available ?? true;
}
// A run's actions there: all shown, only Stop active (every other one continues the run with its CLIs).
export function actionEnabled(action: RunAction, available: boolean): boolean {
  return available || action === "stop";
}

export function availableActions(view: OrchestrationRunView): RunAction[] {
  const actions = runActions(view);
  // A4: an open finding the person may close or make a wish on this pause (main says which pauses: view.decisions)
  return view.status === "paused" && view.decisions?.findings && !actions.includes("person_decide") ? [...actions, "person_decide"] : actions;
}
function runActions(view: OrchestrationRunView): RunAction[] {
  if (view.halted || view.newer) return []; // a newer version's run: nothing is sent to it from here
  const clarify: RunAction[] = view.reason === "journal_corrupt" ? [] : ["clarify"];
  switch (view.status) {
    case "preparing": return ["stop"];
    case "running": return ["pause", "stop", ...clarify];
    case "pausing": return ["keep_running", "stop", ...clarify];
    case "paused": {
      const r = view.reason ?? "";
      if (r === "awaiting_answer") return ["answer", "stop", ...clarify];
      if (r === "awaiting_checks_decision") return ["checks_decide", "stop"];
      if (r === "awaiting_finish_confirmation") return ["finish_confirm", "stop"];
      if (r === "check_needs_permissions") return ["check_amend", "stop"];
      // A4: the person's decision continues the run itself; nothing else but Stop there
      if (r === "awaiting_person_decision") return ["person_decide", "stop"];
      if (r === "coverage_lost") return ["plan_decide", "stop"];
      if (r === "limit_reached") return ["raise_limit", "stop", ...clarify];
      if (r === "outcome_unknown") return ["recover", "stop", ...clarify];
      if (STOP_ONLY.includes(r)) return ["stop", ...clarify];
      if (STEP_ONLY.includes(r)) return ["step", "stop", ...clarify];
      if (RESUMABLE.includes(r)) return ["resume", "step", "stop", ...clarify];
      return ["stop", ...clarify];
    }
    default: return []; // stopping, stopped, completed, failed
  }
}

// Who works now, for the cards and the panel. Preparation and the actions after success are CanvasTTY's own shell
// work, shown with the checks.
// A3: the reviewer reviews a run whose view has findings (journal-v2-format.md §2.8); its CLI is the lead's (Codex), so
// the Codex card shows its work.
export const byReviewer = (view: OrchestrationRunView | null): boolean => view?.progress?.findings != null;
export function activeRole(view: OrchestrationRunView | null): "lead" | "executor" | "reviewer" | "check" | null {
  const a = view?.active;
  if (!a) return null;
  if (a.kind !== "turn") return "check";
  return a.purpose === "execute" ? "executor" : a.purpose !== "plan" && byReviewer(view) ? "reviewer" : "lead";
}
// The participant a canvas card (lead or executor) stands for now: the Codex card is the reviewer while it reviews or asks.
export function cardRole(role: "lead" | "executor", view: OrchestrationRunView | null): "lead" | "executor" | "reviewer" {
  if (role !== "lead") return role;
  return activeRole(view) === "reviewer" || view?.permission?.role === "reviewer" ? "reviewer" : "lead";
}

// The run's status as every place names it (panel, cards, link chip, widget, workspace history): a run of journal v2
// completed without checks is "completed_no_checks", never "completed" (journal-v2-format.md §2.3).
export type RunStatusKey = OrchestrationRunView["status"] | "completed_no_checks";
export function runStatusKey(view: OrchestrationRunView): RunStatusKey {
  return view.status === "completed" && view.progress?.completion === "no_checks" ? "completed_no_checks" : view.status;
}

export type AgentState = "idle" | "starting" | "working" | "waiting" | "needs_you" | "paused" | "stopping" | "completed" | "completed_no_checks" | "stopped" | "failed" | "read_only";
// A card's state from its link's latest run: working only while its own role holds the turn; "needs_you" while its CLI
// waits for the person's decision (the panel may be closed, so the card says it).
export function agentState(role: "lead" | "executor", view: OrchestrationRunView | null): AgentState {
  if (!view) return "idle";
  if (view.newer) return "read_only"; // a newer version's run, whatever its journaled status: only viewed here
  if (view.status === "completed") return runStatusKey(view) as AgentState;
  if (view.status === "stopped" || view.status === "failed" || view.status === "stopping") return view.status;
  const onCard = (r: string | null | undefined) => (r === "reviewer" ? "lead" : r);
  if (onCard(view.permission?.role) === role) return "needs_you";
  if (view.status === "paused") return "paused";
  return onCard(activeRole(view)) === role ? "working" : "waiting";
}

// ---------- journal pages ----------

export interface TextRef { sha256: string; bytes: number }
// A text the journal refers to, readable with text(runId, sha256). ref null: the journal kept no text; `missing`
// says why when the journal knows (the report's status or its store error).
export interface LineText { kind: "report" | "findings" | "output"; ref: TextRef | null; missing: string | null }
export interface HistoryLine { seq: number; ts: string; kind: string; parts: Record<string, string | number | null>; text?: LineText }
const pick = (d: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, (d[k] ?? null) as string | number | null]));
const isRef = (v: unknown): v is TextRef =>
  !!v && typeof (v as TextRef).sha256 === "string" && typeof (v as TextRef).bytes === "number";

// The events a person follows, in journal order; storage and git bookkeeping stay out. Folded over the records read so
// far: a turn's purpose comes from its orch.turn, a check's id from its check.started.
export function historyLines(records: readonly OrchestrationHistoryRecord[]): HistoryLine[] {
  const purposes = new Map<string, string>();
  const checkIds = new Map<string, string>();
  const out: HistoryLine[] = [];
  let endedTurn: string | null = null;
  for (const r of records) {
    const d = r.data as Record<string, any>;
    const line = (kind: string, parts: Record<string, string | number | null>, text?: LineText) =>
      out.push({ seq: r.seq, ts: r.ts, kind, parts, ...(text ? { text } : {}) });
    switch (r.type) {
      case "run.status":
        // the turn whose end this status may be (pauseCause): kept only while the run does not go on
        line("status", { ...pick(d, "status", "reason"), ...((d.completion as { kind?: string } | null | undefined)?.kind === "no_checks" ? { status: "completed_no_checks" } : {}), turnId: endedTurn });
        if (d.status !== "paused" && d.status !== "pausing") endedTurn = null;
        break;
      case "orch.turn": purposes.set(d.turnId, d.purpose); line("turn", pick(d, "purpose", "stage", "round")); break;
      case "turn.finished": {
        endedTurn = typeof d.turnId === "string" ? d.turnId : null;
        const purpose = purposes.get(d.turnId) ?? null;
        const report = d.report ?? {};
        const text: LineText = { kind: "report", ref: isRef(report.ref) ? report.ref : null, missing: report.storeError ?? report.status ?? null };
        if (d.outcome !== "completed") line("turn_failed", { outcome: d.outcome ?? null, purpose }, text);
        else if (purpose === "execute") line("report", { purpose }, text);
        break;
      }
      case "plan.recorded": line("plan", pick(d, "version", "stageCount")); break;
      case "review.recorded":
        line("review", pick(d, "verdict", "stage", "findingsCount"),
          d.findingsCount > 0 ? { kind: "findings", ref: isRef(d.findings) ? d.findings : null, missing: null } : undefined);
        break;
      case "question.asked": line("question", {}); break;
      case "question.answered": line("answered", {}); break;
      case "stage.accepted": line("stage_accepted", pick(d, "stage")); break;
      case "clarification.added": line("clarified", pick(d, "version")); break;
      case "limits.changed": line("limit", pick(d, "kind", "value")); break;
      case "check.started": checkIds.set(d.checkRunId, d.checkId); break;
      case "check.finished":
        line("check", { ...pick(d, "status", "reason", "exitCode", "outputDropped"), checkId: checkIds.get(d.checkRunId) ?? null },
          { kind: "output", ref: isRef(d.output) ? d.output : null, missing: null });
        break;
      case "prepare.started": line("prepare_started", pick(d, "reason")); break;
      case "prepare.finished":
        line("prepare_finished", { ...pick(d, "status", "class"), failed: typeof d.failed === "number" ? d.failed + 1 : null },
          isRef(d.output) ? { kind: "output", ref: d.output, missing: null } : undefined);
        break;
      case "run.recovered": line("recovered", {}); break;
    }
  }
  return out;
}

// How a loaded text is shown: findings as a list, a report by its summary and the rest, check output as it is.
export function formatText(kind: LineText["kind"], text: string): { items: string[]; body: string } {
  if (kind === "output") return { items: [], body: text };
  try {
    const v = JSON.parse(text) as unknown;
    if (kind === "findings" && Array.isArray(v)) return { items: v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))), body: "" };
    if (kind === "report" && v && typeof v === "object" && !Array.isArray(v)) {
      const { summary, ...rest } = v as Record<string, unknown>;
      return { items: typeof summary === "string" ? [summary] : [], body: Object.keys(rest).length ? JSON.stringify(rest, null, 2) : "" };
    }
    return { items: [], body: JSON.stringify(v, null, 2) };
  } catch {
    return { items: [], body: text };
  }
}

export interface RunDigest {
  plan: { sha256: string; bytes: number } | null; // the latest plan's text ref
  question: { questionId: string; text: { sha256: string; bytes: number } } | null; // open question
  checks: { checkRunId: string; checkId: string; status: string | null; reason: string | null }[];
  finalVerdict: string | null;
  goal: TextRef | null; // run.created: the goal as stored (text, criteria, limits, createdAt)
  createdAt: string | null;
  lastExecuteReport: TextRef | null; // the executor's latest report (its `done` is what it claims)
  checkpoints: number[]; // stages with a checkpoint ref
  acceptedStages: number[];
  currentTask: { role: string; purpose: string | null; task: TextRef | null; ts: string } | null; // the latest turn.intent
}

// Folded over every page read so far, in seq order.
export function digest(records: readonly OrchestrationHistoryRecord[]): RunDigest {
  const out: RunDigest = {
    plan: null, question: null, checks: [], finalVerdict: null, goal: null, createdAt: null, lastExecuteReport: null,
    checkpoints: [], acceptedStages: [], currentTask: null
  };
  const purposes = new Map<string, string>();
  const answered = new Set<string>();
  const asked: { questionId: string; text: { sha256: string; bytes: number } }[] = [];
  const byRun = new Map<string, RunDigest["checks"][number]>();
  for (const r of records) {
    const d = r.data as Record<string, any>;
    if (r.type === "plan.recorded") { out.plan = d.plan; out.finalVerdict = null; } // a final review belongs to the plan it reviewed
    if (r.type === "question.asked") asked.push({ questionId: d.questionId, text: d.text });
    if (r.type === "question.answered") answered.add(d.questionId);
    if (r.type === "check.started") {
      const c = { checkRunId: d.checkRunId, checkId: d.checkId, status: null, reason: null };
      byRun.set(d.checkRunId, c);
      out.checks.push(c);
    }
    if (r.type === "check.finished") {
      const c = byRun.get(d.checkRunId);
      if (c) { c.status = d.status; c.reason = d.reason; }
    }
    if (r.type === "review.recorded" && d.stage === null) out.finalVerdict = d.verdict;
    if (r.type === "run.created") { out.goal = isRef(d.goal) ? d.goal : null; out.createdAt = r.ts; }
    if (r.type === "orch.turn") purposes.set(d.turnId, d.purpose);
    if (r.type === "turn.intent") out.currentTask = { role: d.role, purpose: purposes.get(d.turnId) ?? null, task: isRef(d.task) ? d.task : null, ts: r.ts };
    if (r.type === "turn.finished" && purposes.get(d.turnId) === "execute" && d.outcome === "completed" && isRef(d.report?.ref)) out.lastExecuteReport = d.report.ref;
    if (r.type === "checkpoint.created" && typeof d.stage === "number") out.checkpoints.push(d.stage);
    if (r.type === "stage.accepted" && typeof d.stage === "number") out.acceptedStages.push(d.stage);
  }
  out.question = asked.filter((q) => !answered.has(q.questionId)).at(-1) ?? null;
  return out;
}

export function parsePlan(text: string): { title: string; task: string }[] {
  try {
    const p = JSON.parse(text) as { stages?: unknown };
    return Array.isArray(p.stages)
      ? p.stages.filter((s): s is { title: string; task: string } => typeof s?.title === "string" && typeof s?.task === "string")
      : [];
  } catch {
    return [];
  }
}

// ---------- sending ----------

export type Outcome =
  | { kind: "accepted" }
  | { kind: "in_progress" }
  | { kind: "rejected"; code: string } // the service refused the command
  | { kind: "refused"; code: string; message?: string } // the operation itself was refused (argument, state of the app)
  | { kind: "transport"; message: string }; // the IPC call did not complete: nothing is known, retry with the same id

export async function outcomeOf<T>(call: () => Promise<OrchestrationResult<T>>): Promise<{ outcome: Outcome; value?: T }> {
  let r: OrchestrationResult<T>;
  try {
    r = await call();
  } catch (error) {
    return { outcome: { kind: "transport", message: String((error as Error)?.message ?? error) } };
  }
  if (!r.ok) return { outcome: { kind: "refused", code: r.code, ...(r.message ? { message: r.message } : {}) } };
  const v = r.value as unknown as { status?: string; code?: string | null };
  if (v && v.status === "rejected") return { outcome: { kind: "rejected", code: v.code ?? "rejected" }, value: r.value };
  if (v && v.status === "in_progress") return { outcome: { kind: "in_progress" }, value: r.value };
  return { outcome: { kind: "accepted" }, value: r.value };
}

// One id per logical action: a retry after a transport failure sends the same id (main answers a repeat with the
// recorded result); once main has answered, the next press is a new action with a new id. For links and cards.
export function createIdKeeper(newId: () => string) {
  const pending = new Map<string, string>();
  return {
    idFor(key: string): string {
      let id = pending.get(key);
      if (!id) pending.set(key, (id = newId()));
      return id;
    },
    settle(key: string): void { pending.delete(key); },
    size: () => pending.size
  };
}

// A run command whose answer is not known yet, kept whole: main recognises a repeat by commandId and compares the
// whole request (expectedRevision and payload), so a repeat must be the same request, not the same id with the
// revision of now. The action is identified by run and payload; the revision it was sent against stays with it.
export interface PendingCommand { runId: string; commandId: string; expectedRevision: number; command: OrchestrationRunCommand }
export interface CommandStorage { read(): string | null; write(value: string): void }

export function createCommandSender(newId: () => string, storage?: CommandStorage) {
  const key = (runId: string, command: OrchestrationRunCommand) => JSON.stringify([runId, command]);
  const pending = new Map<string, PendingCommand>();
  try {
    for (const p of JSON.parse(storage?.read() ?? "[]") as PendingCommand[]) pending.set(key(p.runId, p.command), p);
  } catch { /* unreadable storage: nothing pending */ }
  const persist = () => { try { storage?.write(JSON.stringify([...pending.values()])); } catch { /* best effort */ } };
  return {
    // The request to send for this action: the pending one if its answer is still unknown, else a new one.
    request(runId: string, revision: number, command: OrchestrationRunCommand): PendingCommand {
      const k = key(runId, command);
      let p = pending.get(k);
      if (!p) {
        pending.set(k, (p = { runId, commandId: newId(), expectedRevision: revision, command }));
        persist();
      }
      return p;
    },
    // main answered (accepted, rejected, in any way but a transport failure): the action is over.
    settle(p: PendingCommand): void {
      if (pending.get(key(p.runId, p.command))?.commandId === p.commandId) pending.delete(key(p.runId, p.command));
      persist();
    },
    pending: (runId: string): PendingCommand[] => [...pending.values()].filter((p) => p.runId === runId)
  };
}

export type CommandSender = ReturnType<typeof createCommandSender>;

export function commandOf(action: RunAction, input: { text?: string; questionId?: string; limit?: string; value?: number;
  recover?: "accept" | "retry_turn" | "reset_to_checkpoint"; confirm?: boolean;
  requestId?: string; decision?: OrchestrationPermissionOption; answers?: Record<string, string[]>;
  content?: Record<string, unknown>; feedback?: string;
  checks?: string[]; tree?: string; commit?: string | null; push?: "confirm" | "decline" | null; qa?: "confirm" | "decline" | null;
  checkId?: string; line?: string;
  person?: Omit<OrchestrationPersonDecide, "kind">; plan?: Omit<OrchestrationPlanDecide, "kind"> } = {}): OrchestrationRunCommand {
  switch (action) {
    case "pause": return { kind: "pause_after_turn", on: true };
    case "keep_running": return { kind: "pause_after_turn", on: false };
    case "resume": return { kind: "resume" };
    case "step": return { kind: "step" };
    case "stop": return { kind: "stop" };
    case "answer": return { kind: "answer", questionId: input.questionId ?? "", text: input.text ?? "" };
    case "clarify": return { kind: "clarify", text: input.text ?? "" };
    case "raise_limit": return { kind: "raise_limit", limit: (input.limit ?? "turns") as "turns", value: input.value ?? 0 };
    case "recover": return { kind: "recover", action: input.recover ?? "accept", ...(input.confirm ? { confirm: true } : {}) };
    case "checks_decide": return { kind: "checks.decide", decision: input.checks ? "edit" : "accept", ...(input.checks ? { checks: input.checks } : {}) };
    case "finish_confirm": return { kind: "finish.confirm", tree: input.tree ?? "", commit: input.commit ?? null, push: input.push ?? null, qa: input.qa ?? null };
    case "check_amend": return { kind: "check.amend", checkId: input.checkId ?? "", line: input.line ?? "" };
    case "person_decide": return { kind: "person.decide", ...input.person! } as OrchestrationPersonDecide;
    case "plan_decide": return { kind: "plan.decide", ...input.plan! } as OrchestrationPlanDecide;
    case "permission": return {
      kind: "permission", requestId: input.requestId ?? "", decision: input.decision ?? "deny", ...(input.answers ? { answers: input.answers } : {}),
      ...(input.content ? { content: input.content } : {}), ...(input.feedback !== undefined ? { feedback: input.feedback } : {})
    };
  }
}

// ---------- snapshots and events ----------

// (seq, tick) order of one watch (stage-7-contract.md §2.2): a state that is not newer never replaces the current one.
export const newerStamp = (a: { seq: number; tick: number }, b: { seq: number; tick: number } | null): boolean =>
  b === null || a.seq > b.seq || (a.seq === b.seq && a.tick > b.tick);

// ---------- the pinned summary (stage 11) ----------

// One plain headline for the state, the reason it is in, and the one next step to offer.
export type Headline = "working" | "awaiting_permission" | "stopping_after_turn" | "awaiting_answer" | "awaiting_plan_review" | "needs_setup"
  | "needs_decision" | "needs_action" | "paused" | "stopping" | "stopped" | "completed" | "completed_no_checks" | "failed" | "halted"
  | "awaiting_checks" | "awaiting_checks_none" | "awaiting_finish_confirmation" | "check_needs_permissions";
const NEEDS_SETUP = ["environment_error", "sandbox_unavailable", "permission_denied", "external_failure"];
const NEEDS_DECISION = ["outcome_unknown", "limit_reached", "loop_suspected", "invalid_report", "protocol_error", "lead_modified_tree", "shared_git_tampered", "journal_corrupt",
  "finish_unconfirmed", "tree_changed_during_review", "awaiting_person_decision", "coverage_lost"];

export function runHeadline(view: OrchestrationRunView): { headline: Headline; next: string } {
  if (view.halted) return { headline: "halted", next: "halted" };
  // A CLI waits for the person's permission or answer inside its turn (stage 12): nothing moves until it is given.
  if (view.permission && ["preparing", "running", "pausing"].includes(view.status)) return { headline: "awaiting_permission", next: "permission" };
  switch (view.status) {
    case "preparing": case "running": return { headline: "working", next: "watch" };
    case "pausing": return { headline: "stopping_after_turn", next: "keep_running" };
    case "stopping": return { headline: "stopping", next: "wait" };
    case "stopped": return { headline: "stopped", next: "new_goal" };
    case "completed": return {
      headline: runStatusKey(view) === "completed_no_checks" ? "completed_no_checks" : "completed",
      next: view.progress?.finish.some((f) => f.step === "qa" && f.asked && finishStatus(f) === "qa_unverified") ? "review_qa_unverified"
        : view.progress?.finish.some((f) => f.step === "commit" && f.status === "done") ? "review_committed"
        : view.workMode === "project" ? "review_in_place" : view.workMode === "worktree" ? "review_worktree" : "take_result"
    };
    case "failed": return { headline: "failed", next: "new_goal" };
    case "paused": {
      const r = view.reason ?? "";
      if (r === "awaiting_answer") return { headline: "awaiting_answer", next: "answer" };
      if (r === "plan_review") return { headline: "awaiting_plan_review", next: "review_plan" };
      // A1.1 Q1: step by step, the lead found none — add commands or go on without checks
      if (r === "awaiting_checks_decision") return view.proposal?.checks.length === 0 ? { headline: "awaiting_checks_none", next: "decide_no_checks" } : { headline: "awaiting_checks", next: "decide_checks" };
      if (r === "check_needs_permissions") return { headline: "check_needs_permissions", next: "amend_check" };
      if (r === "awaiting_finish_confirmation") return { headline: "awaiting_finish_confirmation", next: "confirm_finish" };
      if (NEEDS_SETUP.includes(r)) return { headline: "needs_setup", next: r };
      // failed: "resume" runs the action again; unknown: it only checks what happened (finishOrComplete in main)
      if (r === "finish_unconfirmed") return { headline: "needs_decision", next: finishPending(view)?.status === "failed" ? "finish_retry" : "finish_check" };
      if (NEEDS_DECISION.includes(r)) return { headline: "needs_decision", next: r };
      if (r === "needs_user_action") return { headline: "needs_action", next: r };
      if (r === "stage_done") return { headline: "paused", next: r };
      if (r === "app_closed") return { headline: "paused", next: r };
      return { headline: "paused", next: "resume" };
    }
  }
}

// How an action after success is said. For QA "the verification exited 0" and "this version is deployed" are
// different facts: only a verification that follows the version contract and reported the expected commit confirms
// the version (version "confirmed"). A passing verification without the contract — or a journal from before it — is
// "the check passed; the version is not confirmed". A reported other, missing or malformed version is said as such.
export function finishStatus(f: { step: string; status: string; version?: OrchestrationQaVersion | null; declined?: boolean }): string {
  if (f.declined) return "declined"; // journal v2: the person declined push/QA of a run without checks
  if (f.step !== "qa") return f.status;
  if (f.status === "done") return f.version === "confirmed" ? "qa_confirmed" : "qa_unverified";
  if (f.version === "mismatch" || f.version === "not_reported" || f.version === "invalid") return `qa_${f.version}`;
  return f.status;
}

// The first asked action after success that is not confirmed done (commit, push, QA order), for the finish pause.
export function finishPending(view: OrchestrationRunView): { step: "commit" | "push" | "qa"; status: string } | null {
  const f = view.progress?.finish.find((x) => x.asked && x.status !== "done" && !x.declined);
  return f ? { step: f.step, status: f.status } : null;
}

// ---------- participants and activity ----------

export type ParticipantPhase =
  | "configured" // on the canvas, no turn of this run yet
  | "waiting" // the run goes on, another participant has the turn
  | "starting" // its turn was given, the CLI process has not reported start yet
  | "running" // the CLI process runs
  | "finishing" // the process ended, the turn's result is being settled
  | "finished" // its last turn ended normally
  | "interrupted"; // its last turn ended otherwise, or the application ended during it

export interface ParticipantState {
  phase: ParticipantPhase;
  since: string | null; // when the current phase began (turn given / process started / turn ended)
  lastEventAt: string | null; // the newest activity of this participant
  outcome: string | null; // of its last finished turn
  turnId: string | null;
}

// The step that ended the turn the run is paused for: main keeps TurnResult.ending flattened in that turn's
// turn_finished activity entry (detail.endStep). null for an older entry without it, a turn that ended "ok" (e.g. a
// contract violation found after the transport), or a pause that this turn's outcome does not explain. The pause must be
// the turn's own: after its turn_finished the run never ran again nor paused for another reason.
export function pauseEnding(view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): string | null {
  const cause = viewCause(view, entries);
  return cause?.kind === "ending" ? cause.step : null;
}

// Steps where the application itself failed to pass the CLI's output on: the next step is not "fix the environment".
export const APP_FAILURE_STEPS: readonly string[] = ["relay_failed", "relay_incomplete", "held_after_supervisor_exit", "stream_unknown"];

// ---------- why a run paused: one classification for every place that says it ----------

// Main's reason (the journal, format v1) and, for a pause a turn's end caused, what that turn's activity adds:
// - provider_limit: a provider's usage limit ended the turn. The journal says paused(environment_error), as for any failed
//   turn; the CLI's message is in the turn's activity. The one recorded message is Codex's (codex-cli 0.155.1,
//   evidence/real-stage-13/series-S3-S5-S6-attempt2): "You’ve hit your usage limit. … try again at Sep 28th, 2026
//   11:51 PM." No real Claude limit message has been recorded, so a Claude limit still reads as an environment error.
//   The reset is the CLI's own words, not parsed.
// - ending: the step that ended the turn (TurnResult.ending, kept as detail.endStep of its turn_finished entry).
// - reason: main's reason as it is.
export type PauseCause =
  | { kind: "provider_limit"; reason: string; provider: string; resetsAt: string | null }
  | { kind: "prepare"; reason: string; command: string | null } // the environment preparation failed (its last record)
  | { kind: "ending"; reason: string; step: string }
  | { kind: "reason"; reason: string };
const USAGE_LIMIT = /\bhit your usage limit\b/i;

// reason: main's pause reason; turnId: the turn whose end the pause is (null: none); entries: the run's activity.
export function pauseCause(reason: string, turnId: string | null, entries: readonly OrchestrationActivityEntry[]): PauseCause {
  const turn = turnId ? entries.filter((e) => e.turnId === turnId) : [];
  const finished = [...turn].reverse().find((e) => e.kind === "turn_finished");
  if (!finished || finished.text === "completed") return { kind: "reason", reason };
  // the service's outcome -> pause reason mapping (pauseForOutcome): the pause must be this outcome's
  const mapped = finished.text === "invalid_report" ? "invalid_report"
    : finished.text === "protocol_error" || finished.text === "contract_violation" ? "protocol_error" : "environment_error";
  if (mapped !== reason) return { kind: "reason", reason };
  const limit = reason === "environment_error" ? turn.find((e) => e.kind === "error" && USAGE_LIMIT.test(e.text)) : undefined;
  if (limit) return { kind: "provider_limit", reason, provider: limit.provider ?? finished.provider ?? "provider", resetsAt: /try again at (.+?)\.?\s*$/i.exec(limit.text)?.[1] ?? null };
  const step = finished.detail?.endStep;
  return typeof step === "string" && step !== "ok" ? { kind: "ending", reason, step } : { kind: "reason", reason };
}

// The turn a pause at `end` (exclusive index into entries) belongs to: the last one that finished before it, unless the
// run went on since (a status other than paused/pausing) or paused for another reason in between.
export function pausedTurn(entries: readonly OrchestrationActivityEntry[], end: number, reason: string): string | null {
  let at = end - 1;
  while (at >= 0 && entries[at].kind !== "turn_finished") at--;
  if (at < 0) return null;
  const later = entries.slice(at + 1, end).filter((x) => x.kind === "status");
  if (later.some((x) => x.detail?.status !== "paused" && x.detail?.status !== "pausing")) return null;
  if (later.some((x) => x.detail?.status === "paused" && x.detail?.reason !== reason)) return null;
  return entries[at].turnId;
}

// The cause of the run's current state (null: no reason). Only a pause is explained by a turn.
export function viewCause(view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): PauseCause | null {
  if (!view.reason) return null;
  if (view.status !== "paused") return { kind: "reason", reason: view.reason };
  // a failed preparation pauses the run before anything else (cycle.ts): the pause is that preparation's
  const prep = view.progress?.prepare;
  if (prep?.status === "failed" && (view.reason === "needs_user_action" || view.reason === "external_failure")) return { kind: "prepare", reason: view.reason, command: prep.command };
  return pauseCause(view.reason, pausedTurn(entries, entries.length, view.reason), entries);
}

const PROVIDER_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude" };
export const providerName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider;

// The reason in words, the same everywhere: the run panel, the activity rows, the agent cards, the feed and the history.
export function causeText(locale: LocaleId, cause: PauseCause): string {
  if (cause.kind === "provider_limit") return t(locale, "orchReason_provider_limit").replace("{provider}", providerName(cause.provider));
  if (cause.kind === "prepare") return t(locale, "orchReason_prepare_failed").replace("{command}", cause.command ?? "?");
  const ending = cause.kind === "ending" ? t(locale, `orchEnding_${cause.step}` as TranslationKey) : undefined;
  return ending ?? t(locale, `orchReason_${cause.reason}` as TranslationKey) ?? cause.reason;
}

// The headline key (orchHeadline_<key>): a provider's limit is not "the environment needs preparing".
export function headlineKey(view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): string {
  return viewCause(view, entries)?.kind === "provider_limit" ? "provider_limit" : runHeadline(view).headline;
}

// The key of the next step to offer (orchNext_<key>): the headline's, unless the pause is an application failure.
export function nextStepKey(view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): string {
  const step = pauseEnding(view, entries);
  return step !== null && APP_FAILURE_STEPS.includes(step) ? "app_failure" : runHeadline(view).next;
}

export function providerLimit(view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): { provider: string; resetsAt: string | null } | null {
  const cause = viewCause(view, entries);
  return cause?.kind === "provider_limit" ? { provider: cause.provider, resetsAt: cause.resetsAt } : null;
}

// The next step as said to the person: a provider's limit is waited out (or the account changed), not fixed in the
// environment and not raised in the run's budget; everything else is orchNext_<nextStepKey>.
export function nextStepText(locale: LocaleId, view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): string {
  const limit = providerLimit(view, entries);
  if (limit) {
    return t(locale, limit.resetsAt ? "orchNext_provider_limit_at" : "orchNext_provider_limit")
      .replaceAll("{provider}", providerName(limit.provider)).replace("{at}", limit.resetsAt ?? "");
  }
  const cause = viewCause(view, entries);
  if (cause?.kind === "prepare") return t(locale, "orchNext_prepare_failed").replace("{command}", cause.command ?? "?");
  const key = nextStepKey(view, entries);
  return t(locale, `orchNext_${key}` as TranslationKey) ?? key;
}

// ---------- why a preparation failed ----------

// Lines an interactive login shell prints before the command's own output (steps run in `zsh -ilc`, stdout and stderr
// in one stream): never the reason. Extend the list as new ones are seen.
export const SHELL_NOISE: readonly RegExp[] = [
  /can't change option: monitor/, /no job control in this shell/i, /gitstatus failed to initialize/i, /GITSTATUS_LOG_LEVEL/,
  /^Add the following parameter to .*zshrc/i, /^Restart Zsh to retry gitstatus/i, /^exec zsh$/
];
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
export type PrepareReason = { kind: "missing"; what: string } | { kind: "exit"; code: number; line: string | null } | { kind: "line"; line: string };

// One line of why: what is still missing after the steps, else the exit code with the first meaningful line of the
// output (an error-like line first, the shell's own noise skipped).
export function prepareReason(output: string | null, exitCode: number | null): PrepareReason | null {
  const missing = output ? /^still missing after preparation: (.+)$/m.exec(output) : null;
  if (missing) return { kind: "missing", what: missing[1].trim() };
  const lines = (output ?? "").replace(ANSI, "").split("\n").map((l) => l.trim()).filter((l) => l && !SHELL_NOISE.some((r) => r.test(l)));
  const line = lines.find((l) => /\b(error|err!|fatal|failed|not found|denied|cannot|could not)\b/i.test(l)) ?? lines[0] ?? null;
  if (exitCode !== null) return { kind: "exit", code: exitCode, line };
  return line ? { kind: "line", line } : null;
}

export function prepareReasonText(locale: LocaleId, r: PrepareReason | null): string {
  if (!r) return "";
  if (r.kind === "missing") return t(locale, "orchPrepareWhy_missing").replace("{what}", r.what);
  if (r.kind === "line") return r.line;
  return `${t(locale, "orchExitCode")} ${r.code}${r.line ? `: ${r.line}` : ""}`;
}

// The last `n` lines of a step's output, the shell's noise left out.
export const lastLines = (text: string, n = 40): string => text.replace(ANSI, "").split("\n").filter((l) => !SHELL_NOISE.some((r) => r.test(l.trim()))).slice(-n).join("\n");

export function participantState(role: "lead" | "executor" | "reviewer", view: OrchestrationRunView | null, entries: readonly OrchestrationActivityEntry[],
  open = true): ParticipantState {
  const mine = entries.filter((e) => e.role === role);
  const lastEventAt = mine.at(-1)?.ts ?? null;
  const turnId = [...mine].reverse().find((e) => e.turnId)?.turnId ?? null;
  const turn = turnId ? mine.filter((e) => e.turnId === turnId) : [];
  const find = (k: string) => [...turn].reverse().find((e) => e.kind === k) ?? null;
  const finished = find("turn_finished");
  const goesOn = !!view && ["preparing", "running", "pausing", "stopping"].includes(view.status);
  const holdsTurn = view?.active?.kind === "turn" && activeRole(view) === role;
  const at = (phase: ParticipantPhase, since: string | null, outcome: string | null = null): ParticipantState =>
    ({ phase, since, lastEventAt, outcome, turnId });
  if (holdsTurn) {
    // Its turn now. The newest turn of the record is that turn unless it already finished (the new one's entries have
    // not arrived yet). "running" only once the CLI process reported its start.
    if (turn.length && !finished) {
      const exited = find("process_exited"), started = find("process_started");
      if (exited) return at("finishing", exited.ts);
      if (started) return at("running", started.ts);
      return at("starting", find("task_sent")?.ts ?? null);
    }
    return at("starting", null);
  }
  if (!turn.length) return at(goesOn ? "waiting" : "configured", null);
  // A turn that never finished and nobody holds: the application ended during it (or its result is still settling).
  if (!finished) return at("interrupted", lastEventAt, open ? "no_result" : "app_ended");
  if (finished.text !== "completed") return at("interrupted", finished.ts, finished.text);
  return at(goesOn ? "waiting" : "finished", finished.ts, "completed");
}

// New entries merged into what is shown: by id, never twice, in id order, the newest `cap` kept.
export function mergeActivity(current: readonly OrchestrationActivityEntry[], incoming: readonly OrchestrationActivityEntry[], cap = 3000): OrchestrationActivityEntry[] {
  if (!incoming.length) return current as OrchestrationActivityEntry[];
  const lastId = current.at(-1)?.id ?? 0;
  const fresh = incoming.filter((e) => e.id > lastId);
  let out: OrchestrationActivityEntry[];
  if (fresh.length === incoming.length && incoming.every((e, i) => i === 0 || e.id > incoming[i - 1].id)) out = [...current, ...fresh];
  else {
    const byId = new Map<number, OrchestrationActivityEntry>();
    for (const e of current) byId.set(e.id, e);
    for (const e of incoming) byId.set(e.id, e);
    out = [...byId.values()].sort((a, b) => a.id - b.id);
  }
  return out.length > cap ? out.slice(out.length - cap) : out;
}

// Whether a batch leaves a hole after what is shown (a lost event batch): then the stored page is read again.
export function activityGap(current: readonly OrchestrationActivityEntry[], incoming: readonly OrchestrationActivityEntry[]): boolean {
  const lastId = current.at(-1)?.id ?? null;
  const first = incoming[0]?.id ?? null;
  return lastId !== null && first !== null && first > lastId + 1;
}

// What the run has produced, as separate facts: never one "done" for all of them.
export interface ResultFacts {
  reportedDone: boolean | null; // the executor's own claim in its last report
  changes: "yes" | "no" | "unknown";
  checks: "passed" | "failed" | "none" | "running" | "not_verified";
  checkpoint: number | null; // the newest stage with a checkpoint ref
  goalAccepted: boolean; // final review "complete" and the run completed
  transferred: false; // the application never moves changes into the source project
}
export function resultFacts(view: OrchestrationRunView | null, d: RunDigest, changedFiles: number | null, reportedDone: boolean | null): ResultFacts {
  const last = new Map<string, RunDigest["checks"][number]>();
  for (const c of d.checks) last.set(c.checkId, c);
  const latest = [...last.values()];
  const checks: ResultFacts["checks"] = latest.length === 0 ? "none"
    : latest.some((c) => c.status === null) ? "running"
      : latest.some((c) => c.status === "failed") ? "failed"
        : latest.some((c) => c.status === "not_verified") ? "not_verified" : "passed";
  return {
    reportedDone,
    changes: changedFiles === null ? "unknown" : changedFiles > 0 ? "yes" : "no",
    checks,
    checkpoint: d.checkpoints.length ? Math.max(...d.checkpoints) : null,
    goalAccepted: view?.status === "completed" && d.finalVerdict === "complete",
    transferred: false
  };
}

// ---------- stage 13: the board on top of the panel ----------

// The top of the panel always answers: who works, on what, which stage, what is already checked, whether the person
// has to act. From the view (main's journal) only; an agent's own claim is never shown as checked.
export interface Board {
  who: "nobody" | "lead" | "executor" | "check" | "prepare" | "finish";
  finishStep: "commit" | "push" | "qa" | null;
  checked: { passed: number; total: number; failed: { title: string; class: string | null }[] };
  prepare: string | null; // the last preparation's status
  action: boolean; // the person has to do something now
  grantsApplied: number;
}
export function board(view: OrchestrationRunView): Board {
  const a = view.active;
  const who: Board["who"] = !a ? "nobody" : a.kind === "prepare" ? "prepare" : a.kind === "finish" ? "finish" : a.kind === "check" ? "check"
    : a.purpose === "execute" ? "executor" : "lead";
  const checks = view.progress?.checks ?? [];
  const head = runHeadline(view).headline;
  return {
    who, finishStep: a?.kind === "finish" ? a.step : null,
    checked: {
      passed: checks.filter((c) => c.status === "passed").length, total: checks.length,
      failed: checks.filter((c) => c.status === "failed").map((c) => ({ title: c.title, class: c.class }))
    },
    prepare: view.progress?.prepare?.status ?? null,
    action: !!view.permission || ["awaiting_answer", "awaiting_plan_review", "needs_setup", "needs_decision", "needs_action", "awaiting_checks", "awaiting_checks_none", "awaiting_finish_confirmation", "check_needs_permissions"].includes(head)
      || (view.status === "paused" && view.reason === "stage_done"),
    grantsApplied: view.progress?.grantsApplied ?? 0
  };
}

// ---------- stage 13: the environment probe ----------

// probe.ts values and notes are English patterns ("found 5, enabled 3: a, b", "2 could not be loaded", "the list is
// incomplete", "(none)", "(default)"); they are said in the person's language, anything else is shown as sent.
export function probeText(locale: LocaleId, text: string): string {
  return text
    .replace(/^found (\d+), enabled (\d+)/, (_, f, e) => `${t(locale, "orchProbe_found")} ${f}, ${t(locale, "orchProbe_enabled")} ${e}`)
    .replace(/^(\d+) could not be loaded$/, (_, n) => `${n} ${t(locale, "orchProbe_notLoaded")}`)
    .replace(/^the list is incomplete$/, t(locale, "orchProbe_incomplete"))
    .replace(/\(none\)/g, t(locale, "orchProbe_none"))
    .replace(/\(default\)/g, t(locale, "orchProbe_default"));
}
