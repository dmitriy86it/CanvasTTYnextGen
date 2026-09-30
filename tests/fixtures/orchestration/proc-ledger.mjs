// Accounting of processes a test created itself. Primary: pids we know (tracked here + the ledger file
// the mocks append to via env MOCK_LEDGER, one JSON line {pid,label} per process they start, own pid included).
// Probe: kill(pid, 0) -> ESRCH gone, success alive, EPERM unverifiable (exists but not signalable by us;
// for a pid of our own uid that means it was reused by a foreign process — our process is most likely gone,
// but that is not proven, so it is reported, never counted as "gone").
// Secondary: psByMarker() — a global look by marker; unavailable (EPERM/ENOENT/sandbox) is reported as such.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export class ProcLedger {
  constructor(file = null) {
    this.file = file; // MOCK_LEDGER path, may not exist yet
    this.own = new Map(); // key "pid" or "-pgid" -> label
  }

  // group: true tracks a process group (probe kill(-pgid, 0)).
  track(pid, label, { group = false } = {}) {
    if (Number.isInteger(pid) && pid > 0) this.own.set(group ? -pid : pid, label);
  }

  read() {
    let text = "";
    try { text = fs.readFileSync(this.file, "utf8"); } catch (e) { if (this.file && e.code !== "ENOENT") throw e; }
    for (const l of text.split("\n")) {
      if (!l) continue;
      const { pid, label } = JSON.parse(l);
      if (!this.own.has(pid)) this.track(pid, label);
    }
    return [...this.own].map(([pid, label]) => ({ pid, label }));
  }

  check() {
    const r = { alive: [], gone: [], unverifiable: [] };
    for (const e of this.read()) {
      try { process.kill(e.pid, 0); r.alive.push(e); } catch (err) {
        if (err.code === "ESRCH") r.gone.push(e);
        else r.unverifiable.push({ ...e, code: err.code });
      }
    }
    return r;
  }

  async waitGone(ms = 3000) {
    const until = Date.now() + ms;
    let r = this.check();
    while (r.alive.length && Date.now() < until) { await sleep(25); r = this.check(); }
    return r;
  }

  // Emergency cleanup: SIGKILL only what this ledger knows and still answers kill(0).
  // ponytail: a pid long gone could in theory be reused by an unrelated process of ours; call this only
  // right after a failed waitGone in the same test, not hours later.
  killOwn() {
    const killed = [];
    for (const e of this.check().alive) { try { process.kill(e.pid, "SIGKILL"); killed.push(e); } catch {} }
    return killed;
  }
}

// Human-readable summary; the caller decides what fails. alive => failure; unverifiable => marked, not a pass.
export function describe(r) {
  const fmt = (xs) => xs.map((e) => `${e.label}:${e.pid}${e.code ? `(${e.code})` : ""}`).join(" ");
  return `gone=${r.gone.length} alive=${r.alive.length} unverifiable=${r.unverifiable.length}` +
    (r.alive.length ? ` ALIVE[${fmt(r.alive)}]` : "") + (r.unverifiable.length ? ` UNVERIFIABLE[${fmt(r.unverifiable)}]` : "");
}

// Global secondary check. Never throws: {available:false, error} when ps cannot run or is not allowed.
export function psByMarker(mark, { ps = "ps" } = {}) {
  let out;
  try {
    out = execFileSync(ps, ["-axo", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
  } catch (e) {
    return { available: false, error: e.code ?? (e.status != null ? `exit ${e.status}: ${String(e.stderr).trim().slice(0, 200)}` : String(e)) };
  }
  const pids = out.split("\n").filter((l) => l.includes(mark))
    .map((l) => +l.trim().split(/\s+/)[0]).filter((p) => p && p !== process.pid);
  return { available: true, pids };
}

// Shared test helper: diagnostics for unverifiable/unavailable; fails only for really alive own pids
// (ledger, or marker-carrying pids when ps works).
// t: node:test context (or null in hooks). Returns the final check result.
export async function assertNoneAlive(t, ledger, { ms = 3000, mark = null, ps } = {}) {
  const say = (s) => (t ? t.diagnostic(s) : console.log(`# ${s}`));
  let r = await ledger.waitGone(ms);
  if (r.alive.length) {
    const killed = ledger.killOwn();
    say(`cleanup: SIGKILL own ${killed.map((e) => `${e.label}:${e.pid}`).join(" ")}`);
    const after = await ledger.waitGone(1000);
    say(`after cleanup: ${describe(after)}`);
  }
  if (r.unverifiable.length) say(`UNVERIFIABLE (not counted as clean): ${describe(r)}`);
  let marked = [];
  if (mark) {
    const g = psByMarker(mark, { ps });
    if (!g.available) say(`global check unavailable: ${g.error}`);
    else marked = g.pids; // carry this run's marker: ours, even if not in the ledger
  }
  if (r.alive.length) throw new Error(`own processes still alive after ${ms} ms: ${describe(r)}`);
  if (marked.length) throw new Error(`processes with marker ${mark} still running: ${marked.join(" ")}`);
  return r;
}
