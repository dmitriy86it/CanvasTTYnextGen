// C1, parallel tasks and the board's merged head (docs/agent-orchestration/implementation/stage-c-parallel.md): two
// independent tasks at once through the manager on fake CLIs; the merge runs of boardMerge.ts on real Git — a conflict
// paused for the person with nothing lost, checks that fail leave the head where it was, «merged without checks», a head
// moved by someone else, one merge at a time, the recovery after a crash; and the rollback onto the code of 1.5.16
// (board.json, the journal v3 shown read only). The person's working folder, index, HEAD and branches: byte for byte.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createBoardMerge } from "../src/main/services/orchestration/boardMerge.ts";
import { createBoardStore } from "../src/main/services/orchestration/boardStore.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { AUTOPILOT_BUDGET, autopilotParallelStep, boardStatuses, mergeMark, parallelOf } from "../src/shared/taskBoard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 300_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raoden-c1-")));
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
  return { files: h.digest("hex"), branches: g(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").trim() };
}
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

// ---------------- the merge runs on real Git ----------------

test("a conflict: the merge pauses for the person, nothing is lost; the resolution in the merge copy is checked (markers, files out of the conflict) and only then moves the head", OPTS, async () => {
  const src = project();
  const root = path.join(TMP, `root-${++n}`);
  const m = merger(root, ["test -f a.txt"]);
  const h0 = await m.ensureHead(WS, src);
  const before = personSide(src);
  const t1 = task("T-1"), t2 = task("T-2");
  const c1 = taskCommit(src, h0.commit, { "a.txt": "1\nONE\n3\n", "b.txt": "b\n" }, "t1");
  const c2 = taskCommit(src, h0.commit, { "a.txt": "1\nTWO\n3\n", "c.txt": "c\n" }, "t2");
  const r1 = await m.merge({ workspaceId: WS, project: src, task: t1, taskRunId: randomUUID(), commit: c1, language: "ru" });
  assert.equal((await settled(m, h0.ref, r1.runId)).status, "completed");
  const h1 = g(src, "rev-parse", h0.ref).trim();
  const r2 = await m.merge({ workspaceId: WS, project: src, task: t2, taskRunId: randomUUID(), commit: c2, language: "ru" });
  const paused = await settled(m, h0.ref, r2.runId);
  assert.deepEqual([paused.status, paused.reason, paused.conflicts], ["paused", "merge_conflict", ["a.txt"]]);
  // nothing lost: the head where T-1 left it, T-2's branch as it was, the copy with both sides
  assert.equal(g(src, "rev-parse", h0.ref).trim(), h1);
  assert.equal(g(src, "rev-parse", "refs/heads/raoden/t2").trim(), c2);
  const copy = paused.dir;
  assert.match(fs.readFileSync(path.join(copy, "a.txt"), "utf8"), /<<<<<<< [\s\S]*ONE[\s\S]*TWO[\s\S]*>>>>>>> /);
  assert.deepEqual(mergeMark(t2.id, { merges: await m.mergesInto(h0.ref) }), { kind: "not_merged", reason: "merge_conflict", waits: true, runId: r2.runId });
  // a second merge into this head meanwhile: refused, one at a time
  const t3 = task("T-3");
  const c3 = taskCommit(src, h0.commit, { "d.txt": "d\n" }, "t3");
  await assert.rejects(m.merge({ workspaceId: WS, project: src, task: t3, taskRunId: randomUUID(), commit: c3, language: "ru" }), { code: "merge_busy" });
  // «Готово, проверить» with the markers left: refused, nothing written
  assert.deepEqual(await m.resolve(r2.runId, false), { result: "unresolved", files: ["a.txt"] });
  // the person resolves, and also drops a line of T-1's b.txt: a file out of the conflict — named, needs a «yes»
  fs.writeFileSync(path.join(copy, "a.txt"), "1\nONE\nTWO\n3\n");
  fs.writeFileSync(path.join(copy, "b.txt"), "");
  assert.deepEqual(await m.resolve(r2.runId, false), { result: "confirm", files: ["b.txt"] });
  fs.writeFileSync(path.join(copy, "b.txt"), "b\n"); // thought better of it
  assert.deepEqual(await m.resolve(r2.runId, false), { result: "checking" });
  const done = await settled(m, h0.ref, r2.runId);
  assert.deepEqual([done.status, done.completion], ["completed", "confirmed"]);
  const h2 = g(src, "rev-parse", h0.ref).trim();
  assert.deepEqual(g(src, "rev-parse", `${h2}^1`, `${h2}^2`).trim().split("\n"), [h1, c2]);
  assert.equal(g(src, "show", `${h2}:a.txt`), "1\nONE\nTWO\n3\n");
  assert.deepEqual(g(src, "ls-tree", "--name-only", h2).trim().split("\n").sort(), ["a.txt", "b.txt", "c.txt", "draft.txt", "keep.txt"]); // untracked at the start: in the head (§4.1)
  assert.deepEqual(personSide(src), { ...before, branches: before.branches + `\nrefs/heads/raoden/t1 ${c1}\nrefs/heads/raoden/t2 ${c2}\nrefs/heads/raoden/t3 ${c3}` });
});

test("the merged code's checks fail twice: the head does not move, the merge waits for the person with «possibly interference»; «Пропустить» leaves it out", OPTS, async () => {
  const src = project();
  const root = path.join(TMP, `root-${++n}`);
  const m = merger(root, ["test ! -f b.txt"]); // T-1 adds b.txt: the merged tree fails
  const h0 = await m.ensureHead(WS, src);
  const before = personSide(src);
  const t1 = task("T-1");
  const c1 = taskCommit(src, h0.commit, { "b.txt": "b\n" }, "t1");
  const r = await m.merge({ workspaceId: WS, project: src, task: t1, taskRunId: randomUUID(), commit: c1, language: "en" });
  const s = await settled(m, h0.ref, r.runId);
  assert.deepEqual([s.status, s.reason, s.interference, s.completion], ["paused", "merge_checks_failed", true, null]);
  assert.equal(g(src, "rev-parse", h0.ref).trim(), h0.commit, "the head did not move");
  const checked = fs.readFileSync(path.join(root, "runs", r.runId, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.type === "merge.checked");
  assert.deepEqual(checked.map((x) => [x.data.attempt, x.data.passed]), [[1, false], [2, false]]);
  await m.skip(r.runId);
  const skipped = (await m.mergesInto(h0.ref))[0];
  assert.deepEqual([skipped.status, skipped.reason, mergeMark(t1.id, { merges: [skipped] })], ["stopped", "skipped", { kind: "not_merged", reason: "skipped", waits: false, runId: r.runId }]);
  assert.equal(g(src, "rev-parse", h0.ref).trim(), h0.commit);
  assert.deepEqual(personSide(src), { ...before, branches: `${before.branches}\nrefs/heads/raoden/t1 ${c1}` });
});

test("a project without check commands: «merged without checks» — the head moves, never marked as checked", OPTS, async () => {
  const src = project();
  const m = merger(path.join(TMP, `root-${++n}`), []);
  const h0 = await m.ensureHead(WS, src);
  const t1 = task("T-1");
  const c1 = taskCommit(src, h0.commit, { "b.txt": "b\n" }, "t1");
  const r = await m.merge({ workspaceId: WS, project: src, task: t1, taskRunId: randomUUID(), commit: c1, language: "ru" });
  const s = await settled(m, h0.ref, r.runId);
  assert.deepEqual([s.status, s.completion], ["completed", "no_checks"]);
  assert.deepEqual(mergeMark(t1.id, { merges: [s] }), { kind: "in_board", checks: false });
  assert.notEqual(g(src, "rev-parse", h0.ref).trim(), h0.commit);
  // a result in the head already starts no merge
  assert.deepEqual(await m.merge({ workspaceId: WS, project: src, task: t1, taskRunId: randomUUID(), commit: c1, language: "ru" }), { already: true });
});

test("the head moved by someone else while its merge was checked: it moves only from the expected value — the merge fails «head_moved», the other value stays", OPTS, async () => {
  const src = project();
  const ref = `refs/raoden/board/${WS}/1`;
  // the check itself moves the head (as a person's `git update-ref` would) to the project's HEAD
  const m = merger(path.join(TMP, `root-${++n}`), [`${GIT} --git-dir=${path.join(src, ".git")} update-ref ${ref} $(${GIT} --git-dir=${path.join(src, ".git")} rev-parse HEAD)`]);
  const h0 = await m.ensureHead(WS, src);
  const c1 = taskCommit(src, h0.commit, { "b.txt": "b\n" }, "t1");
  const r = await m.merge({ workspaceId: WS, project: src, task: task("T-1"), taskRunId: randomUUID(), commit: c1, language: "ru" });
  const s = await settled(m, h0.ref, r.runId);
  assert.deepEqual([s.status, s.reason], ["failed", "head_moved"]);
  assert.equal(g(src, "rev-parse", ref).trim(), g(src, "rev-parse", "HEAD").trim(), "the other value stays; nothing of the merge went in");
  // the autopilot takes no merge onto a head moved so, and turns off once nothing goes on
  const step = autopilotParallelStep({ tasks: [] }, [], { workspaceId: WS, project: src }, [], { runs: 0, ms: 0 }, AUTOPILOT_BUDGET,
    { workspaceId: WS, project: src, ref, n: 1, commit: h0.commit, merges: [s] });
  assert.deepEqual([step.kind, step.code], ["off", "head_moved"]);
});

test("a crash around the head's move (§4.6): after update-ref the merge completes on the next start; before it, it waits for the person", OPTS, async () => {
  const src = project();
  const root = path.join(TMP, `root-${++n}`);
  const m = merger(root, ["true"]);
  const h0 = await m.ensureHead(WS, src);
  const c1 = taskCommit(src, h0.commit, { "b.txt": "b\n" }, "t1");
  const r = await m.merge({ workspaceId: WS, project: src, task: task("T-1"), taskRunId: randomUUID(), commit: c1, language: "ru" });
  await settled(m, h0.ref, r.runId);
  const file = path.join(root, "runs", r.runId, "journal.jsonl");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  // cut after merge.committed: the process ended between the commit and the journal's merge.advanced (the head moved)
  const cut = lines.findIndex((l) => JSON.parse(l).type === "merge.committed") + 1;
  fs.writeFileSync(file, `${lines.slice(0, cut).join("\n")}\n`);
  const again = merger(root, ["true"]);
  await again.heads([{ workspaceId: WS, project: src }]);
  const s = (await again.mergesInto(h0.ref))[0];
  assert.deepEqual([s.status, s.completion], ["completed", "confirmed"]);
  // the same cut, but the head never moved: it waits for the person, never completes on its own
  const hb = g(src, "rev-parse", h0.ref).trim();
  const r2 = await again.merge({ workspaceId: WS, project: src, task: task("T-2"), taskRunId: randomUUID(), commit: taskCommit(src, hb, { "c.txt": "c\n" }, "t2"), language: "ru" });
  await settled(again, h0.ref, r2.runId);
  const file2 = path.join(root, "runs", r2.runId, "journal.jsonl");
  const l2 = fs.readFileSync(file2, "utf8").trim().split("\n");
  fs.writeFileSync(file2, `${l2.slice(0, l2.findIndex((l) => JSON.parse(l).type === "merge.committed") + 1).join("\n")}\n`);
  g(src, "update-ref", h0.ref, hb);
  const third = merger(root, ["true"]);
  await third.heads([{ workspaceId: WS, project: src }]);
  const s2 = (await third.mergesInto(h0.ref)).find((x) => x.runId === r2.runId);
  assert.deepEqual([s2.status, s2.reason], ["paused", "recovered"]);
});

// ---------------- two tasks at once through the manager, fake CLIs ----------------

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
// one script per work folder (MOCK_SCRIPT_PER_CWD): two runs at once never take each other's answers
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
function manager(script) {
  const root = path.join(TMP, `root-${++n}`);
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script, MOCK_SCRIPT_PER_CWD: "1" } };
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

test("two independent tasks at once on one link (parallelism 2, separate copies): both «Done», both in the board's result with its checks; the working folder untouched", OPTS, async () => {
  const src = project();
  const m = manager(scripts(turns("x.txt"), turns("y.txt")));
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["test -f keep.txt"] });
  const input = (title) => ({ workspaceId: WS, project: src, title, text: "write a file", criteria: ["the file says done"] });
  const a = (await m.boardCreate(input("A"))).value;
  const b = (await m.boardCreate(input("B"))).value;
  const before = personSide(src);
  const linkId = await linkOn(m, src);
  assert.equal((await m.boardBudget(linkId, { ...AUTOPILOT_BUDGET, parallel: 2 })).ok, true);
  assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
  // both runs go on at once, on one link
  const both = await until(async () => {
    const v = (await m.board()).value;
    const live = v.facts.filter((f) => ["preparing", "running", "paused"].includes(f.status));
    return live.length === 2 ? live : null;
  }, "two runs at once");
  assert.deepEqual(both.map((f) => f.taskKey).sort(), [a.key, b.key].sort());
  const link = (await m.canvas()).value.links.find((l) => l.linkId === linkId);
  assert.equal(link.runIds.length, 2);
  const end = await until(async () => { const s = (await m.board()).value.autopilot[linkId]; return s && !s.on ? s : null; }, "the autopilot to end", 240_000);
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  const v = (await m.board()).value;
  const st = boardStatuses(v.board, v.facts);
  assert.deepEqual([a, b].map((t) => st.get(t.id).done), ["confirmed", "confirmed"]);
  const [h] = v.heads;
  assert.deepEqual(h.merges.map((x) => [x.task.key, x.status, x.completion]).sort(), [[a.key, "completed", "confirmed"], [b.key, "completed", "confirmed"]].sort());
  assert.deepEqual(g(src, "ls-tree", "--name-only", h.commit).trim().split("\n").sort(), ["a.txt", "draft.txt", "keep.txt", "x.txt", "y.txt"]);
  // both from the same head; the person's side as it was, only the result branches are new names
  assert.equal(new Set(v.facts.map((f) => f.board)).size, 1);
  const after = personSide(src);
  assert.equal(after.files, before.files);
  assert.deepEqual(after.branches.split("\n").filter((l) => !l.startsWith("refs/heads/raoden/")), before.branches.split("\n"));
  await m.shutdown();
});

// ---------------- rollback onto the code of 1.5.16 (a4037ab) ----------------

const OLD = path.join(TMP, "v1516");
let oldReady = null;
const oldCode = () => (oldReady ??= (() => {
  fs.mkdirSync(OLD, { recursive: true });
  execFileSync("/bin/sh", ["-c", `"${GIT}" -C "${path.join(HERE, "..")}" archive a4037ab src | tar -x -C "${OLD}"`]);
  return true;
})());
const old = (rel) => import(pathToFileURL(path.join(OLD, rel)).href);

test("board.json on 1.5.16: the parallelism is kept by its other writes and dropped by its budget change (back to 2); nothing else is lost", OPTS, async () => {
  oldCode();
  const { createBoardStore: oldStore } = await old("src/main/services/orchestration/boardStore.ts");
  const file = path.join(TMP, `board-${++n}.json`);
  const [l1, l2] = [randomUUID(), randomUUID()];
  const now = createBoardStore(file, async () => 0);
  const t = await now.create({ workspaceId: WS, project: TMP, title: "A", text: "x", criteria: ["c"] });
  await now.budget(l1, { runs: 3, minutes: 60, parallel: 4 });
  await now.budget(l2, { runs: 2, minutes: 30, parallel: 1 });
  const back = oldStore(file, async () => 0);
  assert.equal((await back.read()).readOnly, null, "board.json stays v1: 1.5.16 writes it");
  await back.update(t.id, { title: "A2" }); // another write keeps the record as it is
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).autopilot[l1], { runs: 3, minutes: 60, parallel: 4 });
  await back.budget(l1, { runs: 5, minutes: 90 }); // its budget change writes runs and minutes only
  const again = (await createBoardStore(file, async () => 0).read()).board;
  assert.deepEqual([again.autopilot[l1], parallelOf(again.autopilot[l1]), again.autopilot[l2]], [{ runs: 5, minutes: 90 }, 2, { runs: 2, minutes: 30, parallel: 1 }]);
  assert.deepEqual(again.tasks.map((x) => x.title), ["A2"]);
});

test("a merge run (journal v3) on 1.5.16: listed «created by a newer version», read only — never continued or stopped, holds no link or folder", OPTS, async () => {
  oldCode();
  const src = project();
  const root = path.join(TMP, `root-${++n}`);
  const m = merger(root, ["true"]);
  const h0 = await m.ensureHead(WS, src);
  const c1 = taskCommit(src, h0.commit, { "b.txt": "b\n" }, "t1");
  const t1 = task("T-1");
  // a merge that waits for the person (the checks fail): not over, as an old build could meet it
  const failing = merger(root, ["false"]);
  const r = await failing.merge({ workspaceId: WS, project: src, task: t1, taskRunId: randomUUID(), commit: c1, language: "ru" });
  await settled(failing, h0.ref, r.runId);
  fs.writeFileSync(path.join(root, "canvas.json"), JSON.stringify({ v: 1, agents: [], links: [], owners: { [r.runId]: WS } }));
  const { createRunManager: oldManager } = await old("src/main/services/orchestration/manager.ts");
  const o = oldManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, agents: async () => { throw new Error("not used"); },
    journalV2: true, workspaceOpen: () => true, workspaceKnown: (id) => id === "common" });
  const listed = (await o.list()).value.find((x) => x.view.runId === r.runId);
  assert.deepEqual([listed.integrity, listed.view.status, listed.view.reason, listed.view.newer.version], ["newer_version", "paused", "newer_version", 3]);
  assert.equal(listed.view.newer.goal, "Объединение T-1 в итог доски");
  const stop = await o.command(r.runId, { commandId: randomUUID(), expectedRevision: 0, command: { kind: "stop" } });
  assert.equal(stop.code, "run_newer_version");
  // its owner kept by the old canvas store; no link holds it, so a run in the project folder may start there
  assert.equal((await o.canvas()).value.owners[r.runId], WS);
  const lead = (await o.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds })).value.agentId;
  const exec = (await o.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds })).value.agentId;
  const linkId = (await o.createLink({ linkId: randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
  const ready = (await o.readiness({ linkId, commands: ["true"], workMode: "project" }));
  assert.ok(!ready.ok || !ready.value.items.some((i) => i.id === "busy"), JSON.stringify(ready));
  // and the merge is as it was: still waiting, the head where it was
  assert.equal((await m.mergesInto(h0.ref))[0].status, "paused");
  assert.equal(g(src, "rev-parse", h0.ref).trim(), h0.commit);
  await o.shutdown();
});

// ---------- the review's cases (round 1) ----------

test("the autopilot's step over the merges: a stale «head moved», a failed or interrupted merge, a task run again, a retry", () => {
  let k = 0;
  const REF = `refs/raoden/board/${WS}/1`, C = (h) => h.repeat(40).slice(0, 40);
  const run = (o = {}) => ({ runId: randomUUID(), taskId: null, taskKey: null, createdAt: ++k, workspaceId: WS, status: "running", reason: null, newer: false, halted: false,
    limit: null, completion: null, phase: "work", permission: false, workMode: "copy", taken: null, board: REF, ...o });
  const t = (o = {}) => ({ id: randomUUID(), key: `T-${++k}`, workspaceId: WS, project: "/p", title: "t", text: "x", criteria: ["c"], dependsOn: [], order: k,
    createdAt: "x", updatedAt: "x", archivedAt: null, accepted: null, ...o });
  const done = (x, o = {}) => run({ taskId: x.id, taskKey: x.key, status: "completed", completion: "confirmed", taken: { branch: "b", commit: C("a"), applied: false }, ...o });
  const merge = (x, r, o = {}) => ({ runId: randomUUID(), board: REF, base: C("0"), task: { id: x.id, key: x.key, runId: r.runId, commit: r.taken.commit }, status: "completed",
    reason: null, detail: null, completion: "confirmed", conflicts: [], outside: [], interference: false, retrying: false, dir: null, createdAt: ++k, ...o });
  const head = (merges) => ({ workspaceId: WS, project: "/p", ref: REF, n: 1, commit: C("f"), merges });
  const AT = { workspaceId: WS, project: "/p" }, NONE = { runs: 0, ms: 0 };
  const step = (tasks, facts, merges) => autopilotParallelStep({ tasks }, facts, AT, [], NONE, AUTOPILOT_BUDGET, head(merges));
  // a «head moved» followed by a merge that went on from the new value: nothing stops (the newest first)
  { const a = t(), b = t(); const ra = done(a);
    const r = step([a, b], [ra], [merge(a, ra), merge(a, ra, { status: "failed", reason: "head_moved", completion: null })]);
    assert.equal(r.kind, "start", JSON.stringify(r)); }
  // a «Done» task whose merge failed or was interrupted: the person decides — never «all done», never a silent wait
  { const a = t(); const ra = done(a);
    const r = step([a], [ra], [merge(a, ra, { status: "failed", reason: "error", completion: null })]);
    assert.deepEqual([r.kind, r.code, r.key], ["off", "merge_failed", a.key]); }
  { const a = t(), b = t({ dependsOn: [] }); b.dependsOn = [a.id]; const ra = done(a);
    const r = step([a, b], [ra], [merge(a, ra, { status: "stopped", reason: "interrupted", completion: null })]);
    assert.deepEqual([r.kind, r.code], ["off", "merge_failed"]); }
  // a task run again: its new result is not in the head; the mark and the step say so
  { const a = t(); const old = done(a); const now = done(a, { createdAt: 1e9, taken: { branch: "d", commit: C("c"), applied: false } });
    const h = head([merge(a, old)]);
    assert.equal(mergeMark(a.id, h, now.runId), null);
    assert.deepEqual(mergeMark(a.id, h, old.runId), { kind: "in_board", checks: true });
    const r = autopilotParallelStep({ tasks: [a] }, [old, now], AT, [], NONE, AUTOPILOT_BUDGET, h);
    assert.deepEqual([r.kind, r.runId], ["merge", now.runId]); }
  // a merge whose checks wait to be retried: no new task starts meanwhile; once it goes on, they do
  { const a = t(), b = t(); const ra = done(a);
    assert.deepEqual(step([a, b], [ra], [merge(a, ra, { status: "running", completion: null, retrying: true })]), { kind: "wait", why: "run" });
    assert.equal(step([a, b], [ra], [merge(a, ra, { status: "running", completion: null })]).kind, "start"); }
});

test("merge runs: a conflict without markers is never committed unnoticed; a result in the head already is marked; no saved settings, no merge; a preparation that changes the copy pauses", OPTS, async () => {
  const src = project();
  fs.writeFileSync(path.join(src, "logo.bin"), Buffer.from([0, 1, 2, 3]));
  g(src, "add", "-A"); g(src, "commit", "-q", "-m", "logo");
  const root = path.join(TMP, `root-${++n}`);
  const m = merger(root, ["true"]);
  const h0 = await m.ensureHead(WS, src);
  const t1 = task("T-1"), t2 = task("T-2");
  const bin = (bytes) => Buffer.from(bytes).toString("latin1");
  const c1 = taskCommit(src, h0.commit, { "logo.bin": bin([0, 9, 9, 9]) }, "bin1");
  const c2 = taskCommit(src, h0.commit, { "logo.bin": bin([0, 7, 7, 7]) }, "bin2");
  const r1 = await m.merge({ workspaceId: WS, project: src, task: t1, taskRunId: randomUUID(), commit: c1, language: "ru" });
  assert.equal((await settled(m, h0.ref, r1.runId)).status, "completed");
  const r2 = await m.merge({ workspaceId: WS, project: src, task: t2, taskRunId: randomUUID(), commit: c2, language: "ru" });
  const p = await settled(m, h0.ref, r2.runId);
  assert.deepEqual([p.status, p.conflicts], ["paused", ["logo.bin"]]);
  // «Готово, проверить» at once: no markers in a binary file, but it is as the merge left it — the person confirms it
  assert.deepEqual(await m.resolve(r2.runId, false), { result: "confirm", files: ["logo.bin"] });
  await m.skip(r2.runId);
  // the same result again, already in the head: a completed run says so (the autopilot does not ask again)
  const h1 = g(src, "rev-parse", h0.ref).trim();
  assert.deepEqual(await m.merge({ workspaceId: WS, project: src, task: t1, taskRunId: randomUUID(), commit: c1, language: "ru" }), { already: true });
  const marked = (await m.mergesInto(h0.ref))[0];
  assert.deepEqual([marked.task.id, marked.status, marked.reason], [t1.id, "completed", "already"]);
  assert.equal(g(src, "rev-parse", h0.ref).trim(), h1);
  // the project's settings never saved: the merged code is not checked with guessed commands
  const unsaved = createBoardMerge({ root, gitPath: () => GIT, launch: () => LAUNCH, own: async () => {}, checks: async () => null,
    shell: async () => ({ shell: SHELL, env: CHECK_ENV }), quiet: async () => true });
  const c3 = taskCommit(src, h1, { "c.txt": "c\n" }, "c3");
  await assert.rejects(unsaved.merge({ workspaceId: WS, project: src, task: task("T-3"), taskRunId: randomUUID(), commit: c3, language: "ru" }), { code: "merge_no_settings" });
  // a preparation step that rewrites a file of the merged tree: paused with that reason, the head where it was
  const prep = createBoardMerge({ root, gitPath: () => GIT, launch: () => LAUNCH, own: async () => {}, checks: async () => ["true"],
    prepare: async () => ({ auto: true, steps: [{ command: "echo more >> keep.txt", unless: null }] }),
    shell: async () => ({ shell: SHELL, env: CHECK_ENV }), quiet: async () => true });
  const r4 = await prep.merge({ workspaceId: WS, project: src, task: task("T-3"), taskRunId: randomUUID(), commit: c3, language: "ru" });
  const s4 = await settled(prep, h0.ref, r4.runId);
  assert.deepEqual([s4.status, s4.reason, s4.detail], ["paused", "merge_prepare_changed", "keep.txt"]);
  assert.equal(g(src, "rev-parse", h0.ref).trim(), h1);
  assert.equal(await prep.active(src), false);
  await prep.skip(r4.runId);
  // a failure that repeats (unrelated histories: no conflict paths, git refuses): «Пропустить» is the way out
  const empty = g(src, "hash-object", "-t", "tree", "-w", "/dev/null").trim();
  const orphan = g(src, "commit-tree", empty, "-m", "unrelated").trim();
  const r5 = await m.merge({ workspaceId: WS, project: src, task: task("T-5"), taskRunId: randomUUID(), commit: orphan, language: "ru" });
  const s5 = await settled(m, h0.ref, r5.runId);
  assert.deepEqual([s5.status, s5.reason], ["failed", "error"]);
  await m.skip(r5.runId);
  assert.deepEqual([(await m.mergesInto(h0.ref)).find((x) => x.runId === r5.runId).reason], ["skipped"]);
  await assert.rejects(m.skip(r5.runId), { code: "merge_not_paused" });
});
