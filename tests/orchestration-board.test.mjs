// B1, the task board's data (docs/agent-orchestration/implementation/stage-b-board.md): board.json (atomic, damaged,
// newer, numbering), a task's status worked out from its runs (never stored), «Accept the result» of a run completed
// without checks, goal.task (journal v2 only, in the request identity) and the autopilot's take-on-Done decision.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createBoardStore } from "../src/main/services/orchestration/boardStore.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { parseCreate } from "../src/main/ipc/orchestrationIpc.ts";
import { autoTakeOnDone, boardStatuses, own, runPhase } from "../src/shared/taskBoard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-board-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
let n = 0;

// ---------------- the status of a task, from its runs ----------------

const run = (over = {}) => ({ runId: randomUUID(), taskId: null, taskKey: null, createdAt: ++n, workspaceId: "common", status: "running", reason: null, newer: false, halted: false, limit: null,
  completion: null, phase: "work", permission: false, workMode: "copy", taken: null, ...over });
const task = (over = {}) => ({ id: randomUUID(), key: `T-${++n}`, workspaceId: "common", project: "/p", title: "t", text: "x", criteria: ["c"],
  dependsOn: [], order: n, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", archivedAt: null, accepted: null, ...over });

test("a task's column and reason come from its latest run; «Done» only from a confirmed completion", () => {
  assert.deepEqual([own(task(), []).column, own(task(), []).reason], ["queue", null]);
  const col = (r, t = task()) => { const s = own(t, [r]); return [s.column, s.reason, s.done]; };
  assert.deepEqual(col(run({ phase: "work" })), ["work", null, null]);
  assert.deepEqual(col(run({ phase: "review" })), ["review", null, null]);
  assert.deepEqual(col(run({ permission: true })), ["work", "waits_permission", null]);
  assert.deepEqual(col(run({ status: "paused", reason: "awaiting_answer" })), ["work", "waits_answer", null]);
  assert.deepEqual(col(run({ status: "paused", reason: "plan_review" })), ["work", "waits_decision", null]);
  assert.deepEqual(col(run({ status: "paused", reason: "limit_reached", phase: "review" })), ["review", "limit_reached", null], "a limit pause stays where it was");
  assert.deepEqual(col(run({ status: "paused", reason: "app_closed" })), ["work", "paused_other", null]);
  assert.deepEqual(col(run({ status: "stopping" })), ["work", "stopping", null]);
  assert.deepEqual(col(run({ status: "pausing" })), ["work", "stopping", null]);
  assert.deepEqual(col(run({ halted: true })), ["work", "paused_other", null], "halted by a condition in main");
  assert.deepEqual(col(run({ status: "stopped" })), ["queue", "last_stopped", null]);
  assert.deepEqual(col(run({ status: "failed" })), ["queue", "last_failed", null]);
  assert.deepEqual(col(run({ status: "completed", completion: "confirmed" })), ["done", null, "confirmed"]);
  assert.deepEqual(col(run({ status: "completed", completion: "no_checks" })), ["review", "no_checks", null], "without checks: never «Done» by itself");
  assert.deepEqual(col(run({ status: "completed", completion: null })), ["review", "paused_other", null], "no completion kind: not «Done»");
  assert.deepEqual(col(run({ newer: true })), ["queue", "run_newer", null]);
  // an unreadable latest run: the column of the last readable one, its own reason
  const t = task();
  const s = own(t, [run({ phase: "review" }), run({ status: "unreadable" })]);
  assert.deepEqual([s.column, s.reason, s.attempts], ["review", "run_unreadable", 2]);
  // the latest run decides, whatever the order the runs come in
  // (the run ids sort the other way: the time decides, not the id)
  const older = run({ runId: `ffffffff${randomUUID().slice(8)}`, status: "stopped", createdAt: 1 });
  const newer = run({ runId: `00000000${randomUUID().slice(8)}`, status: "completed", completion: "confirmed", createdAt: 2 });
  assert.equal(own(t, [newer, older]).current, newer.runId);
});

test("«Accept the result»: «Done (accepted by you, without checks)» only for the task's latest run completed without checks", () => {
  const r = run({ status: "completed", completion: "no_checks" });
  const accepted = own(task({ accepted: { runId: r.runId, at: "2026-10-08T00:00:00Z" } }), [r]);
  assert.deepEqual([accepted.column, accepted.done, accepted.reason], ["done", "accepted", null]);
  // a hand-edited file naming another run, or a run confirmed by checks: nothing changes
  assert.equal(own(task({ accepted: { runId: randomUUID(), at: "x" } }), [r]).done, null);
  const confirmed = run({ status: "completed", completion: "confirmed" });
  assert.equal(own(task({ accepted: { runId: confirmed.runId, at: "x" } }), [confirmed]).done, "confirmed", "accepted never stands for confirmed");
  // a newer run after the acceptance: the old acceptance does not carry over
  const again = run({ status: "running", createdAt: r.createdAt + 1 });
  assert.equal(own(task({ accepted: { runId: r.runId, at: "x" } }), [r, again]).done, null);
  // accepted a run that is not completed without checks (a stopped one): not «Done»
  const stopped = run({ status: "stopped" });
  assert.equal(own(task({ accepted: { runId: stopped.runId, at: "x" } }), [stopped]).done, null);
});

test("dependencies: waits for tasks not «Done» (accepted counts), then for a result not where a dependent task would see it; a cycle never loops", () => {
  const a = task(), b = task({ dependsOn: [] }), c = task();
  b.dependsOn = [a.id];
  c.dependsOn = [b.id];
  const facts = [run({ taskId: a.id, status: "running" })];
  let st = boardStatuses({ tasks: [a, b, c] }, facts);
  assert.deepEqual([st.get(b.id).reason, st.get(b.id).waitsFor], ["waits_task", [a.key]]);
  assert.deepEqual([st.get(c.id).reason, st.get(c.id).waitsFor], ["waits_task", [b.key]]);
  // a done in a copy, its result not taken: b waits for the result
  const doneCopy = run({ taskId: a.id, status: "completed", completion: "confirmed", workMode: "copy" });
  st = boardStatuses({ tasks: [a, b, c] }, [doneCopy]);
  assert.deepEqual([st.get(b.id).reason, st.get(b.id).waitsFor], ["waits_result", [a.key]]);
  // a branch is not enough (the working folder is as it was); applied is
  st = boardStatuses({ tasks: [a, b, c] }, [{ ...doneCopy, taken: { branch: "raoden/x", applied: false } }]);
  assert.equal(st.get(b.id).reason, "waits_result");
  st = boardStatuses({ tasks: [a, b, c] }, [{ ...doneCopy, taken: { branch: null, applied: true } }]);
  assert.equal(st.get(b.id).reason, null);
  // in the project folder the result is there already; accepted without checks counts as «Done»
  const noChecks = run({ taskId: a.id, status: "completed", completion: "no_checks", workMode: "project" });
  st = boardStatuses({ tasks: [a, b, c] }, [noChecks]);
  assert.deepEqual([st.get(a.id).column, st.get(b.id).reason], ["review", "waits_task"]);
  st = boardStatuses({ tasks: [{ ...a, accepted: { runId: noChecks.runId, at: "x" } }, b, c] }, [noChecks]);
  assert.deepEqual([st.get(a.id).done, st.get(b.id).reason], ["accepted", null]);
  // a cycle (a hand-edited file): a task of it not started waits, marked as a cycle, in whatever order the file lists
  // them; one that ran keeps its own status; nothing loops, and a task after the cycle waits for it
  const x = task(), y = task(), z = task();
  x.dependsOn = [y.id];
  y.dependsOn = [x.id];
  z.dependsOn = [y.id];
  const facts2 = [run({ taskId: x.id, status: "completed", completion: "confirmed" })];
  for (const tasks of [[x, y, z], [z, y, x]]) {
    st = boardStatuses({ tasks }, facts2);
    assert.deepEqual([st.get(y.id).column, st.get(y.id).reason, st.get(y.id).cycle, st.get(y.id).waitsFor], ["queue", "waits_task", true, [x.key]]);
    assert.equal(st.get(x.id).done, "confirmed");
    assert.deepEqual([st.get(z.id).reason, st.get(z.id).cycle, st.get(z.id).waitsFor], ["waits_task", false, [y.key]]);
  }
  // a run of another workspace with the same task id does not count
  assert.equal(boardStatuses({ tasks: [a] }, [run({ taskId: a.id, workspaceId: "ws2", status: "completed", completion: "confirmed" })]).get(a.id).column, "queue");
  // a done dependency without a work folder of its own (no marker): nothing to take, nobody waits
  st = boardStatuses({ tasks: [a, b, c] }, [{ ...doneCopy, workMode: null }]);
  assert.equal(st.get(b.id).reason, null);
  // a run of a task not on the board does not reach any task
  assert.equal(boardStatuses({ tasks: [a] }, [run({ taskId: randomUUID(), status: "completed", completion: "confirmed" })]).get(a.id).column, "queue");
});

test("the phase of a run: a check or a review turn is «Review»; between turns the last turn decides", () => {
  assert.equal(runPhase({ active: { kind: "turn", purpose: "execute" } }, "review"), "work");
  assert.equal(runPhase({ active: { kind: "turn", purpose: "final_review" } }, null), "review");
  assert.equal(runPhase({ active: { kind: "check", checkId: "cmd-1" } }, null), "review");
  assert.equal(runPhase({ active: null }, "review"), "review");
  assert.equal(runPhase({ active: null }, null), "work");
});

test("the autopilot's take on «Done» (decision 8): a branch for a copy or worktree result not taken yet, nothing otherwise", () => {
  const r = run({ status: "completed", completion: "confirmed", workMode: "copy" });
  const done = own(task(), [r]);
  assert.equal(autoTakeOnDone(done, r), "branch");
  assert.equal(autoTakeOnDone(done, { ...r, taken: { branch: "raoden/x", applied: false } }), null, "a branch already");
  assert.equal(autoTakeOnDone(done, { ...r, workMode: "project" }), null, "the changes are in the project folder");
  const noChecks = run({ status: "completed", completion: "no_checks", workMode: "worktree" });
  assert.equal(autoTakeOnDone(own(task(), [noChecks]), noChecks), null, "not «Done» until accepted");
  assert.equal(autoTakeOnDone(own(task({ accepted: { runId: noChecks.runId, at: "x" } }), [noChecks]), noChecks), "branch", "accepted is «Done»");
  assert.equal(autoTakeOnDone(done, run({ workMode: "copy" })), null, "another run than the task's current one");
});

// ---------------- board.json ----------------

const input = (over = {}) => ({ workspaceId: "common", project: TMP, title: "Заметка", text: "Добавить заметку", criteria: ["есть"], ...over });

test("board.json: numbers per workspace above the file and above the runs' keys; atomic writes; a restart reads the same board", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "b-"));
  const file = path.join(dir, "board.json");
  let used = 0;
  const store = createBoardStore(file, async (ws) => (ws === "common" ? used : 0));
  const a = await store.create(input());
  const b = await store.create(input({ dependsOn: [a.id] }));
  assert.deepEqual([a.key, b.key, b.dependsOn], ["T-1", "T-2", [a.id]]);
  assert.equal((await store.create(input({ workspaceId: "ws2" }))).key, "T-1", "numbers are per workspace");
  used = 7; // a run of this workspace names T-7 (the file was lost or restored from a copy)
  assert.equal((await store.create(input())).key, "T-8");
  // a cycle is refused and nothing is written
  const before = fs.readFileSync(file);
  await assert.rejects(store.update(a.id, { dependsOn: [b.id] }), /cycle/);
  assert.deepEqual(fs.readFileSync(file), before);
  // a write cut short leaves its tmp next to the board: the board is whole, the tmp goes at the next start
  fs.writeFileSync(`${file}.${randomUUID()}.tmp`, "{\"v\":1,\"tas");
  const again = createBoardStore(file);
  const read = await again.read();
  assert.deepEqual(read.board.tasks.map((t) => t.key), ["T-1", "T-2", "T-1", "T-8"]);
  assert.equal(read.readOnly, null);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  // the number ends at T-999999 (the format of a key); a hand-edited counter above refuses, the board stays readable
  const capped = path.join(fs.mkdtempSync(path.join(TMP, "b-")), "board.json");
  fs.writeFileSync(capped, JSON.stringify({ v: 1, tasks: [], counters: { common: 999_999 } }));
  await assert.rejects(createBoardStore(capped).create(input()), /T-999999/);
  assert.equal((await createBoardStore(capped).read()).readOnly, null);
  // a task without accepted / archivedAt (written by hand) reads as one without them, not as a damaged board
  const loose = path.join(fs.mkdtempSync(path.join(TMP, "b-")), "board.json");
  const { accepted: _a, archivedAt: _b, ...bare } = task();
  fs.writeFileSync(loose, JSON.stringify({ v: 1, tasks: [bare], counters: {} }));
  assert.deepEqual((await createBoardStore(loose).read()).board.tasks.map((t) => [t.id, t.accepted, t.archivedAt]), [[bare.id, null, null]]);
  // the first read and a create at once: the create is never lost to the read's older board
  for (let i = 0; i < 20; i++) {
    const f = path.join(fs.mkdtempSync(path.join(TMP, "b-")), "board.json");
    fs.writeFileSync(f, JSON.stringify({ v: 1, tasks: [], counters: {} }));
    const s2 = createBoardStore(f);
    const [, made] = await Promise.all([s2.read(), s2.create(input())]);
    assert.deepEqual((await s2.read()).board.tasks.map((t) => t.id), [made.id]);
    assert.equal((await s2.create(input())).key, "T-2");
    assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).tasks.length, 2);
  }
  // a first read that fails (here: a folder where the file goes) is asked again once the cause is gone
  const dir5 = fs.mkdtempSync(path.join(TMP, "b-"));
  fs.mkdirSync(path.join(dir5, "board.json"));
  const s5 = createBoardStore(path.join(dir5, "board.json"));
  await assert.rejects(s5.read());
  fs.rmdirSync(path.join(dir5, "board.json"));
  assert.equal((await s5.create(input())).key, "T-1");
  // a damaged file read and written at once at the start: set aside once, the board writable (not «damaged, unmoved»)
  for (let i = 0; i < 20; i++) {
    const dir = fs.mkdtempSync(path.join(TMP, "b-"));
    fs.writeFileSync(path.join(dir, "board.json"), "{ damaged");
    const s3 = createBoardStore(path.join(dir, "board.json"));
    const [r3, made] = await Promise.all([s3.read(), s3.create(input())]);
    assert.equal(made.key, "T-1");
    assert.equal(r3.readOnly, null);
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes(".damaged-")).length, 1);
  }
  // a task with runs is archived, not deleted; a task without runs goes and its dependents lose it openly
  await assert.rejects(again.remove(a.id, async () => true), /archived/);
  await again.remove(a.id, async () => false);
  assert.deepEqual((await again.read()).board.tasks.find((t) => t.id === b.id).dependsOn, []);
});

test("board.json: a damaged file is set aside whole; a newer version's file is read only and never written; a failed write changes nothing", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "b-"));
  const file = path.join(dir, "board.json");
  fs.writeFileSync(file, "{ not json");
  const store = createBoardStore(file);
  assert.deepEqual((await store.read()).board.tasks, []);
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith("board.json.damaged-"));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), "utf8"), "{ not json", "set aside as it was");
  // a task that does not pass the checks makes the file damaged too (never half a board)
  const dir2 = fs.mkdtempSync(path.join(TMP, "b-"));
  fs.writeFileSync(path.join(dir2, "board.json"), JSON.stringify({ v: 1, tasks: [task({ title: "" })], counters: {} }));
  assert.deepEqual((await createBoardStore(path.join(dir2, "board.json")).read()).board.tasks, []);
  // newer
  const dir3 = fs.mkdtempSync(path.join(TMP, "b-"));
  const newer = path.join(dir3, "board.json");
  const kept = JSON.stringify({ v: 2, tasks: [task()], counters: {}, columns: ["x"] });
  fs.writeFileSync(newer, kept);
  const ns = createBoardStore(newer);
  const r = await ns.read();
  assert.deepEqual([r.readOnly, r.board.tasks.length], ["newer_version", 1]);
  await assert.rejects(ns.create(input()), /newer version/);
  assert.equal(fs.readFileSync(newer, "utf8"), kept, "never written");
  // a write that fails: the file and the board as they were
  const dir4 = fs.mkdtempSync(path.join(TMP, "b-"));
  const f4 = path.join(dir4, "board.json");
  const s4 = createBoardStore(f4);
  await s4.create(input());
  const was = fs.readFileSync(f4);
  if (process.getuid?.() !== 0) {
    fs.chmodSync(dir4, 0o500);
    try {
      await assert.rejects(s4.create(input()), /could not be saved/);
    } finally { fs.chmodSync(dir4, 0o700); }
    assert.deepEqual(fs.readFileSync(f4), was);
    assert.equal((await s4.read()).board.tasks.length, 1, "the board in memory follows the file");
  }
});

// ---------------- goal.task through the manager ----------------

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
const C1 = { keep: null, text: "a.txt says 2", covers: ["R1"], evidence: { kind: "change", check: null } };
const PLAN = { answer: { stages: [{ title: "fix", task: "make a.txt say 2", conditions: [C1] }], dropped: [], dropRequirements: [], question: null } };
const REVIEW = { answer: { conditions: [{ id: "C1", status: "met", paths: ["a.txt"], note: "a.txt says 2" }], findings: [], request: "none", question: null } };
const FINAL = { answer: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "a.txt says 2" }] } };
const EXEC = { answer: { summary: "done", done: true }, writes: [{ rel: "a.txt", base64: Buffer.from("2\n").toString("base64") }] };
function manager(v2 = true, root = path.join(TMP, `root-${++n}`)) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL, PLAN]), MOCK_CHECKS: "none" } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP } }));
  const m = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, ...(v2 ? { journalV2: true } : {}) });
  m.root = root;
  return m;
}
function project() {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync(GIT, a, { cwd: dir, env: GIT_ENV });
  return dir;
}
const until = async (fn, what, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}`);
};

test("goal.task: written in the run's goal, part of the request's identity, journal v2 only; the board's facts and «Accept the result»", OPTS, async () => {
  const src = project();
  const m = manager();
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["false"] });
  const t = (await m.boardCreate(input({ project: src }))).value;
  const goal = { text: "a to 2", criteria: ["a.txt says 2"], checks: [], commands: [], mode: "autopilot", task: { id: t.id, key: t.key } };
  const runId = randomUUID();
  // a task not on the board, or of another project: refused before anything starts
  assert.equal((await m.create({ requestId: randomUUID(), source: src, goal: { ...goal, task: { id: randomUUID(), key: "T-9" } } })).code, "task_not_found");
  assert.equal((await m.create({ requestId: randomUUID(), source: project(), goal })).code, "task_project");
  // «Accept the result» before any run: refused
  assert.equal((await m.boardAccept(t.id)).code, "accept_unavailable");
  const r = await m.create({ requestId: runId, source: src, goal });
  assert.ok(r.ok, JSON.stringify(r));
  // the same requestId with another task is another request
  const t2 = (await m.boardCreate(input({ project: src }))).value;
  assert.equal((await m.create({ requestId: runId, source: src, goal: { ...goal, task: { id: t2.id, key: t2.key } } })).code, "request_conflict");
  const done = await until(async () => { const v = (await m.get(runId)).value.view; return v.status === "completed" ? v : null; }, "completed");
  assert.equal(done.progress.completion, "no_checks");
  // the goal in the journal names the task; nothing else of the run depends on it
  const created = JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, "journal.jsonl"), "utf8").split("\n")[0]);
  const text = JSON.parse(fs.readFileSync(path.join(m.root, "runs", runId, "texts", created.data.goal.sha256)));
  assert.deepEqual(text.task, { id: t.id, key: t.key });
  // the board: the run's facts name the task; without checks it is «Review», never «Done» by itself
  let v = (await m.board()).value;
  assert.deepEqual(v.facts.map((f) => [f.runId, f.taskId, f.taskKey, f.completion]), [[runId, t.id, t.key, "no_checks"]]);
  assert.deepEqual([boardStatuses(v.board, v.facts).get(t.id).column, boardStatuses(v.board, v.facts).get(t.id).reason], ["review", "no_checks"]);
  // the person accepts: «Done (accepted by you, without checks)»
  assert.equal((await m.boardAccept(t.id)).value.accepted.runId, runId);
  v = (await m.board()).value;
  assert.equal(boardStatuses(v.board, v.facts).get(t.id).done, "accepted");
  // a restart (another manager over the same folder): the same board and the same statuses
  const again = manager(true, m.root);
  const va = (await again.board()).value;
  assert.deepEqual([...boardStatuses(va.board, va.facts)], [...boardStatuses(v.board, v.facts)]);
  await again.shutdown();
  // a task with a run is archived, not deleted; a repeat of the created request is answered whatever became of the task
  assert.equal((await m.boardRemove(t.id)).code, "task_has_runs");
  assert.ok((await m.boardArchive(t.id, true)).ok);
  assert.deepEqual((await m.create({ requestId: runId, source: src, goal })).value, { runId, created: false });
  assert.equal((await m.create({ requestId: randomUUID(), source: src, goal })).code, "task_archived");
  assert.ok((await m.boardArchive(t.id, false)).ok);
  // a run being created counts before its journal is there
  const tFly = (await m.boardCreate(input({ project: src }))).value;
  const flyId = randomUUID();
  const flying = m.create({ requestId: flyId, source: src, goal: { ...goal, reviewPlan: true, task: { id: tFly.id, key: tFly.key } } });
  assert.equal((await m.boardRemove(tFly.id)).code, "task_has_runs");
  assert.equal((await m.boardArchive(tFly.id, true)).code, "task_starting");
  assert.ok((await flying).ok);
  // a run that is not completed without checks (here: paused for the plan) is not accepted
  await until(async () => (await m.get(flyId)).value.view.reason === "plan_review", "the plan review");
  assert.equal((await m.boardAccept(tFly.id)).code, "accept_unavailable");
  // a work folder marker that cannot be read: the work mode is the goal's (a copy's result is never taken for granted)
  const marker = path.join(m.root, "runs", runId, "workspace", "workspace.json");
  const kept = fs.readFileSync(marker);
  fs.writeFileSync(marker, "{");
  assert.equal((await manager(true, m.root).board()).value.facts.find((x) => x.runId === runId).workMode, "project");
  fs.writeFileSync(marker, kept);
  // a run whose journal cannot be read keeps its task: «journal not readable», never the older run's «Done»; the same
  // after a restart (the task is read from the journal's first record)
  const j = path.join(m.root, "runs", runId, "journal.jsonl");
  const lines = fs.readFileSync(j, "utf8").split("\n");
  lines[3] = lines[3].replace(/"seq":\d+/, '"seq":9999');
  fs.writeFileSync(j, lines.join("\n"));
  for (const mm of [m, manager(true, m.root)]) {
    const vv = (await mm.board()).value;
    const f = vv.facts.find((x) => x.runId === runId);
    assert.deepEqual([f.taskId, f.status], [t.id, "unreadable"]);
    assert.equal(boardStatuses(vv.board, vv.facts).get(t.id).reason, "run_unreadable");
    if (mm !== m) await mm.shutdown();
  }
  // numbering after the board was lost: above the T-n the runs name
  fs.rmSync(path.join(m.root, "board.json"));
  const m2 = manager();
  fs.mkdirSync(m2.root, { recursive: true });
  fs.cpSync(path.join(m.root, "runs"), path.join(m2.root, "runs"), { recursive: true });
  assert.equal((await m2.boardCreate(input({ project: src }))).value.key, "T-4"); // T-3 is the largest a run names
  await m.shutdown();
  await m2.shutdown();
});

test("goal.task: a v1 goal refuses it; the IPC takes { id, key } only", OPTS, async () => {
  const src = project();
  const m = manager(false);
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["true"] });
  const t = (await m.boardCreate(input({ project: src }))).value;
  const r = await m.create({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"], mode: "autopilot", task: { id: t.id, key: t.key } } });
  assert.equal(r.code, "invalid_goal");
  const base = { requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: ["true"] } };
  assert.deepEqual(parseCreate({ ...base, goal: { ...base.goal, task: { id: t.id, key: "T-1" } } }).goal.task, { id: t.id, key: "T-1" });
  assert.throws(() => parseCreate({ ...base, goal: { ...base.goal, task: { id: t.id, key: "1" } } }), /T-<n>/);
  assert.throws(() => parseCreate({ ...base, goal: { ...base.goal, task: { id: t.id, key: "T-1", status: "done" } } }));
  await m.shutdown();
});
