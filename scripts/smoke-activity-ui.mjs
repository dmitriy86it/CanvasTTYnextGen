// Electron UI smoke for the activity display (home widget, agent cards, run summary) with fake Codex/Claude CLIs
// (tests/fixtures/orchestration/mock-*.mjs). Starts no real model and touches no user project: two temporary Git
// projects, HOME and SHELL of the application pointed at the temporary directory.
//   - no terminal, a run working: the widget shows it (never "no sessions");
//   - two projects: a question in one does not hide the work of the other; a terminal next to them;
//   - the executor finished its turn while the lead reviews: not shown as done;
//   - the run ends while its activity tab is watched: an offer to open the summary, the tab stays;
//   - the summary: stages, check commands and remarks apart, long titles at 1280×800 and 1440×900;
//   - after a reload the stored summary opens first and nothing runs again; opening details repeats nothing;
//   - review R2–R4: a required check never started, a run paused with the lead's open remarks, a journal and a report
//     text that cannot be read (their file made unreadable, then readable again) and a retry that loads them.
// Needs `npm run build` first. Usage: node scripts/smoke-activity-ui.mjs [--shots <dir>]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, launch, q, sleep, workspace } from "./orchestration-app-kit.mjs";

const { D, project, script } = workspace("cto-activity-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 500)}`); };

const projectA = project("alpha-project");
const projectB = project("beta-project-with-a-rather-long-folder-name-for-the-widget");
const projectC = project("gamma-project");
const OPEN_REMARKS = ["API возвращает 500 на пустой фильтр", "Нет проверки прав на экспорт"];
const LONG_TITLE = "Интерфейс анализа: таблица результатов, фильтры по периодам, экспорт отчёта и подробная карточка каждой записи";
const FINDINGS = ["Экспорт в CSV не покрыт отдельной проверкой", "Полный MVP не завершён: вне цели этого запуска остались уведомления и роли"];
const codexScript = script("codex", [
  { report: { stages: [{ title: LONG_TITLE, task: "Add src/note.mjs exporting a constant" }], question: null } }, // A: plan
  { report: { stages: [{ title: "Импорт", task: "Add src/import.mjs" }], question: null } }, // B: plan (after the question)
  { report: { verdict: "accept", findings: [], question: null } }, // A: review
  { report: { verdict: "complete", findings: FINDINGS, question: null } }, // A: final (the report schema has no next step)
  { report: { stages: [{ title: "Фильтры отчёта", task: "Add src/filter.mjs" }], question: null } }, // C: plan
  { report: { verdict: "fix", findings: OPEN_REMARKS, question: null } } // C: review asks for fixes (the run is paused after it)
]);
fs.writeFileSync(path.join(codexScript, "2.asks.json"), JSON.stringify([{ tool: "question", question: "Какой формат импорта поддержать первым?", options: ["CSV", "JSON"] }]));
const claudeScript = script("claude", [
  { report: { summary: "Добавлен src/note.mjs с константой; тесты проекта проходят.", done: true }, writes: [["src/note.mjs", "export const note = 'a';\n"]] },
  { report: { summary: "Добавлен src/filter.mjs.", done: true }, writes: [["src/filter.mjs", "export const filter = 1;\n"]] }
]);
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
fs.mkdirSync(D("home"), { recursive: true });
const ledger = D("ledger.jsonl");
const HOLD = { codex: D("hold-codex"), claude: D("hold-claude") };
// A held CLI waits before the fake starts: its process exists, its turn stays active as long as the test wants.
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\ncase "$1" in --help|--version) ;; *) while [ -e "${HOLD[p]}" ]; do sleep 0.1; done ;; esac\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const SHELL = D("login-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, ...extra });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: PATHS, env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({ MOCK_SCRIPT: claudeScript }) },
  shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));
const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);
const hold = (p, on) => (on ? fs.writeFileSync(HOLD[p], "") : fs.rmSync(HOLD[p], { force: true }));

let app;
const api = (expr) => app.ev(`(async () => { const o = window.canvasTTY.orchestration; const r = await (${expr}); if (!r.ok) throw new Error(r.code + " " + r.message); return r.value; })()`);
const viewOf = (runId) => api(`o.get(${JSON.stringify(runId)})`).then((s) => s.view);
const waitView = async (runId, pred, what, ms = 60_000) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await viewOf(runId); if (pred(v)) return v; await sleep(150); }
  throw new Error(`timeout: ${what} ${JSON.stringify(v)?.slice(0, 400)}`);
};
const size = (width, height) => app.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
const reload = async () => {
  await app.call("Page.reload", {});
  await sleep(500);
  await app.waitFor("document.querySelector('.workspace') && window.canvasTTY?.orchestration && true", "canvas after reload");
  await sleep(800);
};
const text = (selector) => app.ev(`${selector}?.textContent ?? null`);
const row = (runId, inner = "") => q(`[data-activity-run="${runId}"] ${inner}`.trim());
const cardSel = (agentId, inner = "") => q(`[data-agent-id="${agentId}"] ${inner}`.trim());
// Every rectangle inside its box: long texts never cover the buttons, the port or a neighbour.
const inside = (child, parent) => app.ev(`(() => { const p = ${parent}.getBoundingClientRect(); return [...document.querySelectorAll(${JSON.stringify(child)})].every((el) => { const r = el.getBoundingClientRect(); return r.width === 0 || (r.left >= p.left - 1 && r.right <= p.right + 1 && r.top >= p.top - 1 && r.bottom <= p.bottom + 1); }); })()`);

try {
  app = await launch({ userData: D("user-data"), providers, port: PORT, shots: SHOTS, env: { HOME: D("home"), SHELL: "/bin/sh" } });
  await size(1280, 800);
  await app.waitFor(`${q("[data-activity-load]")}?.dataset.activityLoad === "ready"`, "widget loaded");
  expect((await text(q(".usage-list .home-empty"))) === "Сейчас нет активных сессий", "empty only once every source answered", await text(q(".usage-list .home-empty")));

  // cards and links through the same IPC the dialogs use; the gesture itself is covered by smoke-orchestration-ui
  const bounds = (x, y) => ({ position: { x, y }, size: { width: 300, height: 222 } });
  const mk = (provider, project, x, y) => api(`o.createAgent(${JSON.stringify({ agentId: crypto.randomUUID(), provider, project, bounds: bounds(x, y), workspaceId: "common" })})`);
  const leadA = await mk("codex", projectA, 1500, 40), execA = await mk("claude", projectA, 1900, 40);
  const leadB = await mk("codex", projectB, 1500, 380), execB = await mk("claude", projectB, 1900, 380);
  const linkA = await api(`o.createLink(${JSON.stringify({ linkId: crypto.randomUUID(), fromAgentId: leadA.agentId, toAgentId: execA.agentId })})`);
  const linkB = await api(`o.createLink(${JSON.stringify({ linkId: crypto.randomUUID(), fromAgentId: leadB.agentId, toAgentId: execB.agentId })})`);
  const goal = (textGoal, commands = ["node --test"]) => ({ text: textGoal, criteria: ["node --test passes"], checks: [], commands, workMode: "project", mode: "autopilot" });
  hold("claude", true);
  const runA = (await api(`o.startOnLink(${JSON.stringify({ linkId: linkA.linkId, requestId: crypto.randomUUID(), goal: goal("Добавить заметку в проект alpha") })})`)).runId;
  await waitView(runA, (v) => v.active?.kind === "turn" && v.active.purpose === "execute", "A: executor holds the turn");
  const runB = (await api(`o.startOnLink(${JSON.stringify({ linkId: linkB.linkId, requestId: crypto.randomUUID(), goal: goal("Добавить импорт в проект beta", ["node --test", "node -e 0"]) })})`)).runId;
  await waitView(runB, (v) => v.permission?.kind === "question", "B: the lead asks a question");
  await reload();

  // ---------- 1. no terminal, two projects: both runs, one row each ----------
  await app.waitFor(`${row(runA)} && ${row(runB)} && ${row(runB)}.dataset.runState === "waiting_user"`, "both runs in the widget", 20_000);
  expect(!(await app.ev(`!!${q(".usage-list .home-empty")}`)), "no terminal, orchestration working: the widget is not empty", null);
  expect(["working", "starting"].includes(await app.ev(`${row(runA)}.dataset.runState`)), "A: working while B waits for an answer", await app.ev(`${row(runA)}.dataset.runState`));
  expect((await text(row(runB, "[data-activity-extra]"))) === "Агент задал вопрос", "B: the reason it waits", await text(row(runB, "[data-activity-extra]")));
  expect((await text(row(runA))).includes("alpha-project") && (await text(row(runA))).includes("Оркестрация"), "A: project and kind named", await text(row(runA)));
  expect((await text(row(runA))).includes("Claude выполняет этап 1"), "A: who works on which stage", await text(row(runA)));
  expect(await app.ev(`document.querySelectorAll("[data-activity-run]").length`) === 2, "one row per run, not one per participant", null);
  expect(await app.ev(`${row(runA, ".activity-run__people")}.querySelectorAll("li").length`) === 2, "the participants fold out inside the row", null);
  await app.reveal(q("[data-activity-load]"));
  await app.shot("01-widget-two-projects-1280");

  // ---------- 2. a terminal next to the runs ----------
  await app.ev(`window.canvasTTY.terminal.create({ provider: "terminal", profile: "normal", cwd: ${JSON.stringify(projectA)}, position: { x: 1500, y: 1400 } }).then(() => true)`);
  await app.waitFor(`[...document.querySelectorAll(".usage-list .activity-kind")].some((e) => e.textContent === "Терминал")`, "terminal row");
  expect(await app.ev(`document.querySelectorAll("[data-activity-run]").length`) === 2, "the terminal and both runs are listed together", null);
  await size(1440, 900);
  await app.reveal(q("[data-activity-load]"));
  await app.shot("02-widget-terminal-and-runs-1440");
  await size(1280, 800);

  // ---------- 3. the executor finished its turn, the lead reviews: not done ----------
  hold("codex", true);
  hold("claude", false);
  await waitView(runA, (v) => v.active?.kind === "turn" && v.active.purpose === "review", "A: the lead reviews", 60_000);
  await app.waitFor(`${cardSel(execA.agentId, "[data-agent-doing]")}?.textContent === "Claude закончил ход и ждёт ревью"`, "executor card: waits for the review", 20_000);
  expect((await text(cardSel(execA.agentId, ".agent-card__state"))) !== "Запуск завершён", "the executor card is not done while the lead reviews", await text(cardSel(execA.agentId, ".agent-card__state")));
  expect((await text(cardSel(leadA.agentId, "[data-agent-doing]")))?.startsWith("Codex проверяет этап 1: Интерфейс анализа"), "lead card: reviews the stage by its title", await text(cardSel(leadA.agentId, "[data-agent-doing]")));
  expect(!(await app.ev(`!!${cardSel(execA.agentId, ".agent-card__summary")}`)), "no summary button before the end", null);
  await app.waitFor(`${row(runA)}.dataset.runState === "checking" || ${row(runA)}.dataset.runState === "starting"`, "widget: A reviewing");
  await app.reveal(cardSel(leadA.agentId));
  for (const c of [leadA, execA]) {
    expect(await inside(`[data-agent-id="${c.agentId}"] .agent-card__body > *`, cardSel(c.agentId)), `long texts stay inside the ${c.role} card`, null);
    expect(await app.ev(`(() => { const d = ${cardSel(c.agentId, ".agent-card__doing")}; const b = ${cardSel(c.agentId, ".agent-card__actions")}.getBoundingClientRect(); return !d || d.getBoundingClientRect().bottom <= b.top; })()`), `the ${c.role} card's action line does not cover its buttons`, null);
  }
  await app.shot("03-cards-lead-reviews");

  // ---------- 4. the run ends while its activity is watched ----------
  await app.clickEl(cardSel(leadA.agentId, ".agent-card__open"));
  await app.waitFor(`${q(".orch-panel")}?.dataset.orchPanelTab === "overview"`, "a running run opens at the overview");
  await app.clickEl(q('[data-orch-tab="activity"]'));
  await app.waitFor(`${q("[data-orch-feed]")} && true`, "activity feed");
  hold("codex", false);
  await waitView(runA, (v) => v.status === "completed", "A completed", 60_000);
  await app.waitFor(`${q("[data-orch-ended]")} && true`, "the offer to open the summary", 20_000);
  expect((await app.ev(`${q(".orch-panel")}.dataset.orchPanelTab`)) === "activity", "the tab is not switched by itself", await app.ev(`${q(".orch-panel")}.dataset.orchPanelTab`));
  await app.shot("04-ended-offer");
  const ledgerBefore = ledgerCount();

  // ---------- 5. the summary ----------
  await app.clickEl(q("[data-orch-ended] button"));
  await app.waitFor(`${q("[data-orch-run-summary]")} && ${q('[data-sum="remarks"] [data-sum-findings]')} && true`, "summary loaded", 20_000);
  const sum = await app.ev(`${q("[data-orch-run-summary]")}.innerText`);
  expect((await text(q("[data-sum-outcome]"))).includes("Лид принял цель этого запуска"), "outcome: the goal of this run", await text(q("[data-sum-outcome]")));
  expect(!!(await text(q("[data-sum-scope]"))), "completed is said to be about this run, not the project", null);
  expect((await text(q("[data-sum-stage-count]"))) === "1 из 1 приняты лидом", "stages counted apart", await text(q("[data-sum-stage-count]")));
  expect((await text(q("[data-sum-check-count]"))).startsWith("Обязательные команды проверки: 1 из 1 прошли"), "check commands counted apart, never as tests", await text(q("[data-sum-check-count]")));
  expect(!!(await text(q("[data-sum-tests]"))), "the test count is not claimed", null);
  expect(await app.ev(`document.querySelectorAll('[data-sum-findings] li').length`) === FINDINGS.length, "the lead's remaining remarks listed", null);
  expect(sum.includes("Полный MVP не завершён"), "the lead's own words about what is left are shown", null);
  expect((await app.ev(`${q('[data-sum="next"]')}.innerText`)).includes("Не указано"), "no next step in the report: not specified, not invented", await app.ev(`${q('[data-sum="next"]')}.innerText`));
  expect(sum.includes("Добавлен src/note.mjs"), "what the executor did (its claim)", null);
  expect(await app.ev(`!!${q('[data-src="journal"]')} && !!${q('[data-src="agent"]')}`), "confirmed facts and agents' claims are marked apart", null);
  expect(!/[{}]"|"\w+":/.test(sum), "no raw JSON in the summary", sum.slice(0, 300));
  expect((await app.ev(`${q('[data-sum="finish"]')}.innerText`)).includes("не запрошено"), "commit/push/QA: their real state", await app.ev(`${q('[data-sum="finish"]')}.innerText`));
  expect(await app.ev(`(() => { const v = ${q(".orch-panel__body")}; return v.scrollWidth <= v.clientWidth + 1; })()`), "1280×800: long titles wrap, no sideways scroll", null);
  await app.shot("05-summary-1280");
  await size(1440, 900);
  await sleep(200);
  expect(await app.ev(`${q(".orch-panel")}.getBoundingClientRect().width >= 700`), "the summary panel is wide", await app.ev(`${q(".orch-panel")}.getBoundingClientRect().width`));
  await app.shot("06-summary-1440");
  await app.clickEl(q("[data-orch-expand]"));
  await sleep(200);
  expect(await app.ev(`${q(".orch-panel")}.getBoundingClientRect().width > 1300`), "the panel expands within the window", await app.ev(`${q(".orch-panel")}.getBoundingClientRect().width`));
  await app.shot("07-summary-expanded-1440");
  await app.clickEl(q("[data-orch-expand]"));
  await size(1280, 800);

  // ---------- 6. details repeat nothing ----------
  for (const tab of ["overview", "activity", "log", "history", "changes", "summary"]) {
    await app.clickEl(q(`[data-orch-tab="${tab}"]`));
    await sleep(250);
  }
  await app.clickEl(q('[data-orch-tab="activity"]'));
  await app.clickEl(q('[data-orch-role="lead"]'));
  await sleep(300);
  expect(!(await app.ev(`${q("[data-orch-feed]")}.innerText`)).includes('"verdict"'), "a structured answer in the feed is shown as text, not JSON", null);
  await sleep(1500);
  expect(ledgerCount() === ledgerBefore, "opening the summary and every tab starts no CLI process", [ledgerBefore, ledgerCount()]);
  await app.clickEl(q(".orch-panel__close"));

  // B: stopped while its question waits; the other project's summary differs
  const vb = await viewOf(runB);
  await api(`o.command(${JSON.stringify({ runId: runB, commandId: crypto.randomUUID(), expectedRevision: vb.revision, command: { kind: "stop" } })})`);
  await waitView(runB, (v) => v.status === "stopped", "B stopped", 30_000);

  // C: paused right after the lead's review asked for fixes (the pause is asked while the review runs)
  const leadC = await mk("codex", projectC, 1500, 720), execC = await mk("claude", projectC, 1900, 720);
  const linkC = await api(`o.createLink(${JSON.stringify({ linkId: crypto.randomUUID(), fromAgentId: leadC.agentId, toAgentId: execC.agentId })})`);
  hold("claude", true);
  const runC = (await api(`o.startOnLink(${JSON.stringify({ linkId: linkC.linkId, requestId: crypto.randomUUID(), goal: goal("Добавить фильтры в проект gamma") })})`)).runId;
  await waitView(runC, (v) => v.active?.kind === "turn" && v.active.purpose === "execute", "C: executor holds the turn");
  hold("codex", true);
  hold("claude", false);
  const vc = await waitView(runC, (v) => v.active?.kind === "turn" && v.active.purpose === "review", "C: the lead reviews");
  await api(`o.command(${JSON.stringify({ runId: runC, commandId: crypto.randomUUID(), expectedRevision: vc.revision, command: { kind: "pause_after_turn", on: true } })})`);
  hold("codex", false);
  await waitView(runC, (v) => v.status === "paused", "C paused after the review", 60_000);

  // ---------- 7. after a reload: the stored summary first, nothing runs again ----------
  const ledgerAtReload = ledgerCount();
  await reload();
  await app.waitFor(`document.querySelectorAll("[data-activity-recent]").length === 2`, "recent results after the reload", 20_000);
  expect(await app.ev(`document.querySelectorAll("[data-activity-run]").length`) === 1, "ended runs leave the active rows; the paused one stays", null);
  await app.reveal(q("[data-activity-load]"));
  await app.shot("08-widget-recent-after-reload");
  await app.ev(`${q(`[data-activity-recent="${runB}"]`)}.scrollIntoView({ block: "nearest" })`);
  expect(await inside("[data-activity-recent] > *", q("[data-activity-recent-list]")), "recent results: long project names never push the summary button out", null);
  await app.clickEl(q(`[data-activity-recent="${runB}"] .activity-recent__summary`));
  await app.waitFor(`${q("[data-sum-outcome]")}?.dataset.sumOutcome === "stopped"`, "B's summary: stopped", 20_000);
  expect((await text(q("[data-sum-outcome]"))).includes("цель не достигнута"), "a stopped run is not a success", await text(q("[data-sum-outcome]")));
  // R2: both required commands are listed, neither started
  expect((await text(q("[data-sum-check-count]")))?.startsWith("Обязательные команды проверки: 0 из 2 прошли"), "R2: the required commands not started are counted", await text(q("[data-sum-check-count]")));
  expect(await app.ev(`[...document.querySelectorAll("[data-check-id]")].map((l) => l.dataset.checkStatus + ":" + l.dataset.checkRuns).join(",")`) === "not_run:0,not_run:0", "R2: each never started, zero attempts",
    await app.ev(`[...document.querySelectorAll("[data-check-id]")].map((l) => l.textContent).join(" | ")`));
  await app.reveal(q('[data-sum="checks"]'));
  await app.shot("09-summary-stopped-checks-not-run");
  await app.clickEl(q(".orch-panel__close"));
  await app.reveal(cardSel(leadA.agentId));
  await app.clickEl(cardSel(leadA.agentId, ".agent-card__open"));
  await app.waitFor(`${q(".orch-panel")}?.dataset.orchPanelTab === "summary" && ${q("[data-sum-outcome]")}?.dataset.sumOutcome === "completed"`, "an ended run opens at its summary", 20_000);
  expect(await app.ev(`!!${cardSel(execA.agentId, ".agent-card__summary")}`), "the ended run's cards offer the summary", null);
  await sleep(2000);
  expect(ledgerCount() === ledgerAtReload, "after the reload nothing started again", [ledgerAtReload, ledgerCount()]);
  const statuses = await api("o.list()").then((l) => l.map((s) => s.view.status).sort());
  expect(JSON.stringify(statuses) === JSON.stringify(["completed", "paused", "stopped"]), "the runs stay as they ended", statuses);
  await app.shot("10-summary-after-reload");
  await app.clickEl(q(".orch-panel__close"));

  // ---------- 8. R3: paused with the lead's open remarks ----------
  await app.reveal(q("[data-activity-load]"));
  await app.clickEl(row(runC, ".usage-row"));
  await app.waitFor(`${q("[data-orch-tab=summary]")} && true`, "C's panel");
  await app.clickEl(q("[data-orch-tab=summary]"));
  await app.waitFor(`document.querySelectorAll('[data-sum="remarks"] [data-sum-findings] li').length === ${OPEN_REMARKS.length}`, "C: the open remarks", 20_000);
  const remarks = await app.ev(`${q('[data-sum="remarks"]')}.innerText`);
  expect(OPEN_REMARKS.every((r) => remarks.includes(r)), "R3: the lead's open remarks are shown while paused, before any final review", remarks);
  expect((await text(q("[data-sum-current-review]")))?.includes("Последнее ревью лида — Этап 1: Фильтры отчёта"), "R3: which review they come from", await text(q("[data-sum-current-review]")));
  await app.reveal(q('[data-sum="lead"]'));
  await app.shot("11-summary-paused-open-remarks");
  await app.clickEl(q(".orch-panel__close"));

  // ---------- 9. R4: a journal and a report text that cannot be read, then a retry ----------
  const runDir = (id) => D("user-data", "orchestration", "runs", id);
  const findingsSha = await api(`o.history(${JSON.stringify(runA)}, 0, 200)`).then((p) => p.records.find((r) => r.type === "review.recorded" && r.data.stage === null).data.findings.sha256);
  const locked = [path.join(runDir(runB), "journal.jsonl"), path.join(runDir(runA), "texts", findingsSha)];
  const ledgerAtErrors = ledgerCount();
  for (const f of locked) fs.chmodSync(f, 0o000);
  try {
    await reload();
    await app.reveal(cardSel(leadB.agentId));
    await app.clickEl(cardSel(leadB.agentId, ".agent-card__open"));
    await app.waitFor(`!!(${q("[data-run-load-error]")} || ${q("[data-orch-tab=summary]")})`, "B's panel");
    if (!(await app.ev(`!!${q("[data-run-load-error]")}`))) await app.clickEl(q("[data-orch-tab=summary]"));
    await app.waitFor(`!!(${q("[data-run-load-error]")} || ${q("[data-sum-journal-error]")})`, "B: the load error", 20_000);
    const errText = await app.ev(`(${q("[data-run-load-error]")} ?? ${q("[data-sum-journal-error]")}).innerText`);
    expect(/Не удалось загрузить/.test(errText) && /Повторить/.test(errText), "R4: an unreadable journal is an error with retry, not empty or done", errText);
    expect(!(await app.ev(`!!${q("[data-sum-outcome]")} && ${q("[data-sum-journal-error]")} === null`)), "R4: no summary without the error beside it", null);
    await app.shot("12-load-error-journal");
  } finally {
    for (const f of locked) fs.chmodSync(f, 0o644);
  }
  await app.clickEl(`(${q("[data-run-load-error] button")} ?? ${q("[data-sum-journal-error] button")})`);
  if (!(await app.ev(`!!${q("[data-orch-run-summary]")}`))) {
    await app.waitFor(`${q("[data-orch-tab=summary]")} && true`, "B's panel after the retry", 20_000);
    await app.clickEl(q("[data-orch-tab=summary]"));
  }
  await app.waitFor(`${q("[data-sum-outcome]")}?.dataset.sumOutcome === "stopped" && !${q("[data-sum-journal-error]")} && ${q("[data-orch-run-summary]")}.dataset.incomplete === "no"`, "B: loaded after the retry", 20_000);
  expect(true, "R4: the retry loads the journal (complete, no error)", null);
  await app.shot("13-after-retry-journal");
  await app.clickEl(q(".orch-panel__close"));
  // the report text of A, still cached as failed in this page: its own retry
  for (const f of locked.slice(1)) fs.chmodSync(f, 0o000);
  try {
    await reload();
    await app.reveal(cardSel(leadA.agentId));
    await app.clickEl(cardSel(leadA.agentId, ".agent-card__open"));
    await app.waitFor(`${q('[data-sum="remarks"] [data-sum-failed]')} && true`, "A: the findings text fails to load", 20_000);
    await app.reveal(q('[data-sum="remarks"]'));
    await app.shot("14-load-error-text");
  } finally {
    for (const f of locked.slice(1)) fs.chmodSync(f, 0o644);
  }
  await app.clickEl(q('[data-sum="remarks"] [data-sum-failed] button'));
  await app.waitFor(`document.querySelectorAll('[data-sum="remarks"] [data-sum-findings] li').length === ${FINDINGS.length}`, "A: findings after the retry", 20_000);
  expect(true, "R4: a report text that failed loads on its own retry", null);
  await app.shot("15-after-retry-text");
  await sleep(1000);
  expect(ledgerCount() === ledgerAtErrors, "R4: errors and retries start no CLI process", [ledgerAtErrors, ledgerCount()]);
  const after = await api("o.list()").then((l) => l.map((s) => s.view.status).sort());
  expect(JSON.stringify(after) === JSON.stringify(["completed", "paused", "stopped"]), "R4: a retry creates no run and changes none", after);
} catch (error) {
  failures.push(`aborted: ${error?.stack ?? error}`);
  try { await app?.shot("zz-failure"); } catch {}
} finally {
  hold("codex", false);
  hold("claude", false);
  await app?.stop();
}
for (const p of passed) console.log(`ok   ${p}`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`\n${passed.length} passed, ${failures.length} failed; shots: ${SHOTS}`);
process.exit(failures.length ? 1 : 0);
