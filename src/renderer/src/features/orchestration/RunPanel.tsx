// The one panel of a link's latest run (stage-8-contract.md §1, stage 11). A pinned summary on top — the state in plain
// words, who works on which stage, why it is paused, the next step, the question with its answer field and the commands
// this state allows — and below it tabs: overview, the live activity of one participant, changes, the technical log,
// the journal's history. Nothing is shown as done before main answers.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import type {
  OrchestrationActivityEntry,
  OrchestrationChanges,
  OrchestrationConditions,
  OrchestrationConditionStatus,
  OrchestrationDecisions,
  OrchestrationFindings,
  OrchestrationFormField,
  OrchestrationHistoryRecord,
  OrchestrationLimitKind,
  OrchestrationPermissionOption,
  OrchestrationPermissionRequest,
  OrchestrationPersonDecide,
  OrchestrationPlanChoice,
  OrchestrationPlanDecide,
  OrchestrationRunView,
  OrchestrationTake,
  OrchestrationTakeOutcome
} from "../../../../shared/orchestration";
import { UiIcon } from "../../components/UiIcon";
import { t, type TranslationKey } from "../../lib/i18n";
import {
  ACTIVE_STATUSES,
  activeRole,
  byReviewer,
  costOf,
  takeOutcomeText,
  takeSourceText,
  takenLines,
  limitRows,
  LIMIT_KINDS,
  tokensText,
  type Cost,
  type CostRole,
  actionEnabled,
  availableActions,
  proposalBlocks,
  TERMINAL_STATUSES,
  board,
  commandOf,
  digest,
  finishStatus,
  formatText,
  historyLines,
  outcomeOf,
  parsePlan,
  nextStepText,
  causeText,
  headlineKey,
  pauseCause,
  glossarySplit,
  changesFirst,
  idLabel,
  idNumber,
  factLines,
  conditionStatusKey,
  requirementStatusKey,
  pauseLabel,
  pauseText,
  PAUSES,
  primaryAction,
  pausedTurn,
  lastLines,
  prepareReason,
  prepareReasonText,
  viewCause,
  orchestrationAvailableHere,
  orchestrationEntry,
  participantState,
  roleModel,
  resultFacts,
  runHeadline,
  type HistoryLine,
  type LineText,
  type ParticipantState,
  type PendingCommand,
  type RunAction,
  type RunDigest
} from "./runModel";
import { duration, findingsLine, finishText, isServiceEntry, outcomeKey, personDecisionsLine, readJournal, reportParts, summaryModel, type ReportParts, type RunJournalState, type TextRef } from "./runStatus";
import type { PanelRole, PanelState, PanelTab } from "./useAgentCanvasUi";
import { outcomeText, type Orchestration, type RunActivityState } from "./useOrchestration";

// What stays different from the same CLI in a terminal (stage 12). Shown before the start and in the run panel.
export const DIFFERENCES = ["tui", "rcHooks", "codexExperimental", "claudeQuestions", "elicitation", "snapshots", "sequential"] as const;
export function Differences({ locale }: { locale: LocaleId }): React.JSX.Element {
  return (
    <details className="orch-diffs" data-orch-differences>
      <summary>{t(locale, "orchDiffTitle")}</summary>
      <ul>{DIFFERENCES.map((d) => <li key={d} data-difference={d}>{tr(locale, `orchDiff_${d}`)}</li>)}</ul>
    </details>
  );
}

const SILENCE_MS = 15_000;
const api = () => window.canvasTTY.orchestration;
const tr = (locale: LocaleId, key: string): string => t(locale, key as TranslationKey) ?? key;
// The result's words that name the lead as the one who accepts and concludes; a run the reviewer reviews has its own (A3)
const REVIEWER_WORDS = ["orchSumOutcome_completed", "orchSumOutcome_completed_no_checks", "orchSumStages_count", "orchSumStages_countPartial", "orchSumStage_done",
  "orchSumStage_not_done", "orchSumStage_not_checked", "orchSum_lead", "orchSumRemarksNone", "orchSumCurrentReview", "orchSumCurrentReviewPartial"];
const time = (locale: LocaleId, ts: string | null) => (ts ? new Date(ts).toLocaleTimeString(locale) : "—");
// A key the dictionary has (dynamic keys built from main's values may be missing).
const known = (locale: LocaleId, key: string): boolean => (t(locale, key as TranslationKey) as string | undefined) !== undefined;

// A clock for durations and silence: re-renders once a second while mounted.
function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(id); }, [ms]);
  return now;
}

// Why the run is paused: the step that ended the turn when main recorded it, else the reason's general words.
// A paused run's headline and why are its pause's words (runModel pauseText) wherever the panel says them: the header,
// the summary's outcome, its reason line.
function reasonText(locale: LocaleId, view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): string {
  const pause = pauseText(locale, view, entries);
  if (pause) return pause.why;
  const cause = viewCause(view, entries);
  return cause ? causeText(locale, cause) : "";
}

// A copy or a worktree: what became of its dependency folders (main's plan per folder, cloneDependencies), one phrase
// when all agree. A folder a preparation step installs is said by that step's last result, nothing until there is one.
// failed: a step failed, its output is in the activity of the checks.
function dependenciesText(locale: LocaleId, entries: readonly OrchestrationActivityEntry[]): { text: string; failed: boolean } | null {
  const d = entries.find((e) => e.kind === "prepare_finished" && e.detail?.dependencies === true)?.detail;
  if (!d) return null;
  // null: the step that installs it has no result yet (or was stopped)
  const all = Object.entries(d).flatMap(([dir, v]): [string, string | null][] => {
    if (dir === "dependencies" || dir.startsWith("step:") || typeof v !== "string") return [];
    if (v !== "install") return known(locale, `orchDeps_${v}`) ? [[dir, v]] : [];
    const step = d[`step:${dir}`];
    const last = entries.filter((e) => e.kind === "prepare_finished" && e.detail?.step === step && typeof e.detail.ok === "boolean").at(-1);
    return [[dir, !last || last.detail!.stopped === true ? null : last.detail!.ok ? "installed" : "failed"]];
  });
  // a folder the project does not need is named only when no folder is needed at all
  const needed = all.filter(([, r]) => r !== "not_needed");
  const dirs = (needed.length ? needed : all).filter((x): x is [string, string] => x[1] !== null);
  if (!dirs.length) return null;
  const word = (r: string) => tr(locale, `orchDeps_${r}`);
  return {
    text: dirs.every(([, r]) => r === dirs[0][1]) ? word(dirs[0][1]) : dirs.map(([dir, r]) => `${dir} — ${word(r)}`).join(" · "),
    failed: dirs.some(([, r]) => r === "failed")
  };
}

function headlineText(locale: LocaleId, view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): string {
  return pauseText(locale, view, entries)?.what ?? tr(locale, `orchHeadline_${headlineKey(view, entries)}`);
}

// A status line's reason: a pause by pauseCause with the turn it followed, anything else as main said it.
function statusReason(locale: LocaleId, status: unknown, reason: unknown, turnId: string | null, entries: readonly OrchestrationActivityEntry[]): string {
  if (typeof reason !== "string" || !reason) return "";
  return ` — ${causeText(locale, status === "paused" ? pauseCause(reason, turnId, entries) : { kind: "reason", reason })}`;
}

// A status in words: a pause by its one short form (runModel pauseLabel, as on the link chip and the cards); anything
// else as the status with main's reason.
function statusWords(locale: LocaleId, status: unknown, reason: unknown, turnId: string | null, entries: readonly OrchestrationActivityEntry[]): string {
  if (status === "paused" && typeof reason === "string" && PAUSES[reason]) return pauseLabel(locale, pauseCause(reason, turnId, entries));
  return `${tr(locale, `orchStatus_${status}`)}${statusReason(locale, status, reason, turnId, entries)}`;
}

// A text with the glossary's words explained on hover (runModel GLOSSARY).
export function Termed({ locale, text }: { locale: LocaleId; text: string }): React.JSX.Element {
  return <>{glossarySplit(locale, text).map((p) => typeof p === "string" ? p
    : <abbr key={p.at} className="orch-term" title={p.hint} data-term={p.term}>{p.text}</abbr>)}</>;
}

// A journal id (F1, C1, R1) as the person reads it, the id in the tooltip (runModel idLabel).
function IdLabel({ locale, id, plain }: { locale: LocaleId; id: string; plain?: boolean }): React.JSX.Element {
  return plain ? <span title={id} data-id={id}>{idLabel(locale, id)}</span> : <b title={id} data-id={id}>{idLabel(locale, id)}</b>;
}

function lineText(locale: LocaleId, line: HistoryLine, entries: readonly OrchestrationActivityEntry[]): string {
  const p = line.parts;
  const head = tr(locale, `orchLine_${line.kind}`);
  switch (line.kind) {
    case "status": return `${head}: ${statusWords(locale, p.status, p.reason, typeof p.turnId === "string" ? p.turnId : null, entries)}`;
    case "turn": return `${head}: ${tr(locale, `orchPurpose_${p.purpose}`)}${p.stage !== null ? ` · ${t(locale, "orchStage")} ${p.stage}` : ""}`;
    case "turn_failed": return `${head}: ${p.purpose ? `${tr(locale, `orchPurpose_${p.purpose}`)} — ` : ""}${p.outcome}`;
    case "report": return head;
    case "review": return `${head}: ${tr(locale, `orchVerdict_${p.verdict}`)}${p.stage !== null ? ` · ${t(locale, "orchStage")} ${p.stage}` : ""}`;
    case "stage_accepted": return `${head} ${p.stage}`;
    case "check": return `${head} ${p.checkId ?? ""}: ${tr(locale, `orchCheck_${p.status}`)}`
      + `${p.reason ? ` — ${tr(locale, `orchCheckReason_${p.reason}`)}` : ""}${p.exitCode !== null && p.status === "failed" ? ` (${t(locale, "orchExitCode")} ${p.exitCode})` : ""}`;
    case "limit": return `${head}: ${tr(locale, `orchLimit_${p.kind}`)} = ${p.value}`;
    case "plan": return `${head} (v${p.version})`;
    case "prepare_finished": return `${head}: ${tr(locale, `orchPrepare_${p.status}`)}${p.failed !== null ? ` · ${t(locale, "orchPrepareStepN")} ${p.failed}` : ""}`;
    default: return head;
  }
}

// A failed preparation on the board: the step that failed and one line of why, its output's last 40 lines on demand.
// Only what is recorded: the journal's output text, the exit code from the step's activity entry.
function PrepareFailure({ orch, runId, locale, prepare, entries }: { orch: Orchestration; runId: string; locale: LocaleId;
  prepare: NonNullable<OrchestrationRunView["progress"]>["prepare"] & object; entries: readonly OrchestrationActivityEntry[] }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const stored = useStored(orch, runId, prepare.output?.sha256);
  const step = prepare.failed === null ? null : Number(prepare.failed);
  const exit = entries.filter((e) => e.kind === "prepare_finished" && e.detail?.step === step && e.detail?.ok === false && typeof e.detail.exitCode === "number").at(-1)?.detail?.exitCode;
  const why = prepareReasonText(locale, prepareReason(stored.text, typeof exit === "number" ? exit : null));
  return (
    <span data-prepare-failure>
      {prepare.command && <> — {t(locale, "orchPrepareStep").replace("{command}", prepare.command)}</>}{why && <span data-prepare-why>: {why}</span>}
      {prepare.output && <> <button type="button" data-prepare-output-toggle onClick={() => setOpen((v) => !v)}>{t(locale, open ? "orchPrepareHideOutput" : "orchPrepareShowOutput")}</button></>}
      {open && <pre className="orch-panel__text" data-prepare-output>{stored.text !== null ? lastLines(stored.text) : t(locale, stored.status === "error" ? "orchError_generic" : "orchLoading")}</pre>}
    </span>
  );
}

// A stored text of the run through the one cache of useOrchestration (read once, shared with the cards and the widget).
function useStored(orch: Orchestration, runId: string | null, sha256: string | undefined): { status: "none" | "loading" | "error" | "ready"; text: string | null; retry(): void } {
  useEffect(() => { if (runId && sha256) orch.loadText(runId, sha256); }, [orch.loadText, runId, sha256]);
  const s = sha256 ? orch.texts[sha256] : undefined;
  return {
    status: !sha256 ? "none" : s?.status ?? "loading",
    text: s?.status === "ready" ? s.text : null,
    retry: () => { if (runId && sha256) orch.loadText(runId, sha256, true); }
  };
}
const useText = (orch: Orchestration, runId: string | null, sha256: string | undefined): string | null => useStored(orch, runId, sha256).text;
const NO_RECORDS: OrchestrationHistoryRecord[] = [];

// A journal text behind a history line, loaded on demand through text(runId, sha256). Loading, a failure to load
// and a text the journal did not keep are each said in words.
function LineDetails({ runId, text, dropped, locale }: { runId: string; text: LineText; dropped: number; locale: LocaleId }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "loaded"; text: string } | null>(null);
  const load = async (): Promise<void> => {
    if (!text.ref) return;
    setState({ kind: "loading" });
    const { outcome, value } = await outcomeOf(() => api().text(runId, text.ref!.sha256));
    if (outcome.kind === "accepted" && value) setState({ kind: "loaded", text: value.text });
    else setState({ kind: "error", message: outcomeText(locale, outcome) ?? t(locale, "orchError_generic") });
  };
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next && (state === null || state.kind === "error")) void load();
  };
  const shown = state?.kind === "loaded" ? formatText(text.kind, state.text) : null;
  return (
    <div className="orch-details">
      <button type="button" className="orch-details__toggle" aria-expanded={open} onClick={toggle}>
        {t(locale, (open ? "orchHide" : `orchShow_${text.kind}`) as TranslationKey)}
      </button>
      {open && (
        <div className="orch-details__body" data-details-state={!text.ref ? "missing" : state?.kind ?? "loading"}>
          {!text.ref ? (
            <p className="orch-details__missing">{t(locale, "orchTextMissing")}{text.missing ? ` (${t(locale, `orchTextWhy_${text.missing}` as TranslationKey) ?? text.missing})` : ""}</p>
          ) : state?.kind === "error" ? (
            <p className="orch-details__error" role="alert">{t(locale, "orchTextLoadFailed")}: {state.message}
              {" "}<button type="button" onClick={() => void load()}>{t(locale, "orchRepeat")}</button></p>
          ) : !shown ? (
            <p className="orch-hint">{t(locale, "orchLoading")}</p>
          ) : (
            <>
              {shown.items.length > 0 && <ul>{shown.items.map((item, i) => <li key={i}>{item}</li>)}</ul>}
              {shown.body && <pre>{shown.body}</pre>}
              {!shown.items.length && !shown.body && <p className="orch-hint">{t(locale, "orchNothingYet")}</p>}
            </>
          )}
          {text.kind === "output" && dropped > 0 && <p className="orch-hint">{t(locale, "orchOutputDropped")}: {dropped}</p>}
        </div>
      )}
    </div>
  );
}

// What a role works with: the model its CLI reported, else the chosen one (marked), else «As in the CLI».
const modelLabel = (locale: LocaleId, m: { model: string | null; reported: boolean }): string =>
  m.model === null ? t(locale, "orchModelCli") : m.reported ? m.model : `${m.model} (${t(locale, "orchModelChosen")})`;
const roleName = (locale: LocaleId, role: PanelRole) =>
  role === "lead" ? `Codex · ${t(locale, "orchRoleLead")}` : role === "executor" ? `Claude · ${t(locale, "orchRoleExecutor")}`
    : role === "reviewer" ? `Codex · ${t(locale, "orchRoleReviewer")}` : t(locale, "orchObserveChecks");

function phaseText(locale: LocaleId, p: ParticipantState, now: number): string {
  const since = p.since ? ` · ${duration(locale, now - Date.parse(p.since))}` : "";
  const why = p.phase === "interrupted" && p.outcome
    ? ` (${tr(locale, known(locale, `orchPhaseWhy_${p.outcome}`) ? `orchPhaseWhy_${p.outcome}` : `orchOutcome_${p.outcome}`)})` : "";
  return `${tr(locale, `orchPhase_${p.phase}`)}${why}${p.phase === "running" || p.phase === "starting" || p.phase === "finishing" ? since : ""}`;
}

// ---------- activity feed ----------

const LOG_KINDS = new Set(["stderr", "error", "process_started", "process_exited", "usage", "truncated", "session", "check_output", "turn_finished", "refusal"]);
export const FEED_KINDS = new Set(["task_sent", "process_started", "process_exited", "session", "thinking", "message", "tool_started", "tool_finished", "file_read",
  "file_changed", "subagent", "refusal", "error", "turn_finished", "check_started", "check_finished", "status", "truncated",
  "permission_requested", "permission_decided", "permission_applied", "prepare_started", "prepare_finished", "external_action", "report_note"]);

// «— CLI: <its reason> (<its type>)», as the CLI put it; nothing when it gave none
export function cliWhy(locale: LocaleId, d: Readonly<Record<string, unknown>>): string {
  const text = typeof d.reason === "string" && d.reason ? d.reason : null;
  const type = typeof d.reasonType === "string" && d.reasonType ? d.reasonType : null;
  if (!text && !type) return "";
  return ` — ${t(locale, "orchCliWhy")}: ${text ?? type}${text && type ? ` (${type})` : ""}`;
}

export function entryLabel(locale: LocaleId, e: OrchestrationActivityEntry, entries: readonly OrchestrationActivityEntry[]): string {
  const d = e.detail ?? {};
  switch (e.kind) {
    case "thinking": return tr(locale, "orchAct_thinking");
    case "turn_finished": return `${tr(locale, "orchAct_turn_finished")}: ${tr(locale, `orchOutcome_${e.text}`)}${d.reportedDone === true ? ` · ${tr(locale, "orchAct_reportedDone")}` : d.reportedDone === false ? ` · ${tr(locale, "orchAct_reportedNotDone")}` : ""}${d.question === true ? ` · ${tr(locale, "orchAct_asked")}` : ""}${typeof d.endStep === "string" && d.endStep !== "ok" && known(locale, `orchEnding_${d.endStep}`) ? ` — ${tr(locale, `orchEnding_${d.endStep}`)}` : ""}`;
    case "status": {
      const at = entries.findIndex((x) => x.id === e.id);
      const turn = typeof d.reason === "string" && at >= 0 ? pausedTurn(entries, at, d.reason) : null;
      return `${tr(locale, "orchAct_status")}: ${statusWords(locale, d.status, d.reason, turn, entries)}`;
    }
    case "task_sent": return `${tr(locale, "orchAct_task_sent")}: ${tr(locale, `orchPurpose_${d.purpose}`)}${d.stage !== null && d.stage !== undefined ? ` · ${t(locale, "orchStage")} ${d.stage}` : ""}`;
    case "process_exited": return `${tr(locale, "orchAct_process_exited")}${d.code !== null && d.code !== undefined ? ` (${t(locale, "orchExitCode")} ${d.code})` : d.signal ? ` (${d.signal})` : ""}`;
    case "tool_finished": return `${tr(locale, "orchAct_tool_finished")}: ${e.text}${typeof d.exitCode === "number" ? ` (${t(locale, "orchExitCode")} ${d.exitCode})` : ""}`;
    case "check_finished": return typeof d.status === "string"
      ? `${tr(locale, "orchAct_check_finished")}: ${String(d.checkId ?? "")}: ${tr(locale, `orchCheck_${d.status}`)}${typeof d.reason === "string" && d.reason ? ` — ${tr(locale, `orchCheckReason_${d.reason}`)}` : ""}`
      : `${tr(locale, "orchAct_check_finished")}: ${e.text}`;
    case "external_action": {
      // "<step>: <phase> — <command or evidence>": the step and phase in words, the command as it ran
      const rest = e.text.includes(" — ") ? e.text.slice(e.text.indexOf(" — ")) : "";
      const phase = String(d.phase ?? "");
      const phaseKey = known(locale, `orchFinishStatus_${phase}`) ? `orchFinishStatus_${phase}` : `orchFinishPhase_${phase}`;
      return typeof d.step === "string" ? `${tr(locale, "orchAct_external_action")}: ${tr(locale, `orchFinishStep_${d.step}`)}: ${known(locale, phaseKey) ? tr(locale, phaseKey) : phase}${rest}`
        : `${tr(locale, "orchAct_external_action")}: ${e.text}`;
    }
    case "prepare_finished": {
      // the preparation's outcome (with why it failed), or a step with nothing to install; a step's own result as it ran
      if (d.summary === true) {
        const why = d.status === "failed" ? prepareReasonText(locale, prepareReason(typeof d.output === "string" ? d.output : null, typeof d.exitCode === "number" ? d.exitCode : null)) : "";
        return `${tr(locale, "orchAct_prepare_summary")}: ${tr(locale, `orchPrepare_${d.status}`)}${typeof d.command === "string" ? ` — ${t(locale, "orchPrepareStep").replace("{command}", d.command)}` : ""}${why ? `: ${why}` : ""}`;
      }
      if (d.nothing === true) return `${tr(locale, "orchAct_prepare_finished")}: ${e.text.replace(/: nothing to install$/, "")}: ${t(locale, "orchPrepareNothing")}`;
      return `${tr(locale, "orchAct_prepare_finished")}: ${e.text}`;
    }
    case "report_note": // a mark the application left out: never counted
      return typeof d.ignoredMark === "string"
        ? t(locale, `orchAct_markIgnored_${d.by === "person" || d.by === "dropped" || d.by === "unchanged" || d.by === "unconfirmed" ? d.by : "check"}`).replace("{role}", t(locale, e.role === "lead" ? "orchRoleLead" : "orchRoleReviewer").toLowerCase())
          .replace("{id}", d.ignoredMark).replace("{paths}", String(d.paths ?? ""))
        : e.text;
    // B3 (§5.3 п. 4–5): why the CLI asked, as it said it; the host's own answer apart from the person's
    case "permission_requested": return `${tr(locale, "orchAct_permission_requested")}: ${e.text}${cliWhy(locale, d)}`;
    case "permission_applied": return d.scope === "sandbox_static"
      ? `${tr(locale, "orchAct_permission_host")}: ${e.text}${cliWhy(locale, d)}`
      : `${tr(locale, "orchAct_permission_applied")}: ${e.text}`;
    case "usage": return `${tr(locale, "orchAct_usage")}${typeof d.costUsd === "number" ? ` · $${d.costUsd.toFixed(4)}` : ""}${typeof d.outputTokens === "number" ? ` · ${d.inputTokens ?? "?"}/${d.outputTokens} tok` : ""}`;
    default: {
      // a CLI reported another rights mode than the one chosen: a warning about rights, not a failed turn
      if (e.kind === "error" && d.accessMismatch === true) {
        return `${tr(locale, "orchAct_accessMismatch")}: ${String(d.field ?? "")} — ${tr(locale, "orchAct_accessAsked")} ${String(d.asked ?? "")}, ${tr(locale, "orchAct_accessReported")} ${String(d.reported ?? "")}`;
      }
      if (e.kind === "message" && d.plan === true) return tr(locale, "orchAct_codexPlan"); // the plan's text is below the line
      const sub = typeof d.subagent === "string" ? ` (${t(locale, "orchActInSub")}: ${d.subagent})` : "";
      return (e.text ? `${tr(locale, `orchAct_${e.kind}`)}: ${e.text}` : tr(locale, `orchAct_${e.kind}`)) + sub;
    }
  }
}

// A structured answer a CLI wrote as its message (a report as JSON): shown as text and lists, never as raw JSON.
export function structured(e: OrchestrationActivityEntry): ReportParts | null {
  if (e.kind !== "message" || !/^\s*[[{]/.test(e.text)) return null;
  const p = reportParts(e.text);
  return p.text === null ? p : null;
}

export function ReportView({ locale, parts }: { locale: LocaleId; parts: ReportParts }): React.JSX.Element {
  return (
    <div className="orch-report" data-orch-report>
      {parts.text !== null && <p className="orch-panel__text">{parts.text}</p>}
      {parts.summary && <p className="orch-panel__text">{parts.summary}</p>}
      {parts.done !== null && <p><b>{t(locale, parts.done ? "orchSumDone_true" : "orchSumDone_false")}</b></p>}
      {parts.verdict && <p><b>{t(locale, "orchSumVerdict")}:</b> {tr(locale, `orchVerdict_${parts.verdict}`)}</p>}
      {parts.findings.length > 0 && <><b>{t(locale, "orchSumFindings")}:</b><ul>{parts.findings.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
      {parts.question && <p><b>{t(locale, "orchSumQuestion")}:</b> {parts.question}</p>}
      {parts.next && <p><b>{t(locale, "orchSum_next")}:</b> {parts.next}</p>}
      {parts.other.length > 0 && <dl className="orch-report__other">{parts.other.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
    </div>
  );
}

function ActivityList({ locale, entries, gaps, filter, emptyText, silence }: {
  locale: LocaleId; entries: readonly OrchestrationActivityEntry[]; gaps: RunActivityState["gaps"];
  filter: (e: OrchestrationActivityEntry) => boolean; emptyText: string; silence: string | null;
}): React.JSX.Element {
  // Service events (hooks) are folded by default; the full feed stays one click away.
  const [service, setService] = useState(false);
  const serviceCount = useMemo(() => entries.filter((e) => filter(e) && isServiceEntry(e)).length, [entries, filter]);
  const shown = useMemo(() => entries.filter((e) => filter(e) && (service || !isServiceEntry(e))), [entries, filter, service]);
  const [limit, setLimit] = useState(300);
  const list = shown.slice(Math.max(0, shown.length - limit));
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const seen = useRef(shown.length);
  const [unseen, setUnseen] = useState(0);
  // Follows new entries only while the reader is at the bottom; otherwise counts them for the "new events" button.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const added = shown.length - seen.current;
    seen.current = shown.length;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else if (added > 0) setUnseen((n) => n + added);
  }, [shown.length]);
  const onScroll = (): void => {
    const el = box.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom.current) setUnseen(0);
  };
  const gapAfter = new Map(gaps.map((g) => [g.afterId, g.reason]));
  return (
    <div className="orch-feed">
      {serviceCount > 0 && (
        <p className="orch-feed__service" data-orch-service={service ? "shown" : "folded"}>
          {t(locale, "orchFeedService").replace("{n}", String(serviceCount))}{" "}
          <button type="button" onClick={() => setService((v) => !v)}>{t(locale, service ? "orchFeedServiceHide" : "orchFeedServiceShow")}</button>
        </p>
      )}
      {shown.length > list.length && <button type="button" className="orch-feed__earlier" onClick={() => setLimit((l) => l + 300)}>{t(locale, "orchFeedEarlier")} ({shown.length - list.length})</button>}
      <div className="orch-feed__list" ref={box} onScroll={onScroll} data-orch-feed data-wheel-owner="local">
        {list.length === 0 && <p className="orch-hint">{emptyText}</p>}
        {list.map((e) => { const report = structured(e); return (
          <div key={e.id} className={`orch-feed__item orch-feed__item--${e.detail?.accessMismatch === true ? "warning" : e.kind}${isServiceEntry(e) ? " orch-feed__item--service" : ""}`} data-activity-kind={e.kind} data-activity-id={e.id}>
            <time>{time(locale, e.ts)}</time>
            <span className="orch-feed__text">{report ? `${tr(locale, "orchAct_message")}: ${t(locale, "orchFeedReport")}` : entryLabel(locale, e, entries)}</span>
            {report && <details open data-orch-structured><summary>{t(locale, "orchFeedReport")}</summary><ReportView locale={locale} parts={report} /></details>}
            {typeof e.detail?.output === "string" && e.detail.output && (
              <details><summary>{t(locale, "orchFeedOutput")}</summary><pre>{e.detail.output}</pre></details>
            )}
            {e.kind === "message" && e.detail?.plan === true && e.text && <details open><summary>{t(locale, "orchPlan")}</summary><pre>{e.text}</pre></details>}
            {gapAfter.has(e.id) && <div className="orch-feed__gap" role="note">{tr(locale, `orchGap_${gapAfter.get(e.id)}`)}</div>}
          </div>
        ); })}
        {silence && <div className="orch-feed__silence" role="status" data-orch-silence>{silence}</div>}
      </div>
      {unseen > 0 && (
        <button type="button" className="orch-feed__new" onClick={() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; atBottom.current = true; setUnseen(0); }}>
          {t(locale, "orchFeedNew")} ({unseen})
        </button>
      )}
    </div>
  );
}

// ---------- changes ----------

function ChangesTab({ locale, runId, seq, inPlace }: { locale: LocaleId; runId: string; seq: number; inPlace: boolean }): React.JSX.Element {
  const [changes, setChanges] = useState<OrchestrationChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const load = useCallback(async () => {
    const { outcome, value } = await outcomeOf(() => api().changes(runId));
    if (outcome.kind === "accepted" && value) { setChanges(value); setError(null); } else setError(outcomeText(locale, outcome));
  }, [locale, runId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: seq is the trigger: reload the changes when the run moves
  useEffect(() => { const id = window.setTimeout(() => void load(), 300); return () => window.clearTimeout(id); }, [load, seq]);
  const open = async (path: string): Promise<void> => {
    if (diff?.path === path) return setDiff(null);
    const { outcome, value } = await outcomeOf(() => api().diff(runId, path));
    if (outcome.kind === "accepted" && value) setDiff(value); else setError(outcomeText(locale, outcome));
  };
  if (error) return <p className="dialog-error" role="alert">{error} <button type="button" onClick={() => void load()}>{t(locale, "orchRepeat")}</button></p>;
  if (!changes) return <p className="orch-hint">{t(locale, "orchLoading")}</p>;
  const last = changes.checkpoints.at(-1);
  return (
    <div className="orch-changes" data-orch-changes>
      <p className="orch-hint">{tr(locale, `orchChangesAt_${changes.at}`)}{changes.atTs ? ` · ${time(locale, changes.atTs)}` : ""}</p>
      {changes.files.length === 0 ? <p>{t(locale, "orchChangesNone")}</p> : (
        <ul className="orch-changes__files">
          {changes.files.map((f) => (
            <li key={f.path}>
              <button type="button" className="orch-changes__file" aria-expanded={diff?.path === f.path} onClick={() => void open(f.path)}>
                <span className={`orch-changes__status orch-changes__status--${f.status}`}>{tr(locale, `orchFileStatus_${f.status}`)}</span> <code>{f.path}</code>
              </button>
              {diff?.path === f.path && <pre className="orch-changes__diff" data-orch-diff>{diff.text || (diff.truncated ? t(locale, "orchDiffTooLarge") : t(locale, "orchDiffEmpty"))}</pre>}
            </li>
          ))}
        </ul>
      )}
      {changes.truncated && <p className="orch-hint">{t(locale, "orchChangesTruncated")}</p>}
      {inPlace ? (
        <div className="orch-take">
          <h4>{t(locale, "orchTakeTitle")}</h4>
          <p>{t(locale, "orchTakeInPlace")}</p>
          {/* git diff <commit> sees tracked paths only: new untracked files are listed by git status */}
          <pre data-orch-take>{`git diff ${changes.baselineRef}\ngit status --short`}</pre>
        </div>
      ) : (
        <div className="orch-take">
          <h4>{t(locale, "orchTakeTitle")}</h4>
          <p>{last ? `${t(locale, "orchTakeCheckpoint")} ${last.stage}: ` : t(locale, "orchTakeNoCheckpoint")}</p>
          {last && <pre data-orch-take>{`git diff ${changes.baselineRef} ${last.ref}\ngit switch -c agents/${runId.slice(0, 8)} ${last.ref}`}</pre>}
          <p className="orch-hint">{t(locale, "orchNotTransferred")}</p>
        </div>
      )}
    </div>
  );
}

// ---------- a CLI's permission prompt, question, plan or MCP form (stages 12–13) ----------

type Decide = (decision: OrchestrationPermissionOption, extra?: { answers?: Record<string, string[]>; content?: Record<string, unknown>; feedback?: string }) => void;

// An MCP server's form: one input per field, the server's own default as the start value, nothing else filled in.
// The browser checks what it can (required, number bounds, lengths); main checks everything again before sending.
function FormFields({ locale, fields, values, onChange }: {
  locale: LocaleId; fields: OrchestrationFormField[]; values: Record<string, unknown>; onChange(name: string, value: unknown): void;
}): React.JSX.Element {
  return (
    <div className="orch-form-fields" data-orch-form-fields>
      {fields.map((f) => {
        const v = values[f.name];
        const label = <span>{f.title}{f.required ? <small> · {t(locale, "orchPermFormRequired")}</small> : null}</span>;
        const hint = f.description ? <small className="orch-hint">{f.description}</small> : null;
        if (f.type === "boolean") {
          return (
            <label key={f.name} className="orch-check" data-form-field={f.name}>
              <input type="checkbox" checked={v === true} onChange={(e) => onChange(f.name, e.target.checked)} />{label}{hint}
            </label>
          );
        }
        if (f.type === "enum") {
          return (
            <label key={f.name} className="orch-field" data-form-field={f.name}>{label}
              <select value={typeof v === "string" ? v : ""} required={f.required} onChange={(e) => onChange(f.name, e.target.value || undefined)}>
                <option value="">{t(locale, "orchPermFormNoAnswer")}</option>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>{hint}
            </label>
          );
        }
        if (f.type === "multi") {
          const list = Array.isArray(v) ? v as string[] : [];
          return (
            <fieldset key={f.name} className="orch-field" data-form-field={f.name}><legend>{label}</legend>
              {f.options.map((o) => (
                <label key={o.value} className="orch-check">
                  <input type="checkbox" checked={list.includes(o.value)}
                    onChange={(e) => onChange(f.name, e.target.checked ? [...list, o.value] : list.filter((x) => x !== o.value))} />
                  <span>{o.label}</span>
                </label>
              ))}{hint}
            </fieldset>
          );
        }
        const numeric = f.type === "number" || f.type === "integer";
        const type = numeric ? "number" : f.format === "email" ? "email" : f.format === "uri" ? "url" : f.format === "date" ? "date" : f.format === "date-time" ? "datetime-local" : "text";
        return (
          <label key={f.name} className="orch-field" data-form-field={f.name}>{label}
            <input type={type} value={v === undefined || v === null ? "" : String(v)} required={f.required}
              min={f.minimum ?? undefined} max={f.maximum ?? undefined} step={f.type === "integer" ? 1 : numeric ? "any" : undefined}
              minLength={f.minLength ?? undefined} maxLength={f.maxLength ?? undefined}
              onChange={(e) => onChange(f.name, e.target.value === "" ? undefined : e.target.value)} />{hint}
          </label>
        );
      })}
    </div>
  );
}

function PermissionBlock({ locale, request, more, sending, onDecide }: {
  locale: LocaleId; request: OrchestrationPermissionRequest; more: number; sending: boolean; onDecide: Decide;
}): React.JSX.Element {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const form = request.kind === "elicitation" ? request.form ?? null : null;
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(
    (form?.mode === "form" ? form.fields : []).filter((f) => f.default !== null).map((f) => [f.name, f.default])));
  const [feedback, setFeedback] = useState("");
  const question = request.kind === "question";
  const answers = () => Object.fromEntries(request.questions.map((q) => [q.id, [...(picked[q.id] ?? []), ...(own[q.id]?.trim() ? [own[q.id].trim()] : [])]]));
  const answered = !question || request.questions.every((q) => (picked[q.id]?.length ?? 0) > 0 || !!own[q.id]?.trim());
  const title = question ? "orchPermQuestion" : request.kind === "plan" ? "orchPermPlan" : request.kind === "elicitation" ? "orchPermForm" : "orchPermTitle";
  const head = <h4>{t(locale, title)} · {roleName(locale, request.role)}</h4>;
  const foot = <p className="orch-hint">{t(locale, "orchPermHint")}{more > 0 ? ` ${t(locale, "orchPermMore")} ${more}.` : ""}</p>;

  if (request.kind === "plan") {
    return (
      <div className="orch-permission orch-permission--plan" data-orch-permission="plan" data-request-id={request.requestId}>
        {head}
        <pre className="orch-permission__plan" data-orch-plan-text>{request.plan ?? request.summary}</pre>
        <textarea rows={2} value={feedback} placeholder={t(locale, "orchPermPlanFeedback")} onChange={(e) => setFeedback(e.target.value)} />
        <div className="orch-panel__actions">
          <button type="button" className="orch-primary" data-decision="allow_once" disabled={sending} onClick={() => onDecide("allow_once")}>{t(locale, "orchPermPlanApprove")}</button>
          <button type="button" data-decision="deny" disabled={sending || !feedback.trim()} onClick={() => onDecide("deny", { feedback: feedback.trim() })}>{t(locale, "orchPermPlanBack")}</button>
        </div>
        {foot}
      </div>
    );
  }
  if (request.kind === "elicitation") {
    return (
      <form className="orch-permission orch-permission--form" data-orch-permission="elicitation" data-request-id={request.requestId}
        onSubmit={(e) => { e.preventDefault(); onDecide("allow_once", form?.mode === "form" ? { content: values } : {}); }}>
        {head}
        <p>{request.server ? <><b>{t(locale, "orchPermServer")}:</b> <code>{request.server}</code> · </> : null}{request.summary}</p>
        {form?.mode === "form" && <FormFields locale={locale} fields={form.fields} values={values} onChange={(name, value) => setValues((cur) => ({ ...cur, [name]: value }))} />}
        {form?.mode === "url" && <><p>{t(locale, "orchPermFormUrl")}</p><pre data-orch-form-url>{form.url}</pre></>}
        {form?.mode === "unsupported" && <p className="dialog-error">{t(locale, "orchPermFormUnsupported")} {form.reason}</p>}
        <div className="orch-panel__actions">
          {form?.mode !== "unsupported" && (
            <button type="submit" className="orch-primary" data-decision="allow_once" disabled={sending}>
              {t(locale, form?.mode === "url" ? "orchPermFormUrlDone" : "orchPermFormSend")}
            </button>
          )}
          <button type="button" className="orch-danger" data-decision="deny" disabled={sending} onClick={() => onDecide("deny")}>{t(locale, "orchPermFormDecline")}</button>
        </div>
        {foot}
      </form>
    );
  }
  return (
    <div className="orch-permission" data-orch-permission={request.kind} data-request-id={request.requestId}>
      {head}
      <p><b>{request.tool}</b>{request.summary ? <>: <code>{request.summary}</code></> : null}</p>
      {request.detail && <details><summary>{t(locale, "orchPermDetail")}</summary><pre>{request.detail}</pre></details>}
      {request.questions.map((q) => (
        <fieldset key={q.id} className="orch-permission__q">
          <legend>{q.question}</legend>
          {q.options.map((o) => (
            <label key={o} className="orch-check">
              <input type={q.multiple ? "checkbox" : "radio"} name={`q-${request.requestId}-${q.id}`} checked={(picked[q.id] ?? []).includes(o)}
                onChange={(e) => setPicked((cur) => ({ ...cur, [q.id]: q.multiple ? (e.target.checked ? [...(cur[q.id] ?? []), o] : (cur[q.id] ?? []).filter((x) => x !== o)) : [o] }))} />
              <span>{o}</span>
            </label>
          ))}
          {q.other && <input type={q.secret ? "password" : "text"} autoComplete={q.secret ? "off" : undefined} placeholder={t(locale, "orchPermOther")} value={own[q.id] ?? ""} onChange={(e) => setOwn((cur) => ({ ...cur, [q.id]: e.target.value }))} />}
        </fieldset>
      ))}
      <div className="orch-panel__actions">
        {request.options.map((o) => (
          <button key={o} type="button" data-decision={o} className={o === "deny" ? "orch-danger" : o === "allow_once" ? "orch-primary" : undefined}
            disabled={sending || (o !== "deny" && !answered)}
            onClick={() => onDecide(o, question && o !== "deny" ? { answers: answers() } : undefined)}>
            {tr(locale, question ? (o === "deny" ? "orchPermDecline" : "orchPermAnswer") : `orchPerm_${o}`)}
          </button>
        ))}
      </div>
      {request.options.includes("allow_run") && <p className="orch-hint">{t(locale, "orchPermScopeHint")}</p>}
      {request.options.includes("allow_readonly_run") && <p className="orch-hint" data-orch-readonly-hint>{t(locale, "orchPermReadOnlyHint")}</p>}
      {request.alwaysAsk && <p className="orch-hint" data-orch-always-ask>{t(locale, "orchPermAlwaysAsk")}</p>}
      {foot}
    </div>
  );
}

// ---------- stage 13: what the CLIs reported they loaded in this run ----------

const ENV_FIELDS = ["model", "permissionMode", "approvalPolicy", "sandbox", "mcp", "skills", "plugins", "agents", "instructionSources", "toolCount", "slashCommands", "outputStyle"] as const;
function SessionEnvironment({ locale, entries }: { locale: LocaleId; entries: readonly OrchestrationActivityEntry[] }): React.JSX.Element {
  const last = (["codex", "claude"] as const).map((p) => ({ p, e: [...entries].reverse().find((x) => x.kind === "session" && x.provider === p && x.detail?.reported === true) ?? null }));
  return (
    <section className="orch-panel__section" data-orch-env-session>
      <h4>{t(locale, "orchEnvSession")}</h4>
      {last.every((x) => !x.e) ? <p className="orch-hint">{t(locale, "orchEnvSessionNone")}</p> : (
        <dl className="orch-env">
          {last.filter((x) => x.e).map(({ p, e }) => (
            <div key={p} data-env-provider={p}>
              <dt>{p === "codex" ? "Codex" : "Claude"} <small className="orch-hint">{t(locale, "orchEnvConfirmed")}</small></dt>
              <dd>{ENV_FIELDS.filter((k) => e!.detail?.[k] !== undefined && e!.detail?.[k] !== null && e!.detail?.[k] !== "").map((k) => (
                <span key={k} className="orch-env__item" data-env-item={k} title={k}><b>{t(locale, `orchEnvKey_${k}`)}</b>: {String(e!.detail![k])}</span>
              ))}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="orch-hint">{t(locale, "orchEnvParityNote")}</p>
    </section>
  );
}

// ---------- the run summary (stage 13 UX): what the run was for and what it ended with ----------

// Where a statement comes from: the application's own journal, or an agent's words.
function Src({ locale, kind }: { locale: LocaleId; kind: "journal" | "agent" }): React.JSX.Element {
  return <small className={`orch-src orch-src--${kind}`} data-src={kind}><Termed locale={locale} text={t(locale, kind === "journal" ? "orchSumConfirmed" : "orchSumClaim")} /></small>;
}
// Nothing recorded — or, while the journal is only partly read, nothing recorded in the part read so far.
function NotSpecified({ locale, incomplete }: { locale: LocaleId; incomplete: boolean }): React.JSX.Element {
  return incomplete
    ? <p className="orch-hint" data-sum-not-loaded>{t(locale, "orchSumNotLoaded")}</p>
    : <p className="orch-hint" data-sum-missing>{t(locale, "orchSumNotSpecified")}</p>;
}
// A stored text: loading, a failure with a retry, or its content; a text the journal never kept is "not specified".
function Stored({ orch, runId, textRef, locale, incomplete, children }: {
  orch: Orchestration; runId: string; textRef: TextRef | null; locale: LocaleId; incomplete: boolean; children(text: string): React.ReactNode;
}): React.JSX.Element {
  const s = useStored(orch, runId, textRef?.sha256);
  if (s.status === "none") return <NotSpecified locale={locale} incomplete={incomplete} />;
  if (s.status === "error") {
    return <p className="dialog-error" role="alert" data-sum-failed>{t(locale, "orchSumLoadFailed")} <button type="button" onClick={s.retry}>{t(locale, "orchRepeat")}</button></p>;
  }
  if (s.text === null) return <p className="orch-hint">{t(locale, "orchLoading")}</p>;
  return <>{children(s.text)}</>;
}
function Section({ id, title, src, locale, children }: { id: string; title: string; src?: "journal" | "agent"; locale: LocaleId; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="orch-panel__section orch-sum" data-sum={id}>
      <h4>{title}{src && <Src locale={locale} kind={src} />}</h4>
      {children}
    </section>
  );
}

// Journal v2, A2 (journal-v2-format.md §2.7): each requirement with the conditions that prove it, the status of each and
// its proof — the check run (its output) or the lead's review (paths, note). The same facts the completion decides on.
function Conditions({ orch, runId, c, locale, incomplete, completion }: {
  orch: Orchestration; runId: string; c: OrchestrationConditions; locale: LocaleId; incomplete: boolean; completion?: string | null;
}): React.JSX.Element {
  const noChecks = completion === "no_checks";
  const status = (s: OrchestrationConditionStatus, key: TranslationKey = `orchCond_${s}` as TranslationKey) => <b className={`orch-cond orch-cond--${s}`}>{t(locale, key)}</b>;
  const item = (x: OrchestrationConditions["conditions"][number]) => (
    <li key={x.id} data-condition={x.id} data-condition-status={x.status}>
      <IdLabel locale={locale} id={x.id} /> {x.text} · <span className="orch-hint">{x.evidence.kind === "check"
        ? fill(t(locale, "orchCondEvidence_check"), { cmd: x.evidence.command ?? x.evidence.check }) : t(locale, `orchCondEvidence_${x.evidence.kind}`)}</span> — {status(x.status, conditionStatusKey(x.status, noChecks, x.evidence.kind === "check"))}
      {x.stale && <p className="orch-hint orch-hint--warn" data-condition-stale>{t(locale, "orchCondStale")}</p>}
      {x.proof && "decision" in x.proof && <p className="orch-hint" data-condition-proof="person">{fill(t(locale, "orchCondProofPerson"), { decision: t(locale, `orchCond_${x.proof.decision}`) })}</p>}
      {x.proof && "checkRunId" in x.proof && (
        <details data-condition-proof="run">
          <summary>{fill(t(locale, "orchCondProofRun"), { run: x.proof.checkRunId.slice(0, 8) })}</summary>
          {x.proof.output
            ? <Stored orch={orch} runId={runId} textRef={x.proof.output} locale={locale} incomplete={incomplete}>{(text) => <pre className="orch-panel__text">{text.slice(-4000)}</pre>}</Stored>
            : <p className="orch-hint">{t(locale, "orchCondNoOutput")}</p>}
        </details>
      )}
      {x.proof && "reviewTurnId" in x.proof && (
        <p className="orch-hint" data-condition-proof="review">{fill(t(locale, "orchCondProofReview"), { paths: x.proof.paths.join(", ") || "—" })}{x.proof.note ? ` — ${x.proof.note}` : ""}</p>
      )}
    </li>
  );
  const loose = c.conditions.filter((x) => x.covers.length === 0);
  return (
    // no "confirmed by the journal" mark: a "change" condition's evidence is the lead's word (each line says which)
    <Section id="conditions" title={t(locale, "orchSum_conditions")} locale={locale}>
      <p data-sum-conditions-count><b>{fill(t(locale, "orchConditionsCount"), { met: c.met, total: c.total })}</b></p>
      <p className="orch-hint">{t(locale, "orchCondCoversHint")}</p>
      <ul className="orch-sum__requirements">{c.requirements.map((r) => (
        <li key={r.id} data-requirement={r.id} data-requirement-status={r.status}>
          <IdLabel locale={locale} id={r.id} /> {r.text} — {status(r.status, requirementStatusKey(r.status, noChecks))}
          {r.why && <span className="orch-hint"> · {fill(t(locale, "orchCondWhy"), { why: r.why })}</span>}
          <ul>{r.conditions.map((id) => item(c.conditions.find((x) => x.id === id)!))}</ul>
        </li>
      ))}</ul>
      {loose.length > 0 && <><b>{t(locale, "orchCondLoose")}</b><ul>{loose.map(item)}</ul></>}
      {(c.dropped ?? []).length > 0 && <><b>{t(locale, "orchCondDropped")}</b><ul data-conditions-dropped>{c.dropped.map((x) => (
        <li key={x.id} data-condition={x.id} data-condition-status="dropped"><IdLabel locale={locale} id={x.id} /> {x.text} — {status("dropped")} · <span className="orch-hint">{fill(t(locale, "orchCondWhy"), { why: x.why })}</span></li>
      ))}</ul></>}
    </Section>
  );
}

// Journal v2, A3 (journal-v2-format.md §2.8): the reviewer's findings — number, severity, status, the stage that owns an
// open one, and what each review did with it on which tree. "Open blocking: N" is findingsLine, as the cards say it.
// A4: the person's decisions are said as such (closed by the person, made a wish — never as fixed); onDecide: the pause
// lets the person close an open finding or make a blocking one a wish.
function Findings({ f, locale, onDecide }: { f: OrchestrationFindings; locale: LocaleId; onDecide?: (id: string, decision: "close" | "to_wish") => void }): React.JSX.Element {
  const item = (x: OrchestrationFindings["items"][number]) => (
    <li key={x.id} data-finding={x.id} data-finding-severity={x.severity} data-finding-status={x.status} data-finding-downgraded={x.downgraded ? "yes" : undefined}>
      <IdLabel locale={locale} id={x.id} /> · {t(locale, `orchFinding_${x.severity}`)} · <b className={`orch-cond orch-cond--${x.status === "closed" ? "met" : "not_met"}`}>{t(locale, `orchFinding_${x.status}`)}</b>
      {x.downgraded && <> · <b className="orch-cond orch-cond--not_met" data-finding-person="to_wish">{t(locale, "orchFindingDowngraded")}</b></>}
      {x.status === "open" && <> · {x.stage !== null ? fill(t(locale, "orchFindingStage"), { n: x.stage }) : t(locale, "orchFindingNextPlan")}</>}
      {x.condition && <> · <IdLabel locale={locale} id={x.condition} plain /></>}
      {x.possibleRepeatOf && <> · <span className="orch-hint" data-finding-repeat={x.possibleRepeatOf}>{fill(t(locale, "orchFindingRepeat"), { n: idNumber(x.possibleRepeatOf) })}</span></>}
      <p className="orch-panel__text">{x.problem}</p>
      {x.paths.length > 0 && <p className="orch-hint">{x.paths.join(", ")}</p>}
      <p className="orch-hint">{fill(t(locale, "orchFindingCloseWhen"), { text: x.closeWhen })}</p>
      <details data-finding-history>
        <summary>{t(locale, "orchFindingHistory")}</summary>
        <ol>{x.history.map((h, i) => (
          <li key={`${h.kind}:${h.reviewTurnId ?? h.by}:${h.index ?? i}`} data-finding-event={h.kind} data-finding-by={h.by} data-finding-review={h.reviewTurnId ?? undefined} data-finding-tree={h.tree}>
            {fill(t(locale, `orchFindingHist_${h.kind}`), { turn: (h.reviewTurnId ?? "").slice(0, 8), note: h.note ?? "" })}
            {h.by === "person" && <> · <b data-finding-person-event>{t(locale, "orchFindingByPerson")}</b></>}
            {" · "}<code>{fill(t(locale, "orchFindingTree"), { tree: h.tree.slice(0, 12) })} · {fill(t(locale, "orchFindingState"), { key: h.runKey.slice(0, 12) })}</code>
            {h.reason && <> — {t(locale, `orchFindingRefused_${h.reason}` as TranslationKey)}</>}
          </li>
        ))}</ol>
      </details>
      {onDecide && x.status === "open" && (
        <div className="orch-panel__actions" data-finding-actions>
          {/* the safe choice is no button: the finding stays open for the executor; both of these remove it unfixed */}
          <small className="orch-hint" data-finding-safe>{t(locale, "orchFindingSafeHint")}</small>
          <button type="button" data-finding-close={x.id} onClick={() => onDecide(x.id, "close")}>{t(locale, "orchFindingClose")}</button>
          {x.severity === "blocking" && <button type="button" data-finding-to-wish={x.id} onClick={() => onDecide(x.id, "to_wish")}>{t(locale, "orchFindingToWish")}</button>}
        </div>
      )}
    </li>
  );
  const blocking = f.items.filter((x) => x.severity === "blocking");
  const wishes = f.items.filter((x) => x.severity === "wish");
  return (
    // a finding is the reviewer's word; what the application did with it is the journal's (history)
    <Section id="findings" title={t(locale, "orchSum_findings")} locale={locale}>
      <p data-sum-findings-open={f.openBlocking}><b>{findingsLine(locale, { progress: { findings: f } as OrchestrationRunView["progress"] })}</b></p>
      {f.items.length === 0 && <p>{t(locale, "orchFindingsNone")}</p>}
      {blocking.length > 0 && <ul className="orch-sum__findings" data-findings="blocking">{blocking.map(item)}</ul>}
      {f.disputed.length > 0 && <><b>{t(locale, "orchFindingsDisputed")}</b><ul data-findings="disputed">{f.disputed.map((d) => (
        <li key={`${d.reviewTurnId}:${d.index}`}>{d.problem} · <span className="orch-hint" title={d.candidates.join(", ")}>{d.candidates.map((c) => idLabel(locale, c)).join(", ")}</span></li>
      ))}</ul></>}
      {wishes.length > 0 && <><b>{t(locale, "orchFindingsWishes")}</b><ul className="orch-sum__findings" data-findings="wish">{wishes.map(item)}</ul></>}
    </Section>
  );
}

type GoalJson = { text?: unknown; criteria?: unknown; commands?: unknown };
function parseGoal(text: string): GoalJson | null {
  try { const v = JSON.parse(text) as unknown; return v && typeof v === "object" ? v as GoalJson : null; } catch { return null; }
}
const fill = (s: string, vars: Record<string, string | number>): string => Object.entries(vars).reduce((a, [k, v]) => a.replaceAll(`{${k}}`, String(v)), s);

function RunSummary({ orch, runId, view, records, locale, changedFiles, gaps, incomplete, onFinding }: {
  orch: Orchestration; runId: string; view: OrchestrationRunView; records: readonly OrchestrationHistoryRecord[];
  locale: LocaleId; changedFiles: number | null; gaps: number; incomplete: boolean; onFinding?: (id: string, decision: "close" | "to_wish") => void;
}): React.JSX.Element {
  // Every plan's titles (a replan names the stages from its firstStage on), read through the shared text cache.
  const planShas = useMemo(() => records.filter((r) => r.type === "plan.recorded")
    .map((r) => (r.data.plan as TextRef | undefined)?.sha256).filter((x): x is string => typeof x === "string"), [records]);
  useEffect(() => { for (const sha of planShas) orch.loadText(runId, sha); }, [orch.loadText, planShas, runId]);
  const planKey = planShas.map((sha) => `${sha}:${orch.texts[sha]?.status ?? ""}`).join(",");
  const goalText = useText(orch, runId, (records.find((r) => r.type === "run.created")?.data.goal as TextRef | undefined)?.sha256);
  const commands = useMemo(() => { const g = goalText ? parseGoal(goalText) : null; return Array.isArray(g?.commands) ? g.commands.filter((c): c is string => typeof c === "string") : null; }, [goalText]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: planKey stands for orch.texts (the plan titles read)
  const m = useMemo(() => summaryModel(view, records, {
    planTitles: (sha) => { const s = orch.texts[sha]; return s?.status === "ready" ? parsePlan(s.text).map((p) => p.title) : null; },
    goalCommands: commands, complete: !incomplete
  }), [view, records, planKey, commands, incomplete]);
  const finalText = useText(orch, runId, m.finalReport?.sha256);
  const lastText = useText(orch, runId, m.lastReport?.sha256);
  const next = (finalText ? reportParts(finalText).next : null) ?? (lastText ? reportParts(lastText).next : null);
  const outcome = outcomeKey(view, m.finalVerdict, m.complete);
  // Read only in part: what was read stands, but nothing is concluded from what was not read yet.
  // A3: a run the reviewer reviews says so — the application accepts its stages, the reviewer concludes
  const said = (key: string) => tr(locale, byReviewer(view) && REVIEWER_WORDS.includes(key) ? `${key}_rv` : key);
  const stageStateText = (st: { state: string }) => said(!m.complete && st.state !== "done" ? "orchSumStage_unloaded" : `orchSumStage_${st.state}`);
  const progress = view.progress ?? null;
  const verdictText = (v: string | null) => (v ? tr(locale, `orchVerdict_${v}`) : "—");
  const missing = <NotSpecified locale={locale} incomplete={incomplete} />;
  const stageLabel = (n: number | null, title: string | null, plan?: number | null) =>
    `${n === null ? t(locale, "orchSumReviewFinal") : `${t(locale, "orchStage")} ${n}${title ? `: ${title}` : ""}`}${plan ? ` · ${fill(t(locale, "orchSumPlanVersion"), { v: plan })}` : ""}`;
  const findingsList = (ref: TextRef | null, attr: string) => (
    <Stored orch={orch} runId={runId} textRef={ref} locale={locale} incomplete={incomplete}>{(text) => {
      const f = reportParts(text).findings;
      return f.length ? <ul {...{ [attr]: "" }}>{f.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p>{said("orchSumRemarksNone")}</p>;
    }}</Stored>
  );
  const problems = [
    ...(m.complete ? (m.stages ?? []).filter((s) => s.state !== "done").map((s) => `${stageLabel(s.n, s.title)} — ${stageStateText(s)}`) : []),
    ...m.checks.filter((c) => c.status !== "passed" && (m.complete || !!progress?.checks)).map((c) => `${c.title} — ${tr(locale, `orchCheck_${c.status}`)}`),
    ...(progress?.finish ?? []).filter((f) => f.asked && finishStatus(f) !== "done" && finishStatus(f) !== "qa_confirmed").map((f) => `${tr(locale, `orchFinishStep_${f.step}`)} — ${finishText(locale, f)}`),
    ...(gaps > 0 ? [t(locale, "orchSumGaps")] : [])
  ];
  const current = m.finalReport || m.finalVerdict ? null : m.currentReview;
  const history = m.reviews.filter((rv) => rv.state !== "current" && rv.state !== "final");
  return (
    <div className="orch-summary-view" data-orch-run-summary data-outcome={outcome} data-incomplete={incomplete ? "yes" : "no"}>
      <Section id="goal" title={t(locale, "orchSum_goal")} locale={locale}>
        <Stored orch={orch} runId={runId} textRef={m.goal} locale={locale} incomplete={incomplete}>{(text) => {
          const g = parseGoal(text);
          if (!g) return <p className="orch-panel__text">{text}</p>;
          const criteria = Array.isArray(g.criteria) ? g.criteria.filter((c): c is string => typeof c === "string") : [];
          return <>
            {typeof g.text === "string" ? <p className="orch-panel__text" data-sum-goal>{g.text}</p> : missing}
            {criteria.length > 0 && <><b>{t(locale, "orchSum_criteria")}:</b><ul>{criteria.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
          </>;
        }}</Stored>
      </Section>

      {/* without checks nothing confirmed the result: its outcome and checks carry no "confirmed by the journal" mark */}
      <Section id="outcome" title={t(locale, "orchSum_outcome")} src={outcome === "completed_no_checks" ? undefined : "journal"} locale={locale}>
        <p className={`orch-sum__outcome orch-sum__outcome--${outcome}`} data-sum-outcome={outcome}>
          <b>{headlineText(locale, view, orch.activity[runId]?.entries ?? [])}</b> — {said(`orchSumOutcome_${outcome}`)}
        </p>
        {outcome === "completed_no_checks" && <p className="dialog-error" data-sum-no-checks>{t(locale, "orchNoChecksRan")}</p>}
        {view.reason && <p><b>{t(locale, "orchSum_reason")}:</b> {reasonText(locale, view, orch.activity[runId]?.entries ?? [])}</p>}
        {outcome === "completed" && <p className="orch-hint" data-sum-scope>{t(locale, "orchSumScope")}</p>}
        {/* A4: what the person decided instead of evidence — the result never reads cleaner than it is */}
        {personDecisionsLine(locale, view) && <p className="dialog-error" data-sum-person>{personDecisionsLine(locale, view)}</p>}
        {m.endedAt && <p className="orch-hint">{t(locale, "orchSumEnded").replace("{time}", new Date(m.endedAt).toLocaleString(locale))}</p>}
      </Section>

      {progress?.conditions && <Conditions orch={orch} runId={runId} c={progress.conditions} locale={locale} incomplete={incomplete} completion={progress.completion} />}
      {progress?.findings && <Findings f={progress.findings} locale={locale} onDecide={onFinding} />}

      <Section id="stages" title={t(locale, "orchSum_stages")} src="journal" locale={locale}>
        {!m.stages ? missing : <>
          {m.stageCounts && <p data-sum-stage-count data-partial={m.complete ? undefined : "yes"}><b>{fill(said(m.complete ? "orchSumStages_count" : "orchSumStages_countPartial"), { done: m.stageCounts.done, total: m.stageCounts.total })}</b></p>}
          <ol className="orch-sum__stages">{m.stages.map((st) => (
            <li key={st.n} data-stage-state={st.state} data-stage-n={st.n} value={st.n}>
              <strong>{st.title ?? `${t(locale, "orchStage")} ${st.n}`}</strong>
              <span> — {stageStateText(st)}{st.rounds > 1 ? ` · ${fill(t(locale, "orchSumRounds"), { n: st.rounds })}` : ""}</span>
            </li>
          ))}</ol>
          {m.superseded.length > 0 && (
            <details className="orch-sum__superseded" data-sum-superseded>
              <summary>{t(locale, "orchSumSuperseded")} ({m.superseded.length})</summary>
              <ul>{m.superseded.map((st, i) => (
                <li key={i}>{stageLabel(st.n, st.title, st.plan)} — {st.verdict ? tr(locale, `orchVerdict_${st.verdict}`) : said(`orchSumStage_${st.state}`)}</li>
              ))}</ul>
            </details>
          )}
        </>}
      </Section>

      <Section id="executor" title={t(locale, "orchSum_executor")} src="agent" locale={locale}>
        {!m.stages?.some((s) => s.report) ? (m.lastReport
          ? <Stored orch={orch} runId={runId} textRef={m.lastReport} locale={locale} incomplete={incomplete}>{(text) => <ReportView locale={locale} parts={reportParts(text)} />}</Stored>
          : missing)
          : m.stages.filter((s) => s.report).map((st) => (
            <details key={st.n} className="orch-sum__report" open={m.stages!.length === 1}>
              <summary>{stageLabel(st.n, st.title)}</summary>
              <Stored orch={orch} runId={runId} textRef={st.report} locale={locale} incomplete={incomplete}>{(text) => <ReportView locale={locale} parts={reportParts(text)} />}</Stored>
            </details>
          ))}
      </Section>

      <Section id="lead" title={said("orchSum_lead")} src="agent" locale={locale}>
        {m.finalReport
          ? <Stored orch={orch} runId={runId} textRef={m.finalReport} locale={locale} incomplete={incomplete}>{(text) => <ReportView locale={locale} parts={{ ...reportParts(text), findings: [], next: null }} />}</Stored>
          : m.finalVerdict ? <p><b>{t(locale, "orchSumVerdict")}:</b> {tr(locale, `orchVerdict_${m.finalVerdict}`)}</p>
            : current ? (
              <div data-sum-current-review={current.verdict ?? ""}>
                <p><b>{fill(said(m.complete ? "orchSumCurrentReview" : "orchSumCurrentReviewPartial"), { stage: stageLabel(current.stage, current.title) })}</b></p>
                {current.report
                  ? <Stored orch={orch} runId={runId} textRef={current.report} locale={locale} incomplete={incomplete}>{(text) => <ReportView locale={locale} parts={{ ...reportParts(text), findings: [] }} />}</Stored>
                  : <p><b>{t(locale, "orchSumVerdict")}:</b> {verdictText(current.verdict)}</p>}
              </div>
            ) : missing}
      </Section>

      <Section id="checks" title={t(locale, "orchSum_checks")} src={outcome === "completed_no_checks" ? undefined : "journal"} locale={locale}>
        {m.checks.length === 0 ? (m.checksKnown ? <p>{t(locale, "orchSumChecks_noneConfigured")}</p> : missing) : <>
          <p data-sum-check-count data-checks-known={m.checksKnown ? "yes" : "no"}><b>{fill(t(locale, m.checksKnown && m.checks.every((c) => c.status === "not_run") ? "orchSumChecks_notRun" : m.checksKnown ? "orchSumChecks_count" : "orchSumChecks_seen"), { passed: m.checkCounts.passed, total: m.checkCounts.total })}</b></p>
          <ul className="orch-sum__checks">{m.checks.map((c) => (
            <li key={c.id} data-check-id={c.id} data-check-status={c.status} data-check-runs={c.runs}><code>{c.title}</code> — {tr(locale, `orchCheck_${c.status}`)} · {fill(t(locale, m.complete ? "orchSumChecks_runs" : "orchSumChecks_runsAtLeast"), { n: c.runs })}</li>
          ))}</ul>
          <p className="orch-hint" data-sum-tests>{t(locale, "orchSumTests")}</p>
        </>}
      </Section>

      <Section id="remarks" title={t(locale, "orchSum_remarks")} locale={locale}>
        <b>{t(locale, "orchSumFindingsCurrent")} <Src locale={locale} kind="agent" /></b>
        {m.finalFindings ? findingsList(m.finalFindings, "data-sum-findings")
          : m.finalVerdict ? <p>{said("orchSumRemarksNone")}</p>
            : current ? <>
              <p className="orch-hint">{stageLabel(current.stage, current.title)} · {verdictText(current.verdict)}{m.complete ? "" : ` — ${t(locale, "orchSumFindingsPartial")}`}</p>
              {current.findings ? findingsList(current.findings, "data-sum-findings") : <p>{said("orchSumRemarksNone")}</p>}
            </> : missing}
        {m.openQuestion && (
          <div data-sum-question>
            <b>{t(locale, "orchSumOpenQuestion")} <Src locale={locale} kind="agent" /></b>
            <Stored orch={orch} runId={runId} textRef={m.openQuestion} locale={locale} incomplete={incomplete}>{(text) => <p className="orch-panel__text">{text}</p>}</Stored>
          </div>
        )}
        {history.length > 0 && (
          <details className="orch-sum__history" data-sum-review-history>
            <summary>{fill(t(locale, "orchSumHistory"), { n: history.length })}</summary>
            <ul>{history.map((rv) => (
              <li key={rv.seq} data-review-state={rv.state}>
                {stageLabel(rv.stage, rv.title, rv.plan)} · {verdictText(rv.verdict)} — <i>{tr(locale, `orchSumReview_${rv.state}`)}</i>
                {rv.findings && findingsList(rv.findings, "data-sum-old-findings")}
              </li>
            ))}</ul>
          </details>
        )}
        {problems.length > 0 && <><b>{t(locale, "orchSumLimits")} <Src locale={locale} kind="journal" /></b><ul data-sum-limits>{problems.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
      </Section>

      <Section id="where" title={t(locale, "orchSum_where")} src="journal" locale={locale}>
        {view.workMode ? (
          <p title={view.workDir}>
            {view.workMode === "worktree"
              ? <>{t(locale, "orchWhereWorktree")} <code><Termed locale={locale} text={progress?.branch ?? "?"} /></code> · <code>{view.workDir}</code></>
              : <>{t(locale, view.workMode === "project" ? "orchWhereProject" : "orchWhereCopy")} <code>{view.workDir}</code></>}
          </p>
        ) : missing}
        {m.checkpoint && <p>{fill(t(locale, "orchSumCheckpoint"), { stage: m.checkpoint.stage, commit: m.checkpoint.commit.slice(0, 12) })}</p>}
        {changedFiles !== null && <p>{fill(t(locale, "orchSumChangedFiles"), { n: changedFiles })}</p>}
      </Section>

      <Section id="finish" title={t(locale, "orchSum_finish")} src="journal" locale={locale}>
        {!m.finish ? missing : (
          <ul>{m.finish.map((f) => (
            <li key={f.step} data-finish-step={f.step} data-finish-status={f.asked ? finishStatus(f) : "not_asked"}>
              {tr(locale, `orchFinishStep_${f.step}`)}: <b>{finishText(locale, f)}</b>{f.commit ? <> · <code>{f.commit.slice(0, 12)}</code></> : null}
            </li>
          ))}</ul>
        )}
      </Section>

      <Section id="next" title={t(locale, "orchSum_next")} locale={locale}>
        {next ? <p className="orch-panel__text" data-sum-next>{next} <Src locale={locale} kind="agent" /></p> : missing}
        {view.newer
          ? <p className="orch-hint" data-orch-read-only-next>{t(locale, "orchReadOnlyHint")}</p>
          : <p className="orch-hint">{t(locale, "orchSumAppHint")}: {nextStepText(locale, view, orch.activity[runId]?.entries ?? [])}</p>}
      </Section>
    </div>
  );
}

// ---------- the panel ----------

// runId: the run shown (a link's latest, or one opened from a workspace's history). onNewGoal: only for a link's
// latest run whose link still exists.
type RunPanelProps = {
  orch: Orchestration; runId: string | null; locale: LocaleId; panel: PanelState;
  onClose(): void; onNewGoal: (() => void) | null; onView(next: { tab?: PanelTab; role?: PanelRole }): void;
  task?: { key: string; title: string } | null; // B2: the board task of the run — the summary starts with it
};

// «Забрать результат»: a new branch in the project (the safe one), or the patch applied to the working folder when it fits
// the files as they are now, or the «Changes» tab. Done by the application; the outcome in words, never git's alone.
function TakeResult({ locale, runId, take, onTake, onChanges }: {
  locale: LocaleId; runId: string; take: OrchestrationTake; onTake(next: OrchestrationTake): void; onChanges(): void;
}): React.JSX.Element {
  const [name, setName] = useState(take.suggested);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ kind: OrchestrationTakeOutcome["result"] | "error"; text: string } | null>(null);
  const act = async (input: { action: "branch"; name: string } | { action: "apply" }): Promise<void> => {
    setBusy(true);
    const r = await api().takeResult(runId, input).catch((e: unknown) => ({ ok: false as const, code: "transport", message: String(e) }));
    setBusy(false);
    if (!r.ok) { setSaid({ kind: "error", text: r.code === "transport" ? t(locale, "orchTransportError") : `${tr(locale, `orchError_${r.code}`)} ${r.message}` }); return; }
    setSaid({ kind: r.value.result, text: takeOutcomeText(locale, r.value, input.action === "branch" ? input.name : name) });
    if (r.value.result === "branch_exists") setName(r.value.take.suggested);
    onTake(r.value.take);
  };
  const worktree = take.mode === "worktree";
  return (
    <div className="orch-take" data-orch-take={take.from}>
      <h4>{t(locale, "orchTakeOpen")}</h4>
      <p className="orch-take__from" data-orch-take-from={take.from}>{takeSourceText(locale, take)}</p>
      {worktree && <p className="orch-hint" data-orch-take-run-branch={take.runBranch ?? ""}>{t(locale, "orchTakeWorktree").replace("{branch}", take.runBranch ?? "?")}</p>}
      <label className="orch-field orch-take__name">
        <span>{t(locale, worktree ? "orchTakeNameWorktree" : "orchTakeName")}</span>
        <input type="text" spellCheck={false} value={name} data-orch-take-name onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="orch-take__actions">
        <button type="button" className="orch-primary" data-orch-primary="take_branch" data-orch-take-branch disabled={busy || !take.allowed || !name.trim() || (!worktree && !!take.branch) || (worktree && take.branch?.name === name.trim())}
          onClick={() => void act({ action: "branch", name: name.trim() })}>{t(locale, worktree ? "orchTakeBranchWorktree" : "orchTakeBranch")}</button>
        <button type="button" data-orch-take-apply disabled={busy || !take.allowed || !!take.applied} onClick={() => void act({ action: "apply" })}>{t(locale, "orchTakeApply")}</button>
        <button type="button" data-orch-take-changes onClick={onChanges}>{t(locale, "orchTakeChanges")}</button>
      </div>
      <small className="orch-hint">{t(locale, "orchTakeHint")}</small>
      {busy && <p className="orch-hint">{t(locale, "orchSending")}</p>}
      {said && <p className={["unavailable", "error"].includes(said.kind) ? "dialog-error" : ["conflict", "branch_exists", "invalid_name"].includes(said.kind) ? "orch-hint orch-hint--warn" : "orch-take__done"}
        role={said.kind === "conflict" ? "alert" : "status"} data-orch-take-outcome={said.kind}>{said.text}</p>}
    </div>
  );
}

export function RunPanel(props: RunPanelProps): React.JSX.Element {
  const newer = props.runId ? props.orch.runs[props.runId]?.view.newer : undefined;
  // a newer journal that declared minReaderVersion this build reads: the whole panel, read-only
  return newer && !newer.compatible
    ? <NewerRunPanel orch={props.orch} runId={props.runId!} locale={props.locale} onClose={props.onClose} newer={newer} />
    : <CurrentRunPanel {...props} />;
}

// "Release link" for a link held by a newer version's run (acceptance-review-spec.md §2.2.1):
// asked to confirm first, then one command whose commandId is kept, so a repeat after a lost answer is the same release.
export function ReleaseNewerLink({ orch, linkId, runId, locale }: { orch: Orchestration; linkId: string; runId: string; locale: LocaleId }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandId = useRef<string | null>(null);
  const release = async (): Promise<void> => {
    commandId.current ??= crypto.randomUUID();
    setSending(true);
    setError(null);
    const r = await orch.releaseNewerLink({ commandId: commandId.current, linkId, runId });
    setSending(false);
    const text = outcomeText(locale, r.outcome);
    if (text) setError(text);
    else setConfirming(false);
  };
  return (
    <div className="orch-release" data-orch-release={linkId}>
      {!confirming
        ? <button type="button" data-orch-release-link onClick={() => setConfirming(true)}>{t(locale, "orchReleaseLink")}</button>
        : (
          <div className="orch-hint orch-hint--warn" role="alertdialog" aria-label={t(locale, "orchReleaseLink")} data-orch-release-confirm>
            <span>{t(locale, "orchReleaseConfirm")}</span>
            <span className="orch-form__actions">
              <button type="button" className="orch-danger" disabled={sending} data-orch-release-do onClick={() => void release()}>{t(locale, "orchReleaseDo")}</button>
              <button type="button" disabled={sending} onClick={() => { setConfirming(false); setError(null); }}>{t(locale, "orchCancel")}</button>
            </span>
          </div>
        )}
      {error && <p className="dialog-error" role="alert" data-orch-release-error>{error}</p>}
    </div>
  );
}
const linkOfRun = (orch: Orchestration, runId: string): string | null => orch.canvas.links.find((l) => l.runIds.includes(runId))?.linkId ?? null;

// A run a newer version of the application wrote (acceptance-review-spec.md §2.2): its goal and its records as they are
// (only the hash chain is checked, nothing is interpreted), and no action but closing.
function NewerRunPanel({ orch, runId, locale, onClose, newer }: {
  orch: Orchestration; runId: string; locale: LocaleId; onClose(): void; newer: NonNullable<OrchestrationRunView["newer"]>;
}): React.JSX.Element {
  const linkId = linkOfRun(orch, runId);
  const [journal, setJournal] = useState<RunJournalState>({ records: [], next: 0, status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger
  useEffect(() => {
    let live = true;
    let cur: RunJournalState = { records: [], next: 0, status: "loading" };
    void readJournal((from) => api().history(runId, from, 200), () => cur, (j) => { cur = j; if (live) setJournal(j); });
    return () => { live = false; };
  }, [runId, attempt]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside className="orch-panel orch-panel--wide" data-interactive="true" data-wheel-owner="local" data-canvas-wheel-priority="local"
      aria-label={t(locale, "orchRun")} data-orch-newer={newer.version}>
      <header className="orch-panel__header">
        <strong>{t(locale, "orchRun")}</strong>
        <code title={runId}>{runId.slice(0, 8)}</code>
        <button className="orch-panel__close" type="button" onClick={onClose} aria-label={t(locale, "orchClose")}><UiIcon name="close" size={16} /></button>
      </header>
      <section className="orch-summary" role="status" data-orch-summary data-headline="newer_version">
        <div className="orch-summary__headline"><strong>{t(locale, "orchNewerTitle")}</strong></div>
        <p>{t(locale, "orchNewerHint")}</p>
        <p data-orch-newer-goal><b>{t(locale, "orchGoalTask")}:</b> {newer.goal ?? t(locale, "orchNewerNoGoal")}</p>
        {newer.chain !== "ok" && <p className="dialog-error" data-orch-newer-chain={newer.chain}>{t(locale, "orchNewerChain")}</p>}
        {newer.fallback && (
          <p className="dialog-error" data-orch-newer-fallback={newer.fallback.code}>
            {t(locale, "orchNewerFallback").replace("{line}", String(newer.fallback.line)).replace("{code}", newer.fallback.code)}
          </p>
        )}
        {linkId && <ReleaseNewerLink orch={orch} linkId={linkId} runId={runId} locale={locale} />}
      </section>
      <div className="orch-panel__body">
        <section className="orch-panel__section">
          <h4>{t(locale, "orchHistory")}</h4>
          <ol className="orch-history" data-orch-newer-history>
            {journal.records.map((r) => (
              <li key={r.seq} data-history-seq={r.seq}><time>{new Date(r.ts).toLocaleTimeString(locale)}</time> <code>{r.type}</code></li>
            ))}
          </ol>
          {journal.status === "error" && (
            <p className="dialog-error" role="alert">{t(locale, "orchSumLoadFailed")} <button type="button" onClick={() => setAttempt((n) => n + 1)}>{t(locale, "orchRepeat")}</button></p>
          )}
        </section>
      </div>
    </aside>
  );
}

// UX audit 2026-10-05, Н9: what the run spends — model calls per role, the tokens each CLI reported (never money), the
// time worked, the turns of the limit and the time left to the deadline.
function CostRows({ locale, cost, reviewer }: { locale: LocaleId; cost: Cost; reviewer: boolean }): React.JSX.Element {
  const roles: CostRole[] = reviewer ? ["lead", "executor", "reviewer"] : ["lead", "executor"];
  const name = (r: CostRole) => t(locale, r === "lead" ? "orchRoleLead" : r === "executor" ? "orchRoleExecutor" : "orchRoleReviewer");
  const atLeast = cost.partial ? `${t(locale, "orchCostAtLeast")} ` : "";
  const tokens = (r: CostRole) => {
    const x = cost.tokens[r];
    if (!x) return t(locale, cost.calls[r] ? "orchCostTokensNone" : "orchCostTokensNoCalls");
    return `${atLeast}${tokensText(locale, x.input + x.output)} (${t(locale, "orchCostIn")} ${tokensText(locale, x.input)}, ${t(locale, "orchCostOut")} ${tokensText(locale, x.output)})`;
  };
  const calls = roles.reduce((n, r) => n + cost.calls[r], 0);
  const tok = roles.reduce((n, r) => n + (cost.tokens[r] ? cost.tokens[r]!.input + cost.tokens[r]!.output : 0), 0);
  const of = (used: string, limit: string) => t(locale, "orchCostOf").replace("{used}", used).replace("{limit}", limit);
  // one line in the pinned board (the plan to review must stay in view above it); the roles folded under it
  return (
    <div className="orch-cost">
      <dt>{t(locale, "orchCostTotal")}:</dt>
      <dd>
        <span data-board="cost-total">{t(locale, "orchCostTotalValue").replace("{calls}", String(calls)).replace("{tokens}", `${atLeast}${tokensText(locale, tok)}`)}</span>
        {" · "}{t(locale, "orchCostTurns")} <span data-board="turns-used">{of(String(cost.turns.used), String(cost.turns.limit))}</span>
        {cost.elapsedMs !== null && <>{" · "}{t(locale, "orchCostElapsed")} <span data-board="elapsed">{of(duration(locale, cost.elapsedMs), duration(locale, cost.runMs))}</span></>}
        {cost.leftMs !== null && <>{" · "}{t(locale, "orchCostLeft")} <span data-board="left">{duration(locale, cost.leftMs)}</span></>}
        <details className="orch-cost__roles" data-orch-cost-roles>
          <summary>{t(locale, "orchCostByRole")}</summary>
          <div><span>{t(locale, "orchCostCalls")}:</span> <span data-board="calls">{roles.map((r) => `${name(r)} ${cost.calls[r]}`).join(" · ")}</span></div>
          <div><span>{t(locale, "orchCostTokens")}:</span> <span data-board="tokens">{roles.map((r) => <span key={r} className="orch-cost__role" data-cost-role={r}>{name(r)}: {tokens(r)}</span>)}</span></div>
        </details>
      </dd>
    </div>
  );
}

// UX audit 2026-10-05, Н7: the limit pause — each limit's value and what is used of it (limitRows), the new value with
// its unit, and «Raise the limit and continue» as the main action. The limit the run stopped at is chosen first.
function RaiseLimit({ locale, cost, budget, primary, sending, onRaise, children }: {
  locale: LocaleId; cost: Cost | null; budget: NonNullable<NonNullable<OrchestrationRunView["progress"]>["budget"]> | null; primary: boolean; sending: boolean;
  onRaise(kind: OrchestrationLimitKind, value: number): void; children?: React.ReactNode;
}): React.JSX.Element {
  const rows = cost && budget ? limitRows(cost, budget) : [];
  const nowOf = (k: OrchestrationLimitKind) => rows.find((r) => r.kind === k)?.now ?? null;
  const proposed = (k: OrchestrationLimitKind) => { const c = nowOf(k); return c !== null ? String(Math.ceil(c * 1.5)) : ""; }; // half as much again
  const [kind, setKind] = useState<OrchestrationLimitKind>(cost?.reached ?? "turns");
  const [value, setValue] = useState(() => proposed(cost?.reached ?? "turns"));
  const current = nowOf(kind);
  const unit = t(locale, kind === "runMs" ? "orchLimitUnit_min" : kind === "turns" ? "orchLimitUnit_turns" : "orchLimitUnit_times");
  const n = Number(value);
  const valid = Number.isInteger(n) && n > 0 && (current === null || n > current);
  return (
    <div className="orch-limit" data-orch-limit>
      {rows.length > 0 && (
        <table className="orch-limit__table">
          <thead><tr><th>{t(locale, "orchLimitName")}</th><th>{t(locale, "orchLimitUsed")}</th><th>{t(locale, "orchLimitNow")}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.kind} data-limit-kind={r.kind} data-limit-reached={r.reached ? "" : undefined} className={r.reached ? "orch-limit__reached" : undefined}>
                <th scope="row">{t(locale, `orchLimit_${r.kind}` as TranslationKey)}{r.reached && <small> — {t(locale, "orchLimitReached")}</small>}</th>
                <td data-limit-used>{r.used ?? "—"}</td>
                <td data-limit-now>{r.now}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="orch-panel__row">
        <label className="orch-field orch-field--inline"><span>{t(locale, "orchLimitWhich")}</span>
          <select value={kind} onChange={(e) => { const k = e.target.value as OrchestrationLimitKind; setKind(k); setValue(proposed(k)); }}>
            {LIMIT_KINDS.map((k) => <option key={k} value={k}>{t(locale, `orchLimit_${k}` as TranslationKey)}</option>)}
          </select></label>
        <label className="orch-field orch-field--inline"><span>{t(locale, "orchLimitNew")}</span>
          <input type="number" min={1} value={value} data-orch-limit-value onChange={(e) => setValue(e.target.value)} /> <span data-orch-limit-unit>{unit}</span></label>
        <button type="button" className={primary ? "orch-primary" : undefined} data-orch-primary={primary ? "raise_limit" : undefined} data-orch-raise
          disabled={sending || !valid} onClick={() => onRaise(kind, kind === "runMs" ? n * 60_000 : n)}>{t(locale, "orchRaiseLimitContinue")}</button>
      </div>
      {!valid && value !== "" && current !== null && <small className="orch-hint orch-hint--warn" data-orch-limit-invalid>{t(locale, "orchLimitMore").replace("{now}", String(current))}</small>}
      {children}
    </div>
  );
}

function CurrentRunPanel({ orch, runId, locale, panel, onClose, onNewGoal, onView, task }: RunPanelProps): React.JSX.Element {
  const state = runId ? orch.runs[runId] ?? null : null;
  const view: OrchestrationRunView | null = state?.view ?? null;
  const activity = (runId && orch.activity[runId]) || { entries: [], gaps: [], firstId: 0, status: "loading" as const, resyncs: 0 };
  // The journal as useOrchestration reads it for every watched run: one read, shared with the cards and the widget.
  const journal = runId ? orch.journals[runId] : undefined;
  const records = journal?.records ?? NO_RECORDS;
  const d: RunDigest = useMemo(() => digest(records), [records]);
  const planText = useText(orch, runId, d.plan?.sha256);
  const questionText = useText(orch, runId, d.question?.text.sha256);
  const goalText = useText(orch, runId, d.goal?.sha256);
  const reportText = useText(orch, runId, d.lastExecuteReport?.sha256);
  const plan = useMemo(() => (planText ? parsePlan(planText) : []), [planText]);
  // A replan numbers its stages from firstStage on (the accepted ones before it keep their numbers).
  const planFirst = useMemo(() => {
    const f = [...records].reverse().find((r) => r.type === "plan.recorded")?.data.firstStage;
    return typeof f === "number" ? f : 1;
  }, [records]);
  const planTotal = plan.length ? planFirst - 1 + plan.length : 0;
  const goal = useMemo(() => { try { return goalText ? JSON.parse(goalText) as { limits?: Record<string, number>; createdAt?: number } : null; } catch { return null; } }, [goalText]);
  const reportedDone = useMemo(() => { try { const r = reportText ? JSON.parse(reportText) as { done?: unknown } : null; return typeof r?.done === "boolean" ? r.done : null; } catch { return null; } }, [reportText]);
  const lines = useMemo(() => historyLines(records).reverse(), [records]);
  const now = useNow();
  const [expanded, setExpanded] = useState(false);
  // The run ended while the person watched another tab: offer the summary, never switch or scroll by itself.
  const status = view?.status ?? null;
  const lastStatus = useRef(status);
  const [endedHere, setEndedHere] = useState(false);
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = status;
    if (was && status && !TERMINAL_STATUSES.includes(was) && TERMINAL_STATUSES.includes(status)) setEndedHere(true);
  }, [status]);
  useEffect(() => { if (panel.tab === "summary") setEndedHere(false); }, [panel.tab]);

  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [clarify, setClarify] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [changedFiles, setChangedFiles] = useState<number | null>(null);
  // «Забрать результат»: a separate copy or worktree, a run that is not working now
  const takeable = !!view && !view.newer && (view.workMode === "copy" || view.workMode === "worktree") && ["completed", "stopped", "paused"].includes(view.status);
  const [take, setTake] = useState<OrchestrationTake | null>(null);
  // the take panel of the run it was opened for; asked again on each revision (the run may have gone on)
  const [takeOpen, setTakeOpen] = useState<string | null>(null);
  const revision = view?.revision ?? 0;
  useEffect(() => {
    if (!takeable || !runId || revision < 0) { setTake(null); return; }
    let live = true;
    void api().take(runId).then((r) => { if (live) setTake(r.ok ? r.value : null); }, () => {});
    return () => { live = false; };
  }, [takeable, runId, revision]);
  const summary = useRef<HTMLElement>(null);
  const answerBox = useRef<HTMLTextAreaElement>(null);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Every "open" (also of the panel that is already open): the pinned summary gets focus and a short highlight, the
  // answer field first when a question waits. Nothing else is scrolled: the reader's place in a tab stays.
  // biome-ignore lint/correctness/useExhaustiveDependencies: panel.focus is the trigger: every open focuses the summary
  useEffect(() => {
    (answerBox.current ?? summary.current)?.focus({ preventScroll: true });
    summary.current?.scrollIntoView({ block: "nearest" });
    setFlash(true);
    const id = window.setTimeout(() => setFlash(false), 1200);
    return () => window.clearTimeout(id);
  }, [panel.focus]);
  // A waiting request (or the lead's question) is brought into the summary's view whenever the panel is opened or a new
  // one arrives: its top goes to the top of the summary when it would not fit below; its buttons stay pinned (CSS).
  const waitingId = state?.view.permission?.requestId ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: panel.focus and waitingId are triggers: bring a waiting request into view
  useEffect(() => {
    const box = summary.current;
    const block = box?.querySelector<HTMLElement>("[data-orch-permission], [data-orch-question]");
    if (!box || !block) return;
    const b = box.getBoundingClientRect(), r = block.getBoundingClientRect();
    if (r.bottom > b.bottom || r.top < b.top) box.scrollTop += r.top - b.top - 8;
    if (!answerBox.current) block.querySelector<HTMLElement>("input, select, textarea, button:not(:disabled)")?.focus({ preventScroll: true });
  }, [panel.focus, waitingId]);

  // The count of changed files for the result facts (the list itself is in the Changes tab).
  // biome-ignore lint/correctness/useExhaustiveDependencies: state.seq is the trigger: recount the changed files when the run moves
  useEffect(() => {
    if (!runId) return;
    let live = true;
    const id = window.setTimeout(() => {
      void api().changes(runId).then((r) => { if (live && r.ok) setChangedFiles(r.value.files.length); }).catch(() => {});
    }, 400);
    return () => { live = false; window.clearTimeout(id); };
  }, [runId, state?.seq]);

  const deliver = async (req: PendingCommand, after?: () => void): Promise<void> => {
    setSending(true);
    setNotice(null);
    const { outcome } = await outcomeOf(() => api().command(req));
    setSending(false);
    if (outcome.kind === "transport") return setNotice(t(locale, "orchTransportError"));
    if (outcome.kind === "in_progress") return setNotice(t(locale, "orchInProgress"));
    orch.commands.settle(req);
    if (outcome.kind === "rejected" && outcome.code === "stale_revision") {
      await orch.refreshRun(req.runId);
      return setNotice(t(locale, "orchStaleRefreshed"));
    }
    const text = outcomeText(locale, outcome);
    if (text) return setNotice(text);
    after?.();
  };
  const send = (action: RunAction, input: Parameters<typeof commandOf>[1] = {}, after?: () => void): Promise<void> =>
    view ? deliver(orch.commands.request(view.runId, view.revision, commandOf(action, input)), after) : Promise.resolve();
  const unknown = runId ? orch.commands.pending(runId) : [];
  // «Поднять лимит и продолжить» (UX audit Н7): main records the new limit and leaves the run paused; the run goes on with
  // a resume at the revision the raise made (two commands, as the person would send them)
  const continueAfterRaise = async (): Promise<void> => {
    if (!view) return;
    const r = await api().get(view.runId).catch(() => null);
    const v = r?.ok ? r.value.view : null;
    if (v && v.status === "paused" && v.reason === "user_request") await deliver(orch.commands.request(v.runId, v.revision, commandOf("resume", {})));
  };

  const actions = view ? availableActions(view) : [];
  const has = (a: RunAction) => actions.includes(a);
  // On a platform without orchestration: every action shown, only Stop active.
  const available = orchestrationAvailableHere();
  const off = (a: RunAction) => !actionEnabled(a, available) || proposalBlocks(view, a);
  const entry = orchestrationEntry(available);
  const busy = view !== null && ACTIVE_STATUSES.includes(view.status);
  const open = state?.open ?? true;
  const lead = participantState("lead", view, activity.entries, open);
  const executor = participantState("executor", view, activity.entries, open);
  const reviewer = participantState("reviewer", view, activity.entries, open);
  const facts = resultFacts(view, d, changedFiles, reportedDone);
  const head = view ? runHeadline(view) : null;
  const pause = view ? pauseText(locale, view, activity.entries) : null;
  const primary = view ? primaryAction(view) : null;
  const active = view?.active ?? null;
  const workingRole: PanelRole | null = !active ? null : activeRole(view) as PanelRole;
  const workingState = workingRole === "lead" ? lead : workingRole === "executor" ? executor : workingRole === "reviewer" ? reviewer : null;
  const stageText = view?.stage ? `${t(locale, "orchStage")} ${view.stage}${planTotal ? ` / ${planTotal}` : ""}` : null;
  const who = !active ? t(locale, "orchNobodyNow")
    : active.kind === "check" ? `${t(locale, "orchCheckRunning")} (${active.checkId})${stageText ? ` · ${stageText}` : ""}`
      : active.kind === "prepare" ? t(locale, "orchCanvasPrepare")
        : active.kind === "finish" ? `${t(locale, "orchCanvasFinish")}: ${tr(locale, `orchFinishStep_${active.step}`)}`
          : `${roleName(locale, workingRole!)} — ${tr(locale, `orchPurpose_${active.purpose}`)}${stageText ? ` · ${stageText}` : ""} · ${workingState ? phaseText(locale, workingState, now) : ""}`;
  const top = view ? board(view) : null;
  const cost = view ? costOf(view, activity.entries, now, activity.firstId) : null;
  const depsText = dependenciesText(locale, activity.entries);
  const accessMismatch = activity.entries.some((e) => e.kind === "error" && e.detail?.accessMismatch === true);
  const progress = view?.progress ?? null;
  const silenceFor = (p: ParticipantState): string | null => {
    if (p.phase !== "running") return null;
    const last = p.lastEventAt ? Date.parse(p.lastEventAt) : null;
    if (last !== null && now - last < SILENCE_MS) return null;
    return `${t(locale, "orchSilence")}${p.lastEventAt ? ` ${t(locale, "orchSilenceLast")} ${time(locale, p.lastEventAt)} (${duration(locale, now - Date.parse(p.lastEventAt))})` : ""}`;
  };

  // a newer version's run: its changes are not read here (main refuses them), so there is no tab for them
  const tabs: PanelTab[] = view?.newer ? ["summary", "overview", "activity", "log", "history"] : ["summary", "overview", "activity", "changes", "log", "history"];
  const roleFilter = useCallback((e: OrchestrationActivityEntry) => panel.role === "check"
    ? (e.role === "check" || e.role === "run") && FEED_KINDS.has(e.kind)
    : (e.role === panel.role && FEED_KINDS.has(e.kind)) || (e.role === "run" && e.kind === "status"), [panel.role]);
  const logFilter = useCallback((e: OrchestrationActivityEntry) => (panel.role === "check" ? e.role === "check" : e.role === panel.role)
    && (LOG_KINDS.has(e.kind) || (e.kind === "tool_finished" && typeof e.detail?.output === "string")), [panel.role]);
  const selected = panel.role === "lead" ? lead : panel.role === "executor" ? executor : panel.role === "reviewer" ? reviewer : null;

  return (
    <aside className={`orch-panel${panel.tab === "summary" ? " orch-panel--wide" : ""}${expanded ? " orch-panel--full" : ""}`}
      data-interactive="true" data-wheel-owner="local" data-canvas-wheel-priority="local" aria-label={t(locale, "orchRun")} data-orch-panel-tab={panel.tab}>
      <header className="orch-panel__header">
        <strong>{t(locale, "orchRun")}</strong>
        {runId && <code title={runId}>{runId.slice(0, 8)}</code>}
        <button className="orch-panel__expand" type="button" aria-pressed={expanded} data-orch-expand onClick={() => setExpanded((v) => !v)}
          title={t(locale, expanded ? "orchPanelCollapse" : "orchPanelExpand")} aria-label={t(locale, expanded ? "orchPanelCollapse" : "orchPanelExpand")}>
          <UiIcon name={expanded ? "restore" : "maximize"} size={14} />
        </button>
        <button className="orch-panel__close" type="button" onClick={onClose} aria-label={t(locale, "orchClose")}><UiIcon name="close" size={16} /></button>
      </header>
      {!view || !head ? (
        runId && orch.runErrors?.[runId]
          ? <p className="orch-panel__empty dialog-error" role="alert" data-run-load-error>{t(locale, "actRunError")}{" "}
            <button type="button" onClick={() => orch.retry()}>{t(locale, "actRetry")}</button></p>
          : <p className="orch-panel__empty">{runId ? t(locale, "orchLoading") : t(locale, "orchNoRun")}</p>
      ) : (
        <>
          <section ref={summary} tabIndex={-1} className={`orch-summary orch-summary--${head.headline} orch-panel__status orch-panel__status--${view.status}${flash ? " orch-summary--flash" : ""}${panel.tab !== "overview" ? " orch-summary--compact" : ""}`}
            role="status" aria-live="polite" data-orch-summary data-headline={head.headline}>
            {task && <div className="orch-summary__task" data-orch-task={task.key} title={task.title}>{tr(locale, "boardTask")} {task.key} · {task.title}</div>}
            <div className="orch-summary__headline">
              <strong data-orch-what><Termed locale={locale} text={pause ? pause.what : headlineText(locale, view, activity.entries)} /></strong>
              {view.reason && <span data-orch-reason><Termed locale={locale} text={pause ? pause.why : reasonText(locale, view, activity.entries)} /></span>}
            </div>
            {endedHere && panel.tab !== "summary" && (
              <div className="orch-ended" role="status" data-orch-ended>
                <span>{t(locale, "orchSummaryReady")}</span>
                <button type="button" className="orch-primary" onClick={() => onView({ tab: "summary" })}>{t(locale, "orchSummaryOpen")}</button>
              </div>
            )}
            {view.newer && (
              <div className="orch-hint orch-hint--warn" role="status" data-orch-read-only={view.newer.version}>
                <strong>{t(locale, "orchReadOnly")}</strong>
                <span>{t(locale, view.newer.preview ? "orchReadOnlyPreview" : "orchReadOnlyHint")}</span>
                {(view.newer.skipped ?? 0) > 0 && <span data-orch-newer-skipped={view.newer.skipped}>{t(locale, "orchNewerSkipped").replace("{n}", String(view.newer.skipped))}</span>}
                {runId && linkOfRun(orch, runId) && <ReleaseNewerLink orch={orch} linkId={linkOfRun(orch, runId)!} runId={runId} locale={locale} />}
              </div>
            )}
            {!view.newer && <p className="orch-summary__next" data-orch-next><b>{t(locale, "orchNextStep")}:</b> <Termed locale={locale} text={pause ? pause.todo : nextStepText(locale, view, activity.entries)} /></p>}
            {head.headline === "awaiting_plan_review" && plan.length > 0 && (
              <ol className="orch-summary__plan" data-orch-summary-plan start={planFirst}>{plan.map((p, i) => <li key={i}><strong>{p.title}</strong><span>{p.task}</span></li>)}</ol>
            )}
            {view.permission && !view.newer && (
              <PermissionBlock key={view.permission.requestId} locale={locale} request={view.permission} more={(view.pendingPermissions ?? 1) - 1} sending={sending || off("permission")}
                onDecide={(decision, extra) => void send("permission", { requestId: view.permission!.requestId, decision, ...extra })} />
            )}

            {has("answer") && d.question && (
              <div className="orch-question" data-orch-question data-orch-form>
                <h4>{t(locale, "orchQuestion")}</h4>
                <p className="orch-panel__text">{questionText ?? t(locale, "orchLoading")}</p>
                <textarea ref={answerBox} rows={3} value={answer} placeholder={t(locale, "orchAnswerPlaceholder")} onChange={(e) => setAnswer(e.target.value)} />
                <button type="button" className="orch-primary" disabled={sending || !answer.trim() || off("answer")}
                  onClick={() => void send("answer", { questionId: d.question!.questionId, text: answer.trim() }, () => setAnswer(""))}>{t(locale, "orchAnswer")}</button>
              </div>
            )}
            {has("checks_decide") && view.proposal && (
              <ChecksDecision key={view.revision} locale={locale} proposal={view.proposal} sending={sending || off("checks_decide")}
                onDecide={(checks) => void send("checks_decide", checks ? { checks } : {})} />
            )}
            {has("check_amend") && view.refused && (
              <CheckRefused key={view.revision} locale={locale} refused={view.refused} sending={sending || off("check_amend")}
                onAmend={(line) => void send("check_amend", { checkId: view.refused!.checkId, line })} />
            )}
            {has("finish_confirm") && view.confirm && (
              <FinishConfirm key={view.revision} locale={locale} confirm={view.confirm} sending={sending || off("finish_confirm")}
                onConfirm={(push, qa) => void send("finish_confirm", { tree: view.confirm!.tree ?? "", commit: view.confirm!.commit, push, qa })} />
            )}
            {has("person_decide") && view.decisions && (view.decisions.disputed.length > 0 || view.decisions.conditions.length > 0) && (
              <PersonDecide key={view.revision} locale={locale} d={view.decisions} sending={sending || off("person_decide")}
                onDecide={(person) => void send("person_decide", { person })} />
            )}
            {has("plan_decide") && view.decisions?.proposal && (
              <PlanProposal key={view.revision} locale={locale} d={view.decisions} sending={sending || off("plan_decide")}
                onDecide={(plan) => void send("plan_decide", { plan })} />
            )}
            {has("raise_limit") && (
              <RaiseLimit key={`${view.revision}:${cost?.reached ?? ""}`} locale={locale} cost={cost} budget={view.progress?.budget ?? null} primary={primary === "raise_limit"}
                sending={sending || off("raise_limit")} onRaise={(kind, value) => void send("raise_limit", { limit: kind, value }, () => void continueAfterRaise())}>
                {proposalBlocks(view, "raise_limit") && <small className="orch-hint" data-orch-proposal-waits>{t(locale, "orchProposalWaitsHint")}</small>}
              </RaiseLimit>
            )}
            {has("recover") && (
              <div className="orch-panel__actions">
                <button type="button" className="orch-primary" data-orch-primary="recover" disabled={sending || off("recover")} onClick={() => void send("recover", { recover: "accept" })}>{pause?.button ?? t(locale, "orchRecoverAccept")}</button>
                <button type="button" disabled={sending || off("recover")} onClick={() => void send("recover", { recover: "retry_turn" })}>{t(locale, "orchRecoverRetry")}</button>
                {/* the confirmation belongs to the reset only, which never runs in the project folder */}
                {view.workMode !== "project" && <>
                  <label className="orch-check"><input type="checkbox" checked={confirmReset} onChange={(e) => setConfirmReset(e.target.checked)} /><span>{t(locale, "orchRecoverConfirm")}</span></label>
                  <button type="button" className="orch-danger" disabled={sending || !confirmReset || off("recover")}
                    onClick={() => void send("recover", { recover: "reset_to_checkpoint", confirm: true })}>{t(locale, "orchRecoverReset")}</button>
                </>}
              </div>
            )}
            {actions.length > 0 && (
              // the header's one main button (runModel primaryAction): the pause's own action — a form's (a question,
              // commands, a decision) is that form's main button just above; Pause while the run works. Stop is
              // secondary and last, unless stopping is all the pause allows
              <div className="orch-panel__actions" data-orch-actions>
                {has("pause") && <button type="button" className={primary === "pause" ? "orch-primary" : undefined} data-orch-primary={primary === "pause" ? "pause" : undefined}
                  disabled={sending || off("pause")} onClick={() => void send("pause")}>{t(locale, "orchPause")}</button>}
                {has("keep_running") && <button type="button" className={primary === "keep_running" ? "orch-primary" : undefined} data-orch-primary={primary === "keep_running" ? "keep_running" : undefined}
                  disabled={sending || off("keep_running")} onClick={() => void send("keep_running")}>{t(locale, "orchKeepRunning")}</button>}
                {has("resume") && <button type="button" className="orch-primary" data-orch-primary="resume" title={t(locale, "orchResumeHint")} disabled={sending || off("resume")} data-orch-resume={head.next} onClick={() => void send("resume")}>
                  {pause?.button ?? t(locale, "orchResume")}
                </button>}
                {has("step") && <button type="button" className={primary === "step" ? "orch-primary" : undefined} data-orch-primary={primary === "step" ? "step" : undefined} title={t(locale, "orchStepHint")}
                  disabled={sending || off("step")} onClick={() => void send("step")}>{primary === "step" && pause ? pause.button : t(locale, "orchStep")}</button>}
                {has("stop") && <button type="button" className={primary === "stop" ? "orch-danger" : "orch-stop"} data-orch-primary={primary === "stop" ? "stop" : undefined}
                  disabled={sending} onClick={() => void send("stop")}>{primary === "stop" && pause ? pause.button : t(locale, "orchStop")}</button>}
              </div>
            )}
            <p className="orch-summary__who" data-orch-working>{who}</p>
            {top && progress && (
              <dl className="orch-board" data-orch-board data-action={top.action ? "yes" : "no"}>
                <div><dt>{t(locale, "orchRunMode")}:</dt><dd data-board="mode">{tr(locale, `orchRunMode_${progress.mode}`)}</dd></div>
                <div><dt>{t(locale, "orchBoardStage")}:</dt><dd data-board="stage">{stageText ?? "—"}</dd></div>
                {depsText && <div><dt>{t(locale, "orchBoardDeps")}:</dt><dd data-board="deps">{depsText.text}{depsText.failed && <> <button type="button" data-deps-step onClick={() => onView({ tab: "activity", role: "check" })}>{t(locale, "orchDepsStep")}</button></>}</dd></div>}
                {top.prepare && <div><dt>{t(locale, "orchBoardPrepare")}:</dt><dd data-board="prepare">{tr(locale, `orchPrepare_${top.prepare}`)}
                  {progress.prepare?.status === "failed" && runId && <PrepareFailure orch={orch} runId={runId} locale={locale} prepare={progress.prepare} entries={activity.entries} />}</dd></div>}
                <div><dt>{t(locale, "orchBoardChecked")}:</dt><dd data-board="checked">{top.checked.total && top.checked.ran === 0 ? fill(t(locale, "orchBoardCheckedNotRun"), { total: top.checked.total }) : top.checked.total ? t(locale, "orchBoardCheckedValue").replace("{passed}", String(top.checked.passed)).replace("{total}", String(top.checked.total)) : progress.completion === "no_checks" ? t(locale, "orchBoardNoChecks") : "—"}
                  {top.checked.failed.map((f, i) => <small key={i} className="orch-board__failed"> · {f.title}{f.class ? ` (${tr(locale, `orchClass_${f.class}`)})` : ""}</small>)}</dd></div>
                {progress.checksFrom && <div><dt>{t(locale, "orchBoardChecksFrom")}:</dt><dd data-board="checks-from">{tr(locale, progress.checksFrom === "proposal" && progress.checks.length === 0 ? "orchChecksFrom_proposal_none" : `orchChecksFrom_${progress.checksFrom}`)}</dd></div>}
                <div><dt>{t(locale, "orchBoardAction")}:</dt><dd data-board="action">{t(locale, top.action ? "orchBoardActionYes" : "orchBoardActionNone")}</dd></div>
                {progress.access && (
                  <div className={progress.access.claude === "full" || progress.access.codex === "full" ? "orch-board__full"
                    : progress.access.claude === "terminal" || progress.access.codex === "terminal" ? "orch-board__terminal" : undefined}>
                    <dt>{t(locale, "orchBoardAccess")}:</dt>
                    <dd data-board="access">Claude — {tr(locale, `orchAccess_${progress.access.claude}`)} · Codex — {tr(locale, `orchAccess_${progress.access.codex}`)}</dd>
                  </div>
                )}
                {progress.models && (
                  <div><dt>{t(locale, "orchBoardModels")}:</dt>
                    <dd data-board="models">{(byReviewer(view) ? ["lead", "executor", "reviewer"] as const : ["lead", "executor"] as const)
                      .map((role) => `${t(locale, role === "lead" ? "orchRoleLead" : role === "executor" ? "orchRoleExecutor" : "orchRoleReviewer")} — ${modelLabel(locale, roleModel(role, activity.entries, progress.models))}`).join(" · ")}</dd>
                  </div>
                )}
                {top.grantsApplied > 0 && <div><dt>{t(locale, "orchBoardGrants")}:</dt><dd data-board="grants">{top.grantsApplied}</dd></div>}
                {cost && <CostRows locale={locale} cost={cost} reviewer={byReviewer(view) || cost.calls.reviewer > 0} />}
              </dl>
            )}
            {accessMismatch && <p className="dialog-error" data-orch-access-mismatch>{t(locale, "orchAccessMismatchWarn")}</p>}
            {personDecisionsLine(locale, view) && <p className="orch-hint orch-hint--warn" data-orch-person>{personDecisionsLine(locale, view)}</p>}
            {view.workMode && (
              <p className={`orch-summary__where orch-summary__where--${view.workMode}`} data-orch-where={view.workMode} title={view.workDir}>
                {view.workMode === "worktree"
                  ? <>{t(locale, "orchWhereWorktree")} <code><Termed locale={locale} text={take?.runBranch ?? progress?.branch ?? "?"} /></code> · <code>{view.workDir}</code></>
                  : <>{t(locale, view.workMode === "project" ? "orchWhereProject" : "orchWhereCopy")} <code>{view.workDir}</code></>}
              </p>
            )}
            {takenLines(locale, take).map((line) => <p key={line} className="orch-take__taken" data-orch-taken>{line}</p>)}
            {take?.allowed && runId && (
              <>
                {takeOpen !== runId && <button type="button" className={view.status === "completed" ? "orch-primary" : undefined} data-orch-primary={view.status === "completed" ? "take" : undefined}
                  data-orch-take-open onClick={() => setTakeOpen(runId)}>{t(locale, "orchTakeOpen")}</button>}
                {takeOpen === runId && <TakeResult locale={locale} runId={runId} take={take} onTake={setTake} onChanges={() => onView({ tab: "changes" })} />}
              </>
            )}
            {changesFirst(view, activity.entries) && !take?.allowed && <button type="button" className="orch-primary" data-orch-view-changes onClick={() => onView({ tab: "changes" })}>{t(locale, "orchViewChanges")}</button>}
            {!busy && onNewGoal && !view.newer && <button type="button" className={changesFirst(view, activity.entries) || (take?.allowed && view.status === "completed") ? undefined : "orch-primary"} data-orch-new-goal disabled={entry.disabled} title={entry.hint ? t(locale, entry.hint) : undefined}
              onClick={onNewGoal}>{t(locale, "orchNewGoal")}</button>}
            {entry.hint && actions.some(off) && <div className="orch-hint" data-orch-platform-hint>{t(locale, entry.hint)}</div>}
            {sending && <div className="orch-hint">{t(locale, "orchSending")}</div>}
            {!sending && unknown.length > 0 && (
              <div className="orch-panel__unknown" role="status">
                <span>{t(locale, "orchUnknownResult")}</span>
                {unknown.map((p) => (
                  <button key={p.commandId} type="button" onClick={() => void deliver(p)}>
                    {t(locale, "orchRepeat")}: {tr(locale, `orchCommand_${p.command.kind}`)}
                  </button>
                ))}
              </div>
            )}
            {notice && <div className="dialog-error" role="alert">{notice}</div>}
          </section>

          <nav className="orch-tabs" role="tablist" aria-label={t(locale, "orchRun")}>
            {tabs.map((tab) => (
              <button key={tab} type="button" role="tab" aria-selected={panel.tab === tab} data-orch-tab={tab}
                className={panel.tab === tab ? "orch-tabs__on" : undefined} onClick={() => onView({ tab })}>{tr(locale, `orchTab_${tab}`)}</button>
            ))}
          </nav>
          {(panel.tab === "activity" || panel.tab === "log") && (
            <div className="orch-roles" role="radiogroup" aria-label={t(locale, "orchObserveWho")}>
              {(["lead", "executor", "check"] as const).map((role) => (
                <button key={role} type="button" role="radio" aria-checked={panel.role === role} data-orch-role={role}
                  className={panel.role === role ? "orch-roles__on" : undefined} onClick={() => onView({ role })}>{roleName(locale, role)}</button>
              ))}
            </div>
          )}

          <div className="orch-panel__body" data-orch-body={panel.tab}>
            {panel.tab === "summary" && runId && <>
              {/* A failed read keeps what was read, says it is incomplete and offers to read the rest (from where it stopped). */}
              {journal?.status === "error" && (
                <p className="dialog-error" role="alert" data-sum-journal-error>
                  {t(locale, "orchSumLoadFailed")}: {t(locale, records.length ? "orchSumIncomplete" : "orchSumJournal")}{" "}
                  <button type="button" onClick={() => void orch.syncJournal(runId)}>{t(locale, "orchRepeat")}</button>
                </p>
              )}
              {journal?.status === "loading" && records.length > 0 && <p className="orch-hint" data-sum-journal-loading>{t(locale, "orchSumIncomplete")}</p>}
              {!records.length
                ? journal?.status !== "error" && <p className="orch-hint">{t(locale, "orchLoading")}</p>
                : <RunSummary orch={orch} runId={runId} view={view} records={records} locale={locale} changedFiles={changedFiles} gaps={activity.gaps.length}
                  onFinding={has("person_decide") && view.decisions?.findings
                    ? (id, decision) => void send("person_decide", { person: { subject: "finding", target: id, decision, finding: null, runKey: view.decisions!.runKey } }) : undefined}
                  incomplete={journal?.status !== "ready"} />}
            </>}
            {panel.tab === "overview" && (
              <>
                <section className="orch-panel__section orch-facts" data-orch-facts>
                  <h4>{t(locale, "orchResult")}</h4>
                  <ul>
                    {factLines(locale, view, facts, journal?.status === "ready").map((f) => (
                      <li key={f.key} data-fact={f.key} data-orch-result={f.key === "accepted" ? d.finalVerdict ?? undefined : undefined}><Termed locale={locale} text={f.label} />: <b>{f.value}</b></li>
                    ))}
                    {view.workMode === "project"
                      ? <li data-fact="in_place">{t(locale, "orchFactInPlace")} — {t(locale, "orchFactInPlaceHint")}</li>
                      : view.workMode === "worktree"
                        ? <li data-fact="where">{t(locale, "orchResultWhere")}: <code><Termed locale={locale} text={progress?.branch ?? "?"} /></code> · <code>{view.workDir}</code></li>
                        : view.workMode === "copy" && !takenLines(locale, take).length && <li data-fact="transferred">{t(locale, "orchFactTransferred")}: <b>{t(locale, "orchNo")}</b> — {t(locale, "orchFactTransferredHint")}</li>}
                    {takenLines(locale, take).map((line) => <li key={line} data-fact="taken">{line}</li>)}
                    {progress?.checks.map((c) => (
                      <li key={c.id} data-fact="check" data-check-status={c.status}><code>{c.title}</code>: <b>{tr(locale, `orchCheck_${c.status}`)}</b>{c.class ? ` (${tr(locale, `orchClass_${c.class}`)})` : ""}</li>
                    ))}
                  </ul>
                  {progress && (
                    <>
                      <h4>{t(locale, "orchResultAfter")}</h4>
                      <ul data-orch-finish>
                        {progress.finish.map((f) => (
                          <li key={f.step} data-finish-step={f.step} data-finish-status={f.asked ? finishStatus(f) : "not_asked"}>
                            {tr(locale, `orchFinishStep_${f.step}`)}: <b>{f.asked ? tr(locale, `orchFinishStatus_${finishStatus(f)}`) : t(locale, "orchFinishNotAsked")}</b>
                            {f.step === "qa" && f.commit ? <> · {t(locale, "orchFinishExpected")} <code>{f.commit.slice(0, 12)}</code></> : f.commit ? <> · <code>{f.commit.slice(0, 12)}</code></> : null}
                            {f.asked && f.step === "qa" && f.observed && <span data-finish-observed={f.observed}> · {t(locale, "orchFinishObserved")} <code>{f.observed.slice(0, 12)}</code></span>}
                            {f.established ? ` · ${t(locale, "orchFinishEstablished")}` : ""}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
                <section className="orch-panel__section" data-orch-participants>
                  <h4>{t(locale, "orchParticipants")}</h4>
                  <ul className="orch-people">
                    {(byReviewer(view) ? ["lead", "executor", "reviewer"] as const : ["lead", "executor"] as const).map((role) => {
                      const info = orch.catalog.providers?.[role === "reviewer" ? "lead" : role];
                      const p = role === "lead" ? lead : role === "executor" ? executor : reviewer;
                      return (
                        <li key={role} data-participant={role} data-phase={p.phase}>
                          <strong title={t(locale, `orchTerm_${role}`)} data-term={role}>{roleName(locale, role)}</strong>
                          {info && <span className="orch-hint">{info.protocol} · {t(locale, "orchNativeInfo")}</span>}
                          {info && progress?.access && (
                            <span className="orch-access-badge" data-participant-access={progress.access[info.provider]}>
                              {t(locale, "orchBoardAccess")}: {tr(locale, `orchAccess_${progress.access[info.provider]}`)}
                            </span>
                          )}
                          {(() => {
                            const m = roleModel(role, activity.entries, progress?.models);
                            return <span className="orch-access-badge" data-participant-model={m.model ?? "cli"} data-model-reported={m.reported ? "yes" : "no"}>{t(locale, "orchModels")}: {modelLabel(locale, m)}</span>;
                          })()}
                          <span>{phaseText(locale, p, now)}{p.lastEventAt ? ` · ${t(locale, "orchLastEvent")} ${time(locale, p.lastEventAt)}` : ""}</span>
                          <button type="button" onClick={() => onView({ tab: "activity", role })}>{t(locale, "orchObserve")}</button>
                        </li>
                      );
                    })}
                  </ul>
                  {d.currentTask && (
                    <p className="orch-hint">{t(locale, "orchCurrentTask")}: {roleName(locale, d.currentTask.role as PanelRole)} — {tr(locale, `orchPurpose_${d.currentTask.purpose ?? "plan"}`)} · {time(locale, d.currentTask.ts)}</p>
                  )}
                </section>
                <SessionEnvironment locale={locale} entries={activity.entries} />
                <section className="orch-panel__section"><Differences locale={locale} /></section>
                <section className="orch-panel__section" data-orch-limits>
                  <h4>{t(locale, "orchTimeAndLimits")}</h4>
                  <dl className="orch-limits-view">
                    <dt>{t(locale, "orchElapsed")}</dt><dd>{d.createdAt ? duration(locale, (busy ? now : Date.parse(lines[0]?.ts ?? d.createdAt)) - Date.parse(d.createdAt)) : "—"}{goal?.limits?.runMs ? ` / ${duration(locale, goal.limits.runMs)}` : ""}</dd>
                    <dt>{t(locale, "orchTurns")}</dt><dd>{view.turns}{goal?.limits?.turns ? ` / ${goal.limits.turns}` : ""}</dd>
                    <dt>{t(locale, "orchStage")}</dt><dd>{view.stage === null ? "—" : `${view.stage}${planTotal ? ` / ${planTotal}` : ""}`}</dd>
                    {goal?.limits?.roundsPerStage && <><dt>{tr(locale, "orchLimit_roundsPerStage")}</dt><dd>{goal.limits.roundsPerStage}</dd></>}
                  </dl>
                </section>
                <section className="orch-panel__section">
                  <h4>{t(locale, "orchPlan")}</h4>
                  {plan.length === 0 ? <p className="orch-hint">{d.plan ? t(locale, "orchLoading") : t(locale, "orchNothingYet")}</p> : (
                    <ol className="orch-plan" start={planFirst}>{plan.map((s, i) => (
                      <li key={i} className={view.stage === planFirst + i ? "orch-plan__current" : undefined}><strong>{s.title}</strong><span>{s.task}</span></li>
                    ))}</ol>
                  )}
                </section>
                <section className="orch-panel__section">
                  <h4>{t(locale, "orchChecks")}</h4>
                  {d.checks.length === 0 ? <p className="orch-hint">{t(locale, "orchNothingYet")}</p> : (
                    <ul className="orch-checks">{d.checks.map((c) => (
                      <li key={c.checkRunId} className={`orch-checks__${c.status ?? "running"}`}>
                        <code>{c.checkId}</code> {c.status ? tr(locale, `orchCheck_${c.status}`) : t(locale, "orchCheckRunning")}
                        {c.reason ? ` — ${tr(locale, `orchCheckReason_${c.reason}`)}` : ""}
                      </li>
                    ))}</ul>
                  )}
                </section>
                {has("clarify") && (
                  <section className="orch-panel__section">
                    <h4>{t(locale, "orchClarify")}</h4>
                    <textarea rows={2} value={clarify} placeholder={t(locale, "orchClarifyPlaceholder")} onChange={(e) => setClarify(e.target.value)} />
                    <button type="button" disabled={sending || !clarify.trim() || off("clarify")}
                      onClick={() => void send("clarify", { text: clarify.trim() }, () => setClarify(""))}>{t(locale, "orchClarify")}</button>
                    {proposalBlocks(view, "clarify") && <small className="orch-hint" data-orch-proposal-waits>{t(locale, "orchProposalWaitsHint")}</small>}
                  </section>
                )}
              </>
            )}
            {panel.tab === "activity" && runId && (
              <ActivityList key={`a:${panel.role}`} locale={locale} entries={activity.entries} gaps={activity.gaps} filter={roleFilter}
                emptyText={activity.status === "loading" ? t(locale, "orchLoading") : t(locale, "orchFeedEmpty")}
                silence={selected ? silenceFor(selected) : null} />
            )}
            {panel.tab === "log" && runId && (
              <ActivityList key={`l:${panel.role}`} locale={locale} entries={activity.entries} gaps={activity.gaps} filter={logFilter}
                emptyText={t(locale, "orchLogEmpty")} silence={null} />
            )}
            {panel.tab === "changes" && runId && !view.newer && <ChangesTab locale={locale} runId={runId} seq={state?.seq ?? 0} inPlace={view.workMode === "project"} />}
            {panel.tab === "history" && (
              <section className="orch-panel__section">
                <ol className="orch-history">
                  {lines.map((l) => (
                    <li key={l.seq} data-history-kind={l.kind}>
                      <time>{new Date(l.ts).toLocaleTimeString(locale)}</time> {lineText(locale, l, activity.entries)}
                      {l.text && runId && <LineDetails runId={runId} text={l.text} dropped={Number(l.parts.outputDropped ?? 0)} locale={locale} />}
                    </li>
                  ))}
                </ol>
                {journal?.status === "error" && (
                  <p className="dialog-error" role="alert">{t(locale, "orchSumLoadFailed")} <button type="button" onClick={() => void orch.syncJournal(runId!)}>{t(locale, "orchRepeat")}</button></p>
                )}
              </section>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
// Journal v2 (journal-v2-format.md §2.4): the lead's proposed check commands — «Принять» as they are, or «Изменить»
// to the person's own lines. Nothing runs before the decision; it is made once.
function ChecksDecision({ locale, proposal, sending, onDecide }: {
  locale: LocaleId; proposal: NonNullable<OrchestrationRunView["proposal"]>; sending: boolean; onDecide(checks: string[] | null): void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(proposal.checks.map((c) => c.command).join("\n"));
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <div className="orch-question" data-orch-checks-proposal data-orch-form>
      <h4>{t(locale, "orchChecksProposalTitle")}</h4>
      {proposal.checks.length === 0
        ? <>
          <p className="orch-panel__text" data-orch-checks-none>{t(locale, "orchChecksProposalNone")}: {proposal.none}</p>
          <p className="orch-hint">{t(locale, "orchChecksProposalNoneHint")}</p>
        </>
        : <ol data-orch-checks-list>{proposal.checks.map((c) => (
          <li key={c.id}><code>{c.command}</code> — {c.why}{c.source.length > 0 && <small> ({t(locale, "orchChecksSource")}: {c.source.join(", ")})</small>}</li>
        ))}</ol>}
      {editing && (
        <label className="orch-field">
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} data-orch-checks-edit />
          <small className="orch-hint">{t(locale, "orchChecksEditHint")}</small>
        </label>
      )}
      <div className="orch-panel__row">
        {/* A1.1 Q1: none proposed — «Продолжить без проверок» accepts the empty set, «Добавить команды» edits it */}
        {!editing && <button type="button" className="orch-primary" disabled={sending} data-orch-checks-accept onClick={() => onDecide(null)}>{t(locale, proposal.checks.length === 0 ? "orchChecksNoChecks" : "orchChecksAccept")}</button>}
        {!editing && <button type="button" disabled={sending} data-orch-checks-edit-open onClick={() => setEditing(true)}>{t(locale, proposal.checks.length === 0 ? "orchChecksAddCommands" : "orchChecksEdit")}</button>}
        {editing && <button type="button" className="orch-primary" disabled={sending || lines.length > 16} data-orch-checks-save onClick={() => onDecide(lines)}>{t(locale, "orchChecksSave")}</button>}
      </div>
    </div>
  );
}

// A1.1 (§2.6): a lead's check the sandbox refused — run it without the sandbox, or change it (the person's command
// runs without the sandbox too). Never the autopilot's: only these two buttons and Stop.
function CheckRefused({ locale, refused, sending, onAmend }: {
  locale: LocaleId; refused: NonNullable<OrchestrationRunView["refused"]>; sending: boolean; onAmend(line: string): void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(refused.command);
  return (
    <div className="orch-question" data-orch-check-refused={refused.checkId} data-orch-form>
      <h4>{t(locale, "orchCheckRefusedTitle")}</h4>
      <p><code>{refused.command}</code></p>
      <p className="orch-hint">{t(locale, "orchCheckRefusedText")}</p>
      {/* the whole command, never shortened; saving it unchanged is the person's decision too (S1-4) */}
      {editing && <label className="orch-field">
        <textarea rows={Math.min(8, refused.command.split("\n").length + 2)} value={text} onChange={(e) => setText(e.target.value)} data-orch-check-refused-line />
        <small className="orch-hint">{t(locale, "orchCheckRefusedEditHint")}</small>
      </label>}
      <div className="orch-panel__row">
        {!editing && <button type="button" className="orch-primary" disabled={sending} data-orch-check-edit-open onClick={() => setEditing(true)}>{t(locale, "orchCheckRefusedEdit")}</button>}
        {editing && <button type="button" className="orch-primary" disabled={sending || text.trim() === ""} data-orch-check-edit-save onClick={() => onAmend(text.trim())}>{t(locale, "orchCheckRefusedSave")}</button>}
      </div>
    </div>
  );
}

// Journal v2 (§2.1): push and QA of a run without checks — every step the goal asked for decided at once, for the tree
// and commit shown; each is decided on its own (owner's decision 5i §7 p. 3), with a warning for QA of an unpushed commit.
function FinishConfirm({ locale, confirm, sending, onConfirm }: {
  locale: LocaleId; confirm: NonNullable<OrchestrationRunView["confirm"]>; sending: boolean;
  onConfirm(push: "confirm" | "decline" | null, qa: "confirm" | "decline" | null): void;
}): React.JSX.Element {
  const [push, setPush] = useState<"confirm" | "decline" | null>(null);
  const [qa, setQa] = useState<"confirm" | "decline" | null>(null);
  const ready = !!confirm.tree && (!confirm.push || push !== null) && (!confirm.qa || qa !== null);
  const choice = (step: "push" | "qa", value: "confirm" | "decline" | null, set: (v: "confirm" | "decline") => void) => (
    <fieldset className="orch-field orch-finish-group" data-orch-finish-step={step}>
      <legend>{t(locale, step === "push" ? "orchFinishGroup_push" : "orchFinishGroup_qa")}</legend>
      {(["confirm", "decline"] as const).map((v) => (
        <label key={v} className="orch-check">
          <input type="radio" name={`orch-finish-${step}`} checked={value === v} onChange={() => set(v)} data-orch-finish-choice={`${step}:${v}`} />
          <span>{t(locale, step === "push" ? (v === "confirm" ? "orchFinishConfirmPush" : "orchFinishDeclinePush") : v === "confirm" ? "orchFinishConfirmQa" : "orchFinishDeclineQa")}</span>
        </label>
      ))}
    </fieldset>
  );
  return (
    <div className="orch-question" data-orch-finish-confirm data-orch-form>
      <h4>{t(locale, "orchFinishConfirmTitle")}</h4>
      <p className="dialog-error" data-orch-finish-no-checks>{t(locale, "orchFinishConfirmNoChecks")}</p>
      {confirm.commit && <p className="orch-hint">commit <code>{confirm.commit.slice(0, 12)}</code></p>}
      {confirm.push && confirm.qa && <p className="orch-hint" data-orch-finish-independent>{t(locale, "orchFinishIndependent")}</p>}
      {confirm.push && choice("push", push, setPush)}
      {confirm.qa && choice("qa", qa, setQa)}
      {qa === "confirm" && push === "decline" && <p className="dialog-error" data-orch-qa-unpushed>{t(locale, "orchFinishConfirmQaUnpushed")}</p>}
      <button type="button" className="orch-primary" disabled={sending || !ready} data-orch-finish-submit
        onClick={() => onConfirm(confirm.push ? push : null, confirm.qa ? qa : null)}>{t(locale, "orchFinishConfirmSubmit")}</button>
    </div>
  );
}

// A4 (5h §3.5, §4; journal-v2-format.md §2.9): the person's decision on awaiting_person_decision — a disputed item (both
// texts and paths: a new defect or a repeat of a closed candidate) and a person condition (met / not met). Each about
// the state shown (runKey); the run goes on by itself after it.
function PersonDecide({ locale, d, sending, onDecide }: {
  locale: LocaleId; d: OrchestrationDecisions; sending: boolean; onDecide(person: Omit<OrchestrationPersonDecide, "kind">): void;
}): React.JSX.Element {
  return (
    <div className="orch-question" data-orch-person-decide data-orch-form>
      <h4>{t(locale, "orchPersonTitle")}</h4>
      {d.disputed.map((x) => (
        <div key={`${x.reviewTurnId}:${x.index}`} data-orch-disputed={`${x.reviewTurnId}:${x.index}`}>
          <p>{t(locale, "orchDisputedItem")}</p>
          <p className="orch-hint" data-orch-disputed-consequence>{t(locale, "orchDisputedConsequence")}</p>
          <div className="orch-seen">
            <div data-orch-disputed-now>
              <p className="orch-panel__text"><b>{t(locale, "orchDisputedNow")}</b> {x.problem}</p>
              {x.evidence && <p className="orch-hint">{x.evidence}</p>}
              {x.paths.length > 0 && <p className="orch-hint">{x.paths.join(", ")}</p>}
            </div>
            {x.candidates.map((c) => {
              const shared = c.paths.filter((f) => x.paths.includes(f));
              return (
                <blockquote key={c.id} data-orch-disputed-candidate={c.id}>
                  <b title={c.id}>{fill(t(locale, "orchDisputedCandidate"), { n: idNumber(c.id) })}</b>: {c.problem}
                  {c.paths.length > 0 && <span className="orch-hint"> · {c.paths.join(", ")}</span>}
                  {shared.length > 0 && <p className="orch-hint" data-orch-disputed-shared>{fill(t(locale, "orchDisputedShared"), { files: shared.join(", ") })}</p>}
                </blockquote>
              );
            })}
          </div>
          <p className="orch-hint" data-orch-disputed-how>{t(locale, "orchDisputedHow")}</p>
          <div className="orch-panel__actions">
            <button type="button" className="orch-primary" disabled={sending} data-orch-disputed-new
              onClick={() => onDecide({ subject: "disputed", target: { reviewTurnId: x.reviewTurnId, index: x.index }, decision: "new", finding: null, runKey: d.runKey })}>
              {t(locale, "orchDisputedNew")}</button>
            {x.candidates.map((c) => (
              <button key={c.id} type="button" disabled={sending} data-orch-disputed-repeat={c.id}
                onClick={() => onDecide({ subject: "disputed", target: { reviewTurnId: x.reviewTurnId, index: x.index }, decision: "repeat", finding: c.id, runKey: d.runKey })}>
                {fill(t(locale, "orchDisputedRepeat"), { n: idNumber(c.id) })}</button>
            ))}
          </div>
        </div>
      ))}
      {d.conditions.map((c) => (
        <div key={c.id} data-orch-person-condition={c.id}>
          <p><b title={c.id}>{fill(t(locale, "orchPersonCondition"), { n: idNumber(c.id) })}</b>: {c.text}</p>
          <div className="orch-panel__actions">
            <button type="button" className="orch-primary" disabled={sending} data-orch-person-met
              onClick={() => onDecide({ subject: "condition", target: c.id, decision: "met", finding: null, runKey: d.runKey })}>{t(locale, "orchPersonMet")}</button>
            <button type="button" disabled={sending} data-orch-person-not-met
              onClick={() => onDecide({ subject: "condition", target: c.id, decision: "not_met", finding: null, runKey: d.runKey })}>{t(locale, "orchPersonNotMet")}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// A4 (5h §3.6 p. 5): a plan proposal that drops conditions or requirements — what goes, why, what is left uncovered,
// and a choice for every open blocking finding of a dropped condition (Accept stays off until each has one). «Вернуть
// лиду» keeps the plan in force and sends the note.
function PlanProposal({ locale, d, sending, onDecide }: {
  locale: LocaleId; d: OrchestrationDecisions; sending: boolean; onDecide(plan: Omit<OrchestrationPlanDecide, "kind">): void;
}): React.JSX.Element {
  const p = d.proposal!;
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const ready = p.findings.every((f) => choices[f.id]);
  const choiceOf = (id: string): OrchestrationPlanChoice => {
    const v = choices[id];
    return v === "close" || v === "to_wish" ? { id, choice: v, stage: null, condition: null } : { id, choice: "move", stage: Number(v.slice(6)), condition: null };
  };
  return (
    <div className="orch-question" data-orch-plan-proposal={p.proposalTurnId} data-orch-form>
      {/* UX audit PR 2: what the decision is about stays in view while its choices scroll */}
      <div className="orch-proposal__head" data-orch-proposal-head>
        <h4>{t(locale, "orchProposalTitle")}</h4>
        <ul>
          {p.dropped.map((x) => (
            <li key={x.id} data-orch-proposal-drop={x.id}><b title={x.id}>{fill(t(locale, "orchProposalCondition"), { n: idNumber(x.id) })}</b>: {x.text}
              {x.covers.length > 0 && <span className="orch-hint"> · {x.covers.join(", ")}</span>}<br /><span className="orch-hint">{fill(t(locale, "orchProposalWhy"), { why: x.why })}</span></li>
          ))}
          {p.dropRequirements.map((x) => (
            <li key={x.id} data-orch-proposal-drop={x.id}><b title={x.id}>{fill(t(locale, "orchProposalRequirement"), { n: idNumber(x.id) })}</b>: {x.text}
              <br /><span className="orch-hint">{fill(t(locale, "orchProposalWhy"), { why: x.why })}</span></li>
          ))}
        </ul>
        {p.uncovered.length > 0 && <p className="dialog-error" data-orch-proposal-uncovered>{fill(t(locale, "orchProposalUncovered"), { list: p.uncovered.map((id) => idLabel(locale, id)).join(", ") })}</p>}
      </div>
      <p className="orch-hint">{fill(t(locale, "orchProposalStages"), { stages: p.stages.map((s) => `${s.stage}. ${s.title}`).join("; ") })}</p>
      {p.findings.length > 0 && <>
        <p><b>{t(locale, "orchProposalFindings")}</b></p>
        {p.findings.map((f) => (
          <label key={f.id} className="orch-field" data-orch-proposal-finding={f.id}>
            <span><IdLabel locale={locale} id={f.id} /> (<IdLabel locale={locale} id={f.condition} plain />): {f.problem}</span>
            <select value={choices[f.id] ?? ""} onChange={(e) => setChoices((c) => ({ ...c, [f.id]: e.target.value }))}>
              <option value="" disabled>{t(locale, "orchProposalChoose")}</option>
              {p.stages.map((s) => <option key={s.stage} value={`stage:${s.stage}`}>{fill(t(locale, "orchProposalMove"), { n: s.stage })}</option>)}
              <option value="close">{t(locale, "orchProposalClose")}</option>
              <option value="to_wish">{t(locale, "orchProposalToWish")}</option>
            </select>
          </label>
        ))}
      </>}
      {/* UX audit: the safe choice first and main — the plan in force stays; accepting drops what is no longer checked.
          Both in one row, so neither scrolls under the pinned subject while the other is in view (PR 2) */}
      <textarea rows={2} value={note} placeholder={t(locale, "orchProposalNote")} onChange={(e) => setNote(e.target.value)} data-orch-proposal-note />
      <p className="orch-hint">{t(locale, "orchProposalKeeps")}</p>
      <p className="orch-hint orch-hint--warn" data-orch-proposal-accept-warn>{t(locale, "orchProposalAcceptWarn")}</p>
      <div className="orch-panel__actions">
        <button type="button" className="orch-primary" disabled={sending} data-orch-proposal-return
          onClick={() => onDecide({ proposalTurnId: p.proposalTurnId, decision: "return", choices: [], note: note.trim() || null, runKey: d.runKey })}>
          {t(locale, "orchProposalReturn")}</button>
        <button type="button" disabled={sending || !ready} data-orch-proposal-accept
          onClick={() => onDecide({ proposalTurnId: p.proposalTurnId, decision: "accept", choices: p.findings.map((f) => choiceOf(f.id)), note: null, runKey: d.runKey })}>
          {t(locale, "orchProposalAcceptDrop")}</button>
      </div>
    </div>
  );
}
