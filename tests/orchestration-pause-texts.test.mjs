// UX audit 2026-10-05, PR 1 ("Pauses are clear"): every pause reason of the journal says what happened, why, what to do
// and has one main button — an action main accepts on that pause; the header's main button is that action, Stop is
// secondary; the link chip, the cards, the feed and the widget say "Waiting for you: …" / "Paused: …"; a plan proposal
// that drops criteria offers the safe choice first; an unavailable sandbox on macOS never says "run on macOS".
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, Module } from "node:module";
import { test } from "node:test";
import { PAUSED_REASONS_V2 } from "../src/main/services/orchestration/journal.ts";
import { PAUSES, availableActions, pauseLabel, pauseText, primaryAction } from "../src/renderer/src/features/orchestration/runModel.ts";
import { runStatus } from "../src/renderer/src/features/orchestration/runStatus.ts";
import { t } from "../src/renderer/src/lib/i18n.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETS = [...PAUSED_REASONS_V2, "sandbox_unsupported", "awaiting_checks_none"];
const FIELDS = ["what", "why", "do", "button"];
const view = (status, reason, extra = {}) => ({ runId: "r", revision: 1, status, reason, stage: null, active: null, permission: null, halted: false,
  newer: null, workMode: "project", workDir: "/p", progress: null, proposal: null, refused: null, confirm: null, decisions: null, ...extra });

test("every pause reason of the journal has what / why / what to do / button in both languages, in the person's words", () => {
  assert.deepEqual(Object.keys(PAUSES).sort(), [...PAUSED_REASONS_V2].sort(), "a new pause reason needs its words and its main action in PAUSES");
  for (const locale of ["ru", "en"]) {
    const titles = new Set();
    for (const set of SETS) {
      const [what, why, todo, button] = FIELDS.map((f) => t(locale, `orchPause_${set}_${f}`));
      for (const [f, text] of [["what", what], ["why", why], ["do", todo], ["button", button]]) {
        assert.ok(typeof text === "string" && text.trim().length > 1, `${locale}: orchPause_${set}_${f}`);
        // no internal words: snake_case codes, runKey, a reason's own name
        assert.doesNotMatch(text, /\b[a-z]+_[a-z_]+\b|runKey|coverage|invalid_report/, `${locale}: orchPause_${set}_${f}: ${text}`);
      }
      assert.ok(!titles.has(what), `${locale}: two pauses are called the same: ${what}`);
      titles.add(what);
      assert.ok(!why.toLowerCase().includes(what.toLowerCase()), `${locale}: ${set}: the why repeats the headline`);
      assert.ok(button.length <= 28, `${locale}: ${set}: one short action, not a sentence: ${button}`);
    }
  }
});

test("the main button of every pause is an action the panel offers and main accepts on that pause", () => {
  const main = fs.readFileSync(path.join(HERE, "..", "src/main/services/orchestration/orchestrationService.ts"), "utf8");
  const set = (name) => [...main.match(new RegExp(`const ${name}: readonly string\\[\\] = \\[([^\\]]+)\\]`))[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const [resumable, stepOnly, stopOnly] = [set("RESUMABLE"), set("STEP_ONLY"), set("STOP_ONLY")];
  // the command's own gate in main names the pause it is accepted on
  const gate = { answer: 'case "answer"', raise_limit: 'case "raise_limit"', recover: 'case "recover"', checks_decide: 'case "checks.decide"',
    check_amend: 'case "check.amend"', finish_confirm: 'case "finish.confirm"', person_decide: "async function personDecide", plan_decide: "async function planDecide" };
  for (const reason of PAUSED_REASONS_V2) {
    const { primary } = PAUSES[reason];
    assert.ok(availableActions(view("paused", reason)).includes(primary), `${reason}: ${primary} is offered`);
    assert.equal(primaryAction(view("paused", reason)), primary);
    if (primary === "resume") assert.ok(resumable.includes(reason), `${reason}: main resumes it`);
    else if (primary === "step") assert.ok(stepOnly.includes(reason) || resumable.includes(reason), `${reason}: main steps it`);
    else if (primary === "stop") assert.ok(stopOnly.includes(reason), `${reason}: stopping is all main allows — else the pause has a better main action`);
    else {
      const at = main.indexOf(gate[primary]);
      assert.ok(at > 0, primary);
      assert.ok(main.slice(at, at + 2500).includes(`"${reason}"`), `${reason}: main's ${primary} is accepted on it`);
    }
  }
  assert.equal(primaryAction(view("running", null)), "pause", "while the run works, Pause is the main action");
});

const requireApp = createRequire(path.join(HERE, "..", "package.json"));
async function bundle(entry) {
  const out = await requireApp("esbuild").build({
    entryPoints: [path.join(HERE, "..", entry)], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
    loader: { ".svg": "dataurl", ".png": "dataurl", ".ico": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
    plugins: [{ name: "same-react", setup(b) { b.onResolve({ filter: /^react(\/.*)?$/ }, (a) => ({ path: requireApp.resolve(a.path), external: true })); } }]
  });
  const file = path.join(HERE, "..", `${path.basename(entry)}.pause-texts.cjs`);
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.join(HERE, ".."));
  mod._compile(out.outputFiles[0].text, file);
  return mod.exports;
}
const panelOf = async () => {
  const React = requireApp("react");
  const { renderToStaticMarkup } = requireApp("react-dom/server");
  const { RunPanel } = await bundle("src/renderer/src/features/orchestration/RunPanel.tsx");
  return (v, { locale = "ru", tab = "overview", entries = [] } = {}) => renderToStaticMarkup(React.createElement(RunPanel, {
    orch: { runs: { r: { view: v, open: true, seq: 9, tick: 0 } }, activity: { r: { entries, gaps: [], firstId: entries[0]?.id ?? 0, status: "ready", resyncs: 0 } },
      runErrors: {}, canvas: { links: [], agents: [] }, journals: { r: { records: [], next: 0, status: "ready" } }, texts: {},
      commands: { pending: () => [] }, catalog: { checks: [] }, loadText() {}, syncJournal() {}, retry() {}, stageTitles: () => ({}) },
    runId: "r", locale, panel: { linkId: "L", tab, role: "lead", focus: 1 }, onClose() {}, onNewGoal() {}, onView() {}
  }));
};
const buttons = (html) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1], text: m[2].replace(/<[^>]+>/g, "") }));

test("the header's main button is the pause's action; Stop is secondary and last; the headline is said once", async () => {
  const panel = await panelOf();
  const primaryOf = (html) => buttons(html).filter((b) => /class="[^"]*orch-primary/.test(b.attrs));
  const stopOf = (html) => buttons(html).find((b) => b.text === t("ru", "orchStop") || b.text === t("ru", "orchPause_lead_modified_tree_button"));

  const resumed = panel(view("paused", "user_request"));
  assert.match(primaryOf(resumed)[0].attrs, /data-orch-primary="resume"/);
  assert.equal(primaryOf(resumed)[0].text, "Продолжить");
  assert.match(stopOf(resumed).attrs, /class="orch-stop"/, "Stop is secondary");
  assert.doesNotMatch(stopOf(resumed).attrs, /orch-danger|orch-primary/);
  const at = resumed.indexOf("data-orch-actions");
  const row = buttons(resumed.slice(at, resumed.indexOf("</div>", at)));
  assert.equal(row.at(-1).text, "Стоп", "Stop is last in the row");

  const step = panel(view("paused", "invalid_report"));
  assert.equal(primaryOf(step)[0].text, "Повторить ход", "the button says what the text says");
  assert.match(step, /Нажмите «Повторить ход»/);

  // a pause decided in a form: the form's own main button, right under the next step, is the main one — before Stop
  const proposal = { checks: [{ id: "c1", command: "npm test", why: "the tests", source: [] }], none: null };
  const checks = panel(view("paused", "awaiting_checks_decision", { proposal }));
  assert.match(primaryOf(checks)[0].attrs, /data-orch-checks-accept/);
  assert.ok(checks.indexOf("data-orch-checks-accept") < checks.indexOf("data-orch-actions"), "the form before the Stop row");
  assert.ok(checks.indexOf("data-orch-next") < checks.indexOf("data-orch-checks-proposal"), "the form right under what to do");
  assert.match(stopOf(checks).attrs, /class="orch-stop"/);

  const limit = panel(view("paused", "limit_reached"));
  assert.match(primaryOf(limit)[0].attrs, /data-orch-primary="raise_limit"/);
  assert.match(limit, /Новое значение/, "the limit's field says what it is");

  const tree = panel(view("paused", "lead_modified_tree"));
  assert.match(stopOf(tree).attrs, /orch-danger/, "where stopping is all main allows, Stop is the main action");
  assert.equal(stopOf(tree).text, "Остановить запуск");
  assert.doesNotMatch(tree, /контрольной точке/, "no button to return to a checkpoint here, so it is not advised");

  const running = panel(view("running", null));
  assert.match(primaryOf(running)[0].attrs, /data-orch-primary="pause"/);
  assert.match(stopOf(running).attrs, /class="orch-stop"/);

  for (const reason of ["needs_user_action", "awaiting_person_decision", "coverage_lost"]) {
    const html = panel(view("paused", reason)).replace(/<[^>]+>/g, "\n");
    const what = t("ru", `orchPause_${reason}_what`);
    assert.equal(html.split(what).length - 1, 1, `${reason}: the headline once`);
    assert.doesNotMatch(html, /Нужно ваше (действие|решение)/i);
  }
});

test("the link chip, the cards, the feed and the widget say «Ждёт вас: …» / «Пауза: …» from the same words", async () => {
  assert.equal(pauseLabel("ru", { kind: "reason", reason: "awaiting_answer" }, true), "Ждёт вас: агент задал вопрос");
  assert.equal(pauseLabel("ru", { kind: "reason", reason: "user_request" }, true), "Пауза: вы поставили запуск на паузу");
  assert.equal(pauseLabel("en", { kind: "reason", reason: "coverage_lost" }, true), "Waiting for you: the lead proposes dropping some readiness criteria");
  const row = runStatus("ru", { view: view("paused", "awaiting_answer"), entries: [], now: Date.now(), stageTitles: {} });
  assert.equal(row.state, "waiting_user");
  assert.equal(row.doing, "Ждёт вас: агент задал вопрос");
  assert.equal(row.wait, t("ru", "orchPause_awaiting_answer_why"));
  assert.equal(runStatus("ru", { view: view("paused", "step_done"), entries: [], now: Date.now(), stageTitles: {} }).doing, "Пауза: шаг сделан");
  // the feed
  const panel = await panelOf();
  const entries = [{ id: 1, ts: "2026-10-05T10:00:00.000Z", runId: "r", role: "run", provider: null, turnId: null, kind: "status", text: "paused",
    detail: { status: "paused", reason: "coverage_lost" } }];
  assert.match(panel(view("paused", "coverage_lost"), { tab: "activity", entries }).replace(/<[^>]+>/g, ""), /Ждёт вас: лид предлагает убрать часть критериев готовности/);
  // the chip and the cards take the same function
  const scene = fs.readFileSync(path.join(HERE, "..", "src/renderer/src/features/orchestration/AgentScene.tsx"), "utf8");
  assert.equal(scene.match(/viewPauseLabel\(locale, view,/g)?.length, 2, "the link chip and the agent cards");
});

test("a plan proposal that drops criteria: «Вернуть лиду» is the main button, accepting the drop is secondary and says what is lost", async () => {
  const panel = await panelOf();
  const decisions = { runKey: "k".repeat(64), disputed: [], conditions: [], findings: false,
    proposal: { proposalTurnId: "t1", dropped: [{ id: "C2", text: "node --test passes", covers: ["R2"], why: "no tests" }], dropRequirements: [],
      uncovered: ["R2"], stages: [{ stage: 1, title: "Note" }], findings: [] } };
  const html = panel(view("paused", "coverage_lost", { decisions, proposalWaits: true }));
  const b = buttons(html);
  const ret = b.find((x) => /data-orch-proposal-return/.test(x.attrs));
  const acc = b.find((x) => /data-orch-proposal-accept/.test(x.attrs));
  assert.match(ret.attrs, /orch-primary/);
  assert.doesNotMatch(acc.attrs, /orch-primary/);
  assert.equal(acc.text, "Принять снятие");
  assert.ok(html.indexOf("data-orch-proposal-return") < html.indexOf("data-orch-proposal-accept"), "the safe choice first");
  assert.match(html, /перестанут проверяться/);
});

test("an unavailable sandbox on macOS is a failed self-test with what to do — never «run on macOS»; elsewhere the platform has none", () => {
  const v = view("paused", "sandbox_unavailable");
  for (const locale of ["ru", "en"]) {
    const mac = pauseText(locale, v, [], true);
    assert.doesNotMatch(`${mac.what} ${mac.why} ${mac.todo}`, /запустите на macOS|run on macOS/i);
    assert.match(mac.todo, locale === "ru" ? /впишите|вписав/i : /your own check commands/);
    assert.equal(mac.primary, "stop");
    assert.equal(pauseText(locale, v, [], false).what, t(locale, "orchPause_sandbox_unsupported_what"));
  }
});
