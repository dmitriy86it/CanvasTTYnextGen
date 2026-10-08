// Electron UI smoke for stage 13 (autopilot, project settings, environment preparation): the real window at a laptop
// size (1280×800), fake Codex/Claude CLIs, fake composer/php, a QA "deploy" that is a script. Screenshots.
//   1. a Laravel-like project without vendor/ and .env: the goal dialog starts from the settings suggested by the
//      repository; the settings dialog (rights with what they map to, preparation, QA, the environment probe);
//      readiness says vendor/ is prepared automatically, not "go to a terminal";
//   2. autopilot with commit + QA: the preparation stage, a permission saved for the project (asked once, applied the
//      second time), an MCP form with validation, the plan exit, a sub-agent, a failing test fixed, commit and QA
//      confirmed by their own checks; the board and the result block say what happened;
//   3. a reload: the same state, no CLI starts again.
// Needs `npm run build` first. Starts no real model and no real push or deploy.
// Usage: node scripts/smoke-autopilot-ui.mjs [--shots <dir>]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, byText, canvasState, card, createAgent, launch as launchApp, openTab, q, runs, sleep, visibleNow, workspace, JOURNAL_V2 } from "./orchestration-app-kit.mjs";
import { linkAgents } from "./link-agents.mjs";

const { TMP, D, git, script } = workspace("cto-autopilot-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };

// ---------- the project: Laravel-like, dependencies missing, a failing test ----------
const app1 = D("laravel-app");
fs.mkdirSync(path.join(app1, "tests", "Feature"), { recursive: true });
const files = {
  artisan: "#!/usr/bin/env php\n<?php\n", "composer.json": JSON.stringify({ name: "smoke/app", require: { "laravel/framework": "^11.0" } }),
  "composer.lock": "{}", ".env.example": "APP_KEY=\n", "app.php": "<?php // broken\n", ".gitignore": "/vendor\n.env\n",
  "phpunit.xml": '<phpunit><php><env name="DB_CONNECTION" value="sqlite"/><env name="DB_DATABASE" value=":memory:"/></php></phpunit>',
  "tests/Feature/AppTest.php": "<?php\n"
};
for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(app1, f), text);
for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "laravel"]]) git(app1, ...args);

// ---------- fake programs of the machine ----------
const BIN = D("bin");
fs.mkdirSync(BIN);
const LOG = D("programs.log");
const prog = (name, body) => fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\necho "${name} $*" >> "${LOG}"\n${body}\n`, { mode: 0o755 });
prog("composer", `mkdir -p vendor && echo '<?php' > vendor/autoload.php && echo "Generating optimized autoload files"`);
prog("php", `case "$2" in
  key:generate) echo "APP_KEY=base64:smoke" >> .env; echo "Application key set successfully." ;;
  test) [ -f vendor/autoload.php ] || { echo "PHP Warning: require(vendor/autoload.php): Failed to open stream"; exit 255; }
        grep -q fixed app.php && echo "Tests: 1 passed" || { echo "FAILED  Tests\\\\Feature\\\\AppTest > health returns 200"; echo "Failed asserting that 500 is identical to 200."; exit 1; } ;;
esac`);
const SHELL = D("login-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 }); // no /etc/profile: the fake programs come first
const programs = (name) => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith(`${name} `)).length : 0);
const deployed = D("qa-deployed");

// ---------- fake CLIs ----------
const verdict = (v) => ({ report: { verdict: v, findings: [], question: null } });
// With the development flag CANVASTTY_JOURNAL_V2=1 the run is written in v2: the lead plans in the v2 shape (the one
// criterion R1 proven by the check command), the reviewer answers each review (journal-v2-format.md §2.7, §2.8).
const V2 = JOURNAL_V2;
const planV2 = { report: { stages: [{ title: "Исправить /health", task: "Make the health test pass",
  conditions: [{ keep: null, text: "php artisan test passes", covers: ["R1"], evidence: { kind: "check", check: "cmd-1" } }] }], dropped: [], dropRequirements: [], question: null } };
const reviewV2 = { report: { conditions: [], findings: [], request: "none", question: null } };
const finalV2 = { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "the test passes" }] } };
const codexScript = script("codex", V2 ? [planV2, reviewV2, reviewV2, finalV2]
  : [{ report: { stages: [{ title: "Исправить /health", task: "Make the health test pass" }], question: null } }, verdict("accept"), verdict("accept"), verdict("complete")]);
const claudeScript = script("claude", [{ report: { summary: "looked around", done: false } }, { report: { summary: "fixed", done: true }, writes: [["app.php", "<?php // fixed\n"]] }]);
const migrate = { tool: "Bash", command: "php artisan migrate --env=testing" };
fs.writeFileSync(path.join(claudeScript, "1.asks.json"), JSON.stringify([
  migrate,
  { tool: "elicitation", server: "tracker", message: "Какой тикет связать с изменением?",
    schema: { type: "object", required: ["env", "ticket"], properties: { env: { type: "string", title: "Окружение", enum: ["qa", "stage"] }, ticket: { type: "string", title: "Тикет", minLength: 3 } } } },
  // a long plan: its decision buttons must stay in view at 1280×800 (review UX-1)
  { tool: "ExitPlanMode", plan: ["1. Прочитать тест", "2. Исправить app.php", "3. Прогнать php artisan test", ...Array.from({ length: 27 }, (_, i) => `${i + 4}. Дополнительный шаг плана номер ${i + 4}`)].join("\n") },
  { tool: "Task", description: "найти обработчик /health" }
]));
fs.writeFileSync(path.join(claudeScript, "2.asks.json"), JSON.stringify([migrate]));
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
const ledger = D("ledger.jsonl");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, MOCK_ALLOW_ACCESS: "1", ...extra });
const providers = D("providers.json");
fs.writeFileSync(D("gitconfig-user"), "[user]\n\tname = smoke\n\temail = smoke@localhost\n");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: PATHS, env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({ MOCK_SCRIPT: claudeScript }) },
  shell: SHELL, checkEnv: { PATH: `${BIN}:${PATHS}`, HOME: D("mock-state"), GIT_CONFIG_GLOBAL: D("gitconfig-user"), GIT_CONFIG_NOSYSTEM: "1" }
}));
const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);
const decisions = () => { const f = D("mock-state", "decisions.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };

let app;
const laptop = () => app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const setValue = (selector, value) => app.ev(`(() => { const el = ${selector}; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); })()`);
const readyItem = (id) => app.ev(`(() => { const el = ${q(`[data-ready-id="${id}"]`)}; return el ? { level: el.dataset.readyLevel, text: el.textContent } : null; })()`);
const view = () => app.ev("window.canvasTTY.orchestration.list().then((r) => r.value.at(-1)?.view ?? null)");

try {
  app = await launchApp({ userData: D("user-data"), providers, port: PORT, shots: SHOTS });
  await laptop();
  // the shared hit-tested gesture (scripts/link-agents.mjs), its journal next to the shots
  const link = await linkAgents({ app, dir: app1, createAgent, canvasState, card, diagFile: path.join(SHOTS, "link-diag.json") });
  const exec = { agentId: link.toAgentId };

  // ---------- 1. the goal dialog and the project settings ----------
  await app.clickEl(byText(`[data-agent-link-id="${link.linkId}"] button`, "Новая цель"));
  await app.waitFor(`${q("[data-orch-profile]")}?.dataset.orchProfile === "suggested"`, "suggested settings", 20_000);
  expect(await app.ev(`${q("[data-orch-commands]")}.value`) === "php artisan test", "the check command comes from the suggested settings", await app.ev(`${q("[data-orch-commands]")}.value`));
  expect(await app.ev(`${q("[data-orch-runmode]")}.dataset.orchRunmode`) === "autopilot", "autopilot is the default mode", null);
  await app.shot("01-goal-dialog");
  // UX audit PR 2: Start / Save pinned at the dialog's bottom, in view without scrolling; the dialog's controls are light
  const pinned = () => app.ev(`(() => { const d = [...document.querySelectorAll(".orch-dialog")].at(-1); const a = d.querySelector(".orch-form__actions");
    const b = a.querySelector('button[type="submit"]'); const r = b.getBoundingClientRect(), dr = d.getBoundingClientRect();
    return { sticky: getComputedStyle(a).position, visible: r.top >= dr.top && r.bottom <= dr.bottom + 1, scrolls: d.scrollHeight > d.clientHeight, scheme: getComputedStyle(d).colorScheme }; })()`);
  const goalPinned = await pinned();
  expect(goalPinned.sticky === "sticky" && goalPinned.visible && goalPinned.scrolls && goalPinned.scheme === "light", "goal dialog: «Старт» pinned and in view while the dialog scrolls", goalPinned);
  await app.clickEl(q("[data-orch-open-settings]"));
  await app.waitFor(`${q("[data-orch-settings]")} && true`, "settings");
  const needed = await app.ev(`${q("[data-orch-needed]")}.textContent`);
  expect(needed.includes("composer install") && needed.includes("key:generate"), "settings: what is missing now is listed", needed);
  // more than the suggested mode and "terminal": the modes read from the CLI's --help have arrived
  await app.waitFor(`document.querySelectorAll('[data-orch-access="claude"] option').length > 2`, "the CLI's own modes", 20_000);
  const claudeModes = await app.ev(`[...document.querySelectorAll('[data-orch-access="claude"] option')].map((o) => o.value)`);
  expect(JSON.stringify(claudeModes) === JSON.stringify(["terminal", "workspace", "acceptEdits", "auto", "full"]), "settings: Claude modes from the installed CLI's --help", claudeModes);
  // the stage A gate: a new project starts in the work folder for both CLIs
  const suggested = await app.ev(`["claude", "codex"].map((p) => document.querySelector(\`[data-orch-access="\${p}"] select\`).value)`);
  expect(JSON.stringify(suggested) === JSON.stringify(["workspace", "workspace"]), "settings: a new project suggests «Рабочая папка» for both CLIs", suggested);
  await setValue(q('[data-orch-access="claude"] select'), "full");
  expect(await app.ev(`!!${q("[data-orch-full-warning]")}`), "full access shows its warning", null);
  await setValue(q('[data-orch-access="claude"] select'), "acceptEdits");
  const mapping = await app.ev(`${q('[data-orch-access="claude"] code')}.textContent`);
  expect(mapping.includes("--permission-mode acceptEdits"), "the mapping says what is passed to Claude", mapping);
  await app.shot("02-settings");
  const settingsPinned = await pinned();
  expect(settingsPinned.sticky === "sticky" && settingsPinned.visible && settingsPinned.scrolls, "settings: «Сохранить» pinned and in view while the dialog scrolls", settingsPinned);
  await app.ev(`${q("[data-orch-advanced]")}.open = true`);
  await setValue(q("[data-orch-settings-qa-env]"), "qa");
  await setValue(q("[data-orch-settings-qa-command]"), `echo "$CANVASTTY_COMMIT" > ${deployed}`);
  // the version contract (review 2): the verification reports the version it observed on QA to $CANVASTTY_QA_RESULT
  await setValue(q("[data-orch-settings-qa-verify]"), `test -s ${deployed} && cat ${deployed} > "$CANVASTTY_QA_RESULT"`);
  expect(await app.ev(`!!${q("[data-orch-qa-unverified]")}`), "settings: without the version contract the check is said not to confirm the version", null);
  await app.clickEl(q("[data-orch-settings-qa-reports] input"));
  expect(await app.ev(`!${q("[data-orch-qa-unverified]")} && ${q("[data-orch-settings-qa-reports] input")}.checked`), "settings: the version contract is on", null);
  await app.clickEl(byText("[data-orch-env-check] button", "Проверить окружение"));
  await app.waitFor(`${q("[data-orch-env-report]")} && true`, "environment report", 30_000);
  const envReport = await app.ev(`${q("[data-orch-env-report]")}.textContent`);
  expect(envReport.includes("mock-mcp") && envReport.includes("mock-skill") && envReport.includes("не подтверждено"), "the probe shows what the CLIs confirmed and marks what they did not", envReport);
  // MCP servers as fields, not text: connection and sign-in apart (the fake Codex: runtimeStatus ready, authStatus notLoggedIn)
  const mcpCodex = await app.ev(`(() => { const e = document.querySelector('[data-env-provider="codex"] [data-mcp-server="mock-mcp"]'); return e && { connection: e.dataset.mcpConnection, auth: e.dataset.mcpAuth }; })()`);
  expect(mcpCodex?.connection === "ready" && mcpCodex?.auth === "notLoggedIn", "the probe shows an MCP server's connection and sign-in apart", mcpCodex);
  const badProbe = await app.ev(`Promise.all([window.canvasTTY.orchestration.probe(${JSON.stringify(link.linkId)}, { mcpReady: 5 }), window.canvasTTY.orchestration.probe(${JSON.stringify(link.linkId)}, { other: "x" })])`);
  expect(badProbe.every((r) => r.ok === false), "the probe's options are checked in main", badProbe);
  await app.ev(`${q("[data-orch-env-report]")}.scrollIntoView({ block: "center" })`);
  await sleep(200);
  await app.shot("03-environment-probe");
  // a new project starts in a separate copy (PR 5); this one works in the project folder, where commit and QA are offered
  expect(await app.ev(`${q("[data-orch-settings-workmode]")}.dataset.orchSettingsWorkmode`) === "copy", "settings: a new project's work place is a separate copy", null);
  await app.clickEl(`document.querySelectorAll("[data-orch-settings-workmode] input")[2]`);
  // «Как в моём терминале» for Codex: shown with its warning, saved only once the warning is confirmed
  await setValue(q('[data-orch-access="codex"] select'), "terminal");
  expect(await app.ev(`!!${q("[data-orch-terminal-warning]")} && !!${q("[data-orch-terminal-confirm]")}`), "terminal mode shows its warning and a confirmation", null);
  await app.clickEl(q(".orch-settings button[type=submit]"));
  await app.waitFor(`${q(".orch-settings .dialog-error")} && true`, "terminal mode refused without the confirmation", 10_000);
  expect((await app.ev(`${q(".orch-settings .dialog-error")}.textContent`)).includes("Подтвердите предупреждение"), "settings: not saved without the confirmation", null);
  await app.clickEl(q("[data-orch-terminal-confirm] input"));
  await app.clickEl(q(".orch-settings button[type=submit]"));
  await app.waitFor(`${q("[data-orch-profile]")}?.dataset.orchProfile === "saved"`, "settings saved", 10_000);
  // review UX-2: the goal dialog says which rights the agents get
  const rights = await app.ev(`${q("[data-orch-rights]")}?.textContent ?? ""`);
  expect(rights.includes("Правки файлов без вопросов") && rights.includes("Как в моём терминале"), "the goal dialog shows the agents' rights from the settings", rights);
  expect(await app.ev(`!!${q("[data-orch-rights-terminal]")}`), "the goal dialog warns about «Как в моём терминале»", null);

  // readiness: prepared, not "go to a terminal"
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[0]`, "Починить /health: тест должен проходить");
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[1]`, "php artisan test проходит");
  await app.waitFor(`["ready", "confirm", "blocked", "error"].includes(${q("[data-orch-readiness]")}?.dataset.orchReadiness)`, "readiness", 20_000);
  const prep = await readyItem("prepare"), vendor = await readyItem("laravel"), testdb = await readyItem("testdb");
  expect(prep?.level === "info" && prep.text.includes("composer install"), "readiness: the preparation is automatic", prep);
  expect(vendor?.level === "ok" && vendor.text.includes("composer install"), "readiness: vendor/ is prepared, not a warning", vendor);
  expect(testdb?.level === "ok" && testdb.text.includes("sqlite"), "readiness: the test database is the test one", testdb);
  await app.clickEl(q('[data-finish-option="commit"] input'));
  await app.clickEl(q('[data-finish-option="qa"] input'));
  expect(await app.ev(`${q('[data-finish-option="push"] input')}.disabled`), "push is off: not set up for the project", null);
  await app.ev(`${q("[data-orch-finish-choice]")}.scrollIntoView({ block: "center" })`);
  await sleep(200);
  await app.shot("04-goal-ready");
  expect((await runs(app)).length === 0 && decisions().length === 0, "nothing started yet: no run, no prompt", await runs(app));
  await app.waitFor(`!${q(".orch-dialog button[type=submit]")}.disabled`, "start enabled", 10_000);
  await app.clickEl(q(".orch-dialog button[type=submit]"));
  await app.waitFor(`${q(".orch-panel")} && !${q(".orch-dialog")}`, "panel");

  // ---------- 2. the run ----------
  await app.waitFor(`${q("[data-orch-permission]")} && true`, "first prompt", 60_000);
  expect(programs("composer") === 1 && fs.existsSync(path.join(app1, "vendor", "autoload.php")), "composer install ran once as preparation", programs("composer"));
  expect(fs.readFileSync(path.join(app1, ".env"), "utf8").includes("APP_KEY=base64"), ".env and the key were prepared", null);
  const opts = await app.ev(`[...document.querySelectorAll("[data-orch-permission] [data-decision]")].map((b) => b.dataset.decision)`);
  expect(opts.includes("allow_project") && opts.includes("allow_run"), "the prompt offers 'until the run ends' and 'always in this project'", opts);
  await app.shot("05-permission");
  // review UX-4: with the panel closed, the card and the link still say that the person is needed
  await app.clickEl(q(".orch-panel__close"));
  expect((await app.ev(`${card(exec.agentId, ".agent-card__state")}?.textContent`)) === "Ждёт вашего решения", "the executor's card says it waits for the person", await app.ev(`${card(exec.agentId, ".agent-card__state")}?.textContent`));
  expect((await app.ev(`${q(`[data-agent-link-id="${link.linkId}"] .agent-link__state`)}?.textContent`)) === "Ждёт вашего решения", "the link says it waits for the person", null);
  await app.clickEl(byText(`[data-agent-link-id="${link.linkId}"] button`, "Наблюдать"));
  await app.waitFor(`${q("[data-orch-permission]")} && true`, "panel again", 10_000);
  expect((await visibleNow(app, q(`[data-orch-permission] [data-decision="allow_project"]`))).ok, "reopened by Observe: the permission's buttons are in view", await visibleNow(app, q(`[data-orch-permission] [data-decision="allow_project"]`)));
  expect((await app.ev(`${q("[data-board=access]")}?.textContent ?? ""`)).includes("Правки файлов без вопросов"), "the board shows the run's rights", null);
  expect(await app.ev(`!!${q("[data-board=access]")}?.closest(".orch-board__terminal")`), "the board shows «Как в моём терминале» in the warning colour", null);
  await openTab(app, "overview");
  // v2: the reviewer is a participant too, a new session of the lead's CLI with its mode
  const badges = await app.ev(`[...document.querySelectorAll("[data-participant] [data-participant-access]")].map((e) => [e.closest("[data-participant]").dataset.participant, e.dataset.participantAccess])`);
  expect(JSON.stringify(badges) === JSON.stringify([["lead", "terminal"], ["executor", "acceptEdits"], ...(V2 ? [["reviewer", "terminal"]] : [])]), "each participant's card shows its CLI's mode", badges);
  await app.clickEl(q(`[data-orch-permission] [data-decision="allow_project"]`));

  await app.waitFor(`${q('[data-orch-permission="elicitation"]')} && true`, "MCP form", 30_000);
  await app.shot("06-mcp-form");
  await setValue(q('[data-form-field="env"] select'), "qa");
  await setValue(q('[data-form-field="ticket"] input'), "AB");
  await app.clickEl(q(`[data-orch-permission="elicitation"] [data-decision="allow_once"]`)); // the browser keeps a too-short value from being sent
  await sleep(300);
  expect(await app.ev(`!!${q('[data-orch-permission="elicitation"]')}`), "a too-short ticket is not sent", null);
  await setValue(q('[data-form-field="ticket"] input'), "ABC-1");
  await app.clickEl(q(`[data-orch-permission="elicitation"] [data-decision="allow_once"]`));

  await app.waitFor(`${q('[data-orch-permission="plan"]')} && true`, "plan exit", 30_000);
  expect((await app.ev(`${q("[data-orch-plan-text]")}.textContent`)).includes("Исправить app.php"), "the plan is shown in full", null);
  for (const d of ["allow_once", "deny"]) {
    const vis = await visibleNow(app, q(`[data-orch-permission="plan"] [data-decision="${d}"]`));
    expect(vis.ok, `a long plan: its ${d} button is in view without scrolling`, vis);
  }
  await app.shot("07-plan-exit");
  await app.clickEl(q(`[data-orch-permission="plan"] [data-decision="allow_once"]`));

  await app.waitFor(`window.canvasTTY.orchestration.list().then((r) => r.value.some((s) => ["completed", "paused", "failed"].includes(s.view.status)))`, "end", 120_000);
  const v = await view();
  expect(v.status === "completed", "the run completed", v);
  const d = decisions();
  expect(d.filter((x) => x.tool === "Bash").length === 2 && d.filter((x) => x.tool === "Bash").every((x) => x.reply?.behavior === "allow"), "the same command twice: asked once, allowed twice", d);
  expect(JSON.stringify(d.find((x) => x.tool === "elicitation")?.reply) === JSON.stringify({ action: "accept", content: { env: "qa", ticket: "ABC-1" } }), "the MCP server got the form as filled", d);
  expect(v.progress?.grantsApplied === 1, "one saved permission applied", v.progress);
  const [commit, , qa] = v.progress?.finish ?? [];
  expect(commit?.status === "done" && /^[0-9a-f]{40}$/.test(commit.commit ?? ""), "the commit is confirmed", commit);
  expect(git(app1, "log", "-1", "--format=%B").includes("CanvasTTY-Run:"), "the commit carries the run", null);
  expect(git(app1, "status", "--porcelain").trim() === "", "the fix is committed; vendor/ and .env stay ignored", git(app1, "status", "--porcelain"));
  expect(qa?.status === "done" && fs.readFileSync(deployed, "utf8").trim() === commit?.commit, "QA got the commit and its verification passed", qa);
  const changes = await app.ev(`window.canvasTTY.orchestration.changes(${JSON.stringify(v.runId)})`);
  expect(changes.ok && changes.value.files.map((f) => f.path).join() === "app.php", "the changes against the start list the fix", changes);
  await sleep(800);
  expect((await app.ev(`${q('[data-fact="changes"]')}.textContent`)).includes("да"), "the result says there are changes", await app.ev(`${q('[data-fact="changes"]')}.textContent`));
  await app.ev(`${q("[data-orch-board]")}?.scrollIntoView({ block: "start" })`);
  await app.shot("08-completed-board");
  // UX audit Н9: what the run spent — model calls per role, the tokens each CLI reported, the turns and the time
  const cost = await app.ev(`Object.fromEntries(["calls", "tokens", "turns-used", "elapsed"].map((k) => [k, document.querySelector('[data-board="' + k + '"]')?.textContent ?? null]))`);
  expect(/Лид [1-9]/.test(cost.calls ?? "") && /Исполнитель [1-9]/.test(cost.calls ?? ""), "the board: model calls per role", cost);
  expect(/Лид: [\d,]+/.test(cost.tokens ?? "") && /Исполнитель: [\d,]+/.test(cost.tokens ?? "") && !/\$|USD/.test(cost.tokens ?? ""), "the board: tokens per role as the CLIs reported them, no money", cost);
  expect(/^\d+ из \d+$/.test(cost["turns-used"] ?? "") && / из /.test(cost.elapsed ?? ""), "the board: turns and time against the limits", cost);
  expect(/вызовов моделей: \d+, токенов: [\d,]/.test(await app.ev(`${q('[data-board="cost-total"]')}?.textContent ?? ""`)), "the board: what the run spent in all, on one line", null);
  await app.ev(`${q("[data-orch-cost-roles]")}.open = true`);
  expect(/Вызовы этого агента: \d+ · токенов:/.test(await app.ev(`${q("[data-agent-cost]")}?.textContent ?? ""`)), "the cards: calls and tokens of their agent", await app.ev(`${q("[data-agent-cost]")}?.textContent ?? ""`));
  await app.ev(`${q('[data-board="calls"]')}?.scrollIntoView({ block: "center" })`);
  await sleep(200);
  await app.shot("08b-board-cost");
  await app.ev(`${q("[data-orch-finish]")}.scrollIntoView({ block: "center" })`);
  await sleep(200);
  await app.shot("09-result");
  // review 2: the version is confirmed only because the verification reported the observed commit and it matched
  expect(qa?.version === "confirmed" && qa?.observed === commit?.commit, "QA: the observed version is the expected commit", qa);
  const qaLine = await app.ev(`${q('[data-finish-step="qa"]')}?.textContent ?? ""`);
  expect(qaLine.includes("подтверждена ожидаемая версия") && qaLine.includes(commit.commit.slice(0, 12)) && (await app.ev(`${q('[data-finish-step="qa"]')}.dataset.finishStatus`)) === "qa_confirmed",
    "the result says the expected version is confirmed on QA and shows the observed commit", qaLine);
  await app.ev(`${q("[data-orch-env-session]")}.scrollIntoView({ block: "center" })`);
  await sleep(200);
  expect((await app.ev(`${q("[data-orch-env-session]")}.textContent`)).includes("mock-mcp (connected)"), "the run shows what the CLIs reported they loaded", null);
  await app.shot("10-session-environment");
  await openTab(app, "activity");
  await app.clickEl(`document.querySelectorAll(".orch-roles button")[1]`);
  await app.waitFor(`document.querySelectorAll('[data-activity-kind="subagent"]').length > 0`, "sub-agent in the feed", 10_000);
  await app.shot("11-activity-executor");
  await app.clickEl(`document.querySelectorAll(".orch-roles button")[2]`);
  await app.waitFor(`document.querySelectorAll('[data-activity-kind="prepare_finished"]').length > 0 && document.querySelectorAll('[data-activity-kind="external_action"]').length > 0`, "prepare and finish in the feed", 10_000);
  await app.shot("12-activity-canvastty");

  // ---------- 3. reload ----------
  const processes = ledgerCount();
  await app.call("Page.reload", {});
  await sleep(1500);
  await laptop();
  await app.waitFor(`${q("[data-agent-link-id]")} && true`, "canvas after reload", 20_000);
  await sleep(1500);
  expect(ledgerCount() === processes, "a reload starts no CLI", [processes, ledgerCount()]);
  expect((await runs(app)).filter((r) => r.status === "completed").length === 1, "the run is still completed", await runs(app));

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
