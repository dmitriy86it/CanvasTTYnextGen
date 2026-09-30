// Provider turns through the public API (startProviderTurn): input refusals before any file or process,
// argv of the proven modes, and the mandatory provider contract check end to end on mock CLIs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildProviderTurn, parseCliVersion, startProviderTurn } from "../src/main/services/orchestration/providers.ts";
import * as publicApi from "../src/main/services/orchestration/index.ts";
import { DEFAULT_TURN_LIMITS } from "../src/main/services/orchestration/turn.ts";
import { ProcLedger, assertNoneAlive } from "./fixtures/orchestration/proc-ledger.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCH = Object.freeze({ command: process.execPath, args: [path.join(ROOT, "src/orchestration/supervisor.mjs")], env: {} });
const NO_SPAWN = Object.freeze({ command: "/nonexistent/should-never-run", args: [], env: {} });
const FIXTURES = path.join(ROOT, "tests/fixtures/orchestration");
const MARK = `CTTYPROV-${process.pid}`;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${MARK}-`)));
const STATE = path.join(TMP, "state");
fs.mkdirSync(STATE);
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SCHEMA = {
  type: "object",
  properties: { status: { type: "string" }, summary: { type: "string" }, sha256: { type: "string" }, memory: { type: "string" } },
  required: ["status", "summary"],
  additionalProperties: false
}; // the mocks' default answer
const SESSION = "11111111-2222-4333-8444-555555555555";

// A native executable wrapping the mock, as the provider CLI registry would resolve it.
function wrapper(provider) {
  const file = path.join(TMP, `${provider}-cli`);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(FIXTURES, `mock-${provider}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const EXEC = { codex: wrapper("codex"), claude: wrapper("claude") };

function cli(provider, launcher = "native") {
  return {
    state: "available",
    provider,
    executable: EXEC[provider] ?? `/opt/bin/${provider}`,
    launcher,
    ...(launcher === "batch" ? { commandPrompt: "C:\\Windows\\System32\\cmd.exe" } : {}),
    environment: { PATH: process.env.PATH },
    checked: []
  };
}

const attemptDir = () => fs.mkdtempSync(path.join(TMP, "attempt-"));
let n = 0;
const mockEnv = (mode, ledgerFile) => ({ CTTYEXP: MARK, MOCK_MODE: mode, MOCK_STATE: STATE, MOCK_LEDGER: ledgerFile, LANG: "C" });
const FAST = {
  limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: 20_000, stdoutGraceMs: 500 },
  supervisor: { graceIntMs: 300, graceTermMs: 300, leftoverMs: 300 }
};

const codexInput = (extra = {}) => ({
  cli: cli("codex"), cliVersion: "codex-cli 0.155.1", mode: "structured-readonly", cwd: TMP, schema: SCHEMA,
  env: { LANG: "C" }, task: "task", attemptDir: attemptDir(), session: { kind: "new" }, ...extra
});
const claudeInput = (extra = {}) => ({
  cli: cli("claude"), cliVersion: "2.1.278 (Claude Code)", mode: "structured-no-tools", cwd: TMP, schema: SCHEMA,
  env: { LANG: "C" }, task: "task", session: { kind: "new", id: SESSION }, ...extra
});

// Runs a provider turn on a mock to the end; asserts the invariants of every provider result and own cleanup.
async function run(t, provider, mode, extra = {}) {
  const ledgerFile = path.join(TMP, `ledger-${++n}.jsonl`);
  const base = provider === "codex" ? codexInput : claudeInput;
  const input = base({ ...FAST, ...extra, env: { ...mockEnv(mode, ledgerFile), ...extra.env } });
  const started = startProviderTurn(input, LAUNCH);
  assert.equal(started.ok, true, started.detail);
  const r = await started.result;
  const ledger = new ProcLedger(ledgerFile);
  ledger.track(r.transport.pids.supervisor, "supervisor");
  ledger.track(r.transport.pids.pgid, "group", { group: true });
  t.diagnostic(`${provider}/${mode}: outcome=${r.outcome} transport=${r.transport.outcome} contract=${r.contract.status} ${JSON.stringify(r.contract.errors)}`);
  assert.equal(r.nextTurnAllowed, r.outcome === "completed");
  if (r.outcome === "completed") assert.equal(r.contract.status, "verified");
  assert.equal(r.transport.process.groupCleared, true);
  await assertNoneAlive(t, ledger, { mark: MARK });
  return { r, input, started };
}

test("parseCliVersion reads the proven version lines only", () => {
  assert.equal(parseCliVersion("codex", "codex-cli 0.155.1\n"), "0.155.1");
  assert.equal(parseCliVersion("claude", "2.1.278 (Claude Code)"), "2.1.278");
  assert.equal(parseCliVersion("claude", "codex-cli 0.155.1"), null);
  assert.equal(parseCliVersion("codex", "0.155.1"), null);
});

test("the public API exposes one provider path and no raw transport", () => {
  assert.equal(typeof publicApi.startProviderTurn, "function");
  for (const name of ["startTurn", "checkTurnSpec", "decideOutcome", "buildProviderTurn", "verifyClaudeInit"]) {
    assert.equal(name in publicApi, false, name);
  }
});

test("codex argv: read-only sandbox, supported reasoningEffort, schema file named in attemptDir but not created", () => {
  const input = codexInput({ model: "model-a", modelParams: { reasoningEffort: "medium" } });
  const built = buildProviderTurn(input);
  assert.equal(built.ok, true, built.detail);
  const argv = built.spec.argv;
  assert.equal(built.schemaFile, argv[argv.indexOf("--output-schema") + 1]);
  assert.deepEqual(argv, [
    EXEC.codex, "exec", "--json", "--ignore-user-config", "--ignore-rules",
    "-m", "model-a", "-c", 'model_reasoning_effort="medium"', "-c", 'approval_policy="never"',
    "--output-schema", built.schemaFile, "-o", "{REPORT_FILE}", "-s", "read-only", "-C", TMP, "-"
  ]);
  assert.equal(path.dirname(built.schemaFile), input.attemptDir);
  assert.deepEqual(fs.readdirSync(input.attemptDir), []);
  assert.deepEqual(built.spec.env, { PATH: process.env.PATH, LANG: "C" });

  const resumed = buildProviderTurn(codexInput({ session: { kind: "resume", id: "thread-1" } }));
  assert.deepEqual(resumed.spec.argv.slice(1, 3), ["exec", "resume"]);
  assert.deepEqual(resumed.spec.argv.slice(-4), ["-c", 'sandbox_mode="read-only"', "thread-1", "-"]);
  assert.ok(!resumed.spec.argv.includes("-m"));
  assert.equal(resumed.spec.expectSessionId, "thread-1");
});

test("claude argv: no tools, strict MCP, exact session id", () => {
  const built = buildProviderTurn(claudeInput({ model: "model-b", maxBudgetUsd: 0.25 }));
  assert.equal(built.ok, true, built.detail);
  assert.deepEqual(built.spec.argv, [
    EXEC.claude, "-p", "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(SCHEMA),
    "--safe-mode", "--tools", "", "--strict-mcp-config", "--disallowedTools", "mcp__*", "--disable-slash-commands",
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--max-budget-usd", "0.25", "--model", "model-b", "--session-id", SESSION
  ]);
  const fresh = buildProviderTurn(claudeInput({ session: { kind: "new" } }));
  assert.match(fresh.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(fresh.spec.argv.at(-1), fresh.sessionId);
  assert.deepEqual(buildProviderTurn(claudeInput({ session: { kind: "resume", id: SESSION } })).spec.argv.slice(-2), ["--resume", SESSION]);
});

test("refusals happen before any file or process: unknown parameters, versions, modes, types", () => {
  const cases = [
    [codexInput({ modelParams: { unsupportedParameter: "ignored" } }), "invalid_input", /modelParams\.unsupportedParameter/],
    [codexInput({ modelParams: { reasoningEffort: "extreme" } }), "invalid_input", /reasoningEffort must be one of/],
    [codexInput({ modelParams: { reasoningEffort: 3 } }), "invalid_input", /reasoningEffort/],
    [codexInput({ modelParams: { reasoningEffort: 'high" -c sandbox_mode="danger' } }), "invalid_input", /reasoningEffort/],
    [codexInput({ modelParams: ["high"] }), "invalid_input", /modelParams must be an object/],
    [codexInput({ unexpectedField: true }), "invalid_input", /unknown input field: unexpectedField/],
    [codexInput({ cliVersion: "codex-cli 0.156.0" }), "unsupported_version", /0\.155\.1/],
    [codexInput({ maxBudgetUsd: 1 }), "invalid_input", /budget/],
    [codexInput({ session: { kind: "new", id: "chosen" } }), "invalid_input", /thread id/],
    [codexInput({ session: { kind: "resume", id: "-s" } }), "invalid_input", /thread id/],
    [codexInput({ session: { kind: "resume" } }), "invalid_input", /session must be/],
    [codexInput({ env: { NODE_OPTIONS: "--inspect" } }), "invalid_input", /env name not allowed: NODE_OPTIONS/],
    [codexInput({ env: { A: 1 } }), "invalid_input", /env must be an object of strings/],
    [codexInput({ cwd: path.join(TMP, "missing") }), "invalid_input", /cwd must be an existing/],
    [codexInput({ schema: { $ref: "#" } }), "invalid_input", /schema/],
    [claudeInput({ modelParams: { reasoningEffort: "high" } }), "invalid_input", /does not support modelParams\.reasoningEffort/],
    [claudeInput({ cliVersion: "2.1.279 (Claude Code)" }), "unsupported_version", /2\.1\.278/],
    [claudeInput({ cliVersion: 2 }), "unsupported_version", /2\.1\.278/],
    [claudeInput({ mode: "structured-readonly" }), "unsupported_mode", /structured-no-tools/],
    [claudeInput({ mode: "executor" }), "unsupported_mode", /structured-no-tools/],
    [claudeInput({ cli: cli("claude", "batch") }), "unsupported_launcher", /batch/],
    [claudeInput({ cli: cli("qwen") }), "unsupported_provider", /qwen/],
    [claudeInput({ cli: { ...cli("claude"), state: "unavailable" } }), "invalid_input", /available/],
    [claudeInput({ cwd: "relative" }), "invalid_input", /cwd/],
    [claudeInput({ model: "--dangerously-skip-permissions" }), "invalid_input", /model/],
    [claudeInput({ maxBudgetUsd: 0 }), "invalid_input", /maxBudgetUsd/],
    [claudeInput({ maxBudgetUsd: "1" }), "invalid_input", /maxBudgetUsd/],
    [claudeInput({ attemptDir: attemptDir() }), "invalid_input", /attemptDir/],
    [claudeInput({ session: { kind: "resume", id: "not-a-uuid" } }), "invalid_input", /UUID/],
    [claudeInput({ session: { kind: "new", id: SESSION, extra: 1 } }), "invalid_input", /session must be/],
    [claudeInput({ schema: { type: "object", additionalProperties: true } }), "invalid_input", /schema/],
    [claudeInput({ limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: 0 } }), "invalid_input", /limits\.timeoutMs/]
  ];
  for (const [input, reason, detail] of cases) {
    const started = startProviderTurn(input, NO_SPAWN);
    assert.equal(started.ok, false, JSON.stringify(detail.source));
    assert.equal(started.reason, reason, started.detail);
    assert.match(started.detail, detail);
    if (input.attemptDir) assert.deepEqual(fs.readdirSync(input.attemptDir), [], "no file created");
  }
});

test("claude ok: transport completed and contract verified -> completed, next turn allowed", async (t) => {
  const { r } = await run(t, "claude", "ok");
  assert.equal(r.outcome, "completed");
  assert.equal(r.nextTurnAllowed, true);
  assert.equal(r.sessionId, SESSION);
  assert.equal(r.report.status, "valid");
  assert.deepEqual(r.contract, {
    status: "verified", errors: [],
    expected: { sessionId: SESSION, tools: ["StructuredOutput"], mcpServers: [] },
    actual: { sessionId: SESSION, tools: ["StructuredOutput"], mcpServers: [] }
  });
});

test("claude contract violations: transport completed, provider turn not completed, no next turn", async (t) => {
  const cases = [
    ["tools_plus_bash", "system/init.tools differs", { tools: ["StructuredOutput", "Bash"], mcpServers: [] }],
    ["tools_nonempty", "system/init.tools differs", { tools: ["Bash"], mcpServers: [] }],
    ["extra_mcp", "system/init.mcp_servers has 1 entries", { tools: ["StructuredOutput"], mcpServers: ["extra-server"] }],
    ["init_no_tools", "system/init.tools absent", { tools: null, mcpServers: [] }],
    ["init_no_mcp", "system/init.mcp_servers absent", { tools: ["StructuredOutput"], mcpServers: null }],
    ["tools_nested", "system/init.tools has a non-string element", { tools: null, mcpServers: [] }],
    ["tools_string", "system/init.tools is not an array", { tools: null, mcpServers: [] }]
  ];
  for (const [mode, error, actual] of cases) {
    const { r } = await run(t, "claude", mode);
    assert.equal(r.transport.outcome, "completed", `${mode}: the transport alone would have passed`);
    assert.equal(r.outcome, "contract_violation", mode);
    assert.equal(r.nextTurnAllowed, false, mode);
    assert.equal(r.contract.status, "violated", mode);
    assert.ok(r.contract.errors.some((e) => e.startsWith(error)), `${mode}: ${JSON.stringify(r.contract.errors)}`);
    assert.deepEqual({ tools: r.contract.actual.tools, mcpServers: r.contract.actual.mcpServers }, actual, mode);
    assert.equal(JSON.stringify(r.contract).includes("connected"), false, "no MCP configuration in diagnostics");
  }
});

test("claude session mismatch or missing session id: failed, contract violated, no next turn", async (t) => {
  for (const [mode, error] of [["wrong_session", "system/init.session_id differs"], ["init_no_session", "system/init.session_id absent"]]) {
    const { r } = await run(t, "claude", mode);
    assert.equal(r.outcome, "failed", mode);
    assert.equal(r.nextTurnAllowed, false, mode);
    assert.equal(r.contract.status, "violated", mode);
    assert.ok(r.contract.errors.includes("session id does not match the expected or earlier one"), mode);
    assert.ok(r.contract.errors.some((e) => e.startsWith(error)), `${mode}: ${JSON.stringify(r.contract.errors)}`);
  }
});

test("codex: new thread and exact resume verified; schema file created only when the turn starts", async (t) => {
  const first = await run(t, "codex", "ok");
  assert.equal(first.r.outcome, "completed");
  assert.equal(first.r.contract.status, "verified");
  assert.match(first.r.sessionId, /^[0-9a-f-]{36}$/);
  const files = fs.readdirSync(first.input.attemptDir);
  assert.ok(files.some((f) => /^output-schema-.*\.json$/.test(f)), JSON.stringify(files));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.input.attemptDir, files.find((f) => f.startsWith("output-schema-"))), "utf8")), SCHEMA);

  const resumed = await run(t, "codex", "ok", { session: { kind: "resume", id: first.r.sessionId } });
  assert.equal(resumed.r.outcome, "completed");
  assert.equal(resumed.r.sessionId, first.r.sessionId);
  assert.deepEqual(resumed.r.contract.actual, { sessionId: first.r.sessionId });

  const wrong = await run(t, "codex", "wrong_session", { session: { kind: "resume", id: first.r.sessionId } });
  assert.equal(wrong.r.outcome, "failed");
  assert.equal(wrong.r.nextTurnAllowed, false);
  assert.ok(wrong.r.contract.errors.includes("thread.started.thread_id differs from the resumed thread"));
});

test("codex without thread_id: contract_violation even though the transport completed", async (t) => {
  const { r } = await run(t, "codex", "no_thread_id");
  assert.equal(r.transport.outcome, "completed");
  assert.equal(r.outcome, "contract_violation");
  assert.equal(r.nextTurnAllowed, false);
  assert.deepEqual(r.contract.errors, ["thread.started.thread_id absent"]);
});
