// B2, the board on the canvas (docs/agent-orchestration/implementation/stage-b-board.md §6): the words of a task's line
// in both languages, «Done» accepted never worded as confirmed, the board's canvas layer, its place in board.json.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createBoardStore } from "../src/main/services/orchestration/boardStore.ts";
import { taskLine } from "../src/renderer/src/features/orchestration/boardModel.ts";
import { boardLayerId, parseCanvasLayerId } from "../src/renderer/src/features/workspace/canvasSelectionGesture.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-board-ui-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const status = (over = {}) => ({ column: "queue", done: null, reason: null, waitsFor: [], cycle: false, attempts: 0, current: null, completion: null, ...over });
const REASONS = ["run_unreadable", "waits_permission", "waits_answer", "waits_decision", "limit_reached", "waits_task", "waits_result", "waits_merge",
  "last_stopped", "last_failed", "no_checks", "stopping", "run_newer", "paused_other"];

test("every reason has its words in both languages; the keys and the attempt are filled in", () => {
  for (const locale of ["ru", "en"]) {
    for (const reason of REASONS) {
      const line = taskLine(locale, status({ reason, waitsFor: ["T-2", "T-5"], attempts: 2 }), null, null);
      assert.ok(line && !line.startsWith("board") && !line.includes("{"), `${locale} ${reason}: ${line}`);
    }
  }
  assert.equal(taskLine("ru", status({ reason: "waits_task", waitsFor: ["T-2", "T-5"] }), null, null), "Ждёт T-2, T-5");
  assert.equal(taskLine("ru", status({ reason: "waits_result", waitsFor: ["T-3"] }), null, null), "Результат T-3 не забран");
  assert.equal(taskLine("ru", status({ reason: "last_stopped", attempts: 2 }), null, null), "Последний запуск остановлен (попытка 2)");
  assert.equal(taskLine("ru", status({ reason: "waits_task", cycle: true, waitsFor: ["T-1"] }), null, null), "Зависимости по кругу: T-1");
  assert.equal(taskLine("ru", status({ reason: "limit_reached" }), null, "turns"), "Исчерпан лимит: Ходы");
  assert.equal(taskLine("ru", status(), null, null), "Ещё не запускалась");
});

test("«Done» accepted by the person is never worded as confirmed by checks", () => {
  for (const locale of ["ru", "en"]) {
    const confirmed = taskLine(locale, status({ column: "done", done: "confirmed" }), null, null);
    const accepted = taskLine(locale, status({ column: "done", done: "accepted" }), null, null);
    assert.notEqual(confirmed, accepted);
    assert.match(accepted, locale === "ru" ? /принято вами, без проверок/ : /accepted by you, without checks/);
    assert.doesNotMatch(accepted, locale === "ru" ? /подтверждено/ : /confirmed/);
  }
});

test("the board is a canvas layer of its workspace", () => {
  assert.deepEqual(parseCanvasLayerId(boardLayerId("ws-1")), { kind: "board", targetId: "ws-1" });
  assert.equal(parseCanvasLayerId("board:"), null);
});

test("board.json keeps the board's place per workspace; a place that does not read is dropped, never a task", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "p-"));
  const file = path.join(dir, "board.json");
  const store = createBoardStore(file);
  const t = await store.create({ workspaceId: "common", project: TMP, title: "a", text: "b", criteria: ["c"] });
  const place = { position: { x: 10, y: -20 }, size: { width: 900, height: 500 } };
  await store.place("common", place);
  await store.place("ws2", place);
  await store.place("ws2", null);
  assert.deepEqual((await createBoardStore(file).read()).board.places, { common: place });
  await assert.rejects(store.place("common", { position: { x: Number.NaN, y: 0 }, size: { width: 1, height: 1 } }), /bounds/);
  // a hand-edited place: dropped on read, the tasks kept
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.places.common = { position: { x: "far" }, size: null };
  fs.writeFileSync(file, JSON.stringify(raw));
  const back = await createBoardStore(file).read();
  assert.deepEqual([back.board.tasks.map((x) => x.id), back.board.places, back.readOnly], [[t.id], undefined, null]);
  // a change of the tasks keeps the places
  const s2 = createBoardStore(file);
  await s2.place("common", place);
  await s2.update(t.id, { title: "renamed" });
  assert.deepEqual((await createBoardStore(file).read()).board.places, { common: place });
});
