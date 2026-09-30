// Integration checks for startTurn: the real src/orchestration/supervisor.mjs + mock CLIs
// (tests/fixtures/orchestration/mock-*.mjs) or tiny inline CLIs (`node -e`).
// MOCK providers: a passing continuation / report test proves the harness works with plausible event shapes;
// it says nothing about compatibility with the real codex / claude CLIs.
// Processes are accounted by proc-ledger.mjs after every turn (pids from TurnResult + the mocks' ledger file):
// kill(pid, 0) -> ESRCH gone, success alive (failure), EPERM unverifiable (reported, never counted as clean).
// `ps` by this run's marker is a secondary check only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto, { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_TURN_LIMITS, decideOutcome, startTurn } from "../src/main/services/orchestration/turn.ts";
import { ProcLedger, assertNoneAlive, describe, psByMarker } from "./fixtures/orchestration/proc-ledger.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TURN_MODULE = path.join(ROOT, "src/main/services/orchestration/turn.ts");
const LAUNCH = Object.freeze({ command: process.execPath, args: [path.join(ROOT, "src/orchestration/supervisor.mjs")], env: {} });
const FIXTURES = path.join(ROOT, "tests/fixtures/orchestration");
const MOCK = { codex: path.join(FIXTURES, "mock-codex.mjs"), claude: path.join(FIXTURES, "mock-claude.mjs") };
const MARK = "CTTYEXP-" + randomBytes(4).toString("hex");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${MARK}-`)));
const STATE = path.join(TMP, "state");
fs.mkdirSync(STATE);
const SCHEMA = {
  type: "object",
  properties: { status: { enum: ["done"] }, summary: { type: "string" }, sha256: { type: "string" }, memory: { type: "string" } },
  required: ["status", "summary", "sha256", "memory"],
  additionalProperties: false
};
const SCHEMA_FILE = path.join(TMP, "schema.json");
fs.writeFileSync(SCHEMA_FILE, JSON.stringify(SCHEMA));
const T = { timeout: 60_000 };
const PROVIDERS = ["codex", "claude"];

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
const newLedger = (file = null) => {
  const l = new ProcLedger(file);
  ledgers.push(l);
  return l;
};

// A mock turn. The mark rides in argv (-c for codex, --append-system-prompt for claude): both mocks ignore it.
function mockSpec(provider, mode, { task = "hello", resume = null, sessionId = randomUUID(), expect = null, limits = {}, env = {}, supervisor = {}, attemptDir } = {}) {
  const ledgerFile = path.join(TMP, `ledger-${++n}.jsonl`);
  const argv = provider === "codex"
    ? [process.execPath, MOCK.codex, "exec", ...(resume ? ["resume"] : []), "--json", "--skip-git-repo-check", "-c", `cttyexp="${MARK}"`,
      "--output-schema", SCHEMA_FILE, "-o", "{REPORT_FILE}", ...(resume ? [resume] : []), "-"]
    : [process.execPath, MOCK.claude, "-p", "--output-format", "stream-json", "--verbose", ...(resume ? ["--resume", resume] : ["--session-id", sessionId]),
      "--json-schema", JSON.stringify(SCHEMA), "--append-system-prompt", MARK];
  if (provider === "codex" && attemptDir === undefined) attemptDir = fs.mkdtempSync(path.join(TMP, "attempt-"));
  const spec = {
    provider, argv, cwd: TMP,
    env: { PATH: process.env.PATH, CTTYEXP: MARK, MOCK_MODE: mode, MOCK_STATE: STATE, MOCK_LEDGER: ledgerFile, ...env },
    task, schema: SCHEMA, attemptDir, expectSessionId: expect,
    limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: 20_000, stdoutGraceMs: 500, ...limits },
    supervisor: { graceIntMs: 300, graceTermMs: 300, leftoverMs: 300, ...supervisor }
  };
  return { spec, ledger: newLedger(ledgerFile) };
}

// An inline CLI: `out(obj)` writes a JSONL line, `file` is the codex report path (argv after the marker).
const INLINE_SCHEMA = { type: "object", properties: { summary: { type: "string", minLength: 1 } }, required: ["summary"], additionalProperties: false };
const cli = (body) => `const fs=require("fs");const file=process.argv[2];const out=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");${body}`;
const CODEX_OK = `out({type:"thread.started",thread_id:"T1"});fs.writeFileSync(file,JSON.stringify({summary:"ok"}));out({type:"turn.completed"});`;
const HOLD = "setInterval(()=>{},1e3);";
function inlineSpec(body, over = {}) {
  const provider = over.provider ?? "codex";
  return {
    spec: {
      provider,
      argv: [process.execPath, "-e", cli(body), MARK, ...(provider === "codex" ? ["{REPORT_FILE}"] : [])],
      cwd: TMP, env: { CTTYEXP: MARK }, task: "", schema: INLINE_SCHEMA, attemptDir: TMP, expectSessionId: null,
      supervisor: { graceIntMs: 300, graceTermMs: 300, leftoverMs: 300 },
      ...over,
      limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: 15_000, stdoutGraceMs: 1000, ...over.limits }
    },
    ledger: newLedger()
  };
}

// Runs one turn to the end, then: invariants every result must hold + no own process alive.
async function run(t, { spec, ledger }, during = null) {
  const h = startTurn(spec, LAUNCH);
  if (during) await during(h, ledger);
  let timer;
  const r = await Promise.race([h.result, new Promise((res) => { timer = setTimeout(res, 40_000, null); })]);
  clearTimeout(timer);
  assert.ok(r, "startTurn did not resolve in 40s");
  ledger.track(r.pids.supervisor, "supervisor");
  ledger.track(r.pids.pgid, "group", { group: true });
  t.diagnostic(`${spec.provider}/${spec.env.MOCK_MODE ?? "inline"}: outcome=${r.outcome} transport=${r.transport.status}(${r.transport.reason}) report=${r.report.status} stopCause=${r.stopCause}`);
  assert.ok(r.pids.supervisor > 0);
  assert.equal(r.nextTurnAllowed, r.outcome === "completed");
  assert.equal(r.process.supervisorDone, true, "supervisor sent done");
  assert.equal(r.process.groupCleared, true, "group cleared");
  assert.ok(r.timeline.every((x, i) => i === 0 || x.at >= r.timeline[i - 1].at), "timeline is monotonic");
  const lr = await assertNoneAlive(t, ledger, { mark: MARK });
  t.diagnostic(`processes: ${describe(lr)}`);
  return r;
}
const turn = (t, provider, mode, opts = {}, during = null) => run(t, mockSpec(provider, mode, opts), during);

const state = (id) => JSON.parse(fs.readFileSync(path.join(STATE, `${id}.json`), "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) assert.fail(`timeout waiting for ${what}`); await sleep(10); }
}
const mockStarted = (ledger) => ledger.read().some((e) => e.label.startsWith("mock-"));
const resultSent = (ledger) => { try { return fs.readFileSync(ledger.file, "utf8").includes('"result_sent"'); } catch { return false; } };

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
  for (const ps of [path.join(bin, "ps"), path.join(bin, "missing")]) {
    const g = psByMarker(MARK, { ps });
    assert.equal(g.available, false, ps);
    t.diagnostic(`${path.basename(ps)}: global check unavailable: ${g.error}`);
  }
});

// ---- success, delivery ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock): >1 MiB task delivered byte for byte -> completed, report valid, session, next turn allowed`, T, async (t) => {
    const unit = 'строка 🧪\r\n\r\nstop\n{"cmd":"stop"}\n  stop  \n';
    const task = Buffer.from(unit.repeat(Math.ceil((1 << 20) / Buffer.byteLength(unit)) + 3) + "хвост без перевода");
    const sessionId = randomUUID();
    const r = await turn(t, provider, "ok", { task, sessionId });
    assert.equal(r.outcome, "completed", JSON.stringify(r.diagnostics));
    assert.equal(r.transport.status, "completed");
    assert.deepEqual([r.report.status, r.report.value.sha256], ["valid", sha(task)], "mock saw EOF and answered about the whole task");
    assert.deepEqual(r.delivery, { status: "ok", errors: [] });
    assert.deepEqual([r.nextTurnAllowed, r.stopCause, r.sessionMismatch, r.process.exitCode], [true, null, false, 0]);
    const got = state(r.sessionId).turns[0];
    assert.ok(Buffer.from(got.base64, "base64").equals(task));
    assert.equal(r.terminal.type, provider === "codex" ? "turn.completed" : "result");
    if (provider === "claude") {
      assert.equal(r.sessionId, sessionId);
      assert.deepEqual([r.sessionEvent.type, r.sessionEvent.session_id, r.sessionEvent.mcp_servers], ["system", sessionId, []]);
      assert.equal(r.reportFile, null);
    } else {
      assert.deepEqual([r.sessionEvent.type, r.sessionEvent.thread_id], ["thread.started", r.sessionId]);
      assert.match(path.basename(r.reportFile), /^report-[0-9a-f-]{36}\.json$/);
    }
  });
}

// ---- continuation (mock: proves the harness passes the exact id, not that the real CLI resumes) ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock continuation, harness only): resume by exact id keeps context; wrong session -> failed`, T, async (t) => {
    const word = `zebra-${randomBytes(3).toString("hex")}`;
    const first = await turn(t, provider, "ok", { task: `remember WORD=${word}\n` });
    assert.equal(first.outcome, "completed");
    const id = first.sessionId;

    const second = await turn(t, provider, "ok", { task: "what was the word?", resume: id, expect: id });
    assert.deepEqual([second.outcome, second.sessionId, second.sessionMismatch], ["completed", id, false]);
    assert.equal(second.report.value.memory, word, "context of the first turn reached the second");
    assert.equal(state(id).turns.length, 2);

    const wrong = await turn(t, provider, "wrong_session", { task: "again", resume: id, expect: id });
    assert.deepEqual([wrong.outcome, wrong.sessionMismatch, wrong.nextTurnAllowed], ["failed", true, false]);
    assert.notEqual(wrong.sessionId, id);
  });
}

// ---- invalid answers ----

for (const [provider, mode, status] of [
  ["codex", "bad_schema", "schema_mismatch"], ["claude", "bad_schema", "schema_mismatch"],
  ["codex", "not_json", "invalid_json"], ["claude", "no_structured", "missing"],
  ["codex", "no_report_file", "missing"]
]) {
  test(`${provider} (mock) ${mode}: transport completed, answer ${status} -> invalid_report`, T, async (t) => {
    const r = await turn(t, provider, mode);
    assert.deepEqual([r.transport.status, r.outcome, r.report.status], ["completed", "invalid_report", status]);
    if (status === "schema_mismatch") assert.ok(r.report.errors.length > 0);
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} (mock): answer larger than maxReportBytes -> invalid_report too_large`, T, async (t) => {
    const r = await turn(t, provider, "big_report", { env: { MOCK_REPORT_BYTES: String(200 << 10) }, limits: { maxReportBytes: 64 << 10 } });
    assert.deepEqual([r.outcome, r.report.status], ["invalid_report", "too_large"]);
  });
}

test("claude: structured_output is the report; result text is not; schema mismatch", async (t) => {
  const body = (so) => `out({type:"system",subtype:"init",session_id:"S1"});out({type:"result",subtype:"success",is_error:false,result:"text",session_id:"S1"${so}});`;
  const ok = await run(t, inlineSpec(body(`,structured_output:{summary:"x"}`), { provider: "claude" }));
  assert.deepEqual([ok.outcome, ok.sessionId, ok.report.value], ["completed", "S1", { summary: "x" }]);
  const bad = await run(t, inlineSpec(body(`,structured_output:{summary:""}`), { provider: "claude" }));
  assert.deepEqual([bad.outcome, bad.report.status], ["invalid_report", "schema_mismatch"]);
  const conflict = await run(t, inlineSpec(`out({type:"system",subtype:"init",session_id:"S1"});out({type:"result",subtype:"success",is_error:false,session_id:"S2",structured_output:{summary:"x"}});`, { provider: "claude" }));
  assert.deepEqual([conflict.outcome, conflict.sessionMismatch], ["failed", true], "result.session_id differs from init");
});

test("codex report: too large (not read), symlink / not a regular file -> missing; not checked when transport failed", async (t) => {
  const big = await run(t, inlineSpec(`fs.writeFileSync(file,JSON.stringify({summary:"z".repeat(1<<20)}));out({type:"turn.completed"});`, { limits: { maxReportBytes: 4096 } }));
  assert.equal(big.report.status, "too_large");
  const target = path.join(TMP, "symlink-target.json");
  fs.writeFileSync(target, JSON.stringify({ summary: "planted" }));
  const link = await run(t, inlineSpec(`fs.symlinkSync(${JSON.stringify(target)},file);out({type:"turn.completed"});`));
  assert.deepEqual([link.outcome, link.report.status], ["invalid_report", "missing"]);
  assert.match(link.report.errors[0], /ELOOP|EMLINK|not a regular file/);
  const dir = await run(t, inlineSpec(`fs.mkdirSync(file);out({type:"turn.completed"});`));
  assert.equal(dir.report.status, "missing");
  const failed = await run(t, inlineSpec(`fs.writeFileSync(file,JSON.stringify({summary:"ok"}));out({type:"turn.failed"});process.exitCode=1;`));
  assert.deepEqual([failed.outcome, failed.report.status], ["failed", "not_checked"]);
});

test("codex (mock): a report left by a previous attempt is never picked up", T, async (t) => {
  const attemptDir = fs.mkdtempSync(path.join(TMP, "attempt-"));
  const stale = path.join(attemptDir, `report-${randomUUID()}.json`);
  const staleBody = JSON.stringify({ status: "done", summary: "stale", sha256: "x", memory: "" });
  fs.writeFileSync(stale, staleBody);
  const r = await turn(t, "codex", "no_report_file", { attemptDir });
  assert.deepEqual([r.outcome, r.report.status], ["invalid_report", "missing"]);
  assert.notEqual(r.reportFile, stale);
  assert.equal(path.dirname(r.reportFile), attemptDir);
  assert.equal(fs.readFileSync(stale, "utf8"), staleBody, "stale file untouched");
});

// ---- process / protocol failures ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock): turn failure -> failed; exit 3 after success -> failed; no terminal event -> protocol_error`, T, async (t) => {
    const fail = await turn(t, provider, "fail");
    assert.deepEqual([fail.outcome, fail.report.status], ["failed", "not_checked"]);
    const exit3 = await turn(t, provider, "exit_after_success");
    assert.deepEqual([exit3.outcome, exit3.process.exitCode, exit3.report.status], ["failed", 3, "not_checked"]);
    const none = await turn(t, provider, "no_terminal");
    assert.deepEqual([none.outcome, none.terminal], ["protocol_error", null]);
  });
}

test("CLI that cannot be spawned (ENOENT, done.error) -> failed, not delivery_failed", async (t) => {
  const { spec, ledger } = inlineSpec("");
  const r = await run(t, { spec: { ...spec, argv: [path.join(TMP, "no-such-cli"), "{REPORT_FILE}"] }, ledger });
  assert.deepEqual([r.outcome, r.transport.reason, r.nextTurnAllowed], ["failed", "supervisor spawn ENOENT", false]);
  assert.equal(r.process.supervisorExitCode, 1);
});

// ---- Stop / timeout ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock): Stop during a running turn -> stopped/user; timeout -> timeout`, T, async (t) => {
    const stopped = await turn(t, provider, "sleep", {}, async (h, ledger) => {
      await until(() => mockStarted(ledger), 5000, "mock started");
      await sleep(100);
      h.stop();
      h.stop(); // idempotent
    });
    assert.deepEqual([stopped.outcome, stopped.stopCause, stopped.process.signalsToLeader[0]], ["stopped", "user", "SIGINT"]);
    assert.equal(stopped.timeline.filter((x) => x.ev.startsWith("stop:")).length, 1);

    const timedOut = await turn(t, provider, "sleep", { limits: { timeoutMs: 500 } });
    assert.deepEqual([timedOut.outcome, timedOut.stopCause, timedOut.report.status], ["timeout", "timeout", "not_checked"]);
  });
}

// ---- false successes (revision 5): delivery failure, timeout / Stop after a valid result ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock): 8 MiB task, CLI never reads stdin but answers -> delivery_failed (EPIPE), report kept`, T, async (t) => {
    const r = await turn(t, provider, "no_read_stdin", { task: Buffer.alloc(8 << 20, 0x61) });
    assert.equal(r.transport.status, "completed", "the CLI itself reported success");
    assert.deepEqual([r.outcome, r.delivery.status, r.nextTurnAllowed], ["delivery_failed", "failed", false]);
    assert.ok(r.delivery.errors.some((e) => e.where === "supervisor" && e.code === "EPIPE"), JSON.stringify(r.delivery.errors));
    assert.equal(r.report.status, "valid", "answer still checked and kept for diagnosis");
  });

  test(`${provider} (mock): valid result, then the CLI hangs -> timeout / user Stop win over the result, report kept`, T, async (t) => {
    const timedOut = await turn(t, provider, "result_then_hang", { limits: { timeoutMs: 500 } });
    assert.deepEqual([timedOut.outcome, timedOut.stopCause, timedOut.transport.status, timedOut.report.status], ["timeout", "timeout", "completed", "valid"]);

    const stopped = await turn(t, provider, "result_then_hang", {}, async (h, ledger) => {
      await until(() => resultSent(ledger), 5000, "result sent");
      await sleep(100); // main has read the result line before the Stop
      h.stop();
    });
    assert.deepEqual([stopped.outcome, stopped.stopCause, stopped.transport.status, stopped.report.status], ["stopped", "user", "completed", "valid"]);
  });
}

test("large task into a CLI that exits at once without a result: EPIPE handled, delivery_failed", async (t) => {
  const r = await run(t, inlineSpec(`process.exit(0);`, { task: Buffer.alloc(8 << 20, 0x61) }));
  assert.deepEqual([r.outcome, r.transport.status, r.delivery.errors[0].code, r.process.exitCode], ["delivery_failed", "protocol_error", "EPIPE", 0]);
});

// ---- limits ----

for (const provider of PROVIDERS) {
  test(`${provider} (mock): oversized line -> protocol_error quickly, no hang`, T, async (t) => {
    const t0 = Date.now();
    const r = await turn(t, provider, "oversized_line", { env: { MOCK_LINE_BYTES: String(4 << 20) }, limits: { maxMessageBytes: 64 << 10 } });
    assert.deepEqual([r.outcome, r.errors[0].code], ["protocol_error", "oversized"]);
    assert.ok(Date.now() - t0 < 10_000);
  });

  test(`${provider} (mock): 2000 x 64 KiB events -> completed; history bounded by bytes, then by count; terminal kept`, T, async (t) => {
    const env = { MOCK_EVENTS: "2000", MOCK_EVENT_BYTES: String(64 << 10) };
    const limits = { maxHistoryEvents: 500, maxHistoryBytes: 1 << 20 };
    const r = await turn(t, provider, "many_big_events", { env, limits });
    assert.equal(r.outcome, "completed");
    assert.ok(r.history.reduce((a, f) => a + f.bytes, 0) <= limits.maxHistoryBytes);
    assert.ok(r.history.length < 20, "the byte limit, not the count limit, cut the history");
    assert.equal(r.counters.keptEvents, r.history.length);
    assert.equal(r.counters.droppedEvents, r.counters.frames - r.counters.keptEvents);
    assert.ok(r.counters.droppedEventBytes > 0);
    assert.equal(r.terminal.type, provider === "codex" ? "turn.completed" : "result");
    assert.equal(r.terminal.index, r.counters.frames - 1);
    assert.ok(r.sessionEvent, "session event kept");
    assert.ok(r.diagnostics.some((d) => d.what === "history_limit"));

    const count = await turn(t, provider, "many_big_events", { env: { MOCK_EVENTS: "200", MOCK_EVENT_BYTES: "1024" }, limits: { maxHistoryEvents: 5 } });
    assert.deepEqual([count.outcome, count.counters.keptEvents, count.terminal.index], ["completed", 5, count.counters.frames - 1]);
  });

  test(`${provider} (mock): descendant holds stdout after the leader exits -> protocol_error stdout_held_open, group cleaned`, T, async (t) => {
    // The supervisor relays stdout and judges it: still open when it signals the group after the leader's exit =>
    // held_until_cleanup. Main no longer stops the turn on its own timer, so there is no stopCause.
    const { spec, ledger } = mockSpec(provider, "hold_stdout", { limits: { stdoutGraceMs: 300 } });
    const r = await run(t, { spec, ledger });
    assert.deepEqual([r.outcome, r.stopCause, r.transport.reason, r.process.stdoutEnded], ["protocol_error", null, "stdout_held_open", false]);
    assert.deepEqual([r.ending.step, r.ending.streams.stdout, r.ending.signals.group[0]], ["stream_held_until_cleanup", "held_until_cleanup", "SIGTERM"]);
    assert.ok(ledger.read().some((e) => e.label.endsWith("-holder")), "holder was recorded (and is gone: checked by run)");
  });
}

test("stream_limit: Stop with protocol_error, CLI stopped", async (t) => {
  const flood = `const s=JSON.stringify({type:"x",s:"a".repeat(1000)})+"\\n";const w=()=>{while(process.stdout.write(s));};process.stdout.on("drain",w);w();${HOLD}`;
  const r = await run(t, inlineSpec(flood, { limits: { maxStreamBytes: 64 * 1024 } }));
  assert.deepEqual([r.outcome, r.stopCause, r.errors[0].code], ["protocol_error", "protocol_error", "stream_limit"]);
  assert.ok(r.process.signalsToLeader.includes("SIGINT"));
});

test("large stderr: head + tail kept within maxStderrBytes, rest counted, no hang", async (t) => {
  const r = await run(t, inlineSpec(`process.stderr.write("HEAD"+"e".repeat(5<<20)+"TAIL",()=>{${CODEX_OK}});`, { limits: { maxStderrBytes: 1024 } }));
  assert.equal(r.outcome, "completed");
  assert.equal(r.stderr.bytes, (5 << 20) + 8);
  assert.ok(r.stderr.head.startsWith("HEAD") && r.stderr.tail.endsWith("TAIL"));
  assert.equal(r.stderr.head.length + r.stderr.tail.length, 1024);
  assert.equal(r.stderr.droppedBytes, r.stderr.bytes - 1024);
  assert.equal(r.counters.stderrDroppedBytes, r.stderr.droppedBytes);
});

test("CLI environment: exactly spec.env, no ELECTRON_RUN_AS_NODE / SUP_* even when the launch sets them", async (t) => {
  const body = `fs.writeFileSync(file,JSON.stringify({summary:Object.keys(process.env).sort().join(",")}));out({type:"turn.completed"});`;
  const { spec, ledger } = inlineSpec(body, { env: { CTTYEXP: MARK, KEEP_ME: "1" } });
  const h = startTurn(spec, { ...LAUNCH, env: { ELECTRON_RUN_AS_NODE: "1" } });
  const r = await h.result;
  ledger.track(r.pids.supervisor, "supervisor");
  await assertNoneAlive(t, ledger);
  assert.equal(r.outcome, "completed", JSON.stringify(r.diagnostics));
  assert.deepEqual(r.report.value.summary.split(",").filter((k) => k !== "__CF_USER_TEXT_ENCODING"), ["CTTYEXP", "KEEP_ME"]);
});

// ---- losing main ----

test("codex (mock): SIGKILL of the process running startTurn -> every ledger pid is gone", T, async (t) => {
  const { spec, ledger } = mockSpec("codex", "sleep");
  const code = `const { startTurn } = await import(${JSON.stringify(pathToFileURL(TURN_MODULE).href)});
    startTurn(JSON.parse(process.env.CTTY_SPEC), JSON.parse(process.env.CTTY_LAUNCH)); setInterval(() => {}, 1e3);`;
  const w = spawn(process.execPath, ["--input-type=module", "-e", code, MARK], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, CTTY_SPEC: JSON.stringify(spec), CTTY_LAUNCH: JSON.stringify(LAUNCH) }
  });
  ledger.track(w.pid, "wrapper(main)");
  await until(() => mockStarted(ledger), 10_000, "mock started");
  await sleep(200);
  const labels = ledger.check().alive.map((e) => e.label).sort(); // "parent" = supervisor (the handle has no pids before the end)
  assert.deepEqual(labels, ["mock-codex", "parent", "wrapper(main)"]);
  w.kill("SIGKILL");
  const r = await assertNoneAlive(t, ledger, { ms: 5000, mark: MARK });
  t.diagnostic(`after SIGKILL of main: ${describe(r)}`);
});

// ---- decideOutcome / preflight ----

test("decideOutcome: revision 5 rules in order (cleanup_unverified cannot be provoked with a real supervisor)", () => {
  const ok = {
    harnessError: null, done: { groupCleared: true }, delivery: { status: "ok" }, stopCause: null,
    transport: { status: "completed" }, sessionMismatch: false, report: { status: "valid" }, supervisorExitCode: 0
  };
  const cases = [
    [{}, "completed"],
    [{ harnessError: "guard_deadline" }, "harness_error"],
    [{ done: null }, "harness_error"],
    [{ done: { error: "spawn", groupCleared: true }, delivery: { status: "failed" } }, "failed"],
    [{ delivery: { status: "failed" }, stopCause: "timeout" }, "delivery_failed"],
    [{ delivery: { status: "unconfirmed" } }, "delivery_failed"],
    [{ stopCause: "timeout" }, "timeout"],
    [{ stopCause: "user" }, "stopped"],
    [{ stopCause: "protocol_error", transport: { status: "protocol_error" } }, "protocol_error"],
    [{ transport: { status: "failed" }, sessionMismatch: true }, "failed"],
    [{ sessionMismatch: true, report: { status: "schema_mismatch" } }, "failed"],
    [{ report: { status: "missing" }, done: { groupCleared: false } }, "invalid_report"],
    [{ done: { groupCleared: false } }, "cleanup_unverified"],
    [{ done: {} }, "cleanup_unverified"],
    [{ supervisorExitCode: null }, "cleanup_unverified"],
    [{ supervisorExitCode: 1 }, "cleanup_unverified"]
  ];
  for (const [over, want] of cases) assert.equal(decideOutcome({ ...ok, ...over }), want, JSON.stringify(over));
});

test("preflight: bad spec or launch throws synchronously and starts nothing", () => {
  const bad = [
    ["codex without {REPORT_FILE}", /REPORT_FILE/, (s) => { s.argv = s.argv.map((a) => (a === "{REPORT_FILE}" ? path.join(TMP, "fixed.json") : a)); }],
    ["claude with {REPORT_FILE}", /codex-only/, (s) => { s.provider = "claude"; }],
    ["attemptDir missing", /attemptDir/, (s) => { s.attemptDir = path.join(TMP, "no-such-dir"); }],
    ["attemptDir relative", /attemptDir/, (s) => { s.attemptDir = "attempt"; }],
    ["attemptDir is a file", /attemptDir/, (s) => { s.attemptDir = SCHEMA_FILE; }],
    ["cwd relative", /cwd/, (s) => { s.cwd = "."; }],
    ["limit missing", /maxReportBytes/, (s) => { delete s.limits.maxReportBytes; }],
    ["limit zero", /timeoutMs/, (s) => { s.limits.timeoutMs = 0; }],
    ["provider unknown", /provider/, (s) => { s.provider = "gemini"; }],
    ["supervisor timing unknown", /supervisor\.nope/, (s) => { s.supervisor.nope = 1; }],
    ["unsupported schema", /\$\.properties\.status\.pattern: unsupported schema keyword/, (s) => { s.schema = { ...SCHEMA, properties: { status: { type: "string", pattern: "x" } } }; }],
    ...["SUP_GRACE_INT_MS", "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR", "BAD-NAME"]
      .map((k) => [`env ${k}`, /env name not allowed/, (s) => { s.env[k] = "x"; }]),
    ["launch env other than ELECTRON_RUN_AS_NODE", /launch env name not allowed: NODE_OPTIONS/, (s, l) => { l.env = { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--x" }; }],
    ["launch without command", /launch\.command/, (s, l) => { l.command = ""; }]
  ];
  for (const [what, re, mutate] of bad) {
    const { spec, ledger } = mockSpec("codex", "ok");
    const launch = { ...LAUNCH };
    mutate(spec, launch);
    assert.throws(() => startTurn(spec, launch), re, what);
    assert.equal(ledger.read().length, 0, `${what}: nothing started`);
  }
});

test("preflight: an already existing report file throws", () => {
  const { spec } = inlineSpec(CODEX_OK);
  const orig = crypto.randomUUID;
  crypto.randomUUID = () => "fixed";
  syncBuiltinESMExports();
  try {
    fs.writeFileSync(path.join(TMP, "report-fixed.json"), "{}");
    assert.throws(() => startTurn(spec, LAUNCH), /already exists/);
  } finally {
    crypto.randomUUID = orig;
    syncBuiltinESMExports();
  }
});
