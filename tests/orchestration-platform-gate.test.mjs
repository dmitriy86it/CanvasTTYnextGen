// Orchestration only where a run can finish: its project checks run in the macOS Seatbelt sandbox. Elsewhere (Linux,
// Windows) nothing new is linked, started or continued, before any CLI, login shell or model call; runs already on disk
// stay readable, stoppable and unlinkable. The renderer shows the entry points inactive with a hint.
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
import { assessReadiness } from "../src/main/services/orchestration/readiness.ts";
import { orchestrationAvailable } from "../src/shared/orchestration.ts";
import { createOrchestrationClient } from "../src/preload/orchestrationClient.ts";
import { actionEnabled, orchestrationAvailableHere, orchestrationEntry } from "../src/renderer/src/features/orchestration/runModel.ts";
import { t } from "../src/renderer/src/lib/i18n.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
// The run made before the platform changes is a real engine run (POSIX supervisor): macOS and Linux, like the engine tests.
const ENGINE = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-platform-gate-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: TMP,
  GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const v = await fn(); if (v) return v; }
  throw new Error(`not reached: ${what}`);
}
const code = (r) => (r.ok ? "ok" : r.code);
const box = (x = 0) => ({ position: { x, y: 0 }, size: { width: 320, height: 180 } });
let n = 0;

// Stand-ins for everything a start or a resume would run: the native CLIs with the login shell, the legacy agent
// CLIs, the turn supervisor, the check program. Each counts its calls; a refused platform must leave them all at 0.
function counted() {
  const calls = { native: 0, agents: 0, launch: 0, node: 0 };
  return {
    calls,
    native: async () => { calls.native += 1; throw Object.assign(new Error("a CLI was started"), { code: "provider_unavailable" }); },
    agents: async () => { calls.agents += 1; throw Object.assign(new Error("a CLI was started"), { code: "provider_unavailable" }); },
    launch: () => { calls.launch += 1; return LAUNCH; },
    nodePath: () => { calls.node += 1; return NODE; }
  };
}
const total = (calls) => Object.values(calls).reduce((a, b) => a + b, 0);

function gitProject(name) {
  const src = path.join(TMP, name);
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "README.md"), "project\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(src, ...a);
  return src;
}

async function linked(m, src) {
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds: box() })).value;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds: box(400) })).value;
  const link = (await m.createLink({ linkId: randomUUID(), fromAgentId: lead.agentId, toAgentId: exec.agentId })).value;
  return { lead, exec, link };
}

test("availability by platform: macOS only", () => {
  assert.equal(orchestrationAvailable("darwin"), true);
  assert.equal(orchestrationAvailable("linux"), false);
  assert.equal(orchestrationAvailable("win32"), false);
});

test("readiness: one blocker for Linux and Windows, none on macOS", async () => {
  const project = gitProject(`ready-${++n}`);
  const base = { project, commands: ["true"], workMode: "project", gitPath: GIT, busy: false,
    runtime: { ok: false, code: "provider_unavailable", detail: "not measured" }, checkedVersions: { codex: [], claude: [] } };
  for (const platform of ["linux", "win32"]) {
    const r = await assessReadiness({ ...base, platform });
    const item = r.items.find((i) => i.id === "platform");
    assert.equal(item.level, "blocker", platform);
    assert.equal(item.facts.code, "unsupported_platform", platform);
    assert.equal(r.ready, false);
  }
  const mac = (await assessReadiness({ ...base, platform: "darwin" })).items.find((i) => i.id === "platform");
  assert.equal(mac.level, "ok");
});

for (const platform of ["linux", "win32"]) {
  test(`${platform}: link, new goal, resume and readiness are refused before any CLI (0 calls)`, async () => {
    const root = path.join(TMP, `root-${++n}`);
    const src = gitProject(`src-${n}`);
    // Cards and a link made on macOS (no CLI is needed for them), then the same data opened on this platform.
    const mac = createRunManager({ platform: "darwin", root, gitPath: () => GIT, ...counted() });
    const cards = await linked(mac, src);
    assert.ok(cards.link, "the link exists");
    await mac.shutdown();

    const stub = counted();
    const m = createRunManager({ platform, root, gitPath: () => GIT, ...stub });
    const goal = { text: "x", criteria: ["y"], commands: ["true"], mode: "autopilot" };
    assert.equal(code(await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds: box() })), "unsupported_platform");
    assert.equal(code(await m.createLink({ linkId: randomUUID(), fromAgentId: cards.lead.agentId, toAgentId: cards.exec.agentId })), "unsupported_platform");
    assert.equal(code(await m.startOnLink({ linkId: cards.link.linkId, requestId: randomUUID(), goal })), "unsupported_platform");
    assert.equal(code(await m.create({ requestId: randomUUID(), source: src, goal })), "unsupported_platform");
    assert.equal(code(await m.command(randomUUID(), { commandId: randomUUID(), expectedRevision: 1, command: { kind: "resume" } })), "unsupported_platform");
    assert.equal(code(await m.probe(cards.link.linkId)), "unsupported_platform");
    const ready = await m.readiness({ linkId: cards.link.linkId, commands: ["true"], workMode: "project" });
    assert.equal(ready.ok, true);
    assert.equal(ready.value.ready, false);
    assert.deepEqual(ready.value.items.map((i) => [i.id, i.level, i.facts?.code]), [["platform", "blocker", "unsupported_platform"]]);
    assert.equal(total(stub.calls), 0, `no CLI, shell, supervisor or check program: ${JSON.stringify(stub.calls)}`);
    assert.equal(fs.existsSync(path.join(root, "runs")), false, "no run was created");
    assert.equal((await m.canvas()).value.links.length, 1, "the existing link is still shown");
    await m.shutdown();
  });
}

test("an existing run opened on Linux: history readable, resume refused, Stop and unlink work", ENGINE, async () => {
  const root = path.join(TMP, `root-${++n}`);
  const src = path.join(TMP, `src-${n}`);
  fs.cpSync(path.join(HERE, "fixtures", "orchestration", "check-project"), src, { recursive: true });
  fs.rmSync(path.join(src, "tests", "broken.test.mjs"));
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) g(src, ...a);
  let release;
  const agents = createTestAgents({ plan: { report: plan("only stage") }, execute: { report: executed(), hold: new Promise((r) => { release = r; }) },
    review: { report: review("accept") }, final_review: { report: review("complete") } });
  // Made on macOS: paused when the application closed during a turn.
  const mac = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, agents: async () => agents, stopGraceMs: 2000 });
  const cards = await linked(mac, src);
  const runId = randomUUID();
  assert.equal(code(await mac.startOnLink({ linkId: cards.link.linkId, requestId: runId, goal: { text: "extend sum", criteria: ["sum works"], checks: ["node-test"] } })), "ok");
  await until(async () => (await mac.get(runId)).value.view.active?.purpose === "execute", "executor at work");
  await mac.shutdown();
  release();

  const stub = counted();
  const m = createRunManager({ platform: "linux", root, gitPath: () => GIT, stopGraceMs: 2000, ...stub });
  const before = (await m.get(runId)).value.view;
  assert.equal(before.status, "paused");
  assert.ok((await m.history(runId, 0, 500)).value.records.length > 0, "its history is readable");
  assert.deepEqual((await m.list()).value.map((r) => r.view.runId), [runId], "the run is listed");
  assert.equal(code(await m.command(runId, { commandId: randomUUID(), expectedRevision: before.revision, command: { kind: "resume" } })), "unsupported_platform");
  assert.equal(code(await m.deleteLink(cards.link.linkId)), "link_active_run", "a paused run still holds its link");

  const stop = await m.command(runId, { commandId: randomUUID(), expectedRevision: before.revision, command: { kind: "stop" } });
  assert.deepEqual(stop, { ok: true, value: { status: "accepted", code: null } });
  await until(async () => (await m.get(runId)).value.view.status === "stopped", "stopped");
  assert.equal(code(await m.deleteLink(cards.link.linkId)), "ok");
  assert.equal(code(await m.deleteAgent(cards.lead.agentId)), "ok");
  assert.equal(stub.calls.native + stub.calls.agents, 0, "no CLI for the refusal, the stop or the unlink");
  assert.deepEqual((await m.list()).value.map((r) => [r.view.runId, r.view.status]), [[runId, "stopped"]], "the run stays in the history");
  await m.shutdown();
});

test("renderer: orchestration entry points inactive with the hint where it is unavailable", () => {
  assert.deepEqual(orchestrationEntry(true), { disabled: false, hint: null });
  const off = orchestrationEntry(false);
  assert.equal(off.disabled, true);
  assert.equal(t("en", off.hint), "Orchestration is currently available on macOS only");
  assert.equal(t("ru", off.hint), "Оркестрация пока доступна только на macOS");
  assert.equal(t("en", "orchError_unsupported_platform"), "Orchestration is currently available on macOS only", "main's refusal reads the same");
  assert.equal(t("ru", "orchError_unsupported_platform"), "Оркестрация пока доступна только на macOS");
  for (const a of ["resume", "step", "answer", "clarify", "raise_limit", "recover", "permission", "pause", "keep_running"]) {
    assert.equal(actionEnabled(a, false), false, a);
    assert.equal(actionEnabled(a, true), true, a);
  }
  assert.equal(actionEnabled("stop", false), true, "Stop stays active");
  assert.equal(orchestrationAvailableHere(), true, "no window API (server render): unchanged");
  globalThis.window = { canvasTTY: { orchestration: { available: false } } };
  try { assert.equal(orchestrationAvailableHere(), false, "the preload's answer"); } finally { delete globalThis.window; }
  const ipc = { invoke: async () => ({ ok: true }), on() {} };
  assert.equal(createOrchestrationClient(ipc, "linux").available, false);
  assert.equal(createOrchestrationClient(ipc, "win32").available, false);
  assert.equal(createOrchestrationClient(ipc, "darwin").available, true);
});
