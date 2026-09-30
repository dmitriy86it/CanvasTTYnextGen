// probe-series.mjs on the mocks, run as a child process (like a user would). Run: node --test probe-series.test.mjs
// Fake `codex`/`claude` that write a marker file sit first on PATH in every run: the marker must never appear.
// Processes: pids from each probe's report + the mocks' ledger (MOCK_LEDGER) via proc-ledger.mjs. Never runs --real.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPlan, expectedClaudeInit, FROM_B1, TOKEN_RE } from "./probe-plan.mjs";
import { ProcLedger, assertNoneAlive, describe } from "./proc-ledger.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SCRIPT = path.join(HERE, "probe-series.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "CTTYEXP-series-"));
const MARKER = path.join(TMP, "real-cli-started");
const FAKEBIN = path.join(TMP, "fakebin");
fs.mkdirSync(FAKEBIN);
for (const c of ["codex", "claude"]) fs.writeFileSync(path.join(FAKEBIN, c), `#!/bin/sh\necho ${c} >> '${MARKER}'\nexit 0\n`, { mode: 0o755 });
const ENV = { ...process.env, PATH: `${FAKEBIN}:${process.env.PATH}` };
delete ENV.CANVASTTY_REAL_PROBES;
const T = { timeout: 60_000 };
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function series(t, args, env = {}) {
  const base = fs.mkdtempSync(path.join(TMP, "base-"));
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--base", base], { env: { ...ENV, ...env }, encoding: "utf8", timeout: 60_000 });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch {}
  if (report?.ledger) {
    const l = new ProcLedger(report.ledger);
    for (const p of report.probes) if (p.pids) { l.track(p.pids.supervisor, `${p.id}-supervisor`); l.track(p.pids.pgid, `${p.id}-group`, { group: true }); }
    t.diagnostic(`processes: ${describe(await assertNoneAlive(t, l))}`);
  }
  assert.equal(fs.existsSync(MARKER), false, "a real CLI (fake on PATH) was started");
  t.diagnostic(`rc=${r.status} ${r.stderr.trim().split("\n").join(" | ")}`);
  return { rc: r.status, report, stdout: r.stdout, base };
}
const ran = (rep) => rep.probes.filter((p) => p.ran).map((p) => p.id);
const probe = (rep, id) => rep.probes.find((p) => p.id === id);

test("plan: exact argv, tokens only in first-turn tasks, expected claude init from flags", () => {
  const plan = buildPlan({ repo: "/r", schemaFile: "/s.json", token: "t1", token2: "t2", u1: "u-1" });
  assert.deepEqual(plan.map((p) => p.id), ["B1", "B2", "K1", "K2"]);
  assert.deepEqual(plan[0].argv, ["codex", "exec", "--json", "--ignore-user-config", "--ignore-rules", "-m", "gpt-6-astra", "-c", 'model_reasoning_effort="high"',
    "-c", 'approval_policy="never"', "--output-schema", "/s.json", "-o", "{REPORT_FILE}", "-s", "read-only", "-C", "/r", "-"]);
  assert.deepEqual(plan[1].argv.slice(-4), ["-c", 'sandbox_mode="read-only"', FROM_B1, "-"]);
  assert.deepEqual(plan[2].argv.slice(-2), ["--session-id", "u-1"]);
  assert.deepEqual(plan[3].argv.slice(0, -2), plan[2].argv.slice(0, -2));
  assert.deepEqual(plan[3].argv.slice(-2), ["--resume", "u-1"]);
  for (const f of ["--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(plan[2].argv.includes(f), f);
  assert.equal(plan[2].argv[plan[2].argv.indexOf("--tools") + 1], "");
  assert.equal(plan[2].argv.includes("--model"), false, "claude: account default model");
  assert.equal(TOKEN_RE.exec(plan[0].task)[1], "t1");
  assert.equal(TOKEN_RE.exec(plan[2].task)[1], "t2");
  for (const p of [plan[1], plan[3]]) assert.ok(!TOKEN_RE.test(p.task) && !p.task.includes("t1") && !p.task.includes("t2"), p.id);
  assert.deepEqual(plan.map((p) => p.expectAnswer), ["ok", "resumed", "ok", "resumed"]);
  // Claude Code 2.1.278: --tools "" + --json-schema -> exactly StructuredOutput (from the real K1 transcript; to be confirmed by init)
  assert.deepEqual(plan[2].expectInit, { tools: ["StructuredOutput"], mcp_servers: [], session_id: "u-1" });
  assert.deepEqual(plan[3].expectInit, plan[2].expectInit);
  assert.deepEqual(expectedClaudeInit(["--tools", "", "--strict-mcp-config"]), { tools: [], mcp_servers: [] });
  // no expectation is claimed for other combinations
  assert.throws(() => expectedClaudeInit(["--tools", "Read,Bash", "--strict-mcp-config"]), /only --tools ""/);
  assert.throws(() => expectedClaudeInit(["--tools", "", "--json-schema", "{}"]), /strict-mcp-config/);
  assert.throws(() => expectedClaudeInit(["--tools", "", "--strict-mcp-config", "--mcp-config", "x"]), /strict-mcp-config/);
});

test("mock: all four ok -> rc 0, report on stdout and in series-report.json, only mocks ran", T, async (t) => {
  const { rc, report } = await series(t, []);
  assert.equal(rc, 0, JSON.stringify(report?.probes.map((p) => [p.id, p.failed])));
  assert.equal(report.mode, "mock");
  assert.deepEqual(report.versions, { codex: "mock", claude: "mock" });
  assert.deepEqual(ran(report), ["B1", "B2", "K1", "K2"]);
  for (const p of report.probes) {
    assert.equal(p.ok, true, p.id);
    assert.deepEqual(p.failed, []);
    assert.equal(p.delivery, "ok");
    assert.equal(p.tokenMatch, true);
    assert.equal(p.answerOk, true, `${p.id}: answer "ok" (B1/K1) / "resumed" (B2/K2)`);
  }
  assert.deepEqual(probe(report, "B1").model, { requested: "gpt-6-astra" });
  assert.deepEqual(probe(report, "K1").model, { reported: "mock-claude" });
  for (const id of ["K1", "K2"]) {
    const k = probe(report, id);
    // lists are recorded on success too; absent vs empty is explicit
    assert.deepEqual(k.init.tools, { expected: ["StructuredOutput"], actual: ["StructuredOutput"], present: true, ok: true });
    assert.deepEqual(k.init.mcp_servers, { expected: [], actual: [], present: true, ok: true });
    assert.equal(k.init.session_id.ok, true);
    assert.ok(k.criteria.length >= 13 && k.criteria.every((c) => c.ok), JSON.stringify(k.criteria));
    assert.equal(k.cliVersion, "mock");
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(report.probeDir, "series-report.json"), "utf8")), report);
  const labels = new ProcLedger(report.ledger).read().map((e) => e.label).filter((l) => l.startsWith("mock-")).sort();
  assert.deepEqual(labels, ["mock-claude", "mock-claude", "mock-codex", "mock-codex"]);
  const repo = path.join(report.probeDir, "repo");
  assert.deepEqual(fs.readdirSync(repo).sort(), [".git", "README.md"]);
});

for (const [modes, failedId, why] of [
  ["B1=fail", "B1", /^outcome=completed: failed$/],
  ["B2=fail", "B2", /^outcome=completed: failed$/],
  ["B2=wrong_token", "B2", /^token: mismatch$/],
  ["B2=no_context", "B2", /^token: mismatch$/],
  ["B2=wrong_session", "B2", /^sessionId: mismatch$/],
  ["K2=no_context", "K2", /^token: mismatch$/],
  ["K1=tools_nonempty", "K1", /^init\.tools exact: unexpected$/],
  ["K1=tools_plus_bash", "K1", /^init\.tools exact: unexpected$/],
  ["K1=extra_mcp", "K1", /^init\.mcp_servers exact: unexpected$/],
  ["K1=init_no_tools", "K1", /^init\.tools exact: field absent$/],
  ["K1=wrong_answer", "K1", /^answer: mismatch$/],
  ["B1=wrong_answer", "B1", /^answer: mismatch$/],
]) {
  test(`mock ${modes}: ${failedId} fails (${why.source}), later probes never start`, T, async (t) => {
    const { rc, report } = await series(t, ["--mock-modes", modes]);
    assert.equal(rc, 1);
    const order = ["B1", "B2", "K1", "K2"];
    assert.deepEqual(ran(report), order.slice(0, order.indexOf(failedId) + 1));
    const f = probe(report, failedId);
    assert.equal(f.ok, false);
    assert.ok(f.failed.some((x) => why.test(x)), JSON.stringify(f.failed));
    for (const p of report.probes.filter((p) => !p.ran)) assert.equal(p.skipped, `${failedId} failed`);
  });
}

test("review scenario: K1 with an 8 MiB task and a CLI that never reads stdin -> delivery_failed, not ok", T, async (t) => {
  const { rc, report } = await series(t, ["--mock-modes", "K1=no_read_stdin", "--mock-task-bytes", "K1=8388608"]);
  assert.equal(rc, 1);
  const k1 = probe(report, "K1");
  assert.equal(k1.outcome, "delivery_failed");
  assert.notEqual(k1.delivery, "ok");
  assert.deepEqual(ran(report), ["B1", "B2", "K1"]);
});

test("review scenario: B1 result then hang with --timeout-ms 500 -> timeout, not ok", T, async (t) => {
  const { rc, report } = await series(t, ["--mock-modes", "B1=result_then_hang", "--timeout-ms", "B1=500"]);
  assert.equal(rc, 1);
  const b1 = probe(report, "B1");
  assert.equal(b1.outcome, "timeout");
  assert.equal(b1.stopCause, "timeout");
  assert.deepEqual(ran(report), ["B1"]);
});

test("dry-run starts nothing: no ledger, no marker, env names only, no tokens, placeholder for B2's id", T, async (t) => {
  for (const target of ["--mock", "--real"]) {
    const { rc, report, stdout } = await series(t, ["--dry-run", target]);
    assert.equal(rc, 0);
    assert.equal(report.mode, "dry-run");
    assert.equal(fs.existsSync(path.join(report.probeDir, "mock-ledger.jsonl")), false);
    assert.equal(fs.existsSync(path.join(report.probeDir, "repo", ".git")), false, "no git either");
    assert.equal(report.probes.length, 4);
    for (const p of report.probes) assert.ok(p.env.every((n) => /^[A-Z_]+$/.test(n)), p.env.join());
    // node and the mocks may live under HOME; nothing else may
    assert.equal(stdout.replaceAll(process.execPath, "").replaceAll(HERE, "").includes(os.homedir() + "/"), false, "no real HOME value");
    assert.ok(probe(report, "B1").task.includes("TOKEN=<TOKEN>"));
    assert.ok(probe(report, "B2").argv.includes(FROM_B1));
    assert.equal(probe(report, "K1").argv[0], target === "--mock" ? process.execPath : "claude");
  }
});

test("--real refuses before resolving anything: no env / wrong env / mock overrides; marker never created", T, async (t) => {
  for (const [args, env] of [
    [["--real"], {}],
    [["--real"], { CANVASTTY_REAL_PROBES: "B1" }],
    [["--real"], { CANVASTTY_REAL_PROBES: "B1,B2,K1,K2 " }],
    [["--real", "--mock-modes", "B1=ok"], { CANVASTTY_REAL_PROBES: "B1,B2,K1,K2" }],
    [["--real", "--mock"], { CANVASTTY_REAL_PROBES: "B1,B2,K1,K2" }],
  ]) {
    const { rc, report, base } = await series(t, args, env);
    assert.notEqual(rc, 0, args.join(" "));
    assert.equal(report, null);
    assert.deepEqual(fs.readdirSync(base), [], "no probe dir created");
  }
});

test("K1 failures keep the actual lists: StructuredOutput+Bash, an extra MCP server (name only), absent tools field", T, async (t) => {
  const k1 = async (mode) => probe((await series(t, ["--series", "K1,K2", "--mock-modes", `K1=${mode}`])).report, "K1");
  const plus = await k1("tools_plus_bash");
  assert.deepEqual(plus.init.tools, { expected: ["StructuredOutput"], actual: ["StructuredOutput", "Bash"], present: true, ok: false });
  const mcp = await k1("extra_mcp");
  assert.deepEqual(mcp.init.mcp_servers, { expected: [], actual: ["extra-server"], present: true, ok: false });
  assert.equal(JSON.stringify(mcp).includes("connected"), false, "no server details, names only");
  const absent = await k1("init_no_tools");
  assert.deepEqual(absent.init.tools, { expected: ["StructuredOutput"], actual: null, present: false, ok: false });
  for (const k of [plus, mcp, absent]) assert.ok(k.criteria.some((c) => !c.ok) && k.criteria.some((c) => c.ok), "every criterion recorded");
});

test("--series K1,K2 (mock): only claude runs (no codex, not even --version), K2 continues K1's new session", T, async (t) => {
  const { rc, report } = await series(t, ["--series", "K1,K2"]);
  assert.equal(rc, 0, JSON.stringify(report?.probes.map((p) => [p.id, p.failed])));
  assert.equal(report.series, "K1,K2");
  assert.deepEqual(report.probes.map((p) => p.id), ["K1", "K2"]);
  assert.deepEqual(report.versions, { claude: "mock" });
  const labels = new ProcLedger(report.ledger).read().map((e) => e.label).filter((l) => l.startsWith("mock-"));
  assert.deepEqual(labels, ["mock-claude", "mock-claude"]);
  assert.deepEqual(fs.readdirSync(path.join(report.probeDir, "attempts")).sort(), ["K1", "K2"]);
  assert.equal(probe(report, "K2").init.session_id.actual, probe(report, "K1").init.session_id.actual);
});

test("--series K1,K2: K1 failure -> K2 never starts", T, async (t) => {
  const { rc, report } = await series(t, ["--series", "K1,K2", "--mock-modes", "K1=wrong_answer"]);
  assert.equal(rc, 1);
  assert.deepEqual(ran(report), ["K1"]);
  assert.equal(probe(report, "K2").skipped, "K1 failed");
});

test("gate: the env must equal the chosen series exactly; old full-series permission does not cover K1,K2", T, async (t) => {
  for (const [args, env] of [
    [["--real", "--series", "K1,K2"], { CANVASTTY_REAL_PROBES: "B1,B2,K1,K2" }],
    [["--real", "--series", "K1,K2"], { CANVASTTY_REAL_PROBES: "K1" }],
    [["--real", "--series", "K1,K2"], { CANVASTTY_REAL_PROBES: "K2,K1" }],
    [["--real"], { CANVASTTY_REAL_PROBES: "K1,K2" }],
    [["--real", "--series", "K1"], { CANVASTTY_REAL_PROBES: "K1" }],
    [["--series", "B1,K1"], {}],
  ]) {
    const { rc, report, base } = await series(t, args, env);
    assert.notEqual(rc, 0, `${args.join(" ")} ${JSON.stringify(env)}`);
    assert.equal(report, null);
    assert.deepEqual(fs.readdirSync(base), [], "no probe dir created");
  }
});

test("dry-run --series K1,K2 --real: two claude probes, full argv, env names only", T, async (t) => {
  const { rc, report } = await series(t, ["--dry-run", "--real", "--series", "K1,K2"]);
  assert.equal(rc, 0);
  assert.equal(report.series, "K1,K2");
  assert.deepEqual(report.probes.map((p) => [p.id, p.argv[0]]), [["K1", "claude"], ["K2", "claude"]]);
  assert.deepEqual(probe(report, "K1").expectInit.tools, ["StructuredOutput"]);
  assert.equal(probe(report, "K1").timeoutMs, 180000);
  assert.equal(probe(report, "K2").timeoutMs, 120000);
  const k1 = probe(report, "K1").argv;
  assert.equal(k1[k1.indexOf("--max-budget-usd") + 1], "0.25");
});
