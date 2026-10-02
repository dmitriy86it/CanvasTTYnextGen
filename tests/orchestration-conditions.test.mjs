// Journal v2, A2 (docs/agent-orchestration/implementation/journal-v2-format.md §2.7): requirements R<n> (the goal's
// criteria) and readiness conditions C<n> (the plans', numbered by the application), each with its evidence — a check
// command on the tree the run completes on, or the lead's review naming the files changed. Completion and its replay
// need every condition and requirement met. Fake CLIs (MOCK_SCRIPT, MOCK_CHECKS) only.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { applyPlan, bookOf, conditionBlockers, emptyBook, factsOf, numberPlan, planProblems, reportConditions } from "../src/main/services/orchestration/conditions.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { buildRecord, isValidEventData, parseJournal } from "../src/main/services/orchestration/journal.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { conditionsView, decidedGoal, loadConditions } from "../src/main/services/orchestration/orchestrationService.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { readRun } from "../src/main/services/orchestration/store.ts";
import { activityRuns, conditionsLine, reportParts } from "../src/renderer/src/features/orchestration/runStatus.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "docs", "agent-orchestration", "implementation", "v2-fixtures", "runs");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-a2-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}
let n = 0;
function project(files) {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  for (const [f, text] of Object.entries({ ".gitignore": "node_modules/\n", ...files })) fs.writeFileSync(path.join(dir, f), text);
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  return dir;
}
function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
function providersFile(env) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP }
  }));
  return file;
}
function script(answers) {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  answers.forEach((a, i) => {
    fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(a.answer));
    if (a.writes) fs.writeFileSync(path.join(dir, `${i + 1}.writes.json`), JSON.stringify(a.writes));
  });
  return dir;
}
function manager(env, { root = path.join(TMP, `root-${++n}`), leadSandbox } = {}) {
  const m = createRunManager({
    platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providersFile(env), () => LAUNCH), journalV2: true,
    ...(leadSandbox !== undefined ? { leadSandbox } : {})
  });
  m.root = root;
  return m;
}
const view = async (m, runId) => (await m.get(runId)).value.view;
const settled = (m, runId) => until(async () => {
  const v = await view(m, runId);
  return ["completed", "paused", "failed", "stopped"].includes(v.status) && !v.permission ? v : null;
}, "the end");
const records = async (m, runId) => (await m.history(runId, 0, 500)).value.records;
const journalFile = (m, runId) => path.join(m.root, "runs", runId, "journal.jsonl");
async function start(m, src, goal) {
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), checks: ["false"] });
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "a and b to 2", criteria: ["a.txt says 2"], checks: [], commands: [], mode: "autopilot", ...goal } });
  assert.ok(r.ok, JSON.stringify(r));
  return runId;
}
// A journal rebuilt by fn (records in, records out), re-chained as this build writes it.
function rewrite(buf, runId, fn) {
  const recs = fn(buf.toString().trim().split("\n").map((l) => JSON.parse(l)));
  const out = [];
  let prev = null;
  for (const r of recs) {
    const { record, line } = buildRecord(prev, runId, r.ts, r.type, r.data, 2, prev === null ? { minReaderVersion: 2, formatPreview: true } : null);
    out.push(line);
    prev = record;
  }
  return Buffer.concat(out);
}
// A text put into the run's texts/ as the store keeps them (named by the sha256 of its bytes).
function putText(m, runId, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(m.root, "runs", runId, "texts", sha256), bytes);
  return { sha256, bytes: bytes.length };
}
const readJsonOf = (m, runId) => async (ref) => JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, "texts", ref.sha256), "utf8"));
async function stateOf(m, runId) {
  const r = await readRun(m.root, runId);
  const goal = await decidedGoal(m.root, runId, r.state, JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, "texts", r.state.goal.sha256), "utf8")));
  return { st: r.state, goal, c: await loadConditions(r.state, readJsonOf(m, runId)) };
}

const b64 = (s) => Buffer.from(s).toString("base64");
const exec = (writes) => ({ answer: { summary: "done", done: true }, writes: Object.entries(writes).map(([rel, text]) => ({ rel, base64: b64(text) })) });
const change = (text, covers) => ({ keep: null, text, covers, evidence: { kind: "change", check: null } });
const byCheck = (text, covers, check) => ({ keep: null, text, covers, evidence: { kind: "check", check } });
const plan = (...stages) => ({ answer: { stages: stages.map(([title, conditions]) => ({ title, task: title, conditions })), dropped: [], dropRequirements: [], question: null } });
const mark = (id, status, paths = []) => ({ id, status, paths, note: `${id} ${status}` });
const review = (...marks) => ({ answer: { verdict: "accept", findings: [], question: null, conditions: marks } });
const final = (...marks) => ({ answer: { verdict: "complete", findings: [], question: null, requirements: marks.map(([id, status]) => ({ id, status, note: id })) } });

// ---------------- the ids (5h §2.3) ----------------

test("ids: R from the criteria, C numbered by the application, never renumbered; a replan keeps the open ones and drops none (A4)", () => {
  const def = (text, covers, evidence = { kind: "change" }) => ({ text, covers, evidence });
  const book = emptyBook();
  const r1 = { stages: [{ title: "a", task: "a", conditions: [{ ...change("a", ["R1"]) }] }, { title: "b", task: "b", conditions: [{ ...change("b", ["R2"]) }, { ...byCheck("t", ["R1"], "cmd-1") }] }], dropped: [], dropRequirements: [] };
  const first = reportConditions(r1);
  assert.deepEqual([...first.problems, ...planProblems(first.stages, r1, book, 1, 2, ["cmd-1"])], []);
  const p1 = numberPlan(r1, first.stages, book.next);
  assert.deepEqual(p1.text.stages.map((s) => s.conditions.map((c) => c.id)), [["C1"], ["C2", "C3"]]);
  applyPlan(book, { firstStage: 1, text: p1.text, conditionsAssigned: p1.assigned });
  // stage 1 accepted; the replan from stage 2 must keep C2 and C3 (or drop them — not before A4)
  const lost = { stages: [{ title: "b2", task: "b2", conditions: [{ ...change("b again", ["R2"]) }] }], dropped: [], dropRequirements: [] };
  const lp = planProblems(reportConditions(lost).stages, lost, book, 2, 2, ["cmd-1"]);
  assert.ok(lp.some((x) => /C2.*neither kept nor dropped/.test(x)) && lp.some((x) => /C3.*neither kept nor dropped/.test(x)), lp.join("; "));
  for (const [extra, what] of [[{ dropped: [{ condition: "C2", why: "x" }] }, /^dropped must be empty/], [{ dropRequirements: [{ requirement: "R2", why: "x" }] }, /^dropRequirements must be empty/]]) {
    assert.ok(planProblems(reportConditions(lost).stages, { ...lost, ...extra }, book, 2, 2, ["cmd-1"]).some((x) => what.test(x)), `dropping is A4's, invalid in A2: ${what}`);
  }
  const keep = (id) => ({ keep: id, text: null, covers: null, evidence: null });
  const r2 = { stages: [{ title: "b2", task: "b2", conditions: [keep("C3"), keep("C2"), { ...change("c", ["R2"]) }] }], dropped: [], dropRequirements: [] };
  const second = reportConditions(r2);
  assert.deepEqual(planProblems(second.stages, r2, book, 2, 2, ["cmd-1"]), []);
  const p2 = numberPlan(r2, second.stages, book.next);
  assert.deepEqual(p2.text.stages[0].conditions, [{ keep: "C3" }, { keep: "C2" }, { id: "C4", ...def("c", ["R2"]) }]);
  applyPlan(book, { firstStage: 2, text: p2.text, conditionsAssigned: p2.assigned });
  assert.deepEqual([book.defs.get("C2"), book.defs.get("C3")], [{ id: "C2", ...def("b", ["R2"]) }, { id: "C3", ...def("t", ["R1"], { kind: "check", check: "cmd-1" }) }], "a kept condition's text, covers and evidence stay");
  assert.deepEqual([...book.stages.entries()], [[1, ["C1"]], [2, ["C3", "C2", "C4"]]]);
  // a plan text that renumbers or reuses an id is not a plan of this run (replayed: conflict)
  assert.throws(() => bookOf([{ firstStage: 1, text: p1.text, conditionsAssigned: 3 }, { firstStage: 2, text: { ...p2.text, stages: [{ ...p2.text.stages[0], conditions: [{ keep: "C3" }, { keep: "C2" }, { id: "C2", ...def("c", ["R2"]) }] }] }, conditionsAssigned: 1 }]));
  assert.throws(() => bookOf([{ firstStage: 1, text: p1.text, conditionsAssigned: 2 }]), "the count the record assigned");
  // keep of a condition no plan defined, a covers of no requirement, a check of no command
  const bad = { stages: [{ title: "x", task: "x", conditions: [keep("C9"), { ...change("x", ["R7"]) }, { ...byCheck("y", ["R2"], "cmd-4") }] }], dropped: [], dropRequirements: [] };
  assert.equal(planProblems(reportConditions(bad).stages, bad, book, 2, 2, ["cmd-1"]).length >= 3, true);
});

test("a run: the lead's conditions over the criteria, a stage back to the executor while one is not met, a replan on an unmet requirement keeps the ids", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([
    plan(["a", [change("a.txt says 2", ["R1", "R2"]), byCheck("the check passes", ["R1"], "cmd-1")]]),
    exec({ "a.txt": "2\n" }),
    review(mark("C1", "not_met")), // accept, but C1 not met: the stage goes back to the executor
    exec({ "a.txt": "2\n" }),
    review(mark("C1", "met", ["a.txt"])),
    final(["R1", "met"], ["R2", "not_met"]), // complete with R2 unmet: a new plan
    plan(["b", [change("b.txt says 2", ["R2"])]]),
    exec({ "b.txt": "2\n" }),
    review(mark("C3", "met", ["b.txt"])),
    final(["R1", "met"], ["R2", "met"])
  ]) });
  const runId = await start(m, src, { criteria: ["a.txt says 2", "b.txt says 2"], commands: ["grep -qx 2 a.txt"] });
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v));
  const all = await records(m, runId);
  const turns = all.filter((r) => r.type === "orch.turn").map((r) => r.data.purpose);
  assert.deepEqual(turns, ["plan", "execute", "review", "execute", "review", "final_review", "plan", "execute", "review", "final_review"]);
  assert.deepEqual(all.filter((r) => r.type === "plan.recorded").map((r) => [r.data.firstStage, r.data.conditionsAssigned]), [[1, 2], [2, 1]]);
  const c = v.progress.conditions;
  assert.deepEqual(c.requirements.map((r) => [r.id, r.text, r.conditions, r.status]), [["R1", "a.txt says 2", ["C1", "C2"], "met"], ["R2", "b.txt says 2", ["C1", "C3"], "met"]]);
  assert.deepEqual(c.conditions.map((x) => [x.id, x.stage, x.status, x.evidence.kind]), [["C1", 1, "met", "change"], ["C2", 1, "met", "check"], ["C3", 2, "met", "change"]]);
  assert.deepEqual([c.met, c.total], [3, 3]);
  assert.deepEqual(c.conditions[0].proof.paths, ["a.txt"]);
  assert.equal(c.conditions[1].evidence.command, "grep -qx 2 a.txt");
  // the result's basis: R → C → evidence
  const basis = JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, "texts", all.at(-1).data.completion.basis.sha256), "utf8"));
  assert.deepEqual(basis.requirements, [{ id: "R1", conditions: ["C1", "C2"], met: true }, { id: "R2", conditions: ["C1", "C3"], met: true }]);
  await m.shutdown();
});

test("the lead's marks: met only with a file the run changed; a mark missing or of another condition — invalid_report, nothing recorded", OPTS, async () => {
  for (const [marks, why] of [[[mark("C1", "met", ["b.txt"])], "a file the run did not change"], [[], "no mark"], [[mark("C1", "met", ["a.txt"]), mark("C2", "met", ["a.txt"])], "a mark of no condition of the stage"]]) {
    const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
    const m = manager({ MOCK_SCRIPT: script([plan(["a", [change("a.txt says 2", ["R1"])]]), exec({ "a.txt": "2\n" }), review(...marks)]), MOCK_CHECKS: "none" });
    const runId = await start(m, src, {});
    const v = await settled(m, runId);
    assert.deepEqual([v.status, v.reason], ["paused", "invalid_report"], why);
    assert.equal((await records(m, runId)).some((r) => r.type === "review.recorded"), false, why);
    await m.shutdown();
  }
  // a plan that leaves a requirement uncovered: invalid_report, no plan recorded
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([plan(["a", [change("a.txt says 2", ["R1"])]]), plan(["a", [change("a.txt says 2", ["R1"]), change("b.txt says 2", ["R2"])]])]), MOCK_CHECKS: "none" });
  const runId = await start(m, src, { criteria: ["a.txt says 2", "b.txt says 2"] });
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "invalid_report"]);
  assert.equal((await records(m, runId)).some((r) => r.type === "plan.recorded"), false);
  // a step: the next plan turn is told what was wrong (5h §2.3, recomputed from the rejected report)
  const r = await m.command(runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "step" } });
  assert.equal(r.value?.status, "accepted", JSON.stringify(r));
  // the second plan turn proposes no commands (checks.proposed); its plan is recorded after that decision
  await until(async () => (await records(m, runId)).some((x) => x.type === "checks.proposed"), "the second plan");
  const tasks = (await records(m, runId)).filter((x) => x.type === "turn.intent").map((x) => fs.readFileSync(path.join(m.root, "runs", runId, "texts", x.data.task.sha256), "utf8"));
  assert.equal(tasks.length, 2);
  assert.ok(!tasks[0].includes("was not accepted") && tasks[0].includes("R2: b.txt says 2"), tasks[0]);
  assert.ok(tasks[1].includes("Your previous plan was not accepted by the application:\n- R2 is covered by no condition"), tasks[1]);
  await m.shutdown();
});

// ---------------- a lead's command as a condition ----------------

test("a lead's command as a condition: met by its passed run → completion allowed; not met → not allowed", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([plan(["a", [byCheck("the proposed check passes", ["R1"], "cmd-1")]]), exec({ "a.txt": "2\n" }), review(), final(["R1", "met"])]),
    MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt" });
  const runId = await start(m, src, {});
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.progress.completion, v.progress.checksFrom], ["completed", "confirmed", "proposal"], JSON.stringify(v));
  const c1 = v.progress.conditions.conditions[0];
  assert.deepEqual([c1.id, c1.status, c1.evidence], ["C1", "met", { kind: "check", check: "cmd-1", command: "grep -qx 2 a.txt" }]);
  const run = (await records(m, runId)).filter((r) => r.type === "check.finished" && r.data.status === "passed").at(-1);
  assert.equal(c1.proof.checkRunId, run.data.checkRunId, "its evidence: the passed run");
  await m.shutdown();
  // the completion function itself: the same facts with the command not passed block it
  const book = bookOf([{ firstStage: 1, text: { stages: [{ title: "a", task: "a", conditions: [{ id: "C1", text: "t", covers: ["R1"], evidence: { kind: "check", check: "cmd-1" } }] }], dropped: [], dropRequirements: [], question: null }, conditionsAssigned: 1 }]);
  const facts = (status) => factsOf(book, 1, { check: () => status, marks: () => [], finalMarks: [{ id: "R1", status: "met", note: "" }] });
  assert.deepEqual(conditionBlockers(facts("met")), []);
  assert.deepEqual(conditionBlockers(facts("not_met")), ["condition_unmet", "requirement_unmet"]);
  assert.deepEqual(conditionBlockers(facts("not_checked")), ["condition_unmet", "requirement_unmet"]);
  const { completion } = await import("../src/main/services/orchestration/cycle.ts");
  const { st, goal } = await stateOf(m, runId);
  const snap = { tree: st.orch.reviews.at(-1).tree, runKey: st.orch.reviews.at(-1).runKey };
  const shouldPass = completion(st, goal, snap, facts("met"));
  const blocked = completion(st, goal, snap, facts("not_met"));
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.blockers.includes("condition_unmet") && blocked.blockers.includes("requirement_unmet"), JSON.stringify(blocked));
  assert.deepEqual(shouldPass, { allowed: true, kind: "confirmed" });
});

test("the person edits the proposed commands: the proposal's plan is dropped, the next plan's check conditions name the edited set", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  // no check profile (leadSandbox false): the autopilot waits for the person's decision on the proposal
  const m = manager({ MOCK_SCRIPT: script([plan(["a", [byCheck("the check passes", ["R1"], "cmd-1")]]), plan(["a", [byCheck("the check passes", ["R1"], "cmd-1")]])]),
    MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt" }, { leadSandbox: false });
  const runId = await start(m, src, {});
  const v = await settled(m, runId);
  assert.equal(v.reason, "awaiting_checks_decision");
  const r = await m.command(runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "checks.decide", decision: "edit", checks: [] } });
  assert.equal(r.value?.status, "accepted", JSON.stringify(r));
  // the set is empty now: a condition on cmd-1 has no command to prove it
  const after = await until(async () => { const x = await view(m, runId); return x.reason === "invalid_report" ? x : null; }, "the second plan refused");
  assert.equal(after.turns, 2);
  assert.equal((await records(m, runId)).some((x) => x.type === "plan.recorded"), false);
  await m.shutdown();
});

// ---------------- stale evidence ----------------

test("an executor breaks a met condition: the old tree's pass is no evidence (not met on the new tree), the rerun restores it", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([
    plan(["a", [byCheck("a.txt says 2", ["R1"], "cmd-1")]], ["c", [change("c.txt exists", ["R1"])]]),
    exec({ "a.txt": "2\n" }), review(),
    exec({ "c.txt": "c\n", "a.txt": "3\n" }), review(mark("C2", "met", ["c.txt"])), // the check fails on this tree
    exec({ "a.txt": "2\n" }), review(mark("C2", "met", ["c.txt"])),
    final(["R1", "met"])
  ]) });
  const runId = await start(m, src, { commands: ["grep -qx 2 a.txt"] });
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v));
  const all = await records(m, runId);
  const runs = all.filter((r) => r.type === "check.finished").map((r) => [r.data.checkRunId, r.data.status]);
  const firstPass = runs.find(([, s]) => s === "passed")[0];
  const failed = runs.find(([, s]) => s === "failed")[0];
  const lastPass = runs.filter(([, s]) => s === "passed").at(-1)[0];
  assert.ok(runs.findIndex(([id]) => id === failed) > runs.findIndex(([id]) => id === firstPass) && lastPass !== firstPass, JSON.stringify(runs));
  assert.deepEqual([v.progress.conditions.conditions[0].status, v.progress.conditions.conditions[0].proof.checkRunId], ["met", lastPass], "the rerun's pass is the evidence");
  await m.shutdown();
  // the facts on the broken tree: its checkKey has only the failed run — the stage 1 pass does not count there
  const { st, goal, c } = await stateOf(m, runId);
  const keyOf = (id) => ({ "cmd-1": st.orch.assessed[id].checkKey });
  assert.notEqual(keyOf(failed)["cmd-1"], keyOf(firstPass)["cmd-1"]);
  assert.equal(conditionsView(st, goal, c, keyOf(failed)).conditions[0].status, "not_met");
  assert.equal(conditionsView(st, goal, c, { "cmd-1": "0".repeat(64) }).conditions[0].status, "not_checked", "a tree no run was on");
  assert.equal(conditionsView(st, goal, c, keyOf(lastPass)).conditions[0].status, "met");
  // replay: a basis that names the old tree's pass for the check condition is no completion
  const buf = fs.readFileSync(journalFile(m, runId));
  const basisRef = all.at(-1).data.completion.basis;
  const basis = JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, "texts", basisRef.sha256), "utf8"));
  const forged = putText(m, runId, { ...basis, checks: basis.checks.map((x) => ({ ...x, checkRunId: firstPass })) });
  fs.writeFileSync(journalFile(m, runId), rewrite(buf, runId, (r) => { r.at(-1).data.completion.basis = forged; return r; }));
  const r = await readRun(m.root, runId);
  assert.deepEqual([r.integrity.status, r.integrity.detail?.phase], ["corrupt", "texts"]);
});

test("a tree seen before (A → B → A): the run completes on A's check run, and its journal reads back intact", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const fix = (...marks) => ({ answer: { ...review(...marks).answer, verdict: "fix" } });
  const m = manager({ MOCK_SCRIPT: script([
    plan(["a", [byCheck("a.txt not empty", ["R1"], "cmd-1")]], ["b", [change("a.txt touched", ["R1"])]]),
    exec({ "a.txt": "2\n" }), review(),
    exec({ "a.txt": "3\n" }), fix(mark("C2", "not_met")), // the check passes on B
    exec({ "a.txt": "2\n" }), review(mark("C2", "met", ["a.txt"])), // back on A: not rerun
    final(["R1", "met"])
  ]) });
  const runId = await start(m, src, { commands: ["grep -q . a.txt"] });
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v));
  await m.shutdown();
  const r = await readRun(m.root, runId);
  assert.deepEqual([r.integrity.status, r.canContinue], ["ok", true], JSON.stringify(r.integrity));
  const { st } = await stateOf(m, runId);
  const basis = JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, "texts", st.completion.basis.sha256), "utf8"));
  assert.equal(st.orch.assessed[basis.checks[0].checkRunId].checkKey, basis.checkKeys["cmd-1"], "the basis names the run on the tree it completed on");
  // the evidence is the checkKey's: a run assessed under another runKey (another command amended, A1.1) still counts
  const buf = fs.readFileSync(journalFile(m, runId));
  fs.writeFileSync(journalFile(m, runId), rewrite(buf, runId, (recs) => {
    for (const x of recs) if (x.type === "check.assessed" && x.data.checkRunId === basis.checks[0].checkRunId) x.data.runKey = "f".repeat(64);
    return recs;
  }));
  assert.equal((await readRun(m.root, runId)).integrity.status, "ok");
});

test("the view between decisions: a check result an executor turn came after is not shown as met (live and not held)", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([
    plan(["a", [byCheck("a.txt says 2", ["R1"], "cmd-1")]], ["b", [change("b.txt exists", ["R1"])]]),
    exec({ "a.txt": "2\n" }), review(),
    { answer: { summary: 42 }, writes: [{ rel: "a.txt", base64: b64("3\n") }] } // an invalid report: paused before any check on this tree
  ]) });
  const runId = await start(m, src, { commands: ["grep -qx 2 a.txt"] });
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "invalid_report"]);
  assert.deepEqual(v.progress.conditions.conditions.map((x) => [x.id, x.status, x.proof]), [["C1", "not_checked", null], ["C2", "not_checked", null]]);
  await m.shutdown();
  const m2 = manager({}, { root: m.root });
  const shown = (await m2.get(runId)).value.view.progress.conditions;
  assert.deepEqual(shown.conditions.map((x) => x.status), ["not_checked", "not_checked"], "the snapshot of a run nobody holds");
  await m2.shutdown();
});

// ---------------- a forged «Завершено» ----------------

test("a forged completion: a requirement or a condition without evidence in the texts — corrupt (texts), the run cannot continue", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([plan(["a", [change("a.txt says 2", ["R1"])]]), exec({ "a.txt": "2\n" }), review(mark("C1", "met", ["a.txt"])), final(["R1", "met"])]), MOCK_CHECKS: "none" });
  const runId = await start(m, src, {});
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.progress.completion], ["completed", "no_checks"]);
  await m.shutdown();
  const all = await records(m, runId);
  const buf = fs.readFileSync(journalFile(m, runId));
  const turnOf = (purpose) => all.filter((r) => r.type === "orch.turn" && r.data.purpose === purpose).at(-1).data.turnId;
  const outcome = async (fn) => {
    fs.writeFileSync(journalFile(m, runId), rewrite(buf, runId, fn));
    const r = await readRun(m.root, runId);
    return [r.integrity.status, r.integrity.detail?.phase ?? null, r.canContinue];
  };
  const answerOf = (turnId, value) => (r) => {
    for (const x of r) if (x.type === "turn.finished" && x.data.turnId === turnId) x.data.report = { ...x.data.report, ref: putText(m, runId, value) };
    return r;
  };
  assert.deepEqual(await outcome((r) => r), ["ok", null, true], "as written");
  const finalAnswer = { verdict: "complete", findings: [], question: null, requirements: [{ id: "R1", status: "not_met", note: "no" }] };
  assert.deepEqual(await outcome(answerOf(turnOf("final_review"), finalAnswer)), ["corrupt", "texts", false], "the final review: R1 not met");
  const reviewAnswer = { verdict: "accept", findings: [], question: null, conditions: [{ id: "C1", status: "not_met", paths: [], note: "no" }] };
  assert.deepEqual(await outcome(answerOf(turnOf("review"), reviewAnswer)), ["corrupt", "texts", false], "the accepting review: C1 not met");
  // the same before the run completed (the journal up to the acceptance): the acceptance alone is checked
  const upToAccepted = (fn) => (r) => fn(r.slice(0, r.findIndex((x) => x.type === "stage.accepted") + 1));
  assert.deepEqual(await outcome(upToAccepted((r) => r)), ["ok", null, true], "up to the acceptance, as written");
  assert.deepEqual(await outcome(upToAccepted(answerOf(turnOf("review"), reviewAnswer))), ["corrupt", "texts", false], "accepted on a review that did not mark C1 met");
  // a plan text with a condition its record does not number, and one renumbered
  const planRec = all.find((r) => r.type === "plan.recorded");
  const planText = JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, "texts", planRec.data.plan.sha256), "utf8"));
  assert.deepEqual(await outcome((r) => { for (const x of r) if (x.type === "plan.recorded") delete x.data.conditionsAssigned; return r; }), ["corrupt", "texts", false]);
  const renumbered = putText(m, runId, { ...planText, stages: [{ ...planText.stages[0], conditions: [{ ...planText.stages[0].conditions[0], id: "C5" }] }] });
  assert.deepEqual(await outcome((r) => { for (const x of r) if (x.type === "plan.recorded") x.data.plan = renumbered; return r; }), ["corrupt", "texts", false]);
  fs.writeFileSync(journalFile(m, runId), buf);
});

// ---------------- regressions ----------------

test("no_checks (A1) with conditions; a journal of A1's plan form (no conditions) opens and continues as before", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([plan(["a", [change("a.txt says 2", ["R1"])]]), exec({ "a.txt": "2\n" }), review(mark("C1", "met", ["a.txt"])), final(["R1", "met"])]), MOCK_CHECKS: "none" });
  const runId = await start(m, src, {});
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.progress.completion, v.progress.conditions.met, v.progress.conditions.total], ["completed", "no_checks", 1, 1]);
  await m.shutdown();
  // the same run as A1 wrote it: the plan without conditions, the record without conditionsAssigned
  const all = await records(m, runId);
  const planRec = all.find((r) => r.type === "plan.recorded");
  const planText = JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, "texts", planRec.data.plan.sha256), "utf8"));
  const a1 = putText(m, runId, { stages: planText.stages.map(({ title, task }) => ({ title, task })), question: null });
  const buf = fs.readFileSync(journalFile(m, runId));
  fs.writeFileSync(journalFile(m, runId), rewrite(buf, runId, (r) => {
    for (const x of r) if (x.type === "plan.recorded") { delete x.data.conditionsAssigned; x.data.plan = a1; }
    return r;
  }));
  const r = await readRun(m.root, runId);
  assert.deepEqual([r.integrity.status, r.state.orch.plans[0].conditionsAssigned], ["ok", undefined]);
  const m2 = manager({}, { root: m.root });
  const v2 = (await m2.get(runId)).value.view;
  assert.deepEqual([v2.status, v2.progress.completion, v2.progress.conditions], ["completed", "no_checks", null], "no conditions shown for a plan of A1's form");
  await m2.shutdown();
});

// ---------------- the fixtures of the format ----------------

test("the fixtures (A4's final form): plan.recorded with conditionsAssigned valid; their plans are valid and number as A2 numbers them", () => {
  let plans = 0;
  for (const id of fs.readdirSync(FIXTURES)) {
    const name = fs.readFileSync(path.join(FIXTURES, id, "FIXTURE"), "utf8").trim();
    const recs = parseJournal(fs.readFileSync(path.join(FIXTURES, id, "journal.jsonl")), id).records;
    const goal = JSON.parse(fs.readFileSync(path.join(FIXTURES, id, "texts", recs[0].data.goal.sha256), "utf8"));
    const book = emptyBook();
    for (const r of recs.filter((x) => x.type === "plan.recorded")) {
      assert.equal(isValidEventData(r.type, r.data, 2), true, `${name}: ${JSON.stringify(r.data)}`);
      const text = JSON.parse(fs.readFileSync(path.join(FIXTURES, id, "texts", r.data.plan.sha256), "utf8"));
      const stages = text.stages.map((s) => ({ conditions: s.conditions.map((c) => ("keep" in c ? { keep: c.keep } : { text: c.text, covers: c.covers, evidence: c.evidence })) }));
      const problems = planProblems(stages, text, book, r.data.firstStage, goal.criteria.length, Array.from({ length: 8 }, (_, i) => `cmd-${i + 1}`));
      assert.deepEqual(problems, [], name);
      applyPlan(book, { firstStage: r.data.firstStage, text, conditionsAssigned: r.data.conditionsAssigned });
      plans += 1;
    }
  }
  assert.ok(plans >= 8, `${plans} plans`);
});

// ---------------- the renderer's model ----------------

test("the UI model: «N из M условий выполнено» on the result, the cards and the activity feed alike; none without conditions", () => {
  const conditions = {
    requirements: [{ id: "R1", text: "a", conditions: ["C1", "C2"], status: "not_checked" }],
    conditions: [
      { id: "C1", text: "x", covers: ["R1"], stage: 1, status: "met", evidence: { kind: "change" }, proof: { reviewTurnId: "t", paths: ["a.txt"], note: "" } },
      { id: "C2", text: "y", covers: ["R1"], stage: 1, status: "not_checked", evidence: { kind: "check", check: "cmd-1", command: "npm test" }, proof: null }
    ],
    met: 1, total: 2
  };
  const v = { runId: "r", status: "running", progress: { conditions } };
  assert.equal(conditionsLine("ru", v), "1 из 2 условий выполнено");
  assert.equal(conditionsLine("en", v), "1 of 2 conditions met");
  assert.equal(conditionsLine("ru", { progress: { conditions: null } }), null);
  assert.equal(conditionsLine("ru", { progress: null }), null);
  assert.equal(conditionsLine("ru", { progress: { conditions: { ...conditions, met: 0, total: 0, conditions: [] } } }), null);
  const view = { runId: "r", status: "paused", reason: "invalid_report", stage: 1, revision: 1, active: null, halted: false, permission: null, progress: { conditions } };
  const rows = activityRuns("ru", {
    links: [{ linkId: "l", fromAgentId: "a", runIds: ["r"] }], agents: [{ agentId: "a", project: "/p" }], runs: { r: { view, open: false } },
    entries: () => [], lastRecordAt: () => null, runErrors: {}, stageTitles: () => null, now: Date.now()
  });
  assert.equal([...rows.active, ...rows.recent][0].conditions, "1 из 2 условий выполнено");
  // the lead's marks are the «Условия» section's, not the report's other fields
  const parts = reportParts(JSON.stringify({ verdict: "complete", findings: [], question: null, requirements: [{ id: "R1", status: "met", note: "" }], conditions: [], extra: 1 }));
  assert.deepEqual(parts.other, [["extra", "1"]]);
});
