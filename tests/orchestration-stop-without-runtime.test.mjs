// A paused run left by an earlier start of the application must be stoppable, and its cards deletable, when the CLIs
// it needs to continue are now missing or of another version. Stop needs no agent, CLI or prepared dependencies; start
// and resume still refuse without them.
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
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-stop-norun-")));
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

// The CLIs of the new start: absent, or of a version the application does not run. Counted: Stop must not ask for them.
function missing(code) {
  const asked = { n: 0 };
  const fail = async () => { asked.n += 1; throw Object.assign(new Error(`${code}: the CLI of this start`), { code }); };
  return { asked, fail };
}

async function linked(m, src) {
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds: box() })).value;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds: box(400) })).value;
  const link = (await m.createLink({ linkId: randomUUID(), fromAgentId: lead.agentId, toAgentId: exec.agentId })).value;
  return { lead, exec, link };
}

// After the restart: the run is paused, resume is refused for the missing runtime, the cards need a Stop; Stop is
// accepted without the runtime, the run ends stopped, the cards and the link go, history and results stay.
async function stopAfterRestart(m2, asked, runId, { lead, exec, link }, refusal) {
  const before = (await m2.get(runId)).value.view;
  assert.equal(before.status, "paused");
  const historyBefore = (await m2.history(runId, 0, 500)).value.records.length;
  assert.equal(code(await m2.deleteLink(link.linkId)), "link_active_run", "a paused run holds its link");
  assert.equal(code(await m2.deleteAgent(lead.agentId)), "link_active_run");

  const resume = await m2.command(runId, { commandId: randomUUID(), expectedRevision: before.revision, command: { kind: "resume" } });
  assert.equal(code(resume), refusal, "continuing still needs the runtime");
  assert.ok(asked.n >= 1);

  // A stop the run rejects leaves nothing held without the runtime: the next command needs it again.
  const stale = await m2.command(runId, { commandId: randomUUID(), expectedRevision: before.revision - 1, command: { kind: "stop" } });
  assert.deepEqual(stale.value, { status: "rejected", code: "stale_revision" });
  assert.equal((await m2.get(runId)).value.view.status, "paused");
  assert.equal(code(await m2.command(runId, { commandId: randomUUID(), expectedRevision: before.revision, command: { kind: "resume" } })), refusal);
  const askedByResume = asked.n;

  const stop = await m2.command(runId, { commandId: randomUUID(), expectedRevision: before.revision, command: { kind: "stop" } });
  assert.deepEqual(stop, { ok: true, value: { status: "accepted", code: null } }, "Stop needs no CLI");
  const end = await until(async () => { const v = (await m2.get(runId)).value.view; return v.status === "stopped" ? v : null; }, "stopped");
  assert.equal(asked.n, askedByResume, "Stop did not ask for the CLIs");
  assert.equal(end.active ?? null, null);

  const again = await m2.command(runId, { commandId: randomUUID(), expectedRevision: end.revision, command: { kind: "resume" } });
  assert.notDeepEqual(again.value, { status: "accepted", code: null }, "a stopped run does not continue");

  assert.equal(code(await m2.deleteLink(link.linkId)), "ok");
  assert.equal(code(await m2.deleteAgent(lead.agentId)), "ok");
  assert.equal(code(await m2.deleteAgent(exec.agentId)), "ok");
  const c = (await m2.canvas()).value;
  assert.deepEqual([c.agents.length, c.links.length], [0, 0], "cards and link gone");
  assert.deepEqual((await m2.list()).value.map((r) => [r.view.runId, r.view.status]), [[runId, "stopped"]], "the run stays in the history");
  assert.ok((await m2.history(runId, 0, 500)).value.records.length > historyBefore, "the journal is kept and continued");
}

test("stage 4–11 run: paused, restart with a CLI of another version, Stop, the cards can be deleted", OPTS, async () => {
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
  const m1 = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, agents: async () => agents, stopGraceMs: 2000 });
  const cards = await linked(m1, src);
  const runId = randomUUID();
  assert.equal(code(await m1.startOnLink({ linkId: cards.link.linkId, requestId: runId, goal: { text: "extend sum", criteria: ["sum works"], checks: ["node-test"] } })), "ok");
  await until(async () => (await m1.get(runId)).value.view.active?.purpose === "execute", "executor at work");
  await m1.shutdown(); // the application closes during a turn: paused
  release();

  const { asked, fail } = missing("unsupported_version");
  const m2 = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, agents: fail, stopGraceMs: 2000 });
  await stopAfterRestart(m2, asked, runId, cards, "unsupported_version");
  const other = await linked(m2, src);
  assert.equal(code(await m2.startOnLink({ linkId: other.link.linkId, requestId: randomUUID(), goal: { text: "x", criteria: ["y"], checks: ["node-test"] } })),
    "unsupported_version", "a new start still refuses the version");
  await m2.shutdown();

  const m3 = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, agents: fail, stopGraceMs: 2000 });
  assert.equal((await m3.get(runId)).value.view.status, "stopped", "the stop is in the journal");
  await m3.shutdown();
});

test("native run: paused, restart without the CLIs, Stop, the cards can be deleted", OPTS, async () => {
  const root = path.join(TMP, `root-${++n}`);
  const src = path.join(TMP, `src-${n}`);
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "README.md"), "project\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(src, ...a);
  const wrapper = (name, mock) => {
    const file = path.join(TMP, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
    return file;
  };
  const script = path.join(TMP, `script-${n}`);
  fs.mkdirSync(script);
  fs.writeFileSync(path.join(script, "1.json"), JSON.stringify({ stages: [{ title: "note", task: "add note.txt" }], question: null }));
  fs.writeFileSync(path.join(script, "2.json"), JSON.stringify({ summary: "x", done: true }));
  fs.writeFileSync(path.join(script, "2.asks.json"), JSON.stringify([{ tool: "Bash", command: "sleep" }])); // waits for a person
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: state, MOCK_SCRIPT: script } };
  const file = path.join(TMP, `providers-${n}.json`);
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: wrapper("codex", "mock-codex.mjs"), version: "codex-cli 0.155.1", ...p },
    claude: { executable: wrapper("claude", "mock-claude.mjs"), version: "2.1.281 (Claude Code)", ...p },
    // A check executable must be its own real path; on Debian/Ubuntu /bin/sh is a symlink to dash.
    shell: fs.realpathSync("/bin/sh"), checkEnv: { PATH: "/usr/bin:/bin", HOME: TMP }
  }));
  const legacy = async () => { throw new Error("the restricted runtime is not used by a native goal"); };
  const m1 = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000, agents: legacy, native: testNativeRuntime(file, () => LAUNCH) });
  const cards = await linked(m1, src);
  const runId = randomUUID();
  assert.equal(code(await m1.startOnLink({ linkId: cards.link.linkId, requestId: runId, goal: { text: "x", criteria: ["y"], checks: [], commands: ["true"], workMode: "project" } })), "ok");
  await until(async () => (await m1.get(runId)).value.view.permission, "the executor waits for a person");
  await m1.shutdown();

  const { asked, fail } = missing("provider_unavailable");
  const m2 = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000, agents: legacy, native: fail });
  await stopAfterRestart(m2, asked, runId, cards, "provider_unavailable");
  assert.equal(fs.readFileSync(path.join(src, "README.md"), "utf8"), "project\n", "the project is untouched");
  await m2.shutdown();
});

// Commands that meet on a restored run while its stop without the runtime is being decided. The stop's handle reaches
// no other command, a rejected stop leaves the next command to open the run with its runtime, two stops make one owner
// of the journal, and a repeated command keeps its recorded result.
test("concurrent Stop/Resume and two Stops on a restored run: no stop-only handle for others, one journal owner", OPTS, async (t) => {
  const root = path.join(TMP, `root-${++n}`);
  const project = (i) => { // one project per run: a project folder holds one run at a time
    const src = path.join(TMP, `src-${n}-${i}`);
    fs.cpSync(path.join(HERE, "fixtures", "orchestration", "check-project"), src, { recursive: true });
    fs.rmSync(path.join(src, "tests", "broken.test.mjs"));
    fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
    for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) g(src, ...a);
    return src;
  };
  let release;
  const agents = createTestAgents({ plan: { report: plan("only stage") }, execute: { report: executed(), hold: new Promise((r) => { release = r; }) },
    review: { report: review("accept") }, final_review: { report: review("complete") } });
  const m1 = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, agents: async () => agents, stopGraceMs: 2000 });
  t.after(async () => { release(); await m1.shutdown(); }); // a failed assertion leaves nothing running
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const cards = await linked(m1, project(i));
    const runId = randomUUID();
    assert.equal(code(await m1.startOnLink({ linkId: cards.link.linkId, requestId: runId, goal: { text: `goal ${i}`, criteria: ["sum works"], checks: ["node-test"] } })), "ok");
    await until(async () => (await m1.get(runId)).value.view.active?.purpose === "execute", `executor ${i} at work`);
    runs.push(runId);
  }
  await m1.shutdown();
  release();

  const { asked, fail } = missing("unsupported_version");
  const m2 = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, agents: fail, stopGraceMs: 2000 });
  t.after(() => m2.shutdown());
  const rev = async (id) => (await m2.get(id)).value.view.revision;
  const cmd = (id, kind, expectedRevision, commandId = randomUUID()) => m2.command(id, { commandId, expectedRevision, command: { kind } });
  const tick = () => new Promise((r) => setImmediate(r));

  // 1. a stale Stop and a Resume at once: the Stop is rejected, the Resume checks the runtime (no store_failed)
  const [a] = runs;
  const r0 = await rev(a);
  const staleId = randomUUID();
  const stale = cmd(a, "stop", r0 - 1, staleId);
  await tick();
  const racing = cmd(a, "resume", r0);
  const before = asked.n;
  assert.deepEqual((await stale).value, { status: "rejected", code: "stale_revision" });
  assert.equal(code(await racing), "unsupported_version", "the Resume went the usual way");
  assert.equal(asked.n, before + 1, "the runtime was asked for the Resume, never for the Stop");
  // the repeat of the rejected Stop returns its recorded result; the run stays paused
  assert.deepEqual((await cmd(a, "stop", r0 - 1, staleId)).value, { status: "rejected", code: "stale_revision" });
  assert.equal((await m2.get(a)).value.view.status, "paused");

  // 2. a valid Stop and a Resume at once: the Stop is accepted, the Resume does not continue the run
  const r1 = await rev(a);
  const stop = cmd(a, "stop", r1);
  await tick();
  const resume = cmd(a, "resume", r1);
  assert.deepEqual((await stop).value, { status: "accepted", code: null });
  const res = await resume;
  assert.ok(res.ok && res.value.status === "rejected" && res.value.code !== "store_failed", `the Resume is rejected by the run: ${JSON.stringify(res)}`);
  await until(async () => (await m2.get(a)).value.view.status === "stopped", "a stopped");

  // 3. two Stops at once: one accepted, the other rejected by the run (never store_failed)
  const b = runs[1];
  const r2 = await rev(b);
  const [s1, s2] = await Promise.all([cmd(b, "stop", r2), cmd(b, "stop", r2)]);
  assert.deepEqual([s1.value, s2.value].map((v) => v.status).sort(), ["accepted", "rejected"], JSON.stringify([s1, s2]));
  assert.notEqual([s1.value, s2.value].find((v) => v.status === "rejected").code, "store_failed");
  await until(async () => (await m2.get(b)).value.view.status === "stopped", "b stopped");

  // 4. the same Stop sent twice at once (an IPC retry): one decision, the same result for both
  const c = runs[2];
  const r3 = await rev(c);
  const same = randomUUID();
  const [t1, t2] = await Promise.all([cmd(c, "stop", r3, same), cmd(c, "stop", r3, same)]);
  assert.deepEqual([t1.value, t2.value], [{ status: "accepted", code: null }, { status: "accepted", code: null }]);
  await until(async () => (await m2.get(c)).value.view.status === "stopped", "c stopped");
  assert.equal(asked.n, before + 1, "no Stop asked for the runtime");
  await m2.shutdown();

  // The journals: readable, intact, one continuous sequence, each stop recorded once.
  const m3 = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, agents: fail, stopGraceMs: 2000 });
  for (const id of runs) {
    const s = (await m3.get(id)).value;
    assert.equal(s.integrity, "ok", id);
    assert.equal(s.view.status, "stopped", id);
    const lines = fs.readFileSync(path.join(root, "runs", id, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.seq), lines.map((_, i) => i), "one writer: seq without gaps or repeats");
    assert.equal(lines.filter((l) => l.type === "run.status" && l.data.status === "stopped").length, 1, "stopped once");
  }
  const stops = (id) => fs.readFileSync(path.join(root, "runs", id, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((l) => l.type === "command.received" && l.data.kind === "stop").length;
  assert.equal(stops(c), 1, "the repeated Stop is one command in the journal");
  await m3.shutdown();
});
