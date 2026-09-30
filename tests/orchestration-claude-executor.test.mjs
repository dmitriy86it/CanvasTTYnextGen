// Claude structured-edit (stage-6-contract.md §2-4): exact argv, the candidate gate, refusals before any file or
// process, and real turns through startProviderTurn / createProviderAgents on mock-claude. The mock emulates the CLI
// permission policy; these tests prove the adapter and the harness, not the real CLI's isolation.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROVIDER_MODES, buildProviderTurn, startProviderTurn } from "../src/main/services/orchestration/providers.ts";
import { createProviderAgents } from "../src/main/services/orchestration/agents.ts";
import { DEFAULT_TURN_LIMITS } from "../src/main/services/orchestration/turn.ts";
import { ProcLedger, assertNoneAlive } from "./fixtures/orchestration/proc-ledger.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCH = Object.freeze({ command: process.execPath, args: [path.join(ROOT, "src/orchestration/supervisor.mjs")], env: {} });
const NO_SPAWN = Object.freeze({ command: "/nonexistent/should-never-run", args: [], env: {} });
const FIXTURES = path.join(ROOT, "tests/fixtures/orchestration");
const MARK = `CTTYEXEC-${process.pid}`;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${MARK}-`)));
const STATE = path.join(TMP, "state");
fs.mkdirSync(STATE);
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SCHEMA = {
  type: "object",
  properties: { status: { type: "string" }, summary: { type: "string" }, sha256: { type: "string" }, memory: { type: "string" } },
  required: ["status", "summary"],
  additionalProperties: false
};
const SESSION = "22222222-3333-4444-8555-666666666666";
const EDIT_ARGS = [
  "--safe-mode", "--restricted",
  "--settings", '{"permissions":{"blockReadsOutsideWorkingDirectories":true}}',
  "--tools", "Read,Edit,Write,Glob,Grep",
  "--strict-mcp-config",
  "--allowedTools", "Read,Glob,Grep,Edit(/**)",
  "--disallowedTools", "mcp__*,Edit(/.git/**),Edit(/.claude/**)",
  "--disable-slash-commands",
  "--permission-mode", "dontAsk",
  "--permission-prompts", "none"
];

const EXEC = path.join(TMP, "claude-cli");
fs.writeFileSync(EXEC, `#!/bin/sh\nexec "${process.execPath}" "${path.join(FIXTURES, "mock-claude.mjs")}" "$@"\n`, { mode: 0o755 });
const cli = (provider = "claude", launcher = "native") => ({
  state: "available", provider, executable: EXEC, launcher,
  ...(launcher === "batch" ? { commandPrompt: "C:\\Windows\\System32\\cmd.exe" } : {}),
  environment: { PATH: process.env.PATH }, checked: []
});

let n = 0;
const newCopy = () => {
  const dir = fs.mkdtempSync(path.join(TMP, "copy-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, "existing.txt"), "old\n");
  return dir;
};
const mockEnv = (mode, ledgerFile) => ({ CTTYEXP: MARK, MOCK_MODE: mode, MOCK_STATE: STATE, MOCK_LEDGER: ledgerFile, LANG: "C" });
const FAST = {
  limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: 20_000, stdoutGraceMs: 500 },
  supervisor: { graceIntMs: 300, graceTermMs: 300, leftoverMs: 300 }
};
const editInput = (extra = {}) => ({
  cli: cli(), cliVersion: "2.1.280 (Claude Code)", mode: "structured-edit", candidate: true, cwd: TMP, schema: SCHEMA,
  env: { LANG: "C" }, task: "task", session: { kind: "new", id: SESSION }, ...extra
});
const b64 = (s) => Buffer.from(s).toString("base64");

async function finish(t, started, ledgerFile) {
  const r = await started.result;
  const ledger = new ProcLedger(ledgerFile);
  ledger.track(r.transport.pids.supervisor, "supervisor");
  ledger.track(r.transport.pids.pgid, "group", { group: true });
  t.diagnostic(`outcome=${r.outcome} transport=${r.transport.outcome} contract=${r.contract.status} ${JSON.stringify(r.contract.errors)}`);
  assert.equal(r.nextTurnAllowed, r.outcome === "completed");
  assert.equal(r.transport.process.groupCleared, true);
  await assertNoneAlive(t, ledger, { mark: MARK });
  return r;
}

async function run(t, mode, extra = {}) {
  const ledgerFile = path.join(TMP, `ledger-${++n}.jsonl`);
  const started = startProviderTurn(editInput({ ...FAST, ...extra, env: mockEnv(mode, ledgerFile) }), LAUNCH);
  assert.equal(started.ok, true, started.detail);
  return finish(t, started, ledgerFile);
}

const toolResults = (r) => r.transport.history.filter((f) => f.kind === "event" && f.type === "user")
  .flatMap((f) => f.value.message.content).filter((c) => c.type === "tool_result");

test("PROVIDER_MODES: modes per provider; no-tools stays 2.1.278 only, structured-edit is a 2.1.280/2.1.281 candidate", () => {
  assert.deepEqual(PROVIDER_MODES.codex.map((m) => [m.mode, m.status, [...m.versions]]), [["structured-readonly", "proven", ["0.155.1"]]]);
  assert.deepEqual(PROVIDER_MODES.claude.map((m) => [m.mode, m.status, [...m.versions]]), [
    ["structured-no-tools", "proven", ["2.1.278"]],
    ["structured-edit", "candidate", ["2.1.280", "2.1.281"]]
  ]);
  assert.ok(Object.isFrozen(PROVIDER_MODES.claude) && Object.isFrozen(PROVIDER_MODES.claude[1].versions));
});

test("structured-edit argv: exact sequence, no forbidden flags", () => {
  const built = buildProviderTurn(editInput({ model: "model-b", maxBudgetUsd: 0.5 }));
  assert.equal(built.ok, true, built.detail);
  assert.deepEqual(built.spec.argv, [
    EXEC, "-p", "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify(SCHEMA),
    ...EDIT_ARGS, "--max-budget-usd", "0.5", "--model", "model-b", "--session-id", SESSION
  ]);
  assert.equal(built.spec.attemptDir, undefined);
  assert.deepEqual(buildProviderTurn(editInput({ session: { kind: "resume", id: SESSION } })).spec.argv.slice(-2), ["--resume", SESSION]);
  const fresh = buildProviderTurn(editInput({ session: { kind: "new" } }));
  assert.deepEqual(fresh.spec.argv.slice(1, -2), ["-p", "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify(SCHEMA), ...EDIT_ARGS]);
  for (const argv of [built.spec.argv, fresh.spec.argv]) {
    for (const bad of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--add-dir", "--mcp-config",
      "--plugin-dir", "--plugin-url", "--agents", "--bare", "bypassPermissions", "auto", "acceptEdits"]) {
      assert.ok(!argv.includes(bad), bad);
    }
    assert.ok(!/Bash|WebFetch|WebSearch/.test(argv[argv.indexOf("--tools") + 1]));
  }
});

test("candidate gate and refusals happen before any file or process", () => {
  const cases = [
    [editInput({ candidate: undefined }), "unproven_mode", /candidate/],
    [editInput({ candidate: false }), "unproven_mode", /candidate/],
    [editInput({ candidate: "true" }), "invalid_input", /candidate must be a boolean/],
    [editInput({ cliVersion: "2.1.278 (Claude Code)" }), "unsupported_version", /2\.1\.280/],
    [editInput({ mode: "structured-no-tools", cliVersion: "2.1.280 (Claude Code)" }), "unsupported_version", /2\.1\.278/],
    [editInput({ cli: cli("claude", "batch") }), "unsupported_launcher", /batch/],
    [editInput({ attemptDir: TMP }), "invalid_input", /attemptDir/],
    [editInput({ mode: "structured-edit", cli: cli("codex"), cliVersion: "codex-cli 0.155.1" }), "unsupported_mode", /structured-readonly/],
    [editInput({ mode: "executor" }), "unsupported_mode", /structured-no-tools, structured-edit/]
  ];
  for (const [input, reason, detail] of cases) {
    const started = startProviderTurn(input, NO_SPAWN);
    assert.equal(started.ok, false, detail.source);
    assert.equal(started.reason, reason, started.detail);
    assert.match(started.detail, detail);
  }
  // candidate: true changes nothing for a proven mode
  const proven = buildProviderTurn(editInput({ mode: "structured-no-tools", cliVersion: "2.1.278 (Claude Code)" }));
  const plain = buildProviderTurn(editInput({ mode: "structured-no-tools", cliVersion: "2.1.278 (Claude Code)", candidate: undefined }));
  assert.equal(proven.ok, true, proven.detail);
  assert.deepEqual(proven.spec.argv, plain.spec.argv);
});

test("edit inside cwd: file written and changed, structured report, contract verified with permissionMode", async (t) => {
  const cwd = newCopy();
  const task = `do it\nMOCK_WRITE new/dir/created.txt ${b64("hello\n")}\nMOCK_WRITE existing.txt ${b64("new\n")}\n`;
  const r = await run(t, "ok", { cwd, task });
  assert.equal(r.outcome, "completed");
  assert.equal(r.report.status, "valid");
  assert.equal(r.report.value.status, "done");
  assert.equal(fs.readFileSync(path.join(cwd, "new/dir/created.txt"), "utf8"), "hello\n");
  assert.equal(fs.readFileSync(path.join(cwd, "existing.txt"), "utf8"), "new\n");
  assert.deepEqual(toolResults(r).map((c) => c.is_error ?? false), [false, false]);
  assert.deepEqual(r.contract, {
    status: "verified", errors: [],
    expected: { sessionId: SESSION, tools: ["Read", "Edit", "Write", "Glob", "Grep", "StructuredOutput"], mcpServers: [], permissionMode: "dontAsk" },
    actual: { sessionId: SESSION, tools: ["Read", "Edit", "Write", "Glob", "Grep", "StructuredOutput"], mcpServers: [], permissionMode: "dontAsk" }
  });
});

test("writes outside cwd, into .git/ or .claude/ are denied by the mock and create nothing", async (t) => {
  const cwd = newCopy();
  const outside = path.join(TMP, `outside-${process.pid}.txt`);
  const rels = [`../${path.basename(outside)}`, outside, ".git/hooks/pre-commit", ".claude/settings.json"];
  const r = await run(t, "ok", { cwd, session: { kind: "new" }, task: rels.map((rel) => `MOCK_WRITE ${rel} ${b64("x")}`).join("\n") });
  assert.equal(r.outcome, "completed");
  assert.deepEqual(toolResults(r).map((c) => [c.is_error, c.content]), rels.map(() => [true, "denied"]));
  assert.equal(fs.existsSync(outside), false);
  assert.deepEqual(fs.readdirSync(path.join(cwd, ".git")), []);
  assert.equal(fs.existsSync(path.join(cwd, ".claude")), false);
});

test("resume continues the same session in structured-edit", async (t) => {
  const cwd = newCopy();
  const id = "33333333-4444-4555-8666-777777777777";
  const first = await run(t, "ok", { cwd, session: { kind: "new", id }, task: "WORD=kiwi" });
  assert.equal(first.outcome, "completed");
  const second = await run(t, "ok", { cwd, session: { kind: "resume", id }, task: `MOCK_WRITE second.txt ${b64("2")}` });
  assert.equal(second.outcome, "completed");
  assert.equal(second.sessionId, id);
  assert.equal(second.report.value.memory, "kiwi");
  assert.equal(fs.readFileSync(path.join(cwd, "second.txt"), "utf8"), "2");
});

test("stop during edit_slow: stopped, process group cleared", async (t) => {
  const ledgerFile = path.join(TMP, `ledger-${++n}.jsonl`);
  const started = startProviderTurn(editInput({ ...FAST, cwd: newCopy(), session: { kind: "new" }, env: mockEnv("edit_slow", ledgerFile) }), LAUNCH);
  assert.equal(started.ok, true, started.detail);
  const deadline = Date.now() + 15_000;
  while (!(fs.existsSync(ledgerFile) && fs.readFileSync(ledgerFile, "utf8").includes("edit_started"))) {
    assert.ok(Date.now() < deadline, "edit_slow never started");
    await new Promise((r) => setTimeout(r, 50));
  }
  started.stop();
  const r = await finish(t, started, ledgerFile);
  assert.equal(r.outcome, "stopped");
  assert.equal(r.transport.stopCause, "user");
});

test("init violations in structured-edit: contract_violation, no next turn", async (t) => {
  const cases = [
    ["tools_plus_bash", "system/init.tools differs"],
    ["extra_mcp", "system/init.mcp_servers has 1 entries"],
    ["init_no_tools", "system/init.tools absent"],
    ["init_no_mcp", "system/init.mcp_servers absent"],
    ["permission_mode_other", "system/init.permissionMode is not"]
  ];
  for (const [mode, error] of cases) {
    const r = await run(t, mode, { cwd: newCopy(), session: { kind: "new" } });
    assert.equal(r.transport.outcome, "completed", mode);
    assert.equal(r.outcome, "contract_violation", mode);
    assert.ok(r.contract.errors.some((e) => e.startsWith(error)), `${mode}: ${JSON.stringify(r.contract.errors)}`);
  }
  const other = await run(t, "permission_mode_other", { cwd: newCopy(), session: { kind: "new" } });
  assert.equal(other.contract.actual.permissionMode, "acceptEdits");
  // absent permissionMode is recorded as null, not a violation
  const absent = await run(t, "init_no_permission_mode", { cwd: newCopy(), session: { kind: "new" } });
  assert.equal(absent.outcome, "completed");
  assert.equal(absent.contract.actual.permissionMode, null);
});

test("createProviderAgents: executor only with a Claude executor config and allowCandidate", async (t) => {
  const lead = { cli: { ...cli("codex") }, cliVersion: "codex-cli 0.155.1", env: { LANG: "C" } };
  const cwd = newCopy();
  const req = { purpose: "execute", role: "executor", cwd, task: `MOCK_WRITE agent.txt ${b64("a")}`, schema: SCHEMA, sessionId: null, timeoutMs: 20_000 };
  const ledgerFile = path.join(TMP, `ledger-${++n}.jsonl`);
  const executor = { cli: cli(), cliVersion: "2.1.280 (Claude Code)", env: mockEnv("ok", ledgerFile) };

  const none = createProviderAgents({ lead, launch: NO_SPAWN, attemptRoot: TMP }).prepare(req);
  assert.deepEqual([none.ok, none.reason], [false, "unsupported_capability"]);
  const gated = createProviderAgents({ lead, executor, launch: NO_SPAWN, attemptRoot: TMP }).prepare(req);
  assert.deepEqual([gated.ok, gated.reason], [false, "unavailable"]);
  assert.match(gated.detail, /^unproven_mode: /);
  const codexExecutor = createProviderAgents({ lead, executor: { ...executor, cli: cli("codex"), allowCandidate: true }, launch: NO_SPAWN, attemptRoot: TMP }).prepare(req);
  assert.deepEqual([codexExecutor.ok, codexExecutor.reason], [false, "unsupported_capability"]);
  const oldCli = createProviderAgents({ lead, executor: { ...executor, cliVersion: "2.1.278 (Claude Code)", allowCandidate: true }, launch: NO_SPAWN, attemptRoot: TMP }).prepare(req);
  assert.match(oldCli.detail, /^unsupported_version: /);

  const agents = createProviderAgents({ lead, executor: { ...executor, allowCandidate: true }, launch: LAUNCH, attemptRoot: TMP });
  const prepared = agents.prepare(req);
  assert.equal(prepared.ok, true, prepared.detail);
  assert.deepEqual([prepared.provider, prepared.mode], ["claude", "structured-edit"]);
  const turn = prepared.start();
  assert.match(turn.sessionId, /^[0-9a-f-]{36}$/);
  const r = await finish(t, { result: turn.result }, ledgerFile);
  assert.equal(r.outcome, "completed");
  assert.equal(r.sessionId, turn.sessionId);
  assert.equal(fs.readFileSync(path.join(cwd, "agent.txt"), "utf8"), "a");

  const resumed = agents.prepare({ ...req, sessionId: turn.sessionId, task: "again" }).start();
  assert.equal(resumed.sessionId, turn.sessionId);
  assert.equal((await finish(t, { result: resumed.result }, ledgerFile)).outcome, "completed");
});

test("MOCK_SCRIPT: answers and writes come from the script directory by call number", async (t) => {
  const script = fs.mkdtempSync(path.join(TMP, "script-"));
  fs.writeFileSync(path.join(script, "1.json"), JSON.stringify({ status: "scripted", summary: "one" }));
  fs.writeFileSync(path.join(script, "1.writes.json"), JSON.stringify([{ rel: "from-script.txt", base64: b64("s") }]));
  fs.writeFileSync(path.join(script, "2.json"), JSON.stringify({ status: "scripted", summary: "two" }));
  const cwd = newCopy();
  for (const summary of ["one", "two"]) {
    const ledgerFile = path.join(TMP, `ledger-${++n}.jsonl`);
    const started = startProviderTurn(editInput({ ...FAST, cwd, session: { kind: "new" }, env: { ...mockEnv("ok", ledgerFile), MOCK_SCRIPT: script } }), LAUNCH);
    const r = await finish(t, started, ledgerFile);
    assert.equal(r.outcome, "completed");
    assert.deepEqual(r.report.value, { status: "scripted", summary });
  }
  assert.equal(fs.readFileSync(path.join(cwd, "from-script.txt"), "utf8"), "s");
  assert.equal(fs.readFileSync(path.join(script, "counter"), "utf8"), "2");
});
