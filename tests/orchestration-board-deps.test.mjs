// B3, dependencies and waiting reasons (docs/agent-orchestration/implementation/stage-b-board.md §4.2, §4.3, §5.3):
// «the dependency changed after it was done», the Dock badge with the tasks waiting for «Accept the result», the CLI's
// reason on a task's line and the count of the person's permission prompts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DEFAULT_NOTIFY_PREFS, notifyStep } from "../src/renderer/src/features/orchestration/notify.ts";
import { ASKS_HINT_OVER, askCount, permissionLine } from "../src/renderer/src/features/orchestration/boardModel.ts";
import { boardStatuses } from "../src/shared/taskBoard.ts";

let n = 0;
const run = (over = {}) => ({ runId: randomUUID(), taskId: null, taskKey: null, createdAt: ++n, workspaceId: "common", status: "running", reason: null, newer: false, halted: false, limit: null,
  completion: null, phase: "work", permission: false, workMode: "project", taken: null, ...over });
const task = (over = {}) => ({ id: randomUUID(), key: `T-${++n}`, workspaceId: "common", project: "/p", title: "t", text: "x", criteria: ["c"],
  dependsOn: [], order: n, createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z", archivedAt: null, accepted: null, ...over });

test("a «Done» task on a dependency not «Done» now stays «Done» and says why: changed after, or never ready; it goes on", () => {
  const a = task();
  const b = task({ dependsOn: [a.id] });
  const c = task({ dependsOn: [b.id] });
  const done = (t) => run({ taskId: t.id, status: "completed", completion: "confirmed" });
  const ra = done(a);
  const rb = done(b);
  const rc = done(c);
  let s = boardStatuses({ tasks: [a, b, c] }, [ra, rb, rc]);
  assert.deepEqual([s.get(b.id).done, s.get(b.id).depsNote, s.get(c.id).depsNote], ["confirmed", null, null]);
  // a new run of A stopped: A is not «Done»; B is not rolled back, it is marked; so is C after it
  s = boardStatuses({ tasks: [a, b, c] }, [ra, rb, rc, run({ taskId: a.id, status: "stopped" })]);
  assert.deepEqual([s.get(a.id).done, s.get(a.id).reason], [null, "last_stopped"]);
  assert.deepEqual([s.get(b.id).column, s.get(b.id).done, s.get(b.id).depsNote], ["done", "confirmed", "changed"]);
  assert.equal(s.get(c.id).depsNote, "changed", "the note goes on to the tasks after it");
  // B started anyway while A was never «Done»: done, «not ready», never «changed»
  s = boardStatuses({ tasks: [a, b] }, [run({ taskId: b.id, status: "completed", completion: "confirmed" })]);
  assert.deepEqual([s.get(b.id).done, s.get(b.id).depsNote], ["confirmed", "not_ready"]);
  // a task not done is never noted (its line says what it waits for)
  const d = task({ dependsOn: [a.id] });
  assert.equal(boardStatuses({ tasks: [a, d] }, [run({ taskId: a.id, status: "stopped" })]).get(d.id).depsNote, null);
});

test("what a task waits for by its dependencies is known whatever its own column", () => {
  const a = task();
  const b = task({ dependsOn: [a.id] });
  // B completed without checks (Review), while A is not «Done»: B is still not ready to start again
  const s = boardStatuses({ tasks: [a, b] }, [run({ taskId: a.id, status: "stopped" }), run({ taskId: b.id, status: "completed", completion: "no_checks" })]);
  assert.deepEqual([s.get(b.id).column, s.get(b.id).reason], ["review", "no_checks"], "its own reason stays");
  assert.deepEqual(s.get(b.id).depsWait, { reason: "waits_task", waitsFor: [a.key], cycle: false });
  assert.equal(s.get(a.id).depsWait, null);
});

test("the Dock badge counts the tasks waiting for «Accept the result» with the runs waiting for the person", () => {
  const v = (status, extra = {}) => ({ runId: "r", revision: 1, status, reason: null, stage: 1, active: null, permission: null, halted: false, newer: null,
    workMode: "project", workDir: "/p", progress: null, proposal: null, refused: null, confirm: null, decisions: null, ...extra });
  const runs = [{ runId: "a", view: v("paused", { reason: "awaiting_answer" }), place: "x" }, { runId: "b", view: v("completed", { progress: { completion: "no_checks" } }), place: "x" }];
  assert.equal(notifyStep("ru", runs, {}, DEFAULT_NOTIFY_PREFS, true).badge, 1, "a run completed without checks is not waiting");
  assert.equal(notifyStep("ru", runs, {}, DEFAULT_NOTIFY_PREFS, true, true, 2).badge, 3);
  assert.equal(notifyStep("ru", runs, {}, { ...DEFAULT_NOTIFY_PREFS, dockBadge: false }, true, true, 2).badge, 0, "the setting still turns it off");
});

test("a task waiting for a permission says what and the CLI's reason as it said it; prompts are counted, the host's answers and questions are not", () => {
  const p = { summary: "u=$x; curl $u", why: { type: "other", text: "A variable in this command can't be checked before it runs" } };
  assert.equal(permissionLine("ru", "Ждёт разрешения", p), "Ждёт разрешения: u=$x; curl $u (причина CLI: A variable in this command can't be checked before it runs)");
  assert.equal(permissionLine("en", "Waits", { summary: "ls", why: { type: "subcommandResults", text: null } }), "Waits: ls (the CLI's reason: subcommandResults)");
  assert.equal(permissionLine("ru", "Ждёт разрешения", { summary: "ls" }), "Ждёт разрешения: ls", "no reason given: none made up");
  assert.equal(permissionLine("ru", "Ждёт разрешения", null), "Ждёт разрешения");
  const e = (kind, detail) => ({ id: ++n, ts: "", turnId: null, role: "executor", provider: "claude", kind, text: "", detail });
  const entries = [e("permission_requested", { kind: "command" }), e("permission_requested", { kind: "tool" }), e("permission_requested", { kind: "question" }),
    e("permission_applied", { scope: "sandbox_static", kind: "tool" }), e("permission_decided", { decision: "allow_once" })];
  assert.equal(askCount(entries), 2);
  assert.equal(ASKS_HINT_OVER, 3, "the same threshold as «read-only until the run ends»");
});
