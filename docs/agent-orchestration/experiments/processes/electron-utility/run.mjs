// Does an Electron utilityProcess notice SIGKILL of the main process, and can it clean up its detached group?
// Usage: node run.mjs /path/to/electron-binary
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MARK = "CTTYEXP-" + randomBytes(4).toString("hex");
const LOG = path.join(HERE, `util-${MARK}.log`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(5)}ms]`, ...a);

const table = () => execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" })
  .split("\n").filter(Boolean).map((l) => { const [pid, ppid, pgid, ...c] = l.trim().split(/\s+/); return { pid: +pid, ppid: +ppid, pgid: +pgid, cmd: c.join(" ") }; });
function tree(root) {
  const all = table(); const out = []; const q = [root];
  while (q.length) { const p = q.shift(); for (const x of all) if (x.ppid === p) { out.push(x); q.push(x.pid); } }
  return out;
}
const alive = (pids) => { const set = new Set(table().map((x) => x.pid)); return pids.filter((p) => set.has(p)); };
const short = (x) => ({ pid: x.pid, ppid: x.ppid, pgid: x.pgid, cmd: x.cmd.replace(MARK, "MARK").replace(/^.*\/(Electron[^ ]*)/, "$1").slice(0, 70) });

const e = spawn(process.argv[2], [path.join(HERE, "main.cjs"), MARK], { env: { ...process.env, UTIL_LOG: LOG }, stdio: ["ignore", "pipe", "pipe"], detached: true });
let info = {};
e.stdout.on("data", (d) => { for (const l of d.toString().split("\n").filter(Boolean)) { log("electron:", l); try { Object.assign(info, JSON.parse(l.replace(/^util: /, ""))); } catch {} } });
e.stderr.resume();
for (let i = 0; i < 100 && !(info.utility && info.groupLeader); i++) await sleep(100);
await sleep(300);
const before = tree(e.pid);
log("tree before crash:"); before.forEach((x) => log("   ", JSON.stringify(short(x))));
const pids = [e.pid, ...before.map((x) => x.pid)];
process.kill(e.pid, "SIGKILL");
log("electron main SIGKILLed");
for (const ms of [300, 1500]) {
  await sleep(ms);
  const left = table().filter((x) => pids.includes(x.pid) || x.cmd.includes(MARK));
  log(`${ms}ms later still alive:`, left.length ? "" : "(none)"); left.forEach((x) => log("   ", JSON.stringify(short(x))));
}
log("utility log:\n" + (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").replace(/^\d+ /gm, "   ") : "(none)"));
// Cleanup: only pids captured from our own tree or carrying MARK.
for (const x of table().filter((x) => pids.includes(x.pid) || x.cmd.includes(MARK))) { try { process.kill(x.pid, "SIGKILL"); } catch {} }
await sleep(300);
log("after cleanup:", alive(pids).length, "of captured pids alive;", table().filter((x) => x.cmd.includes(MARK)).length, "MARK processes");
fs.rmSync(LOG, { force: true });
process.exit(0);
