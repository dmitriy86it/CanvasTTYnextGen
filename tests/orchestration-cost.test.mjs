// UX audit 2026-10-05, Н9 and Н7: what a run spends — model calls per role from the journal's turns, the tokens each CLI
// reported in the activity (never money), the time and the turns against the limits — and the limit pause's table of
// each limit's value and what is used of it. Also the Dock badge hint of the notification settings (en and ru).
import assert from "node:assert/strict";
import test from "node:test";
import { budgetOf } from "../src/main/services/orchestration/orchestrationService.ts";
import { costOf, limitRows, tokensText } from "../src/renderer/src/features/orchestration/runModel.ts";
import { t } from "../src/renderer/src/lib/i18n.ts";

const T0 = Date.parse("2026-10-08T10:00:00Z");
const LIMITS = { turns: 12, roundsPerStage: 2, replans: 1, runMs: 30 * 60_000 };
const turn = (role) => ({ role });
const state = (turns, extra = {}) => ({ turns: Object.fromEntries(turns.map((r, i) => [`t${i}`, turn(r)])), orch: { plan: { version: 1 }, limitOverrides: {} }, status: "running", pausedReason: null, ...extra });
const goal = { createdAt: T0, limits: LIMITS };

test("the budget from the journal: model calls per role, turns used, the deadline; the limit a limit pause stopped at", () => {
  const b = budgetOf(state(["lead", "executor", "lead", "reviewer", "executor"]), goal, T0 + 60_000);
  assert.deepEqual(b.calls, { lead: 2, executor: 2, reviewer: 1 });
  assert.deepEqual(b.used, { turns: 5, replans: 0 });
  assert.equal(b.deadlineAt, T0 + 30 * 60_000);
  assert.equal(b.reached, null);
  const spent = budgetOf(state(Array(12).fill("executor"), { status: "paused", pausedReason: "limit_reached" }), goal, T0 + 60_000);
  assert.equal(spent.reached, "turns");
  const raised = budgetOf(state(["lead"], { orch: { plan: { version: 1 }, limitOverrides: { turns: 20 } } }), goal, T0);
  assert.equal(raised.limits.turns, 20, "a raised limit is the one shown");
  const late = budgetOf(state(["lead"], { status: "paused", pausedReason: "limit_reached" }), goal, T0 + 31 * 60_000);
  assert.equal(late.reached, "runMs");
});

const view = (budget, status = "running") => ({ status, progress: { budget } });
const usage = (id, role, inputTokens, outputTokens, ts = "2026-10-08T10:05:00Z") => ({ id, ts, role, kind: "usage", detail: { inputTokens, outputTokens } });

test("the cost per role: calls from the journal, tokens summed from what each CLI reported; a role without a report has none", () => {
  const b = budgetOf(state(["lead", "executor", "reviewer"]), goal, T0);
  const entries = [usage(1, "lead", 1000, 200), usage(2, "lead", 3000, 100), usage(3, "executor", 50_000, 1200), { id: 4, ts: "2026-10-08T10:06:00Z", role: "reviewer", kind: "tool", detail: {} }];
  const c = costOf(view(b), entries, T0 + 10 * 60_000);
  assert.deepEqual(c.calls, { lead: 1, executor: 1, reviewer: 1 });
  assert.deepEqual(c.tokens, { lead: { input: 4000, output: 300 }, executor: { input: 50_000, output: 1200 }, reviewer: null });
  assert.equal(c.partial, false);
  assert.deepEqual(c.turns, { used: 3, limit: 12 });
  assert.equal(c.elapsedMs, 10 * 60_000);
  assert.equal(c.leftMs, 20 * 60_000);
  // the oldest activity not loaded: the tokens are a lower bound
  assert.equal(costOf(view(b), entries.slice(1), T0, 1).partial, true);
  // a finished run: the time to its last activity, nothing left
  const over = costOf(view(b, "completed"), entries, T0 + 99 * 60_000);
  assert.equal(over.elapsedMs, 6 * 60_000);
  assert.equal(over.leftMs, null);
  // no budget (an older main): no cost at all
  assert.equal(costOf({ status: "running", progress: {} }, entries, T0), null);
  assert.equal(tokensText("ru", 12_345), "12,3 тыс.");
  assert.equal(tokensText("en", 512), "512");
});

test("the limit pause shows each limit's current value and what is used of it; the one it stopped at is marked", () => {
  const b = budgetOf(state(Array(12).fill("lead"), { status: "paused", pausedReason: "limit_reached", orch: { plan: { version: 2 }, limitOverrides: {} } }), goal, T0 + 7 * 60_000);
  const c = costOf(view(b, "paused"), [], T0 + 7 * 60_000);
  assert.deepEqual(limitRows(c, b), [
    { kind: "turns", reached: true, now: 12, used: 12 },
    { kind: "runMs", reached: false, now: 30, used: 7 },
    { kind: "replans", reached: false, now: 1, used: 1 },
    { kind: "roundsPerStage", reached: false, now: 2, used: null }
  ]);
});

test("notification settings: the Dock badge hint, in Russian and English", () => {
  assert.equal(t("ru", "notifyBadgeHint"), "Если число не появляется на иконке — включите «Значки на иконке приложения» в Системных настройках → Уведомления → Raoden Loom.");
  assert.match(t("en", "notifyBadgeHint"), /Badge application icon.*System Settings → Notifications → Raoden Loom/);
});
