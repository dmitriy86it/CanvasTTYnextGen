// UX audit 2026-10-05, PR 2 ("Summary and decisions"): the result block never says the opposite of the headline or of
// itself; journal ids read as «Замечание 1» / «Критерий 1»; push and QA are two separate decisions; the glossary
// explains its terms on hover; the link chip never covers a card.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, Module } from "node:module";
import { test } from "node:test";
import { GLOSSARY, board, conditionStatusKey, factLines, glossarySplit, idLabel, nextStepText, pauseText, requirementStatusKey, resultFacts }
  from "../src/renderer/src/features/orchestration/runModel.ts";
import { chipCenter, chipSize } from "../src/renderer/src/features/orchestration/linkChip.ts";
import { t } from "../src/renderer/src/lib/i18n.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const view = (status, reason = null, extra = {}) => ({ runId: "r", revision: 1, status, reason, stage: 1, active: null, permission: null, halted: false,
  newer: null, workMode: "project", workDir: "/p", progress: null, proposal: null, refused: null, confirm: null, decisions: null, ...extra });
const digest = (o = {}) => ({ plan: null, question: null, checks: [], finalVerdict: null, goal: null, createdAt: null, lastExecuteReport: null,
  checkpoints: [], acceptedStages: [], currentTask: null, ...o });
const progress = (o = {}) => ({ checks: [], finish: [], completion: null, conditions: null, findings: null, ...o });
const conditions = { met: 1, total: 1, dropped: [], requirements: [{ id: "R1", text: "node --test passes", status: "met", why: null, conditions: ["C1"] }],
  conditions: [{ id: "C1", text: "src/note.mjs exists", covers: ["R1"], status: "met", evidence: { kind: "change", check: null }, proof: null, stale: false }] };

// the states the audit and after-pr1 found contradictions in, and their neighbours
const STATES = [
  { name: "completed, accepted by the reviewer (the lead's final verdict not in the digest)", v: view("completed", null, { progress: progress({ completion: "checked", checks: [{ id: "c", title: "npm test", status: "passed", class: null }] }) }),
    d: digest({ checks: [{ checkRunId: "x", checkId: "c", status: "passed", reason: null }] }), changed: 2 },
  { name: "completed without checks, a criterion met by the review", v: view("completed", null, { progress: progress({ completion: "no_checks", conditions }) }), d: digest({ finalVerdict: "complete" }), changed: 1 },
  { name: "completed in the project folder, nothing changed", v: view("completed", null, { progress: progress({ completion: "checked" }) }), d: digest({ finalVerdict: "complete" }), changed: 0 },
  { name: "paused: the lead changed the tree (no change against the start)", v: view("paused", "lead_modified_tree", { progress: progress() }), d: digest(), changed: 0 },
  { name: "paused: limit reached", v: view("paused", "limit_reached", { progress: progress({ conditions: { ...conditions, met: 1, requirements: [{ ...conditions.requirements[0], status: "not_checked" }] } }) }), d: digest(), changed: 1 },
  { name: "paused by the person", v: view("paused", "user_request", { progress: progress() }), d: digest(), changed: null },
  { name: "running", v: view("running", null, { progress: progress() }), d: digest(), changed: null },
  { name: "stopped", v: view("stopped", null, { progress: progress() }), d: digest(), changed: 3 }
];

test("the result block: no line says the opposite of another or of the headline, in every state (ru and en)", () => {
  for (const locale of ["ru", "en"]) {
    for (const s of STATES) {
      const facts = resultFacts(s.v, s.d, s.changed, null);
      const lines = Object.fromEntries(factLines(locale, s.v, facts, true).map((l) => [l.key, l.value]));
      const noChecks = s.v.progress?.completion === "no_checks";
      const at = `${locale}: ${s.name}`;
      // «Завершён» never beside «Цель принята …: нет»; a run that is not over never reads "not accepted" either
      if (s.v.status === "completed") assert.equal(lines.accepted, t(locale, "orchYes"), at);
      if (["running", "paused"].includes(s.v.status)) assert.notEqual(lines.accepted, t(locale, "orchNo"), `${at}: not decided yet, never "no"`);
      // without checks nothing reads as passed or as met by a command
      if (noChecks) {
        assert.notEqual(lines.checks, t(locale, "orchFactChecks_passed"), at);
        for (const c of s.v.progress.conditions.conditions) {
          if (c.status === "met" && c.evidence.kind !== "check") assert.equal(conditionStatusKey(c.status, true, false), "orchCond_met_review", at);
        }
        for (const r of s.v.progress.conditions.requirements) if (r.status === "met") assert.equal(requirementStatusKey(r.status, true), "orchCond_met_review", at);
        assert.doesNotMatch(t(locale, "orchCond_met_review"), /^(выполнено|met)$/);
      }
      // a requirement waiting for its review is not "not checked" beside "1 of 1 conditions met"
      for (const r of s.v.progress?.conditions?.requirements ?? []) if (r.status === "not_checked") assert.equal(requirementStatusKey(r.status, noChecks), "orchReq_not_checked", at);
      // «лид изменил файлы» never beside «изменений нет»
      if (s.v.status === "paused" && s.v.reason === "lead_modified_tree") assert.notEqual(lines.changes, t(locale, "orchFactChanges_no"), at);
      // a pause always waits for the person: never «От вас: ничего не нужно»
      if (s.v.status === "paused") assert.equal(board(s.v).action, true, at);
      // the headline of a pause is its own words, never the old generic one
      if (s.v.status === "paused") assert.notEqual(pauseText(locale, s.v, [], true).what, t(locale, "orchHeadline_needs_decision"), at);
      // "commit them" only if there are changes: the next step never asserts changes the facts deny
      if (s.v.status === "completed" && facts.changes === "no") assert.match(nextStepText(locale, s.v, []), locale === "ru" ? /если изменения есть/ : /if there are changes/, at);
    }
  }
});

test("checks that never ran read «not run yet», never «0 of N passed» (it reads as failed)", async () => {
  const v = view("running", null, { progress: progress({ checks: [{ id: "c", title: "npm test", status: "not_run", class: null }], checksFrom: "proposal", mode: "autopilot" }) });
  assert.deepEqual([board(v).checked.ran, board(v).checked.total], [0, 1]);
  const html = (await panelOf())(v).replace(/<[^>]+>/g, "");
  assert.match(html, /1, ещё не запускались/);
  assert.doesNotMatch(html, /0 из 1 прошли/);
});

test("journal ids read as «Замечание 1», «Критерий 1», «Требование 1»; the id itself is the tooltip", async () => {
  assert.equal(idLabel("ru", "F1"), "Замечание 1");
  assert.equal(idLabel("ru", "C12"), "Критерий 12");
  assert.equal(idLabel("ru", "R2"), "Требование 2");
  assert.equal(idLabel("en", "F3"), "Finding 3");
  assert.equal(idLabel("en", "LIKE-F1"), "LIKE-F1", "anything else stays as it is");
  const panel = await panelOf();
  const decisions = { runKey: "k".repeat(64), findings: false, conditions: [{ id: "C2", text: "the person checks it" }],
    disputed: [{ reviewTurnId: "t1", index: 0, problem: "still undocumented", evidence: null, paths: [], candidates: [{ id: "F1", problem: "note is not documented", paths: [] }] }] };
  const html = panel(view("paused", "awaiting_person_decision", { decisions }));
  const text = html.replace(/<[^>]+>/g, "");
  assert.match(text, /Закрытое замечание 1/);
  assert.match(text, /Повтор замечания 1/);
  assert.match(text, /Критерий 2 подтверждаете вы/);
  assert.doesNotMatch(text, /\b[FC]\d\b/, "no bare F1 or C2 in the text");
  assert.match(html, /title="F1"/, "the id in the tooltip");
  const drop = { ...decisions, disputed: [], conditions: [], proposal: { proposalTurnId: "p", dropped: [{ id: "C2", text: "x", covers: ["R2"], why: "w" }], dropRequirements: [{ id: "R2", text: "y", why: "w" }],
    uncovered: ["R2"], stages: [{ stage: 1, title: "s" }], findings: [] } };
  const proposal = panel(view("paused", "coverage_lost", { decisions: drop, proposalWaits: true }));
  assert.match(proposal.replace(/<[^>]+>/g, ""), /Критерий 2[\s\S]*Требование 2[\s\S]*Останутся без критериев: Требование 2/);
  // what the decision is about stays in view: the headline and the dropped list in one sticky block, before the choices
  const head = proposal.indexOf("data-orch-proposal-head");
  assert.ok(head > 0 && head < proposal.indexOf("data-orch-proposal-drop") && proposal.indexOf("data-orch-proposal-uncovered") < proposal.indexOf("data-orch-proposal-return"));
});

test("push and deploy to QA are two separate groups, each confirmed or declined on its own", async () => {
  const panel = await panelOf();
  const html = panel(view("paused", "awaiting_finish_confirmation", { confirm: { tree: "t".repeat(40), commit: "c".repeat(40), push: true, qa: true } }));
  const groups = [...html.matchAll(/<fieldset class="orch-field orch-finish-group" data-orch-finish-step="(push|qa)"><legend>([^<]+)<\/legend>([\s\S]*?)<\/fieldset>/g)];
  assert.deepEqual(groups.map((g) => g[1]), ["push", "qa"]);
  assert.deepEqual(groups.map((g) => g[2]), [t("ru", "orchFinishGroup_push"), t("ru", "orchFinishGroup_qa")]);
  for (const g of groups) assert.deepEqual([...g[3].matchAll(/data-orch-finish-choice="([a-z]+:[a-z]+)"/g)].map((m) => m[1]), [`${g[1]}:confirm`, `${g[1]}:decline`]);
  assert.match(html, /data-orch-finish-independent/);
});

test("the glossary: every listed term has one sentence in en and ru and is explained on hover; One step and Resume say how they differ", async () => {
  const terms = ["lead", "executor", "reviewer", "turn", "round", "sandbox", "push", "qa", "criterion", "finding"];
  assert.deepEqual(Object.keys(GLOSSARY).sort(), [...terms].sort());
  const samples = { ru: "лид исполнитель проверяющий ход раунд песочница push QA критерий замечание", en: "lead executor reviewer turn round sandbox push QA criterion finding" };
  for (const locale of ["ru", "en"]) {
    for (const term of terms) assert.match(t(locale, `orchTerm_${term}`), /^\S.{20,200}[.)]$/, `${locale}: orchTerm_${term}`);
    const found = glossarySplit(locale, samples[locale]).filter((p) => typeof p !== "string").map((p) => p.term);
    assert.deepEqual(found, terms, locale);
  }
  assert.deepEqual(glossarySplit("ru", "выход из хода").filter((p) => typeof p !== "string").map((p) => p.text), ["хода"], "inside another word nothing is marked");
  const panel = await panelOf();
  const html = panel(view("paused", "step_done"));
  assert.match(html, new RegExp(`title="${t("ru", "orchStepHint")}"`));
  assert.match(html, new RegExp(`title="${t("ru", "orchResumeHint")}"`));
  assert.match(t("ru", "orchStepHint"), /один ход и снова встать на паузу/);
  assert.match(t("ru", "orchResumeHint"), /до завершения или следующей паузы/);
  assert.match(panel(view("paused", "lead_modified_tree")), /<abbr class="orch-term" title="[^"]+" data-term="lead">Лид<\/abbr>/);
});

test("the link chip never covers a card: between the cards when it fits, else under (or above) them", () => {
  const overlaps = (c, s, r) => c.x - s.width / 2 < r.x + r.width && r.x < c.x + s.width / 2 && c.y - s.height / 2 < r.y + r.height && r.y < c.y + s.height / 2;
  const card = (x, y) => ({ x, y, width: 200, height: 140 });
  const size = chipSize("Ждёт вас: лид предлагает убрать часть критериев готовности", 2);
  const cases = [
    { name: "far apart: the middle", from: card(0, 0), to: card(900, 0), others: [] },
    { name: "close (the audit's screen): under the pair", from: card(220, 170), to: card(475, 170), others: [] },
    { name: "close, a card under them: above", from: card(0, 200), to: card(260, 200), others: [card(100, 360)] },
    { name: "the executor below the lead", from: card(0, 0), to: card(40, 300), others: [] }
  ];
  for (const c of cases) {
    const cards = [c.from, c.to, ...c.others];
    const at = chipCenter(c.from, c.to, cards, size);
    for (const r of cards) assert.ok(!overlaps(at, size, r), `${c.name}: ${JSON.stringify(at)} covers ${JSON.stringify(r)}`);
  }
  assert.deepEqual(chipCenter(card(0, 0), card(900, 0), [], size), { x: 550, y: 70 }, "far apart: exactly between them, as before");
});

const requireApp = createRequire(path.join(HERE, "..", "package.json"));
async function bundle(entry) {
  const out = await requireApp("esbuild").build({
    entryPoints: [path.join(HERE, "..", entry)], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
    loader: { ".svg": "dataurl", ".png": "dataurl", ".ico": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
    plugins: [{ name: "same-react", setup(b) { b.onResolve({ filter: /^react(\/.*)?$/ }, (a) => ({ path: requireApp.resolve(a.path), external: true })); } }]
  });
  const file = path.join(HERE, "..", `${path.basename(entry)}.summary-decisions.cjs`);
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.join(HERE, ".."));
  mod._compile(out.outputFiles[0].text, file);
  return mod.exports;
}
async function panelOf() {
  const React = requireApp("react");
  const { renderToStaticMarkup } = requireApp("react-dom/server");
  const { RunPanel } = await bundle("src/renderer/src/features/orchestration/RunPanel.tsx");
  return (v, { locale = "ru", tab = "overview" } = {}) => renderToStaticMarkup(React.createElement(RunPanel, {
    orch: { runs: { r: { view: v, open: true, seq: 9, tick: 0 } }, activity: { r: { entries: [], gaps: [], firstId: 0, status: "ready", resyncs: 0 } },
      runErrors: {}, canvas: { links: [], agents: [] }, journals: { r: { records: [], next: 0, status: "ready" } }, texts: {},
      commands: { pending: () => [] }, catalog: { checks: [] }, loadText() {}, syncJournal() {}, retry() {}, stageTitles: () => ({}) },
    runId: "r", locale, panel: { linkId: "L", tab, role: "lead", focus: 1 }, onClose() {}, onNewGoal() {}, onView() {}
  }));
}
