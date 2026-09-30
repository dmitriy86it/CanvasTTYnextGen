// R-M02. parseFile checks the id with ID.test(w.id); RegExp.test converts undefined to the string "undefined", which
// matches /^[A-Za-z0-9_-]{1,64}$/. An entry without an id is accepted as a workspace whose id is undefined.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrateWorkspaces, WORKSPACES_FILE } from "../../../../../../src/main/services/WorkspaceStore.ts";

test("R-M02: a workspace entry without an id is not accepted", async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "rm02-"));
  fs.writeFileSync(path.join(ud, WORKSPACES_FILE), JSON.stringify({
    v: 1, activeId: "common",
    workspaces: [
      { id: "common", title: "", root: null, createdAt: "2026-09-01T00:00:00.000Z", closed: false, camera: null },
      { title: "No id", root: null, createdAt: "2026-09-01T00:00:00.000Z", closed: false, camera: null }
    ]
  }));
  const m = await migrateWorkspaces(ud);
  fs.rmSync(ud, { recursive: true, force: true });
  const ids = m.state.workspaces.map((w) => w.id);
  assert.ok(ids.every((id) => typeof id === "string"), `workspace ids: ${JSON.stringify(ids.map(String))}`);
});
