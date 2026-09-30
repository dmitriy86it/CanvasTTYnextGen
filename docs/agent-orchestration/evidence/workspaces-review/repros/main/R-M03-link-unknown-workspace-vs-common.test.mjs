// R-M03. Spec §1: a missing or unknown workspaceId means the common canvas. A card whose workspace no longer exists
// (e.g. after a damaged workspaces.json was moved aside, §3 step 2 / M3) is shown on the common canvas next to the
// common cards, but canvasStore.createLink compares raw ids (workspaceOfCard), so linking it with a common card on the
// same canvas is refused with link_workspaces.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCanvasStore } from "../../../../../../src/main/services/orchestration/canvasStore.ts";

test("R-M03: a card of an unknown workspace (shown on common) links with a common card", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rm03-")));
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  const lead = randomUUID(), exec = randomUUID();
  const bounds = { position: { x: 0, y: 0 }, size: { width: 400, height: 300 } };
  // canvas.json as it is after workspaces.json was lost: one card still names the old workspace "ghost"
  fs.writeFileSync(path.join(dir, "canvas.json"), JSON.stringify({ v: 1, agents: [
    { agentId: lead, provider: "codex", role: "lead", project, bounds, createdAt: "2026-09-01T00:00:00.000Z", workspaceId: "ghost" },
    { agentId: exec, provider: "claude", role: "executor", project, bounds, createdAt: "2026-09-01T00:00:00.000Z", workspaceId: "common" }
  ], links: [], owners: {} }));
  const store = createCanvasStore(path.join(dir, "canvas.json"));
  const outcome = await store.createLink({ linkId: randomUUID(), fromAgentId: lead, toAgentId: exec }).then(() => "linked", (e) => e.code);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(outcome, "linked");
});
