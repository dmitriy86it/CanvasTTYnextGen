// Electron UI smoke for stage 12 (native sessions): the real window at a laptop size (1280×800), fake Codex/Claude CLIs
// speaking the app-server and stream-json host protocols (tests/fixtures/orchestration/mock-*.mjs), screenshots.
//   1. fresh profile: agent cards from the context menu on the empty canvas;
//   2. a Laravel-like project: readiness before any model turn (stack, vendor/, the suggested `php artisan test`,
//      the program on the login shell's PATH), the goal dialog with commands and the work place; nothing started;
//   3. a Node project with the user's uncommitted work: a run in the project folder; the executor's permission prompt
//      and its question reach the panel and are answered there; the user's command check passes; completed;
//      the work place, the changes in place and the list of known differences are shown;
//   4. a reload: the run is shown as it was, no CLI starts again.
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-native-ui.mjs [--shots <dir>]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, byText, canvasState, card, createAgent, launch as launchApp, openTab, q, runs, sleep, startGoal, visibleNow, workspace, JOURNAL_V2 } from "./orchestration-app-kit.mjs";

const { TMP, D, git, project, script } = workspace("cto-native-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };

// ---------- projects ----------
const laravel = D("laravel-app");
fs.mkdirSync(path.join(laravel, "tests", "Feature"), { recursive: true });
fs.writeFileSync(path.join(laravel, "artisan"), "#!/usr/bin/env php\n<?php\n");
fs.writeFileSync(path.join(laravel, "composer.json"), JSON.stringify({ name: "smoke/app", require: { "laravel/framework": "^11.0" } }));
fs.writeFileSync(path.join(laravel, "tests", "Feature", "ExampleTest.php"), "<?php\n");
fs.writeFileSync(path.join(laravel, ".gitignore"), "/vendor\n.env\n");
for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "laravel"]]) git(laravel, ...args);

const node = project("node-app");
fs.writeFileSync(path.join(node, "README.md"), "the user's uncommitted work\n");

// ---------- fake CLIs ----------
const verdict = (v) => ({ report: { verdict: v, findings: [], question: null } });
// journal v2 (the default since 1.5.8, or the development flag): the lead plans with conditions (R1 by the note, R2 by
// the check), the reviewer answers the stage review and the final review (journal-v2-format.md §2.7, §2.8)
const planV2 = { report: { stages: [{ title: "Заметка", task: "Add src/note.mjs", conditions: [
  { keep: null, text: "src/note.mjs exists", covers: ["R1"], evidence: { kind: "change", check: null } },
  { keep: null, text: "node --test passes", covers: ["R2"], evidence: { kind: "check", check: "cmd-1" } }] }], dropped: [], dropRequirements: [], question: null } };
const reviewV2 = { report: { conditions: [{ id: "C1", status: "met", paths: ["src/note.mjs"], note: "src/note.mjs exports note" }], findings: [], request: "none", question: null } };
const finalV2 = { report: { conditions: [], findings: [], request: "none", question: null, requirements: ["R1", "R2"].map((id) => ({ id, status: "met", note: "done" })) } };
const codexScript = script("codex", JOURNAL_V2 ? [planV2, reviewV2, finalV2]
  : [{ report: { stages: [{ title: "Заметка", task: "Add src/note.mjs" }], question: null } }, verdict("accept"), verdict("complete")]);
const claudeScript = script("claude", [{ report: { summary: "note added", done: true }, writes: [["src/note.mjs", "export const note = 'a';\n"]] }]);
fs.writeFileSync(path.join(claudeScript, "1.asks.json"), JSON.stringify([
  { tool: "Bash", command: "node --test" },
  // six long options: the answer buttons must still be in view at 1280×800 (review UX-1)
  { tool: "AskUserQuestion", question: "Какое имя у константы? Выберите то, что лучше подходит к существующему коду и соглашениям проекта",
    options: ["note — короткое и уже используется в тестах проекта", "memo", "remark — нейтральное", "annotation — длинное, но точное", "comment — спорит с JS", "text — слишком общее"] }
]));
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
const ledger = D("ledger.jsonl");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, ...extra });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: PATHS, env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({ MOCK_SCRIPT: claudeScript }) },
  shell: "/bin/sh", checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));
const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);
const decisions = () => { const f = D("mock-state", "decisions.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };

let app;
const laptop = () => app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
async function pair(projectDir) {
  const before = (await canvasState(app)).agents.length;
  await createAgent(app, "Агент Codex (лид)", projectDir);
  await createAgent(app, "Агент Claude (исполнитель)", projectDir);
  const c = await canvasState(app);
  const [lead, exec] = [c.agents.find((a) => a.provider === "codex" && a.project === projectDir), c.agents.find((a) => a.provider === "claude" && a.project === projectDir)];
  expect(c.agents.length === before + 2 && lead && exec, `two cards on ${path.basename(projectDir)}`, c.agents);
  await app.drag(await app.center(card(lead.agentId, ".agent-card__port")), await app.center(card(exec.agentId, ".agent-card__body")), 20);
  await app.waitFor(`window.canvasTTY.orchestration.canvas().then((r) => r.value.links.some((l) => l.fromAgentId === ${JSON.stringify(lead.agentId)}))`, "link");
  const link = (await canvasState(app)).links.find((l) => l.fromAgentId === lead.agentId);
  return { lead, exec, link };
}
const readyItem = (id) => app.ev(`(() => { const el = ${q(`[data-ready-id="${id}"]`)}; return el ? { level: el.dataset.readyLevel, text: el.textContent } : null; })()`);

try {
  app = await launchApp({ userData: D("user-data"), providers, port: PORT, shots: SHOTS });
  await laptop();
  expect(ledgerCount() === 0, "no CLI process at start", ledgerCount());
  await app.shot("01-fresh-canvas");

  // ---------- 2. Laravel readiness: facts only, nothing started ----------
  const L = await pair(laravel);
  await app.clickEl(byText(`[data-agent-link-id="${L.link.linkId}"] button`, "Новая цель"));
  await app.waitFor(`${q(".orch-dialog textarea")} && true`, "goal dialog");
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[0]`, "Добавить страницу /health");
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[1]`, "GET /health отвечает 200\nphp artisan test проходит");
  await app.waitFor(`["ready", "confirm", "blocked", "error"].includes(${q("[data-orch-readiness]")}?.dataset.orchReadiness)`, "readiness", 20_000);
  await app.waitFor(`${q("[data-orch-commands]")}.value === "php artisan test"`, "suggested command", 10_000);
  const stack = await readyItem("stack"), vendor = await readyItem("laravel"), cmd = await readyItem("command_1"), wd = await readyItem("workdir");
  expect(stack?.level === "ok" && /Laravel/i.test(stack.text), "readiness: the stack is Laravel", stack);
  // stage 13: the suggested project settings prepare vendor/ automatically (composer install), so it is not a warning
  expect(vendor?.level === "ok" && vendor.text.includes("composer install"), "readiness: vendor/ is missing and prepared automatically (composer install)", vendor);
  expect(cmd && cmd.level !== "ok", "readiness: php is not on this login PATH, said before any turn", cmd);
  expect(wd?.level === "info", "readiness: the agents work in the project folder", wd);
  expect(await app.ev(`${q("[data-orch-workmode]")}.dataset.orchWorkmode`) === "project", "work place default: the project folder", null);
  expect(await app.ev(`!!${q(".orch-dialog [data-orch-differences]")}`), "the dialog lists the known differences", null);
  await app.ev(`${q(".orch-dialog [data-orch-differences]")}.open = true`);
  await app.ev(`${q("[data-orch-readiness]")}.scrollIntoView({ block: "start" })`);
  await sleep(200);
  await app.shot("02-laravel-readiness");
  await app.ev(`${q(".orch-dialog [data-orch-differences]")}.scrollIntoView({ block: "end" })`);
  await sleep(200);
  await app.shot("02b-differences");
  await app.key("Escape", "Escape", 27);
  await app.waitFor(`!${q(".orch-dialog")}`, "dialog closed");
  // the readiness starts CLIs without a model: the models list (model/list), the capability probes, the sign-in status. A
  // model turn leaves its record with the fake CLIs: a session file (<uuid>.json), codex-thread.jsonl, claude-argv.jsonl
  const turns = () => fs.readdirSync(D("mock-state")).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f) || f === "codex-thread.jsonl" || f === "claude-argv.jsonl");
  expect(turns().length === 0 && (await runs(app)).length === 0, "readiness started no model turn and no run", [turns(), ledgerCount(), await runs(app)]);

  // ---------- 3. a run in the project folder ----------
  const N = await pair(node);
  await startGoal(app, N.link.linkId, { task: "Добавить src/note.mjs", criteria: "src/note.mjs есть\nnode --test проходит", commands: ["node --test"],
    onDialog: async () => { await app.waitFor(`${q("[data-orch-readiness]")} && true`, "readiness"); await app.shot("03-goal-dialog"); } });
  const where = await app.ev(`(() => { const el = ${q("[data-orch-where]")}; return el && { mode: el.dataset.orchWhere, text: el.textContent }; })()`);
  expect(where?.mode === "project" && where.text.includes(node), "the panel says: in the project folder, with its path", where);
  await app.waitFor(`${q("[data-orch-permission]")} && true`, "permission prompt", 60_000);
  const perm = await app.ev(`${q("[data-orch-permission]")}.textContent`);
  expect(perm.includes("Bash") && perm.includes("node --test"), "the executor's Bash prompt is in the panel with its command", perm);
  expect(await app.ev(`${q(".orch-summary")}.textContent.includes("разреш") || ${q(".orch-summary")}.textContent.includes("Разреш")`), "the headline says a decision is awaited", null);
  await app.shot("04-permission");
  await app.clickEl(q(`[data-orch-permission] [data-decision="allow_once"]`));
  await app.waitFor(`${q("[data-orch-permission] .orch-permission__q")} && true`, "question", 30_000);
  await app.shot("05-question");
  const answerBtn = await visibleNow(app, q(`[data-orch-permission] [data-decision="allow_once"]`));
  expect(answerBtn.ok, "a long question: the answer button is in view without scrolling", answerBtn);
  await app.clickEl(`[...document.querySelectorAll("[data-orch-permission] .orch-permission__q label")].find((l) => l.textContent.includes("memo")).querySelector("input")`);
  await app.clickEl(q(`[data-orch-permission] [data-decision="allow_once"]`));
  await app.waitFor(`window.canvasTTY.orchestration.list().then((r) => r.value.some((s) => ["completed", "paused", "failed"].includes(s.view.status)))`, "end", 90_000);
  const list = await runs(app);
  expect(list.some((r) => r.status === "completed"), "the run completed", list);
  const d = decisions();
  expect(d.length === 2 && d[0].reply?.behavior === "allow" && JSON.stringify(d[1].reply).includes("memo"), "the CLI got the allow and the chosen answer", d);
  expect(fs.readFileSync(path.join(node, "src", "note.mjs"), "utf8").includes("note"), "the executor wrote into the project folder", null);
  expect(fs.readFileSync(path.join(node, "README.md"), "utf8") === "the user's uncommitted work\n", "the user's uncommitted work is kept", null);
  expect(git(node, "rev-parse", "--abbrev-ref", "HEAD").trim() === "main", "the user's branch is untouched", null);
  await app.shot("06-completed");
  await openTab(app, "activity");
  await app.waitFor(`document.querySelectorAll("[data-activity-kind]").length > 3`, "feed", 10_000);
  await app.shot("07-activity");
  await app.clickEl(`document.querySelectorAll(".orch-roles button")[1]`);
  await sleep(300);
  await app.shot("08-activity-executor");
  await openTab(app, "changes");
  await app.waitFor(`${q(".orch-panel")}.textContent.includes("note.mjs")`, "changes", 10_000);
  await app.shot("09-changes-in-place");

  // ---------- 4. reload: the same state, nothing runs again ----------
  const processes = ledgerCount();
  await app.call("Page.reload", {});
  await sleep(1500);
  await laptop();
  await app.waitFor(`${q("[data-agent-link-id]")} && true`, "canvas after reload", 20_000);
  await sleep(1500);
  expect(ledgerCount() === processes, "a reload starts no CLI", [processes, ledgerCount()]);
  expect((await runs(app)).filter((r) => r.status === "completed").length === 1, "the run is still completed after the reload", await runs(app));
  await app.shot("10-after-reload");

  const quit = await app.quit();
  const summary = { ok: failures.length === 0, passed: passed.length, failures, fakeCliProcesses: ledgerCount(), shots: SHOTS, exit: quit };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  await app?.shot("failure").catch(() => {});
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.stack ?? error), passed, failures, shots: SHOTS }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await app?.stop().catch(() => {});
  if (shotsArg > 0) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
