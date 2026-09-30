// Snapshots, checkpoints and restore of the managed copy (stage-3-contract.md), on temporary repositories only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import {
  applyRestore,
  createCheckpoint,
  createSnapshot,
  inspectWorkspaceRefs,
  prepareRestore
} from "../src/main/services/orchestration/snapshots.ts";
import { createRun } from "../src/main/services/orchestration/store.ts";
import { createWorkspace, readIncompleteRestore } from "../src/main/services/orchestration/workspace.ts";

const GIT = findGit(process.env);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty snapshots ü-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GITCONFIG = path.join(TMP, "test-gitconfig");
fs.writeFileSync(GITCONFIG, "");

// Test-side git: isolated from the user's configuration, fixed identity, argv only.
function g(cwd, ...args) {
  return execFileSync(GIT, args, {
    cwd,
    env: {
      PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t"
    },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function sourceFingerprint(src) {
  return {
    index: sha(path.join(src, ".git", "index")),
    head: fs.readFileSync(path.join(src, ".git", "HEAD"), "utf8"),
    branches: g(src, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"),
    files: Object.fromEntries(fs.readdirSync(src).filter((f) => f !== ".git").map((f) => [f, sha(path.join(src, f))]))
  };
}

let n = 0;
async function setup() {
  const root = path.join(TMP, `root ${++n} ✓`);
  const src = path.join(TMP, `source ${n} проект`);
  fs.mkdirSync(src, { recursive: true });
  g(src, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "a.txt"), "one\n");
  fs.writeFileSync(path.join(src, ".gitignore"), "*.log\n");
  fs.writeFileSync(path.join(src, "notes.log"), "tracked though ignored\n");
  g(src, "add", "a.txt", ".gitignore");
  g(src, "add", "-f", "notes.log");
  g(src, "commit", "-q", "-m", "init");
  const runId = randomUUID();
  const writer = await createRun(root, runId, { goal: "snapshots" });
  const ws = await createWorkspace({ root, runId, source: src, gitPath: GIT });
  return { root, src, runId, writer, ws };
}
const copyFile = (ws, name) => path.join(ws.repo, name);

test("checkpoint: created in the source, repeat returns the same result, other content is a conflict, stages are ordered", async () => {
  const { src, ws, writer } = await setup();
  const before = sourceFingerprint(src);
  fs.writeFileSync(copyFile(ws, "a.txt"), "two\n");
  fs.writeFileSync(copyFile(ws, "new file ü.txt"), "added by the agent\n");

  const c1 = await createCheckpoint(ws, 1);
  assert.equal(c1.reused, false);
  assert.equal(c1.parent, ws.baseline.commit);
  assert.equal(g(src, "rev-parse", `refs/canvastty/${ws.runId}/stage-1`), c1.commit);
  assert.equal(g(src, "show", `${c1.commit}:new file ü.txt`), "added by the agent");
  assert.match(g(src, "log", "-1", "--format=%B", c1.commit), new RegExp(`CanvasTTY-Snapshot: ${ws.runId}:stage-1`));

  const again = await createCheckpoint(ws, 1);
  assert.deepEqual(again, { ...c1, reused: true }, "same tree and parent: the same checkpoint");

  fs.writeFileSync(copyFile(ws, "a.txt"), "three\n");
  await assert.rejects(createCheckpoint(ws, 1), (e) => e.code === "checkpoint_conflict" && e.detail.existing === c1.commit);
  assert.equal(g(src, "rev-parse", `refs/canvastty/${ws.runId}/stage-1`), c1.commit, "the existing checkpoint is not overwritten");

  await assert.rejects(createCheckpoint(ws, 3), (e) => e.code === "checkpoint_out_of_order");
  await assert.rejects(createCheckpoint(ws, 2, { expectedTree: c1.tree }), (e) => e.code === "tree_changed");
  const c2 = await createCheckpoint(ws, 2);
  assert.equal(c2.parent, c1.commit);

  const after = sourceFingerprint(src);
  assert.deepEqual(after, before, "source index, HEAD, branches, tags and files unchanged");
  assert.deepEqual(g(src, "for-each-ref", "--format=%(refname:lstrip=3)", `refs/canvastty/${ws.runId}`).split("\n").sort(),
    ["baseline", "stage-1", "stage-2"], "no temporary refs left");
  await writer.close();
});

test("restore to the baseline: recovery snapshot first, non-ignored files replaced, ignored files kept, .git of the copy untouched", async () => {
  const { src, ws, writer } = await setup();
  fs.writeFileSync(copyFile(ws, "a.txt"), "changed\n");
  fs.writeFileSync(copyFile(ws, "extra.txt"), "only in the copy\n");
  fs.writeFileSync(copyFile(ws, "debug.log"), "ignored build output\n");
  const copyHead = fs.readFileSync(path.join(ws.repo, ".git", "HEAD"), "utf8");

  const prepared = await prepareRestore(ws, { name: "baseline", commit: ws.baseline.commit }, ws.baseline);
  assert.equal(prepared.recovery.kind, "recovery");
  assert.equal(g(src, "rev-parse", prepared.recovery.ref), prepared.recovery.commit, "recovery snapshot published before any change");
  assert.equal(fs.readFileSync(copyFile(ws, "extra.txt"), "utf8"), "only in the copy\n", "prepare changes nothing in the copy");
  assert.equal(g(src, "show", `${prepared.recovery.commit}:extra.txt`), "only in the copy");

  await applyRestore(ws, prepared);
  assert.equal(fs.readFileSync(copyFile(ws, "a.txt"), "utf8"), "one\n");
  assert.equal(fs.existsSync(copyFile(ws, "extra.txt")), false, "removed: it is in the recovery snapshot");
  assert.equal(fs.readFileSync(copyFile(ws, "debug.log"), "utf8"), "ignored build output\n", "ignored files are left alone");
  assert.equal(fs.readFileSync(path.join(ws.repo, ".git", "HEAD"), "utf8"), copyHead);
  assert.equal(fs.readFileSync(path.join(src, "a.txt"), "utf8"), "one\n", "the source project is not reset");
  await writer.close();
});

test("restore conflict: a target path held by an ignored file is refused and the copy is unchanged", async () => {
  const { ws, writer } = await setup();
  fs.writeFileSync(copyFile(ws, "build.out"), "v1\n");
  const c1 = await createCheckpoint(ws, 1); // build.out not ignored yet: in stage-1
  // now ignored and changed: the recovery snapshot (tracked set = baseline) leaves it out, stage-1 would overwrite it
  fs.appendFileSync(copyFile(ws, ".gitignore"), "build.out\n");
  fs.writeFileSync(copyFile(ws, "build.out"), "v2, not in any snapshot\n");
  // base = baseline: build.out is outside the applicable base, so it is outside the recovery snapshot and in the way
  const prepared = await prepareRestore(ws, { name: "stage-1", commit: c1.commit }, ws.baseline);
  assert.throws(() => g(ws.repo, "--git-dir", ws.control, "cat-file", "-e", `${prepared.recoveryCommit}:build.out`));
  await assert.rejects(applyRestore(ws, prepared), (e) => e.code === "restore_conflict" && e.detail.path === "build.out");
  assert.equal(fs.readFileSync(copyFile(ws, "build.out"), "utf8"), "v2, not in any snapshot\n");
  assert.equal(fs.readFileSync(copyFile(ws, ".gitignore"), "utf8"), "*.log\nbuild.out\n", "nothing applied");
  assert.equal(await readIncompleteRestore(ws), null, "refused before the first write: no intent file");
  await writer.close();
});

// Defect 3 of the external review: the applicable base decides what the recovery snapshot holds. A file accepted into
// a checkpoint must stay in it with the content from disk, even once a new ignore rule hides it.
test("recovery snapshot keeps a file accepted into the applicable base after a new ignore rule", async () => {
  const { src, ws, writer } = await setup();
  fs.writeFileSync(copyFile(ws, "build.out"), "v1\n");
  const c1 = await createCheckpoint(ws, 1);
  fs.appendFileSync(copyFile(ws, ".gitignore"), "build.out\n");
  fs.writeFileSync(copyFile(ws, "build.out"), "v2, only on disk\n");

  const prepared = await prepareRestore(ws, { name: "stage-1", commit: c1.commit }, { commit: c1.commit, tree: c1.tree, parent: c1.parent });
  assert.equal(g(src, "show", `${prepared.recoveryCommit}:build.out`), "v2, only on disk", "the accepted file is in the recovery commit");
  assert.deepEqual(await applyRestore(ws, prepared), { status: "restored" });
  assert.equal(fs.readFileSync(copyFile(ws, "build.out"), "utf8"), "v1\n", "restored to the checkpoint's content");
  assert.equal(await readIncompleteRestore(ws), null);
  await writer.close();
});

test("restore target must match the journal's commit", async () => {
  const { ws, writer } = await setup();
  await createCheckpoint(ws, 1);
  await assert.rejects(prepareRestore(ws, { name: "stage-1", commit: ws.baseline.commit }, ws.baseline), (e) => e.code === "restore_target_mismatch");
  await assert.rejects(prepareRestore(ws, { name: "stage-2", commit: ws.baseline.commit }, ws.baseline), (e) => e.code === "restore_target_mismatch");
  await writer.close();
});

test("intermediate snapshots stay in control.git; recovery snapshots are numbered in the source", async () => {
  const { src, ws, writer } = await setup();
  fs.writeFileSync(copyFile(ws, "a.txt"), "x\n");
  const mid = await createSnapshot(ws, "intermediate", ws.baseline);
  assert.match(mid.ref, /^refs\/canvastty\/snapshot\/[0-9a-f-]{36}$/);
  assert.equal(g(src, "for-each-ref", "refs/canvastty/snapshot"), "", "not published in the source");
  const r1 = await createSnapshot(ws, "recovery", ws.baseline);
  const r2 = await createSnapshot(ws, "recovery", ws.baseline);
  assert.deepEqual([r1.ref, r2.ref], [`refs/canvastty/${ws.runId}/recovery-1`, `refs/canvastty/${ws.runId}/recovery-2`]);
  assert.equal(r1.tree, mid.tree);
  await writer.close();
});

test("a nested repository in the copy is refused, not recorded as a gitlink", async () => {
  const { ws, writer } = await setup();
  const nested = copyFile(ws, "vendor");
  fs.mkdirSync(nested);
  g(nested, "init", "-q");
  fs.writeFileSync(path.join(nested, "x"), "x");
  await assert.rejects(createSnapshot(ws, "intermediate", ws.baseline), (e) => e.code === "nested_repository");
  await writer.close();
});

test("inspectWorkspaceRefs: refs without events are reported, never accepted or deleted", async () => {
  const { ws, writer } = await setup();
  fs.writeFileSync(copyFile(ws, "a.txt"), "y\n");
  const c1 = await createCheckpoint(ws, 1);
  const state = { baseline: ws.baseline, checkpoints: {}, snapshots: [] };
  const found = await inspectWorkspaceRefs(ws, state);
  assert.deepEqual(found.unjournaled, [{ name: "stage-1", commit: c1.commit }]);
  assert.deepEqual(found.missing, []);
  assert.deepEqual((await inspectWorkspaceRefs(ws, state)).unjournaled, found.unjournaled, "inspection deletes nothing");
  await writer.close();
});
