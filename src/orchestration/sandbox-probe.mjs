// Trusted self-test probe for the check sandbox (docs/agent-orchestration/implementation/stage-4-contract.md §3).
// Shipped outside the asar next to supervisor.mjs and launched as
// { command: process.execPath, args: [sandbox-probe.mjs, <spec json>], env: { ELECTRON_RUN_AS_NODE: "1" } }.
//
// The SAME file runs twice per self-test: once outside the sandbox (the positive control that the resource exists and
// the operation works) and once inside it (the expected denial). It therefore contains no project code and knows no
// layout: every path, host and port comes from the spec in argv, never from a constant or from the environment.
//
// Usage: <node> sandbox-probe.mjs '<spec json>'
//   spec = { ops: [{ name, op, ...args }, ...], out?: "<file>" }
// Prints exactly one JSON line: {"results":[{ name, ok, detail, results? }, ...]} and, when `out` is given, writes the
// same JSON there (the only way to collect a detached descendant's verdict once its parents are gone).
// Exit code is 0 whenever the spec was understood: a refused operation is a result, not a failure of the probe.
import { spawn, spawnSync } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

const NET_TIMEOUT_MS = 4000;
const CHILD_TIMEOUT_MS = 30_000;
const DETACH_DELAY_S = 1; // the sandboxed parent tree is gone by the time the escapee runs

const self = fileURLToPath(import.meta.url);
const die = (m) => { process.stdout.write(JSON.stringify({ error: m }) + "\n"); process.exit(2); };

// Node reports a refusal as an error event, so every net op is "resolve = the resource was reachable".
function withTimeout(start) {
  return new Promise((resolve, reject) => {
    const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => reject(new Error("TIMEOUT")), NET_TIMEOUT_MS);
    start(done(resolve), done(reject));
  });
}

const connect = (target) => withTimeout((ok, bad) => {
  const s = net.connect(target);
  s.on("connect", () => { s.destroy(); ok(); });
  s.on("error", bad);
});

const listen = (target, after) => withTimeout((ok, bad) => {
  const s = net.createServer();
  s.on("error", bad);
  s.listen(target, () => s.close(() => { after?.(); ok(); }));
});

// A Unix socket path is limited to ~104 bytes, well below a run directory's length, so the bind is relative to the
// directory the socket belongs in. The cwd is restored whatever happens: later ops use relative paths of their own.
async function listenUnix(target) {
  const cwd = process.cwd();
  const dir = target.slice(0, target.lastIndexOf("/"));
  const name = `./${target.slice(target.lastIndexOf("/") + 1)}`;
  process.chdir(dir);
  try {
    await listen(name, () => fs.rmSync(name, { force: true }));
  } finally {
    process.chdir(cwd);
  }
}

// One nested probe run: a grandchild through /bin/sh, so the shell layer is covered too. ELECTRON_RUN_AS_NODE is set
// here because the supervisor strips it from the target's environment on purpose.
function nested(spec) {
  const r = spawnSync("/bin/sh", ["-c", 'exec "$0" "$1" "$2"', process.execPath, self, JSON.stringify(spec)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: CHILD_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"]
  });
  const parsed = parse(r.stdout ?? "");
  if (parsed === null) throw new Error(`no probe output (status ${r.status}, signal ${r.signal}): ${(r.stderr ?? "").slice(0, 400)}`);
  return parsed;
}

const ops = {
  read: (o) => { fs.readFileSync(o.path); },
  readdir: (o) => { if (fs.readdirSync(o.path).length === 0 && o.nonEmpty) throw new Error("directory is empty"); },
  write: (o) => { fs.writeFileSync(o.path, "canvastty-sandbox\n"); },
  // Append of zero bytes: proves the file can be opened for writing without changing a byte of it.
  touch: (o) => { fs.appendFileSync(o.path, ""); },
  ptmx: () => { fs.closeSync(fs.openSync("/dev/ptmx", "r+")); },
  tcp: (o) => connect({ host: o.host, port: o.port }),
  "tcp-listen": () => listen({ host: "127.0.0.1", port: 0 }),
  dns: (o) => withTimeout((ok, bad) => dns.lookup(o.host, (e, a) => (e ? bad(e) : ok(a)))),
  "unix-connect": (o) => connect(o.path),
  "unix-listen": (o) => listenUnix(o.path),
  // Signal scoping, on which the check supervisor's sandbox scan rests: kill(pid, 0) must reach an own child and
  // must be refused for a process outside the sandbox. One positive pid only, never a group or a broadcast.
  signal: (o) => {
    if (!Number.isInteger(o.pid) || o.pid <= 1) throw new Error(`bad pid ${o.pid}`);
    process.kill(o.pid, 0);
  },
  "signal-child": () => new Promise((resolve, reject) => {
    const c = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    c.once("error", reject);
    c.once("spawn", () => {
      let refused = null;
      try { process.kill(c.pid, 0); } catch (e) { refused = e; }
      c.once("exit", () => (refused ? reject(refused) : resolve()));
      c.kill("SIGKILL");
    });
  }),
  child: (o) => ({ results: nested(o.spec) }),
  detach: (o) => {
    spawn("/bin/sh", ["-c", `sleep ${DETACH_DELAY_S}; exec "$0" "$1" "$2"`, process.execPath, self, JSON.stringify(o.spec)],
      { detached: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }).unref();
  }
};

function parse(text) {
  for (const line of text.split("\n").reverse()) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line);
      if (Array.isArray(v?.results)) return v.results;
    } catch { /* not our line */ }
  }
  return null;
}

const spec = (() => {
  try {
    return JSON.parse(process.argv[2] ?? "");
  } catch {
    return null;
  }
})();
if (!Array.isArray(spec?.ops)) die("spec must be {ops:[...]}");

const results = [];
for (const o of spec.ops) {
  if (typeof o?.name !== "string" || typeof ops[o?.op] !== "function") die(`bad op ${JSON.stringify(o?.op)}`);
  try {
    const extra = await ops[o.op](o);
    results.push({ name: o.name, ok: true, detail: "", ...extra });
  } catch (e) {
    results.push({ name: o.name, ok: false, detail: String(e?.code ?? e?.message ?? e).slice(0, 400) });
  }
}

const json = JSON.stringify({ results });
if (typeof spec.out === "string") {
  try {
    fs.writeFileSync(spec.out, json + "\n");
  } catch (e) {
    results.push({ name: "probe.out", ok: false, detail: String(e?.code ?? e) });
  }
}
process.stdout.write(json + "\n");
