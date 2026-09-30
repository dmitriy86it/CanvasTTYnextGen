// Independent check (participant "warden") of the Claude executor mode structured-edit against stage-6-contract.md:
// argv rights (§2), candidate admission (§3), refusals on the mock CLI (§2 init contract, §3 stop/timeout) and the
// service with the real adapter (§6, stage-5 §3/§11). Written from the contract, not from the implementation.
// Everything runs on mock CLIs from tests/fixtures; the real claude/codex are never started.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createProviderAgents } from "../src/main/services/orchestration/agents.ts";
import { checkPreparedDeps, createRegistry } from "../src/main/services/orchestration/checks.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createOrchestrationService } from "../src/main/services/orchestration/orchestrationService.ts";
import { buildProviderTurn, startProviderTurn } from "../src/main/services/orchestration/providers.ts";
import { readRun } from "../src/main/services/orchestration/store.ts";
import { DEFAULT_TURN_LIMITS } from "../src/main/services/orchestration/turn.ts";
import { ProcLedger, assertNoneAlive } from "./fixtures/orchestration/proc-ledger.mjs";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = path.join(ROOT, "tests/fixtures/orchestration");
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = Object.freeze({ command: NODE, args: [path.join(ROOT, "src/orchestration/supervisor.mjs")], env: {} });
const NO_SPAWN = Object.freeze({ command: "/nonexistent/should-never-run", args: [], env: {} });
const MARK = `CTTYWARDEN-${process.pid}`;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${MARK}-`)));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SKIP = { skip: process.platform !== "darwin" && "checks run only in the macOS sandbox" };

const SESSION = "11111111-2222-4333-8444-555555555555";
const EDIT_VERSION = "2.1.280 (Claude Code)";
const EDIT_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
const SCHEMA = {
  type: "object",
  properties: { status: { type: "string" }, summary: { type: "string" }, sha256: { type: "string" }, memory: { type: "string" } },
  required: ["status", "summary"],
  additionalProperties: false
}; // the mocks' default answer

function wrapper(provider) {
  const file = path.join(TMP, `${provider}-cli`);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${provider}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const EXEC = { codex: wrapper("codex"), claude: wrapper("claude") };
const cli = (provider) => ({ state: "available", provider, executable: EXEC[provider] ?? `/opt/bin/${provider}`, launcher: "native", environment: { PATH: process.env.PATH }, checked: [] });

let n = 0;
const fresh = (prefix) => fs.mkdtempSync(path.join(TMP, `${prefix}-`));
// A cwd that looks like a copy: a .git directory with a config, and nothing else.
function copyDir() {
  const dir = fresh("copy");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\tbare = false\n");
  return dir;
}
const b64 = (s) => Buffer.from(s).toString("base64");
const write = (rel, body = "x") => `MOCK_WRITE ${rel} ${b64(body)}`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const shaFile = (f) => sha(fs.readFileSync(f));
// Every file of a copy (its .git included) with its content hash: "unchanged" means exactly this is equal.
const treeOf = (dir) => fs.readdirSync(dir, { recursive: true }).sort()
  .map((rel) => fs.lstatSync(path.join(dir, rel)).isFile() ? `${rel} ${shaFile(path.join(dir, rel))}` : rel).join("\n");

const editInput = (extra = {}) => ({
  cli: cli("claude"), cliVersion: EDIT_VERSION, mode: "structured-edit", candidate: true, cwd: copyDir(), schema: SCHEMA,
  env: { LANG: "C" }, task: "task", session: { kind: "new", id: SESSION }, ...extra
});
const argvOf = (input) => {
  const built = buildProviderTurn(input);
  assert.equal(built.ok, true, built.detail);
  return built.spec.argv;
};
const valueOf = (argv, flag) => {
  assert.equal(argv.filter((a) => a === flag).length, 1, `${flag} exactly once`);
  return argv[argv.indexOf(flag) + 1];
};
const list = (v) => v.split(",").map((s) => s.trim());
async function until(fn, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (fn()) return;
  throw new Error("condition not reached");
}

// ---------- §2 argv ----------

test("structured-edit argv: required restrictions present, dangerous flags absent (new, resume, model, budget)", () => {
  const variants = [
    editInput(),
    editInput({ session: { kind: "resume", id: SESSION } }),
    editInput({ model: "model-b", maxBudgetUsd: 0.5 })
  ];
  for (const input of variants) {
    const argv = argvOf(input);
    const joined = argv.join("\u0000");
    for (const bad of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--add-dir", "--mcp-config",
      "--plugin-dir", "--plugin-url", "--agents", "--bare"]) {
      assert.equal(argv.some((a) => a === bad || a.startsWith(`${bad}=`)), false, bad);
    }
    for (const bad of ["bypassPermissions", "acceptEdits"]) assert.equal(joined.includes(bad), false, bad);
    for (const flag of ["-p", "--safe-mode", "--restricted", "--strict-mcp-config", "--disable-slash-commands", "--verbose"]) {
      assert.ok(argv.includes(flag), flag);
    }
    assert.equal(valueOf(argv, "--output-format"), "stream-json");
    assert.equal(valueOf(argv, "--permission-mode"), "dontAsk", "never auto/acceptEdits/bypassPermissions");
    assert.equal(valueOf(argv, "--permission-prompts"), "none");
    assert.deepEqual(JSON.parse(valueOf(argv, "--json-schema")), SCHEMA);

    const tools = list(valueOf(argv, "--tools"));
    assert.deepEqual([...tools].sort(), [...EDIT_TOOLS].sort());
    for (const t of ["Bash", "WebFetch", "WebSearch", "Task"]) assert.equal(tools.includes(t), false, t);

    const allowed = list(valueOf(argv, "--allowedTools"));
    assert.ok(allowed.includes("Edit(/**)"), "edits only under the working directory");
    for (const bare of ["Edit", "Write", "Bash"]) assert.equal(allowed.includes(bare), false, `bare ${bare} would approve any path`);
    assert.equal(allowed.some((a) => a.startsWith("Bash") || a.startsWith("Write(") || a.startsWith("mcp__")), false, JSON.stringify(allowed));

    const disallowed = list(valueOf(argv, "--disallowedTools"));
    for (const d of ["mcp__*", "Edit(/.git/**)", "Edit(/.claude/**)"]) assert.ok(disallowed.includes(d), d);

    const settings = JSON.parse(valueOf(argv, "--settings"));
    assert.equal(settings?.permissions?.blockReadsOutsideWorkingDirectories, true);

    const sessionFlag = input.session.kind === "new" ? "--session-id" : "--resume";
    assert.equal(valueOf(argv, sessionFlag), SESSION);
    if (input.model) assert.equal(valueOf(argv, "--model"), "model-b");
    if (input.maxBudgetUsd) assert.equal(valueOf(argv, "--max-budget-usd"), "0.5");
  }
});

test("no flags can be smuggled through input fields; refusals create no files and no processes", () => {
  const cases = [
    [{ model: "model --dangerously-skip-permissions" }, "invalid_input"],
    [{ model: "--add-dir" }, "invalid_input"],
    [{ model: "-x" }, "invalid_input"],
    [{ model: "a b" }, "invalid_input"],
    [{ allowedTools: "Bash" }, "invalid_input"],
    [{ extraArgs: ["--bare"] }, "invalid_input"],
    [{ permissionMode: "bypassPermissions" }, "invalid_input"],
    [{ modelParams: { reasoningEffort: "high" } }, "invalid_input"],
    [{ modelParams: { tools: "Bash" } }, "invalid_input"],
    [{ maxBudgetUsd: "1 --bare" }, "invalid_input"],
    [{ session: { kind: "resume", id: "--dangerously-skip-permissions" } }, "invalid_input"],
    [{ env: { NODE_OPTIONS: "--require /x" } }, "invalid_input"]
  ];
  for (const [extra, reason] of cases) {
    const input = editInput(extra);
    const before = fs.readdirSync(input.cwd);
    const started = startProviderTurn(input, NO_SPAWN); // env names are checked with the spec, before any process
    assert.equal(started.ok, false, JSON.stringify(extra));
    assert.equal(started.reason, reason, `${JSON.stringify(extra)}: ${started.detail}`);
    assert.deepEqual(fs.readdirSync(input.cwd), before, "no file created");
  }
});

// ---------- §3 candidate admission ----------

test("candidate mode needs candidate: true; versions are not widened", () => {
  for (const candidate of [undefined, false, "true", 1]) {
    const input = editInput({ candidate });
    if (candidate === undefined) delete input.candidate;
    const before = fs.readdirSync(input.cwd);
    for (const r of [buildProviderTurn(input), startProviderTurn(input, NO_SPAWN)]) {
      assert.equal(r.ok, false, String(candidate));
      if (candidate === undefined || candidate === false) assert.equal(r.reason, "unproven_mode", r.detail);
      else assert.ok(["unproven_mode", "invalid_input"].includes(r.reason), r.detail);
    }
    assert.deepEqual(fs.readdirSync(input.cwd), before);
  }
  // structured-edit only for the named candidates 2.1.280 and 2.1.281 (2.1.282 was probed on the native path only);
  // structured-no-tools stays proven only for 2.1.278
  for (const [extra, reason] of [
    [{ cliVersion: "2.1.278 (Claude Code)" }, "unsupported_version"],
    [{ cliVersion: "2.1.282 (Claude Code)" }, "unsupported_version"],
    [{ cliVersion: "2.1.283 (Claude Code)" }, "unsupported_version"],
    [{ cliVersion: "2.1.282.1 (Claude Code)" }, "unsupported_version"],
    [{ cliVersion: "2.1.279 (Claude Code)" }, "unsupported_version"],
    [{ cliVersion: "2.1.281 (Claude Code)", mode: "structured-no-tools", candidate: undefined }, "unsupported_version"],
    [{ mode: "structured-no-tools", candidate: undefined }, "unsupported_version"]
  ]) {
    const input = editInput(extra);
    if (extra.candidate === undefined && "candidate" in extra) delete input.candidate;
    const r = startProviderTurn(input, NO_SPAWN);
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.equal(r.reason, reason, r.detail);
  }
  // 2.1.281 is admitted as a candidate only: with candidate: true it builds, without it (or false) it is unproven_mode
  for (const candidate of [undefined, false]) {
    const input = editInput({ cliVersion: "2.1.281 (Claude Code)" });
    if (candidate === undefined) delete input.candidate; else input.candidate = candidate;
    const r = buildProviderTurn(input);
    assert.deepEqual([r.ok, r.reason], [false, "unproven_mode"], String(candidate));
  }
  for (const v of ["2.1.281"]) {
    const admitted = buildProviderTurn(editInput({ cliVersion: `${v} (Claude Code)`, candidate: true }));
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.ok(!admitted.spec.argv.some((a) => /bypass|dangerously/i.test(a)));
  }
  // codex never gets structured-edit
  const codex = startProviderTurn({ ...editInput(), cli: cli("codex"), cliVersion: "codex-cli 0.155.1" }, NO_SPAWN);
  assert.equal(codex.ok, false);
});

test("createProviderAgents: executor only when configured and allowCandidate; lead only Codex; executor only Claude", () => {
  const req = (purpose, role) => ({ purpose, role, cwd: copyDir(), task: "t", schema: SCHEMA, sessionId: null, timeoutMs: 1000 });
  const lead = { cli: cli("codex"), cliVersion: "codex-cli 0.155.1", env: {} };
  const executor = (extra = {}) => ({ cli: cli("claude"), cliVersion: EDIT_VERSION, env: {}, ...extra });
  const agents = (cfg) => createProviderAgents({ lead, launch: NO_SPAWN, attemptRoot: TMP, ...cfg });

  const none = agents({}).prepare(req("execute", "executor"));
  assert.deepEqual([none.ok, none.reason], [false, "unsupported_capability"]);

  for (const allowCandidate of [undefined, false]) {
    const r = agents({ executor: executor(allowCandidate === undefined ? {} : { allowCandidate }) }).prepare(req("execute", "executor"));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unavailable");
    assert.match(r.detail, /unproven_mode/);
  }

  const codexExecutor = agents({ executor: { ...executor({ allowCandidate: true }), cli: cli("codex"), cliVersion: "codex-cli 0.155.1" } })
    .prepare(req("execute", "executor"));
  assert.equal(codexExecutor.ok, false, "executor is Claude only");

  const oldClaude = agents({ executor: executor({ allowCandidate: true, cliVersion: "2.1.278 (Claude Code)" }) }).prepare(req("execute", "executor"));
  assert.equal(oldClaude.ok, false, "structured-edit is a candidate for 2.1.280 and 2.1.281 only");
  const unknownClaude = agents({ executor: executor({ allowCandidate: true, cliVersion: "2.1.283 (Claude Code)" }) }).prepare(req("execute", "executor"));
  assert.deepEqual([unknownClaude.ok, unknownClaude.reason], [false, "unavailable"]);
  assert.match(unknownClaude.detail, /unsupported_version/);
  for (const allowCandidate of [undefined, false]) {
    const r = agents({ executor: executor({ cliVersion: "2.1.281 (Claude Code)", ...(allowCandidate === undefined ? {} : { allowCandidate }) }) }).prepare(req("execute", "executor"));
    assert.equal(r.ok, false);
    assert.match(r.detail, /unproven_mode/);
  }
  for (const v of ["2.1.281"]) {
    assert.equal(agents({ executor: executor({ allowCandidate: true, cliVersion: `${v} (Claude Code)` }) }).prepare(req("execute", "executor")).ok, true, v);
  }

  const claudeLead = createProviderAgents({ lead: { cli: cli("claude"), cliVersion: EDIT_VERSION, env: {} }, executor: executor({ allowCandidate: true }), launch: NO_SPAWN, attemptRoot: TMP });
  assert.equal(claudeLead.prepare(req("plan", "lead")).ok, false, "the lead is Codex only");
  assert.equal(claudeLead.prepare(req("review", "lead")).ok, false);

  // positive control: the refusals above are not a broken prepare()
  const ok = agents({ executor: executor({ allowCandidate: true }) }).prepare(req("execute", "executor"));
  assert.equal(ok.ok, true, ok.detail);
  assert.deepEqual([ok.provider, ok.mode], ["claude", "structured-edit"]);
});

// ---------- refusals on mock-claude ----------

const FAST = {
  limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: 20_000, stdoutGraceMs: 500 },
  supervisor: { graceIntMs: 300, graceTermMs: 300, leftoverMs: 300 }
};
const mockEnv = (mode, ledgerFile, state, extra = {}) => ({ CTTYEXP: MARK, MOCK_MODE: mode, MOCK_STATE: state, MOCK_LEDGER: ledgerFile, LANG: "C", ...extra });

async function mockTurn(t, mode, { extra = {}, env = {}, during } = {}) {
  const ledgerFile = path.join(TMP, `ledger-${++n}.jsonl`);
  const input = editInput({ ...FAST, ...extra, env: mockEnv(mode, ledgerFile, fresh("state"), env) });
  const started = startProviderTurn(input, LAUNCH);
  assert.equal(started.ok, true, started.detail);
  if (during) await during(started);
  const r = await started.result;
  const ledger = new ProcLedger(ledgerFile);
  ledger.track(r.transport.pids.supervisor, "supervisor");
  ledger.track(r.transport.pids.pgid, "group", { group: true });
  t.diagnostic(`${mode}: outcome=${r.outcome} transport=${r.transport.outcome} ${JSON.stringify(r.contract.errors)}`);
  assert.equal(r.nextTurnAllowed, r.outcome === "completed");
  assert.equal(r.transport.process.groupCleared, true);
  await assertNoneAlive(t, ledger, { mark: MARK });
  return { r, input };
}

test("mock ok: completed, init contract verified, permissionMode recorded (positive control)", async (t) => {
  const { r } = await mockTurn(t, "ok");
  assert.equal(r.outcome, "completed", JSON.stringify(r.contract.errors));
  assert.equal(r.contract.status, "verified");
  assert.deepEqual([...r.contract.actual.tools].sort(), [...EDIT_TOOLS, "StructuredOutput"].sort());
  assert.deepEqual(r.contract.actual.mcpServers, []);
  assert.equal(r.contract.actual.permissionMode, "dontAsk");
});

test("init contract violations on the mock: contract_violation, no next turn", async (t) => {
  for (const mode of ["tools_plus_bash", "extra_mcp", "init_no_tools", "permission_mode_other"]) {
    const { r } = await mockTurn(t, mode);
    assert.equal(r.transport.outcome, "completed", `${mode}: the transport alone would have passed`);
    assert.equal(r.outcome, "contract_violation", mode);
    assert.equal(r.nextTurnAllowed, false, mode);
    assert.equal(r.contract.status, "violated", mode);
    if (mode === "permission_mode_other") assert.ok(r.contract.errors.some((e) => e.includes("permissionMode")), JSON.stringify(r.contract.errors));
  }
});

test("init without permissionMode is not a violation, but is recorded as absent (§2)", async (t) => {
  const { r } = await mockTurn(t, "init_no_permission_mode");
  assert.equal(r.outcome, "completed", JSON.stringify(r.contract.errors));
  assert.equal(r.contract.actual.permissionMode, null);
});

test("a foreign session_id is never completed", async (t) => {
  const { r } = await mockTurn(t, "wrong_session");
  assert.notEqual(r.outcome, "completed");
  assert.equal(r.nextTurnAllowed, false);
  assert.equal(r.contract.status, "violated");
});

test("timeout and stop: the group is cleared, no next turn", async (t) => {
  for (const mode of ["sleep", "edit_slow"]) {
    const { r } = await mockTurn(t, mode, { extra: { limits: { ...FAST.limits, timeoutMs: 700 }, task: write("slow.txt") } });
    assert.equal(r.outcome, "timeout", mode);
    assert.equal(r.transport.process.groupCleared, true, mode);
  }
  const { r } = await mockTurn(t, "sleep", { during: async (s) => { await new Promise((res) => setTimeout(res, 300)); s.stop(); } });
  assert.equal(r.outcome, "stopped");
  assert.equal(r.nextTurnAllowed, false);
  // stop while the executor is inside its edit work (the mock marks it in the ledger)
  const edit = await mockTurn(t, "edit_slow", {
    extra: { task: write("slow.txt") },
    during: async (s) => {
      const file = path.join(TMP, `ledger-${n}.jsonl`);
      await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("edit_started"), 10_000);
      s.stop();
    }
  });
  assert.equal(edit.r.outcome, "stopped");
  assert.equal(edit.r.nextTurnAllowed, false);
});

// The mock emulates the CLI policy (contract §4): this checks the emulation and our plumbing, not the real CLI.
test("mock policy emulation: writes outside cwd, into .git and .claude are denied; inside cwd applied", async (t) => {
  const canary = path.join(TMP, `outside-abs-${randomUUID()}`);
  const task = [
    "edit please",
    write("inside.txt", "inside"),
    write("sub/nested.txt", "nested"),
    write("../outside-rel.txt"),
    write(canary),
    write(".git/config", "[core]\n\thooksPath = /tmp\n"),
    write(".git/hooks/pre-commit", "#!/bin/sh\n"),
    write(".claude/settings.json", "{}")
  ].join("\n");
  const { r, input } = await mockTurn(t, "ok", { extra: { task } });
  const gitConfigBefore = "[core]\n\tbare = false\n";
  assert.equal(r.outcome, "completed", JSON.stringify(r.contract.errors));
  assert.equal(fs.readFileSync(path.join(input.cwd, "inside.txt"), "utf8"), "inside");
  assert.equal(fs.readFileSync(path.join(input.cwd, "sub/nested.txt"), "utf8"), "nested");
  assert.equal(fs.existsSync(path.join(path.dirname(input.cwd), "outside-rel.txt")), false);
  assert.equal(fs.existsSync(canary), false);
  assert.equal(fs.readFileSync(path.join(input.cwd, ".git/config"), "utf8"), gitConfigBefore);
  assert.equal(fs.existsSync(path.join(input.cwd, ".git/hooks")), false);
  assert.equal(fs.existsSync(path.join(input.cwd, ".claude")), false);
  const denied = r.transport.history.filter((f) => f.kind === "event" && JSON.stringify(f.value).includes("\"is_error\":true"));
  assert.ok(denied.length >= 5, `denied tool_results: ${denied.length}`);
});

// ---------- the service with the real adapter ----------

const GIT = findGit(process.env);
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "");
const g = (cwd, ...args) => execFileSync(GIT, args, {
  cwd, encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
}).trim();
const registry = createRegistry([
  { id: "unit", title: "unit tests", executable: NODE, argv: ["--test", "tests/sum.test.mjs"], timeoutMs: 120_000, maxOutputBytes: 65_536 }
]);

function project() {
  const src = fresh("src");
  fs.cpSync(path.join(FIXTURES, "check-project"), src, { recursive: true });
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fixture");
  const deps = checkPreparedDeps({
    lockfileRelPath: "package-lock.json", lockfileSha256: shaFile(path.join(src, "package-lock.json")),
    nodeModulesPath: path.join(src, "node_modules")
  });
  return { src, root: path.join(TMP, `root-${++n}`), deps };
}

// Lead turns come from the test agents (the real lead would need mock-codex answers per purpose; the lead is not
// what this file checks). Executor turns go through the real createProviderAgents(...).prepare — the path under test.
// Every prepare() is recorded with the copy's .git/config hash taken before anything of the turn ran.
function mixedAgents(lead, real) {
  const seen = [];
  return {
    seen,
    prepare(req) {
      const gitConfig = path.join(req.cwd, ".git", "config");
      seen.push({ purpose: req.purpose, role: req.role, cwd: req.cwd, gitConfig: fs.existsSync(gitConfig) ? shaFile(gitConfig) : null, tree: treeOf(req.cwd) });
      return req.role === "executor" ? real.prepare(req) : lead.prepare(req);
    }
  };
}
const leadAgents = (stageTask) => createTestAgents({
  plan: { report: plan({ title: "warden stage", task: stageTask }) },
  review: { report: review("accept") },
  final_review: { report: review("complete") },
  execute: { report: executed() } // never used: executor turns go to the real adapter
});
const service = (p, agents) => createOrchestrationService({ root: p.root, gitPath: GIT, agents, checks: { registry, deps: p.deps, launch: LAUNCH } });
const goal = { text: "warden", criteria: ["sum works"], checks: ["unit"] };
const realAgents = (executor) => createProviderAgents({
  lead: { cli: cli("codex"), cliVersion: "codex-cli 0.155.1", env: {} }, executor, launch: LAUNCH, attemptRoot: fresh("attempts")
});

test("service: executor without allowCandidate -> paused(permission_denied) before any executor intent; copy untouched", SKIP, async () => {
  const p = project();
  const lead = leadAgents(write("should-not-exist.txt"));
  const ledgerFile = path.join(TMP, `ledger-${++n}.jsonl`);
  const agents = mixedAgents(lead, realAgents({ cli: cli("claude"), cliVersion: EDIT_VERSION, env: mockEnv("ok", ledgerFile, fresh("state")) }));
  const run = await service(p, agents).createRun({ source: p.src, goal });
  await until(() => run.view().status === "paused");
  await run.idle();
  assert.equal(run.view().reason, "permission_denied");
  const st = (await readRun(p.root, run.runId)).state;
  assert.deepEqual(Object.values(st.turns).map((t) => t.role), ["lead"], "no turn.intent of the executor");
  assert.deepEqual(lead.log.map((e) => e.purpose), ["plan"]);
  assert.equal(fs.existsSync(ledgerFile), false, "the executor CLI never ran");
  const exec = agents.seen.find((s) => s.role === "executor");
  assert.ok(exec, "the executor turn was asked for");
  assert.equal(treeOf(exec.cwd), exec.tree, "the copy (with its .git) is unchanged");
  assert.equal(shaFile(path.join(exec.cwd, ".git", "config")), exec.gitConfig);
  await run.close();
});

// The mock denies the escapes itself (contract §4): this proves the service survives a denied escape and that our
// plumbing never widens it — not that the real Claude Code enforces the policy (that is series E1).
test("service: mock executor tries to write outside the copy, into its .git and into managed data; run completes", SKIP, async (t) => {
  const p = project();
  const canary = path.join(TMP, `canary-${randomUUID()}`);
  const stageTask = [
    "apply the edits",
    write("warden-inside.txt", "inside\n"),
    write("../outside.txt"),
    write("../control.git/config", "[warden]\n\ttampered = WARDEN-TAMPER\n"),
    write(canary),
    write(".git/config", "[core]\n\thooksPath = /tmp\n"),
    write(".git/hooks/post-checkout", "#!/bin/sh\n"),
    write(".claude/settings.json", "{}")
  ].join("\n");
  const lead = leadAgents(stageTask);
  const script = fresh("script");
  fs.writeFileSync(path.join(script, "1.json"), JSON.stringify(executed("wrote what was allowed")));
  const ledgerFile = path.join(TMP, `ledger-${++n}.jsonl`);
  const agents = mixedAgents(lead, realAgents({
    cli: cli("claude"), cliVersion: EDIT_VERSION, allowCandidate: true,
    env: mockEnv("ok", ledgerFile, fresh("state"), { MOCK_SCRIPT: script })
  }));
  const run = await service(p, agents).createRun({ source: p.src, goal });
  await until(() => ["completed", "paused", "failed"].includes(run.view().status));
  await run.idle();
  const st = (await readRun(p.root, run.runId)).state;
  t.diagnostic(`status=${st.status} reason=${st.pausedReason}`);
  assert.equal(st.status, "completed", `reason ${st.pausedReason}`);

  const exec = agents.seen.find((s) => s.role === "executor");
  const workspace = path.dirname(exec.cwd);
  assert.equal(fs.existsSync(path.join(workspace, "outside.txt")), false);
  assert.equal(fs.existsSync(canary), false);
  assert.doesNotMatch(fs.readFileSync(path.join(workspace, "control.git", "config"), "utf8"), /WARDEN-TAMPER/, "managed data untouched");
  assert.equal(shaFile(path.join(exec.cwd, ".git", "config")), exec.gitConfig, ".git/config of the copy unchanged");
  assert.equal(fs.existsSync(path.join(exec.cwd, ".git", "hooks", "post-checkout")), false);
  assert.equal(fs.existsSync(path.join(exec.cwd, ".claude")), false);
  const executorTurns = Object.values(st.turns).filter((x) => x.role === "executor");
  assert.equal(executorTurns.length, 1);
  assert.deepEqual([executorTurns[0].provider, executorTurns[0].mode], ["claude", "structured-edit"]);
  // the allowed edit went into the checkpoint; the user's branch did not move
  const commit = st.workspace.checkpoints["1"].commit;
  assert.equal(g(p.src, "show", `${commit}:warden-inside.txt`), "inside");
  assert.equal(g(p.src, "rev-parse", "main"), g(p.src, "rev-parse", "HEAD"));
  const ledger = new ProcLedger(ledgerFile);
  await assertNoneAlive(t, ledger, { mark: MARK });
  await run.close();
});
