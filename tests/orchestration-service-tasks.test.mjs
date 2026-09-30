// What the service tells the agents (stage-6-contract.md §5.3), read from the tasks the adapter actually received:
// the planner sees the acceptance rules and the budget as the service counts it (user changes included); a repeated
// execute after an accept with failing checks and a replan get the failing results of the current state; completion
// needs a separate final review turn; a spent turn budget still forbids the next call. Real Store, copy, sandboxed
// checks and checkpoints; test agents instead of CLIs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
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

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-tasks-")));
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
const service = (p, agents) => createOrchestrationService({ root: p.root, gitPath: GIT, agents, checks: { registry, deps: p.deps, launch: LAUNCH } });
const goal = (extra = {}) => ({ text: "extend sum", criteria: ["sum works"], checks: ["unit"], ...extra });
const cmd = (run, command) => run.command({ commandId: randomUUID(), expectedRevision: run.view().revision, command });
async function until(fn, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (fn()) return;
  throw new Error(`condition not reached: ${fn}`);
}
const writeSum = (body) => (c) => fs.writeFileSync(c.path("src/sum.mjs"), body);
const GOOD = "export const sum = (...xs) => xs.reduce((a, b) => a + b, 0);\n// improved\n";
const BAD = "export const sum = () => 42;\n";
const tasks = (agents, purpose) => agents.log.filter((e) => e.purpose === purpose).map((e) => e.task);

test("the planner sees the acceptance rules and the budget as the service counts it, user changes included", SKIP, async () => {
  const p = project();
  const agents = createTestAgents({
    plan: { report: plan("only stage") },
    execute: { report: executed(), edit: writeSum(GOOD) },
    review: { report: review("accept") },
    final_review: { report: review("complete") }
  });
  const run = await service(p, agents).createRun({ source: p.src, goal: goal({ limits: { turns: 1, replans: 2, roundsPerStage: 3 } }) });
  await until(() => run.view().status === "paused");
  await run.idle();
  assert.deepEqual([run.view().status, run.view().reason], ["paused", "limit_reached"]);
  const [first] = tasks(agents, "plan");
  for (const rule of [/Inspect the project yourself \(read-only\) before writing the plan/, /every required check \(unit\) passes on the copy after that stage/,
    /Never plan a stage that only inspects, plans or verifies/, /a small task is one stage/, /final review is mandatory: it is a separate lead turn/]) {
    assert.match(first, rule);
  }
  assert.match(first, /this is turn 1 of at most 1 \(0 left after it/);
  assert.match(first, /Replans used: 0 of 2/);
  assert.match(first, /Rounds per stage: at most 3/);
  assert.equal(agents.log.length, 1, "turns: 1 — the spent budget forbids the next call");

  // the user raises the limit: the next task counts with the new value
  assert.equal((await cmd(run, { kind: "raise_limit", limit: "turns", value: 5 })).status, "accepted");
  assert.equal((await cmd(run, { kind: "resume" })).status, "accepted");
  await until(() => run.view().status === "completed");
  await run.idle();
  const exec = tasks(agents, "execute")[0];
  assert.match(exec, /this is turn 2 of at most 5 \(3 left after it/);
  assert.match(exec, /Implement the current stage completely in this turn/);
  assert.match(tasks(agents, "final_review")[0], /this is turn 4 of at most 5/);
  await run.close();
});

test("an accept with a failing check sends the stage back; the executor gets the failing result of the current state", SKIP, async () => {
  const p = project();
  const agents = createTestAgents({
    plan: { report: plan("only stage") },
    execute: (_req, i) => ({ report: executed(), edit: writeSum(i === 1 ? BAD : GOOD) }),
    review: { report: review("accept") }, // wrongly accepts the failing round and gives no findings
    final_review: { report: review("complete") }
  });
  const run = await service(p, agents).createRun({ source: p.src, goal: goal() });
  await until(() => run.view().status === "completed");
  await run.idle();
  assert.deepEqual(agents.log.map((e) => e.purpose), ["plan", "execute", "review", "execute", "review", "final_review"]);
  const [firstExec, second] = tasks(agents, "execute");
  assert.doesNotMatch(firstExec, /Check results on the current state/, "a first round has nothing to repeat");
  assert.match(second, /Check results on the current state of the copy \(results of other states are not shown\):\n- unit: failed/);
  const section = second.slice(second.indexOf("- unit: failed"), second.indexOf("Answer only with"));
  assert.match(section, /(ℹ|#) fail [1-9]/, "the tail of the check's own output goes with it");
  assert.ok(section.length <= 1500 + 100, `bounded: ${section.length} chars`);
  assert.match(second, /An accept while a required check fails does not advance the stage/);
  assert.match(second, /this is round 2/);
  const st = (await readRun(p.root, run.runId)).state;
  assert.deepEqual(st.orch.reviews.map((r) => r.verdict), ["accept", "accept", "complete"]);
  assert.deepEqual(Object.keys(st.workspace.checkpoints), ["1"], "only the passing round was accepted");
  await run.close();
});

test("a replan gets the reason and the current check results; completion needs its own final review turn", SKIP, async () => {
  const agents = createTestAgents({
    plan: (_req, i) => ({ report: plan(i === 1 ? "inspect only" : "implement") }),
    execute: (_req, i) => ({ report: executed(), ...(i === 1 ? {} : { edit: writeSum(GOOD) }) }),
    review: (_req, i) => ({ report: i === 1 ? review("replan", ["stage 1 cannot pass: nothing changes"]) : review("accept") }),
    final_review: { report: review("complete") }
  });
  const p = project();
  fs.writeFileSync(path.join(p.src, "src", "sum.mjs"), BAD); // failing from the start, so an inspect-only stage fails
  g(p.src, "commit", "-qam", "broken sum");
  const run = await service(p, agents).createRun({ source: p.src, goal: goal() });
  await until(() => run.view().status === "completed");
  await run.idle();
  assert.deepEqual(agents.log.map((e) => e.purpose), ["plan", "execute", "review", "plan", "execute", "review", "final_review"]);
  const replan = tasks(agents, "plan")[1];
  assert.match(replan, /Why a new plan is needed: the last review of plan v1 returned replan on stage 1\.\nIts findings:\n- stage 1 cannot pass: nothing changes/);
  assert.match(replan, /Check results on the current state of the copy[^\n]*\n- unit: failed/);
  assert.match(replan, /Replans used: 0 of 3 \(this plan is one of them\)/);
  assert.equal(agents.log.at(-1).purpose, "final_review", "completed only after a separate final review turn");
  assert.match(tasks(agents, "final_review")[0], /- unit: passed/);
  await run.close();
});

test("a spent turn budget before the final review: no further call, paused(limit_reached), never completed", SKIP, async () => {
  const p = project();
  const agents = createTestAgents({
    plan: { report: plan("only stage") },
    execute: { report: executed(), edit: writeSum(GOOD) },
    review: { report: review("accept") },
    final_review: { report: review("complete") }
  });
  const run = await service(p, agents).createRun({ source: p.src, goal: goal({ limits: { turns: 3 } }) });
  await until(() => run.view().status === "paused");
  await run.idle();
  assert.deepEqual([run.view().status, run.view().reason], ["paused", "limit_reached"]);
  assert.deepEqual(agents.log.map((e) => e.purpose), ["plan", "execute", "review"], "no final_review call past the budget");
  const st = (await readRun(p.root, run.runId)).state;
  assert.deepEqual(Object.keys(st.workspace.checkpoints), ["1"], "the stage itself was accepted and checkpointed");
  assert.notEqual(st.status, "completed");
  assert.match(tasks(agents, "review")[0], /this is turn 3 of at most 3 \(0 left after it/);
  await run.close();
});
