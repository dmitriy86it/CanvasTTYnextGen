// What a run is doing now and what it ended with, in the person's words: the one set of display rules behind the home
// widget, the agent cards and the run summary. Pure (no IPC, no React), testable under node. Only facts of the view,
// the journal and the CLIs' activity events are used; nothing is guessed, and silence is only reported as silence.
import type {
  OrchestrationActivityEntry,
  OrchestrationHistoryRecord,
  OrchestrationPermissionRequest,
  OrchestrationRunProgress,
  OrchestrationRunView
} from "../../../../shared/orchestration.ts";
import { closedByPerson } from "../../../../shared/orchestration.ts";
import type { LocaleId } from "../../../../shared/contracts.ts";
import { t, type TranslationKey } from "../../lib/i18n.ts";
import { activeRole, byReviewer, causeText, finishStatus, headlineKey, PAUSES, pauseWhy, viewPauseLabel, participantState, runHeadline, runStatusKey, TERMINAL_STATUSES, viewCause } from "./runModel.ts";

// read_only: a newer version's run (acceptance-review-spec.md §2.2): shown, never paused, continued or stopped here.
export type ActivityState = "starting" | "working" | "checking" | "waiting_agent" | "waiting_user" | "paused" | "stopping" | "completed" | "completed_no_checks" | "stopped" | "failed" | "read_only";
export type Role = "lead" | "executor" | "reviewer";
export const QUIET_MS = 30_000;

const tr = (locale: LocaleId, key: string, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(locale, key as TranslationKey) ?? key);
const who = (role: Role | "check"): string => (role === "lead" || role === "reviewer" ? "Codex" : role === "executor" ? "Claude" : "");
// One line, bounded: full commands and output stay in the run's details.
export const short = (s: string, max = 80): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export function duration(locale: LocaleId, ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const [sec, min, h] = [t(locale, "orchUnitSec"), t(locale, "orchUnitMin"), t(locale, "orchUnitHour")];
  if (s < 60) return `${s} ${sec}`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} ${min} ${s % 60} ${sec}` : `${Math.floor(m / 60)} ${h} ${m % 60} ${min}`;
}

// A service event of a CLI (Codex hooks): kept in the full feed, folded by default.
export const isServiceEntry = (e: OrchestrationActivityEntry): boolean =>
  (e.kind === "tool_started" || e.kind === "tool_finished") && e.detail?.tool === "hook";

export interface StatusInput {
  view: OrchestrationRunView;
  entries: readonly OrchestrationActivityEntry[];
  open: boolean; // the run is held by this application process
  stageTitles: StageTitles | null; // by global stage number (stageTitleMap); null: no plan loaded
  now: number;
}

export interface StatusLine {
  state: ActivityState;
  actor: Role | "check" | "prepare" | "finish" | null;
  stage: number | null;
  doing: string; // "Codex проверяет этап 3: интерфейс анализа"
  now: string | null; // the concrete current action from the CLI's events
  wait: string | null; // why it waits, when it does
  lastEventAt: string | null;
  quiet: string | null; // "Нет новых событий 40 с" — a fact, never "hung"
}

const stageName = (locale: LocaleId, n: number | null, titles: StatusInput["stageTitles"]): string => {
  if (n === null) return "";
  const title = titles?.[n];
  return title ? tr(locale, "orchNow_stageTitled", { n, title: short(title, 60) }) : tr(locale, "orchNow_stage", { n });
};

// The sentence for whoever holds the turn or the operation now.
function activeDoing(locale: LocaleId, view: OrchestrationRunView, titles: StatusInput["stageTitles"]): { actor: StatusLine["actor"]; doing: string; checking: boolean } | null {
  const a = view.active;
  if (!a) return null;
  const stage = stageName(locale, view.stage, titles);
  if (a.kind === "check") return { actor: "check", doing: tr(locale, "orchNow_check", { stage: stage ? ` · ${stage}` : "" }), checking: true };
  if (a.kind === "prepare") return { actor: "prepare", doing: t(locale, "orchCanvasPrepare"), checking: false };
  if (a.kind === "finish") return { actor: "finish", doing: `${t(locale, "orchCanvasFinish")}: ${tr(locale, `orchFinishStep_${a.step}`)}`, checking: false };
  const role = activeRole(view) as Role;
  return { actor: role, doing: tr(locale, `orchNow_${a.purpose}`, { who: who(role), stage }).trim(), checking: a.purpose === "review" || a.purpose === "final_review" };
}

// The newest concrete step of a participant's current turn, from the CLI's own events (never a reasoning text).
export function currentAction(locale: LocaleId, entries: readonly OrchestrationActivityEntry[], role: Role | "check", turnId: string | null): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.role !== role || (turnId && e.turnId !== turnId) || isServiceEntry(e)) continue;
    switch (e.kind) {
      case "tool_started": return `${t(locale, "orchNow_tool")}: ${short(e.text)}`;
      case "tool_finished": return `${t(locale, "orchNow_toolDone")}: ${short(e.text)}`;
      case "thinking": return t(locale, "orchNow_thinking");
      case "message": return t(locale, "orchNow_message");
      case "file_changed": return `${t(locale, "orchAct_file_changed")}: ${short(e.text)}`;
      case "file_read": return `${t(locale, "orchAct_file_read")}: ${short(e.text)}`;
      case "subagent": return `${t(locale, "orchAct_subagent")}: ${short(e.text)}`;
      case "check_started": return `${t(locale, "orchAct_check_started")}: ${short(e.text)}`;
      case "process_started": return t(locale, "orchAct_process_started");
      case "process_exited": return t(locale, "orchPhase_finishing");
      default: continue;
    }
  }
  return null;
}

export function permissionReason(locale: LocaleId, p: OrchestrationPermissionRequest): string {
  return p.kind === "tool" ? tr(locale, "orchWait_perm_tool", { tool: short(p.tool, 40) }) : tr(locale, `orchWait_perm_${p.kind}`);
}

// Why a paused, stopped or failed run is where it is: the one classification of runModel (viewCause), in words.
const reasonText = (locale: LocaleId, view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): string | null => {
  const cause = viewCause(view, entries);
  return cause ? causeText(locale, cause) : null;
};

function quietText(locale: LocaleId, state: ActivityState, last: string | null, now: number): string | null {
  if (state !== "working" && state !== "checking" && state !== "starting") return null;
  if (!last) return null;
  const ms = now - Date.parse(last);
  return ms >= QUIET_MS ? tr(locale, "orchNow_quiet", { d: duration(locale, ms) }) : null;
}

// The state of a run that is not moving by itself: waiting for the person, paused, stopping or ended.
function heldState(locale: LocaleId, view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): { state: ActivityState; doing: string; wait: string | null } | null {
  if (view.newer) return { state: "read_only", doing: t(locale, "orchReadOnly"), wait: t(locale, "orchReason_newer_version") };
  if (view.halted) return { state: "waiting_user", doing: t(locale, "orchHeadline_halted"), wait: t(locale, "orchNext_halted") };
  if (view.permission && ["preparing", "running", "pausing"].includes(view.status)) {
    return { state: "waiting_user", doing: tr(locale, "orchNow_needsYou", { who: who(view.permission.role) }), wait: permissionReason(locale, view.permission) };
  }
  if (TERMINAL_STATUSES.includes(view.status)) {
    const key = runStatusKey(view);
    return { state: key as ActivityState, doing: t(locale, `orchHeadline_${key}` as TranslationKey), wait: key === "completed_no_checks" ? t(locale, "orchNoChecksRan") : reasonText(locale, view, entries) };
  }
  if (view.status === "stopping") return { state: "stopping", doing: t(locale, "orchHeadline_stopping"), wait: null };
  if (view.status === "paused") {
    // the one short form of the pause ("Waiting for you: …" / "Paused: …") and its why (runModel PAUSES)
    const label = viewPauseLabel(locale, view, entries);
    const cause = viewCause(view, entries);
    if (label && cause) return { state: PAUSES[view.reason ?? ""]?.you === false ? "paused" : "waiting_user", doing: label, wait: pauseWhy(locale, cause, undefined, view.proposal?.checks.length === 0) };
    const user = runHeadline(view).headline !== "paused";
    return { state: user ? "waiting_user" : "paused", doing: t(locale, `orchHeadline_${headlineKey(view, entries)}` as TranslationKey), wait: reasonText(locale, view, entries) };
  }
  return null;
}

// The run as one line: the widget row.
export function runStatus(locale: LocaleId, input: StatusInput): StatusLine {
  const { view, entries, now } = input;
  const lastEventAt = entries.at(-1)?.ts ?? null;
  const base = { stage: view.stage, lastEventAt };
  const held = heldState(locale, view, entries);
  if (held) return { ...base, ...held, actor: view.permission?.role ?? null, now: null, quiet: null };
  const act = activeDoing(locale, view, input.stageTitles);
  const pausing = view.status === "pausing" ? t(locale, "orchHeadline_stopping_after_turn") : null;
  if (!act) {
    return { ...base, state: "waiting_agent", actor: null, doing: t(locale, "orchNow_between"), now: null, wait: pausing, quiet: null };
  }
  let state: ActivityState = act.checking ? "checking" : "working";
  let nowText: string | null = null;
  if (act.actor === "lead" || act.actor === "executor" || act.actor === "reviewer") {
    const p = participantState(act.actor, view, entries, input.open);
    // starting: the new turn has no events of its own yet — the newest ones belong to the previous turn
    if (p.phase === "starting") state = "starting";
    else nowText = currentAction(locale, entries, act.actor, p.turnId);
  } else if (act.actor === "check") nowText = currentAction(locale, entries, "check", null);
  return { ...base, state, actor: act.actor, doing: act.doing, now: nowText, wait: pausing, quiet: quietText(locale, state, lastEventAt, now) };
}

// One participant as its card says it: its own turn, or what it waits for.
export function roleStatus(locale: LocaleId, role: Role, input: StatusInput): StatusLine {
  const { view, entries, now } = input;
  const mine = entries.filter((e) => e.role === role);
  const lastEventAt = mine.at(-1)?.ts ?? null;
  const base = { stage: view.stage, lastEventAt, actor: role };
  if (view.permission && view.permission.role !== role && ["preparing", "running", "pausing"].includes(view.status) && !view.halted) {
    return { ...base, state: "waiting_agent", doing: tr(locale, "orchNow_waitsFor", { who: who(role) }), now: null,
      wait: tr(locale, "orchNow_otherNeedsYou", { who: who(view.permission.role) }), quiet: null };
  }
  const held = heldState(locale, view, entries);
  if (held) return { ...base, ...held, now: null, quiet: null };
  const act = activeDoing(locale, view, input.stageTitles);
  const pausing = view.status === "pausing" ? t(locale, "orchHeadline_stopping_after_turn") : null;
  if (act && act.actor === role) {
    const p = participantState(role, view, entries, input.open);
    const state: ActivityState = p.phase === "starting" ? "starting" : act.checking ? "checking" : "working";
    const nowText = p.phase === "starting" ? null : currentAction(locale, entries, role, p.turnId);
    return { ...base, state, doing: act.doing, now: nowText, wait: pausing, quiet: quietText(locale, state, lastEventAt, now) };
  }
  // Someone else works: say what this one did last and whom it waits for.
  const p = participantState(role, view, entries, input.open);
  const finishedTurn = p.outcome === "completed" && p.turnId !== null;
  const doing = !finishedTurn ? tr(locale, "orchNow_waitsFor", { who: who(role) })
    // the review is the lead's (v1) or, in journal v2, the reviewer's
    : role === "executor" && (act?.actor === "lead" || act?.actor === "reviewer") && view.active?.kind === "turn" && view.active.purpose === "review"
      ? tr(locale, "orchNow_doneAwaitReview", { who: who(role) })
      : tr(locale, "orchNow_doneTurn", { who: who(role) });
  return { ...base, state: "waiting_agent", doing, now: null, wait: act ? act.doing : t(locale, "orchNow_between"), quiet: null };
}

// Journal v2, A3 (journal-v2-format.md §2.8): "open blocking: N" — the one line the result, the cards and the activity
// feed show; null when the lead reviews (no findings).
export function findingsLine(locale: LocaleId, view: Pick<OrchestrationRunView, "progress">): string | null {
  const f = view.progress?.findings;
  return f ? tr(locale, "orchFindingsOpenBlocking", { n: f.openBlocking }) : null;
}

// A4 (journal-v2-format.md §2.9): what the person decided instead of evidence — dropped conditions and requirements,
// blocking findings made wishes, findings closed by the person. The result never reads cleaner than it is: the one line
// the result and the panel say it with; null when the person decided none of these.
export function personDecisionsLine(locale: LocaleId, view: Pick<OrchestrationRunView, "progress">): string | null {
  const c = view.progress?.conditions;
  const f = view.progress?.findings;
  const dropped = [...(c?.dropped ?? []).map((x) => x.id), ...(c?.requirements ?? []).filter((r) => r.status === "dropped").map((r) => r.id)];
  const downgraded = (f?.items ?? []).filter((x) => x.downgraded).map((x) => x.id);
  const closed = (f?.items ?? []).filter(closedByPerson).map((x) => x.id);
  const parts = [
    dropped.length ? tr(locale, "orchPersonDropped", { ids: dropped.join(", ") }) : null,
    downgraded.length ? tr(locale, "orchPersonDowngraded", { ids: downgraded.join(", ") }) : null,
    closed.length ? tr(locale, "orchPersonClosed", { ids: closed.join(", ") }) : null
  ].filter((x): x is string => x !== null);
  return parts.length ? tr(locale, "orchPersonDecisions", { list: parts.join("; ") }) : null;
}

// Journal v2, A2 (journal-v2-format.md §2.7): "N of M conditions met" — the one line the result, the cards and the
// activity feed show; null without conditions (v1, a plan of A1's form, nothing planned yet).
export function conditionsLine(locale: LocaleId, view: Pick<OrchestrationRunView, "progress">): string | null {
  const c = view.progress?.conditions;
  return c && c.total > 0 ? tr(locale, "orchConditionsCount", { met: c.met, total: c.total }) : null;
}

export function stateLabel(locale: LocaleId, state: ActivityState): string {
  return t(locale, `orchState_${state}` as TranslationKey);
}

// ---------- the run summary ----------

export interface TextRef { sha256: string; bytes: number }
const isRef = (v: unknown): v is TextRef => !!v && typeof (v as TextRef).sha256 === "string" && typeof (v as TextRef).bytes === "number";

export type StageState = "done" | "not_done" | "not_checked" | "not_started";
export interface SummaryStage {
  n: number;
  plan: number | null; // the plan version the stage belongs to (null: a journal without plans)
  title: string | null;
  state: StageState;
  rounds: number;
  verdict: string | null; // the lead's last review verdict of the stage
  report: TextRef | null; // the executor's last report for the stage (its claim)
  findings: TextRef | null; // the lead's last findings for the stage
}
// A review of the lead. current: the latest word on a stage that is still open; replaced: a later review of the same
// stage came; closed: the stage was accepted afterwards; superseded: the stage was replaced by a new plan; final: the
// final review.
export type ReviewState = "current" | "replaced" | "closed" | "superseded" | "final";
export interface SummaryReview { seq: number; stage: number | null; plan: number | null; title: string | null; verdict: string | null; findings: TextRef | null; report: TextRef | null; state: ReviewState }
export interface SummaryCheck { id: string; title: string; status: string; runs: number }
export interface RunSummaryModel {
  goal: TextRef | null;
  stages: SummaryStage[] | null; // the stages of the plan in force (and accepted ones of earlier plans); null: no plan
  superseded: SummaryStage[]; // unaccepted stages a later plan replaced, with their own plan version
  stageCounts: { done: number; total: number } | null;
  checks: SummaryCheck[]; // check commands, the latest result of each (not tests)
  checkCounts: { passed: number; total: number };
  checksKnown: boolean; // the full set of required commands is known (else only the ones seen in the journal)
  reviews: SummaryReview[];
  currentReview: SummaryReview | null; // the newest review whose remarks are still open
  openQuestion: TextRef | null; // asked by the lead, not answered yet
  finalVerdict: string | null;
  finalReport: TextRef | null;
  finalFindings: TextRef | null;
  lastReport: TextRef | null;
  finish: OrchestrationRunProgress["finish"] | null; // null: the journal predates the actions after success
  checkpoint: { stage: number; commit: string } | null;
  endedAt: string | null;
  complete: boolean; // the whole journal was read: an absence is a fact, not a gap
}
export interface SummaryOptions {
  complete?: boolean; // false: records after the last one read may exist (loading or a failed page); default true
  planTitles?: (planSha256: string) => readonly string[] | null; // a plan's stage titles, in its order
  goalCommands?: readonly string[] | null; // the goal's check command lines (checks[i] is cmd-(i+1))
}

// Stage titles by global stage number: each plan names the stages from its firstStage on; accepted stages keep the
// title of the plan they were done under. A plan whose text is not loaded leaves its stages unnamed (never an older
// plan's title for a new task with the same number).
export type StageTitles = Readonly<Record<number, string>>;
export function stageTitleMap(records: readonly OrchestrationHistoryRecord[], planTitles: (planSha256: string) => readonly string[] | null): StageTitles {
  const out: Record<number, string> = {};
  for (const r of records) {
    if (r.type !== "plan.recorded") continue;
    const d = r.data as Record<string, any>;
    const first = typeof d.firstStage === "number" ? d.firstStage : 1;
    for (const k of Object.keys(out)) if (Number(k) >= first) delete out[Number(k)];
    const titles = isRef(d.plan) ? planTitles(d.plan.sha256) : null;
    titles?.forEach((title, i) => { out[first + i] = title; });
  }
  return out;
}

// Folded over the journal records only: what the application itself recorded.
export function summaryModel(view: OrchestrationRunView | null, records: readonly OrchestrationHistoryRecord[], opts: SummaryOptions | null = null): RunSummaryModel {
  const turns = new Map<string, { purpose: string; stage: number | null }>();
  const turnReports = new Map<string, TextRef>();
  const stages = new Map<number, SummaryStage>();
  const reviewsOf = new Map<SummaryStage, SummaryReview[]>();
  const reviews: SummaryReview[] = [];
  const superseded: SummaryStage[] = [];
  let planVersion: number | null = null;
  let hadPlan = false;
  let lastReviewReport: TextRef | null = null;
  // the final review in force: a new plan supersedes it, a later review replaces it
  let finalRv: SummaryReview | null = null;
  const dropFinal = (state: ReviewState) => {
    if (finalRv) finalRv.state = state;
    finalRv = null;
    out.finalVerdict = null; out.finalReport = null; out.finalFindings = null;
  };
  const stageOf = (n: number): SummaryStage => {
    let s = stages.get(n);
    if (!s) stages.set(n, (s = { n, plan: planVersion, title: null, state: "not_started", rounds: 0, verdict: null, report: null, findings: null }));
    return s;
  };
  const checks = new Map<string, SummaryCheck>();
  const fromMain = view?.progress?.checks ?? null;
  const commands = opts?.goalCommands ?? null;
  // The full list first: main's progress (every required command), else the goal's command lines.
  if (fromMain) for (const c of fromMain) checks.set(c.id, { id: c.id, title: c.title, status: c.status, runs: 0 });
  else if (commands) commands.forEach((line, i) => checks.set(`cmd-${i + 1}`, { id: `cmd-${i + 1}`, title: line, status: "not_run", runs: 0 }));
  const checksKnown = !!fromMain || !!commands;
  const checkRuns = new Map<string, string>();
  const asked = new Map<string, TextRef>();
  const out: RunSummaryModel = {
    goal: null, stages: null, superseded, stageCounts: null, checks: [], checkCounts: { passed: 0, total: 0 }, checksKnown,
    reviews, currentReview: null, openQuestion: null, finalVerdict: null, finalReport: null, finalFindings: null, lastReport: null,
    finish: view?.progress?.finish ?? null, checkpoint: null, endedAt: null, complete: opts?.complete ?? true
  };
  for (const r of records) {
    const d = r.data as Record<string, any>;
    switch (r.type) {
      case "run.created": out.goal = isRef(d.goal) ? d.goal : null; break;
      case "plan.recorded": {
        hadPlan = true;
        planVersion = typeof d.version === "number" ? d.version : (planVersion ?? 0) + 1;
        const first = typeof d.firstStage === "number" ? d.firstStage : 1;
        const count = typeof d.stageCount === "number" ? d.stageCount : 0;
        dropFinal("superseded"); // a final review asking for a replan (or any before this plan) belongs to the old plan
        // the stages the new plan takes over and that were not accepted: moved aside with their own reviews
        for (const [n, s] of [...stages]) {
          if (n < first || s.state === "done") continue;
          stages.delete(n);
          if (s.report && s.report === out.lastReport) out.lastReport = null; // not the current plan's work
          if (s.state !== "not_started") superseded.push(s);
          for (const rv of reviewsOf.get(s) ?? []) if (rv.state === "current" || rv.state === "replaced") rv.state = "superseded";
        }
        const titles = isRef(d.plan) ? opts?.planTitles?.(d.plan.sha256) ?? null : null;
        for (let n = first; n < first + count; n++) stageOf(n).title = titles?.[n - first] ?? null;
        break;
      }
      case "orch.turn":
        turns.set(d.turnId, { purpose: d.purpose, stage: typeof d.stage === "number" ? d.stage : null });
        if (d.purpose === "execute" && typeof d.stage === "number") { const s = stageOf(d.stage); s.rounds += 1; if (s.state === "not_started") s.state = "not_checked"; }
        break;
      case "turn.finished": {
        const turn = turns.get(d.turnId);
        const ref = d.outcome === "completed" && isRef(d.report?.ref) ? d.report.ref : null;
        if (!turn || !ref) break;
        turnReports.set(d.turnId, ref);
        if (turn.purpose === "execute" && turn.stage !== null) { stageOf(turn.stage).report = ref; out.lastReport = ref; }
        if (turn.purpose === "review" || turn.purpose === "final_review") lastReviewReport = ref;
        if (turn.purpose === "final_review") { if (finalRv) dropFinal("replaced"); out.finalReport = ref; }
        break;
      }
      // A3: the reviewer's result has no verdict — the application decides the stage; the final review with request none
      // is the run's "complete" (its findings are the Findings section's)
      case "review.assessed":
      case "review.recorded": {
        const verdict: string | null = r.type === "review.assessed" ? (d.request === "none" ? (typeof d.stage === "number" ? "assessed" : "complete") : d.request) : d.verdict ?? null;
        const report = (typeof d.turnId === "string" ? turnReports.get(d.turnId) : undefined) ?? lastReviewReport;
        const findings = isRef(d.findings) ? d.findings : null;
        if (typeof d.stage === "number") {
          const s = stageOf(d.stage);
          s.verdict = verdict;
          s.findings = findings;
          if (s.state !== "done") s.state = "not_done";
          if (finalRv) dropFinal("replaced"); // a stage reviewed after the final review: the newer word stands
          const list = reviewsOf.get(s) ?? [];
          for (const rv of list) if (rv.state === "current") rv.state = "replaced";
          const rv: SummaryReview = { seq: r.seq, stage: d.stage, plan: s.plan, title: s.title, verdict, findings, report, state: "current" };
          list.push(rv);
          reviewsOf.set(s, list);
          reviews.push(rv);
        } else {
          if (finalRv) { finalRv.state = "replaced"; out.finalReport = report; }
          out.finalVerdict = verdict;
          out.finalFindings = findings;
          finalRv = { seq: r.seq, stage: null, plan: planVersion, title: null, verdict, findings, report, state: "final" };
          reviews.push(finalRv);
        }
        break;
      }
      case "stage.accepted":
        if (typeof d.stage === "number") {
          const s = stageOf(d.stage);
          s.state = "done";
          for (const rv of reviewsOf.get(s) ?? []) if (rv.state === "current") rv.state = "closed";
        }
        break;
      case "question.asked": if (typeof d.questionId === "string" && isRef(d.text)) asked.set(d.questionId, d.text); break;
      case "question.answered": asked.delete(d.questionId); break;
      case "checkpoint.created": if (typeof d.stage === "number" && typeof d.commit === "string") out.checkpoint = { stage: d.stage, commit: d.commit }; break;
      case "check.started": {
        checkRuns.set(d.checkRunId, d.checkId);
        const c = checks.get(d.checkId) ?? { id: d.checkId, title: d.checkId, status: "running", runs: 0 };
        c.runs += 1;
        if (!fromMain) c.status = "running";
        checks.set(d.checkId, c);
        break;
      }
      // main's status is the assessed one; the journal's own only when main has none
      case "check.finished": { const c = checks.get(checkRuns.get(d.checkRunId) ?? ""); if (c && !fromMain?.some((x) => x.id === c.id)) c.status = d.status ?? "unknown"; break; }
      case "run.status": if (TERMINAL_STATUSES.includes(d.status)) out.endedAt = r.ts; break;
    }
  }
  if (stages.size || hadPlan) {
    out.stages = [...stages.values()].sort((a, b) => a.n - b.n);
    if (hadPlan) out.stageCounts = { done: out.stages.filter((s) => s.state === "done").length, total: out.stages.length };
  }
  out.currentReview = [...reviews].reverse().find((rv) => rv.state === "current") ?? null;
  out.openQuestion = [...asked.values()].at(-1) ?? null;
  out.checks = [...checks.values()];
  out.checkCounts = { passed: out.checks.filter((c) => c.status === "passed").length, total: out.checks.length };
  return out;
}

// A stored report read as plain parts: a structured answer is never shown as JSON.
export interface ReportParts { summary: string | null; done: boolean | null; verdict: string | null; findings: string[]; question: string | null; next: string | null; other: [string, string][]; text: string | null }
export function reportParts(text: string): ReportParts {
  const out: ReportParts = { summary: null, done: null, verdict: null, findings: [], question: null, next: null, other: [], text: null };
  let v: unknown;
  try { v = JSON.parse(text); } catch { out.text = text; return out; }
  const str = (x: unknown): string => (typeof x === "string" ? x : JSON.stringify(x));
  if (Array.isArray(v)) { out.findings = v.map(str); return out; }
  if (!v || typeof v !== "object") { out.text = str(v); return out; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === null || x === undefined) continue;
    if (k === "summary" && typeof x === "string") out.summary = x;
    else if (k === "done" && typeof x === "boolean") out.done = x;
    else if (k === "verdict" && typeof x === "string") out.verdict = x;
    // A3: a reviewer's finding is said by its problem
    else if (k === "findings" && Array.isArray(x)) out.findings = x.map((f) => (f && typeof f === "object" && "problem" in f ? str((f as { problem: unknown }).problem) : str(f)));
    else if (k === "question") out.question = str(x);
    else if (["next", "nextStep", "next_step", "nextSteps", "next_steps"].includes(k)) out.next = Array.isArray(x) ? x.map(str).join("\n") : str(x);
    // the plan's stages and the lead's marks of conditions and requirements are shown by their own sections (A2)
    else if (!["stages", "conditions", "requirements", "dropped", "dropRequirements", "request"].includes(k)) out.other.push([k, str(x)]);
  }
  return out;
}

// The outcome in one sentence, apart for each end: never "done" for a run that did not reach its goal.
// complete: the whole journal was read. A completed run whose final review is not read yet is said as such — never as
// a final review that did not confirm the goal.
export function outcomeKey(view: OrchestrationRunView, finalVerdict: string | null, complete = true): string {
  if (runStatusKey(view) === "completed_no_checks") return "completed_no_checks"; // never "completed": no check ran
  if (view.status === "completed") return finalVerdict === "complete" ? "completed" : complete ? "completed_unconfirmed" : "completed_unloaded";
  if (view.status === "stopped" || view.status === "failed") return view.status;
  if (view.status === "paused" || view.halted) return "paused";
  return "active";
}

export const finishText = (locale: LocaleId, f: OrchestrationRunProgress["finish"][number]): string =>
  f.asked ? tr(locale, `orchFinishStatus_${finishStatus(f)}`) : t(locale, "orchFinishNotAsked");

// ---------- reading a run's journal ----------

// The run's journal as read so far (pages from the start, then the newer records as the run's seq grows).
// ready: everything the journal held at the last read; loading: pages still to read; error: a read failed — the records
// kept are a correct prefix but incomplete.
export interface RunJournalState { records: OrchestrationHistoryRecord[]; next: number; status: "loading" | "ready" | "error" }
type HistoryPage = { ok: true; value: { records: OrchestrationHistoryRecord[]; more: boolean } } | { ok: false };
// Reads from what is already held on (a retry continues after the last record read: no record twice, nothing else asked).
export async function readJournal(history: (fromSeq: number) => Promise<HistoryPage>, current: () => RunJournalState,
  put: (j: RunJournalState) => void, maxPages = 100): Promise<void> {
  for (let i = 0; i < maxPages; i++) {
    const cur = current();
    const r = await history(cur.next).catch(() => null);
    if (!r?.ok) { put({ ...cur, status: "error" }); return; }
    const page = r.value.records.filter((rec) => rec.seq >= cur.next);
    put({ records: page.length ? [...cur.records, ...page] : cur.records, next: page.length ? page.at(-1)!.seq + 1 : cur.next, status: r.value.more ? "loading" : "ready" });
    if (!r.value.more) return;
  }
}

// ---------- the home widget ----------

export interface ActivityRunRow {
  linkId: string;
  runId: string;
  project: string; // the lead card's folder name
  projectPath: string;
  load: "loading" | "error" | "ready";
  line: StatusLine | null; // null while the run's state is not loaded
  conditions: string | null; // A2: conditionsLine
  findings: string | null; // A3: findingsLine
  roles: { role: Role; line: StatusLine }[];
  ended: boolean;
  at: string | null; // the newest known event, for the order
}
export interface ActivityRunsInput {
  links: readonly { linkId: string; fromAgentId: string; runIds: readonly string[] }[];
  agents: readonly { agentId: string; project: string }[];
  runs: Readonly<Record<string, { view: OrchestrationRunView; open: boolean }>>;
  entries: (runId: string) => readonly OrchestrationActivityEntry[];
  lastRecordAt: (runId: string) => string | null;
  runErrors: Readonly<Record<string, true>>;
  stageTitles: (runId: string) => StageTitles | null;
  now: number;
}

// One row per run (the latest run of each link), never one per participant; the participants are inside it. Ended
// runs go to the recent results, newest first.
export function activityRuns(locale: LocaleId, input: ActivityRunsInput, recentLimit = 3): { active: ActivityRunRow[]; recent: ActivityRunRow[] } {
  const seen = new Set<string>();
  const rows: ActivityRunRow[] = [];
  for (const link of input.links) {
    const runId = link.runIds.at(-1);
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    const projectPath = input.agents.find((a) => a.agentId === link.fromAgentId)?.project ?? "";
    const project = projectPath.split("/").filter(Boolean).at(-1) ?? projectPath;
    const run = input.runs[runId];
    const base = { linkId: link.linkId, runId, project, projectPath };
    if (!run) {
      rows.push({ ...base, load: input.runErrors[runId] ? "error" : "loading", line: null, conditions: null, findings: null, roles: [], ended: false, at: null });
      continue;
    }
    const s: StatusInput = { view: run.view, entries: input.entries(runId), open: run.open, stageTitles: input.stageTitles(runId), now: input.now };
    const line = runStatus(locale, s);
    rows.push({
      ...base, load: "ready", line, conditions: conditionsLine(locale, run.view), findings: findingsLine(locale, run.view), ended: TERMINAL_STATUSES.includes(run.view.status),
      roles: (byReviewer(run.view) ? ["lead", "executor", "reviewer"] as const : ["lead", "executor"] as const).map((role) => ({ role, line: roleStatus(locale, role, s) })),
      at: [line.lastEventAt, input.lastRecordAt(runId)].filter((x): x is string => !!x).sort().at(-1) ?? null
    });
  }
  const newest = (a: ActivityRunRow, b: ActivityRunRow) => (b.at ?? "").localeCompare(a.at ?? "");
  return { active: rows.filter((r) => !r.ended).sort(newest), recent: rows.filter((r) => r.ended).sort(newest).slice(0, recentLimit) };
}
