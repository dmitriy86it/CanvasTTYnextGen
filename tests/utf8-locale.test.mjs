import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ensureUtf8Locale, utf8LocaleFor } from "../src/main/services/utf8Locale.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = { skip: process.platform !== "darwin" && "pbcopy is macOS only" };
const TEXT = "Этап 0 ┌─┐│";
const AVAILABLE = ["C", "en_US.UTF-8", "ru_RU.UTF-8", "ru_RU.KOI8-R"];

test("no locale at all (an app started from Finder): LANG becomes the system locale in UTF-8, else en_US.UTF-8; Linux C.UTF-8; Windows untouched", () => {
  assert.deepEqual(utf8LocaleFor({}, "darwin", "ru_RU", AVAILABLE), { lang: "ru_RU.UTF-8", warning: null });
  assert.deepEqual(utf8LocaleFor({}, "darwin", "ru-RU", AVAILABLE).lang, "ru_RU.UTF-8");
  assert.deepEqual(utf8LocaleFor({}, "darwin", "en_US@rg=ruzzzz", AVAILABLE).lang, "en_US.UTF-8");
  assert.equal(utf8LocaleFor({}, "darwin", "xx_YY", AVAILABLE).lang, "en_US.UTF-8", "not in locale -a");
  assert.equal(utf8LocaleFor({}, "darwin", null, AVAILABLE).lang, "en_US.UTF-8");
  assert.equal(utf8LocaleFor({ LANG: "" }, "darwin", "ru_RU", AVAILABLE).lang, "ru_RU.UTF-8", "empty counts as unset");
  assert.equal(utf8LocaleFor({}, "linux", null, []).lang, "C.UTF-8");
  assert.deepEqual(utf8LocaleFor({}, "win32", null, []), { lang: null, warning: null });
});

test("the person's values are kept: a UTF-8 LANG or LC_CTYPE as is; an explicit LC_ALL=C or a non-UTF-8 LANG untouched, with a warning", () => {
  assert.deepEqual(utf8LocaleFor({ LANG: "de_DE.UTF-8" }, "darwin", "ru_RU", AVAILABLE), { lang: null, warning: null });
  assert.deepEqual(utf8LocaleFor({ LC_CTYPE: "UTF-8" }, "darwin", "ru_RU", AVAILABLE).lang, null);
  assert.deepEqual(utf8LocaleFor({ LANG: "C.utf8" }, "linux", null, []).lang, null);
  const c = utf8LocaleFor({ LC_ALL: "C", LANG: "ru_RU.UTF-8" }, "darwin", "ru_RU", AVAILABLE);
  assert.equal(c.lang, null);
  assert.match(c.warning, /^LC_ALL=C is not UTF-8/);
  assert.match(utf8LocaleFor({ LANG: "ru_RU.KOI8-R" }, "darwin", "ru_RU", AVAILABLE).warning, /^LANG=ru_RU.KOI8-R is not UTF-8/);
  const env = { LC_ALL: "C" };
  ensureUtf8Locale(env, "darwin");
  assert.deepEqual(env, { LC_ALL: "C" }, "never overwritten");
});

test("macOS: pbcopy and pbpaste in the app's environment keep «Этап 0» and box drawing byte for byte", MAC, () => {
  const bare = { PATH: "/usr/bin:/bin", HOME: process.env.HOME };
  const utf8 = { ...bare, LANG: "en_US.UTF-8" };
  const saved = execFileSync("/usr/bin/pbpaste", { env: utf8 });
  try {
    const copied = (env) => { execFileSync("/usr/bin/pbcopy", { input: TEXT, env }); return execFileSync("/usr/bin/pbpaste", { env: utf8 }); };
    assert.notDeepEqual(copied(bare), Buffer.from(TEXT), "without a locale pbcopy reads UTF-8 as Mac Roman (the bug)");
    const env = { ...bare };
    ensureUtf8Locale(env, "darwin");
    assert.match(env.LANG, /\.UTF-8$/);
    assert.deepEqual(copied(env), Buffer.from(TEXT));
  } finally {
    execFileSync("/usr/bin/pbcopy", { input: saved, env: utf8 });
  }
});

test("the main process sets the locale before anything is spawned; xterm selects over a mouse-tracking TUI with ⌥", () => {
  const main = fs.readFileSync(path.join(HERE, "..", "src", "main", "index.ts"), "utf8");
  const at = main.indexOf("\nensureUtf8Locale();");
  assert.ok(at > 0 && at < main.indexOf("app.requestSingleInstanceLock()") && at < main.indexOf("new TerminalManager("), "called at startup, at top level");
  const card = fs.readFileSync(path.join(HERE, "..", "src", "renderer", "src", "features", "terminal", "TerminalCard.tsx"), "utf8");
  assert.match(card, /macOptionClickForcesSelection: true/);
});
