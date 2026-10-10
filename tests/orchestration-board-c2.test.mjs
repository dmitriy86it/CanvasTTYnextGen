// C2 (docs/agent-orchestration/implementation/stage-c-parallel.md, §4.7 and the owner's decisions 12–15): dependencies
// through the board's merged head (a chain and two dependencies, never «waits_merge»), worktrees in parallel, overlap
// warnings, the start queue when every place is taken, the head updated from the project's HEAD (no conflict, a conflict,
// failed checks), the merges in the autopilot's minutes, «already in the result»; and board.json on 1.5.17 and 1.5.16.
// The person's working folder, index, HEAD and branches: byte for byte.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createBoardAutopilot } from "../src/main/services/orchestration/boardAutopilot.ts";
import { createBoardMerge } from "../src/main/services/orchestration/boardMerge.ts";
import { createBoardStore } from "../src/main/services/orchestration/boardStore.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { AUTOPILOT_BUDGET, autopilotParallelStep, boardStatuses, goalFor, mergeMark, namedPaths, overlapsOf, startBase } from "../src/shared/taskBoard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 300_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raoden-c2-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WS = "common";
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const CHECK_ENV = { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}` };
let n = 0;

function project() {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n2\n3\n");
  fs.writeFileSync(path.join(dir, "keep.txt"), "keep\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  fs.writeFileSync(path.join(dir, "draft.txt"), "the person's own unsaved work\n"); // untracked, never touched
  return dir;
}
// The person's side, byte for byte: every file of the working folder (no .git), the index, HEAD and the branches
function personSide(dir) {
  const h = createHash("sha256");
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = path.join(rel, e.name);
      if (r === ".git") continue;
      if (e.isDirectory()) walk(r); else h.update(r).update(fs.readFileSync(path.join(dir, r)));
    }
  };
  walk("");
  h.update(fs.readFileSync(path.join(dir, ".git", "index"))).update(fs.readFileSync(path.join(dir, ".git", "HEAD")));
  return { files: h.digest("hex"), head: g(dir, "rev-parse", "HEAD").trim(), branches: g(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").trim() };
}
// the branches the person had, whatever the application added under its own names
const theirs = (branches) => branches.split("\n").filter((l) => !/^refs\/heads\/(raoden|canvastty)\//.test(l));
// A task's result as a run in a copy leaves it: a commit on top of `base` with these files, in a branch of the project
function taskCommit(dir, base, files, name) {
  const clone = path.join(TMP, `clone-${++n}`);
  g(TMP, "clone", "-q", "--no-checkout", dir, clone);
  g(clone, "fetch", "-q", "origin", base);
  g(clone, "checkout", "-q", "--detach", base);
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(clone, rel), text);
  g(clone, "add", "-A");
  g(clone, "commit", "-q", "-m", name);
  const commit = g(clone, "rev-parse", "HEAD").trim();
  g(clone, "push", "-q", "origin", `HEAD:refs/heads/raoden/${name}`);
  return commit;
}
// the person commits in their own folder (what decision 13 is about)
function personCommits(dir, files, message) {
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
  g(dir, "add", ...Object.keys(files));
  g(dir, "commit", "-q", "-m", message);
}
function merger(root, checks) {
  return createBoardMerge({
    root, gitPath: () => GIT, launch: () => LAUNCH, own: async () => {}, checks: async () => checks,
    shell: async () => ({ shell: SHELL, env: CHECK_ENV }), quiet: async () => true, retryWaitMs: 200, retryPollMs: 50
  });
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
const settled = (m, ref, runId) => until(async () => {
  const x = (await m.mergesInto(ref)).find((y) => y.runId === runId);
  return x && !["preparing", "running"].includes(x.status) ? x : null;
}, "the merge to settle");
const task = (key) => ({ id: randomUUID(), key });

// ---------------- the head updated from the project's HEAD (decision 13), on real Git ----------------

test("«Обновить итог от текущего HEAD» without a conflict: the person's commits get in after the checks, the head moves from the expected value; «Применить» then brings the tasks only; the person's side untouched", OPTS, async () => {
  const src = project();
  const root = path.join(TMP, `root-${++n}`);
  const m = merger(root, ["test -f keep.txt", "test -f mine.txt"]);
  const h0 = await m.ensureHead(WS, src);
  const r1 = await m.merge({ workspaceId: WS, project: src, task: task("T-1"), taskRunId: randomUUID(), commit: taskCommit(src, h0.commit, { "x.txt": "x\n" }, "t1"), language: "ru" });
  // the first merge's checks need mine.txt: the head has no such file yet — fixed by the person's commit below
  assert.deepEqual([(await settled(m, h0.ref, r1.runId)).reason], ["merge_checks_failed"]);
  await m.skip(r1.runId);
  assert.equal((await m.heads([{ workspaceId: WS, project: src }]))[0].behind, 0, "nothing committed yet");
  personCommits(src, { "mine.txt": "mine\n" }, "mine");
  personCommits(src, { "b.txt": "b\n" }, "b");
  const before = personSide(src);
  const [h] = await m.heads([{ workspaceId: WS, project: src }]);
  assert.equal(h.behind, 2, "two commits of the person are not in the head");
  // the autopilot never does it: only this call (the person's action) — and a merge run like a task's
  const up = await m.fromHead({ workspaceId: WS, project: src, language: "ru" });
  const done = await settled(m, h0.ref, up.runId);
  assert.deepEqual([done.status, done.completion, done.source, done.task.commit], ["completed", "confirmed", "head", before.head]);
  const [h1] = await m.heads([{ workspaceId: WS, project: src }]);
  assert.equal(h1.behind, 0);
  assert.deepEqual(g(src, "rev-parse", `${h1.commit}^1`, `${h1.commit}^2`).trim().split("\n"), [h0.commit, before.head], "a merge of the head it was built on and HEAD");
  await assert.rejects(m.fromHead({ workspaceId: WS, project: src, language: "ru" }), { code: "head_current" });
  // a task merged after the update; «Применить» brings its file only (the person's commits are in the folder already)
  const r2 = await m.merge({ workspaceId: WS, project: src, task: task("T-2"), taskRunId: randomUUID(), commit: taskCommit(src, h1.commit, { "y.txt": "y\n" }, "t2"), language: "ru" });
  assert.equal((await settled(m, h0.ref, r2.runId)).status, "completed");
  const mine = (x) => ({ ...x, branches: theirs(x.branches) }); // raoden/t2: this test's own task result
  assert.deepEqual(mine(personSide(src)), mine(before), "the folder, its index, HEAD and branches as they were");
  assert.deepEqual(await m.apply(WS, src), { applied: true });
  assert.equal(fs.readFileSync(path.join(src, "y.txt"), "utf8"), "y\n");
  assert.equal(g(src, "status", "--porcelain").trim().split("\n").sort().join(","), "?? draft.txt,?? y.txt");
});

test("«Обновить итог от текущего HEAD» with a conflict pauses for the person, and with failed checks the head stays where it was", OPTS, async () => {
  const src = project();
  const root = path.join(TMP, `root-${++n}`);
  const m = merger(root, ["test -f keep.txt"]);
  const h0 = await m.ensureHead(WS, src);
  const r1 = await m.merge({ workspaceId: WS, project: src, task: task("T-1"), taskRunId: randomUUID(), commit: taskCommit(src, h0.commit, { "a.txt": "1\nTASK\n3\n" }, "t1"), language: "ru" });
  await settled(m, h0.ref, r1.runId);
  const h1 = g(src, "rev-parse", h0.ref).trim();
  personCommits(src, { "a.txt": "1\nPERSON\n3\n" }, "mine");
  const before = personSide(src);
  const up = await m.fromHead({ workspaceId: WS, project: src, language: "en" });
  const paused = await settled(m, h0.ref, up.runId);
  assert.deepEqual([paused.status, paused.reason, paused.conflicts, paused.source], ["paused", "merge_conflict", ["a.txt"], "head"]);
  assert.equal(g(src, "rev-parse", h0.ref).trim(), h1, "the head did not move");
  assert.deepEqual(personSide(src), before);
  // one merge at a time: nothing else goes into the head while this one waits
  await assert.rejects(m.merge({ workspaceId: WS, project: src, task: task("T-9"), taskRunId: randomUUID(), commit: h1, language: "en" }), { code: "merge_busy" });
  await m.skip(up.runId);

  // checks that fail on the merged code: the head stays, the update waits for the person
  const src2 = project();
  const m2 = merger(path.join(TMP, `root-${++n}`), ["test ! -f bad.txt"]);
  const k0 = await m2.ensureHead(WS, src2);
  personCommits(src2, { "bad.txt": "bad\n" }, "bad");
  const before2 = personSide(src2);
  const up2 = await m2.fromHead({ workspaceId: WS, project: src2, language: "en" });
  const failed = await settled(m2, k0.ref, up2.runId);
  assert.deepEqual([failed.status, failed.reason], ["paused", "merge_checks_failed"]);
  assert.equal(g(src2, "rev-parse", k0.ref).trim(), k0.commit);
  assert.equal((await m2.heads([{ workspaceId: WS, project: src2 }]))[0].behind, 1, "still behind");
  assert.deepEqual(personSide(src2), before2);
  await m2.skip(up2.runId);
  // another line checked out (not from the head's start): nothing «behind», nothing to update from
  g(src2, "checkout", "-q", "--orphan", "other");
  g(src2, "commit", "-q", "-m", "other line");
  const [k1] = await m2.heads([{ workspaceId: WS, project: src2 }]);
  assert.deepEqual([k1.behind, k1.branch], [null, "other"]);
  await assert.rejects(m2.fromHead({ workspaceId: WS, project: src2, language: "en" }), { code: "head_other_line" });
});

// ---------------- the shared rules (no Git) ----------------

const fact = (over) => ({ runId: randomUUID(), taskId: null, taskKey: null, createdAt: 1, workspaceId: WS, status: "completed", reason: null, newer: false,
  halted: false, limit: null, completion: "confirmed", phase: "work", permission: false, workMode: "copy", taken: null, board: null, ...over });
const bt = (key, over = {}) => ({ id: randomUUID(), key, workspaceId: WS, project: "/p", title: key, text: "x", criteria: ["c"], dependsOn: [], order: Number(key.slice(2)),
  createdAt: "", updatedAt: "", archivedAt: null, accepted: null, ...over });

test("dependencies through the head (decision 9): «waits_head» until the dependency's current result is in the head — never «waits_merge» for two; ready once both are", () => {
  const [t1, t2] = [bt("T-1"), bt("T-2")];
  const t3 = bt("T-3", { dependsOn: [t1.id, t2.id] });
  const r1 = fact({ taskId: t1.id, taskKey: "T-1", taken: { branch: "raoden/a", commit: "a".repeat(40), applied: false } });
  const r2 = fact({ taskId: t2.id, taskKey: "T-2", taken: { branch: "raoden/b", commit: "b".repeat(40), applied: false } });
  const board = { tasks: [t1, t2, t3] };
  // without a head (B's rule): two results in branches need the person
  assert.equal(boardStatuses(board, [r1, r2]).get(t3.id).reason, "waits_merge");
  const merge = (t, r, status) => ({ runId: randomUUID(), board: "refs/raoden/board/common/1", base: "c".repeat(40), task: { id: t.id, key: t.key, runId: r.runId, commit: r.taken.commit },
    status, reason: null, detail: null, completion: status === "completed" ? "confirmed" : null, conflicts: [], outside: [], interference: false, retrying: false, dir: null, createdAt: 1 });
  const head = (merges) => ({ workspaceId: WS, project: "/p", ref: "refs/raoden/board/common/1", n: 1, commit: "c".repeat(40), merges });
  const one = boardStatuses(board, [r1, r2], [head([merge(t1, r1, "completed"), merge(t2, r2, "running")])]).get(t3.id);
  assert.deepEqual([one.reason, one.waitsFor, one.depsWait.reason], ["waits_head", ["T-2"], "waits_head"]);
  assert.equal(boardStatuses(board, [r1, r2], [head([merge(t1, r1, "completed"), merge(t2, r2, "completed")])]).get(t3.id).depsWait, null);
  // a chain: the dependency «Done» but not merged yet — waits for the head, not for a branch
  const t4 = bt("T-4", { dependsOn: [t1.id] });
  assert.equal(boardStatuses({ tasks: [t1, t4] }, [r1], [head([])]).get(t4.id).reason, "waits_head");
  assert.equal(boardStatuses({ tasks: [t1, t4] }, [r1]).get(t4.id).reason, null, "B: one result in a branch is its base");
  // a dependency of another project never gets into this head: B's rule for it (its branch is the base)
  const tB = bt("T-5", { project: "/q", dependsOn: [t1.id] });
  assert.equal(boardStatuses({ tasks: [t1, tB] }, [r1], [{ ...head([]), project: "/q" }]).get(tB.id).depsWait, null);
  // a person's start: from the head — unless a dependency's result is in the working folder (it may not be in the head)
  const t6 = bt("T-6", { dependsOn: [t1.id] });
  const inFolder = { ...r1, workMode: "project", taken: null };
  const h1 = head([merge(t1, r1, "completed")]);
  assert.equal(startBase(t6, { tasks: [t1, t6] }, boardStatuses({ tasks: [t1, t6] }, [r1], [h1]), [r1], [h1]).key, "T-0");
  assert.equal(startBase(t6, { tasks: [t1, t6] }, boardStatuses({ tasks: [t1, t6] }, [inFolder], [h1]), [inFolder], [h1]), null);
  // a merge of an older run of the dependency says nothing of its current result
  const old = merge(t1, { ...r1, runId: randomUUID() }, "completed");
  assert.equal(boardStatuses({ tasks: [t1, t4] }, [r1], [head([old])]).get(t4.id).reason, "waits_head");
});

test("no state without a way out (§8): a run the autopilot started, paused for a reason that is not the person's question, turns it off once nothing else goes on; a question waits", () => {
  const [t1, t2] = [bt("T-1"), bt("T-2")];
  const head = { workspaceId: WS, project: "/p", ref: "refs/raoden/board/common/1", n: 1, commit: "c".repeat(40), merges: [] };
  const paused = (reason) => fact({ taskId: t1.id, taskKey: "T-1", status: "paused", reason, completion: null, board: head.ref });
  const step = (f) => autopilotParallelStep({ tasks: [t1, t2] }, [f], { workspaceId: WS, project: "/p" }, [f.runId], { runs: 1, ms: 0 }, { runs: 1, minutes: 60, parallel: 2 }, head);
  assert.deepEqual([step(paused("invalid_report")).kind, step(paused("invalid_report")).code], ["off", "run_paused"]);
  assert.equal(step(paused("awaiting_answer")).kind, "wait");
});

test("«already in the result» (decision 15): a merge that found the result in the head is marked so; «without checks» only when there were none", () => {
  const t1 = bt("T-1");
  const m = (reason, completion) => ({ workspaceId: WS, project: "/p", ref: "r", n: 1, commit: "c", merges: [{ runId: "m", board: "r", base: "c", task: { id: t1.id, key: "T-1", runId: "r1", commit: "a" },
    status: "completed", reason, detail: null, completion, conflicts: [], outside: [], interference: false, retrying: false, dir: null, createdAt: 1 }] });
  assert.deepEqual(mergeMark(t1.id, m("already", null), "r1"), { kind: "in_board", checks: false, already: true });
  assert.deepEqual(mergeMark(t1.id, m(null, "no_checks"), "r1"), { kind: "in_board", checks: false, already: false });
  assert.deepEqual(mergeMark(t1.id, m(null, "confirmed"), "r1"), { kind: "in_board", checks: true, already: false });
});

test("overlap warnings (§4.7): two tasks at work that changed one file; a task to start that names a file another changes; no warning for two not started, for a result in the head, or for words that are not paths", () => {
  const t1 = bt("T-1", { text: "Rework the login form" });
  const t2 = bt("T-2", { text: "Export CSV" });
  const t3 = bt("T-3", { text: "Fix the error text in auth.ts, e.g. the 401 one (v1.5)" });
  const t4 = bt("T-4", { text: "Touch src/auth.ts too" });
  const t5 = bt("T-5", { text: "Docs in README.md" });
  const r1 = fact({ taskId: t1.id, status: "running", completion: null, files: ["src/auth.ts", "src/form.tsx"] });
  const r2 = fact({ taskId: t2.id, status: "paused", reason: "awaiting_answer", completion: null, files: ["src/csv.ts"], named: ["src/form.tsx"] });
  const board = { tasks: [t1, t2, t3, t4, t5] };
  const facts = [r1, r2];
  const o = overlapsOf(board, facts, boardStatuses(board, facts));
  assert.deepEqual(o.get(t1.id), [{ key: "T-2", files: ["src/form.tsx"], kind: "now" }]);
  assert.deepEqual(o.get(t2.id), [{ key: "T-1", files: ["src/form.tsx"], kind: "now" }]);
  // «auth.ts» named by a task in the queue matches «src/auth.ts» changed by one at work; two queued ones are not compared
  assert.deepEqual(o.get(t3.id), [{ key: "T-1", files: ["src/auth.ts"], kind: "maybe" }]);
  assert.deepEqual(o.get(t4.id), [{ key: "T-1", files: ["src/auth.ts"], kind: "maybe" }]);
  assert.equal(o.get(t5.id), undefined);
  assert.deepEqual(namedPaths("e.g. v1.5 and 401, i.e. see https://x.io/a.md or ./src/a.ts, docs/ and `package.json`"), ["src/a.ts", "package.json"]);
  // T-1's result in the head: what it changed is the others' base now
  const done = fact({ taskId: t1.id, files: ["src/auth.ts", "src/form.tsx"], taken: { branch: "b", commit: "a".repeat(40), applied: false } });
  const head = { workspaceId: WS, project: "/p", ref: "r", n: 1, commit: "c", merges: [{ runId: "m", board: "r", base: "c", task: { id: t1.id, key: "T-1", runId: done.runId, commit: "a".repeat(40) },
    status: "completed", reason: null, detail: null, completion: "confirmed", conflicts: [], outside: [], interference: false, retrying: false, dir: null, createdAt: 1 }] };
  const after = overlapsOf(board, [done, r2], boardStatuses(board, [done, r2], [head]), [head]);
  assert.equal(after.get(t1.id), undefined);
  assert.equal(after.get(t4.id), undefined);
  // «Done» long ago — in the folder, or with no head — is nobody's work in progress: no warning between two such
  const [d1, d2] = [bt("T-1", { text: "src/auth.ts" }), bt("T-2", { text: "src/auth.ts" })];
  const old = [fact({ taskId: d1.id, workMode: "project" }), fact({ taskId: d2.id, taken: { branch: "b", commit: "a".repeat(40), applied: false } })];
  assert.equal(overlapsOf({ tasks: [d1, d2] }, old, boardStatuses({ tasks: [d1, d2] }, old)).size, 0);
  // «Done» in a copy from the head and not merged yet is still to come into it
  const pending = fact({ taskId: d2.id, board: "r", taken: { branch: "b", commit: "a".repeat(40), applied: false } });
  const h0 = { ...head, merges: [] };
  const going = [fact({ taskId: d1.id, status: "running", completion: null }), pending];
  assert.deepEqual(overlapsOf({ tasks: [d1, d2] }, going, boardStatuses({ tasks: [d1, d2] }, going, [h0]), [h0]).get(d1.id), [{ key: "T-2", files: ["src/auth.ts"], kind: "now" }]);
});

test("the autopilot's minutes count the merges into the head since it was turned on (decision 14): their preparation and checks, never their pause for the person", async () => {
  let now = Date.parse("2026-10-10T10:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const on = now;
  const merges = [
    { runId: "m1", createdAt: on + 1000 }, // checks 10 min, then waits for the person 30 min (not counted), then 5 min more
    { runId: "m0", createdAt: on - 60_000 } // before it was turned on: not its
  ];
  const journals = {
    m1: [{ ts: iso(on + 1000), type: "run.created", data: {} }, { ts: iso(on + 1000), type: "run.status", data: { status: "running" } },
      { ts: iso(on + 601_000), type: "run.status", data: { status: "paused", reason: "merge_checks_failed" } },
      { ts: iso(on + 2_401_000), type: "run.status", data: { status: "running" } },
      { ts: iso(on + 2_701_000), type: "run.status", data: { status: "completed", completion: "confirmed" } }],
    m0: [{ ts: iso(on - 60_000), type: "run.created", data: {} }, { ts: iso(on - 60_000), type: "run.status", data: { status: "running" } }]
  };
  const ap = createBoardAutopilot({
    view: async () => ({ board: { v: 1, tasks: [], counters: {} }, facts: [] }), link: async () => ({ workspaceId: WS, project: "/p" }),
    profile: async () => ({ workMode: "copy", access: {}, models: null, finish: {}, checks: [], prepare: {}, env: {}, grants: [] }), optionalChecks: true,
    journal: async (id) => journals[id] ?? [], readiness: async () => ({ ok: false, code: "x" }), start: async () => ({ ok: false, code: "x" }), take: async () => ({ ok: false, code: "x" }),
    head: async () => ({ workspaceId: WS, project: "/p", ref: "r", n: 1, commit: "c", merges }), ensureHead: async () => {}, merge: async () => ({ ok: false, code: "x" }),
    newId: () => randomUUID(), now: () => now
  }, async () => AUTOPILOT_BUDGET, 3_600_000);
  await ap.set("L", true, "ru");
  now = on + 3_000_000;
  const s = (await ap.state()).L;
  assert.equal(s.used.minutes, 15, JSON.stringify(s.used));
  merges.length = 0; // «Начать новый итог доски»: the old head's merges stay counted
  assert.equal((await ap.state()).L.used.minutes, 15);
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
const turns = (file) => {
  const c1 = { keep: null, text: `${file} says done`, covers: ["R1"], evidence: { kind: "change", check: null } };
  return [
    { answer: { stages: [{ title: "fix", task: `write ${file}`, conditions: [c1] }], dropped: [], dropRequirements: [], question: null } },
    { answer: { summary: "done", done: true }, writes: [{ rel: file, base64: Buffer.from("done\n").toString("base64") }] },
    { answer: { conditions: [{ id: "C1", status: "met", paths: [file], note: "written" }], findings: [], request: "none", question: null } },
    { answer: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "written" }] } }
  ];
};
// one script per work folder (MOCK_SCRIPT_PER_CWD): runs at once never take each other's answers
function scripts(...sets) {
  const dir = path.join(TMP, `script-${++n}`);
  sets.forEach((answers, k) => {
    const sub = path.join(dir, String(k + 1));
    fs.mkdirSync(sub, { recursive: true });
    answers.forEach((a, i) => {
      fs.writeFileSync(path.join(sub, `${i + 1}.json`), JSON.stringify(a.answer));
      if (a.writes) fs.writeFileSync(path.join(sub, `${i + 1}.writes.json`), JSON.stringify(a.writes));
    });
  });
  return dir;
}
function manager(script, extra = {}) {
  const root = path.join(TMP, `root-${++n}`);
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script, MOCK_SCRIPT_PER_CWD: "1", ...extra } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...CHECK_ENV, HOME: TMP } }));
  const m = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, journalV2: true,
    workspaceOpen: () => true, workspaceKnown: (id) => id === "common" });
  m.root = root;
  return m;
}
const bounds = { position: { x: 0, y: 0 }, size: { width: 280, height: 160 } };
async function linkOn(m, src) {
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds })).value.agentId;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds })).value.agentId;
  return (await m.createLink({ linkId: randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
}
// the goal a run was created with (its base among it)
const goalOf = (root, runId) => {
  const first = JSON.parse(fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").split("\n")[0]);
  return JSON.parse(fs.readFileSync(path.join(root, "runs", runId, "texts", first.data.goal.sha256), "utf8"));
};
const spanOf = (root, runId) => {
  const recs = fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return [Date.parse(recs[0].ts), Date.parse(recs.filter((r) => r.type === "run.status").at(-1).ts)];
};
const input = (src, title, dependsOn = []) => ({ workspaceId: WS, project: src, title, text: "write a file", criteria: ["the file says done"], dependsOn });
async function runBoard(m, linkId, parallel, watch = async () => {}) {
  assert.equal((await m.boardBudget(linkId, { ...AUTOPILOT_BUDGET, parallel })).ok, true);
  assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
  return until(async () => { await watch(); const s = (await m.board()).value.autopilot[linkId]; return s && !s.on ? s : null; }, "the autopilot to end", 280_000);
}

test("T-1 ∥ T-2 → T-3 in separate copies: T-3 starts only after both are merged into the head and checked, from that head — never «waits_merge»; the working folder untouched", OPTS, async () => {
  const src = project();
  const m = manager(scripts(turns("x.txt"), turns("y.txt"), turns("z.txt")), { MOCK_TURN_DELAY_MS: "1500" });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["test -f keep.txt"] });
  const t1 = (await m.boardCreate(input(src, "A"))).value;
  const t2 = (await m.boardCreate(input(src, "B"))).value;
  const t3 = (await m.boardCreate(input(src, "C", [t1.id, t2.id]))).value;
  const before = personSide(src);
  const linkId = await linkOn(m, src);
  const reasons = new Set();
  const end = await runBoard(m, linkId, 2, async () => {
    const v = (await m.board()).value;
    reasons.add(boardStatuses(v.board, v.facts, v.heads ?? []).get(t3.id).reason);
  });
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  assert.ok(!reasons.has("waits_merge"), [...reasons].join(","));
  assert.ok(reasons.has("waits_head") || reasons.has("waits_task"), [...reasons].join(","));
  const v = (await m.board()).value;
  const [h] = v.heads;
  const st = boardStatuses(v.board, v.facts, v.heads);
  assert.deepEqual([t1, t2, t3].map((t) => st.get(t.id).done), ["confirmed", "confirmed", "confirmed"]);
  const runOf = (t) => v.facts.find((f) => f.runId === st.get(t.id).current);
  // T-3 started from the head with both results in it, after both merges completed (their checks passed)
  const base = goalOf(m.root, runOf(t3).runId).base;
  assert.equal(base.branch, h.ref);
  assert.deepEqual(g(src, "ls-tree", "--name-only", base.commit).trim().split("\n").sort(), ["a.txt", "draft.txt", "keep.txt", "x.txt", "y.txt"]);
  const mergeOf = (t) => h.merges.find((x) => x.task.id === t.id);
  for (const t of [t1, t2]) {
    assert.deepEqual([mergeOf(t).status, mergeOf(t).completion], ["completed", "confirmed"]);
    assert.ok(spanOf(m.root, mergeOf(t).runId)[1] <= spanOf(m.root, runOf(t3).runId)[0], `${t.key} merged before T-3 started`);
  }
  assert.deepEqual(g(src, "ls-tree", "--name-only", h.commit).trim().split("\n").sort(), ["a.txt", "draft.txt", "keep.txt", "x.txt", "y.txt", "z.txt"]);
  // what each run changed, for the overlap warnings: from its base to its last checkpoint
  assert.deepEqual(runOf(t3).files, ["z.txt"]);
  const after = personSide(src);
  assert.deepEqual([after.files, after.head, theirs(after.branches)], [before.files, before.head, theirs(before.branches)]);
  await m.shutdown();
});

test("worktrees in parallel (C2): two independent tasks at once, each in its own worktree from the head; both merged into the head with its checks; the person's folder, index, HEAD and branches untouched", OPTS, async () => {
  const src = project();
  const m = manager(scripts(turns("x.txt"), turns("y.txt")), { MOCK_TURN_DELAY_MS: "2000" });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "worktree", checks: ["test -f keep.txt"], finish: { commit: false, push: false, qa: false } });
  const a = (await m.boardCreate(input(src, "A"))).value;
  const b = (await m.boardCreate(input(src, "B"))).value;
  const before = personSide(src);
  const linkId = await linkOn(m, src);
  const end = await runBoard(m, linkId, 2);
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  const v = (await m.board()).value;
  assert.deepEqual(v.facts.map((f) => f.workMode), ["worktree", "worktree"]);
  const [s1, s2] = v.facts.map((f) => spanOf(m.root, f.runId));
  assert.ok(s1[0] < s2[1] && s2[0] < s1[1], `the runs went on at once: ${JSON.stringify([s1, s2])}`);
  const [h] = v.heads;
  assert.deepEqual(v.facts.map((f) => goalOf(m.root, f.runId).base?.branch), [h.ref, h.ref]);
  assert.deepEqual(h.merges.map((x) => [x.task.key, x.status, x.completion]).sort(), [[a.key, "completed", "confirmed"], [b.key, "completed", "confirmed"]].sort());
  assert.deepEqual(g(src, "ls-tree", "--name-only", h.commit).trim().split("\n").sort(), ["a.txt", "draft.txt", "keep.txt", "x.txt", "y.txt"]);
  const after = personSide(src);
  assert.deepEqual([after.files, after.head, theirs(after.branches)], [before.files, before.head, theirs(before.branches)]);
  await m.shutdown();
});

test("the start queue (decision 12): with every place taken a task's start waits — «N of N» on the board — and begins when a place frees; «Запустить сейчас сверх лимита» starts one at once", OPTS, async () => {
  const src = project();
  const m = manager(scripts(turns("x.txt"), turns("y.txt"), turns("z.txt")), { MOCK_TURN_DELAY_MS: "1500" });
  const profile = { ...(await suggestProfile(src)), workMode: "copy", checks: ["test -f keep.txt"] };
  await createProfileStore(m.root).save(src, profile);
  const [t1, t2, t3] = [(await m.boardCreate(input(src, "A"))).value, (await m.boardCreate(input(src, "B"))).value, (await m.boardCreate(input(src, "C"))).value];
  const linkId = await linkOn(m, src);
  assert.equal((await m.boardBudget(linkId, { ...AUTOPILOT_BUDGET, parallel: 1 })).ok, true);
  const start = (t) => m.startOnLink({ linkId, requestId: randomUUID(), goal: goalFor(t, profile, { optionalChecks: true, language: "ru", base: null }) });
  const r1 = await start(t1);
  assert.ok(r1.ok && !r1.value.queued, JSON.stringify(r1));
  const r2 = await start(t2);
  assert.deepEqual([r2.ok, r2.value.queued], [true, { busy: 1, limit: 1 }]);
  const q = (await m.board()).value.queued;
  assert.deepEqual(q.map((x) => [x.taskId, x.busy, x.limit, x.failed]), [[t2.id, 1, 1, null]]);
  assert.ok(!(await m.board()).value.facts.some((f) => f.taskId === t2.id), "no run of T-2 yet");
  const r3 = await start(t3);
  assert.ok(r3.value.queued);
  // over the limit, confirmed by the person: T-3 starts while T-1 still holds the only place
  const now3 = await m.boardQueue("run", t3.id);
  assert.ok(now3.ok, JSON.stringify(now3));
  const active = (await m.board()).value.facts.filter((f) => !["completed", "stopped", "failed"].includes(f.status)).map((f) => f.taskId).sort();
  assert.deepEqual(active, [t1.id, t3.id].sort());
  // T-2 begins by itself once both are over
  const all = await until(async () => {
    const v = (await m.board()).value;
    const st = boardStatuses(v.board, v.facts, v.heads ?? []);
    return [t1, t2, t3].every((t) => st.get(t.id).done) ? v : null;
  }, "the three tasks to be done", 240_000);
  const span = (t) => spanOf(m.root, all.facts.find((f) => f.taskId === t.id).runId);
  assert.ok(span(t2)[0] >= Math.max(span(t1)[1], span(t3)[1]) - 50, "T-2 began after the place freed");
  assert.equal(all.queued, undefined);
  // «Убрать из очереди»: nothing else is left to start
  assert.equal((await m.boardQueue("cancel", t2.id)).ok, true);
  assert.equal((await m.boardQueue("run", t2.id)).code, "not_queued");
  await m.shutdown();
});

// ---------------- board.json on 1.5.17 (1fa3fd6) and 1.5.16 (a4037ab) ----------------

const oldCode = new Map();
function old(rev) {
  const dir = path.join(TMP, `v-${rev}`);
  if (!oldCode.has(rev)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("/bin/sh", ["-c", `"${GIT}" -C "${path.join(HERE, "..")}" archive ${rev} src | tar -x -C "${dir}"`]);
    oldCode.set(rev, dir);
  }
  return (rel) => import(pathToFileURL(path.join(dir, rel)).href);
}

for (const [name, rev] of [["1.5.17", "1fa3fd6"], ["1.5.16", "a4037ab"]]) {
  test(`board.json of C2 on ${name}: read and written as it is — tasks, dependencies, budgets with the parallelism; nothing lost on the way back`, OPTS, async () => {
    const { createBoardStore: oldStore } = await old(rev)("src/main/services/orchestration/boardStore.ts");
    const file = path.join(TMP, `board-${++n}.json`);
    const now = createBoardStore(file, async () => 0);
    const t1 = await now.create({ workspaceId: WS, project: TMP, title: "A", text: "touch src/auth.ts", criteria: ["c"] });
    const t2 = await now.create({ workspaceId: WS, project: TMP, title: "B", text: "y", criteria: ["c"] });
    await now.create({ workspaceId: WS, project: TMP, title: "C", text: "z", criteria: ["c"], dependsOn: [t1.id, t2.id] });
    const l = randomUUID();
    await now.budget(l, { runs: 3, minutes: 60, parallel: 3 });
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    const back = oldStore(file, async () => 0);
    assert.equal((await back.read()).readOnly, null, "board.json stays v1");
    await back.update(t2.id, { title: "B2" });
    const again = (await createBoardStore(file, async () => 0).read()).board;
    assert.deepEqual({ ...again, tasks: again.tasks.map((t) => ({ ...t, updatedAt: "" })) },
      { ...written, tasks: written.tasks.map((t) => ({ ...t, updatedAt: "", ...(t.id === t2.id ? { title: "B2" } : {}) })) });
  });
}
