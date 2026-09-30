// How the future OrchestrationService uses the store around one provider turn (no service yet):
// command.received -> turn.intent (confirmed before any process starts) -> startProviderTurn -> turn.finished from the
// ProviderTurnResult (not transport.outcome) -> command.completed. Mock CLIs only; the store itself starts nothing.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startProviderTurn } from "../src/main/services/orchestration/providers.ts";
import { createRun, openRun, readRun, readText } from "../src/main/services/orchestration/store.ts";
import { DEFAULT_TURN_LIMITS } from "../src/main/services/orchestration/turn.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCH = Object.freeze({ command: process.execPath, args: [path.join(ROOT, "src/orchestration/supervisor.mjs")], env: {} });
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-store-provider-")));
const STATE = path.join(TMP, "mock-state");
fs.mkdirSync(STATE);
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SCHEMA = {
  type: "object",
  properties: { status: { type: "string" }, summary: { type: "string" }, sha256: { type: "string" }, memory: { type: "string" } },
  required: ["status", "summary"],
  additionalProperties: false
};
const CLAUDE = path.join(TMP, "claude-cli");
fs.writeFileSync(CLAUDE, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "tests/fixtures/orchestration/mock-claude.mjs")}" "$@"\n`, { mode: 0o755 });

function claudeTurn(mode, sessionId, task) {
  return {
    cli: { state: "available", provider: "claude", executable: CLAUDE, launcher: "native", environment: { PATH: process.env.PATH }, checked: [] },
    cliVersion: "2.1.278 (Claude Code)",
    mode: "structured-no-tools",
    cwd: TMP,
    schema: SCHEMA,
    env: { MOCK_MODE: mode, MOCK_STATE: STATE, LANG: "C" },
    task,
    session: { kind: "new", id: sessionId },
    limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: 20_000, stdoutGraceMs: 500 },
    supervisor: { graceIntMs: 300, graceTermMs: 300, leftoverMs: 300 }
  };
}

// One service step: persist intent, run the provider turn, persist its verified outcome.
async function serviceStep(writer, { mode, commandId = randomUUID(), turnId = randomUUID() }) {
  const sessionId = randomUUID();
  const task = `step ${turnId}\n`;
  const check = await writer.recordCommand(commandId, "step", { turnId });
  assert.deepEqual(check, { status: "new" });
  await writer.recordTurnIntent({ turnId, commandId, role: "executor", provider: "claude", mode: "structured-no-tools", sessionId, task });
  assert.equal(writer.state().turns[turnId].status, "in_flight", "intent is durable before the process starts");
  const started = startProviderTurn(claudeTurn(mode, sessionId, task), LAUNCH);
  assert.equal(started.ok, true, started.detail);
  const result = await started.result;
  await writer.recordTurnResult(turnId, result);
  await writer.completeCommand(commandId, { status: "accepted", code: null });
  return { result, turnId, commandId };
}

test("service scenario: verified turn and contract violation are journaled from ProviderTurnResult", async () => {
  const runId = randomUUID();
  const writer = await createRun(TMP, runId, { goal: "demo goal" });
  await writer.setRunStatus("running", null);

  const ok = await serviceStep(writer, { mode: "ok" });
  assert.equal(ok.result.outcome, "completed");
  const bad = await serviceStep(writer, { mode: "tools_plus_bash" });
  assert.equal(bad.result.transport.outcome, "completed", "transport alone would have said completed");
  assert.equal(bad.result.outcome, "contract_violation");
  await writer.close();

  const { state, integrity, canContinue } = await readRun(TMP, runId);
  assert.equal(integrity.status, "ok");
  assert.equal(canContinue, true);
  assert.equal(state.turns[ok.turnId].status, "completed");
  assert.equal(state.turns[bad.turnId].status, "contract_violation");
  assert.equal(state.commands[ok.commandId].status, "completed");

  const journal = fs.readFileSync(path.join(TMP, "runs", runId, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const finished = journal.filter((r) => r.type === "turn.finished");
  assert.deepEqual(finished.map((r) => [r.data.outcome, r.data.nextTurnAllowed, r.data.transport.outcome]),
    [["completed", true, "completed"], ["contract_violation", false, "completed"]]);
  assert.ok(finished[1].data.contract.errors.some((e) => e.includes("system/init.tools")));
  const raw = fs.readFileSync(path.join(TMP, "runs", runId, "journal.jsonl"), "utf8");
  for (const leak of ["MOCK_STATE", "PATH", "stderr", "\"history\"", "diagnostics"]) assert.equal(raw.includes(leak), false, leak);

  // The structured report is stored as a text object and verified on read.
  const report = JSON.parse(await readText(TMP, runId, finished[0].data.report.ref));
  assert.equal(report.status, "done");
});

test("service crash after the intent: recovery marks outcome_unknown and does not start the CLI again", async () => {
  const runId = randomUUID();
  const turnId = randomUUID();
  const commandId = randomUUID();
  const writer = await createRun(TMP, runId, { goal: "crash demo" });
  await writer.setRunStatus("running", null);
  await writer.recordCommand(commandId, "step", { turnId });
  await writer.recordTurnIntent({ turnId, commandId, role: "executor", provider: "claude", mode: "structured-no-tools", sessionId: randomUUID(), task: "never started\n" });
  await writer.close(); // the service "crashed" here: intent confirmed, result never written

  const before = fs.readdirSync(STATE).length;
  const reopened = await openRun(TMP, runId);
  const state = reopened.state();
  assert.equal(state.turns[turnId].status, "outcome_unknown");
  assert.equal(state.status, "paused");
  assert.equal(state.pausedReason, "outcome_unknown");
  assert.equal(state.commands[commandId].status, "unfinished");
  assert.deepEqual(await reopened.recordCommand(commandId, "step", { turnId }), { status: "duplicate_in_progress" });
  await reopened.close();
  assert.equal(fs.readdirSync(STATE).length, before, "no mock CLI session was created by recovery");
});

test("a journal without a complete run.created is corrupt, not a torn tail: nothing to truncate to", async () => {
  for (const content of ["", '{"data":{"goal":']) {
    const runId = randomUUID();
    fs.mkdirSync(path.join(TMP, "runs", runId), { recursive: true });
    fs.writeFileSync(path.join(TMP, "runs", runId, "journal.jsonl"), content);
    const read = await readRun(TMP, runId);
    assert.equal(read.integrity.status, "corrupt", JSON.stringify(content));
    assert.equal(read.canContinue, false);
    await assert.rejects(openRun(TMP, runId, { acceptTornTail: true }), (e) => e.code === "journal_corrupt");
    assert.equal(fs.readFileSync(path.join(TMP, "runs", runId, "journal.jsonl"), "utf8"), content, "file untouched");
  }
});
