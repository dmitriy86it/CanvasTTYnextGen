// Review fixes of the workspaces renderer (workspaces-spec.md §1, §5, §6): closing a workspace asks only while it has
// work to stop (an open shell is not), a card's bounds change never changes the workspace it belongs to, and the run holding a
// project folder is the one main names, in main's workspace.
import assert from "node:assert/strict";
import test from "node:test";
import { closeHasWork, folderHolderOf, withBounds } from "../src/renderer/src/features/workspaces/workspaceModel.ts";

const known = (id) => ["common", "ws-a"].includes(id);

test("closing asks while there is work to stop: an unfinished run (paused included) or a live agent CLI; a shell alone hides", () => {
  const shell = { provider: "terminal", exitCode: null, workspaceId: "ws-a" };
  const status = { r1: "paused", r2: "running", r3: "completed" };
  const ask = (sessions, runIds = []) => closeHasWork({ workspaceId: "ws-a", sessions, links: runIds.map((r) => ({ runIds: ["old", r] })),
    owner: () => "ws-a", runStatus: (r) => status[r], known });
  assert.equal(ask([shell]), false, "shells only: hide without asking");
  assert.equal(ask([]), false, "an empty workspace");
  assert.equal(ask([shell], ["r3"]), false, "a finished run is no work");
  assert.equal(ask([], ["r1"]), true, "a paused run still asks: closing offers to stop it");
  assert.equal(ask([], ["r2"]), true);
  assert.equal(ask([shell, { provider: "claude", exitCode: null, workspaceId: "ws-a" }]), true, "a live agent CLI, idle or not");
  assert.equal(ask([{ provider: "claude", exitCode: 0, workspaceId: "ws-a" }]), false, "an ended CLI");
  assert.equal(ask([{ provider: "claude", exitCode: null, workspaceId: "ws-b" }]), false, "another workspace's CLI");
  assert.equal(ask([shell], ["r-no-snapshot"]), true, "a known run whose state is loading or unreadable is not taken for no work");
});

test("bounds: the owner is the card's current one, whatever the bounds carry", () => {
  const card = { position: { x: 1, y: 2 }, size: { width: 3, height: 4 }, workspaceId: "ws-b" };
  const moved = { position: { x: 10, y: 20 }, size: { width: 30, height: 40 } };
  assert.deepEqual(withBounds(card, moved), { ...moved, workspaceId: "ws-b" }, "bounds alone keep the owner");
  assert.deepEqual(withBounds(card, { ...moved, workspaceId: "ws-x" }), { ...moved, workspaceId: "ws-b" }, "a stale owner is ignored");
  const common = { position: { x: 1, y: 2 }, size: { width: 3, height: 4 } };
  assert.deepEqual(withBounds(common, { ...moved, workspaceId: "ws-x" }), moved, "a common card stays common");
  assert.deepEqual(withBounds(null, moved), moved);
});

test("folder holder: main's run and workspace; an unknown workspace is the common canvas; malformed is no hint", () => {
  assert.deepEqual(folderHolderOf({ runId: "r9", workspaceId: "ws-a", runReadable: true, extra: 1 }, known), { runId: "r9", workspaceId: "ws-a", runReadable: true });
  assert.deepEqual(folderHolderOf({ runId: "r9", workspaceId: "gone", runReadable: false }, known), { runId: "r9", workspaceId: "common", runReadable: false });
  assert.equal(folderHolderOf(undefined, known), null, "no busy item");
  assert.equal(folderHolderOf({ ok: false, code: "folder_busy", message: "m" }, known), null, "a refusal without main's fields");
  assert.equal(folderHolderOf({ runId: "r9", workspaceId: "ws-a", runReadable: "no" }, known), null);
});
