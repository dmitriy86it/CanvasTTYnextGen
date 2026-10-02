// A0 before its external review: a link held by a newer version's run can be let go here ("Release link"), such a run is
// "read only" on its cards (never "paused"), store.deleteRun refuses it, and a newer journal that declares
// minReaderVersion this build reads is replayed by v1 rules and shown whole — still read-only. v1 journals are unchanged.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { READER_VERSION, ZERO_HASH, buildRecord, canonical, parseJournal } from "../src/main/services/orchestration/journal.ts";
import { createRunManager } from "../src/main/services/orchestration/manager.ts";
import { deleteRun, openRun, readRun } from "../src/main/services/orchestration/store.ts";
import { agentState, availableActions } from "../src/renderer/src/features/orchestration/runModel.ts";
import { roleStatus, runStatus } from "../src/renderer/src/features/orchestration/runStatus.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-a0r-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const sha = (b) => createHash("sha256").update(b).digest("hex");

// Records as a newer version writes them; `first` adds top-level fields to the first record (minReaderVersion).
function lines(runId, version, events, first = {}) {
  const out = [];
  let prev = null;
  for (const [i, [type, data, extra]] of events.entries()) {
    const body = { v: version, seq: i, ts: `2026-09-30T10:00:0${i % 10}.000Z`, runId, type, prevHash: prev ?? ZERO_HASH, data, ...(i === 0 ? first : {}), ...(extra ?? {}) };
    const hash = sha(canonical(body));
    out.push(canonical({ ...body, hash }) + "\n");
    prev = hash;
  }
  return out;
}
// A v1-shaped run (created, running, completed) with fields v1 does not know, in the data and in the envelope.
const RUN = (goal) => [
  ["run.created", { goal, planVersion: 2 }],
  ["run.status", { status: "running", reason: null, note: "v2 field" }, { origin: "v2" }],
  ["run.status", { status: "completed", reason: null }]
];
// version 3: above this build's own v1 and v2 (journal-v2-format.md), so the A0 rules apply as they did in 1.5.7
function writeRun(root, { version = 3, first = {}, events = RUN, text = "compatible goal" } = {}) {
  const runId = randomUUID();
  const dir = path.join(root, "runs", runId);
  fs.mkdirSync(path.join(dir, "texts"), { recursive: true, mode: 0o700 });
  const g = Buffer.from(JSON.stringify({ text, criteria: ["c"], checks: [], commands: ["true"] }));
  const ref = { sha256: sha(g), bytes: g.length };
  fs.writeFileSync(path.join(dir, "texts", ref.sha256), g);
  fs.writeFileSync(path.join(dir, "journal.jsonl"), lines(runId, version, events(ref), first).join(""));
  return { runId, dir, text };
}
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
const managerOf = (root, agents = null) => createRunManager({
  platform: "darwin", // the engine under test; the platform gate has its own tests
  root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000, agents: async () => agents, appVersion: () => "1.5.6-test"
});
const code = (res) => (res.ok ? "ok" : res.code);
const COMMANDS = [
  { kind: "stop" }, { kind: "resume" }, { kind: "step" }, { kind: "clarify", text: "x" },
  { kind: "recover", action: "accept" }, { kind: "raise_limit", limit: "turns", value: 99 }
];
const bounds = { position: { x: 0, y: 0 }, size: { width: 300, height: 176 } };
async function linkWith(m, root, runId, src) {
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds })).value.agentId;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds })).value.agentId;
  const link = (await m.createLink({ linkId: randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
  if (runId) {
    await m.shutdown();
    const file = path.join(root, "canvas.json");
    const cv = JSON.parse(fs.readFileSync(file, "utf8"));
    cv.links.find((l) => l.linkId === link).runIds = [runId];
    fs.writeFileSync(file, JSON.stringify(cv));
  }
  return link;
}

// ---------- 1. Release link ----------

test("release link: only a newer version's run on its own link; the link goes, the folder is free, the run's files stay", async () => {
  const root = path.join(TMP, "release");
  const src = fs.realpathSync(fs.mkdtempSync(path.join(TMP, "release-src-")));
  const newer = writeRun(root, { first: {} }); // a plain A0 journal (no minReaderVersion)
  const v1 = writeRun(root, { version: 1, events: (goal) => [["run.created", { goal }]] }); // a v1 run, preparing
  let m = managerOf(root);
  const link = await linkWith(m, root, newer.runId, src);
  m = managerOf(root);
  const v1Link = await linkWith(m, root, v1.runId, fs.realpathSync(fs.mkdtempSync(path.join(TMP, "release-src-"))));
  m = managerOf(root);
  const other = await linkWith(m, root, null, src);
  const before = footprint(newer.dir);
  const release = (input) => m.releaseNewerLink({ commandId: randomUUID(), ...input });

  // refused: a v1 run, a run that is not the link's, a link that does not exist
  assert.equal(code(await release({ linkId: v1Link, runId: v1.runId })), "run_not_newer");
  assert.equal(code(await release({ linkId: link, runId: v1.runId })), "link_run_mismatch");
  assert.equal(code(await release({ linkId: randomUUID(), runId: newer.runId })), "link_not_found");
  // before: the folder is held by the newer run
  assert.equal(code(await m.startOnLink({ linkId: other, requestId: randomUUID(), goal: { text: "g", criteria: ["c"], checks: [] } })), "folder_busy");

  const commandId = randomUUID();
  const r = await m.releaseNewerLink({ commandId, linkId: link, runId: newer.runId });
  assert.equal(code(r), "ok", JSON.stringify(r));
  assert.deepEqual([r.value.runId, r.value.linkId, r.value.folder, r.value.appVersion, r.value.commandId], [newer.runId, link, src, "1.5.6-test", commandId]);
  const again = await m.releaseNewerLink({ commandId, linkId: link, runId: newer.runId });
  assert.deepEqual(again.value, r.value, "a repeat of the commandId answers the same and changes nothing");
  assert.equal(code(await m.releaseNewerLink({ commandId, linkId: v1Link, runId: v1.runId })), "request_conflict");
  assert.equal(code(await release({ linkId: link, runId: newer.runId })), "link_not_found", "a new command for a released link");

  const saved = JSON.parse(fs.readFileSync(path.join(root, "canvas.json"), "utf8"));
  assert.equal(saved.links.some((l) => l.linkId === link), false, "the link is gone");
  assert.deepEqual(saved.releasedNewerRuns, [r.value], "the release is written down once");
  assert.ok(saved.owners[newer.runId], "the run keeps its workspace for the history");
  assert.deepEqual(footprint(newer.dir), before, "the run's files are unchanged");
  // the folder is free: a start on another link of it is no longer folder_busy (it goes on to create the run)
  assert.notEqual(code(await m.startOnLink({ linkId: other, requestId: randomUUID(), goal: { text: "g", criteria: ["c"], checks: [] } })), "folder_busy");
  // the run is still listed and read-only
  const s = (await m.get(newer.runId)).value;
  assert.equal(s.integrity, "newer_version");
  assert.ok((await m.list()).value.some((x) => x.view.runId === newer.runId));
  await m.shutdown();
  // a restart reads the release back
  m = managerOf(root);
  assert.equal(code(await m.releaseNewerLink({ commandId, linkId: link, runId: newer.runId })), "ok");
  await m.shutdown();
  assert.deepEqual(footprint(newer.dir), before);
});

// ---------- 2. Read only on the cards, never paused ----------

test("cards and widget: a newer version's run is read only, never paused, and offers no action", () => {
  const view = { runId: randomUUID(), status: "paused", reason: "newer_version", revision: 0, stage: null, turns: 0, halted: false, active: null,
    newer: { version: 2, chain: "ok", goal: "g" } };
  for (const v of [view, { ...view, status: "completed", reason: null, newer: { ...view.newer, compatible: true } }]) {
    for (const role of ["lead", "executor"]) {
      assert.equal(agentState(role, v), "read_only");
      const line = roleStatus("ru", role, { view: v, entries: [], open: false, stageTitles: null, now: Date.now() });
      assert.deepEqual([line.state, line.doing, line.wait], ["read_only", "Только просмотр", "создан более новой версией Raoden Loom"]);
    }
    assert.deepEqual(availableActions(v), []);
    const row = runStatus("en", { view: v, entries: [], open: false, stageTitles: null, now: Date.now() });
    assert.equal(row.state, "read_only");
    assert.doesNotMatch(`${row.doing} ${row.wait}`, /paus/i);
  }
});

// ---------- 3. store.deleteRun ----------

test("store.deleteRun refuses a newer version's run before the lock; a v1 run is deleted as before", async () => {
  const root = path.join(TMP, "delete");
  for (const first of [{}, { minReaderVersion: 1 }]) {
    const r = writeRun(root, { first });
    const before = footprint(r.dir);
    await assert.rejects(deleteRun(root, r.runId), (e) => e.code === "run_newer_version");
    assert.deepEqual(footprint(r.dir), before, "no lock, no rename");
  }
  const v1 = writeRun(root, { version: 1, events: (goal) => [["run.created", { goal }]] });
  await deleteRun(root, v1.runId);
  assert.equal(fs.existsSync(v1.dir), false);
});

// ---------- 4. minReaderVersion ----------

test("minReaderVersion 1: replayed by v1 rules (unknown fields ignored), shown whole, and nothing may act on it", async () => {
  assert.equal(READER_VERSION, 2);
  const root = path.join(TMP, "compat");
  const r = writeRun(root, { first: { minReaderVersion: 1 } });
  const buf = fs.readFileSync(path.join(r.dir, "journal.jsonl"));
  const p = parseJournal(buf, r.runId);
  assert.deepEqual(p.integrity, { status: "newer_version_compatible", detail: { version: 3, minReaderVersion: 1, chain: { status: "ok" }, skipped: 0 } });
  assert.equal(p.state.status, "completed");
  assert.equal(p.records.length, 3);
  const before = footprint(r.dir);
  await assert.rejects(openRun(root, r.runId, { acceptTornTail: true }), (e) => e.code === "journal_newer_version");
  assert.equal((await readRun(root, r.runId)).canContinue, false);

  const m = managerOf(root);
  const s = (await m.get(r.runId)).value;
  assert.equal(s.integrity, "newer_version_compatible");
  assert.deepEqual([s.view.status, s.view.newer.compatible, s.view.newer.goal, s.open], ["completed", true, r.text, false]);
  for (const command of COMMANDS) assert.equal(code(await m.command(r.runId, { commandId: randomUUID(), expectedRevision: s.view.revision, command })), "run_newer_version", command.kind);
  for (const res of [await m.changes(r.runId), await m.diff(r.runId, "a"), await m.create({ requestId: r.runId, source: TMP, goal: { text: r.text, criteria: ["c"], checks: [] } })]) {
    assert.equal(code(res), "run_newer_version");
  }
  assert.equal((await m.history(r.runId, 0, 10)).value.records.length, 3);
  assert.equal(m.openCount(), 0);
  await m.shutdown();
  assert.deepEqual(footprint(r.dir), before, "no lock, recovery, truncation or record");
});

test("minReaderVersion above the reader's, absent, or not an integer: the A0 view as before", () => {
  const root = path.join(TMP, "notcompat");
  for (const first of [{ minReaderVersion: 3 }, {}, { minReaderVersion: "1" }, { minReaderVersion: 1.5 }, { minReaderVersion: 0 }]) {
    const r = writeRun(root, { first });
    const p = parseJournal(fs.readFileSync(path.join(r.dir, "journal.jsonl")), r.runId);
    assert.deepEqual([p.integrity.status, p.state, p.integrity.detail.fallback], ["newer_version", null, undefined], JSON.stringify(first));
    assert.equal(p.records.length, 3);
  }
});

test("minReaderVersion 1 with a record v1 cannot apply: the A0 view, marked with where and why, never a crash", async () => {
  const root = path.join(TMP, "fallback");
  const cases = [
    ["unknown_record", (goal) => [...RUN(goal).slice(0, 2), ["acceptance.decided", { stage: 1 }]]],
    ["invalid_event", (goal) => [...RUN(goal).slice(0, 2), ["run.status", { status: "dancing", reason: null }]]],
    ["replay_conflict", (goal) => [["run.status", { status: "running", reason: null }], ...RUN(goal)]]
  ];
  for (const [why, events] of cases) {
    const r = writeRun(root, { first: { minReaderVersion: 1 }, events });
    const p = parseJournal(fs.readFileSync(path.join(r.dir, "journal.jsonl")), r.runId);
    assert.equal(p.integrity.status, "newer_version", why);
    assert.equal(p.state, null);
    assert.deepEqual(p.integrity.detail.fallback, { line: why === "replay_conflict" ? 1 : 3, code: why });
    assert.equal(p.records.length, events({}).length, "the records as they are");
    const m = managerOf(root);
    const s = (await m.get(r.runId)).value;
    assert.deepEqual([s.integrity, s.view.newer.compatible, s.view.newer.fallback?.code], ["newer_version", undefined, why]);
    await m.shutdown();
  }
});

test("v1 journals are written as before: v 1 and no minReaderVersion", () => {
  const { record, line } = buildRecord(null, randomUUID(), "2026-09-30T10:00:00.000Z", "run.created", { goal: { sha256: "a".repeat(64), bytes: 1 } });
  assert.equal(record.v, 1);
  assert.equal("minReaderVersion" in JSON.parse(line.toString()), false);
  assert.deepEqual(Object.keys(JSON.parse(line.toString())).sort(), ["data", "hash", "prevHash", "runId", "seq", "ts", "type", "v"]);
});

// ---------- after the internal review (round 1) ----------

test("review R1/R3/R4/R6a: releases survive other canvas changes, owners survive a forged start, ids are checked, two newer runs go together", async () => {
  const root = path.join(TMP, "review1");
  const src = fs.realpathSync(fs.mkdtempSync(path.join(TMP, "review1-src-")));
  const a = writeRun(root), b = writeRun(root), c = writeRun(root);
  let m = managerOf(root);
  const link = await linkWith(m, root, a.runId, src);
  m = managerOf(root);
  const twoLink = await linkWith(m, root, null, fs.realpathSync(fs.mkdtempSync(path.join(TMP, "review1-src-"))));
  await m.shutdown();
  const file = path.join(root, "canvas.json");
  const cv = JSON.parse(fs.readFileSync(file, "utf8"));
  cv.links.find((l) => l.linkId === twoLink).runIds = [b.runId, c.runId];
  cv.owners = { [a.runId]: "ws-a", [b.runId]: "common", [c.runId]: "common" };
  fs.writeFileSync(file, JSON.stringify(cv));
  const prints = () => [a, b, c].map((r) => footprint(r.dir));
  const before = prints();
  m = managerOf(root);

  // R4: ids are checked in main, not only by the IPC layer
  assert.equal(code(await m.releaseNewerLink({ commandId: "not-a-uuid", linkId: link, runId: a.runId })), "invalid_argument");
  // R3: a forged start whose request id names a newer run leaves that run's owner alone
  const spare = await linkWith(m, root, null, fs.realpathSync(fs.mkdtempSync(path.join(TMP, "review1-src-"))));
  m = managerOf(root);
  assert.equal(code(await m.startOnLink({ linkId: spare, requestId: a.runId, goal: { text: "g", criteria: ["c"], checks: [] } })), "run_newer_version");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).owners[a.runId], "ws-a");

  const r = await m.releaseNewerLink({ commandId: randomUUID(), linkId: link, runId: a.runId });
  assert.equal(code(r), "ok");
  // R6a: a link with two newer runs is let go with both, one entry each, one commandId
  const both = randomUUID();
  const r2 = await m.releaseNewerLink({ commandId: both, linkId: twoLink, runId: c.runId });
  assert.equal(code(r2), "ok", JSON.stringify(r2));
  assert.equal(r2.value.runId, c.runId);
  assert.equal((await m.releaseNewerLink({ commandId: both, linkId: twoLink, runId: b.runId })).value.runId, b.runId, "the other run's entry answers its repeat");
  // R1: an unrelated card deleted afterwards keeps the releases
  const cards = (await m.canvas()).value.agents.filter((x) => x.project !== src);
  assert.equal(code(await m.deleteAgent(cards[0].agentId)), "ok");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved.releasedNewerRuns.map((x) => x.runId).sort(), [a.runId, b.runId, c.runId].sort());
  assert.equal(saved.owners[a.runId], "ws-a");
  assert.deepEqual((await m.canvas()).value.releasedNewerRuns.length, 3, "the canvas read shows the releases");
  await m.shutdown();
  assert.deepEqual(prints(), before, "the runs' files are unchanged");
});

test("review R5: a chain failure on the first record of a compatible journal is the raw view with its chain error, not a replay conflict", () => {
  const root = path.join(TMP, "review5");
  const r = writeRun(root, { first: { minReaderVersion: 1 } });
  const jp = path.join(r.dir, "journal.jsonl");
  fs.writeFileSync(jp, fs.readFileSync(jp, "utf8").replace('"planVersion":2', '"planVersion":3'));
  const p = parseJournal(fs.readFileSync(jp), r.runId);
  assert.equal(p.integrity.status, "newer_version");
  assert.deepEqual([p.integrity.detail.chain.status, p.integrity.detail.chain.detail.line, p.integrity.detail.chain.detail.code], ["corrupt", 1, "bad_hash"]);
  assert.equal(p.integrity.detail.fallback, undefined);
});

// ---------- owner's decisions before the merge: skippable records, the version is the first record's ----------

const SKIP = (extra) => (ref) => [
  ["run.created", { goal: ref, planVersion: 2 }],
  ["run.v2.note", { text: "a v2 note" }, extra],
  ["run.status", { status: "running", reason: null }],
  ["run.v2.note", { text: "another" }, extra],
  ["run.status", { status: "completed", reason: null }]
];
const compat = (root, events) => {
  const r = writeRun(root, { first: { minReaderVersion: 1 }, events });
  return { ...r, p: parseJournal(fs.readFileSync(path.join(r.dir, "journal.jsonl")), r.runId) };
};

test("skippable: an unknown record marked skippable: true is left out of the state and counted", async () => {
  const root = path.join(TMP, "skip");
  const { runId, dir, p } = compat(root, SKIP({ skippable: true }));
  assert.equal(p.integrity.status, "newer_version_compatible");
  assert.deepEqual([p.integrity.detail.skipped, p.integrity.detail.chain.status, p.records.length, p.state.status], [2, "ok", 5, "completed"]);
  const before = footprint(dir);
  const m = managerOf(root);
  const s = (await m.get(runId)).value;
  assert.deepEqual([s.integrity, s.view.newer.compatible, s.view.newer.skipped, s.view.status], ["newer_version_compatible", true, 2, "completed"]);
  await m.shutdown();
  assert.deepEqual(footprint(dir), before);
});

test("skippable: an unknown record without the mark, or with any value but the boolean true, falls back", () => {
  const root = path.join(TMP, "skip-no");
  for (const extra of [undefined, { skippable: "true" }, { skippable: 1 }, { skippable: false }]) {
    const { p } = compat(root, SKIP(extra));
    assert.equal(p.integrity.status, "newer_version", JSON.stringify(extra));
    assert.deepEqual(p.integrity.detail.fallback, { line: 2, code: "unknown_record" }, JSON.stringify(extra));
  }
});

test("skippable: on a known record the mark is ignored and the record is applied", () => {
  const { p } = compat(path.join(TMP, "skip-known"), (ref) => [
    ["run.created", { goal: ref, planVersion: 2 }],
    ["run.status", { status: "running", reason: null }, { skippable: true }],
    ["run.status", { status: "completed", reason: null }, { skippable: true }]
  ]);
  assert.deepEqual([p.integrity.status, p.integrity.detail.skipped, p.state.status], ["newer_version_compatible", 0, "completed"]);
});

test("skippable: the chain covers skipped records; a broken hash on one is a chain error", () => {
  const root = path.join(TMP, "skip-hash");
  const r = writeRun(root, { first: { minReaderVersion: 1 }, events: SKIP({ skippable: true }) });
  const jp = path.join(r.dir, "journal.jsonl");
  fs.writeFileSync(jp, fs.readFileSync(jp, "utf8").replace('"text":"a v2 note"', '"text":"a v2 notE"'));
  const p = parseJournal(fs.readFileSync(jp), r.runId);
  assert.equal(p.integrity.status, "newer_version_compatible");
  assert.deepEqual([p.integrity.detail.chain.status, p.integrity.detail.chain.detail.line, p.integrity.detail.chain.detail.code], ["corrupt", 2, "bad_hash"]);
  assert.deepEqual([p.records.length, p.integrity.detail.skipped], [1, 0], "nothing after the break is shown or counted");
});

test("the version is the first record's: a record of another v falls back to the A0 view", () => {
  const { p } = compat(path.join(TMP, "v-change"), (ref) => [
    ["run.created", { goal: ref, planVersion: 2 }],
    ["run.status", { status: "running", reason: null }],
    ["run.status", { status: "completed", reason: null }, { v: 4 }]
  ]);
  assert.equal(p.integrity.status, "newer_version");
  assert.deepEqual(p.integrity.detail.fallback, { line: 3, code: "version_changed" });
});
