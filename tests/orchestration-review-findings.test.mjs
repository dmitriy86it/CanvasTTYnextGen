// Journal v2, A3 (docs/agent-orchestration/implementation/journal-v2-format.md §2.8): the reviewer — Codex in a new
// session per review — reports findings F<n> numbered by the application, never renumbered; a blocking one holds its
// stage and the completion until a later review closes it on a changed tree. review.assessed records each result with
// what the application did with it; the replay rechecks it. Fake CLIs (MOCK_SCRIPT, MOCK_CHECKS) only; the goal's own
// commands run in the person's shell (no Seatbelt needed: Linux CI has none).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { completion } from "../src/main/services/orchestration/cycle.ts";
import { applyApplied, emptyFindings, openBlocking, planReview } from "../src/main/services/orchestration/findings.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { findingsKey } from "../src/main/services/orchestration/progress.ts";
import { buildRecord, parseJournal } from "../src/main/services/orchestration/journal.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { conditionFacts, decidedGoal, findingsView, loadConditions } from "../src/main/services/orchestration/orchestrationService.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { readRun } from "../src/main/services/orchestration/store.ts";
import { activityRuns, findingsLine, roleStatus } from "../src/renderer/src/features/orchestration/runStatus.ts";
import { agentState, cardRole } from "../src/renderer/src/features/orchestration/runModel.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "docs", "agent-orchestration", "implementation", "v2-fixtures", "runs");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-a3-")));
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
async function start(m, src, goal = {}) {
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), checks: ["false"] });
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["a.txt says 2"], checks: [], commands: ["grep -qx 2 a.txt"], mode: "autopilot", ...goal } });
  assert.ok(r.ok, JSON.stringify(r));
  return runId;
}
// A journal rebuilt by fn (records in, records out), re-chained as this build writes it (head: as an A1–A3 development
// build wrote it, PREVIEW).
const PREVIEW = { minReaderVersion: 2, formatPreview: true };
function rewrite(buf, runId, fn, head = { minReaderVersion: 2 }) {
  const recs = fn(buf.toString().trim().split("\n").map((l) => JSON.parse(l)));
  const out = [];
  let prev = null;
  for (const r of recs) {
    const { record, line } = buildRecord(prev, runId, r.ts, r.type, r.data, 2, prev === null ? head : null);
    out.push(line);
    prev = record;
  }
  return Buffer.concat(out);
}
function putText(m, runId, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(m.root, "runs", runId, "texts", sha256), bytes);
  return { sha256, bytes: bytes.length };
}
const integrityOf = async (m, runId) => { const r = await readRun(m.root, runId); return [r.integrity.status, r.integrity.detail?.phase ?? null, r.canContinue]; };

const b64 = (s) => Buffer.from(s).toString("base64");
const writes = (files) => Object.entries(files).map(([rel, text]) => ({ rel, base64: b64(text) }));
const exec = (files, summary = "done") => ({ answer: { summary, done: true }, writes: writes(files) });
const C1 = { keep: null, text: "a.txt says 2", covers: ["R1"], evidence: { kind: "change", check: null } };
const PLAN = { answer: { stages: [{ title: "a", task: "make a.txt say 2", conditions: [C1] }], dropped: [], dropRequirements: [], question: null } };
const met = (...paths) => [{ id: "C1", status: "met", paths, note: "C1" }];
// the reviewer's answers (journal-v2-format.md §2.8)
const finding = ({ id = null, severity = "blocking", condition = null, problem = "a problem", paths = ["a.txt"], status = "open", relation = null } = {}) =>
  ({ id, severity, condition, problem, evidence: "seen in the file", closeWhen: "it is fixed", status, paths, relation });
const review = (findings, marks = met("a.txt"), request = "none") => ({ answer: { conditions: marks, findings, request, question: null } });
const final = (findings = []) => ({ answer: { conditions: [], findings, request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "R1" }] } });
const turnsOf = (all) => all.filter((r) => r.type === "orch.turn").map((r) => r.data.purpose);
const tasksOf = (m, runId, all, role) => all.filter((r) => r.type === "turn.intent" && r.data.role === role).map((r) => textOf(m, runId, r.data.task));

// ---------------- the rules, pure (5h §3.4) ----------------

test("numbering: new findings take the next numbers and keep them; naming a number that is not there, or changing a severity — a violation", () => {
  const book = emptyFindings();
  const ctx = (tree, runKey) => ({ turnId: randomUUID(), seq: ++n, runKey, tree, stage: 1, changedSince: () => new Set(["a.txt", "b.txt"]), stageConditions: ["C1"], conditions: ["C1"] });
  const first = [finding({ problem: "x" }), finding({ severity: "wish", paths: [], problem: "y" })];
  const r1 = planReview(book, first, ctx("t1", "k1"));
  assert.deepEqual(r1.problems, []);
  assert.deepEqual(r1.applied.opened.map((o) => [o.id, o.index, o.severity]), [["F1", 0, "blocking"], ["F2", 1, "wish"]]);
  applyApplied(book, { ...r1.applied, report: { sha256: "0".repeat(64), bytes: 1 }, conditionsMet: [] }, first, ctx("t1", "k1"));
  // a repeated review: F1 closed, F2 named as it is, one new — F3; nothing renumbered
  const second = [finding({ id: "F1", status: "closed", paths: ["b.txt"] }), finding({ id: "F2", severity: "wish", paths: [] }), finding({ problem: "z" })];
  const r2 = planReview(book, second, ctx("t2", "k2"));
  assert.deepEqual(r2.problems, []);
  assert.deepEqual([r2.applied.closed, r2.applied.unchanged, r2.applied.opened.map((o) => o.id), r2.applied.nextFinding], [[{ id: "F1", index: 0 }], [{ id: "F2", index: 1 }], ["F3"], 4]);
  // renumbered: F1 named F3 (no such finding) — and a severity changed
  assert.match(planReview(book, [finding({ id: "F3" })], ctx("t2", "k2")).problems.join(), /F3 is not a finding of this run/);
  assert.match(planReview(book, [finding({ id: "F2", severity: "blocking", paths: [] })], ctx("t2", "k2")).problems.join(), /severity cannot change/);
  assert.match(planReview(book, [finding({ id: "F1" }), finding({ id: "F1" })], ctx("t2", "k2")).problems.join(), /named twice/);
  // by its id and as the repeat of a new one in the same report: named twice as well
  const closed = [finding({ id: "F1", status: "closed", paths: ["b.txt"] })];
  applyApplied(book, { ...planReview(book, closed, ctx("t2", "k2")).applied, report: { sha256: "0".repeat(64), bytes: 1 }, conditionsMet: [] }, closed, ctx("t2", "k2"));
  const twice = [finding({ id: "F1", paths: ["a.txt"] }), finding({ paths: ["a.txt"], relation: { repeatOf: "F1", distinctFrom: null, why: null } })];
  const sameTree = { ...ctx("t2", "k3"), changedSince: () => new Set() };
  assert.match(planReview(book, twice, sameTree).problems.join(), /F1 is named twice/);
  assert.match(planReview(book, [finding({ paths: [] })], ctx("t2", "k2")).problems.join(), /new blocking finding names its paths/);
});

test("closing a blocking finding: never on the state it was opened on, never with no path or a path that did not change since", () => {
  const book = emptyFindings();
  const ctx = (runKey, changed) => ({ turnId: randomUUID(), seq: ++n, runKey, tree: `tree-${runKey}`, stage: 1, changedSince: () => new Set(changed), stageConditions: [], conditions: [] });
  const f = [finding()];
  const r = planReview(book, f, ctx("k1", []));
  applyApplied(book, { ...r.applied, report: { sha256: "0".repeat(64), bytes: 1 }, conditionsMet: [] }, f, ctx("k1", []));
  const close = (paths) => [finding({ id: "F1", status: "closed", paths })];
  assert.match(planReview(book, close(["a.txt"]), ctx("k1", ["a.txt"])).problems.join(), /cannot be closed on the state it was opened on/);
  assert.match(planReview(book, close([]), ctx("k2", ["a.txt"])).problems.join(), /needs the paths changed for it/);
  assert.match(planReview(book, close(["a.txt"]), ctx("k2", ["b.txt"])).problems.join(), /none of a\.txt changed since F1 was opened/);
  assert.deepEqual(planReview(book, close(["b.txt"]), ctx("k2", ["b.txt"])).problems, []);
  // stage A gate: an unchanged file next to a changed one is extra, not a refusal
  assert.deepEqual(planReview(book, close(["b.txt", "a.txt"]), ctx("k2", ["b.txt"])).problems, []);
  assert.equal(openBlocking(book).length, 1, "nothing is applied by planning");
});

test("a possible repeat: a new blocking finding on the unchanged files of a closed one needs a relation; without it — disputed", () => {
  const book = emptyFindings();
  let k = 0;
  const ctx = (changed) => ({ turnId: randomUUID(), seq: ++n, runKey: `k${++k}`, tree: `t${k}`, stage: 1, changedSince: () => new Set(changed), stageConditions: [], conditions: [] });
  const step = (findings, changed) => {
    const c = ctx(changed);
    const r = planReview(book, findings, c);
    assert.deepEqual(r.problems, []);
    applyApplied(book, { ...r.applied, report: { sha256: "0".repeat(64), bytes: 1 }, conditionsMet: [] }, findings, c);
    return r.applied;
  };
  step([finding()], []);
  step([finding({ id: "F1", status: "closed", paths: ["a.txt"] })], ["a.txt"]);
  // declared a repeat on unchanged files: refused (no new evidence)
  assert.deepEqual(step([finding({ relation: { repeatOf: "F1", distinctFrom: null, why: null } })], []).refused.map((x) => x.reason), ["declared_repeat"]);
  assert.deepEqual(step([finding({ problem: "again" })], []).disputed, [{ index: 0, candidates: ["F1"] }]);
  assert.equal(book.disputed.length, 1);
  const relation = { repeatOf: null, distinctFrom: "F1", why: "another problem" };
  assert.deepEqual(step([finding({ problem: "other", relation })], []).opened.map((o) => [o.id, o.possibleRepeatOf]), [["F2", "F1"]]);
  // one distinctFrom per closed finding on its unchanged files: then any new one on them is disputed, whatever its relation
  assert.equal(step([finding({ problem: "third", relation })], []).disputed.length, 1);
  assert.equal(step([finding({ relation: { repeatOf: "F1", distinctFrom: null, why: null } })], []).disputed.length, 1);
});

// ---------------- a run ----------------

test("a run: the reviewer opens a blocking and a wish, the stage goes back to the executor, a repeated review closes the blocking one on a changed tree; the wish stays visible, the run completes", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([
    PLAN,
    exec({ "a.txt": "2\n" }, "EXECUTOR-SUMMARY-1"),
    review([finding({ problem: "BLOCKING-PROBLEM" }), finding({ severity: "wish", paths: [], problem: "WISH-PROBLEM" })]),
    exec({ "b.txt": "2\n" }),
    review([finding({ id: "F1", status: "closed", paths: ["b.txt"] }), finding({ id: "F2", severity: "wish", paths: [] })]),
    final([finding({ id: "F2", severity: "wish", paths: [] })])
  ]) });
  const runId = await start(m, src);
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v));
  const all = await records(m, runId);
  assert.deepEqual(turnsOf(all), ["plan", "execute", "review", "execute", "review", "final_review"]);
  assert.equal(all.some((r) => r.type === "review.recorded"), false);
  // the reviewer: its own role, the lead's CLI, a new session each time, the tree it reviewed
  const intents = all.filter((r) => r.type === "turn.intent" && r.data.role === "reviewer");
  assert.equal(intents.length, 3);
  assert.ok(intents.every((r) => r.data.provider === "codex" && r.data.sessionId === null));
  const reviewTurns = all.filter((r) => r.type === "orch.turn" && r.data.purpose !== "plan" && r.data.purpose !== "execute");
  assert.ok(reviewTurns.every((r) => /^[0-9a-f]{40}$/.test(r.data.tree)), "a reviewer's turn records its tree");
  assert.ok(all.filter((r) => r.type === "orch.turn" && (r.data.purpose === "plan" || r.data.purpose === "execute")).every((r) => r.data.tree === null));
  // the applied texts: numbers, groups
  const applied = all.filter((r) => r.type === "review.assessed").map((r) => JSON.parse(textOf(m, runId, r.data.applied)));
  assert.deepEqual(applied[0].opened.map((o) => [o.id, o.severity, o.stage]), [["F1", "blocking", 1], ["F2", "wish", 1]]);
  assert.deepEqual([applied[1].closed, applied[1].unchanged, applied[1].opened], [[{ id: "F1", index: 0 }], [{ id: "F2", index: 1 }], []]);
  // what each role was told: the executor the open blocking one of its stage (never the wish); the reviewer no
  // executor's report
  const exec2 = tasksOf(m, runId, all, "executor")[1];
  assert.ok(exec2.includes("F1") && exec2.includes("BLOCKING-PROBLEM") && !exec2.includes("WISH-PROBLEM"), exec2);
  const rev = tasksOf(m, runId, all, "reviewer");
  assert.ok(rev.every((t) => !t.includes("EXECUTOR-SUMMARY-1") && !t.includes("make a.txt say 2")), rev[0]);
  assert.ok(rev[1].includes("- F1 [blocking; open; a.txt]: BLOCKING-PROBLEM") && rev[1].includes("Paths changed since the run started"), rev[1]);
  // the view: F1 closed with its history, F2 an open wish, nothing blocking
  const f = v.progress.findings;
  assert.equal(f.openBlocking, 0);
  assert.deepEqual(f.items.map((x) => [x.id, x.severity, x.status]), [["F1", "blocking", "closed"], ["F2", "wish", "open"]]);
  const reviews = all.filter((r) => r.type === "review.assessed").map((r) => r.data.turnId);
  assert.deepEqual(f.items[0].history.map((h) => [h.kind, h.reviewTurnId]), [["opened", reviews[0]], ["closed", reviews[1]]]);
  assert.notEqual(f.items[0].history[0].tree, f.items[0].history[1].tree);
  assert.equal(findingsLine("ru", v), "Открыто блокирующих: 0");
  await m.shutdown();
  const r = await readRun(m.root, runId);
  assert.deepEqual([r.integrity.status, r.canContinue], ["ok", true], JSON.stringify(r.integrity));
});

test("the completion function: an open blocking finding or a disputed item forbids it; closed by the rules, it is allowed", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, exec({ "a.txt": "2\n" }), review([]), final()]) });
  const runId = await start(m, src);
  assert.equal((await settled(m, runId)).status, "completed");
  await m.shutdown();
  const r = await readRun(m.root, runId);
  const read = async (ref) => JSON.parse(textOf(m, runId, ref));
  const goal = await decidedGoal(m.root, runId, r.state, await read(r.state.goal));
  const c = await loadConditions(r.state, read);
  const basis = await read(r.state.completion.basis);
  const snapshot = { tree: basis.tree, runKey: basis.runKey, checkKeys: basis.checkKeys };
  const facts = conditionFacts(r.state, goal, c, snapshot.checkKeys);
  assert.deepEqual(completion(r.state, goal, snapshot, facts, { open: 0, disputed: 0 }), { allowed: true, kind: "confirmed" });
  assert.deepEqual(completion(r.state, goal, snapshot, facts, { open: 1, disputed: 0 }), { allowed: false, blockers: ["blocking_open"] });
  assert.deepEqual(completion(r.state, goal, snapshot, facts, { open: 0, disputed: 1 }), { allowed: false, blockers: ["disputed_pending"] });
});

test("the reviewer renumbers a finding, closes one on the same tree, or closes it naming a file that did not change — invalid_report, nothing applied; the next review is told why", OPTS, async () => {
  const cases = [
    [exec({ "b.txt": "2\n" }), review([finding({ id: "F2", problem: "the same one, renumbered" })]), /F2 is not a finding of this run/],
    [exec({}), review([finding({ id: "F1", status: "closed", paths: ["a.txt"] })]), /cannot be closed on the state it was opened on/],
    [exec({ "b.txt": "2\n" }), review([finding({ id: "F1", status: "closed", paths: ["a.txt"] })]), /none of a\.txt changed since F1 was opened/]
  ];
  for (const [fix, bad, why] of cases) {
    const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
    const m = manager({ MOCK_SCRIPT: script([PLAN, exec({ "a.txt": "2\n" }), review([finding()]), fix, bad, review([finding({ id: "F1", status: "closed", paths: ["b.txt"] })])]) });
    const runId = await start(m, src);
    const v = await settled(m, runId);
    assert.deepEqual([v.status, v.reason], ["paused", "invalid_report"], String(why));
    let all = await records(m, runId);
    assert.equal(all.filter((r) => r.type === "review.assessed").length, 1, String(why));
    assert.equal(v.progress.findings.openBlocking, 1);
    // a step: the next review is told what was wrong, recomputed from the rejected report
    const r = await m.command(runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "step" } });
    assert.equal(r.value?.status, "accepted", JSON.stringify(r));
    await until(async () => (await records(m, runId)).filter((x) => x.type === "turn.intent" && x.data.role === "reviewer").length === 3, "the next review");
    all = await records(m, runId);
    const task = tasksOf(m, runId, all, "reviewer")[2];
    assert.match(task, /Your previous report was not accepted by the application:\n- findings\[0\]: /, String(why));
    assert.match(task, why);
    await m.shutdown();
  }
});

test("replay: a stage accepted or a run completed with an open blocking finding — corrupt (texts), the run cannot continue", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([
    PLAN, exec({ "a.txt": "2\n" }), review([finding()]), exec({ "b.txt": "2\n" }), review([finding({ id: "F1", status: "closed", paths: ["b.txt"] })]), final()
  ]) });
  const runId = await start(m, src);
  assert.equal((await settled(m, runId)).status, "completed");
  await m.shutdown();
  const all = await records(m, runId);
  const buf = fs.readFileSync(journalFile(m, runId));
  const outcome = async (fn) => { fs.writeFileSync(journalFile(m, runId), rewrite(buf, runId, fn)); return integrityOf(m, runId); };
  // a review's report and its application, forged together (consistent with each other)
  const forge = (turnId, report, applied) => (recs) => {
    const ref = putText(m, runId, report);
    for (const x of recs) {
      if (x.type === "turn.finished" && x.data.turnId === turnId) x.data.report = { ...x.data.report, ref };
      if (x.type === "review.assessed" && x.data.turnId === turnId) { x.data.report = ref; x.data.applied = putText(m, runId, { ...applied, report: ref }); }
    }
    return recs;
  };
  const [, closing, finalTurn] = all.filter((r) => r.type === "review.assessed").map((r) => r.data);
  const appliedOf = (d) => JSON.parse(textOf(m, runId, d.applied));
  assert.deepEqual(await outcome((r) => r), ["ok", null, true], "as written");
  // the closing review forged to leave F1 open: the stage was accepted with it
  const keepOpen = forge(closing.turnId, review([finding({ id: "F1" })]).answer, { ...appliedOf(closing), closed: [], unchanged: [{ id: "F1", index: 0 }] });
  assert.deepEqual(await outcome(keepOpen), ["corrupt", "texts", false], "accepted with F1 open");
  const upToAccepted = (fn) => (r) => fn(r).slice(0, r.findIndex((x) => x.type === "stage.accepted") + 1);
  assert.deepEqual(await outcome(upToAccepted(keepOpen)), ["corrupt", "texts", false], "accepted with F1 open, the run not completed yet");
  // the final review forged to open a blocking one: «Завершено» with it open
  const opened = { id: "F2", index: 0, severity: "blocking", condition: null, stage: null, paths: ["a.txt"], possibleRepeatOf: null };
  const openAtEnd = forge(finalTurn.turnId, final([finding({ problem: "late" })]).answer, { ...appliedOf(finalTurn), opened: [opened], nextFinding: 3 });
  assert.deepEqual(await outcome(openAtEnd), ["corrupt", "texts", false], "completed with F2 open");
  // the same without the completion (the journal before run.status completed): it may go on
  assert.deepEqual(await outcome((r) => openAtEnd(r).filter((x) => !(x.type === "run.status" && x.data.status === "completed"))), ["ok", null, true]);
  // the closing report forged against the live rules: closed without paths, its severity changed, on the opening state,
  // a request other than recorded, an opened finding of another stage
  const closingApplied = appliedOf(closing);
  const closeWith = (over) => forge(closing.turnId, review([finding({ id: "F1", status: "closed", paths: ["b.txt"], ...over })]).answer, closingApplied);
  assert.deepEqual(await outcome(closeWith({ paths: [] })), ["corrupt", "texts", false], "closed without paths");
  assert.deepEqual(await outcome(closeWith({ severity: "wish" })), ["corrupt", "texts", false], "severity changed");
  const opening = all.find((r) => r.type === "review.assessed").data;
  assert.deepEqual(await outcome((r) => { for (const x of r) if (x.type === "review.assessed" && x.data.turnId === closing.turnId) x.data.runKey = opening.runKey; return r; }),
    ["corrupt", "texts", false], "closed on the opening state");
  assert.deepEqual(await outcome(forge(closing.turnId, review([finding({ id: "F1", status: "closed", paths: ["b.txt"] })], met("a.txt"), "replan").answer, closingApplied)),
    ["corrupt", "texts", false], "request replan recorded as none");
  const openingApplied = appliedOf(opening);
  assert.deepEqual(await outcome(forge(opening.turnId, review([finding()]).answer, { ...openingApplied, opened: openingApplied.opened.map((o) => ({ ...o, stage: 99 })) })),
    ["corrupt", "texts", false], "opened for another stage");
  // renumbered in the applied text, or a result for a turn that is not the last
  assert.deepEqual(await outcome(forge(closing.turnId, review([finding({ id: "F1", status: "closed", paths: ["b.txt"] })]).answer, { ...appliedOf(closing), nextFinding: 5 })), ["corrupt", "texts", false]);
  const moved = (recs) => { const i = recs.findIndex((x) => x.type === "review.assessed"); const [x] = recs.splice(i, 1); recs.splice(recs.length - 2, 0, x); return recs; };
  assert.deepEqual(await outcome(moved), ["corrupt", null, false]);
  assert.equal((await readRun(m.root, runId)).integrity.detail.code, "replay_conflict");
  fs.writeFileSync(journalFile(m, runId), buf);
});

test("the tree changes during a review: the review is dropped (review.discarded), retried once, then the person decides; resume allows one more", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const touching = (text) => ({ ...review([]), writes: writes({ "b.txt": text }) });
  const m = manager({ MOCK_SCRIPT: script([PLAN, exec({ "a.txt": "2\n" }), touching("x\n"), touching("y\n"), review([]), final()]) });
  const runId = await start(m, src);
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "tree_changed_during_review"]);
  let all = await records(m, runId);
  assert.equal(all.filter((r) => r.type === "review.discarded").length, 2);
  assert.equal(all.some((r) => r.type === "review.assessed"), false);
  const r = await m.command(runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "resume" } });
  assert.equal(r.value?.status, "accepted", JSON.stringify(r));
  assert.equal((await settled(m, runId)).status, "completed");
  all = await records(m, runId);
  assert.deepEqual(turnsOf(all), ["plan", "execute", "review", "review", "review", "final_review"]);
  await m.shutdown();
  assert.deepEqual(await integrityOf(m, runId), ["ok", null, true]);
});

test("the final review opens a blocking finding: the run is not completed — a new plan follows", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, exec({ "a.txt": "2\n" }), review([]), final([finding({ problem: "b.txt is stale", paths: ["b.txt"] })])]) });
  const runId = await start(m, src);
  const v = await settled(m, runId); // the plan turn has no scripted answer: it fails, and the run pauses
  assert.equal(v.status, "paused");
  assert.equal(v.progress.findings.openBlocking, 1);
  const all = await records(m, runId);
  assert.deepEqual(turnsOf(all), ["plan", "execute", "review", "final_review", "plan"]);
  const planTask = textOf(m, runId, all.filter((r) => r.type === "turn.intent").at(-1).data.task);
  assert.ok(planTask.includes("Why a new plan is needed: the reviewer's last review of plan v1 (the final review) left the goal unmet.") && planTask.includes("b.txt is stale"), planTask);
  await m.shutdown();
});

test("a blocking finding bound to a condition of an accepted stage reaches the next plan's executor; its stage is not accepted while it is open", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n", "c.txt": "1\n" });
  const C2 = { keep: null, text: "b.txt says 2", covers: ["R1"], evidence: { kind: "change", check: null } };
  // C1, bound to the open F1, is returned by the refused final review (A4, 5h §3.8): the next plan keeps it
  const PLAN2 = { answer: { stages: [{ title: "b", task: "make b.txt say 2", conditions: [{ keep: "C1", text: null, covers: null, evidence: null }, C2] }], dropped: [], dropRequirements: [], question: null } };
  const marks = [{ id: "C1", status: "met", paths: ["a.txt"], note: "C1" }, { id: "C2", status: "met", paths: ["b.txt"], note: "C2" }];
  const m = manager({ MOCK_SCRIPT: script([
    PLAN, exec({ "a.txt": "2\n" }), review([]),
    final([finding({ condition: "C1", problem: "C1-IS-WRONG" })]), // bound to C1, whose stage 1 is accepted
    PLAN2, exec({ "b.txt": "2\n" }, "first try"), review([], marks),
    exec({ "c.txt": "2\n" }), review([finding({ id: "F1", condition: "C1", status: "closed", paths: ["c.txt"] })], marks),
    final()
  ]) });
  const runId = await start(m, src);
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v));
  const all = await records(m, runId);
  assert.deepEqual(turnsOf(all), ["plan", "execute", "review", "final_review", "plan", "execute", "review", "execute", "review", "final_review"]);
  const execs = tasksOf(m, runId, all, "executor");
  assert.ok(execs[1].includes("C1-IS-WRONG") && execs[2].includes("C1-IS-WRONG"), execs[1]);
  assert.equal(all.filter((r) => r.type === "stage.accepted").length, 2);
  await m.shutdown();
});

test("discarded reviews count only in a row: a review applied between two discards starts the count again", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n", "c.txt": "1\n" });
  const touching = (r, text) => ({ ...r, writes: writes({ "c.txt": text }) });
  const m = manager({ MOCK_SCRIPT: script([
    PLAN, exec({ "a.txt": "2\n" }), touching(review([]), "x\n"), review([finding()]), exec({ "b.txt": "2\n" }),
    touching(review([]), "y\n"), review([finding({ id: "F1", status: "closed", paths: ["b.txt"] })]), final()
  ]) });
  const runId = await start(m, src);
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify([v.status, v.reason]));
  assert.equal((await records(m, runId)).filter((r) => r.type === "review.discarded").length, 2);
  await m.shutdown();
});

test("a disputed finding: the run waits for the person — resume and clarify are refused (the person decides, A4); the run is not completed", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "1\n" });
  // F1 on a.txt closed; the final review opens a blocking one on a.txt, unchanged since, without saying how they relate
  const m = manager({ MOCK_SCRIPT: script([
    PLAN, exec({ "a.txt": "2\n" }), review([finding()]), exec({ "b.txt": "2\n" }), review([finding({ id: "F1", status: "closed", paths: ["b.txt"] })]),
    final([finding({ problem: "like F1", paths: ["a.txt"] })])
  ]) });
  const runId = await start(m, src);
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "awaiting_person_decision"]);
  assert.deepEqual(v.progress.findings.disputed.map((d) => d.candidates), [["F1"]]);
  const all = await records(m, runId);
  assert.deepEqual([all.some((r) => r.type === "stage.accepted"), v.progress.completion], [true, null]);
  assert.equal((await m.command(runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "resume" } })).value?.status, "rejected");
  assert.equal((await m.command(runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "clarify", text: "go on" } })).value?.status, "rejected");
  await m.shutdown();
});

// ---------------- regressions ----------------

test("A1 no_checks with the reviewer: completed without checks; a wish never blocks it", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, exec({ "a.txt": "2\n" }), review([finding({ severity: "wish", paths: [] })]), final()]), MOCK_CHECKS: "none" });
  const runId = await start(m, src, { commands: [] });
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.progress.completion, v.progress.findings.openBlocking, v.progress.findings.items.length], ["completed", "no_checks", 0, 1]);
  await m.shutdown();
});

test("a journal the lead reviewed (A1–A2): with v2 on, read only and never continued; replayed as the development builds did, it goes with the lead, and a reviewer's result in it is a replay_conflict", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const MOCK_STATE = fs.mkdtempSync(path.join(TMP, "state-")); // the lead's session goes on in the second manager
  const m = manager({ MOCK_SCRIPT: script([PLAN, exec({ "a.txt": "2\n" }), review([]), final()]), MOCK_STATE });
  const runId = await start(m, src);
  assert.equal((await settled(m, runId)).status, "completed");
  await m.shutdown();
  // as A2 wrote it: the lead reviewed (review.recorded), no tree in orch.turn; cut after the stage was accepted
  const buf = fs.readFileSync(journalFile(m, runId));
  const asA2 = (recs) => {
    const cut = recs.findIndex((x) => x.type === "checkpoint.created");
    return recs.slice(0, cut + 1).map((x) => {
      if (x.type === "orch.turn") delete x.data.tree;
      if (x.type === "turn.intent" && x.data.role === "reviewer") x.data.role = "lead";
      if (x.type === "review.assessed") {
        const d = x.data;
        return { ...x, type: "review.recorded", data: { turnId: d.turnId, stage: d.stage, verdict: "accept", findings: null, findingsKey: findingsKey([]), findingsCount: 0, clarificationVersion: d.clarificationVersion, runKey: d.runKey } };
      }
      return x;
    });
  };
  // with v2 on (1.5.8) such a journal is a development build's: shown read only, never continued
  const preview = rewrite(buf, runId, asA2, PREVIEW);
  fs.writeFileSync(journalFile(m, runId), preview);
  const shown = await readRun(m.root, runId);
  assert.deepEqual([shown.integrity.status, shown.integrity.detail.preview, shown.state], ["newer_version", true, null]);
  const m2 = manager({ MOCK_SCRIPT: script([]), MOCK_STATE }, { root: m.root });
  const v = await view(m2, runId);
  const r = await m2.command(runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "resume" } });
  assert.equal(r.code, "run_newer_version", JSON.stringify(r));
  await m2.shutdown();
  assert.deepEqual(fs.readFileSync(journalFile(m, runId)), preview);
  // replayed as the development builds did (the switch off): the lead reviews; a reviewer's result in it — replay_conflict
  const asDev = parseJournal(preview, runId, { previewReadOnly: false });
  assert.deepEqual([asDev.integrity.status, asDev.state.findings ?? null], ["ok", null]);
  const mixed = rewrite(buf, runId, (recs) => { const a2 = asA2(recs); return [...a2, ...recs.slice(a2.length)]; }, PREVIEW);
  assert.equal(parseJournal(mixed, runId, { previewReadOnly: false }).integrity.detail.code, "replay_conflict");
  // A4's final form: the lead's review record is not of this form at all
  fs.writeFileSync(journalFile(m, runId), rewrite(buf, runId, asA2));
  assert.equal((await readRun(m.root, runId)).integrity.detail.code, "invalid_event");
});

// ---------------- the fixtures of the format ----------------

// The records as this build replays them, and the findings from their texts.
test("the fixtures (A4's final form) with the reviewer's results: their records replay, their findings apply; 05-open-blocking has F1 open, blocking, owned by stage 1", async () => {
  let seen = 0;
  for (const id of fs.readdirSync(FIXTURES)) {
    const dir = path.join(FIXTURES, id);
    const name = fs.readFileSync(path.join(dir, "FIXTURE"), "utf8").trim();
    const types = fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
    if (!types.includes("review.assessed")) continue;
    seen += 1;
    const r = parseJournal(fs.readFileSync(path.join(dir, "journal.jsonl")), id);
    assert.equal(r.integrity.status, "ok", `${name}: ${JSON.stringify(r.integrity)}`);
    const c = await loadConditions(r.state, async (ref) => JSON.parse(fs.readFileSync(path.join(dir, "texts", ref.sha256), "utf8")));
    assert.equal(c.findings.problem, null, name);
    if (name !== "05-open-blocking") continue;
    const f = findingsView(r.state, c);
    assert.deepEqual(f.items.map((x) => [x.id, x.severity, x.status, x.stage, x.condition]), [["F1", "blocking", "open", 1, "C1"]]);
    assert.equal(f.openBlocking, 1);
  }
  assert.ok(seen >= 6, `${seen} fixtures`);
});

// ---------------- the renderer's model ----------------

test("the UI model: «Открыто блокирующих: N» on the result, the cards and the activity feed alike; the reviewer is its own participant on the Codex card", () => {
  const findings = {
    items: [{ id: "F1", severity: "blocking", status: "open", condition: null, stage: 1, problem: "p", evidence: "", closeWhen: "c", paths: ["a.txt"], possibleRepeatOf: null,
      history: [{ kind: "opened", reviewTurnId: "t1", index: 0, runKey: "k", tree: "a".repeat(40), reason: null }] }],
    disputed: [], openBlocking: 1
  };
  const v = { runId: "r", status: "running", reason: null, revision: 1, stage: 1, turns: 3, halted: false, active: { kind: "turn", purpose: "review" }, progress: { findings, finish: [] } };
  assert.equal(findingsLine("ru", v), "Открыто блокирующих: 1");
  assert.equal(findingsLine("en", v), "Open blocking: 1");
  assert.equal(findingsLine("ru", { ...v, progress: { finish: [] } }), null, "the lead reviews: no line");
  const rows = activityRuns("ru", {
    links: [{ linkId: "l", fromAgentId: "a", runIds: ["r"] }], agents: [{ agentId: "a", project: "/p/x" }], runs: { r: { view: v, open: true } },
    entries: () => [], lastRecordAt: () => null, runErrors: {}, stageTitles: () => null, now: Date.now()
  });
  assert.equal(rows.active[0].findings, "Открыто блокирующих: 1");
  assert.deepEqual(rows.active[0].roles.map((x) => x.role), ["lead", "executor", "reviewer"]);
  // the reviewer works in the lead's CLI: the Codex card is working, and stands for the reviewer
  assert.equal(agentState("lead", v), "working");
  assert.equal(cardRole("lead", v), "reviewer");
  assert.equal(roleStatus("ru", "reviewer", { view: v, entries: [], open: true, stageTitles: null, now: Date.now() }).actor, "reviewer");
  // without findings (the lead reviews) the review is the lead's
  assert.equal(cardRole("lead", { ...v, progress: { finish: [] } }), "lead");
});
