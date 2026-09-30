// Regression checks for src/orchestration/supervisor.mjs, the helper the orchestration engine runs every CLI
// turn under. The stand-in CLI is written to a temp dir by this file; processes are accounted by their own pids
// (kill(pid, 0): ESRCH gone, success alive, EPERM unverifiable); `ps` by this run's marker is only a second look.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OwnPids, commandOf, waitDead } from "./fixtures/orchestration/reaper-pids.mjs";

const SUP = fileURLToPath(new URL("../src/orchestration/supervisor.mjs", import.meta.url));
const MARK = "CTTYSUP-" + randomBytes(4).toString("hex");
const FAKE_KEY = "fake-test-value";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `${MARK}-`));
const LEDGER = path.join(TMP, "ledger.jsonl");
const MOCK = path.join(TMP, "mock-cli.mjs");
const ESCAPEE = fileURLToPath(new URL("./fixtures/orchestration/reaper-escapee.mjs", import.meta.url));
// Signal scoping exactly as in the check profile, everything else allowed (the fixtures write pid files into TMP).
const SIGNAL_SCOPED = "(version 1)(allow default)(deny signal)(allow signal (target same-sandbox))";
const pids = new OwnPids(); // escapees and their leaders, killed in after() only after `ps` confirms the command

// Modes: exit0 | exit42 | sleep | ignore-int | exit-now (no stdin read) | spawn / spawn-exit (descendant in the group).
fs.writeFileSync(MOCK, `
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
const [mode, mark] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const ledger = (pid, label) => fs.appendFileSync(process.env.MOCK_LEDGER, JSON.stringify({ pid, label }) + "\\n");
ledger(process.pid, "mock-cli");
if (mode === "exit-now") process.exit(0);
if (mode === "ignore-int") process.on("SIGINT", () => out({ type: "mock.sigint_ignored" }));
if (mode.startsWith("spawn")) {
  const d = spawn(process.execPath, ["-e", "setInterval(()=>{},1e3)", mark + "-descendant"], { stdio: "ignore" });
  ledger(d.pid, "mock-cli-descendant");
  out({ type: "mock.descendant", pid: d.pid });
}
out({ type: "mock.ready", pid: process.pid });
const hash = createHash("sha256");
const head = [];
let len = 0;
process.stdin.on("data", (d) => { hash.update(d); len += d.length; if (len <= 4096) head.push(d); });
process.stdin.on("end", () => {
  out({ type: "mock.stdin", eof: true, len, sha256: hash.digest("hex"),
    text: len <= 4096 ? Buffer.concat(head).toString("utf8") : null,
    hasElectronRunAsNode: "ELECTRON_RUN_AS_NODE" in process.env,
    supVars: Object.keys(process.env).filter((k) => k.startsWith("SUP_")),
    hasAnthropicKey: process.env.ANTHROPIC_API_KEY === "${FAKE_KEY}" });
  if (mode === "exit0" || mode === "spawn-exit") process.exit(0);
  if (mode === "exit42") process.exit(42);
});
if (mode === "sleep" || mode === "ignore-int" || mode === "spawn") setInterval(() => {}, 1e3);
`);

// ---- own-pid accounting ----
const own = new Map(); // pid, or -pgid for a group -> label
const track = (pid, label, group = false) => { if (Number.isInteger(pid) && pid > 0) own.set(group ? -pid : pid, label); };
const probe = (pid) => { try { process.kill(pid, 0); return "alive"; } catch (e) { return e.code === "ESRCH" ? "gone" : "unverifiable"; } };
const alive = (pid) => probe(pid) === "alive";
const groupAlive = (pgid) => alive(-pgid);
function ledgerCheck() {
  try {
    for (const l of fs.readFileSync(LEDGER, "utf8").split("\n")) if (l) { const { pid, label } = JSON.parse(l); if (!own.has(pid)) track(pid, label); }
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const r = { alive: [], gone: [], unverifiable: [] };
  for (const [pid, label] of own) r[probe(pid)].push(`${label}:${pid}`);
  return r;
}
function psByMarker() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    return { available: true, pids: out.split("\n").filter((l) => l.includes(MARK)).map((l) => +l.trim().split(/\s+/)[0]).filter((p) => p && p !== process.pid) };
  } catch (e) { return { available: false, error: e.code ?? String(e) }; }
}
async function waitNoneAlive(ms) {
  const until = Date.now() + ms;
  let r = ledgerCheck();
  while (r.alive.length && Date.now() < until) { await sleep(25); r = ledgerCheck(); }
  return r;
}
after(async () => {
  const r = await waitNoneAlive(1000);
  if (r.alive.length) {
    console.log(`# after: still alive ${r.alive.join(" ")}; SIGKILL own`);
    // A positive pid only while `ps` shows it still runs a command of this run (pid reuse); a group is ours by pgid.
    for (const [pid] of own) if (alive(pid) && (pid < 0 || commandOf(pid)?.includes(MARK))) try { process.kill(pid, "SIGKILL"); } catch {}
    process.exitCode = 1;
  }
  const killed = await pids.cleanup();
  if (killed.length) console.log(`# after: SIGKILL own escapees ${killed.join("; ")}`);
  fs.rmSync(TMP, { recursive: true, force: true });
});

function lines(stream, onLine) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
}

// Starts the supervisor the way Electron main does: ELECTRON_RUN_AS_NODE=1 in its env, fd0 control, fd3 status, fd4 task.
// sandboxed: the supervisor itself runs under sandbox-exec (which execs it: same pid), as a project check does.
function start(mode, { cmd, env = {}, allow = "PATH,HOME,CTTYEXP,MOCK_LEDGER", execPath = process.execPath, sandboxed = false } = {}) {
  const argv = [SUP, ...(cmd ?? [process.execPath, MOCK, mode, MARK])];
  const sup = spawn(sandboxed ? "/usr/bin/sandbox-exec" : execPath, sandboxed ? ["-p", SIGNAL_SCOPED, "--", execPath, ...argv] : argv, {
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, CTTYEXP: MARK, MOCK_LEDGER: LEDGER, ELECTRON_RUN_AS_NODE: "1", SUP_ENV_ALLOW: allow, SUP_GRACE_INT_MS: "300", SUP_GRACE_TERM_MS: "300", SUP_LEFTOVER_MS: "300", ...env },
  });
  track(sup.pid, "supervisor");
  const s = { sup, status: [], statusText: "", out: [], stderr: "" };
  lines(sup.stdio[3], (l) => {
    s.statusText += l + "\n";
    const st = JSON.parse(l);
    if (st.ev === "started") track(st.pgid, "group", true);
    s.status.push(st);
  });
  lines(sup.stdout, (l) => s.out.push(JSON.parse(l)));
  sup.stderr.on("data", (d) => { s.stderr += d; });
  for (const fd of [0, 4]) sup.stdio[fd].on("error", () => {}); // EPIPE after the supervisor exits
  s.closed = new Promise((r) => sup.on("close", (code, signal) => r({ code, signal })));
  s.ev = (name) => s.status.filter((x) => x.ev === name);
  s.mock = (type) => s.out.find((x) => x.type === type);
  s.pgid = () => s.ev("started")[0]?.pgid;
  s.stop = () => sup.stdin.write('{"cmd":"stop"}\n');
  s.task = (data) => sup.stdio[4].end(data);
  s.finish = async () => { const r = await Promise.race([s.closed, sleep(8000).then(() => null)]); assert.ok(r, "supervisor did not exit in 8s"); return r; };
  return s;
}
async function until(pred, ms = 5000, what = "condition") {
  const t = Date.now() + ms;
  while (!pred()) { if (Date.now() > t) assert.fail(`timeout waiting for ${what}`); await sleep(10); }
}
function assertCleanDone(s, r, exitCode = 0) {
  assert.equal(s.ev("done").length, 1, "done exactly once");
  assert.equal(r.code, exitCode);
  assert.equal(s.stderr, "", "no stderr (no uncaught exception)");
  const done = s.ev("done")[0];
  assert.equal(done.groupCleared, true);
  if (s.pgid()) assert.equal(groupAlive(s.pgid()), false, "process group is empty");
  return done;
}

function electronBinary() {
  try {
    const p = createRequire(import.meta.url)("electron");
    return typeof p === "string" && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

test("task delivered byte for byte: UTF-8, CRLF, blank lines, stop lines; EOF reaches the target", async () => {
  const task = 'первая строка\r\n\r\nstop\n{"cmd":"stop"}\n\n  stop  \n🧪 последняя строка без перевода';
  const s = start("exit0");
  s.task(task);
  const r = await s.finish();
  const got = s.mock("mock.stdin");
  assert.equal(got.eof, true);
  assert.equal(got.text, task);
  assert.equal(got.len, Buffer.byteLength(task));
  const done = assertCleanDone(s, r);
  assert.equal(done.leaderExit.code, 0);
  assert.equal(done.stopRequested, false);
  assert.equal(s.ev("stop_requested").length, 0);
  const order = s.status.map((x) => x.ev).filter((e) => e.startsWith("task_") || e === "done");
  assert.deepEqual(order, ["task_eof", "task_written", "done"], "delivery statuses precede done");
});

test("target exits without reading an 8 MiB task: no crash, task_write_error EPIPE before done, no task_written", async () => {
  for (let i = 0; i < 3; i++) {
    const s = start("exit-now");
    s.task(Buffer.alloc(8 << 20, 0x61));
    assert.equal(assertCleanDone(s, await s.finish()).leaderExit.code, 0);
    const evs = s.status.map((x) => x.ev);
    assert.equal(s.ev("task_write_error")[0]?.code, "EPIPE", `run ${i}: ${evs}`);
    assert.ok(evs.indexOf("task_write_error") < evs.indexOf("done"), `run ${i}: ${evs}`);
    assert.equal(s.ev("task_written").length, 0, `run ${i}`);
  }
});

test("1 MiB+ task (larger than a pipe buffer) delivered intact", async () => {
  const unit = "строка задания 🧪 stop\r\n{\"cmd\":\"stop\"}\n\n";
  const task = Buffer.from(unit.repeat(Math.ceil((1 << 20) / Buffer.byteLength(unit)) + 7));
  assert.ok(task.length > 1 << 20);
  const s = start("exit0");
  s.task(task);
  const r = await s.finish();
  const got = s.mock("mock.stdin");
  assert.equal(got.len, task.length);
  assert.equal(got.sha256, createHash("sha256").update(task).digest("hex"));
  assert.equal(assertCleanDone(s, r).stopRequested, false);
});

test("control channel: only a whole {\"cmd\":\"stop\"} line stops; substrings and task text do not", async () => {
  const s = start("sleep");
  await until(() => s.mock("mock.ready"), 5000, "mock ready");
  s.task('stop\n{"cmd":"stop"}\n');
  s.sup.stdin.write('stop\nxstop\n{"cmd":"stopx"}\n"stop"\n{"cmd":"stop"} trailing\n');
  await until(() => s.mock("mock.stdin"), 5000, "task EOF at target");
  await sleep(400);
  assert.equal(s.ev("stop_requested").length, 0);
  assert.equal(s.ev("control_ignored").length, 5);
  assert.equal(groupAlive(s.pgid()), true, "target still running");
  s.sup.stdin.write('{"cmd":'); // a command split across writes still counts once the line is whole
  await sleep(50);
  assert.equal(s.ev("stop_requested").length, 0);
  s.sup.stdin.write('"stop"}\r\n');
  assert.equal(assertCleanDone(s, await s.finish()).stopReason, "command");
});

test("target env: no ELECTRON_RUN_AS_NODE, no SUP_*, allowed auth var passes, values never in status", async () => {
  const s = start("exit0", {
    allow: "PATH,HOME,CTTYEXP,MOCK_LEDGER,ANTHROPIC_API_KEY,ELECTRON_RUN_AS_NODE,SUP_GRACE_INT_MS,NOT_SET_ANYWHERE",
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
  });
  s.task("");
  const r = await s.finish();
  const got = s.mock("mock.stdin");
  assert.equal(got.hasElectronRunAsNode, false);
  assert.deepEqual(got.supVars, []);
  assert.equal(got.hasAnthropicKey, true);
  assert.deepEqual(s.ev("started")[0].env, ["ANTHROPIC_API_KEY", "CTTYEXP", "HOME", "MOCK_LEDGER", "PATH"]);
  assert.equal(s.statusText.includes(FAKE_KEY), false);
  assert.equal(s.stderr.includes(FAKE_KEY), false);
  assertCleanDone(s, r);
});

test("missing executable: spawn error in status, clean exit, no hang", async () => {
  const s = start(null, { cmd: [`/nonexistent/${MARK}-cli`] });
  s.task(Buffer.alloc(1 << 20, 0x61)); // writes into a target that never started
  const done = assertCleanDone(s, await s.finish(), 1);
  assert.equal(done.error, "spawn");
  assert.equal(done.code, "ENOENT");
  assert.equal(done.leaderExit, null);
});

test("unusable fd4 (stdio \"ignore\" leaves one of node's own fds there): done fd4_unusable, exit != 0, no crash, nothing spawned", async () => {
  const flag = path.join(TMP, `fd4-${randomBytes(4).toString("hex")}`);
  const sup = spawn(process.execPath, [SUP, process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(flag)}, "x")`, MARK], {
    stdio: ["pipe", "pipe", "pipe", "pipe", "ignore"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  track(sup.pid, "supervisor");
  const status = [];
  let stderr = "";
  lines(sup.stdio[3], (l) => status.push(JSON.parse(l)));
  sup.stderr.on("data", (d) => { stderr += d; });
  const code = await new Promise((r) => sup.on("close", r));
  assert.notEqual(code, 0);
  assert.equal(stderr, "", "no uncaught exception");
  assert.deepEqual(status.map((x) => x.ev), ["done"]);
  assert.ok(["fd4_unusable", "fd4_missing"].includes(status[0].error), status[0].error);
  if (process.platform === "darwin") assert.equal(status[0].error, "fd4_unusable");
  assert.equal(fs.existsSync(flag), false, "the target never started");
});

test("no command: done with an error, exit 2, nothing spawned", async () => {
  const s = start(null, { cmd: [] });
  s.task("");
  const done = assertCleanDone(s, await s.finish(), 2);
  assert.equal(done.error, "no_command");
  assert.equal(s.ev("started").length, 0);
});

test("Stop while running: leader SIGINT, descendant in the group cleaned, done once", async () => {
  const s = start("spawn");
  await until(() => s.mock("mock.ready"), 5000, "mock ready");
  const descendant = s.mock("mock.descendant").pid;
  s.stop();
  const done = assertCleanDone(s, await s.finish());
  assert.equal(done.stopRequested, true);
  assert.equal(done.signalsToLeader[0], "SIGINT");
  assert.equal(done.leaderExit.signal, "SIGINT");
  assert.equal(alive(descendant), false);
});

test("Stop with a leader that ignores SIGINT escalates to SIGTERM", async () => {
  const s = start("ignore-int");
  await until(() => s.mock("mock.ready"), 5000, "mock ready");
  s.stop();
  const done = assertCleanDone(s, await s.finish());
  assert.deepEqual(done.signalsToLeader, ["SIGINT", "SIGTERM"]);
  assert.equal(done.leaderExit.signal, "SIGTERM");
});

test("natural exit: exit code kept, descendant left in the group is killed after the leftover grace", async () => {
  for (const [mode, code] of [["spawn-exit", 0], ["exit42", 42]]) {
    const s = start(mode);
    s.task("x");
    const done = assertCleanDone(s, await s.finish());
    assert.equal(done.leaderExit.code, code);
    assert.deepEqual(done.signalsToLeader, []);
    if (mode === "spawn-exit") assert.deepEqual(done.signals.map((x) => `${x.target}:${x.sig}`), ["group:SIGTERM"]);
  }
});

test("Stop racing the natural exit (20 runs): done exactly once, no exceptions", async (t) => {
  const seen = { stopAccepted: 0, stopAfterLeaderExit: 0, leaderSignalled: 0 };
  for (let i = 0; i < 20; i++) {
    const s = start(i % 2 ? "exit0" : "spawn-exit");
    await until(() => s.mock("mock.ready"), 5000, "mock ready");
    const variant = i % 4;
    if (variant === 0) { s.task(""); s.stop(); } // same tick as the EOF that makes it exit
    else if (variant === 1) { s.task(""); await until(() => s.ev("leader_exit").length, 5000, "leader exit"); s.stop(); }
    else if (variant === 2) { s.task(""); await sleep(i % 7); s.stop(); }
    else { s.stop(); s.task(""); }
    const done = assertCleanDone(s, await s.finish());
    // A Stop that lands after the supervisor already finished is simply not seen: that is fine.
    assert.equal(done.stopRequested, s.ev("stop_requested").length === 1, `run ${i}`);
    assert.ok(s.ev("stop_requested").length <= 1, `run ${i}`);
    assert.ok(done.leaderExit, `run ${i}`);
    seen.stopAccepted += done.stopRequested;
    seen.stopAfterLeaderExit += done.stopAfterLeaderExit;
    seen.leaderSignalled += done.signalsToLeader.length > 0;
  }
  t.diagnostic(JSON.stringify(seen));
});

test("lifeline: fd0 EOF stops the group", async () => {
  const s = start("spawn");
  await until(() => s.mock("mock.ready"), 5000, "mock ready");
  s.sup.stdin.end();
  const done = assertCleanDone(s, await s.finish());
  assert.equal(done.stopReason, "lifeline_eof");
  assert.equal(done.signalsToLeader[0], "SIGTERM");
});

test("lifeline: SIGKILL of the process holding fd0 cleans the group", async () => {
  const main = `
    const { spawn } = require("node:child_process");
    const v = spawn(process.execPath, ${JSON.stringify([SUP, process.execPath, MOCK, "spawn", MARK])},
      { stdio: ["pipe", "ignore", "ignore", "pipe", "pipe"], env: { ...process.env, SUP_ENV_ALLOW: "PATH,HOME,CTTYEXP,MOCK_LEDGER", SUP_GRACE_INT_MS: "300", SUP_GRACE_TERM_MS: "300" } });
    v.stdio[3].on("data", (d) => process.stdout.write(d));
    console.log(JSON.stringify({ ev: "supervisor", pid: v.pid }));
    setInterval(() => {}, 1e3);`;
  const m = spawn(process.execPath, ["-e", main, MARK], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, CTTYEXP: MARK, MOCK_LEDGER: LEDGER, ELECTRON_RUN_AS_NODE: "1" } });
  track(m.pid, "fake-main");
  const st = [];
  lines(m.stdout, (l) => st.push(JSON.parse(l)));
  await until(() => st.some((x) => x.ev === "started"), 5000, "started");
  await sleep(200); // let the mock spawn its descendant
  const supPid = st.find((x) => x.ev === "supervisor").pid;
  const pgid = st.find((x) => x.ev === "started").pgid;
  track(supPid, "supervisor");
  track(pgid, "group", true);
  assert.equal(groupAlive(pgid), true);
  m.kill("SIGKILL");
  await until(() => !groupAlive(pgid) && !alive(supPid), 3000, "group and supervisor gone");
});

test("task EOF alone does not stop the target", async () => {
  const s = start("sleep");
  s.task("hello\n");
  await until(() => s.mock("mock.stdin"), 5000, "task EOF at target");
  await sleep(800); // longer than every grace period
  assert.equal(s.ev("task_eof").length, 1);
  assert.equal(s.ev("stop_requested").length, 0);
  assert.equal(s.ev("leader_exit").length, 0);
  assert.equal(groupAlive(s.pgid()), true);
  s.stop();
  assertCleanDone(s, await s.finish());
});

const electron = electronBinary();
// Electron's own log line (electron/shell/common/mac/codesign_util.cc): in Node mode it checks the parent's code
// signature and logs this when task_name_for_pid on the parent is denied, e.g. when the test run itself is inside
// a Seatbelt sandbox (reproduced with `sandbox-exec` + `(deny mach-task-name)`; Node mode still runs, exit 0).
// Only this exact line is split off and reported; any other stderr (supervisor or CLI) still fails the test.
const ELECTRON_CODESIGN_LOG = /^\[\d{4}\/\d{6}\.\d+:ERROR:electron\/shell\/common\/mac\/codesign_util\.cc:\d+\] task_name_for_pid: [^\n]*\n/gm;
function splitElectronRuntimeLog(t, s) {
  const runtime = s.stderr.match(ELECTRON_CODESIGN_LOG) ?? [];
  s.stderr = s.stderr.replace(ELECTRON_CODESIGN_LOG, "");
  for (const line of runtime) t.diagnostic(`electron runtime log (not a test failure): ${line.trim()}`);
}
const electronSkip = { skip: electron ? false : "electron binary not installed (require('electron') gave no existing path)" };

test("runs under the Electron binary in Node mode; the CLI never sees ELECTRON_RUN_AS_NODE", electronSkip, async (t) => {
  const task = "задание через Electron 🧪\n";
  const s = start("exit0", { execPath: electron });
  s.task(task);
  const r = await s.finish();
  const got = s.mock("mock.stdin");
  assert.equal(got.text, task);
  assert.equal(got.hasElectronRunAsNode, false);
  assert.deepEqual(got.supVars, []);
  splitElectronRuntimeLog(t, s);
  assertCleanDone(s, r);
});

test("under Electron the CLI's own stderr is never split off", electronSkip, async (t) => {
  const cliError = "[0922/000000.000000:ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: from the CLI";
  const s = start("exit0", { execPath: electron, cmd: [process.execPath, "-e", `process.stderr.write(${JSON.stringify(`cli failed\n${cliError}`)})`, MARK] });
  s.task("");
  const r = await s.finish();
  splitElectronRuntimeLog(t, s);
  assert.equal(r.code, 0);
  assert.ok(s.stderr.includes("cli failed\n"), JSON.stringify(s.stderr));
  assert.ok(s.stderr.includes(cliError), "a look-alike line without a trailing newline from the CLI is kept");
});

// ---- opt-in sandbox sweep (SUP_SANDBOX_SWEEP=1): the supervisor scans its own sandbox instance ----
const darwinOnly = { skip: process.platform === "darwin" ? false : "sandbox-exec is macOS only" };
const pidFile = (tag) => path.join(TMP, `${tag}-${randomBytes(4).toString("hex")}.pid`);
async function readPid(file, ms = 8000) {
  for (const t = Date.now() + ms; Date.now() < t; await sleep(20)) if (fs.existsSync(file)) return Number(fs.readFileSync(file, "utf8"));
  assert.fail(`no pid in ${file}`);
}
// The escapee's pid is tracked before any assertion, so after() can clean it whatever fails.
async function withEscapee({ stay = false, sandboxed = true, env = {} } = {}) {
  const escFile = pidFile("esc"), selfFile = stay ? pidFile("lead") : null;
  const s = start(null, { cmd: [process.execPath, ESCAPEE, escFile, selfFile ?? "-", MARK], sandboxed, env: { SUP_SANDBOX_SWEEP: "1", ...env } });
  s.task("");
  s.esc = pids.track(await readPid(escFile), "/bin/sleep");
  if (stay) s.leader = pids.track(await readPid(selfFile), "reaper-escapee.mjs");
  return s;
}

test("sweep is opt-in: without SUP_SANDBOX_SWEEP done has no sandbox field", async () => {
  const s = start("exit0");
  s.task("");
  const done = assertCleanDone(s, await s.finish());
  assert.equal("sandbox" in done, false);
});

test("sweep outside a sandbox: not_sandboxed, no scan, nothing signalled", darwinOnly, async () => {
  const s = await withEscapee({ sandboxed: false });
  const done = assertCleanDone(s, await s.finish());
  assert.deepEqual(done.sandbox, { cleared: false, killed: 0, scans: 0, error: "not_sandboxed" });
  assert.ok(commandOf(s.esc)?.includes("/bin/sleep"), "the escapee is untouched: an unsandboxed supervisor signals nothing");
  assert.equal((await pids.cleanup()).length, 1, "the test kills its own escapee");
});

test("sweep inside the sandbox, natural exit: setsid /bin/sleep escapee killed, two empty scans", darwinOnly, async () => {
  const s = await withEscapee();
  const done = assertCleanDone(s, await s.finish());
  assert.equal(done.leaderExit.code, 0);
  assert.equal(done.sandbox.cleared, true, JSON.stringify(done.sandbox));
  assert.equal(done.sandbox.error, null);
  assert.ok(done.sandbox.killed >= 1, "the escapee was killed by the scan");
  assert.ok(done.sandbox.scans >= 3, "a scan that found it, then two empty ones");
  assert.equal(await waitDead(s.esc, 0), true, "dead by the time done is written");
});

test("sweep inside the sandbox after lifeline EOF (main gone): group stopped, escapee killed", darwinOnly, async () => {
  const s = await withEscapee({ stay: true });
  s.sup.stdin.end();
  const done = assertCleanDone(s, await s.finish());
  assert.equal(done.stopReason, "lifeline_eof");
  assert.equal(done.sandbox.cleared, true, JSON.stringify(done.sandbox));
  assert.equal(await waitDead(s.leader, 0), true);
  assert.equal(await waitDead(s.esc, 0), true);
});

test("sweep deadline: a found process is still killed, but the sandbox is not reported clear", darwinOnly, async () => {
  const s = await withEscapee({ env: { SUP_SWEEP_MS: "0" } });
  const done = assertCleanDone(s, await s.finish());
  assert.deepEqual({ ...done.sandbox, killed: done.sandbox.killed >= 1 }, { cleared: false, killed: true, scans: 1, error: "deadline" });
  assert.equal(await waitDead(s.esc, 2000), true);
});

test("no processes of this run are left (own pids; ps by marker only as a secondary check)", async (t) => {
  const r = await waitNoneAlive(3000);
  assert.deepEqual(r.alive, [], "own processes still alive");
  assert.ok(r.gone.length > 0, "accounting saw the processes of this run");
  if (r.unverifiable.length) t.diagnostic(`UNVERIFIABLE (not counted as clean): ${r.unverifiable.join(" ")}`);
  const g = psByMarker();
  if (!g.available) t.diagnostic(`ps unavailable: ${g.error}`);
  else assert.deepEqual(g.pids, [], `processes with marker ${MARK} still running`);
  t.diagnostic(`own: ${r.gone.length} gone, ${r.unverifiable.length} unverifiable`);
});
