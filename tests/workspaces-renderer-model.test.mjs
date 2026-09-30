// Project workspaces in the renderer (workspaces-spec.md §5–§6): the switcher's counts come from the application's own
// state and never take an open shell for an agent at work; a move offers the whole linked group; the arrange proposal
// checks nothing; the camera saver sends every write to the workspace it was made in, also after a switch.
import assert from "node:assert/strict";
import test from "node:test";
import { arrangeGroups, createCameraSaver, linkedGroup, workspaceCounts } from "../src/renderer/src/features/workspaces/workspaceModel.ts";
import { runOwners, workspaceOf } from "../src/shared/workspaceOwnership.ts";

const known = (id) => ["common", "ws-a", "ws-b"].includes(id);

test("counts: runs at work, CLIs at work and attention per workspace; an open shell is never work", () => {
  const sessions = [
    { provider: "terminal", status: "idle", exitCode: null, workspaceId: "ws-a" }, // an open shell
    { provider: "terminal", status: "working", exitCode: null, workspaceId: "ws-a" }, // a shell running a command is still a shell
    { provider: "claude", status: "working", exitCode: null, workspaceId: "ws-a" },
    { provider: "codex", status: "needs_approval", exitCode: null, workspaceId: "ws-b" },
    { provider: "claude", status: "working", exitCode: 0, workspaceId: "ws-b" }, // ended
    { provider: "terminal", status: "idle", exitCode: null } // no workspace: the common canvas
  ];
  const owner = (r) => ({ r1: "ws-a", r2: "ws-b", r3: "ws-b", r4: "gone" }[r]);
  const runs = [
    { runId: "r1", state: "working" }, { runId: "r2", state: "waiting_user" }, { runId: "r3", state: "paused" },
    { runId: "r4", state: "checking" }
  ];
  const c = workspaceCounts({ sessions, runs, owner: (r) => (known(owner(r)) ? owner(r) : "common"), known });
  assert.deepEqual(c["ws-a"], { runs: 1, cli: 1, attention: 0, shells: 2 });
  assert.deepEqual(c["ws-b"], { runs: 0, cli: 0, attention: 2, shells: 0 }, "a paused run is neither at work nor waiting");
  assert.deepEqual(c.common, { runs: 1, cli: 0, attention: 0, shells: 1 }, "an unknown owner counts on the common canvas");
});

const canvas = {
  agents: [
    { agentId: "L1", role: "lead", provider: "codex", project: "/p/alpha", workspaceId: "ws-a" },
    { agentId: "E1", role: "executor", provider: "claude", project: "/p/alpha", workspaceId: "ws-a" },
    { agentId: "E2", role: "executor", provider: "claude", project: "/p/alpha", workspaceId: "ws-a" },
    { agentId: "L2", role: "lead", provider: "codex", project: "/p/beta" },
    { agentId: "E3", role: "executor", provider: "claude", project: "/p/beta" }
  ],
  links: [
    { linkId: "k1", fromAgentId: "L1", toAgentId: "E1", runIds: ["old", "r1"] },
    { linkId: "k2", fromAgentId: "L1", toAgentId: "E2", runIds: [] },
    { linkId: "k3", fromAgentId: "L2", toAgentId: "E3", runIds: ["r9"] }
  ],
  owners: { r1: "ws-a" }
};

test("a move offers the whole linked group, whichever card it starts from", () => {
  assert.deepEqual(linkedGroup(canvas, "E2"), ["L1", "E1", "E2"]);
  assert.deepEqual(linkedGroup(canvas, "L2"), ["L2", "E3"]);
});

test("run owners: written owner first, then the link's workspace, then the common canvas", () => {
  const owner = runOwners(canvas, known);
  assert.equal(owner("r1"), "ws-a");
  assert.equal(owner("old"), "ws-a", "an older run of a link in ws-a");
  assert.equal(owner("r9"), "common");
  assert.equal(owner("never-seen"), "common");
  assert.equal(workspaceOf({ workspaceId: "ws-b" }, known), "ws-b");
});

test("arrange: a proposal by folder; groups with an unfinished run cannot be checked", () => {
  const sessions = [{ id: "t1", title: "shell", cwd: "/p/beta" }, { id: "t2", title: "other", cwd: "/p/beta", workspaceId: "ws-b" }];
  const groups = arrangeGroups({ workspaceId: "common", known, sessions, canvas, runStatus: (r) => (r === "r9" ? "paused" : "completed") });
  assert.deepEqual(groups.map((g) => [g.folder, g.items.map((i) => [i.kind, i.ids, i.blocked])]), [
    ["/p/beta", [["terminal", ["t1"], false], ["agents", ["L2", "E3"], true]]]
  ]);
});

test("the camera saver: one write per workspace after the delay; a switch flushes A to A, never to B", () => {
  const writes = [];
  const timers = new Map();
  let next = 0;
  const saver = createCameraSaver((id, camera) => writes.push([id, camera.x]), 500, {
    set: (fn) => { const id = ++next; timers.set(id, fn); return id; },
    clear: (id) => timers.delete(id)
  });
  const fire = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  saver.schedule("ws-a", { x: 1, y: 0, zoom: 1 });
  saver.schedule("ws-a", { x: 2, y: 0, zoom: 1 });
  assert.deepEqual(writes, [], "nothing before the delay");
  // a switch to B while A's write is pending: A's camera goes to A at once
  saver.schedule("ws-b", { x: 50, y: 0, zoom: 1 });
  assert.deepEqual(writes, [["ws-a", 2]]);
  fire();
  assert.deepEqual(writes, [["ws-a", 2], ["ws-b", 50]]);
  // a late timer of A that fires after the switch cannot write B's camera
  saver.schedule("ws-a", { x: 3, y: 0, zoom: 1 });
  saver.flush();
  fire();
  assert.deepEqual(writes.at(-1), ["ws-a", 3]);
  assert.equal(writes.length, 3);
});

test("a move keeps the layout and shifts the whole set right only where it would cover a card of the target", async () => {
  const { roomFor } = await import("../src/renderer/src/features/workspaces/workspaceModel.ts");
  const box = (x, y, w = 300, h = 200) => ({ position: { x, y }, size: { width: w, height: h } });
  assert.equal(roomFor([box(1000, 0)], [box(0, 0, 800, 600)]), 0, "a free place: coordinates kept");
  const dx = roomFor([box(0, 0), box(400, 0)], [box(0, 0, 800, 600)]);
  assert.equal(dx, 840, "both cards shift by one amount past HOME and its gap");
  assert.equal(roomFor([box(0, 0)], []), 0);
});
