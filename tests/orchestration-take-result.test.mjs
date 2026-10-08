// UX audit 2026-10-05, top-10 #10: «Забрать результат» from a separate copy or worktree. The application makes the
// branch or applies the patch with its own Git: the user's working tree, index, HEAD and current branch stay as they
// were (byte for byte) unless «apply» was asked, and «apply» writes nothing when the patch does not fit the files now.
// Fake CLIs only; every repository is a temporary one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { branchSlug, createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-take-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
function project(files) {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  return dir;
}
const wrapper = (name, mock) => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
};
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
function providersFile(env) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, ...env } };
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
const b64 = (s) => Buffer.from(s).toString("base64");
const PLAN = { answer: { stages: [{ title: "fix", task: "make the test pass" }], question: null } };
const REVIEW = { answer: { verdict: "accept", findings: [], question: null } };
const FINAL = { answer: { verdict: "complete", findings: [], question: null } };
const EXEC = (files) => ({ answer: { summary: "done", done: true }, writes: Object.entries(files).map(([rel, text]) => ({ rel, base64: b64(text) })) });
function manager(files) {
  const root = path.join(TMP, `root-${++n}`);
  return createRunManager({
    platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); },
    native: testNativeRuntime(providersFile({ MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script([PLAN, EXEC(files), REVIEW, FINAL]) }), () => LAUNCH)
  });
}
async function completed(m, src, workMode, text = "set a to 2") {
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text, criteria: ["a is 2"], checks: [], commands: ["true"], mode: "autopilot", workMode } });
  assert.ok(r.ok, JSON.stringify(r));
  const end = Date.now() + 60_000;
  for (;;) {
    const v = (await m.get(runId)).value.view;
    if (["completed", "paused", "failed", "stopped"].includes(v.status)) { assert.equal(v.status, "completed", JSON.stringify(v)); return runId; }
    if (Date.now() > end) throw new Error("the run did not end");
    await sleep(50);
  }
}
// everything of the user's side a branch must not touch: files, the index file, HEAD, the current branch
const userSide = (src, files) => ({
  files: Object.fromEntries(files.map((f) => [f, fs.existsSync(path.join(src, f)) ? fs.readFileSync(path.join(src, f), "utf8") : null])),
  index: fs.readFileSync(path.join(src, ".git", "index")).toString("base64"),
  head: fs.readFileSync(path.join(src, ".git", "HEAD"), "utf8"),
  main: g(src, "rev-parse", "refs/heads/main").trim()
});
const ok = (r) => { assert.ok(r.ok, JSON.stringify(r)); return r.value; };

test("the branch name from the goal: Latin, Cyrillic transliterated, the rest a dash", () => {
  assert.equal(branchSlug("Сделай кнопку «Сохранить» зелёной"), "sdelai-knopku-sohranit-zelenoi");
  assert.equal(branchSlug("Fix: login (#42)"), "fix-login-42");
  assert.equal(branchSlug("!!!"), "result");
  assert.ok(branchSlug("a".repeat(80)).length <= 32);
});

test("copy: «Create a branch» puts the run's changes in a new branch of the project; the user's side stays byte for byte; a taken name is never overwritten; again — no duplicate", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "x\n" });
  const m = manager({ "a.txt": "2\n" });
  // the user's own uncommitted work: an edited file and a staged new one
  fs.writeFileSync(path.join(src, "b.txt"), "x\nmine\n");
  fs.writeFileSync(path.join(src, "s.txt"), "staged\n");
  g(src, "add", "s.txt");
  const runId = await completed(m, src, "copy");
  const info = ok(await m.take(runId));
  assert.deepEqual([info.mode, info.from, info.files, info.allowed, info.branch, info.applied], ["copy", "checkpoint", 1, true, null, null]);
  assert.equal(info.suggested, `raoden/set-a-to-2-${runId.slice(0, 8)}`);
  // the suggested name taken already: another one is offered, and the taken one is refused, not moved
  g(src, "branch", info.suggested);
  const head = g(src, "rev-parse", "HEAD").trim();
  const next = ok(await m.take(runId)).suggested;
  assert.equal(next, `${info.suggested}-2`);
  const before = userSide(src, ["a.txt", "b.txt", "s.txt"]);
  const taken = ok(await m.takeResult(runId, { action: "branch", name: info.suggested }));
  assert.equal(taken.result, "branch_exists");
  assert.equal(g(src, "rev-parse", `refs/heads/${info.suggested}`).trim(), head, "not overwritten");
  const made = ok(await m.takeResult(runId, { action: "branch", name: next }));
  assert.equal(made.result, "created", JSON.stringify(made));
  assert.equal(g(src, "show", `${next}:a.txt`), "2\n", "the branch holds the run's change");
  assert.equal(g(src, "show", `${next}:b.txt`), "x\nmine\n", "on top of what the run started from");
  assert.match(g(src, "log", "-1", "--format=%B", next), new RegExp(`CanvasTTY-Run: ${runId}`));
  assert.deepEqual(userSide(src, ["a.txt", "b.txt", "s.txt"]), before, "working tree, index, HEAD and the current branch untouched");
  assert.deepEqual(made.take.branch?.name, next);
  // again: nothing new
  const again = ok(await m.takeResult(runId, { action: "branch", name: `${next}-other` }));
  assert.equal(again.result, "already");
  assert.equal(g(src, "for-each-ref", "--format=%(refname)", "refs/heads/raoden/").trim().split("\n").length, 2);
  assert.equal(ok(await m.takeResult(runId, { action: "branch", name: "-bad" })).result, "already", "the record answers before the name");
  await m.shutdown();
});

test("copy: «Apply to the working folder» writes the run's changes beside the user's own; a conflict with their uncommitted work refuses and writes nothing", OPTS, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "x\n" });
  const m = manager({ "a.txt": "2\n", "n.txt": "new\n" });
  const runId = await completed(m, src, "copy");
  fs.writeFileSync(path.join(src, "b.txt"), "x\nmine\n"); // the user's work elsewhere: no conflict
  const index = fs.readFileSync(path.join(src, ".git", "index"));
  const applied = ok(await m.takeResult(runId, { action: "apply" }));
  assert.equal(applied.result, "applied", JSON.stringify(applied));
  assert.equal(fs.readFileSync(path.join(src, "a.txt"), "utf8"), "2\n");
  assert.equal(fs.readFileSync(path.join(src, "n.txt"), "utf8"), "new\n");
  assert.equal(fs.readFileSync(path.join(src, "b.txt"), "utf8"), "x\nmine\n");
  assert.deepEqual(fs.readFileSync(path.join(src, ".git", "index")), index, "the index is not touched");
  assert.ok(applied.take.applied?.at);
  assert.equal(ok(await m.takeResult(runId, { action: "apply" })).result, "already", "again: not applied twice");
  await m.shutdown();

  const src2 = project({ "a.txt": "1\n" });
  const m2 = manager({ "a.txt": "2\n", "n.txt": "new\n" });
  const run2 = await completed(m2, src2, "copy");
  fs.writeFileSync(path.join(src2, "a.txt"), "mine\n"); // the same line, changed by the user after the start
  const refused = ok(await m2.takeResult(run2, { action: "apply" }));
  assert.equal(refused.result, "conflict");
  assert.deepEqual(refused.files, ["a.txt"]);
  assert.equal(fs.readFileSync(path.join(src2, "a.txt"), "utf8"), "mine\n");
  assert.equal(fs.existsSync(path.join(src2, "n.txt")), false, "nothing of the patch written");
  assert.equal(refused.take.applied, null);
  // the branch is still offered and works
  assert.equal(ok(await m2.takeResult(run2, { action: "branch", name: "from-run" })).result, "created");
  assert.equal(fs.readFileSync(path.join(src2, "a.txt"), "utf8"), "mine\n");
  await m2.shutdown();
});

test("worktree: the run's branch is shown; «Create a branch» commits the result on it and renames it", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ "a.txt": "2\n" });
  const runId = await completed(m, src, "worktree");
  const info = ok(await m.take(runId));
  assert.equal(info.mode, "worktree");
  assert.equal(info.runBranch, `canvastty/${runId.slice(0, 8)}`);
  const before = userSide(src, ["a.txt"]);
  const r = ok(await m.takeResult(runId, { action: "branch", name: "feature/a-is-2" }));
  assert.equal(r.result, "renamed", JSON.stringify(r));
  assert.equal(r.take.runBranch, "feature/a-is-2");
  assert.equal(g(src, "show", "feature/a-is-2:a.txt"), "2\n");
  assert.equal(g(src, "branch", "--list", info.runBranch).trim(), "", "the old name is gone");
  assert.match(g(src, "worktree", "list"), /\[feature\/a-is-2\]/, "the worktree follows the renamed branch");
  assert.deepEqual(userSide(src, ["a.txt"]), before);
  assert.equal(ok(await m.takeResult(runId, { action: "branch", name: "feature/a-is-2" })).result, "already");
  await m.shutdown();
});

test("the project folder: nothing to take, the changes are there already", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ "a.txt": "2\n" });
  const runId = await completed(m, src, "project");
  const r = await m.take(runId);
  assert.equal(r.ok, false);
  assert.equal(r.code, "take_unavailable");
  await m.shutdown();
});
