// Regressions for the independent review of stage 8 (stage-8-contract.md §3.1, §2.1):
//   1. a run started on a link always belongs to the link, whatever write fails, also after a restart;
//   2. a command whose answer was lost is repeated as the same request (id, expectedRevision, payload), so main
//      answers with the recorded result and does nothing again — also after the run's revision has moved on.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager } from "../src/main/services/orchestration/manager.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { timeout: 180_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-r8-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: TMP,
  GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
function project() {
  const src = path.join(TMP, `src-${++n}`);
  fs.cpSync(path.join(HERE, "fixtures", "orchestration", "check-project"), src, { recursive: true });
  fs.rmSync(path.join(src, "tests", "broken.test.mjs"));
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fixture");
  return src;
}
const testAgents = () => createTestAgents({
  plan: { report: plan("only stage") }, execute: { report: executed() }, review: { report: review("accept") }, final_review: { report: review("complete") }
});
// agentsHook runs when a run asks for its agents: after the run exists, before anything else is written.
function manager(root, { agentsHook = () => {}, calls = { n: 0 } } = {}) {
  return createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { calls.n++; agentsHook(); return testAgents(); } });
}
const box = (x = 0) => ({ position: { x, y: 0 }, size: { width: 320, height: 180 } });
const goal = (extra = {}) => ({ text: "extend sum", criteria: ["sum works"], checks: ["node-test"], ...extra });
async function until(fn, what, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (await fn()) return;
  throw new Error(`not reached: ${what}`);
}
const code = (r) => (r.ok ? "ok" : r.code);
async function linked(m, src) {
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds: box() })).value;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds: box(400) })).value;
  return (await m.createLink({ linkId: randomUUID(), fromAgentId: lead.agentId, toAgentId: exec.agentId })).value;
}
// canvas.json is made unwritable by putting a directory where the atomic rename goes
function breakCanvas(root) {
  const file = path.join(root, "canvas.json");
  fs.renameSync(file, `${file}.saved`);
  fs.mkdirSync(file);
  return () => { fs.rmdirSync(file); fs.renameSync(`${file}.saved`, file); };
}
const status = async (m, runId) => (await m.get(runId)).value?.view.status;

test("a canvas write that fails after the run exists does not orphan the run; a second start is refused, also after a restart", OPTS, async () => {
  const root = path.join(TMP, "after-create");
  let restore = null;
  const calls = { n: 0 };
  const m = manager(root, { calls, agentsHook: () => { if (!restore) restore = breakCanvas(root); } });
  const src = project();
  const link = await linked(m, src);
  const runId = randomUUID();
  try {
    const started = await m.startOnLink({ linkId: link.linkId, requestId: runId, goal: goal({ reviewPlan: true }) });
    assert.ok(restore, "the canvas was unwritable while the run was being created");
    const runs = (await m.list()).value;
    // either the start succeeded, or it failed and no run exists: never a run the link does not know
    if (started.ok) assert.equal(started.value.runId, runId);
    else assert.equal(runs.length, 0, `refused (${started.code}) but a run exists`);
    await until(async () => (await status(m, runId)) === "paused", "run paused at the plan review");
    restore();
    restore = () => {};
    assert.deepEqual((await m.canvas()).value.links[0].runIds, [runId], "the run belongs to its link");
    assert.equal(code(await m.startOnLink({ linkId: link.linkId, requestId: randomUUID(), goal: goal() })), "link_busy");
    const repeat = await m.startOnLink({ linkId: link.linkId, requestId: runId, goal: goal({ reviewPlan: true }) });
    assert.deepEqual(repeat.value, { runId, created: false }, "a repeat of the request answers with its run");
    assert.equal((await m.list()).value.length, 1, "one run only");
  } finally {
    await m.shutdown();
  }
  // restart: the link still owns the run; nothing opens or continues; a second run is still refused
  const before = calls.n;
  const m2 = manager(root, { calls });
  try {
    assert.deepEqual((await m2.canvas()).value.links[0].runIds, [runId]);
    const s = (await m2.get(runId)).value;
    assert.equal(s.open, false, "the run is not opened by the restart");
    assert.equal(s.view.status, "paused");
    assert.equal(code(await m2.startOnLink({ linkId: link.linkId, requestId: randomUUID(), goal: goal() })), "link_busy");
    await sleep(300);
    assert.equal(calls.n, before, "no agent was asked for after the restart");
    assert.equal((await m2.list()).value.length, 1);
  } finally {
    await m2.shutdown();
  }
});

test("a canvas write that fails before the run is created leaves no run; the next start works", OPTS, async () => {
  const root = path.join(TMP, "before-create");
  const calls = { n: 0 };
  const m = manager(root, { calls });
  try {
    const link = await linked(m, project());
    const restore = breakCanvas(root);
    const failed = await m.startOnLink({ linkId: link.linkId, requestId: randomUUID(), goal: goal({ reviewPlan: true }) });
    restore();
    assert.equal(code(failed), "store_failed", "a failed write is a store failure, not a raw file-system code");
    assert.equal((await m.list()).value.length, 0, "no run was created");
    assert.equal(calls.n, 0, "no agent was asked for");
    assert.deepEqual((await m.canvas()).value.links[0].runIds, []);
    const ok = await m.startOnLink({ linkId: link.linkId, requestId: randomUUID(), goal: goal({ reviewPlan: true }) });
    assert.equal(code(ok), "ok");
    assert.deepEqual((await m.canvas()).value.links[0].runIds, [ok.value.runId]);
  } finally {
    await m.shutdown();
  }
});

test("a reservation whose run was never created (a crash between the two) is not shown and does not block the link", OPTS, async () => {
  const root = path.join(TMP, "phantom");
  const m = manager(root);
  const link = await linked(m, project());
  await m.shutdown();
  const file = path.join(root, "canvas.json");
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  const phantom = randomUUID();
  c.links[0].runIds.push(phantom);
  fs.writeFileSync(file, JSON.stringify(c));
  const m2 = manager(root);
  try {
    assert.deepEqual((await m2.canvas()).value.links[0].runIds, [], "a run id without a run is not shown");
    const ok = await m2.startOnLink({ linkId: link.linkId, requestId: randomUUID(), goal: goal({ reviewPlan: true }) });
    assert.equal(code(ok), "ok");
    assert.deepEqual((await m2.canvas()).value.links[0].runIds, [ok.value.runId]);
  } finally {
    await m2.shutdown();
  }
});

// ---------- commands whose answer was lost ----------

async function pausedRun(root) {
  const m = manager(root);
  const runId = randomUUID();
  assert.equal(code(await m.create({ requestId: runId, source: project(), goal: goal({ reviewPlan: true }) })), "ok");
  await until(async () => (await m.get(runId)).value.view.reason === "plan_review", "plan review pause");
  return { m, runId };
}
const view = async (m, runId) => (await m.get(runId)).value.view;
const records = async (m, runId, type) => (await m.history(runId, 0, 200)).value.records.filter((r) => r.type === type);

test("clarify: main accepts, the answer is lost, the revision moves on; the repeat returns the recorded answer and adds nothing", OPTS, async () => {
  const { createCommandSender } = await import("../src/renderer/src/features/orchestration/runModel.ts");
  const { m, runId } = await pausedRun(path.join(TMP, "clarify"));
  try {
    const sender = createCommandSender(randomUUID);
    const command = { kind: "clarify", text: "Keep backward compatibility" };
    const before = await view(m, runId);
    const first = sender.request(runId, before.revision, command);
    const answer = await m.command(runId, first); // accepted by main; the renderer never sees it
    assert.equal(answer.value.status, "accepted");
    const now = await view(m, runId);
    assert.ok(now.revision > before.revision, "the run moved on");
    const retry = sender.request(runId, now.revision, command);
    assert.deepEqual(retry, first, "the same request: id, expectedRevision and payload");
    assert.deepEqual(await m.command(runId, retry), answer, "main answers with the recorded result");
    assert.equal((await records(m, runId, "clarification.added")).length, 1, "one clarification");
    sender.settle(retry);
    assert.notEqual(sender.request(runId, now.revision, command).commandId, first.commandId, "a new press after the answer is a new action");
  } finally {
    await m.shutdown();
  }
});

test("step: a repeat after a lost answer does not start another step", OPTS, async () => {
  const { createCommandSender } = await import("../src/renderer/src/features/orchestration/runModel.ts");
  const { m, runId } = await pausedRun(path.join(TMP, "step"));
  try {
    const sender = createCommandSender(randomUUID);
    const before = await view(m, runId);
    const first = sender.request(runId, before.revision, { kind: "step" });
    const answer = await m.command(runId, first);
    assert.equal(answer.value.status, "accepted");
    await until(async () => (await view(m, runId)).reason === "step_done", "the step is done");
    const now = await view(m, runId);
    const retry = sender.request(runId, now.revision, { kind: "step" });
    assert.deepEqual(retry, first);
    assert.deepEqual(await m.command(runId, retry), answer);
    await sleep(500);
    const after = await view(m, runId);
    assert.equal(after.reason, "step_done");
    assert.equal(after.revision, now.revision, "nothing happened after the repeat");
    const turns = (await records(m, runId, "orch.turn")).filter((r) => r.data.purpose !== "plan");
    assert.equal(turns.length, 1, "exactly one turn after the plan");
  } finally {
    await m.shutdown();
  }
});

test("the sender keeps a pending request across a reload of the window (session storage)", async () => {
  const { createCommandSender } = await import("../src/renderer/src/features/orchestration/runModel.ts");
  let saved = null;
  const storage = { read: () => saved, write: (v) => { saved = v; } };
  const a = createCommandSender(randomUUID, storage);
  const req = a.request("r1", 4, { kind: "stop" });
  const b = createCommandSender(randomUUID, storage); // a new page
  assert.deepEqual(b.request("r1", 9, { kind: "stop" }), req);
  assert.deepEqual(b.pending("r1"), [req]);
  b.settle(req);
  assert.deepEqual(createCommandSender(randomUUID, storage).pending("r1"), []);
});
