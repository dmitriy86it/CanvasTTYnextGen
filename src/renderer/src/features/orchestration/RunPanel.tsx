// The one panel of a link's latest run (stage-8-contract.md §1, stage 11). A pinned summary on top — the state in plain
// words, who works on which stage, why it is paused, the next step, the question with its answer field and the commands
// this state allows — and below it tabs: overview, the live activity of one participant, changes, the technical log,
// the journal's history. Nothing is shown as done before main answers.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import type {
  OrchestrationActivityEntry,
  OrchestrationAgentLink,
  OrchestrationChanges,
  OrchestrationFormField,
  OrchestrationHistoryRecord,
  OrchestrationLimitKind,
  OrchestrationPermissionOption,
  OrchestrationPermissionRequest,
  OrchestrationRunView
} from "../../../../shared/orchestration";
import { UiIcon } from "../../components/UiIcon";
import { t, type TranslationKey } from "../../lib/i18n";
import {
  ACTIVE_STATUSES,
  availableActions,
  TERMINAL_STATUSES,
  board,
  commandOf,
  digest,
  finishPending,
  finishStatus,
  formatText,
  historyLines,
  outcomeOf,
  parsePlan,
  nextStepKey,
  participantState,
  pauseEnding,
  resultFacts,
  runHeadline,
  type HistoryLine,
  type LineText,
  type ParticipantState,
  type PendingCommand,
  type RunAction,
  type RunDigest
} from "./runModel";
import { duration, finishText, isServiceEntry, outcomeKey, readJournal, reportParts, summaryModel, type ReportParts, type RunJournalState, type TextRef } from "./runStatus";
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
function reasonText(locale: LocaleId, view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): string {
  const step = pauseEnding(view, entries);
  return step && known(locale, `orchEnding_${step}`) ? tr(locale, `orchEnding_${step}`) : tr(locale, `orchReason_${view.reason}`);
}

function lineText(locale: LocaleId, line: HistoryLine): string {
  const p = line.parts;
  const head = tr(locale, `orchLine_${line.kind}`);
  switch (line.kind) {
    case "status": return `${head}: ${tr(locale, `orchStatus_${p.status}`)}${p.reason ? ` — ${tr(locale, `orchReason_${p.reason}`)}` : ""}`;
    case "turn": return `${head}: ${tr(locale, `orchPurpose_${p.purpose}`)}${p.stage !== null ? ` · ${t(locale, "orchStage")} ${p.stage}` : ""}`;
    case "turn_failed": return `${head}: ${p.purpose ? `${tr(locale, `orchPurpose_${p.purpose}`)} — ` : ""}${p.outcome}`;
    case "report": return head;
    case "review": return `${head}: ${tr(locale, `orchVerdict_${p.verdict}`)}${p.stage !== null ? ` · ${t(locale, "orchStage")} ${p.stage}` : ""}`;
    case "stage_accepted": return `${head} ${p.stage}`;
    case "check": return `${head} ${p.checkId ?? ""}: ${tr(locale, `orchCheck_${p.status}`)}`
      + `${p.reason ? ` — ${tr(locale, `orchCheckReason_${p.reason}`)}` : ""}${p.exitCode !== null && p.status === "failed" ? ` (${t(locale, "orchExitCode")} ${p.exitCode})` : ""}`;
    case "limit": return `${head}: ${tr(locale, `orchLimit_${p.kind}`)} = ${p.value}`;
    case "plan": return `${head} (v${p.version})`;
    default: return head;
  }
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

const roleName = (locale: LocaleId, role: PanelRole) =>
  role === "lead" ? `Codex · ${t(locale, "orchRoleLead")}` : role === "executor" ? `Claude · ${t(locale, "orchRoleExecutor")}` : t(locale, "orchObserveChecks");

function phaseText(locale: LocaleId, p: ParticipantState, now: number): string {
  const since = p.since ? ` · ${duration(locale, now - Date.parse(p.since))}` : "";
  const why = p.phase === "interrupted" && p.outcome
    ? ` (${tr(locale, known(locale, `orchPhaseWhy_${p.outcome}`) ? `orchPhaseWhy_${p.outcome}` : `orchOutcome_${p.outcome}`)})` : "";
  return `${tr(locale, `orchPhase_${p.phase}`)}${why}${p.phase === "running" || p.phase === "starting" || p.phase === "finishing" ? since : ""}`;
}

// ---------- activity feed ----------

const LOG_KINDS = new Set(["stderr", "error", "process_started", "process_exited", "usage", "truncated", "session", "check_output", "turn_finished", "refusal"]);
const FEED_KINDS = new Set(["task_sent", "process_started", "process_exited", "session", "thinking", "message", "tool_started", "tool_finished", "file_read",
  "file_changed", "subagent", "refusal", "error", "turn_finished", "check_started", "check_finished", "status", "truncated",
  "permission_requested", "permission_decided", "permission_applied", "prepare_started", "prepare_finished", "external_action"]);

function entryLabel(locale: LocaleId, e: OrchestrationActivityEntry): string {
  const d = e.detail ?? {};
  switch (e.kind) {
    case "thinking": return tr(locale, "orchAct_thinking");
    case "turn_finished": return `${tr(locale, "orchAct_turn_finished")}: ${tr(locale, `orchOutcome_${e.text}`)}${d.reportedDone === true ? ` · ${tr(locale, "orchAct_reportedDone")}` : d.reportedDone === false ? ` · ${tr(locale, "orchAct_reportedNotDone")}` : ""}${d.question === true ? ` · ${tr(locale, "orchAct_asked")}` : ""}${typeof d.endStep === "string" && d.endStep !== "ok" && known(locale, `orchEnding_${d.endStep}`) ? ` — ${tr(locale, `orchEnding_${d.endStep}`)}` : ""}`;
    case "status": return `${tr(locale, "orchAct_status")}: ${tr(locale, `orchStatus_${d.status}`)}${d.reason ? ` — ${tr(locale, `orchReason_${d.reason}`)}` : ""}`;
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
function structured(e: OrchestrationActivityEntry): ReportParts | null {
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
            <span className="orch-feed__text">{report ? `${tr(locale, "orchAct_message")}: ${t(locale, "orchFeedReport")}` : entryLabel(locale, e)}</span>
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
  return <small className={`orch-src orch-src--${kind}`} data-src={kind}>{t(locale, kind === "journal" ? "orchSumConfirmed" : "orchSumClaim")}</small>;
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

type GoalJson = { text?: unknown; criteria?: unknown; commands?: unknown };
function parseGoal(text: string): GoalJson | null {
  try { const v = JSON.parse(text) as unknown; return v && typeof v === "object" ? v as GoalJson : null; } catch { return null; }
}
const fill = (s: string, vars: Record<string, string | number>): string => Object.entries(vars).reduce((a, [k, v]) => a.replaceAll(`{${k}}`, String(v)), s);

function RunSummary({ orch, runId, view, records, locale, changedFiles, gaps, incomplete }: {
  orch: Orchestration; runId: string; view: OrchestrationRunView; records: readonly OrchestrationHistoryRecord[];
  locale: LocaleId; changedFiles: number | null; gaps: number; incomplete: boolean;
}): React.JSX.Element {
  // Every plan's titles (a replan names the stages from its firstStage on), read through the shared text cache.
  const planShas = useMemo(() => records.filter((r) => r.type === "plan.recorded")
    .map((r) => (r.data.plan as TextRef | undefined)?.sha256).filter((x): x is string => typeof x === "string"), [records]);
  useEffect(() => { for (const sha of planShas) orch.loadText(runId, sha); }, [orch.loadText, planShas, runId]);
  const planKey = planShas.map((sha) => `${sha}:${orch.texts[sha]?.status ?? ""}`).join(",");
  const goalText = useText(orch, runId, (records.find((r) => r.type === "run.created")?.data.goal as TextRef | undefined)?.sha256);
  const commands = useMemo(() => { const g = goalText ? parseGoal(goalText) : null; return Array.isArray(g?.commands) ? g.commands.filter((c): c is string => typeof c === "string") : null; }, [goalText]);
  const m = useMemo(() => summaryModel(view, records, {
    planTitles: (sha) => { const s = orch.texts[sha]; return s?.status === "ready" ? parsePlan(s.text).map((p) => p.title) : null; },
    goalCommands: commands, complete: !incomplete
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [view, records, planKey, commands, incomplete]);
  const finalText = useText(orch, runId, m.finalReport?.sha256);
  const lastText = useText(orch, runId, m.lastReport?.sha256);
  const next = (finalText ? reportParts(finalText).next : null) ?? (lastText ? reportParts(lastText).next : null);
  const head = runHeadline(view);
  const outcome = outcomeKey(view, m.finalVerdict, m.complete);
  // Read only in part: what was read stands, but nothing is concluded from what was not read yet.
  const stageStateText = (st: { state: string }) => tr(locale, !m.complete && st.state !== "done" ? "orchSumStage_unloaded" : `orchSumStage_${st.state}`);
  const progress = view.progress ?? null;
  const verdictText = (v: string | null) => (v ? tr(locale, `orchVerdict_${v}`) : "—");
  const missing = <NotSpecified locale={locale} incomplete={incomplete} />;
  const stageLabel = (n: number | null, title: string | null, plan?: number | null) =>
    `${n === null ? t(locale, "orchSumReviewFinal") : `${t(locale, "orchStage")} ${n}${title ? `: ${title}` : ""}`}${plan ? ` · ${fill(t(locale, "orchSumPlanVersion"), { v: plan })}` : ""}`;
  const findingsList = (ref: TextRef | null, attr: string) => (
    <Stored orch={orch} runId={runId} textRef={ref} locale={locale} incomplete={incomplete}>{(text) => {
      const f = reportParts(text).findings;
      return f.length ? <ul {...{ [attr]: "" }}>{f.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p>{t(locale, "orchSumRemarksNone")}</p>;
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

      <Section id="outcome" title={t(locale, "orchSum_outcome")} src="journal" locale={locale}>
        <p className={`orch-sum__outcome orch-sum__outcome--${outcome}`} data-sum-outcome={outcome}>
          <b>{tr(locale, `orchHeadline_${head.headline}`)}</b> — {tr(locale, `orchSumOutcome_${outcome}`)}
        </p>
        {view.reason && <p><b>{t(locale, "orchSum_reason")}:</b> {reasonText(locale, view, orch.activity[runId]?.entries ?? [])}</p>}
        {outcome === "completed" && <p className="orch-hint" data-sum-scope>{t(locale, "orchSumScope")}</p>}
        {m.endedAt && <p className="orch-hint">{t(locale, "orchSumEnded").replace("{time}", new Date(m.endedAt).toLocaleString(locale))}</p>}
      </Section>

      <Section id="stages" title={t(locale, "orchSum_stages")} src="journal" locale={locale}>
        {!m.stages ? missing : <>
          {m.stageCounts && <p data-sum-stage-count data-partial={m.complete ? undefined : "yes"}><b>{fill(t(locale, m.complete ? "orchSumStages_count" : "orchSumStages_countPartial"), { done: m.stageCounts.done, total: m.stageCounts.total })}</b></p>}
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
                <li key={i}>{stageLabel(st.n, st.title, st.plan)} — {st.verdict ? tr(locale, `orchVerdict_${st.verdict}`) : tr(locale, `orchSumStage_${st.state}`)}</li>
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

      <Section id="lead" title={t(locale, "orchSum_lead")} src="agent" locale={locale}>
        {m.finalReport
          ? <Stored orch={orch} runId={runId} textRef={m.finalReport} locale={locale} incomplete={incomplete}>{(text) => <ReportView locale={locale} parts={{ ...reportParts(text), findings: [], next: null }} />}</Stored>
          : m.finalVerdict ? <p><b>{t(locale, "orchSumVerdict")}:</b> {tr(locale, `orchVerdict_${m.finalVerdict}`)}</p>
            : current ? (
              <div data-sum-current-review={current.verdict ?? ""}>
                <p><b>{fill(t(locale, m.complete ? "orchSumCurrentReview" : "orchSumCurrentReviewPartial"), { stage: stageLabel(current.stage, current.title) })}</b></p>
                {current.report
                  ? <Stored orch={orch} runId={runId} textRef={current.report} locale={locale} incomplete={incomplete}>{(text) => <ReportView locale={locale} parts={{ ...reportParts(text), findings: [] }} />}</Stored>
                  : <p><b>{t(locale, "orchSumVerdict")}:</b> {verdictText(current.verdict)}</p>}
              </div>
            ) : missing}
      </Section>

      <Section id="checks" title={t(locale, "orchSum_checks")} src="journal" locale={locale}>
        {m.checks.length === 0 ? (m.checksKnown ? <p>{t(locale, "orchSumChecks_noneConfigured")}</p> : missing) : <>
          <p data-sum-check-count data-checks-known={m.checksKnown ? "yes" : "no"}><b>{fill(t(locale, m.checksKnown ? "orchSumChecks_count" : "orchSumChecks_seen"), { passed: m.checkCounts.passed, total: m.checkCounts.total })}</b></p>
          <ul className="orch-sum__checks">{m.checks.map((c) => (
            <li key={c.id} data-check-id={c.id} data-check-status={c.status} data-check-runs={c.runs}><code>{c.title}</code> — {tr(locale, `orchCheck_${c.status}`)} · {fill(t(locale, m.complete ? "orchSumChecks_runs" : "orchSumChecks_runsAtLeast"), { n: c.runs })}</li>
          ))}</ul>
          <p className="orch-hint" data-sum-tests>{t(locale, "orchSumTests")}</p>
        </>}
      </Section>

      <Section id="remarks" title={t(locale, "orchSum_remarks")} locale={locale}>
        <b>{t(locale, "orchSumFindingsCurrent")} <Src locale={locale} kind="agent" /></b>
        {m.finalFindings ? findingsList(m.finalFindings, "data-sum-findings")
          : m.finalVerdict ? <p>{t(locale, "orchSumRemarksNone")}</p>
            : current ? <>
              <p className="orch-hint">{stageLabel(current.stage, current.title)} · {verdictText(current.verdict)}{m.complete ? "" : ` — ${t(locale, "orchSumFindingsPartial")}`}</p>
              {current.findings ? findingsList(current.findings, "data-sum-findings") : <p>{t(locale, "orchSumRemarksNone")}</p>}
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
              ? <>{t(locale, "orchWhereWorktree")} <code>{progress?.branch ?? "?"}</code> · <code>{view.workDir}</code></>
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
        <p className="orch-hint">{t(locale, "orchSumAppHint")}: {tr(locale, `orchNext_${nextStepKey(view, orch.activity[runId]?.entries ?? [])}`)}</p>
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
};

export function RunPanel(props: RunPanelProps): React.JSX.Element {
  const newer = props.runId ? props.orch.runs[props.runId]?.view.newer : undefined;
  // a newer journal that declared minReaderVersion this build reads: the whole panel, read-only
  return newer && !newer.compatible
    ? <NewerRunPanel orch={props.orch} runId={props.runId!} locale={props.locale} onClose={props.onClose} newer={newer} />
    : <CurrentRunPanel {...props} />;
}

// "Release link" for a link held by a newer version's run (proposed amendment to acceptance-review-spec.md §2.2):
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

function CurrentRunPanel({ orch, runId, locale, panel, onClose, onNewGoal, onView }: RunPanelProps): React.JSX.Element {
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
  const lastStatus = useRef(view?.status ?? null);
  const [endedHere, setEndedHere] = useState(false);
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = view?.status ?? null;
    if (was && view && !TERMINAL_STATUSES.includes(was) && TERMINAL_STATUSES.includes(view.status)) setEndedHere(true);
  }, [view?.status]);
  useEffect(() => { if (panel.tab === "summary") setEndedHere(false); }, [panel.tab]);

  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [clarify, setClarify] = useState("");
  const [limit, setLimit] = useState<{ kind: OrchestrationLimitKind; value: string }>({ kind: "turns", value: "" });
  const [confirmReset, setConfirmReset] = useState(false);
  const [changedFiles, setChangedFiles] = useState<number | null>(null);
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
  useEffect(() => {
    const box = summary.current;
    const block = box?.querySelector<HTMLElement>("[data-orch-permission], [data-orch-question]");
    if (!box || !block) return;
    const b = box.getBoundingClientRect(), r = block.getBoundingClientRect();
    if (r.bottom > b.bottom || r.top < b.top) box.scrollTop += r.top - b.top - 8;
    if (!answerBox.current) block.querySelector<HTMLElement>("input, select, textarea, button:not(:disabled)")?.focus({ preventScroll: true });
  }, [panel.focus, waitingId]);

  // The count of changed files for the result facts (the list itself is in the Changes tab).
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

  const actions = view ? availableActions(view) : [];
  const has = (a: RunAction) => actions.includes(a);
  const busy = view !== null && ACTIVE_STATUSES.includes(view.status);
  const open = state?.open ?? true;
  const lead = participantState("lead", view, activity.entries, open);
  const executor = participantState("executor", view, activity.entries, open);
  const facts = resultFacts(view, d, changedFiles, reportedDone);
  const head = view ? runHeadline(view) : null;
  const active = view?.active ?? null;
  const workingRole: PanelRole | null = !active ? null : active.kind !== "turn" ? "check" : active.purpose === "execute" ? "executor" : "lead";
  const workingState = workingRole === "lead" ? lead : workingRole === "executor" ? executor : null;
  const stageText = view?.stage ? `${t(locale, "orchStage")} ${view.stage}${planTotal ? ` / ${planTotal}` : ""}` : null;
  const who = !active ? t(locale, "orchNobodyNow")
    : active.kind === "check" ? `${t(locale, "orchCheckRunning")} (${active.checkId})${stageText ? ` · ${stageText}` : ""}`
      : active.kind === "prepare" ? t(locale, "orchCanvasPrepare")
        : active.kind === "finish" ? `${t(locale, "orchCanvasFinish")}: ${tr(locale, `orchFinishStep_${active.step}`)}`
          : `${roleName(locale, workingRole!)} — ${tr(locale, `orchPurpose_${active.purpose}`)}${stageText ? ` · ${stageText}` : ""} · ${workingState ? phaseText(locale, workingState, now) : ""}`;
  const top = view ? board(view) : null;
  const pending = view ? finishPending(view) : null;
  const accessMismatch = activity.entries.some((e) => e.kind === "error" && e.detail?.accessMismatch === true);
  const progress = view?.progress ?? null;
  const silenceFor = (p: ParticipantState): string | null => {
    if (p.phase !== "running") return null;
    const last = p.lastEventAt ? Date.parse(p.lastEventAt) : null;
    if (last !== null && now - last < SILENCE_MS) return null;
    return `${t(locale, "orchSilence")}${p.lastEventAt ? ` ${t(locale, "orchSilenceLast")} ${time(locale, p.lastEventAt)} (${duration(locale, now - Date.parse(p.lastEventAt))})` : ""}`;
  };

  const tabs: PanelTab[] = ["summary", "overview", "activity", "changes", "log", "history"];
  const roleFilter = useCallback((e: OrchestrationActivityEntry) => panel.role === "check"
    ? (e.role === "check" || e.role === "run") && FEED_KINDS.has(e.kind)
    : (e.role === panel.role && FEED_KINDS.has(e.kind)) || (e.role === "run" && e.kind === "status"), [panel.role]);
  const logFilter = useCallback((e: OrchestrationActivityEntry) => (panel.role === "check" ? e.role === "check" : e.role === panel.role)
    && (LOG_KINDS.has(e.kind) || (e.kind === "tool_finished" && typeof e.detail?.output === "string")), [panel.role]);
  const selected = panel.role === "lead" ? lead : panel.role === "executor" ? executor : null;

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
            <div className="orch-summary__headline">
              <strong>{tr(locale, `orchHeadline_${head.headline}`)}</strong>
              {view.reason && <span data-orch-reason>{reasonText(locale, view, activity.entries)}</span>}
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
                <span>{t(locale, "orchReadOnlyHint")}</span>
                {runId && linkOfRun(orch, runId) && <ReleaseNewerLink orch={orch} linkId={linkOfRun(orch, runId)!} runId={runId} locale={locale} />}
              </div>
            )}
            <p className="orch-summary__who" data-orch-working>{who}</p>
            {top && progress && (
              <dl className="orch-board" data-orch-board data-action={top.action ? "yes" : "no"}>
                <div><dt>{t(locale, "orchRunMode")}:</dt><dd data-board="mode">{tr(locale, `orchRunMode_${progress.mode}`)}</dd></div>
                <div><dt>{t(locale, "orchBoardStage")}:</dt><dd data-board="stage">{stageText ?? "—"}</dd></div>
                {top.prepare && <div><dt>{t(locale, "orchBoardPrepare")}:</dt><dd data-board="prepare">{tr(locale, `orchPrepare_${top.prepare}`)}</dd></div>}
                <div><dt>{t(locale, "orchBoardChecked")}:</dt><dd data-board="checked">{top.checked.total ? t(locale, "orchBoardCheckedValue").replace("{passed}", String(top.checked.passed)).replace("{total}", String(top.checked.total)) : "—"}
                  {top.checked.failed.map((f, i) => <small key={i} className="orch-board__failed"> · {f.title}{f.class ? ` (${tr(locale, `orchClass_${f.class}`)})` : ""}</small>)}</dd></div>
                <div><dt>{t(locale, "orchBoardAction")}:</dt><dd data-board="action">{t(locale, top.action ? "orchBoardActionYes" : "orchBoardActionNone")}</dd></div>
                {progress.access && (
                  <div className={progress.access.claude === "full" || progress.access.codex === "full" ? "orch-board__full" : undefined}>
                    <dt>{t(locale, "orchBoardAccess")}:</dt>
                    <dd data-board="access">Claude — {tr(locale, `orchAccess_${progress.access.claude}`)} · Codex — {tr(locale, `orchAccess_${progress.access.codex}`)}</dd>
                  </div>
                )}
                {top.grantsApplied > 0 && <div><dt>{t(locale, "orchBoardGrants")}:</dt><dd data-board="grants">{top.grantsApplied}</dd></div>}
              </dl>
            )}
            {accessMismatch && <p className="dialog-error" data-orch-access-mismatch>{t(locale, "orchAccessMismatchWarn")}</p>}
            <p className="orch-summary__next" data-orch-next><b>{t(locale, "orchNextStep")}:</b> {tr(locale, `orchNext_${nextStepKey(view, activity.entries)}`)}</p>
            {head.headline === "awaiting_plan_review" && plan.length > 0 && (
              <ol className="orch-summary__plan" data-orch-summary-plan start={planFirst}>{plan.map((p, i) => <li key={i}><strong>{p.title}</strong><span>{p.task}</span></li>)}</ol>
            )}
            {view.workMode && (
              <p className={`orch-summary__where orch-summary__where--${view.workMode}`} data-orch-where={view.workMode} title={view.workDir}>
                {view.workMode === "worktree"
                  ? <>{t(locale, "orchWhereWorktree")} <code>{progress?.branch ?? "?"}</code> · <code>{view.workDir}</code></>
                  : <>{t(locale, view.workMode === "project" ? "orchWhereProject" : "orchWhereCopy")} <code>{view.workDir}</code></>}
              </p>
            )}
            {view.permission && !view.newer && (
              <PermissionBlock key={view.permission.requestId} locale={locale} request={view.permission} more={(view.pendingPermissions ?? 1) - 1} sending={sending}
                onDecide={(decision, extra) => void send("permission", { requestId: view.permission!.requestId, decision, ...extra })} />
            )}

            {has("answer") && d.question && (
              <div className="orch-question" data-orch-question>
                <h4>{t(locale, "orchQuestion")}</h4>
                <p className="orch-panel__text">{questionText ?? t(locale, "orchLoading")}</p>
                <textarea ref={answerBox} rows={3} value={answer} placeholder={t(locale, "orchAnswerPlaceholder")} onChange={(e) => setAnswer(e.target.value)} />
                <button type="button" className="orch-primary" disabled={sending || !answer.trim()}
                  onClick={() => void send("answer", { questionId: d.question!.questionId, text: answer.trim() }, () => setAnswer(""))}>{t(locale, "orchAnswer")}</button>
              </div>
            )}
            {actions.length > 0 && (
              <div className="orch-panel__actions">
                {has("pause") && <button type="button" disabled={sending} onClick={() => void send("pause")}>{t(locale, "orchPause")}</button>}
                {has("keep_running") && <button type="button" disabled={sending} onClick={() => void send("keep_running")}>{t(locale, "orchKeepRunning")}</button>}
                {has("resume") && <button type="button" className="orch-primary" disabled={sending} data-orch-resume={head.next} onClick={() => void send("resume")}>
                  {head.next === "finish_retry" && pending ? `${t(locale, "orchFinishRetry")}: ${tr(locale, `orchFinishStep_${pending.step}`)}` : t(locale, "orchResume")}
                </button>}
                {has("step") && <button type="button" disabled={sending} onClick={() => void send("step")}>{t(locale, "orchStep")}</button>}
                {has("stop") && <button type="button" className="orch-danger" disabled={sending} onClick={() => void send("stop")}>{t(locale, "orchStop")}</button>}
              </div>
            )}
            {has("raise_limit") && (
              <div className="orch-panel__row">
                <select value={limit.kind} onChange={(e) => setLimit((l) => ({ ...l, kind: e.target.value as OrchestrationLimitKind }))}>
                  {(["turns", "roundsPerStage", "replans", "runMs"] as const).map((k) => <option key={k} value={k}>{tr(locale, `orchLimit_${k}`)}</option>)}
                </select>
                <input type="number" min={1} value={limit.value} onChange={(e) => setLimit((l) => ({ ...l, value: e.target.value }))} />
                <button type="button" disabled={sending || !(Number(limit.value) > 0)}
                  onClick={() => void send("raise_limit", { limit: limit.kind, value: limit.kind === "runMs" ? Number(limit.value) * 60_000 : Number(limit.value) })}>{t(locale, "orchRaiseLimit")}</button>
              </div>
            )}
            {has("recover") && (
              <div className="orch-panel__actions">
                <button type="button" disabled={sending} onClick={() => void send("recover", { recover: "accept" })}>{t(locale, "orchRecoverAccept")}</button>
                <button type="button" disabled={sending} onClick={() => void send("recover", { recover: "retry_turn" })}>{t(locale, "orchRecoverRetry")}</button>
                <label className="orch-check"><input type="checkbox" checked={confirmReset} onChange={(e) => setConfirmReset(e.target.checked)} /><span>{t(locale, "orchRecoverConfirm")}</span></label>
                {view.workMode !== "project" && <>
                  <button type="button" className="orch-danger" disabled={sending || !confirmReset}
                    onClick={() => void send("recover", { recover: "reset_to_checkpoint", confirm: true })}>{t(locale, "orchRecoverReset")}</button>
                </>}
              </div>
            )}
            {!busy && onNewGoal && !view.newer && <button type="button" className="orch-primary" onClick={onNewGoal}>{t(locale, "orchNewGoal")}</button>}
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
                  incomplete={journal?.status !== "ready"} />}
            </>}
            {panel.tab === "overview" && (
              <>
                <section className="orch-panel__section orch-facts" data-orch-facts>
                  <h4>{t(locale, "orchResult")}</h4>
                  <ul>
                    <li data-fact="reported">{t(locale, "orchFactReported")}: <b>{facts.reportedDone === null ? t(locale, "orchFactNoReport") : facts.reportedDone ? t(locale, "orchYes") : t(locale, "orchNo")}</b></li>
                    <li data-fact="changes">{t(locale, "orchFactChanges")}: <b>{tr(locale, `orchFactChanges_${facts.changes}`)}</b></li>
                    <li data-fact="checks">{t(locale, "orchFactChecks")}: <b>{tr(locale, `orchFactChecks_${facts.checks}`)}</b></li>
                    <li data-fact="checkpoint">{t(locale, "orchFactCheckpoint")}: <b>{facts.checkpoint === null ? t(locale, "orchNo") : `${t(locale, "orchStage")} ${facts.checkpoint}`}</b></li>
                    <li data-fact="accepted" data-orch-result={d.finalVerdict ?? undefined}>{t(locale, "orchFactAccepted")}: <b>{facts.goalAccepted ? t(locale, "orchYes") : journal?.status === "ready" ? t(locale, "orchNo") : t(locale, "orchFactNotLoaded")}</b></li>
                    {view.workMode === "project"
                      ? <li data-fact="in_place">{t(locale, "orchFactInPlace")} — {t(locale, "orchFactInPlaceHint")}</li>
                      : view.workMode === "worktree"
                        ? <li data-fact="where">{t(locale, "orchResultWhere")}: <code>{progress?.branch ?? "?"}</code> · <code>{view.workDir}</code></li>
                        : view.workMode === "copy" && <li data-fact="transferred">{t(locale, "orchFactTransferred")}: <b>{t(locale, "orchNo")}</b> — {t(locale, "orchFactTransferredHint")}</li>}
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
                    {(["lead", "executor"] as const).map((role) => {
                      const info = orch.catalog.providers?.[role];
                      const p = role === "lead" ? lead : executor;
                      return (
                        <li key={role} data-participant={role} data-phase={p.phase}>
                          <strong>{roleName(locale, role)}</strong>
                          {info && <span className="orch-hint">{info.protocol} · {t(locale, "orchNativeInfo")}</span>}
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
                    <button type="button" disabled={sending || !clarify.trim()}
                      onClick={() => void send("clarify", { text: clarify.trim() }, () => setClarify(""))}>{t(locale, "orchClarify")}</button>
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
            {panel.tab === "changes" && runId && <ChangesTab locale={locale} runId={runId} seq={state?.seq ?? 0} inPlace={view.workMode === "project"} />}
            {panel.tab === "history" && (
              <section className="orch-panel__section">
                <ol className="orch-history">
                  {lines.map((l) => (
                    <li key={l.seq} data-history-kind={l.kind}>
                      <time>{new Date(l.ts).toLocaleTimeString(locale)}</time> {lineText(locale, l)}
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