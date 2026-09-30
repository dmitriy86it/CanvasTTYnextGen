// R-M05. Task question "project busy (folder_busy) by a run from another workspace — does main give enough information
// for the UI to explain it and navigate?" canvasStore.startOnLink refuses with code folder_busy and a fixed message;
// neither the refusal nor manager.readiness ({ busy: boolean }) names the run (or its workspace) that holds the folder.
// The renderer re-derives it (WorkspaceCanvas.folderBusy: only the LAST runId of each link, only if its snapshot is
// loaded and readable), while main's rule (manager.busy) checks EVERY runId and counts an unreadable journal as busy.
// When the two rules differ, the UI gets folder_busy with nothing to point to.
// Here the busy() stub stands in for manager.busy (a run of link B in workspace "beta" is unfinished).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCanvasStore } from "../../../../../../src/main/services/orchestration/canvasStore.ts";

test("R-M05: a folder_busy refusal names the run that holds the folder", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rm05-")));
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  const store = createCanvasStore(path.join(dir, "canvas.json"));
  const bounds = { position: { x: 0, y: 0 }, size: { width: 400, height: 300 } };
  const ids = { la: randomUUID(), ea: randomUUID(), lb: randomUUID(), eb: randomUUID() };
  await store.createAgent({ agentId: ids.la, provider: "codex", project, bounds, workspaceId: "alpha" });
  await store.createAgent({ agentId: ids.ea, provider: "claude", project, bounds, workspaceId: "alpha" });
  await store.createAgent({ agentId: ids.lb, provider: "codex", project, bounds, workspaceId: "beta" });
  await store.createAgent({ agentId: ids.eb, provider: "claude", project, bounds, workspaceId: "beta" });
  const linkA = randomUUID(), linkB = randomUUID(), heldBy = randomUUID();
  await store.createLink({ linkId: linkA, fromAgentId: ids.la, toAgentId: ids.ea });
  await store.createLink({ linkId: linkB, fromAgentId: ids.lb, toAgentId: ids.eb });
  // link B holds a reserved run (as startOnLink leaves it); its run is at work
  await store.startOnLink(linkB, heldBy, async () => false, async () => true, async () => ({ runId: heldBy, created: true }));
  const busy = async (l) => l.runIds.includes(heldBy);
  const err = await store.startOnLink(linkA, randomUUID(), busy, async () => false, async () => { throw new Error("not reached"); }).catch((e) => e);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(err.code, "folder_busy");
  assert.ok(String(err.message).includes(heldBy) || err.runId === heldBy, `refusal: ${JSON.stringify({ code: err.code, message: err.message, runId: err.runId })}`);
});
