// Stage 13 (docs/agent-orchestration/implementation/stage-13-autopilot.md): autopilot, the project profile, environment
// preparation, saved permissions, MCP forms, plan exit, sub-agents, actions after success and their recovery.
// Fake CLIs and fake programs (npm, composer, php) only; the push target is a local bare repository, QA is a script.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { accessMapping, claudeAccessArgs, claudeModesFromHelp, codexAccessParams } from "../src/main/services/orchestration/access.ts";
import { createFrameMapper } from "../src/main/services/orchestration/activity.ts";
import { commitMessage, remoteHead, resultOid } from "../src/main/services/orchestration/finish.ts";
import { parseFormSchema, validateForm } from "../src/main/services/orchestration/forms.ts";
import { applyDirenv } from "../src/main/services/orchestration/loginEnv.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { LARAVEL_ENV_STEP, classifyFailure, laravelTestDb, neededSteps, suggestPrepare } from "../src/main/services/orchestration/prepare.ts";
import { probeClaude, probeCodex } from "../src/main/services/orchestration/probe.ts";
import { createProfileStore, grantFingerprint, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { assessReadiness } from "../src/main/services/orchestration/readiness.ts";
import { claudeHostDriver, codexAppServerDriver } from "../src/main/services/orchestration/sessions.ts";
import { parseCommand, parseCreate } from "../src/main/ipc/orchestrationIpc.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const SUPERVISOR = path.join(HERE, "..", "src", "orchestration", "supervisor.mjs");
const LAUNCH = { command: NODE, args: [SUPERVISOR], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-autopilot-")));
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

function providersFile(env) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
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

function manager(env, root = path.join(TMP, `root-${++n}`)) {
  const m = createRunManager({
    root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providersFile(env), () => LAUNCH)
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

// ---------------- pieces ----------------

test("rights: each mode says what it turns into; the installed Claude's own --help decides what is offered", () => {
  assert.deepEqual(claudeAccessArgs("terminal"), []);
  assert.deepEqual(claudeAccessArgs("acceptEdits"), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(claudeAccessArgs("full"), ["--dangerously-skip-permissions"]);
  assert.deepEqual(codexAccessParams("terminal"), {});
  assert.deepEqual(codexAccessParams("full"), { sandbox: "danger-full-access", approvalPolicy: "never" });
  assert.match(accessMapping("codex", "terminal"), /config\.toml/);
  const help = execFileSync(CLAUDE, ["--help"], { encoding: "utf8" });
  assert.deepEqual(claudeModesFromHelp(help), ["terminal", "acceptEdits", "auto", "full"]);
  assert.deepEqual(claudeModesFromHelp("Usage: claude"), ["terminal"], "an older CLI without the choices offers only the terminal mode");
});

test("preparation: steps from lock files, only the missing ones; failures are told apart", async () => {
  const dir = project({ "package.json": "{}", "package-lock.json": "{}", "composer.json": "{}", artisan: "", ".env.example": "APP_KEY=\n" });
  const steps = await suggestPrepare(dir);
  // the .env step never overwrites an existing .env and generates the key only when it is empty (review LC-5)
  assert.deepEqual(steps.map((s) => s.command), ["composer install --no-interaction --no-progress", LARAVEL_ENV_STEP.command, "npm ci"]);
  fs.mkdirSync(path.join(dir, "vendor"));
  fs.writeFileSync(path.join(dir, "vendor", "autoload.php"), "");
  assert.deepEqual((await neededSteps(dir, steps)).map((x) => x.index), [1, 2]);
  assert.equal(classifyFailure("sh: phpunit: command not found", 127), "environment");
  assert.equal(classifyFailure("SQLSTATE[HY000] [2002] Connection refused", 1), "environment");
  assert.equal(classifyFailure("curl error 6 while downloading https://repo.packagist.org: Could not resolve host", 1), "external");
  assert.equal(classifyFailure("Failed asserting that false is true.", 1), "code");
  // never the production database for the tests
  fs.writeFileSync(path.join(dir, ".env"), "DB_CONNECTION=mysql\nDB_HOST=prod.db.example.com\nDB_DATABASE=shop\n");
  assert.equal((await laravelTestDb(dir, async () => true)).risky, true);
  fs.writeFileSync(path.join(dir, "phpunit.xml"), '<phpunit><php><env name="DB_CONNECTION" value="sqlite"/><env name="DB_DATABASE" value=":memory:"/></php></phpunit>');
  const db = await laravelTestDb(dir, async () => true);
  assert.deepEqual([db.risky, db.source, db.connection], [false, "phpunit", "sqlite"]);
});

test("readiness: missing dependencies are prepared, not sent to the terminal; a production test database blocks", async () => {
  const dir = project({ "composer.json": "{}", artisan: "", ".env": "DB_CONNECTION=mysql\nDB_HOST=10.1.2.3\n" }, { ignore: "vendor/\n" });
  const base = { project: dir, commands: ["vendor/bin/phpunit"], workMode: "project", platform: "darwin", gitPath: GIT, busy: false,
    runtime: { ok: true, versions: { codex: "codex-cli 0.155.1", claude: "2.1.281" }, env: { PATH: "/usr/bin" }, shell: "/bin/sh", direnv: "not_allowed" },
    checkedVersions: { codex: ["0.155.1"], claude: ["2.1.281"] }, dbProbe: async () => true };
  const r = await assessReadiness({ ...base, prepare: { steps: await suggestPrepare(dir), auto: true } });
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.equal(by.prepare.level, "info");
  assert.equal(by.laravel.level, "ok", JSON.stringify(by.laravel));
  assert.equal(by.command_1.detail, "vendor/bin/phpunit appears after preparation");
  assert.equal(by.testdb.level, "blocker");
  assert.equal(by.direnv.level, "warning");
  assert.equal(r.ready, false);
  const off = await assessReadiness({ ...base, prepare: { steps: await suggestPrepare(dir), auto: false } });
  assert.equal(off.items.find((i) => i.id === "prepare").level, "warning");
});

test("MCP forms: fields from the schema, the answer checked against them, nothing filled in", () => {
  const f = parseFormSchema({ type: "object", required: ["email", "env"], properties: {
    email: { type: "string", format: "email", title: "Email" }, count: { type: "integer", minimum: 1, maximum: 5 },
    env: { type: "string", oneOf: [{ const: "qa", title: "QA" }, { const: "stage", title: "Stage" }] }, ok: { type: "boolean", default: true },
    tags: { type: "array", items: { enum: ["a", "b"] }, maxItems: 1 } } });
  assert.equal(f.mode, "form");
  assert.deepEqual(f.fields.map((x) => x.type), ["string", "integer", "enum", "boolean", "multi"]);
  assert.equal(f.fields[3].default, true, "the server's own default only");
  assert.deepEqual(validateForm(f.fields, {}).errors, { email: "required", env: "required" });
  assert.equal(validateForm(f.fields, { email: "x", env: "qa" }).errors.email, "an email address");
  assert.equal(validateForm(f.fields, { email: "a@b.co", env: "qa", count: "9" }).errors.count, "at most 5");
  assert.equal(validateForm(f.fields, { email: "a@b.co", env: "qa", tags: ["a", "b"] }).errors.tags, "at most 1");
  assert.equal(validateForm(f.fields, { email: "a@b.co", env: "qa", secret: "x" }).errors.secret, "unknown field");
  assert.deepEqual(validateForm(f.fields, { email: "a@b.co", env: "qa", count: "2", ok: false }).content, { email: "a@b.co", env: "qa", count: 2, ok: false });
  assert.equal(parseFormSchema({ type: "object", properties: { x: { type: "object" } } }).mode, "unsupported");
});

test("project profile: saved per project; a grant is found only for the same tool and parameters", async () => {
  const root = path.join(TMP, `profiles-${++n}`);
  const store = createProfileStore(root);
  const a = project({ "package.json": "{}", "package-lock.json": "{}" });
  const b = project({});
  const s = await suggestProfile(a);
  assert.equal(s.savedAt, null);
  assert.deepEqual(s.prepare.steps.map((x) => x.command), ["npm ci"]);
  await store.save(a, { ...s, checks: ["npm test"] });
  assert.equal(await store.get(b), null);
  const fp = grantFingerprint("claude", "command", "Bash", { command: "npm run lint", description: "lint", tool_use_id: "x" });
  assert.equal(fp, grantFingerprint("claude", "command", "Bash", { command: "npm run lint", description: "other words", tool_use_id: "y" }));
  assert.notEqual(fp, grantFingerprint("claude", "command", "Bash", { command: "npm run lint --fix" }));
  assert.notEqual(fp, grantFingerprint("codex", "command", "Bash", { command: "npm run lint" }));
  await store.addGrant(a, { provider: "claude", kind: "command", tool: "Bash", summary: "npm run lint", fingerprint: fp });
  await store.addGrant(a, { provider: "claude", kind: "command", tool: "Bash", summary: "npm run lint", fingerprint: fp });
  assert.equal((await store.get(a)).grants.length, 1);
  await assert.rejects(store.addGrant(b, { provider: "claude", kind: "command", tool: "Bash", summary: "x", fingerprint: fp }), /no saved profile/);
  await assert.rejects(store.save(a, { ...s, finish: { commit: true, push: { remote: "--upload-pack=x", branch: "qa" }, qa: null } }), /remote and branch/);
});

test("direnv: an allowed .envrc is applied, one not allowed is said and not applied", async () => {
  const dir = project({ ".envrc": "export FROM_ENVRC=1\n" });
  const bin = path.join(TMP, `direnv-bin-${++n}`);
  fs.mkdirSync(bin);
  const allowed = path.join(TMP, `allowed-${n}`);
  fs.writeFileSync(path.join(bin, "direnv"), `#!/bin/sh
if [ "$1" = status ]; then if [ -f "${allowed}" ]; then echo '{"state":{"foundRC":{"allowed":0}}}'; else echo '{"state":{"foundRC":{"allowed":2}}}'; fi; exit 0; fi
if [ "$1" = export ]; then echo '{"FROM_ENVRC":"1","REMOVED":null}'; fi
`, { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, REMOVED: "x" };
  const no = await applyDirenv({ cwd: dir, env, enabled: true });
  assert.equal(no.direnv, "not_allowed");
  assert.equal(no.env.FROM_ENVRC, undefined);
  fs.writeFileSync(allowed, "");
  const yes = await applyDirenv({ cwd: dir, env, enabled: true });
  assert.equal(yes.direnv, "applied");
  assert.equal(yes.env.FROM_ENVRC, "1");
  assert.equal(yes.env.REMOVED, undefined);
  assert.equal((await applyDirenv({ cwd: dir, env, enabled: false })).direnv, "off");
  assert.equal((await applyDirenv({ cwd: TMP, env: { PATH: "/usr/bin" }, enabled: true })).direnv, "none");
});

test("finish helpers: a commit message carries the run, the remote's answer is read exactly", () => {
  const id = randomUUID();
  assert.match(commitMessage("Fix login\nmore", id), new RegExp(`^Fix login\\n\\nCanvasTTY-Run: ${id}\\n$`));
  const oid = "a".repeat(40);
  assert.equal(resultOid(`${oid}\n`), oid);
  assert.equal(resultOid(`noise\n${oid}\n`), null, "one id and nothing else");
  assert.equal(resultOid(""), null);
  assert.equal(remoteHead(`${oid}\trefs/heads/qa\n${"b".repeat(40)}\trefs/heads/qa2\n`, "qa"), oid);
  assert.equal(remoteHead("", "qa"), null);
});

test("activity: what each CLI reports it loaded, sub-agents from their own events", () => {
  const c = createFrameMapper("claude", "executor", "/p");
  const ev = (value) => ({ kind: "event", type: value.type ?? value.method ?? "rpc.response", value, bytes: 1 });
  const init = c(ev({ type: "system", subtype: "init", model: "m", tools: ["Task"], mcp_servers: [{ name: "gh", status: "connected" }], skills: ["s1"], plugins: [{ name: "p1" }], slash_commands: ["a"] }))[0];
  assert.equal(init.detail.mcp, "gh (connected)");
  assert.equal(init.detail.skills, "s1");
  assert.equal(init.detail.plugins, "p1");
  const task = c(ev({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Task", input: { description: "explore", subagent_type: "Explore" } }] } }))[0];
  assert.deepEqual([task.kind, task.detail.phase, task.detail.agent], ["subagent", "started", "Explore"]);
  const inner = c(ev({ type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "text", text: "hi" }] } }))[0];
  assert.equal(inner.detail.subagent, "explore");
  const done = c(ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }))[0];
  assert.deepEqual([done.kind, done.detail.phase], ["subagent", "finished"]);
  const x = createFrameMapper("codex", "lead", "/p");
  const th = x(ev({ id: 3, result: { thread: { id: "t" }, model: "gpt", approvalPolicy: "never", sandbox: { type: "dangerFullAccess" }, instructionSources: ["/p/AGENTS.md"], cwd: "/p" } }))[0];
  assert.deepEqual([th.kind, th.detail.approvalPolicy, th.detail.sandbox, th.detail.instructionSources], ["session", "never", "dangerFullAccess", 1]);
  const collab = x(ev({ method: "item/completed", params: { item: { type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", prompt: "check", receiverThreadIds: ["a"] } } }))[0];
  assert.deepEqual([collab.kind, collab.text], ["subagent", "spawnAgent: check"]);
});

test("drivers: an MCP form and a plan are answered with what the person gave", async () => {
  const sent = [];
  const io = { send: (m) => sent.push(m), end() {}, hold() {} };
  const frame = (value, rpc) => ({ kind: "event", type: rpc ? (value.method ?? "rpc.response") : value.type, value, bytes: 1 });
  const replies = [{ decision: "allow_once", content: { env: "qa" } }, { decision: "deny", feedback: "split stage 2" }, { decision: "deny" }];
  const asks = [];
  const c = claudeHostDriver({ task: "t", ask: async (q) => { asks.push(q); return replies.shift(); } });
  c.start(io);
  c.frame(frame({ type: "control_request", request_id: "e", request: { subtype: "elicitation", mcp_server_name: "deploy", message: "Where?", mode: "form",
    requested_schema: { type: "object", properties: { env: { type: "string", enum: ["qa"] } } } } }));
  c.frame(frame({ type: "control_request", request_id: "p", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "1. a\n2. b" } } }));
  c.frame(frame({ type: "control_request", request_id: "u", request: { subtype: "elicitation", mcp_server_name: "x", message: "Sign in", mode: "url", url: "https://x.test/login", elicitation_id: "1" } }));
  await sleep(10);
  const resp = (id) => sent.find((m) => m.type === "control_response" && m.response.request_id === id).response.response;
  assert.equal(asks[0].kind, "elicitation");
  assert.equal(asks[0].form.mode, "form");
  assert.deepEqual(resp("e"), { action: "accept", content: { env: "qa" } });
  assert.equal(asks[1].kind, "plan");
  assert.equal(asks[1].plan, "1. a\n2. b");
  assert.equal(resp("p").behavior, "deny");
  assert.match(resp("p").message, /split stage 2/);
  assert.equal(asks[2].form.mode, "url");
  assert.equal(resp("u").action, "decline");

  const sent2 = [];
  let q = null;
  const d = codexAppServerDriver({ cwd: "/p", task: "t", schema: {}, threadId: null, clientVersion: "t", access: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    ask: async (x) => { q = x; return { decision: "allow_once", content: { n: 2 } }; } });
  d.start({ send: (m) => sent2.push(m), end() {}, hold() {} });
  d.frame(frame({ id: sent2[0].id, result: {} }, true));
  assert.deepEqual(sent2.find((m) => m.method === "thread/start").params, { cwd: "/p", sandbox: "workspace-write", approvalPolicy: "on-request" });
  d.frame(frame({ id: 9, method: "mcpServer/elicitation/request", params: { serverName: "s", mode: "form", message: "n?", requestedSchema: { type: "object", properties: { n: { type: "number" } } } } }, true));
  await sleep(5);
  assert.equal(q.server, "s");
  assert.deepEqual(sent2.find((m) => m.id === 9).result, { action: "accept", content: { n: 2 }, _meta: null });
});

test("IPC: mode, actions after success, the new decisions, form content and plan feedback are validated", () => {
  const goal = { text: "t", criteria: ["c"], checks: [], mode: "autopilot", finish: { commit: true, push: false, qa: false } };
  const c = parseCreate({ requestId: randomUUID(), source: "/p", goal });
  assert.deepEqual([c.goal.mode, c.goal.finish.commit, c.goal.commands], ["autopilot", true, undefined]);
  assert.throws(() => parseCreate({ requestId: randomUUID(), source: "/p", goal: { ...goal, mode: "yolo" } }), /goal.mode/);
  assert.throws(() => parseCreate({ requestId: randomUUID(), source: "/p", goal: { ...goal, finish: { commit: "yes", push: false, qa: false } } }), /finish.commit/);
  assert.throws(() => parseCreate({ requestId: randomUUID(), source: "/p", goal: { ...goal, finish: { commit: true, push: false, qa: false, deploy: true } } }), /not allowed/);
  const base = { runId: randomUUID(), commandId: randomUUID(), expectedRevision: 0 };
  const p = parseCommand({ ...base, command: { kind: "permission", requestId: randomUUID(), decision: "allow_project", content: { a: "x", b: 2, c: true, d: ["x"] }, feedback: "no" } });
  assert.deepEqual([p.command.decision, p.command.content.b, p.command.feedback], ["allow_project", 2, "no"]);
  assert.throws(() => parseCommand({ ...base, command: { kind: "permission", requestId: randomUUID(), decision: "allow_once", content: { a: { deep: 1 } } } }), /form value/);
});

// ---------------- runs ----------------

test("autopilot on a Node project: node_modules missing is prepared, a failing test is fixed, one saved permission is not asked again", OPTS, async () => {
  const src = project({ "package.json": "{}", "package-lock.json": "{}", "value.txt": "1\n" });
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const lint = [{ tool: "Bash", command: "npm run lint" }];
  const dir = script([PLAN, EXEC({ asks: lint }), REVIEW, EXEC({ asks: lint, writes: [{ rel: "value.txt", base64: b64("2\n") }] }), REVIEW, FINAL]);
  const m = manager({ MOCK_STATE: state, MOCK_SCRIPT: dir });
  const before = runs("npm");
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "value must be 2", criteria: ["check passes"], checks: [],
    commands: ["test -f node_modules/.package-lock.json && grep -qx 2 value.txt || { echo 'AssertionError: expected 2'; exit 1; }"], mode: "autopilot" } });
  assert.ok(r.ok, JSON.stringify(r));
  const ask = await asking(m, runId);
  assert.deepEqual(ask.permission.options, ["allow_once", "allow_session", "allow_run", "allow_project", "deny"]);
  assert.equal((await answer(m, ask, "allow_project")).value.status, "accepted");
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(runs("npm") - before, 1, "npm ci ran once, as a preparation step");
  const types = (await history(m, runId)).map((x) => x.type);
  assert.ok(types.indexOf("prepare.finished") < types.indexOf("turn.intent"), "prepared before the first model turn");
  const recs = await history(m, runId);
  assert.equal(recs.find((x) => x.type === "check.classified")?.data.class, "code", "the failing test is the code's business");
  assert.equal(recs.filter((x) => x.type === "permission.applied").length, 1, "the second identical prompt was answered by the saved decision");
  const decisions = fs.readFileSync(path.join(state, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(decisions.map((d) => d.reply.behavior), ["allow", "allow"]);
  assert.equal(done.progress.prepare.status, "done");
  assert.equal(done.progress.checks[0].status, "passed");
  assert.equal(done.progress.grantsApplied, 1);
  assert.deepEqual((await m.changes(runId)).value.files.map((f) => f.path), ["value.txt"]);
  const activity = (await m.activity(runId, 0, 500)).value.entries;
  assert.ok(activity.some((e) => e.kind === "prepare_finished"));
  assert.ok(activity.some((e) => e.kind === "permission_applied"));
  await m.shutdown();

  // the next run of this project: the saved decision applies at once; another project is asked
  const dir2 = script([PLAN, EXEC({ asks: lint }), REVIEW, FINAL]);
  const m2 = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: dir2 }, m.root);
  const run2 = randomUUID();
  assert.ok((await m2.create({ requestId: run2, source: src, goal: { text: "again", criteria: ["c"], checks: [], commands: ["true"], mode: "autopilot" } })).ok);
  assert.equal((await settled(m2, run2)).status, "completed");
  assert.equal((await history(m2, run2)).find((x) => x.type === "permission.applied")?.data.scope, "project");
  const other = project({});
  const dir3 = script([PLAN, EXEC({ asks: lint }), REVIEW, FINAL]);
  const m3 = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: dir3 }, m.root);
  const run3 = randomUUID();
  assert.ok((await m3.create({ requestId: run3, source: other, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"], mode: "autopilot" } })).ok);
  const ask3 = await asking(m3, run3, "the other project's prompt");
  await answer(m3, ask3, "deny");
  await settled(m3, run3);
  await m2.shutdown();
  await m3.shutdown();
});

test("autopilot on a Laravel project from its profile: composer, .env and key are prepared, the test is fixed", OPTS, async () => {
  const src = project({ "composer.json": JSON.stringify({ name: "a/b" }), artisan: "", ".env.example": "APP_KEY=\n", "app.php": "<?php // broken\n",
    "phpunit.xml": '<phpunit><php><env name="DB_CONNECTION" value="sqlite"/></php></phpunit>', "tests/Feature/AppTest.php": "<?php\n" });
  const dir = script([PLAN, EXEC({ writes: [{ rel: "app.php", base64: b64("<?php // fixed\n") }] }), REVIEW, FINAL]);
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: dir });
  const before = { composer: runs("composer"), php: runs("php") };
  const runId = randomUUID();
  // no commands: the profile suggested from the repository gives `php artisan test` and the preparation
  const r = await m.create({ requestId: runId, source: src, goal: { text: "fix the app", criteria: ["tests pass"], checks: [], mode: "autopilot" } });
  assert.ok(r.ok, JSON.stringify(r));
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(runs("composer") - before.composer, 1);
  assert.ok(fs.readFileSync(path.join(src, ".env"), "utf8").includes("APP_KEY=base64"), "the key was generated in .env");
  assert.equal(g(src, "status", "--porcelain").trim(), "M app.php", "vendor/ and .env stay ignored; only the fix is a change");
  const saved = await createProfileStore(m.root).get(src);
  assert.deepEqual(saved.checks, ["php artisan test"]);
  await m.shutdown();
});

test("an environment failure of a check is prepared once, not sent to the agents as a code error", OPTS, async () => {
  // the executor deletes node_modules: the check fails with a missing module, the preparation runs again, the re-check passes
  const src = project({ "package.json": "{}", "package-lock.json": "{}" });
  fs.mkdirSync(path.join(src, "node_modules"));
  fs.writeFileSync(path.join(src, "node_modules", ".package-lock.json"), "{}");
  const dir = script([PLAN, EXEC(), REVIEW, FINAL]);
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: dir });
  const flag = path.join(TMP, `broke-${++n}`);
  const runId = randomUUID();
  // the first check run removes node_modules (as a broken environment would) and fails like a missing module
  const cmd = `if [ ! -f ${flag} ]; then touch ${flag}; rm -rf node_modules; echo "Error: Cannot find module 'left-pad'"; exit 1; fi; test -f node_modules/.package-lock.json`;
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: [cmd], mode: "autopilot" } })).ok);
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  const recs = await history(m, runId);
  assert.equal(recs.find((x) => x.type === "check.classified")?.data.class, "environment");
  assert.deepEqual(recs.filter((x) => x.type === "prepare.started").map((x) => x.data.reason), ["start", "check"]);
  assert.deepEqual(recs.filter((x) => x.type === "prepare.finished").map((x) => x.data.status), ["not_needed", "done"], "nothing was needed at the start; once after the check");
  assert.equal(recs.filter((x) => x.type === "orch.turn" && x.data.purpose === "execute").length, 1, "no extra executor round for an environment problem");
  await m.shutdown();
});

test("MCP form, plan exit and sub-agents reach the panel; a wrong form answer is refused", OPTS, async () => {
  const src = project({});
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const schema = { type: "object", required: ["env"], properties: { env: { type: "string", enum: ["qa", "stage"] }, note: { type: "string", maxLength: 5 } } };
  const dir = script([
    { ...PLAN, asks: [{ tool: "collab" }] },
    EXEC({ asks: [{ tool: "elicitation", schema, message: "Which environment?" }, { tool: "ExitPlanMode", plan: "1. edit\n2. test" }, { tool: "Task" }] }),
    REVIEW, FINAL]);
  const m = manager({ MOCK_STATE: state, MOCK_SCRIPT: dir });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"], mode: "autopilot" } })).ok);
  const form = await asking(m, runId, "the form");
  assert.equal(form.permission.kind, "elicitation");
  assert.equal(form.permission.server, "mock-mcp");
  assert.deepEqual(form.permission.form.fields.map((f) => f.name), ["env", "note"]);
  assert.ok(!form.permission.options.includes("allow_project"), "a form is not a permission to remember");
  const wrong = await answer(m, form, "allow_once", { content: { env: "prod" } });
  assert.equal(wrong.value.code, "invalid_form", JSON.stringify(wrong));
  assert.equal((await answer(m, form, "allow_once", { content: { env: "qa" } })).value.status, "accepted");
  const plan = await until(async () => { const v = await view(m, runId); return v.permission?.kind === "plan" ? v : null; }, "the plan");
  assert.equal(plan.permission.plan, "1. edit\n2. test");
  await answer(m, plan, "deny", { feedback: "test first" });
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  const decisions = fs.readFileSync(path.join(state, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(decisions.find((d) => d.tool === "elicitation").reply, { action: "accept", content: { env: "qa" } });
  const exit = decisions.find((d) => d.tool === "ExitPlanMode").reply;
  assert.equal(exit.behavior, "deny");
  assert.match(exit.message, /test first/);
  const activity = (await m.activity(runId, 0, 500)).value.entries;
  assert.ok(activity.some((e) => e.kind === "subagent" && e.provider === "codex"), "codex sub-agent from collabAgentToolCall");
  assert.ok(activity.some((e) => e.kind === "subagent" && e.provider === "claude" && e.detail?.phase === "finished"));
  assert.ok(activity.some((e) => e.kind === "session" && e.provider === "claude" && e.detail?.mcp === "mock-mcp (connected)"));
  assert.ok(activity.some((e) => e.kind === "session" && e.provider === "codex" && e.detail?.reported === true));
  await m.shutdown();
});

test("rights modes reach each CLI exactly; the probe asks without a model turn", OPTS, async () => {
  const src = project({});
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const m = manager({ MOCK_STATE: state, MOCK_SCRIPT: script([PLAN, EXEC(), REVIEW, FINAL]), MOCK_ALLOW_ACCESS: "1" });
  const store = createProfileStore(m.root);
  await store.save(src, { ...(await suggestProfile(src)), checks: ["true"], access: { claude: "acceptEdits", codex: "workspace" } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot" } })).ok);
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.deepEqual(done.progress.access, { claude: "acceptEdits", codex: "workspace" });
  const argv = JSON.parse(fs.readFileSync(path.join(state, "claude-argv.jsonl"), "utf8").trim().split("\n")[0]);
  assert.deepEqual(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, "codex-access.jsonl"), "utf8").trim().split("\n")[0]), { approvalPolicy: "on-request", sandbox: "workspace-write" });
  await m.shutdown();

  const env = { PATH: "/usr/bin:/bin", HOME: TMP, MOCK_STATE: state };
  const cl = await probeClaude({ executable: CLAUDE, cwd: src, env });
  assert.ok(cl.ok, JSON.stringify(cl));
  const by = Object.fromEntries(cl.items.map((i) => [i.id, i]));
  assert.match(by.mcp.value, /mock-mcp \(connected\)/);
  assert.equal(by.mcp_auth.value, "needs-login");
  assert.equal(by.skills.confirmed, false, "not said by this request: marked unconfirmed");
  const cx = await probeCodex({ executable: CODEX, cwd: src, env });
  assert.ok(cx.ok, JSON.stringify(cx));
  const cby = Object.fromEntries(cx.items.map((i) => [i.id, i]));
  assert.deepEqual([cby.skills.value, cby.plugins.value, cby.hooks.value, cby.sandbox.value], ["1: mock-skill", "1: mock-plugin", "1: SessionStart", "workspace-write"]);
  assert.ok(!fs.existsSync(path.join(state, "decisions.jsonl")), "no turn, no prompt");
});

test("after success in a worktree: commit and push to the configured branch, QA confirmed by its own check", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const remote = path.join(TMP, `remote-${++n}.git`);
  g(TMP, "init", "-q", "--bare", remote);
  g(src, "remote", "add", "qa", remote);
  const deployed = path.join(TMP, `deployed-${n}`);
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] }), REVIEW, FINAL]) });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "worktree", checks: ["grep -qx 2 a.txt"],
    finish: { commit: true, push: { remote: "qa", branch: "qa-branch", remoteUrl: remote },
      qa: { environment: "qa", command: `echo "$CANVASTTY_COMMIT" > ${deployed}`, verify: `cat ${deployed} > "$CANVASTTY_QA_RESULT"`, reportsVersion: true } } });
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "set a to 2", criteria: ["a is 2"], checks: [], mode: "autopilot", finish: { commit: true, push: true, qa: true } } });
  assert.ok(r.ok, JSON.stringify(r));
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  const [commit, push, qa] = done.progress.finish;
  assert.deepEqual([commit.status, push.status, qa.status], ["done", "done", "done"]);
  assert.deepEqual([qa.version, qa.observed], ["confirmed", commit.commit], "the verification reported the delivered commit");
  assert.equal(g(remote, "rev-parse", "refs/heads/qa-branch").trim(), commit.commit);
  assert.match(g(remote, "log", "-1", "--format=%B", "qa-branch"), new RegExp(`CanvasTTY-Run: ${runId}`));
  assert.equal(fs.readFileSync(deployed, "utf8").trim(), commit.commit);
  assert.equal(fs.readFileSync(path.join(src, "a.txt"), "utf8"), "1\n", "the project folder itself is not touched in worktree mode");
  assert.match(done.progress.branch, /^canvastty\//);
  const ch = (await m.changes(runId)).value;
  assert.deepEqual(ch.files.map((f) => f.path), ["a.txt"], JSON.stringify(ch));
  await m.shutdown();
});

test("push and QA are refused unless the project has them configured", OPTS, async () => {
  const src = project({});
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN]) });
  const r = await m.create({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"], mode: "autopilot", finish: { commit: true, push: true, qa: false } } });
  assert.equal(r.code, "finish_not_configured");
  await m.shutdown();
});

// Review LC-8: QA deploys a confirmed commit (a goal with QA and no commit is refused), and after an unknown outcome its
// verification — the person's own command, not known to be read-only — runs only after the person resumes from the
// pause that says so; the deploy is never run again. The verification reports the deployed commit (the version contract).
test("a QA deploy whose answer was lost is never run again: only its verification decides", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const count = path.join(TMP, `qa-count-${++n}`);
  const marker = path.join(TMP, `qa-marker-${n}`);
  const root = path.join(TMP, `root-${++n}`);
  const env = { MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] }), REVIEW, FINAL]) };
  const m = manager(env, root);
  await createProfileStore(root).save(src, { ...(await suggestProfile(src)), checks: ["true"],
    finish: { commit: true, push: null, qa: { environment: "qa", command: `echo run >> ${count}; echo "$CANVASTTY_COMMIT" > ${marker}; sleep 60`, verify: `cat ${marker} > "$CANVASTTY_QA_RESULT"`, reportsVersion: true } } });
  assert.equal((await m.create({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot", finish: { commit: false, push: false, qa: true } } })).code, "invalid_goal");
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot", finish: { commit: true, push: false, qa: true } } })).ok);
  await until(async () => fs.existsSync(marker), "the deploy started");
  await m.shutdown(); // the application ends while the deploy runs: its outcome is not known
  const m2 = manager(env, root);
  const v = await view(m2, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "app_closed"], JSON.stringify(v));
  await sleep(500);
  assert.equal((await view(m2, runId)).revision, v.revision, "nothing runs by itself after the restart");
  await m2.command(runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "resume" } });
  const asked = await settled(m2, runId, "the pause before the verification");
  assert.deepEqual([asked.status, asked.reason], ["paused", "finish_unconfirmed"], "the verification waits for the person");
  assert.equal((await history(m2, runId)).filter((x) => x.type === "finish.result" && x.data.established).length, 0);
  await m2.command(runId, { commandId: randomUUID(), expectedRevision: asked.revision, command: { kind: "resume" } });
  const done = await settled(m2, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(fs.readFileSync(count, "utf8").trim().split("\n").length, 1, "the deploy command ran once");
  const qa = done.progress.finish.find((f) => f.step === "qa");
  const commit = done.progress.finish.find((f) => f.step === "commit");
  assert.deepEqual([qa.status, qa.established, qa.version, qa.observed, qa.commit], ["done", true, "confirmed", commit.commit, commit.commit]);
  await m2.shutdown();
});

test("step by step: the plan is shown and the run stops after each stage", OPTS, async () => {
  const src = project({});
  const two = { answer: { stages: [{ title: "one", task: "a" }, { title: "two", task: "b" }], question: null } };
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([two, EXEC(), REVIEW, EXEC(), REVIEW, FINAL]) });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"], mode: "steps" } })).ok);
  const plan = await settled(m, runId, "the plan");
  assert.equal(plan.reason, "plan_review", JSON.stringify(plan));
  await m.command(runId, { commandId: randomUUID(), expectedRevision: plan.revision, command: { kind: "resume" } });
  const stage = await until(async () => { const v = await view(m, runId); return v.status === "paused" && v.reason === "stage_done" ? v : null; }, "stage 1 done");
  await m.command(runId, { commandId: randomUUID(), expectedRevision: stage.revision, command: { kind: "resume" } });
  const end = await until(async () => { const v = await view(m, runId); return v.status === "completed" || (v.status === "paused" && v.revision !== stage.revision && v.reason === "stage_done") ? v : null; }, "stage 2");
  if (end.status !== "completed") await m.command(runId, { commandId: randomUUID(), expectedRevision: end.revision, command: { kind: "resume" } });
  assert.equal((await settled(m, runId)).status, "completed");
  await m.shutdown();
});

test("stop during preparation; after a restart a waiting prompt is not carried over and nothing runs by itself", OPTS, async () => {
  const src = project({});
  const root = path.join(TMP, `root-${++n}`);
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN]) }, root);
  await createProfileStore(root).save(src, { ...(await suggestProfile(src)), checks: ["true"], prepare: { steps: [{ command: "sleep 60", unless: null }], auto: true } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["c"], checks: [], mode: "autopilot" } })).ok);
  const prep = await until(async () => { const v = await view(m, runId); return v.active?.kind === "prepare" ? v : null; }, "preparing");
  await m.command(runId, { commandId: randomUUID(), expectedRevision: prep.revision, command: { kind: "stop" } });
  const stopped = await settled(m, runId);
  assert.equal(stopped.status, "stopped");
  assert.equal((await history(m, runId)).find((x) => x.type === "prepare.finished").data.status, "stopped");
  await m.shutdown();

  const src2 = project({});
  const env = { MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ asks: [{ tool: "Bash", command: "make deploy" }] }), EXEC({ asks: [{ tool: "Bash", command: "make deploy" }] }), REVIEW, FINAL]) };
  const a = manager(env, root);
  const run2 = randomUUID();
  assert.ok((await a.create({ requestId: run2, source: src2, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"], mode: "autopilot" } })).ok);
  const first = await asking(a, run2);
  await a.shutdown(); // the application ends while the prompt waits
  const b = manager(env, root);
  const after = await view(b, run2);
  assert.equal(after.status, "paused");
  assert.equal(after.permission ?? null, null, "the old process's prompt is gone with it");
  await sleep(500);
  assert.equal((await view(b, run2)).revision, after.revision, "nothing started by itself after the restart");
  await b.command(run2, { commandId: randomUUID(), expectedRevision: after.revision, command: { kind: "resume" } });
  const again = await asking(b, run2, "the prompt of the new turn");
  assert.notEqual(again.permission.requestId, first.permission.requestId);
  await answer(b, again, "allow_once");
  assert.equal((await settled(b, run2)).status, "completed");
  await b.shutdown();
});

test("panel model: the board says who works, what is checked and whether the person must act", async () => {
  const { board, runHeadline, availableActions } = await import("../src/renderer/src/features/orchestration/runModel.ts");
  const progress = { mode: "autopilot", branch: null, access: null, prepare: { status: "done", failed: null, class: null }, finish: [], grantsApplied: 2,
    checks: [{ id: "cmd-1", title: "npm test", status: "passed", class: null }, { id: "cmd-2", title: "npm run lint", status: "failed", class: "environment" }] };
  const base = { runId: "r", status: "running", reason: null, revision: 1, stage: 1, turns: 1, halted: false, permission: null, progress };
  const b = board({ ...base, active: { kind: "prepare" } });
  assert.deepEqual([b.who, b.checked.passed, b.checked.total, b.checked.failed[0].class, b.action, b.grantsApplied], ["prepare", 1, 2, "environment", false, 2]);
  assert.equal(board({ ...base, active: { kind: "finish", step: "push" } }).finishStep, "push");
  const paused = (reason) => ({ ...base, status: "paused", reason, active: null });
  assert.equal(runHeadline(paused("needs_user_action")).headline, "needs_action");
  assert.equal(runHeadline(paused("external_failure")).headline, "needs_setup");
  assert.equal(runHeadline(paused("finish_unconfirmed")).headline, "needs_decision");
  assert.equal(board(paused("stage_done")).action, true);
  for (const r of ["stage_done", "external_failure", "needs_user_action", "finish_unconfirmed"]) assert.ok(availableActions(paused(r)).includes("resume"), r);
});

test("a commit in the project folder takes only the run's files; the changes stay listed against the start", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "mine.txt": "x\n" });
  fs.writeFileSync(path.join(src, "mine.txt"), "the person's own edit\n");
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC({ writes: [{ rel: "a.txt", base64: b64("2\n") }] }), REVIEW, FINAL]) });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["c"], checks: [], commands: ["grep -qx 2 a.txt"], mode: "autopilot", finish: { commit: true, push: false, qa: false } } })).ok);
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.deepEqual(g(src, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["a.txt"], "only the run's file is in the commit");
  assert.equal(g(src, "status", "--porcelain").trim(), "M mine.txt", "the person's own edit stays uncommitted");
  assert.deepEqual((await m.changes(runId)).value.files.map((f) => f.path), ["a.txt"]);
  await m.shutdown();
});
