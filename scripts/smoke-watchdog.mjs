// A hard time limit for a smoke or e2e script that starts Electron: SMOKE_TIMEOUT_MS, 10 minutes by default. Armed by
// the first step() or watch(). When it fires it prints the last step of the scenario, the live processes under this
// one (ps over the tree) and the last 50 lines of stdout and stderr of every watched process, then kills that tree
// and exits with 124. The timer never keeps a finished script alive.
// ponytail: an in-process timer; a script blocked in a synchronous call (execFileSync without a timeout) is not caught.
import { execFileSync } from "node:child_process";

export const SMOKE_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 10 * 60_000;
const TAIL_BYTES = 256 * 1024;
let last = "(no step yet)";
let timer = null;
const watched = [];

function arm() {
  if (timer) return;
  timer = setTimeout(fire, SMOKE_TIMEOUT_MS);
  timer.unref();
}

// The step the scenario is at now: what the report names if the limit is reached.
export function step(what) {
  last = what;
  arm();
}

// Keeps the tail of a child's stdout and stderr (next to whatever else reads them).
export function watch(child, name = "app") {
  arm();
  const w = { name: `${name} (pid ${child.pid})`, stdout: "", stderr: "" };
  watched.push(w);
  for (const k of ["stdout", "stderr"]) child[k]?.on("data", (c) => { w[k] = (w[k] + c).slice(-TAIL_BYTES); });
  return child;
}

// pid, ppid and command of every process under `root`, parents first.
export function processTree(root = process.pid) {
  const rows = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8", timeout: 10_000 }).split("\n").flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m && !(Number(m[2]) === process.pid && m[3].startsWith("/bin/ps -A")) ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : []; // not this ps
  });
  const out = [];
  const seen = new Set([root]);
  for (let added = true; added;) {
    added = false;
    for (const r of rows) if (!seen.has(r.pid) && seen.has(r.ppid)) { seen.add(r.pid); out.push(r); added = true; }
  }
  return out;
}

function fire() {
  const say = (s) => process.stderr.write(`${s}\n`);
  say(`\n[smoke-watchdog] time limit of ${Math.round(SMOKE_TIMEOUT_MS / 1000)} s reached (SMOKE_TIMEOUT_MS)`);
  say(`[smoke-watchdog] last step: ${last}`);
  let tree = [];
  try { tree = processTree(); } catch (e) { say(`[smoke-watchdog] ps failed: ${e?.message ?? e}`); }
  say(`[smoke-watchdog] live child processes (${tree.length}):`);
  for (const p of tree) say(`  ${p.pid} <- ${p.ppid}  ${p.command.slice(0, 300)}`);
  for (const w of watched) {
    for (const k of ["stdout", "stderr"]) {
      say(`[smoke-watchdog] ${w.name} ${k}, last 50 lines:`);
      say(w[k].split("\n").slice(-51).join("\n").trimEnd() || "  (empty)");
    }
  }
  for (const p of tree.reverse()) { try { process.kill(p.pid, "SIGKILL"); } catch {} }
  process.exit(124);
}
