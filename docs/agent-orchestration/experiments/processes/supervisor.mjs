// Per-run supervisor prototype. Usage: node supervisor.mjs <cmd> [args...]
// fd0: lifeline + control, one JSON command per line ({"cmd":"stop"}). EOF => main is gone => stop the group.
// fd1/fd2: handed straight to the target (no copying).
// fd3: status JSON lines to main (env names only, never values).
// fd4: task bytes, copied as-is to the target's stdin; EOF on fd4 => EOF on the target's stdin (not a stop).
//      Status: task_eof (fd4 EOF), task_written (target stdin finished), task_read_error / task_write_error.
//      Required: main passes a pipe, or "ignore" (/dev/null) for an empty task.
// Env: the target gets only names listed in SUP_ENV_ALLOW (comma-separated; default below),
//      never ELECTRON_RUN_AS_NODE or SUP_*.
// Only processes that stay in the target's process group are controlled (setsid/detached escapees are not).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const GRACE_INT_MS = Number(process.env.SUP_GRACE_INT_MS ?? 5000);
const GRACE_TERM_MS = Number(process.env.SUP_GRACE_TERM_MS ?? 3000);
const LEFTOVER_MS = Number(process.env.SUP_LEFTOVER_MS ?? 2000);
const KILL_WAIT_MS = 1000;
const MAX_CONTROL_LINE = 4096;
const DEFAULT_ALLOW = "PATH,HOME,USER,LOGNAME,SHELL,TMPDIR,LANG,LC_ALL,LC_CTYPE,TERM,TZ";
const denied = (name) => name === "ELECTRON_RUN_AS_NODE" || name.startsWith("SUP_");

const report = (o) => { try { fs.writeSync(3, JSON.stringify({ t: Date.now(), ...o }) + "\n"); } catch {} };
for (const s of ["SIGINT", "SIGHUP", "SIGTERM"]) process.on(s, () => {}); // only the lifeline/control stops us

// ---- state: handlers only record facts and wake run(); run() is the single termination path ----
let leaderExit = null; // { code, signal, at }
let spawnError = null;
let stop = null; // { reason: "command" | "lifeline_eof", at }
const signalsToLeader = []; // sent while the leader was not yet reaped
const signals = []; // every signal sent: { sig, target, at }
let wake = () => {};
const nap = (ms) => new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
const requestStop = (reason) => { if (!stop) { stop = { reason, at: Date.now() }; report({ ev: "stop_requested", reason }); wake(); } };

let taskFd;
try { taskFd = fs.fstatSync(4); } catch {}
if (!taskFd || !(taskFd.isFIFO() || taskFd.isSocket() || taskFd.isCharacterDevice() || taskFd.isFile())) {
  report({ ev: "done", error: "fd4_missing", leaderExit: null, stopRequested: false, groupCleared: true });
  process.exit(2);
}

const allow = (process.env.SUP_ENV_ALLOW ?? DEFAULT_ALLOW).split(",").map((s) => s.trim()).filter(Boolean);
const env = {};
for (const k of allow) if (!denied(k) && process.env[k] !== undefined) env[k] = process.env[k];

const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, { stdio: ["pipe", "inherit", "inherit"], detached: true, env });
const pgid = child.pid; // undefined if spawn failed
child.on("exit", (code, signal) => { leaderExit = { code, signal, at: Date.now() }; report({ ev: "leader_exit", code, signal }); wake(); });
child.on("error", (e) => { if (pgid === undefined && !spawnError) { spawnError = e.code ?? String(e); wake(); } });

// ---- task channel: fd4 -> child stdin ----
const task = taskFd.isFIFO() || taskFd.isSocket() ? new net.Socket({ fd: 4, readable: true, writable: false }) : fs.createReadStream(null, { fd: 4 });
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
}
async function waitGone(ms, interruptOnStop = false) {
  const until = Date.now() + ms;
  while (!gone() && Date.now() < until && !(interruptOnStop && stop)) await nap(Math.min(50, until - Date.now()));
  return gone();
}

async function run() {
  while (leaderExit === null && spawnError === null && stop === null) await nap(1000);
  if (spawnError === null) {
    if (leaderExit === null) {
      // Stop while running. Leader first: lets the CLI run its own cleanup (Codex SIGINT => interrupt).
      send("leader", stop.reason === "command" ? "SIGINT" : "SIGTERM");
      await waitGone(GRACE_INT_MS);
    } else {
      // Natural exit: descendants still in the group (e.g. holding stdout) get a moment; a Stop cuts it short.
      await waitGone(LEFTOVER_MS, true);
    }
    if (!gone()) { send("group", "SIGTERM"); await waitGone(GRACE_TERM_MS); }
    if (!gone()) { send("group", "SIGKILL"); await waitGone(KILL_WAIT_MS); }
  }
  // Status lines are written synchronously and done is the last one (exit follows in the same tick), so nothing
  // can come after it. With the leader gone a write still queued on its stdin fails (EPIPE) on the next poll:
  // wait for stdin to settle, bounded, so task_written / task_write_error are not lost behind done.
  for (const until = Date.now() + KILL_WAIT_MS; !stdinSettled && Date.now() < until;) await nap(until - Date.now());
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
  });
  process.exit(spawnError ? 1 : 0);
}

report({ ev: "started", pgid: pgid ?? null, env: Object.keys(env).sort() });
run();
