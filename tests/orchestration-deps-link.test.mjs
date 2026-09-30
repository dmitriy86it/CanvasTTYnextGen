// The node_modules symlink the orchestrator makes in the copy for checks (stage-4-contract.md §«Зависимости»,
// stage-3-contract.md §«Служебная ссылка») is not part of the project: snapshots, checkpoints and restores leave it out,
// with or without a `node_modules/` ignore rule. Ownership is verifiable: a replaced or re-pointed link is the project's
// like any other file and the dependencies are refused; a node_modules the project itself has is never left out,
// replaced or removed. The source repository and the user's branch never change.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { checkPreparedDeps, createRegistry } from "../src/main/services/orchestration/checks.ts";
import { inspectPreparedDeps, runProjectCheck } from "../src/main/services/orchestration/checkService.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { applyRestore, createCheckpoint, prepareRestore } from "../src/main/services/orchestration/snapshots.ts";
import { createRun } from "../src/main/services/orchestration/store.ts";
import { createWorkspace, snapshotCopyTree } from "../src/main/services/orchestration/workspace.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "orchestration", "check-project");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const SKIP = { skip: process.platform !== "darwin" && "checks run only in the macOS sandbox" };

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-depslink-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "");
const g = (cwd, ...args) => execFileSync(GIT, args, {
  cwd, encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
}).trim();
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

let n = 0;
// The check-project fixture as a source repository. ignore: its .gitignore; depsInside: the prepared node_modules is the
// source's own ignored directory (else a directory outside the source); extra(src) runs before the commit.
async function setup({ ignore = "node_modules/\nout/\n", depsInside = true, extra } = {}) {
  const root = path.join(TMP, `root-${++n}`);
  const src = path.join(TMP, `src-${n}`);
  fs.cpSync(FIXTURE, src, { recursive: true });
  fs.writeFileSync(path.join(src, ".gitignore"), ignore);
  const nm = depsInside ? path.join(src, "node_modules") : path.join(TMP, `deps-${n}`, "node_modules");
  fs.mkdirSync(path.join(nm, "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(nm, "left-pad", "index.mjs"), "export default (s) => ` ${s}`;\n");
  extra?.(src);
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fixture project");
  const runId = randomUUID();
  const writer = await createRun(root, runId, { goal: "deps link" });
  const ws = await createWorkspace({ root, runId, source: src, gitPath: GIT });
  await writer.recordWorkspaceCreated({
    sourcePathSha256: sha(ws.sourcePath), baseline: { commit: ws.baseline.commit, tree: ws.baseline.tree }, head: ws.head
  });
  const deps = checkPreparedDeps({
    lockfileRelPath: "package-lock.json", lockfileSha256: sha(fs.readFileSync(path.join(src, "package-lock.json"))), nodeModulesPath: nm
  });
  return { root, src, runId, writer, ws, deps, main: g(src, "rev-parse", "main"), status: g(src, "status", "--porcelain") };
}
const link = (c) => path.join(c.ws.repo, "node_modules");
const identity = (p) => { const st = fs.lstatSync(p, { bigint: true }); return `${st.ino}:${st.birthtimeNs}`; };
const lsTree = (c, rev) => g(c.src, "ls-tree", "--name-only", rev).split("\n");
const sourceUnchanged = (c) => {
  assert.equal(g(c.src, "rev-parse", "main"), c.main, "the user's branch did not move");
  assert.equal(g(c.src, "status", "--porcelain"), c.status, "the source working tree is untouched");
};

// The service's link, a new file, a checkpoint: the checkpoint holds the file and nothing of the link.
async function linkThenCheckpoint(c) {
  const d = await inspectPreparedDeps(c.ws, c.deps);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.ok(fs.lstatSync(link(c)).isSymbolicLink());
  assert.equal(await snapshotCopyTree(c.ws, c.ws.baseline.tree), c.ws.baseline.tree, "the link alone changes nothing");
  fs.writeFileSync(path.join(c.ws.repo, "src", "extra.mjs"), "export const extra = 1;\n");
  const cp = await createCheckpoint(c.ws, 1);
  assert.deepEqual(g(c.src, "diff", "--name-only", c.ws.baseline.commit, cp.commit).split("\n"), ["src/extra.mjs"]);
  assert.ok(!lsTree(c, cp.commit).includes("node_modules"), "no node_modules entry in the checkpoint");
  assert.ok(fs.lstatSync(link(c)).isSymbolicLink(), "the link stays in the copy");
  sourceUnchanged(c);
  return cp;
}

test("the service's link is left out of snapshots and the checkpoint with a `node_modules/` rule", async () => {
  const c = await setup();
  await linkThenCheckpoint(c);
  await c.writer.close();
});

test("the service's link is left out with no node_modules rule at all (dependencies outside the source)", async () => {
  const c = await setup({ ignore: "out/\n", depsInside: false });
  await linkThenCheckpoint(c);
  await c.writer.close();
});

test("a replaced link (same target, new link) is not the service's: dependencies refused, the link counts and stays", async () => {
  const c = await setup();
  assert.equal((await inspectPreparedDeps(c.ws, c.deps)).ok, true);
  const target = fs.readlinkSync(link(c));
  fs.unlinkSync(link(c));
  fs.symlinkSync(target, link(c));
  const replaced = identity(link(c));
  const d = await inspectPreparedDeps(c.ws, c.deps);
  assert.equal(d.ok, false);
  assert.match(JSON.stringify(d.detail), /not the link the orchestrator made/);
  assert.equal(identity(link(c)), replaced, "left as it is");
  const tree = await snapshotCopyTree(c.ws, c.ws.baseline.tree);
  assert.notEqual(tree, c.ws.baseline.tree, "the foreign link is part of the tree");
  sourceUnchanged(c);
  await c.writer.close();
});

test("a re-pointed link is refused and counts as a change", async () => {
  const c = await setup();
  assert.equal((await inspectPreparedDeps(c.ws, c.deps)).ok, true);
  const elsewhere = path.join(TMP, `elsewhere-${n}`);
  fs.mkdirSync(elsewhere);
  fs.unlinkSync(link(c));
  fs.symlinkSync(elsewhere, link(c));
  const d = await inspectPreparedDeps(c.ws, c.deps);
  assert.equal(d.ok, false);
  assert.equal(fs.readlinkSync(link(c)), elsewhere);
  assert.notEqual(await snapshotCopyTree(c.ws, c.ws.baseline.tree), c.ws.baseline.tree);
  await c.writer.close();
});

test("the project's own tracked node_modules link is never left out, replaced or removed", async () => {
  const c = await setup({ depsInside: false, extra: (src) => fs.symlinkSync("vendor", path.join(src, "node_modules")) });
  assert.ok(lsTree(c, "main").includes("node_modules"), "the project tracks it");
  const d = await inspectPreparedDeps(c.ws, c.deps);
  assert.equal(d.ok, false, "not the prepared dependencies");
  assert.equal(fs.readlinkSync(link(c)), "vendor", "left as it is");
  assert.equal(await snapshotCopyTree(c.ws, c.ws.baseline.tree), c.ws.baseline.tree, "still part of the tree");
  fs.writeFileSync(path.join(c.ws.repo, "src", "extra.mjs"), "export const extra = 1;\n");
  const cp = await createCheckpoint(c.ws, 1);
  assert.ok(lsTree(c, cp.commit).includes("node_modules"), "the project's entry stays in the checkpoint");
  sourceUnchanged(c);
  await c.writer.close();
});

test("check, checkpoint, restore to the baseline, check again: the same link, the baseline tree, passed", SKIP, async () => {
  const c = await setup();
  const registry = createRegistry([{ id: "unit", title: "unit", executable: NODE, argv: ["--test", "tests/sum.test.mjs"], timeoutMs: 60_000, maxOutputBytes: 8192 }]);
  const check = () => runProjectCheck({ ws: c.ws, registry, id: "unit", deps: c.deps, writer: c.writer, launch: LAUNCH, state: c.writer.state() });
  const first = await check();
  assert.deepEqual([first.status, first.reason], ["passed", null]);
  assert.equal(first.copy.treeBefore, c.ws.baseline.tree, "the checked tree is the baseline: the link is not in it");
  const made = identity(link(c));
  const cp = await linkThenCheckpoint(c);
  const prepared = await prepareRestore(c.ws, { name: "baseline", commit: c.ws.baseline.commit }, { commit: cp.commit, tree: cp.tree, parent: cp.parent });
  assert.equal(prepared.fromTree, cp.tree, "the recovery snapshot is the checkpoint's tree");
  await applyRestore(c.ws, prepared);
  assert.ok(!fs.existsSync(path.join(c.ws.repo, "src", "extra.mjs")), "restored");
  assert.equal(identity(link(c)), made, "the restore neither removed nor re-made the link");
  const second = await check();
  assert.deepEqual([second.status, second.reason], ["passed", null], JSON.stringify(second.detail));
  assert.equal(second.copy.treeBefore, c.ws.baseline.tree);
  assert.equal(second.copy.treeAfter, c.ws.baseline.tree);
  sourceUnchanged(c);
  await c.writer.close();
});
