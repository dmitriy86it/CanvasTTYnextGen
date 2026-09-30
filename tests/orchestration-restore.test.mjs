// Р3 restore regressions (docs/agent-orchestration/implementation/stage-3-review-fixes.md): the three review defects
// and the rules around them — refusal before the first write leaves the copy untouched, a write that fails half way is
// restore_incomplete and blocks everything until it is cleared, the applicable base is mandatory, and a confirmed
// restore returns { status: "restored" }. Only temporary repositories under a canvastty-restore-tests- mkdtemp
// directory; the source repository must stay byte-for-byte the same apart from refs/canvastty/<runId>/* and objects.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { createSnapshot, createCheckpoint, prepareRestore, applyRestore } from "../src/main/services/orchestration/snapshots.ts";
import {
  applyTreeToCopy,
  clearIncompleteRestore,
  readCommit,
  readIncompleteRestore,
  snapshotCopyTree
} from "../src/main/services/orchestration/workspace.ts";
import { fingerprint, readCommitTree, readTree, refs, write } from "./fixtures/orchestration/git-fixtures.mjs";
import {
  baselineTarget,
  copyState,
  craftTree,
  intentPath,
  newTmp,
  probeAcceptedFile,
  probePartialRestore,
  probeStateChanged,
  setupWorkspace
} from "./fixtures/orchestration/restore-probes.mjs";

const TMP = newTmp("regressions");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Probe 1 makes a directory unwritable; root would write through it anyway.
const ROOT_USER = process.getuid?.() === 0;

// A target tree with two paths differing only in case is unreachable on disk here, and reachable elsewhere.
const CASE_INSENSITIVE = (() => {
  fs.writeFileSync(path.join(TMP, "case-probe"), "x");
  const same = fs.existsSync(path.join(TMP, "CASE-PROBE"));
  fs.rmSync(path.join(TMP, "case-probe"));
  return same;
})();

const code = (c) => (e) => {
  assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.stack ?? e}`);
  return true;
};
const checks = (result) => {
  for (const [what, ok] of result.checks) assert.ok(ok, `${result.name}: ${what}`);
};
const read = (ws, rel) => fs.readFileSync(path.join(ws.repo, rel), "utf8");
const canvasttyRefs = (tmp, source, runId) => refs(tmp, source, `refs/canvastty/${runId}/`).sort();

// a.txt, b.txt, a path with a space and non-ASCII characters, and an ignored directory.
const SMALL = (dir) => {
  write(dir, "a.txt", "a v1\n");
  write(dir, "b.txt", "b v1\n");
  write(dir, "dir with space/файл ü.txt", "u v1\n");
  write(dir, ".gitignore", "build/\n");
};

async function assertSourceUnchanged(c, before, label) {
  assert.deepEqual(fingerprint(c.tmp, c.source), before, `${label}: source repository changed`);
}

test("probe 1: a write that fails half way is restore_incomplete with the intent file left behind", { skip: ROOT_USER && "not as root" }, async () => {
  const result = await probePartialRestore(TMP);
  checks(result);
  assert.equal(result.facts.code, "restore_incomplete");
  const intent = result.facts.intent;
  assert.equal(intent.target, result.prepared.target);
  assert.equal(intent.targetCommit, result.prepared.targetCommit);
  assert.equal(intent.recoveryCommit, result.prepared.recoveryCommit);
  assert.equal(intent.fromTree, result.prepared.fromTree);
  assert.equal(intent.toTree, result.prepared.toTree);
  assert.equal(new Date(intent.startedAt).toISOString(), intent.startedAt, "startedAt is an ISO timestamp");
});

// The other side of defect 1: a write that fails with nothing written at all stays a conflict, and the intent
// file is removed again. Only zdir/only ü.txt differs between the trees, so the first failure is also the last.
test("a failed write that changed nothing is restore_conflict and takes the intent file back", { skip: ROOT_USER && "not as root" }, async () => {
  const c = await setupWorkspace(TMP, "nothing-written", (dir) => {
    write(dir, "zdir/only ü.txt", "only v1\n");
    write(dir, ".gitignore", "build/\n");
  });
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  write(ws.repo, "zdir/only ü.txt", "only changed by the agent\n");
  const prepared = await prepareRestore(ws, baselineTarget(ws), ws.baseline);

  const zdir = path.join(ws.repo, "zdir");
  const zmode = fs.statSync(zdir).mode & 0o7777;
  const before = copyState(ws.repo);
  fs.chmodSync(zdir, 0o500);
  try {
    await assert.rejects(applyRestore(ws, prepared), code("restore_conflict"));
  } finally {
    fs.chmodSync(zdir, zmode);
  }
  assert.deepEqual(copyState(ws.repo), { ...before, zdir: `dir:${zmode.toString(8)}` }, "the copy did not change");
  assert.equal(read(ws, "zdir/only ü.txt"), "only changed by the agent\n");
  assert.equal(await readIncompleteRestore(ws), null);
  assert.equal(fs.existsSync(intentPath(ws)), false, "nothing was written, so the intent file is gone");
  await assertSourceUnchanged(c, sourceBefore, "failed write with nothing written");
});

// A crash between writing the intent file and the confirmation leaves the file, possibly half written: its mere
// presence blocks, and only clearIncompleteRestore unblocks.
test("an intent file left by a crash blocks even when it is unreadable", async () => {
  const c = await setupWorkspace(TMP, "crash-intent", SMALL);
  const ws = c.ws;
  write(ws.repo, "a.txt", "a changed by the agent\n");
  fs.writeFileSync(intentPath(ws), '{"v":1,"fromTree":"tru');
  assert.equal(await readIncompleteRestore(ws), null, "a truncated intent file does not parse");
  await assert.rejects(createSnapshot(ws, "intermediate", ws.baseline), code("restore_incomplete"));
  await assert.rejects(createCheckpoint(ws, 1), code("restore_incomplete"));
  await assert.rejects(prepareRestore(ws, baselineTarget(ws), ws.baseline), code("restore_incomplete"));
  await clearIncompleteRestore(ws);
  assert.ok(await createSnapshot(ws, "intermediate", ws.baseline));
});

test("after a half-written restore every operation is refused until clearIncompleteRestore; no automatic rollback", { skip: ROOT_USER && "not as root" }, async () => {
  const result = await probePartialRestore(TMP);
  checks(result);
  const { case: c, prepared } = result;
  const ws = c.ws;
  const partial = copyState(ws.repo);
  const refsBefore = canvasttyRefs(c.tmp, c.source, c.runId);
  const sourceBefore = fingerprint(c.tmp, c.source);

  await assert.rejects(createSnapshot(ws, "intermediate", ws.baseline), code("restore_incomplete"), "createSnapshot");
  await assert.rejects(createSnapshot(ws, "recovery", ws.baseline), code("restore_incomplete"), "createSnapshot(recovery)");
  await assert.rejects(createCheckpoint(ws, 1), code("restore_incomplete"), "createCheckpoint");
  await assert.rejects(prepareRestore(ws, baselineTarget(ws), ws.baseline), code("restore_incomplete"), "prepareRestore");
  await assert.rejects(applyRestore(ws, prepared), code("restore_incomplete"), "applyRestore (retry)");

  assert.deepEqual(copyState(ws.repo), partial, "the refused calls did not touch the copy");
  assert.deepEqual(canvasttyRefs(c.tmp, c.source, c.runId), refsBefore, "no ref was published while blocked");
  assert.ok(fs.existsSync(intentPath(ws)), "the intent file is still there");

  // The recovery snapshot of the pre-restore copy is published and readable.
  assert.ok(refsBefore.some((l) => l === `${prepared.recoveryCommit} refs/canvastty/${c.runId}/recovery-1`), refsBefore.join(","));
  assert.deepEqual(readCommitTree(c.tmp, ws.control, prepared.recoveryCommit), {
    ".gitignore": "build/\n", "a.txt": "a changed by the agent\n", "zdir/c ü.txt": "c changed by the agent\n"
  }, "recovery snapshot = the copy before the restore");

  await clearIncompleteRestore(ws);
  assert.equal(await readIncompleteRestore(ws), null);
  assert.equal(fs.existsSync(intentPath(ws)), false, "clearIncompleteRestore removed the intent file");
  assert.deepEqual(copyState(ws.repo), partial, "no automatic rollback: the copy is still half restored");
  assert.equal(read(ws, "a.txt"), "a v1\n");
  assert.equal(read(ws, "zdir/c ü.txt"), "c changed by the agent\n");

  // Unblocked: a snapshot of the half-restored copy is possible again.
  const snap = await createSnapshot(ws, "intermediate", ws.baseline);
  assert.deepEqual(readCommitTree(c.tmp, ws.control, snap.commit), {
    ".gitignore": "build/\n", "a.txt": "a v1\n", "zdir/c ü.txt": "c changed by the agent\n"
  }, "the half-restored state is what a new snapshot sees");
  await assertSourceUnchanged(c, sourceBefore, "blocked and cleared");
});

test("probe 2: a copy changed after prepareRestore is refused before the first write, byte for byte", async () => {
  const result = await probeStateChanged(TMP);
  checks(result);
  assert.deepEqual(result.facts.afterApply, result.facts.beforeApply, "the copy did not change");
  assert.equal(result.facts.intentFile, false, "no intent file for a refusal before the first write");
  assert.equal(result.facts.error.detail?.expected, result.prepared.fromTree, "detail names the prepared tree");
  assert.notEqual(result.facts.error.detail?.actual, result.prepared.fromTree, "detail names the tree found instead");
});

test("an existing file changed between prepareRestore and applyRestore -> restore_state_changed", async () => {
  const c = await setupWorkspace(TMP, "between-modified", SMALL);
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  write(ws.repo, "a.txt", "a changed by the agent\n");
  const prepared = await prepareRestore(ws, baselineTarget(ws), ws.baseline);
  write(ws.repo, "dir with space/файл ü.txt", "u changed after prepareRestore\n");

  const before = copyState(ws.repo);
  await assert.rejects(applyRestore(ws, prepared), code("restore_state_changed"));
  assert.deepEqual(copyState(ws.repo), before, "nothing was written");
  assert.equal(read(ws, "a.txt"), "a changed by the agent\n");
  assert.equal(read(ws, "dir with space/файл ü.txt"), "u changed after prepareRestore\n");
  assert.equal(await readIncompleteRestore(ws), null);
  assert.equal(fs.existsSync(intentPath(ws)), false);
  await assertSourceUnchanged(c, sourceBefore, "file changed between the steps");
});

test("a new non-ignored file between prepareRestore and applyRestore -> restore_state_changed", async () => {
  const c = await setupWorkspace(TMP, "between-added", SMALL);
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  write(ws.repo, "a.txt", "a changed by the agent\n");
  const prepared = await prepareRestore(ws, baselineTarget(ws), ws.baseline);
  write(ws.repo, "dir with space/new ü.txt", "new after prepareRestore\n");

  const before = copyState(ws.repo);
  await assert.rejects(applyRestore(ws, prepared), code("restore_state_changed"));
  assert.deepEqual(copyState(ws.repo), before, "nothing was written");
  assert.equal(read(ws, "dir with space/new ü.txt"), "new after prepareRestore\n");
  assert.equal(await readIncompleteRestore(ws), null);
  assert.equal(fs.existsSync(intentPath(ws)), false);
  await assertSourceUnchanged(c, sourceBefore, "file added between the steps");
});

test("a new IGNORED file between prepareRestore and applyRestore: the restore goes through and keeps it", async () => {
  const c = await setupWorkspace(TMP, "between-ignored", SMALL);
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  write(ws.repo, "a.txt", "a changed by the agent\n");
  const prepared = await prepareRestore(ws, baselineTarget(ws), ws.baseline);
  write(ws.repo, "build/gen ü.out", "ignored, outside the snapshot\n");

  assert.deepEqual(await applyRestore(ws, prepared), { status: "restored" });
  assert.deepEqual(readTree(ws.repo), {
    ...readCommitTree(c.tmp, ws.control, ws.baseline.commit),
    "build/gen ü.out": "ignored, outside the snapshot\n"
  }, "target tree plus the ignored file");
  assert.equal(await readIncompleteRestore(ws), null);
  assert.equal(fs.existsSync(intentPath(ws)), false, "a confirmed restore removes the intent file");
  await assertSourceUnchanged(c, sourceBefore, "ignored file added between the steps");
});

test("confirmed restore: { status: \"restored\" }, copy tree = target tree, no intent file left", async () => {
  const c = await setupWorkspace(TMP, "confirmed", SMALL);
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  write(ws.repo, "a.txt", "a changed by the agent\n");
  fs.rmSync(path.join(ws.repo, "b.txt"));
  write(ws.repo, "new ü file.txt", "added by the agent\n");
  write(ws.repo, "dir with space/файл ü.txt", "u changed by the agent\n");
  write(ws.repo, "build/keep ü.out", "ignored\n");

  const prepared = await prepareRestore(ws, baselineTarget(ws), ws.baseline);
  assert.equal(await readIncompleteRestore(ws), null, "prepareRestore alone writes no intent");
  assert.deepEqual(await applyRestore(ws, prepared), { status: "restored" });

  const target = readCommitTree(c.tmp, ws.control, ws.baseline.commit);
  assert.deepEqual(readTree(ws.repo), { ...target, "build/keep ü.out": "ignored\n" }, "copy = target (ignored files stay)");
  assert.equal(await readIncompleteRestore(ws), null);
  assert.equal(fs.existsSync(intentPath(ws)), false);
  await assertSourceUnchanged(c, sourceBefore, "confirmed restore");

  // Restoring the same target again is a no-op that still confirms.
  const again = await prepareRestore(ws, baselineTarget(ws), ws.baseline);
  assert.deepEqual(await applyRestore(ws, again), { status: "restored" });
  assert.deepEqual(readTree(ws.repo), { ...target, "build/keep ü.out": "ignored\n" });
});

// The confirmation looks only at what the restore had to do. The target does not have the agent's ignore rule, so
// after the restore the artefact it hid is a plain untracked file — outside both trees, and therefore not a miss.
test("an ignore rule the target does not have: the restore is confirmed and the ignored artefact stays", async () => {
  const c = await setupWorkspace(TMP, "ignore-rule-dropped", (dir) => {
    write(dir, "a.txt", "a v1\n");
    write(dir, ".gitignore", "build/\n"); // the baseline knows nothing about gen/
  });
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  write(ws.repo, ".gitignore", "build/\ngen/\n");
  write(ws.repo, "gen/out ü.txt", "generated, hidden by the agent's rule\n");

  const prepared = await prepareRestore(ws, baselineTarget(ws), ws.baseline);
  assert.equal(readCommitTree(c.tmp, ws.control, prepared.recoveryCommit)["gen/out ü.txt"], undefined, "ignored: outside the snapshot");
  assert.deepEqual(await applyRestore(ws, prepared), { status: "restored" });
  assert.deepEqual(readTree(ws.repo), {
    ...readCommitTree(c.tmp, ws.control, ws.baseline.commit),
    "gen/out ü.txt": "generated, hidden by the agent's rule\n"
  }, "the target tree, with the artefact the restore had to leave alone");
  assert.equal(await readIncompleteRestore(ws), null);
  assert.equal(fs.existsSync(intentPath(ws)), false, "the run is not blocked");
  assert.ok(await createSnapshot(ws, "intermediate", ws.baseline), "and the next operation goes through");
  await assertSourceUnchanged(c, sourceBefore, "ignore rule dropped by the target");
});

// The post-write confirmation itself: a target tree whose two paths differ only in case cannot exist in a work tree
// on a case-insensitive filesystem, while `read-tree -m -u` applies it with a warning and exit 0.
test("a target tree the filesystem cannot hold: read-tree succeeds, the result is restore_incomplete", { skip: !CASE_INSENSITIVE && "needs a case-insensitive filesystem" }, async () => {
  const c = await setupWorkspace(TMP, "impossible-target", SMALL);
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  const fromTree = await snapshotCopyTree(ws, ws.baseline.tree);
  const toTree = craftTree(c.tmp, ws, ws.baseline.tree, { "out.txt": "lower case\n", "OUT.txt": "UPPER CASE\n" });

  await assert.rejects(applyTreeToCopy(ws, fromTree, toTree), (e) => {
    code("restore_incomplete")(e);
    assert.equal(e.detail?.expected, toTree, "the detail names the target tree");
    return true;
  });
  assert.equal(fs.readdirSync(ws.repo).filter((n) => n.toLowerCase() === "out.txt").length, 1, "only one of the two paths exists");
  assert.ok(await readIncompleteRestore(ws), "the intent file stays: the copy is neither tree");
  await assert.rejects(createSnapshot(ws, "intermediate", ws.baseline), code("restore_incomplete"), "and blocks the run");
  await clearIncompleteRestore(ws);
  await assertSourceUnchanged(c, sourceBefore, "impossible target tree");
});

test("the base must be a consistent commit/tree pair; the journal's own pair passes", async () => {
  const c = await setupWorkspace(TMP, "base-consistent", SMALL);
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  write(ws.repo, "a.txt", "a changed by the agent\n");
  const cp = await createCheckpoint(ws, 1); // a second, different commit/tree pair to mix up
  assert.notEqual(cp.tree, ws.baseline.tree);

  const mixed = { commit: ws.baseline.commit, tree: cp.tree, parent: ws.baseline.parent };
  await assert.rejects(createSnapshot(ws, "recovery", mixed), code("invalid_input"), "base.tree is not the tree of base.commit");
  await assert.rejects(prepareRestore(ws, baselineTarget(ws), mixed), code("invalid_input"), "same for prepareRestore");
  await assert.rejects(createSnapshot(ws, "intermediate", { commit: ws.baseline.tree, tree: ws.baseline.tree, parent: null }),
    code("invalid_input"), "base.commit is a tree, not a commit");
  assert.deepEqual(canvasttyRefs(c.tmp, c.source, c.runId),
    [`${ws.baseline.commit} refs/canvastty/${c.runId}/baseline`, `${cp.commit} refs/canvastty/${c.runId}/stage-1`].sort(),
    "no recovery snapshot was published for a refused base");

  // The pairs that do come from the journal (baseline and the checkpoint) are accepted.
  assert.ok(await createSnapshot(ws, "intermediate", ws.baseline));
  const prepared = await prepareRestore(ws, { name: "stage-1", commit: cp.commit }, { commit: cp.commit, tree: cp.tree, parent: cp.parent });
  assert.deepEqual(await applyRestore(ws, prepared), { status: "restored" });
  await assertSourceUnchanged(c, sourceBefore, "base consistency");
});

test("the applicable base is mandatory: createSnapshot and prepareRestore without it are invalid_input", async () => {
  const c = await setupWorkspace(TMP, "base-required", SMALL);
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  write(ws.repo, "a.txt", "a changed by the agent\n");
  const before = copyState(ws.repo);

  await assert.rejects(createSnapshot(ws, "recovery", undefined), code("invalid_input"), "createSnapshot(recovery) without base");
  await assert.rejects(createSnapshot(ws, "intermediate", undefined), code("invalid_input"), "createSnapshot(intermediate) without base");
  await assert.rejects(prepareRestore(ws, baselineTarget(ws), undefined), code("invalid_input"), "prepareRestore without base");
  await assert.rejects(createSnapshot(ws, "recovery", { commit: ws.baseline.commit }), code("invalid_input"), "base without a tree");
  await assert.rejects(prepareRestore(ws, baselineTarget(ws), { tree: ws.baseline.tree }), code("invalid_input"), "base without a commit");

  assert.deepEqual(copyState(ws.repo), before, "a refused call does not touch the copy");
  assert.deepEqual(canvasttyRefs(c.tmp, c.source, c.runId), [`${ws.baseline.commit} refs/canvastty/${c.runId}/baseline`], "nothing published");
  await assertSourceUnchanged(c, sourceBefore, "missing base");
});

for (const stage of [1, 2]) {
  test(`probe 3: a file accepted in stage-${stage} keeps its content in the recovery snapshot after a new ignore rule`, async () => {
    const result = await probeAcceptedFile(TMP, { stage });
    checks(result);
    const { case: c, prepared, checkpoint } = result;
    const ws = c.ws;
    assert.equal(prepared.fromTree, (await readCommit(ws, prepared.recoveryCommit)).tree, "fromTree is the recovery commit's tree");
    assert.equal(prepared.toTree, checkpoint.tree);

    // Restoring to that checkpoint is confirmed and brings the accepted content back.
    assert.deepEqual(await applyRestore(ws, prepared), { status: "restored" });
    assert.equal(read(ws, "accepted.txt"), "accepted v1\n", "the accepted file is back at its checkpoint content");
    assert.deepEqual(readTree(ws.repo), readCommitTree(c.tmp, ws.control, checkpoint.commit), "copy = the checkpoint");
    assert.equal(fs.existsSync(intentPath(ws)), false);
  });
}

// The same accepted-then-ignored file, restored to a target that does not have it: it is in the recovery snapshot
// (thanks to the applicable base), so the restore may remove it from the copy and must still confirm.
test("restoring to the baseline removes a file accepted in stage-1 that a new rule ignores; the recovery snapshot keeps it", async () => {
  const c = await setupWorkspace(TMP, "accepted-dropped", (dir) => {
    write(dir, "a.txt", "a v1\n");
    write(dir, ".gitignore", "build/\n");
  });
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  write(ws.repo, "accepted.txt", "accepted v1\n");
  const cp = await createCheckpoint(ws, 1);
  write(ws.repo, ".gitignore", "build/\naccepted.txt\n");
  write(ws.repo, "accepted.txt", "accepted from disk\n");

  const base = { commit: cp.commit, tree: cp.tree, parent: cp.parent };
  const prepared = await prepareRestore(ws, baselineTarget(ws), base);
  assert.equal(readCommitTree(c.tmp, ws.control, prepared.recoveryCommit)["accepted.txt"], "accepted from disk\n");
  assert.deepEqual(await applyRestore(ws, prepared), { status: "restored" });
  assert.deepEqual(readTree(ws.repo), readCommitTree(c.tmp, ws.control, ws.baseline.commit), "copy = baseline");
  assert.equal(fs.existsSync(path.join(ws.repo, "accepted.txt")), false, "removed, and only recoverable from the snapshot");
  assert.equal(fs.existsSync(intentPath(ws)), false);
  await assertSourceUnchanged(c, sourceBefore, "accepted file dropped by the restore");
});

// Regression from the second external review: the check that dropped paths are gone treated a directory the target
// tree needs as a leftover. item (a file in the copy) must become item/ holding the target's own child.txt.
test("a file replaced by a directory the target tree needs: the restore is confirmed", async () => {
  const c = await setupWorkspace(TMP, "file-to-dir", (dir) => {
    write(dir, "item/child.txt", "child v1\n");
    write(dir, "item/nested/deep ü.txt", "deep v1\n");
    write(dir, "a.txt", "a v1\n");
    write(dir, ".gitignore", "build/\n");
  });
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  fs.rmSync(path.join(ws.repo, "item"), { recursive: true });
  write(ws.repo, "item", "the agent made it a plain file\n");
  write(ws.repo, "build/gen ü.out", "ignored artefact\n");

  const prepared = await prepareRestore(ws, baselineTarget(ws), ws.baseline);
  assert.deepEqual(await applyRestore(ws, prepared), { status: "restored" });
  assert.equal(read(ws, "item/child.txt"), "child v1\n");
  assert.equal(read(ws, "item/nested/deep ü.txt"), "deep v1\n");
  assert.ok(fs.lstatSync(path.join(ws.repo, "item")).isDirectory(), "item is a directory again");
  assert.equal(read(ws, "build/gen ü.out"), "ignored artefact\n", "ignored files are still left alone");
  assert.equal(await readIncompleteRestore(ws), null);
  assert.equal(fs.existsSync(intentPath(ws)), false);
  await createSnapshot(ws, "intermediate", ws.baseline); // the run is not blocked
  await assertSourceUnchanged(c, sourceBefore, "file replaced by a needed directory");
});

// The other direction: the copy holds a directory where the target has a plain file of that name.
test("a directory replaced by the target's plain file: the restore is confirmed", async () => {
  const c = await setupWorkspace(TMP, "dir-to-file", (dir) => {
    write(dir, "item", "item is a file in the baseline\n");
    write(dir, "a.txt", "a v1\n");
    write(dir, ".gitignore", "build/\n");
  });
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  fs.rmSync(path.join(ws.repo, "item"));
  write(ws.repo, "item/child.txt", "the agent made it a directory\n");

  const prepared = await prepareRestore(ws, baselineTarget(ws), ws.baseline);
  assert.deepEqual(await applyRestore(ws, prepared), { status: "restored" });
  assert.equal(read(ws, "item"), "item is a file in the baseline\n");
  assert.ok(fs.lstatSync(path.join(ws.repo, "item")).isFile(), "item is a plain file again");
  assert.deepEqual(readTree(ws.repo), readCommitTree(c.tmp, ws.control, ws.baseline.commit), "copy = baseline");
  assert.equal(fs.existsSync(intentPath(ws)), false);
  await assertSourceUnchanged(c, sourceBefore, "directory replaced by the target's file");
});

// The plain case the exception must not swallow: a file the target drops is simply removed from disk.
test("a file the target tree drops is removed and the restore is confirmed", async () => {
  const c = await setupWorkspace(TMP, "plain-drop", SMALL);
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  write(ws.repo, "added by the agent ü.txt", "extra\n");
  const cp = await createCheckpoint(ws, 1); // the extra file is accepted, so the baseline drops it again
  const base = { commit: cp.commit, tree: cp.tree, parent: cp.parent };

  const prepared = await prepareRestore(ws, baselineTarget(ws), base);
  assert.deepEqual(await applyRestore(ws, prepared), { status: "restored" });
  assert.equal(fs.existsSync(path.join(ws.repo, "added by the agent ü.txt")), false, "dropped from disk");
  assert.deepEqual(readTree(ws.repo), readCommitTree(c.tmp, ws.control, ws.baseline.commit), "copy = baseline");
  assert.equal(fs.existsSync(intentPath(ws)), false);
  await assertSourceUnchanged(c, sourceBefore, "plain drop");
});

// The dropped-path check must not be reachable by simply putting the file back: the pre-check sees the copy is no
// longer the tree the restore was prepared from and refuses before any write. Its own branch (read-tree reports
// success yet leaves a dropped path on disk) has no deterministic repro here and stays defense in depth — see
// stage-3-review-fixes.md. What is tested is that putting the file back is caught, and caught before a write.
test("a dropped file put back before the restore is refused before any write", async () => {
  const c = await setupWorkspace(TMP, "leftover-drop", SMALL);
  const ws = c.ws;
  const sourceBefore = fingerprint(c.tmp, c.source);
  write(ws.repo, "leftover ü.txt", "extra\n");
  const cp = await createCheckpoint(ws, 1);
  const fromTree = cp.tree;                 // holds leftover ü.txt
  const toTree = ws.baseline.tree;          // drops it
  fs.rmSync(path.join(ws.repo, "leftover ü.txt"));
  write(ws.repo, "leftover ü.txt", "put back behind the restore's back\n");
  const before = copyState(ws.repo);

  await assert.rejects(applyTreeToCopy(ws, fromTree, toTree), code("restore_state_changed"));
  assert.deepEqual(copyState(ws.repo), before, "refused before the first write");
  assert.equal(await readIncompleteRestore(ws), null, "no intent file: nothing was written");
  await createSnapshot(ws, "intermediate", ws.baseline); // the run is not blocked
  await assertSourceUnchanged(c, sourceBefore, "dropped file put back");
});

// The exception is narrow: it accepts a directory only when the target's own files live in it. A directory left where
// the target wants nothing is still a leftover. Checked on the check itself, since the pre-check guards the path above.
test("the dropped-path exception covers only directories the target tree needs", async () => {
  const c = await setupWorkspace(TMP, "needed-dirs-only", (dir) => {
    write(dir, "item/child.txt", "child v1\n");
    write(dir, "gone/old ü.txt", "old v1\n");
    write(dir, ".gitignore", "build/\n");
  });
  const ws = c.ws;
  // stage-1 keeps item/, drops gone/: restoring the baseline recreates gone/old ü.txt, restoring stage-1 removes it
  fs.rmSync(path.join(ws.repo, "gone"), { recursive: true });
  const cp = await createCheckpoint(ws, 1);
  const base = { commit: cp.commit, tree: cp.tree, parent: cp.parent };

  const toBaseline = await prepareRestore(ws, baselineTarget(ws), base);
  assert.deepEqual(await applyRestore(ws, toBaseline), { status: "restored" });
  assert.equal(read(ws, "gone/old ü.txt"), "old v1\n", "the directory the target needs is back with its file");

  const toStage = await prepareRestore(ws, { name: "stage-1", commit: cp.commit }, ws.baseline);
  assert.deepEqual(await applyRestore(ws, toStage), { status: "restored" });
  assert.equal(fs.existsSync(path.join(ws.repo, "gone", "old ü.txt")), false, "the dropped file is gone from disk");
  assert.equal(fs.existsSync(intentPath(ws)), false, "an empty directory Git leaves behind is not a leftover file");
});
