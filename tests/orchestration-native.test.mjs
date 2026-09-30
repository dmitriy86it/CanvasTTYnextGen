// Stage 12 (docs/agent-orchestration/implementation/stage-12-native-sessions.md): the agents as the user runs them.
// Fake CLIs speak the two protocols (codex app-server, claude stream-json with host permission prompts); no model runs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { captureLoginEnv } from "../src/main/services/orchestration/loginEnv.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { NATIVE_PROTOCOL_CHECKED, buildNativeTurn } from "../src/main/services/orchestration/providers.ts";
import { assessReadiness, suggestCommands } from "../src/main/services/orchestration/readiness.ts";
import { claudeHostDriver, codexAppServerDriver } from "../src/main/services/orchestration/sessions.ts";
import { checkTurnSpec, sessionEnv } from "../src/main/services/orchestration/turn.ts";
import { createWorkspace, applyTreeToCopy, snapshotCopyTree } from "../src/main/services/orchestration/workspace.ts";
import { parseCommand, parseCreate } from "../src/main/ipc/orchestrationIpc.ts";
import { runHeadline } from "../src/renderer/src/features/orchestration/runModel.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const SUPERVISOR = path.join(HERE, "..", "src", "orchestration", "supervisor.mjs");
const LAUNCH = { command: NODE, args: [SUPERVISOR], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-native-")));
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
function project({ dirty = true } = {}) {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "project\n");
  fs.writeFileSync(path.join(dir, "user.txt"), "committed\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  if (dirty) fs.writeFileSync(path.join(dir, "user.txt"), "the user's uncommitted work\n");
  return dir;
}
// Wrapper executables for the fake CLIs (a provider CLI is one executable path).
function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
function providersFile(env) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: "/bin/sh", checkEnv: { PATH: "/usr/bin:/bin", HOME: TMP }
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
const PLAN = { answer: { stages: [{ title: "note", task: "add note.txt" }], question: null } };
const REVIEW = { answer: { verdict: "accept", findings: [], question: null } };
const FINAL = { answer: { verdict: "complete", findings: [], question: null } };
const b64 = (s) => Buffer.from(s).toString("base64");

function manager(env) {
  const root = path.join(TMP, `root-${++n}`);
  const file = providersFile(env);
  return createRunManager({
    root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("the restricted runtime is not used by a native goal"); },
    native: testNativeRuntime(file, () => LAUNCH)
  });
}

// ---------------- the protocol drivers ----------------

function fakeIo() {
  const sent = [];
  let ended = false, held = 0;
  return { sent, io: { send: (m) => sent.push(m), end: () => { ended = true; }, hold: (on) => { held += on ? 1 : -1; } }, ended: () => ended, held: () => held };
}
const frame = (value, rpc) => ({ kind: "event", type: rpc ? (value.method ?? "rpc.response") : value.type, value, bytes: 1 });

test("codex driver: no config override, a prompt waits for the person and gets only their answer", async () => {
  let asked = null, resolveAsk;
  const d = codexAppServerDriver({ cwd: "/p", task: "do it", schema: { type: "object" }, threadId: null, clientVersion: "t",
    ask: (q) => { asked = q; return new Promise((r) => { resolveAsk = r; }); } });
  const f = fakeIo();
  d.start(f.io);
  assert.equal(f.sent[0].method, "initialize");
  d.frame(frame({ id: f.sent[0].id, result: {} }, true));
  const start = f.sent.find((m) => m.method === "thread/start");
  assert.deepEqual(Object.keys(start.params), ["cwd"], "no approvalPolicy, sandbox or config: the user's config.toml decides");
  d.frame(frame({ id: start.id, result: { thread: { id: "th1" } } }, true));
  const turn = f.sent.find((m) => m.method === "turn/start");
  assert.deepEqual(turn.params.outputSchema, { type: "object" });
  d.frame(frame({ id: 77, method: "item/commandExecution/requestApproval", params: { command: "php artisan migrate", threadId: "th1", turnId: "t1", itemId: "i" } }, true));
  assert.equal(asked.kind, "command");
  assert.equal(asked.summary, "php artisan migrate");
  assert.equal(f.held(), 1, "the turn's deadline is held while the person decides");
  assert.equal(f.sent.filter((m) => m.id === 77).length, 0, "nothing is answered before the person");
  resolveAsk({ decision: "allow_session" });
  await sleep(5);
  assert.deepEqual(f.sent.find((m) => m.id === 77).result, { decision: "acceptForSession" });
  assert.equal(f.held(), 0);
  d.frame(frame({ method: "item/completed", params: { item: { type: "agentMessage", text: "{\"ok\":true}" } } }, true));
  d.frame(frame({ method: "turn/completed", params: { turn: { status: "completed" } } }, true));
  assert.equal(d.terminal(frame({ method: "turn/completed", params: { turn: { status: "completed" } } }, true)), "ok");
  assert.deepEqual(d.answer(), { ok: true });
  assert.ok(f.ended(), "stdin ends after the terminal event");
});

test("codex driver: a request the CLI withdraws is not answered; unknown client requests get an error", async () => {
  let signal;
  const d = codexAppServerDriver({ cwd: "/p", task: "x", schema: {}, threadId: "th", clientVersion: "t", ask: (_q, s) => { signal = s; return new Promise(() => {}); } });
  const f = fakeIo();
  d.start(f.io);
  d.frame(frame({ id: 5, method: "item/fileChange/requestApproval", params: { reason: "write" } }, true));
  d.frame(frame({ method: "serverRequest/resolved", params: { requestId: 5 } }, true));
  assert.ok(signal.aborted);
  assert.equal(f.held(), 0);
  d.frame(frame({ id: 6, method: "account/chatgptAuthTokens/refresh", params: {} }, true));
  assert.equal(f.sent.find((m) => m.id === 6).error.code, -32601);
});

test("claude driver: can_use_tool goes to the person; deny, allow and 'for the session' use the CLI's own suggestions", async () => {
  const replies = [{ decision: "deny" }, { decision: "allow_once" }, { decision: "allow_session" }];
  const asks = [];
  const d = claudeHostDriver({ task: "t", ask: async (q) => { asks.push(q); return replies.shift(); } });
  const f = fakeIo();
  d.start(f.io);
  assert.deepEqual(f.sent[0], { type: "user", message: { role: "user", content: "t" }, parent_tool_use_id: null, session_id: "" });
  const sugg = [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }];
  for (const id of ["a", "b", "c"]) d.frame(frame({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, permission_suggestions: sugg } }));
  await sleep(5);
  const resp = (id) => f.sent.find((m) => m.type === "control_response" && m.response.request_id === id).response.response;
  assert.equal(resp("a").behavior, "deny");
  assert.deepEqual(resp("b"), { behavior: "allow", updatedInput: { command: "ls" } });
  assert.deepEqual(resp("c").updatedPermissions, sugg);
  assert.deepEqual(asks[0].options, ["allow_once", "allow_session", "deny"]);
  replies.push({ decision: "allow_once", answers: { "Which DB?": ["sqlite"] } });
  d.frame(frame({ type: "control_request", request_id: "q", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion",
    input: { questions: [{ question: "Which DB?", multiSelect: false, options: [{ label: "mysql" }, { label: "sqlite" }] }] } } }));
  await sleep(5);
  assert.deepEqual(resp("q").updatedInput.answers, { "Which DB?": "sqlite" });
  d.frame(frame({ type: "control_request", request_id: "h", request: { subtype: "hook_callback" } }));
  assert.equal(f.sent.at(-1).response.subtype, "error");
  d.frame(frame({ type: "result", subtype: "success", is_error: false, structured_output: { a: 1 } }));
  assert.deepEqual(d.answer(), { a: 1 });
  assert.ok(f.ended());
});

test("native turn argv: no flag removes configuration, tools, MCP, hooks or prompts; NODE_* reaches the CLI", () => {
  const cli = (p, exe) => ({ state: "available", provider: p, executable: exe, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] });
  const common = { cwd: TMP, env: { NODE_EXTRA_CA_CERTS: "/etc/ca.pem", PATH: "/usr/bin" }, task: "t", schema: { type: "object" }, session: { kind: "new" }, ask: async () => ({ decision: "deny" }), clientVersion: "t" };
  const c = buildNativeTurn({ ...common, cli: cli("claude", CLAUDE), cliVersion: "2.1.281 (Claude Code)" });
  assert.ok(c.ok);
  for (const f of ["--safe-mode", "--restricted", "--bare", "--tools", "--strict-mcp-config", "--setting-sources", "--permission-mode", "--permission-prompts", "--model", "--disallowedTools"]) {
    assert.ok(!c.spec.argv.includes(f), f);
  }
  assert.ok(c.spec.argv.includes("--permission-prompt-tool"));
  checkTurnSpec(c.spec, LAUNCH); // NODE_* is allowed in a session (passed whole in SUP_CHILD_ENV)
  // Stage 13 (RT-10.3): a supervisor variable in the person's environment no longer fails the session turn; it is
  // dropped from what reaches the CLI (and never reached the supervisor's own environment). Bad names still fail.
  checkTurnSpec({ ...c.spec, env: { SUP_GRACE_INT_MS: "1" } }, LAUNCH);
  assert.deepEqual(sessionEnv({ SUP_GRACE_INT_MS: "1", ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin" }), { env: { PATH: "/usr/bin" }, dropped: ["SUP_GRACE_INT_MS", "ELECTRON_RUN_AS_NODE"] });
  assert.throws(() => checkTurnSpec({ ...c.spec, env: { "A=B": "1" } }, LAUNCH));
  const x = buildNativeTurn({ ...common, cli: cli("codex", CODEX), cliVersion: "codex-cli 0.200.0" });
  assert.ok(x.ok, "another codex version runs; readiness says its protocol was not compared");
  assert.deepEqual(x.spec.argv.slice(1), ["app-server"]);
});

// ---------------- the run: project folder, permissions, the user's check command ----------------

test("a native run works in the project folder, keeps uncommitted work, asks the person and runs the user's command", OPTS, async () => {
  const src = project();
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const dir = script([PLAN, { answer: { summary: "note added", done: true }, writes: [{ rel: "note.txt", base64: b64("hello\n") }], asks: [{ tool: "Bash", command: "php artisan test" }] }, REVIEW, FINAL]);
  const m = manager({ MOCK_STATE: state, MOCK_SCRIPT: dir });
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "add a note", criteria: ["note.txt exists"], checks: [], commands: ["test -f note.txt"], workMode: "project" } });
  assert.ok(r.ok, JSON.stringify(r));
  const asking = await until(async () => { const v = (await m.get(runId)).value.view; return v.permission ? v : null; }, "a permission prompt");
  assert.equal(asking.workMode, "project");
  assert.equal(asking.workDir, src);
  assert.equal(asking.permission.tool, "Bash");
  assert.equal(asking.permission.summary, "php artisan test");
  assert.equal(runHeadline(asking).headline, "awaiting_permission");
  // nothing moves until the person answers: no decision recorded yet
  await sleep(300);
  assert.ok(!fs.existsSync(path.join(state, "decisions.jsonl")));
  const bad = await m.command(runId, { commandId: randomUUID(), expectedRevision: asking.revision, command: { kind: "permission", requestId: randomUUID(), decision: "allow_once" } });
  assert.equal(bad.value.code, "unknown_request");
  const ok = await m.command(runId, { commandId: randomUUID(), expectedRevision: asking.revision, command: { kind: "permission", requestId: asking.permission.requestId, decision: "allow_once" } });
  assert.equal(ok.value.status, "accepted", JSON.stringify(ok));
  const done = await until(async () => { const v = (await m.get(runId)).value.view; return ["completed", "paused", "failed", "stopped"].includes(v.status) ? v : null; }, "the end");
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(fs.readFileSync(path.join(src, "note.txt"), "utf8"), "hello\n", "the executor wrote into the project folder itself");
  assert.equal(fs.readFileSync(path.join(src, "user.txt"), "utf8"), "the user's uncommitted work\n", "the user's work is kept");
  const decisions = fs.readFileSync(path.join(state, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(decisions.map((d) => d.reply.behavior), ["allow"]);
  assert.equal(g(src, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main", "the user's branch is untouched");
  const records = (await m.history(runId, 0, 500)).value.records;
  assert.ok(records.some((r) => r.type === "check.finished" && r.data.status === "passed"), JSON.stringify(records.map((r) => r.type)));
  const changes = await m.changes(runId);
  assert.ok(changes.value.files.some((f) => f.path === "note.txt"), JSON.stringify(changes));
  const activity = await m.activity(runId, 0, 500);
  assert.ok(activity.value.entries.some((e) => e.kind === "permission_requested"));
  assert.ok(activity.value.entries.some((e) => e.kind === "permission_decided"));
  await m.shutdown();
});

test("a denied prompt is denied in the CLI; a stop withdraws a waiting prompt", OPTS, async () => {
  const src = project({ dirty: false });
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const dir = script([PLAN, { answer: { summary: "x", done: true }, asks: [{ tool: "Bash", command: "rm -rf build" }] }, REVIEW, FINAL]);
  const m = manager({ MOCK_STATE: state, MOCK_SCRIPT: dir });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["y"], checks: [], commands: ["true"], workMode: "project" } })).ok);
  const v = await until(async () => { const x = (await m.get(runId)).value.view; return x.permission ? x : null; }, "prompt");
  // stage 13: "until the run ends" and "always in this project" are CanvasTTY's own memory of the same action
  assert.deepEqual(v.permission.options, ["allow_once", "allow_session", "allow_run", "allow_project", "deny"]);
  await m.command(runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "permission", requestId: v.permission.requestId, decision: "deny" } });
  await until(async () => fs.existsSync(path.join(state, "decisions.jsonl")), "decision");
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, "decisions.jsonl"), "utf8")).reply.behavior, "deny");
  await until(async () => (await m.get(runId)).value.view.status === "completed", "completed");
  await m.shutdown();

  // stop while a prompt waits: the prompt is withdrawn, nothing is answered for the person
  const state2 = fs.mkdtempSync(path.join(TMP, "state-"));
  const dir2 = script([PLAN, { answer: { summary: "x", done: true }, asks: [{ tool: "Bash", command: "sleep" }] }]);
  const m2 = manager({ MOCK_STATE: state2, MOCK_SCRIPT: dir2 });
  const run2 = randomUUID();
  assert.ok((await m2.create({ requestId: run2, source: project({ dirty: false }), goal: { text: "x", criteria: ["y"], checks: [], commands: ["true"], workMode: "project" } })).ok);
  const w = await until(async () => { const x = (await m2.get(run2)).value.view; return x.permission ? x : null; }, "prompt 2");
  await m2.command(run2, { commandId: randomUUID(), expectedRevision: w.revision, command: { kind: "stop" } });
  const end = await until(async () => { const x = (await m2.get(run2)).value.view; return x.status === "stopped" ? x : null; }, "stopped");
  assert.equal(end.permission ?? null, null);
  assert.ok(!fs.existsSync(path.join(state2, "decisions.jsonl")) || !fs.readFileSync(path.join(state2, "decisions.jsonl"), "utf8").includes("allow"));
  await m2.shutdown();
});

test("a failing user check command sends the stage back; its output is kept", OPTS, async () => {
  const src = project({ dirty: false });
  const dir = script([PLAN, { answer: { summary: "x", done: true } }, { answer: { verdict: "accept", findings: [], question: null } }]);
  const m = manager({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: dir });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "x", criteria: ["y"], checks: [], commands: ["echo failing-output; exit 3"], workMode: "project", limits: { roundsPerStage: 1 } } })).ok);
  const v = await until(async () => { const x = (await m.get(runId)).value.view; return x.status === "paused" ? x : null; }, "paused");
  assert.equal(v.reason, "limit_reached");
  const hist = await m.history(runId, 0, 200);
  const finished = hist.value.records.find((r) => r.type === "check.finished");
  assert.equal(finished.data.status, "failed");
  assert.equal(finished.data.exitCode, 3);
  const text = await m.text(runId, finished.data.output.sha256);
  assert.match(text.value.text, /failing-output/);
  await m.shutdown();
});

// ---------------- pieces ----------------

test("project work mode: the folder itself is the work tree; nothing is written into it; restores refuse", OPTS, async () => {
  const src = project();
  const root = path.join(TMP, `ws-${++n}`);
  const runId = randomUUID();
  fs.mkdirSync(path.join(root, "runs", runId), { recursive: true });
  fs.writeFileSync(path.join(root, "runs", runId, "journal.jsonl"), "");
  const before = g(src, "status", "--porcelain");
  const ws = await createWorkspace({ root, runId, source: src, gitPath: GIT, mode: "project" });
  assert.equal(ws.repo, src);
  assert.equal(g(src, "status", "--porcelain"), before, "the user's index and files are unchanged");
  fs.writeFileSync(path.join(src, "new.txt"), "x");
  const tree = await snapshotCopyTree(ws, ws.baseline.tree);
  assert.notEqual(tree, ws.baseline.tree);
  await assert.rejects(applyTreeToCopy(ws, tree, ws.baseline.tree), /never writes into the project folder/);
});

test("login environment: rc output before the environment is ignored; a failing shell is said", async () => {
  const shell = path.join(TMP, "noisy-sh");
  fs.writeFileSync(shell, `#!/bin/sh\necho "welcome banner"\nexport FROM_RC=yes\nshift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
  const r = await captureLoginEnv({ cwd: TMP, base: { SHELL: shell, PATH: "/usr/bin:/bin", HOME: TMP } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.env.FROM_RC, "yes");
  assert.equal(r.env.PWD, undefined);
  const bad = path.join(TMP, "bad-sh");
  fs.writeFileSync(bad, "#!/bin/sh\nexit 4\n", { mode: 0o755 });
  const f = await captureLoginEnv({ cwd: TMP, base: { SHELL: bad, PATH: "/usr/bin:/bin" } });
  assert.equal(f.ok, false);
  assert.equal(f.reason, "failed");
});

test("readiness: a Laravel project is recognised before any model call; its command and missing vendor/ are said", async () => {
  const dir = project({ dirty: false });
  fs.writeFileSync(path.join(dir, "artisan"), "#!/usr/bin/env php\n");
  fs.writeFileSync(path.join(dir, "composer.json"), JSON.stringify({ scripts: { test: "phpunit" } }));
  assert.deepEqual(await suggestCommands(dir), { stack: "laravel", commands: ["php artisan test"], laravel: true });
  const r = await assessReadiness({
    project: dir, commands: ["php artisan test"], workMode: "project", platform: "darwin", gitPath: GIT, busy: false,
    runtime: { ok: true, versions: { codex: "codex-cli 0.155.1", claude: "2.1.281 (Claude Code)" }, env: { PATH: "/nonexistent" }, shell: "/bin/zsh" },
    checkedVersions: { codex: ["0.155.1"], claude: ["2.1.281"] }
  });
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.equal(by.laravel.level, "warning");
  assert.equal(by.command_1.level, "warning", "php is not on this PATH: said, not hidden");
  assert.equal(by.tests.level, "confirm");
  assert.equal(by.workdir.level, "info");
  assert.ok(r.ready, "warnings do not block");
  const none = await assessReadiness({ project: dir, commands: [], workMode: "project", platform: "darwin", gitPath: GIT, busy: true,
    runtime: { ok: false, code: "environment_error", detail: "zsh exited" }, checkedVersions: { codex: [], claude: [] } });
  assert.equal(none.ready, false);
  assert.deepEqual(none.items.filter((i) => i.level === "blocker").map((i) => i.id).sort(), ["busy", "commands", "env"]);
});

test("readiness: the Claude protocol is compared with exactly 2.1.280, 2.1.281, 2.1.282 and 2.1.283; a neighbour version is said", async () => {
  const dir = project({ dirty: false });
  const clis = async (claude) => (await assessReadiness({
    project: dir, commands: ["true"], workMode: "project", platform: "darwin", gitPath: GIT, busy: false,
    runtime: { ok: true, versions: { codex: "codex-cli 0.155.1", claude: `${claude} (Claude Code)` }, env: { PATH: "/nonexistent" }, shell: "/bin/zsh" },
    checkedVersions: NATIVE_PROTOCOL_CHECKED
  })).items.find((i) => i.id === "clis");
  for (const v of ["2.1.281", "2.1.282", "2.1.283"]) assert.equal((await clis(v)).level, "ok", v);
  for (const v of ["2.1.279", "2.1.284", "2.1.283.1"]) {
    const item = await clis(v);
    assert.equal(item.level, "warning", v);
    assert.equal(item.facts.unchecked, "claude", v);
  }
});

test("IPC: goal commands and work mode, the permission command and its answers are validated", () => {
  const goal = { text: "t", criteria: ["c"], checks: [], commands: ["php artisan test"], workMode: "project" };
  const c = parseCreate({ requestId: randomUUID(), source: "/p", goal });
  assert.deepEqual(c.goal.commands, ["php artisan test"]);
  assert.throws(() => parseCreate({ requestId: randomUUID(), source: "/p", goal: { ...goal, commands: ["a\nb"] } }), /single non-empty lines/);
  assert.throws(() => parseCreate({ requestId: randomUUID(), source: "/p", goal: { ...goal, workMode: "other" } }), /workMode/);
  assert.throws(() => parseCreate({ requestId: randomUUID(), source: "/p", goal: { ...goal, commands: undefined } }), /goal.checks/);
  const base = { runId: randomUUID(), commandId: randomUUID(), expectedRevision: 0 };
  const p = parseCommand({ ...base, command: { kind: "permission", requestId: randomUUID(), decision: "allow_session", answers: { q1: ["a"], q2: [] } } });
  assert.equal(p.command.decision, "allow_session");
  assert.throws(() => parseCommand({ ...base, command: { kind: "permission", requestId: randomUUID(), decision: "bypass" } }), /decision/);
});
