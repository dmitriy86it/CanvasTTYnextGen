// Notifications and the Dock badge for the runs this window watches (every link's latest run, in every workspace).
// What to tell is notify.ts; here it reaches macOS (main shows it) or, where macOS shows nothing, a banner in the window.
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocaleId, NotificationSettings } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import { NOTIFIED_KEY, NOTIFY_UNAVAILABLE_KEY, notifyStep, pruneNotified, type Note } from "./notify";
import type { RunActivityState, RunState } from "./useOrchestration";

const store = {
  read(): Record<string, string> {
    try { const v = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
  },
  write(v: Record<string, string>): void { try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(pruneNotified(v))); } catch { /* not kept: at worst one repeat after a restart */ } },
  unavailable(): boolean { try { return localStorage.getItem(NOTIFY_UNAVAILABLE_KEY) === "1"; } catch { return false; } },
  setUnavailable(): void { try { localStorage.setItem(NOTIFY_UNAVAILABLE_KEY, "1"); } catch { /* the banner still shows */ } }
};

export function useRunNotifications({ locale, prefs, runs, activity, title, open, accepting = 0 }: {
  locale: LocaleId; prefs: NotificationSettings; runs: Record<string, RunState>; activity: Record<string, RunActivityState>;
  title(runId: string): string; open(runId: string): void;
  accepting?: number; // the board's tasks waiting for «Accept the result» (counted on the badge)
}): { banner: Note[]; openNote(runId: string): void; dismiss(runId: string): void } {
  const notified = useRef<Record<string, string> | null>(null);
  const badge = useRef<number | null>(null);
  const [banner, setBanner] = useState<Note[]>([]);
  const shown = useRef(new Map<string, Note>());
  const toBanner = useCallback((n: Note) => setBanner((b) => [...b.filter((x) => x.runId !== n.runId), n]), []);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    notified.current ??= store.read();
    const list = Object.entries(runs).map(([runId, r]) => ({ runId, view: r.view, place: title(runId), entries: activity[runId]?.entries ?? [] }));
    const step = notifyStep(locale, list, notified.current, prefs, document.hasFocus() && !document.hidden, true, accepting);
    notified.current = step.notified;
    store.write(step.notified);
    if (badge.current !== step.badge) { badge.current = step.badge; window.canvasTTY.notify.setBadge(step.badge); }
    if (step.bounce) window.canvasTTY.notify.bounce();
    for (const n of step.notes) {
      if (store.unavailable()) { toBanner(n); continue; }
      shown.current.set(n.runId, n);
      void window.canvasTTY.notify.show(n).then((r) => { if (!r.shown) { store.setUnavailable(); toBanner(n); } }, () => toBanner(n));
    }
  }, [accepting, activity, locale, prefs, runs, title, toBanner]);

  useEffect(() => {
    const offClick = window.canvasTTY.notify.onClick((runId) => openRef.current(runId));
    // macOS refused it (no permission, an ad-hoc signed build): the settings say how to allow them; the banner meanwhile
    const offFailed = window.canvasTTY.notify.onFailed((runId) => { store.setUnavailable(); const n = shown.current.get(runId); if (n) toBanner(n); });
    return () => { offClick(); offFailed(); };
  }, [toBanner]);

  const dismiss = useCallback((runId: string) => setBanner((b) => b.filter((x) => x.runId !== runId)), []);
  return { banner, dismiss, openNote: useCallback((runId: string) => { dismiss(runId); openRef.current(runId); }, [dismiss]) };
}

export function NotifyBanner({ locale, notes, onOpen, onDismiss }: { locale: LocaleId; notes: Note[]; onOpen(runId: string): void; onDismiss(runId: string): void }): React.JSX.Element | null {
  if (!notes.length) return null;
  return (
    <div className="notify-banner" role="status" data-interactive="true" data-notify-banner>
      {notes.map((n) => (
        <div key={n.runId} className={`notify-banner__item notify-banner__item--${n.signal}`} data-notify-run={n.runId}>
          <span><b>{n.title}</b> {n.body}</span>
          <button type="button" onClick={() => onOpen(n.runId)}>{t(locale, "orchNotifyBannerOpen")}</button>
          <button type="button" aria-label={t(locale, "orchNotifyBannerClose")} onClick={() => onDismiss(n.runId)}>×</button>
        </div>
      ))}
    </div>
  );
}
