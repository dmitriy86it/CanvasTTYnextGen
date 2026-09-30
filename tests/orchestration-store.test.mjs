// Functional checks of the orchestration store (docs/agent-orchestration/implementation/stage-2-contract.md):
// round trip through the journal, canonical form and hash chain recomputed independently, append ordering,
// the in-process writer lock, commands, turns, statuses, texts and run deletion. Temp directories only.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createRun, deleteRun, openRun, readRun, readText } from "../src/main/services/orchestration/store.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "CTTYSTORE-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

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

// The contract's canonical JSON, written here independently of journal.ts.
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value));
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

const intent = (turnId, extra = {}) => ({
  turnId, commandId: null, role: "executor", provider: "codex", mode: "structured-readonly", sessionId: null, task: "task text", ...extra
});

// A ProviderTurnResult assembled by hand (providers.ts shape); `transport` is a full TurnResult with marker
// strings in every field the journal must not carry.
const SECRET = "CTTY-MARKER-DO-NOT-STORE";
function turnResult(overrides = {}) {
  const transport = {
    outcome: "completed",
    transport: { status: "completed", reason: null },
    report: { status: "valid", value: { status: "done", summary: "ok" } },
    delivery: { status: "ok", errors: [] },
    sessionId: "11111111-2222-4333-8444-555555555555",
    sessionEvent: { type: "thread.started", note: `${SECRET}-sessionEvent` },
    sessionMismatch: false,
    stopCause: null,
    nextTurnAllowed: true,
    process: { exitCode: 0, signal: null, stdoutEnded: true, signalsToLeader: [], groupCleared: true, supervisorExitCode: 0, supervisorDone: true },
    counters: { stdoutBytes: 10, frames: 1, keptEvents: 1, droppedEvents: 0, droppedEventBytes: 0, stderrBytes: 5, stderrDroppedBytes: 0, droppedDiagnostics: 0 },
    history: [{ kind: "event", type: "item.completed", value: { text: `${SECRET}-history` }, bytes: 40 }],
    terminal: { type: "turn.completed", index: 0, at: 1 },
    errors: [{ kind: "error", code: "invalid_json", bytes: 3, head: `${SECRET}-errors` }],
    stderr: { head: `${SECRET}-stderr`, tail: "", bytes: 5, droppedBytes: 0 },
    diagnostics: [{ at: 1, what: `${SECRET}-diagnostics` }],
    timeline: [{ at: 1, ev: `${SECRET}-timeline` }],
    pids: { supervisor: 1, pgid: 1 },
    reportFile: `/tmp/${SECRET}-report.json`,
    env: { CTTY_LEAK_PROBE: `${SECRET}-env` },
    argv: ["codex", `${SECRET}-argv`],
    ...overrides.transport
  };
  return {
    outcome: "completed",
    nextTurnAllowed: true,
    sessionId: transport.sessionId,
    report: transport.report,
    contract: {
      status: "verified",
      errors: [],
      expected: { sessionId: null, tools: [`${SECRET}-tool`], mcpServers: [] },
      actual: { sessionId: transport.sessionId, tools: [`${SECRET}-tool`], mcpServers: [] }
    },
    ...overrides,
    transport
  };
}

test("state survives close: readRun and openRun give the same state and lastHash, readRun changes no byte", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "reach the goal" });
  assert.equal(w.runId, runId);
  assert.equal(w.state().status, "preparing");
  assert.equal(w.state().lastSeq, 0);
  const cmd = randomUUID();
  assert.deepEqual(await w.recordCommand(cmd, "start", { a: 1 }), { status: "new" });
  await w.setRunStatus("running", null);
  const turnId = randomUUID();
  await w.recordTurnIntent(intent(turnId, { commandId: cmd }));
  await w.recordTurnResult(turnId, turnResult());
  await w.completeCommand(cmd, { status: "accepted", code: null });
  await w.setRunStatus("paused", "user_request"); // openRun then has nothing to recover
  const before = w.state();
  assert.equal(before.lastSeq, 6);
  assert.equal(before.turns[turnId].status, "completed");
  assert.equal(before.commands[cmd].status, "completed");
  assert.equal(before.pausedReason, "user_request");
  await w.close();

  const bytes = rawJournal(root, runId);
  const read = await readRun(root, runId);
  assert.equal(read.integrity.status, "ok");
  assert.equal(read.canContinue, true);
  assert.deepEqual(read.state, before);
  assert.equal(read.state.lastHash, records(root, runId).at(-1).hash);
  assert.deepEqual(rawJournal(root, runId), bytes, "readRun must not change the journal");
  assert.equal(lockHeld(root, runId), false, "close removes the lock");
  assert.equal(fs.existsSync(path.join(runDir(root, runId), "state.json")), false, "no state cache on disk");

  const w2 = await openRun(root, runId);
  assert.deepEqual(w2.state(), before);
  await w2.close();
  assert.deepEqual(rawJournal(root, runId), bytes, "a paused run without unfinished work is opened without writes");
  assert.deepEqual(Buffer.from(await readText(root, runId, before.goal)).toString("utf8"), "reach the goal");
});

test("every journal line is the canonical form of its record and the hash chain recomputes independently", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "ключи и юникод \u{1F600} \"quotes\"" });
  await w.recordCommand(randomUUID(), "kind", { z: 1, a: [true, null, "é"], m: { b: 2, a: 1 } });
  await w.setRunStatus("running", null);
  await w.close();

  const lines = rawJournal(root, runId).toString("utf8").split("\n");
  assert.equal(lines.pop(), "", "the journal ends with a newline");
  let prev = "0".repeat(64);
  lines.forEach((line, seq) => {
    const rec = JSON.parse(line);
    assert.deepEqual(Object.keys(rec), ["data", "hash", "prevHash", "runId", "seq", "ts", "type", "v"]);
    assert.equal(line, canonical(rec), `line ${seq} is canonical`);
    const { hash, ...rest } = rec;
    assert.equal(hash, sha256(canonical(rest)), `hash of line ${seq}`);
    assert.equal(rec.prevHash, prev);
    assert.equal(rec.seq, seq);
    assert.equal(rec.runId, runId);
    assert.equal(rec.v, 1);
    assert.ok(!Number.isNaN(Date.parse(rec.ts)), "ts is ISO-8601");
    prev = hash;
  });
  assert.equal((await readRun(root, runId)).state.lastHash, prev);

  // Same record, keys in another order: equal JSON value, same hash, but not the canonical bytes.
  const rec = JSON.parse(lines[1]);
  const reordered = JSON.stringify({ v: rec.v, type: rec.type, ts: rec.ts, seq: rec.seq, runId: rec.runId, prevHash: rec.prevHash, hash: rec.hash, data: rec.data });
  const text = [lines[0], reordered, ...lines.slice(2)].join("\n") + "\n";
  fs.writeFileSync(journalOf(root, runId), text);
  const bad = await readRun(root, runId);
  assert.equal(bad.integrity.status, "corrupt");
  assert.equal(bad.integrity.detail.code, "non_canonical");
  assert.equal(bad.integrity.detail.offset, Buffer.byteLength(lines[0]) + 1);
  assert.equal(bad.canContinue, false);
  assert.equal(bad.state.lastSeq, 0);
});

test("parallel appends are serialized: seq without gaps, chain intact, each command recorded once", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "parallel" });
  const ids = Array.from({ length: 60 }, () => randomUUID());
  const checks = await Promise.all(ids.map((id, i) => w.recordCommand(id, "p", { i })));
  assert.ok(checks.every((c) => c.status === "new"));
  assert.equal(w.state().lastSeq, 60);
  await w.close();
  const recs = records(root, runId);
  assert.deepEqual(recs.map((r) => r.seq), Array.from({ length: 61 }, (_, i) => i));
  recs.slice(1).forEach((r, i) => assert.equal(r.prevHash, recs[i].hash));
  assert.deepEqual(new Set(recs.slice(1).map((r) => r.data.commandId)), new Set(ids));
  assert.equal((await readRun(root, runId)).integrity.status, "ok");
});

test("one writer per run inside a process; closed writer refuses calls; bad run ids and duplicates are refused", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "lock" });
  await assert.rejects(openRun(root, runId), code("writer_locked"));
  await assert.rejects(createRun(root, runId, { goal: "again" }), code("run_exists"));
  const read = await readRun(root, runId); // readers take no lock
  assert.equal(read.integrity.status, "ok");
  await w.close();
  await assert.rejects(w.setRunStatus("running", null), code("writer_closed"));
  await assert.rejects(w.recordCommand(randomUUID(), "k", {}), code("writer_closed"));
  const w2 = await openRun(root, runId); // the lock was released by close
  await w2.close();

  for (const bad of ["../escape", "", "not-a-uuid", runId.toUpperCase(), `${runId}/..`]) {
    await assert.rejects(createRun(root, bad, { goal: "x" }), code("invalid_run_id"), bad);
    await assert.rejects(readRun(root, bad), code("invalid_run_id"), bad);
    await assert.rejects(openRun(root, bad), code("invalid_run_id"), bad);
    await assert.rejects(deleteRun(root, bad), code("invalid_run_id"), bad);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, "runs")), [runId]);
  await assert.rejects(readRun(root, randomUUID()), code("run_not_found"));
  await assert.rejects(openRun(root, randomUUID()), code("run_not_found"));
});

test("commands: new, duplicate_completed with the stored result, command_id_reused writes nothing, unfinished after restart", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "commands" });
  const done = randomUUID();
  assert.deepEqual(await w.recordCommand(done, "stop", { force: true, n: 1 }), { status: "new" });
  assert.equal(w.state().commands[done].status, "received");
  assert.deepEqual(await w.recordCommand(done, "stop", { n: 1, force: true }), { status: "duplicate_in_progress" }, "key order of payload is irrelevant");
  await w.completeCommand(done, { status: "rejected", code: "not_allowed" });
  assert.equal(w.state().commands[done].status, "completed");
  let size = rawJournal(root, runId).length;
  assert.deepEqual(await w.recordCommand(done, "stop", { force: true, n: 1 }), { status: "duplicate_completed", result: { status: "rejected", code: "not_allowed" } });
  assert.deepEqual(await w.recordCommand(done, "stop", { force: false, n: 1 }), { status: "command_id_reused" });
  assert.equal(rawJournal(root, runId).length, size, "duplicates and reuse append nothing");
  await assert.rejects(w.completeCommand(done, { status: "accepted", code: null }));
  await assert.rejects(w.completeCommand(randomUUID(), { status: "accepted", code: null }));
  assert.equal(rawJournal(root, runId).length, size);

  const pending = randomUUID();
  await w.recordCommand(pending, "clarify", { text: "why" });
  await w.close();

  const w2 = await openRun(root, runId);
  assert.equal(w2.state().commands[pending].status, "unfinished");
  assert.equal(w2.state().commands[done].status, "completed");
  const rec = records(root, runId).at(-1);
  assert.equal(rec.type, "run.recovered");
  assert.deepEqual(rec.data, { unfinishedTurns: [], unfinishedCommands: [pending], previousStatus: "preparing" });
  assert.equal(w2.state().status, "paused");
  assert.equal(w2.state().pausedReason, "recovered");
  size = rawJournal(root, runId).length;
  assert.deepEqual(await w2.recordCommand(pending, "clarify", { text: "why" }), { status: "duplicate_in_progress" });
  assert.deepEqual(await w2.recordCommand(pending, "clarify", { text: "other" }), { status: "command_id_reused" });
  assert.deepEqual(await w2.recordCommand(done, "stop", { force: true, n: 1 }), { status: "duplicate_completed", result: { status: "rejected", code: "not_allowed" } });
  assert.equal(rawJournal(root, runId).length, size);
  await w2.close();
});

test("unfinished turn: readRun shows in_flight and writes nothing; openRun records run.recovered, outcome_unknown, no new intent", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const turnId = randomUUID();
  const w = await createRun(root, runId, { goal: "turn" });
  await w.setRunStatus("running", null);
  await w.recordTurnIntent(intent(turnId));
  assert.equal(w.state().turns[turnId].status, "in_flight");
  await w.close(); // "crash": no turn result was recorded

  const bytes = rawJournal(root, runId);
  const read = await readRun(root, runId);
  assert.equal(read.integrity.status, "ok");
  assert.equal(read.state.turns[turnId].status, "in_flight");
  assert.equal(read.state.status, "running");
  assert.deepEqual(rawJournal(root, runId), bytes);

  const w2 = await openRun(root, runId);
  const recs = records(root, runId);
  assert.equal(recs.length, 4);
  assert.deepEqual(recs[3].data, { unfinishedTurns: [turnId], unfinishedCommands: [], previousStatus: "running" });
  assert.equal(recs.filter((r) => r.type === "turn.intent").length, 1, "the store never retries a turn");
  assert.equal(w2.state().turns[turnId].status, "outcome_unknown");
  assert.equal(w2.state().status, "paused");
  assert.equal(w2.state().pausedReason, "outcome_unknown");
  await w2.close();

  const after = rawJournal(root, runId);
  const w3 = await openRun(root, runId); // recovered once: paused, nothing in flight
  assert.equal(w3.state().status, "paused");
  await w3.close();
  assert.deepEqual(rawJournal(root, runId), after, "a second open does not recover again");
});

test("terminal status survives restart untouched; non-terminal without unfinished work becomes paused(recovered)", async () => {
  const root = newRoot();
  for (const status of ["completed", "failed", "stopped"]) {
    const runId = randomUUID();
    const w = await createRun(root, runId, { goal: status });
    await w.setRunStatus("running", null);
    await w.setRunStatus(status, null);
    await w.close();
    const bytes = rawJournal(root, runId);
    const w2 = await openRun(root, runId);
    assert.equal(w2.state().status, status);
    assert.equal(w2.state().pausedReason, null);
    await w2.close();
    assert.deepEqual(rawJournal(root, runId), bytes, `${status}: nothing is written on open`);
  }
  for (const status of ["preparing", "running", "pausing", "stopping"]) {
    const runId = randomUUID();
    const w = await createRun(root, runId, { goal: status });
    if (status !== "preparing") await w.setRunStatus(status, null);
    await w.close();
    const w2 = await openRun(root, runId);
    assert.equal(w2.state().status, "paused", status);
    assert.equal(w2.state().pausedReason, "recovered", status);
    assert.deepEqual(records(root, runId).at(-1).data, { unfinishedTurns: [], unfinishedCommands: [], previousStatus: status });
    await w2.close();
  }
});

test("run.status data rules: reason only for paused; no transition out of a terminal status", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "status" });
  const size = rawJournal(root, runId).length;
  await assert.rejects(w.setRunStatus("paused", null));
  await assert.rejects(w.setRunStatus("running", "user_request"));
  await assert.rejects(w.setRunStatus("sleeping", null));
  assert.equal(rawJournal(root, runId).length, size);
  await w.setRunStatus("completed", null);
  await assert.rejects(w.setRunStatus("running", null));
  assert.equal(w.state().status, "completed");
  await w.close();
  assert.equal((await readRun(root, runId)).integrity.status, "ok");
});

test("recordTurnResult: contract_violation is the outcome, raw TurnResult is refused, nothing of env/stderr/history reaches the journal", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "results" });

  const violated = randomUUID();
  await w.recordTurnIntent(intent(violated));
  const vr = turnResult({
    outcome: "contract_violation",
    nextTurnAllowed: false,
    contract: {
      status: "violated",
      errors: Array.from({ length: 20 }, (_, i) => `err${i}:` + "e".repeat(300)),
      expected: { sessionId: null, tools: ["StructuredOutput"], mcpServers: [] },
      actual: { sessionId: null, tools: [`${SECRET}-tool`, "Bash"], mcpServers: [`${SECRET}-mcp`] }
    }
  });
  assert.equal(vr.transport.outcome, "completed");
  await w.recordTurnResult(violated, vr);
  assert.equal(w.state().turns[violated].status, "contract_violation");
  let fin = records(root, runId).at(-1);
  assert.equal(fin.type, "turn.finished");
  assert.equal(fin.data.outcome, "contract_violation");
  assert.equal(fin.data.nextTurnAllowed, false);
  assert.equal(fin.data.transport.outcome, "completed");
  assert.equal(fin.data.contract.status, "violated");
  assert.ok(fin.data.contract.errors.length <= 16 && fin.data.contract.errors.every((e) => e.length <= 256), "contract errors bounded");

  const raw = randomUUID();
  await w.recordTurnIntent(intent(raw));
  const size = rawJournal(root, runId).length;
  await assert.rejects(w.recordTurnResult(raw, turnResult().transport), code("invalid_input"));
  assert.equal(rawJournal(root, runId).length, size);
  assert.equal(w.state().turns[raw].status, "in_flight");

  await w.recordTurnResult(raw, turnResult()); // a completed, verified result
  fin = records(root, runId).at(-1);
  assert.deepEqual(Object.keys(fin.data).sort(), ["contract", "nextTurnAllowed", "outcome", "report", "sessionId", "transport", "turnId"]);
  assert.deepEqual(Object.keys(fin.data.transport).sort(), ["exitCode", "groupCleared", "outcome", "signal"]);
  assert.equal(fin.data.nextTurnAllowed, true);
  assert.equal(fin.data.report.status, "valid");
  assert.deepEqual(JSON.parse(Buffer.from(await readText(root, runId, fin.data.report.ref)).toString("utf8")), { status: "done", summary: "ok" });
  assert.equal(Buffer.from(await readText(root, runId, fin.data.report.ref)).toString("utf8"), canonical({ status: "done", summary: "ok" }));

  const big = randomUUID();
  await w.recordTurnIntent(intent(big));
  // A valid report over the storage limit is not dropped silently: the provider's outcome is kept, the next turn is
  // forbidden, the call rejects with report_not_stored (the report limits are covered in detail in store-report tests).
  const bigReport = { status: "valid", value: { summary: "x".repeat(70_000) } };
  await assert.rejects(w.recordTurnResult(big, turnResult({ report: bigReport, transport: { report: bigReport } })), code("report_not_stored"));
  fin = records(root, runId).at(-1);
  assert.deepEqual(fin.data.report, { status: "valid", ref: null, storeError: "too_large" });
  assert.equal(fin.data.outcome, "completed");
  assert.equal(fin.data.nextTurnAllowed, false);

  await assert.rejects(w.recordTurnResult(randomUUID(), turnResult()), "result without intent");
  await assert.rejects(w.recordTurnResult(big, turnResult()), "second result for one turn");
  await w.close();

  const journalText = rawJournal(root, runId).toString("utf8");
  assert.equal(journalText.includes(SECRET), false, "no env, argv, stderr, history, diagnostics or tool names in the journal");
  assert.equal(journalText.includes("CTTY_LEAK_PROBE"), false);
  assert.equal((await readRun(root, runId)).integrity.status, "ok");
});

test("texts: putText/readText round trip, missing, changed, symlinked and oversized texts", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "texts" });
  const content = "секрет может быть в тексте\n";
  const ref = await w.putText(content);
  assert.deepEqual(ref, { sha256: sha256(content), bytes: Buffer.byteLength(content) });
  assert.deepEqual(await w.putText(Buffer.from(content)), ref, "same content, same object");
  assert.equal(Buffer.from(await readText(root, runId, ref)).toString("utf8"), content);
  const max = await w.putText(Buffer.alloc(65_536, 0x61));
  assert.equal(max.bytes, 65_536);
  await assert.rejects(w.putText(Buffer.alloc(65_537, 0x61)), code("text_too_large"));
  const empty = await w.putText("");
  assert.equal(Buffer.from(await readText(root, runId, empty)).length, 0);
  await w.close();

  const file = path.join(runDir(root, runId), "texts", ref.sha256);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.from(original).fill(0x7a, 0, 1)); // same size, other bytes
  await assert.rejects(readText(root, runId, ref), code("text_corrupt"));
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from("!")]));
  await assert.rejects(readText(root, runId, ref), code("text_corrupt"));
  fs.rmSync(file);
  await assert.rejects(readText(root, runId, ref), code("text_missing"));
  const elsewhere = path.join(root, "outside.txt");
  fs.writeFileSync(elsewhere, original);
  fs.symlinkSync(elsewhere, file);
  await assert.rejects(readText(root, runId, ref), (err) => ["text_missing", "text_corrupt"].includes(err.code), "symlinks are not followed");
  await assert.rejects(readText(root, runId, { sha256: "0".repeat(64), bytes: 1 }), code("text_missing"));
});

test("text references reach the journal only after the text file exists", async () => {
  const root = newRoot();
  const runId = randomUUID();
  const texts = path.join(runDir(root, runId), "texts");
  const seen = [];
  // The io hook runs exactly when a journal line is written: every TextRef in it must already be on disk.
  const io = {
    async write(fh, buf) {
      const rec = JSON.parse(Buffer.from(buf).toString("utf8"));
      const refs = [rec.data.goal, rec.data.task, rec.data.report?.ref].filter(Boolean);
      for (const r of refs) {
        seen.push(r.sha256);
        assert.equal(fs.readFileSync(path.join(texts, r.sha256)).length, r.bytes, `${rec.type}: text is stored before its ref`);
      }
      return fh.write(buf);
    }
  };
  const w = await createRun(root, runId, { goal: "goal first", io });
  const turnId = randomUUID();
  await w.recordTurnIntent(intent(turnId, { task: "task first" }));
  await w.recordTurnResult(turnId, turnResult());
  assert.equal(seen.length, 3);

  // A text that cannot be stored leaves no reference: the intent is refused before its line is written.
  const size = rawJournal(root, runId).length;
  fs.chmodSync(texts, 0o500);
  try {
    await assert.rejects(w.recordTurnIntent(intent(randomUUID(), { task: "cannot be stored" })));
  } finally {
    fs.chmodSync(texts, 0o700);
  }
  assert.equal(rawJournal(root, runId).length, size);
  assert.equal(records(root, runId).filter((r) => r.type === "turn.intent").length, 1);
  await w.close();
});

test("deleteRun removes one run, leaves the neighbour byte for byte, refuses while a writer holds the lock", async () => {
  const root = newRoot();
  const keep = randomUUID();
  const gone = randomUUID();
  const wk = await createRun(root, keep, { goal: "keep" });
  await wk.recordCommand(randomUUID(), "k", {});
  await wk.setRunStatus("paused", "user_request");
  await wk.close();
  const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).sort()
    .map((p) => [p, fs.statSync(path.join(dir, p)).isFile() ? sha256(fs.readFileSync(path.join(dir, p))) : "dir"]));
  const keepBefore = snapshot(runDir(root, keep));

  const wg = await createRun(root, gone, { goal: "gone" });
  await wg.putText("some text");
  await assert.rejects(deleteRun(root, gone), code("writer_locked"));
  assert.ok(fs.existsSync(journalOf(root, gone)));
  await wg.close();
  await deleteRun(root, gone);
  assert.deepEqual(fs.readdirSync(path.join(root, "runs")), [keep], "no .deleting-* leftovers");
  await assert.rejects(readRun(root, gone), code("run_not_found"));
  await assert.rejects(deleteRun(root, gone), code("run_not_found"));

  assert.deepEqual(snapshot(runDir(root, keep)), keepBefore);
  const read = await readRun(root, keep);
  assert.equal(read.integrity.status, "ok");
  assert.equal(read.state.status, "paused");
});
