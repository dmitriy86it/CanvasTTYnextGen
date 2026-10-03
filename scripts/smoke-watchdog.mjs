// A hard time limit for a smoke or e2e script that starts Electron: SMOKE_TIMEOUT_MS, 10 minutes by default. Armed by
// the first step() or watch(). When it fires it prints the last step of the scenario, the live processes under this
// one (ps over the tree) and the last 50 lines of stdout and stderr of every watched process, then kills that tree
// and exits with 124. The timer never keeps a finished script alive.
// ponytail: an in-process timer; a script blocked in a synchronous call (execFileSync without a timeout) is not caught.
//
// Hermetic runs: hermeticEnv() is the environment of the development app in a smoke (PATH = the refusing fake CLIs of
// tests/fixtures/smoke-bin and the system folders; CANVASTTY_SMOKE_HERMETIC=1, so the app looks for provider CLIs in
// PATH only and polls no provider's limits; node named by absolute path). watch(child, name, { check: true }) samples
// the processes under the child; a program outside the fakes and the allowed list fails the script at exit.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// Keeps the tail of a child's stdout and stderr (next to whatever else reads them). check: sample the processes under
// it (checkProcesses); report: say what is found but do not fail (a packaged app ignores CANVASTTY_SMOKE_HERMETIC);
// allow: more allowed folders (a packaged app's bundle).
export function watch(child, name = "app", { check = false, report = false, allow = [] } = {}) {
  arm();
  const w = { name: `${name} (pid ${child.pid})`, stdout: "", stderr: "" };
  watched.push(w);
  for (const k of ["stdout", "stderr"]) child[k]?.on("data", (c) => { w[k] = (w[k] + c).slice(-TAIL_BYTES); });
  if (check && child.pid) {
    const seen = new Set();
    const roots = [...ALLOWED, ...allow.map((a) => `${real(a)}/`)];
    const sample = () => {
      try {
        for (const v of checkProcesses(child.pid, roots, seen)) (report ? reported : foreign).push({ ...v, app: w.name });
      } catch { /* ps or lsof unavailable for a moment: the next sample */ }
    };
    const t = setInterval(sample, SAMPLE_MS);
    t.unref();
    child.once?.("exit", () => clearInterval(t));
    sample();
  }
  return child;
}

// ---------- hermetic smoke runs ----------

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const SMOKE_BIN = path.join(ROOT, "tests", "fixtures", "smoke-bin");
// checks and preparation of the test runtime run through it: no login, so no path_helper putting Homebrew back in PATH
const SMOKE_SHELL = path.join(ROOT, "tests", "fixtures", "smoke-shell.sh");
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const NODE = real(process.execPath);
export const HERMETIC_PATH = [SMOKE_BIN, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

// The development app's environment in a smoke: PATH without user or Homebrew folders, the hermetic switch, node by
// its absolute path, the system shell (checks: a shell without login). `extra` (HOME, providers, …) comes last.
export function hermeticEnv(extra = {}) {
  return { ...process.env, PATH: HERMETIC_PATH, SHELL: "/bin/sh", CANVASTTY_SMOKE_HERMETIC: "1", CANVASTTY_SMOKE_NODE: NODE, CANVASTTY_SMOKE_SHELL: SMOKE_SHELL, ...extra };
}

// Where a program the app starts may live: the system, this repository's Electron, sources, build and fixtures, the
// node and git named for the run, and the temporary folders the smokes write their fake programs into.
const SAMPLE_MS = 500;
const ALLOWED = [
  "/bin/", "/usr/bin/", "/usr/sbin/", "/sbin/", "/usr/libexec/", "/usr/lib/", "/lib/", "/System/",
  "/Library/Developer/CommandLineTools/", "/Applications/Xcode.app/", // git behind the /usr/bin/git shim
  ...["node_modules/electron/", "src/", "out/", "tests/fixtures/", "scripts/"].map((d) => `${real(ROOT)}/${d}`),
  NODE, real("/usr/bin/git"),
  `${real(os.tmpdir())}/`, "/private/tmp/", "/tmp/", "/private/var/folders/"
];
const INTERPRETERS = new Set(["node", "sh", "bash", "zsh", "dash", "python", "python3", "perl", "ruby"]);
const foreign = [];
const reported = [];

// The executable of each process (its file, not its argv[0]): lsof's txt on macOS, /proc/<pid>/exe on Linux.
function executables(pids) {
  const out = new Map();
  if (!pids.length) return out;
  if (process.platform === "linux") {
    for (const pid of pids) { try { out.set(pid, fs.readlinkSync(`/proc/${pid}/exe`)); } catch { /* gone */ } }
    return out;
  }
  const r = spawnSync("/usr/sbin/lsof", ["-nP", "-a", "-d", "txt", "-p", pids.join(","), "-Fpn"], { encoding: "utf8", timeout: 10_000 });
  let pid = null;
  for (const l of (r.stdout ?? "").split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && pid !== null && !out.has(pid)) out.set(pid, l.slice(1));
  }
  return out;
}

// Processes under `rootPid` not seen before whose program (or, for an interpreter, its script) is outside `roots`.
// ponytail: a sample every 500 ms misses a program that lives shorter than that; a long-lived one (an app-server, a
// daemon) is what costs quota and outlives the run.
export function checkProcesses(rootPid, roots = ALLOWED, seen = new Set()) {
  const ok = (p) => roots.some((r) => (r.endsWith("/") ? p.startsWith(r) : p === r));
  // keyed by pid and command line: a process that execs another program is looked at again
  const fresh = processTree(rootPid).filter((p) => !seen.has(`${p.pid} ${p.command}`));
  const exe = executables(fresh.map((p) => p.pid));
  const out = [];
  for (const p of fresh) {
    seen.add(`${p.pid} ${p.command}`);
    const file = exe.get(p.pid);
    if (!file) continue; // gone before lsof saw it
    const args = p.command.split(/\s+/).slice(1);
    // `sh -c "<command line>"` (and `node -e`) runs no script file: a "/word" in that line (a commit message's "/health:")
    // is not a program; what the line starts is a process of its own, looked at by itself
    const inline = args[0] === "-c" || args[0] === "-e";
    const script = INTERPRETERS.has(path.basename(file).replace(/\d+(\.\d+)*$/, "")) && !inline ? args.find((a) => a.startsWith("/")) : undefined;
    const bad = [file, script].filter((f) => f && !ok(real(f)));
    const key = `foreign ${p.pid} ${bad.join(" ")}`; // the same program under a changed command line is said once
    if (bad.length && !seen.has(key)) { seen.add(key); out.push({ pid: p.pid, program: bad.join(" "), command: p.command.slice(0, 300) }); }
  }
  return out;
}

process.on("exit", () => {
  const say = (s) => process.stderr.write(`${s}\n`);
  for (const [list, head] of [[reported, "reported only (packaged app)"], [foreign, "FAILED: the app started programs outside the fake CLIs and the allowed list"]]) {
    if (!list.length) continue;
    say(`\n[smoke-hermetic] ${head}:`);
    for (const v of list) say(`  ${v.app}: pid ${v.pid} ${v.program}\n    ${v.command}`);
  }
  if (foreign.length) process.exitCode = 1;
});

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
