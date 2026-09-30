// Per-turn supervisor for orchestration CLI runs. Shipped outside the asar (extraResources) and launched as
// { command: process.execPath, args: [supervisor.mjs, <cmd>, ...args], env: { ELECTRON_RUN_AS_NODE: "1", ... } };
// runs under Node 22+ and Electron's Node mode. Usage: node supervisor.mjs <cmd> [args...]
// fd0: lifeline + control, one JSON command per line ({"cmd":"stop"}). EOF => main is gone => stop the group.
// fd1/fd2: the target's stdout/stderr, relayed (target pipe -> fd, with backpressure) and closed as soon as the target
//      side ends, so main's EOF means the CLI side really closed, and never waits for the supervisor's own cleanup.
//      Status: stream_end { stream, status } when a stream ends; done.streams says for each how it ended:
//      "eof" (before any cleanup signal), "held_until_cleanup" (still open when the group was signalled after the
//      leader's exit: a group member held it) or "held_abandoned" (still open after the group was gone and a bounded
//      wait: held outside the group, e.g. a setsid escapee; the relay was cut so main gets EOF), "held_capped" (written
//      to past the read cap after the leader's exit, no group signal, holder unknown), or "relay_failed"
//      (writing to fd1/fd2 failed, or main was gone before every byte was written); `bytes` = bytes written to the fd.
//      Durations in done are integer ms since the leader's exit, measured here (never compared with main's clock).
// fd3: status JSON lines to main (env names only, never values).
// fd4: task bytes, copied as-is to the target's stdin; EOF on fd4 => EOF on the target's stdin (not a stop).
//      Status: task_eof (fd4 EOF), task_written (target stdin finished), task_read_error / task_write_error.
//      Required: main passes a pipe, or "ignore" (/dev/null) for an empty task.
// Env: the target gets the SUP_CHILD_ENV object when given, else only names listed in SUP_ENV_ALLOW (comma-separated;
//      default below); never ELECTRON_RUN_AS_NODE or SUP_*.
// Only processes that stay in the target's process group are controlled (setsid/detached escapees are not),
// unless SUP_SANDBOX_SWEEP=1: see sweepSandbox() below.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { Writable } from "node:stream";

const GRACE_INT_MS = Number(process.env.SUP_GRACE_INT_MS ?? 5000);
const GRACE_TERM_MS = Number(process.env.SUP_GRACE_TERM_MS ?? 3000);
const LEFTOVER_MS = Number(process.env.SUP_LEFTOVER_MS ?? 2000);
const KILL_WAIT_MS = 1000;
const STREAM_WAIT_MS = 1000; // with the group gone: how long a stream may stay open before it is abandoned
const MAX_CONTROL_LINE = 4096;
const SWEEP = process.env.SUP_SANDBOX_SWEEP === "1";
const SWEEP_MS = Number(process.env.SUP_SWEEP_MS ?? 3000);
const MAX_PID = 99999; // macOS PID_MAX
const DEFAULT_ALLOW = "PATH,HOME,USER,LOGNAME,SHELL,TMPDIR,LANG,LC_ALL,LC_CTYPE,TERM,TZ";
const denied = (name) => name === "ELECTRON_RUN_AS_NODE" || name.startsWith("SUP_");

// Sandbox guard, taken before anything is spawned: the parent is main (same uid, alive), so kill(ppid, 0) fails with
// EPERM only when Seatbelt scopes our signals, i.e. we run inside a sandbox with (allow signal (target same-sandbox)).
// Taken now, not at the sweep: after main's death ppid is launchd (root), which gives EPERM without any sandbox.
const startPpid = process.ppid;
const signalProbe = (pid) => { try { process.kill(pid, 0); return "ok"; } catch (e) { return e.code; } };
const zombie = (pid) => { try { os.getPriority(pid); return false; } catch (e) { return e.info?.code === "ESRCH"; } };
const sandboxedAtStart = SWEEP && startPpid > 1 && signalProbe(startPpid) === "EPERM";

const report = (o) => { try { fs.writeSync(3, JSON.stringify({ t: Date.now(), ...o }) + "\n"); } catch {} };
for (const s of ["SIGINT", "SIGHUP", "SIGTERM"]) process.on(s, () => {}); // only the lifeline/control stops us

// ---- state: handlers only record facts and wake run(); run() is the single termination path ----
let leaderExit = null; // { code, signal, at }
let spawnError = null;
let stop = null; // { reason: "command" | "lifeline_eof", at }
const signalsToLeader = []; // sent while the leader was not yet reaped
const signals = []; // every signal sent: { sig, target, at }
let cleanupStarted = false; // a group signal was sent after the leader's exit: what holds a stream now is not the leader
let wake = () => {};
const nap = (ms) => new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
const requestStop = (reason) => { if (!stop) { stop = { reason, at: Date.now() }; report({ ev: "stop_requested", reason }); wake(); } };

let taskFd;
try { taskFd = fs.fstatSync(4); } catch {}
if (!taskFd || !(taskFd.isFIFO() || taskFd.isSocket() || taskFd.isCharacterDevice() || taskFd.isFile())) {
  report({ ev: "done", error: "fd4_missing", leaderExit: null, stopRequested: false, groupCleared: true });
  process.exit(2);
}

// Opened before anything is spawned: an fd4 that is not a real task channel (e.g. stdio "ignore" leaves fd4 to one of
// node's own descriptors, which net.Socket refuses with ENOTTY) is a clean error, not a crash with a started target.
let task;
try {
  task = taskFd.isFIFO() || taskFd.isSocket() ? new net.Socket({ fd: 4, readable: true, writable: false }) : fs.createReadStream(null, { fd: 4 });
} catch (e) {
  report({ ev: "done", error: "fd4_unusable", code: e.code ?? null, leaderExit: null, stopRequested: false, groupCleared: true });
  process.exit(2);
}

// SUP_CHILD_ENV (JSON object of strings): the target's whole environment, e.g. the user's login shell environment with
// NODE_OPTIONS or NODE_EXTRA_CA_CERTS, which must reach the CLI without configuring this node process.
const env = {};
let childEnv = null;
try { childEnv = process.env.SUP_CHILD_ENV ? JSON.parse(process.env.SUP_CHILD_ENV) : null; } catch { childEnv = null; }
if (childEnv && typeof childEnv === "object" && !Array.isArray(childEnv)) {
  for (const [k, v] of Object.entries(childEnv)) if (!denied(k) && typeof v === "string") env[k] = v;
} else {
  const allow = (process.env.SUP_ENV_ALLOW ?? DEFAULT_ALLOW).split(",").map((s) => s.trim()).filter(Boolean);
  for (const k of allow) if (!denied(k) && process.env[k] !== undefined) env[k] = process.env[k];
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  report({ ev: "done", error: "no_command", leaderExit: null, stopRequested: false, groupCleared: true });
  process.exit(2);
}
const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], detached: true, env });
const pgid = child.pid; // undefined if spawn failed
child.on("exit", (code, signal) => { leaderExit = { code, signal, at: Date.now() }; report({ ev: "leader_exit", code, signal }); wake(); });
child.on("error", (e) => { if (pgid === undefined && !spawnError) { spawnError = e.code ?? String(e); wake(); } });

// ---- task channel: fd4 -> child stdin ----
task.on("error", (e) => report({ ev: "task_read_error", code: e.code }));
task.on("end", () => report({ ev: "task_eof" })); // registered before pipe(): always precedes task_written
// task_written: every byte was handed to the target's stdin pipe and the pipe was closed. A pipe write is not
// a read: the target may still never have read it (small tasks fit in the pipe buffer).
let stdinSettled = false; // finished, failed or closed: its status line (if any) is already on fd3
const settle = () => { stdinSettled = true; wake(); };
child.stdin.on("finish", () => { report({ ev: "task_written" }); settle(); });
child.stdin.on("close", settle);
child.stdin.on("error", (e) => {
  // EPIPE etc.: target gone or never started. Keep draining fd4 so main never blocks on it.
  report({ ev: "task_write_error", code: e.code });
  task.unpipe(child.stdin);
  task.resume();
  settle();
});
task.pipe(child.stdin); // ends child stdin on fd4 EOF

// ---- output relay: target stdout/stderr -> fd1/fd2 ----
// fd1/fd2 may be a pipe, a socket (non-blocking here: fs.WriteStream gives up on EAGAIN; net.Socket is refused inside
// the check sandbox with ENOTTY), a file or /dev/null: plain fs.write, retried on EAGAIN. The target side's end ends
// the relay, which closes the fd once every buffered byte is written.
// A relay that fails or is cut with bytes not yet written makes the stream "relay_failed", never "eof"; `bytes` counts
// what reached fd1/fd2, so main can check it against what it read.
function fdWriter(fd, count) {
  let open = true;
  // main sees EOF when the fd closes; the number itself stays taken by /dev/null (closed and reopened in one synchronous
  // step: open() takes the lowest free number, and 0 stays the control channel), so nothing opened later (a socket, the
  // sweep, node itself) becomes fd1/fd2 and gets node's own late output, e.g. an uncaught exception on stderr.
  const close = (cb) => {
    if (!open) return cb();
    open = false;
    try { fs.closeSync(fd); } catch {}
    try {
      const got = fs.openSync("/dev/null", "w");
      if (got !== fd) { fs.closeSync(got); report({ ev: "relay_fd_not_held", fd }); }
    } catch (e) { report({ ev: "relay_fd_not_held", fd, code: e.code }); }
    cb();
  };
  return new Writable({
    write(chunk, _enc, cb) {
      const go = (off) => fs.write(fd, chunk, off, chunk.length - off, null, (e, n) => {
        if (e && e.code !== "EAGAIN") return cb(e);
        if (!e) { off += n; count.bytes += n; }
        if (off >= chunk.length) cb();
        else if (e) setTimeout(go, 5, off); // the pipe is full: main reads it
        else go(off);
      });
      go(0);
    },
    final: (cb) => close(() => cb()),
    destroy: (err, cb) => close(() => cb(err)),
  });
}
// While the leader runs, reading follows main (backpressure). After the leader's exit the target side is read at once,
// whatever main's pace, so its EOF is seen on its own time and a stream's status never depends on main's speed: what
// is left then is the pipe's buffer plus whatever descendants still write. AFTER_EXIT_CAP bounds that memory: past it
// someone keeps writing after the leader's exit, reading stops (the stream stays open: "capped"), and the cleanup
// decides as for any holder. What was read is always handed to main; only the unread rest of a capped or abandoned
// stream is lost, and that turn has failed anyway.
// Per stream. Far above what the leader can leave in the pipe (its buffer, 64 KiB at most); small enough that a slow main
// (a few ms per line) still gets through what was read in seconds, not minutes.
const AFTER_EXIT_CAP = 1024 * 1024;
const streams = {};
for (const [name, fd] of [["stdout", 1], ["stderr", 2]]) {
  const src = child[name];
  const s = streams[name] = { src, dst: null, endAt: null, status: null, closed: false, bytes: 0, afterExit: 0, capped: false, dead: false };
  const dst = s.dst = fdWriter(fd, s);
  dst.on("error", (e) => {
    // Main is gone (EPIPE) or the fd is unusable: keep draining the target so it never blocks on a full pipe.
    report({ ev: "relay_error", stream: name, code: e.code });
    if (s.status === null || s.status === "eof") s.status = "relay_failed";
    s.dead = true;
    src.resume();
  });
  dst.on("drain", () => { if (!s.capped && !s.dead) src.resume(); });
  dst.on("close", () => { s.closed = true; wake(); });
  src.on("data", (d) => {
    if (s.dead) return;
    const more = dst.write(d);
    if (leaderExit === null) { if (!more) src.pause(); return; }
    s.afterExit += d.length;
    if (s.afterExit > AFTER_EXIT_CAP && !s.capped) { s.capped = true; src.pause(); report({ ev: "stream_capped", stream: name }); }
  });
  src.on("error", () => {}); // followed by close
  src.on("close", () => {
    if (s.endAt !== null) return;
    s.endAt = Date.now();
    // An EOF already in the pipe but handled in the same tick as the group's SIGTERM counts as held: that can only turn
    // a success into a failure, never the other way round.
    s.status ??= cleanupStarted ? "held_until_cleanup" : "eof";
    report({ ev: "stream_end", stream: name, status: s.status });
    if (!dst.writableEnded && !dst.destroyed) dst.end();
    wake();
  });
}
child.on("exit", () => { for (const s of Object.values(streams)) if (!s.capped && !s.dead) s.src.resume(); });
const streamsEnded = () => streams.stdout.endAt !== null && streams.stderr.endAt !== null;
const relaysClosed = () => streams.stdout.closed && streams.stderr.closed;

// ---- control channel: fd0, whole lines only ----
let line = "";
let overlong = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  let start = 0;
  for (let nl = d.indexOf("\n"); nl >= 0; nl = d.indexOf("\n", start)) {
    const whole = overlong ? null : line + d.slice(start, nl);
    line = ""; overlong = false; start = nl + 1;
    if (whole !== null) control(whole.replace(/\r$/, ""));
  }
  if (!overlong) { line += d.slice(start); if (line.length > MAX_CONTROL_LINE) { line = ""; overlong = true; report({ ev: "control_overlong" }); } }
});
process.stdin.on("end", () => { report({ ev: "lifeline_eof" }); requestStop("lifeline_eof"); });
process.stdin.on("error", () => requestStop("lifeline_eof"));

function control(text) {
  if (text.trim() === "") return;
  let msg;
  try { msg = JSON.parse(text); } catch {}
  if (msg && msg.cmd === "stop") return requestStop("command");
  report({ ev: "control_ignored" });
}

// ---- signalling ----
const groupAlive = () => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const gone = () => leaderExit !== null && !groupAlive();
function send(target, sig) {
  // Leader by pid only while unreaped (pid cannot be reused yet); group only while it still has members.
  if (target === "leader" ? leaderExit !== null : !groupAlive()) return;
  try { process.kill(target === "leader" ? pgid : -pgid, sig); } catch { return; }
  signals.push({ sig, target, at: Date.now() });
  if (leaderExit === null) signalsToLeader.push(sig);
  else if (target === "group") {
    cleanupStarted = true;
    for (const st of Object.values(streams)) if (st.endAt === null && st.capped) st.status ??= "held_until_cleanup"; // it never reaches EOF: reading stopped
  }
}
async function waitFor(cond, ms, interruptOnStop = false) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until && !(interruptOnStop && stop)) await nap(Math.min(50, until - Date.now()));
  return cond();
}
const waitGone = (ms) => waitFor(gone, ms);

// Opt-in (SUP_SANDBOX_SWEEP=1, project checks): the supervisor itself runs inside the check's sandbox instance, where
// kill(pid, 0) succeeds only for processes of that same instance (EPERM for every other process, ESRCH for none).
// A full pid scan therefore finds everything the target left behind, setsid escapees and platform binaries
// included, and nothing else. Only pids found by a completed scan are signalled, one by one; a pid reused by an
// outside process between the scan and the kill is refused by the sandbox itself (EPERM).
// Zombies answer kill(pid, 0) from inside ANY sandbox, whoever they belong to, so a hit counts only when
// getpriority() still finds the process: it skips zombies (ESRCH) and is not scoped by the sandbox. A zombie runs no
// code and keeps its pid until reaped, so leaving it is safe.
// A nested sandbox would hide a process from the scan; sandbox_apply is refused inside this profile.
async function sweepSandbox() {
  const res = { cleared: false, killed: 0, scans: 0, error: null };
  if (!sandboxedAtStart || signalProbe(process.ppid) !== "EPERM") return { ...res, error: "not_sandboxed" };
  const outside = new Set([startPpid, process.ppid]);
  const deadline = Date.now() + SWEEP_MS;
  for (let empty = 0; ;) {
    const found = [];
    for (let pid = 2; pid <= MAX_PID; pid++) if (pid !== process.pid && signalProbe(pid) === "ok" && !zombie(pid)) found.push(pid);
    res.scans++;
    // A process known to be outside answered: the scoping does not hold, so nothing may be signalled.
    if (found.some((pid) => outside.has(pid))) return { ...res, error: "not_sandboxed" };
    // ponytail: a process that forks and exits faster than one scan (~200 ms) can slip past a single scan; two
    // consecutive empty scans narrow that window. Closing it needs freezing the sandbox, impossible without privileges.
    if (found.length === 0) { if (++empty === 2) return { ...res, cleared: true }; continue; }
    empty = 0;
    for (const pid of found) { try { process.kill(pid, "SIGKILL"); res.killed++; } catch {} }
    if (Date.now() >= deadline) return { ...res, error: "deadline" };
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sinceLeaderExit = (at) => (leaderExit && at !== null ? Math.round(at - leaderExit.at) : null);

async function run() {
  while (leaderExit === null && spawnError === null && stop === null) await nap(1000);
  if (spawnError === null) {
    if (leaderExit === null) {
      // Stop while running. Leader first: lets the CLI run its own cleanup (Codex SIGINT => interrupt).
      send("leader", stop.reason === "command" ? "SIGINT" : "SIGTERM");
      await waitGone(GRACE_INT_MS);
    } else {
      // Natural exit: descendants still in the group and the output streams get a moment; a Stop cuts it short.
      await waitFor(() => gone() && streamsEnded(), LEFTOVER_MS, true);
    }
    if (!gone()) { send("group", "SIGTERM"); await waitGone(GRACE_TERM_MS); }
    if (!gone()) { send("group", "SIGKILL"); await waitGone(KILL_WAIT_MS); }
  }
  // Whatever still holds a stream now is outside the group (or unkillable): bounded wait, then the relay is cut.
  // A Stop, timeout or lifeline EOF that comes during this wait ends it.
  const stopBefore = stop;
  await waitFor(() => streamsEnded() || stop !== stopBefore, STREAM_WAIT_MS);
  // Capped without any group signal: someone kept writing after the leader's exit, but whether from inside the group
  // (and gone since) or from outside it is not known: "held_capped", not "held_abandoned".
  for (const s of Object.values(streams)) if (s.endAt === null) { s.status ??= s.capped ? "held_capped" : "held_abandoned"; s.src.destroy(); }
  // The last buffered bytes reach main. Not cut on a timer (main may be busy for a while): it ends when main has read
  // them, or when main is gone (EPIPE on the relay, lifeline EOF); main's own guard bounds the whole turn.
  while (!relaysClosed() && stop?.reason !== "lifeline_eof") await nap(1000);
  for (const s of Object.values(streams)) {
    if (s.closed) continue;
    if (s.status === null || s.status === "eof") s.status = "relay_failed";
    s.dst.destroy();
  }
  // Status lines are written synchronously and done is the last one (exit follows in the same tick), so nothing
  // can come after it. With the leader gone a write still queued on its stdin fails (EPIPE) on the next poll:
  // wait for stdin to settle, bounded, so task_written / task_write_error are not lost behind done.
  for (const until = Date.now() + KILL_WAIT_MS; !stdinSettled && Date.now() < until;) await nap(until - Date.now());
  // Every path, spawn error included: sandbox-exec has already exec'd us, and one uniform answer is simpler than
  // proving that nothing started.
  const sandbox = SWEEP ? await sweepSandbox() : undefined;
  report({
    ev: "done",
    ...(spawnError ? { error: "spawn", code: spawnError } : {}),
    leaderExit,
    stopRequested: stop !== null,
    stopReason: stop?.reason ?? null,
    stopRequestedAt: stop?.at ?? null,
    stopAfterLeaderExit: stop !== null && leaderExit !== null && stop.at >= leaderExit.at,
    signalsToLeader,
    signals,
    groupCleared: spawnError !== null || gone(),
    streams: Object.fromEntries(Object.entries(streams).map(([k, s]) => [k, { status: s.status, endMs: sinceLeaderExit(s.endAt), bytes: s.bytes, capped: s.capped }])),
    doneMs: sinceLeaderExit(Date.now()),
    ...(sandbox ? { sandbox } : {}),
  });
  process.exit(spawnError ? 1 : 0);
}

report({ ev: "started", pgid: pgid ?? null, env: Object.keys(env).sort() });
run();
