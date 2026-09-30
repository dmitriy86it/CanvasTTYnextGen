// Damage, failure and crash checks of the orchestration store (stage-2-contract.md): torn tail and its explicit
// repair, corruption in the middle of the journal, the undetectable loss of a whole valid tail, write/fsync
// failures injected through `io`, the writer lock across processes and a writer killed with SIGKILL.
// Temp directories only; the only processes started are this file's own children, and only they are killed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRun, openRun, readRun } from "../src/main/services/orchestration/store.ts";

const CHILD = fileURLToPath(new URL("./fixtures/orchestration/store-crash-child.mjs", import.meta.url));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "CTTYSTOREREC-")));
const children = new Set();
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  fs.rmSync(TMP, { recursive: true, force: true });
});

let rootN = 0;
const newRoot = () => fs.mkdtempSync(path.join(TMP, `root${rootN++}-`));
const runDir = (root, runId) => path.join(root, "runs", runId);
// The highest lock generation (locks/writer-<N>.json) and its content, or null when the run was never locked.
function topLock(root, runId) {
  const dir = path.join(root, "runs", runId, "locks");
  const gens = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^writer-\d{12}\.json$/.test(n)).sort() : [];
  return gens.length ? { name: gens.at(-1), ...JSON.parse(fs.readFileSync(path.join(dir, gens.at(-1)), "utf8")) } : null;
}
const lockHeld = (root, runId) => topLock(root, runId)?.released === false;
const journalOf = (root, runId) => path.join(runDir(root, runId), "journal.jsonl");
const rawJournal = (root, runId) => fs.readFileSync(journalOf(root, runId));
const records = (root, runId) => rawJournal(root, runId).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const code = (expected) => (err) => {
  assert.equal(err?.code, expected, `expected ${expected}, got ${err?.code}: ${err?.message}`);
  return true;
};
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// The contract's canonical JSON and record hash, independent of journal.ts, to craft well-formed damage.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}
function seal(rec) {
  const { hash: _drop, ...rest } = rec;
  return canonical({ ...rest, hash: sha256(canonical(rest)) });
}

// A healthy run of 6 records (seq 0..5), closed and paused; its three commands stay received (openRun recovers them).
async function healthyRun() {
  const root = newRoot();
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "healthy" });
  await w.recordCommand(randomUUID(), "a", { n: 1 });
  await w.setRunStatus("running", null);
  await w.recordCommand(randomUUID(), "b", { n: 2 });
  await w.recordCommand(randomUUID(), "c", { n: 3 });
  await w.setRunStatus("paused", "user_request");
  await w.close();
  const lines = rawJournal(root, runId).toString("utf8").split("\n").slice(0, -1);
  assert.equal(lines.length, 6);
  return { root, runId, lines };
}
const offsetOf = (lines, i) => lines.slice(0, i).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);

// A child store process; resolves once `ready(line)` is true for a stdout line. All seen lines are kept.
function startChild(args, ready) {
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const lines = [];
  let buf = "";
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const readyP = new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        lines.push(line);
        if (ready(line, lines)) resolve();
      }
    });
    exited.then(({ code, signal }) => reject(new Error(`child exited early (${code}/${signal}): ${stderr}`)));
  });
  return { child, lines, ready: readyP, exited };
}
async function killChild(c) {
  c.child.kill("SIGKILL");
  const { signal } = await c.exited; // after "exit" the pid is reaped: kill(pid, 0) now gives ESRCH
  assert.equal(signal, "SIGKILL");
}

test("torn tail: readRun reports it and changes nothing; openRun needs acceptTornTail, then quarantines exactly the tail", async () => {
  const { root, runId, lines } = await healthyRun();
  const tail = Buffer.from('{"data":{"commandId":"half-writ'); // a record cut mid-write
  fs.appendFileSync(journalOf(root, runId), tail);
  const bytes = rawJournal(root, runId);
  const tornAt = offsetOf(lines, 6);

  const read = await readRun(root, runId);
  assert.equal(read.integrity.status, "torn_tail");
  assert.deepEqual({ offset: read.integrity.detail.offset, bytes: read.integrity.detail.bytes }, { offset: tornAt, bytes: tail.length });
  assert.equal(read.canContinue, false);
  assert.equal(read.state.lastSeq, 5, "state from the valid records");
  assert.deepEqual(rawJournal(root, runId), bytes);

  await assert.rejects(openRun(root, runId), code("journal_torn_tail"));
  assert.deepEqual(rawJournal(root, runId), bytes, "refused open changes nothing");
  assert.equal(lockHeld(root, runId), false, "refused open releases the lock");

  const w = await openRun(root, runId, { acceptTornTail: true });
  const quarantine = path.join(runDir(root, runId), "quarantine");
  const name = `torn-${tornAt}-${sha256(tail)}.bin`;
  assert.deepEqual(fs.readdirSync(quarantine), [name]);
  assert.deepEqual(fs.readFileSync(path.join(quarantine, name)), tail);
  const recs = records(root, runId);
  assert.equal(recs.length, 8);
  assert.deepEqual(rawJournal(root, runId).subarray(0, tornAt), bytes.subarray(0, tornAt), "valid prefix kept as is");
  assert.equal(recs[6].type, "journal.tail_repaired");
  assert.deepEqual(recs[6].data, { offset: tornAt, bytes: tail.length, sha256: sha256(tail), quarantine: name });
  assert.equal(recs[6].prevHash, JSON.parse(lines[5]).hash);
  assert.equal(recs[7].type, "run.recovered", "recovery runs after the repair");

  await w.recordCommand(randomUUID(), "after", {});
  assert.equal(w.state().lastSeq, 8);
  await w.close();
  const again = await readRun(root, runId);
  assert.equal(again.integrity.status, "ok");
  assert.equal(again.canContinue, true);
  assert.equal(again.state.lastSeq, 8);
});

// Each case damages the record at index 3 (seq 3, 1-based line 4) of a healthy journal; the records before it stay valid.
const DAMAGE = [
  ["changed byte", "bad_hash", (ls) => { ls[3] = ls[3].replace(/"ts":"(\d)/, (m, d) => `"ts":"${(Number(d) + 1) % 10}`); }],
  ["deleted line", "bad_seq", (ls) => { ls.splice(3, 1); }],
  ["swapped lines", "bad_seq", (ls) => { [ls[3], ls[4]] = [ls[4], ls[3]]; }],
  ["wrong prevHash", "bad_prev_hash", (ls) => { ls[3] = seal({ ...JSON.parse(ls[3]), prevHash: "f".repeat(64) }); }],
  ["version 2", "unsupported_version", (ls) => { ls[3] = seal({ ...JSON.parse(ls[3]), v: 2 }); }],
  ["unknown type", "invalid_event", (ls) => { ls[3] = seal({ ...JSON.parse(ls[3]), type: "run.bogus" }); }],
  ["extra record field", "invalid_event", (ls) => { ls[3] = seal({ ...JSON.parse(ls[3]), extra: 1 }); }],
  ["extra data field", "invalid_event", (ls) => { const r = JSON.parse(ls[3]); ls[3] = seal({ ...r, data: { ...r.data, env: {} } }); }],
  ["other run", "wrong_run", (ls) => { ls[3] = seal({ ...JSON.parse(ls[3]), runId: randomUUID() }); }],
  ["invalid json", "invalid_json", (ls) => { ls[3] = ls[3].slice(0, 40); }],
  ["non-canonical", "non_canonical", (ls) => { ls[3] = ls[3].replace('"data":', '"data": '); }],
  ["duplicate command", "replay_conflict", (ls) => {
    const prev = JSON.parse(ls[2]);
    const dup = JSON.parse(ls[1]); // command.received of seq 1, replayed at seq 3
    ls[3] = seal({ ...dup, seq: 3, prevHash: prev.hash });
  }],
  ["status after terminal", "invalid_transition", (ls) => {
    const r2 = JSON.parse(ls[2]);
    ls[2] = seal({ ...r2, data: { status: "completed", reason: null } });
    ls[3] = seal({ ...JSON.parse(ls[3]), prevHash: JSON.parse(ls[2]).hash, type: "run.status", data: { status: "running", reason: null } });
  }]
];

for (const [name, expected, damage] of DAMAGE) {
  test(`corruption in the middle (${name}) → corrupt/${expected} at line 4, state before it, file untouched`, async () => {
    const { root, runId, lines } = await healthyRun();
    const ls = [...lines];
    damage(ls);
    fs.writeFileSync(journalOf(root, runId), ls.join("\n") + "\n");
    const bytes = rawJournal(root, runId);

    const read = await readRun(root, runId);
    assert.equal(read.integrity.status, "corrupt");
    assert.equal(read.integrity.detail.code, expected);
    assert.equal(read.integrity.detail.line, 4); // 1-based
    assert.equal(read.integrity.detail.offset, offsetOf(ls, 3));
    assert.equal(read.canContinue, false);
    assert.equal(read.state.lastSeq, 2, "state from the records before the damage");
    assert.equal(read.state.lastHash, JSON.parse(ls[2]).hash);

    await assert.rejects(openRun(root, runId), (err) => {
      assert.equal(err.code, "journal_corrupt");
      assert.equal(err.detail?.code, expected);
      return true;
    });
    await assert.rejects(openRun(root, runId, { acceptTornTail: true }), code("journal_corrupt"));
    assert.equal(lockHeld(root, runId), false);
    assert.deepEqual(rawJournal(root, runId), bytes);
  });
}

test("invalid UTF-8 inside a line → corrupt/invalid_utf8", async () => {
  const { root, runId, lines } = await healthyRun();
  const buf = Buffer.from(lines.join("\n") + "\n");
  const at = offsetOf(lines, 3) + lines[3].indexOf('"kind":"') + 8;
  buf[at] = 0xff;
  fs.writeFileSync(journalOf(root, runId), buf);
  const read = await readRun(root, runId);
  assert.equal(read.integrity.status, "corrupt");
  assert.equal(read.integrity.detail.code, "invalid_utf8");
  assert.equal(read.integrity.detail.line, 4); // 1-based
  assert.deepEqual(rawJournal(root, runId), buf);
});

test("KNOWN LIMIT: losing a whole valid tail is not detected", async () => {
  // Without an independently stored last hash the chain cannot tell a journal cut at a record boundary from a
  // complete one (stage-2-contract.md, "Граница цепочки"). This test pins that limitation: if it ever fails,
  // an external anchor was added and the test must be rewritten to expect detection.
  const { root, runId, lines } = await healthyRun();
  fs.writeFileSync(journalOf(root, runId), lines.slice(0, 3).join("\n") + "\n");
  const read = await readRun(root, runId);
  assert.equal(read.integrity.status, "ok");
  assert.equal(read.canContinue, true);
  assert.equal(read.state.lastSeq, 2);
  const w = await openRun(root, runId); // opens and even continues the shortened journal
  assert.equal(w.state().lastSeq, 3, "run.recovered appended to the shortened chain");
  await w.close();
});

// io hooks controlled per test: "ok" writes, "throw" fails before writing, "half" writes half then fails.
function faultyIo() {
  const ctl = { write: "ok", sync: "ok" };
  return {
    ctl,
    io: {
      async write(fh, buf) {
        if (ctl.write === "throw") throw Object.assign(new Error("injected write failure"), { code: "EIO" });
        if (ctl.write === "half") {
          await fh.write(buf.subarray(0, Math.floor(buf.length / 2)));
          throw Object.assign(new Error("injected short write"), { code: "EIO" });
        }
        return fh.write(buf);
      },
      async sync(fh) {
        if (ctl.sync === "throw") throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
        return fh.sync();
      }
    }
  };
}

async function poisonCase(set) {
  const root = newRoot();
  const runId = randomUUID();
  const { ctl, io } = faultyIo();
  const w = await createRun(root, runId, { goal: "poison", io });
  await w.setRunStatus("running", null);
  const before = w.state();
  set(ctl);
  const failing = randomUUID();
  const first = w.recordCommand(failing, "k", { i: 1 });
  const queued = w.recordCommand(randomUUID(), "k", { i: 2 });
  await assert.rejects(first, code("write_failed"));
  await assert.rejects(queued, code("writer_poisoned"));
  ctl.write = "ok";
  ctl.sync = "ok";
  await assert.rejects(w.setRunStatus("paused", "user_request"), code("writer_poisoned"));
  await assert.rejects(w.putText("t").then(() => w.recordTurnIntent({
    turnId: randomUUID(), commandId: null, role: "lead", provider: "claude", mode: "structured-no-tools", sessionId: null, task: "t"
  })), code("writer_poisoned"));
  assert.deepEqual(w.state(), before, "state stays at the last confirmed record");
  await w.close();
  assert.equal(lockHeld(root, runId), false);
  return { root, runId, failing };
}

test("write throws before writing: write_failed, then writer_poisoned; reopen verifies a journal without the record", async () => {
  const { root, runId, failing } = await poisonCase((c) => { c.write = "throw"; });
  const read = await readRun(root, runId);
  assert.equal(read.integrity.status, "ok");
  assert.equal(read.state.commands[failing], undefined);
  const w = await openRun(root, runId);
  assert.equal(w.state().status, "paused");
  await w.close();
});

test("line written but fsync fails: write_failed, poisoned; after reopen the record is present (unconfirmed, not lost)", async () => {
  const { root, runId, failing } = await poisonCase((c) => { c.sync = "throw"; });
  const read = await readRun(root, runId);
  assert.equal(read.integrity.status, "ok");
  assert.equal(read.state.commands[failing].status, "received");
  const w = await openRun(root, runId);
  assert.equal(w.state().commands[failing].status, "unfinished");
  await w.close();
});

test("short write: write_failed, poisoned; reopen finds a torn tail and needs acceptTornTail", async () => {
  const { root, runId, failing } = await poisonCase((c) => { c.write = "half"; });
  const read = await readRun(root, runId);
  assert.equal(read.integrity.status, "torn_tail");
  assert.equal(read.state.commands[failing], undefined);
  await assert.rejects(openRun(root, runId), code("journal_torn_tail"));
  const w = await openRun(root, runId, { acceptTornTail: true });
  assert.ok(records(root, runId).some((r) => r.type === "journal.tail_repaired"));
  await w.recordCommand(randomUUID(), "k", {});
  await w.close();
  assert.equal((await readRun(root, runId)).integrity.status, "ok");
});

test("writer lock across processes: a live writer in another process → writer_locked; after its SIGKILL the stale lock is taken", async () => {
  const root = newRoot();
  const runId = randomUUID();
  await (await createRun(root, runId, { goal: "cross-process" })).close();
  const holder = startChild(["hold", root, runId], (l) => l === "ready");
  await holder.ready;
  const lock = topLock(root, runId);
  assert.equal(lock.pid, holder.child.pid);
  assert.equal(lock.released, false);
  await assert.rejects(openRun(root, runId), code("writer_locked"));
  assert.equal((await readRun(root, runId)).integrity.status, "ok", "readers are not blocked");

  await killChild(holder);
  const w = await openRun(root, runId);
  const taken = topLock(root, runId);
  assert.equal(taken.pid, process.pid);
  assert.notEqual(taken.token, lock.token);
  assert.ok(taken.name > lock.name, "the takeover is a new generation");
  assert.equal(w.staleLock?.pid, holder.child.pid, "the dead owner's lock is kept for diagnostics");
  assert.equal(w.staleLock?.token, lock.token);
  await w.close();
  assert.equal(lockHeld(root, runId), false);
  assert.equal(topLock(root, runId).token, taken.token, "close marks its own generation released");
});

test("turn intent then SIGKILL of the writer process: in_flight on read, outcome_unknown after openRun, no retry", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const turnId = randomUUID();
  const w0 = await createRun(root, runId, { goal: "intent crash" });
  await w0.setRunStatus("running", null);
  await w0.close();
  const c = startChild(["intent", root, runId, turnId], (l) => l === "intent");
  await c.ready;
  await killChild(c);

  const bytes = rawJournal(root, runId);
  const read = await readRun(root, runId);
  assert.equal(read.state.turns[turnId].status, "in_flight");
  assert.deepEqual(rawJournal(root, runId), bytes);
  const w = await openRun(root, runId);
  assert.equal(w.state().turns[turnId].status, "outcome_unknown");
  assert.equal(w.state().status, "paused");
  assert.equal(w.state().pausedReason, "outcome_unknown");
  assert.equal(records(root, runId).filter((r) => r.type === "turn.intent").length, 1);
  await w.close();
});

test("writer process killed with SIGKILL mid-loop: every confirmed seq survives, journal ok or torn_tail", async () => {
  // A process crash only: the page cache survives SIGKILL, so this is NOT evidence of durability across power
  // loss or kernel panic (that depends on fsync semantics of the file system and disk).
  const root = newRoot();
  const runId = randomUUID();
  const c = startChild(["loop", root, runId], (_l, ls) => ls.length > 40);
  await c.ready;
  await killChild(c);
  const confirmed = c.lines.map(Number);
  assert.deepEqual(confirmed, confirmed.map((_, i) => i), "child confirmed seq 0..n in order");
  const lastConfirmed = confirmed.at(-1);

  const read = await readRun(root, runId);
  assert.ok(["ok", "torn_tail"].includes(read.integrity.status), JSON.stringify(read.integrity));
  assert.ok(read.state.lastSeq >= lastConfirmed, `confirmed ${lastConfirmed}, journal has ${read.state.lastSeq}`);
  const w = await openRun(root, runId, { acceptTornTail: read.integrity.status === "torn_tail" });
  const seqs = records(root, runId).map((r) => r.seq);
  for (const s of confirmed) assert.ok(seqs.includes(s), `confirmed seq ${s} present`);
  assert.equal(records(root, runId).at(-1).type, "run.recovered", "received-but-unfinished commands recovered");
  await w.close();
  assert.equal((await readRun(root, runId)).integrity.status, "ok");
});
