// Electron UI smoke for «Проверить сейчас» (UX audit 2026-10-05, top-10 №8): the check before the start, at a laptop size
// (1280×800), with the fake Codex/Claude CLIs. No goal is started and no model is called.
//   1. a copy of a project whose check command passes: every item ok, the time it took;
//   2. a project whose check command already fails on the source: the command's first lines, «already fail before any
//      change», «Fix» focuses the check commands;
//   3. the project folder: the commands are not run before the start, only said to run there;
//   4. a Claude without the sandbox settings (MOCK_CLAUDE_HELP=no_settings, a second launch): the rights blocker with
//      what to do, «Fix» and the one-run «As in my terminal», Start off with the reason;
//   5. the project settings: the same check on the settings being edited.
// Needs `npm run build` first. Usage: node scripts/smoke-preflight-ui.mjs [--shots <dir>]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, byText, canvasState, card, createAgent, launch as launchApp, q, runs, sleep, workspace } from "./orchestration-app-kit.mjs";

const { TMP, D, project, script } = workspace("cto-preflight-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const failures = [];
const passed = [];
const notes = {};
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 500)}`); };

const passing = project("notes-app");
const failingProject = project("legacy-app");
const codexScript = script("codex", []);
const claudeScript = script("claude", []);
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
const ledger = D("ledger.jsonl");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const providers = (extra = {}) => {
  const file = D(`providers-${Object.keys(extra).join("-") || "plain"}.json`);
  const env = (more) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, ...extra, ...more });
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: wrap("codex"), version: "codex-cli 0.160.0", path: PATHS, env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
    claude: { executable: wrap("claude"), version: "2.1.293 (Claude Code)", path: PATHS, env: env({ MOCK_SCRIPT: claudeScript }) },
    shell: "/bin/sh", checkEnv: { PATH: PATHS, HOME: D("mock-state") }
  }));
  return file;
};
// what a model turn leaves with the fake CLIs: a session file (<uuid>.json), codex-thread.jsonl, claude-argv.jsonl
const modelCalls = () => {
  const files = fs.existsSync(D("mock-state")) ? fs.readdirSync(D("mock-state")) : [];
  return files.filter((f) => /^[0-9a-f-]{36}\.json$/.test(f) || f === "codex-thread.jsonl" || f === "claude-argv.jsonl");
};

let app;
const laptop = () => app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
async function pair(dir) {
  await createAgent(app, "Агент Codex (лид)", dir);
  await createAgent(app, "Агент Claude (исполнитель)", dir);
  const c = await canvasState(app);
  const lead = c.agents.find((a) => a.provider === "codex" && a.project === dir), exec = c.agents.find((a) => a.provider === "claude" && a.project === dir);
  await app.drag(await app.center(card(lead.agentId, ".agent-card__port")), await app.center(card(exec.agentId, ".agent-card__body")), 20);
  await app.waitFor(`window.canvasTTY.orchestration.canvas().then((r) => r.value.links.some((l) => l.fromAgentId === ${JSON.stringify(lead.agentId)}))`, "link");
  return (await canvasState(app)).links.find((l) => l.fromAgentId === lead.agentId).linkId;
}
const items = () => app.ev(`[...document.querySelectorAll(".orch-dialog [data-ready-id]")].map((el) => ({ id: el.dataset.readyId, level: el.dataset.readyLevel, text: el.textContent.replace(/\\s+/g, " ").trim() }))`);
const by = async () => Object.fromEntries((await items()).map((i) => [i.id, i]));
async function openGoal(linkId, commands, workMode) {
  await app.clickEl(byText(`[data-agent-link-id="${linkId}"] button`, "Новая цель"));
  await app.waitFor(`${q(".orch-dialog textarea")} && true`, "goal dialog");
  await app.waitFor(`${q("[data-orch-profile]")}?.dataset.orchProfile !== "loading"`, "project settings", 20_000);
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[0]`, "Добавить заметку");
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[1]`, "Заметка добавлена");
  await app.type(q("[data-orch-commands]"), commands);
  if (workMode !== "project") {
    await app.ev(`${q(".orch-dialog .orch-advanced")}.open = true`);
    await app.clickEl(q(`[data-orch-workmode] input[value="${workMode}"]`));
  }
  await app.waitFor(`["ready", "confirm", "blocked"].includes(${q("[data-orch-readiness]")}?.dataset.orchReadiness)`, "light readiness", 30_000);
}
async function checkNow(what) {
  const t0 = Date.now();
  await app.clickEl(q("[data-orch-check-now]"));
  await app.waitFor(`${q("[data-orch-readiness]")}?.dataset.orchChecked === "full"`, `check now: ${what}`, 120_000);
  return Date.now() - t0;
}
// the check from its top, or from its first problem when there is one (a screenshot shows what matters)
const scrollToCheck = async (problem) => {
  await app.ev(`${problem ? q(`[data-ready-id="${problem}"]`) : q("[data-orch-readiness]")}.scrollIntoView({ block: ${problem ? '"center"' : '"start"'} })`);
  await sleep(300);
};
// Escape closes one level: the settings go back to the goal dialog, then the goal dialog closes
const closeDialog = async () => {
  for (let i = 0; i < 3 && await app.ev(`!!${q(".orch-dialog")}`); i++) { await app.key("Escape", "Escape", 27); await sleep(300); }
  await app.waitFor(`!${q(".orch-dialog")}`, "dialog closed");
};

try {
  // ---------- launch 1: CLIs as installed ----------
  app = await launchApp({ userData: D("user-data"), providers: providers(), port: 9800 + Math.floor(Math.random() * 150), shots: SHOTS });
  await laptop();
  await app.waitFor(`${q(".workspace")} && true`, "window", 30_000);

  // 1. a copy, the command passes
  const linkOk = await pair(passing);
  await openGoal(linkOk, "grep -qx 1 README.md || true\nnode -e \"process.exit(0)\"", "copy");
  notes.copyCheckMs = await checkNow("copy, passing");
  let it = await by();
  expect(Object.values(it).every((i) => i.level !== "blocker"), "copy, passing: no blocker", it);
  expect(it.source_1?.level === "ok" && it.source_2?.level === "ok", "copy, passing: both commands pass on the source", [it.source_1, it.source_2]);
  expect(!it.source_failing, "copy, passing: no «already fail»", it.source_failing);
  expect(it.source_where?.level === "info" && /в папке проекта ничего не запускалось/.test(it.source_where.text), "copy: says plainly that nothing ran in the project folder", it.source_where);
  expect(it.sandbox?.level === "ok" && it.sandbox_git?.level === "ok", "the check sandbox and git in it", [it.sandbox, it.sandbox_git]);
  expect(it.auth_codex?.level === "ok" && it.auth_claude?.level === "ok", "the sign-in, as the CLIs say it", [it.auth_codex, it.auth_claude]);
  expect(it.model_claude?.level === "info", "Claude's model: not checked before the start", it.model_claude);
  expect(it.clis?.level === "ok" && /0\.160\.0/.test(it.clis.text), "the CLIs' capabilities", it.clis);
  expect(await app.ev(`!!${q("[data-orch-check-done]")}`), "the time the check took is said", null);
  expect(await app.ev(`!${q(".orch-dialog button[type=submit]")}.disabled || ${q("[data-orch-readiness]")}.dataset.orchReadiness === "confirm"`), "Start stays available", null);
  expect(await app.ev(`${q("[data-orch-ready-summary]")}.dataset.orchReadySummary`) !== "blocked", "all ok: the summary does not block", null);
  await scrollToCheck();
  await app.shot("01-check-all-ok");
  await closeDialog();

  // 2. a command already failing on the source
  const linkFail = await pair(failingProject);
  await openGoal(linkFail, "node -e \"console.error('expected 2 notes, got 1'); process.exit(1)\"", "copy");
  notes.failingCheckMs = await checkNow("copy, failing");
  it = await by();
  expect(it.source_1?.level === "warning" && /expected 2 notes, got 1/.test(it.source_1.text), "failing: the command and its first lines", it.source_1);
  expect(it.source_failing?.level === "warning" && /уже падают до изменений/.test(it.source_failing.text), "failing: «the checks already fail before any change»", it.source_failing);
  expect(!Object.values(it).some((i) => i.level === "blocker"), "failing on the source is a warning, not a blocker", it);
  expect(await app.ev(`${q("[data-orch-ready-summary]")}.dataset.orchReadySummary === "warnings"`), "failing: the summary says warnings, the start is possible", null);
  await scrollToCheck("source_1");
  await app.shot("02-check-commands-fail-on-source");
  await app.clickEl(q('[data-ready-id="source_failing"] [data-orch-fix="commands"]'));
  await sleep(300);
  expect(await app.ev(`document.activeElement === ${q("[data-orch-commands]")}`), "«Fix» on a failing command focuses the check commands", null);
  await closeDialog();

  // 3. the project folder: nothing runs in it before the start
  const marker = path.join(passing, "ran-before-start.txt");
  await app.clickEl(byText(`[data-agent-link-id="${linkOk}"] button`, "Новая цель"));
  await app.waitFor(`${q(".orch-dialog textarea")} && true`, "goal dialog");
  await app.type(q("[data-orch-commands]"), `touch ${marker}`);
  await app.waitFor(`["ready", "confirm", "blocked"].includes(${q("[data-orch-readiness]")}?.dataset.orchReadiness)`, "light readiness", 30_000);
  await checkNow("project folder");
  it = await by();
  expect(it.source?.level === "info" && !it.source_1 && !fs.existsSync(marker), "project folder: the commands are not run before the start", [it.source, fs.existsSync(marker)]);
  await closeDialog();

  // 5. the project settings: the same check on the settings being edited
  await app.clickEl(byText(`[data-agent-link-id="${linkFail}"] button`, "Новая цель"));
  await app.waitFor(`${q("[data-orch-open-settings]")} && true`, "settings button", 20_000);
  await app.clickEl(q("[data-orch-open-settings]"));
  await app.waitFor(`${q(".orch-dialog [data-orch-check-now]")} && true`, "check now in the settings", 20_000);
  expect(await app.ev(`${q("[data-orch-readiness]")}.dataset.orchReadiness === "idle"`), "settings: nothing is checked until asked", null);
  await app.clickEl(q(".orch-dialog [data-orch-check-now]"));
  await app.waitFor(`${q("[data-orch-readiness]")}?.dataset.orchChecked === "full"`, "settings check", 120_000);
  expect((await items()).length > 3, "settings: the check lists its items", await items());
  await scrollToCheck();
  await app.shot("05-settings-check");
  await closeDialog();

  expect(modelCalls().length === 0 && (await runs(app)).length === 0, "no model call and no run: the fake CLIs' record", [modelCalls(), await runs(app)]);
  await app.quit();
  app = null;

  // ---------- launch 2: a Claude without the sandbox settings ----------
  app = await launchApp({ userData: D("user-data-2"), providers: providers({ MOCK_CLAUDE_HELP: "no_settings" }), port: 9800 + Math.floor(Math.random() * 150), shots: SHOTS });
  await laptop();
  await app.waitFor(`${q(".workspace")} && true`, "window 2", 30_000);
  const linkBlocked = await pair(project("blocked-app"));
  // the project's rights: «Рабочая папка» for both
  const prof = await app.ev(`window.canvasTTY.orchestration.profile(${JSON.stringify(linkBlocked)}).then((r) => r.value.profile)`);
  await app.ev(`window.canvasTTY.orchestration.saveProfile(${JSON.stringify(linkBlocked)}, ${JSON.stringify({ ...prof, access: { claude: "workspace", codex: "workspace" } })})`);
  await openGoal(linkBlocked, "node -e 0", "copy");
  notes.blockerCheckMs = await checkNow("blocker");
  it = await by();
  expect(it.access_claude?.level === "blocker" && /Claude 2\.1\.293: не принимает настройки песочницы/.test(it.access_claude.text), "the blocker names the CLI, its version and what is missing", it.access_claude);
  expect(await app.ev(`!!${q('[data-ready-id="access_claude"] [data-orch-fix="settings"]')} && !!${q('[data-ready-id="access_claude"] [data-orch-access-once]')}`), "the blocker offers «Fix» and the one-run choice", null);
  expect(await app.ev(`${q(".orch-dialog button[type=submit]")}.disabled`), "Start is off on a blocker", null);
  expect(/Старт недоступен/.test(await app.ev(`${q("[data-orch-not-ready]")}?.textContent ?? ""`)), "the reason is said beside Start", await app.ev(`${q("[data-orch-not-ready]")}?.textContent ?? ""`));
  expect(await app.ev(`${q("[data-orch-ready-summary]")}.dataset.orchReadySummary === "blocked"`), "blocker: the summary says Start is unavailable", null);
  await scrollToCheck("access_claude");
  await app.shot("03-check-blocker");
  await closeDialog();
  expect(modelCalls().length === 0, "launch 2: no model call", modelCalls());

  const quit = await app.quit();
  app = null;
  const summary = { ok: failures.length === 0, passed: passed.length, failures, notes, shots: SHOTS, exit: quit };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  await app?.shot("failure").catch(() => {});
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.stack ?? error), passed, failures, notes, shots: SHOTS }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await app?.stop().catch(() => {});
  if (shotsArg > 0) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
