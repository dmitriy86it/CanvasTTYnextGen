// Stage A0 (acceptance-review-spec.md §2.2, §5): a journal written by a newer version (first record v above this build's;
// 3 here since A4, whose final form of v2 is this build's own) is shown read-only — its goal and its hash-checked
// records — and never opened, repaired, recovered, stopped or written; a neighbouring v1 run goes on as before, and new
// runs are still written as v1.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { JOURNAL_VERSION, ZERO_HASH, canonical, newerVersion, parseJournal } from "../src/main/services/orchestration/journal.ts";
import { createRunManager } from "../src/main/services/orchestration/manager.ts";
import { openRun, readRun } from "../src/main/services/orchestration/store.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "orchestration");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const MAC = { skip: process.platform !== "darwin" && "checks run only in the macOS sandbox", timeout: 180_000 };

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-a0-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- artificial journals of a newer version ----------

// Records as a newer version writes them: the same envelope and hash chain, its own version and event types.
function newerLines(runId, version, events) {
  const lines = [];
  let prev = null;
  for (const [i, [type, data]] of events.entries()) {
    const body = { v: version, seq: i, ts: `2026-09-30T10:00:0${i % 10}.000Z`, runId, type, prevHash: prev ?? ZERO_HASH, data };
    const hash = sha(canonical(body));
    lines.push(canonical({ ...body, hash }) + "\n");
    prev = hash;
  }
  return lines;
}
const goalText = (text) => Buffer.from(JSON.stringify({ text, criteria: ["c"], checks: [], commands: ["true"] }));
const V2_EVENTS = (goal) => [
  ["run.created", { goal }],
  ["plan.recorded", { turnId: randomUUID(), version: 1, plan: goal, firstStage: 1, stageCount: 1, conditionsAssigned: 2 }],
  ["review.assessed", { turnId: randomUUID(), stage: 1, request: "none", report: goal, applied: goal, clarificationVersion: 0, runKey: "k" }],
  ["plan.proposed", { turnId: randomUUID(), plan: goal, firstStage: 1, stageCount: 1, conditionsAssigned: 3 }]
];
// kind: ok | broken (line 3 altered) | torn (last line cut) | mixed (line 3 another version) | no_goal (goal text removed)
function writeNewer(root, { version = 3, kind = "ok", text = "newer goal" } = {}) {
  const runId = randomUUID();
  const dir = path.join(root, "runs", runId);
  fs.mkdirSync(path.join(dir, "texts"), { recursive: true, mode: 0o700 });
  const g = goalText(text);
  const ref = { sha256: sha(g), bytes: g.length };
  if (kind !== "no_goal") fs.writeFileSync(path.join(dir, "texts", ref.sha256), g);
  let lines = newerLines(runId, version, V2_EVENTS(ref));
  if (kind === "broken") lines[2] = lines[2].replace('"request":"none"', '"request":"replan"');
  if (kind === "mixed") lines = [...lines.slice(0, 2), ...newerLines(runId, version + 1, V2_EVENTS(ref)).slice(2)];
  const buf = Buffer.from(lines.join(""));
  fs.writeFileSync(path.join(dir, "journal.jsonl"), kind === "torn" ? buf.subarray(0, buf.length - 20) : buf);
  return { runId, dir, text };
}
// Every file and directory under dir: content hash, size, mode and mtime, so any write, repair or lock shows.
function footprint(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out[path.relative(dir, p)] = e.isDirectory() ? `dir ${st.mode}` : `${sha(fs.readFileSync(p))} ${st.size} ${st.mode} ${st.mtimeMs}`;
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

// ---------- 1. the journal ----------

test("A0 journal: any version above the supported one is newer_version, chain-checked, never replayed", () => {
  const root = path.join(TMP, "j");
  for (const version of [3, 17]) {
    const r = writeNewer(root, { version });
    const p = parseJournal(fs.readFileSync(path.join(r.dir, "journal.jsonl")), r.runId);
    assert.equal(newerVersion(fs.readFileSync(path.join(r.dir, "journal.jsonl"))), version);
    assert.equal(p.state, null);
    assert.deepEqual(p.integrity, { status: "newer_version", detail: { version, chain: { status: "ok" } } });
    assert.deepEqual(p.records.map((x) => x.type), ["run.created", "plan.recorded", "review.assessed", "plan.proposed"]);
  }
  const chain = (kind) => {
    const r = writeNewer(root, { kind });
    const p = parseJournal(fs.readFileSync(path.join(r.dir, "journal.jsonl")), r.runId);
    assert.equal(p.integrity.status, "newer_version", kind);
    return { records: p.records.length, chain: p.integrity.detail.chain };
  };
  const broken = chain("broken");
  assert.equal(broken.records, 2);
  assert.deepEqual([broken.chain.status, broken.chain.detail.line, broken.chain.detail.code], ["corrupt", 3, "bad_hash"]);
  const mixed = chain("mixed");
  assert.deepEqual([mixed.records, mixed.chain.status, mixed.chain.detail.code], [2, "corrupt", "unsupported_version"]);
  const torn = chain("torn");
  assert.deepEqual([torn.records, torn.chain.status], [3, "torn_tail"]);
  // Not newer: v1, a first line that is not JSON, a version that is not an integer above 1, no complete first line.
  const id = randomUUID();
  for (const first of ['{"v":1}', "garbage", '{"v":"2"}', '{"v":1.5}', '{"v":0}']) assert.equal(newerVersion(Buffer.from(`${first}\n`)), null, first);
  assert.equal(newerVersion(Buffer.from('{"v":3}')), 3, "a first line that lost its newline still names its version");
  const [only] = newerLines(id, 3, [["run.created", { goal: { sha256: "a".repeat(64), bytes: 1 } }]]);
  const lone = parseJournal(Buffer.from(only.trimEnd()), id);
  assert.deepEqual([lone.integrity.status, lone.integrity.detail.chain.status, lone.records.length], ["newer_version", "torn_tail", 0]);
  // A first line torn inside its JSON names no version: it stays a damaged journal (accepted, nothing to read).
  const cut = parseJournal(Buffer.from(only.slice(0, 40)), id);
  assert.equal(cut.integrity.status, "corrupt");
  // A v1 journal whose later line claims another version stays corrupt, as before.
  const [v1a] = newerLines(id, JOURNAL_VERSION, [["run.created", { goal: { sha256: "a".repeat(64), bytes: 1 } }]]);
  const v1 = parseJournal(Buffer.from(v1a + newerLines(id, 2, [["run.created", { goal: { sha256: "a".repeat(64), bytes: 1 } }], ["x", {}]])[1]), id);
  assert.deepEqual([v1.integrity.status, v1.integrity.detail.code, v1.records.length], ["corrupt", "unsupported_version", 1]);
});

// ---------- 2. the store ----------

test("A0 store: openRun refuses a newer journal before the lock, also with acceptTornTail; readRun only reads", async () => {
  const root = path.join(TMP, "s");
  for (const kind of ["ok", "broken", "torn", "no_goal"]) {
    const r = writeNewer(root, { kind });
    const before = footprint(r.dir);
    for (const options of [{}, { acceptTornTail: true }]) {
      await assert.rejects(openRun(root, r.runId, options), (e) => e.code === "journal_newer_version", kind);
    }
    const read = await readRun(root, r.runId);
    assert.equal(read.state, null);
    assert.equal(read.canContinue, false);
    assert.equal(read.integrity.status, "newer_version");
    assert.deepEqual(footprint(r.dir), before, `${kind}: no lock, quarantine, truncation or record`);
  }
  // Over the size limit: only its first line is read, and it is still a newer version's run, not a damaged one.
  const big = writeNewer(root);
  const jp = path.join(big.dir, "journal.jsonl");
  fs.appendFileSync(jp, Buffer.alloc(64 * 1024 * 1024 + 1, 0x20));
  const before = footprint(big.dir);
  await assert.rejects(openRun(root, big.runId, { acceptTornTail: true }), (e) => e.code === "journal_newer_version");
  const read = await readRun(root, big.runId);
  assert.deepEqual([read.state, read.integrity.status, read.integrity.detail.chain.detail.code], [null, "newer_version", "journal_too_large"]);
  assert.deepEqual(footprint(big.dir), before);
  // The manager shows its goal and the records of its first 64 KiB, without reading the whole file.
  const m = managerOf(root, null);
  const snap = (await m.get(big.runId)).value;
  assert.deepEqual([snap.integrity, snap.view.newer.chain, snap.view.newer.goal], ["newer_version", "corrupt", big.text]);
  assert.equal((await m.history(big.runId, 0, 100)).value.records.length, 4);
  await m.shutdown();
  assert.deepEqual(footprint(big.dir), before);
  fs.rmSync(big.dir, { recursive: true });
});

// ---------- 3. the application's run manager ----------

let n = 0;
const git = (cwd, ...args) => execFileSync(GIT, args, {
  cwd, encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
}).trim();
function project() {
  fs.writeFileSync(path.join(TMP, "gitconfig"), "");
  const src = path.join(TMP, `src-${++n}`);
  fs.cpSync(path.join(FIXTURES, "check-project"), src, { recursive: true });
  fs.rmSync(path.join(src, "tests", "broken.test.mjs"));
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
  git(src, "init", "-q", "-b", "main");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "fixture");
  return { src, root: path.join(TMP, `root-${n}`) };
}
const GOOD = "export const sum = (...xs) => xs.reduce((a, b) => a + b, 0);\n// improved\n";
const agentsFor = () => createTestAgents({
  plan: { report: plan("only stage") },
  execute: { report: executed(), edit: (c) => fs.writeFileSync(c.path("src/sum.mjs"), GOOD) },
  review: { report: review("accept") }, final_review: { report: review("complete") }
});
const managerOf = (root, agents) => createRunManager({
  platform: "darwin", // the engine under test; the platform gate has its own tests
  root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, agents: async () => agents, stopGraceMs: 2000
});
async function until(fn, what, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (await fn()) return;
  throw new Error(`not reached: ${what}`);
}
const COMMANDS = [
  { kind: "stop" }, { kind: "resume" }, { kind: "step" }, { kind: "pause_after_turn", on: true }, { kind: "dismiss" },
  { kind: "clarify", text: "x" }, { kind: "answer", questionId: randomUUID(), text: "x" },
  { kind: "recover", action: "accept" }, { kind: "recover", action: "reset_to_checkpoint", confirm: true },
  { kind: "raise_limit", limit: "turns", value: 99 }
];

test("A0 manager: newer runs are listed and read-only; direct commands are refused without a write; a v1 run goes on in v1", MAC, async () => {
  const p = project();
  const agents = agentsFor();
  let m = managerOf(p.root, agents);
  const v1 = randomUUID();
  assert.ok((await m.create({ requestId: v1, source: p.src, goal: { text: "extend sum", criteria: ["sum works"], checks: ["node-test"], reviewPlan: true } })).ok);
  await until(async () => (await m.get(v1)).value?.view.status === "paused", "v1 plan review");

  const runs = {
    ok: writeNewer(p.root), broken: writeNewer(p.root, { kind: "broken" }), torn: writeNewer(p.root, { kind: "torn" }),
    no_goal: writeNewer(p.root, { kind: "no_goal" }), v9: writeNewer(p.root, { version: 9, text: "nine" })
  };
  const prints = () => Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, footprint(r.dir)]));
  const before = prints();
  const activityFile = (id) => path.join(p.root, "activity", `${id}.jsonl`);

  const check = async (mgr, round, held) => {
    const list = (await mgr.list()).value;
    assert.deepEqual(list.map((s) => s.view.runId).sort(), [v1, ...Object.values(runs).map((r) => r.runId)].sort(), round);
    for (const [kind, r] of Object.entries(runs)) {
      const s = (await mgr.get(r.runId)).value;
      assert.equal(s.integrity, "newer_version", `${round} ${kind}`);
      assert.equal(s.open, false);
      assert.deepEqual([s.view.status, s.view.reason, s.view.active, s.view.halted], ["paused", "newer_version", null, false]);
      assert.equal(s.view.newer.version, kind === "v9" ? 9 : 3);
      assert.equal(s.view.newer.chain, kind === "broken" ? "corrupt" : kind === "torn" ? "torn_tail" : "ok");
      assert.equal(s.view.newer.goal, kind === "no_goal" ? null : r.text);
      const h = (await mgr.history(r.runId, 0, 100)).value;
      assert.equal(h.records.length, kind === "broken" ? 2 : kind === "torn" ? 3 : 4, `${round} ${kind} history`);
      assert.equal(h.records[0].type, "run.created");
      const goal = h.records[0].data.goal;
      const text = await mgr.text(r.runId, goal.sha256);
      if (kind === "no_goal") assert.equal(text.code, "text_missing");
      else assert.equal(JSON.parse(text.value.text).text, r.text);
      for (const command of COMMANDS) {
        const res = await mgr.command(r.runId, { commandId: randomUUID(), expectedRevision: 0, command });
        assert.deepEqual([res.ok, res.code], [false, "run_newer_version"], `${round} ${kind} ${command.kind}`);
      }
      for (const res of [await mgr.changes(r.runId), await mgr.diff(r.runId, "src/sum.mjs")]) assert.deepEqual([res.ok, res.code], [false, "run_newer_version"]);
      const again = await mgr.create({ requestId: r.runId, source: p.src, goal: { text: r.text, criteria: ["c"], checks: ["node-test"] } });
      assert.deepEqual([again.ok, again.code], [false, "run_newer_version"], `${round} ${kind} create`);
      const w = await mgr.watch(r.runId, () => {});
      assert.equal(w.snapshot.value.integrity, "newer_version");
      w.unwatch();
      assert.ok((await mgr.activity(r.runId, 0, 10)).ok);
      assert.equal(fs.existsSync(activityFile(r.runId)), false, "no activity file is written for it");
    }
    assert.deepEqual(prints(), before, `${round}: the newer runs' files are unchanged`);
    assert.equal(mgr.openCount(), held, "no newer run is held");
  };
  await check(m, "first", 1);
  // Reopened: a new process (manager) on the same profile, the v1 run left paused by shutdown.
  await m.shutdown();
  m = managerOf(p.root, agents);
  const holdV1 = await m.get(v1);
  assert.equal(holdV1.value.integrity, "ok");
  await check(m, "reopened", 0); // the v1 run is opened by its first command

  // The v1 run next to them goes on and ends by the old rules, and its journal holds only v1 records.
  const res = await m.command(v1, { commandId: randomUUID(), expectedRevision: (await m.get(v1)).value.view.revision, command: { kind: "resume" } });
  assert.equal(res.ok && res.value.status, "accepted", JSON.stringify(res));
  await until(async () => (await m.get(v1)).value.view.status === "completed", "v1 completed", 120_000);
  const lines = fs.readFileSync(path.join(p.root, "runs", v1, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.length > 5 && lines.every((l) => l.v === 1), "a new run is written as v1");
  assert.deepEqual(prints(), before, "still unchanged after the v1 run ran");
  await m.shutdown();
});

// ---------- 4. the canvas: a newer run holds its link and folder, and says why ----------

test("A0 canvas: a link whose run a newer version wrote is kept, with link_newer_run instead of 'stop it first'", async () => {
  const root = path.join(TMP, "canvas");
  const src = fs.realpathSync(fs.mkdtempSync(path.join(TMP, "canvas-src-")));
  let m = managerOf(root, null);
  const bounds = { position: { x: 0, y: 0 }, size: { width: 300, height: 176 } };
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds })).value.agentId;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds })).value.agentId;
  const lead2 = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds })).value.agentId;
  const exec2 = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds })).value.agentId;
  const link = (await m.createLink({ linkId: randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
  const other = (await m.createLink({ linkId: randomUUID(), fromAgentId: lead2, toAgentId: exec2 })).value.linkId;
  await m.shutdown();
  const r = writeNewer(root);
  const file = path.join(root, "canvas.json");
  const cv = JSON.parse(fs.readFileSync(file, "utf8"));
  cv.links.find((l) => l.linkId === link).runIds = [r.runId];
  fs.writeFileSync(file, JSON.stringify(cv));
  const before = footprint(r.dir);
  let agentCalls = 0;
  m = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000, agents: async () => { agentCalls++; return null; } });
  const code = (res) => (res.ok ? "ok" : res.code);
  assert.equal(code(await m.deleteLink(link)), "link_newer_run");
  assert.equal(code(await m.deleteAgent(lead)), "link_newer_run");
  assert.equal(code(await m.moveAgentGroup([lead, exec], "common")), "link_newer_run");
  assert.equal(code(await m.startOnLink({ linkId: link, requestId: randomUUID(), goal: { text: "g", criteria: ["c"], checks: [] } })), "link_newer_run");
  // another link in the same folder: the folder is held by that run, named and readable (its panel explains it)
  const start = await m.startOnLink({ linkId: other, requestId: randomUUID(), goal: { text: "g", criteria: ["c"], checks: [] } });
  assert.deepEqual([start.ok, start.code], [false, "folder_busy"]);
  assert.deepEqual((await m.canvas()).value.links.find((l) => l.linkId === link).runIds, [r.runId], "the link keeps its run");
  // A start on a link of another folder whose request id names the newer run: refused before any agent, and the
  // reservation is taken back. A damaged journal with the request's id: journal_corrupt, also before any agent.
  const src2 = fs.realpathSync(fs.mkdtempSync(path.join(TMP, "canvas-src-")));
  const lead3 = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src2, bounds })).value.agentId;
  const exec3 = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src2, bounds })).value.agentId;
  const third = (await m.createLink({ linkId: randomUUID(), fromAgentId: lead3, toAgentId: exec3 })).value.linkId;
  const runIdsOf = async (id) => (await m.canvas()).value.links.find((l) => l.linkId === id).runIds;
  const stolen = await m.startOnLink({ linkId: third, requestId: r.runId, goal: { text: "g", criteria: ["c"], checks: ["node-test"] } });
  assert.deepEqual([stolen.ok, stolen.code], [false, "run_newer_version"]);
  assert.deepEqual(await runIdsOf(third), [], "the reservation is taken back");
  assert.equal((await m.canvas()).value.owners?.[r.runId] ?? null, JSON.parse(fs.readFileSync(file, "utf8")).owners?.[r.runId] ?? null);
  const damaged = randomUUID();
  fs.mkdirSync(path.join(root, "runs", damaged), { recursive: true });
  fs.writeFileSync(path.join(root, "runs", damaged, "journal.jsonl"), "garbage\n");
  const again = await m.create({ requestId: damaged, source: src2, goal: { text: "g", criteria: ["c"], checks: ["node-test"] } });
  assert.deepEqual([again.ok, again.code], [false, "journal_corrupt"]);
  assert.equal(agentCalls, 0, "no agent or CLI was asked for");
  assert.deepEqual(footprint(r.dir), before);
  await m.shutdown();
});

test("A0 workspace close: a newer version's run is not work to stop here", async () => {
  const { closeCountsRun, closeRunStatus, closeHasWork } = await import("../src/renderer/src/features/workspaces/workspaceModel.ts");
  const newer = { status: "paused", newer: { version: 2, chain: "ok", goal: null } };
  assert.equal(closeCountsRun(closeRunStatus(newer)), false);
  assert.equal(closeCountsRun(closeRunStatus({ status: "paused" })), true);
  assert.equal(closeCountsRun(closeRunStatus(undefined)), true, "an unread run still counts");
  const ask = (view) => closeHasWork({ workspaceId: "a", sessions: [], links: [{ runIds: ["r"] }], owner: () => "a", runStatus: () => closeRunStatus(view), known: () => true });
  assert.equal(ask(newer), false);
  assert.equal(ask({ status: "running" }), true);
});
