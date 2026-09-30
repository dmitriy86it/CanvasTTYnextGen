// Stop/ownership experiments on our own toy processes only.
// Every process we start carries MARK in argv and CTTYEXP=<MARK> in env; cleanup kills only those.
// Usage: node stop-exp.mjs [a|b|c|c2|d|e|env|all]
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MARK = "CTTYEXP-" + randomBytes(4).toString("hex");
const ENV = { ...process.env, CTTYEXP: MARK };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(5)}ms]`, ...a);
// A long-lived node process tagged with MARK; optional code runs first.
const idle = (code = "") => `node -e '${code}setInterval(()=>{},1e3)' ${MARK}`;

function ours() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes(MARK) && !l.includes("ps -axo")).map((l) => {
    const [pid, ppid, pgid, stat, ...rest] = l.trim().split(/\s+/);
    return { pid: +pid, ppid: +ppid, pgid: +pgid, stat, cmd: rest.join(" ").replace(MARK, "MARK").slice(0, 90) };
  }).filter((p) => p.pid !== process.pid);
}
function show(label) { const p = ours(); log(label, p.length ? "" : "(none)"); for (const x of p) log("   ", JSON.stringify(x)); return p; }
function cleanup() {
  for (const p of ours()) { try { process.kill(p.pid, "SIGKILL"); } catch {} }
}
function watch(child, name) {
  const st = { bytes: 0, exit: null, end: false, close: false };
  child.stdout?.on("data", (d) => { st.bytes += d.length; });
  child.stdout?.on("end", () => { st.end = true; log(`${name}: stdout 'end' (bytes=${st.bytes})`); });
  child.on("exit", (c, s) => { st.exit = { c, s }; log(`${name}: 'exit' code=${c} signal=${s} (stdout bytes so far=${st.bytes})`); });
  child.on("close", (c, s) => { st.close = true; log(`${name}: 'close' code=${c} signal=${s}`); });
  return st;
}
const sh = (script, opts = {}) => spawn("sh", ["-c", script, MARK], { env: ENV, stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });

// Copy of ProviderElectronSmoke.ts:539-565 terminate(), timings unchanged.
function smokeTerminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) { log("smokeTerminate: leader already exited -> returns without signalling"); return; }
  const g = (s) => { try { process.kill(-child.pid, s); } catch { try { child.kill(s); } catch {} } };
  g("SIGTERM");
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) g("SIGKILL"); else log("smokeTerminate: leader exited, SIGKILL skipped"); }, 2000).unref();
}

const S = {
  async a() {
    log("== a) leader exits, detached descendant (stdout -> /dev/null) keeps running");
    const c = sh(`${idle()} >/dev/null 2>&1 & echo '{"type":"x"}'; exit 0`);
    watch(c, "leader");
    await sleep(500);
    show("after leader exit:");
    smokeTerminate(c);
    await sleep(2500);
    show("after smokeTerminate + 2.5s:");
    process.kill(-c.pid, "SIGKILL");
    log(`kill(-pgid=${c.pid}, SIGKILL) succeeded although leader pid is gone (group still exists)`);
    await sleep(300);
    show("after group SIGKILL:");
  },
  async b() {
    log("== b) leader ignores SIGINT and SIGTERM");
    const c = spawn("node", ["-e", "process.on('SIGINT',()=>console.log('got INT'));process.on('SIGTERM',()=>console.log('got TERM'));setInterval(()=>{},1e3)", MARK], { env: ENV, stdio: ["ignore", "pipe", "pipe"], detached: true });
    c.stdout.on("data", (d) => log("child says:", d.toString().trim()));
    watch(c, "leader");
    await sleep(300);
    for (const s of ["SIGINT", "SIGTERM"]) { process.kill(-c.pid, s); await sleep(700); log(`after ${s}: alive=${c.exitCode === null && c.signalCode === null}`); }
    process.kill(-c.pid, "SIGKILL");
    await sleep(300);
  },
  async c() {
    log("== c) descendant inherits stdout and outlives the leader");
    const c = sh(`${idle(`setTimeout(()=>console.log(JSON.stringify({type:"late"})),800);`)} & echo '{"type":"turn.completed"}'; exit 0`);
    const st = watch(c, "leader");
    c.stdout.on("data", (d) => log("stdout data:", JSON.stringify(d.toString())));
    await sleep(3000);
    log(`3s after start: exit=${JSON.stringify(st.exit)} end=${st.end} close=${st.close}`);
    show("still alive:");
    process.kill(-c.pid, "SIGKILL");
    log("group SIGKILL sent");
    await sleep(300);
  },
  async c2() {
    log("== c2) 'exit' vs unread stdout: leader writes 32KB (fits the pipe buffer) and exits; we read late");
    const c = spawn("node", ["-e", "process.stdout.write('x'.repeat(32<<10)+'\\n')", MARK], { env: ENV, stdio: ["ignore", "pipe", "pipe"], detached: true });
    c.stdout.pause();
    setTimeout(() => c.stdout.resume(), 300);
    watch(c, "leader");
    await new Promise((r) => c.on("close", r));
  },
  async d() {
    log("== d) orchestrator SIGKILLed: bare detached groups vs supervisor");
    // The orchestrator starts: (1) silent detached worker, (2) chatty detached worker, (3) silent worker under supervisor.
    const orch = `
      const { spawn } = require("node:child_process");
      const s = spawn("sh", ["-c", ${JSON.stringify(idle() + " & wait")}, "${MARK}"], { stdio: ["ignore","pipe","pipe"], detached: true });
      const n = spawn("sh", ["-c", "while :; do echo tick; sleep 0.1; done", "${MARK}"], { stdio: ["ignore","pipe","pipe"], detached: true });
      n.stdout.resume();
      const v = spawn(process.execPath, [${JSON.stringify(path.join(HERE, "supervisor.mjs"))}, "sh", "-c", ${JSON.stringify(idle() + " & wait")}, "${MARK}"], { stdio: ["pipe","pipe","pipe","pipe","pipe"], env: { ...process.env, SUP_ENV_ALLOW: "PATH,HOME,CTTYEXP", SUP_GRACE_INT_MS: "500", SUP_GRACE_TERM_MS: "500" } });
      v.stdio[3].on("data", (d) => process.stdout.write("sup: " + d));
      console.log(JSON.stringify({ silent: s.pid, chatty: n.pid, supervisor: v.pid }));
      setInterval(()=>{},1e3);
    `;
    const o = spawn("node", ["-e", orch, MARK], { env: ENV, stdio: ["ignore", "pipe", "inherit"], detached: true });
    o.stdout.on("data", (d) => log("orchestrator:", d.toString().trim()));
    await sleep(1000);
    show("before crash:");
    process.kill(o.pid, "SIGKILL");
    log("orchestrator SIGKILLed");
    await sleep(250);
    show("250ms after crash:");
    await sleep(2750);
    show("3s after crash:");
  },
  async e() {
    log("== e) descendants that leave the process group");
    const perlSetsid = `perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' node -e 'setInterval(()=>{},1e3)' ${MARK}-setsid`;
    const nodeDetached = `node -e 'require(\"child_process\").spawn(\"node\",[\"-e\",\"setInterval(()=>{},1e3)\",\"${MARK}-nodedetached\"],{detached:true,stdio:\"ignore\"}).unref()'`;
    const c = sh(`nohup ${idle()} >/dev/null 2>&1 & (${idle()} >/dev/null 2>&1 &) ; ${perlSetsid} >/dev/null 2>&1 & ${nodeDetached}; sleep 60`);
    watch(c, "leader");
    await sleep(1000);
    show(`before kill (leader pgid=${c.pid}):`);
    process.kill(-c.pid, "SIGKILL");
    await sleep(500);
    const left = show("after kill(-pgid, SIGKILL):");
    const byEnv = left.filter((p) => { try { return execFileSync("ps", ["-E", "-o", "command=", "-p", String(p.pid)], { encoding: "utf8" }).includes("CTTYEXP=" + MARK); } catch { return false; } });
    log(`escapees still carrying CTTYEXP env marker (visible via ps -E): ${byEnv.length}/${left.length}`);
  },
  async env() {
    log("== env) what ps shows about environment");
    const c = spawn("node", ["-e", "setInterval(()=>{},1e3)", MARK], { env: ENV, stdio: "ignore", detached: true });
    await sleep(300);
    const own = execFileSync("ps", ["-E", "-o", "lstart=,command=", "-p", String(c.pid)], { encoding: "utf8" });
    log("own process, ps -E shows CTTYEXP marker:", own.includes("CTTYEXP=" + MARK), "| lstart:", own.trim().slice(0, 24));
    const eww = execFileSync("ps", ["eww", "-o", "command=", "-p", String(c.pid)], { encoding: "utf8" });
    log("own process, ps eww shows marker:", eww.includes("CTTYEXP=" + MARK));
    let root = "";
    try { root = execFileSync("ps", ["-E", "-o", "command=", "-p", "1"], { encoding: "utf8" }); } catch {}
    log("pid 1 (other uid), ps -E shows any NAME=VALUE after command:", /\s[A-Z_]+=/.test(root.trim()), "| text:", root.trim().slice(0, 60));
    c.kill("SIGKILL");
  },
};

const which = process.argv[2] ?? "all";
try {
  for (const k of which === "all" ? Object.keys(S) : [which]) { await S[k](); cleanup(); await sleep(200); }
} finally {
  cleanup();
  await sleep(300);
  show("final check, processes with this run's MARK:");
  process.exit(0);
}
