// F-1 (real series N/L, evidence/real-stage-13/README.md): a Laravel project has a package.json for its front end and
// no JS lock file. The suggested preparation ran `npm install`, which the PHP tests do not need (12 s) and which wrote a
// new package-lock.json into the person's project. Preparation must not install there, and everything else about
// dependencies stays: a lock without node_modules is installed, a changed lock is installed again, the separate copy
// never writes into the project's node_modules. Fake CLIs and fake programs only (npm, composer, php count their runs).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { lockFingerprints, neededSteps, suggestPrepare } from "../src/main/services/orchestration/prepare.ts";
import { createProfileStore } from "../src/main/services/orchestration/profile.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-prepare-deps-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = await fn(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}
let n = 0;
// manifests that ask for something to install (an empty one has nothing to prepare: prepare.ts hasSomethingToInstall)
const DEPS_PKG = JSON.stringify({ dependencies: { "left-pad": "^1.3.0" } });
const DEPS_COMPOSER = JSON.stringify({ name: "a/b", require: { php: ">=8.2" } });
function project(files) {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\nvendor/\n.env\n");
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  return dir;
}
function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const BIN = path.join(TMP, "bin");
fs.mkdirSync(BIN);
const LOG = path.join(TMP, "programs.log");
const prog = (name, body) => fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\necho "${name} $*" >> "${LOG}"\n${body}\n`, { mode: 0o755 });
// as the real npm: `ci` installs from the lock; `install` without a lock writes a new package-lock.json into the folder,
// unless --no-package-lock
prog("npm", `case "$1" in
  ci) mkdir -p node_modules && echo '{}' > node_modules/.package-lock.json ;;
  install) mkdir -p node_modules
    case " $* " in *" --no-package-lock "*) ;; *) [ -f package-lock.json ] || echo '{"lockfileVersion":3}' > package-lock.json ;; esac ;;
esac`);
const npmCalls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith("npm ")) : []);
prog("composer", `mkdir -p vendor && echo '<?php' > vendor/autoload.php`);
prog("php", `case "$2" in
  key:generate) echo "APP_KEY=base64:x" >> .env ;;
  test) [ -f vendor/autoload.php ] || exit 255; grep -q fixed app.php && echo "Tests: 1 passed" || { echo "FAILED Tests\\\\Feature\\\\AppTest"; exit 1; } ;;
esac`);
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const runs = (name) => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith(`${name} `)).length : 0);

function manager(env) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `${BIN}:/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP }
  }));
  const root = path.join(TMP, `root-${++n}`);
  const m = createRunManager({
    platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH)
  });
  m.root = root;
  return m;
}
function script(answers) {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  answers.forEach((a, i) => {
    fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(a.answer));
    if (a.writes) fs.writeFileSync(path.join(dir, `${i + 1}.writes.json`), JSON.stringify(a.writes));
  });
  return dir;
}
const PLAN = { answer: { stages: [{ title: "fix", task: "make the test pass" }], question: null } };
const REVIEW = { answer: { verdict: "accept", findings: [], question: null } };
const FINAL = { answer: { verdict: "complete", findings: [], question: null } };
const EXEC = (extra = {}) => ({ answer: { summary: "done", done: true }, ...extra });
const b64 = (s) => Buffer.from(s).toString("base64");
const settled = (m, runId) => until(async () => {
  const v = (await m.get(runId)).value.view;
  return ["completed", "paused", "failed", "stopped"].includes(v.status) && !v.permission ? v : null;
}, "the end");
// sha256 and mtime of every file under a folder: a write anywhere shows
function fingerprints(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const f = path.join(e.parentPath ?? e.path, e.name);
    out[path.relative(dir, f)] = [createHash("sha256").update(fs.readFileSync(f)).digest("hex"), fs.statSync(f).mtimeMs];
  }
  return out;
}

test("F-1: a Laravel project without a JS lock file is prepared without npm; no package-lock.json appears in it", OPTS, async () => {
  const src = project({ "composer.json": DEPS_COMPOSER, artisan: "", ".env.example": "APP_KEY=\n", "app.php": "<?php // broken\n",
    "package.json": JSON.stringify({ private: true, type: "module", scripts: { build: "vite build" }, devDependencies: { vite: "^7.0.0" } }),
    "phpunit.xml": '<phpunit><php><env name="DB_CONNECTION" value="sqlite"/></php></phpunit>', "tests/Feature/AppTest.php": "<?php\n" });
  assert.equal((await suggestPrepare(src)).some((s) => /\bnpm\b/.test(s.command)), false, "no npm step is suggested");
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "app.php", base64: b64("<?php // fixed\n") }] }), REVIEW, FINAL]) });
  const before = { npm: runs("npm"), composer: runs("composer") };
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "fix the app", criteria: ["tests pass"], checks: [], mode: "autopilot" } })).ok);
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(runs("npm") - before.npm, 0, "npm was not run");
  assert.equal(runs("composer") - before.composer, 1, "the PHP dependencies were still prepared");
  assert.equal(fs.existsSync(path.join(src, "package-lock.json")), false, "nothing written into the project");
  assert.equal(g(src, "status", "--porcelain").trim(), "M app.php", "only the fix is a change");
  assert.equal((await createProfileStore(m.root).get(src)).prepare.steps.some((s) => /\bnpm\b/.test(s.command)), false);
  await m.shutdown();
});

test("regressions: a lock without node_modules is installed; a changed lock is installed again; a Node project without a lock keeps npm install", async () => {
  const node = project({ "package.json": DEPS_PKG, "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } }) });
  const steps = await suggestPrepare(node);
  assert.deepEqual(steps.map((s) => s.command), ["npm ci"]);
  assert.deepEqual((await neededSteps(node, steps)).map((x) => x.step.command), ["npm ci"], "no node_modules: installed");
  fs.mkdirSync(path.join(node, "node_modules"));
  fs.writeFileSync(path.join(node, "node_modules", ".package-lock.json"), "{}");
  const known = await lockFingerprints(node, steps);
  assert.deepEqual(await neededSteps(node, steps, known), [], "installed and unchanged");
  fs.writeFileSync(path.join(node, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.3.1" } } }));
  assert.deepEqual((await neededSteps(node, steps, known)).map((x) => x.step.command), ["npm ci"], "a changed lock: installed again");
  const bare = project({ "package.json": DEPS_PKG });
  assert.deepEqual((await suggestPrepare(bare)).map((s) => s.command), ["npm install --no-package-lock"], "the JS project itself: installed, no lock written");
});

test("a JS project without a lock file is prepared with npm install --no-package-lock: no lock file appears, git status stays clean", OPTS, async () => {
  const src = project({ "package.json": JSON.stringify({ name: "p", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } }) });
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC(), REVIEW, FINAL]) });
  const before = npmCalls().length;
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["test -d node_modules"], mode: "autopilot" } })).ok);
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.deepEqual(npmCalls().slice(before), ["npm install --no-package-lock"], "the flag reaches npm");
  assert.equal(fs.existsSync(path.join(src, "package-lock.json")), false, "no lock file in the project");
  assert.equal(g(src, "status", "--porcelain"), "", "the project's git status is clean");
  // with a lock file the step stays npm ci
  const locked = project({ "package.json": DEPS_PKG, "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } }) });
  assert.deepEqual((await suggestPrepare(locked)).map((s) => s.command), ["npm ci"]);
  await m.shutdown();
});

test("the separate copy never writes into the project's node_modules nor its lock (sha256 and mtime before and after)", OPTS, async () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } });
  const src = project({ "package.json": DEPS_PKG, "package-lock.json": lock, "a.txt": "1\n" });
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", ".package-lock.json"), lock);
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.js"), "module.exports = (s) => s;\n");
  const deps = fingerprints(path.join(src, "node_modules"));
  const lockBefore = fingerprints(src)["package-lock.json"];
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] }), REVIEW, FINAL]) });
  const before = runs("npm");
  const runId = randomUUID();
  // a native copy is a clone: the ignored node_modules is cloned from the project (APFS) or installed in the copy,
  // never linked (tests/orchestration-copy-deps.test.mjs)
  const apfs = process.platform === "darwin" && fs.statfsSync(TMP).type === 26;
  const cmd = "grep -qx 2 a.txt";
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["c"], checks: [], commands: [cmd], workMode: "copy", mode: "autopilot" } })).ok);
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(runs("npm") - before, apfs ? 0 : 1, apfs ? "cloned: nothing to install" : "no clone without APFS: npm ci in the copy");
  assert.deepEqual(fingerprints(path.join(src, "node_modules")), deps, "the project's node_modules is untouched");
  assert.deepEqual(fingerprints(src)["package-lock.json"], lockBefore);
  assert.equal(fs.readFileSync(path.join(src, "a.txt"), "utf8"), "1\n", "the project itself is not the copy");
  await m.shutdown();
});
