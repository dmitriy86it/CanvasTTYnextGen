// Stage 13 lifecycle review (LC-1…LC-11, UX-5, RT-2/7/9): the test database, preparation by lock files, the actions
// after success bound to the checked tree, QA confirmation, the push address, recovery. Fake CLIs and programs only;
// push targets are local bare repositories.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { LARAVEL_ENV_STEP, laravelTestDb, lockFingerprints, neededSteps, suggestPrepare, worktreeSteps } from "../src/main/services/orchestration/prepare.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { assessReadiness, testDbItem } from "../src/main/services/orchestration/readiness.ts";
import { remoteUrlsMatch } from "../src/main/services/orchestration/finish.ts";
import { applyDirenv } from "../src/main/services/orchestration/loginEnv.ts";
import { alive, waitDead } from "./fixtures/orchestration/reaper-pids.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const SUPERVISOR = path.join(HERE, "..", "src", "orchestration", "supervisor.mjs");
const LAUNCH = { command: NODE, args: [SUPERVISOR], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-lifecycle-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}
let n = 0;
// manifests that ask for something to install (an empty one has nothing to prepare: prepare.ts hasSomethingToInstall)
const DEPS_PKG = JSON.stringify({ dependencies: { "left-pad": "^1.3.0" } });
const DEPS_COMPOSER = JSON.stringify({ name: "a/b", require: { php: ">=8.2" } });
function project(files, { ignore = "node_modules/\nvendor/\n.env\n" } = {}) {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, ".gitignore"), ignore);
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
// Fake programs of the user's machine (npm, composer, php) that count their runs.
const BIN = path.join(TMP, "bin");
fs.mkdirSync(BIN);
const LOG = path.join(TMP, "programs.log");
const prog = (name, body) => fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\necho "${name} $*" >> "${LOG}"\n${body}\n`, { mode: 0o755 });
prog("npm", `[ "$1" = ci ] && mkdir -p node_modules && echo '{}' > node_modules/.package-lock.json && echo "added 1 package"`);
prog("composer", `mkdir -p vendor && echo '<?php' > vendor/autoload.php && echo "Generating autoload files"`);
prog("php", `case "$2" in
  key:generate) echo "APP_KEY=base64:x" >> .env ;;
  test) [ -f vendor/autoload.php ] || { echo "PHP Warning: require(vendor/autoload.php): Failed to open stream"; exit 255; }
        grep -q APP_KEY=base64 .env || { echo "No application encryption key has been specified."; exit 1; }
        grep -q fixed app.php && echo "Tests: 1 passed" || { echo "FAILED Tests\\\\Feature\\\\AppTest > it works"; exit 1; } ;;
esac`);
// The user's login shell as the checks call it (`-ilc <line>`), without the machine's profile files: /etc/profile's
// path_helper would put the real npm/composer/php before the fake ones.
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const runs = (name) => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith(`${name} `)).length : 0);

function providersFile(env, codexVersion = "codex-cli 0.155.1") {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: codexVersion, ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `${BIN}:/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP }
  }));
  return file;
}
function script(answers) {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  answers.forEach((a, i) => {
    fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(a.answer));
    if (a.writes) fs.writeFileSync(path.join(dir, `${i + 1}.writes.json`), JSON.stringify(a.writes));
    if (a.asks) fs.writeFileSync(path.join(dir, `${i + 1}.asks.json`), JSON.stringify(a.asks));
  });
  return dir;
}
const PLAN = { answer: { stages: [{ title: "fix", task: "make the test pass" }], question: null } };
const REVIEW = { answer: { verdict: "accept", findings: [], question: null } };
const FINAL = { answer: { verdict: "complete", findings: [], question: null } };
const EXEC = (extra = {}) => ({ answer: { summary: "done", done: true }, ...extra });
const b64 = (s) => Buffer.from(s).toString("base64");

function manager(env, root = path.join(TMP, `root-${++n}`), codexVersion) {
  const m = createRunManager({
    platform: "darwin", // the engine under test; the platform gate has its own tests
    root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providersFile(env, codexVersion), () => LAUNCH)
  });
  m.root = root;
  return m;
}
const view = async (m, runId) => (await m.get(runId)).value.view;
const settled = (m, runId, what = "the end") => until(async () => {
  const v = await view(m, runId);
  return ["completed", "paused", "failed", "stopped"].includes(v.status) && !v.permission ? v : null;
}, what);
const history = async (m, runId) => (await m.history(runId, 0, 200)).value.records;
const answer = (m, v, decision, extra = {}) => m.command(v.runId ?? v.id, { commandId: randomUUID(), expectedRevision: v.revision,
  command: { kind: "permission", requestId: v.permission.requestId, decision, ...extra } });
const asking = (m, runId, what = "a prompt") => until(async () => { const v = await view(m, runId); return v.permission ? v : null; }, what);


const resume = (m, v) => m.command(v.runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "resume" } });
const READY = { commands: ["php artisan test"], workMode: "project", platform: "darwin", gitPath: GIT, busy: false,
  runtime: { ok: true, versions: { codex: "codex-cli 0.155.1", claude: "2.1.281 (Claude Code)" }, env: { PATH: "/usr/bin" }, shell: "/bin/sh" },
  dbProbe: async () => true };
const laravel = (files) => project({ artisan: "", "composer.json": DEPS_COMPOSER, ...files });

// ---------------- the test database (LC-1, LC-2, LC-3) ----------------

test("test database: commented phpunit lines, a local working database, the process environment and a config cache", async () => {
  // LC-1: Laravel 10's phpunit.xml has the sqlite lines commented out; the tests use .env's production database
  const l10 = laravel({ ".env": "DB_CONNECTION=mysql\nDB_HOST=prod.db.example.com\nDB_DATABASE=shop\n", "phpunit.xml": `<phpunit><php>
    <env name="APP_ENV" value="testing"/>
    <!-- <env name="DB_CONNECTION" value="sqlite"/> -->
    <!-- <env name="DB_DATABASE" value=":memory:"/> -->
  </php></phpunit>` });
  const a = await laravelTestDb(l10, async () => true);
  assert.deepEqual([a.connection, a.source, a.risky], ["mysql", ".env", true]);
  assert.equal(testDbItem(a).level, "blocker");
  // attributes in any order, single quotes
  fs.writeFileSync(path.join(l10, "phpunit.xml"), `<phpunit><php><env value=':memory:' name='DB_DATABASE'/><env value="sqlite" name="DB_CONNECTION"/></php></phpunit>`);
  const b = await laravelTestDb(l10, async () => true);
  assert.deepEqual([b.connection, b.database, b.explicit, testDbItem(b).level], ["sqlite", ":memory:", true, "ok"]);

  // LC-2: a local database from .env may be the person's working one: never "ok", the person confirms
  const local = laravel({ ".env": "DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_DATABASE=myapp_dev\n" });
  const c = await laravelTestDb(local, async () => true);
  assert.deepEqual([c.risky, c.explicit, testDbItem(c).level], [false, false, "confirm"]);
  assert.match(testDbItem(c).detail, /working database/);
  const r = await assessReadiness({ ...READY, project: local });
  assert.equal(r.items.find((i) => i.id === "testdb").level, "confirm");
  // a database named for the tests (phpunit.xml) on the same local server is the usual setup
  fs.writeFileSync(path.join(local, "phpunit.xml"), '<phpunit><php><env name="DB_DATABASE" value="testing"/></php></phpunit>');
  assert.equal(testDbItem(await laravelTestDb(local, async () => true)).level, "ok");
  // sqlite from .env without a name is database/database.sqlite: the working one
  const lite = laravel({ ".env": "DB_CONNECTION=sqlite\n" });
  assert.equal(testDbItem(await laravelTestDb(lite, async () => true)).level, "confirm");

  // LC-3: a variable of the process (login shell, direnv) wins over phpunit.xml without force, and over .env
  const shell = laravel({ ".env": "DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\n", "phpunit.xml": '<phpunit><php><env name="DB_DATABASE" value="testing"/></php></phpunit>' });
  const env = { DB_DATABASE: "shop", DB_HOST: "prod.db.example.com" };
  const d = await laravelTestDb(shell, async () => true, { env });
  assert.deepEqual([d.database, d.host, d.explicit, d.risky, testDbItem(d).level], ["shop", "prod.db.example.com", false, true, "blocker"]);
  const r2 = await assessReadiness({ ...READY, project: shell, runtime: { ...READY.runtime, env: { PATH: "/usr/bin", ...env } } });
  assert.equal(r2.items.find((i) => i.id === "testdb").level, "blocker", "readiness uses the login shell's environment");
  fs.writeFileSync(path.join(shell, "phpunit.xml"), '<phpunit><php><env name="DB_DATABASE" value="testing" force="true"/><env name="DB_HOST" value="127.0.0.1" force="true"/></php></phpunit>');
  const e = await laravelTestDb(shell, async () => true, { env });
  assert.deepEqual([e.database, e.explicit, testDbItem(e).level], ["testing", true, "ok"], "force wins over the process");
  // a cached configuration ignores phpunit.xml
  fs.mkdirSync(path.join(shell, "bootstrap", "cache"), { recursive: true });
  fs.writeFileSync(path.join(shell, "bootstrap", "cache", "config.php"), "<?php return [];");
  assert.equal(testDbItem(await laravelTestDb(shell, async () => true, { env })).level, "blocker");
  // nothing set anywhere: not claimed safe. Review 3: the framework's default connection is read now (sqlite
  // database/database.sqlite, a file that may be the working one), so the person confirms, as with DB_CONNECTION=sqlite
  assert.equal(testDbItem(await laravelTestDb(laravel({}), async () => true)).level, "confirm");
});

test("test database: a run is refused in main too, not only by the dialog", OPTS, async () => {
  const src = laravel({ ".env": "DB_CONNECTION=mysql\nDB_HOST=prod.db.example.com\n", "tests/Feature/AppTest.php": "<?php\n" });
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN]) });
  const r = await m.create({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"], mode: "autopilot", workMode: "project" } });
  assert.equal(r.code, "test_database_unsafe", JSON.stringify(r));
  const r2 = await m.create({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"], workMode: "project" } });
  assert.equal(r2.code, "test_database_unsafe", "a goal without a mode as well");
  await m.shutdown();
});

// ---------------- preparation (LC-5, LC-6) ----------------

test("preparation: a changed lock file makes the install needed again; the .env step never overwrites .env", async () => {
  const dir = project({ "composer.json": DEPS_COMPOSER, "composer.lock": '{"v":1}', "package.json": DEPS_PKG, "package-lock.json": '{"v":1}' });
  const steps = await suggestPrepare(dir);
  fs.mkdirSync(path.join(dir, "vendor")); fs.writeFileSync(path.join(dir, "vendor/autoload.php"), "<?php");
  fs.mkdirSync(path.join(dir, "node_modules")); fs.writeFileSync(path.join(dir, "node_modules/.package-lock.json"), "{}");
  assert.deepEqual(await neededSteps(dir, steps), [], "installed after the lock");
  const known = await lockFingerprints(dir, steps);
  assert.deepEqual(Object.keys(known).sort(), ["composer.lock", "package-lock.json"]);
  assert.deepEqual(await neededSteps(dir, steps, known), []);
  fs.writeFileSync(path.join(dir, "composer.lock"), '{"v":2}');
  assert.deepEqual((await neededSteps(dir, steps, known)).map((x) => x.step.command), ["composer install --no-interaction --no-progress"], "against the recorded fingerprint");
  // without a record: a lock newer than what the install left
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, "package-lock.json"), later, later);
  assert.deepEqual((await neededSteps(dir, steps)).map((x) => x.step.command), ["composer install --no-interaction --no-progress", "npm ci"]);

  // Laravel .env: done only with a key; an existing .env is kept, the key generated only when empty
  const lv = laravel({ ".env.example": "APP_KEY=\nAPP_NAME=example\n" });
  const [envStep] = (await suggestPrepare(lv)).filter((s) => s.unless === ".env");
  assert.equal(envStep.command, LARAVEL_ENV_STEP.command);
  fs.writeFileSync(path.join(lv, ".env"), "APP_KEY=\nAPP_NAME=mine\n");
  assert.equal((await neededSteps(lv, [envStep])).length, 1, ".env without a key is not prepared");
  const bin = fs.mkdtempSync(path.join(TMP, "php-"));
  fs.writeFileSync(path.join(bin, "php"), `#!/bin/sh\n[ "$2" = key:generate ] && sed -i.bak 's/^APP_KEY=$/APP_KEY=base64:new/' .env\n`, { mode: 0o755 });
  const sh = (cwd) => execFileSync("/bin/sh", ["-c", envStep.command], { cwd, env: { PATH: `${bin}:/usr/bin:/bin` } });
  sh(lv);
  assert.equal(fs.readFileSync(path.join(lv, ".env"), "utf8"), "APP_KEY=base64:new\nAPP_NAME=mine\n", "the person's .env kept, only the key filled");
  assert.equal((await neededSteps(lv, [envStep])).length, 0);
  fs.writeFileSync(path.join(lv, ".env"), "APP_KEY=base64:mine\n");
  sh(lv);
  assert.equal(fs.readFileSync(path.join(lv, ".env"), "utf8"), "APP_KEY=base64:mine\n", "a set key is never generated again");
});

test("preparation in a worktree: the .env step is added although the project folder has its .env; the test database is read from .env.example", async () => {
  const dir = laravel({ ".env.example": "APP_KEY=\nDB_CONNECTION=mysql\nDB_HOST=prod.db.example.com\n", ".env": "APP_KEY=base64:x\nDB_CONNECTION=sqlite\nDB_DATABASE=:memory:\n" });
  const steps = await suggestPrepare(dir);
  assert.deepEqual(steps.map((s) => s.unless), ["vendor/autoload.php"]);
  assert.deepEqual((await worktreeSteps(dir, steps)).map((s) => s.unless), ["vendor/autoload.php", ".env"]);
  assert.deepEqual((await suggestPrepare(dir, { worktree: true })).map((s) => s.unless), ["vendor/autoload.php", ".env"]);
  const r = await assessReadiness({ ...READY, project: dir, workMode: "worktree", prepare: { steps, auto: true } });
  assert.match(r.items.find((i) => i.id === "prepare").facts.steps, /cp \.env\.example \.env/);
  assert.equal(r.items.find((i) => i.id === "testdb").level, "blocker", "the worktree's .env comes from .env.example");
  const p = await assessReadiness({ ...READY, project: dir, workMode: "project", prepare: { steps, auto: true } });
  assert.equal(p.items.find((i) => i.id === "testdb").level, "ok");
});

test("the separate copy is prepared as a fresh worktree; an npm lock without dependencies needs no npm ci (LC-12)", OPTS, async () => {
  const lock = JSON.stringify({ name: "p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "p", version: "1.0.0" } } });
  const empty = project({ "package.json": '{"name":"p","version":"1.0.0"}', "package-lock.json": lock });
  // nothing to install: no step is suggested (hasSomethingToInstall), and a saved npm ci is not needed either
  assert.deepEqual(await suggestPrepare(empty), []);
  const steps = [{ command: "npm ci", unless: "node_modules/.package-lock.json" }];
  assert.deepEqual(await neededSteps(empty, steps), [], "npm ci would succeed and write no node_modules");
  const withDeps = project({ "package.json": DEPS_PKG, "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } }) });
  assert.equal((await neededSteps(withDeps, steps)).length, 1);
  // the copy starts without the ignored files, as a worktree: every step is listed (folders cloned from the project
  // are skipped once they are, tests/orchestration-copy-deps.test.mjs); a project without them prepares nothing
  const r = await assessReadiness({ ...READY, project: withDeps, commands: ["true"], workMode: "copy", prepare: { steps, auto: true } });
  assert.equal(r.items.find((i) => i.id === "prepare").facts.steps, "npm ci");
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] }), REVIEW, FINAL]) });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["c"], checks: [], commands: ["grep -qx 2 a.txt"], workMode: "copy", mode: "autopilot" } })).ok);
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal((await history(m, runId)).filter((x) => x.type.startsWith("prepare.")).length, 0);
  await m.shutdown();
});

test("a mode of rights the installed CLI does not offer is refused at the start (RT-9)", OPTS, async () => {
  // what the CLI offers is probed (its app-server protocol), never read off a list of versions
  const src = project({});
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN]), MOCK_CODEX_SCHEMA: "no_workspace" }, undefined, "codex-cli 0.155.2");
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["true"], access: { claude: "terminal", codex: "workspace" } });
  const r = await m.create({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot" } });
  assert.equal(r.code, "access_unsupported", JSON.stringify(r));
  assert.equal(r.message, "Codex 0.155.2: the rights mode workspace is not available (schema_missing: sandbox workspace-write)", "the CLI, its version, the mode and what is missing");
  await m.shutdown();
});

test("direnv for a worktree run: never the project's allowance carried over (RT-10.4)", async () => {
  const dir = project({ ".envrc": "export FROM_ENVRC=1\n" });
  const bin = fs.mkdtempSync(path.join(TMP, "direnv-"));
  fs.writeFileSync(path.join(bin, "direnv"), `#!/bin/sh\nif [ "$1" = status ]; then echo '{"state":{"foundRC":{"allowed":0}}}'; exit 0; fi\necho '{"FROM_ENVRC":"1"}'\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  assert.equal((await applyDirenv({ cwd: dir, env, enabled: true })).direnv, "applied", "the project folder itself: allowed");
  const pending = await applyDirenv({ cwd: dir, env, enabled: true, pending: true });
  assert.deepEqual([pending.direnv, pending.env.FROM_ENVRC], ["not_allowed", undefined], "a worktree not created yet: its .envrc was never allowed");
  assert.equal((await applyDirenv({ cwd: project({}), env, enabled: true, pending: true })).direnv, "none");
});

// ---------------- recovery of the preparation (LC-4, UX-5) and its limit (LC-11) ----------------

// The application closes while a preparation step runs. shutdown() stops it (SIGINT to the step's shell), waits for its
// result at most stopGraceMs + 1 s and closes the journal. Whether the step's end is recorded depends only on when the
// step reacts, so each case controls that itself: A) the step exits on SIGINT at once -> prepare.finished(stopped);
// B) the step ignores SIGINT and SIGTERM and ends only on a latch the test sets after shutdown() returned -> no end in
// the journal, reopening shows interrupted. Both: paused(app_closed), the step's process gone, the next step not
// started, nothing written after shutdown, reopening starts nothing, Resume prepares again before the first turn.
const tree = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      const st = fs.lstatSync(f);
      out[path.relative(dir, f)] = e.isDirectory() ? `d:${st.mtimeMs}` : `${st.size}:${st.mtimeMs}`;
      if (e.isDirectory()) walk(f);
    }
  };
  walk(dir);
  return out;
};
async function closedDuringPreparation(stepBody, { late }) {
  const src = project({});
  const root = path.join(TMP, `root-${++n}`);
  const env = { MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC(), REVIEW, FINAL]) };
  const m = manager(env, root);
  const quick = path.join(TMP, `quick-${++n}`), pidFile = path.join(TMP, `pid-${++n}`), latch = path.join(TMP, `latch-${++n}`);
  // the same step is quick after the resume; the second step must not start before it
  await createProfileStore(root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["test -f prepared.txt", "test -f second.txt"],
    prepare: { steps: [
      { command: `[ -f ${quick} ] || { ${stepBody({ pidFile, latch })}; }; touch prepared.txt`, unless: "prepared.txt" },
      { command: "touch second.txt", unless: "second.txt" }
    ], auto: true } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot" } })).ok);
  // the step's shell wrote its pid after installing its traps: a stop from here on meets the reaction under test
  const pid = await until(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, "utf8")), "the step's shell ready");
  assert.equal((await view(m, runId)).active?.kind, "prepare");
  await m.shutdown();
  const journalFile = path.join(root, "runs", runId, "journal.jsonl");
  const atClose = { root: tree(root), src: tree(src), journal: fs.readFileSync(journalFile) };
  if (late) {
    assert.ok(alive(pid), "B: the step outlived shutdown(), so its result could not be recorded");
    fs.writeFileSync(latch, ""); // the step ends now (exit 0: a late success that must continue nothing)
  }
  assert.ok(await waitDead(pid, 10_000), "the step's process is gone");
  await sleep(500); // the late result has reached the closed run: anything it did would show now
  assert.deepEqual(tree(root), atClose.root, "nothing written in the application's folder after shutdown");
  assert.deepEqual(tree(src), atClose.src, "the project is not changed after shutdown");
  assert.ok(!fs.existsSync(path.join(src, "prepared.txt")) && !fs.existsSync(path.join(src, "second.txt")), "the step did not continue, the next step did not start");

  const m2 = manager(env, root);
  const v = await view(m2, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "app_closed"]);
  assert.deepEqual([v.workMode, v.workDir], ["project", src], "the run nobody holds shows where it works");
  assert.equal(v.progress.prepare.status, late ? "interrupted" : "stopped");
  await sleep(300);
  assert.ok(fs.readFileSync(journalFile).equals(atClose.journal), "reopening records and starts nothing");
  assert.deepEqual(tree(src), atClose.src);
  fs.writeFileSync(quick, "");
  await resume(m2, v);
  const done = await settled(m2, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  const recs = await history(m2, runId);
  assert.deepEqual(recs.filter((x) => x.type === "prepare.started").map((x) => x.data.reason), ["start", "start"], "prepared again after the resume");
  assert.deepEqual(recs.filter((x) => x.type === "prepare.finished").map((x) => x.data.status), late ? ["done"] : ["stopped", "done"]);
  const types = recs.map((x) => x.type);
  assert.ok(types.lastIndexOf("prepare.finished") < types.indexOf("turn.intent"), "before the first model turn");
  assert.ok(fs.existsSync(path.join(src, "prepared.txt")) && fs.existsSync(path.join(src, "second.txt")));
  assert.equal((await m2.get(runId)).value.integrity, "ok", "the journal replays: a preparation left in flight is followed by a new one");
  await m2.shutdown();
}

test("closed during preparation, A: the stopped step's result is in before the journal closes (prepare.finished stopped)", OPTS, () =>
  closedDuringPreparation(({ pidFile }) => `trap 'kill $! 2>/dev/null; exit 130' INT; echo $$ > ${pidFile}; sleep 30 & wait $!`, { late: false }));

test("closed during preparation, B: the step outlives shutdown(), reopening sees the preparation interrupted", OPTS, () =>
  closedDuringPreparation(({ pidFile, latch }) => `trap '' INT TERM; echo $$ > ${pidFile}; while [ ! -f ${latch} ]; do sleep 0.1; done; exit 0`, { late: true }));

test("a check that breaks its own environment again is prepared for once per executor turn, then the person decides", OPTS, async () => {
  const src = project({ "package.json": DEPS_PKG, "package-lock.json": "{}" });
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC(), REVIEW, FINAL]) });
  const runId = randomUUID();
  const cmd = `rm -rf node_modules; echo "Error: Cannot find module 'left-pad'"; exit 1`;
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: [cmd], mode: "autopilot" } })).ok);
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "needs_user_action"]);
  const recs = await history(m, runId);
  assert.deepEqual(recs.filter((x) => x.type === "prepare.started").map((x) => x.data.reason), ["start", "check"]);
  assert.equal(recs.filter((x) => x.type === "check.started").length, 2);
  await m.shutdown();
});

// ---------------- actions after success (LC-7, LC-8, LC-9, LC-10) ----------------

function remoteFor(src) {
  const remote = path.join(TMP, `remote-${++n}.git`);
  g(TMP, "init", "-q", "--bare", remote);
  g(src, "remote", "add", "qa", remote);
  return remote;
}

test("a commit that does not hold the checked content is not done, and nothing is pushed (LC-7)", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  fs.writeFileSync(path.join(src, ".git/hooks/pre-commit"), "#!/bin/sh\necho 999 > a.txt\ngit add a.txt\n", { mode: 0o755 });
  const remote = remoteFor(src);
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] }), REVIEW, FINAL]) });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "worktree", checks: ["grep -qx 2 a.txt"],
    finish: { commit: true, push: { remote: "qa", branch: "qa-branch", remoteUrl: remote }, qa: null } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["c"], checks: [], mode: "autopilot", finish: { commit: true, push: true, qa: false } } })).ok);
  // the hook changed the work folder: the commit is not done, and the changed state goes back to the checks (the fake
  // lead has no more answers, so the run stops there)
  const v = await settled(m, runId);
  assert.equal(v.status, "paused", JSON.stringify(v));
  const [commit, push] = v.progress.finish;
  assert.deepEqual([commit.status, push.status], ["failed", "not_started"]);
  assert.throws(() => g(remote, "rev-parse", "--verify", "-q", "refs/heads/qa-branch"), "nothing reached the remote");
  const res = (await history(m, runId)).find((x) => x.type === "finish.result");
  assert.match(res.data.tree, /^[0-9a-f]{40}$/, "the result names the tree it was for");
  await m.shutdown();
});

test("a confirmed commit of an older state is committed again and only the commit of the checked state is pushed (LC-7)", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const flag = path.join(TMP, `hook-${++n}`);
  // once, after the first commit: the work folder changes (a.txt = 999), so the checked state is no longer the committed one
  fs.writeFileSync(path.join(src, ".git/hooks/post-commit"), `#!/bin/sh\n[ -f ${flag} ] || { touch ${flag}; echo 999 > a.txt; }\n`, { mode: 0o755 });
  const remote = remoteFor(src);
  const W = EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] });
  const W2 = EXEC({ writes: [{ rel: "a.txt", base64: b64("2\nagain\n") }] }); // a checked state other than the first commit's
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, W, REVIEW, FINAL, FINAL, PLAN, W2, REVIEW, FINAL, FINAL, FINAL]) });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "worktree", checks: ["grep -qx 2 a.txt"],
    finish: { commit: true, push: { remote: "qa", branch: "qa-branch", remoteUrl: remote }, qa: null } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["c"], checks: [], mode: "autopilot", finish: { commit: true, push: true, qa: false } } })).ok);
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  const results = (await history(m, runId)).filter((x) => x.type === "finish.result");
  const commits = results.filter((x) => x.data.commit && x.data.status === "done").map((x) => x.data.commit);
  assert.ok(new Set(commits).size >= 2, "committed again for the new checked state");
  const [commit, push] = done.progress.finish;
  assert.equal(push.commit, commit.commit, "the push delivers the commit of the checked state");
  assert.equal(g(remote, "show", "qa-branch:a.txt"), "2\nagain\n");
  await m.shutdown();
});

test("QA: a deploy that went through with a failing verification is 'deployed, not confirmed'; resuming runs only the verification (LC-8)", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const count = path.join(TMP, `qa-count-${++n}`);
  const gate = path.join(TMP, `qa-gate-${n}`);
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] }), REVIEW, FINAL]) });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["true"],
    finish: { commit: true, push: null, qa: { environment: "qa", command: `echo run >> ${count}`, verify: `test -f ${gate}` } } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot", finish: { commit: true, push: false, qa: true } } })).ok);
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "finish_unconfirmed"]);
  const qa = v.progress.finish.find((f) => f.step === "qa");
  assert.deepEqual([qa.status, qa.version ?? null], ["unknown", null], "deployed, not confirmed: the verification did not pass, so no version was established");
  fs.writeFileSync(gate, "");
  await resume(m, v);
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(fs.readFileSync(count, "utf8").trim().split("\n").length, 1, "the deploy ran once");
  assert.deepEqual(done.progress.finish.find((f) => f.step === "qa").status, "done");
  assert.equal(done.progress.finish.find((f) => f.step === "qa").version, "not_checked", "a passing verification without the version contract confirms no version");
  await m.shutdown();
});

test("closed during a QA deploy that outlives shutdown(): its late success starts no verification and writes nothing", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const pidFile = path.join(TMP, `pid-${++n}`), latch = path.join(TMP, `latch-${n}`), verified = path.join(TMP, `verified-${n}`);
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] }), REVIEW, FINAL]) });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["true"], finish: { commit: true, push: null, qa: { environment: "qa",
    command: `trap '' INT TERM; echo $$ > ${pidFile}; while [ ! -f ${latch} ]; do sleep 0.1; done; exit 0`, verify: `touch ${verified}` } } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot", finish: { commit: true, push: false, qa: true } } })).ok);
  const pid = await until(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, "utf8")), "the deploy running");
  await m.shutdown();
  const atClose = { root: tree(m.root), src: tree(src) };
  assert.ok(alive(pid), "the deploy outlived shutdown()");
  fs.writeFileSync(latch, "");
  assert.ok(await waitDead(pid, 10_000));
  await sleep(500);
  assert.ok(!fs.existsSync(verified), "no verification started after shutdown");
  assert.deepEqual(tree(m.root), atClose.root, "nothing written after shutdown");
  assert.deepEqual(tree(src), atClose.src);
  // reopened: the deploy's outcome is unknown; only the verification runs, after the person's resume, and its
  // established result replays after the intent the earlier process left in flight
  const m2 = manager({}, m.root);
  const v = await view(m2, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "app_closed"]);
  await resume(m2, v);
  const asked = await settled(m2, runId, "the pause before the verification");
  assert.deepEqual([asked.reason, asked.progress.finish[2].status], ["finish_unconfirmed", "outcome_unknown"]);
  assert.ok(!fs.existsSync(verified));
  await resume(m2, asked);
  const done = await settled(m2, runId);
  assert.deepEqual([done.status, done.progress.finish[2].status, done.progress.finish[2].established], ["completed", "done", true], JSON.stringify(done));
  assert.ok(fs.existsSync(verified));
  assert.equal((await m2.get(runId)).value.integrity, "ok");
  await m2.shutdown();
});

test("a QA deploy that succeeds while the application closes: its verification does not start; after the restart it runs once, on resume", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const [pidFile, latch, gotInt, verified, deploys] = ["pid", "latch", "int", "verified", "deploys"].map((x) => path.join(TMP, `${x}-${++n}`));
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] }), REVIEW, FINAL]) });
  // the deploy notes the stop (SIGINT from shutdown) and ends with success on the latch: inside the shutdown window
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["true"], finish: { commit: true, push: null, qa: { environment: "qa",
    command: `echo d >> ${deploys}; trap 'touch ${gotInt}' INT; trap '' TERM; echo $$ > ${pidFile}; while [ ! -f ${latch} ]; do sleep 0.1; done; exit 0`,
    verify: `echo v >> ${verified}` } } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot", finish: { commit: true, push: false, qa: true } } })).ok);
  const pid = await until(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, "utf8")), "the deploy running");
  const closing = m.shutdown();
  await until(() => fs.existsSync(gotInt), "the deploy asked to stop");
  fs.writeFileSync(latch, "");
  await closing;
  assert.ok(await waitDead(pid, 10_000));
  assert.ok(!fs.existsSync(verified), "no verification started in the shutdown window");
  const m2 = manager({}, m.root);
  const v = await view(m2, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "app_closed"]);
  await resume(m2, v);
  const asked = await settled(m2, runId, "the pause before the verification");
  assert.deepEqual([asked.reason, asked.progress.finish[2].status], ["finish_unconfirmed", "outcome_unknown"]);
  assert.ok(!fs.existsSync(verified), "the verification is the person's command: not before the resume");
  await resume(m2, asked);
  const done = await settled(m2, runId);
  assert.deepEqual([done.status, done.progress.finish[2].status, done.progress.finish[2].established], ["completed", "done", true], JSON.stringify(done));
  assert.deepEqual([fs.readFileSync(deploys, "utf8"), fs.readFileSync(verified, "utf8")], ["d\n", "v\n"], "one deploy, one verification");
  assert.equal((await m2.get(runId)).value.integrity, "ok");
  await m2.shutdown();
});

test("push: a push URL or a rewrite the person did not allow stops the push before anything is sent (LC-9)", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const remote = remoteFor(src);
  const other = path.join(TMP, `other-${++n}.git`);
  g(TMP, "init", "-q", "--bare", other);
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] }), REVIEW, FINAL]) });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "worktree", checks: ["grep -qx 2 a.txt"],
    finish: { commit: true, push: { remote: "qa", branch: "qa-branch", remoteUrl: remote }, qa: null } });
  g(src, "config", "remote.qa.pushurl", other);
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["c"], checks: [], mode: "autopilot", finish: { commit: true, push: true, qa: false } } })).ok);
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "needs_user_action"], JSON.stringify(v));
  assert.throws(() => g(other, "rev-parse", "--verify", "-q", "refs/heads/qa-branch"), "nothing was pushed to the other address");
  assert.equal(remoteUrlsMatch(`${remote}\n`, `${remote}\n`, remote), true);
  assert.equal(remoteUrlsMatch(`${remote}\n`, `${remote}\n${other}\n`, remote), false);
  assert.equal(remoteUrlsMatch(`${remote}\n`, "", remote), false, "both lists are needed");
  assert.equal(remoteUrlsMatch(`${remote}\n`, null, remote), false);
  await m.shutdown();
});

test("files the environment preparation made are left out of the commit (LC-10)", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "package.json": DEPS_PKG });
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] }), REVIEW, FINAL]) });
  // what `npm install` does without a lock file: node_modules (ignored) and a new package-lock.json (not ignored)
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["grep -qx 2 a.txt"],
    prepare: { steps: [{ command: "mkdir -p node_modules && echo '{}' > package-lock.json", unless: "node_modules" }], auto: true } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["c"], checks: [], mode: "autopilot", finish: { commit: true, push: false, qa: false } } })).ok);
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.deepEqual(g(src, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["a.txt"]);
  assert.equal(g(src, "status", "--porcelain").trim(), "?? package-lock.json", "left in the folder for the person");
  await m.shutdown();
});

// ---------------- saved permissions: a prompt the CLI must show to the person (RT-2) ----------------

test("a prompt the CLI marks for the person is never answered by a saved decision nor offered to be saved", OPTS, async () => {
  const src = project({});
  const lint = { tool: "Bash", command: "npm run lint" };
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ asks: [lint, { ...lint, request: { decision_reason_type: "rule" } }] }), REVIEW, FINAL]) });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"], mode: "autopilot" } })).ok);
  const first = await asking(m, runId);
  assert.ok(first.permission.options.includes("allow_project"));
  await m.command(runId, { commandId: randomUUID(), expectedRevision: first.revision, command: { kind: "permission", requestId: first.permission.requestId, decision: "allow_project" } });
  const second = await until(async () => { const v = await view(m, runId); return v.permission && v.permission.requestId !== first.permission.requestId ? v : null; }, "the rule's prompt");
  assert.equal(second.permission.alwaysAsk, true);
  assert.deepEqual(second.permission.options.filter((o) => o === "allow_run" || o === "allow_project"), []);
  await m.command(runId, { commandId: randomUUID(), expectedRevision: second.revision, command: { kind: "permission", requestId: second.permission.requestId, decision: "allow_once" } });
  assert.equal((await settled(m, runId)).status, "completed");
  assert.equal((await history(m, runId)).filter((x) => x.type === "permission.applied").length, 0);
  await m.shutdown();
});
