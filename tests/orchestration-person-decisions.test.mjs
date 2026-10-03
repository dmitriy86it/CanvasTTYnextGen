// Journal v2, A4 (docs/agent-orchestration/implementation/journal-v2-format.md §2.9; acceptance-review-spec 5h §3.5–§3.8):
// the person's decisions and the finish — a disputed item, a finding closed or made a wish, conditions and requirements
// dropped by a plan proposal the person accepts, the freshness of "change" evidence and the conditions a refused final
// review returns, the torn tail and command recovery. Each decision is the person's command, recorded with the state
// it was made on; the autopilot never makes one. Fake CLIs (MOCK_SCRIPT) only; no Seatbelt needed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { completion } from "../src/main/services/orchestration/cycle.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { JOURNAL_V2_BY_DEFAULT, buildRecord, canonical, parseJournal, sha256Hex } from "../src/main/services/orchestration/journal.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { conditionFacts, decidedGoal, loadConditions } from "../src/main/services/orchestration/orchestrationService.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { readRun } from "../src/main/services/orchestration/store.ts";
import { parseCommand } from "../src/main/ipc/orchestrationIpc.ts";
import { availableActions } from "../src/renderer/src/features/orchestration/runModel.ts";
import { personDecisionsLine } from "../src/renderer/src/features/orchestration/runStatus.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "docs", "agent-orchestration", "implementation", "v2-fixtures", "runs");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-a4-")));
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
function manager(env, { root = path.join(TMP, `root-${++n}`) } = {}) {
  const m = createRunManager({
    platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providersFile(env), () => LAUNCH), journalV2: true
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
const textOf = (m, runId, ref) => fs.readFileSync(path.join(m.root, "runs", runId, "texts", ref.sha256), "utf8");
async function start(m, src, goal = {}, profile = {}) {
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), checks: ["false"], ...profile });
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["a.txt says 2"], checks: [], commands: ["grep -qx 2 a.txt"], mode: "autopilot", ...goal } });
  assert.ok(r.ok, JSON.stringify(r));
  return runId;
}
const b64 = (s) => Buffer.from(s).toString("base64");
const writes = (files) => Object.entries(files).map(([rel, text]) => ({ rel, base64: b64(text) }));
const exec = (files, summary = "done") => ({ answer: { summary, done: true }, writes: writes(files) });
const change = (text, covers) => ({ keep: null, text, covers, evidence: { kind: "change", check: null } });
const keep = (id) => ({ keep: id, text: null, covers: null, evidence: null });
const plan = (stages, dropped = [], dropRequirements = []) =>
  ({ answer: { stages: stages.map(([title, conditions]) => ({ title, task: title, conditions })), dropped, dropRequirements, question: null } });
const PLAN = plan([["a", [change("a.txt says 2", ["R1"])]]]);
const mark = (id, status = "met", paths = ["a.txt"]) => ({ id, status, paths: status === "met" ? paths : [], note: `${id} ${status}` });
const finding = ({ id = null, severity = "blocking", condition = null, problem = "a problem", paths = ["a.txt"], status = "open", relation = null } = {}) =>
  ({ id, severity, condition, problem, evidence: "seen in the file", closeWhen: "it is fixed", status, paths, relation });
const review = (findings, marks = [mark("C1")], request = "none") => ({ answer: { conditions: marks, findings, request, question: null } });
const final = (findings = [], requirements = [["R1", "met"]], conditions = []) =>
  ({ answer: { conditions, findings, request: "none", question: null, requirements: requirements.map(([id, status]) => ({ id, status, note: id })) } });
const tasksOf = (m, runId, all, role) => all.filter((r) => r.type === "turn.intent" && r.data.role === role).map((r) => textOf(m, runId, r.data.task));
const turnsOf = (all) => all.filter((r) => r.type === "orch.turn").map((r) => r.data.purpose);
const sendAs = async (m, v, command, commandId = randomUUID()) => {
  const r = await m.command(v.runId, { commandId, expectedRevision: v.revision, command });
  return r.ok ? r.value : { status: "error", code: r.code };
};
const decide = (m, v, person) => sendAs(m, v, { kind: "person.decide", runKey: v.decisions.runKey, ...person });
const waitsFor = async (m, runId, reason) => {
  // the autopilot leaves a person's pause by itself never: the same pause after a while
  await sleep(1500);
  const v = await view(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", reason], "the autopilot did not decide for the person");
  return v;
};
// F1 on a.txt opened and closed (b.txt changed), then the final review opens a blocking one on a.txt, unchanged since,
// without saying how they relate: a disputed item
const DISPUTED = [PLAN, exec({ "a.txt": "2\n" }), review([finding()]), exec({ "b.txt": "2\n" }), review([finding({ id: "F1", status: "closed", paths: ["b.txt"] })]),
  final([finding({ problem: "LIKE-F1", paths: ["a.txt"] })])];

// ---------------- the switch ----------------

test("v2 is not on by default: JOURNAL_V2_BY_DEFAULT is false, and the app enables v2 only through it or the development flag", () => {
  assert.equal(JOURNAL_V2_BY_DEFAULT, false);
  const main = fs.readFileSync(path.join(HERE, "..", "src", "main", "index.ts"), "utf8");
  assert.match(main, /journalV2: JOURNAL_V2_BY_DEFAULT \|\| developmentEnv\("CANVASTTY_JOURNAL_V2"\) === "1"/);
});

// ---------------- a disputed item ----------------

test("a disputed item: the autopilot waits; «a repeat» of a closed finding whose files did not change is refused — nothing blocks, the run completes without another plan", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script(DISPUTED) });
  const runId = await start(m, src);
  await settled(m, runId);
  const v = await waitsFor(m, runId, "awaiting_person_decision");
  assert.deepEqual(availableActions(v), ["person_decide", "stop"]);
  for (const kind of ["resume", "step"]) assert.equal((await sendAs(m, v, { kind })).code, "invalid_state", kind);
  const d = v.decisions;
  assert.deepEqual([d.disputed.length, d.disputed[0].problem, d.disputed[0].candidates.map((c) => c.id)], [1, "LIKE-F1", ["F1"]]);
  assert.match(d.runKey, /^[0-9a-f]{64}$/);
  const target = { reviewTurnId: d.disputed[0].reviewTurnId, index: d.disputed[0].index };
  // a decision about another state than the one shown: refused, nothing recorded
  assert.equal((await sendAs(m, v, { kind: "person.decide", subject: "disputed", target, decision: "repeat", finding: "F1", runKey: "0".repeat(64) })).code, "stale_revision");
  // a repeat of a finding that is not its candidate, or a new one naming a finding
  assert.equal((await decide(m, v, { subject: "disputed", target, decision: "repeat", finding: "F7" })).code, "invalid_command");
  assert.equal((await decide(m, v, { subject: "disputed", target, decision: "new", finding: "F1" })).code, "invalid_command");
  assert.equal((await records(m, runId)).some((r) => r.type === "person.decided"), false);
  assert.equal((await decide(m, v, { subject: "disputed", target, decision: "repeat", finding: "F1" })).status, "accepted");
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify([done.status, done.reason]));
  const all = await records(m, runId);
  assert.deepEqual(turnsOf(all), ["plan", "execute", "review", "execute", "review", "final_review"], "no other plan or review");
  const rec = all.find((r) => r.type === "person.decided").data;
  assert.deepEqual([rec.subject, rec.decision, rec.finding, rec.reopened, rec.runKey, /^[0-9a-f]{40}$/.test(rec.tree)], ["disputed", "repeat", "F1", false, d.runKey, true]);
  // the person's decision, then command.completed, then the run goes on
  const at = all.findIndex((r) => r.type === "person.decided");
  assert.deepEqual(all.slice(at, at + 3).map((r) => [r.type, r.data.status ?? null]), [["person.decided", null], ["command.completed", null], ["run.status", "running"]]);
  const f1 = done.progress.findings.items.find((x) => x.id === "F1");
  // the person's «repeat»: the reopen rule by id (5h §3.4) — its files did not change since F1 was closed: refused
  assert.deepEqual([f1.status, f1.history.map((h) => [h.kind, h.by, h.reason])],
    ["closed", [["opened", "reviewer", null], ["closed", "reviewer", null], ["disputed", "reviewer", null], ["refused", "person", "declared_repeat"]]]);
  assert.equal(done.progress.findings.disputed.length, 0);
  await m.shutdown();
  const r = await readRun(m.root, runId);
  assert.deepEqual([r.integrity.status, r.canContinue], ["ok", true], JSON.stringify(r.integrity));
});

test("a disputed item decided «a new defect»: a blocking finding is opened by the person, the final is refused, a plan of fixes; a later review closes it", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n", "c.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([...DISPUTED,
    plan([["fix", [change("c.txt says 2", ["R1"])]]]), exec({ "c.txt": "2\n" }),
    review([finding({ id: "F2", status: "closed", paths: ["c.txt"] })], [mark("C2", "met", ["c.txt"])]), final()]) });
  const runId = await start(m, src);
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "awaiting_person_decision"]);
  const target = { reviewTurnId: v.decisions.disputed[0].reviewTurnId, index: 0 };
  assert.equal((await decide(m, v, { subject: "disputed", target, decision: "new", finding: null })).status, "accepted");
  // decided once: the same item again is refused
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify([done.status, done.reason]));
  const all = await records(m, runId);
  assert.deepEqual(turnsOf(all), ["plan", "execute", "review", "execute", "review", "final_review", "plan", "execute", "review", "final_review"]);
  const f2 = done.progress.findings.items.find((x) => x.id === "F2");
  assert.deepEqual([f2.severity, f2.status, f2.possibleRepeatOf, f2.history.map((h) => [h.kind, h.by ?? null])], ["blocking", "closed", "F1", [["opened", "person"], ["closed", "reviewer"]]]);
  await m.shutdown();
  assert.equal((await readRun(m.root, runId)).integrity.status, "ok");
});

// ---------------- a finding the person makes a wish ----------------

test("a blocking finding made a wish by the person: the stage is accepted and the run completes; the result says «понижено человеком», never fixed", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, exec({ "a.txt": "2\n" }), review([finding({ problem: "NOT-FIXED" })]), final()]) });
  const runId = await start(m, src, { limits: { roundsPerStage: 1 } });
  let v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason, v.progress.findings.openBlocking], ["paused", "limit_reached", 1]);
  assert.equal(v.decisions.findings, true, "the person may decide a finding on this pause");
  assert.ok(availableActions(v).includes("person_decide"));
  // only an open finding, only a blocking one made a wish; a condition is not decided here
  assert.equal((await decide(m, v, { subject: "finding", target: "F9", decision: "to_wish", finding: null })).code, "invalid_state");
  assert.equal((await decide(m, v, { subject: "condition", target: "C1", decision: "met", finding: null })).code, "invalid_state");
  assert.equal((await decide(m, v, { subject: "finding", target: "F1", decision: "to_wish", finding: null })).status, "accepted");
  v = await view(m, runId);
  assert.deepEqual([v.status, v.reason, v.progress.findings.openBlocking], ["paused", "limit_reached", 0], "the decision does not continue the run by itself here");
  assert.equal((await sendAs(m, v, { kind: "raise_limit", limit: "roundsPerStage", value: 2 })).status, "accepted");
  assert.equal((await sendAs(m, await view(m, runId), { kind: "resume" })).status, "accepted");
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify((await records(m, runId)).slice(-12).map((r) => [r.type, r.data.status ?? r.data.purpose ?? r.data.kind ?? "", r.data.reason ?? ""])));
  const f1 = done.progress.findings.items[0];
  assert.deepEqual([f1.severity, f1.status, f1.downgraded, f1.history.at(-1).kind, f1.history.at(-1).by], ["wish", "open", true, "to_wish", "person"]);
  assert.equal(personDecisionsLine("ru", done), "Решения человека вместо доказательств: понижено F1");
  assert.equal(personDecisionsLine("en", done), "The person's decisions instead of evidence: downgraded F1");
  const all = await records(m, runId);
  const basis = JSON.parse(textOf(m, runId, all.at(-1).data.completion.basis));
  assert.deepEqual(basis.person.downgraded, ["F1"]);
  assert.equal(all.at(-1).data.completion.kind, "confirmed");
  // the next reviewer is told it was the person's
  await m.shutdown();
  assert.equal((await readRun(m.root, runId)).integrity.status, "ok");
});

// ---------------- dropped by a plan proposal ----------------

const DROP = [
  plan([["ab", [change("a.txt says 2", ["R1"]), change("b.txt says 2", ["R2"])]]]),
  exec({ "a.txt": "2\n" }),
  review([], [mark("C1"), mark("C2", "not_met")], "replan"),
  plan([["a", [keep("C1")]]], [{ condition: "C2", why: "WHY-C2" }], [{ requirement: "R2", why: "WHY-R2" }])
];
const twoCriteria = { criteria: ["a.txt says 2", "b.txt says 2"] };

test("a plan dropping a condition and a requirement is a proposal: the autopilot waits; accepted, the run completes — the result says what was dropped, never met", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([...DROP, exec({ "a.txt": "2\n" }, "again"), review([], [mark("C1")]), final([], [["R1", "met"]])]) });
  const runId = await start(m, src, twoCriteria);
  await settled(m, runId);
  const v = await waitsFor(m, runId, "coverage_lost");
  assert.deepEqual(availableActions(v), ["plan_decide", "stop"]);
  assert.equal((await sendAs(m, v, { kind: "resume" })).code, "invalid_state");
  const p = v.decisions.proposal;
  assert.deepEqual([p.dropped.map((x) => [x.id, x.why]), p.dropRequirements.map((x) => [x.id, x.why]), p.uncovered, p.findings], [[["C2", "WHY-C2"]], [["R2", "WHY-R2"]], ["R2"], []]);
  // «uncovered»: what the proposal leaves without a condition in force (R2 here, dropped with it)
  let all = await records(m, runId);
  assert.deepEqual(all.filter((r) => r.type === "plan.recorded").length, 1, "the plan in force stays");
  assert.equal(all.filter((r) => r.type === "plan.proposed").length, 1);
  // a choice for a finding that is not one of the proposal's: refused
  assert.equal((await sendAs(m, v, { kind: "plan.decide", proposalTurnId: p.proposalTurnId, decision: "accept", choices: [{ id: "F1", choice: "close", stage: null, condition: null }], note: null, runKey: v.decisions.runKey })).code, "invalid_command");
  assert.equal((await sendAs(m, v, { kind: "plan.decide", proposalTurnId: p.proposalTurnId, decision: "accept", choices: [], note: null, runKey: v.decisions.runKey })).status, "accepted");
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify([done.status, done.reason, turnsOf(await records(m, runId))]));
  all = await records(m, runId);
  const decided = all.find((r) => r.type === "plan.decided").data;
  assert.deepEqual([decided.decision, decided.version, decided.runKey, /^[0-9a-f]{40}$/.test(decided.tree)], ["accept", 2, v.decisions.runKey, true]);
  const c = done.progress.conditions;
  assert.deepEqual(c.requirements.map((r) => [r.id, r.status, r.why ?? null]), [["R1", "met", null], ["R2", "dropped", "WHY-R2"]]);
  assert.deepEqual(c.dropped.map((x) => [x.id, x.why]), [["C2", "WHY-C2"]]);
  assert.deepEqual([c.met, c.total], [1, 1], "a dropped condition is not counted as met");
  assert.equal(personDecisionsLine("ru", done), "Решения человека вместо доказательств: снято C2, R2");
  // the completion's basis: the requirement dropped, not met; the person's section names both
  const basis = JSON.parse(textOf(m, runId, all.at(-1).data.completion.basis));
  assert.deepEqual(basis.requirements, [{ id: "R1", conditions: ["C1"], met: true }, { id: "R2", conditions: [], met: false, dropped: true }]);
  assert.deepEqual([basis.person.droppedConditions, basis.person.droppedRequirements], [["C2"], ["R2"]]);
  await m.shutdown();
  // the completion function counts the drop: without it, R2 is unmet and the run cannot complete
  const r = await readRun(m.root, runId);
  assert.equal(r.integrity.status, "ok");
  const read = async (ref) => JSON.parse(textOf(m, runId, ref));
  const goal = await decidedGoal(m.root, runId, r.state, await read(r.state.goal));
  const cs = await loadConditions(r.state, read);
  const snapshot = { tree: basis.tree, runKey: basis.runKey, checkKeys: basis.checkKeys };
  assert.deepEqual(completion(r.state, goal, snapshot, conditionFacts(r.state, goal, cs, snapshot.checkKeys), { open: 0, disputed: 0 }), { allowed: true, kind: "confirmed" });
  cs.book.droppedRequirements.clear();
  assert.deepEqual(completion(r.state, goal, snapshot, conditionFacts(r.state, goal, cs, snapshot.checkKeys), { open: 0, disputed: 0 }).allowed, false);
});

test("a proposal returned to the lead: the plan in force stays, the next plan turn gets the person's note", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([...DROP, plan([["ab", [keep("C1"), keep("C2")]]])]) });
  const runId = await start(m, src, twoCriteria);
  const v = await settled(m, runId);
  assert.equal(v.reason, "coverage_lost");
  const p = v.decisions.proposal;
  assert.equal((await sendAs(m, v, { kind: "plan.decide", proposalTurnId: p.proposalTurnId, decision: "return", choices: [], note: "KEEP-XLSX-PLEASE", runKey: v.decisions.runKey })).status, "accepted");
  await until(async () => (await records(m, runId)).filter((r) => r.type === "plan.recorded").length === 2, "the next plan");
  const all = await records(m, runId);
  const decided = all.find((r) => r.type === "plan.decided").data;
  assert.deepEqual([decided.decision, decided.version], ["return", null]);
  const task = tasksOf(m, runId, all, "lead").at(-1);
  assert.match(task, /KEEP-XLSX-PLEASE/);
  assert.equal(all.some((r) => r.type === "plan.recorded" && r.data.turnId === p.proposalTurnId), false, "the returned proposal is never a plan");
  await m.shutdown();
});

// ---------------- the freshness of "change" evidence ----------------

test("a «change» condition whose files changed after its stage was accepted: not counted until the final review confirms it; refused there, it returns to the next plan", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([
    plan([["a", [change("a.txt says 2", ["R1"])]], ["b", [change("b.txt says 2", ["R2"])]]]),
    exec({ "a.txt": "2\n" }), review([], [mark("C1")]),
    exec({ "b.txt": "2\n", "a.txt": "2\nedited later\n" }), review([], [mark("C2", "met", ["b.txt"])]),
    final([], [["R1", "met"], ["R2", "met"]]), // C1 is stale and not confirmed: an invalid report
    final([], [["R1", "not_met"], ["R2", "met"]], [mark("C1", "not_met")]), // refused: C1 returns
    plan([["b2", [change("a.txt is clean", ["R1"])]]]), // C1 neither kept nor dropped: invalid
    plan([["a2", [keep("C1")]]]),
    exec({ "a.txt": "2\n" }), review([], [mark("C1")]), final([], [["R1", "met"], ["R2", "met"]])
  ]) });
  const runId = await start(m, src, twoCriteria);
  let v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "invalid_report"]);
  const c1 = v.progress.conditions.conditions.find((x) => x.id === "C1");
  assert.deepEqual([c1.stale, c1.status === "met"], [true, false], JSON.stringify(v.progress.conditions));
  // one step (one operation), then on: the final review again refuses C1 (not met), and the plan that loses C1 is invalid
  assert.equal((await sendAs(m, v, { kind: "step" })).status, "accepted");
  v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "step_done"]);
  assert.equal((await sendAs(m, v, { kind: "resume" })).status, "accepted");
  v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "invalid_report"], "the plan that loses C1");
  assert.equal(v.progress.conditions.conditions.find((x) => x.id === "C1").status, "not_met", "refused by the final review");
  let all = await records(m, runId);
  assert.deepEqual(turnsOf(all).slice(5), ["final_review", "final_review", "plan"]);
  assert.match(tasksOf(m, runId, all, "lead").at(-1), /C1/, "the plan turn is told C1 returns");
  assert.equal((await sendAs(m, v, { kind: "step" })).status, "accepted");
  v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "step_done"]);
  assert.equal((await sendAs(m, v, { kind: "resume" })).status, "accepted");
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify([done.status, done.reason]));
  all = await records(m, runId);
  assert.deepEqual(turnsOf(all), ["plan", "execute", "review", "execute", "review", "final_review", "final_review", "plan", "plan", "execute", "review", "final_review"]);
  const conds = done.progress.conditions.conditions;
  assert.deepEqual(conds.map((x) => [x.id, x.stage, x.status, x.stale ?? false]), [["C2", 2, "met", false], ["C1", 3, "met", false]]);
  await m.shutdown();
  assert.equal((await readRun(m.root, runId)).integrity.status, "ok");
});

// ---------------- the torn tail and command recovery ----------------

test("a torn tail is cut off on opening (only the torn bytes); a decision recorded before its command.completed stands after a restart, the repeat changes nothing", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const root = path.join(TMP, `root-${++n}`);
  const env = { MOCK_SCRIPT: script(DISPUTED) };
  const m = manager(env, { root });
  const runId = await start(m, src);
  const v = await settled(m, runId);
  assert.equal(v.reason, "awaiting_person_decision");
  const target = { reviewTurnId: v.decisions.disputed[0].reviewTurnId, index: 0 };
  const command = { kind: "person.decide", subject: "disputed", target, decision: "repeat", finding: "F1", runKey: v.decisions.runKey };
  const commandId = randomUUID();
  assert.equal((await sendAs(m, v, command, commandId)).status, "accepted");
  await settled(m, runId);
  await m.shutdown();
  // the application ended after the decision and before its command.completed; the last line was half written
  const file = journalFile(m, runId);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const cut = lines.findIndex((l) => l.includes('"type":"command.completed"') && l.includes(commandId));
  const kept = `${lines.slice(0, cut).join("\n")}\n`;
  fs.writeFileSync(file, `${kept}{"v":2,"seq":${cut},"ts":"2026-10-0`);
  assert.equal(parseJournal(fs.readFileSync(file), runId).integrity.status, "torn_tail");
  const again = manager(env, { root });
  const r = await again.command(runId, { commandId, expectedRevision: v.revision, command });
  assert.equal(r.value?.status, "accepted", JSON.stringify(r));
  const after = fs.readFileSync(file, "utf8");
  assert.ok(after.startsWith(kept), "nothing before the torn line is lost");
  assert.equal(after.includes('"ts":"2026-10-0\n') || after.includes('"seq":' + cut + ',"ts":"2026-10-0{'), false, "the torn bytes are gone");
  const all = await records(again, runId);
  assert.equal(all.filter((x) => x.type === "person.decided").length, 1, "the repeat recorded nothing");
  assert.deepEqual(all.find((x) => x.type === "command.completed" && x.data.commandId === commandId).data.result, { status: "accepted", code: null });
  const w = await view(again, runId);
  assert.deepEqual([w.status, w.reason], ["paused", "recovered"]);
  assert.equal((await sendAs(again, w, { kind: "resume" })).status, "accepted");
  assert.equal((await settled(again, runId)).status, "completed");
  await again.shutdown();
});

test("a person's command received but not decided before a restart: rejected as interrupted; continuing leads back to the person's pause, its decision stays the person's", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const root = path.join(TMP, `root-${++n}`);
  const env = { MOCK_SCRIPT: script(DISPUTED) };
  const m = manager(env, { root });
  const runId = await start(m, src);
  const v = await settled(m, runId);
  const target = { reviewTurnId: v.decisions.disputed[0].reviewTurnId, index: 0 };
  const commandId = randomUUID();
  assert.equal((await sendAs(m, v, { kind: "person.decide", subject: "disputed", target, decision: "repeat", finding: "F1", runKey: v.decisions.runKey }, commandId)).status, "accepted");
  await settled(m, runId);
  await m.shutdown();
  const file = journalFile(m, runId);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const cut = lines.findIndex((l) => l.includes('"type":"person.decided"'));
  fs.writeFileSync(file, `${lines.slice(0, cut).join("\n")}\n`);
  const again = manager(env, { root });
  const command = { kind: "person.decide", subject: "disputed", target, decision: "repeat", finding: "F1", runKey: v.decisions.runKey };
  // the same request again opens the run: its command was not decided — rejected, nothing recorded
  const r = await again.command(runId, { commandId, expectedRevision: v.revision, command });
  assert.deepEqual([r.value?.status, r.value?.code], ["rejected", "interrupted"], JSON.stringify(r));
  let all = await records(again, runId);
  assert.equal(all.some((x) => x.type === "person.decided"), false);
  // opened after the end: «recovered» (as any run with unfinished work); continuing it leads back to the person's pause
  const back = await view(again, runId);
  assert.deepEqual([back.status, back.reason], ["paused", "recovered"]);
  assert.equal((await sendAs(again, back, { kind: "resume" })).status, "accepted");
  const w = await settled(again, runId);
  assert.deepEqual([w.status, w.reason, w.decisions.disputed.length], ["paused", "awaiting_person_decision", 1], "the pause stays the person's");
  assert.equal((await waitsFor(again, runId, "awaiting_person_decision")).reason, "awaiting_person_decision", "nothing decides it after a restart");
  assert.equal(all.filter((x) => x.type === "orch.turn").length, (await records(again, runId)).filter((x) => x.type === "orch.turn").length, "no turn ran");
  assert.equal((await decide(again, w, { subject: "disputed", target, decision: "repeat", finding: "F1" })).status, "accepted");
  assert.equal((await settled(again, runId)).status, "completed");
  all = await records(again, runId);
  assert.equal(all.filter((x) => x.type === "person.decided").length, 1);
  await again.shutdown();
});

// ---------------- forged decisions ----------------

test("IPC: a person's decision carries exactly its fields — who decided or a role is not the renderer's to say", () => {
  const base = { runId: randomUUID(), commandId: randomUUID(), expectedRevision: 3 };
  const runKey = "a".repeat(64);
  const ok = (command) => parseCommand({ ...base, command }).command;
  assert.deepEqual(ok({ kind: "person.decide", subject: "finding", target: "F1", decision: "to_wish", finding: null, runKey }),
    { kind: "person.decide", subject: "finding", target: "F1", decision: "to_wish", finding: null, runKey });
  for (const extra of [{ by: "autopilot" }, { by: "person" }, { role: "lead" }, { tree: "b".repeat(40) }, { reopened: true }]) {
    assert.throws(() => ok({ kind: "person.decide", subject: "finding", target: "F1", decision: "close", finding: null, runKey, ...extra }), JSON.stringify(extra));
    assert.throws(() => ok({ kind: "plan.decide", proposalTurnId: randomUUID(), decision: "accept", choices: [], note: null, runKey, ...extra }), JSON.stringify(extra));
  }
  assert.throws(() => ok({ kind: "person.decide", subject: "condition", target: "C1", decision: "close", finding: null, runKey }), "a condition is met or not met");
  assert.throws(() => ok({ kind: "person.decide", subject: "finding", target: "C1", decision: "close", finding: null, runKey }), "a finding is F<n>");
  assert.throws(() => ok({ kind: "person.decide", subject: "finding", target: "F1", decision: "close", finding: null, runKey: "x" }));
});

// ---------------- replay ----------------

test("replay: push of a run without checks delivering another tree than the person confirmed — corrupt (texts); as written, ok", async () => {
  const id = fs.readdirSync(FIXTURES).find((x) => fs.readFileSync(path.join(FIXTURES, x, "FIXTURE"), "utf8").trim() === "07-no-checks-push-confirmed");
  const root = path.join(TMP, `fx-${++n}`);
  fs.cpSync(path.join(FIXTURES, id), path.join(root, "runs", id), { recursive: true });
  assert.deepEqual([(await readRun(root, id)).integrity.status], ["ok"]);
  const file = path.join(root, "runs", id, "journal.jsonl");
  const recs = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const push = recs.find((r) => r.type === "finish.intent" && r.data.step === "push");
  const params = JSON.parse(fs.readFileSync(path.join(root, "runs", id, "texts", push.data.params.sha256), "utf8"));
  const body = canonical({ ...params, push: { ...params.push, tree: "f".repeat(40) } });
  const ref = { sha256: sha256Hex(body), bytes: Buffer.byteLength(body) };
  fs.writeFileSync(path.join(root, "runs", id, "texts", ref.sha256), body);
  push.data.params = ref;
  let prev = null;
  const out = [];
  for (const r of recs) {
    const { record, line } = buildRecord(prev, id, r.ts, r.type, r.data, 2, prev === null ? { minReaderVersion: 2 } : null);
    out.push(line);
    prev = record;
  }
  fs.writeFileSync(file, Buffer.concat(out));
  const r = await readRun(root, id);
  assert.deepEqual([r.integrity.status, r.integrity.detail?.phase, r.canContinue], ["corrupt", "texts", false]);
});
