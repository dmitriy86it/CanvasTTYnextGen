// Checks in a separate copy or a worktree need the project's dependencies (node_modules, vendor). The copy is a clone:
// ignored folders are not in it. Fixtures are offline: a local stub package, a fake npm and composer that count runs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-copy-deps-")));
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
prog("composer", `mkdir -p vendor && echo '<?php' > vendor/autoload.php`);
prog("php", `case "$2" in
  key:generate) echo "APP_KEY=base64:x" >> .env ;;
  test) [ -f vendor/autoload.php ] || exit 255; grep -q fixed app.php && echo "Tests: 1 passed" || { echo "FAILED Tests\\\\Feature\\\\AppTest"; exit 1; } ;;
esac`);
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const runs = (name) => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith(`${name} `)).length : 0);

function manager(env, extra = {}) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `${BIN}:/usr/bin:/bin:${path.dirname(GIT)}:${path.dirname(NODE)}`, HOME: TMP }
  }));
  const root = path.join(TMP, `root-${++n}`);
  const m = createRunManager({
    platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), ...extra
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


// A Node project with its dependencies installed: a stub package the check imports, ignored by git.
function nodeProject() {
  return project({
    "package.json": JSON.stringify({ name: "p", version: "1.0.0", dependencies: { stub: "1.0.0" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/stub": { version: "1.0.0" } } }),
    "node_modules/stub/package.json": JSON.stringify({ name: "stub", version: "1.0.0", type: "module", main: "index.js" }),
    "node_modules/stub/index.js": "export const ok = 1;\n",
    "node_modules/.package-lock.json": "{}"
  });
}
// The fake npm installs no stub: a check passes only with the project's own node_modules.
const NODE_CHECK = `node --input-type=module -e "import('stub').then((m) => process.exit(m.ok === 1 ? 0 : 1))"`;
// A PHP project with vendor/ installed; the fake composer writes an autoload without the stub's line.
function phpProject() {
  return project({
    "composer.json": JSON.stringify({ name: "a/b", require: { "x/stub": "1.0.0" } }),
    "composer.lock": JSON.stringify({ packages: [{ name: "x/stub", version: "1.0.0" }] }),
    "vendor/autoload.php": "<?php // x/stub\n"
  });
}
const PHP_CHECK = "grep -q x/stub vendor/autoload.php";

async function runIn(src, workMode, commands, extra = {}) {
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC(), REVIEW, FINAL]) }, extra);
  const runId = randomUUID();
  const created = await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], commands, workMode, mode: "autopilot" } });
  assert.ok(created.ok, JSON.stringify(created));
  const done = await settled(m, runId);
  const entries = (await m.activity(runId, 0, 500)).value.entries;
  await m.shutdown();
  const record = fs.readdirSync(path.join(m.root, "runs", runId), { recursive: true }).find((f) => path.basename(f) === "deps.json");
  return { done, entries, deps: record ? JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, record), "utf8")).dirs : null,
    said: entries.filter((e) => e.detail?.dependencies === true).map((e) => e.text).join("; ") };
}
const result = (r, dir) => r.deps?.find((d) => d.dir === dir);
// Clones need APFS (macOS). Elsewhere the same runs take the other path, asserted instead of skipped: installed in the
// copy, the reason said, the project untouched.
const APFS = process.platform === "darwin" && fs.statfsSync(TMP).type === 26;
const noClone = (r, dir) => assert.deepEqual(result(r, dir), { dir, result: "installed", reason: "could not clone: clonefile needs APFS" });
const MODES = ["copy", "worktree"];

for (const mode of MODES) {
  test(`${mode} repro: a check that imports the project's node_modules passes`, OPTS, async () => {
    const r = await runIn(nodeProject(), mode, [NODE_CHECK]);
    const { done, entries } = r;
    if (!APFS) return noClone(r, "node_modules");
    assert.equal(done.status, "completed", JSON.stringify({ done, checks: entries.filter((e) => e.kind.startsWith("check")).map((e) => [e.kind, e.text]) }));
  });

  test(`${mode}: node_modules is cloned; the project's stays as it was and a write in the copy never reaches it`, OPTS, async () => {
    const src = nodeProject();
    const before = fingerprints(path.join(src, "node_modules"));
    const lockBefore = fingerprints(src)["package-lock.json"];
    const npm = runs("npm");
    const r = await runIn(src, mode, [NODE_CHECK]);
    if (!APFS) { noClone(r, "node_modules"); assert.deepEqual(fingerprints(path.join(src, "node_modules")), before); return; }
    assert.equal(r.done.status, "completed");
    assert.deepEqual(result(r, "node_modules"), { dir: "node_modules", result: "cloned", reason: "package-lock.json matches the project's", lock: "package-lock.json",
      sha256: createHash("sha256").update(fs.readFileSync(path.join(src, "package-lock.json"))).digest("hex"), ms: result(r, "node_modules").ms });
    assert.equal(runs("npm") - npm, 0, "the cloned folder needs no npm ci");
    assert.match(r.said, /node_modules: cloned from the project/);
    const copy = r.done.workDir;
    assert.ok(fs.existsSync(path.join(copy, "node_modules", "stub", "index.js")));
    fs.writeFileSync(path.join(copy, "node_modules", "stub", "index.js"), "export const ok = 2;\n");
    fs.writeFileSync(path.join(copy, "node_modules", "new-in-copy.txt"), "x");
    assert.deepEqual(fingerprints(path.join(src, "node_modules")), before, "sha256 and mtime of the project's node_modules");
    assert.deepEqual(fingerprints(src)["package-lock.json"], lockBefore);
    assert.equal(fs.existsSync(path.join(src, "node_modules", "new-in-copy.txt")), false);
    assert.equal(g(src, "status", "--porcelain"), "");
  });

  test(`${mode}: a lock file in the copy that differs from the project's is installed there, not cloned`, OPTS, async () => {
    const src = nodeProject();
    // copy: the lock is the project's working tree, so it differs only through an ignored lock; worktree: from HEAD
    if (mode === "copy") { fs.appendFileSync(path.join(src, ".gitignore"), "package-lock.json\n"); g(src, "rm", "-q", "--cached", "package-lock.json"); g(src, "commit", "-qam", "untrack lock"); }
    else fs.writeFileSync(path.join(src, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/stub": { version: "1.0.1" } } }));
    const before = fingerprints(path.join(src, "node_modules"));
    const r = await runIn(src, mode, ["true"]);
    assert.equal(result(r, "node_modules").result, "installed");
    assert.match(result(r, "node_modules").reason, /package-lock\.json in the copy differs from the project's/);
    assert.equal(fs.existsSync(path.join(r.done.workDir, "node_modules", "stub")), false, "not cloned");
    if (mode === "worktree") assert.ok(fs.existsSync(path.join(r.done.workDir, "node_modules", ".package-lock.json")), "npm ci ran in the copy");
    assert.match(r.said, /node_modules: installed in the copy/);
    assert.deepEqual(fingerprints(path.join(src, "node_modules")), before);
  });

  test(`${mode}: no clone possible: installed in the copy, the reason said`, OPTS, async () => {
    const src = nodeProject();
    const before = fingerprints(path.join(src, "node_modules"));
    const npm = runs("npm");
    const r = await runIn(src, mode, ["true"], { cloneDir: async () => { throw new Error("clonefile needs APFS"); } });
    assert.equal(r.done.status, "completed");
    assert.deepEqual(result(r, "node_modules"), { dir: "node_modules", result: "installed", reason: "could not clone: clonefile needs APFS" });
    assert.equal(runs("npm") - npm, 1, "npm ci in the copy");
    assert.ok(fs.existsSync(path.join(r.done.workDir, "node_modules", ".package-lock.json")));
    assert.match(r.said, /node_modules: installed in the copy \(could not clone: clonefile needs APFS\)/);
    assert.deepEqual(fingerprints(path.join(src, "node_modules")), before);
  });

  test(`${mode}: vendor of a PHP project by the same rule`, OPTS, async () => {
    const src = phpProject();
    const before = fingerprints(path.join(src, "vendor"));
    const composer = runs("composer");
    const r = await runIn(src, mode, [PHP_CHECK]);
    if (!APFS) { noClone(r, "vendor"); assert.deepEqual(fingerprints(path.join(src, "vendor")), before); return; }
    assert.equal(r.done.status, "completed");
    assert.equal(result(r, "vendor").result, "cloned");
    assert.equal(result(r, "node_modules").result, "skipped");
    assert.equal(runs("composer") - composer, 0);
    fs.writeFileSync(path.join(r.done.workDir, "vendor", "new-in-copy.php"), "x");
    assert.deepEqual(fingerprints(path.join(src, "vendor")), before);
    // a changed composer.lock: composer install in the copy
    const src2 = phpProject();
    if (mode === "worktree") fs.writeFileSync(path.join(src2, "composer.lock"), "{}");
    else { fs.appendFileSync(path.join(src2, ".gitignore"), "composer.lock\n"); g(src2, "rm", "-q", "--cached", "composer.lock"); g(src2, "commit", "-qam", "untrack lock"); }
    const r2 = await runIn(src2, mode, ["true"]);
    assert.equal(result(r2, "vendor").result, "installed");
    assert.equal(runs("composer") - composer, 1);
  });
}

test("a link that leads out of the dependency folder refuses the clone", OPTS, async () => {
  const src = nodeProject();
  fs.symlinkSync(path.join(src, "package.json"), path.join(src, "node_modules", "outside"));
  const r = await runIn(src, "copy", ["true"]);
  assert.deepEqual(result(r, "node_modules"), { dir: "node_modules", result: "installed", reason: "could not clone: a link leads out of the folder: outside" });
});

test("the project folder mode is unchanged: nothing is cloned, nothing recorded", OPTS, async () => {
  const r = await runIn(nodeProject(), "project", [NODE_CHECK]);
  assert.equal(r.done.status, "completed");
  assert.equal(r.deps, null);
  assert.equal(r.said, "");
});

// The run panel says it in a few words: where the copy's dependencies came from.
async function loadRunPanel() {
  const require = createRequire(path.join(HERE, "..", "package.json"));
  const out = await require("esbuild").build({
    entryPoints: [path.join(HERE, "..", "src/renderer/src/features/orchestration/RunPanel.tsx")],
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
    loader: { ".svg": "dataurl", ".png": "dataurl", ".ico": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
    plugins: [{ name: "same-react", setup(b) { b.onResolve({ filter: /^react(\/.*)?$/ }, (a) => ({ path: require.resolve(a.path), external: true })); } }]
  });
  const file = path.join(HERE, "..", "run-panel-copy-deps.cjs");
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.join(HERE, ".."));
  mod._compile(out.outputFiles[0].text, file);
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  return (locale, view, entries) => renderToStaticMarkup(React.createElement(mod.exports.RunPanel, {
    orch: { runs: { r: { view, open: true, seq: 9, tick: 0 } }, activity: { r: { entries, gaps: [], firstId: entries[0]?.id ?? 0, status: "ready", resyncs: 0 } },
      runErrors: {}, canvas: { links: [], agents: [] }, journals: { r: { records: [], next: 0, status: "ready" } }, texts: {},
      commands: { pending: () => [] }, catalog: { checks: [] }, loadText() {}, syncJournal() {}, retry() {} },
    runId: "r", locale, panel: { linkId: "L", tab: "overview", role: "lead", focus: 1 }, onClose() {}, onNewGoal() {}, onView() {}
  }));
}

test("the run panel: «Зависимости: склонированы из проекта» / installed in the copy", OPTS, async () => {
  const render = await loadRunPanel();
  const cloned = await runIn(nodeProject(), "copy", [NODE_CHECK]);
  if (!APFS) assert.match(render("ru", cloned.done, cloned.entries), /data-board="deps">установлены в копии</);
  else assert.match(render("ru", cloned.done, cloned.entries), /Зависимости:<\/dt><dd data-board="deps">склонированы из проекта</);
  if (APFS) assert.match(render("en", cloned.done, cloned.entries), /Dependencies:<\/dt><dd data-board="deps">cloned from the project</);
  const installed = await runIn(nodeProject(), "worktree", ["true"], { cloneDir: async () => { throw new Error("x"); } });
  assert.match(render("ru", installed.done, installed.entries), /data-board="deps">установлены в копии</);
  const project = await runIn(nodeProject(), "project", ["true"]);
  assert.doesNotMatch(render("ru", project.done, project.entries), /data-board="deps"/);
});
