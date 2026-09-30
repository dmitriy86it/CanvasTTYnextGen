// Regression checks for supervisor.mjs on mock-cli.mjs. Run: node --test supervisor.test.mjs
// Processes are accounted by proc-ledger.mjs: pids we spawned plus the ones mock-cli writes to MOCK_LEDGER.
// Every process also carries this run's CTTYEXP marker in argv; `ps` by marker is only a secondary check.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ProcLedger, assertNoneAlive } from "./proc-ledger.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SUP = path.join(HERE, "supervisor.mjs");
const MOCK = path.join(HERE, "mock-cli.mjs");
const MARK = "CTTYEXP-" + randomBytes(4).toString("hex");
const FAKE_KEY = "fake-test-value";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `${MARK}-`));
const LEDGER = path.join(TMP, "ledger.jsonl");
const ledger = new ProcLedger(LEDGER);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const groupAlive = (pgid) => alive(-pgid);
after(async () => {
  try { await assertNoneAlive(null, ledger, { ms: 1000, mark: MARK }); } catch (e) { console.log(`# after: ${e.message}`); process.exitCode = 1; }
  fs.rmSync(TMP, { recursive: true, force: true });
});

function lines(stream, onLine) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
}

// Starts the supervisor the way Electron main would: ELECTRON_RUN_AS_NODE=1 in its env, fd0 control, fd3 status, fd4 task.
function start(mode, { cmd, env = {}, allow = "PATH,HOME,CTTYEXP,MOCK_LEDGER" } = {}) {
  const sup = spawn(process.execPath, [SUP, ...(cmd ?? [process.execPath, MOCK, mode, MARK])], {
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, CTTYEXP: MARK, MOCK_LEDGER: LEDGER, ELECTRON_RUN_AS_NODE: "1", SUP_ENV_ALLOW: allow, SUP_GRACE_INT_MS: "300", SUP_GRACE_TERM_MS: "300", SUP_LEFTOVER_MS: "300", ...env },
  });
  ledger.track(sup.pid, "supervisor");
  const s = { sup, status: [], statusText: "", out: [], stderr: "" };
  lines(sup.stdio[3], (l) => {
    s.statusText += l + "\n";
    const st = JSON.parse(l);
    if (st.ev === "started") ledger.track(st.pgid, "group", { group: true });
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
  assert.deepEqual(done.leaderExit.code, 0);
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
  assertCleanDone(s, r);
  assert.equal(s.ev("done")[0].stopRequested, false);
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
  const done = assertCleanDone(s, await s.finish());
  assert.equal(done.stopReason, "command");
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
  const r = await s.finish();
  const done = assertCleanDone(s, r, 1);
  assert.equal(done.error, "spawn");
  assert.equal(done.code, "ENOENT");
  assert.equal(done.leaderExit, null);
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
  ledger.track(m.pid, "fake-main");
  const st = [];
  lines(m.stdout, (l) => st.push(JSON.parse(l)));
  await until(() => st.some((x) => x.ev === "started"), 5000, "started");
  await sleep(200); // let the mock spawn its descendant
  const supPid = st.find((x) => x.ev === "supervisor").pid;
  const pgid = st.find((x) => x.ev === "started").pgid;
  ledger.track(supPid, "supervisor");
  ledger.track(pgid, "group", { group: true });
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

test("no processes of this run are left (ledger; ps by marker only as a secondary check)", async (t) => {
  const r = await assertNoneAlive(t, ledger, { mark: MARK });
  assert.ok(r.gone.length > 0, "ledger saw the processes of this run");
  t.diagnostic(`ledger: ${r.gone.length} gone, ${r.unverifiable.length} unverifiable`);
});
