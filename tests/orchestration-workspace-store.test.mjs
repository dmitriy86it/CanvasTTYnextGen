// How the future service orders Git results and journal events for the workspace (stage-3-contract.md):
// the create-only ref first, then the Store event. A ref without its event is never taken as an accepted stage and
// never deleted; an interrupted restore stays visible as pendingRestore; nothing restarts an agent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { applyRestore, createCheckpoint, inspectWorkspaceRefs, prepareRestore } from "../src/main/services/orchestration/snapshots.ts";
import { createRun, openRun, readRun } from "../src/main/services/orchestration/store.ts";
import { createWorkspace, openWorkspace } from "../src/main/services/orchestration/workspace.ts";

const GIT = findGit(process.env);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-ws-store-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GITCONFIG = path.join(TMP, "test-gitconfig");
fs.writeFileSync(GITCONFIG, "");
function g(cwd, ...args) {
  return execFileSync(GIT, args, {
    cwd,
    env: {
      PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t"
    },
    encoding: "utf8"
  }).trim();
}
const code = (c) => (e) => e?.code === c;
const journalBytes = (root, runId) => fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"));

let n = 0;
// Service step 1: run, workspace, then the journal event for the confirmed baseline.
async function start({ io } = {}) {
  const root = path.join(TMP, `root-${++n}`);
  const src = path.join(TMP, `src-${n}`);
  fs.mkdirSync(src, { recursive: true });
  g(src, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "a.txt"), "one\n");
  g(src, "add", "a.txt");
  g(src, "commit", "-q", "-m", "init");
  const runId = randomUUID();
  const writer = await createRun(root, runId, { goal: "workspace journal", io });
  const ws = await createWorkspace({ root, runId, source: src, gitPath: GIT });
  await writer.recordWorkspaceCreated({
    sourcePathSha256: createHash("sha256").update(ws.sourcePath).digest("hex"),
    baseline: { commit: ws.baseline.commit, tree: ws.baseline.tree },
    head: ws.head
  });
  return { root, src, runId, writer, ws };
}

test("checkpoint is accepted only through its journal event", async () => {
  const { root, runId, writer, ws } = await start();
  fs.writeFileSync(path.join(ws.repo, "a.txt"), "two\n");
  const c1 = await createCheckpoint(ws, 1);
  await writer.recordCheckpoint({ stage: 1, commit: c1.commit, tree: c1.tree, parent: c1.parent });
  await writer.close();
  const { state } = await readRun(root, runId);
  assert.deepEqual(state.workspace.checkpoints["1"], { commit: c1.commit, tree: c1.tree, parent: c1.parent });
  assert.deepEqual((await inspectWorkspaceRefs(ws, state.workspace)).unjournaled, []);
});

test("crash between the ref and the event: not accepted after reopen, the ref is kept, the repeat is idempotent", async () => {
  const { root, runId, writer, ws, src } = await start();
  fs.writeFileSync(path.join(ws.repo, "a.txt"), "two\n");
  const c1 = await createCheckpoint(ws, 1);
  await writer.close(); // the service died before recordCheckpoint

  const reopened = await openRun(root, runId);
  assert.deepEqual(reopened.state().workspace.checkpoints, {}, "the stage is not accepted");
  const ws2 = await openWorkspace({ root, runId, gitPath: GIT });
  assert.deepEqual((await inspectWorkspaceRefs(ws2, reopened.state().workspace)).unjournaled, [{ name: "stage-1", commit: c1.commit }]);
  assert.equal(g(src, "rev-parse", `refs/canvastty/${runId}/stage-1`), c1.commit, "the found snapshot is not deleted");

  const again = await createCheckpoint(ws2, 1); // same tree: the same result, then the event
  assert.equal(again.commit, c1.commit);
  assert.equal(again.reused, true);
  await reopened.recordCheckpoint({ stage: 1, commit: again.commit, tree: again.tree, parent: again.parent });
  assert.deepEqual((await inspectWorkspaceRefs(ws2, reopened.state().workspace)).unjournaled, []);
  await reopened.close();
});

test("journal write failure after the ref: write_failed, poisoned; after reopen not accepted, ref kept", async () => {
  let armed = false;
  const io = { write: async (fh, buf) => { if (armed) throw new Error("injected journal failure"); return fh.write(buf, 0, buf.length); } };
  const { root, runId, writer, ws, src } = await start({ io });
  fs.writeFileSync(path.join(ws.repo, "a.txt"), "two\n");
  const c1 = await createCheckpoint(ws, 1);
  armed = true;
  await assert.rejects(writer.recordCheckpoint({ stage: 1, commit: c1.commit, tree: c1.tree, parent: c1.parent }), code("write_failed"));
  await writer.close();
  const { state } = await readRun(root, runId);
  assert.deepEqual(state.workspace.checkpoints, {});
  assert.equal(g(src, "rev-parse", `refs/canvastty/${runId}/stage-1`), c1.commit);
});

test("a Git error leaves the journal unchanged", async () => {
  const { root, runId, writer, ws } = await start();
  const before = journalBytes(root, runId);
  fs.appendFileSync(path.join(ws.control, "config"), "\n[core]\n\tfsmonitor = /bin/echo\n"); // tampered control.git
  await assert.rejects(createCheckpoint(ws, 1), code("workspace_tampered"));
  assert.deepEqual(journalBytes(root, runId), before);
  await writer.close();
});

test("interrupted restore: pendingRestore after reopen, no automatic restore or agent start; finished explicitly", async () => {
  const { root, runId, writer, ws } = await start();
  fs.writeFileSync(path.join(ws.repo, "a.txt"), "agent edit\n");
  const prepared = await prepareRestore(ws, { name: "baseline", commit: ws.baseline.commit }, { commit: ws.baseline.commit, tree: ws.baseline.tree, parent: null });
  await writer.recordSnapshot({ kind: "recovery", ref: prepared.recovery.ref, commit: prepared.recovery.commit, tree: prepared.recovery.tree });
  const restore = { target: prepared.target, targetCommit: prepared.targetCommit, recoveryCommit: prepared.recoveryCommit };
  await writer.recordRestoreStarted(restore);
  await writer.close(); // crash before the copy changed

  const reopened = await openRun(root, runId);
  assert.deepEqual(reopened.state().workspace.pendingRestore, restore);
  assert.equal(fs.readFileSync(path.join(ws.repo, "a.txt"), "utf8"), "agent edit\n", "reopening did not restore anything");
  assert.equal(Object.keys(reopened.state().turns).length, 0, "no turn was started");

  await applyRestore(ws, prepared); // the service decides to finish it explicitly
  await reopened.recordRestored(restore);
  assert.equal(reopened.state().workspace.pendingRestore, null);
  assert.deepEqual(reopened.state().workspace.lastRestore, restore);
  assert.equal(fs.readFileSync(path.join(ws.repo, "a.txt"), "utf8"), "one\n");
  await reopened.close();
});

// The applicable base of the copy (stage-3-review-fixes.md): baseline, then confirmed checkpoints and restores only.
test("current base moves only on confirmed events; a checkpoint is refused while a restore is unfinished", async () => {
  const { root, runId, writer, ws } = await start();
  assert.deepEqual(writer.state().workspace.current, ws.baseline && { commit: ws.baseline.commit, tree: ws.baseline.tree });

  fs.writeFileSync(path.join(ws.repo, "a.txt"), "stage one\n");
  const c1 = await createCheckpoint(ws, 1);
  await writer.recordCheckpoint({ stage: 1, commit: c1.commit, tree: c1.tree, parent: c1.parent });
  assert.deepEqual(writer.state().workspace.current, { commit: c1.commit, tree: c1.tree }, "a confirmed checkpoint becomes the base");

  // a restore of the copy to the baseline: while it is unfinished no stage can be accepted from the copy
  const prepared = await prepareRestore(ws, { name: "baseline", commit: ws.baseline.commit }, { commit: c1.commit, tree: c1.tree, parent: c1.parent });
  await writer.recordSnapshot({ kind: "recovery", ref: prepared.recovery.ref, commit: prepared.recovery.commit, tree: prepared.recovery.tree });
  const restore = { target: prepared.target, targetCommit: prepared.targetCommit, recoveryCommit: prepared.recoveryCommit };
  await writer.recordRestoreStarted(restore);
  const before = journalBytes(root, runId);
  await assert.rejects(writer.recordCheckpoint({ stage: 2, commit: c1.commit, tree: c1.tree, parent: c1.commit }), code("invalid_input"));
  assert.deepEqual(journalBytes(root, runId), before);
  assert.deepEqual(writer.state().workspace.current, { commit: c1.commit, tree: c1.tree }, "the base does not move on an unfinished restore");

  await applyRestore(ws, prepared);
  await writer.recordRestored(restore);
  assert.deepEqual(writer.state().workspace.current, { commit: ws.baseline.commit, tree: ws.baseline.tree }, "the confirmed target is the new base");
  await writer.close();
});

// A restore that started writing and failed: partial or unknown. The recovery snapshot and pendingRestore stay,
// nothing is accepted, nothing is rolled back automatically, and only an explicit new attempt may follow.
test("restore_failed keeps the restore pending, blocks checkpoints and allows an explicit new attempt", async () => {
  const { root, runId, writer, ws } = await start();
  fs.writeFileSync(path.join(ws.repo, "a.txt"), "agent edit\n");
  const base = { commit: ws.baseline.commit, tree: ws.baseline.tree, parent: null };
  const first = await prepareRestore(ws, { name: "baseline", commit: ws.baseline.commit }, base);
  await writer.recordSnapshot({ kind: "recovery", ref: first.recovery.ref, commit: first.recovery.commit, tree: first.recovery.tree });
  const restore = { target: first.target, targetCommit: first.targetCommit, recoveryCommit: first.recoveryCommit };
  await writer.recordRestoreStarted(restore);
  await writer.recordRestoreFailed({ ...restore, result: "partial" });

  let state = writer.state().workspace;
  assert.deepEqual(state.pendingRestore, restore, "still unfinished");
  assert.deepEqual(state.failedRestore, { ...restore, result: "partial" });
  assert.equal(state.lastRestore, null);
  const before = journalBytes(root, runId);
  await assert.rejects(writer.recordCheckpoint({ stage: 1, commit: first.recovery.commit, tree: first.recovery.tree, parent: ws.baseline.commit }), code("invalid_input"));
  await assert.rejects(writer.recordRestored(restore), code("invalid_input"), "a failed attempt is not a restore");
  assert.deepEqual(journalBytes(root, runId), before);

  await writer.close();
  const reopened = await openRun(root, runId); // a crash changes nothing: the attempt stays failed and pending
  state = reopened.state().workspace;
  assert.deepEqual([state.pendingRestore, state.failedRestore.result], [restore, "partial"]);

  // an explicit new attempt: a fresh recovery snapshot of the partial copy, then the same restore, confirmed
  const retry = await prepareRestore(ws, { name: "baseline", commit: ws.baseline.commit }, base);
  await reopened.recordSnapshot({ kind: "recovery", ref: retry.recovery.ref, commit: retry.recovery.commit, tree: retry.recovery.tree });
  const second = { target: retry.target, targetCommit: retry.targetCommit, recoveryCommit: retry.recoveryCommit };
  await reopened.recordRestoreStarted(second);
  assert.equal(reopened.state().workspace.failedRestore, null, "the new attempt replaces the failed one");
  await applyRestore(ws, retry);
  await reopened.recordRestored(second);
  state = reopened.state().workspace;
  assert.deepEqual([state.pendingRestore, state.failedRestore, state.lastRestore], [null, null, second]);
  assert.equal(fs.readFileSync(path.join(ws.repo, "a.txt"), "utf8"), "one\n");
  await reopened.close();
});

test("the journal refuses workspace events that contradict it", async () => {
  const { root, runId, writer, ws } = await start();
  const before = journalBytes(root, runId);
  const fake = "a".repeat(40);
  await assert.rejects(writer.recordCheckpoint({ stage: 2, commit: fake, tree: fake, parent: ws.baseline.commit }), code("invalid_input"), "out of order");
  await assert.rejects(writer.recordCheckpoint({ stage: 1, commit: fake, tree: fake, parent: fake }), code("invalid_input"), "wrong parent");
  await assert.rejects(writer.recordRestoreStarted({ target: "baseline", targetCommit: ws.baseline.commit, recoveryCommit: fake }), code("invalid_input"), "no recovery snapshot");
  await assert.rejects(writer.recordRestored({ target: "baseline", targetCommit: ws.baseline.commit, recoveryCommit: fake }), code("invalid_input"), "no restore started");
  await assert.rejects(writer.recordRestoreFailed({ target: "baseline", targetCommit: ws.baseline.commit, recoveryCommit: fake, result: "partial" }), code("invalid_input"), "no restore started");
  await assert.rejects(writer.recordRestoreFailed({ target: "baseline", targetCommit: ws.baseline.commit, recoveryCommit: fake, result: "maybe" }), code("invalid_input"), "unknown result value");
  await assert.rejects(writer.recordWorkspaceCreated({ sourcePathSha256: "b".repeat(64), baseline: { commit: fake, tree: fake }, head: null }), code("invalid_input"), "created twice");
  await assert.rejects(writer.recordSnapshot({ kind: "recovery", ref: "refs/heads/main", commit: fake, tree: fake }), code("invalid_input"), "not a canvastty ref");
  assert.deepEqual(journalBytes(root, runId), before);
  await writer.close();
});
