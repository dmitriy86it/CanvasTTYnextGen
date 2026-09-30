// Writer lock across processes (stage-2-contract.md, "Исправления по ревью Р2"): generations locks/writer-<N>.json.
// Two forked children race for one stale generation with barriers in hooks.beforeLockClaim, so every interleaving
// here is deterministic: both contenders see the same stale generation, then the parent decides who claims first.
// Temp directories only; the only processes started are this file's own children, and only they are killed.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRun, deleteRun, openRun, readRun } from "../src/main/services/orchestration/store.ts";

const CHILD = fileURLToPath(new URL("./fixtures/orchestration/store-lock-child.mjs", import.meta.url));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "CTTYSTORELOCK-")));
const DEAD_PID = 2147483647; // above any pid the OS hands out: kill(pid, 0) -> ESRCH
const children = new Set();
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  fs.rmSync(TMP, { recursive: true, force: true });
});

let rootN = 0;
const newRoot = () => fs.mkdtempSync(path.join(TMP, `root${rootN++}-`));
const runDir = (root, runId) => path.join(root, "runs", runId);
const locksDir = (root, runId) => path.join(runDir(root, runId), "locks");
const gen = (n) => `writer-${String(n).padStart(12, "0")}.json`;
const genPath = (root, runId, n) => path.join(locksDir(root, runId), gen(n));
const genBytes = (root, runId, n) => fs.readFileSync(genPath(root, runId, n));
const genInfo = (root, runId, n) => JSON.parse(genBytes(root, runId, n).toString("utf8"));
const lockNames = (root, runId) => fs.readdirSync(locksDir(root, runId)).sort();
const gens = (count) => Array.from({ length: count }, (_, i) => gen(i + 1));
const records = (root, runId) =>
  fs.readFileSync(path.join(runDir(root, runId), "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const code = (expected) => (err) => {
  assert.equal(err?.code, expected, `expected ${expected}, got ${err?.code}: ${err?.message}`);
  return true;
};

// A forked store child; replies are queued so none is lost between requests.
async function startChild() {
  const proc = fork(CHILD, [], { execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] });
  children.add(proc);
  const queue = [];
  const waiters = [];
  proc.on("message", (m) => (waiters.length ? waiters.shift()(m) : queue.push(m)));
  const exited = new Promise((resolve) => proc.on("exit", (exitCode, signal) => resolve({ exitCode, signal })));
  const recv = () => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const timer = setTimeout(() => reject(new Error(`child ${proc.pid}: no reply in 15 s`)), 15_000);
    waiters.push((m) => { clearTimeout(timer); resolve(m); });
  });
  const expect = async (event) => {
    const m = await recv();
    assert.equal(m.event, event, `child ${proc.pid}: expected ${event}, got ${JSON.stringify(m)}`);
    return m;
  };
  const ask = (msg) => { proc.send(msg); return recv(); };
  const c = { proc, pid: proc.pid, recv, expect, ask, exited, send: (msg) => proc.send(msg) };
  await expect("spawned");
  return c;
}
const stop = async (c) => {
  if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill("SIGKILL");
  await c.exited;
};

// A closed, paused run (generation 1 released) whose newest generation 2 belongs to a dead owner.
async function staleRun() {
  const root = newRoot();
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "lock race" });
  await w.setRunStatus("paused", "user_request");
  await w.close();
  assert.deepEqual(lockNames(root, runId), gens(1));
  assert.equal(genInfo(root, runId, 1).released, true);
  const dead = { pid: DEAD_PID, token: randomUUID(), createdAt: new Date().toISOString(), released: false };
  fs.writeFileSync(genPath(root, runId, 2), JSON.stringify(dead));
  return { root, runId, dead };
}

// Integrity ok, seq without gaps, every acknowledged append at its seq.
async function assertJournal(root, runId, acked) {
  const res = await readRun(root, runId);
  assert.equal(res.integrity.status, "ok", JSON.stringify(res.integrity));
  assert.equal(res.canContinue, true);
  const recs = records(root, runId);
  recs.forEach((r, i) => assert.equal(r.seq, i));
  assert.equal(res.state.lastSeq, recs.length - 1);
  for (const { commandId, seq } of acked) {
    assert.equal(recs[seq].type, "command.received");
    assert.equal(recs[seq].data.commandId, commandId);
    assert.ok(res.state.commands[commandId], commandId);
  }
}

// Scenarios 1-4: both children reach beforeLockClaim having seen stale generation 2, then `order` decides who
// claims first. The first becomes the writer of generation 3; the second must get writer_locked while it is open.
async function staleRace(order) {
  const { root, runId, dead } = await staleRun();
  const pair = [await startChild(), await startChild()];
  try {
    for (const c of pair) {
      c.send({ op: "open", root, runId, barrier: true });
      await c.expect("at_claim");
    }
    const [winner, loser] = order.map((i) => pair[i]);

    winner.send({ op: "release" });
    const won = await winner.expect("ok");
    assert.equal(won.staleLock?.pid, DEAD_PID);
    assert.equal(won.staleLock?.token, dead.token);
    assert.deepEqual(lockNames(root, runId), gens(3));
    const winnerBytes = genBytes(root, runId, 3);
    const held = JSON.parse(winnerBytes.toString("utf8"));
    assert.equal(held.pid, winner.pid);
    assert.equal(held.released, false);
    assert.equal(typeof held.token, "string");

    loser.send({ op: "release" });
    const lost = await loser.recv();
    assert.equal(lost.event, "error", `loser became a writer: ${JSON.stringify(lost)}`);
    assert.equal(lost.code, "writer_locked", lost.message);
    // The loser neither removed nor rewrote the winner's generation and left no file of its own.
    assert.deepEqual(genBytes(root, runId, 3), winnerBytes);
    assert.deepEqual(lockNames(root, runId), gens(3));

    const appended = await winner.ask({ op: "append", count: 5 });
    assert.equal(appended.event, "ok", JSON.stringify(appended));
    await assertJournal(root, runId, appended.acked);
    assert.deepEqual(genBytes(root, runId, 3), winnerBytes);

    // Once the winner closes, generation 3 is released and the former loser takes generation 4.
    assert.equal((await winner.ask({ op: "close" })).event, "ok");
    assert.deepEqual(genInfo(root, runId, 3), { ...held, released: true });
    const reopened = await loser.ask({ op: "open", root, runId, barrier: false });
    assert.equal(reopened.event, "ok", JSON.stringify(reopened));
    assert.deepEqual(lockNames(root, runId), gens(4));
    assert.equal(genInfo(root, runId, 4).pid, loser.pid);
    assert.equal((await loser.ask({ op: "close" })).event, "ok");
    await assertJournal(root, runId, appended.acked);
  } finally {
    await Promise.all(pair.map(stop));
  }
}

test("stale generation, both contenders at the claim: first released wins, second gets writer_locked", () => staleRace([0, 1]));

test("stale generation, reverse release order: the second child wins, the first gets writer_locked", () => staleRace([1, 0]));

test("SIGKILLed writer: the next openRun takes the lock with the dead owner in staleLock; close releases, next open is N+1", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const w0 = await createRun(root, runId, { goal: "killed writer" });
  await w0.setRunStatus("paused", "user_request");
  await w0.close();

  const child = await startChild();
  const opened = await child.ask({ op: "open", root, runId, barrier: false });
  assert.equal(opened.event, "ok", JSON.stringify(opened));
  assert.deepEqual(lockNames(root, runId), gens(2));
  const owner = genInfo(root, runId, 2);
  assert.equal(owner.pid, child.pid);
  assert.equal(owner.released, false);
  const appended = await child.ask({ op: "append", count: 3 });
  assert.equal(appended.event, "ok", JSON.stringify(appended));

  // A live writer in another process holds the lock.
  await assert.rejects(openRun(root, runId), code("writer_locked"));
  assert.deepEqual(lockNames(root, runId), gens(2));

  child.proc.kill("SIGKILL");
  assert.equal((await child.exited).signal, "SIGKILL");
  assert.deepEqual(genInfo(root, runId, 2), owner, "a killed writer cannot release its generation");

  const w1 = await openRun(root, runId);
  assert.equal(w1.staleLock?.pid, child.pid);
  assert.equal(w1.staleLock?.token, owner.token);
  assert.deepEqual(lockNames(root, runId), gens(3));
  const mine = genInfo(root, runId, 3);
  assert.equal(mine.pid, process.pid);
  assert.equal(mine.released, false);
  await assertJournal(root, runId, appended.acked);
  await w1.close();
  assert.deepEqual(genInfo(root, runId, 3), { ...mine, released: true });

  const w2 = await openRun(root, runId);
  assert.equal(w2.staleLock ?? null, null, "a released generation is not a stale lock");
  assert.deepEqual(lockNames(root, runId), gens(4));
  assert.equal(genInfo(root, runId, 4).released, false);
  await w2.close();
  assert.equal(genInfo(root, runId, 4).released, true);
  await assertJournal(root, runId, appended.acked);
});

test("deleteRun while another process holds the writer: writer_locked, run and lock files untouched", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const w0 = await createRun(root, runId, { goal: "delete vs live writer" });
  await w0.setRunStatus("paused", "user_request");
  await w0.close();
  const child = await startChild();
  try {
    assert.equal((await child.ask({ op: "open", root, runId, barrier: false })).event, "ok");
    const before = genBytes(root, runId, 2);
    await assert.rejects(deleteRun(root, runId), code("writer_locked"));
    assert.ok(fs.existsSync(runDir(root, runId)));
    assert.deepEqual(lockNames(root, runId), gens(2));
    assert.deepEqual(genBytes(root, runId, 2), before);
    const appended = await child.ask({ op: "append", count: 2 });
    assert.equal(appended.event, "ok", JSON.stringify(appended));
    await assertJournal(root, runId, appended.acked);
    assert.equal((await child.ask({ op: "close" })).event, "ok");
    await deleteRun(root, runId);
    assert.deepEqual(fs.readdirSync(path.join(root, "runs")), []);
  } finally {
    await stop(child);
  }
});

// deleteRun and openRun both at the claim of one stale generation; exactly one of them may win.
async function deleteRace(first) {
  const { root, runId } = await staleRun();
  const opener = await startChild();
  const deleter = await startChild();
  try {
    opener.send({ op: "open", root, runId, barrier: true });
    await opener.expect("at_claim");
    deleter.send({ op: "delete", root, runId, barrier: true });
    await deleter.expect("at_claim");

    const [a, b] = first === "open" ? [opener, deleter] : [deleter, opener];
    a.send({ op: "release" });
    const won = await a.recv();
    assert.equal(won.event, "ok", JSON.stringify(won));
    b.send({ op: "release" });
    const lost = await b.recv();
    assert.equal(lost.event, "error", `two owners: ${JSON.stringify(lost)}`);

    if (first === "open") {
      assert.equal(lost.code, "writer_locked", lost.message);
      assert.ok(fs.existsSync(runDir(root, runId)), "run deleted under a live writer");
      assert.deepEqual(lockNames(root, runId), gens(3));
      assert.equal(genInfo(root, runId, 3).pid, opener.pid);
      const appended = await opener.ask({ op: "append", count: 3 });
      assert.equal(appended.event, "ok", JSON.stringify(appended));
      await assertJournal(root, runId, appended.acked);
      assert.equal((await opener.ask({ op: "close" })).event, "ok");
    } else {
      assert.ok(["writer_locked", "run_not_found"].includes(lost.code), `${lost.code}: ${lost.message}`);
      // The late opener did not resurrect the run directory (for example runs/<runId>/locks) or leave debris.
      assert.deepEqual(fs.readdirSync(path.join(root, "runs")), []);
      await assert.rejects(readRun(root, runId), code("run_not_found"));
    }
  } finally {
    await Promise.all([opener, deleter].map(stop));
  }
}

test("deleteRun vs openRun on one stale generation, openRun claims first: deleteRun gets writer_locked", () => deleteRace("open"));

test("deleteRun vs openRun on one stale generation, deleteRun claims first: openRun fails, run stays deleted", () => deleteRace("delete"));
