// Run 842f5237 (Raoden Loom 1.5.6): a package.json with scripts only. `npm install` exits 0 and makes no node_modules,
// because there is nothing to install; the preparation called that a failure and every Continue repeated it. Nothing to
// install is a prepared environment, judged by the project's files now; a real failure keeps its reason on record.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import * as prepare from "../src/main/services/orchestration/prepare.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-prepare-nothing-")));
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
// as the real npm when package.json asks for nothing, and as any npm that exits 0 without installing: no node_modules.
// The login shell's noise of a real ~/.zshrc comes first (the steps run in `zsh -ilc`).
fs.writeFileSync(path.join(BIN, "npm"), `#!/bin/sh\necho "npm $*" >> "${LOG}"
echo "(anon):setopt:7: can't change option: monitor" >&2
echo "[ERROR]: gitstatus failed to initialize." >&2
echo "up to date, audited 1 package in 312ms"\n`, { mode: 0o755 });
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const runs = (name) => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith(`${name} `)).length : 0);

function manager(env, root = path.join(TMP, `root-${++n}`)) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `${BIN}:/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP }
  }));
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
  answers.forEach((a, i) => { fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(a.answer)); });
  return dir;
}
const PLAN = { answer: { stages: [{ title: "fix", task: "make the test pass" }], question: null } };
const REVIEW = { answer: { verdict: "accept", findings: [], question: null } };
const FINAL = { answer: { verdict: "complete", findings: [], question: null } };
const EXEC = { answer: { summary: "done", done: true } };
const env = () => ({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]) });
const settled = (m, runId) => until(async () => {
  const v = (await m.get(runId)).value.view;
  return ["completed", "paused", "failed", "stopped"].includes(v.status) && !v.permission ? v : null;
}, "the end");
const history = async (m, runId) => (await m.history(runId, 0, 500)).value.records;
const activity = async (m, runId) => (await m.activity(runId, 0, 500)).value.entries;
const resume = async (m, runId) => m.command(runId, { commandId: randomUUID(), expectedRevision: (await m.get(runId)).value.view.revision, command: { kind: "resume" } });

// The project of run 842f5237: package.json with scripts only, nothing to install.
const SCRIPTS_ONLY = JSON.stringify({ name: "huntrix-magic-stage", version: "2.2.0", private: true, type: "module", scripts: { test: "node --test" } });
const WITH_DEPS = JSON.stringify({ name: "p", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } });
// The step a 1.5.6 profile saved for such a project, kept in the goal of its runs.
const SAVED_STEP = { command: "npm install", unless: "node_modules" };
async function start(m, src, steps = [SAVED_STEP]) {
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["true"], prepare: { steps, auto: true } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot" } })).ok);
  return runId;
}

test("nothing to install: package.json without dependencies is a prepared environment; the run reaches the lead's turn", OPTS, async () => {
  const src = project({ "package.json": SCRIPTS_ONLY });
  const m = manager(env());
  const npm = runs("npm");
  const runId = await start(m, src);
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  const recs = await history(m, runId);
  assert.deepEqual(recs.filter((r) => r.type === "prepare.finished").map((r) => [r.data.status, r.data.failed]), [["not_needed", null]]);
  assert.ok(recs.some((r) => r.type === "orch.turn" && r.data.purpose === "plan"), "the lead planned");
  const feed = await activity(m, runId);
  assert.ok(feed.some((e) => e.kind === "prepare_finished" && e.detail?.nothing === true && e.text === "npm install: nothing to install"));
  assert.ok(feed.some((e) => e.kind === "prepare_finished" && e.detail?.summary === true && e.detail.status === "not_needed"));
  assert.equal(runs("npm") - npm, 0, "nothing ran, nothing was written");
  assert.equal(g(src, "status", "--porcelain"), "");
  await m.shutdown();
});

test("with dependencies, no node_modules after the install is still a failure, its reason on record", OPTS, async () => {
  const src = project({ "package.json": WITH_DEPS });
  const m = manager(env());
  const runId = await start(m, src);
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "needs_user_action"]);
  assert.deepEqual([v.progress.prepare.status, v.progress.prepare.failed, v.progress.prepare.command], ["failed", "0", "npm install"]);
  const fin = (await history(m, runId)).find((r) => r.type === "prepare.finished");
  assert.equal((await m.text(runId, fin.data.output.sha256)).value.text, "still missing after preparation: node_modules");
  const summary = (await activity(m, runId)).find((e) => e.detail?.summary === true);
  assert.deepEqual([summary.detail.status, summary.detail.command, summary.detail.output], ["failed", "npm install", "still missing after preparation: node_modules"]);
  await m.shutdown();
});

test("suggestPrepare: no npm step for a package.json without dependencies, no composer step for a composer.json without require", async () => {
  assert.deepEqual(await prepare.suggestPrepare(project({ "package.json": SCRIPTS_ONLY })), []);
  assert.deepEqual(await prepare.suggestPrepare(project({ "package.json": JSON.stringify({ dependencies: {}, devDependencies: {}, workspaces: [] }) })), []);
  assert.deepEqual(await prepare.suggestPrepare(project({ "composer.json": JSON.stringify({ name: "a/b", require: {}, "require-dev": {} }) })), []);
  assert.deepEqual((await prepare.suggestPrepare(project({ "package.json": WITH_DEPS }))).map((s) => s.command), ["npm install --no-package-lock"]);
  assert.deepEqual((await prepare.suggestPrepare(project({ "package.json": JSON.stringify({ workspaces: { packages: ["a"] } }) }))).map((s) => s.command), ["npm install --no-package-lock"]);
  assert.deepEqual((await prepare.suggestPrepare(project({ "composer.json": JSON.stringify({ require: { php: ">=8.2" } }) }))).map((s) => s.command), ["composer install --no-interaction --no-progress"]);
  // one rule for the suggestion and for the marker: unreadable manifests are not judged
  assert.equal(await prepare.hasSomethingToInstall(project({ "package.json": "{ not json" }), "package.json"), true);
  const empty = project({ "composer.json": "{}" });
  assert.deepEqual(await prepare.neededSteps(empty, [{ command: "composer install", unless: "vendor/autoload.php" }]), [], "composer: nothing to wait for");
});

test("a run of the form of 842f5237 (steps in the goal, prepare.finished failed) passes the preparation on Continue", OPTS, async () => {
  // The journal as 1.5.6 left it: the goal holds the saved step, the preparation failed with node_modules missing and
  // the run paused. Here the failure comes from a dependency the project then drops; the record is the same.
  const src = project({ "package.json": WITH_DEPS });
  const root = path.join(TMP, `root-${++n}`);
  const e = env();
  const m = manager(e, root);
  const runId = await start(m, src);
  const paused = await settled(m, runId);
  assert.deepEqual([paused.status, paused.reason], ["paused", "needs_user_action"]);
  const recs = await history(m, runId);
  const goal = JSON.parse((await m.text(runId, recs[0].data.goal.sha256)).value.text);
  assert.deepEqual(goal.prepare.steps, [SAVED_STEP], "the step is the goal's");
  assert.deepEqual(recs.filter((r) => r.type === "prepare.finished").map((r) => [r.data.status, r.data.failed, r.data.class]), [["failed", 0, "environment"]]);
  await m.shutdown();
  fs.writeFileSync(path.join(src, "package.json"), SCRIPTS_ONLY);
  g(src, "commit", "-qam", "scripts only");
  const m2 = manager(e, root); // the updated application
  await resume(m2, runId);
  const done = await settled(m2, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  const after = await history(m2, runId);
  assert.deepEqual(after.filter((r) => r.type === "prepare.finished").map((r) => r.data.status), ["failed", "not_needed"]);
  assert.ok(after.some((r) => r.type === "orch.turn" && r.data.purpose === "plan"));
  await m2.shutdown();
});

// The renderer's modules, bundled as the app does (React and the i18n as they are).
const require = createRequire(path.join(HERE, "..", "package.json"));
async function bundle(entry) {
  const out = await require("esbuild").build({
    entryPoints: [path.join(HERE, "..", entry)], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
    loader: { ".svg": "dataurl", ".png": "dataurl", ".ico": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
    plugins: [{ name: "same-react", setup(b) { b.onResolve({ filter: /^react(\/.*)?$/ }, (a) => ({ path: require.resolve(a.path), external: true })); } }]
  });
  const file = path.join(HERE, "..", `${path.basename(entry)}.prepare-nothing.cjs`);
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.join(HERE, ".."));
  mod._compile(out.outputFiles[0].text, file);
  return mod.exports;
}
// The output of the step in run 842f5237, as stored: a real ~/.zshrc speaks first, with its colours.
const ESC = String.fromCharCode(27);
const RUN_842 = `(anon):setopt:7: can't change option: monitor\n\n[${ESC}[31mERROR${ESC}[39m]: gitstatus failed to initialize.\n\n\n  Add the following parameter to ${ESC}[4m~/.zshrc${ESC}[24m for extra diagnostics on error:\n\n    ${ESC}[1mGITSTATUS_LOG_LEVEL=DEBUG${ESC}[0m\n\n  Restart Zsh to retry gitstatus initialization:\n\n    ${ESC}[32m${ESC}[4mexec${ESC}[24m${ESC}[32m zsh${ESC}[39m\n\n`;

test("the reason line skips the login shell's noise", async () => {
  const { prepareReason, prepareReasonText, lastLines } = await bundle("src/renderer/src/features/orchestration/runModel.ts");
  assert.deepEqual(prepareReason(`${RUN_842}npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x\n`, 1), { kind: "exit", code: 1, line: "npm error code E404" });
  assert.deepEqual(prepareReason(`${RUN_842}up to date, audited 1 package in 312ms\n`, 2), { kind: "exit", code: 2, line: "up to date, audited 1 package in 312ms" });
  assert.deepEqual(prepareReason(RUN_842, 1), { kind: "exit", code: 1, line: null }, "only noise: no line");
  assert.deepEqual(prepareReason("still missing after preparation: node_modules", null), { kind: "missing", what: "node_modules" });
  assert.equal(prepareReasonText("ru", prepareReason("still missing after preparation: node_modules", null)), "нет node_modules после установки");
  assert.equal(prepareReasonText("en", { kind: "exit", code: 1, line: "npm error code E404" }), "exit code 1: npm error code E404");
  assert.equal(lastLines(`${RUN_842}${Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")}`), Array.from({ length: 40 }, (_, i) => `line ${i + 21}`).join("\n"));
});

test("the run panel says which step failed and why: the board, the next step, the feed, the history", OPTS, async () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { RunPanel } = await bundle("src/renderer/src/features/orchestration/RunPanel.tsx");
  const src = project({ "package.json": WITH_DEPS });
  const m = manager(env());
  const step = { command: `echo "(anon):setopt:7: can't change option: monitor" >&2; echo "npm error code E404"; exit 1`, unless: "node_modules" };
  const runId = await start(m, src, [step]);
  const view = await settled(m, runId);
  const entries = await activity(m, runId);
  const records = await history(m, runId);
  const texts = {};
  for (const r of records) for (const v of Object.values(r.data)) if (v?.sha256) texts[v.sha256] = { status: "ready", text: (await m.text(runId, v.sha256)).value.text };
  await m.shutdown();
  const render = (locale, tab, role = "lead") => renderToStaticMarkup(React.createElement(RunPanel, {
    orch: { runs: { r: { view, open: true, seq: 9, tick: 0 } }, activity: { r: { entries, gaps: [], firstId: entries[0]?.id ?? 0, status: "ready", resyncs: 0 } },
      runErrors: {}, canvas: { links: [], agents: [] }, journals: { r: { records, next: records.length, status: "ready" } }, texts,
      commands: { pending: () => [] }, catalog: { checks: [] }, loadText() {}, syncJournal() {}, retry() {} },
    runId: "r", locale, panel: { linkId: "L", tab, role, focus: 1 }, onClose() {}, onNewGoal() {}, onView() {}
  }));
  const text = (html) => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&gt;/g, ">");
  const overview = render("ru", "overview");
  assert.match(text(overview), /Подготовка среды:не удалась — шаг «echo .* exit 1»: код выхода 1: npm error code E404 Показать вывод/);
  assert.match(overview, /data-prepare-output-toggle/);
  assert.match(text(overview), /Дальше: проверьте шаг «echo .* exit 1»: устраните причину сбоя и нажмите «Продолжить»/);
  assert.doesNotMatch(text(overview), /прочтите, что именно нужно, в ленте/);
  assert.match(text(render("en", "overview")), /Next: check the step “echo .* exit 1”: fix the cause and press Continue/);
  const feed = text(render("ru", "activity", "check"));
  assert.match(feed, /Подготовка среды: не удалась — шаг «echo .* exit 1»: код выхода 1: npm error code E404/);
  const hist = text(render("ru", "history"));
  assert.match(hist, /Подготовка среды начата/);
  assert.match(hist, /Подготовка среды: не удалась · шаг 1/);
  assert.match(text(render("en", "history")), /Environment preparation: failed · step 1/);
});
