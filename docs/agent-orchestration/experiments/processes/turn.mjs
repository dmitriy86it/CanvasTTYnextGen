// runTurn(spec): one CLI turn under supervisor.mjs, per turn-contract.md.
// All ordering uses performance.now() of this process; supervisor timestamps (Date.now) are never compared.
// The result is ready only after: `done` (or EOF) on fd3, supervisor exit, stdout end, stderr end.
// A guard deadline turns anything that never arrives into outcome "harness_error" instead of a hang.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlFramer, TurnCollector, reconcile } from "./jsonl.ts";
import { validate } from "./schema.mjs";

const SUP = fileURLToPath(new URL("./supervisor.mjs", import.meta.url));

export const DEFAULT_TURN_LIMITS = Object.freeze({
  maxMessageBytes: 16 * 1024 * 1024,
  maxStreamBytes: 512 * 1024 * 1024,
  maxHistoryEvents: 1000,
  maxHistoryBytes: 8 * 1024 * 1024,
  maxStderrBytes: 256 * 1024,
  maxDiagnostics: 100,
  maxReportBytes: 1024 * 1024,
  timeoutMs: 30 * 60 * 1000,
  stdoutGraceMs: 2000,
});

const MAX_ERRORS = 100; // error frames kept; the first one always
const MAX_STATUS_LINE = 64 * 1024;
const GUARD_MARGIN_MS = 5000;
const SUP_DEFAULTS = { graceIntMs: 5000, graceTermMs: 3000, leftoverMs: 2000 }; // mirrors supervisor.mjs
const SUP_KILL_WAIT_MS = 1000;
const REPORT_TOKEN = "{REPORT_FILE}";

function preflight(spec) {
  const fail = (m) => { throw new Error(`runTurn: ${m}`); };
  const isDir = (p) => typeof p === "string" && path.isAbsolute(p) && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory();
  if (spec.provider !== "codex" && spec.provider !== "claude") fail("provider must be codex or claude");
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !spec.argv.every((a) => typeof a === "string")) fail("argv must be a non-empty string array");
  if (!isDir(spec.cwd)) fail("cwd must be an existing absolute directory");
  if (!spec.env || typeof spec.env !== "object") fail("env must be an object");
  for (const [k, v] of Object.entries(spec.env)) {
    // Names go into the comma-separated SUP_ENV_ALLOW; the supervisor (node) gets spec.env too,
    // so SUP_*, NODE_* and ELECTRON_* would configure the supervisor itself.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /^(SUP|NODE|ELECTRON)_/.test(k)) fail(`env name not allowed: ${k}`);
    if (typeof v !== "string") fail(`env value for ${k} must be a string`);
  }
  if (typeof spec.task !== "string" && !Buffer.isBuffer(spec.task)) fail("task must be a string or Buffer");
  if (!spec.schema || typeof spec.schema !== "object") fail("schema must be an object");
  for (const k of Object.keys(DEFAULT_TURN_LIMITS)) if (!(spec.limits?.[k] > 0 && Number.isFinite(spec.limits[k]))) fail(`limits.${k} must be a positive number`);
  for (const [k, v] of Object.entries(spec.supervisor ?? {})) if (!(k in SUP_DEFAULTS) || !(v >= 0 && Number.isFinite(v))) fail(`supervisor.${k}`);
  const hasToken = spec.argv.some((a) => a.includes(REPORT_TOKEN));
  if (spec.provider === "claude") {
    if (hasToken) fail(`${REPORT_TOKEN} is codex-only`);
    return null;
  }
  if (!hasToken) fail(`codex argv must contain ${REPORT_TOKEN}`);
  if (!isDir(spec.attemptDir)) fail("attemptDir must be an existing absolute directory");
  const reportFile = path.join(spec.attemptDir, `report-${randomUUID()}.json`);
  if (fs.lstatSync(reportFile, { throwIfNoEntry: false })) fail(`report file already exists: ${reportFile}`);
  return reportFile;
}

function checkValue(value, maxBytes, schema) {
  if (value === undefined) return { status: "missing" };
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size > maxBytes) return { status: "too_large", errors: [`${size} > ${maxBytes} bytes`] };
  const errors = validate(schema, value);
  return errors.length ? { status: "schema_mismatch", errors } : { status: "valid", value };
}

// Never reads more than maxBytes + 1: size is checked with fstat first, and again by the read itself (the file may grow).
function readReport(file, maxBytes, schema) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); // no symlinks, no FIFO block
  } catch (e) {
    return e.code === "ENOENT" ? { status: "missing" } : { status: "missing", errors: [`open: ${e.code}`] };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { status: "missing", errors: ["not a regular file"] };
    if (st.size > maxBytes) return { status: "too_large", errors: [`${st.size} > ${maxBytes} bytes`] };
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    for (let k; n < buf.length && (k = fs.readSync(fd, buf, n, buf.length - n, n)) > 0;) n += k;
    if (n > maxBytes) return { status: "too_large", errors: [`grew past ${maxBytes} bytes`] };
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, n))); } catch { return { status: "invalid_json" }; }
    const errors = validate(schema, value);
    return errors.length ? { status: "schema_mismatch", errors } : { status: "valid", value };
  } finally {
    fs.closeSync(fd);
  }
}

// Outcome rules of turn-contract.md revision 5, first match wins. Pure, so each rule is testable without processes.
export function decideOutcome({ harnessError, done, delivery, stopCause, transport, sessionMismatch, report, supervisorExitCode }) {
  if (harnessError || !done) return "harness_error";
  if (done.error) return "failed";
  if (delivery.status !== "ok") return "delivery_failed";
  if (stopCause === "timeout") return "timeout";
  if (stopCause === "user") return "stopped";
  if (transport.status !== "completed") return transport.status;
  if (sessionMismatch) return "failed";
  if (report.status !== "valid") return "invalid_report";
  if (done.groupCleared !== true || supervisorExitCode !== 0) return "cleanup_unverified";
  return "completed";
}

export function runTurn(spec) {
  const reportFile = preflight(spec);
  const L = spec.limits;
  const now = () => performance.now();

  const timeline = [];
  const diagnostics = [];
  let droppedDiagnostics = 0;
  const mark = (ev) => timeline.push({ at: now(), ev });
  const diag = (what, extra = {}) => { if (diagnostics.length < L.maxDiagnostics) diagnostics.push({ at: now(), what, ...extra }); else droppedDiagnostics++; };

  // ---- state ----
  let stopCause = null, stopRequestedAt = null;
  let started = null, leaderExit = null, done = null, statusEnded = false, supExit = null;
  let stdoutEnded = false, stdoutHeldOpen = false, stderrEnded = false, finished = false;
  let stdoutBytes = 0;
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  let resolve;
  const result = new Promise((r) => { resolve = r; });

  // ---- spawn ----
  const env = { ...spec.env, SUP_ENV_ALLOW: Object.keys(spec.env).join(",") };
  const s = spec.supervisor ?? {};
  if (s.graceIntMs !== undefined) env.SUP_GRACE_INT_MS = String(s.graceIntMs);
  if (s.graceTermMs !== undefined) env.SUP_GRACE_TERM_MS = String(s.graceTermMs);
  if (s.leftoverMs !== undefined) env.SUP_LEFTOVER_MS = String(s.leftoverMs);
  const argv = reportFile ? spec.argv.map((a) => a.replaceAll(REPORT_TOKEN, reportFile)) : spec.argv;
  const sup = spawn(process.execPath, [SUP, ...argv], { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
  const [control, stdout, stderr, status, taskIn] = sup.stdio;
  mark("spawn");

  function stop(cause) {
    // After `done` the supervisor cannot act on it any more: nothing to request.
    if (stopCause !== null || done !== null || finished) return;
    stopCause = cause;
    stopRequestedAt = now();
    mark(`stop:${cause}`);
    if (control.writable) control.write('{"cmd":"stop"}\n');
  }

  sup.on("error", (e) => { diag("supervisor_spawn_error", { code: e.code }); finish("supervisor_spawn_error"); });
  sup.on("exit", (code, signal) => {
    supExit = { code, signal };
    mark("supervisor_exit");
    // A descendant that escaped the group can hold stdout/stderr forever: give up on them after the grace.
    later(L.stdoutGraceMs, () => {
      if (!stdoutEnded) { stdoutHeldOpen = true; stdoutEnded = true; diag("stdout_held_after_supervisor_exit"); stdout.destroy(); }
      if (!stderrEnded) { stderrEnded = true; diag("stderr_held_after_supervisor_exit"); stderr.destroy(); }
      check();
    });
    check();
  });
  control.on("error", (e) => diag("control_write_error", { code: e.code }));

  // ---- task delivery ----
  // ok = main wrote the whole task to fd4 and closed it, the supervisor saw fd4 EOF (task_eof) and finished the
  // CLI's stdin (task_written: every byte handed to the stdin pipe, then closed). A pipe write is not a read:
  // ok does NOT prove the agent read the task. Any error, before or after the terminal event, makes it failed.
  const delivery = { mainWritten: false, taskEof: false, taskWritten: false, errors: [] };
  const deliveryError = (where, code) => delivery.errors.push({ where, code, at: now() });
  taskIn.on("error", (e) => { deliveryError("main", e.code); diag("task_write_error", { code: e.code }); });
  taskIn.on("finish", () => { delivery.mainWritten = true; });
  taskIn.end(spec.task);

  // ---- stdout: framer -> collector ----
  const collector = new TurnCollector(spec.provider, { maxEvents: L.maxHistoryEvents, maxErrors: MAX_ERRORS, maxHistoryBytes: L.maxHistoryBytes });
  let historyNoted = false;
  const framer = new JsonlFramer((f) => {
    const terminals = collector.terminals.length;
    collector.push(f, now());
    if (collector.terminals.length > terminals) mark(`terminal:${f.type}`);
    if (!historyNoted && collector.droppedEvents > 0) { historyNoted = true; diag("history_limit", { index: collector.overflowAt }); }
    if (f.kind === "error" && (f.code === "stream_limit" || f.code === "oversized")) {
      diag("framing_limit", { code: f.code, bytes: f.bytes });
      stop("protocol_error");
    }
  }, { maxMessageBytes: L.maxMessageBytes, maxStreamBytes: L.maxStreamBytes });
  stdout.on("data", (d) => { stdoutBytes += d.length; framer.push(d); });
  stdout.on("end", () => { framer.end(); stdoutEnded = true; mark("stdout_end"); check(); });

  // ---- stderr: head + tail within maxStderrBytes, the rest counted ----
  const headMax = Math.floor(L.maxStderrBytes / 2), tailMax = L.maxStderrBytes - headMax;
  const errHead = [];
  let errHeadLen = 0, errTail = Buffer.alloc(0), stderrBytes = 0;
  stderr.on("data", (d) => {
    stderrBytes += d.length;
    if (errHeadLen < headMax) {
      const k = Math.min(headMax - errHeadLen, d.length);
      errHead.push(d.subarray(0, k));
      errHeadLen += k;
      d = d.subarray(k);
    }
    if (d.length) {
      const t = Buffer.concat([errTail, d.subarray(Math.max(0, d.length - tailMax))]);
      errTail = t.subarray(Math.max(0, t.length - tailMax));
    }
  });
  stderr.on("end", () => { stderrEnded = true; mark("stderr_end"); check(); });

  // ---- fd3: status lines ----
  let line = "", overlong = false;
  status.setEncoding("utf8");
  status.on("data", (d) => {
    let start = 0;
    for (let nl = d.indexOf("\n"); nl >= 0; nl = d.indexOf("\n", start)) {
      const whole = overlong ? null : line + d.slice(start, nl);
      line = ""; overlong = false; start = nl + 1;
      if (whole !== null) onStatus(whole);
    }
    if (!overlong) { line += d.slice(start); if (line.length > MAX_STATUS_LINE) { line = ""; overlong = true; diag("status_overlong"); } }
  });
  status.on("end", () => { statusEnded = true; mark("status_eof"); check(); });

  function onStatus(text) {
    let m;
    try { m = JSON.parse(text); } catch { return diag("status_invalid"); }
    mark(`sup:${m.ev}`);
    if (m.ev === "started") started = m;
    else if (m.ev === "task_write_error" || m.ev === "task_read_error") { deliveryError("supervisor", m.code); diag(`sup_${m.ev}`, { code: m.code }); }
    else if (m.ev === "task_eof") delivery.taskEof = true;
    else if (m.ev === "task_written") delivery.taskWritten = true;
    else if (m.ev === "leader_exit") {
      leaderExit = { code: m.code, signal: m.signal };
      later(L.stdoutGraceMs, () => { if (!stdoutEnded) { stdoutHeldOpen = true; diag("stdout_held_open", { graceMs: L.stdoutGraceMs }); stop("stdout_held_open"); } });
    } else if (m.ev === "done" && !done) { done = m; check(); }
  }

  // ---- deadlines ----
  later(L.timeoutMs, () => { diag("timeout", { timeoutMs: L.timeoutMs }); stop("timeout"); });
  const sg = { ...SUP_DEFAULTS, ...s };
  // SUP_KILL_WAIT_MS twice: after SIGKILL, and the supervisor's wait for the CLI's stdin to settle before done.
  const guardMs = L.timeoutMs + sg.graceIntMs + sg.graceTermMs + sg.leftoverMs + 2 * SUP_KILL_WAIT_MS + 2 * L.stdoutGraceMs + GUARD_MARGIN_MS;
  later(guardMs, () => finish("guard_deadline"));

  function check() {
    if (!finished && (done || statusEnded) && supExit && stdoutEnded && stderrEnded) finish(null);
  }

  function finish(harnessError) {
    if (finished) return;
    finished = true;
    for (const t of timers) clearTimeout(t);
    if (harnessError) {
      diag("harness_error", { reason: harnessError, missing: { done: !done && !statusEnded, supervisorExit: !supExit, stdoutEnd: !stdoutEnded, stderrEnd: !stderrEnded } });
      stdout.destroy(); stderr.destroy(); status.destroy();
    } else if (!done) diag("status_eof_without_done");
    control.end(); // lifeline EOF: if the supervisor is somehow still alive, it stops the group
    taskIn.destroy();
    mark("finish");

    const le = done?.leaderExit ?? leaderExit;
    const facts = { exitCode: le?.code ?? null, signal: le?.signal ?? null, stdoutEnded: stdoutEnded && !stdoutHeldOpen, stopRequestedAt, signalsToLeader: done?.signalsToLeader ?? [] };
    const r = reconcile(collector, facts);
    let transport = { status: r.status, reason: r.status === "completed" ? null : r.reason };
    if (done?.error) transport = { status: "failed", reason: `supervisor ${done.error}${done.code ? " " + done.code : ""}` };

    let report = { status: "not_checked" };
    if (transport.status === "completed") {
      report = spec.provider === "codex" ? readReport(reportFile, L.maxReportBytes, spec.schema) : checkValue(collector.terminals[0].value.structured_output, L.maxReportBytes, spec.schema);
    }
    const sessionId = collector.sessionId;
    const sessionMismatch = (spec.expectSessionId != null && sessionId !== spec.expectSessionId) || collector.sessionConflict;
    if (sessionMismatch) diag("session_mismatch", { expected: spec.expectSessionId ?? null, got: sessionId, conflict: collector.sessionConflict });
    const stderrDroppedBytes = stderrBytes - errHeadLen - errTail.length;
    if (stderrDroppedBytes > 0) diag("stderr_limit", { droppedBytes: stderrDroppedBytes });

    const d = delivery;
    const deliveryResult = { status: d.errors.length ? "failed" : d.mainWritten && d.taskEof && d.taskWritten ? "ok" : "unconfirmed", errors: [...d.errors] }; // copy: late errors after finish do not alter the result
    if (deliveryResult.status === "unconfirmed") diag("delivery_unconfirmed", { mainWritten: d.mainWritten, taskEof: d.taskEof, taskWritten: d.taskWritten });
    const supervisorExitCode = supExit?.code ?? null;
    const outcome = decideOutcome({ harnessError, done, delivery: deliveryResult, stopCause, transport, sessionMismatch, report, supervisorExitCode });

    const t = collector.terminals[0];
    resolve({
      outcome,
      transport,
      report,
      sessionId,
      sessionMismatch,
      stopCause,
      nextTurnAllowed: outcome === "completed",
      delivery: deliveryResult,
      sessionEvent: collector.sessionEvent,
      process: {
        exitCode: facts.exitCode, signal: facts.signal, stdoutEnded: facts.stdoutEnded, signalsToLeader: facts.signalsToLeader,
        groupCleared: done?.groupCleared ?? false, supervisorExitCode, supervisorDone: done !== null,
      },
      counters: {
        stdoutBytes, frames: collector.frameCount, keptEvents: collector.events.length, droppedEvents: collector.droppedEvents,
        droppedEventBytes: collector.droppedEventBytes, stderrBytes, stderrDroppedBytes, droppedDiagnostics,
      },
      history: collector.events,
      terminal: t ? { type: t.type, index: t.index, at: t.at } : null,
      errors: collector.errors,
      stderr: { head: Buffer.concat(errHead).toString("utf8"), tail: errTail.toString("utf8"), bytes: stderrBytes, droppedBytes: stderrDroppedBytes },
      diagnostics,
      timeline,
      pids: { supervisor: sup.pid ?? null, pgid: started?.pgid ?? null },
      reportFile,
    });
  }

  return { stop: () => stop("user"), result };
}
