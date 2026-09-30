// startTurn(spec, launch): one CLI turn under the per-turn supervisor (src/orchestration/supervisor.mjs).
// All ordering uses performance.now() of this process; supervisor timestamps (Date.now) are never compared.
// The result is ready only after: `done` (or EOF) on fd3, supervisor exit, stdout end, stderr end.
// Whether a stream was held open is the supervisor's judgement (`done.streams`): it relays the CLI's stdout/stderr and
// alone knows whether they ended before or after its cleanup; main never races its own timer against that cleanup.
// A guard deadline turns anything that never arrives into outcome "harness_error" instead of a hang.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { JsonlFramer, TurnCollector, reconcile, type Transport } from "./jsonl.ts";
import { compileSchema, validateAnswer } from "./schema.ts";
import type {
  AnswerSchema,
  DeliveryError,
  StopCause,
  StreamEnd,
  SupervisorLaunch,
  TurnDelivery,
  TurnDiagnostic,
  TurnEndingStep,
  TurnLimits,
  TurnOutcome,
  TurnReport,
  TurnResult,
  TurnObserver,
  TurnSpec
} from "./types.ts";

export const DEFAULT_TURN_LIMITS: Readonly<TurnLimits> = Object.freeze({
  maxMessageBytes: 16 * 1024 * 1024,
  maxStreamBytes: 512 * 1024 * 1024,
  maxHistoryEvents: 1000,
  maxHistoryBytes: 8 * 1024 * 1024,
  maxStderrBytes: 256 * 1024,
  maxDiagnostics: 100,
  maxReportBytes: 64 * 1024, // = the store's text limit (MAX_TEXT_BYTES in journal.ts): a larger report could not be journaled
  timeoutMs: 30 * 60 * 1000,
  stdoutGraceMs: 2000
});

const MAX_ERRORS = 100; // error frames kept; the first one always
const MAX_STATUS_LINE = 64 * 1024;
const GUARD_MARGIN_MS = 5000;
const SUP_DEFAULTS = { graceIntMs: 5000, graceTermMs: 3000, leftoverMs: 2000 }; // mirrors supervisor.mjs
const SUP_KILL_WAIT_MS = 1000;
const SUP_STREAM_WAIT_MS = 1000; // mirrors supervisor.mjs STREAM_WAIT_MS
const SUP_STREAM_ENDS = new Set(["eof", "held_until_cleanup", "held_abandoned", "held_capped", "relay_failed"]);
const REPORT_TOKEN = "{REPORT_FILE}";
const LAUNCH_ENV_ALLOWED = new Set(["ELECTRON_RUN_AS_NODE"]);

// Supervisor status lines on fd3 (see supervisor.mjs).
interface DoneStatus {
  ev: "done";
  error?: string;
  code?: string;
  leaderExit: { code: number | null; signal: string | null } | null;
  stopRequested?: boolean;
  signalsToLeader?: string[];
  signals?: { sig: string; target: string }[];
  groupCleared?: boolean;
  streams?: Record<"stdout" | "stderr", { status: string | null; endMs: number | null; bytes?: number; capped?: boolean } | undefined>;
  doneMs?: number | null;
}
type StatusLine = { ev: string; code?: string | number | null; signal?: string | null; pgid?: number | null };

function preflight(spec: TurnSpec, launch: SupervisorLaunch): string | null {
  const fail = (m: string): never => { throw new Error(`startTurn: ${m}`); };
  const isDir = (p: unknown) => typeof p === "string" && path.isAbsolute(p) && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  if (!launch || typeof launch.command !== "string" || !launch.command) fail("launch.command must be a non-empty string");
  if (!Array.isArray(launch.args) || !launch.args.every((a) => typeof a === "string")) fail("launch.args must be a string array");
  for (const [k, v] of Object.entries(launch.env ?? {})) {
    if (!LAUNCH_ENV_ALLOWED.has(k) || typeof v !== "string") fail(`launch env name not allowed: ${k}`);
  }
  if (spec.provider !== "codex" && spec.provider !== "claude") fail("provider must be codex or claude");
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !spec.argv.every((a) => typeof a === "string")) fail("argv must be a non-empty string array");
  if (!isDir(spec.cwd)) fail("cwd must be an existing absolute directory");
  if (!spec.env || typeof spec.env !== "object") fail("env must be an object");
  for (const [k, v] of Object.entries(spec.env)) {
    // Exec turns: names go into the comma-separated SUP_ENV_ALLOW and the supervisor (node) gets spec.env too, so
    // SUP_*, NODE_* and ELECTRON_* would configure the supervisor itself. Sessions pass the environment whole in
    // SUP_CHILD_ENV, which only the CLI gets: there the supervisor's own names are left out at the start (sessionEnv).
    const bad = spec.session ? !/^[^=\0]+$/.test(k)
      : !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /^(SUP|NODE|ELECTRON)_/.test(k);
    if (bad) fail(`env name not allowed: ${k}`);
    if (typeof v !== "string") fail(`env value for ${k} must be a string`);
  }
  if (typeof spec.task !== "string" && !(spec.task instanceof Uint8Array)) fail("task must be a string or Uint8Array");
  compileSchema(spec.schema); // UnsupportedSchemaError: nothing is started
  const limits = spec.limits as unknown as Record<string, unknown> | undefined;
  for (const k of Object.keys(DEFAULT_TURN_LIMITS)) {
    const v = limits?.[k];
    if (!(typeof v === "number" && v > 0 && Number.isFinite(v))) fail(`limits.${k} must be a positive number`);
  }
  for (const [k, v] of Object.entries(spec.supervisor ?? {})) {
    if (!(k in SUP_DEFAULTS) || !(typeof v === "number" && v >= 0 && Number.isFinite(v))) fail(`supervisor.${k}`);
  }
  const hasToken = spec.argv.some((a) => a.includes(REPORT_TOKEN));
  if (spec.session) {
    if (hasToken) fail(`${REPORT_TOKEN} is for codex exec only`);
    return null;
  }
  if (spec.provider === "claude") {
    if (hasToken) fail(`${REPORT_TOKEN} is codex-only`);
    return null;
  }
  if (!hasToken) fail(`codex argv must contain ${REPORT_TOKEN}`);
  if (!isDir(spec.attemptDir)) fail("attemptDir must be an existing absolute directory");
  const reportFile = path.join(spec.attemptDir as string, `report-${randomUUID()}.json`);
  if (fs.lstatSync(reportFile, { throwIfNoEntry: false })) fail(`report file already exists: ${reportFile}`);
  return reportFile;
}

function checkValue(value: unknown, maxBytes: number, schema: AnswerSchema): TurnReport {
  if (value === undefined) return { status: "missing" };
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size > maxBytes) return { status: "too_large", errors: [`${size} > ${maxBytes} bytes`] };
  const errors = validateAnswer(schema, value);
  return errors.length ? { status: "schema_mismatch", errors } : { status: "valid", value };
}

// Never reads more than maxBytes + 1: size is checked with fstat first, and again by the read itself (the file may grow).
function readReport(file: string, maxBytes: number, schema: AnswerSchema): TurnReport {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); // no symlinks, no FIFO block
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { status: "missing" } : { status: "missing", errors: [`open: ${code}`] };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { status: "missing", errors: ["not a regular file"] };
    if (st.size > maxBytes) return { status: "too_large", errors: [`${st.size} > ${maxBytes} bytes`] };
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    for (let k; n < buf.length && (k = fs.readSync(fd, buf, n, buf.length - n, n)) > 0;) n += k;
    if (n > maxBytes) return { status: "too_large", errors: [`grew past ${maxBytes} bytes`] };
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, n)));
    } catch {
      return { status: "invalid_json" };
    }
    const errors = validateAnswer(schema, value);
    return errors.length ? { status: "schema_mismatch", errors } : { status: "valid", value };
  } finally {
    fs.closeSync(fd);
  }
}

export interface OutcomeFacts {
  harnessError: string | null;
  done: { error?: string; groupCleared?: boolean } | null;
  delivery: { status: TurnDelivery["status"] };
  stopCause: StopCause | null;
  transport: { status: Transport["status"] };
  sessionMismatch: boolean;
  report: { status: TurnReport["status"] };
  supervisorExitCode: number | null;
}

// Outcome rules of turn-contract.md revision 5, first match wins. Pure, so each rule is testable without processes.
export function decideOutcome(f: OutcomeFacts): TurnOutcome {
  if (f.harnessError || !f.done) return "harness_error";
  if (f.done.error) return "failed";
  if (f.delivery.status !== "ok") return "delivery_failed";
  if (f.stopCause === "timeout") return "timeout";
  if (f.stopCause === "user") return "stopped";
  if (f.transport.status !== "completed") return f.transport.status;
  if (f.sessionMismatch) return "failed";
  if (f.report.status !== "valid") return "invalid_report";
  if (f.done.groupCleared !== true || f.supervisorExitCode !== 0) return "cleanup_unverified";
  return "completed";
}

// Runs every startTurn precondition without starting anything; throws the same errors startTurn would.
export function checkTurnSpec(spec: TurnSpec, launch: SupervisorLaunch): void {
  preflight(spec, launch);
}

// A session's environment without the names the supervisor keeps for itself (SUP_*, ELECTRON_RUN_AS_NODE): a user's
// variable with such a name is not passed, and the turn says which (names only), instead of refusing to start.
export function sessionEnv(env: Readonly<Record<string, string>>): { env: Record<string, string>; dropped: string[] } {
  const dropped = Object.keys(env).filter((k) => k.startsWith("SUP_") || k === "ELECTRON_RUN_AS_NODE");
  return { env: Object.fromEntries(Object.entries(env).filter(([k]) => !dropped.includes(k))), dropped };
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const sigNames = (a: readonly unknown[]): string[] => a.filter((x): x is string => typeof x === "string" && /^SIG[A-Z0-9]{1,12}$/.test(x)).slice(0, 8);

// Which rule of decideOutcome ended the turn, with the transport rule spelled out (codes only, no free text).
function endingStep(outcome: TurnOutcome, transport: Transport, frameErrors: number, supervisorError: boolean,
  relayProblem: TurnEndingStep | null, streams: Readonly<Record<"stdout" | "stderr", StreamEnd>>, onlyCutTail: boolean, stdoutCut: boolean): TurnEndingStep {
  switch (outcome) {
    case "completed": return "ok";
    case "harness_error": return relayProblem ?? "harness";
    case "delivery_failed": return "delivery";
    case "timeout": return "timeout";
    case "stopped": return "stop";
    case "invalid_report": return "invalid_report";
    case "cleanup_unverified": return "cleanup_failed";
  }
  if (supervisorError) return "supervisor_error";
  if (transport.status === "completed") return "session_mismatch"; // failed with a completed transport
  const held = (e: StreamEnd): TurnEndingStep => (e === "held_abandoned" ? "stream_held_abandoned" : e === "held_capped" ? "stream_held_capped" : "stream_held_until_cleanup");
  // Only when the supervisor itself cut stdout (read cap, abandoned) is a partial last line its doing; a broken line the
  // CLI wrote stays a format error whoever held the stream.
  const cutByUs = stdoutCut && onlyCutTail;
  if (frameErrors > 0 && !cutByUs) return "protocol_parse";
  if (cutByUs) return held(streams.stdout);
  if (transport.status === "stopped") return "protocol_stop";
  const r = transport.reason ?? "";
  // who held it: a member of the CLI's group until the cleanup, or a process outside it (no cleanup reached it)
  if (r === "stdout_held_open" || r === "stderr_held_open") return held(streams[r === "stdout_held_open" ? "stdout" : "stderr"]);
  for (const s of ["multiple_terminal_events", "events_after_terminal", "no_terminal_event", "terminal_failure"] as const) if (r.startsWith(s)) return s;
  return "exit_code";
}

export function startTurn(spec: TurnSpec, launch: SupervisorLaunch, observer?: TurnObserver): { stop(): void; result: Promise<TurnResult> } {
  const reportFile = preflight(spec, launch);
  // An observer's failure is its own: it is switched off, the turn goes on exactly as without it.
  let watching = observer ?? null;
  const observe = (fn: (o: TurnObserver) => void) => {
    if (!watching) return;
    try { fn(watching); } catch { watching = null; }
  };
  const L = spec.limits;
  const now = () => performance.now();

  const timeline: TurnResult["timeline"] = [];
  const diagnostics: TurnDiagnostic[] = [];
  let droppedDiagnostics = 0;
  const mark = (ev: string) => timeline.push({ at: now(), ev });
  const diag = (what: string, extra: Record<string, unknown> = {}) => {
    if (diagnostics.length < L.maxDiagnostics) diagnostics.push({ at: now(), what, ...extra });
    else droppedDiagnostics++;
  };

  // ---- state ----
  let stopCause: StopCause | null = null;
  let stopRequestedAt: number | null = null;
  let started: StatusLine | null = null;
  let leaderExit: { code: number | null; signal: string | null } | null = null;
  let done: DoneStatus | null = null;
  let statusEnded = false;
  let supExit: { code: number | null; signal: string | null } | null = null;
  let stdoutEnded = false, stderrEnded = false, finished = false;
  const streamEnd: Record<"stdout" | "stderr", StreamEnd> = { stdout: "unknown", stderr: "unknown" };
  let leaderExitAt: number | null = null;
  let stdoutBytes = 0;
  const timers: NodeJS.Timeout[] = [];
  const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
  let resolve!: (r: TurnResult) => void;
  const result = new Promise<TurnResult>((r) => { resolve = r; });

  // ---- spawn ----
  const child = spec.session ? sessionEnv(spec.env) : null;
  const env: Record<string, string> = child
    ? { ...launch.env, SUP_CHILD_ENV: JSON.stringify(child.env) }
    : { ...launch.env, ...spec.env, SUP_ENV_ALLOW: Object.keys(spec.env).join(",") };
  const s = spec.supervisor ?? {};
  if (s.graceIntMs !== undefined) env.SUP_GRACE_INT_MS = String(s.graceIntMs);
  if (s.graceTermMs !== undefined) env.SUP_GRACE_TERM_MS = String(s.graceTermMs);
  if (s.leftoverMs !== undefined) env.SUP_LEFTOVER_MS = String(s.leftoverMs);
  const argv = reportFile ? spec.argv.map((a) => a.replaceAll(REPORT_TOKEN, reportFile)) : spec.argv;
  const sup = spawn(launch.command, [...launch.args, ...argv], { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
  const control = sup.stdio[0] as Writable;
  const stdout = sup.stdio[1] as Readable;
  const stderr = sup.stdio[2] as Readable;
  const status = sup.stdio[3] as Readable;
  const taskIn = sup.stdio[4] as Writable;
  mark("spawn");
  observe((o) => o.process?.("spawned", { pid: sup.pid ?? null }));
  if (child?.dropped.length) {
    diag("env_dropped", { names: child.dropped.slice(0, 20) });
    observe((o) => o.stderr?.(Buffer.from(`CanvasTTY: not passed to the CLI (names reserved by the supervisor): ${child.dropped.slice(0, 20).join(", ")}\n`)));
  }

  function stop(cause: StopCause): void {
    // After `done` the supervisor cannot act on it any more: nothing to request.
    if (stopCause !== null || done !== null || finished) return;
    // A session is asked to interrupt first (its last write), then the supervisor's signals follow as for any turn.
    if (spec.session?.interrupt && cause !== "protocol_error") drive(() => spec.session!.interrupt!());
    if (stopCause !== null) return;
    stopCause = cause;
    stopRequestedAt = now();
    mark(`stop:${cause}`);
    if (control.writable) control.write('{"cmd":"stop"}\n');
  }

  sup.on("error", (e: NodeJS.ErrnoException) => { diag("supervisor_spawn_error", { code: e.code }); finish("supervisor_spawn_error"); });
  sup.on("exit", (code, signal) => {
    supExit = { code, signal };
    mark("supervisor_exit");
    // Last guard: the supervisor's relay closes both on its exit at the latest, so this never fires; if it does, the
    // stream counts as held (a failure), never as ended.
    later(L.stdoutGraceMs, () => {
      if (!stdoutEnded) { streamEnd.stdout = "held_after_supervisor_exit"; stdoutEnded = true; diag("stdout_held_after_supervisor_exit"); stdout.destroy(); }
      if (!stderrEnded) { streamEnd.stderr = "held_after_supervisor_exit"; stderrEnded = true; diag("stderr_held_after_supervisor_exit"); stderr.destroy(); }
      check();
    });
    check();
  });
  control.on("error", (e: NodeJS.ErrnoException) => diag("control_write_error", { code: e.code }));

  // ---- task delivery ----
  // ok = main wrote the whole task to fd4 and closed it, the supervisor saw fd4 EOF (task_eof) and finished the
  // CLI's stdin (task_written: every byte handed to the stdin pipe, then closed). A pipe write is not a read:
  // ok does NOT prove the agent read the task. Any error, before or after the terminal event, makes it failed.
  const delivery = { mainWritten: false, taskEof: false, taskWritten: false, errors: [] as DeliveryError[] };
  let opened = false; // session: the opening message reached the pipe
  const deliveryError = (where: DeliveryError["where"], code: string | undefined) => delivery.errors.push({ where, code, at: now() });
  taskIn.on("error", (e: NodeJS.ErrnoException) => {
    // In a session, a failed write after the opening message (the CLI already gone) is not a failed delivery.
    if (!(spec.session && opened)) deliveryError("main", e.code);
    diag("task_write_error", { code: e.code });
  });
  taskIn.on("finish", () => { delivery.mainWritten = true; });
  // A session: the driver writes lines while the turn lasts. Delivery is the opening message handed to the pipe;
  // what follows (answers to requests, the EOF) is conversation, and a write after a stop is simply not made.
  const io = {
    send(message: unknown): void {
      if (finished || stopCause !== null || !taskIn.writable) return;
      taskIn.write(JSON.stringify(message) + "\n", (e) => { if (!e) opened = true; });
    },
    end(): void { if (taskIn.writable) taskIn.end(); },
    hold(on: boolean): void { holdDeadline(on); }
  };
  function drive(fn: () => void): void {
    try { fn(); } catch (e) { diag("session_driver_error", { message: String((e as Error)?.message ?? e).slice(0, 200) }); stop("protocol_error"); }
  }
  if (!spec.session) taskIn.end(spec.task);

  // ---- stdout: framer -> collector ----
  const collector = new TurnCollector(spec.provider, { maxEvents: L.maxHistoryEvents, maxErrors: MAX_ERRORS, maxHistoryBytes: L.maxHistoryBytes }, spec.session ?? null);
  let historyNoted = false;
  const framer = new JsonlFramer((f) => {
    const terminals = collector.terminals.length;
    collector.push(f, now());
    observe((o) => o.frame?.(f));
    if (spec.session && f.kind === "event") drive(() => spec.session!.frame(f));
    if (collector.terminals.length > terminals && f.kind === "event") mark(`terminal:${f.type}`);
    if (!historyNoted && collector.droppedEvents > 0) { historyNoted = true; diag("history_limit", { index: collector.overflowAt }); }
    if (f.kind === "error" && (f.code === "stream_limit" || f.code === "oversized")) {
      diag("framing_limit", { code: f.code, bytes: f.bytes });
      stop("protocol_error");
    }
  }, { maxMessageBytes: L.maxMessageBytes, maxStreamBytes: L.maxStreamBytes, rpc: spec.session?.rpc === true });
  stdout.on("data", (d: Buffer) => { stdoutBytes += d.length; framer.push(d); });
  stdout.on("end", () => { framer.end(); stdoutEnded = true; mark("stdout_end"); check(); });

  // ---- stderr: head + tail within maxStderrBytes, the rest counted ----
  const headMax = Math.floor(L.maxStderrBytes / 2), tailMax = L.maxStderrBytes - headMax;
  const errHead: Buffer[] = [];
  let errHeadLen = 0, errTail = Buffer.alloc(0), stderrBytes = 0;
  stderr.on("data", (d: Buffer) => {
    stderrBytes += d.length;
    observe((o) => o.stderr?.(d));
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
  status.on("data", (d: string) => {
    let start = 0;
    for (let nl = d.indexOf("\n"); nl >= 0; nl = d.indexOf("\n", start)) {
      const whole = overlong ? null : line + d.slice(start, nl);
      line = ""; overlong = false; start = nl + 1;
      if (whole !== null) onStatus(whole);
    }
    if (!overlong) {
      line += d.slice(start);
      if (line.length > MAX_STATUS_LINE) { line = ""; overlong = true; diag("status_overlong"); }
    }
  });
  status.on("end", () => { statusEnded = true; mark("status_eof"); check(); });

  function onStatus(text: string): void {
    let m: StatusLine;
    try {
      m = JSON.parse(text) as StatusLine;
    } catch {
      return diag("status_invalid");
    }
    if (!m || typeof m !== "object" || typeof m.ev !== "string") return diag("status_invalid");
    mark(`sup:${m.ev}`);
    const code = typeof m.code === "string" ? m.code : undefined;
    if (m.ev === "started") { started = m; observe((o) => o.process?.("cli_started", { pid: typeof m.pgid === "number" ? m.pgid : null })); }
    else if (m.ev === "task_write_error" || m.ev === "task_read_error") { deliveryError("supervisor", code); diag(`sup_${m.ev}`, { code }); }
    else if (m.ev === "task_eof") delivery.taskEof = true;
    else if (m.ev === "task_written") delivery.taskWritten = true;
    else if (m.ev === "leader_exit") {
      leaderExit = { code: typeof m.code === "number" ? m.code : null, signal: m.signal ?? null };
      const exit = leaderExit;
      leaderExitAt = now();
      observe((o) => o.process?.("leader_exit", { code: exit.code, signal: exit.signal }));
    } else if (m.ev === "done" && !done) {
      done = m as unknown as DoneStatus;
      for (const k of ["stdout", "stderr"] as const) {
        const st = done.streams?.[k]?.status;
        streamEnd[k] = typeof st === "string" && SUP_STREAM_ENDS.has(st) ? st as StreamEnd : "unknown";
        // A supervisor without an error always says how both ended; a missing fact is not a clean end.
        if (streamEnd[k] !== "eof" && !done.error) diag(`${k}_not_clean`, { status: streamEnd[k] });
      }
      check();
    }
  }

  // ---- deadlines ----
  // Both stop counting while a session holds them (a person is being asked); they resume with what was left.
  const sg = { ...SUP_DEFAULTS, ...s };
  // SUP_KILL_WAIT_MS three times: after SIGKILL, the relay flush, the wait for the CLI's stdin to settle before done;
  // then the stream wait with the group gone, and main's own last guard after the supervisor's exit.
  const guardMs = L.timeoutMs + sg.graceIntMs + sg.graceTermMs + sg.leftoverMs + 3 * SUP_KILL_WAIT_MS + SUP_STREAM_WAIT_MS
    + L.stdoutGraceMs + GUARD_MARGIN_MS;
  const deadlines = [
    { left: L.timeoutMs, fire: () => { diag("timeout", { timeoutMs: L.timeoutMs }); stop("timeout"); } },
    { left: guardMs, fire: () => finish("guard_deadline") }
  ].map((d) => ({ ...d, timer: null as NodeJS.Timeout | null, since: 0 }));
  let holds = 0;
  const arm = () => { for (const d of deadlines) { d.since = now(); d.timer = setTimeout(d.fire, Math.max(0, d.left)); } };
  arm();
  function holdDeadline(on: boolean): void {
    if (finished) return;
    if (on && holds++ === 0) {
      for (const d of deadlines) { if (d.timer) clearTimeout(d.timer); d.timer = null; d.left -= now() - d.since; }
      mark("hold");
    } else if (!on && holds > 0 && --holds === 0) { arm(); mark("hold_end"); }
  }

  function check(): void {
    if (!finished && (done || statusEnded) && supExit && stdoutEnded && stderrEnded) finish(null);
  }

  function finish(harnessError: string | null): void {
    if (finished) return;
    finished = true;
    for (const t of timers) clearTimeout(t);
    for (const d of deadlines) if (d.timer) clearTimeout(d.timer);
    if (harnessError) {
      diag("harness_error", { reason: harnessError, missing: { done: !done && !statusEnded, supervisorExit: !supExit, stdoutEnd: !stdoutEnded, stderrEnd: !stderrEnded } });
      stdout.destroy(); stderr.destroy(); status.destroy();
    } else if (!done) diag("status_eof_without_done");
    control.end(); // lifeline EOF: if the supervisor is somehow still alive, it stops the group
    taskIn.destroy();
    mark("finish");

    const d0 = done as DoneStatus | null; // narrowed copy: `done` is assigned in callbacks
    const le = d0?.leaderExit ?? leaderExit;
    // The application's own side, never the CLI's fault: the supervisor could not pass bytes on, main gave up on a
    // stream, the supervisor said nothing about it, or main did not read exactly what the supervisor wrote.
    let relayProblem: TurnEndingStep | null = null;
    if (!harnessError && d0 && !d0.error) {
      for (const k of ["stdout", "stderr"] as const) {
        const e = streamEnd[k];
        if (e === "relay_failed" || e === "held_after_supervisor_exit") relayProblem ??= e;
        else if (e === "unknown") relayProblem ??= "stream_unknown";
      }
      const sent = { stdout: d0.streams?.stdout?.bytes, stderr: d0.streams?.stderr?.bytes };
      if (!relayProblem && (sent.stdout !== stdoutBytes || sent.stderr !== stderrBytes)) {
        relayProblem = "relay_incomplete";
        diag("relay_incomplete", { sentStdout: int(sent.stdout), readStdout: stdoutBytes, sentStderr: int(sent.stderr), readStderr: stderrBytes });
      }
    }
    // Held by another process (supervisor facts): the transport's stdout/stderr_held_open. Success needs "eof".
    const cleanEnd = (k: "stdout" | "stderr") => stdoutEnded && stderrEnded
      && (!!d0?.error || !["held_until_cleanup", "held_abandoned", "held_capped"].includes(streamEnd[k]));
    const facts = {
      exitCode: le?.code ?? null,
      signal: le?.signal ?? null,
      stdoutEnded: cleanEnd("stdout"),
      stderrEnded: cleanEnd("stderr"),
      stopRequestedAt,
      signalsToLeader: d0?.signalsToLeader ?? []
    };
    let transport = reconcile(collector, facts);
    if (d0?.error) transport = { status: "failed", reason: `supervisor ${d0.error}${d0.code ? " " + d0.code : ""}` };

    let report: TurnReport = { status: "not_checked" };
    if (transport.status === "completed") {
      let answer: unknown;
      if (spec.session) { try { answer = spec.session.answer(); } catch { answer = undefined; } }
      report = reportFile !== null
        ? readReport(reportFile, L.maxReportBytes, spec.schema)
        : checkValue(spec.session ? answer : collector.terminals[0].value.structured_output, L.maxReportBytes, spec.schema);
    }
    const sessionId = collector.sessionId;
    const sessionMismatch = (spec.expectSessionId != null && sessionId !== spec.expectSessionId) || collector.sessionConflict;
    if (sessionMismatch) diag("session_mismatch", { expected: spec.expectSessionId ?? null, got: sessionId, conflict: collector.sessionConflict });
    const stderrDroppedBytes = stderrBytes - errHeadLen - errTail.length;
    if (stderrDroppedBytes > 0) diag("stderr_limit", { droppedBytes: stderrDroppedBytes });

    const dl = delivery;
    const deliveryResult: TurnDelivery = {
      status: dl.errors.length ? "failed" : (spec.session ? opened : dl.mainWritten && dl.taskEof && dl.taskWritten) ? "ok" : "unconfirmed",
      errors: [...dl.errors] // copy: late errors after finish do not alter the result
    };
    if (deliveryResult.status === "unconfirmed") diag("delivery_unconfirmed", { mainWritten: dl.mainWritten, taskEof: dl.taskEof, taskWritten: dl.taskWritten });
    const supervisorExitCode = supExit?.code ?? null;
    const outcome = decideOutcome({ harnessError: harnessError ?? relayProblem, done: d0, delivery: deliveryResult, stopCause, transport, sessionMismatch, report, supervisorExitCode });

    const t = collector.terminals[0];
    const st = started as StatusLine | null;
    resolve({
      outcome,
      transport,
      report,
      delivery: deliveryResult,
      sessionId,
      sessionEvent: collector.sessionEvent,
      sessionMismatch,
      stopCause,
      nextTurnAllowed: outcome === "completed",
      process: {
        exitCode: facts.exitCode, signal: facts.signal, stdoutEnded: facts.stdoutEnded, signalsToLeader: facts.signalsToLeader,
        groupCleared: d0?.groupCleared ?? false, supervisorExitCode, supervisorDone: d0 !== null
      },
      counters: {
        stdoutBytes, frames: collector.frameCount, keptEvents: collector.events.length, droppedEvents: collector.droppedEvents,
        droppedEventBytes: collector.droppedEventBytes, stderrBytes, stderrDroppedBytes, droppedDiagnostics
      },
      history: collector.events,
      terminal: t ? { type: t.type, index: t.index, at: t.at } : null,
      errors: collector.errors,
      stderr: { head: Buffer.concat(errHead).toString("utf8"), tail: errTail.toString("utf8"), bytes: stderrBytes, droppedBytes: stderrDroppedBytes },
      diagnostics,
      timeline,
      pids: { supervisor: sup.pid ?? null, pgid: typeof st?.pgid === "number" ? st.pgid : null },
      reportFile,
      ending: {
        step: endingStep(outcome, transport, collector.errorCount, !!d0?.error, harnessError ? null : relayProblem, streamEnd,
          collector.errorCount === 1 && collector.errors[0]?.kind === "error" && collector.errors[0].code === "unterminated_tail",
          d0?.streams?.stdout?.capped === true || streamEnd.stdout === "held_abandoned"),
        streams: { ...streamEnd },
        ms: {
          terminalToLeaderExit: t && leaderExitAt !== null ? Math.round(leaderExitAt - t.at) : null,
          leaderExitToStdoutEof: int(d0?.streams?.stdout?.endMs),
          leaderExitToStderrEof: int(d0?.streams?.stderr?.endMs),
          leaderExitToDone: int(d0?.doneMs)
        },
        signals: { leader: sigNames(facts.signalsToLeader), group: sigNames((d0?.signals ?? []).filter((x) => x?.target === "group").map((x) => x.sig)) },
        framing: { count: collector.errorCount, codes: [...new Set(collector.errors.flatMap((e) => (e.kind === "error" ? [e.code] : [])))] },
        counts: { frames: collector.frameCount, stdoutBytes, stderrBytes,
          cappedStreams: (d0?.streams?.stdout?.capped === true ? 1 : 0) + (d0?.streams?.stderr?.capped === true ? 1 : 0) }
      }
    });
  }

  if (spec.session) drive(() => spec.session!.start(io));
  return { stop: () => stop("user"), result };
}
