// The UI drivers' wait (scripts/orchestration-app-kit.mjs): only a truthy value of a successful evaluation ends it.
// launch(): a failure after the spawn stops only the own child, waits for its exit, closes the WebSocket and rethrows
// the original error. Driven with a fake child, fetch and WebSocket: no Electron.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
import { launch, waitForValue } from "../scripts/orchestration-app-kit.mjs";

const noPause = async () => {};

test("waitForValue: false is not success; the timeout names the last value", async () => {
  await assert.rejects(waitForValue(async () => false, "cond", 30, noPause), /timeout: cond \(false\)/);
});

test("waitForValue: an exception is not success, even though its text is not empty; the timeout names it", async () => {
  await assert.rejects(waitForValue(async () => { throw new Error("evaluate: Cannot read properties of null"); }, "cond", 30, noPause),
    /timeout: cond \(undefined; last error: evaluate: Cannot read properties of null\)/);
});

test("waitForValue: a condition met after an exception and a false value is accepted with its value", async () => {
  const answers = [() => { throw new Error("page reloading"); }, () => false, () => ({ linked: true })];
  let i = 0;
  assert.deepEqual(await waitForValue(async () => answers[Math.min(i++, 2)](), "cond", 5_000, noPause), { linked: true });
  assert.equal(i, 3);
});

// A child that exits on SIGTERM (or only on SIGKILL with `ignoreTerm`); `killThrows` makes kill() fail.
function fakeChild({ pid = 4242, ignoreTerm = false, killThrows = false } = {}) {
  const c = new EventEmitter();
  Object.assign(c, { pid, exitCode: null, signalCode: null, signals: [], stdout: new EventEmitter(), stderr: new EventEmitter() });
  c.kill = (sig) => {
    if (killThrows) throw new Error("kill failed");
    c.signals.push(sig);
    if (sig === "SIGKILL" || !ignoreTerm) setImmediate(() => { c.signalCode = sig; c.emitted = true; c.emit("exit", null, sig); });
    return true;
  };
  return c;
}
const PAGE = { type: "page", url: "file:///index.html", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/1" };
const fetchWith = (pages) => async (url) => {
  if (url.endsWith("/json/version")) throw new Error("ECONNREFUSED");
  return { json: async () => pages };
};
function fakeWs(outcome) {
  const made = [];
  class Ws { constructor(url) { this.url = url; this.closed = false; made.push(this); setImmediate(() => (outcome === "open" ? this.onopen?.() : this.onerror?.({ message: "refused" }))); }
    close() { this.closed = true; } send() {} }
  return { Ws, made };
}
const opts = { userData: "/tmp/ud", port: 9999, shots: "/tmp" };
const deps = (child, extra = {}) => ({ spawnFn: () => child, fetchFn: fetchWith([PAGE]), WebSocketImpl: fakeWs("open").Ws,
  listenerOf: () => child.pid, argsOf: () => "electron --user-data-dir=/tmp/ud", pause: async () => {}, killAfterMs: 50, ...extra });

test("launch: no window: the own child is stopped and its exit awaited, the original error is thrown", async () => {
  const child = fakeChild();
  await assert.rejects(launch(opts, deps(child, { fetchFn: fetchWith([]) })), /no window/);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(child.emitted, true);
});

test("launch: a child ignoring SIGTERM gets SIGKILL after the timeout before the error is thrown", async () => {
  const child = fakeChild({ ignoreTerm: true });
  await assert.rejects(launch(opts, deps(child, { fetchFn: fetchWith([]) })), /no window/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
});

test("launch: a WebSocket error stops the own child, awaits its exit and closes the socket", async () => {
  const child = fakeChild();
  const { Ws, made } = fakeWs("error");
  await assert.rejects(launch(opts, deps(child, { WebSocketImpl: Ws })), /WebSocket ws:\/\/127\.0\.0\.1:1\/devtools\/page\/1: refused/);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(child.emitted, true);
  assert.equal(made.length, 1);
  assert.equal(made[0].closed, true);
});

test("launch: a port served by another pid stops only the own child; the other pid gets no signal", async () => {
  const child = fakeChild();
  const kill = mock.method(process, "kill", () => true);
  try {
    await assert.rejects(launch(opts, deps(child, { listenerOf: () => 777 })), /port 9999 is served by pid 777, not by the launched app \(pid 4242\)/);
    assert.equal(kill.mock.callCount(), 0);
  } finally { kill.mock.restore(); }
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(child.emitted, true);
});

test("launch: a failing cleanup does not replace the original error; it is attached", async () => {
  const child = fakeChild({ killThrows: true });
  await assert.rejects(launch(opts, deps(child, { fetchFn: fetchWith([]) })), (e) => {
    assert.match(e.message, /no window/);
    assert.match(String(e.cleanupError?.message), /kill failed/);
    return true;
  });
});

test("launch: a port already served before the spawn starts nothing", async () => {
  let spawned = false;
  await assert.rejects(launch(opts, { fetchFn: async () => ({}), spawnFn: () => { spawned = true; } }), /port 9999 is taken/);
  assert.equal(spawned, false);
});
