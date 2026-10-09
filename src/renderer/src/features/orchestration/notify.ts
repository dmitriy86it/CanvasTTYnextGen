// Notifications and the Dock badge (UX audit PR 3): which run states tell the person, once per change of state.
// Pure: the caller passes the runs it watches, what was notified before (kept outside the journal, across restarts)
// and whether the window has the focus; it gets back what to show, the badge and the new record. Tested under node.
import type { OrchestrationActivityEntry, OrchestrationRunView } from "../../../../shared/orchestration.ts";
import type { LocaleId, NotificationSettings } from "../../../../shared/contracts.ts";
import { t } from "../../lib/i18n.ts";
import { PAUSES, viewPauseLabel } from "./runModel.ts";

export type NotifySignal = "waiting" | "completed" | "completed_no_checks" | "failed";
export type NotifyPrefs = NotificationSettings;
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { waiting: true, completed: true, failed: true, dockBadge: true, bounce: false };

// The state a notification is about, with what tells one state from another ("" — nothing to tell).
export function runSignal(view: OrchestrationRunView, onMac = true): { signal: NotifySignal; key: string } | null {
  if (view.permission) return { signal: "waiting", key: `waiting:permission:${view.permission.requestId}` };
  // the pauses the chip calls «Ждёт вас: …» (runModel PAUSES[reason].you), not «Пауза: …»
  if (view.status === "paused" && view.reason && PAUSES[view.reason]?.you !== false && viewPauseLabel("en", view, [], onMac) !== null)
    return { signal: "waiting", key: `waiting:${view.reason}` };
  if (view.status === "completed") return view.progress?.completion === "no_checks" ? { signal: "completed_no_checks", key: "completed_no_checks" } : { signal: "completed", key: "completed" };
  if (view.status === "failed") return { signal: "failed", key: "failed" };
  return null;
}

export interface NotifyRun { runId: string; view: OrchestrationRunView; place: string; entries?: readonly OrchestrationActivityEntry[] }
export interface Note { runId: string; signal: NotifySignal; title: string; body: string }
export interface NotifyStep { notes: Note[]; badge: number; bounce: boolean; notified: Record<string, string> }

// notified: the last state told per run ("" — none; absent — a run not seen before this record existed).
// A run seen for the first time without a record (older runs after an update) is only recorded, never told.
// accepting (B3, owner's decision 10): the board's tasks waiting for «Accept the result» — the person's too, on the badge.
export function notifyStep(locale: LocaleId, runs: readonly NotifyRun[], notified: Readonly<Record<string, string>>, prefs: NotifyPrefs, focused: boolean, onMac = true, accepting = 0): NotifyStep {
  const next: Record<string, string> = { ...notified };
  const notes: Note[] = [];
  let badge = 0;
  let bounce = false;
  for (const r of runs) {
    const s = runSignal(r.view, onMac);
    if (s?.signal === "waiting") badge++;
    const before = notified[r.runId];
    next[r.runId] = s?.key ?? "";
    if (!s || before === undefined || before === s.key) continue;
    if (s.signal === "waiting" && prefs.bounce && !focused) bounce = true;
    if (focused || !prefs[s.signal === "completed_no_checks" ? "completed" : s.signal]) continue;
    notes.push({ runId: r.runId, signal: s.signal, title: r.place, body: noteBody(locale, s.signal, r) });
  }
  return { notes, badge: prefs.dockBadge ? badge + accepting : 0, bounce, notified: next };
}

// The short reason only: never a path, a command or a file's text.
function noteBody(locale: LocaleId, signal: NotifySignal, r: NotifyRun): string {
  if (signal !== "waiting") return t(locale, `orchNotify_${signal}`);
  if (r.view.permission) return t(locale, "orchNotify_permission");
  return viewPauseLabel(locale, r.view, r.entries ?? []) ?? t(locale, "orchNotify_permission");
}

// The record kept between launches: bounded, so runs deleted long ago do not pile up.
export function pruneNotified(notified: Readonly<Record<string, string>>, keep = 500): Record<string, string> {
  const entries = Object.entries(notified);
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - keep)));
}

// Set when macOS refused to show a notification (no permission, an unsigned build): the settings say how to allow
// them, and the window shows its own banner meanwhile. Cleared once a notification is shown again.
export const NOTIFY_UNAVAILABLE_KEY = "orch.notify.unavailable";
export const NOTIFIED_KEY = "orch.notified.v1";
