// External review of the activity display, first stage (R1–R4): stage identity after a replan, the full list of required
// checks, the lead's interim reviews, and load failures. The model (runStatus.ts), the journal reader and the real
// RunPanel rendered to markup with anonymised journals; no Electron, no CLI, no model.
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { outcomeKey, readJournal, runStatus, roleStatus, stageTitleMap, summaryModel } from "../src/renderer/src/features/orchestration/runStatus.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

// The real RunPanel, bundled in memory (React kept external so the hooks share one copy).
async function loadRunPanel() {
  const { build } = require("esbuild");
  const out = await build({
    entryPoints: [path.join(ROOT, "src/renderer/src/features/orchestration/RunPanel.tsx")],
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
    loader: { ".svg": "dataurl", ".png": "dataurl", ".ico": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
    plugins: [{ name: "same-react", setup(b) { b.onResolve({ filter: /^react(\/.*)?$/ }, (a) => ({ path: require.resolve(a.path), external: true })); } }]
  });
  const file = path.join(ROOT, "run-panel-in-memory.cjs");
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(ROOT);
  mod._compile(out.outputFiles[0].text, file);
  return mod.exports.RunPanel;
}
const RunPanel = await loadRunPanel();

const TS = "2026-01-01T00:00:00Z";
const sha = (c) => c.repeat(64);
const ref = (c) => ({ sha256: sha(c), bytes: 10 });
let seq = 0;
const rec = (type, data) => ({ seq: seq++, ts: TS, type, data });
const view = (over = {}) => ({ runId: "r", status: "paused", reason: "user_request", stage: 2, turns: 6, revision: 6, halted: false, active: null, ...over });
const PLAN1 = ["Старая модель", "Старый API", "Старый интерфейс"];
const PLAN2 = ["Новый API", "Новый интерфейс"];
const planTitles = (s) => (s === sha("1") ? PLAN1 : s === sha("2") ? PLAN2 : null);

// Stage 1 accepted; stage 2 of plan 1 got "fix" then "replan"; plan 2 starts at stage 2.
function replanJournal({ acceptFirst = true } = {}) {
  seq = 0;
  const j = [rec("run.created", { goal: ref("g") }), rec("orch.turn", { turnId: "p1", purpose: "plan", stage: null }), rec("plan.recorded", { version: 1, plan: ref("1"), firstStage: 1, stageCount: 3 })];
  const round = (id, stage, verdict, findings) => j.push(
    rec("orch.turn", { turnId: `e${id}`, purpose: "execute", stage }), rec("turn.finished", { turnId: `e${id}`, outcome: "completed", report: { ref: ref(`e${id}`.slice(-1)) } }),
    rec("orch.turn", { turnId: `v${id}`, purpose: "review", stage }), rec("turn.finished", { turnId: `v${id}`, outcome: "completed", report: { ref: ref("r") } }),
    rec("review.recorded", { turnId: `v${id}`, stage, verdict, findings: findings ? ref(findings) : null, findingsCount: findings ? 1 : 0 }));
  if (acceptFirst) { round("a", 1, "accept", null); j.push(rec("stage.accepted", { stage: 1 })); }
  round("b", acceptFirst ? 2 : 1, "fix", "b");
  round("c", acceptFirst ? 2 : 1, "replan", "c");
  j.push(rec("plan.recorded", { version: 2, plan: ref("2"), firstStage: acceptFirst ? 2 : 1, stageCount: 2 }));
  return j;
}

test("R1: stage titles by global number after a replan; an unloaded plan never lends its numbers old titles", () => {
  const j = replanJournal();
  assert.deepEqual(stageTitleMap(j, planTitles), { 1: "Старая модель", 2: "Новый API", 3: "Новый интерфейс" });
  assert.deepEqual(stageTitleMap(j, (s) => (s === sha("1") ? PLAN1 : null)), { 1: "Старая модель" }, "plan 2 not loaded: stages 2 and 3 unnamed, not 'Старый API'");
  const titles = stageTitleMap(j, planTitles);
  const input = { view: view({ status: "running", reason: null, active: { kind: "turn", purpose: "execute" } }), entries: [{ id: 1, ts: TS, turnId: "e2", role: "executor", provider: "claude", kind: "process_started", text: "", detail: {} }], open: true, stageTitles: titles, now: Date.parse(TS) };
  assert.equal(runStatus("ru", input).doing, "Claude выполняет этап 2: Новый API");
  assert.equal(roleStatus("ru", "executor", input).doing, "Claude выполняет этап 2: Новый API");
});

test("R1: the summary keeps accepted stages under their own plan; replaced ones are apart with their old reviews", () => {
  const m = summaryModel(view(), replanJournal(), { planTitles });
  assert.deepEqual(m.stages.map((s) => [s.n, s.plan, s.title, s.state, s.verdict]), [[1, 1, "Старая модель", "done", "accept"], [2, 2, "Новый API", "not_started", null], [3, 2, "Новый интерфейс", "not_started", null]]);
  assert.deepEqual(m.stageCounts, { done: 1, total: 3 });
  assert.deepEqual(m.superseded.map((s) => [s.n, s.plan, s.title, s.verdict]), [[2, 1, "Старый API", "replan"]]);
  assert.equal(m.stages[1].findings, null, "the new stage 2 carries no remark of the old stage 2");
  assert.ok(m.reviews.filter((r) => r.stage === 2).every((r) => r.state === "superseded"));
  assert.equal(m.currentReview, null, "no open remark after the replan");
  // the unaccepted part replaced from stage 1 on
  const m2 = summaryModel(view(), replanJournal({ acceptFirst: false }), { planTitles });
  assert.deepEqual(m2.stages.map((s) => [s.n, s.plan, s.state]), [[1, 2, "not_started"], [2, 2, "not_started"]]);
  assert.deepEqual(m2.superseded.map((s) => [s.n, s.plan, s.title]), [[1, 1, "Старая модель"]]);
});

test("R2: every required check is listed and counted, the journal adds results and attempts", () => {
  seq = 0;
  const j = [rec("check.started", { checkRunId: "c1", checkId: "cmd-1" }), rec("check.finished", { checkRunId: "c1", status: "passed" })];
  const progress = { finish: [], checks: [{ id: "cmd-1", title: "npm run lint", status: "passed", class: null }, { id: "cmd-2", title: "npm test", status: "not_run", class: null }] };
  const m = summaryModel(view({ status: "stopped", progress }), j, null);
  assert.deepEqual(m.checkCounts, { passed: 1, total: 2 });
  assert.equal(m.checksKnown, true);
  assert.deepEqual(m.checks.map((c) => [c.title, c.status, c.runs]), [["npm run lint", "passed", 1], ["npm test", "not_run", 0]]);
  // without main's progress: the goal's command lines are the list
  const g = summaryModel(view({ status: "stopped" }), j, { goalCommands: ["npm run lint", "npm test"] });
  assert.deepEqual(g.checks.map((c) => [c.title, c.status, c.runs]), [["npm run lint", "passed", 1], ["npm test", "not_run", 0]]);
  assert.equal(g.checksKnown, true);
  // an old journal with no known list: only what was seen, marked as such
  const old = summaryModel(view({ status: "stopped" }), j, null);
  assert.equal(old.checksKnown, false);
  assert.deepEqual(old.checkCounts, { passed: 1, total: 1 });
});

test("R3: the open review and its remarks; replaced, closed and superseded ones are history", () => {
  seq = 0;
  const base = [rec("plan.recorded", { version: 1, plan: ref("1"), firstStage: 1, stageCount: 3 })];
  const review = (turn, stage, verdict, findings) => [rec("orch.turn", { turnId: turn, purpose: "review", stage }),
    rec("turn.finished", { turnId: turn, outcome: "completed", report: { ref: ref(turn) } }), rec("review.recorded", { turnId: turn, stage, verdict, findings: ref(findings) })];
  // fix, then fix again: the first is replaced, the second open
  let m = summaryModel(view(), [...base, ...review("a", 1, "fix", "1"), ...review("b", 1, "fix", "2")], { planTitles });
  assert.deepEqual(m.reviews.map((r) => r.state), ["replaced", "current"]);
  assert.deepEqual(m.currentReview.findings, ref("2"));
  assert.deepEqual(m.currentReview.report, ref("b"), "the review's own report (verdict, question) is linked by its turn");
  // question: open, with the lead's question
  m = summaryModel(view({ reason: "awaiting_answer" }), [...base, ...review("a", 1, "question", "1"), rec("question.asked", { questionId: "q", text: ref("q") })], { planTitles });
  assert.equal(m.currentReview.verdict, "question");
  assert.deepEqual(m.openQuestion, ref("q"));
  // then accept: every remark of the stage is closed
  m = summaryModel(view(), [...base, ...review("a", 1, "fix", "1"), ...review("b", 1, "accept", "2"), rec("stage.accepted", { stage: 1 })], { planTitles });
  assert.deepEqual(m.reviews.map((r) => r.state), ["replaced", "closed"]);
  assert.equal(m.currentReview, null);
  // replan: superseded
  assert.ok(summaryModel(view(), replanJournal(), { planTitles }).reviews.some((r) => r.state === "superseded"));
});

test("R4: the journal reader keeps what it read on a failure and a retry continues without duplicates", async () => {
  const pages = [
    { ok: true, value: { records: [{ seq: 0 }, { seq: 1 }], more: true } },
    { ok: false },
    { ok: true, value: { records: [{ seq: 1 }, { seq: 2 }, { seq: 3 }], more: false } }
  ];
  const asked = [];
  let state = { records: [], next: 0, status: "loading" };
  const states = [];
  const history = async (from) => { asked.push(from); return pages.shift(); };
  const put = (j) => { state = j; states.push(j.status); };
  await readJournal(history, () => state, put);
  assert.deepEqual(states, ["loading", "error"], "between pages it is not 'ready'");
  assert.deepEqual(state.records.map((r) => r.seq), [0, 1]);
  await readJournal(history, () => state, put);
  assert.deepEqual(asked, [0, 2, 2], "the retry asks from the first missing record, nothing else");
  assert.deepEqual(state.records.map((r) => r.seq), [0, 1, 2, 3], "no record twice");
  assert.equal(state.status, "ready");
});

// ---------- the real panel ----------

function props({ records = [], journalStatus = "ready", texts = {}, v = view(), runs, runErrors = {}, tab = "summary" } = {}) {
  const calls = [];
  const orch = {
    runs: runs ?? { r: { view: v, open: true, seq: 9, tick: 0 } }, activity: {}, runErrors, canvas: { links: [], agents: [] },
    journals: { r: { records, next: records.length, status: journalStatus } }, texts,
    commands: { pending: () => [] }, catalog: { checks: [] },
    loadText: (...a) => calls.push(["loadText", ...a]), syncJournal: (...a) => calls.push(["syncJournal", ...a]), retry: () => calls.push(["retry"])
  };
  return { calls, p: { orch, runId: "r", locale: "ru", panel: { linkId: "L", tab, role: "lead", focus: 1 }, onClose() {}, onNewGoal() {}, onView() {} } };
}
const render = (p) => renderToStaticMarkup(React.createElement(RunPanel, p));
const ready = (text) => ({ status: "ready", text });

test("R3 rendered: a paused run shows the lead's open remarks and question; closed ones are only in the history", () => {
  seq = 0;
  const records = [rec("plan.recorded", { version: 1, plan: ref("1"), firstStage: 1, stageCount: 2 }),
    rec("orch.turn", { turnId: "a", purpose: "review", stage: 1 }), rec("review.recorded", { turnId: "a", stage: 1, verdict: "fix", findings: ref("x") }),
    rec("stage.accepted", { stage: 1 }),
    rec("orch.turn", { turnId: "b", purpose: "review", stage: 2 }), rec("turn.finished", { turnId: "b", outcome: "completed", report: { ref: ref("b") } }),
    rec("review.recorded", { turnId: "b", stage: 2, verdict: "question", findings: ref("y") }), rec("question.asked", { questionId: "q", text: ref("q") })];
  const texts = { [sha("1")]: ready(JSON.stringify({ stages: [{ title: "Этап А", task: "a" }, { title: "Этап Б", task: "b" }] })),
    [sha("x")]: ready(JSON.stringify(["OLD_REMARK_CLOSED"])), [sha("y")]: ready(JSON.stringify(["OPEN_REMARK_API"])),
    [sha("b")]: ready(JSON.stringify({ verdict: "question", findings: ["OPEN_REMARK_API"], question: "Какой формат?" })), [sha("q")]: ready("Какой формат ответа нужен?") };
  const html = render(props({ records, texts, v: view({ reason: "awaiting_answer" }) }).p);
  const remarks = html.slice(html.indexOf('data-sum="remarks"'), html.indexOf('data-sum="where"'));
  const open = remarks.slice(0, remarks.indexOf("data-sum-review-history"));
  assert.match(open, /OPEN_REMARK_API/);
  assert.match(open, /Какой формат ответа нужен\?/);
  assert.doesNotMatch(open, /OLD_REMARK_CLOSED/, "a remark closed by the stage's acceptance is not shown as open");
  assert.match(remarks, /data-review-state="closed"[\s\S]*OLD_REMARK_CLOSED/);
  assert.match(html, /Последнее ревью лида — Этап 2: Этап Б; финального ревью ещё нет/);
});

test("R2 rendered: a required command never started is listed with zero attempts and counted", () => {
  seq = 0;
  const records = [rec("check.started", { checkRunId: "c", checkId: "cmd-1" }), rec("check.finished", { checkRunId: "c", status: "passed" })];
  const v = view({ status: "stopped", reason: "user_request", progress: { finish: [], checks: [{ id: "cmd-1", title: "npm run lint", status: "passed", class: null }, { id: "cmd-2", title: "npm test", status: "not_run", class: null }] } });
  const html = render(props({ records, v }).p);
  assert.match(html, /Обязательные команды проверки: 1 из 2 прошли/);
  assert.match(html, /data-check-id="cmd-2" data-check-status="not_run" data-check-runs="0"><code>npm test<\/code> — ещё не запускалась · попыток: 0/);
  const old = render(props({ records, v: view({ status: "stopped" }) }).p);
  assert.match(old, /Полный перечень обязательных команд неизвестен/);
});

test("R4 rendered: a journal error keeps what was read, says it is incomplete, retries from where it stopped", () => {
  seq = 0;
  const records = [rec("run.created", { goal: ref("g") })];
  const { p, calls } = props({ records, journalStatus: "error", texts: { [sha("g")]: ready(JSON.stringify({ text: "Цель", criteria: [] })) } });
  const html = render(p);
  assert.match(html, /data-sum-journal-error/);
  assert.match(html, /журнал загружен не полностью/);
  assert.match(html, /Повторить/);
  assert.match(html, /Цель/, "what was read is kept");
  assert.match(html, /Не загружено: журнал прочитан не полностью/, "absence in the unread part is not 'not specified'");
  assert.doesNotMatch(html.slice(html.indexOf("data-orch-run-summary")), /data-sum-missing/);
  assert.ok(!calls.some(([k]) => k === "syncJournal" || k === "retry"), "rendering starts nothing by itself");
});

test("R4 rendered: a failed run state is an error with retry; a failed report text too", () => {
  const html = render(props({ runs: {}, runErrors: { r: true } }).p);
  assert.match(html, /Не удалось загрузить состояние запуска/);
  assert.match(html, /Повторить/);
  assert.doesNotMatch(html, /Загрузка/);
  seq = 0;
  const records = [rec("orch.turn", { turnId: "f", purpose: "final_review", stage: null }), rec("turn.finished", { turnId: "f", outcome: "completed", report: { ref: ref("f") } }),
    rec("review.recorded", { turnId: "f", stage: null, verdict: "complete", findings: ref("h") })];
  const text = render(props({ records, v: view({ status: "completed", reason: null }), texts: { [sha("f")]: { status: "error" }, [sha("h")]: ready("[]") } }).p);
  const lead = text.slice(text.indexOf('data-sum="lead"'), text.indexOf('data-sum="checks"'));
  assert.match(lead, /data-sum-failed[^>]*>Не удалось загрузить <button[^>]*>Повторить/);
});

// ---------- re-review: an incomplete journal concludes nothing; a final review belongs to its plan ----------

// A completed run: stage 1 got "fix" then "accept"; the final review "complete" with a remark — the tail after `cut`
// is the part not read yet.
function completedJournal() {
  seq = 0;
  return [
    rec("run.created", { goal: ref("g") }), rec("plan.recorded", { version: 1, plan: ref("1"), firstStage: 1, stageCount: 1 }),
    rec("orch.turn", { turnId: "e1", purpose: "execute", stage: 1 }), rec("check.started", { checkRunId: "c1", checkId: "cmd-1" }), rec("check.finished", { checkRunId: "c1", status: "failed" }),
    rec("orch.turn", { turnId: "v1", purpose: "review", stage: 1 }), rec("review.recorded", { turnId: "v1", stage: 1, verdict: "fix", findings: ref("o") }),
    // ---- cut: not read yet ----
    rec("orch.turn", { turnId: "e2", purpose: "execute", stage: 1 }), rec("check.started", { checkRunId: "c2", checkId: "cmd-1" }), rec("check.finished", { checkRunId: "c2", status: "passed" }),
    rec("orch.turn", { turnId: "v2", purpose: "review", stage: 1 }), rec("review.recorded", { turnId: "v2", stage: 1, verdict: "accept", findings: null }), rec("stage.accepted", { stage: 1 }),
    rec("orch.turn", { turnId: "f", purpose: "final_review", stage: null }), rec("turn.finished", { turnId: "f", outcome: "completed", report: { ref: ref("f") } }),
    rec("review.recorded", { turnId: "f", stage: null, verdict: "complete", findings: ref("h") }), rec("run.status", { status: "completed", reason: null })
  ];
}
const CUT = 7;
const completedView = view({ status: "completed", reason: null, stage: null, progress: { finish: [], checks: [{ id: "cmd-1", title: "npm test", status: "passed", class: null }] } });
const completedTexts = () => ({ [sha("1")]: ready(JSON.stringify({ stages: [{ title: "Этап А", task: "a" }] })), [sha("g")]: ready(JSON.stringify({ text: "Цель" })),
  [sha("o")]: ready(JSON.stringify(["OLD_REMARK_FIXED_LATER"])), [sha("f")]: ready(JSON.stringify({ verdict: "complete", findings: ["FINAL_REMARK"], question: null })), [sha("h")]: ready(JSON.stringify(["FINAL_REMARK"])) });

test("re-review 1: a completed run read in part is 'details not loaded', never a negative verdict", () => {
  const part = completedJournal().slice(0, CUT);
  const m = summaryModel(completedView, part, { planTitles, complete: false });
  assert.equal(m.complete, false);
  assert.equal(outcomeKey(completedView, m.finalVerdict, m.complete), "completed_unloaded");
  assert.equal(outcomeKey(completedView, m.finalVerdict), "completed_unconfirmed", "only a fully read journal says the final review did not confirm");
  assert.equal(outcomeKey(completedView, summaryModel(completedView, completedJournal(), { planTitles }).finalVerdict), "completed");
  for (const status of ["loading", "error"]) {
    const { p, calls } = props({ records: part, journalStatus: status, v: completedView, texts: completedTexts() });
    const html = render(p);
    assert.match(html, /Запуск завершён\. Подробности результата ещё не загружены\./, status);
    for (const wrong of ["не подтвердило достижение цели", "финального ревью ещё нет", "не выполнен", "лид не принял", "попыток: 1<"]) assert.ok(!html.includes(wrong), `${status}: ${wrong}`);
    assert.match(html, /состояние не загружено/);
    assert.match(html, /В прочитанной части журнала: 0 из 1 приняты лидом; журнал загружен не полностью/);
    assert.match(html, /попыток: не меньше 1/);
    assert.match(html, /Последнее прочитанное ревью лида — Этап 1: Этап А; дальнейшая часть журнала не загружена/);
    assert.match(html, /актуальность не подтверждена/);
    assert.match(html, /Обязательные команды проверки: 1 из 1 прошли/, "main's own check state is not hidden");
    assert.equal(/data-sum-journal-error/.test(html), status === "error");
    assert.equal(/data-sum-journal-loading/.test(html), status === "loading");
    assert.ok(!calls.some(([k]) => k === "syncJournal" || k === "retry"), "rendering starts nothing");
  }
  // after the rest is read (a retry): the real result, nothing partial left
  const html = render(props({ records: completedJournal(), v: completedView, texts: completedTexts() }).p);
  assert.match(html, /Лид принял цель этого запуска финальным ревью/);
  assert.match(html, /1 из 1 приняты лидом/);
  assert.match(html, /попыток: 2</);
  assert.doesNotMatch(html, /не загружено|не меньше|актуальность не подтверждена/);
  const open = html.slice(html.indexOf('data-sum="remarks"'), html.indexOf("data-sum-review-history"));
  assert.match(open, /FINAL_REMARK/);
  assert.doesNotMatch(open, /OLD_REMARK_FIXED_LATER/);
});

// Stage 1 accepted → final review "replan" → plan 2 → stage 2 executed → review "fix".
function finalReplanJournal() {
  seq = 0;
  return [
    rec("plan.recorded", { version: 1, plan: ref("1"), firstStage: 1, stageCount: 1 }),
    rec("orch.turn", { turnId: "e1", purpose: "execute", stage: 1 }), rec("turn.finished", { turnId: "e1", outcome: "completed", report: { ref: ref("5") } }),
    rec("stage.accepted", { stage: 1 }),
    rec("orch.turn", { turnId: "f1", purpose: "final_review", stage: null }), rec("turn.finished", { turnId: "f1", outcome: "completed", report: { ref: ref("b") } }),
    rec("review.recorded", { turnId: "f1", stage: null, verdict: "replan", findings: ref("c") }),
    rec("plan.recorded", { version: 2, plan: ref("2"), firstStage: 2, stageCount: 1 }),
    rec("orch.turn", { turnId: "e2", purpose: "execute", stage: 2 }), rec("turn.finished", { turnId: "e2", outcome: "completed", report: { ref: ref("6") } }),
    rec("orch.turn", { turnId: "r2", purpose: "review", stage: 2 }), rec("turn.finished", { turnId: "r2", outcome: "completed", report: { ref: ref("d") } }),
    rec("review.recorded", { turnId: "r2", stage: 2, verdict: "fix", findings: ref("e") })
  ];
}

test("re-review 2: a final review belongs to its plan; the new plan's review is the current one", () => {
  const m = summaryModel(view({ stage: 2 }), finalReplanJournal(), { planTitles });
  assert.equal(m.finalVerdict, null);
  assert.equal(m.finalReport, null);
  assert.deepEqual(m.reviews.map((r) => [r.stage, r.verdict, r.state]), [[null, "replan", "superseded"], [2, "fix", "current"]]);
  assert.deepEqual(m.currentReview.findings, ref("e"));
  assert.deepEqual(m.lastReport, ref("6"));
  // a later final review replaces an earlier one; a stage review after a final one replaces it too
  seq = 0;
  const twice = [rec("orch.turn", { turnId: "f", purpose: "final_review", stage: null }), rec("review.recorded", { turnId: "f", stage: null, verdict: "fix", findings: ref("x") }),
    rec("orch.turn", { turnId: "g", purpose: "final_review", stage: null }), rec("review.recorded", { turnId: "g", stage: null, verdict: "complete", findings: ref("y") })];
  assert.deepEqual(summaryModel(view(), twice, null).reviews.map((r) => r.state), ["replaced", "final"]);
  seq = 0;
  const after = [rec("orch.turn", { turnId: "f", purpose: "final_review", stage: null }), rec("review.recorded", { turnId: "f", stage: null, verdict: "fix", findings: ref("x") }),
    rec("orch.turn", { turnId: "v", purpose: "review", stage: 1 }), rec("review.recorded", { turnId: "v", stage: 1, verdict: "fix", findings: ref("y") })];
  const ma = summaryModel(view(), after, null);
  assert.equal(ma.finalVerdict, null);
  assert.deepEqual(ma.currentReview.findings, ref("y"));
});

test("re-review 2 rendered: the old plan's final review, report and next step are history, not the current result", () => {
  const texts = {
    [sha("1")]: ready(JSON.stringify({ stages: [{ title: "Старый этап", task: "a" }] })), [sha("2")]: ready(JSON.stringify({ stages: [{ title: "Новый этап", task: "b" }] })),
    [sha("b")]: ready(JSON.stringify({ verdict: "replan", findings: ["OLD_FINAL_REPLAN"], question: null, nextStep: "OLD_NEXT_STEP" })), [sha("c")]: ready(JSON.stringify(["OLD_FINAL_REPLAN"])),
    [sha("d")]: ready(JSON.stringify({ verdict: "fix", findings: ["CURRENT_STAGE2_FIX"], question: null })), [sha("e")]: ready(JSON.stringify(["CURRENT_STAGE2_FIX"])),
    [sha("5")]: ready(JSON.stringify({ summary: "STAGE1_DONE", done: true })), [sha("6")]: ready(JSON.stringify({ summary: "STAGE2_WORK", done: true }))
  };
  const html = render(props({ records: finalReplanJournal(), texts, v: view({ stage: 2 }) }).p);
  const lead = html.slice(html.indexOf('data-sum="lead"'), html.indexOf('data-sum="checks"'));
  assert.match(lead, /Последнее ревью лида — Этап 2: Новый этап; финального ревью ещё нет/);
  assert.doesNotMatch(lead, /replan|OLD_FINAL/i);
  const remarks = html.slice(html.indexOf('data-sum="remarks"'), html.indexOf('data-sum="where"'));
  const open = remarks.slice(0, remarks.indexOf("data-sum-review-history"));
  assert.match(open, /CURRENT_STAGE2_FIX/);
  assert.doesNotMatch(open, /OLD_FINAL_REPLAN/);
  assert.match(remarks, /Финальное ревью · план v1 · нужен новый план — <i>заменено новым планом<\/i>[\s\S]*OLD_FINAL_REPLAN/);
  const next = html.slice(html.indexOf('data-sum="next"'));
  assert.doesNotMatch(next, /OLD_NEXT_STEP/);
  assert.match(html, /STAGE2_WORK/);
  assert.doesNotMatch(html.slice(html.indexOf('data-sum="outcome"'), html.indexOf('data-sum="stages"')), /Лид принял цель/);
});
