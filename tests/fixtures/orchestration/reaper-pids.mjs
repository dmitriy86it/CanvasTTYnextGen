// Guaranteed cleanup of the processes a test created itself, and nothing else. Every pid comes from the test's own
// bookkeeping (a pid file or a spawn result) together with a substring of the command it must still be running;
// cleanup() confirms that via `ps -o command= -p <pid>` before a signal (pid reuse), sends SIGKILL to that pid only
// and waits for ESRCH. Never a name match, never a negative pid, never kill(-1).
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export const probe = (pid) => {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    return e.code === "ESRCH" ? "gone" : "unverifiable";
  }
};
export const alive = (pid) => probe(pid) !== "gone"; // EPERM is not proof of death

export function commandOf(pid) {
  try {
    return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null; // ps exits 1 for a pid that does not exist
  }
}

export async function waitDead(pid, ms = 5000) {
  for (const until = Date.now() + ms; alive(pid) && Date.now() < until;) await sleep(25);
  return !alive(pid);
}

export class OwnPids {
  constructor() { this.own = new Map(); } // pid -> expected command substring

  track(pid, expect) {
    if (!Number.isInteger(pid) || pid <= 1 || typeof expect !== "string" || expect === "") throw new Error(`bad pid ${pid}`);
    this.own.set(pid, expect);
    return pid;
  }

  // Returns what had to be killed: an empty list is the normal outcome of a passing test.
  async cleanup() {
    const killed = [], stuck = [];
    for (const [pid, expect] of this.own) {
      if (!alive(pid)) continue;
      const cmd = commandOf(pid);
      if (cmd === null || !cmd.includes(expect)) continue; // gone meanwhile or reused by another program
      try { process.kill(pid, "SIGKILL"); killed.push(`${pid} ${cmd}`); } catch {}
      if (!(await waitDead(pid))) stuck.push(pid);
    }
    this.own.clear();
    if (stuck.length) throw new Error(`own processes survived SIGKILL: ${stuck.join(" ")}`);
    return killed;
  }
}
