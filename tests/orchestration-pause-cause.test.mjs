// One classification of a pause for every place that says why a run paused: the run panel (summary and overview, its
// feed and its history), the activity rows on the canvas and HOME, and the agent cards. Real data: the journal and the
// activity of real series S3 attempt 2, where a Codex usage limit ended the lead's turn
// (docs/agent-orchestration/evidence/real-stage-13/series-S3-S5-S6-attempt2). Link chips and a workspace's run list
// show the status only, without a reason. No Electron, no CLI.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, Module } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { activityRuns, roleStatus, runStatus } from "../src/renderer/src/features/orchestration/runStatus.ts";
import { causeText, viewCause } from "../src/renderer/src/features/orchestration/runModel.ts";
import { t } from "../src/renderer/src/lib/i18n.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "docs/agent-orchestration/evidence/real-stage-13/series-S3-S5-S6-attempt2");
const require = createRequire(path.join(ROOT, "package.json"));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

async function loadRunPanel() {
  const { build } = require("esbuild");
  const out = await build({
    entryPoints: [path.join(ROOT, "src/renderer/src/features/orchestration/RunPanel.tsx")],
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
    loader: { ".svg": "dataurl", ".png": "dataurl", ".ico": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
    plugins: [{ name: "same-react", setup(b) { b.onResolve({ filter: /^react(\/.*)?$/ }, (a) => ({ path: require.resolve(a.path), external: true })); } }]
  });
  const file = path.join(ROOT, "run-panel-pause-cause.cjs");
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(ROOT);
  mod._compile(out.outputFiles[0].text, file);
  return mod.exports.RunPanel;
}
const RunPanel = await loadRunPanel();

const lines = (f) => fs.readFileSync(path.join(EVIDENCE, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const records = lines("run-journal.jsonl").map((r) => ({ seq: r.seq, ts: r.ts, type: r.type, data: r.data }));
const entries = lines("codex-turn-error.jsonl");
const view = { runId: "r", status: "paused", reason: "environment_error", stage: null, turns: 1, revision: 8, halted: false, active: null };
const LOCALE = "ru";
const REASON = t(LOCALE, "orchReason_provider_limit").replace("{provider}", "Codex");
const HEADLINE = t(LOCALE, "orchHeadline_provider_limit");
const ENV = t(LOCALE, "orchReason_environment_error");

function panel(tab) {
  const orch = {
    runs: { r: { view, open: true, seq: 9, tick: 0 } }, activity: { r: { entries, gaps: [], firstId: entries[0].id, status: "ready", resyncs: 0 } },
    runErrors: {}, canvas: { links: [], agents: [] }, journals: { r: { records, next: records.length, status: "ready" } }, texts: {},
    commands: { pending: () => [] }, catalog: { checks: [] }, loadText() {}, syncJournal() {}, retry() {}
  };
  return renderToStaticMarkup(React.createElement(RunPanel, {
    orch, runId: "r", locale: LOCALE, panel: { linkId: "L", tab, role: "lead", focus: 1 }, onClose() {}, onNewGoal() {}, onView() {}
  }));
}
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a Codex usage limit: the same reason and headline in the panel, the activity rows and the agent cards", () => {
  assert.deepEqual(viewCause(view, entries), { kind: "provider_limit", reason: "environment_error", provider: "codex", resetsAt: "Sep 28th, 2026 11:51 PM" });
  assert.equal(causeText(LOCALE, viewCause(view, entries)), REASON);

  const input = { view, entries, open: true, stageTitles: null, now: Date.parse("2026-09-26T05:31:00Z") };
  const row = runStatus(LOCALE, input);
  assert.equal(row.wait, REASON, "activity row on the canvas and in HOME");
  assert.equal(row.doing, HEADLINE);
  for (const role of ["lead", "executor"]) {
    const card = roleStatus(LOCALE, role, input);
    assert.equal(card.wait, REASON, `agent card: ${role}`);
    assert.equal(card.doing, HEADLINE);
  }
  const rows = activityRuns(LOCALE, { links: [{ linkId: "L", fromAgentId: "a", runIds: ["r"] }], agents: [{ agentId: "a", project: "/p" }],
    runs: { r: { view, open: true } }, entries: () => entries, lastRecordAt: () => null, runErrors: {}, stageTitles: () => null, now: input.now });
  assert.equal(rows.active[0].line.wait, REASON);
  assert.deepEqual(rows.active[0].roles.map((r) => r.line.wait), [REASON, REASON]);

  const overview = panel("overview");
  assert.match(overview, new RegExp(`data-orch-reason="?[^>]*>${REASON}<`), "run panel: overview");
  assert.match(text(overview), new RegExp(HEADLINE));
  const summary = text(panel("summary"));
  assert.match(summary, new RegExp(`${t(LOCALE, "orchSum_reason")}: ${REASON}`), "run panel: summary");
  assert.match(text(panel("activity")), new RegExp(`${t(LOCALE, "orchAct_status")}: [^—]+ — ${REASON}`), "run panel: feed");
  assert.match(text(panel("history")), new RegExp(`— ${REASON}`), "run panel: history");
  for (const [where, html] of [["overview", overview], ["summary", summary], ["activity", panel("activity")], ["history", panel("history")]]) {
    assert.doesNotMatch(text(html), new RegExp(`— ${ENV}|: ${ENV}|>${ENV}<`), `${where}: never "environment error" for this pause`);
  }
});

test("an ordinary failed turn stays an environment error everywhere", () => {
  const plain = entries.map((e) => (e.kind === "error" ? { ...e, text: "turn failed: mock failure" } : e));
  const input = { view, entries: plain, open: true, stageTitles: null, now: 0 };
  assert.equal(runStatus(LOCALE, input).wait, ENV);
  assert.equal(roleStatus(LOCALE, "lead", input).wait, ENV);
  assert.equal(causeText(LOCALE, viewCause(view, plain)), ENV);
});
