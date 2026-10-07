// UX audit PR 3: which run states notify the person (once per change of state, never while the window has the focus,
// never again after a restart), the Dock badge across workspaces, the settings, and the PR 2 follow-ups.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_NOTIFY_PREFS, notifyStep, runSignal } from "../src/renderer/src/features/orchestration/notify.ts";
import { GLOSSARY, changesFirst, commandLike, glossarySplit } from "../src/renderer/src/features/orchestration/runModel.ts";
import { t } from "../src/renderer/src/lib/i18n.ts";

const view = (status, reason = null, extra = {}) => ({ runId: "r", revision: 1, status, reason, stage: 1, active: null, permission: null, halted: false,
  newer: null, workMode: "project", workDir: "/srv/projects/secret-project", progress: null, proposal: null, refused: null, confirm: null, decisions: null, ...extra });
const run = (runId, v, place = "alpha") => ({ runId, view: v, place });
const P = DEFAULT_NOTIFY_PREFS;
// a run seen before, now in `v`: what one step tells
const step = (before, v, { prefs = P, focused = false, notified = { r: before } } = {}) => notifyStep("ru", [run("r", v)], notified, prefs, focused);

test("which changes of state notify: waiting for the person, completed (two texts), failed — not plain steps or pauses you may simply resume", () => {
  const told = (v) => step("", v).notes.map((n) => n.signal);
  assert.deepEqual(told(view("paused", "awaiting_answer")), ["waiting"]);
  assert.deepEqual(told(view("paused", "coverage_lost")), ["waiting"]);
  assert.deepEqual(told(view("running", null, { permission: { requestId: "q1", role: "executor", provider: "claude", kind: "command", tool: "Bash" } })), ["waiting"]);
  assert.deepEqual(told(view("completed", null, { progress: { completion: "checked" } })), ["completed"]);
  assert.deepEqual(told(view("completed", null, { progress: { completion: "no_checks" } })), ["completed_no_checks"]);
  assert.deepEqual(told(view("failed")), ["failed"]);
  for (const v of [view("running"), view("paused", "user_request"), view("paused", "step_done"), view("paused", "app_closed"), view("paused", "recovered"), view("stopped")])
    assert.deepEqual(told(v), [], `${v.status} ${v.reason}`);
  const body = (v) => step("", v).notes[0].body;
  assert.equal(body(view("completed", null, { progress: { completion: "checked" } })), t("ru", "orchNotify_completed"));
  assert.equal(body(view("completed", null, { progress: { completion: "no_checks" } })), t("ru", "orchNotify_completed_no_checks"));
  assert.notEqual(t("ru", "orchNotify_completed"), t("ru", "orchNotify_completed_no_checks"));
  assert.notEqual(t("en", "orchNotify_completed"), t("en", "orchNotify_completed_no_checks"));
});

test("the text: the project's name and the chip's short reason; no path, command or file", () => {
  const [n] = step("", view("paused", "awaiting_answer")).notes;
  assert.equal(n.title, "alpha");
  assert.match(n.body, /^Ждёт вас: /);
  assert.doesNotMatch(`${n.title} ${n.body}`, /\/srv|secret-project|node --test/);
  const [e] = notifyStep("en", [run("r", view("failed"))], { r: "" }, P, false).notes;
  assert.equal(e.body, t("en", "orchNotify_failed"));
});

test("not while the window has the focus — and that state is not told later either", () => {
  const focused = step("", view("paused", "awaiting_answer"), { focused: true });
  assert.deepEqual(focused.notes, []);
  assert.deepEqual(notifyStep("ru", [run("r", view("paused", "awaiting_answer"))], focused.notified, P, false).notes, [], "the focus moved away later: no stale notification");
});

test("one notification per change of state; none again after a restart; a run older than the record is only recorded", () => {
  const v = view("paused", "awaiting_answer");
  const first = step("", v);
  assert.equal(first.notes.length, 1);
  assert.deepEqual(notifyStep("ru", [run("r", v)], first.notified, P, false).notes, [], "the same state again");
  // a restart: the record is read back from storage (a JSON round trip), the run is still waiting
  const restored = JSON.parse(JSON.stringify(first.notified));
  assert.deepEqual(notifyStep("ru", [run("r", v)], restored, P, false).notes, []);
  // after an update: no record of the run at all — recorded, not told
  const unknown = notifyStep("ru", [run("old", view("completed", null, { progress: { completion: "checked" } }))], {}, P, false);
  assert.deepEqual([unknown.notes, unknown.notified.old], [[], "completed"]);
  // waiting, resumed, waiting again for the same reason: told again
  const resumed = notifyStep("ru", [run("r", view("running"))], first.notified, P, false);
  assert.equal(notifyStep("ru", [run("r", v)], resumed.notified, P, false).notes.length, 1);
});

test("a click opens that run: the notification carries its run and its place", () => {
  const s = notifyStep("ru", [run("a", view("paused", "awaiting_answer"), "Проект · alpha"), run("b", view("failed"), "Работа · beta")], { a: "", b: "" }, P, false);
  assert.deepEqual(s.notes.map((n) => [n.runId, n.title]), [["a", "Проект · alpha"], ["b", "Работа · beta"]]);
});

test("the Dock badge counts the runs waiting in every workspace; off — no badge; bounce once on the change", () => {
  const runs = [run("a", view("paused", "awaiting_answer"), "ws1 · a"), run("b", view("paused", "coverage_lost"), "ws2 · b"), run("c", view("running"), "ws2 · c"),
    run("d", view("paused", "user_request"), "ws3 · d")];
  const notified = { a: "", b: "waiting:coverage_lost", c: "", d: "" };
  assert.equal(notifyStep("ru", runs, notified, P, false).badge, 2);
  assert.equal(notifyStep("ru", runs, notified, P, true).badge, 2, "the badge does not depend on the focus");
  assert.equal(notifyStep("ru", runs, notified, { ...P, dockBadge: false }, false).badge, 0);
  assert.equal(notifyStep("ru", runs, notified, P, false).bounce, false, "bounce is off by default");
  const on = notifyStep("ru", runs, notified, { ...P, bounce: true }, false);
  assert.equal(on.bounce, true);
  assert.equal(notifyStep("ru", runs, on.notified, { ...P, bounce: true }, false).bounce, false, "once per change");
});

test("each setting turns its event off", () => {
  const cases = [["waiting", view("paused", "awaiting_answer")], ["completed", view("completed", null, { progress: { completion: "checked" } })],
    ["completed", view("completed", null, { progress: { completion: "no_checks" } })], ["failed", view("failed")]];
  for (const [key, v] of cases) {
    assert.equal(step("", v).notes.length, 1, key);
    assert.equal(step("", v, { prefs: { ...P, [key]: false } }).notes.length, 0, `${key} off`);
  }
});

test("runSignal: the waiting pauses are exactly the chip's «Ждёт вас»", () => {
  assert.equal(runSignal(view("paused", "plan_review"))?.signal, "waiting");
  assert.equal(runSignal(view("paused", "user_request")), null);
  assert.equal(runSignal(view("paused", "awaiting_answer", { halted: true })), null, "a halted run asks nothing");
});

test("the goal dialog offers to move a requirement that reads like a check command — not ordinary text", () => {
  for (const s of ["node --test passes", "npm test", "npx vitest", "php artisan test", "composer test", "pytest -q", "python -m pytest", "cargo test", "go test ./...", "make test", "./run-tests.sh", "the suite passes with --test"])
    assert.equal(commandLike(s), true, s);
  for (const s of ["src/note.mjs exists", "Make sure the button is red", "README describes the API", "the node module is documented", "tests pass", "Node 22 is supported", "pytests are fine"])
    assert.equal(commandLike(s), false, s);
});

test("a completed run whose next step is «Changes» has it as the main button", () => {
  assert.equal(changesFirst(view("completed", null, { workMode: "project", progress: { completion: "checked", finish: [], checks: [] } }), []), true);
  assert.equal(changesFirst(view("completed", null, { workMode: "project", progress: { completion: "checked", finish: [{ step: "commit", status: "done", asked: true }], checks: [] } }), []), false, "committed: the next step is not «Changes»");
  assert.equal(changesFirst(view("paused", "user_request"), []), false);
});

test("the glossary explains checkpoint, worktree, the journal's word, the agent's claim and the service branch (ru and en)", () => {
  for (const term of ["checkpoint", "worktree", "journal", "claim", "branch"]) {
    assert.ok(term in GLOSSARY, term);
    for (const locale of ["ru", "en"]) assert.match(t(locale, `orchTerm_${term}`), /^\S.{20,200}[.)]$/, `${locale} ${term}`);
  }
  const found = (locale, s) => glossarySplit(locale, s).filter((p) => typeof p !== "string").map((p) => p.term);
  assert.deepEqual(found("ru", "Контрольная точка: Этап 1; в отдельном worktree, ветка canvastty/run-1; подтверждено журналом; со слов агента"), ["checkpoint", "worktree", "branch", "journal", "claim"]);
  assert.deepEqual(found("en", "Checkpoint, a worktree on canvastty/run-1, confirmed by the journal, the agent's claim"), ["checkpoint", "worktree", "branch", "journal", "claim"]);
  assert.match(t("ru", "orchTerm_branch"), /служебная ветка Raoden Loom/);
  assert.match(t("ru", "orchTerm_worktree"), /отдельная рабочая копия git/);
});
