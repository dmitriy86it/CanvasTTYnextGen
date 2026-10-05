// An app started from Finder or the Dock gets no LANG, LC_CTYPE or LC_ALL, and every process it starts inherits that:
// a CLI in a terminal card (Claude Code, Codex: started directly, not through a login shell) or its pbcopy then reads
// UTF-8 as Mac Roman, and "Этап 0" is copied as "–≠—В–∞–њ 0". A login shell gets LANG=C.UTF-8 from /etc/zprofile, a
// directly started CLI does not. So the main process sets one UTF-8 LANG at startup, before anything is spawned, and
// terminals, agent CLIs, the login shell of the runs, preparation, checks and the supervisor all inherit it. Only the
// encoding changes; a value the person set is never overwritten.
import { execFileSync } from "node:child_process";

const UTF8 = /\.utf-?8(@|$)/i;

export interface LocaleChoice { lang: string | null; warning: string | null }

// The locale the C library uses for characters: LC_ALL, then LC_CTYPE, then LANG (empty counts as unset).
export function utf8LocaleFor(
  env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform, systemLocale: string | null, available: readonly string[]
): LocaleChoice {
  if (platform === "win32") return { lang: null, warning: null };
  const name = (["LC_ALL", "LC_CTYPE", "LANG"] as const).find((n) => env[n]);
  if (name) {
    return UTF8.test(env[name]!) ? { lang: null, warning: null }
      : { lang: null, warning: `${name}=${env[name]} is not UTF-8: text copied from terminals (Cyrillic, box drawing) may be garbled` };
  }
  if (platform !== "darwin") return { lang: "C.UTF-8", warning: null };
  // AppleLocale "ru_RU", "ru-RU" or "en_US@rg=ruzzzz" → ru_RU.UTF-8, if this system has it
  const base = systemLocale?.split("@")[0].replace("-", "_");
  const wanted = base ? `${base}.UTF-8` : null;
  return { lang: wanted && available.includes(wanted) ? wanted : "en_US.UTF-8", warning: null };
}

export function ensureUtf8Locale(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LocaleChoice {
  const read = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 2000 }).trim(); } catch { return ""; } };
  const unset = !env.LC_ALL && !env.LC_CTYPE && !env.LANG;
  const choice = utf8LocaleFor(env, platform,
    unset && platform === "darwin" ? read("/usr/bin/defaults", ["read", "-g", "AppleLocale"]) || null : null,
    unset && platform === "darwin" ? read("/usr/bin/locale", ["-a"]).split("\n") : []);
  if (choice.lang) env.LANG = choice.lang;
  if (choice.warning) console.warn(`[locale] ${choice.warning}`);
  return choice;
}
