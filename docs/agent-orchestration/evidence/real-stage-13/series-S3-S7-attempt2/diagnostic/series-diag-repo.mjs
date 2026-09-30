// Stage 13 limited real series through the UI: N (a small Node project without node_modules) and L (a minimal Laravel
// project without vendor/, SQLite tests set explicitly). Autopilot, rights «Как в моём терминале», no commit/push/QA.
// Every user action is a mouse event in the application's window (DevTools protocol); the script reads the journal,
// the activity file and the project. A temporary userData and new temporary projects are used; the installed app,
// the global CLI settings and their authorization are not touched.
//   --rehearse   development build + fake CLIs and fake programs (no model request, no download)
//   --real       development build + the installed Codex/Claude CLIs (REAL model requests) and real npm/composer/php
// --out <dir>: report.json, series.log, shots/. --only N|L. Stops the series at the first unexpected refusal, protocol
// error, pause or limit; never repeats a scenario and never raises a limit.
//
// The remaining series S3–S7 (evidence/real-stage-13/S3-S7-PLAN.md), selected with --only S3,S4,S5,S6,S7 (never mixed
// with N/L; each scenario once, in the given order), with the same limits, stops and prompt rule:
//   S3 step by step, Claude acceptEdits / Codex workspace: the flags passed (process list) and what each CLI reported
//   S4 a local MCP server asking a form (tests/fixtures/orchestration/mcp-elicit-server.mjs): answer, decline, validation
//   S5 Claude in plan mode by the project's own .claude/settings.json: ExitPlanMode sent back once, then approved
//   S6 worktree + commit + push to a local bare repository + a local QA script; quit during QA, restart, resume: the
//      deploy must not run again; quit after QA, restart: nothing runs
//   S7 «Проверить окружение» on the person's project (--project <dir>, read only), names compared with the terminal
// --s4-dir <dir>: where S4's project is made (a new folder; a fixed path lets the person trust it in Codex once).
//
// Prompts of the CLIs during a real run: the assignment allows working in the temporary project and running its own
// tests. A prompt is answered «Разрешить один раз» only when it is exactly that (a read/test command or a file change
// inside the project); every answer is recorded as an intervention with its reason. Anything else — a question, a plan,
// a form, a command outside the project, network — stops the series and is shown in the report. Nothing is saved.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, byText, canvasState, card, createAgent, launch as launchApp, q, sleep, startGoal, workspace } from "<repo>/scripts/orchestration-app-kit.mjs";

const REAL = process.argv.includes("--real");
const REHEARSE = process.argv.includes("--rehearse");
if (REAL === REHEARSE) throw new Error("exactly one of --real or --rehearse");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const ORDER = (arg("--only") ?? "N,L").split(",").map((x) => x.trim()).filter(Boolean);
const S_SERIES = ORDER.some((n) => n.startsWith("S"));
if (S_SERIES && ORDER.some((n) => !/^S[3-7]$/.test(n))) throw new Error("--only: S3..S7 are not mixed with N/L");
if (new Set(ORDER).size !== ORDER.length) throw new Error("--only: a scenario is run once");
const SUPPORTED = { codex: ["codex-cli 0.155.1"], claude: ["2.1.281 (Claude Code)", "2.1.282 (Claude Code)"] };
const LIMITS = { turns: 8, roundsPerStage: 2, replans: 1, runMin: 20 };
const SCENARIO_MS = 20 * 60_000;
// S3–S7: 4 runs of at most 8 turns and S7 without a turn
const SERIES_MS = (S_SERIES ? 100 : 50) * 60_000;
const SERIES_TURNS = S_SERIES ? 32 : 16;
const PERSON_PROJECT = arg("--project") ? fs.realpathSync(path.resolve(arg("--project"))) : null;
if (REAL && ORDER.includes("S7") && !PERSON_PROJECT) throw new Error("S7 needs --project <the person's usual project>");

const { TMP, D, git } = workspace(REAL ? "cto-real-auto-" : "cto-real-auto-rh-");
const OUT = path.resolve(arg("--out") ?? D("out"));
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9700 + Math.floor(Math.random() * 90);
const t0 = Date.now();
const report = { mode: REAL ? "real" : "rehearse", startedAt: new Date(t0).toISOString(), order: ORDER, limits: { perScenario: { ...LIMITS, scenarioMin: 20 }, series: { turns: SERIES_TURNS, minutes: SERIES_MS / 60_000 } }, scenarios: {}, interventions: [], checks: [], failures: [], notes: {} };
const logLines = [];
const log = (m) => { const l = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`; logLines.push(l); process.stderr.write(`${l}\n`); };
const check = (ok, what, got) => { report.checks.push({ ok, what, ...(ok ? {} : { got }) }); log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` ${JSON.stringify(got)?.slice(0, 500)}`}`); if (!ok) report.failures.push(what); return ok; };
class Halt extends Error {}
const halt = (why) => { throw new Halt(why); };
const anon = (s) => String(s ?? "").replaceAll(TMP, "<tmp>").replaceAll(process.env.HOME ?? "/nonexistent", "~");

const sh = (cmd, cwd, opts = {}) => execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60_000, ...opts });
const which = (name) => { try { return execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(); } catch { return null; } };

// ---------- CLIs ----------
let providersFile;
let BIN, rehearsalEnv;
if (REAL) {
  for (const cli of ["codex", "claude"]) {
    const bin = which(cli);
    const version = bin ? execFileSync(bin, ["--version"], { encoding: "utf8" }).split("\n")[0].trim() : null;
    report.notes[`${cli}Version`] = version;
    if (!SUPPORTED[cli].includes(version)) { process.stdout.write(`${JSON.stringify({ ok: false, stop: `unsupported ${cli} version: ${version}` })}\n`); process.exit(1); }
  }
  for (const tool of ["node", "npm", "php", "composer"]) report.notes[`${tool}Version`] = (() => { try { return sh(`${tool} --version`, TMP).trim().split("\n")[0]; } catch (e) { return `unavailable: ${String(e).slice(0, 200)}`; } })();
  // the tests' environment must not carry a database of the person (phpunit's force="true" wins anyway; recorded)
  const dbVars = sh("env", TMP).split("\n").filter((l) => /^DB_/.test(l)).map((l) => l.split("=")[0]);
  report.notes.loginShellDbVariables = dbVars;
  log(`versions: ${report.notes.codexVersion}; ${report.notes.claudeVersion}; DB_* in login shell: ${dbVars.join(",") || "none"}`);
} else {
  BIN = D("bin");
  fs.mkdirSync(BIN);
  const prog = (name, body) => fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // npm ci: a small stand-in of "ms" (no download); npm test: the project's real tests with node --test
  const ms = "module.exports = (t) => { const m = /^([0-9]+)(ms|s|m|h|d)$/.exec(t); return m ? Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]] : undefined; };";
  prog("npm", `case "$1" in ci) mkdir -p node_modules/ms && echo '{"name":"ms","main":"index.js"}' > node_modules/ms/package.json && echo '${ms}' > node_modules/ms/index.js && echo '{}' > node_modules/.package-lock.json ;; test) exec node --test ;; esac`);
  prog("composer", `mkdir -p vendor && echo '<?php' > vendor/autoload.php`);
  prog("php", `case "$2" in key:generate) sed -i.bak 's/^APP_KEY=.*/APP_KEY=base64:rehearse/' .env ;; test) grep -q health routes/web.php && echo "Tests: 2 passed" || { echo "FAILED Tests\\\\Feature\\\\HealthAcceptTest"; exit 1; } ;; esac`);
  fs.writeFileSync(D("login-shell"), `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
  fs.writeFileSync(D("gitconfig-user"), "[user]\n\tname = rehearsal\n\temail = rehearsal@localhost\n");
  rehearsalEnv = { PATH: `${BIN}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: D("mock-state"), GIT_CONFIG_GLOBAL: D("gitconfig-user"), GIT_CONFIG_NOSYSTEM: "1" };
}
// The fake CLIs' scripts, in the order the selected scenarios call them (each scenario's `rehearse` steps).
function writeRehearsal() {
  const script = (name, steps) => {
    const d = D("script", name);
    fs.mkdirSync(d, { recursive: true });
    steps.forEach((s, i) => {
      fs.writeFileSync(path.join(d, `${i + 1}.json`), JSON.stringify(s.report));
      if (s.writes) fs.writeFileSync(path.join(d, `${i + 1}.writes.json`), JSON.stringify(s.writes.map(([rel, text]) => ({ rel, base64: Buffer.from(text).toString("base64") }))));
      if (s.asks) fs.writeFileSync(path.join(d, `${i + 1}.asks.json`), JSON.stringify(s.asks));
    });
    return d;
  };
  const codex = script("codex", ORDER.flatMap((n) => SCENARIOS[n].rehearse?.codex ?? []));
  const claude = script("claude", ORDER.flatMap((n) => SCENARIOS[n].rehearse?.claude ?? []));
  fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
  const wrap = (p) => { const f = D(`${p}-mock`); fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 }); return f; };
  const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
  // MOCK_ALLOW_ACCESS: the mocks accept a rights mode the person chose (S3); N and L choose none
  const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: D("ledger.jsonl"), MOCK_ALLOW_ACCESS: "1", ...extra });
  providersFile = D("providers.json");
  fs.writeFileSync(providersFile, JSON.stringify({
    codex: { executable: wrap("codex"), version: SUPPORTED.codex[0], path: PATHS, env: env({ MOCK_SCRIPT: codex, CODEX_HOME: D("mock-state", ".codex") }) },
    claude: { executable: wrap("claude"), version: SUPPORTED.claude.at(-1), path: PATHS, env: env({ MOCK_SCRIPT: claude }) },
    shell: D("login-shell"), checkEnv: rehearsalEnv
  }));
}
const mockState = (file) => { const f = D("mock-state", file); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const verdict = (v) => ({ report: { verdict: v, findings: [], question: null } });
const plan = { report: { stages: [{ title: "change", task: "make the acceptance test pass" }], question: null } };
const DURATION = { report: { summary: "toMs", done: true }, writes: [["src/duration.mjs", "import ms from \"ms\";\nexport function toMs(t) { const v = ms(t); if (typeof v !== \"number\") throw new TypeError(\"bad\"); return v; }\n"], ["tests/duration.test.mjs", "import { test } from \"node:test\";\ntest(\"ok\", () => {});\n"]] };

// ---------- the projects ----------
const commitAll = (dir, msg) => { for (const a of [["add", "-A"], ["-c", "user.name=series", "-c", "user.email=series@localhost", "commit", "-q", "-m", msg]]) git(dir, ...a); };
// extra: {rel: text} files added before the first commit (null: the file is left out)
function nodeProject(name = "node-app", extra = {}) {
  const dir = arg("--s4-dir") && name === "s4-app" ? path.resolve(arg("--s4-dir")) : D(name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) halt(`${dir} is not empty`);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "series-node-app", version: "1.0.0", private: true, type: "module", scripts: { test: "node --test" }, dependencies: { ms: "2.1.3" } }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(dir, "src", "sum.mjs"), "export const sum = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(dir, "tests", "sum.test.mjs"), "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { sum } from \"../src/sum.mjs\";\ntest(\"sum\", () => assert.equal(sum(1, 2), 3));\n");
  fs.writeFileSync(path.join(dir, "tests", "duration.accept.test.mjs"), "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { toMs } from \"../src/duration.mjs\";\ntest(\"toMs\", () => { assert.equal(toMs(\"2s\"), 2000); assert.equal(toMs(\"1h\"), 3600000); assert.throws(() => toMs(\"soon\"), TypeError); });\n");
  if (REAL) {
    sh("npm install --package-lock-only --ignore-scripts --no-audit --no-fund", dir); // the lock file from the public registry; no node_modules
    if (fs.existsSync(path.join(dir, "node_modules"))) halt("fixture: node_modules appeared");
  } else fs.writeFileSync(path.join(dir, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "series-node-app" }, "node_modules/ms": { version: "2.1.3" } } })}\n`);
  for (const [rel, text] of Object.entries(extra)) {
    if (text === null) { fs.rmSync(path.join(dir, rel)); continue; }
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, "init", "-q", "-b", "main");
  commitAll(dir, "node app");
  return dir;
}
function laravelProject() {
  const dir = D("laravel-app");
  if (REAL) {
    // the skeleton and its lock file from Packagist; vendor/ is removed again: the run prepares it
    sh(`composer create-project laravel/laravel ${JSON.stringify(dir)} --no-scripts --no-interaction --prefer-dist --no-progress`, TMP);
    fs.rmSync(path.join(dir, "vendor"), { recursive: true, force: true });
    for (const f of [".env", "database/database.sqlite"]) fs.rmSync(path.join(dir, f), { force: true });
    for (const f of fs.readdirSync(path.join(dir, "bootstrap", "cache"))) if (f.endsWith(".php")) fs.rmSync(path.join(dir, "bootstrap", "cache", f));
  } else {
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.mkdirSync(path.join(dir, "tests", "Feature"), { recursive: true });
    fs.writeFileSync(path.join(dir, "artisan"), "#!/usr/bin/env php\n<?php\n");
    fs.writeFileSync(path.join(dir, "composer.json"), JSON.stringify({ name: "series/laravel", require: { "laravel/framework": "^12.0" } }));
    fs.writeFileSync(path.join(dir, "composer.lock"), "{}");
    fs.writeFileSync(path.join(dir, ".env.example"), "APP_KEY=\nDB_CONNECTION=sqlite\n");
    fs.writeFileSync(path.join(dir, "routes", "web.php"), "<?php\n");
    fs.writeFileSync(path.join(dir, ".gitignore"), "/vendor\n.env\n");
  }
  // the tests' database, set explicitly: SQLite in memory, forced over any variable of the environment
  const xmlFile = path.join(dir, "phpunit.xml");
  let xml = fs.existsSync(xmlFile) ? fs.readFileSync(xmlFile, "utf8") : "<?xml version=\"1.0\"?>\n<phpunit>\n    <php>\n    </php>\n</phpunit>\n";
  xml = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/\s*<env name="DB_(?:CONNECTION|DATABASE|HOST|PORT|USERNAME|PASSWORD|URL)"[^>]*\/>/g, "");
  xml = xml.replace(/<php>/, "<php>\n        <env name=\"DB_CONNECTION\" value=\"sqlite\" force=\"true\"/>\n        <env name=\"DB_DATABASE\" value=\":memory:\" force=\"true\"/>\n        <env name=\"DB_URL\" value=\"\" force=\"true\"/>");
  fs.writeFileSync(xmlFile, xml);
  fs.writeFileSync(path.join(dir, "tests", "Feature", "HealthAcceptTest.php"), "<?php\n\nnamespace Tests\\Feature;\n\nuse Tests\\TestCase;\n\nclass HealthAcceptTest extends TestCase\n{\n    public function test_health(): void\n    {\n        $this->getJson('/health')->assertOk()->assertExactJson(['status' => 'ok']);\n    }\n}\n");
  git(dir, "init", "-q", "-b", "main");
  commitAll(dir, "laravel app");
  return dir;
}

const DURATION_TASK = "Add src/duration.mjs exporting toMs(text): it converts a duration string such as \"2s\" or \"1h\" to milliseconds using the installed \"ms\" package and throws a TypeError when the text is not a duration. Add your own unit test tests/duration.test.mjs. Do not modify tests/duration.accept.test.mjs.";
const DURATION_CRITERIA = "npm test passes\ntests/duration.accept.test.mjs is unchanged\nonly src/ and tests/ change";
const QA = D("qa"); // S6: the local "environment" the QA script deploys to, outside every project
const MCP_LOG = D("mcp-elicit.jsonl"); // S4: what the MCP server was asked and answered
const MCP_SERVER = path.join(FIXTURES, "mcp-elicit-server.mjs");
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const mcpLog = () => lines(MCP_LOG).map((l) => JSON.parse(l));

const SCENARIOS = {
  N: { make: nodeProject, check: "npm test", accept: "tests/duration.accept.test.mjs", prepared: "node_modules/.package-lock.json",
    task: DURATION_TASK, criteria: DURATION_CRITERIA,
    rehearse: { codex: [plan, verdict("accept"), verdict("complete")], claude: [DURATION] } },
  L: { make: laravelProject, check: "php artisan test", accept: "tests/Feature/HealthAcceptTest.php", prepared: "vendor/autoload.php",
    task: "Add a route GET /health in routes/web.php that returns the JSON {\"status\":\"ok\"} and a feature test tests/Feature/HealthTest.php for it. Do not modify tests/Feature/HealthAcceptTest.php or phpunit.xml.",
    criteria: "php artisan test passes\ntests/Feature/HealthAcceptTest.php and phpunit.xml are unchanged",
    rehearse: { codex: [plan, verdict("accept"), verdict("complete")], claude: [{ report: { summary: "health", done: true }, writes: [["routes/web.php", "<?php\n// health\n"], ["tests/Feature/HealthTest.php", "<?php\n"]] }] } },

  // ---- S3: step by step, the CLIs' own narrower modes ----
  S3: { make: () => nodeProject("s3-app"), check: "npm test", accept: "tests/duration.accept.test.mjs", prepared: "node_modules/.package-lock.json",
    task: DURATION_TASK, criteria: DURATION_CRITERIA, mode: "steps", access: { claude: "acceptEdits", codex: "workspace" },
    rights: "Claude acceptEdits (--permission-mode acceptEdits), Codex workspace (sandbox=workspace-write, approvalPolicy=on-request)",
    // the plan review and every accepted stage stop the run; the person continues each with «Продолжить»
    onPause: (st, sc) => ["plan_review", "stage_done"].includes(st.reason) && (sc.pauses ??= []).length < 4 ? (sc.pauses.push(st.reason), true) : false,
    verify(dir, sc) {
      const claude = sc.sessionFacts.filter((f) => f.provider === "claude"), codex = sc.sessionFacts.filter((f) => f.provider === "codex");
      check(sc.claudeArgv.length > 0 && sc.claudeArgv.every((a) => a === "--permission-mode acceptEdits"), "S3: every Claude session was started with --permission-mode acceptEdits (argv)", sc.claudeArgv);
      check(claude.length > 0 && claude.every((f) => f.detail.permissionMode === "acceptEdits"), "S3: Claude reported permissionMode acceptEdits (system/init) for every session", claude.map((f) => f.detail.permissionMode));
      check(codex.length > 0 && codex.every((f) => f.detail.approvalPolicy === "on-request" && f.detail.sandbox === "workspaceWrite"), "S3: Codex reported approvalPolicy on-request, sandbox workspaceWrite (thread reply) for every thread", codex.map((f) => [f.detail.approvalPolicy, f.detail.sandbox]));
      check(!sc.accessMismatchShown, "S3: no «rights differ» warning in the panel", null);
      check(sc.pauses?.includes("plan_review") && sc.pauses.includes("stage_done"), "S3: the run stopped for the plan and after the accepted stage", sc.pauses);
      if (!REAL) check(mockState("codex-access.jsonl").some((a) => a.approvalPolicy === "on-request" && a.sandbox === "workspace-write"), "S3 (rehearsal): the thread parameters the fake Codex received", mockState("codex-access.jsonl"));
    },
    rehearse: { codex: [plan, verdict("accept"), verdict("complete")], claude: [DURATION] } },

  // ---- S4: an MCP server's form on both CLIs ----
  S4: { make: () => nodeProject("s4-app", { "tests/duration.accept.test.mjs": null,
    ".mcp.json": `${JSON.stringify({ mcpServers: { "release-form": { command: NODE, args: [MCP_SERVER], env: { MCP_ELICIT_LOG: MCP_LOG } } } }, null, 2)}\n`,
    ".claude/settings.json": `${JSON.stringify({ enabledMcpjsonServers: ["release-form"] }, null, 2)}\n`, // project scope only
    ".codex/config.toml": `[mcp_servers.release-form]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(MCP_SERVER)}]\nenv = { MCP_ELICIT_LOG = ${JSON.stringify(MCP_LOG)} }\n`,
    "tests/receipts.accept.test.mjs": "import assert from \"node:assert/strict\";\nimport fs from \"node:fs\";\nimport { test } from \"node:test\";\ntest(\"receipts\", () => {\n  const lines = fs.readFileSync(\"release/receipts.txt\", \"utf8\").split(\"\\n\").filter(Boolean);\n  for (const c of [\"api\", \"web\"]) assert.ok(lines.some((l) => new RegExp(`^RELEASE-FORM nonce=[0-9a-f]{12} component=${c} `).test(l)), c);\n});\n"
  }), check: "npm test", accept: "tests/receipts.accept.test.mjs", prepared: "node_modules/.package-lock.json",
    task: "Release form check with the MCP server release-form (tool release_ticket). Planner: before you write the plan, call release_ticket with component \"plan\" and copy the one line it returns (it starts with RELEASE-FORM) verbatim into the first stage's task. Executor: call release_ticket with component \"api\", then with component \"web\"; a person answers each form, and may decline one. Write release/receipts.txt with the returned lines verbatim, one per line: the planner's line from your task first (if there is one), then api, then web. Never invent or edit a line. Do not modify tests/.",
    criteria: "npm test passes\nrelease/receipts.txt holds the lines release_ticket returned, verbatim\ntests/ is unchanged",
    // What the person does with each form: web is declined, every other one is filled; the first filled one is first
    // tried with values the form does not allow (they must not reach the server).
    async prompt(p, sc) {
      if (p.kind === "tool" && /release_ticket/.test(`${p.tool} ${p.summary}`)) {
        await app.clickEl(q(`[data-request-id="${p.requestId}"] [data-decision="allow_once"]`));
        return { action: "Разрешить один раз", reason: "the assignment's own MCP tool release_ticket" };
      }
      if (p.kind !== "elicitation") return null;
      const fields = p.form?.mode === "form" ? p.form.fields.map((f) => f.name) : [];
      if (p.server !== "release-form" || !fields.includes("ticket")) halt(`S4: a form this assignment cannot answer: ${JSON.stringify({ server: p.server, summary: p.summary, form: p.form?.mode })}`);
      const component = /for (\w+)/.exec(p.summary ?? "")?.[1] ?? "?";
      const form = { component, provider: p.provider, role: p.role, fields };
      (sc.forms ??= []).push(form);
      const sel = (inner) => q(`[data-request-id="${p.requestId}"] ${inner}`);
      await app.shot(`S4-form-${sc.forms.length}-${component}`);
      if (component === "web") {
        await app.clickEl(sel('[data-decision="deny"]'));
        form.answer = "declined";
        return { action: "Отклонить (форма)", reason: "S4: the web form is declined by design" };
      }
      if (!sc.validation) {
        sc.validation = {};
        for (const [what, ticket, reviewers] of [["short ticket", "AB", "2"], ["reviewers over 5", "REL-1", "9"]]) {
          await setValue(sel('[data-form-field="ticket"] input'), ticket);
          await setValue(sel('[data-form-field="env"] select'), "qa");
          await setValue(sel('[data-form-field="reviewers"] input'), reviewers);
          const rejected = () => journal(sc.runId).filter((r) => r.type === "command.completed" && r.data.result?.code === "invalid_form").length;
          const before = rejected();
          await app.clickEl(sel('[data-decision="allow_once"]'));
          await sleep(600);
          // who stopped it: the panel (the browser's own field rules: no command) or main (the command refused)
          sc.validation[what] = !(await app.ev(`!!${q(`[data-request-id="${p.requestId}"]`)}`)) ? "SENT" : rejected() > before ? "refused by main (invalid_form)" : "blocked in the panel";
        }
      }
      await setValue(sel('[data-form-field="ticket"] input'), `REL-${component}`);
      await setValue(sel('[data-form-field="env"] select'), "qa");
      await setValue(sel('[data-form-field="reviewers"] input'), "2");
      await app.clickEl(sel('[data-decision="allow_once"]'));
      form.answer = { ticket: `REL-${component}`, env: "qa", reviewers: 2 };
      return { action: "Отправить форму", reason: `S4: the ${component} form filled as the assignment says` };
    },
    verify(dir, sc) {
      const log = mcpLog(), calls = log.filter((l) => l.type === "call"), inits = log.filter((l) => l.type === "initialize");
      sc.mcp = { initialize: inits.map((l) => ({ client: l.client?.name ?? null, protocolVersion: l.protocolVersion, elicitation: l.elicitation })),
        calls: calls.map((c) => ({ client: c.client?.name ?? null, component: c.component, action: c.action, valid: c.valid, nonce: c.nonce })),
        failed: log.filter((l) => l.type === "call_failed").map((l) => ({ client: l.client?.name ?? null, component: l.component, error: l.error })) };
      const receipts = lines(path.join(dir, "release", "receipts.txt"));
      const nonce = (l) => /nonce=([0-9a-f]{12})/.exec(l)?.[1];
      sc.receipts = receipts.map((l) => ({ nonce: nonce(l), known: calls.some((c) => c.nonce === nonce(l)) }));
      check(!!sc.validation && Object.values(sc.validation).every((x) => x !== "SENT"), "S4: values the form does not allow are not sent", sc.validation);
      check(calls.every((c) => c.valid), "S4: the server received only valid answers (its own check)", calls);
      const api = calls.find((c) => c.component === "api"), web = calls.find((c) => c.component === "web");
      check(api?.action === "accept" && api.content?.ticket === "REL-api" && web?.action === "decline", "S4: the server got the api form as filled and the web form declined", sc.mcp.calls);
      check(receipts.length >= 2 && sc.receipts.every((r) => r.known) && [api, web].every((c) => c && receipts.some((l) => nonce(l) === c.nonce)),
        "S4: used, not only loaded: every receipt in the project carries a nonce the server made for a call", sc.receipts);
      const exec = calls.filter((c) => /claude/i.test(c.client?.name ?? "")), lead = calls.filter((c) => /codex/i.test(c.client?.name ?? ""));
      sc.byCli = { claudeCalls: exec.length, codexCalls: lead.length, codexRelayed: lead.some((c) => receipts.some((l) => nonce(l) === c.nonce)) };
      check(exec.length >= 2, "S4: Claude called the tool and its forms reached the person (server log: client claude)", sc.byCli);
      // Codex: its form is the planner's call; whether the planner's line reached the project is recorded, not required
      if (sc.codexServerLoaded !== false) check(lead.length >= 1 && lead.every((c) => c.action === "accept"), "S4: Codex called the tool and its form reached the person (server log: client codex)", sc.byCli);
      if (!REAL) check(mockState("decisions.jsonl").filter((d) => d.tool === "elicitation").length === calls.length, "S4 (rehearsal): every form the fake CLIs forwarded was answered", mockState("decisions.jsonl"));
    },
    rehearse: {
      codex: [{ ...plan, asks: [{ tool: "mcp", server: "release-form", name: "release_ticket", arguments: { component: "plan" } }] }, verdict("accept"), verdict("complete")],
      claude: [{ report: { summary: "receipts", done: true }, asks: ["api", "web"].map((component) => ({ tool: "mcp", server: "release-form", name: "release_ticket", arguments: { component }, saveTo: "release/receipts.txt" })) }]
    } },

  // ---- S5: Claude leaves plan mode (the project's own default mode) ----
  S5: { make: () => nodeProject("s5-app", { "tests/duration.accept.test.mjs": null,
    ".claude/settings.json": `${JSON.stringify({ permissions: { defaultMode: "plan" } }, null, 2)}\n`,
    "tests/clamp.accept.test.mjs": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { clamp } from \"../src/clamp.mjs\";\ntest(\"clamp\", () => { assert.equal(clamp(7, 1, 5), 5); assert.equal(clamp(-2, 1, 5), 1); assert.throws(() => clamp(1, 5, 1), RangeError); });\n"
  }), check: "npm test", accept: "tests/clamp.accept.test.mjs", prepared: "node_modules/.package-lock.json",
    task: "Add src/clamp.mjs exporting clamp(x, lo, hi): x limited to [lo, hi], a RangeError when lo > hi. Plan first and present your plan for approval (leave plan mode with it) before you change any file. Do not modify tests/clamp.accept.test.mjs.",
    criteria: "npm test passes\ntests/clamp.accept.test.mjs is unchanged",
    feedback: "Also add tests/clamp-feedback.test.mjs that checks clamp(5, 5, 5) === 5. Then present the plan again.",
    async prompt(p, sc) {
      if (p.kind !== "plan") return null;
      (sc.plans ??= []).push({ provider: p.provider, text: anon(p.plan ?? p.summary).slice(0, 2000) });
      const sel = (inner) => q(`[data-request-id="${p.requestId}"] ${inner}`);
      await app.shot(`S5-plan-${sc.plans.length}`);
      if (sc.plans.length === 1) {
        await app.type(`${sel("textarea")}`, SCENARIOS.S5.feedback);
        await app.clickEl(sel('[data-decision="deny"]'));
        return { action: "Вернуть план", reason: "S5: the first plan is sent back once with feedback" };
      }
      await app.clickEl(sel('[data-decision="allow_once"]'));
      return { action: "Одобрить план", reason: "S5: the plan after the feedback is approved" };
    },
    verify(dir, sc) {
      const claude = sc.sessionFacts.filter((f) => f.provider === "claude");
      check(claude[0]?.detail.permissionMode === "plan", "S5: Claude reported permissionMode plan from the project's settings (system/init)", claude.map((f) => f.detail.permissionMode));
      check(sc.claudeArgv.every((a) => a === "(no permission flag)"), "S5: no permission flag passed (rights «Как в моём терминале»)", sc.claudeArgv);
      check((sc.plans?.length ?? 0) >= 2, "S5: ExitPlanMode reached the person (can_use_tool), was sent back once, then approved", sc.plans?.length);
      const fb = path.join(dir, "tests", "clamp-feedback.test.mjs");
      check(fs.existsSync(fb) && fs.readFileSync(fb, "utf8").includes("5, 5, 5"), "S5: the feedback was acted on (tests/clamp-feedback.test.mjs)", null);
      if (!REAL) check(mockState("decisions.jsonl").some((d) => d.tool === "ExitPlanMode" && d.reply?.behavior === "deny" && d.reply.message === SCENARIOS.S5.feedback), "S5 (rehearsal): the fake Claude got the plan back with the feedback text", mockState("decisions.jsonl").filter((d) => d.tool === "ExitPlanMode"));
    },
    rehearse: { codex: [plan, verdict("accept"), verdict("complete")], claude: [{ report: { summary: "clamp", done: true },
      asks: [{ tool: "ExitPlanMode", plan: "1. write src/clamp.mjs\n2. run npm test" }, { tool: "ExitPlanMode", plan: "1. write src/clamp.mjs\n2. add tests/clamp-feedback.test.mjs\n3. run npm test" }],
      writes: [["src/clamp.mjs", "export function clamp(x, lo, hi) { if (lo > hi) throw new RangeError(\"empty\"); return Math.min(hi, Math.max(lo, x)); }\n"],
        ["tests/clamp-feedback.test.mjs", "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { clamp } from \"../src/clamp.mjs\";\ntest(\"same\", () => assert.equal(clamp(5, 5, 5), 5));\n"]] }] } },

  // ---- S6: worktree, commit, push to a local bare repository, a local QA; quit during and after QA ----
  S6: { make() {
    const dir = nodeProject("s6-app");
    const bare = D("s6-remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "origin", "main");
    fs.mkdirSync(QA, { recursive: true });
    SCENARIOS.S6.bare = bare;
    SCENARIOS.S6.mainAtStart = git(dir, "rev-parse", "main").trim();
    return dir;
  }, check: "npm test", accept: "tests/duration.accept.test.mjs", prepared: "node_modules/.package-lock.json",
    task: DURATION_TASK, criteria: DURATION_CRITERIA, workMode: "worktree", finish: ["commit", "push", "qa"], branch: "canvastty-s6",
    // the deploy records itself, then stays busy: the app is quit during that time
    qa: { environment: "qa-local", command: `echo "$CANVASTTY_COMMIT" >> ${QA}/deploys.log && echo "$CANVASTTY_COMMIT" > ${QA}/deployed && sleep 45 && echo done >> ${QA}/deploy-finished.log`,
      verify: `echo x >> ${QA}/verify.log && test -s ${QA}/deployed && cat ${QA}/deployed > "$CANVASTTY_QA_RESULT"` },
    async during(v, sc, runId) {
      if (sc.quitDuringQa || !(v?.active?.kind === "finish" && v.active.step === "qa" && lines(`${QA}/deploys.log`).length >= 1)) return false;
      sc.quitDuringQa = await quitAndRestart("S6-during-qa", runId);
      await app.clickEl(byText(`[data-agent-link-id="${sc.linkId}"] button`, "Открыть запуск"));
      await app.waitFor(`${q(".orch-panel")} && true`, "panel after restart");
      return true;
    },
    // after the restart: the pause of the restart and the one that says the QA outcome is unknown are continued; a
    // «repeat the action» pause is never continued (it would deploy again)
    onPause: (st, sc) => !!sc.quitDuringQa && ["user_request", "app_closed", "finish_unconfirmed"].includes(st.reason) && (sc.resumes = (sc.resumes ?? 0) + 1) <= 4,
    async verify(dir, sc, runId) {
      const v = await view(app, runId);
      const [commit, push, qa] = v?.progress?.finish ?? [];
      sc.finish = v?.progress?.finish ?? null;
      const branchHead = execFileSync("git", ["ls-remote", SCENARIOS.S6.bare, `refs/heads/${SCENARIOS.S6.branch}`], { encoding: "utf8" }).trim().split(/\s+/)[0] ?? null;
      sc.lsRemote = branchHead;
      check(commit?.status === "done" && /^[0-9a-f]{40}$/.test(commit.commit ?? ""), "S6: the commit is confirmed", commit);
      check(execFileSync("git", ["--git-dir", SCENARIOS.S6.bare, "log", "-1", "--format=%B", commit?.commit ?? "HEAD"], { encoding: "utf8" }).includes(`CanvasTTY-Run: ${runId}`), "S6: the pushed commit carries the trailer CanvasTTY-Run", null);
      check(push?.status === "done" && branchHead === commit?.commit, "S6: git ls-remote of the bare repository shows the commit on the branch", { push, branchHead });
      check(qa?.status === "done" && qa.version === "confirmed" && qa.observed === commit?.commit, "S6: QA verified with the expected version", qa);
      sc.qaCounts = { deploys: lines(`${QA}/deploys.log`).length, verifications: lines(`${QA}/verify.log`).length, deployFinished: lines(`${QA}/deploy-finished.log`).length };
      check(sc.qaCounts.deploys === 1, "S6: the deploy ran once, not again after the restart", sc.qaCounts);
      check(git(dir, "rev-parse", "main").trim() === SCENARIOS.S6.mainAtStart && git(dir, "status", "--porcelain").trim() === "", "S6: the project folder's main and working tree are untouched (the work is in the worktree)", null);
      // quit after QA: nothing continues or runs again
      const before = { journal: journal(runId).length, ...sc.qaCounts };
      await quitAndRestart("S6-after-qa", runId);
      const after = { journal: journal(runId).length, deploys: lines(`${QA}/deploys.log`).length, verifications: lines(`${QA}/verify.log`).length };
      sc.afterQaRestart = { before, after, status: lastStatus(runId) };
      check(after.journal === before.journal && after.deploys === before.deploys && after.verifications === before.verifications && lastStatus(runId)?.status === "completed",
        "S6: after quitting when QA was done and restarting, nothing ran (journal, deploy, verification unchanged)", sc.afterQaRestart);
    },
    rehearse: { codex: [plan, verdict("accept"), verdict("complete")], claude: [DURATION] } },

  // ---- S7: what the CLIs report they load, on the person's own project (no run, no model turn) ----
  S7: { probe: true }
};

// ---------- observation ----------
const userData = D("ud");
const runDir = (runId) => path.join(userData, "orchestration", "runs", runId);
const journal = (runId) => fs.readFileSync(path.join(runDir(runId), "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const activity = (runId) => { const f = path.join(userData, "orchestration", "activity", `${runId}.jsonl`); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []; };
const timeline = (runId) => journal(runId).map((r) => `${r.seq}:${r.type}${r.type === "run.status" ? `(${r.data.status}${r.data.reason ? `/${r.data.reason}` : ""})`
  : r.type === "orch.turn" ? `(${r.data.purpose})` : r.type === "turn.finished" ? `(${r.data.outcome})` : r.type === "check.finished" ? `(${r.data.status}${r.data.reason ? `/${r.data.reason}` : ""})`
  : r.type === "turn.intent" ? `(${r.data.provider})` : r.type === "prepare.finished" ? `(${r.data.status})` : r.type === "permission.decided" || r.type === "permission.asked" ? `(${r.data.kind ?? ""})` : ""}`);
const turnsBy = (runId) => { const t = { codex: 0, claude: 0 }; for (const r of journal(runId)) if (r.type === "turn.intent") t[r.data.provider]++; return t; };
const lastStatus = (runId) => journal(runId).filter((r) => r.type === "run.status").at(-1)?.data;
const view = (app, runId) => app.ev(`window.canvasTTY.orchestration.list().then((r) => r.value.find((s) => s.view.runId === ${JSON.stringify(runId)})?.view ?? null)`);
const laptop = (app) => app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const setLimits = (app) => async () => {
  await app.ev(`${q(".orch-dialog .orch-advanced")}.open = true`);
  const inputs = `document.querySelectorAll(".orch-limits input")`;
  const want = [LIMITS.turns, LIMITS.roundsPerStage, LIMITS.replans, LIMITS.runMin];
  for (const [i, v] of want.entries()) await app.type(`${inputs}[${i}]`, String(v));
  const got = await app.ev(`[...${inputs}].map((i) => i.value)`);
  if (got.join() !== want.join()) halt(`limits not set in the dialog: ${got}`);
  const access = await app.ev(`[...document.querySelectorAll("[data-orch-profile] [data-orch-access-summary], [data-orch-access]")].map((e) => e.textContent.trim()).join(" | ")`).catch(() => "");
  if (access) log(`goal dialog rights: ${access.slice(0, 300)}`);
};

// What a prompt is allowed to be answered with by this assignment: a read or test command, or a file change, inside
// the temporary project. Returns the reason, or null (the series stops).
const SAFE_CMD = /^(?:npm (?:test|run test|ls)|node --test(?: [\w./*-]+)*|node [\w./-]+\.m?js|php artisan (?:test|route:list)(?: [\w=:/.-]+)*|(?:php )?vendor\/bin\/(?:phpunit|pest)(?: [\w=:/.-]+)*|composer (?:dump-autoload|validate)|git (?:status|diff|log|show)(?: [\w=:/.-]+)*|ls(?: -[a-zA-Z]+)*(?: [\w./-]+)*|cat [\w./-]+|head(?: -n ?\d+)? [\w./-]+|tail(?: -n ?\d+)? [\w./-]+|wc(?: -l)? [\w./-]+|pwd)$/;
function allowedByAssignment(p, projectDir) {
  if (!["command", "file_change", "tool"].includes(p.kind)) return null;
  const inside = (f) => { const abs = path.resolve(projectDir, f); return abs === projectDir || abs.startsWith(`${projectDir}/`); };
  let detail = {};
  try { detail = JSON.parse(p.detail ?? "{}"); } catch {}
  if (p.kind === "file_change" || ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(p.tool)) {
    const files = [detail.file_path, detail.path, detail.notebook_path, ...(Array.isArray(detail.paths) ? detail.paths : []), ...(Array.isArray(detail.changes) ? detail.changes.map((c) => c?.path) : [])].filter((x) => typeof x === "string");
    if (files.length && files.every(inside)) return `file change inside the project: ${files.map((f) => path.relative(projectDir, path.resolve(projectDir, f))).join(", ")}`;
    return null;
  }
  const cmdRaw = typeof detail.command === "string" ? detail.command : Array.isArray(detail.command) ? detail.command.join(" ") : p.summary;
  const cwd = typeof detail.cwd === "string" ? detail.cwd : projectDir;
  if (!inside(cwd)) return null;
  let cmd = String(cmdRaw ?? "").trim().replace(/^(?:\/bin\/(?:ba|z)?sh -l?c )(['"])([\s\S]*)\1$/, "$2");
  cmd = cmd.replace(new RegExp(`^cd ${projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} && `), "").replace(/ 2>&1$/, "").trim();
  if (p.tool === "Read" || p.tool === "Grep" || p.tool === "Glob") return inside(detail.file_path ?? detail.path ?? projectDir) ? `read inside the project (${p.tool})` : null;
  return SAFE_CMD.test(cmd) ? `test/read command inside the project: ${cmd}` : null;
}

const setValue = (selector, value) => app.ev(`(() => { const el = ${selector}; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); })()`);
// The application's own process tree: CLI sessions started for a run (never another program of the person).
function descendants(root) {
  const rows = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,args="], { encoding: "utf8" }).split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], args: m[3] }));
  const out = [], seen = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!seen.has(r.pid) && seen.has(r.ppid)) { seen.add(r.pid); out.push(r); grew = true; } }
  return out;
}
const claudeSessions = () => descendants(app.child.pid).filter((p) => p.args.includes("--permission-prompt-tool stdio") && p.args.includes("--json-schema"));
// Run sessions only: the application's limits widget keeps its own `codex app-server --listen stdio://` (LimitsService,
// no model turn), also in a rehearsal; it is counted apart.
const cliProcesses = () => descendants(app.child.pid).filter((p) => /(?:^|\/)(?:claude|codex)(?:\s|$)|mock-(?:claude|codex)|app-server|--permission-prompt-tool/.test(p.args) && !p.args.includes("--listen stdio://"));
const limitsProcesses = () => descendants(app.child.pid).filter((p) => p.args.includes("app-server --listen stdio://")).length;
const permissionFlag = (args) => /--permission-mode (\S+)/.exec(args) ? `--permission-mode ${/--permission-mode (\S+)/.exec(args)[1]}` : args.includes("--dangerously-skip-permissions") ? "--dangerously-skip-permissions" : "(no permission flag)";

let usedTurns = 0;
async function linkAgents(dir) {
  await createAgent(app, "Агент Codex (лид)", dir);
  await createAgent(app, "Агент Claude (исполнитель)", dir);
  const c = await canvasState(app);
  const lead = c.agents.filter((a) => a.provider === "codex").at(-1);
  const exec = c.agents.filter((a) => a.provider === "claude").at(-1);
  // both ends hit-tested: the press on the lead's own port, the drop on the executor's body (the drop zone)
  await app.ev(`(() => { window.__ev = []; for (const t of ["pointerdown","pointermove","pointerup","pointercancel","gotpointercapture","lostpointercapture","mousemove","mouseup"]) document.addEventListener(t, (e) => { const l = window.__ev; if (t.endsWith("move") && l.length && l[l.length-1][0] === t) { l[l.length-1][5]++; return; } l.push([t, String(e.target?.className ?? "").slice(0,60), e.clientX|0, e.clientY|0, e.buttons, 1, e.pointerId ?? null, e.isTrusted]); }, true); return true; })()`);
  const p1 = await app.pointOn(card(lead.agentId, ".agent-card__port")), p2 = await app.pointOn(card(exec.agentId, ".agent-card__body"));
  const hit = (p) => app.ev(`document.elementsFromPoint(${p.x}, ${p.y}).slice(0,4).map((e) => String(e.className).slice(0,50))`);
  console.error("DIAG points", JSON.stringify({ p1, p2, h1: await hit(p1), h2: await hit(p2) }));
  await app.drag(p1, p2, 20);
  await sleep(3000);
  console.error("DIAG events", JSON.stringify(await app.ev("window.__ev")));
  console.error("DIAG links", JSON.stringify((await canvasState(app)).links.length), "errors", JSON.stringify(await app.ev(`[...document.querySelectorAll(".dialog-error,[role=alert],.agent-card__error,.agent-card__message")].map((e) => e.textContent.trim().slice(0,200))`)));
  console.error("DIAG focus", JSON.stringify(await app.ev("({ hasFocus: document.hasFocus(), vis: document.visibilityState, w: innerWidth, h: innerHeight })")));
  await app.shot("diag-after-drag");
  process.exit(3);
  return (await canvasState(app)).links.at(-1);
}

// «Проверить окружение» in the open settings (Advanced): what each CLI reported, as the panel shows it.
async function probeEnvironment(tag) {
  await app.ev(`${q("[data-orch-advanced]")}.open = true`);
  await app.clickEl(byText("[data-orch-env-check] button", "Проверить окружение"));
  await app.waitFor(`["done", "error"].includes(${q("[data-orch-env-check]")}?.dataset.orchEnvCheck)`, "environment report", 120_000);
  const r = await app.ev(`(() => { const el = ${q("[data-orch-env-check]")}; return { state: el.dataset.orchEnvCheck, error: el.querySelector(":scope > .dialog-error")?.textContent ?? null,
    providers: [...el.querySelectorAll("[data-env-provider]")].map((p) => ({ provider: p.dataset.envProvider, error: p.querySelector(".dialog-error")?.textContent ?? null,
      items: [...p.querySelectorAll("[data-env-item]")].map((i) => ({ id: i.dataset.envItem, confirmed: i.dataset.confirmed === "yes", text: i.textContent.trim().slice(0, 1500) })) })) }; })()`);
  await app.ev(`${q("[data-orch-env-check]")}.scrollIntoView({ block: "center" })`);
  await sleep(200);
  await app.shot(tag);
  return JSON.parse(anon(JSON.stringify(r)));
}

// The project settings of a scenario, set in the settings dialog opened from the goal dialog, and saved.
async function projectSettings(name, s, sc) {
  await app.clickEl(q("[data-orch-open-settings]"));
  await app.waitFor(`${q("[data-orch-settings]")} && true`, "settings");
  if (s.access) {
    await app.waitFor(`document.querySelectorAll('[data-orch-access="claude"] option').length > 1`, "the CLI's own modes", 30_000);
    for (const [cli, mode] of Object.entries(s.access)) {
      const offered = await app.ev(`[...document.querySelectorAll('[data-orch-access="${cli}"] option')].map((o) => o.value)`);
      if (!offered.includes(mode)) halt(`${name}: ${cli} does not offer ${mode} (${offered})`);
      await setValue(q(`[data-orch-access="${cli}"] select`), mode);
    }
    sc.accessMapping = await app.ev(`[...document.querySelectorAll("[data-orch-access] code")].map((c) => c.textContent)`);
  }
  if (s.workMode === "worktree") await app.clickEl(`document.querySelectorAll("[data-orch-settings-workmode] input")[1]`);
  if (s.finish) {
    await app.ev(`${q("[data-orch-advanced]")}.open = true`);
    await setValue(q("[data-orch-settings-remote]"), "origin");
    await app.waitFor(`${q("[data-orch-settings-branch]")} && true`, "branch field");
    await setValue(q("[data-orch-settings-branch]"), s.branch);
    await setValue(q("[data-orch-settings-qa-env]"), s.qa.environment);
    await setValue(q("[data-orch-settings-qa-command]"), s.qa.command);
    await setValue(q("[data-orch-settings-qa-verify]"), s.qa.verify);
    await app.clickEl(q("[data-orch-settings-qa-reports] input"));
  }
  if (name === "S4") {
    // gate before any model turn: does each CLI itself report the test server for this project?
    sc.environment = await probeEnvironment("S4-00-probe");
    const has = (prov) => !!sc.environment.providers.find((p) => p.provider === prov)?.items.find((i) => i.id === "mcp")?.text.includes("release-form");
    sc.claudeServerLoaded = has("claude");
    sc.codexServerLoaded = has("codex");
    log(`S4 gate: release-form reported by Claude ${sc.claudeServerLoaded}, by Codex ${sc.codexServerLoaded}`);
    if (REAL && !sc.claudeServerLoaded) halt("S4 gate: Claude does not report release-form for the project; nothing started");
    // the fake CLIs report fixed lists; their tool calls read .mcp.json
    if (!REAL) { sc.gateNote = "rehearsal: the fake CLIs' probe lists are fixed, the gate is not meaningful"; sc.codexServerLoaded = true; }
  }
  await app.shot(`${name}-00-settings`);
  await app.clickEl(q(".orch-settings button[type=submit]"));
  await app.waitFor(`${q("[data-orch-profile]")}?.dataset.orchProfile === "saved"`, "settings saved", 10_000);
}

// Continues a paused run as the person does, unless the only way on repeats an action after success.
async function resume(name, runId, why) {
  await app.waitFor(`${q("[data-orch-resume]")} && true`, `${name}: «Продолжить»`, 20_000);
  const next = await app.ev(`${q("[data-orch-resume]")}.dataset.orchResume`);
  if (next === "finish_retry") halt(`${name}: the way on would repeat an action after success (${why}); not done`);
  const count = journal(runId).length;
  await app.shot(`${name}-pause-${why}`);
  await app.clickEl(q("[data-orch-resume]"));
  report.interventions.push({ scenario: name, at: new Date().toISOString(), action: "Продолжить", reason: `paused(${why})`, next });
  log(`${name}: «Продолжить» after paused(${why}), next=${next}`);
  const end = Date.now() + 30_000;
  while (Date.now() < end && (journal(runId).length === count || lastStatus(runId)?.status === "paused" && lastStatus(runId)?.reason === why)) await sleep(250);
}

// SIGTERM to the main process (as Quit), then the application again on the same userData.
async function quitAndRestart(tag, runId) {
  await app.shot(`${tag}-before-quit`);
  const clis = cliProcesses();
  const quitAt = Date.now();
  app.child.kill("SIGTERM");
  const exit = await Promise.race([app.exited, sleep(60_000).then(() => null)]);
  if (!exit) halt(`${tag}: the app did not exit within 60 s`);
  const out = { exit, ms: Date.now() - quitAt, cliAtQuit: clis.length, statusAfterQuit: lastStatus(runId),
    finishRecords: journal(runId).filter((r) => r.type.startsWith("finish.")).map((r) => `${r.type}(${r.data.step ?? r.data.status}${r.data.established ? ",established" : ""})`) };
  const len = journal(runId).length;
  app = await launchApp({ userData, port: PORT, shots: SHOTS, providers: providersFile });
  await laptop(app);
  await app.waitFor(`document.querySelectorAll("[data-agent-id]").length >= 2`, "cards after restart", 30_000);
  const t = Date.now();
  while (Date.now() - t < 20_000) await sleep(1000);
  out.grewWithoutPerson = journal(runId).length - len;
  out.cliAfterRestart = cliProcesses().map((p) => anon(p.args).slice(0, 200));
  out.limitsWidgetProcesses = limitsProcesses();
  check(out.grewWithoutPerson === 0 && out.cliAfterRestart.length === 0, `${tag}: after the restart nothing continued by itself (20 s: journal, CLI processes)`, out);
  log(`${tag}: quit ${JSON.stringify(out.exit)} in ${out.ms} ms; status ${JSON.stringify(out.statusAfterQuit)}; ${out.finishRecords.join(" ")}`);
  return out;
}

async function runScenario(name) {
  const s = SCENARIOS[name];
  if (s.probe) return runProbe(name);
  const sc = report.scenarios[name] = { task: s.task, criteria: s.criteria, limits: LIMITS, rights: s.rights ?? "terminal (Как в моём терминале)", mode: s.mode ?? "autopilot",
    ...(s.workMode ? { workMode: s.workMode } : {}), ...(s.finish ? { finish: s.finish } : {}) };
  if (usedTurns + LIMITS.turns > SERIES_TURNS) halt("series turn budget would be exceeded");
  usedTurns += LIMITS.turns;
  log(`${name}: preparing the project`);
  const dir = s.make();
  sc.project = anon(dir);
  sc.projectAtStart = { files: git(dir, "ls-files").split("\n").filter(Boolean).length, vendor: fs.existsSync(path.join(dir, "vendor")), node_modules: fs.existsSync(path.join(dir, "node_modules")), env: fs.existsSync(path.join(dir, ".env")) };
  const acceptBlob = git(dir, "rev-parse", `HEAD:${s.accept}`).trim();
  const xmlBlob = name === "L" ? git(dir, "rev-parse", "HEAD:phpunit.xml").trim() : null;
  const argvSeen = mockState("claude-argv.jsonl").length;

  const link = await linkAgents(dir);
  sc.linkId = link.linkId;
  await startGoal(app, link.linkId, { task: s.task, criteria: s.criteria, workMode: s.workMode, onDialog: async () => {
    if (s.access || s.finish || s.workMode || name === "S4") await projectSettings(name, s, sc);
    if (name === "S4" && sc.codexServerLoaded === false) {
      // Codex does not have the server here: the planner's call is left out (the person's step, see the plan)
      sc.task = s.task.replace(/Planner: [^.]*\. /, "");
      await app.type(`document.querySelectorAll(".orch-dialog textarea")[0]`, sc.task);
    }
    if (s.mode === "steps") await app.clickEl(q('[data-orch-runmode] input[value="steps"]'));
    await setLimits(app)();
    if (s.workMode) await app.clickEl(q(`[data-orch-workmode] input[value="${s.workMode}"]`));
    for (const f of s.finish ?? []) if (!(await app.ev(`${q(`[data-finish-option="${f}"] input`)}.checked`))) await app.clickEl(q(`[data-finish-option="${f}"] input`));
    sc.finishChosen = await app.ev(`[...document.querySelectorAll("[data-finish-option] input")].map((i) => i.checked)`);
    sc.goalRights = await app.ev(`${q("[data-orch-rights]")}?.textContent ?? null`);
    const cmds = await app.ev(`${q("[data-orch-commands]")}.value`);
    sc.checkCommands = cmds;
    if (cmds.trim() !== s.check) halt(`${name}: suggested check is ${JSON.stringify(cmds)}, expected ${s.check}`);
    await app.waitFor(`["ready", "confirm", "blocked", "error"].includes(${q("[data-orch-readiness]")}?.dataset.orchReadiness)`, "readiness", 30_000);
    sc.readiness = await app.ev(`[...document.querySelectorAll("[data-ready-id]")].map((e) => ({ id: e.dataset.readyId, level: e.dataset.readyLevel, text: e.textContent.trim().slice(0, 300) }))`);
    await app.shot(`${name}-01-goal-ready`);
  } });
  const runId = (await canvasState(app)).links.find((l) => l.linkId === link.linkId).runIds.at(-1);
  sc.runId = runId;
  log(`${name}: run ${runId.slice(0, 8)} started`);
  const start = Date.now();
  let shotPrep = false;
  let workDir = dir;
  const answered = new Set();
  const argvByPid = new Map();
  for (;;) {
    if (Date.now() - start > SCENARIO_MS) { sc.stop = "scenario time limit (20 min)"; await app.clickEl(byText(".orch-panel button", "Стоп")).catch(() => {}); halt(`${name}: 20 min limit`); }
    if (Date.now() - t0 > SERIES_MS) { sc.stop = `series time limit (${SERIES_MS / 60_000} min)`; await app.clickEl(byText(".orch-panel button", "Стоп")).catch(() => {}); halt(`series ${SERIES_MS / 60_000} min limit`); }
    const v = await view(app, runId);
    if (v?.workDir) workDir = v.workDir;
    for (const p of claudeSessions()) if (!argvByPid.has(p.pid)) argvByPid.set(p.pid, permissionFlag(p.args));
    if (!sc.accessMismatchShown) sc.accessMismatchShown = await app.ev(`!!${q("[data-orch-access-mismatch]")}`).catch(() => false);
    if (!shotPrep && v?.active?.kind === "prepare") { shotPrep = true; await app.shot(`${name}-02-preparing`); }
    if (v?.permission && !answered.has(v.permission.requestId)) {
      const p = v.permission;
      const shown = { kind: p.kind, provider: p.provider, role: p.role, tool: p.tool, summary: anon(p.summary).slice(0, 400), detail: anon(p.detail).slice(0, 1500), options: p.options, alwaysAsk: p.alwaysAsk ?? null };
      await app.shot(`${name}-prompt-${answered.size + 1}`);
      answered.add(p.requestId);
      const own = await s.prompt?.(p, sc);
      if (own) { report.interventions.push({ scenario: name, at: new Date().toISOString(), ...own, prompt: shown }); log(`${name}: ${own.action} — ${own.reason}`); continue; }
      const why = REAL ? allowedByAssignment(p, workDir) : `rehearsal: ${p.kind}`;
      if (!why) { sc.stoppedAtPrompt = shown; halt(`${name}: a prompt this assignment cannot answer: ${JSON.stringify(shown).slice(0, 600)}`); }
      await app.clickEl(q(`[data-request-id="${p.requestId}"] [data-decision="allow_once"]`));
      report.interventions.push({ scenario: name, at: new Date().toISOString(), action: "Разрешить один раз", reason: why, prompt: shown });
      log(`${name}: prompt answered allow_once — ${why}`);
      continue;
    }
    if (await s.during?.(v, sc, runId)) continue;
    const st = lastStatus(runId);
    if (st?.status === "paused" && s.onPause?.(st, sc)) { await resume(name, runId, st.reason); continue; }
    if (st && !["running", "created", "preparing", "pausing", "stopping"].includes(st.status)) { sc.final = st; break; }
    await sleep(1000);
  }
  sc.durationMs = Date.now() - start;
  sc.timeline = timeline(runId);
  sc.turns = turnsBy(runId);
  sc.claudeArgv = REAL ? [...argvByPid.values()] : mockState("claude-argv.jsonl").slice(argvSeen).map((a) => permissionFlag(a.join(" ")));
  sc.claudeArgvSource = REAL ? "process list of the app's children, sampled every second" : "argv the fake Claude recorded";
  const v = await view(app, runId);
  sc.progress = v?.progress ?? null;
  sc.workDir = anon(workDir);
  const act = activity(runId);
  sc.sessionFacts = act.filter((a) => a.kind === "session" && a.detail?.reported).map((a) => ({ role: a.role, provider: a.provider, text: anon(a.text).slice(0, 300), detail: JSON.parse(anon(JSON.stringify(a.detail ?? {}))) }));
  sc.usage = act.filter((a) => a.kind === "usage").map((a) => ({ role: a.role, text: a.text, detail: a.detail ?? null }));
  sc.warnings = act.filter((a) => /warn|mismatch|differ/i.test(`${a.kind} ${a.text}`)).map((a) => ({ role: a.role, kind: a.kind, text: anon(a.text).slice(0, 300) }));
  await app.shot(`${name}-03-final`);
  try { await app.ev(`${q("[data-orch-env-session]")}?.scrollIntoView({ block: "center" })`); await sleep(300); await app.shot(`${name}-04-session-facts`); } catch {}
  try { await app.ev(`${q("[data-orch-finish]")}?.scrollIntoView({ block: "center" })`); await sleep(300); await app.shot(`${name}-05-result`); } catch {}
  if (sc.final.status !== "completed") { check(false, `${name}: run completed`, sc.final); halt(`${name} ended ${JSON.stringify(sc.final)}`); }
  check(true, `${name}: run completed`, null);
  // the result, checked independently in the person's shell (rehearsal: the fake programs, the real node --test)
  const changed = git(workDir, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3));
  sc.changedFiles = changed;
  check(git(dir, "rev-parse", `HEAD:${s.accept}`).trim() === acceptBlob && !changed.includes(s.accept), `${name}: ${s.accept} unchanged`, changed);
  if (xmlBlob) check(!changed.includes("phpunit.xml"), `${name}: phpunit.xml unchanged`, changed);
  check(fs.existsSync(path.join(workDir, s.prepared)), `${name}: prepared by the run (${s.prepared})`, null);
  if (name === "L") check(/^APP_KEY=base64:/m.test(fs.readFileSync(path.join(dir, ".env"), "utf8")), "L: .env with an application key prepared", null);
  try {
    const out = REAL ? sh(`${s.check} 2>&1`, workDir) : execFileSync("/bin/sh", ["-c", `${s.check} 2>&1`], { cwd: workDir, env: rehearsalEnv, encoding: "utf8" });
    sc.independentCheck = { exit: 0, tail: anon(out.slice(-600)) };
  } catch (e) { sc.independentCheck = { exit: e.status, tail: anon(String(e.stdout ?? "").slice(-600)) }; }
  check(sc.independentCheck.exit === 0, `${name}: ${s.check} passes in the person's shell after the run`, sc.independentCheck);
  const orchTurns = sc.turns.codex + sc.turns.claude;
  check(orchTurns <= LIMITS.turns, `${name}: orchestrator turns within ${LIMITS.turns} (${orchTurns})`, sc.turns);
  await s.verify?.(workDir, sc, runId);
  if (report.failures.length) halt(`${name} criteria`);
  await app.clickEl(q(".orch-panel__close")).catch(() => {});
}

// S7: the lists the CLIs report for the person's project, beside the terminal's own (names only); nothing is saved and
// the project is only read. The person compares with /mcp and /skills in their terminal and records the result.
async function runProbe(name) {
  const sc = report.scenarios[name] = { mode: "no run: «Проверить окружение» only", turns: { codex: 0, claude: 0 } };
  const dir = PERSON_PROJECT;
  sc.project = REAL ? "<the person's project>" : anon(dir);
  const isGit = fs.existsSync(path.join(dir, ".git"));
  const status = () => (isGit ? execFileSync("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }) : null);
  const before = status();
  const link = await linkAgents(dir);
  await app.clickEl(byText(`[data-agent-link-id="${link.linkId}"] button`, "Новая цель"));
  await app.waitFor(`${q("[data-orch-profile]")} && ${q("[data-orch-profile]")}.dataset.orchProfile !== "loading"`, "project settings", 30_000);
  await app.clickEl(q("[data-orch-open-settings]"));
  await app.waitFor(`${q("[data-orch-settings]")} && true`, "settings");
  sc.environment = await probeEnvironment("S7-environment");
  await app.clickEl(byText(".orch-settings button", "Отмена"));
  await app.clickEl(byText(".orch-dialog button", "Отмена")).catch(() => {});
  const namesOf = (text) => [...String(text ?? "").matchAll(/([\w.@-]+) \(([\w-]+)\)/g)].map((m) => m[1]);
  const mcp = (prov) => namesOf(sc.environment.providers.find((p) => p.provider === prov)?.items.find((i) => i.id === "mcp")?.text);
  sc.app = { claudeMcp: mcp("claude"), codexMcp: mcp("codex") };
  if (REAL) {
    // the terminal's own lists (no model): names only, never commands, arguments or environment
    const first = (cmd, pick) => { try { return [...new Set(sh(`${cmd} 2>&1`, dir).split("\n").map(pick).filter(Boolean))]; } catch (e) { return `failed: ${anon(String(e.stdout ?? e)).slice(0, 200)}`; } };
    sc.terminal = { claudeMcp: first("claude mcp list", (l) => /^([\w.@-]+): .+ - /.exec(l.trim())?.[1]),
      codexMcp: first("codex mcp list", (l) => { const n = /^([\w.@-]+)\s/.exec(l.trim())?.[1]; return n && n !== "Name" ? n : null; }) };
    for (const k of ["claudeMcp", "codexMcp"]) if (Array.isArray(sc.terminal[k])) sc[`${k}Differs`] = { onlyInApp: sc.app[k].filter((x) => !sc.terminal[k].includes(x)), onlyInTerminal: sc.terminal[k].filter((x) => !sc.app[k].includes(x)) };
  } else sc.terminal = "rehearsal: not asked (fake CLIs)";
  sc.personCheck = "PENDING: compare with /mcp and /skills (claude) and /mcp (codex) in a terminal in the same folder; record equal / differs (what)";
  check(sc.environment.state === "done" && sc.environment.providers.length === 2, `${name}: both CLIs answered «Проверить окружение»`, sc.environment);
  check(status() === before, `${name}: the project is unchanged by the probe (git status)`, isGit ? null : "not a git repository");
  check((await canvasState(app)).links.at(-1).runIds.length === 0, `${name}: no run was started`, null);
}

let app;
try {
  if (!REAL) writeRehearsal();
  app = await launchApp({ userData, port: PORT, shots: SHOTS, providers: providersFile });
  await laptop(app);
  report.notes.executable = "development build (electron-vite out/), not the installed application";
  for (const name of ORDER) await runScenario(name);
  report.ok = report.failures.length === 0;
} catch (error) {
  report.ok = false;
  report.halted = error instanceof Halt ? error.message : String(error?.stack ?? error);
  log(`HALT: ${report.halted}`);
  await app?.shot("halt").catch(() => {});
  for (const s of Object.values(report.scenarios)) if (s.runId && !s.timeline) try { s.timeline = timeline(s.runId); s.turns = turnsBy(s.runId); } catch {}
} finally {
  report.finishedAt = new Date().toISOString();
  report.interventionCount = report.interventions.length;
  report.turnsTotal = Object.values(report.scenarios).reduce((n, s) => n + (s.turns?.codex ?? 0) + (s.turns?.claude ?? 0), 0);
  await app?.quit().catch(() => {});
  try { execFileSync("pkill", ["-f", `remote-debugging-port=${PORT}`], { stdio: "ignore" }); } catch {}
  fs.writeFileSync(path.join(OUT, "report.json"), `${anon(JSON.stringify(report, null, 2))}\n`);
  fs.writeFileSync(path.join(OUT, "series.log"), `${anon(logLines.join("\n"))}\n`);
  if (fs.existsSync(MCP_LOG)) fs.writeFileSync(path.join(OUT, "mcp-elicit.jsonl"), anon(fs.readFileSync(MCP_LOG, "utf8")));
  process.stdout.write(`${JSON.stringify({ ok: report.ok, halted: report.halted ?? null, failures: report.failures, turnsTotal: report.turnsTotal, interventions: report.interventionCount, out: OUT, tmp: TMP })}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
