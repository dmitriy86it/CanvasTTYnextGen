// Stage 7, review fixes (stage-7-contract.md §1.1, §2.1, §2.2, §1.2): the identity of a create request, cancelled
// watches, notifications of the operation in progress and the application's provider configuration.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { IPC } from "../src/shared/contracts.ts";
import { assertMainRenderer } from "../src/main/ipc/mainRenderer.ts";
import { registerOrchestrationIpc } from "../src/main/ipc/orchestrationIpc.ts";
import { createOrchestrationClient } from "../src/preload/orchestrationClient.ts";
import { checkPreparedDeps, createRegistry } from "../src/main/services/orchestration/checks.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testProviderAgents } from "../src/main/services/orchestration/manager.ts";
import { createOrchestrationService } from "../src/main/services/orchestration/orchestrationService.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "orchestration");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const MAC = { skip: process.platform !== "darwin" && "checks run only in the macOS sandbox", timeout: 180_000 };

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-review7-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "");
const g = (cwd, ...args) => execFileSync(GIT, args, {
  cwd, encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
}).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

let n = 0;
function project({ extra } = {}) {
  const src = path.join(TMP, `src-${++n}`);
  fs.cpSync(path.join(FIXTURES, "check-project"), src, { recursive: true });
  fs.rmSync(path.join(src, "tests", "broken.test.mjs"));
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
  extra?.(src);
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fixture");
  return { src, root: path.join(TMP, `root-${n}`) };
}
// Everything a run could leave in a source project: refs, branch, working tree.
const footprint = (src) => ({ refs: g(src, "for-each-ref"), head: g(src, "rev-parse", "HEAD"), status: g(src, "status", "--porcelain", "--ignored") });

function manager(root, agents, extra = {}) {
  const calls = { agents: 0 };
  const m = createRunManager({
    root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE,
    agents: extra.agents ?? (async () => (calls.agents++, agents)), stopGraceMs: 2000
  });
  return { m, calls };
}
const goal = (extra = {}) => ({ text: "extend sum", criteria: ["sum works"], checks: ["node-test"], ...extra });
const GOOD = "export const sum = (...xs) => xs.reduce((a, b) => a + b, 0);\n// improved\n";
const cycleAgents = (execute = { report: executed(), edit: (c) => fs.writeFileSync(c.path("src/sum.mjs"), GOOD) }) => createTestAgents({
  plan: { report: plan("only stage") }, execute, review: { report: review("accept") }, final_review: { report: review("complete") }
});
async function until(fn, what, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (await fn()) return;
  throw new Error(`not reached: ${what}`);
}
const view = async (m, runId) => (await m.get(runId)).value.view;
const runDirs = (root) => (fs.existsSync(path.join(root, "runs")) ? fs.readdirSync(path.join(root, "runs")).filter((d) => !d.startsWith(".")) : []);

// ---------- 1. the identity of a create request ----------

test("create: concurrent identical requests and equivalent spellings of one project are one run", MAC, async () => {
  const p = project();
  const agents = cycleAgents();
  const { m } = manager(p.root, agents);
  const runId = randomUUID();
  const link = path.join(TMP, `link-${n}`);
  fs.symlinkSync(p.src, link);
  const spellings = [p.src, `${p.src}/`, `${p.src}/./`, `${path.dirname(p.src)}/../${path.basename(path.dirname(p.src))}/${path.basename(p.src)}`, link];
  if (p.src.startsWith("/private/")) spellings.push(p.src.slice("/private".length));
  const req = (source) => ({ requestId: runId, source, goal: goal({ reviewPlan: true }) });
  const all = await Promise.all(spellings.map((s) => m.create(req(s))));
  assert.ok(all.every((r) => r.ok && r.value.runId === runId), JSON.stringify(all));
  await until(async () => (await view(m, runId)).status === "paused", "plan_review");
  const again = await Promise.all(spellings.map((s) => m.create(req(s))));
  assert.ok(again.every((r) => r.ok && r.value.created === false), JSON.stringify(again));
  assert.deepEqual(runDirs(p.root), [runId]);
  assert.equal(agents.log.length, 1, "one plan turn");
  await m.shutdown();
});

test("create: concurrent requests with one requestId and another goal or project — one run, the other request_conflict", MAC, async () => {
  for (const variant of ["goal", "project"]) {
    const a = project(), b = project();
    const before = { [a.src]: footprint(a.src), [b.src]: footprint(b.src) };
    const agents = cycleAgents();
    const { m } = manager(a.root, agents);
    const runId = randomUUID();
    const first = { requestId: runId, source: a.src, goal: goal({ reviewPlan: true }) };
    const second = variant === "goal" ? { ...first, goal: goal({ reviewPlan: true, text: "another goal" }) } : { ...first, source: b.src };
    const results = await Promise.all([m.create(first), m.create(second)]);
    // Whichever comes first after reading the path wins; the other is refused, never joined.
    const won = results.findIndex((r) => r.ok);
    assert.notEqual(won, -1, JSON.stringify(results));
    assert.deepEqual(results[won].value, { runId, created: true }, variant);
    const lost = results[1 - won];
    assert.deepEqual([lost.ok, lost.code], [false, "request_conflict"], `${variant}: ${JSON.stringify(lost)}`);
    await until(async () => (await view(m, runId)).status === "paused", "plan_review");
    assert.deepEqual(runDirs(a.root), [runId]);
    assert.equal(agents.log.length, 1, `${variant}: one plan turn`);
    const text = (await m.history(runId, 0, 1)).value.records[0].data.goal;
    assert.match((await m.text(runId, text.sha256)).value.text, won === 0 || variant === "project" ? /extend sum/ : /another goal/);
    if (variant === "project") {
      const loser = [first, second][1 - won].source;
      assert.deepEqual(footprint(loser), before[loser], "the losing project is untouched");
    }
    await m.shutdown();
  }
});

test("create: after creation and after a restart, only the equivalent request is a repeat", MAC, async () => {
  const a = project(), b = project();
  const beforeB = footprint(b.src);
  const agents = cycleAgents();
  const one = manager(a.root, agents);
  const runId = randomUUID();
  const req = { requestId: runId, source: a.src, goal: goal({ reviewPlan: true }) };
  assert.equal((await one.m.create(req)).value.created, true);
  await until(async () => (await view(one.m, runId)).status === "paused", "plan_review");
  const check = async (m, label) => {
    assert.deepEqual((await m.create(req)).value, { runId, created: false }, `${label}: same request`);
    assert.deepEqual((await m.create({ ...req, source: `${a.src}/` })).value, { runId, created: false }, `${label}: same project, other spelling`);
    for (const [what, other] of [["source", { ...req, source: b.src }], ["goal", { ...req, goal: goal({ reviewPlan: true, text: "x" }) }],
      ["reviewPlan", { ...req, goal: goal() }], ["limits", { ...req, goal: goal({ reviewPlan: true, limits: { turns: 3 } }) }]]) {
      const r = await m.create(other);
      assert.deepEqual([r.ok, r.code], [false, "request_conflict"], `${label}: another ${what}`);
    }
  };
  await check(one.m, "after creation");
  await one.m.shutdown();
  const two = manager(a.root, agents);
  await check(two.m, "after a restart");
  assert.equal(two.calls.agents, 0, "nothing resolved for a repeat or a conflict");
  assert.deepEqual(runDirs(a.root), [runId]);
  assert.equal(agents.log.length, 1);
  assert.deepEqual(footprint(b.src), beforeB, "the other project is untouched");
  await two.m.shutdown();
});

// ---------- 2. cancelled watches (the IPC layer with a manager whose watch settles when the test says) ----------

function page(id) {
  const wc = new EventEmitter();
  Object.assign(wc, { id, mainFrame: { id: `frame-${id}` }, sent: [], destroyed: false,
    send(channel, payload) { this.sent.push({ channel, payload }); }, isDestroyed() { return this.destroyed; } });
  return wc;
}
function slowManager() {
  const pending = [];
  const live = new Set();
  return {
    pending, live,
    watch(runId, listener) {
      const d = deferred();
      pending.push(d);
      return d.promise.then((ok) => {
        if (!ok) return { snapshot: { ok: false, code: "run_not_found", message: "no run" }, unwatch() {} };
        const entry = { runId, listener };
        live.add(entry);
        return { snapshot: { ok: true, value: { seq: 1, tick: 0, view: { runId }, integrity: "ok", open: true } }, unwatch: () => live.delete(entry) };
      });
    },
    watchActivity() { return () => {}; }, // activity rides the same channel; not the subject here
    emit(runId) { for (const e of live) if (e.runId === runId) e.listener({ runId, seq: 2, tick: 0, view: { runId } }); }
  };
}
function watchIpc() {
  const m = slowManager();
  const main = page(1);
  const handlers = new Map();
  registerOrchestrationIpc((channel, listener) => handlers.set(channel, (event, ...args) => {
    assertMainRenderer(event, () => ({ isDestroyed: () => false, webContents: main }));
    return listener(event, ...args);
  }), m);
  const invoke = (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({ sender: main, senderFrame: main.mainFrame }, ...args));
  const events = () => main.sent.filter((s) => s.channel === IPC.orchestrationEvent).length;
  return { m, main, invoke, events };
}
const RUN = randomUUID();
const tick = () => new Promise((r) => setImmediate(r));

test("watch: an unwatch, a reload or a closed window before the watch settles leaves no subscription", async () => {
  for (const cancel of ["unwatch", "reload", "destroyed"]) {
    const { m, main, invoke, events } = watchIpc();
    const w = invoke(IPC.orchestrationWatch, RUN);
    await tick();
    if (cancel === "unwatch") await invoke(IPC.orchestrationUnwatch, RUN);
    if (cancel === "reload") main.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    if (cancel === "destroyed") { main.destroyed = true; main.emit("destroyed"); }
    m.pending[0].resolve(true);
    await w;
    assert.equal(m.live.size, 0, `${cancel}: the late subscription was released`);
    m.emit(RUN);
    assert.equal(events(), 0, `${cancel}: nothing sent`);
  }
});

test("watch: quick watch/unwatch/watch and concurrent watches end with exactly the newest subscription", async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const { m, invoke, events } = watchIpc();
    const w1 = invoke(IPC.orchestrationWatch, RUN);
    await tick();
    await invoke(IPC.orchestrationUnwatch, RUN);
    const w2 = invoke(IPC.orchestrationWatch, RUN);
    await tick();
    for (const i of order) m.pending[i].resolve(true);
    await Promise.all([w1, w2]);
    assert.equal(m.live.size, 1, `order ${order}: one subscription`);
    m.emit(RUN);
    assert.equal(events(), 1, "one event per change");
    await invoke(IPC.orchestrationUnwatch, RUN);
    assert.equal(m.live.size, 0, "the unwatch releases the one that is left");
  }
  const { m, invoke } = watchIpc();
  const ws = [invoke(IPC.orchestrationWatch, RUN), invoke(IPC.orchestrationWatch, RUN), invoke(IPC.orchestrationWatch, RUN)];
  await tick();
  m.pending.forEach((d) => d.resolve(true));
  await Promise.all(ws);
  assert.equal(m.live.size, 1, "concurrent watches: one subscription");
});

test("watch: a refused watch leaves nothing and does not remove a newer subscription", async () => {
  const { m, invoke } = watchIpc();
  const w1 = invoke(IPC.orchestrationWatch, RUN);
  await tick();
  const w2 = invoke(IPC.orchestrationWatch, RUN);
  await tick();
  m.pending[1].resolve(true);
  await w2;
  m.pending[0].resolve(false);
  assert.equal((await w1).ok, false);
  assert.equal(m.live.size, 1, "the newer subscription stays");
  await invoke(IPC.orchestrationUnwatch, RUN);
  assert.equal(m.live.size, 0);
  const w3 = invoke(IPC.orchestrationWatch, RUN);
  await tick();
  m.pending[2].resolve(false);
  assert.equal((await w3).ok, false);
  assert.equal(m.live.size, 0);
});

// ---------- 2b. the preload client: one main subscription per run and page, snapshot first, never older ----------

function fakeIpc() {
  const calls = [];
  const replies = [];
  let onEvent = null;
  return {
    calls, replies,
    ipc: {
      invoke(channel, ...args) { const d = deferred(); calls.push([channel, ...args]); replies.push(d); return d.promise; },
      on(channel, l) { assert.equal(channel, IPC.orchestrationEvent); onEvent = l; }
    },
    event: (seq, tick, status = "running") => onEvent({ runId: RUN, seq, tick, view: { status } }),
    channels: () => calls.map((c) => c[0])
  };
}
const snap = (seq, tick, status = "running") => ({ ok: true, value: { seq, tick, view: { status }, integrity: "ok", open: true } });

test("preload: several listeners of one run use one main subscription; the last to leave releases it", async () => {
  const f = fakeIpc();
  const client = createOrchestrationClient(f.ipc, "darwin");
  const a = [], b = [];
  const wa = client.watch(RUN, (e) => a.push(e));
  const wb = client.watch(RUN, (e) => b.push(e));
  assert.deepEqual(f.channels(), [IPC.orchestrationWatch, IPC.orchestrationGet], "the second listener only reads");
  f.replies[0].resolve(snap(5, 0));
  f.replies[1].resolve(snap(5, 1));
  await Promise.all([wa.snapshot, wb.snapshot]);
  f.event(5, 1);
  f.event(6, 0);
  assert.deepEqual(a.map((e) => [e.seq, e.tick]), [[5, 0], [5, 1], [6, 0]]);
  assert.deepEqual(b.map((e) => [e.seq, e.tick]), [[5, 1], [6, 0]], "nothing older than its own snapshot");
  wa.unwatch();
  assert.equal(f.channels().length, 2, "b still listens: no unwatch");
  f.event(7, 0);
  assert.equal(a.length, 3, "a left");
  wb.unwatch();
  wb.unwatch();
  assert.deepEqual(f.channels().slice(2), [IPC.orchestrationUnwatch], "one unwatch when the last one leaves");
});

test("preload: events that arrive before the snapshot wait for it; an older snapshot never rolls a listener back", async () => {
  const f = fakeIpc();
  const client = createOrchestrationClient(f.ipc, "darwin");
  const got = [];
  const w = client.watch(RUN, (e) => got.push([e.seq, e.tick, e.view.status]));
  f.event(12, 1, "running");
  f.event(13, 0, "running");
  assert.deepEqual(got, [], "nothing before the snapshot");
  f.replies[0].resolve(snap(12, 0));
  await w.snapshot;
  assert.deepEqual(got, [[12, 0, "running"], [12, 1, "running"], [13, 0, "running"]]);
  f.event(12, 1, "stale");
  f.event(13, 0, "stale");
  assert.equal(got.length, 3, "not newer: dropped");
});

test("preload: quick watch/unwatch/watch, a refused watch and a listener that left before the snapshot", async () => {
  const f = fakeIpc();
  const client = createOrchestrationClient(f.ipc, "darwin");
  const got = [];
  const w1 = client.watch(RUN, (e) => got.push(e));
  w1.unwatch();
  const w2 = client.watch(RUN, (e) => got.push(e));
  assert.deepEqual(f.channels(), [IPC.orchestrationWatch, IPC.orchestrationUnwatch, IPC.orchestrationWatch]);
  f.replies[0].resolve(snap(1, 0));
  f.replies[2].resolve(snap(2, 0));
  await Promise.all([w1.snapshot, w2.snapshot]);
  assert.deepEqual(got.map((e) => e.seq), [2], "the left listener gets nothing");
  const refused = client.watch(randomUUID(), () => assert.fail("no events for a refused watch"));
  f.replies[3].resolve({ ok: false, code: "run_not_found", message: "x" });
  assert.equal((await refused.snapshot).ok, false);
  assert.equal(f.channels().at(-1), IPC.orchestrationUnwatch, "a refused first watch leaves nothing registered");
});

// ---------- 3. notifications of the operation in progress ----------

const stampOf = (e) => [e.seq, e.tick];
const newer = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
function assertOrdered(events, from) {
  let last = from;
  for (const e of events) {
    assert.ok(newer(stampOf(e), last), `stamps grow: ${JSON.stringify(last)} -> ${JSON.stringify(stampOf(e))}`);
    last = stampOf(e);
  }
}

test("a subscriber sees the executor at work before the turn ends, and idle after; stamps only grow", MAC, async () => {
  const p = project();
  const gate = deferred();
  const agents = cycleAgents({ report: executed(), hold: gate.promise, edit: (c) => fs.writeFileSync(c.path("src/sum.mjs"), GOOD) });
  const { m } = manager(p.root, agents);
  const runId = randomUUID();
  await m.create({ requestId: runId, source: p.src, goal: goal() });
  const events = [];
  const { snapshot } = await m.watch(runId, (e) => events.push(e));
  try {
    await until(() => events.some((e) => e.view.active?.purpose === "execute"), "an event with the executor active", 20_000);
    assert.equal(agents.log.find((e) => e.purpose === "execute").settled, false, "seen while the turn is held");
  } finally {
    gate.resolve();
  }
  await until(async () => (await view(m, runId)).status === "completed", "completed");
  const i = events.findIndex((e) => e.view.active?.purpose === "execute");
  assert.ok(events.slice(i).some((e) => e.view.active === null), "the end of the turn is announced");
  assertOrdered(events, stampOf(snapshot.value));
  const now = (await m.get(runId)).value;
  assert.deepEqual({ seq: events.at(-1).seq, tick: events.at(-1).tick, view: events.at(-1).view }, { seq: now.seq, tick: now.tick, view: now.view });
  await m.shutdown();
});

test("a subscriber sees the project check running before it ends", MAC, async () => {
  const p = project({ extra: (src) => fs.writeFileSync(path.join(src, "tests", "slow.test.mjs"),
    "import { test } from \"node:test\";\ntest(\"slow\", () => new Promise((r) => setTimeout(r, 1500)));\n") });
  const agents = cycleAgents();
  const { m } = manager(p.root, agents);
  const runId = randomUUID();
  const events = [];
  await m.create({ requestId: runId, source: p.src, goal: goal() });
  const { snapshot } = await m.watch(runId, (e) => events.push(e));
  await until(() => events.some((e) => e.view.active?.kind === "check"), "an event with the check active");
  assert.deepEqual(events.find((e) => e.view.active?.kind === "check").view.active, { kind: "check", checkId: "node-test" });
  await until(async () => (await view(m, runId)).status === "completed", "completed");
  const i = events.findIndex((e) => e.view.active?.kind === "check");
  assert.ok(events.slice(i).some((e) => e.view.active === null));
  assertOrdered(events, stampOf(snapshot.value));
  assert.deepEqual(events.at(-1).view, (await m.get(runId)).value.view);
  await m.shutdown();
});

test("a failed journal write is announced: halted reaches the subscriber", MAC, async () => {
  const p = project();
  const gate = deferred();
  const io = { armed: false, async write(fh, buf) {
    if (io.armed && buf.toString("utf8").includes('"type":"turn.finished"')) throw new Error("the disk is gone");
    return fh.write(buf);
  } };
  const agents = cycleAgents({ report: executed(), hold: gate.promise });
  const sha = createHash("sha256").update(fs.readFileSync(path.join(p.src, "package-lock.json"))).digest("hex");
  const deps = checkPreparedDeps({ lockfileRelPath: "package-lock.json", lockfileSha256: sha, nodeModulesPath: path.join(p.src, "node_modules") });
  const registry = createRegistry([{ id: "node-test", title: "t", executable: NODE, argv: ["--test"], timeoutMs: 60_000, maxOutputBytes: 8192 }]);
  const run = await createOrchestrationService({ root: p.root, gitPath: GIT, agents, storeIo: io, checks: { registry, deps, launch: LAUNCH } })
    .createRun({ source: p.src, goal: goal() });
  const seen = [];
  run.onChange(() => seen.push(run.view().halted));
  await until(() => run.view().active?.purpose === "execute", "the executor turn");
  io.armed = true;
  gate.resolve();
  try {
    await until(() => run.view().halted, "halted");
    assert.ok(seen.includes(true), "a notification carried halted");
  } finally {
    await run.close();
  }
});

// ---------- 4. the application's provider configuration, through the manager's own path ----------

function fakeProviders({ claudeVersion = "2.1.281 (Claude Code)" } = {}) {
  const d = path.join(TMP, `providers-${++n}`);
  fs.mkdirSync(path.join(d, "state", ".codex"), { recursive: true });
  const script = (name, steps) => {
    const s = path.join(d, name);
    fs.mkdirSync(s);
    steps.forEach((st, i) => {
      fs.writeFileSync(path.join(s, `${i + 1}.json`), JSON.stringify(st.report));
      if (st.writes) fs.writeFileSync(path.join(s, `${i + 1}.writes.json`), JSON.stringify(st.writes.map(([rel, text]) => ({ rel, base64: Buffer.from(text).toString("base64") }))));
    });
    return s;
  };
  const verdict = (v) => ({ report: { verdict: v, findings: [], question: null } });
  const codex = script("codex", [{ report: { stages: [{ title: "sum", task: "improve sum" }], question: null } }, verdict("accept"), verdict("complete")]);
  const claude = script("claude", [{ report: { summary: "done", done: true }, writes: [["src/sum.mjs", GOOD]] }]);
  const wrap = (p) => {
    const f = path.join(d, `${p}-mock`);
    fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
    return f;
  };
  const ledger = path.join(d, "ledger.jsonl");
  const env = (extra) => ({ HOME: path.join(d, "state"), MOCK_STATE: path.join(d, "state"), MOCK_LEDGER: ledger, ...extra });
  const file = path.join(d, "providers.json");
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
      env: env({ MOCK_SCRIPT: codex, CODEX_HOME: path.join(d, "state", ".codex") }) },
    claude: { executable: wrap("claude"), version: claudeVersion, path: `${path.dirname(NODE)}:/usr/bin:/bin`, env: env({ MOCK_SCRIPT: claude }) }
  }));
  const argvs = () => fs.readdirSync(path.join(d, "state")).filter((f) => f.endsWith(".json"))
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(d, "state", f), "utf8")).turns ?? []).map((t) => t.argv);
  return { file, ledger, argvs };
}
const after2 = (argv, flag) => argv[argv.indexOf(flag) + 1];

for (const claudeVersion of ["2.1.281 (Claude Code)"]) test(`the application's providers (Claude ${claudeVersion}): Codex gpt-6-astra/high and Claude claude-sonnet-5/$1 reach the fake CLIs' argv`, MAC, async () => {
  const p = project();
  const fake = fakeProviders({ claudeVersion });
  const { m } = manager(p.root, null, { agents: testProviderAgents(fake.file, () => LAUNCH) });
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: p.src, goal: goal() });
  assert.equal(r.ok, true, JSON.stringify(r));
  await until(async () => ["completed", "paused", "stopped", "failed"].includes((await view(m, runId)).status), "the run settles", 120_000);
  assert.equal((await view(m, runId)).status, "completed");
  const argvs = fake.argvs();
  const codex = argvs.filter((a) => a[0] === "exec");
  const claude = argvs.filter((a) => a.includes("-p"));
  assert.equal(codex.length, 3);
  assert.equal(claude.length, 1);
  for (const a of codex) {
    assert.equal(after2(a, "-m"), "gpt-6-astra", a.join(" "));
    assert.ok(a.includes('model_reasoning_effort="high"'), a.join(" "));
  }
  assert.equal(after2(claude[0], "--model"), "claude-sonnet-5");
  assert.equal(after2(claude[0], "--max-budget-usd"), "1");
  await m.shutdown();
});

// exact versions only: the candidate 2.1.280, a neighbour on either side of the admitted 2.1.281, and 2.1.282, which is
// admitted for native sessions only (its probe did not run this path)
for (const claudeVersion of ["2.1.280 (Claude Code)", "2.1.279 (Claude Code)", "2.1.282 (Claude Code)", "2.1.283 (Claude Code)"]) test(`the application refuses a CLI version outside the proven combination (Claude ${claudeVersion}) before anything starts`, async () => {
  const p = project();
  const fake = fakeProviders({ claudeVersion });
  const { m } = manager(p.root, null, { agents: testProviderAgents(fake.file, () => LAUNCH) });
  const r = await m.create({ requestId: randomUUID(), source: p.src, goal: goal() });
  assert.deepEqual([r.ok, r.code], [false, "unsupported_version"], JSON.stringify(r));
  assert.deepEqual(runDirs(p.root), []);
  assert.equal(fs.existsSync(fake.ledger), false, "no CLI process");
});

// ---------- 5. shutdown against a create still resolving its project path ----------

test("shutdown while a create is still reading the project path: shutting_down, no run, no writer, no turn", MAC, async () => {
  const p = project();
  const agents = cycleAgents();
  const { m, calls } = manager(p.root, agents);
  const pending = m.create({ requestId: randomUUID(), source: p.src, goal: goal() }); // not awaited
  await m.shutdown();
  const r = await pending;
  assert.deepEqual([r.ok, r.code], [false, "shutting_down"], JSON.stringify(r));
  await sleep(300);
  assert.equal(m.openCount(), 0, "no writer");
  assert.deepEqual(runDirs(p.root), [], "no run");
  assert.equal(calls.agents, 0, "no agent resolved");
  assert.equal(agents.log.length, 0, "no turn");
});

test("a create registered before shutdown finishes under its control: the run is left paused and closed", MAC, async () => {
  const p = project();
  const agents = cycleAgents();
  const entered = deferred(), gate = deferred();
  const { m } = manager(p.root, null, { agents: async () => { entered.resolve(); await gate.promise; return agents; } });
  const runId = randomUUID();
  const pending = m.create({ requestId: runId, source: p.src, goal: goal() });
  await entered.promise; // registered: past the identity, inside the creation
  const down = m.shutdown();
  gate.resolve();
  await down;
  const r = await pending;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(m.openCount(), 0, "the handle was shut down, not left open");
  const listed = (await m.list()).value;
  assert.deepEqual(listed.map((x) => [x.view.runId, x.view.status, x.open]), [[runId, "paused", false]]);
  assert.equal(agents.active, 0, "no turn in flight");
  const turns = agents.log.length;
  await sleep(500);
  assert.equal(agents.log.length, turns, "nothing after the shutdown");
  assert.ok(agents.log.every((e) => e.settled), "every started turn settled");
});

test("shutdown twice, sequentially and concurrently, is safe; a manager after it creates as before", MAC, async () => {
  const p = project();
  const agents = cycleAgents({ report: executed(), hold: new Promise(() => {}) });
  const { m } = manager(p.root, agents);
  const runId = randomUUID();
  await m.create({ requestId: runId, source: p.src, goal: goal() });
  await until(async () => (await view(m, runId)).active?.purpose === "execute", "the executor turn");
  await Promise.all([m.shutdown(), m.shutdown()]);
  await m.shutdown();
  assert.equal(m.openCount(), 0);
  // UX-5: the application's exit is its own pause reason (app_closed), not the person's pause (user_request)
  assert.deepEqual([(await view(m, runId)).status, (await view(m, runId)).reason], ["paused", "app_closed"]);
  const late = await m.create({ requestId: randomUUID(), source: p.src, goal: goal() });
  assert.deepEqual([late.ok, late.code], [false, "shutting_down"]);

  const next = manager(p.root, cycleAgents());
  const again = { requestId: randomUUID(), source: p.src, goal: goal() };
  const [a, b] = await Promise.all([next.m.create(again), next.m.create(again)]);
  assert.deepEqual([a.value, b.value], [{ runId: again.requestId, created: true }, { runId: again.requestId, created: true }]);
  await until(async () => (await view(next.m, again.requestId)).status === "completed", "completed");
  assert.deepEqual((await next.m.create(again)).value, { runId: again.requestId, created: false });
  await next.m.shutdown();
});
