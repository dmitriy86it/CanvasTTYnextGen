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
// S3–S7: a Bash prompt the rule does not recognise is left pending in the panel and handed to the coordinator (the
// operator of the series): the full request goes to <out>/pending/<requestId>.json with a mechanical pre-check of task
// files written by heredoc (answer-rule.mjs heredocWrites); the coordinator reads the whole command and writes
// <out>/decisions/<requestId>.json ({ requestId, decision: "allow_once" | "stop", reason }). allow_once is clicked as
// «Разрешить один раз» in the panel and recorded as a planned intervention; anything else stops. The wait counts
// against the scenario's and the series' time. The rehearsal goes through the same path.
// Evidence, on success and on a halt: the active run is stopped with «Стоп», the app's own CLI processes are waited for,
// the app is quit; then each scenario's final journal, activity, project state (the folder and, S6, the worktree) and
// requested/reported rights go to <out>/<scenario>/ (series-evidence.mjs). The temporary projects and userData are kept.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURES, NODE, byText, canvasState, card, createAgent, launch as launchApp, q, sleep, startGoal, workspace } from "./orchestration-app-kit.mjs";
import { linkAgents as linkAgentsWith } from "./link-agents.mjs";
import { allowedByAssignment, heredocWrites } from "./answer-rule.mjs";
import { awaitDecision } from "./coordinator-decision.mjs";
import { projectState, rightsState, saveScenarioEvidence } from "./series-evidence.mjs";
import { isExecutorPlanPrompt, s5Verdict, splitChanges } from "./s5-criteria.mjs";
import { s4Verdict } from "./s4-criteria.mjs";
import { S4_SERVER, s4Gate } from "./s4-gate.mjs";
import { mcpNames, safeReport } from "./safe-environment.mjs";
import { s7Verdict } from "./s7-criteria.mjs";

const REAL = process.argv.includes("--real");
const REHEARSE = process.argv.includes("--rehearse");
if (REAL === REHEARSE) throw new Error("exactly one of --real or --rehearse");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const ORDER = (arg("--only") ?? "N,L").split(",").map((x) => x.trim()).filter(Boolean);
const S_SERIES = ORDER.some((n) => n.startsWith("S"));
if (S_SERIES && ORDER.some((n) => !/^(?:S[3-7]|S4C|S4X)$/.test(n))) throw new Error("--only: S3..S7 (S4 as S4C, S4X) are not mixed with N/L");
if (new Set(ORDER).size !== ORDER.length) throw new Error("--only: a scenario is run once");
const SUPPORTED = { codex: ["codex-cli 0.155.1"], claude: ["2.1.281 (Claude Code)", "2.1.282 (Claude Code)", "2.1.283 (Claude Code)"] };
const LIMITS = { turns: 8, roundsPerStage: 2, replans: 1, runMin: 20 };
const SCENARIO_MS = 20 * 60_000;
// How long a prompt waits for the coordinator (never beyond the scenario's or the series' time); no decision in time
// stops the series as coordinator_timeout. --coordinator-wait <s> shortens it, in a rehearsal only.
const COORD_WAIT_MS = (REHEARSE && arg("--coordinator-wait") ? Number(arg("--coordinator-wait")) : 120) * 1000;
// S3–S7: the scenarios chosen with --only, each run at most 8 turns and 20 minutes (S7 has no turn): S3,S5,S6 → 24
// turns and 60 minutes; all five → 32 and 100 (S7 counted as the time of a scenario). N and L: 16 turns, 50 minutes.
const RUNS = S_SERIES ? ORDER.filter((n) => n !== "S7").length : 0;
const SERIES_MS = (S_SERIES ? 20 * (RUNS + (ORDER.includes("S7") ? 1 : 0)) : 50) * 60_000;
const SERIES_TURNS = S_SERIES ? 8 * RUNS : 16;
const PERSON_PROJECT = arg("--project") ? fs.realpathSync(path.resolve(arg("--project"))) : null;
if (REAL && ORDER.includes("S7") && !PERSON_PROJECT) throw new Error("S7 needs --project <the person's usual project>");

const { TMP, D, git } = workspace(REAL ? "cto-real-auto-" : "cto-real-auto-rh-");
// the person's global CLI files must not change in a series (Codex writes trust for an untrusted cwd by itself)
const GLOBAL_FILES = [".codex/config.toml", ".claude/settings.json"].map((f) => path.join(os.homedir(), f));
const globalHashes = () => Object.fromEntries(GLOBAL_FILES.map((f) => [f, fs.existsSync(f) ? createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null]));
const globalBefore = globalHashes();
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
// the compound command Claude asked in the earlier real S3 (scripts/answer-rule.mjs allows it)
const S3_COMPOUND = "npm test 2>&1 | tail -12; shasum -a 256 tests/duration.accept.test.mjs; git status --short";
// the heredoc write Claude asked in the real S3, attempt 3: not the rule's, it goes to the coordinator
const S3_HEREDOC = "cat > src/duration.mjs <<'EOF'\nimport ms from \"ms\";\nexport function toMs(t) { const v = ms(t); if (typeof v !== \"number\") throw new TypeError(\"bad\"); return v; }\nEOF\ncat > tests/duration.test.mjs <<'EOF'\nimport { test } from \"node:test\";\ntest(\"ok\", () => {});\nEOF\nnpm test 2>&1 | tail -12; git status --short";
const S3_HEREDOC_2 = "cat > tests/duration.test.mjs <<'EOF'\nimport assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { toMs } from \"../src/duration.mjs\";\ntest(\"2s\", () => assert.equal(toMs(\"2s\"), 2000));\nEOF\nnode --test tests/duration.test.mjs 2>&1 | tail -5";
const DURATION = { report: { summary: "toMs", done: true }, writes: [["src/duration.mjs", "import ms from \"ms\";\nexport function toMs(t) { const v = ms(t); if (typeof v !== \"number\") throw new TypeError(\"bad\"); return v; }\n"], ["tests/duration.test.mjs", "import { test } from \"node:test\";\ntest(\"ok\", () => {});\n"]] };

// ---------- the projects ----------
const commitAll = (dir, msg) => { for (const a of [["add", "-A"], ["-c", "user.name=series", "-c", "user.email=series@localhost", "commit", "-q", "-m", msg]]) git(dir, ...a); };
// extra: {rel: text} files added before the first commit (null: the file is left out)
function nodeProject(name = "node-app", extra = {}) {
  // S4: --s4-dir <root> puts s4c-app / s4x-app in a folder the person trusted for Codex (its project config loads only there)
  const dir = arg("--s4-dir") && /^s4[cx]-app$/.test(name) ? path.join(fs.realpathSync(path.resolve(arg("--s4-dir"))), name) : D(name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) halt(`${dir} is not empty`);
  // the Codex lead in an untrusted folder would write the trust into the person's config by itself: S4 runs only in
  // folders the person has trusted already (exact path, as Codex matches it)
  if (REAL && /^s4[cx]-app$/.test(name) && !fs.readFileSync(path.join(os.homedir(), ".codex/config.toml"), "utf8").replace(/[ \t]+/g, "").includes(`[projects.${JSON.stringify(dir)}]\ntrust_level="trusted"`))
    halt(`blocked: ${dir} is not a trusted project in ~/.codex/config.toml`);
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
const mcpLogFile = (name) => D(`mcp-elicit-${name}.jsonl`); // S4: what the server of that variant was asked and answered
const MCP_SERVER = path.join(FIXTURES, "mcp-elicit-server.mjs");
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const mcpLog = (name) => lines(mcpLogFile(name)).map((l) => JSON.parse(l));

// S4 variants: the test server release-form reaches only the provider under test (S4C: .mcp.json + the project's
// .claude/settings.json; S4X: the project's .codex/config.toml), the other agent gets an ordinary task. Only that
// provider's forms and tool prompts of release-form/release_ticket are answered; anything else stops the variant. The
// verdict is s4-criteria.mjs over the server's own log, the forms shown, the tool results and the receipts, tied by
// the call's nonce (it is in the form's message).
const S4_TOOL = new Set(["release_ticket", "mcp__release-form__release_ticket"]);
function s4Variant(name, v) {
  const MCP_LOG = mcpLogFile(name);
  const server = { command: NODE, args: [MCP_SERVER], env: { MCP_ELICIT_LOG: MCP_LOG } };
  const files = v.provider === "claude"
    ? { ".mcp.json": `${JSON.stringify({ mcpServers: { "release-form": server } }, null, 2)}\n`, ".claude/settings.json": `${JSON.stringify({ enabledMcpjsonServers: ["release-form"] }, null, 2)}\n` }
    : { ".codex/config.toml": `[mcp_servers.release-form]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(MCP_SERVER)}]\nenv = { MCP_ELICIT_LOG = ${JSON.stringify(MCP_LOG)} }\n`,
      // the fake Codex of the rehearsal reads .mcp.json (mock-common mcpToolCall); the real run has none
      ...(REHEARSE ? { ".mcp.json": `${JSON.stringify({ mcpServers: { "release-form": server } }, null, 2)}\n` } : {}) };
  const accept = `tests/receipts.accept.test.mjs`;
  const who = v.provider === "claude"
    ? `Claude executor only: call the MCP tool release_ticket of the server release-form with component "${v.accept}", then with component "${v.decline}". A person answers each form and may decline one. Write release/receipts.txt with each line the tool returned, verbatim, one per line, in call order. Never invent or edit a line. The Codex lead plans and reviews as usual and does not call release_ticket.`
    : `Codex lead only: before you write the plan, call the MCP tool release_ticket of the server release-form with component "${v.accept}", then with component "${v.decline}". A person answers each form and may decline one. Copy both lines the tool returned verbatim into the first stage's task and tell the executor to write them to release/receipts.txt, one per line, in call order, unchanged. The Claude executor does not call release_ticket.`;
  return {
    s4: v, make: () => nodeProject(`${name.toLowerCase()}-app`, { "tests/duration.accept.test.mjs": null, ...files,
      [accept]: `import assert from "node:assert/strict";\nimport fs from "node:fs";\nimport { test } from "node:test";\ntest("receipts", () => {\n  const lines = fs.readFileSync("release/receipts.txt", "utf8").split("\\n").filter(Boolean);\n  for (const c of ${JSON.stringify([v.accept, v.decline])}) assert.ok(lines.some((l) => new RegExp(\`^RELEASE-FORM nonce=[0-9a-f]{12} component=\${c} \`).test(l)), c);\n});\n` }),
    check: "npm test", accept, prepared: "node_modules/.package-lock.json",
    task: `Release form check with the local MCP test server release-form (tool release_ticket). ${who} Do not modify tests/.`,
    criteria: "npm test passes\nrelease/receipts.txt holds the lines release_ticket returned, verbatim\ntests/ is unchanged",
    async prompt(p, sc) {
      const toolName = String(p.tool ?? "");
      if (p.kind === "tool" && (S4_TOOL.has(toolName) || /release_ticket/.test(`${toolName} ${p.summary}`))) {
        const ok = p.provider === v.provider && S4_TOOL.has(toolName) && (p.server === undefined || p.server === "release-form");
        (sc.toolPrompts ??= []).push({ requestId: p.requestId, provider: p.provider, role: p.role, tool: toolName, server: p.server ?? (toolName.startsWith("mcp__release-form__") ? "release-form" : null), allowed: ok });
        if (!ok) halt(`${name}: a tool prompt outside this variant: ${JSON.stringify({ provider: p.provider, tool: toolName, server: p.server })}`);
        await app.clickEl(q(`[data-request-id="${p.requestId}"] [data-decision="allow_once"]`));
        return { action: "Разрешить один раз", reason: `${name}: the test tool release-form/release_ticket` };
      }
      if (p.kind !== "elicitation") return null;
      const m = /for ([\w-]+) \(call ([0-9a-f]{12})\)/.exec(p.summary ?? "");
      const fields = p.form?.mode === "form" ? p.form.fields.map((f) => f.name) : [];
      const form = { requestId: p.requestId, provider: p.provider, role: p.role, server: p.server ?? null, message: p.summary ?? null, component: m?.[1] ?? null, nonce: m?.[2] ?? null, answer: null, content: null, invalidAttempts: [] };
      (sc.forms ??= []).push(form);
      if (p.server !== "release-form" || p.provider !== v.provider || p.role !== v.role || !m || !fields.includes("ticket") || ![v.accept, v.decline].includes(m[1]))
        halt(`${name}: a form this variant cannot answer: ${JSON.stringify({ server: p.server, provider: p.provider, role: p.role, summary: p.summary, form: p.form?.mode })}`);
      const sel = (inner) => q(`[data-request-id="${p.requestId}"] ${inner}`);
      await app.shot(`${name}-form-${sc.forms.length}-${m[1]}`);
      if (m[1] === v.decline) {
        await app.clickEl(sel('[data-decision="deny"]'));
        form.answer = "decline";
        return { action: "Отклонить (форма)", reason: `${name}: the ${m[1]} form is declined by design` };
      }
      for (const [what, ticket, reviewers] of [["short ticket", "AB", "2"], ["reviewers over 5", "REL-1", "9"]]) {
        await setValue(sel('[data-form-field="ticket"] input'), ticket);
        await setValue(sel('[data-form-field="env"] select'), "qa");
        await setValue(sel('[data-form-field="reviewers"] input'), reviewers);
        const rejected = () => journal(sc.runId).filter((r) => r.type === "command.completed" && r.data.result?.code === "invalid_form").length;
        const before = rejected();
        await app.clickEl(sel('[data-decision="allow_once"]'));
        await sleep(600);
        const outcome = !(await app.ev(`!!${q(`[data-request-id="${p.requestId}"]`)}`)) ? "SENT" : rejected() > before ? "refused by main (invalid_form)" : "blocked in the panel";
        form.invalidAttempts.push({ what, outcome });
        if (outcome === "SENT") halt(`${name}: an invalid form value was sent (${what})`);
      }
      const content = { ticket: `REL-${m[1]}`, env: "qa", reviewers: 2 };
      await setValue(sel('[data-form-field="ticket"] input'), content.ticket);
      await setValue(sel('[data-form-field="env"] select'), content.env);
      await setValue(sel('[data-form-field="reviewers"] input'), String(content.reviewers));
      // what the panel sends: the filled fields and the defaults the form keeps (urgent), read from the form itself
      const urgent = await app.ev(`(() => { const i = ${sel('[data-form-field="urgent"] input')}; return i ? i.checked : null; })()`);
      if (urgent !== null) content.urgent = urgent;
      await app.clickEl(sel('[data-decision="allow_once"]'));
      Object.assign(form, { answer: "accept", content });
      return { action: "Отправить форму", reason: `${name}: the ${m[1]} form filled as the assignment says` };
    },
    verify(dir, sc) {
      const act = activity(sc.runId);
      const facts = { variant: name, provider: v.provider, role: v.role, server: mcpLog(name), forms: sc.forms ?? [], toolPrompts: sc.toolPrompts ?? [],
        // the activity names the tool as the CLI does (Claude: mcp__release-form__release_ticket, Codex:
        // release-form.release_ticket with status); only the test server's tool is normalised to release_ticket
        toolResults: act.filter((a) => a.kind === "tool_finished" && /release_ticket/.test(`${a.text} ${JSON.stringify(a.detail ?? {})}`)).map((a) => {
          const raw = String(a.detail?.tool ?? a.text ?? "");
          return { provider: a.provider, role: a.role, tool: /^(?:mcp__release-form__|release-form\.)release_ticket$/.test(raw) ? "release_ticket" : raw, rawTool: raw,
            ok: a.detail?.ok === true || a.detail?.status === "completed", text: a.detail?.result ?? null };
        }),
        receipts: lines(path.join(dir, "release", "receipts.txt")),
        acceptUnchanged: git(dir, "rev-parse", `HEAD:${accept}`).trim() === evidence[name].acceptBlob && !statusOf(dir).includes(accept),
        checksPassed: sc.independentCheck?.exit === 0 };
      sc.criteriaFacts = JSON.parse(anon(JSON.stringify(facts)));
      for (const r of s4Verdict(facts)) check(r.ok, `${name}: ${r.what}`, r.got);
    },
    rehearse: v.provider === "claude"
      ? { codex: [plan, verdict("accept"), verdict("complete")], claude: [{ report: { summary: "receipts", done: true }, asks: [v.accept, v.decline].map((component) => ({ tool: "mcp", server: "release-form", name: "release_ticket", arguments: { component }, saveTo: "release/receipts.txt" })) }] }
      : { codex: [{ ...plan, asks: [v.accept, v.decline].map((component) => ({ tool: "mcp", server: "release-form", name: "release_ticket", arguments: { component }, saveTo: "release/receipts.txt" })) }, verdict("accept"), verdict("complete")], claude: [{ report: { summary: "receipts", done: true } }] }
  };
}

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
      if (!REAL) check(report.interventions.some((x) => x.scenario === "S3" && x.action === "Разрешить один раз" && x.reason === `test/read command inside the project: ${S3_COMPOUND}`),
        "S3 (rehearsal): the compound read/test command was answered «Разрешить один раз» by the rule", report.interventions.filter((x) => x.scenario === "S3"));
      if (!REAL) check(mockState("codex-access.jsonl").some((a) => a.approvalPolicy === "on-request" && a.sandbox === "workspace-write"), "S3 (rehearsal): the thread parameters the fake Codex received", mockState("codex-access.jsonl"));
    },
    rehearse: { codex: [plan, verdict("accept"), verdict("complete")], claude: [{ ...DURATION, asks: [{ tool: "Bash", command: S3_HEREDOC }, { tool: "Bash", command: S3_HEREDOC_2 }, { tool: "Bash", command: S3_COMPOUND }] }] } },

  // ---- S4: an MCP server's form, one provider per variant (S4C: Claude's executor, S4X: Codex's lead) ----
  S4C: s4Variant("S4C", { provider: "claude", role: "executor", accept: "api", decline: "web" }),
  S4X: s4Variant("S4X", { provider: "codex", role: "lead", accept: "plan-a", decline: "plan-b" }),

  // ---- S5: Claude leaves plan mode (the project's own default mode) ----
  // Only Claude's own ExitPlanMode requests of this run count (s5-criteria.mjs); the implementation and tests of the
  // project are checked unchanged before each answer. A lead's question about approving the plan is answered once, by
  // the coordinator's decision, with the fixed text LEAD_ANSWER; any other question stops.
  S5: { make: () => nodeProject("s5-app", { "tests/duration.accept.test.mjs": null,
    ".claude/settings.json": `${JSON.stringify({ permissions: { defaultMode: "plan" } }, null, 2)}\n`,
    "tests/clamp.accept.test.mjs": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { clamp } from \"../src/clamp.mjs\";\ntest(\"clamp\", () => { assert.equal(clamp(7, 1, 5), 5); assert.equal(clamp(-2, 1, 5), 1); assert.throws(() => clamp(1, 5, 1), RangeError); });\n"
  }), check: "npm test", accept: "tests/clamp.accept.test.mjs", prepared: "node_modules/.package-lock.json",
    task: "Implement src/clamp.mjs exporting clamp(x, lo, hi): return x limited to [lo, hi], and throw RangeError when lo > hi. Preserve tests/clamp.accept.test.mjs byte-for-byte.\n\n"
      + "Role-specific workflow:\n"
      + "- Codex lead: produce the normal orchestration plan and delegate implementation to Claude. The implementation objective is already authorized. Do not request a separate approval of your orchestration plan merely because Claude must obtain approval to leave its own plan mode. Include the following Claude-specific requirement in the delegated stage task.\n"
      + "- Claude executor only: this project's Claude settings start you in plan mode. Inspect the relevant files, prepare your implementation plan, and request approval through the native ExitPlanMode tool before editing implementation or test files. If the plan is returned with feedback, revise it and request approval again. After approval, implement the task and run npm test.\n"
      + "- Codex lead: review the resulting changes and actual check results through the normal workflow.\n\n"
      + "The approval being tested is Claude's native plan-mode approval, not a free-text question from the lead.",
    criteria: "npm test passes\ntests/clamp.accept.test.mjs is unchanged",
    feedback: "Also add tests/clamp-feedback.test.mjs that checks clamp(5, 5, 5) === 5. Then present the plan again.",
    async prompt(p, sc) {
      if (p.kind !== "plan") return null;
      const entry = { requestId: p.requestId, kind: p.kind, tool: p.tool ?? null, provider: p.provider, role: p.role, text: anon(p.plan ?? p.summary), at: new Date().toISOString(),
        shownInPanel: await app.ev(`!!${q(`[data-request-id="${p.requestId}"]`)}`), changesBefore: splitChanges(statusOf(evidence.S5.workDir)), answer: null, feedback: null };
      (sc.plans ??= []).push(entry);
      if (!isExecutorPlanPrompt(p)) halt(`S5: a plan request not from Claude's executor: ${JSON.stringify({ provider: p.provider, role: p.role, tool: p.tool })}`);
      const counted = sc.plans.filter((x) => isExecutorPlanPrompt(x));
      const sel = (inner) => q(`[data-request-id="${p.requestId}"] ${inner}`);
      await app.shot(`S5-plan-${counted.length}`);
      if (counted.length === 1) {
        await app.type(`${sel("textarea")}`, SCENARIOS.S5.feedback);
        await app.clickEl(sel('[data-decision="deny"]'));
        Object.assign(entry, { answer: "deny", feedback: SCENARIOS.S5.feedback });
        return { action: "Вернуть план", reason: "S5: the first ExitPlanMode is sent back once with feedback", requestId: p.requestId };
      }
      if (counted.length > 2) halt("S5: a third ExitPlanMode request");
      await app.clickEl(sel('[data-decision="allow_once"]'));
      entry.answer = "allow_once";
      return { action: "Одобрить план", reason: "S5: the plan after the feedback is approved", requestId: p.requestId };
    },
    async onQuestion(v, sc, runId, start) {
      if (sc.leadAnswered) return false;
      // the question as the journal records it; its text from the run's own text store
      const asked = journal(runId).filter((r) => r.type === "question.asked").at(-1);
      if (!asked) halt("S5: paused for an answer without a recorded question");
      const questionId = asked.data.questionId;
      const textFile = path.join(runDir(runId), "texts", asked.data.text.sha256);
      const text = fs.existsSync(textFile) ? fs.readFileSync(textFile, "utf8") : null;
      const intent = journal(runId).find((r) => r.type === "turn.intent" && r.data.turnId === asked.data.turnId);
      if (!(await app.ev(`!!${q("[data-orch-question] textarea")}`))) halt("S5: the lead's question is not shown in the panel");
      const request = { requestId: questionId, scenario: "S5", runId, kind: "question", provider: intent?.data.provider ?? null, command: text,
        answer: SCENARIOS.S5.leadAnswer, projectDir: evidence.S5.workDir, precheck: null, askedAt: new Date().toISOString() };
      log(`S5: COORDINATOR decision needed for ${questionId} (lead question): ${path.join(OUT, "pending", `${questionId}.json`)}`);
      const own = Date.now() + COORD_WAIT_MS, deadline = Math.min(own, start + SCENARIO_MS, t0 + SERIES_MS);
      const d = await awaitDecision({ request, pendingDir: path.join(OUT, "pending"), decisionsDir: path.join(OUT, "decisions"), decided, deadline,
        stillPending: async () => lastStatus(runId)?.reason === "awaiting_answer" && journal(runId).filter((r) => r.type === "question.asked").at(-1)?.data.questionId === questionId });
      if (d.decision === "timeout") d.decision = deadline === own ? "coordinator_timeout" : "time_limit";
      const entry = { scenario: "S5", requestId: questionId, kind: "question", decision: d.decision, reason: d.reason ?? null, askedAt: request.askedAt,
        detectedAt: d.record?.detectedAt ?? null, writtenAt: d.record?.writtenAt ?? null, waitedMs: d.waitedMs, appliedAt: null, question: text };
      (report.coordinator ??= []).push(entry);
      log(`S5: coordinator ${d.decision} for ${questionId} after ${Math.round((d.waitedMs ?? 0) / 1000)} s${d.reason ? ` — ${d.reason}` : ""}`);
      if (d.decision !== "allow_once") { sc.stoppedAtQuestion = entry; if (d.decision === "coordinator_timeout") sc.stop = "coordinator_timeout"; halt(`S5: lead question, coordinator ${d.decision}${d.reason ? `: ${d.reason}` : ""}`); }
      await app.type(q("[data-orch-question] textarea"), SCENARIOS.S5.leadAnswer);
      await app.clickEl(q("[data-orch-question] button"));
      const until = Date.now() + 15_000;
      while (Date.now() < until && lastStatus(runId)?.reason === "awaiting_answer") await sleep(250);
      if (lastStatus(runId)?.reason === "awaiting_answer") halt(`S5: the answer to ${questionId} was not applied`);
      sc.leadAnswered = true;
      entry.appliedAt = new Date().toISOString();
      report.interventions.push({ scenario: "S5", at: entry.appliedAt, action: "Ответить лиду", by: "coordinator", reason: d.reason, answer: SCENARIOS.S5.leadAnswer, timing: entry });
      log(`S5: applied ${questionId} answer to the lead — ${d.reason}`);
      return true;
    },
    leadAnswer: "Да, выполнение этой задачи согласовано. Передайте её Claude с требованием нативного согласования его плана через ExitPlanMode. Это согласование не заменяет запрос Claude.",
    verify(dir, sc) {
      const fb = path.join(dir, "tests", "clamp-feedback.test.mjs");
      const facts = { sessions: sc.sessionFacts.filter((f) => f.provider === "claude").map((f) => ({ provider: f.provider, permissionMode: f.detail.permissionMode })),
        claudeArgv: sc.claudeArgv, plans: sc.plans ?? [], feedbackText: SCENARIOS.S5.feedback, finalChecksPassed: sc.independentCheck?.exit === 0,
        acceptUnchanged: git(dir, "rev-parse", `HEAD:${SCENARIOS.S5.accept}`).trim() === evidence.S5.acceptBlob && !statusOf(dir).includes(SCENARIOS.S5.accept),
        feedbackFile: fs.existsSync(fb) ? fs.readFileSync(fb, "utf8") : null };
      sc.criteriaFacts = { ...facts, plans: facts.plans.map((x) => ({ ...x, text: x.text.slice(0, 4000) })) };
      for (const r of s5Verdict(facts)) check(r.ok, `S5: ${r.what}`, r.got);
      try { execFileSync(process.execPath, ["--test", "tests/clamp-feedback.test.mjs"], { cwd: dir, encoding: "utf8", stdio: "pipe" }); sc.feedbackTestRun = "passed"; }
      catch (e) { sc.feedbackTestRun = `failed: ${anon(String(e.stdout ?? e)).slice(-400)}`; }
      check(sc.feedbackTestRun === "passed", "S5: tests/clamp-feedback.test.mjs runs and passes on its own", sc.feedbackTestRun);
      if (!REAL) check(mockState("decisions.jsonl").some((d) => d.tool === "ExitPlanMode" && d.reply?.behavior === "deny" && d.reply.message === SCENARIOS.S5.feedback), "S5 (rehearsal): the fake Claude got the plan back with the feedback text", mockState("decisions.jsonl").filter((d) => d.tool === "ExitPlanMode"));
    },
    // the rehearsal's lead asks the plan-approval question once (as the real lead did in attempt 5)
    rehearse: { codex: [{ report: { stages: plan.report.stages, question: "Approve this one-stage plan? No files have been changed." } }, plan, verdict("accept"), verdict("complete")], claude: [{ report: { summary: "clamp", done: true },
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
// What each turn cost as the CLI reported it. A turn with its result (usage, or an error result with total_cost_usd)
// is "complete"; a Claude turn cut off before its result keeps what its own events carried — the token usage of its
// assistant messages in Claude's transcript, within the turn's time — marked "incomplete"; nothing at all: "unknown",
// never $0.
function turnCosts(runId) {
  const recs = journal(runId), act = activity(runId);
  return recs.filter((r) => r.type === "turn.intent").map((r, i, intents) => {
    const { turnId, provider, role } = r.data;
    const fin = recs.find((x) => x.type === "turn.finished" && x.data.turnId === turnId);
    const base = { turnId, provider, role, outcome: fin?.data.outcome ?? null };
    const results = act.filter((a) => a.turnId === turnId && (a.kind === "usage" || a.kind === "error" && a.detail && "costUsd" in a.detail));
    if (results.length) return { ...base, cost: "complete", costUsd: results.map((a) => a.detail?.costUsd).find((c) => typeof c === "number") ?? null, usage: results.map((a) => a.detail ?? null) };
    const tokens = provider === "claude" ? transcriptUsage(fin?.data.sessionId ?? r.data.sessionId, r.ts, fin?.ts ?? intents[i + 1]?.ts) : null;
    return tokens ? { ...base, cost: "incomplete", costUsd: null, tokens, source: "assistant message usage in Claude's transcript" } : { ...base, cost: "unknown", costUsd: null };
  });
}
function transcriptUsage(sessionId, from, to) {
  if (!REAL || !sessionId) return null;
  const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  const file = dirs.map((d) => path.join(root, d, `${sessionId}.jsonl`)).find((f) => fs.existsSync(f));
  if (!file) return null;
  const byId = new Map(); // a message streamed in parts repeats its usage: the last one per id
  for (const l of lines(file)) {
    try { const e = JSON.parse(l); if (e.message?.role === "assistant" && e.message.usage && e.message.id && e.timestamp >= from && (!to || e.timestamp <= to)) byId.set(e.message.id, e.message.usage); } catch {}
  }
  if (!byId.size) return null;
  const sum = (k) => [...byId.values()].reduce((n, u) => n + (typeof u[k] === "number" ? u[k] : 0), 0);
  return { messages: byId.size, ...Object.fromEntries(["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].map((k) => [k, sum(k)])) };
}
// the project's state without touching its index (no optional locks)
const statusOf = (dir) => execFileSync("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
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
// --diag-link: a journal of each link gesture, <out>/link-diag-<n>-<project>.json (scripts/link-agents.mjs).
const DIAG_LINK = process.argv.includes("--diag-link");
let linkGestures = 0;
const linkAgents = (dir) => linkAgentsWith({ app, dir, createAgent, canvasState, card, anon, log,
  diagFile: DIAG_LINK ? path.join(OUT, `link-diag-${String(++linkGestures).padStart(2, "0")}-${path.basename(dir).replace(/[^\w.-]/g, "_")}.json`) : null });

// «Проверить окружение» in the open settings (Advanced): what each CLI reported, as the panel shows it.
async function probeEnvironment(tag) {
  await app.ev(`${q("[data-orch-advanced]")}.open = true`);
  await app.clickEl(byText("[data-orch-env-check] button", "Проверить окружение"));
  await app.waitFor(`["done", "error"].includes(${q("[data-orch-env-check]")}?.dataset.orchEnvCheck)`, "environment report", 150_000); // probe.ts PROBE_MS: at worst 130 s
  // structured attributes only (safe-environment.mjs): never the shown text, notes or errors; a whole list with no
  // [data-mcp-server] is the confirmed empty list (servers: [])
  const r = await app.ev(`(() => { const el = ${q("[data-orch-env-check]")}; return { state: el.dataset.orchEnvCheck,
    providers: [...el.querySelectorAll("[data-env-provider]")].map((p) => ({ provider: p.dataset.envProvider, ok: !p.querySelector(".dialog-error"),
      limitMs: Number(p.dataset.envLimit) || null, timing: [...p.querySelectorAll("[data-timing-method]")].map((x) => ({ method: x.dataset.timingMethod,
        page: Number(x.dataset.timingPage) || null, startMs: Number(x.dataset.timingStart), durationMs: Number(x.dataset.timingDuration),
        allottedMs: Number(x.dataset.timingAllotted), leftMs: Number(x.dataset.timingLeft), outcome: x.dataset.timingOutcome })),
      items: [...p.querySelectorAll("[data-env-item]")].map((i) => ({ id: i.dataset.envItem, confirmed: i.dataset.confirmed === "yes",
        ...(i.dataset.envComplete ? { complete: i.dataset.envComplete === "yes" } : {}), ...(i.dataset.envIncomplete ? { incomplete: i.dataset.envIncomplete } : {}),
        ...(i.dataset.envComplete === "yes" || i.querySelector("[data-mcp-server]") ? { servers: [...i.querySelectorAll("[data-mcp-server]")].map((m) => ({ name: m.dataset.mcpServer,
          connection: m.dataset.mcpConnection || null, auth: m.dataset.mcpAuth || null, tools: m.dataset.mcpTools ? m.dataset.mcpTools.split(",") : [] })) } : {}) })) })) }; })()`);
  await app.ev(`${q("[data-orch-env-check]")}.scrollIntoView({ block: "center" })`);
  await sleep(200);
  await app.shot(tag);
  return { state: r.state, ...safeReport(r) };
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
  if (s.s4) {
    // gate before any model turn (s4-gate.mjs): the application's own probe of this scenario's folder — the CLI's
    // executable, environment and project as the application runs them — asked for release-form's readiness, and a
    // fresh initialize from that CLI in the server's log. The interface's text is only shown, never parsed.
    sc.environment = await probeEnvironment(`${name}-00-probe`);
    const since = Date.now();
    const probed = await app.ev(`window.canvasTTY.orchestration.probe(${JSON.stringify(sc.linkId)}, { mcpReady: ${JSON.stringify(S4_SERVER)} })`);
    const client = REAL ? { claude: "claude-code", codex: "codex-mcp-client" }[s.s4.provider] : `mock-${s.s4.provider}`;
    sc.gate = { probe: probed.ok ? safeReport(probed.value) : { refused: probed.code ?? "refused" }, client,
      ...s4Gate({ provider: s.s4.provider, report: probed.ok ? probed.value : null, logText: lines(mcpLogFile(name)).join("\n"), since, client }) };
    if (!probed.ok) sc.gate.reasons.unshift(`probe refused: ${probed.code ?? "refused"}`);
    log(`${name} gate: ${sc.gate.ok ? "ready" : `not ready: ${sc.gate.reasons.join("; ")}`}`);
    if (!sc.gate.ok) { sc.stop = "blocked"; halt(`${name} blocked before any model turn: ${sc.gate.reasons.join("; ")}`); }
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

// A Bash prompt the rule does not answer: pending in the panel until the coordinator's decision (see the header).
const decided = new Set();
async function coordinatorDecides(name, s, p, runId, workDir, start) {
  let detail = {};
  try { detail = JSON.parse(p.detail ?? "{}"); } catch {}
  const command = typeof detail.command === "string" ? detail.command : p.summary;
  const cwd = typeof detail.cwd === "string" ? detail.cwd : workDir;
  const precheck = heredocWrites(command, workDir, { cwd, protectedFiles: [s.accept] });
  const request = { requestId: p.requestId, scenario: name, runId, provider: p.provider, role: p.role, tool: p.tool, projectDir: workDir, cwd,
    protectedFiles: [s.accept], writableDirs: ["src", "tests"], command, detail: p.detail, precheck, askedAt: new Date().toISOString() };
  log(`${name}: COORDINATOR decision needed for ${p.requestId} (precheck ${precheck.ok ? "ok" : `problems: ${precheck.problems.join("; ")}`}): ${path.join(OUT, "pending", `${p.requestId}.json`)}`);
  const own = Date.now() + COORD_WAIT_MS, deadline = Math.min(own, start + SCENARIO_MS, t0 + SERIES_MS);
  const d = await awaitDecision({ request, pendingDir: path.join(OUT, "pending"), decisionsDir: path.join(OUT, "decisions"), decided,
    stillPending: async () => (await view(app, runId))?.permission?.requestId === p.requestId, deadline });
  // the coordinator's own limit, or the scenario's / series' time that was shorter
  if (d.decision === "timeout") d.decision = deadline === own ? "coordinator_timeout" : "time_limit";
  log(`${name}: coordinator ${d.decision} for ${p.requestId} after ${Math.round((d.waitedMs ?? 0) / 1000)} s${d.reason ? ` — ${d.reason}` : ""}`);
  const entry = { scenario: name, requestId: p.requestId, decision: d.decision, reason: d.reason ?? null, askedAt: request.askedAt,
    detectedAt: d.record?.detectedAt ?? null, writtenAt: d.record?.writtenAt ?? null, waitedMs: d.waitedMs, appliedAt: null, precheckOk: precheck.ok };
  (report.coordinator ??= []).push(entry);
  return { ...d, entry, precheck: { ok: precheck.ok, writes: precheck.writes, mkdirs: precheck.mkdirs, rest: precheck.rest, problems: precheck.problems } };
}

// The evidence of each scenario, taken after the work has stopped (see the header).
const evidence = {};
async function stopActiveRuns() {
  const out = { stopped: [], cliBefore: [], cliLeft: [] };
  if (!app) return out;
  for (const [name, own] of Object.entries(evidence)) {
    const st = own.runId ? (() => { try { return lastStatus(own.runId); } catch { return null; } })() : null;
    if (!st || !["running", "created", "preparing", "pausing", "stopping"].includes(st.status)) continue;
    try {
      if (!(await app.ev(`!!${q(".orch-panel")}`))) await app.clickEl(byText(`[data-agent-link-id="${report.scenarios[name]?.linkId}"] button`, "Открыть запуск"));
      await app.clickEl(byText(".orch-panel button", "Стоп"));
      const end = Date.now() + 60_000;
      while (Date.now() < end && ["running", "created", "preparing", "pausing", "stopping"].includes(lastStatus(own.runId)?.status)) await sleep(500);
      out.stopped.push({ scenario: name, from: st, to: lastStatus(own.runId) });
    } catch (e) { out.stopped.push({ scenario: name, from: st, error: String(e?.message ?? e).slice(0, 300) }); }
  }
  const end = Date.now() + 30_000;
  while (Date.now() < end && cliProcesses().length) await sleep(500);
  out.cliLeft = cliProcesses().map((p) => ({ pid: p.pid, args: anon(p.args).slice(0, 200) }));
  return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function saveEvidence() {
  for (const [name, own] of Object.entries(evidence)) {
    const sc = report.scenarios[name];
    const projects = [{ label: "folder", state: projectState(own.dir, { accept: own.accept, acceptBlob: own.acceptBlob }) }];
    if (own.workDir !== own.dir) projects.push({ label: "worktree", state: projectState(own.workDir, { accept: own.accept, acceptBlob: own.acceptBlob }) });
    const act = own.runId ? activity(own.runId) : [];
    const rights = rightsState({ requested: { claude: own.access?.claude ?? "terminal (Как в моём терминале)", codex: own.access?.codex ?? "terminal (Как в моём терминале)" }, mapping: sc?.accessMapping,
      claudeArgv: REAL ? [...own.argvByPid.values()] : mockState("claude-argv.jsonl").slice(own.argvSeen).map((a) => permissionFlag(a.join(" "))), activity: act });
    if (sc && own.runId) sc.timelineFinal = timeline(own.runId);
    if (sc) { sc.rights = rights; sc.projectState = projects.map((x) => ({ label: x.label, dir: anon(x.state.dir), status: x.state.status, newFiles: x.state.newFiles, accept: x.state.accept })); }
    sc && (sc.evidence = saveScenarioEvidence(OUT, name, { journalFile: own.runId ? path.join(runDir(own.runId), "journal.jsonl") : null,
      activityFile: own.runId ? path.join(userData, "orchestration", "activity", `${own.runId}.jsonl`) : null, projects, rights, anon }));
    // the run's stored texts: the goal, every task sent to a CLI (the delegated stage task), plans, reports, questions
    if (own.runId && fs.existsSync(path.join(runDir(own.runId), "texts"))) for (const f of fs.readdirSync(path.join(runDir(own.runId), "texts"))) {
      fs.mkdirSync(path.join(OUT, name, "texts"), { recursive: true });
      fs.writeFileSync(path.join(OUT, name, "texts", f), anon(fs.readFileSync(path.join(runDir(own.runId), "texts", f), "utf8")));
    }
  }
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
  const own = evidence[name] = { dir, accept: s.accept, acceptBlob, workDir: dir, runId: null, access: s.access ?? null, argvByPid: new Map(), argvSeen };

  const link = await linkAgents(dir);
  sc.linkId = link.linkId;
  await startGoal(app, link.linkId, { task: s.task, criteria: s.criteria, workMode: s.workMode, onDialog: async () => {
    if (s.access || s.finish || s.workMode || s.s4) await projectSettings(name, s, sc);
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
  own.runId = runId;
  log(`${name}: run ${runId.slice(0, 8)} started`);
  const start = Date.now();
  let shotPrep = false;
  let workDir = dir;
  const answered = new Set();
  const argvByPid = own.argvByPid;
  for (;;) {
    if (Date.now() - start > SCENARIO_MS) { sc.stop = "scenario time limit (20 min)"; await app.clickEl(byText(".orch-panel button", "Стоп")).catch(() => {}); halt(`${name}: 20 min limit`); }
    if (Date.now() - t0 > SERIES_MS) { sc.stop = `series time limit (${SERIES_MS / 60_000} min)`; await app.clickEl(byText(".orch-panel button", "Стоп")).catch(() => {}); halt(`series ${SERIES_MS / 60_000} min limit`); }
    const v = await view(app, runId);
    if (v?.workDir) own.workDir = workDir = v.workDir;
    for (const p of claudeSessions()) if (!argvByPid.has(p.pid)) argvByPid.set(p.pid, permissionFlag(p.args));
    if (!sc.accessMismatchShown) sc.accessMismatchShown = await app.ev(`!!${q("[data-orch-access-mismatch]")}`).catch(() => false);
    if (!shotPrep && v?.active?.kind === "prepare") { shotPrep = true; await app.shot(`${name}-02-preparing`); }
    if (v?.permission && !answered.has(v.permission.requestId)) {
      const p = v.permission;
      const shown = { kind: p.kind, provider: p.provider, role: p.role, tool: p.tool, summary: anon(p.summary).slice(0, 400), detail: anon(p.detail).slice(0, 1500), options: p.options, alwaysAsk: p.alwaysAsk ?? null };
      await app.shot(`${name}-prompt-${answered.size + 1}`);
      answered.add(p.requestId);
      const scripted = await s.prompt?.(p, sc);
      if (scripted) { report.interventions.push({ scenario: name, at: new Date().toISOString(), ...scripted, prompt: shown }); log(`${name}: ${scripted.action} — ${scripted.reason}`); continue; }
      // the same rule in the rehearsal and the real run: nothing is allowed because the CLI is a fake
      const why = allowedByAssignment(p, workDir);
      if (!why && S_SERIES && p.kind === "tool" && p.tool === "Bash") {
        const d = await coordinatorDecides(name, s, p, runId, workDir, start);
        if (d.decision !== "allow_once") {
          sc.stoppedAtPrompt = { ...shown, coordinator: d.entry };
          if (d.decision === "coordinator_timeout") sc.stop = "coordinator_timeout";
          halt(`${name}: ${d.decision === "coordinator_timeout" ? `coordinator_timeout: no decision within ${COORD_WAIT_MS / 1000} s` : `coordinator ${d.decision}`}${d.reason ? `: ${d.reason}` : ""}`);
        }
        await app.clickEl(q(`[data-request-id="${p.requestId}"] [data-decision="allow_once"]`));
        // applied: the panel no longer waits on this request (10 s)
        const until = Date.now() + 10_000;
        while (Date.now() < until && (await view(app, runId))?.permission?.requestId === p.requestId) await sleep(200);
        if ((await view(app, runId))?.permission?.requestId === p.requestId) { sc.stoppedAtPrompt = { ...shown, coordinator: d.entry }; halt(`${name}: the coordinator's allow_once for ${p.requestId} was not applied in the panel`); }
        d.entry.appliedAt = new Date().toISOString();
        report.interventions.push({ scenario: name, at: d.entry.appliedAt, action: "Разрешить один раз", by: "coordinator", reason: d.reason, precheck: d.precheck, timing: d.entry, prompt: shown });
        log(`${name}: applied ${p.requestId} allow_once by the coordinator — ${d.reason}`);
        continue;
      }
      if (!why) { sc.stoppedAtPrompt = shown; halt(`${name}: a prompt this assignment cannot answer: ${JSON.stringify(shown).slice(0, 600)}`); }
      await app.clickEl(q(`[data-request-id="${p.requestId}"] [data-decision="allow_once"]`));
      report.interventions.push({ scenario: name, at: new Date().toISOString(), action: "Разрешить один раз", reason: why, prompt: shown });
      log(`${name}: prompt answered allow_once — ${why}`);
      continue;
    }
    if (await s.during?.(v, sc, runId)) continue;
    const st = lastStatus(runId);
    if (st?.status === "paused" && st.reason === "awaiting_answer" && s.onQuestion && await s.onQuestion(v, sc, runId, start)) continue;
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
  sc.cost = turnCosts(runId);
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
  const dir = REAL ? PERSON_PROJECT : nodeProject("s7-app");
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
  // names from the structured fields; the terminal side is the person's (S7-MANUAL.md): no CLI list command is run
  // here — `claude mcp list` prints servers' credentials, `codex mcp list` their commands and environment
  sc.app = { claudeMcp: mcpNames(sc.environment, "claude"), codexMcp: mcpNames(sc.environment, "codex") };
  sc.terminal = "not asked by the driver: the manual part (evidence/real-stage-13/S7-MANUAL.md)";
  sc.personCheck = "PENDING: the manual part, each point equal / differs / not confirmed";
  // how long each request of the probe took (safe fields: method, page, times, outcome), for a timeout's diagnosis
  for (const p of sc.environment?.providers ?? []) log(`${name} ${p.provider} timing (limit ${p.limitMs} ms): ${(p.timing ?? []).map((t) => `${t.method}${t.page ? `#${t.page}` : ""} ${t.durationMs}/${t.allottedMs} ms ${t.outcome}`).join("; ")}`);
  // the automatic part only (s7-criteria.mjs): each CLI answered once and its MCP list is whole; the manual part stays PENDING
  sc.auto = s7Verdict(sc.environment);
  for (const c of sc.auto.checks) check(c.ok, `${name}: ${c.what}`, c.ok ? null : c.got);
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
  for (const s of Object.values(report.scenarios)) if (s.runId && !s.timeline) try { s.timeline = timeline(s.runId); s.turns = turnsBy(s.runId); s.cost = turnCosts(s.runId); } catch {}
} finally {
  report.finishedAt = new Date().toISOString();
  report.interventionCount = report.interventions.length;
  report.turnsTotal = Object.values(report.scenarios).reduce((n, s) => n + (s.turns?.codex ?? 0) + (s.turns?.claude ?? 0), 0);
  // the work first: the active run stopped as the person does, its CLI processes waited for; then only this run's own
  // app, waited for (never another process that happens to use the port); a failed launch has already stopped its child
  try { report.shutdown = await stopActiveRuns(); } catch (e) { report.shutdown = { error: String(e?.message ?? e) }; }
  const pids = app ? descendants(app.child.pid).map((p) => p.pid) : [];
  await app?.stop().catch(() => {});
  await sleep(2000);
  report.shutdown.ownProcessesLeft = pids.filter(alive);
  try { saveEvidence(); } catch (e) { report.evidenceError = String(e?.stack ?? e).slice(0, 1000); }
  const globalAfter = globalHashes();
  check(GLOBAL_FILES.every((f) => globalAfter[f] === globalBefore[f]), "global ~/.codex/config.toml and ~/.claude/settings.json unchanged", { globalBefore, globalAfter });
  report.kept = { tmp: anon(TMP), userData: anon(userData), note: "kept for the review; not removed by the driver" };
  fs.writeFileSync(path.join(OUT, "report.json"), `${anon(JSON.stringify(report, null, 2))}\n`);
  fs.writeFileSync(path.join(OUT, "series.log"), `${anon(logLines.join("\n"))}\n`);
  for (const n of ["S4C", "S4X"]) if (fs.existsSync(mcpLogFile(n))) fs.writeFileSync(path.join(OUT, `mcp-elicit-${n}.jsonl`), anon(fs.readFileSync(mcpLogFile(n), "utf8")));
  process.stdout.write(`${JSON.stringify({ ok: report.ok, halted: report.halted ?? null, failures: report.failures, turnsTotal: report.turnsTotal, interventions: report.interventionCount, out: OUT, tmp: TMP })}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
