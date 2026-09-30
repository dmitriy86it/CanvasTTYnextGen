// The whole orchestration cycle (stage-5-contract.md) on a temporary project: test agents instead of CLIs, and the real
// Store, managed copy (stage 3), sandboxed check runner (stage 4) and checkpoints. The agents only ever edit the copy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createProviderAgents } from "../src/main/services/orchestration/agents.ts";
import { checkPreparedDeps, createRegistry } from "../src/main/services/orchestration/checks.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createOrchestrationService } from "../src/main/services/orchestration/orchestrationService.ts";
import { readRun } from "../src/main/services/orchestration/store.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "orchestration", "check-project");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const SKIP = { skip: process.platform !== "darwin" && "checks run only in the macOS sandbox" };

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-svc-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "");
const g = (cwd, ...args) => execFileSync(GIT, args, {
  cwd, encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
}).trim();
const sha = (b) => createHash("sha256").update(b).digest("hex");

const registry = createRegistry([
  { id: "unit", title: "unit tests", executable: NODE, argv: ["--test", "tests/sum.test.mjs"], timeoutMs: 120_000, maxOutputBytes: 65_536 }
]);

let n = 0;
function project() {
  const src = path.join(TMP, `src-${++n}`);
  fs.cpSync(FIXTURE, src, { recursive: true });
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fixture");
  const deps = checkPreparedDeps({
    lockfileRelPath: "package-lock.json", lockfileSha256: sha(fs.readFileSync(path.join(src, "package-lock.json"))),
    nodeModulesPath: path.join(src, "node_modules")
  });
  return { src, root: path.join(TMP, `root-${n}`), deps };
}

function service(p, agents, extra = {}) {
  return createOrchestrationService({ root: p.root, gitPath: GIT, agents, checks: { registry, deps: p.deps, launch: LAUNCH }, ...extra });
}
const goal = (extra = {}) => ({ text: "extend sum", criteria: ["sum works"], checks: ["unit"], ...extra });
const cmd = (run, command) => run.command({ commandId: randomUUID(), expectedRevision: run.view().revision, command });
// Waits for fn() while the run makes progress. The bound is on a run that stopped changing (a hang, or a state the
// condition can never come from), not on the whole path: sandboxed checks on a loaded machine make a correct run take
// minutes, and that says nothing about the orchestration.
async function until(run, fn, quietMs = 60_000) {
  let last = Date.now();
  const off = run.onChange(() => { last = Date.now(); });
  try {
    for (; Date.now() - last < quietMs; await new Promise((r) => setTimeout(r, 25))) if (fn()) return;
  } finally { off(); }
  const v = run.view();
  throw new Error(`condition not reached: the run did not change for ${quietMs} ms; now ${v.status}${v.reason ? `(${v.reason})` : ""}`);
}
const journal = async (p, run) => (await readRun(p.root, run.runId)).state;
const writeSum = (body) => (g) => fs.writeFileSync(g.path("src/sum.mjs"), body);
const GOOD = "export const sum = (...xs) => xs.reduce((a, b) => a + b, 0);\n// improved\n";
const BAD = "export const sum = () => 42;\n";

test("automatic start: plan → executor → checks → review → checkpoint per stage → final review → completed", SKIP, async () => {
  const p = project();
  const agents = createTestAgents({
    plan: { report: plan("stage one", "stage two") },
    execute: (_req, i) => ({ report: executed(), edit: (c) => fs.writeFileSync(c.path(`src/stage-${i}.mjs`), `export const s = ${i};\n`) }),
    review: { report: review("accept") },
    final_review: { report: review("complete") }
  });
  const run = await service(p, agents).createRun({ source: p.src, goal: goal() });
  await until(run, () => run.view().status === "completed");
  await run.idle();

  const st = await journal(p, run);
  assert.equal(st.status, "completed");
  assert.deepEqual(agents.log.map((e) => e.purpose), ["plan", "execute", "review", "execute", "review", "final_review"]);
  assert.equal(st.orch.plan.stageCount, 2);
  assert.deepEqual(Object.keys(st.workspace.checkpoints), ["1", "2"], "each accepted stage has its checkpoint");
  assert.equal(g(p.src, "rev-parse", `refs/canvastty/${run.runId}/stage-2`), st.workspace.checkpoints["2"].commit);
  assert.equal(g(p.src, "rev-parse", "main"), g(p.src, "rev-parse", "HEAD"), "the user's branch did not move");
  const checks = Object.values(st.checks);
  assert.ok(checks.length >= 2 && checks.every((c) => c.status === "passed"));
  assert.equal(Object.keys(st.orch.assessed).length, checks.length, "every check result is tied to a state key");
  // the final phase reused the check on the last stage's state: same key, no new run
  assert.equal(checks.length, 2);
  const kinds = st.orch.reviews.map((r) => r.verdict);
  assert.deepEqual(kinds, ["accept", "accept", "complete"]);
  assert.ok(agents.log.every((e) => e.task.includes("sum works")), "the fixed criteria go into every task");
  await run.close();
});

test("reviewPlan stops after the plan; resume continues to completion", SKIP, async () => {
  const p = project();
  const agents = createTestAgents({
    plan: { report: plan("only stage") },
    execute: { report: executed(), edit: writeSum(GOOD) },
    review: { report: review("accept") },
    final_review: { report: review("complete") }
  });
  const run = await service(p, agents).createRun({ source: p.src, goal: goal({ reviewPlan: true }) });
  await until(run, () => run.view().status === "paused");
  await run.idle();
  assert.deepEqual([run.view().status, run.view().reason], ["paused", "plan_review"]);
  assert.deepEqual(agents.log.map((e) => e.purpose), ["plan"], "nothing ran after the plan");
  assert.equal((await cmd(run, { kind: "resume" })).status, "accepted");
  await until(run, () => run.view().status === "completed");
  await run.close();
});

test("a failing check sends the stage back to the executor; the fix is accepted", SKIP, async () => {
  const p = project();
  const agents = createTestAgents({
    plan: { report: plan("change sum") },
    execute: (_req, i) => ({ report: executed(i === 1 ? "claims done" : "fixed"), edit: writeSum(i === 1 ? BAD : GOOD) }),
    // the lead is shown the real check results; it asks for a fix while the check fails
    review: (req) => ({ report: req.task.includes("unit: failed") ? review("fix", ["sum is broken"]) : review("accept") }),
    final_review: { report: review("complete") }
  });
  const run = await service(p, agents).createRun({ source: p.src, goal: goal() });
  await until(run, () => ["completed", "paused", "failed"].includes(run.view().status));
  await run.idle();
  const st = await journal(p, run);
  assert.equal(st.status, "completed", `reason ${st.pausedReason}`);
  const statuses = Object.values(st.checks).map((c) => c.status);
  assert.deepEqual(statuses.slice(0, 2), ["failed", "passed"]);
  assert.deepEqual(st.orch.reviews.map((r) => r.verdict), ["fix", "accept", "complete"]);
  assert.ok(agents.log[3].task.includes("sum is broken"), "the executor sees the lead's findings");
  await run.close();
});

test("the lead cannot accept a stage while a required check fails; self-reports confirm nothing", SKIP, async () => {
  const p = project();
  const agents = createTestAgents({
    plan: { report: plan("change sum") },
    execute: (_req, i) => ({ report: executed("all tests pass"), edit: writeSum(i === 1 ? BAD : GOOD) }),
    review: { report: review("accept") }, // accepts blindly
    final_review: { report: review("complete") }
  });
  const run = await service(p, agents).createRun({ source: p.src, goal: goal() });
  await until(run, () => ["completed", "paused"].includes(run.view().status));
  await run.idle();
  const st = await journal(p, run);
  assert.equal(st.status, "completed");
  const executes = agents.log.filter((e) => e.purpose === "execute").length;
  assert.equal(executes, 2, "the failing round was not accepted: a second executor round ran");
  assert.equal(st.orch.accepted["1"] !== undefined, true);
  await run.close();
});

test("step runs exactly one external operation, then paused(step_done); pause and resume", SKIP, async () => {
  const p = project();
  let release;
  const held = new Promise((r) => { release = r; });
  const agents = createTestAgents({
    plan: { report: plan("one", "two") },
    execute: (_req, i) => ({ report: executed(), edit: writeSum(GOOD + `// ${i}\n`), hold: i === 2 ? held : undefined }),
    review: { report: review("accept") },
    final_review: { report: review("complete") }
  });
  const run = await service(p, agents).createRun({ source: p.src, goal: goal({ reviewPlan: true }) });
  await until(run, () => run.view().reason === "plan_review");
  await run.idle();

  assert.equal((await cmd(run, { kind: "step" })).status, "accepted");
  await until(run, () => run.view().reason === "step_done");
  await run.idle();
  assert.deepEqual(agents.log.map((e) => e.purpose), ["plan", "execute"], "one operation: the executor turn");
  const before = Object.keys((await journal(p, run)).checks).length;

  assert.equal((await cmd(run, { kind: "step" })).status, "accepted");
  await until(run, () => run.view().reason === "step_done");
  await run.idle();
  const st = await journal(p, run);
  assert.equal(Object.keys(st.checks).length, before + 1, "one operation: one check");
  assert.equal(agents.log.length, 2);

  // resume, then pause while the second executor turn holds: the turn ends, nothing after it starts
  assert.equal((await cmd(run, { kind: "resume" })).status, "accepted");
  await until(run, () => run.view().active?.kind === "turn" && run.view().active.purpose === "execute");
  assert.equal((await cmd(run, { kind: "pause_after_turn", on: true })).status, "accepted");
  assert.equal(run.view().status, "pausing");
  release();
  await until(run, () => run.view().status === "paused");
  await run.idle();
  assert.equal(run.view().reason, "user_request");
  const count = agents.log.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(agents.log.length, count, "no operation after the pause");
  assert.equal((await cmd(run, { kind: "resume" })).status, "accepted");
  await until(run, () => run.view().status === "completed");
  await run.close();
});

test("the real provider adapter refuses an executor turn and a non-Codex lead explicitly", () => {
  const cli = (provider) => ({ state: "available", provider, executable: "/nonexistent/cli", launcher: "direct", environment: {}, checked: [] });
  const req = (purpose, role) => ({ purpose, role, cwd: TMP, task: "t", schema: { type: "object" }, sessionId: null, timeoutMs: 1000 });
  const agents = createProviderAgents({ lead: { cli: cli("codex"), cliVersion: "codex-cli 0.155.1", env: {} }, launch: LAUNCH, attemptRoot: TMP });
  const refused = agents.prepare(req("execute", "executor"));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "unsupported_capability");
  assert.match(refused.detail, /structured-no-tools cannot change the working copy/);
  const claudeLead = createProviderAgents({ lead: { cli: cli("claude"), cliVersion: "2.1.278 (Claude Code)", env: {} }, launch: LAUNCH, attemptRoot: TMP });
  assert.equal(claudeLead.prepare(req("plan", "lead")).ok, false);
});

test("production code never imports test fixtures or mocks", () => {
  const dir = path.join(HERE, "..", "src", "main", "services", "orchestration");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(text, /from\s+["'][^"']*(fixtures|mock-|test-agents)/, f);
  }
});
