// "Stop and hide" for terminals (docs/agent-orchestration/implementation/workspaces-spec.md §5): the answer is the
// process's confirmed exit, not the signal. A fake PTY stands in for the process, so a failed signal, a signal without
// an exit and an exit at the moment of the request are reproduced without a real CLI or a change to the product code.
import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { IPC } from "../src/shared/contracts.ts";

// kill: what the fake process does when signalled — "exit" (exits right after), "silent" (ignores it), "throw",
// "throw-once" (refuses the first signal, ignores the next),
// "throw-then-exit" (it already ended: the signal fails, the exit event is on its way).
function fixture(kill) {
  const events = [];
  let exitHandler = null;
  const calls = { kill: 0 };
  const fakePty = {
    pid: 10101, process: "synthetic", write() {}, resize() {},
    onData() { return { dispose() {} }; },
    onExit(fn) { exitHandler = fn; return { dispose() {} }; },
    kill() {
      calls.kill += 1;
      if (kill === "throw" || (kill === "throw-once" && calls.kill === 1)) throw new Error("synthetic kill refused");
      if (kill === "throw-then-exit") { setTimeout(() => exitHandler({ exitCode: 0 }), 20); throw new Error("ESRCH synthetic"); }
      if (kill === "exit") setTimeout(() => exitHandler({ exitCode: 0 }), 20);
    }
  };
  const manager = new TerminalManager((channel, payload) => events.push({ channel, payload }), {
    get: (provider) => ({ state: "available", provider, executable: "/synthetic/codex", launcher: "native", environment: {}, checked: [] })
  }, undefined, undefined, false, () => fakePty);
  manager.configureWorkspaces({ active: () => "a", isOpen: () => true });
  const session = manager.create({ provider: "codex", cwd: os.tmpdir(), profile: "normal", position: { x: 0, y: 0 }, workspaceId: "a" });
  const removed = () => events.some((e) => e.channel === IPC.terminalRemoved && e.payload.id === session.id);
  const listed = () => manager.list().some((s) => s.id === session.id);
  return { manager, id: session.id, calls, removed, listed, exit: (code = 0) => exitHandler({ exitCode: code }) };
}

test("stop: a signal that cannot be sent is kill_failed; the session stays managed and is not reported removed", async () => {
  const f = fixture("throw");
  const r = await f.manager.stop(f.id, 200, 50);
  assert.deepEqual(r, { outcome: "kill_failed", error: "synthetic kill refused" });
  assert.equal(f.listed(), true);
  assert.equal(f.removed(), false);
});

test("stop: a signal sent without an exit is timeout, not stopped; the process stays under control and its later exit is seen", async () => {
  const f = fixture("silent");
  const r = await f.manager.stop(f.id, 100, 50);
  assert.deepEqual(r, { outcome: "timeout" });
  assert.equal(f.calls.kill, 1);
  assert.equal(f.listed(), true, "still managed");
  assert.equal(f.removed(), false, "no removal before an exit");
  f.exit(0);
  assert.equal(f.manager.list().find((s) => s.id === f.id).exitCode, 0, "the exit that came later is recorded");
});

test("stop: a confirmed exit is exited; only then the session is removed", async () => {
  const f = fixture("exit");
  const pending = f.manager.stop(f.id, 2000, 50);
  assert.equal(f.removed(), false, "the signal alone removes nothing");
  assert.deepEqual(await pending, { outcome: "exited", exitCode: 0 });
  assert.equal(f.removed(), true);
  assert.equal(f.listed(), false);
});

test("stop: a terminal that already exited is stopped without a signal", async () => {
  const f = fixture("throw");
  f.exit(3);
  assert.deepEqual(await f.manager.stop(f.id, 200, 50), { outcome: "exited", exitCode: 3 });
  assert.equal(f.calls.kill, 0, "no signal to an ended process");
  assert.equal(f.removed(), true);
});

test("stop: an exit at the moment of the request (the signal fails, the exit follows) is exited, not a failure", async () => {
  const f = fixture("throw-then-exit");
  assert.deepEqual(await f.manager.stop(f.id, 2000, 500), { outcome: "exited", exitCode: 0 });
  assert.equal(f.removed(), true);
});

// Earlier this test expected "absent" when the card was closed while the stop waited: that let a live process be
// taken for stopped (external review, /private/tmp/raoden-terminal-stop-race-review.test.mjs). "absent" is now only an
// id main has no record of.
test("stop: an id main has no record of is absent — not a confirmation", async () => {
  const f = fixture("silent");
  assert.deepEqual(await f.manager.stop("no-such-id", 100, 50), { outcome: "absent" });
});

test("stop + dispose meanwhile: not stopped; the live process keeps its record until its exit", async () => {
  const f = fixture("silent");
  const pending = f.manager.stop(f.id, 150, 50);
  f.manager.dispose(f.id); // the card closed by another path while the stop waits
  assert.deepEqual(await pending, { outcome: "timeout" });
  assert.equal(f.listed(), true, "still managed");
  assert.equal(f.removed(), false, "no removal while it has not ended");
  assert.equal(f.calls.kill, 2, "the close signalled it too");
});

test("stop + dispose, then the late exit: the record goes with the exit", async () => {
  const f = fixture("silent");
  const pending = f.manager.stop(f.id, 100, 50);
  f.manager.dispose(f.id);
  assert.deepEqual(await pending, { outcome: "timeout" });
  f.exit(0);
  assert.equal(f.removed(), true, "removed on the exit");
  assert.equal(f.listed(), false);
});

test("stop + dispose, exit while the stop still waits: exited", async () => {
  const f = fixture("silent");
  const pending = f.manager.stop(f.id, 2000, 50);
  f.manager.dispose(f.id);
  setTimeout(() => f.exit(0), 30);
  assert.deepEqual(await pending, { outcome: "exited", exitCode: 0 });
  assert.equal(f.removed(), true);
});

test("after the race: a second stop signals the kept process again; a second dispose still keeps it", async () => {
  const f = fixture("silent");
  const first = f.manager.stop(f.id, 60, 30);
  f.manager.dispose(f.id);
  assert.deepEqual(await first, { outcome: "timeout" });
  assert.deepEqual(await f.manager.stop(f.id, 60, 30), { outcome: "timeout" }, "the record is there, the process is signalled again");
  f.manager.dispose(f.id);
  assert.equal(f.listed(), true, "a stop saw it alive and no exit came: still managed");
  const again = f.manager.stop(f.id, 2000, 30);
  setTimeout(() => f.exit(0), 20);
  assert.deepEqual(await again, { outcome: "exited", exitCode: 0 });
  assert.equal(f.listed(), false);
  assert.deepEqual(await f.manager.stop(f.id, 60, 30), { outcome: "absent" }, "after the confirmed exit main has no record");
});

test("a stop whose signal failed leaves the ordinary close as it was: a later successful close removes the card", async () => {
  const f = fixture("throw-once");
  assert.equal((await f.manager.stop(f.id, 100, 30)).outcome, "kill_failed");
  f.manager.dispose(f.id); // the second signal is accepted: the ordinary close removes the card, as before
  assert.equal(f.calls.kill, 2);
  assert.equal(f.removed(), true);
});
