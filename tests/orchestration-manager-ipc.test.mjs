// Stage 7 (stage-7-contract.md): the run manager behind the orchestration IPC channels. The channels are registered as
// registerIpc registers them (handleMain + assertMainRenderer) with fake windows; test agents instead of CLIs; the
// real Store, copy and sandboxed node-test check.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { IPC } from "../src/shared/contracts.ts";
import { assertMainRenderer } from "../src/main/ipc/mainRenderer.ts";
import { registerOrchestrationIpc } from "../src/main/ipc/orchestrationIpc.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager } from "../src/main/services/orchestration/manager.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "orchestration", "check-project");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const SKIP = { skip: process.platform !== "darwin" && "checks run only in the macOS sandbox" };

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-manager-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "");
const g = (cwd, ...args) => execFileSync(GIT, args, {
  cwd, encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
}).trim();

let n = 0;
function project() {
  const src = path.join(TMP, `src-${++n}`);
  fs.cpSync(FIXTURE, src, { recursive: true });
  fs.rmSync(path.join(src, "tests", "broken.test.mjs")); // node --test runs every test file
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fixture");
  return { src, root: path.join(TMP, `root-${n}`) };
}

// The manager as main builds it, with every resolver counted: construction must call none of them.
function manager(root, agents) {
  const calls = { agents: 0, git: 0, launch: 0, node: 0 };
  const m = createRunManager({
    root,
    gitPath: () => (calls.git++, GIT),
    launch: () => (calls.launch++, LAUNCH),
    nodePath: () => (calls.node++, NODE),
    agents: async () => (calls.agents++, agents),
    stopGraceMs: 2000
  });
  return { m, calls };
}

// Fake Electron: a main window, its top frame, a second window; handleMain exactly as registerIpc wraps it.
function page(id) {
  const wc = new EventEmitter();
  Object.assign(wc, { id, mainFrame: { id: `frame-${id}` }, sent: [], destroyed: false,
    send(channel, payload) { this.sent.push({ channel, payload }); }, isDestroyed() { return this.destroyed; } });
  return wc;
}
function ipc(m) {
  const main = page(1), other = page(2);
  const handlers = new Map();
  const handleMain = (channel, listener) => handlers.set(channel, (event, ...args) => {
    assertMainRenderer(event, () => ({ isDestroyed: () => false, webContents: main }));
    return listener(event, ...args);
  });
  registerOrchestrationIpc(handleMain, m);
  const call = (wc, channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({ sender: wc, senderFrame: wc.mainFrame }, ...args));
  return { main, other, handlers, invoke: (channel, ...args) => call(main, channel, ...args), call };
}

const goal = (extra = {}) => ({ text: "extend sum", criteria: ["sum works"], checks: ["node-test"], ...extra });
const GOOD = "export const sum = (...xs) => xs.reduce((a, b) => a + b, 0);\n// improved\n";
const cycleAgents = (execute = { report: executed(), edit: (c) => fs.writeFileSync(c.path("src/sum.mjs"), GOOD) }) => createTestAgents({
  plan: { report: plan("only stage") }, execute, review: { report: review("accept") }, final_review: { report: review("complete") }
});
async function until(fn, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (await fn()) return;
  throw new Error(`condition not reached: ${fn}`);
}
const view = async (m, runId) => (await m.get(runId)).value.view;
const statusIs = (m, runId, ...s) => async () => s.includes((await view(m, runId)).status);

test("the channels are the ones registerIpc guards", () => {
  const source = fs.readFileSync(path.join(HERE, "..", "src", "main", "ipc", "registerIpc.ts"), "utf8");
  assert.match(source, /registerOrchestrationIpc\(handleMain, orchestration\)/);
  const { handlers } = ipc(manager(path.join(TMP, "unused")).m);
  assert.deepEqual([...handlers.keys()].sort(), Object.entries(IPC).filter(([k]) => k.startsWith("orchestration") && k !== "orchestrationEvent").map(([, v]) => v).sort());
});

test("building the manager starts nothing: no directory, no resolver, no agent; an empty list", async () => {
  const root = path.join(TMP, "fresh");
  const { m, calls } = manager(root, cycleAgents());
  assert.deepEqual(await m.list(), { ok: true, value: [] });
  assert.equal((await m.catalog()).value.checks[0].id, "node-test");
  assert.deepEqual(calls, { agents: 0, git: 0, launch: 0, node: 0 });
  assert.equal(fs.existsSync(root), false);
  assert.equal(m.openCount(), 0);
});

test("a foreign renderer and invalid arguments are refused before anything happens", async () => {
  const p = project();
  const { m, calls } = manager(p.root, cycleAgents());
  const { invoke, call, other, main } = ipc(m);
  const runId = randomUUID();
  const create = { requestId: runId, source: p.src, goal: goal() };
  await assert.rejects(call(other, IPC.orchestrationCreate, create), /only to the trusted CanvasTTY renderer/);
  await assert.rejects(call(other, IPC.orchestrationList), /only to the trusted CanvasTTY renderer/);
  const subFrame = Promise.resolve().then(() => ipc(m).handlers.get(IPC.orchestrationList)({ sender: main, senderFrame: { id: "iframe" } }));
  await assert.rejects(subFrame, /only to the trusted/);
  for (const [channel, ...args] of [
    [IPC.orchestrationCreate, { ...create, requestId: "run-1" }],
    [IPC.orchestrationCreate, { ...create, executable: "/bin/sh" }],
    [IPC.orchestrationCreate, { ...create, goal: { ...goal(), argv: ["-c", "x"] } }],
    [IPC.orchestrationCreate, { ...create, goal: goal({ checks: ["../../bin/sh"] }) }],
    [IPC.orchestrationCreate, { ...create, goal: goal({ limits: { turns: 0 } }) }],
    [IPC.orchestrationCreate, { ...create, source: "relative/dir" }],
    [IPC.orchestrationCreate, null],
    [IPC.orchestrationCommand, { runId, commandId: randomUUID(), expectedRevision: 0, command: { kind: "exec", argv: ["sh"] } }],
    [IPC.orchestrationCommand, { runId, commandId: randomUUID(), expectedRevision: -1, command: { kind: "stop" } }],
    [IPC.orchestrationCommand, { runId, commandId: randomUUID(), expectedRevision: 0, command: { kind: "stop", env: {} } }],
    [IPC.orchestrationCommand, { runId, commandId: "x", expectedRevision: 0, command: { kind: "stop" } }],
    [IPC.orchestrationHistory, runId, 0, 10_000],
    [IPC.orchestrationText, runId, "../../etc/passwd"],
    [IPC.orchestrationGet, "../runs"],
    [IPC.orchestrationWatch, "not-a-uuid"]
  ]) {
    const r = await invoke(channel, ...args);
    assert.deepEqual([r.ok, r.code], [false, "invalid_argument"], `${channel} ${JSON.stringify(args)}`);
  }
  // an unknown check id passes the shape and is refused by the registry, still before the run exists
  const unknown = await invoke(IPC.orchestrationCreate, { ...create, goal: goal({ checks: ["npm-install"] }) });
  assert.equal(unknown.ok, false);
  assert.equal(fs.existsSync(path.join(p.root, "runs", runId)), false);
  assert.deepEqual([calls.git, calls.launch], [0, 0]);
  assert.equal(fs.existsSync(path.join(p.root, "runs")), false, "no run directory at all");
  // a project without prepared dependencies: refused before the agents, nothing on disk
  fs.rmSync(path.join(p.src, "node_modules"), { recursive: true });
  const noDeps = await invoke(IPC.orchestrationCreate, create);
  assert.deepEqual([noDeps.ok, noDeps.code], [false, "deps_unavailable"]);
  assert.equal(calls.agents, 0);
  assert.equal(fs.existsSync(p.root), false, "not even the root");
});

test("full cycle through the channels: create, events after the snapshot, history pages, texts of the run only", SKIP, async () => {
  const p = project();
  const agents = cycleAgents();
  const { m } = manager(p.root, agents);
  const { invoke, main } = ipc(m);
  const runId = randomUUID();
  const created = await invoke(IPC.orchestrationCreate, { requestId: runId, source: p.src, goal: goal() });
  assert.deepEqual(created, { ok: true, value: { runId, created: true } });
  const snap = await invoke(IPC.orchestrationWatch, runId);
  assert.equal(snap.ok, true);
  await until(statusIs(m, runId, "completed"));
  const events = main.sent.filter((s) => s.channel === IPC.orchestrationEvent && s.payload.view).map((s) => s.payload); // run states, not activity
  assert.ok(events.length > 3);
  const newer = (x, y) => x.seq > y.seq || (x.seq === y.seq && x.tick > y.tick);
  assert.ok(events.every((e, i) => e.runId === runId && newer(e, i === 0 ? snap.value : events[i - 1])), "(seq, tick) only grows");
  assert.equal(events.at(-1).view.status, "completed");
  const now = (await m.get(runId)).value;
  assert.deepEqual([events.at(-1).seq, events.at(-1).tick], [now.seq, now.tick], "the last event is the current state");
  assert.deepEqual(agents.log.map((e) => e.purpose), ["plan", "execute", "review", "final_review"]);

  const first = await invoke(IPC.orchestrationHistory, runId, 0, 2);
  assert.deepEqual(first.value.records.map((r) => [r.seq, r.type]), [[0, "run.created"], [1, "workspace.created"]]);
  assert.equal(first.value.more, true);
  const rest = await invoke(IPC.orchestrationHistory, runId, 2, 200);
  assert.equal(rest.value.records[0].seq, 2);
  assert.equal(rest.value.records.at(-1).seq, first.value.lastSeq);
  assert.equal(rest.value.more, false);
  const goalRef = first.value.records[0].data.goal;
  const text = await invoke(IPC.orchestrationText, runId, goalRef.sha256);
  assert.match(text.value.text, /extend sum/);
  const other = await invoke(IPC.orchestrationText, runId, "0".repeat(64));
  assert.deepEqual([other.ok, other.code], [false, "text_not_found"]);
  const list = await invoke(IPC.orchestrationList);
  assert.deepEqual(list.value.map((r) => [r.view.runId, r.view.status, r.open]), [[runId, "completed", true]]);
  await m.shutdown();
});

test("a repeated create and a repeated command do nothing again; a stale revision is refused", SKIP, async () => {
  const p = project();
  const agents = cycleAgents();
  const { m } = manager(p.root, agents);
  const { invoke } = ipc(m);
  const runId = randomUUID();
  const req = { requestId: runId, source: p.src, goal: goal({ reviewPlan: true }) };
  const [a, b] = await Promise.all([invoke(IPC.orchestrationCreate, req), invoke(IPC.orchestrationCreate, req)]);
  assert.deepEqual([a.value, b.value], [{ runId, created: true }, { runId, created: true }], "one creation answers both");
  assert.deepEqual((await invoke(IPC.orchestrationCreate, req)).value, { runId, created: false });
  const conflict = await invoke(IPC.orchestrationCreate, { ...req, goal: goal({ text: "another goal" }) });
  assert.deepEqual([conflict.ok, conflict.code], [false, "request_conflict"]);
  await until(statusIs(m, runId, "paused"));
  assert.equal((await view(m, runId)).reason, "plan_review");
  assert.equal(agents.log.length, 1, "one plan turn: one run");
  assert.equal(fs.readdirSync(path.join(p.root, "runs")).filter((d) => !d.startsWith(".")).length, 1);

  const rev = (await view(m, runId)).revision;
  const stale = await invoke(IPC.orchestrationCommand, { runId, commandId: randomUUID(), expectedRevision: rev + 1, command: { kind: "resume" } });
  assert.deepEqual(stale.value, { status: "rejected", code: "stale_revision" });
  assert.equal((await view(m, runId)).status, "paused");
  const cmd = { runId, commandId: randomUUID(), expectedRevision: rev, command: { kind: "resume" } };
  assert.deepEqual((await invoke(IPC.orchestrationCommand, cmd)).value, { status: "accepted", code: null });
  await until(statusIs(m, runId, "completed"));
  const turns = agents.log.length;
  const again = await invoke(IPC.orchestrationCommand, cmd);
  assert.deepEqual(again.value, { status: "accepted", code: null }, "the recorded result");
  assert.equal((await view(m, runId)).status, "completed", "not resumed again");
  assert.equal(agents.log.length, turns);
  await m.shutdown();
});

test("stop during an executor turn: the turn is stopped and the run ends stopped", SKIP, async () => {
  const p = project();
  let release;
  const agents = cycleAgents({ report: executed(), hold: new Promise((r) => { release = r; }) });
  const { m } = manager(p.root, agents);
  const { invoke } = ipc(m);
  const runId = randomUUID();
  await invoke(IPC.orchestrationCreate, { requestId: runId, source: p.src, goal: goal() });
  await until(async () => (await view(m, runId)).active?.kind === "turn" && (await view(m, runId)).active.purpose === "execute");
  const r = await invoke(IPC.orchestrationCommand, { runId, commandId: randomUUID(), expectedRevision: (await view(m, runId)).revision, command: { kind: "stop" } });
  assert.deepEqual(r.value, { status: "accepted", code: null });
  await until(statusIs(m, runId, "stopped"));
  assert.equal(agents.log.find((e) => e.purpose === "execute").stopped, true);
  release();
  assert.equal(agents.log.length, 2, "nothing after the stop");
  await m.shutdown();
});

test("a closed window, a reload and an explicit unwatch release the subscriptions", SKIP, async () => {
  const p = project();
  const { m } = manager(p.root, cycleAgents());
  const { invoke, main } = ipc(m);
  const runId = randomUUID();
  await invoke(IPC.orchestrationCreate, { requestId: runId, source: p.src, goal: goal({ reviewPlan: true }) });
  await until(statusIs(m, runId, "paused"));
  await invoke(IPC.orchestrationWatch, runId);
  await invoke(IPC.orchestrationWatch, runId); // the same page twice: still one watch
  assert.equal(m.watcherCount(), 1);
  await invoke(IPC.orchestrationUnwatch, runId);
  assert.equal(m.watcherCount(), 0);
  await invoke(IPC.orchestrationWatch, runId);
  main.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  main.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  assert.equal(m.watcherCount(), 1, "a subframe or same-document navigation keeps it");
  main.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  assert.equal(m.watcherCount(), 0, "a reload releases it");
  await invoke(IPC.orchestrationWatch, runId);
  main.destroyed = true;
  main.emit("destroyed");
  assert.equal(m.watcherCount(), 0, "a closed window releases it");
  const sent = main.sent.length;
  const rev = (await view(m, runId)).revision;
  await m.command(runId, { commandId: randomUUID(), expectedRevision: rev, command: { kind: "stop" } });
  await until(statusIs(m, runId, "stopped"));
  assert.equal(main.sent.length, sent, "nothing is sent to a closed window");
  await m.shutdown();
});

test("exit during a turn pauses the run; after a restart the history is there and nothing continues by itself", SKIP, async () => {
  const p = project();
  let release;
  const first = cycleAgents({ report: executed(), hold: new Promise((r) => { release = r; }) });
  const one = manager(p.root, first);
  const runId = randomUUID();
  await one.m.create({ requestId: runId, source: p.src, goal: goal() });
  await until(async () => (await view(one.m, runId)).active?.purpose === "execute");
  await one.m.shutdown();
  release();
  assert.equal(first.log.find((e) => e.purpose === "execute").stopped, true, "the operation was stopped through its own stop()");
  const refused = await one.m.create({ requestId: randomUUID(), source: p.src, goal: goal() });
  assert.deepEqual([refused.ok, refused.code], [false, "shutting_down"]);

  const second = cycleAgents();
  const two = manager(p.root, second);
  const listed = (await two.m.list()).value;
  // UX-5: the application's exit is its own pause reason (app_closed), not the person's pause (user_request)
  assert.deepEqual(listed.map((r) => [r.view.runId, r.view.status, r.view.reason, r.open]), [[runId, "paused", "app_closed", false]]);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(two.calls, { agents: 0, git: 0, launch: 0, node: 0 }, "nothing opened, nothing resolved");
  assert.equal(second.log.length, 0);
  const history = await two.m.history(runId, 0, 200);
  assert.ok(history.value.records.some((r) => r.type === "turn.started" || r.type === "turn.intent" || r.type.startsWith("turn")));

  // an explicit command opens it and continues from the journal (a clean exit needs no run.recovered)
  const rev = (await view(two.m, runId)).revision;
  const resume = await two.m.command(runId, { commandId: randomUUID(), expectedRevision: rev, command: { kind: "resume" } });
  assert.deepEqual(resume.value, { status: "accepted", code: null });
  await until(statusIs(two.m, runId, "completed"));
  const types = (await two.m.history(runId, 0, 200)).value.records.map((r) => r.type);
  assert.equal(types.filter((t) => t === "command.received").length, 1, "the resume is the only command");
  assert.equal(second.log[0].purpose, "execute", "the interrupted stage is done again, the plan is not");
  await two.m.shutdown();
});

test("test providers, the IPC smoke and dropped replies are read only through developmentEnv (ignored when packaged)", () => {
  const source = fs.readFileSync(path.join(HERE, "..", "src", "main", "index.ts"), "utf8");
  for (const name of ["CANVASTTY_ORCHESTRATION_TEST_PROVIDERS", "CANVASTTY_ORCHESTRATION_IPC_SMOKE", "CANVASTTY_ORCHESTRATION_TEST_DROP_REPLIES"]) {
    const reads = source.split("\n").filter((l) => l.includes(`"${name}"`) || l.includes(`.${name}`));
    assert.ok(reads.length > 0, name);
    for (const l of reads) assert.match(l, new RegExp(`developmentEnv\\("${name}"\\)`), l);
  }
  assert.match(source, /function developmentEnv\(name: string\): string \| undefined \{\n  return app\.isPackaged \? undefined : process\.env\[name\];/);
  assert.match(source, /orchestration = buildRunManager\(\);/);
  assert.match(source, /await orchestration\?\.shutdown\(\);\n  await evenG2\?\.close\(\);/, "orchestration stops before the rest of the services");
});
