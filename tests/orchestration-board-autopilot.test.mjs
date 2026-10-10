// B4, the board's autopilot (docs/agent-orchestration/implementation/stage-b-board.md §5): what it does next from the
// board and the runs' facts (autopilotStep), the controller over stand-in calls (readiness before each start, the
// settings' snapshot, waits it never answers), and a chain A → B → C through the manager on fake CLIs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createBoardAutopilot } from "../src/main/services/orchestration/boardAutopilot.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { parseCreate } from "../src/main/ipc/orchestrationIpc.ts";
import { AUTOPILOT_BUDGET, activeMs, autopilotStep, boardStatuses, goalFor, mergeMark } from "../src/shared/taskBoard.ts";
import { boardNotes, DEFAULT_NOTIFY_PREFS } from "../src/renderer/src/features/orchestration/notify.ts";
import { stopText } from "../src/renderer/src/features/orchestration/boardModel.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 240_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-board-ap-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

const WS = "common";
const run = (over = {}) => ({ runId: randomUUID(), taskId: null, taskKey: null, createdAt: ++n, workspaceId: WS, status: "running", reason: null, newer: false, halted: false, limit: null,
  completion: null, phase: "work", permission: false, workMode: "copy", taken: null, ...over });
const task = (over = {}) => ({ id: randomUUID(), key: `T-${++n}`, workspaceId: WS, project: "/p", title: "t", text: "x", criteria: ["c"],
  dependsOn: [], order: n, createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z", archivedAt: null, accepted: null, ...over });
const AT = { workspaceId: WS, project: "/p", workMode: "copy" };
const NONE = { runs: 0, ms: 0 };
const C = (hex) => hex.repeat(40).slice(0, 40);
const done = (t, over = {}) => run({ taskId: t.id, taskKey: t.key, status: "completed", completion: "confirmed", ...over });

// ---------------- what it does next ----------------

test("the next step: a task by order whose dependencies are «Done»; a copy from the dependency's branch; none — why", () => {
  const a = task(), b = task({ dependsOn: [a.id] }), c = task({ dependsOn: [b.id] });
  const board = { tasks: [c, b, a] };
  let s = autopilotStep(board, [], AT, null, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([s.kind, s.task?.key, s.base], ["start", a.key, null]);
  // A done in a copy, not taken: the autopilot takes it as a branch first
  const ra = done(a);
  s = autopilotStep(board, [ra], AT, ra.runId, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([s.kind, s.runId], ["take", ra.runId]);
  // taken: B starts from A's branch
  const ta = { ...ra, taken: { branch: "raoden/a", commit: C("a"), applied: false } };
  s = autopilotStep(board, [ta], AT, ra.runId, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([s.kind, s.task.key, s.base], ["start", b.key, { branch: "raoden/a", commit: C("a"), key: a.key }]);
  // a worktree does not start from a branch (stage C): off, said why
  s = autopilotStep(board, [ta], { ...AT, workMode: "worktree" }, ra.runId, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([s.kind, s.code, s.detail], ["off", "worktree_base", a.key]);
  // every task «Done»
  const all = [ta, { ...done(b), taken: { branch: "raoden/b", commit: C("b"), applied: false } }, { ...done(c), taken: { branch: "raoden/c", commit: C("c"), applied: false } }];
  s = autopilotStep(board, all, AT, all[2].runId, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([s.kind, s.code], ["off", "all_done"]);
  // a task tried before (stopped) is never retried by the autopilot: the others wait for it
  s = autopilotStep(board, [ta, run({ taskId: b.id, status: "stopped" })], AT, null, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([s.kind, s.code], ["off", "others_wait"]);
  assert.match(s.detail, new RegExp(`${b.key} \\(last_stopped\\)`));
  assert.match(s.detail, new RegExp(`${c.key} \\(waits_task: ${b.key}\\)`));
});

test("two dependencies whose results are in two branches: a merge is the person's (stage C) — never started, said why", () => {
  const a = task(), b = task(), c = task({ dependsOn: [a.id, b.id] });
  const facts = [{ ...done(a), taken: { branch: "raoden/a", commit: C("a"), applied: false } }, { ...done(b), taken: { branch: "raoden/b", commit: C("b"), applied: false } }];
  const st = boardStatuses({ tasks: [a, b, c] }, facts);
  assert.deepEqual([st.get(c.id).reason, st.get(c.id).waitsFor], ["waits_merge", [a.key, b.key]]);
  const s = autopilotStep({ tasks: [a, b, c] }, facts, AT, facts[1].runId, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([s.kind, s.code], ["off", "others_wait"]);
  assert.match(s.detail, /waits_merge/);
  // one of them in the working folder (applied) and one in a branch: still two results to join
  const mixed = [{ ...facts[0], taken: { branch: "raoden/a", commit: C("a"), applied: true } }, facts[1]];
  assert.equal(boardStatuses({ tasks: [a, b, c] }, mixed).get(c.id).reason, "waits_merge");
});

test("the latest run decides: waits for the person (a question, a permission, a decision, «Accept the result»), off when it did not end «Done»", () => {
  const a = task(), b = task({ dependsOn: [a.id] });
  const board = { tasks: [a, b] };
  const at = (over) => { const r = run({ taskId: a.id, taskKey: a.key, ...over }); return autopilotStep(board, [r], AT, r.runId, NONE, AUTOPILOT_BUDGET); };
  assert.deepEqual(at({}), { kind: "wait", why: "run" });
  assert.deepEqual(at({ permission: true }), { kind: "wait", why: "permission" }, "a permission request waits: the autopilot never answers it");
  assert.deepEqual(at({ status: "paused", reason: "awaiting_answer" }), { kind: "wait", why: "person" });
  assert.deepEqual(at({ status: "paused", reason: "plan_review" }), { kind: "wait", why: "person" });
  assert.deepEqual(at({ status: "paused", reason: "step_done" }), { kind: "wait", why: "person" });
  assert.deepEqual(at({ status: "completed", completion: "no_checks" }), { kind: "wait", why: "accept" });
  assert.deepEqual([at({ status: "paused", reason: "limit_reached", limit: "turns" }).code, at({ status: "paused", reason: "limit_reached", limit: "turns" }).detail], ["limit_reached", "turns"]);
  for (const [over, code] of [[{ status: "stopped" }, "run_stopped"], [{ status: "failed" }, "run_failed"], [{ status: "paused", reason: "environment_error" }, "run_paused"],
    [{ status: "paused", reason: "coverage_lost" }, "run_paused"], [{ halted: true }, "run_paused"], [{ status: "unreadable" }, "run_unreadable"]]) {
    const s = at(over);
    assert.deepEqual([s.kind, s.code, s.key], ["off", code, a.key], JSON.stringify(over));
  }
  // its journal not there yet: waits; its task deleted: off (review of B4: it waited for ever)
  assert.deepEqual(autopilotStep(board, [], AT, randomUUID(), NONE, AUTOPILOT_BUDGET), { kind: "wait", why: "run" });
  const orphan = run({ taskId: randomUUID(), taskKey: "T-77", status: "completed", completion: "confirmed" });
  assert.deepEqual([autopilotStep(board, [orphan], AT, orphan.runId, NONE, AUTOPILOT_BUDGET).code], ["task_gone"]);
  // the outcome of commit/push/QA not known: not a wait for an answer — off
  assert.equal(at({ status: "paused", reason: "finish_unconfirmed" }).code, "run_paused");
  // the budget: runs, then minutes
  assert.equal(autopilotStep(board, [], AT, null, { runs: 5, ms: 0 }, AUTOPILOT_BUDGET).code, "budget_runs");
  assert.equal(autopilotStep(board, [], AT, null, { runs: 1, ms: 240 * 60_000 }, AUTOPILOT_BUDGET).code, "budget_minutes");
  assert.equal(autopilotStep(board, [], AT, null, { runs: 1, ms: 0 }, { runs: 1, minutes: 9 }).code, "budget_runs");
  // the budget used up by the run that finished the board: «all done», not «budget»
  const last = { ...done(a), workMode: "project" }, lastB = { ...done(b), workMode: "project" };
  assert.equal(autopilotStep(board, [last, lastB], AT, lastB.runId, { runs: 2, ms: 0 }, { runs: 2, minutes: 9 }).code, "all_done");
});

test("another run of the place goes on (the person's, another link's): the autopilot waits, never turns off for it", () => {
  const a = task(), b = task({ dependsOn: [a.id] });
  const mine = run({ taskId: a.id, taskKey: a.key }); // A started by the person, still at work
  assert.deepEqual(autopilotStep({ tasks: [a, b] }, [mine], AT, null, NONE, AUTOPILOT_BUDGET), { kind: "wait", why: "run" });
  assert.deepEqual(autopilotStep({ tasks: [a, b] }, [{ ...mine, status: "paused", reason: "plan_review" }], AT, null, NONE, AUTOPILOT_BUDGET), { kind: "wait", why: "run" });
  // paused for something that waits for nobody: the others wait — off, said so (not a wait for ever)
  assert.equal(autopilotStep({ tasks: [a, b] }, [{ ...mine, status: "paused", reason: "user_request" }], AT, null, NONE, AUTOPILOT_BUDGET).code, "others_wait");
  // the same run in another project: not this place's
  assert.equal(autopilotStep({ tasks: [{ ...a, project: "/q" }, b] }, [mine], AT, null, NONE, AUTOPILOT_BUDGET).code, "others_wait");
});

test("a dependency «Done» on a shaky base (changed after, started anyway) is the person's: not taken next", () => {
  const a = task(), b = task({ dependsOn: [a.id] }), c = task({ dependsOn: [b.id] });
  // B done while A never was (started anyway): C waits for the person
  const facts = [{ ...done(b), workMode: "project" }];
  const s = autopilotStep({ tasks: [a, b, c] }, facts, AT, null, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([s.kind, s.task?.key], ["start", a.key], "A itself goes");
  const after = autopilotStep({ tasks: [{ ...a, archivedAt: "x" }, b, c] }, facts, AT, null, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([after.kind, after.code], ["off", "others_wait"]);
});

test("working minutes by the journal: without the pauses that wait for the person; a permission request counts", () => {
  const t0 = Date.parse("2026-10-09T10:00:00Z");
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  const rec = (min, status, reason = null) => ({ ts: at(min), type: "run.status", data: { status, reason } });
  const records = [{ ts: at(0), type: "run.created", data: {} }, rec(0, "running"), rec(10, "paused", "plan_review"), rec(40, "running"), rec(45, "paused", "environment_error"), rec(50, "running"), rec(60, "completed")];
  assert.equal(activeMs(records, t0 + 999 * 60_000) / 60_000, 10 + 5 + 5 + 10);
  // still running: up to now
  assert.equal(activeMs(records.slice(0, 4), t0 + 41 * 60_000) / 60_000, 11);
});

test("the goal of a task: the profile as it is, autopilot mode, the dependency's branch only for a copy", () => {
  const profile = { checks: ["npm test"], workMode: "copy", finish: { commit: true, push: true, qa: true }, models: { lead: "m1", executor: null, reviewer: null } };
  const t = task({ text: "do", criteria: ["a", "b"] });
  const base = { branch: "raoden/x", commit: C("1"), key: "T-1" };
  const goal = goalFor(t, profile, { optionalChecks: true, language: "ru", base });
  assert.deepEqual(goal, { models: profile.models, text: "do", criteria: ["a", "b"], checks: [], commands: ["npm test"], workMode: "copy", mode: "autopilot", reviewPlan: false,
    language: "ru", task: { id: t.id, key: t.key }, limits: {}, base });
  assert.equal("finish" in goal, false, "a separate copy has no actions after success");
  const project = goalFor(t, { ...profile, workMode: "project" }, { optionalChecks: false, language: "en", base });
  assert.deepEqual([project.finish, "base" in project, "models" in project], [{ commit: true, push: false, qa: false }, false, false], "never push or QA; no base outside a copy");
});

// ---------------- the controller over stand-in calls ----------------

function standIn({ tasks, profile = { access: { claude: "workspace", codex: "workspace" }, workMode: "copy", checks: ["true"], finish: { commit: false, push: false, qa: false }, grants: [] } }) {
  const facts = [];
  const calls = { readiness: 0, start: [], take: [], merge: [], heads: 0 };
  // C1: the board's merged head of the place; a merge here completes at once and moves it
  const state = { tasks, profile, ready: { ready: true, items: [] }, head: { workspaceId: WS, project: "/p", ref: `refs/raoden/board/${WS}/1`, n: 1, commit: C("a"), merges: [] } };
  const deps = {
    view: async () => ({ board: { v: 1, tasks: state.tasks, counters: {} }, facts: [...facts] }),
    link: async () => ({ workspaceId: WS, project: "/p" }),
    profile: async () => state.profile,
    optionalChecks: true,
    journal: async () => [],
    readiness: async () => { calls.readiness++; return { ok: true, value: state.ready }; },
    start: async ({ requestId, goal }) => {
      calls.start.push(goal);
      facts.push(run({ runId: requestId, taskId: goal.task.id, taskKey: goal.task.key, board: goal.base?.branch ?? null, workMode: goal.workMode }));
      return { ok: true, value: { runId: requestId, created: true } };
    },
    take: async (runId) => {
      calls.take.push(runId);
      const f = facts.find((x) => x.runId === runId);
      f.taken = { branch: `raoden/${f.taskKey}`, commit: C(String(calls.take.length)), applied: false };
      return { ok: true, value: { result: "created" } };
    },
    head: async () => state.head,
    ensureHead: async () => { calls.heads++; },
    merge: async (input) => {
      calls.merge.push(input.task.key);
      const to = C(String.fromCharCode(97 + calls.merge.length));
      const m = { runId: randomUUID(), board: state.head.ref, base: state.head.commit, task: { ...input.task, runId: input.taskRunId, commit: input.commit },
        status: "completed", reason: null, detail: null, completion: "confirmed", conflicts: [], outside: [], interference: false, dir: null, createdAt: ++n };
      state.head = { ...state.head, commit: to, merges: [m, ...state.head.merges] };
      return { ok: true, value: { runId: m.runId } };
    },
    newId: () => randomUUID(),
    now: () => Date.now()
  };
  const finish = (key, over = { status: "completed", completion: "confirmed" }) => Object.assign(facts.find((f) => f.taskKey === key && f.status === "running"), over);
  return { deps, facts, calls, state, finish };
}
const LINK = randomUUID();

test("controller: readiness before each start; a chain goes on from the board's head after each merge (C, decision 9); all «Done» — off", async () => {
  const a = task(), b = task({ dependsOn: [a.id] }), c = task({ dependsOn: [b.id] });
  const s = standIn({ tasks: [a, b, c] });
  const ap = createBoardAutopilot(s.deps, async () => AUTOPILOT_BUDGET, 3_600_000);
  const head = (commit) => ({ branch: `refs/raoden/board/${WS}/1`, commit, key: "T-0" });
  await ap.set(LINK, true, "ru");
  await ap.tick(LINK);
  assert.deepEqual([s.calls.readiness, s.calls.start.map((g) => [g.task.key, g.base])], [1, [[a.key, head(C("a"))]]]);
  await ap.tick(LINK);
  assert.equal(s.calls.start.length, 1, "A is still running and B waits for it: nothing else starts");
  s.finish(a.key);
  await ap.tick(LINK); // take
  await ap.tick(LINK); // merge A into the head
  await ap.tick(LINK); // start B from the head that holds A
  assert.deepEqual([s.calls.take.length, s.calls.merge, s.calls.start.map((g) => [g.task.key, g.base.commit])], [1, [a.key], [[a.key, C("a")], [b.key, C("b")]]]);
  s.finish(b.key);
  for (let i = 0; i < 3; i++) await ap.tick(LINK);
  assert.deepEqual([s.calls.readiness, s.calls.start.at(-1).base], [3, head(C("c"))]);
  s.finish(c.key);
  for (let i = 0; i < 3; i++) await ap.tick(LINK);
  const st = (await ap.state())[LINK];
  assert.deepEqual([st.on, st.stop.code, st.used.runs, s.calls.take.length, s.calls.merge], [false, "all_done", 0, 3, [a.key, b.key, c.key]]);
  ap.shutdown();
});

test("controller: a readiness blocker or a «confirm» item turns it off before the start; a run that waits for the person is never answered", async () => {
  const a = task(), b = task();
  const s = standIn({ tasks: [a, b] });
  const ap = createBoardAutopilot(s.deps, async () => ({ ...AUTOPILOT_BUDGET, parallel: 1 }), 3_600_000);
  s.state.ready = { ready: true, items: [{ id: "tests", level: "confirm", detail: "no test file found" }] };
  await ap.set(LINK, true);
  await ap.tick(LINK);
  let st = (await ap.state())[LINK];
  assert.deepEqual([st.on, st.stop.code, st.stop.detail, s.calls.start.length], [false, "not_ready", "tests: no test file found", 0]);
  s.state.ready = { ready: true, items: [] };
  await ap.set(LINK, true);
  await ap.tick(LINK);
  // a permission request: it waits, starts nothing, takes nothing, and has no way to answer
  Object.assign(s.facts[0], { permission: true });
  for (let i = 0; i < 3; i++) await ap.tick(LINK);
  st = (await ap.state())[LINK];
  assert.deepEqual([st.on, st.waits, s.calls.start.length, s.calls.take.length], [true, "permission", 1, 0]);
  // stopped: off, with the task
  Object.assign(s.facts[0], { permission: false, status: "stopped", reason: "user_request" });
  await ap.tick(LINK);
  st = (await ap.state())[LINK];
  assert.deepEqual([st.on, st.stop.code, st.stop.key, s.calls.start.length], [false, "run_stopped", a.key, 1]);
  ap.shutdown();
});

test("controller: «Done» without checks waits for «Accept the result», then goes on", async () => {
  const a = task(), b = task({ dependsOn: [a.id] });
  const s = standIn({ tasks: [a, b] });
  const ap = createBoardAutopilot(s.deps, async () => AUTOPILOT_BUDGET, 3_600_000);
  await ap.set(LINK, true);
  await ap.tick(LINK);
  s.finish(a.key, { status: "completed", completion: "no_checks" });
  for (let i = 0; i < 3; i++) await ap.tick(LINK);
  assert.deepEqual([(await ap.state())[LINK].waits, s.calls.start.length, s.calls.take.length], ["accept", 1, 0]);
  s.state.tasks = [{ ...a, accepted: { runId: s.facts[0].runId, at: "x" } }, b];
  for (let i = 0; i < 3; i++) await ap.tick(LINK); // take, merge, start
  assert.deepEqual([s.calls.take.length, s.calls.merge, s.calls.start.map((g) => g.task.key)], [1, [a.key], [a.key, b.key]]);
  ap.shutdown();
});

test("controller: the project's settings changed since it was turned on — off; a permission saved for the project is named", async () => {
  const a = task(), b = task();
  const s = standIn({ tasks: [a, b] });
  const ap = createBoardAutopilot(s.deps, async () => AUTOPILOT_BUDGET, 3_600_000);
  await ap.set(LINK, true);
  await ap.tick(LINK);
  s.state.profile = { ...s.state.profile, grants: [{ id: "g1", provider: "claude", kind: "command", tool: "Bash", summary: "npm test", fingerprint: "f", grantedAt: "x" }] };
  s.finish(a.key, { status: "completed", completion: "confirmed", workMode: "project" });
  await ap.tick(LINK);
  let st = (await ap.state())[LINK];
  assert.deepEqual([st.on, st.stop.code, st.stop.detail, s.calls.start.length], [false, "grant_added", "claude: npm test", 1]);
  // turned on again: a preparation step added after it — off (it would run a new command)
  await ap.set(LINK, true);
  s.state.profile = { ...s.state.profile, prepare: { auto: false, steps: ["npm ci"] } };
  await ap.tick(LINK);
  assert.deepEqual([(await ap.state())[LINK].stop.code, s.calls.start.length], ["settings_changed", 1]);
  // turned on again: the new settings are the snapshot; then the work mode changes
  await ap.set(LINK, true);
  s.state.profile = { ...s.state.profile, workMode: "project" };
  await ap.tick(LINK);
  st = (await ap.state())[LINK];
  assert.deepEqual([st.stop.code, s.calls.start.length], ["settings_changed", 1]);
  // turned off by the person: no reason kept, nothing starts
  await ap.set(LINK, true);
  await ap.set(LINK, false);
  await ap.tick(LINK);
  assert.deepEqual([(await ap.state())[LINK], s.calls.start.length], [undefined, 1]);
  ap.shutdown();
});

// ---------------- through the manager, fake CLIs ----------------

function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
function script(answers) {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  answers.forEach((a, i) => {
    fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(a.answer));
    if (a.writes) fs.writeFileSync(path.join(dir, `${i + 1}.writes.json`), JSON.stringify(a.writes));
  });
  return dir;
}
// one task's four turns: the plan, the executor writes <file>, the review, the final review
const turns = (file) => {
  const c1 = { keep: null, text: `${file} says done`, covers: ["R1"], evidence: { kind: "change", check: null } };
  return [
    { answer: { stages: [{ title: "fix", task: `write ${file}`, conditions: [c1] }], dropped: [], dropRequirements: [], question: null } },
    { answer: { summary: "done", done: true }, writes: [{ rel: file, base64: Buffer.from("done\n").toString("base64") }] },
    { answer: { conditions: [{ id: "C1", status: "met", paths: [file], note: "written" }], findings: [], request: "none", question: null } },
    { answer: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "written" }] } }
  ];
};
function manager(answers, env = {}) {
  const root = path.join(TMP, `root-${++n}`);
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script(answers), ...env } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP } }));
  const m = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, journalV2: true,
    workspaceOpen: () => true, workspaceKnown: (id) => id === "common" || id === "ws-other" });
  m.root = root;
  return m;
}
function project() {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  return dir;
}
const until = async (fn, what, ms = 120_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
};
const input = (over = {}) => ({ workspaceId: WS, title: "t", text: "write a file", criteria: ["the file says done"], ...over });
const bounds = { position: { x: 0, y: 0 }, size: { width: 280, height: 160 } };
async function linkOn(m, src, workspaceId) {
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds, ...(workspaceId ? { workspaceId } : {}) })).value.agentId;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds, ...(workspaceId ? { workspaceId } : {}) })).value.agentId;
  return (await m.createLink({ linkId: randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
}
const goalOf = (m, runId) => {
  const created = JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, "journal.jsonl"), "utf8").split("\n")[0]);
  return JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, "texts", created.data.goal.sha256)));
};

test("a chain A → B → C on the board's autopilot (C1, decision 9): each «Done», merged into the board's head with checks, each next copy from the head; the working folder untouched", OPTS, async () => {
  const src = project();
  const m = manager([...turns("a2.txt"), ...turns("b2.txt"), ...turns("c2.txt")]);
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["true"] });
  const a = (await m.boardCreate(input({ project: src, title: "A" }))).value;
  const b = (await m.boardCreate(input({ project: src, title: "B", dependsOn: [a.id] }))).value;
  const c = (await m.boardCreate(input({ project: src, title: "C", dependsOn: [b.id] }))).value;
  const head = g(src, "rev-parse", "HEAD").trim();
  const linkId = await linkOn(m, src);
  const on = await m.boardAutopilot(linkId, true, "en");
  assert.ok(on.ok && on.value.on, JSON.stringify(on));
  const end = await until(async () => { const s = (await m.board()).value.autopilot[linkId]; return s && !s.on ? s : null; }, "the autopilot to end", 200_000);
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  const v = (await m.board()).value;
  const st = boardStatuses(v.board, v.facts);
  assert.deepEqual([a, b, c].map((t) => st.get(t.id).done), ["confirmed", "confirmed", "confirmed"]);
  const runOf = (t) => v.facts.find((f) => f.runId === st.get(t.id).current);
  const [ra, rb, rc] = [a, b, c].map(runOf);
  // the head: one per workspace and project, every task merged with its checks
  const [h] = v.heads;
  assert.equal(h.ref, `refs/raoden/board/${WS}/1`);
  assert.deepEqual(h.merges.map((x) => [x.task.key, x.status, x.completion]).reverse(), [[a.key, "completed", "confirmed"], [b.key, "completed", "confirmed"], [c.key, "completed", "confirmed"]]);
  assert.equal(g(src, "rev-parse", h.ref).trim(), h.commit);
  assert.deepEqual(g(src, "ls-tree", "--name-only", h.commit).trim().split("\n").sort(), ["a.txt", "a2.txt", "b2.txt", "c2.txt"]);
  // the bases: every task from the head as it was at its start — B's holds A, C's holds A and B
  const bases = [ra, rb, rc].map((r) => goalOf(m, r.runId).base);
  assert.deepEqual(bases.map((x) => [x.branch, x.key]), [[h.ref, "T-0"], [h.ref, "T-0"], [h.ref, "T-0"]]);
  g(src, "merge-base", "--is-ancestor", ra.taken.commit, bases[1].commit);
  g(src, "merge-base", "--is-ancestor", rb.taken.commit, bases[2].commit);
  // the head moved only through merge commits of the application, each on top of the one before
  assert.equal(g(src, "rev-list", "--count", "--merges", `${bases[0].commit}..${h.commit}`).trim(), "3");
  // the working folder, its index, HEAD and the branches it had: as they were (the result branches are new names)
  assert.deepEqual([g(src, "rev-parse", "HEAD").trim(), g(src, "status", "--porcelain").trim(), fs.readdirSync(src).sort(), g(src, "symbolic-ref", "HEAD").trim()],
    [head, "", [".git", "a.txt"], "refs/heads/main"]);
  assert.deepEqual(g(src, "for-each-ref", "--format=%(refname)", "refs/heads").trim().split("\n").filter((r) => !r.startsWith("refs/heads/raoden/")), ["refs/heads/main"]);
  // the merge runs: journal v3, not on a link, owned by the workspace, not in the list of runs
  const mergeIds = h.merges.map((x) => x.runId);
  const first = JSON.parse(fs.readFileSync(path.join(m.root, "runs", mergeIds[0], "journal.jsonl"), "utf8").split("\n")[0]);
  assert.deepEqual([first.v, first.minReaderVersion], [3, 3]);
  const canvas = (await m.canvas()).value;
  assert.ok(mergeIds.every((id) => canvas.owners[id] === WS && !canvas.links.some((l) => l.runIds.includes(id))));
  assert.ok(!(await m.list()).value.some((r) => mergeIds.includes(r.view.runId)));
  // «Create a branch from the board's result»: a new name at the head, nothing else
  const br = await m.boardHeadBranch(WS, src);
  assert.ok(br.ok, JSON.stringify(br));
  assert.equal(g(src, "rev-parse", `refs/heads/${br.value.name}`).trim(), h.commit);
  assert.deepEqual([g(src, "rev-parse", "HEAD").trim(), g(src, "status", "--porcelain").trim()], [head, ""]);
  await m.shutdown();
});

test("main checks a task's start: one run of a task at a time (two links at once), the workspace that owns it, a base only from its dependency's branch", OPTS, async () => {
  const src = project();
  const m = manager([...turns("a2.txt"), ...turns("b2.txt")]);
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["true"] });
  const a = (await m.boardCreate(input({ project: src }))).value;
  const goal = { text: "x", criteria: ["c"], checks: [], commands: ["true"], workMode: "copy", mode: "autopilot", reviewPlan: true, task: { id: a.id, key: a.key } };
  // another workspace's link: the task is not its
  const foreign = await linkOn(m, src, "ws-other");
  assert.equal((await m.startOnLink({ linkId: foreign, requestId: randomUUID(), goal })).code, "task_workspace");
  // a base the task's dependencies never made
  const bad = await m.startOnLink({ linkId: await linkOn(m, src), requestId: randomUUID(), goal: { ...goal, base: { branch: "main", commit: g(src, "rev-parse", "HEAD").trim(), key: "T-9" } } });
  assert.equal(bad.code, "invalid_base");
  // two direct starts of one task at once (no canvas queue between them): one run (review of B4: both ran)
  const direct = await Promise.all([1, 2].map(() => m.create({ requestId: randomUUID(), source: src, goal })));
  assert.equal(direct.filter((r) => r.ok).length, 1, JSON.stringify(direct));
  assert.equal(direct.find((r) => !r.ok).code, "task_active_run");
  await until(async () => { const id = direct.find((r) => r.ok).value.runId; return (await m.get(id)).value.view.reason === "plan_review"; }, "the plan review");
  for (const r of direct.filter((x) => x.ok)) await m.command(r.value.runId, { commandId: randomUUID(), expectedRevision: (await m.get(r.value.runId)).value.view.revision, command: { kind: "stop" } });
  await until(async () => (await m.get(direct.find((r) => r.ok).value.runId)).value.view.status === "stopped", "stopped");
  // two starts of one task at once, on two links of its workspace: one run
  const [l1, l2] = [await linkOn(m, src), await linkOn(m, src)];
  const both = await Promise.all([m.startOnLink({ linkId: l1, requestId: randomUUID(), goal, anyway: true }), m.startOnLink({ linkId: l2, requestId: randomUUID(), goal, anyway: true })]);
  assert.equal(both.filter((r) => r.ok).length, 1, JSON.stringify(both));
  assert.ok(["task_active_run", "folder_busy"].includes(both.find((r) => !r.ok).code), JSON.stringify(both));
  await m.shutdown();
});

test("«Completed without checks» holds the chain until «Accept the result»; then it is merged «without checks» and the next task starts from the head", OPTS, async () => {
  const src = project();
  // no check command: the lead proposes none (journal v2), the runs complete without checks
  const m = manager([...turns("a2.txt"), ...turns("b2.txt")], { MOCK_CHECKS: "none" });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: [] });
  const a = (await m.boardCreate(input({ project: src, title: "A" }))).value;
  const b = (await m.boardCreate(input({ project: src, title: "B", dependsOn: [a.id] }))).value;
  const linkId = await linkOn(m, src);
  assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
  const waiting = await until(async () => { const s = (await m.board()).value.autopilot[linkId]; return s?.waits === "accept" ? s : null; }, "the wait for «Accept»");
  assert.equal(waiting.on, true);
  await sleep(2000); // a few beats: nothing taken, nothing started
  let v = (await m.board()).value;
  assert.deepEqual(v.facts.map((f) => [f.taskKey, f.completion, f.taken?.branch ?? null]), [[a.key, "no_checks", null]]);
  assert.ok((await m.boardAccept(a.id)).ok);
  await until(async () => (await m.board()).value.facts.some((f) => f.taskKey === b.key), "B to start");
  v = (await m.board()).value;
  const ra = v.facts.find((f) => f.taskKey === a.key);
  const rb = v.facts.find((f) => f.taskKey === b.key);
  assert.ok(ra.taken?.branch, "A's result taken as a branch once accepted");
  // the project has no check commands: «Объединено без проверок» — the head moves, never shown as confirmed
  const [h] = v.heads;
  assert.deepEqual(h.merges.map((x) => [x.task.key, x.status, x.completion]), [[a.key, "completed", "no_checks"]]);
  assert.deepEqual(mergeMark(a.id, h), { kind: "in_board", checks: false });
  assert.deepEqual(goalOf(m, rb.runId).base, { branch: h.ref, commit: h.commit, key: "T-0" });
  await until(async () => (await m.board()).value.autopilot[linkId]?.waits === "accept", "B's wait for «Accept»");
  assert.ok((await m.boardAutopilot(linkId, false, "ru")).ok);
  assert.equal((await m.board()).value.autopilot[linkId], undefined, "turned off by the person: no reason kept");
  await m.shutdown();
});

test("notifications: «the board's autopilot stopped: <why>» and «every task is done», once per stop, behind their own switch", () => {
  const link = randomUUID();
  const on = { on: true, budget: AUTOPILOT_BUDGET, used: { runs: 1, minutes: 2 }, waits: "run", stop: null };
  const stopped = (code, over = {}) => ({ ...on, on: false, waits: null, stop: { code, detail: null, key: "T-2", at: `2026-10-09T10:00:0${++n % 10}Z`, ...over } });
  const place = () => "proj";
  // first seen: only recorded
  const r = boardNotes("ru", { [link]: on }, {}, DEFAULT_NOTIFY_PREFS, false, place);
  assert.deepEqual([r.notes, r.notified[`board-${link}`]], [[], ""]);
  const s1 = stopped("run_stopped");
  const r1 = boardNotes("ru", { [link]: s1 }, r.notified, DEFAULT_NOTIFY_PREFS, false, place);
  assert.deepEqual(r1.notes, [{ runId: `board-${link}`, signal: "failed", title: "Автопилот доски остановился: T-2: запуск остановлен", body: "proj" }]);
  assert.deepEqual(boardNotes("ru", { [link]: s1 }, r1.notified, DEFAULT_NOTIFY_PREFS, false, place).notes, [], "once per stop");
  const done = stopped("all_done", { key: null });
  assert.deepEqual(boardNotes("ru", { [link]: done }, r1.notified, DEFAULT_NOTIFY_PREFS, false, place).notes.map((x) => [x.title, x.signal]), [["Доска: все задачи готовы", "completed"]]);
  assert.deepEqual(boardNotes("ru", { [link]: done }, r1.notified, { ...DEFAULT_NOTIFY_PREFS, board: false }, false, place).notes, [], "its own switch");
  assert.deepEqual(boardNotes("ru", { [link]: done }, r1.notified, DEFAULT_NOTIFY_PREFS, true, place).notes, [], "the window has the focus: the card says it");
  // the reasons in the person's words: the tasks left waiting with their own reasons, the added permission named
  assert.equal(stopText("ru", { code: "others_wait", detail: "x", key: null, at: "x", waiting: [{ key: "T-4", reason: "waits_merge", waitsFor: ["T-2", "T-3"] }] }),
    "остальные ждут: T-4 — Нужно объединить результаты T-2, T-3 (этап C)");
  assert.equal(stopText("ru", { code: "grant_added", detail: "claude: npm test", key: "T-3", at: "x" }), "добавлено разрешение проекта: claude: npm test");
});

test("a dependency's result in a branch only: a start without that base is a start without the result — refused unless «anyway»", OPTS, async () => {
  const src = project();
  const m = manager([...turns("a2.txt"), turns("b2.txt")[0], ...turns("b2.txt")]);
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["true"] });
  const a = (await m.boardCreate(input({ project: src }))).value;
  const b = (await m.boardCreate(input({ project: src, dependsOn: [a.id] }))).value;
  // withoutBase lifts the branch check only: B before A is «Done» is still refused
  assert.equal((await m.create({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"], workMode: "copy", mode: "autopilot", task: { id: b.id, key: b.key } }, withoutBase: true })).code, "task_not_ready");
  assert.equal(parseCreate({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"] }, withoutBase: true }).withoutBase, true);
  assert.throws(() => parseCreate({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"] }, withoutBase: 1 }), /withoutBase/);
  const goal = (t, over = {}) => ({ text: "x", criteria: ["c"], checks: [], commands: ["true"], workMode: "copy", mode: "autopilot", task: { id: t.id, key: t.key }, ...over });
  const ra = await m.create({ requestId: randomUUID(), source: src, goal: goal(a) });
  await until(async () => (await m.get(ra.value.runId)).value.view.status === "completed", "A completed");
  const info = (await m.take(ra.value.runId)).value;
  assert.equal((await m.takeResult(ra.value.runId, { action: "branch", name: info.suggested })).value.result, "created");
  const taken = (await m.board()).value.facts.find((f) => f.runId === ra.value.runId).taken;
  for (const over of [{}, { workMode: "worktree" }]) {
    const r = await m.create({ requestId: randomUUID(), source: src, goal: goal(b, over) });
    assert.equal(r.code, "task_not_ready", JSON.stringify(over));
    assert.match(r.message, new RegExp(taken.branch));
  }
  // the working folder chosen (withoutBase): only the branch check goes; a dependency not «Done» would still refuse it
  const chosen = await m.create({ requestId: randomUUID(), source: src, goal: goal(b, { reviewPlan: true }), withoutBase: true });
  assert.ok(chosen.ok, JSON.stringify(chosen));
  await until(async () => (await m.get(chosen.value.runId)).value.view.reason === "plan_review", "the plan review");
  await m.command(chosen.value.runId, { commandId: randomUUID(), expectedRevision: (await m.get(chosen.value.runId)).value.view.revision, command: { kind: "stop" } });
  await until(async () => (await m.get(chosen.value.runId)).value.view.status === "stopped", "stopped");
  const ok = await m.create({ requestId: randomUUID(), source: src, goal: goal(b, { base: { branch: taken.branch, commit: taken.commit, key: a.key } }) });
  assert.ok(ok.ok, JSON.stringify(ok));
  await until(async () => (await m.get(ok.value.runId)).value.view.status === "completed", "B completed");
  await m.shutdown();
});
