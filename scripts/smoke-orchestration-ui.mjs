// Electron UI smoke for stage 8: the real window driven over the DevTools protocol (mouse and key events as the
// user makes them, screenshots), with fake Codex/Claude CLIs (tests/fixtures/orchestration/mock-*.mjs).
// Two launches on one user-data directory:
//   first:   agent cards from the context menu, zoom + pan, a card moved, refused links (keyboard: other project;
//            mouse: onto itself, a repeat), the link by a port drag; run 1 to completed with the executor held
//            mid-turn; run 2 paused at the plan review, stopped; run 3 stopped while the executor works; a reload;
//   restart: cards, link and runs as they were, nothing started by itself; the link deleted after the stop.
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-orchestration-ui.mjs [--shots <dir>]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, byText, canvasState, card, cardText, createAgent, launch as launchApp, openTab, q, visibleNow, runs, sleep, startGoal as startGoalKit, workspace, JOURNAL_V2 } from "./orchestration-app-kit.mjs";

const { TMP, D, project, script } = workspace("cto-ui-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9400 + Math.floor(Math.random() * 400);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };

// ---------- projects and fake CLIs ----------
const projectA = project("project-a");
const projectB = project("project-b");

const planR = { report: { stages: [{ title: "Заметка", task: "Add src/note.mjs exporting a constant" }], question: null } };
const verdict = (v) => ({ report: { verdict: v, findings: [], question: null } });
// run 1: plan; round 1 adds a failing test, the check fails and the lead asks for a fix with two findings; round 2
// fixes it, the check passes, review accept, final review. run 2: plan (then the plan review pause). run 3: plan
// (then the held executor is stopped).
const FINDINGS = ["tests/extra.test.mjs fails: 1 + 1 is not 3", "keep sum() pure"];
// With the development flag CANVASTTY_JOURNAL_V2=1 the run is written in v2: the lead plans with conditions (R1 by the
// note, R2 by the check), the reviewer answers the reviews — the same two findings as blocking ones, closed in round 2
// (journal-v2-format.md §2.7, §2.8).
const V2 = JOURNAL_V2;
const planV2 = { report: { stages: [{ title: "Заметка", task: "Add src/note.mjs exporting a constant", conditions: [
  { keep: null, text: "src/note.mjs exists", covers: ["R1"], evidence: { kind: "change", check: null } },
  { keep: null, text: "node --test passes", covers: ["R2"], evidence: { kind: "check", check: "cmd-1" } }] }], dropped: [], dropRequirements: [], question: null } };
const findingV2 = (problem, id = null, status = "open") => ({ id, severity: "blocking", condition: null, problem, evidence: "tests/extra.test.mjs", closeWhen: "the test passes",
  status, paths: ["tests/extra.test.mjs"], relation: null });
const reviewV2 = (findings) => ({ report: { conditions: [{ id: "C1", status: "met", paths: ["src/note.mjs"], note: "src/note.mjs exports note" }], findings, request: "none", question: null } });
const finalV2 = { report: { conditions: [], findings: [], request: "none", question: null, requirements: ["R1", "R2"].map((id) => ({ id, status: "met", note: "done" })) } };
const codexScript = script("codex", V2
  ? [planV2, reviewV2(FINDINGS.map((f) => findingV2(f))), reviewV2(FINDINGS.map((f, i) => findingV2(f, `F${i + 1}`, "closed"))), finalV2, planV2, planV2]
  : [planR, { report: { verdict: "fix", findings: FINDINGS, question: null } }, verdict("accept"), verdict("complete"), planR, planR]);
const failing = 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("extra", () => assert.equal(1 + 1, 3));\n';
const passing = 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("extra", () => assert.equal(1 + 1, 2));\n';
const claudeScript = script("claude", [
  { report: { summary: "note and extra test added", done: true }, writes: [["src/note.mjs", "export const note = 'a';\n"], ["tests/extra.test.mjs", failing]] },
  { report: { summary: "extra test fixed", done: true }, writes: [["tests/extra.test.mjs", passing]] }
]);
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
const ledger = D("ledger.jsonl");
const HOLD = D("hold-executor");
// The executor waits while HOLD exists, before the fake CLI starts: the turn stays active as long as the test wants.
const wrap = (p) => {
  const f = D(`${p}-mock`);
  const hold = p === "claude" ? `case "$1" in --help|--version) ;; *) while [ -e "${HOLD}" ]; do sleep 0.1; done ;; esac\n` : "";
  fs.writeFileSync(f, `#!/bin/sh\n${hold}exec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, ...extra });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
    env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
    env: env({ MOCK_SCRIPT: claudeScript }) }
}));
const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);
const userData = D("user-data");

const launch = () => launchApp({ userData, providers, port: PORT, shots: SHOTS });
// The plan review is off by default: checked on every goal dialog before the submit.
const startGoal = (app, linkId, opts = {}) => startGoalKit(app, linkId, { ...opts, onDialog: async () => {
  const reviewChecked = await app.ev(`[...document.querySelectorAll(".orch-dialog .orch-check")].find((l) => l.textContent.includes("Показать план")).querySelector("input").checked`);
  expect(reviewChecked === false, "goal dialog: the plan review is off by default", reviewChecked);
} });

let app;
try {
  // =============== first launch ===============
  app = await launch();
  expect(ledgerCount() === 0, "first: no CLI process at start", ledgerCount());
  await app.shot("01-empty-canvas");

  // cards from the context menu, each on a hit-tested empty spot of the canvas
  await createAgent(app, "Агент Codex (лид)", projectA);
  await createAgent(app, "Агент Claude (исполнитель)", projectA);
  await createAgent(app, "Агент Claude (исполнитель)", projectB);
  let c = await canvasState(app);
  const lead = c.agents.find((a) => a.provider === "codex");
  const exec = c.agents.find((a) => a.provider === "claude" && a.project === projectA);
  const exec2 = c.agents.find((a) => a.provider === "claude" && a.project === projectB);
  expect(c.agents.length === 3 && lead?.role === "lead" && exec?.role === "executor" && exec2, "three cards held in main with their roles", c.agents);
  expect(await app.ev(`document.querySelectorAll("[data-agent-id]").length`) === 3, "three cards drawn", null);
  expect((await cardText(app, lead.agentId, ".agent-card__state")) === "Свободен", "a new card is idle", await cardText(app, lead.agentId, ".agent-card__state"));
  expect(await app.ev(`!!${card(lead.agentId, ".agent-card__port")} && !${card(exec.agentId, ".agent-card__port")}`), "only the lead has a link port", null);
  await app.shot("02-cards");

  // zoom out, pan the canvas, move the lead by its header: geometry only
  await app.clickEl(`document.querySelectorAll(".canvas-controls button")[1]`);
  await sleep(300);
  await app.panBy({ x: -60, y: -40 });
  const before = (await canvasState(app)).agents.find((a) => a.agentId === lead.agentId).bounds.position;
  // pressed where elementFromPoint confirms the header (its title, not its button); success is read from main below
  await app.reveal(card(lead.agentId, ".agent-card__identity"));
  const header = await app.pointOn(card(lead.agentId, ".agent-card__identity"));
  await app.drag(header, { x: header.x + 40, y: header.y + 30 });
  await sleep(300);
  const after = (await canvasState(app)).agents.find((a) => a.agentId === lead.agentId).bounds.position;
  expect(after.x !== before.x || after.y !== before.y, "a header drag at zoom 0.82 after a pan moves the card and main keeps it", [before, after]);
  const zoom = await app.ev(`Number(${q(".workspace__scene")}.style.transform.match(/scale\\(([\\d.]+)\\)/)[1])`);
  expect(zoom < 1, "the canvas is zoomed out during the gestures", zoom);

  // keyboard: the port toggles linking; Escape cancels; Enter on "Link here" of the other project's card is refused
  await app.ev(`${card(lead.agentId, ".agent-card__port")}.focus({ preventScroll: true })`);
  await app.key("Enter", "Enter", 13, "\r");
  expect(await app.ev(`!!${q(".orch-linking-hint")} && document.querySelectorAll(".agent-card__connect").length === 2`), "Enter on the port starts linking; executors offer Link here", null);
  await app.key("Escape", "Escape", 27);
  expect(await app.ev(`!${q(".orch-linking-hint")} && document.querySelectorAll(".agent-card__connect").length === 0`), "Escape cancels linking", null);
  await app.ev(`${card(lead.agentId, ".agent-card__port")}.focus({ preventScroll: true })`);
  await app.key("Enter", "Enter", 13, "\r");
  await app.ev(`${card(exec2.agentId, ".agent-card__connect")}.focus({ preventScroll: true })`);
  await app.key("Enter", "Enter", 13, "\r");
  await app.waitFor(`${card(lead.agentId, ".agent-card__message")}?.textContent`, "refusal on the lead card");
  expect((await cardText(app, lead.agentId, ".agent-card__message"))?.includes("одном проекте") || (await cardText(app, lead.agentId, ".agent-card__message")), "a link across projects is refused with a reason", await cardText(app, lead.agentId, ".agent-card__message"));
  const refusedText = await cardText(app, lead.agentId, ".agent-card__message");
  expect((await canvasState(app)).links.length === 0, "no link after the refusal", null);
  await app.shot("03-refused-other-project");

  // mouse: port onto its own card is refused; port onto the executor links; a repeat is refused
  const port = await app.center(card(lead.agentId, ".agent-card__port"));
  const leadBody = await app.center(card(lead.agentId, ".agent-card__body"));
  await app.drag(port, leadBody);
  await app.waitFor(`${card(lead.agentId, ".agent-card__message")}?.textContent !== ${JSON.stringify(refusedText)}`, "self refusal");
  const selfText = await cardText(app, lead.agentId, ".agent-card__message");
  expect((await canvasState(app)).links.length === 0 && selfText, "a link onto the same card is refused", selfText);
  const execBody = await app.center(card(exec.agentId, ".agent-card__body"));
  await app.drag(await app.center(card(lead.agentId, ".agent-card__port")), execBody, 20);
  await app.waitFor(`${q(".agent-link__chip")} && true`, "link chip");
  c = await canvasState(app);
  const link = c.links[0];
  expect(c.links.length === 1 && link.fromAgentId === lead.agentId && link.toAgentId === exec.agentId, "the port drag links lead → executor", c.links);
  expect(!(await cardText(app, lead.agentId, ".agent-card__message")), "a successful link clears the refusal", null);
  await app.shot("04-linked");
  await app.drag(await app.center(card(lead.agentId, ".agent-card__port")), await app.center(card(exec.agentId, ".agent-card__body")), 20);
  await app.waitFor(`${card(lead.agentId, ".agent-card__message")}?.textContent`, "duplicate refusal");
  expect((await canvasState(app)).links.length === 1, "a repeated pair is refused", await cardText(app, lead.agentId, ".agent-card__message"));

  // run 1: to completed; the executor is held mid-turn and shown working until the turn ends
  fs.writeFileSync(HOLD, "");
  await startGoal(app, link.linkId);
  await app.waitFor(`${card(exec.agentId, ".agent-card__state")}?.textContent === "Работает"`, "executor working", 60_000);
  const leadWhile = await cardText(app, lead.agentId, ".agent-card__state");
  const workingText = await app.ev(`${q("[data-orch-working]")}.textContent`);
  expect(leadWhile === "Ждёт свой ход" && workingText.startsWith("Claude"), "while the executor works: its card and the panel say so, the lead waits", [leadWhile, workingText]);
  expect(await app.ev(`!${byText(`[data-agent-link-id="${link.linkId}"] button`, "Новая цель")} && !${q(".agent-link__delete")}`), "a busy link offers neither a new goal nor deletion", null);
  const actions1 = await app.ev(`[...document.querySelectorAll(".orch-panel__actions button")].map((b) => b.textContent)`);
  expect(JSON.stringify(actions1) === JSON.stringify(["Пауза после хода", "Стоп"]), "running: only Pause and Stop (and clarify)", actions1);
  await app.shot("05-executor-working");
  await sleep(1500);
  expect((await cardText(app, exec.agentId, ".agent-card__state")) === "Работает", "the executor stays shown as working for the whole turn", null);
  fs.rmSync(HOLD);
  await app.waitFor(`${q(".orch-panel__status--completed")} && true`, "run 1 completed", 90_000);
  // v1: the lead's final verdict; v2 has none (the reviewer marks requirements): the result line itself
  await app.waitFor(`${q(V2 ? '[data-fact="accepted"]' : "[data-orch-result]")} && true`, "final verdict shown", 10_000);
  const run1 = link.runIds[0] ?? (await canvasState(app)).links[0].runIds[0];
  expect(await app.ev(`document.querySelectorAll(".orch-checks li").length > 0 && document.querySelectorAll(".orch-plan li").length === 1`), "completed: plan and check results in the overview", null);
  await openTab(app, "history");
  await app.waitFor(`document.querySelectorAll(".orch-history li").length > 3`, "history tab");
  expect(true, "completed: the history is in its tab", null);
  await openTab(app, "overview");
  expect(await app.ev(`document.querySelectorAll(".orch-panel__actions button").length === 0`), "completed: no run command offered", null);
  expect((await cardText(app, exec.agentId, ".agent-card__state")) === "Запуск завершён", "cards show the completed run", null);
  await app.shot("06-completed");
  await openTab(app, "history");
  // history: the executor's report, the lead's findings and the failed check's output open from the journal
  const li = (kind, has = "") => `[...document.querySelectorAll('.orch-history li[data-history-kind="${kind}"]')].find((l) => l.textContent.includes(${JSON.stringify(has)}))`;
  const failedCheck = li("check", "не пройдена");
  expect(await app.ev(`!!${failedCheck} && ${failedCheck}.textContent.includes("код выхода 1")`), "the failed check is in the history with its exit code", await app.ev(`[...document.querySelectorAll(".orch-history li")].map((l) => l.textContent).join(" | ")`));
  await app.clickEl(`${failedCheck}.querySelector(".orch-details__toggle")`);
  await app.waitFor(`${failedCheck}.querySelector(".orch-details__body pre")?.textContent.includes("extra")`, "check output shown");
  if (V2) {
    // v2: the reviewer's findings are in the result («Замечания»), each with its history — opened, then closed
    await openTab(app, "summary");
    await app.waitFor(`document.querySelectorAll("[data-finding]").length === 2`, "findings shown");
    const shown = await app.ev(`[...document.querySelectorAll("[data-finding]")].map((e) => [e.dataset.finding, e.dataset.findingSeverity, e.dataset.findingStatus, ${JSON.stringify(FINDINGS)}.some((f) => e.textContent.includes(f))].join(":"))`);
    expect(shown.join() === "F1:blocking:closed:true,F2:blocking:closed:true", "the reviewer's findings: both blocking, closed in round 2", shown);
    await openTab(app, "history");
    // the tab switch closed the check's output: opened again, so the panel is long enough to scroll
    await app.clickEl(`${failedCheck}.querySelector(".orch-details__toggle")`);
    await app.waitFor(`${failedCheck}.querySelector(".orch-details__body pre")?.textContent.includes("extra")`, "check output shown");
  } else {
    await app.clickEl(`${li("review", "нужны исправления")}.querySelector(".orch-details__toggle")`);
    await app.waitFor(`${li("review", "нужны исправления")}.querySelectorAll(".orch-details__body li").length === 2`, "findings shown");
    const findingsShown = await app.ev(`[...${li("review", "нужны исправления")}.querySelectorAll(".orch-details__body li")].map((x) => x.textContent)`);
    expect(JSON.stringify(findingsShown) === JSON.stringify(FINDINGS), "the lead's findings open as a list", findingsShown);
  }
  const firstReport = `[...document.querySelectorAll('.orch-history li[data-history-kind="report"]')].at(-1)`;
  await app.clickEl(`${firstReport}.querySelector(".orch-details__toggle")`);
  await app.waitFor(`${firstReport}.querySelector(".orch-details__body li")?.textContent === "note and extra test added"`, "executor report shown");
  const scrolled = await app.ev(`${q(".orch-panel__body")}.scrollTop`);
  expect(scrolled > 0, "the run panel scrolls with the mouse wheel (the canvas does not take the wheel over it)", scrolled);
  expect(true, "the executor's report opens with its summary", null);
  await app.reveal(`${failedCheck}`);
  await app.shot("06b-history-details");

  // run 2: the plan review pauses the run; Stop ends it
  await startGoal(app, link.linkId, { reviewPlan: true });
  await app.waitFor(`${q(".orch-panel__status--paused")} && true`, "run 2 paused", 60_000);
  const reason2 = await app.ev(`${q(".orch-panel__status span")}.textContent`);
  const actions2 = await app.ev(`[...document.querySelectorAll(".orch-panel__actions button")].map((b) => b.textContent)`);
  expect(reason2.includes("план") && JSON.stringify(actions2) === JSON.stringify(["Начать работу по плану", "Один шаг", "Стоп"]), "plan review: paused with its reason; Resume (as «Начать работу по плану»), Step, Stop offered", [reason2, actions2]);
  await app.waitFor(`document.querySelectorAll(".orch-plan li").length === 1`, "plan shown for review");
  // review UX-9: the plan to review is also in the pinned summary, in view without scrolling
  const summaryPlan = await visibleNow(app, q("[data-orch-summary-plan] li"));
  expect(summaryPlan.ok, "plan review: the plan is in the summary, in view", summaryPlan);
  await app.shot("07-plan-review");
  await app.clickEl(byText(".orch-panel__actions button", "Стоп"));
  await app.waitFor(`${q(".orch-panel__status--stopped")} && true`, "run 2 stopped", 30_000);

  // run 3: Stop while the executor works
  fs.writeFileSync(HOLD, "");
  await startGoal(app, link.linkId);
  await app.waitFor(`${card(exec.agentId, ".agent-card__state")}?.textContent === "Работает"`, "run 3 executor working", 60_000);
  await app.clickEl(byText(".orch-panel__actions button", "Стоп"));
  await app.waitFor(`${q(".orch-panel__status--stopped")} && true`, "run 3 stopped", 30_000);
  fs.rmSync(HOLD, { force: true });
  expect((await cardText(app, exec.agentId, ".agent-card__state")) === "Запуск остановлен", "stopping an active run: cards show it stopped", null);
  await app.shot("08-stopped-active");
  // the stopped turn left no report: opening it says so instead of showing nothing
  await openTab(app, "history");
  const stoppedTurn = `document.querySelector('.orch-history li[data-history-kind="turn_failed"]')`;
  await app.clickEl(`${stoppedTurn}.querySelector(".orch-details__toggle")`);
  await app.waitFor(`${stoppedTurn}.querySelector('[data-details-state="missing"]')?.textContent.includes("Текст не сохранён в журнале (ход не завершился")`, "missing text said");
  expect(true, "a turn without a stored report says that the journal kept no text", null);
  await app.shot("08c-missing-text");
  const historyBefore = await app.ev(`document.querySelectorAll(".orch-history li").length`);
  c = await canvasState(app);
  expect(c.links[0].runIds.length === 3, "three runs on the link", c.links[0].runIds);
  const runsBefore = await runs(app);

  // a terminal card beside the agents: its lifecycle is not the agents'
  await app.clickEl(q(".orch-panel__close"));
  const termSpot = await app.freeRect(80, 80) ?? (await app.panBy({ x: -400, y: 0 }), await app.freeRect(80, 80));
  if (!termSpot) throw new Error("no empty canvas for the terminal");
  await app.click(termSpot.x + 20, termSpot.y + 20, "right");
  await app.clickEl(byText(".canvas-menu [role=menuitem]", "Запустить агента"));
  await app.waitFor(`[...document.querySelectorAll(".canvas-menu__submenu [role=menuitem]")].find((el) => /Terminal|Терминал/.test(el.textContent)) && true`, "terminal row");
  await app.clickEl(`[...document.querySelectorAll(".canvas-menu__submenu [role=menuitem]")].find((el) => /Terminal|Терминал/.test(el.textContent))`);
  await app.waitFor(`document.querySelectorAll(".terminal-card").length === 1`, "terminal card", 20_000);
  const terminalIds = () => app.ev(`[...document.querySelectorAll('[data-canvas-layer-id^="terminal:"]')].map((el) => el.dataset.canvasLayerId).join(",")`);
  const sessionsBefore = await app.ev("document.querySelectorAll('.terminal-card').length");
  const terminalsBefore = await terminalIds();
  expect(sessionsBefore === 1 && (await canvasState(app)).agents.length === 3, "a terminal opens beside the agent cards; the cards are untouched", [sessionsBefore, terminalsBefore]);
  await app.shot("08b-terminal-beside-agents");
  const ledgerBeforeReload = ledgerCount();

  // reload: the same state, the same history, no second run, nothing continues
  await app.call("Page.reload", { ignoreCache: false });
  await sleep(500);
  await app.waitFor(`document.querySelectorAll("[data-agent-id]").length === 3 && ${q(".agent-link__chip")} && true`, "cards after reload");
  await app.waitFor(`${byText(`[data-agent-link-id="${link.linkId}"] button`, "Открыть запуск")} && true`, "link run after reload");
  await app.clickEl(byText(`[data-agent-link-id="${link.linkId}"] button`, "Открыть запуск"));
  await app.waitFor(`${q(".orch-panel__status--stopped")} && true`, "stopped after reload");
  await openTab(app, "history");
  await app.waitFor(`document.querySelectorAll(".orch-history li").length === ${historyBefore}`, "same history after reload");
  await sleep(1500);
  expect((await runs(app)).length === 3 && ledgerCount() === ledgerBeforeReload, "reload: no new run, no CLI started", [await runs(app), ledgerCount(), ledgerBeforeReload]);
  await app.waitFor(`document.querySelectorAll('.terminal-card').length === ${sessionsBefore}`, "terminal after reload");
  expect((await terminalIds()) === terminalsBefore, "reload: the same terminal session, the agents did not touch it", [await terminalIds(), terminalsBefore]);
  await app.shot("09-after-reload");
  const boundsBefore = (await canvasState(app)).agents.map((a) => [a.agentId, a.bounds]);
  const quit1 = await app.quit();

  // =============== restart ===============
  app = await launch();
  await app.waitFor(`document.querySelectorAll("[data-agent-id]").length === 3 && ${q(".agent-link__chip")} && true`, "cards after restart");
  await sleep(1500);
  c = await canvasState(app);
  expect(JSON.stringify(c.agents.map((a) => [a.agentId, a.bounds])) === JSON.stringify(boundsBefore) && c.links.length === 1 && c.links[0].runIds.length === 3,
    "restart: cards with their geometry and the link kept", c);
  const runsAfter = await runs(app);
  expect(JSON.stringify(runsAfter.map((r) => [r.runId, r.status]).sort()) === JSON.stringify(runsBefore.map((r) => [r.runId, r.status]).sort()) && runsAfter.every((r) => !r.open),
    "restart: the runs as they were, none opened", runsAfter);
  expect(ledgerCount() === ledgerBeforeReload, "restart: no CLI started by itself", ledgerCount());
  await app.reveal(card(lead.agentId)); // the camera starts at HOME again
  await app.shot("10-after-restart");

  // a linked card asks before it goes; Cancel keeps card and link
  await app.clickEl(card(lead.agentId, ".agent-card__close"));
  await app.waitFor(`${card(lead.agentId, ".agent-card__confirm")} && true`, "delete confirmation");
  await app.shot("10b-delete-linked-card-confirm");
  await app.clickEl(byText(`[data-agent-id="${lead.agentId}"] .agent-card__confirm button`, "Отмена"));
  expect(await app.ev(`!${card(lead.agentId, ".agent-card__confirm")}`) && (await canvasState(app)).links.length === 1, "Cancel keeps the linked card and its link", null);

  // delete the link after the stop: history and cards stay
  await app.clickEl(q(`[data-agent-link-id="${link.linkId}"] .agent-link__delete`));
  await app.waitFor(`!${q(".agent-link__chip")}`, "link removed");
  c = await canvasState(app);
  expect(c.links.length === 0 && c.agents.length === 3, "the link is deleted, the cards stay", c);
  expect((await runs(app)).length === 3, "the link's runs stay", await runs(app));
  const hist = await app.ev(`window.canvasTTY.orchestration.history(${JSON.stringify(run1)}, 0, 5).then((r) => r.ok && r.value.records.length)`);
  expect(hist > 0, "the history of a run of the deleted link is still readable", hist);
  await app.shot("11-link-deleted");
  // an unlinked card is deleted at once
  await app.clickEl(card(exec2.agentId, ".agent-card__close"));
  await app.waitFor(`!${card(exec2.agentId)}`, "card removed");
  expect((await canvasState(app)).agents.length === 2, "an unlinked card is deleted", null);
  const quit2 = await app.quit();

  const summary = { ok: failures.length === 0, passed: passed.length, failures, fakeCliProcesses: ledgerCount(), shots: SHOTS, exits: [quit1, quit2] };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  await app?.shot("failure").catch(() => {});
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.stack ?? error), passed, failures, shots: SHOTS }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(HOLD, { force: true }); } catch {}
  await app?.stop().catch(() => {});
  if (shotsArg > 0) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
