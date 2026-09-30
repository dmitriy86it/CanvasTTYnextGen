// Closing a terminal card end to end: App's own close handler (compiled from App.tsx, not a copy) → main's
// TerminalManager with a fake PTY → main's events applied to the renderer's list as App applies them → the workspace
// close check. After a stop that saw no exit, a closed card must come back marked while main keeps the live process
// (workspaces-spec.md §4, §5; external review /private/tmp/raoden-stop-card-visibility-review.test.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { IPC } from "../src/shared/contracts.ts";
import { upsertSession } from "../src/renderer/src/lib/sessionReconciliation.ts";
import { closeHasWork } from "../src/renderer/src/features/workspaces/workspaceModel.ts";

const root = new URL("..", import.meta.url).pathname;
const { transformSync } = createRequire(`${root}package.json`)("esbuild");
const app = fs.readFileSync(`${root}src/renderer/src/App.tsx`, "utf8");
const from = app.indexOf("  const disposeSession = useCallback(");
const to = app.indexOf("  const focusSession = useCallback(", from);
assert.ok(from >= 0 && to > from, "App's close handler is found");
const handlerJs = transformSync(app.slice(from, to), { loader: "ts", target: "es2022" }).code;

// kill: "silent" (ignores the signal), "exit" (exits right after), "throw" (the signal cannot be sent).
function bench(kill) {
  let exitHandler = null;
  let ui = [];
  const events = [];
  const fakePty = {
    pid: 20202, process: "synthetic", write() {}, resize() {},
    onData() { return { dispose() {} }; },
    onExit(fn) { exitHandler = fn; return { dispose() {} }; },
    kill() {
      if (kill === "throw") throw new Error("synthetic kill refused");
      if (kill === "exit") setTimeout(() => exitHandler({ exitCode: 0 }), 5);
    }
  };
  // main's events reach the renderer's list the way App's subscriptions apply them
  const manager = new TerminalManager((channel, payload) => {
    events.push(channel);
    if (channel === IPC.terminalSession) ui = upsertSession(ui, payload.session);
    if (channel === IPC.terminalRemoved) ui = ui.filter((s) => s.id !== payload.id);
  }, { get: (provider) => ({ state: "available", provider, executable: "/synthetic/codex", launcher: "native", environment: {}, checked: [] }) },
  undefined, undefined, false, () => fakePty);
  manager.configureWorkspaces({ active: () => "a", isOpen: () => true });
  const { id } = manager.create({ provider: "codex", cwd: os.tmpdir(), profile: "normal", position: { x: 0, y: 0 }, workspaceId: "a" });
  ui = manager.list().map((s) => ({ ...s, buffer: "" }));
  const window = { canvasTTY: { terminal: { dispose: (sid) => Promise.resolve().then(() => manager.dispose(sid)) } } };
  const none = () => {};
  const closeCard = new Function("useCallback", "window", "setSessions", "setActiveSessionId", "setRenamingSessionId", `${handlerJs}\nreturn disposeSession;`)
    ((fn) => fn, window, (fn) => { ui = fn(ui); }, none, none);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return {
    manager, id, events, settle,
    closeCard: async () => { closeCard(id); await settle(); },
    card: () => ui.find((s) => s.id === id),
    inMain: () => manager.list().some((s) => s.id === id),
    asks: () => closeHasWork({ workspaceId: "a", sessions: ui, links: [], owner: () => "a", runStatus: () => undefined, known: () => true }),
    exit: async (code = 0) => { exitHandler({ exitCode: code }); await settle(); }
  };
}

test("an ordinary close (no stop before): the card goes, main drops the session, nothing comes back", async () => {
  const b = bench("silent");
  await b.closeCard();
  assert.equal(b.card(), undefined);
  assert.equal(b.inMain(), false);
  assert.equal(b.asks(), false);
});

test("a close whose signal fails: the card comes back unmarked, main keeps the process", async () => {
  const b = bench("throw");
  const warn = console.warn; console.warn = () => {};
  try { await b.closeCard(); } finally { console.warn = warn; }
  assert.equal(b.inMain(), true);
  assert.equal(b.card()?.exitCode, null, "the card is back");
  assert.equal(b.card()?.closeUnconfirmed, undefined, "no close was accepted");
});

test("stop without an exit, then the card closed: it comes back marked, closing the workspace asks; the late exit removes it for good", async () => {
  const b = bench("silent");
  assert.equal((await b.manager.stop(b.id, 25, 10)).outcome, "timeout");
  await b.closeCard();
  assert.equal(b.inMain(), true, "main keeps the live process");
  assert.equal(b.card()?.closeUnconfirmed, true, "the card is back, its end shown as not confirmed");
  assert.equal(b.card()?.exitCode, null, "not shown as ended");
  assert.equal(b.asks(), true, "closing its workspace offers to stop it");
  await b.closeCard();
  assert.equal(b.card()?.closeUnconfirmed, true, "closed again: still back while it lives");
  await b.exit(0);
  assert.equal(b.card(), undefined, "the confirmed exit removes the card");
  assert.equal(b.inMain(), false);
  assert.equal(b.events.at(-1), IPC.terminalRemoved, "nothing brings it back after the removal");
  await b.settle();
  assert.equal(b.card(), undefined);
});

test("stop without an exit, card closed, then a stop that sees the exit: exited, the card is gone", async () => {
  const b = bench("silent");
  await b.manager.stop(b.id, 25, 10);
  await b.closeCard();
  const again = b.manager.stop(b.id, 2000, 10);
  setTimeout(() => b.exit(0), 10);
  assert.deepEqual(await again, { outcome: "exited", exitCode: 0 });
  await b.settle();
  assert.equal(b.card(), undefined);
  assert.equal(b.inMain(), false);
});

test("a shell whose card came back after an unconfirmed close is work too; an ordinary shell is not", () => {
  const ask = (s) => closeHasWork({ workspaceId: "a", sessions: [s], links: [], owner: () => "a", runStatus: () => undefined, known: () => true });
  assert.equal(ask({ provider: "terminal", exitCode: null, workspaceId: "a" }), false);
  assert.equal(ask({ provider: "terminal", exitCode: null, workspaceId: "a", closeUnconfirmed: true }), true);
  assert.equal(ask({ provider: "terminal", exitCode: 0, workspaceId: "a", closeUnconfirmed: true }), false, "ended");
});
