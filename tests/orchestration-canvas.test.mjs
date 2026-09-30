// Stage 8 (stage-8-contract.md §3): agent cards and links in main. Every link rule is enforced here without a renderer;
// cards and links survive a restart; a run is started on a link with the lead's project as its source; moving a card
// never changes a run's revision; a link or card with an active run cannot be deleted; deleting keeps the run history.
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
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const MAC = { skip: process.platform !== "darwin" && "checks run only in the macOS sandbox", timeout: 180_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-canvas-")));
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
const agents = (execute = { report: executed() }) => createTestAgents({
  plan: { report: plan("only stage") }, execute, review: { report: review("accept") }, final_review: { report: review("complete") }
});
const manager = (root, a = agents()) => createRunManager({
  root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, agents: async () => a, stopGraceMs: 2000
});
const box = (x = 0, y = 0) => ({ position: { x, y }, size: { width: 320, height: 180 } });
const goal = (extra = {}) => ({ text: "extend sum", criteria: ["sum works"], checks: ["node-test"], ...extra });
async function until(fn, what, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (await fn()) return;
  throw new Error(`not reached: ${what}`);
}
const code = (r) => (r.ok ? "ok" : r.code);
async function pair(m, src, other = src) {
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds: box() })).value;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: other, bounds: box(400) })).value;
  return { lead, exec };
}

test("reading the canvas creates nothing; cards and links are kept across a restart", async () => {
  const root = path.join(TMP, "root-restart");
  const src = project();
  const one = manager(root);
  assert.deepEqual((await one.canvas()).value, { agents: [], links: [] });
  assert.equal(fs.existsSync(root), false, "nothing written by a read");
  const { lead, exec } = await pair(one, `${src}/`); // any spelling: the card keeps the realpath
  assert.equal(lead.project, src);
  assert.deepEqual([lead.role, exec.role], ["lead", "executor"]);
  const link = (await one.createLink({ linkId: randomUUID(), fromAgentId: lead.agentId, toAgentId: exec.agentId })).value;
  await one.moveAgent(exec.agentId, box(900, 50));
  await one.shutdown();
  const two = manager(root);
  const c = (await two.canvas()).value;
  assert.deepEqual(c.agents.map((a) => [a.agentId, a.provider, a.bounds.position.x]), [[lead.agentId, "codex", 0], [exec.agentId, "claude", 900]]);
  assert.deepEqual(c.links.map((l) => [l.linkId, l.fromAgentId, l.toAgentId, l.runIds]), [[link.linkId, lead.agentId, exec.agentId, []]]);
  assert.equal(two.openCount(), 0);
});

test("link rules are enforced in main: self, roles, duplicate pair, different projects, missing card; a repeat returns the same link", async () => {
  const root = path.join(TMP, "root-rules");
  const m = manager(root);
  const a = project(), b = project();
  const { lead, exec } = await pair(m, a);
  const lead2 = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: a, bounds: box() })).value;
  const execB = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: b, bounds: box() })).value;
  const link = (from, to, linkId = randomUUID()) => m.createLink({ linkId, fromAgentId: from, toAgentId: to });
  assert.equal(code(await link(lead.agentId, lead.agentId)), "link_self");
  assert.equal(code(await link(exec.agentId, lead.agentId)), "link_roles", "executor -> lead");
  assert.equal(code(await link(lead.agentId, lead2.agentId)), "link_roles", "lead -> lead");
  assert.equal(code(await link(lead.agentId, execB.agentId)), "link_projects");
  assert.equal(code(await link(lead.agentId, randomUUID())), "agent_not_found");
  const id = randomUUID();
  const first = await link(lead.agentId, exec.agentId, id);
  assert.equal(code(first), "ok");
  assert.deepEqual((await link(lead.agentId, exec.agentId, id)).value, first.value, "the same request: the same link");
  assert.equal(code(await link(lead.agentId, exec.agentId)), "link_duplicate");
  assert.equal(code(await link(lead2.agentId, exec.agentId, id)), "request_conflict");
  assert.equal((await m.canvas()).value.links.length, 1);
  assert.equal(code(await m.createAgent({ agentId: randomUUID(), provider: "claude", project: path.join(TMP, "nope"), bounds: box() })), "invalid_project");
  await m.shutdown();
});

test("a run on a link: the lead's project is the source, a second start is refused, moving a card keeps the revision, delete needs a Stop", MAC, async () => {
  const root = path.join(TMP, "root-run");
  const src = project();
  let release;
  const a = agents({ report: executed(), hold: new Promise((r) => { release = r; }) });
  const m = manager(root, a);
  const { lead, exec } = await pair(m, src);
  const link = (await m.createLink({ linkId: randomUUID(), fromAgentId: lead.agentId, toAgentId: exec.agentId })).value;
  const requestId = randomUUID();
  const started = await m.startOnLink({ linkId: link.linkId, requestId, goal: goal() });
  assert.deepEqual(started.value, { runId: requestId, created: true });
  assert.deepEqual((await m.startOnLink({ linkId: link.linkId, requestId, goal: goal() })).value, { runId: requestId, created: false }, "a repeat");
  const other = await m.startOnLink({ linkId: link.linkId, requestId: randomUUID(), goal: goal() });
  assert.equal(code(other), "link_busy");
  assert.deepEqual((await m.list()).value.map((r) => r.view.runId), [requestId], "no second run");
  assert.deepEqual((await m.canvas()).value.links[0].runIds, [requestId]);

  await until(async () => (await m.get(requestId)).value.view.active?.purpose === "execute", "executor at work");
  const rev = (await m.get(requestId)).value.view.revision;
  await m.moveAgent(lead.agentId, box(123, 456));
  await m.moveAgent(exec.agentId, box(789, 10));
  assert.equal((await m.get(requestId)).value.view.revision, rev, "geometry is not part of the run");

  assert.equal(code(await m.deleteLink(link.linkId)), "link_active_run");
  assert.equal(code(await m.deleteAgent(exec.agentId)), "link_active_run");
  const stop = await m.command(requestId, { commandId: randomUUID(), expectedRevision: rev, command: { kind: "stop" } });
  assert.deepEqual(stop.value, { status: "accepted", code: null }, "the old expectedRevision still holds after the moves");
  await until(async () => (await m.get(requestId)).value.view.status === "stopped", "stopped");
  release();
  assert.equal(code(await m.deleteLink(link.linkId)), "ok");
  const c = (await m.canvas()).value;
  assert.deepEqual([c.links.length, c.agents.length], [0, 2], "cards stay");
  assert.deepEqual((await m.list()).value.map((r) => [r.view.runId, r.view.status]), [[requestId, "stopped"]], "the run's history stays");
  assert.ok((await m.history(requestId, 0, 200)).value.records.length > 5);
  await m.shutdown();
});

test("deleting a card removes its links (not the runs) once no run of them is active", MAC, async () => {
  const root = path.join(TMP, "root-card");
  const src = project();
  const m = manager(root);
  const { lead, exec } = await pair(m, src);
  const link = (await m.createLink({ linkId: randomUUID(), fromAgentId: lead.agentId, toAgentId: exec.agentId })).value;
  const runId = randomUUID();
  await m.startOnLink({ linkId: link.linkId, requestId: runId, goal: goal() });
  await until(async () => (await m.get(runId)).value.view.status === "completed", "completed");
  assert.equal(code(await m.deleteAgent(lead.agentId)), "ok");
  const c = (await m.canvas()).value;
  assert.deepEqual([c.agents.map((a) => a.agentId), c.links], [[exec.agentId], []]);
  assert.equal((await m.get(runId)).value.view.status, "completed");
  await m.shutdown();
});

test("the canvas channels refuse a foreign renderer and anything but their fields (no source, path or argv from IPC)", async () => {
  const root = path.join(TMP, "root-ipc");
  const m = manager(root);
  const page = (id) => Object.assign(new EventEmitter(), { id, mainFrame: {}, send() {}, isDestroyed: () => false });
  const main = page(1), other = page(2);
  const handlers = new Map();
  registerOrchestrationIpc((channel, listener) => handlers.set(channel, (event, ...args) => {
    assertMainRenderer(event, () => ({ isDestroyed: () => false, webContents: main }));
    return listener(event, ...args);
  }), m);
  const call = (wc, channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({ sender: wc, senderFrame: wc.mainFrame }, ...args));
  const src = project();
  const agent = { agentId: randomUUID(), provider: "codex", project: src, bounds: box(), workspaceId: "common" };
  await assert.rejects(call(other, IPC.orchestrationAgentCreate, agent), /trusted CanvasTTY renderer/);
  await assert.rejects(call(other, IPC.orchestrationCanvas), /trusted CanvasTTY renderer/);
  for (const [channel, ...args] of [
    [IPC.orchestrationAgentCreate, { ...agent, provider: "qwen" }],
    [IPC.orchestrationAgentCreate, { ...agent, workspaceId: undefined }],
    [IPC.orchestrationAgentCreate, { ...agent, workspaceId: "../x" }],
    [IPC.orchestrationAgentGroupMove, [agent.agentId], "../x"],
    [IPC.orchestrationAgentGroupMove, [], "common"],
    [IPC.orchestrationAgentCreate, { ...agent, executable: "/bin/sh" }],
    [IPC.orchestrationAgentCreate, { ...agent, project: "relative" }],
    [IPC.orchestrationAgentCreate, { ...agent, bounds: { position: { x: Infinity, y: 0 }, size: { width: 1, height: 1 } } }],
    [IPC.orchestrationAgentMove, agent.agentId, { position: { x: 0, y: 0 } }],
    [IPC.orchestrationLinkCreate, { linkId: randomUUID(), fromAgentId: randomUUID(), toAgentId: randomUUID(), role: "lead" }],
    [IPC.orchestrationLinkStart, { linkId: randomUUID(), requestId: randomUUID(), goal: goal(), source: "/etc" }],
    [IPC.orchestrationLinkStart, { linkId: randomUUID(), requestId: randomUUID(), goal: { ...goal(), argv: ["x"] } }],
    [IPC.orchestrationLinkDelete, "../x"]
  ]) {
    const r = await call(main, channel, ...args);
    assert.deepEqual([r.ok, r.code], [false, "invalid_argument"], `${channel} ${JSON.stringify(args)}`);
  }
  assert.equal(fs.existsSync(root), false, "nothing written");
  assert.equal(code(await call(main, IPC.orchestrationAgentCreate, agent)), "ok");
  await m.shutdown();
});
