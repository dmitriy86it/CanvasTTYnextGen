// B2: the words of the board (stage-b-board.md §4.3, §6), apart from the card so they are tested without a window.
import type { LocaleId } from "../../../../shared/contracts.ts";
import type { OrchestrationActivityEntry, OrchestrationPermissionRequest } from "../../../../shared/orchestration.ts";
import type { AutopilotStop, TaskStatus } from "../../../../shared/taskBoard.ts";
import { t, type TranslationKey } from "../../lib/i18n.ts";
import { runStatus } from "./runStatus.ts";

export const tr = (locale: LocaleId, key: string, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(locale, key as TranslationKey) ?? key);

// One line of a task: «Done» of either kind, else the reason (§4.3), else what its run does now, else «not started».
type RunInput = Pick<Parameters<typeof runStatus>[1], "view" | "entries" | "open">;
export function taskLine(locale: LocaleId, status: TaskStatus, run: RunInput | null, limit: string | null): string {
  if (status.done) return t(locale, status.done === "accepted" ? "boardDone_accepted" : "boardDone_confirmed");
  const keys = status.waitsFor.join(", ");
  if (status.reason === "waits_task" && status.cycle) return tr(locale, "boardReason_cycle", { keys });
  if (status.reason === "limit_reached" && limit) return `${t(locale, "boardReason_limit_reached")}: ${t(locale, `orchLimit_${limit}` as TranslationKey) ?? limit}`;
  if (status.reason) return tr(locale, `boardReason_${status.reason}`, { keys, n: status.attempts });
  if (run && (status.column === "work" || status.column === "review")) return runStatus(locale, { ...run, stageTitles: null, now: Date.now() }).doing;
  return t(locale, "boardNotStarted");
}


// «Waits for a permission: <what>» with the CLI's own reason (§5.3 п. 4), as it said it — never retold
export function permissionLine(locale: LocaleId, base: string, permission: Pick<OrchestrationPermissionRequest, "summary" | "why"> | null | undefined): string {
  if (!permission) return base;
  const why = permission.why?.text || permission.why?.type;
  return `${base}: ${permission.summary}${why ? ` (${t(locale, "orchCliWhy")}: ${why})` : ""}`;
}

// The person's permission prompts in a run (§5.3 п. 3): shown, never a ground for a decision. Questions, plans and
// forms are not about rights; the host's own answers (permission_applied) are not prompts.
export const ASKS_HINT_OVER = 3; // the read-only button's threshold (readOnly.asks > 3)
const RIGHTS = new Set(["command", "file_change", "permissions", "tool"]);
export function askCount(entries: readonly OrchestrationActivityEntry[]): number {
  return entries.filter((e) => e.kind === "permission_requested" && RIGHTS.has(String(e.detail?.kind))).length;
}

// B4: why the board's autopilot stopped, in the person's words (the tasks it left waiting with their own reasons)
export function stopText(locale: LocaleId, stop: AutopilotStop): string {
  const waiting = (stop.waiting ?? []).map((w) => `${w.key} — ${w.reason ? tr(locale, `boardReason_${w.reason}`, { keys: w.waitsFor.join(", "), n: 0 }) : t(locale, "boardNotStarted")}`).join("; ");
  return tr(locale, `boardApStop_${stop.code}`, { key: stop.key ?? "", detail: stop.detail ?? "", waiting });
}
