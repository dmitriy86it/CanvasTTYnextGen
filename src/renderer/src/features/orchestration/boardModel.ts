// B2: the words of the board (stage-b-board.md §4.3, §6), apart from the card so they are tested without a window.
import type { LocaleId } from "../../../../shared/contracts.ts";
import type { TaskStatus } from "../../../../shared/taskBoard.ts";
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

