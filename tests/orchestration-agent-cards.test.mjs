// 1.5.13: resizable agent cards. The size and the size "Expand" returns to live in the canvas store (never in a run's
// journal) and come back after a restart; a card's size stays within its limits; a waiting agent's line never repeats
// the working one's word for word. The DOM side (handles, no clipped lines, the live feed) is scripts/smoke-agent-cards-ui.mjs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCanvasStore } from "../src/main/services/orchestration/canvasStore.ts";
import { AGENT_CARD_SIZE, agentCardSize, isCompact, withoutHome } from "../src/renderer/src/features/orchestration/agentCardGeometry.ts";
import { roleStatus } from "../src/renderer/src/features/orchestration/runStatus.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-cards-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const ok = (r) => r; // the store resolves with the value or throws a refusal

test("a card's size and its expanded size are saved in the canvas store and read back by a new store (a restart)", async () => {
  const file = path.join(TMP, "canvas.json");
  const agentId = randomUUID();
  const store = createCanvasStore(file);
  ok(await store.createAgent({ agentId, provider: "claude", project: TMP, bounds: { position: { x: 10, y: 20 }, size: { ...AGENT_CARD_SIZE } }, workspaceId: "common" }));
  await store.moveAgent(agentId, { position: { x: 10, y: 20 }, size: { width: 520, height: 640 } }, { width: 520, height: 640 });
  // collapsed: the compact size, the larger one kept to come back to
  await store.moveAgent(agentId, { position: { x: 10, y: 20 }, size: { ...AGENT_CARD_SIZE } }, { width: 520, height: 640 });
  // a move that says nothing of it (an older version, a group drag) keeps it
  await store.moveAgent(agentId, { position: { x: 40, y: 50 }, size: { ...AGENT_CARD_SIZE } });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.v, 1, "the store's format version does not change: the field is optional");
  const again = (await createCanvasStore(file).read(async () => true)).agents.find((a) => a.agentId === agentId);
  assert.deepEqual(again.bounds, { position: { x: 40, y: 50 }, size: AGENT_CARD_SIZE });
  assert.deepEqual(again.expanded, { width: 520, height: 640 });
  await assert.rejects(store.moveAgent(agentId, { position: { x: 0, y: 0 }, size: { width: 300, height: 222 } }, { width: -1, height: 5 }));
});

test("a store written by 1.5.12 (no expanded field) is read as before; a card without one expands to the default size", async () => {
  const file = path.join(TMP, "old.json");
  const agentId = randomUUID();
  fs.writeFileSync(file, JSON.stringify({ v: 1, agents: [{ agentId, provider: "codex", role: "lead", project: TMP, bounds: { position: { x: 0, y: 0 }, size: { width: 300, height: 222 } }, createdAt: "2026-10-08T00:00:00Z" }], links: [], owners: {} }));
  const card = (await createCanvasStore(file).read(async () => true)).agents[0];
  assert.equal(card.agentId, agentId);
  assert.equal(card.expanded, undefined);
  assert.equal(isCompact(card.bounds.size), true);
});

test("a saved size is kept within the card's limits: never smaller than the compact card, never larger than a terminal", () => {
  assert.deepEqual(agentCardSize({ width: 100, height: 50 }), { width: 300, height: 222 });
  assert.deepEqual(agentCardSize({ width: 9000, height: 9000 }), { width: 1600, height: 1100 });
  assert.deepEqual(agentCardSize({ width: 480, height: 600 }), { width: 480, height: 600 });
  assert.equal(isCompact({ width: 300, height: 222 }), true);
  assert.equal(isCompact({ width: 300, height: 223 }), false);
});

test("the live feed says a home folder as ~, like the card's own lines", () => {
  assert.equal(withoutHome('Tool: /bin/zsh -lc "cat /Users/runner/dev/x/docs/a.md"'), 'Tool: /bin/zsh -lc "cat ~/dev/x/docs/a.md"');
  assert.equal(withoutHome("read /home/runner/project/a.txt"), "read ~/project/a.txt");
  assert.equal(withoutHome("src/a.ts"), "src/a.ts");
});

test("a waiting agent says «Waiting: <who works and what it does>» in one line, never the other one's line word for word", () => {
  const view = { runId: "r", status: "running", reason: null, revision: 3, stage: null, turns: 1, halted: false, active: { kind: "turn", purpose: "plan" } };
  const input = { view, entries: [], open: true, stageTitles: null, now: Date.now() };
  const lead = roleStatus("ru", "lead", input);
  const exec = roleStatus("ru", "executor", input);
  assert.equal(exec.state, "waiting_agent");
  assert.equal(exec.doing, `Ждёт: ${lead.doing}`);
  assert.equal(exec.wait, null, "one line, not the lead's line again under it");
  assert.notEqual(exec.doing, lead.doing);
  assert.equal(roleStatus("en", "executor", input).doing.startsWith("Waiting: "), true);
});
