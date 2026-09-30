// Integration checks for runTurn (real supervisor.mjs + mock-codex.mjs / mock-claude.mjs). Run: node --test turn.test.mjs
// MOCK providers: a passing continuation / report test proves the harness (turn.mjs + supervisor) works with
// plausible event shapes; it says nothing about compatibility with the real codex / claude CLIs.
// Processes are accounted by proc-ledger.mjs after every turn (pids from TurnResult + the mocks' ledger file);
// `ps` by this run's marker is a secondary check only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTurn, DEFAULT_TURN_LIMITS } from "./turn.mjs";
import { ProcLedger, assertNoneAlive, describe, psByMarker } from "./proc-ledger.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MOCK = { codex: path.join(HERE, "mock-codex.mjs"), claude: path.join(HERE, "mock-claude.mjs") };
const MARK = "CTTYEXP-" + randomBytes(4).toString("hex");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `${MARK}-`));
const STATE = path.join(TMP, "state");
fs.mkdirSync(STATE);
const SCHEMA = {
  type: "object",
  properties: { status: { enum: ["done"] }, summary: { type: "string" }, sha256: { type: "string" }, memory: { type: "string" } },
  required: ["status", "summary", "sha256", "memory"],
  additionalProperties: false,
};
const SCHEMA_FILE = path.join(TMP, "schema.json");
fs.writeFileSync(SCHEMA_FILE, JSON.stringify(SCHEMA));
const TOKEN_SCHEMA = { type: "object", properties: { token: { type: "string" }, answer: { type: "string" } }, required: ["token", "answer"], additionalProperties: false };
const TOKEN_SCHEMA_FILE = path.join(TMP, "token-schema.json");
fs.writeFileSync(TOKEN_SCHEMA_FILE, JSON.stringify(TOKEN_SCHEMA));
const T = { timeout: 60_000 };

const ledgers = [];
after(async () => {
  for (const l of ledgers) {
    try { await assertNoneAlive(null, l, { ms: 500 }); } catch (e) { console.log(`# after: ${e.message}`); process.exitCode = 1; }
  }
  const g = psByMarker(MARK);
  console.log(g.available ? `# after: global check, marker pids: [${g.pids.join(" ")}]` : `# after: global check unavailable: ${g.error}`);
  fs.rmSync(TMP, { recursive: true, force: true });
});

let n = 0;
// One turn's spec. The mark rides in argv (-c for codex, --append-system-prompt for claude): both mocks ignore it.
function makeSpec(provider, mode, { task = "hello", resume = null, sessionId = randomUUID(), expect = null, limits = {}, env = {}, supervisor = {}, attemptDir, schema = SCHEMA } = {}) {
  const ledgerFile = path.join(TMP, `ledger-${++n}.jsonl`);
  const argv = provider === "codex"
    ? [process.execPath, MOCK.codex, "exec", ...(resume ? ["resume"] : []), "--json", "--skip-git-repo-check", "-c", `cttyexp="${MARK}"`,
      "--output-schema", schema === SCHEMA ? SCHEMA_FILE : TOKEN_SCHEMA_FILE, "-o", "{REPORT_FILE}", ...(resume ? [resume] : []), "-"]
    : [process.execPath, MOCK.claude, "-p", "--output-format", "stream-json", "--verbose", ...(resume ? ["--resume", resume] : ["--session-id", sessionId]),
      "--json-schema", JSON.stringify(schema), "--append-system-prompt", MARK];
  if (provider === "codex" && attemptDir === undefined) attemptDir = fs.mkdtempSync(path.join(TMP, "attempt-"));
  const spec = {
    provider, argv, cwd: TMP,
    env: { PATH: process.env.PATH, CTTYEXP: MARK, MOCK_MODE: mode, MOCK_STATE: STATE, MOCK_LEDGER: ledgerFile, ...env },
    task, schema, attemptDir, expectSessionId: expect,
    limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: 20_000, stdoutGraceMs: 500, ...limits },
    supervisor: { graceIntMs: 300, graceTermMs: 300, leftoverMs: 300, ...supervisor },
  };
  const ledger = new ProcLedger(ledgerFile);
  ledgers.push(ledger);
  return { spec, ledger };
}

// Runs one turn to the end, then: invariants every result must hold + no own process alive.
async function turn(t, provider, mode, opts = {}, during = null) {
  const { spec, ledger } = makeSpec(provider, mode, opts);
  const h = runTurn(spec);
  if (during) await during(h, ledger);
  const r = await h.result;
  ledger.track(r.pids.supervisor, "supervisor");
  ledger.track(r.pids.pgid, "group", { group: true });
  t.diagnostic(`${provider}/${mode}: outcome=${r.outcome} transport=${r.transport.status}(${r.transport.reason}) report=${r.report.status} stopCause=${r.stopCause}`);
  if (r.outcome !== "completed") assert.equal(r.nextTurnAllowed, false, "no next turn after a non-completed outcome");
  assert.equal(r.process.supervisorDone, true, "supervisor sent done");
  assert.equal(r.process.groupCleared, true, "group cleared");
  const lr = await assertNoneAlive(t, ledger, { mark: MARK });
  t.diagnostic(`processes: ${describe(lr)}`);
  return { r, spec, ledger };
}

const state = (id) => JSON.parse(fs.readFileSync(path.join(STATE, `${id}.json`), "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) assert.fail(`timeout waiting for ${what}`); await sleep(10); }
}
const mockStarted = (ledger) => ledger.read().some((e) => e.label.startsWith("mock-"));
const PROVIDERS = ["codex", "claude"];

// ---- proc-ledger itself ----

test("proc-ledger: EPERM is unverifiable (not gone), ps failures are 'unavailable', never success", async (t) => {
  const l = new ProcLedger(null);
  l.track(1, "launchd (foreign uid)");
  const r = l.check();
  assert.equal(r.alive.length + r.gone.length, 0);
  assert.equal(r.unverifiable[0]?.code, "EPERM");
  await assertNoneAlive(t, l); // unverifiable is reported via diagnostic, does not throw
  const live = new ProcLedger(null);
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1e3)", `${MARK}-alive`], { stdio: "ignore" });
  live.track(c.pid, "really-alive");
  await assert.rejects(assertNoneAlive(t, live, { ms: 200 }), /still alive/, "a live own process fails the test");
  assert.equal((await live.waitGone(1000)).alive.length, 0, "killOwn cleaned it up");
  const bin = path.join(TMP, "fakebin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ps"), "#!/bin/sh\necho 'ps: sysctl: Operation not permitted' >&2\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ps-noexec"), "#!/bin/sh\n", { mode: 0o644 });
  for (const ps of [path.join(bin, "ps"), path.join(bin, "ps-noexec"), path.join(bin, "missing")]) {
    const g = psByMarker(MARK, { ps });
    assert.equal(g.available, false, ps);
    t.diagnostic(`${path.basename(ps)}: global check unavailable: ${g.error}`);
  }
  const real = psByMarker(MARK);
  t.diagnostic(real.available ? "ps on PATH: available" : `ps on PATH: global check unavailable: ${real.error}`);
});

// ---- success ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock): structured answer -> completed, report valid, session id, next turn allowed`, T, async (t) => {
    const sessionId = randomUUID();
    const { r } = await turn(t, provider, "ok", { sessionId });
    assert.equal(r.outcome, "completed");
    assert.equal(r.transport.status, "completed");
    assert.equal(r.report.status, "valid");
    assert.equal(r.report.value.status, "done");
    assert.equal(r.nextTurnAllowed, true);
    assert.equal(r.stopCause, null);
    assert.equal(r.sessionMismatch, false);
    assert.equal(r.process.exitCode, 0);
    assert.ok(r.sessionId);
    assert.equal(state(r.sessionId).id, r.sessionId);
    if (provider === "claude") assert.equal(r.sessionId, sessionId);
    else assert.match(path.basename(r.reportFile), /^report-[0-9a-f-]{36}\.json$/);
    assert.equal(r.terminal.type, provider === "codex" ? "turn.completed" : "result");
    assert.deepEqual(r.delivery, { status: "ok", errors: [] });
    assert.equal(r.sessionEvent.type, provider === "codex" ? "thread.started" : "system");
    if (provider === "claude") assert.deepEqual([r.sessionEvent.session_id, r.sessionEvent.tools, r.sessionEvent.mcp_servers, r.sessionEvent.model], [sessionId, [], [], "mock-claude"]);
    else assert.equal(r.sessionEvent.thread_id, r.sessionId);
  });
}

// ---- task delivery ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock): task delivered byte for byte with EOF (UTF-8, CRLF, "stop", {"cmd":"stop"}, >1 MiB)`, T, async (t) => {
    const unit = 'строка 🧪\r\n\r\nstop\n{"cmd":"stop"}\n  stop  \n';
    const task = Buffer.from(unit.repeat(Math.ceil((1 << 20) / Buffer.byteLength(unit)) + 3) + "хвост без перевода");
    assert.ok(task.length > 1 << 20);
    const { r } = await turn(t, provider, "ok", { task });
    assert.equal(r.outcome, "completed");
    const got = state(r.sessionId).turns[0];
    assert.equal(got.len, task.length);
    assert.equal(got.sha256, sha(task));
    assert.equal(r.report.value.sha256, sha(task), "mock saw EOF and answered about the whole task");
    assert.ok(Buffer.from(got.base64, "base64").equals(task));
  });
}

// ---- continuation (mock: proves the harness passes the exact id, not that the real CLI resumes) ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock continuation, harness only): resume by exact id keeps context; wrong session -> failed`, T, async (t) => {
    const word = `zebra-${randomBytes(3).toString("hex")}`;
    const first = await turn(t, provider, "ok", { task: `remember WORD=${word}\n` });
    assert.equal(first.r.outcome, "completed");
    const id = first.r.sessionId;

    const second = await turn(t, provider, "ok", { task: "what was the word?", resume: id, expect: id });
    assert.equal(second.r.outcome, "completed");
    assert.equal(second.r.sessionId, id);
    assert.equal(second.r.sessionMismatch, false);
    assert.equal(second.r.report.value.memory, word, "context of the first turn reached the second");
    assert.equal(state(id).turns.length, 2);
    assert.ok(provider === "codex" ? second.spec.argv.includes("resume") : second.spec.argv.includes("--resume"));

    const wrong = await turn(t, provider, "wrong_session", { task: "again", resume: id, expect: id });
    assert.equal(wrong.r.outcome, "failed");
    assert.equal(wrong.r.sessionMismatch, true);
    assert.notEqual(wrong.r.sessionId, id);
  });
}

// ---- token answers (modes probe-series relies on) ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock): token schema -> token of the session's first task; wrong_token / no_context${provider === "claude" ? " / tools_nonempty" : ""}`, T, async (t) => {
    const token = `tok-${randomBytes(3).toString("hex")}`;
    const o = { schema: TOKEN_SCHEMA };
    const first = await turn(t, provider, "ok", { ...o, task: `Return token = "TOKEN=${token}"` });
    assert.equal(first.r.outcome, "completed");
    assert.deepEqual(first.r.report.value, { token, answer: "ok" });
    const id = first.r.sessionId;
    const answer = async (mode, task = "the token from my previous message") => (await turn(t, provider, mode, { ...o, task, resume: id, expect: id })).r.report.value;
    assert.deepEqual(await answer("ok", "TOKEN=other"), { token, answer: "resumed" }, "resume answers the first task's token");
    assert.deepEqual(await answer("no_context"), { token: "", answer: "resumed" });
    assert.notEqual((await answer("wrong_token")).token, token);
    if (provider === "claude") assert.deepEqual((await turn(t, provider, "tools_nonempty", o)).r.sessionEvent.tools, ["Bash"]);
  });
}

// ---- invalid answers ----

for (const [provider, mode, status] of [
  ["codex", "bad_schema", "schema_mismatch"], ["claude", "bad_schema", "schema_mismatch"],
  ["codex", "not_json", "invalid_json"], ["claude", "no_structured", "missing"],
  ["codex", "no_report_file", "missing"],
]) {
  test(`${provider} (mock) ${mode}: transport completed, answer ${status} -> invalid_report`, T, async (t) => {
    const { r } = await turn(t, provider, mode);
    assert.equal(r.transport.status, "completed");
    assert.equal(r.outcome, "invalid_report");
    assert.equal(r.report.status, status);
    if (status === "schema_mismatch") assert.ok(r.report.errors.length > 0);
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} (mock): answer larger than maxReportBytes -> invalid_report too_large`, T, async (t) => {
    const { r } = await turn(t, provider, "big_report", { env: { MOCK_REPORT_BYTES: String(200 << 10) }, limits: { maxReportBytes: 64 << 10 } });
    assert.equal(r.outcome, "invalid_report");
    assert.equal(r.report.status, "too_large");
  });
}

// ---- process / protocol failures ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock): failures -> failed / protocol_error (turn failure, exit 3 after success, no terminal event)`, T, async (t) => {
    const fail = await turn(t, provider, "fail");
    assert.equal(fail.r.outcome, "failed");
    assert.equal(fail.r.report.status, "not_checked");

    const exit3 = await turn(t, provider, "exit_after_success");
    assert.equal(exit3.r.outcome, "failed");
    assert.equal(exit3.r.process.exitCode, 3);
    assert.equal(exit3.r.report.status, "not_checked");

    const none = await turn(t, provider, "no_terminal");
    assert.equal(none.r.outcome, "protocol_error");
    assert.equal(none.r.terminal, null);
  });
}

// ---- Stop / timeout ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock): Stop during a running turn -> stopped/user; timeout -> timeout`, T, async (t) => {
    const stopped = await turn(t, provider, "sleep", {}, async (h, ledger) => {
      await until(() => mockStarted(ledger), 5000, "mock started");
      await sleep(100);
      h.stop();
      h.stop(); // idempotent
    });
    assert.equal(stopped.r.outcome, "stopped");
    assert.equal(stopped.r.stopCause, "user");
    assert.equal(stopped.r.process.signalsToLeader[0], "SIGINT");

    const timedOut = await turn(t, provider, "sleep", { limits: { timeoutMs: 500 } });
    assert.equal(timedOut.r.outcome, "timeout");
    assert.equal(timedOut.r.stopCause, "timeout");
  });
}

// ---- false successes (revision 5): delivery failure, timeout / Stop after a valid result ----

const resultSent = (ledger) => { try { return fs.readFileSync(ledger.file, "utf8").includes('"result_sent"'); } catch { return false; } };

for (const provider of PROVIDERS) {
  test(`${provider} (mock): 8 MiB task, CLI never reads stdin but answers -> delivery_failed (EPIPE), report kept`, T, async (t) => {
    const { r } = await turn(t, provider, "no_read_stdin", { task: Buffer.alloc(8 << 20, 0x61) });
    assert.equal(r.transport.status, "completed", "the CLI itself reported success");
    assert.equal(r.outcome, "delivery_failed");
    assert.equal(r.delivery.status, "failed");
    assert.ok(r.delivery.errors.some((e) => e.where === "supervisor" && e.code === "EPIPE"), JSON.stringify(r.delivery.errors));
    assert.equal(r.report.status, "valid", "answer still checked and kept for diagnosis");
    assert.equal(r.nextTurnAllowed, false);
    t.diagnostic(`delivery: ${JSON.stringify(r.delivery)}`);
  });

  test(`${provider} (mock): valid result, then the CLI hangs -> timeout / user Stop win over the result, report kept`, T, async (t) => {
    const timedOut = await turn(t, provider, "result_then_hang", { limits: { timeoutMs: 500 } });
    assert.deepEqual([timedOut.r.outcome, timedOut.r.stopCause, timedOut.r.transport.status], ["timeout", "timeout", "completed"]);
    assert.equal(timedOut.r.report.status, "valid");
    assert.equal(timedOut.r.nextTurnAllowed, false);

    const stopped = await turn(t, provider, "result_then_hang", {}, async (h, ledger) => {
      await until(() => resultSent(ledger), 5000, "result sent");
      await sleep(100); // main has read the result line before the Stop
      h.stop();
    });
    assert.deepEqual([stopped.r.outcome, stopped.r.stopCause, stopped.r.transport.status], ["stopped", "user", "completed"]);
    assert.equal(stopped.r.report.status, "valid");
    assert.equal(stopped.r.nextTurnAllowed, false);
  });
}

// ---- limits ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock): oversized line -> protocol_error quickly, no hang`, T, async (t) => {
    const t0 = Date.now();
    const { r } = await turn(t, provider, "oversized_line", { env: { MOCK_LINE_BYTES: String(4 << 20) }, limits: { maxMessageBytes: 64 << 10 } });
    assert.equal(r.outcome, "protocol_error");
    assert.equal(r.errors[0].code, "oversized");
    assert.ok(Date.now() - t0 < 10_000);
  });

  test(`${provider} (mock): 2000 x 64 KiB events -> completed; history bounded by bytes and count; terminal kept`, T, async (t) => {
    const limits = { maxHistoryEvents: 500, maxHistoryBytes: 1 << 20 };
    const { r } = await turn(t, provider, "many_big_events", { env: { MOCK_EVENTS: "2000", MOCK_EVENT_BYTES: String(64 << 10) }, limits });
    assert.equal(r.outcome, "completed");
    const kept = r.history.reduce((a, f) => a + f.bytes, 0);
    assert.ok(r.history.length <= limits.maxHistoryEvents);
    assert.ok(kept <= limits.maxHistoryBytes, `kept ${kept} bytes`);
    assert.ok(r.history.length < 20, "the byte limit, not the count limit, cut the history");
    assert.equal(r.counters.keptEvents, r.history.length);
    assert.ok(r.counters.droppedEvents > 0 && r.counters.droppedEventBytes > 0);
    assert.ok(r.counters.frames >= 2002);
    assert.ok(r.counters.stdoutBytes > 2000 * (60 << 10));
    assert.equal(r.terminal.type, provider === "codex" ? "turn.completed" : "result");
    assert.equal(r.terminal.index, r.counters.frames - 1);
    t.diagnostic(JSON.stringify(r.counters));
  });

  test(`${provider} (mock): stderr flood -> no hang, stderr kept within maxStderrBytes, rest counted`, T, async (t) => {
    const { r } = await turn(t, provider, "stderr_flood", { env: { MOCK_STDERR_BYTES: String(16 << 20) }, limits: { maxStderrBytes: 64 << 10 } });
    assert.equal(r.outcome, "completed");
    assert.ok(r.stderr.bytes >= 16 << 20);
    assert.ok(Buffer.byteLength(r.stderr.head) + Buffer.byteLength(r.stderr.tail) <= 64 << 10);
    assert.equal(r.stderr.droppedBytes, r.counters.stderrDroppedBytes);
    assert.ok(r.stderr.droppedBytes > 0);
  });

  test(`${provider} (mock): descendant holds stdout after the leader exits -> protocol_error stdout_held_open, group cleaned`, T, async (t) => {
    // leftoverMs > stdoutGraceMs, so it is the harness (not the supervisor's own leftover sweep) that notices.
    const { r, ledger } = await turn(t, provider, "hold_stdout", { limits: { stdoutGraceMs: 300 }, supervisor: { leftoverMs: 5000 } });
    assert.equal(r.outcome, "protocol_error");
    assert.equal(r.stopCause, "stdout_held_open");
    assert.ok(ledger.read().some((e) => e.label.endsWith("-holder")), "holder was recorded");
  });
}

// ---- losing main ----

test("codex (mock): SIGKILL of the process running runTurn -> every ledger pid is gone", T, async (t) => {
  const { spec, ledger } = makeSpec("codex", "sleep");
  const code = `const { runTurn } = await import(${JSON.stringify(pathToFileURL(path.join(HERE, "turn.mjs")).href)});
    runTurn(JSON.parse(process.env.CTTY_SPEC)); setInterval(() => {}, 1e3);`;
  const w = spawn(process.execPath, ["--input-type=module", "-e", code, MARK], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, CTTY_SPEC: JSON.stringify(spec) } });
  ledger.track(w.pid, "wrapper(main)");
  await until(() => mockStarted(ledger), 10_000, "mock started");
  await sleep(200);
  const labels = ledger.check().alive.map((e) => e.label).sort(); // "parent" = supervisor (the handle has no pids before the end)
  assert.deepEqual(labels, ["mock-codex", "parent", "wrapper(main)"]);
  w.kill("SIGKILL");
  const r = await assertNoneAlive(t, ledger, { ms: 5000, mark: MARK });
  t.diagnostic(`after SIGKILL of main: ${describe(r)}`);
});

// ---- report file of this attempt only ----

test("codex (mock): a report left by a previous attempt is never picked up", T, async (t) => {
  const attemptDir = fs.mkdtempSync(path.join(TMP, "attempt-"));
  const stale = path.join(attemptDir, `report-${randomUUID()}.json`);
  const staleBody = JSON.stringify({ status: "done", summary: "stale", sha256: "x", memory: "" });
  fs.writeFileSync(stale, staleBody);
  const { r } = await turn(t, "codex", "no_report_file", { attemptDir });
  assert.notEqual(r.outcome, "completed");
  assert.equal(r.report.status, "missing");
  assert.notEqual(r.reportFile, stale);
  assert.equal(path.dirname(r.reportFile), attemptDir);
  assert.equal(fs.readFileSync(stale, "utf8"), staleBody, "stale file untouched");
});

test("preflight: bad spec throws synchronously and starts nothing", (t) => {
  const bad = [
    ["codex without {REPORT_FILE}", (s) => { s.argv = s.argv.map((a) => (a === "{REPORT_FILE}" ? path.join(TMP, "fixed.json") : a)); }],
    ["claude with {REPORT_FILE}", (s) => { s.provider = "claude"; }],
    ["attemptDir missing", (s) => { s.attemptDir = path.join(TMP, "no-such-dir"); }],
    ["attemptDir relative", (s) => { s.attemptDir = "attempt"; }],
    ["attemptDir is a file", (s) => { s.attemptDir = SCHEMA_FILE; }],
    ["cwd relative", (s) => { s.cwd = "."; }],
    ["env SUP_*", (s) => { s.env.SUP_GRACE_INT_MS = "1"; }],
    ["limit missing", (s) => { delete s.limits.maxReportBytes; }],
    ["provider unknown", (s) => { s.provider = "gemini"; }],
  ];
  for (const [what, mutate] of bad) {
    const { spec, ledger } = makeSpec("codex", "ok");
    mutate(spec);
    assert.throws(() => runTurn(spec), /runTurn:/, what);
    assert.equal(ledger.read().length, 0, `${what}: nothing started`);
  }
  t.diagnostic("report file name is generated by runTurn (report-<uuid>.json) and checked with lstat before start; " +
    "a caller cannot pass an existing path, so a collision can only be simulated by patching randomUUID (not done)");
});
