// Limits and termination of turn.mjs on tiny inline CLIs (`node -e`). Run: node --test turn-limits.test.mjs
// Process accounting uses only pids this test created (TurnResult.pids): kill(pid, 0) -> ESRCH gone,
// success alive (failure), EPERM unverifiable (reported, not counted as clean). No `ps`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto, { randomBytes } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTurn, decideOutcome, DEFAULT_TURN_LIMITS } from "./turn.mjs";
import { validate } from "./schema.mjs";

const MARK = "CTTYEXP-" + randomBytes(4).toString("hex");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), `${MARK}-`));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const SCHEMA = { type: "object", properties: { summary: { type: "string", minLength: 1 } }, required: ["summary"], additionalProperties: false };

// Inline CLI: `out(obj)` writes a JSONL line, `file` is the codex report path (argv after the marker).
const cli = (body) => `const fs=require("fs");const file=process.argv[2];const out=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");${body}`;
const CODEX_OK = `out({type:"thread.started",thread_id:"T1"});fs.writeFileSync(file,JSON.stringify({summary:"ok"}));out({type:"turn.completed"});`;
const HOLD = "setInterval(()=>{},1e3);";

function spec(body, over = {}) {
  const provider = over.provider ?? "codex";
  return {
    provider,
    argv: [process.execPath, "-e", cli(body), MARK, ...(provider === "codex" ? ["{REPORT_FILE}"] : [])],
    cwd: DIR, env: { CTTYEXP: MARK }, task: "", schema: SCHEMA, attemptDir: DIR, expectSessionId: null,
    supervisor: { graceIntMs: 300, graceTermMs: 300, leftoverMs: 300 },
    ...over,
    limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: 15000, stdoutGraceMs: 1000, ...over.limits },
  };
}

// Waits for the result with an outer bound, then checks that every pid of this turn is gone.
async function turn(t, s, { onStart } = {}) {
  const h = runTurn(s);
  onStart?.(h);
  let timer;
  const r = await Promise.race([h.result, new Promise((res) => { timer = setTimeout(res, 40000, null); })]);
  clearTimeout(timer);
  assert.ok(r, "runTurn did not resolve in 40s");
  const check = (what, pid) => {
    if (pid == null) return;
    try { process.kill(pid, 0); assert.fail(`${what} ${pid} still alive`); } catch (e) {
      if (e.code === "EPERM") t.diagnostic(`${what} ${pid}: unverifiable (EPERM)`);
      else if (e.code !== "ESRCH") throw e;
    }
  };
  check("supervisor", r.pids.supervisor);
  check("group", r.pids.pgid && -r.pids.pgid);
  assert.ok(r.pids.supervisor > 0);
  return r;
}

test("codex happy path: completed, valid report, session id, next turn allowed", async (t) => {
  const r = await turn(t, spec(CODEX_OK));
  assert.equal(r.outcome, "completed", JSON.stringify(r.diagnostics));
  assert.equal(r.report.status, "valid");
  assert.deepEqual(r.report.value, { summary: "ok" });
  assert.equal(r.sessionId, "T1");
  assert.equal(r.nextTurnAllowed, true);
  assert.equal(r.process.groupCleared, true);
  assert.ok(r.reportFile.startsWith(path.join(DIR, "report-")));
  assert.equal(r.terminal.type, "turn.completed");
  assert.ok(r.timeline.every((x, i) => i === 0 || x.at >= r.timeline[i - 1].at), "timeline is monotonic");
});

test("claude: structured_output is the report; result text is not; session mismatch fails", async (t) => {
  const body = (so) => `out({type:"system",subtype:"init",session_id:"S1"});out({type:"result",subtype:"success",is_error:false,result:"text",session_id:"S1"${so}});`;
  const ok = await turn(t, spec(body(`,structured_output:{summary:"x"}`), { provider: "claude" }));
  assert.equal(ok.outcome, "completed");
  assert.equal(ok.sessionId, "S1");
  const missing = await turn(t, spec(body(""), { provider: "claude" }));
  assert.equal(missing.outcome, "invalid_report");
  assert.equal(missing.report.status, "missing");
  const bad = await turn(t, spec(body(`,structured_output:{summary:""}`), { provider: "claude" }));
  assert.equal(bad.report.status, "schema_mismatch");
  const big = await turn(t, spec(body(`,structured_output:{summary:"y".repeat(5000)}`), { provider: "claude", limits: { maxReportBytes: 1000 } }));
  assert.equal(big.report.status, "too_large");
  const other = await turn(t, spec(body(`,structured_output:{summary:"x"}`), { provider: "claude", expectSessionId: "S0" }));
  assert.equal(other.sessionMismatch, true);
  assert.equal(other.outcome, "failed");
  assert.equal(other.nextTurnAllowed, false);
});

test("codex report: missing, too large (not read), invalid JSON; not checked when transport failed", async (t) => {
  const missing = await turn(t, spec(`out({type:"turn.completed"});`));
  assert.deepEqual([missing.outcome, missing.report.status], ["invalid_report", "missing"]);
  const big = await turn(t, spec(`fs.writeFileSync(file,JSON.stringify({summary:"z".repeat(1<<20)}));out({type:"turn.completed"});`, { limits: { maxReportBytes: 4096 } }));
  assert.equal(big.report.status, "too_large");
  const junk = await turn(t, spec(`fs.writeFileSync(file,"{nope");out({type:"turn.completed"});`));
  assert.equal(junk.report.status, "invalid_json");
  const failed = await turn(t, spec(`fs.writeFileSync(file,JSON.stringify({summary:"ok"}));out({type:"turn.failed"});process.exitCode=1;`));
  assert.deepEqual([failed.outcome, failed.report.status], ["failed", "not_checked"]);
});

test("large stderr: head + tail kept within maxStderrBytes, rest counted, no hang", async (t) => {
  const r = await turn(t, spec(`process.stderr.write("HEAD"+"e".repeat(5<<20)+"TAIL",()=>{${CODEX_OK}});`, { limits: { maxStderrBytes: 1024 } }));
  assert.equal(r.outcome, "completed");
  assert.equal(r.stderr.bytes, (5 << 20) + 8);
  assert.ok(r.stderr.head.startsWith("HEAD") && r.stderr.tail.endsWith("TAIL"));
  assert.equal(r.stderr.head.length + r.stderr.tail.length, 1024);
  assert.equal(r.stderr.droppedBytes, r.stderr.bytes - 1024);
  assert.equal(r.counters.stderrDroppedBytes, r.stderr.droppedBytes);
  assert.ok(r.diagnostics.some((d) => d.what === "stderr_limit"));
});

test("history: byte limit and event limit independently; terminal never lost", async (t) => {
  const many = `const s="a".repeat(10000);for(let i=0;i<2000;i++)out({type:"item.completed",i,s});`;
  const bytes = await turn(t, spec(many + CODEX_OK, { limits: { maxHistoryEvents: 1e6, maxHistoryBytes: 100_000 } }));
  assert.equal(bytes.outcome, "completed");
  assert.ok(bytes.counters.keptEvents > 0 && bytes.counters.keptEvents < 11, `${bytes.counters.keptEvents}`);
  assert.ok(bytes.history.reduce((n, f) => n + f.bytes, 0) <= 100_000);
  assert.equal(bytes.counters.droppedEvents, bytes.counters.frames - bytes.counters.keptEvents);
  assert.ok(bytes.counters.droppedEventBytes > 2000 * 10000 - 100_000);
  assert.deepEqual([bytes.terminal.type, bytes.terminal.index], ["turn.completed", 2001]);
  assert.equal(bytes.sessionId, "T1"); // arrived after the history was already full
  const count = await turn(t, spec(many + CODEX_OK, { limits: { maxHistoryEvents: 5 } }));
  assert.equal(count.outcome, "completed");
  assert.equal(count.counters.keptEvents, 5);
  assert.equal(count.terminal.index, 2001);
});

test("stream_limit and oversized line: Stop with protocol_error, CLI stopped", async (t) => {
  const flood = `const s=JSON.stringify({type:"x",s:"a".repeat(1000)})+"\\n";const w=()=>{while(process.stdout.write(s));};process.stdout.on("drain",w);w();${HOLD}`;
  const r = await turn(t, spec(flood, { limits: { maxStreamBytes: 64 * 1024 } }));
  assert.deepEqual([r.outcome, r.stopCause, r.nextTurnAllowed], ["protocol_error", "protocol_error", false]);
  assert.equal(r.errors[0].code, "stream_limit");
  assert.ok(r.process.signalsToLeader.includes("SIGINT"));
  const big = await turn(t, spec(`process.stdout.write('{"type":"x","s":"'+"a".repeat(1<<20));${HOLD}`, { limits: { maxMessageBytes: 4096 } }));
  assert.deepEqual([big.outcome, big.stopCause, big.errors[0].code], ["protocol_error", "protocol_error", "oversized"]);
});

test("timeout: Stop with cause timeout; user Stop: stopped", async (t) => {
  const r = await turn(t, spec(`out({type:"thread.started",thread_id:"T"});${HOLD}`, { limits: { timeoutMs: 300 } }));
  assert.deepEqual([r.outcome, r.stopCause, r.nextTurnAllowed, r.report.status], ["timeout", "timeout", false, "not_checked"]);
  const u = await turn(t, spec(`out({type:"thread.started",thread_id:"T"});${HOLD}`), { onStart: (h) => setTimeout(() => { h.stop(); h.stop(); }, 300) });
  assert.deepEqual([u.outcome, u.stopCause, u.nextTurnAllowed], ["stopped", "user", false]);
  assert.equal(u.timeline.filter((x) => x.ev.startsWith("stop:")).length, 1);
});

test("descendant holds stdout after the leader exits: stdout_held_open, group cleaned", async (t) => {
  const body = `require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1e3)","${MARK}-child"],{stdio:["ignore","inherit","ignore"]}).unref();${CODEX_OK}`;
  const r = await turn(t, spec(body, { supervisor: { graceIntMs: 300, graceTermMs: 300, leftoverMs: 5000 }, limits: { stdoutGraceMs: 300 } }));
  assert.deepEqual([r.outcome, r.stopCause, r.process.stdoutEnded], ["protocol_error", "stdout_held_open", false]);
  assert.equal(r.transport.reason, "stdout_held_open");
  assert.equal(r.process.groupCleared, true);
});

test("50 MB of stdout completes without hanging", async (t) => {
  const body = `const s=JSON.stringify({type:"item.completed",s:"b".repeat(65000)})+"\\n";let n=0;const w=()=>{while(n<800){n++;if(!process.stdout.write(s))return;}process.stdout.removeListener("drain",w);${CODEX_OK}};process.stdout.on("drain",w);w();`;
  const t0 = performance.now();
  const r = await turn(t, spec(body));
  t.diagnostic(`50MB turn: ${(performance.now() - t0).toFixed(0)} ms`);
  assert.equal(r.outcome, "completed", JSON.stringify(r.diagnostics));
  assert.ok(r.counters.stdoutBytes > 50e6);
  assert.equal(r.terminal.index, 801);
});

test("large task into a CLI that exits at once: EPIPE handled, result arrives, delivery_failed", async (t) => {
  const r = await turn(t, spec(`process.exit(0);`, { task: Buffer.alloc(8 << 20, 0x61) }));
  assert.equal(r.outcome, "delivery_failed"); // before revision 5: protocol_error (no terminal event)
  assert.equal(r.transport.status, "protocol_error");
  assert.equal(r.delivery.errors[0].code, "EPIPE");
  assert.equal(r.process.exitCode, 0);
  assert.equal(r.process.supervisorDone, true);
  t.diagnostic(`task diagnostics: ${JSON.stringify(r.diagnostics.map((d) => d.what))}`);
});

test("CLI that cannot be spawned (done.error) -> failed, not delivery_failed", async (t) => {
  const r = await turn(t, spec("", { argv: [path.join(DIR, "no-such-cli"), "{REPORT_FILE}"] }));
  assert.deepEqual([r.outcome, r.transport.reason, r.nextTurnAllowed], ["failed", "supervisor spawn ENOENT", false]);
  assert.equal(r.process.supervisorExitCode, 1);
});

test("decideOutcome: revision 5 rules in order (cleanup_unverified cannot be provoked with a real supervisor)", () => {
  const ok = {
    harnessError: null, done: { groupCleared: true }, delivery: { status: "ok" }, stopCause: null,
    transport: { status: "completed" }, sessionMismatch: false, report: { status: "valid" }, supervisorExitCode: 0,
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
    [{ supervisorExitCode: 1 }, "cleanup_unverified"],
  ];
  for (const [over, want] of cases) assert.equal(decideOutcome({ ...ok, ...over }), want, JSON.stringify(over));
});

test("preflight: bad spec and an already existing report file throw synchronously", () => {
  assert.throws(() => runTurn(spec(CODEX_OK, { attemptDir: path.join(DIR, "nope") })), /attemptDir/);
  assert.throws(() => runTurn(spec(CODEX_OK, { argv: [process.execPath, "-e", "0"] })), /REPORT_FILE/);
  assert.throws(() => runTurn(spec(CODEX_OK, { env: { SUP_LEFTOVER_MS: "1" } })), /env name/);
  for (const k of ["NODE_OPTIONS", "NODE_PATH", "NODE_DEBUG", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR"]) {
    assert.throws(() => runTurn(spec(CODEX_OK, { env: { CTTYEXP: MARK, [k]: "x" } })), /env name not allowed/, k);
  }
  assert.throws(() => runTurn(spec(CODEX_OK, { limits: { timeoutMs: undefined } })), /timeoutMs/);
  const orig = crypto.randomUUID;
  crypto.randomUUID = () => "fixed";
  syncBuiltinESMExports();
  try {
    fs.writeFileSync(path.join(DIR, "report-fixed.json"), "{}");
    assert.throws(() => runTurn(spec(CODEX_OK)), /already exists/);
  } finally {
    crypto.randomUUID = orig;
    syncBuiltinESMExports();
  }
});

test("schema.mjs subset", () => {
  const s = {
    type: "object", required: ["a", "k"], additionalProperties: false,
    properties: { a: { type: "integer" }, k: { enum: ["x", "y"] }, l: { type: "array", items: { type: "string", maxLength: 2 } }, n: { type: ["null", "number"] }, b: { type: "boolean" } },
  };
  assert.deepEqual(validate(s, { a: 1, k: "x", l: ["ab", "🧪🧪"], n: null, b: true }), []);
  assert.deepEqual(validate(s, { a: 1.5, k: "z", l: ["abc", 3], n: "s", extra: 1 }), [
    "$.a: expected integer, got number", "$.k: not in enum", "$.l[0]: longer than 2", "$.l[1]: expected string, got integer",
    "$.n: expected null|number, got string", "$: unexpected property extra",
  ]);
  assert.deepEqual(validate(s, []), ["$: expected object, got array"]);
  assert.deepEqual(validate(s, {}), ["$: missing required a", "$: missing required k"]);
  assert.deepEqual(validate({ type: "string", pattern: "x" }, "y"), ["$: unsupported schema keyword pattern"]);
  assert.deepEqual(validate({ type: "string", minLength: 2 }, "a"), ["$: shorter than 2"]);
});
