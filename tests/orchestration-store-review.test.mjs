// Regressions from the external review of Р2: command deduplication must compare kind as well as payload, and a
// valid report that cannot be stored must be reported explicitly instead of disappearing behind completed/next turn.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { MAX_TEXT_BYTES, canonical } from "../src/main/services/orchestration/journal.ts";
import { createRun, openRun, readRun } from "../src/main/services/orchestration/store.ts";
import { DEFAULT_TURN_LIMITS } from "../src/main/services/orchestration/turn.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-store-review-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const journal = (runId) => fs.readFileSync(path.join(TMP, "runs", runId, "journal.jsonl"));
const records = (runId) => journal(runId).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
const code = (c) => (e) => e?.code === c;

async function newRun() {
  const runId = randomUUID();
  const w = await createRun(TMP, runId, { goal: "review regressions" });
  await w.setRunStatus("running", null);
  return { runId, w };
}

// A ProviderTurnResult as startProviderTurn returns it (only the fields the store reads are meaningful).
function providerResult({ outcome = "completed", value, reportStatus = "valid" } = {}) {
  const report = value === undefined ? { status: reportStatus } : { status: reportStatus, value };
  return {
    outcome,
    nextTurnAllowed: outcome === "completed",
    sessionId: null,
    report,
    contract: { status: outcome === "contract_violation" ? "violated" : "verified", errors: [], expected: { sessionId: null }, actual: { sessionId: null } },
    transport: { outcome: "completed", report, process: { exitCode: 0, signal: null, groupCleared: true } }
  };
}
const intent = (turnId) => ({ turnId, commandId: null, role: "executor", provider: "claude", mode: "structured-no-tools", sessionId: null, task: "t" });

// A report whose canonical JSON is exactly `bytes` long, built from a repeated character of `charBytes` UTF-8 bytes.
function reportOfBytes(bytes, char = "x") {
  const overhead = Buffer.byteLength(canonical({ summary: "" }));
  const charBytes = Buffer.byteLength(char);
  assert.equal((bytes - overhead) % charBytes, 0, "size reachable with this character");
  const value = { summary: char.repeat((bytes - overhead) / charBytes) };
  assert.equal(Buffer.byteLength(canonical(value)), bytes);
  return value;
}

test("command id reused with another kind or payload: refused while unfinished, after completion and after reopen; journal unchanged", async () => {
  const { runId, w } = await newRun();
  const id = randomUUID();
  assert.deepEqual(await w.recordCommand(id, "pause_after_turn", {}), { status: "new" });
  let before = journal(runId);
  assert.deepEqual(await w.recordCommand(id, "stop", {}), { status: "command_id_reused" }, "unfinished, other kind");
  assert.deepEqual(await w.recordCommand(id, "pause_after_turn", { on: true }), { status: "command_id_reused" }, "unfinished, other payload");
  assert.deepEqual(journal(runId), before, "a conflict writes nothing");
  assert.deepEqual(await w.recordCommand(id, "pause_after_turn", {}), { status: "duplicate_in_progress" }, "same command keeps its meaning");

  await w.completeCommand(id, { status: "accepted", code: null });
  before = journal(runId);
  assert.deepEqual(await w.recordCommand(id, "stop", {}), { status: "command_id_reused" }, "completed, other kind");
  assert.deepEqual(await w.recordCommand(id, "pause_after_turn", { on: false }), { status: "command_id_reused" }, "completed, other payload");
  assert.deepEqual(await w.recordCommand(id, "pause_after_turn", {}), { status: "duplicate_completed", result: { status: "accepted", code: null } });
  assert.deepEqual(journal(runId), before);

  const pending = randomUUID();
  assert.deepEqual(await w.recordCommand(pending, "clarify", { v: 1 }), { status: "new" });
  await w.close();

  const r = await openRun(TMP, runId); // pending becomes unfinished (run.recovered)
  assert.equal(r.state().commands[pending].status, "unfinished");
  before = journal(runId);
  assert.deepEqual(await r.recordCommand(id, "stop", {}), { status: "command_id_reused" }, "completed, after reopen");
  assert.deepEqual(await r.recordCommand(pending, "stop", { v: 1 }), { status: "command_id_reused" }, "unfinished, after reopen, other kind");
  assert.deepEqual(await r.recordCommand(pending, "clarify", { v: 2 }), { status: "command_id_reused" }, "unfinished, after reopen, other payload");
  assert.deepEqual(await r.recordCommand(pending, "clarify", { v: 1 }), { status: "duplicate_in_progress" });
  assert.deepEqual(await r.recordCommand(id, "pause_after_turn", {}), { status: "duplicate_completed", result: { status: "accepted", code: null } });
  assert.deepEqual(journal(runId), before);
  await r.close();
});

test("kind is validated before the duplicate lookup", async () => {
  const { runId, w } = await newRun();
  const id = randomUUID();
  await w.recordCommand(id, "stop", {});
  const before = journal(runId);
  for (const kind of ["", "k".repeat(65), 7, null, undefined]) {
    await assert.rejects(w.recordCommand(id, kind, {}), code("invalid_input"), JSON.stringify(kind));
  }
  await assert.rejects(w.recordCommand(randomUUID(), "", {}), code("invalid_input"), "new command with an empty kind");
  assert.deepEqual(journal(runId), before);
  await w.close();
});

test("the engine's default report limit equals the store's text limit", () => {
  assert.equal(MAX_TEXT_BYTES, 65_536);
  assert.equal(DEFAULT_TURN_LIMITS.maxReportBytes, MAX_TEXT_BYTES);
});

test("report exactly at 65 536 bytes is stored; one byte more is report_not_stored with the outcome kept and no next turn", async () => {
  const { runId, w } = await newRun();
  const atLimit = randomUUID();
  await w.recordTurnIntent(intent(atLimit));
  await w.recordTurnResult(atLimit, providerResult({ value: reportOfBytes(65_536) }));
  let fin = records(runId).at(-1);
  assert.equal(fin.data.report.storeError, null);
  assert.equal(fin.data.report.ref.bytes, 65_536);
  assert.equal(fin.data.nextTurnAllowed, true);

  const over = randomUUID();
  await w.recordTurnIntent(intent(over));
  const textsBefore = fs.readdirSync(path.join(TMP, "runs", runId, "texts")).sort();
  const err = await w.recordTurnResult(over, providerResult({ value: reportOfBytes(65_537) })).then(() => null, (e) => e);
  assert.equal(err?.code, "report_not_stored");
  assert.deepEqual(err.detail, { storeError: "too_large", outcome: "completed" });
  fin = records(runId).at(-1);
  assert.equal(fin.type, "turn.finished");
  assert.equal(fin.data.outcome, "completed", "the provider's actual outcome is kept");
  assert.equal(fin.data.nextTurnAllowed, false);
  assert.deepEqual(fin.data.report, { status: "valid", ref: null, storeError: "too_large" });
  assert.deepEqual(fs.readdirSync(path.join(TMP, "runs", runId, "texts")).sort(), textsBefore, "nothing truncated stored instead");
  assert.equal(w.state().turns[over].nextTurnAllowed, false);
  await w.close();
  const { state, integrity } = await readRun(TMP, runId);
  assert.equal(integrity.status, "ok");
  assert.deepEqual(state.turns[over].report, { status: "valid", ref: null, storeError: "too_large" });
});

test("multibyte report: the limit counts UTF-8 bytes, not characters", async () => {
  const { w } = await newRun();
  const fits = randomUUID();
  await w.recordTurnIntent(intent(fits));
  await w.recordTurnResult(fits, providerResult({ value: reportOfBytes(65_536, "й") }));
  assert.equal(w.state().turns[fits].report.ref.bytes, 65_536);

  const over = randomUUID();
  await w.recordTurnIntent(intent(over));
  const value = { summary: "й".repeat(32_768) }; // 32 768 characters, 65 550 bytes
  assert.ok(canonical(value).length < 65_536 && Buffer.byteLength(canonical(value)) > 65_536);
  await assert.rejects(w.recordTurnResult(over, providerResult({ value })), code("report_not_stored"));
  assert.equal(w.state().turns[over].report.storeError, "too_large");
  await w.close();
});

test("contract_violation with an oversized report keeps contract_violation and records the storage failure", async () => {
  const { runId, w } = await newRun();
  const turn = randomUUID();
  await w.recordTurnIntent(intent(turn));
  await assert.rejects(w.recordTurnResult(turn, providerResult({ outcome: "contract_violation", value: reportOfBytes(70_000) })), code("report_not_stored"));
  const fin = records(runId).at(-1);
  assert.equal(fin.data.outcome, "contract_violation");
  assert.equal(fin.data.nextTurnAllowed, false);
  assert.equal(fin.data.report.storeError, "too_large");
  await w.close();
});

test("text write failure: report_not_stored(write_failed), outcome kept, the writer stays usable", { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false }, async () => {
  const { runId, w } = await newRun();
  const turn = randomUUID();
  await w.recordTurnIntent(intent(turn));
  const texts = path.join(TMP, "runs", runId, "texts");
  fs.chmodSync(texts, 0o500);
  try {
    const err = await w.recordTurnResult(turn, providerResult({ value: { summary: "fresh report" } })).then(() => null, (e) => e);
    assert.equal(err?.code, "report_not_stored");
    assert.equal(err.detail.storeError, "write_failed");
  } finally {
    fs.chmodSync(texts, 0o700);
  }
  const fin = records(runId).at(-1);
  assert.deepEqual([fin.data.outcome, fin.data.nextTurnAllowed, fin.data.report.storeError], ["completed", false, "write_failed"]);
  await w.setRunStatus("paused", "user_request"); // a text failure does not poison the journal writer
  await w.close();
});

for (const failing of ["write", "sync"]) {
  test(`journal ${failing} failure while writing turn.finished: poisoned; after reopen no automatic retry`, async () => {
    const runId = randomUUID();
    let armed = false;
    const io = failing === "write"
      ? { write: async (fh, buf) => { if (armed) throw new Error("injected write failure"); return fh.write(buf, 0, buf.length); } }
      : { sync: async (fh) => { if (armed) throw new Error("injected fsync failure"); await fh.sync(); } };
    const w = await createRun(TMP, runId, { goal: `journal ${failing} failure`, io });
    await w.setRunStatus("running", null);
    const turn = randomUUID();
    await w.recordTurnIntent(intent(turn));
    armed = true;
    await assert.rejects(w.recordTurnResult(turn, providerResult({ value: { summary: "ok" } })), code("write_failed"));
    await assert.rejects(w.setRunStatus("paused", "user_request"), code("writer_poisoned"));
    await w.close();

    const r = await openRun(TMP, runId);
    const state = r.state();
    assert.equal(records(runId).filter((x) => x.type === "turn.intent").length, 1, "no new intent: no automatic retry");
    if (failing === "write") {
      // nothing reached the file: the outcome is unknown and the run waits for the user
      assert.equal(state.turns[turn].status, "outcome_unknown");
      assert.deepEqual([state.status, state.pausedReason], ["paused", "outcome_unknown"]);
    } else {
      // the full line was written before fsync failed: the record exists but was never confirmed to the caller
      assert.equal(state.turns[turn].status, "completed");
      assert.deepEqual([state.status, state.pausedReason], ["paused", "recovered"]);
    }
    await r.close();
  });
}
