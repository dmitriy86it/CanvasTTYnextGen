// Electron UI smoke for B2, the task board (docs/agent-orchestration/implementation/stage-b-board.md §6): the real
// window at 1280×800, fake Codex/Claude CLIs (tests/fixtures/orchestration/mock-*.mjs), a temporary Git project.
//   1. «Board» in the workspace bar puts the board on the canvas; three tasks made in its form (T-3 after T-2);
//   2. T-1 started from the board: the goal dialog has its text, requirements and «Task T-1»; the run (with the
//      project's check) ends «Done — confirmed by checks»; its agent cards and its summary name T-1;
//   3. T-2 run without checks: «Review», «Completed without checks …»; «Accept the result» explains first, then
//      «Done (accepted by you, without checks)» — its own mark, not the confirmed one; T-3 no longer waits;
//   4. the window reloads: the same columns, reasons and marks; no CLI starts again.
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-board-ui.mjs [--shots <dir>]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, canvasState, card, createAgent, launch as launchApp, q, sleep, waitForValue, workspace, JOURNAL_V2 } from "./orchestration-app-kit.mjs";

const { D, project, script } = workspace("cto-board-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };
if (!JOURNAL_V2) throw new Error("the board is journal v2 only (goal.task)");

// ---------- the project and the fake CLIs ----------
const node = project("board-app");
// run 1 (T-1, the project's check): plan (a change and the check), review, final. Run 2 (T-2, no checks): the lead
// proposes none (MOCK_CHECKS=none), plan (a change only), review, final.
const plan = (file, check) => ({ report: { stages: [{ title: "Заметка", task: `Add ${file}`, conditions: [
  { keep: null, text: `${file} exists`, covers: ["R1"], evidence: { kind: "change", check: null } },
  ...(check ? [{ keep: null, text: "node --test passes", covers: ["R2"], evidence: { kind: "check", check: "cmd-1" } }] : [])] }], dropped: [], dropRequirements: [], question: null } });
const review = (file) => ({ report: { conditions: [{ id: "C1", status: "met", paths: [file], note: "done" }], findings: [], request: "none", question: null } });
const final = (ids) => ({ report: { conditions: [], findings: [], request: "none", question: null, requirements: ids.map((id) => ({ id, status: "met", note: "done" })) } });
const codexScript = script("codex", [plan("src/one.mjs", true), review("src/one.mjs"), final(["R1", "R2"]), plan("src/two.mjs", false), review("src/two.mjs"), final(["R1"])]);
const claudeScript = script("claude", [
  { report: { summary: "one added", done: true }, writes: [["src/one.mjs", "export const one = 1;\n"]] },
  { report: { summary: "two added", done: true }, writes: [["src/two.mjs", "export const two = 2;\n"]] }
]);
// run 2's executor asks to run a command first: the run waits for the person, the board and the card say so
// B3: with the CLI's own reason (decision_reason), which the board's line and the feed show as it was said
const CLI_WHY = "Permission rule Bash(ls:*) requires approval";
fs.writeFileSync(path.join(claudeScript, "2.asks.json"), JSON.stringify([{ tool: "Bash", command: "ls src", request: { decision_reason_type: "rule", decision_reason: CLI_WHY } }]));
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
fs.writeFileSync(D("mock-state", ".codex", "config.toml"), "");
const ledger = D("ledger.jsonl");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, MOCK_CHECKS: "none", ...extra });
// the checks' shell without a login, as in the other smokes (a login /bin/sh puts Homebrew's node first)
const SHELL = D("login-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: PATHS, env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({ MOCK_SCRIPT: claudeScript }) },
  shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));
const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);

let app;
const laptop = () => app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const task = (key) => `[data-board-task="${key}"]`;
// what the board shows of a task: its column, «Done» kind, reason and its status line
const shown = (key) => app.ev(`(() => { const el = ${q(task(key))}; return el && { column: el.dataset.boardTaskColumn, done: el.dataset.boardDone ?? null,
  reason: el.dataset.boardReason ?? null, line: el.querySelector("[data-board-line-text]")?.textContent ?? "", badge: el.querySelector(".board-task__badge")?.className ?? null,
  buttons: [...el.querySelectorAll(".board-task__actions button")].map((b) => b.textContent) }; })()`);
const until = (key, ok, what, ms = 90_000) => waitForValue(async () => { const s = await shown(key); return s && ok(s) ? s : null; }, what, ms);
async function newTask({ title, text, criteria, after = [] }) {
  await app.clickEl(q("[data-board-new]"));
  await app.waitFor(`${q("[data-board-form]")} && true`, "task form");
  await app.type(q('[data-board-field="title"]'), title);
  await app.type(q('[data-board-field="text"]'), text);
  await app.type(q('[data-board-field="criteria"]'), criteria);
  for (const key of after) await app.clickEl(q(`[data-board-depends="${key}"]`));
  await app.clickEl(q("[data-board-save]"));
  await app.waitFor(`!${q("[data-board-form]")}`, "task form closed");
}
async function startFromBoard(key, commands, shot) {
  await app.clickEl(`${q(task(key))}.querySelector("[data-board-start]")`);
  await app.waitFor(`${q(".orch-dialog textarea")} && true`, "goal dialog");
  await app.waitFor(`${q("[data-orch-profile]")} && ${q("[data-orch-profile]")}.dataset.orchProfile !== "loading"`, "project settings", 20_000);
  if (shot) { await app.ev(`${q(".orch-dialog")}.scrollTop = 0`); await app.shot(shot); }
  const filled = await app.ev(`({ task: ${q("[data-goal-task]")}?.dataset.goalTask ?? null, text: document.querySelectorAll(".orch-dialog textarea")[0].value,
    criteria: document.querySelectorAll(".orch-dialog textarea")[1].value })`);
  await app.type(q("[data-orch-commands]"), commands.join("\n"));
  const mode = await app.ev(`${q("[data-orch-workmode]")}?.dataset.orchWorkmode`);
  if (mode !== "project") {
    await app.ev(`${q(".orch-dialog .orch-advanced")}.open = true`);
    await app.clickEl(q('[data-orch-workmode] input[value="project"]'));
  }
  await app.waitFor(`["ready", "confirm", "blocked", "error"].includes(${q("[data-orch-readiness]")}?.dataset.orchReadiness)`, "readiness", 45_000);
  const confirms = await app.ev(`document.querySelectorAll(".orch-ready__item--confirm input[type=checkbox]").length`);
  for (let i = 0; i < confirms; i += 1) await app.clickEl(`document.querySelectorAll(".orch-ready__item--confirm input[type=checkbox]")[${i}]`);
  await app.waitFor(`!${q(".orch-dialog button[type=submit]")}.disabled`, "start enabled", 10_000);
  return filled;
}
const submitGoal = async () => {
  await app.clickEl(q(".orch-dialog button[type=submit]"));
  await app.waitFor(`${q(".orch-panel")} && !${q(".orch-dialog")}`, "run panel after start");
};
const closePanel = () => app.ev(`${q(".orch-panel__close")}?.click()`);
// the board alone, twice the pixels: the canvas is at 0.5, so the full window shows its text small
async function boardShot(name) {
  const r = await app.ev(`(() => { const b = ${q("[data-board]")}.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const shot = await app.call("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 2 } });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(shot.data, "base64"));
}

try {
  app = await launchApp({ userData: D("user-data"), providers, port: PORT, shots: SHOTS });
  await laptop();
  // ---------- 1. the board and three tasks ----------
  await createAgent(app, "Агент Codex (лид)", node);
  await createAgent(app, "Агент Claude (исполнитель)", node);
  const c = await canvasState(app);
  const lead = c.agents.find((a) => a.provider === "codex"), exec = c.agents.find((a) => a.provider === "claude");
  const ends = () => Promise.all([app.center(card(lead.agentId, ".agent-card__port")), app.center(card(exec.agentId, ".agent-card__body"))]);
  let prev = null;
  const [from, to] = await waitForValue(async () => { const e = await ends(); const still = prev && JSON.stringify(prev) === JSON.stringify(e); prev = e; return still ? e : null; }, "the cards laid out");
  await app.drag(from, to, 20);
  await app.waitFor("window.canvasTTY.orchestration.canvas().then((r) => r.value.links.length === 1)", "link");
  await app.clickEl(q("[data-board-button]"));
  await app.waitFor(`${q("[data-board]")} && true`, "the board on the canvas");
  expect(await app.ev(`[...document.querySelectorAll("[data-board-column]")].map((c) => c.dataset.boardColumn).join()`) === "queue,work,review,done", "four columns: queue, work, review, done");
  await app.shot("board-01-empty");
  await app.clickEl(q("[data-board-new]"));
  await app.waitFor(`${q("[data-board-form]")} && true`, "task form");
  await app.shot("board-02-new-task-form");
  await app.key("Escape", "Escape", 27);
  await app.waitFor(`!${q("[data-board-form]")}`, "form closed");
  await newTask({ title: "Модуль one", text: "Добавить src/one.mjs с константой one", criteria: "src/one.mjs есть\nnode --test проходит" });
  await newTask({ title: "Модуль two", text: "Добавить src/two.mjs с константой two", criteria: "src/two.mjs есть" });
  await newTask({ title: "Связать модули", text: "Импортировать two в one", criteria: "one импортирует two", after: ["T-2"] });
  const t3 = await shown("T-3");
  expect(t3?.column === "queue" && t3.reason === "waits_task" && t3.line.includes("T-2") && !t3.buttons.includes("Запустить"), "T-3 waits for T-2, no «Start»", t3);
  expect(!await app.ev(`${q(task("T-3"))}.querySelector("[data-board-after]")`), "T-3 says «waits for T-2» once (no second «after T-2» line)");
  // B3 (§4.2): «Start anyway» asks first, naming what it waits for
  expect(t3.buttons.includes("Запустить всё равно"), "T-3 offers «Start anyway»", t3);
  await app.clickEl(`${q(task("T-3"))}.querySelector("[data-board-start-anyway]")`);
  await app.waitFor(`${q("[data-board-anyway-confirm]")} && true`, "start anyway confirmation");
  const anywayWhy = await app.ev(`${q("[data-board-anyway-confirm]")}.textContent`);
  expect(anywayWhy.includes("T-2 ещё не готова") && anywayWhy.includes("Запустить всё равно?"), "«Start anyway» says T-2 is not done and asks", anywayWhy);
  await app.shot("board-03b-start-anyway");
  await boardShot("board-03b-start-anyway-board");
  await app.clickEl(`${q("[data-board-anyway-confirm]")}.querySelectorAll("button")[1]`);
  const fresh = await shown("T-1");
  expect(fresh?.column === "queue" && fresh.line === "Ещё не запускалась" && fresh.buttons.includes("Запустить"), "T-1 not started, «Start»", fresh);
  await app.shot("board-03-three-tasks");
  await boardShot("board-03-three-tasks-board");

  // ---------- 2. T-1 from the board, with the project's check ----------
  const filled = await startFromBoard("T-1", ["node --test"], "board-04-goal-dialog-from-task");
  expect(filled.task === "T-1" && filled.text === "Добавить src/one.mjs с константой one" && filled.criteria === "src/one.mjs есть\nnode --test проходит",
    "the goal dialog starts from T-1: its text, requirements, «Task T-1»", filled);
  await submitGoal();
  const runs1 = await app.ev("window.canvasTTY.orchestration.list().then((r) => r.value.map((s) => s.view.runId))");
  const run1 = runs1[0];
  const done1 = await until("T-1", (s) => s.done === "confirmed", "T-1 done (confirmed)");
  expect(done1.column === "done" && done1.line.startsWith("Готово — подтверждено проверками") && done1.badge?.includes("confirmed"), "T-1: Done, confirmed by checks", done1);
  expect(await app.ev(`${q("[data-orch-task]")}?.dataset.orchTask`) === "T-1", "the run's summary starts with T-1", await app.ev(`${q(".orch-summary")}?.textContent.slice(0, 200)`));
  await closePanel();
  const run1View = await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(run1)}).then((r) => [r.value.view.status, r.value.view.progress?.completion])`);
  expect(JSON.stringify(run1View) === '["completed","confirmed"]', "the same data: the run completed, confirmed", run1View);
  const t3After1 = await shown("T-3");
  expect(t3After1.reason === "waits_task" && t3After1.line.includes("T-2"), "T-3 still waits for T-2", t3After1);

  // ---------- 3. T-2 without checks; «Accept the result» ----------
  await startFromBoard("T-2", []);
  await submitGoal();
  // the executor's permission request: the task waits for it on the board, the agent card names the task
  await app.waitFor(`${q("[data-orch-permission]")} && true`, "permission prompt", 60_000);
  await closePanel();
  const waiting = await until("T-2", (s) => s.reason === "waits_permission", "T-2 waits for a permission", 30_000);
  expect(waiting.column === "work" && waiting.line.startsWith("Ждёт разрешения: ls src") && waiting.buttons.includes("Ответить на запрос"),
    "T-2 at work: «Waits for a permission: <what>», «Answer the request»", waiting);
  expect(waiting.line.includes(`причина CLI: ${CLI_WHY}`), "the line gives the CLI's reason as it said it", waiting.line);
  const asksFact = await app.ev(`${q(task("T-2"))}.querySelector("[data-board-facts]")?.textContent ?? ""`);
  expect(asksFact.includes("вопросов о правах: 1"), "the task counts the permission prompts of its run", asksFact);
  const cardTask = await app.ev(`${q(`[data-agent-id="${exec.agentId}"] [data-agent-task]`)}?.textContent ?? null`);
  expect(cardTask === "T-2 · Модуль two", "the agent card at work shows «T-2 · Модуль two»", cardTask);
  await app.shot("board-05a-waits-permission");
  await boardShot("board-05a-waits-permission-board");
  await app.clickEl(`${q(task("T-2"))}.querySelector("[data-board-open]")`);
  await app.waitFor(`${q("[data-orch-permission]")} && true`, "permission prompt in the panel", 30_000);
  await app.clickEl(q(`[data-orch-permission] [data-decision="allow_once"]`));
  await closePanel();
  const review2 = await until("T-2", (s) => s.reason === "no_checks", "T-2 completed without checks");
  expect(review2.column === "review" && review2.done === null && review2.line.startsWith("Завершено без проверок: команды проверки не заданы")
    && review2.buttons.includes("Принять результат") && review2.buttons.includes("Запустить снова"), "T-2: Review, completed without checks — accept or run again", review2);
  const agentState = await app.ev(`${q(`[data-agent-id="${lead.agentId}"]`)}.className`);
  expect(agentState.includes("agent-card--completed_no_checks"), "the agent card says the same: completed without checks", agentState);
  const t3Before = await shown("T-3");
  expect(t3Before.reason === "waits_task", "T-3 waits while T-2 is not accepted", t3Before);
  // B3 (decision 10): the Dock badge counts the task waiting for «Accept the result»
  const lastBadge = () => [...app.output().matchAll(/\[smoke\] notify badge (\d+)/g)].map((m) => Number(m[1])).at(-1) ?? null;
  await until("T-2", () => lastBadge() === 1, "the badge counts T-2", 15_000).catch(() => null);
  expect(lastBadge() === 1, "the Dock badge counts the task waiting for «Accept the result»", lastBadge());
  await app.shot("board-05-completed-without-checks");
  await boardShot("board-05-completed-without-checks-board");
  await app.clickEl(`${q(task("T-2"))}.querySelector("[data-board-accept]")`);
  await app.waitFor(`${q("[data-board-accept-confirm]")} && true`, "accept explanation");
  const why = await app.ev(`${q("[data-board-accept-confirm]")}.textContent`);
  expect(why.includes("Команды проверки не запускались") && why.includes("Дальше пойдут: T-3"), "«Accept the result» explains first and names what goes on", why);
  expect(!await app.ev(`${q(task("T-2"))}.querySelector(".board-task__actions")`), "while asked, the card's other buttons are hidden");
  await app.shot("board-06-accept-explained");
  await boardShot("board-06-accept-explained-board");
  await app.clickEl(q("[data-board-accept-yes]"));
  const accepted = await until("T-2", (s) => s.done === "accepted", "T-2 accepted");
  expect(accepted.column === "done" && accepted.line.startsWith("Готово (принято вами, без проверок)") && accepted.badge?.includes("accepted") && !accepted.badge.includes("confirmed"),
    "T-2: Done (accepted by you, without checks), its own mark", accepted);
  await until("T-2", () => lastBadge() === 0, "the badge back to 0", 15_000).catch(() => null);
  expect(lastBadge() === 0, "accepted: the badge is back to 0", lastBadge());
  const t3Free = await until("T-3", (s) => s.reason === null, "T-3 free");
  expect(t3Free.column === "queue" && t3Free.buttons.includes("Запустить"), "T-3 no longer waits (the result is in the project folder)", t3Free);
  await app.shot("board-07-done-confirmed-and-accepted");
  await boardShot("board-07-done-confirmed-and-accepted-board");

  // ---------- 4. reload ----------
  const before = ledgerCount();
  const all = async () => ({ t1: await shown("T-1"), t2: await shown("T-2"), t3: await shown("T-3") });
  const was = await all();
  await app.ev("location.reload()");
  await sleep(1500);
  await app.waitFor(`${q("[data-board]")} && ${q(task("T-3"))} && true`, "the board after a reload", 30_000);
  await laptop();
  const now = await waitForValue(async () => { const a = await all(); return JSON.stringify(a) === JSON.stringify(was) ? a : null; }, "the same board after a reload", 15_000).catch(() => all());
  expect(JSON.stringify(now) === JSON.stringify(was), "after a reload: the same columns, reasons and marks", { was, now });
  await sleep(1000);
  expect(ledgerCount() === before, "a reload starts no CLI", [before, ledgerCount()]);
  await app.shot("board-08-after-reload");
} catch (error) {
  failures.push(`error: ${String(error?.stack ?? error).slice(0, 1500)}`);
  try { await app?.shot("failure"); } catch {}
} finally {
  const exit = await app?.quit?.();
  console.log(JSON.stringify({ ok: failures.length === 0, passed: passed.length, passedList: passed, failures, fakeCliProcesses: ledgerCount(), shots: SHOTS, exit }, null, 2));
  process.exitCode = failures.length === 0 ? 0 : 1;
}
