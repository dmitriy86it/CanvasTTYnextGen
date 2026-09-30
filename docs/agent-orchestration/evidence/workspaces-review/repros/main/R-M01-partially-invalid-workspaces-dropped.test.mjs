// R-M01. A workspaces.json of version 1 with one entry the parser does not accept (here: createdAt missing) is not
// treated as damaged (spec §3 step 2: a damaged file is moved aside as .damaged-<uuid>). The entry is dropped in
// memory, and the very next change (a camera write) rewrites workspaces.json without it: the workspace record (name,
// folder, camera) is gone and no copy of the original bytes is kept anywhere.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrateWorkspaces, WorkspaceStore, WORKSPACES_FILE } from "../../../../../../src/main/services/WorkspaceStore.ts";

test("R-M01: an entry the parser rejects is not silently lost on the next write", async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "rm01-"));
  const original = JSON.stringify({
    v: 1, activeId: "alpha",
    workspaces: [
      { id: "common", title: "", root: null, createdAt: "2026-09-01T00:00:00.000Z", closed: false, camera: null },
      { id: "alpha", title: "Alpha", root: "/tmp/alpha", closed: false, camera: { x: 1, y: 2, zoom: 1 } } // no createdAt
    ]
  });
  fs.writeFileSync(path.join(ud, WORKSPACES_FILE), original);
  const m = await migrateWorkspaces(ud);
  const store = new WorkspaceStore(ud, m, async () => ({ cards: 0, runs: 0 }));
  const r = await store.setCamera("common", { x: 0, y: 0, zoom: 1 });
  assert.equal(r.ok, true);
  const files = fs.readdirSync(ud);
  const kept = files.some((f) => f.startsWith(`${WORKSPACES_FILE}.damaged-`) && fs.readFileSync(path.join(ud, f), "utf8") === original);
  const now = JSON.parse(fs.readFileSync(path.join(ud, WORKSPACES_FILE), "utf8"));
  const alphaStill = now.workspaces.some((w) => w.id === "alpha");
  fs.rmSync(ud, { recursive: true, force: true });
  assert.ok(alphaStill || kept, `workspace "alpha" was dropped and the original file was not kept aside; files: ${files.join(", ")}`);
});
