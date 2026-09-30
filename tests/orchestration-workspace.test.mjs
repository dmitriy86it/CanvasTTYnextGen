// Р3 workspace (stage-3-contract.md): source validation, baseline, the managed copy and control.git, the snapshot and
// restore primitives, tamper detection and the command vectors Git must never execute. Only temporary repositories
// whose paths contain a space and non-ASCII characters; the source repository must stay byte-for-byte the same
// except for refs/canvastty/<runId>/* and objects.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { GitError, HARDENED_CONFIG, findGit, git as runGit } from "../src/main/services/orchestration/git.ts";
import {
  WorkspaceError,
  applyTreeToCopy,
  commitSnapshot,
  createWorkspace,
  listSourceRefs,
  openWorkspace,
  publishRef,
  readCommit,
  readSourceRef,
  setControlRef,
  snapshotCopyTree,
  verifyWorkspace
} from "../src/main/services/orchestration/workspace.ts";
import {
  FILES,
  Markers,
  armGitDir,
  commitAll,
  fingerprint,
  git,
  initRepo,
  makeRichRepo,
  readCommitTree,
  readTree,
  refs,
  write
} from "./fixtures/orchestration/git-fixtures.mjs";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty ws тест-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const GIT = findGit(process.env);
const ROOT = path.join(TMP, "root ü данные");
fs.mkdirSync(path.join(ROOT, "runs"), { recursive: true });

const code = (c) => (e) => {
  assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.stack ?? e}`);
  return true;
};
const without = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const wsDir = (runId) => path.join(ROOT, "runs", runId, "workspace");

function newRun() {
  const runId = randomUUID();
  fs.mkdirSync(path.join(ROOT, "runs", runId));
  return runId;
}

let sourceN = 0;
const sourcePath = (label) => path.join(TMP, `src ${++sourceN} проект ${label}`);

// A small committed source with an ignore rule, shared by the tests that only need "some" workspace.
function smallSource() {
  const dir = initRepo(TMP, sourcePath("small"));
  write(dir, "a.txt", "a v1\n");
  write(dir, "b.txt", "b v1\n");
  write(dir, "sub dir/c ü.txt", "c v1\n");
  write(dir, ".gitignore", "build/\n");
  commitAll(TMP, dir, "initial");
  return dir;
}
let shared = null;
const sharedSource = () => (shared ??= smallSource());

async function freshWorkspace(source = sharedSource()) {
  const runId = newRun();
  return createWorkspace({ root: ROOT, runId, source, gitPath: GIT });
}

// Only refs/canvastty/<runId>/* may be added; everything else in the source stays identical.
function assertSourceUnchanged(source, before, label) {
  const now = fingerprint(TMP, source);
  assert.deepEqual(now, before, `${label}: source repository changed`);
}

test("git is available for the workspace tests", () => {
  assert.ok(GIT && path.isAbsolute(GIT), `findGit returned ${GIT}`);
});

test("git.ts: environment from scratch, hardened flags, no discovery, error codes", async () => {
  const home = path.join(TMP, "git home пусто");
  fs.mkdirSync(home);
  const bin = path.join(TMP, "git probes ü");
  fs.mkdirSync(bin);
  const probe = (name, body) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };
  const dump = path.join(bin, "env dump");
  const envProbe = probe("env-git", `env > '${dump}'; printf '%s\\n' "$@" > '${dump}.args'`);
  process.env.CANVASTTY_TEST_LEAK = "1";
  try {
    await runGit({ gitPath: envProbe, gitDir: home, home }, ["status"], { identity: true });
  } finally { delete process.env.CANVASTTY_TEST_LEAK; }
  const env = Object.fromEntries(fs.readFileSync(dump, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.equal(env.CANVASTTY_TEST_LEAK, undefined, "parent environment not inherited");
  assert.equal(env.HOME, home);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_DIR, home);
  assert.equal(env.PATH, `${bin}:/usr/bin:/bin`);
  assert.equal(env.GIT_AUTHOR_EMAIL, "canvastty@localhost");
  const args = fs.readFileSync(`${dump}.args`, "utf8").trim().split("\n");
  assert.deepEqual(args, [...HARDENED_CONFIG.flatMap((kv) => ["-c", kv]), "status"]);
  for (const kv of ["core.hooksPath=/dev/null", "core.fsmonitor=false", "diff.external=", "core.alternateRefsCommand="]) assert.ok(HARDENED_CONFIG.includes(kv), kv);

  const userHome = path.join(TMP, "git user home");
  await runGit({ gitPath: envProbe, gitDir: home, home, userHome }, ["ls-files"], { useUserGlobalConfig: true });
  const env2 = fs.readFileSync(dump, "utf8");
  assert.match(env2, new RegExp(`^HOME=${userHome}$`, "m"));
  assert.doesNotMatch(env2, /^GIT_CONFIG_GLOBAL=/m, "the exception reads the user's global config");
  await runGit({ gitPath: envProbe, gitDir: home, home, userHome }, ["status"]);
  assert.match(fs.readFileSync(dump, "utf8"), /^GIT_CONFIG_GLOBAL=\/dev\/null$/m, "userHome alone does not enable the exception");

  // No discovery: gitDir is not a repository while the work tree lies inside one.
  const repo = smallSource();
  await assert.rejects(runGit({ gitPath: GIT, gitDir: home, workTree: repo, home }, ["rev-parse", "HEAD"]), code("git_failed"));
  const failed = await runGit({ gitPath: GIT, gitDir: path.join(repo, ".git"), home }, ["rev-parse", "--verify", "no-such-ref"]).catch((e) => e);
  assert.ok(failed instanceof GitError && failed.code === "git_failed" && failed.exitCode !== 0 && failed.stderr.length > 0);
  await assert.rejects(runGit({ gitPath: path.join(bin, "missing"), gitDir: home, home }, ["status"]), code("git_spawn"));
  await assert.rejects(runGit({ gitPath: "git", gitDir: home, home }, ["status"]), code("git_spawn"));
  await assert.rejects(runGit({ gitPath: probe("slow-git", "exec sleep 5"), gitDir: home, home }, ["status"], { timeoutMs: 200 }), code("git_timeout"));
  await assert.rejects(runGit({ gitPath: GIT, gitDir: path.join(repo, ".git"), home }, ["cat-file", "-p", "HEAD"], { maxOutputBytes: 16 }), code("git_output_limit"));
});

test("modified source: baseline is the work tree, copy is detached on it, source keeps index/HEAD/refs/tree; no vector runs", async () => {
  const { dir: source, expected } = makeRichRepo(TMP, sourcePath("rich"));
  write(source, ".gitattributes", "*.txt filter=canvastty-x\n");
  git(TMP, source, ["add", ".gitattributes"]);
  expected[".gitattributes"] = "*.txt filter=canvastty-x\n";
  const markers = new Markers(path.join(TMP, "markers rich"));
  armGitDir(TMP, path.join(source, ".git"), markers, "source");
  // A user HOME whose global config ignores secret.env and points fsmonitor/hooks at markers.
  const userHome = path.join(TMP, "home пользователь");
  write(userHome, "global ignore", `${FILES.globalIgnored}\n`);
  write(userHome, ".gitconfig", [
    "[core]",
    `\texcludesFile = "${path.join(userHome, "global ignore")}"`,
    `\tfsmonitor = "${markers.script("home-fsmonitor")}"`,
    `\thooksPath = "${markers.hooks(path.join(TMP, "home hooks"))}"`,
    `\tpager = "${markers.script("home-pager")}"`,
    "[diff]",
    `\texternal = "${markers.script("home-diff-external")}"`,
    ""
  ].join("\n"));
  const headBefore = git(TMP, source, ["rev-parse", "HEAD"]);
  const before = fingerprint(TMP, source);
  const runId = newRun();

  const ws = await createWorkspace({ root: ROOT, runId, source, gitPath: GIT, userHome });

  assert.equal(ws.runId, runId);
  assert.equal(ws.head, headBefore);
  assert.equal(ws.baseline.parent, headBefore, "baseline parent is HEAD");
  assert.equal(ws.sourcePath, fs.realpathSync(source));
  assert.deepEqual(readCommitTree(TMP, path.join(source, ".git"), ws.baseline.commit), without(expected, FILES.globalIgnored),
    "baseline = work tree of tracked + non-ignored untracked; staged/partial take the work-tree version; deleted, ignored and globally ignored absent; symlink kept");
  assert.equal(git(TMP, source, ["rev-parse", `${ws.baseline.commit}^{tree}`]), ws.baseline.tree);
  assert.match(git(TMP, source, ["cat-file", "commit", ws.baseline.commit]), new RegExp(`CanvasTTY-Snapshot: ${runId}:baseline`));

  // Source: identical except the one baseline ref.
  assertSourceUnchanged(source, before, "after createWorkspace");
  assert.deepEqual(refs(TMP, source, "refs/canvastty/"), [`${ws.baseline.commit} refs/canvastty/${runId}/baseline`]);
  assert.equal(git(TMP, source, ["diff", "--cached", "--name-only", "HEAD"]).split("\n").sort().join(","), [".gitattributes", FILES.partial, FILES.staged].sort().join(","),
    "the source index still holds exactly the staged changes");

  // Copy: detached on baseline, files = baseline tree, owned marker.
  assert.equal(git(TMP, ws.repo, ["symbolic-ref", "-q", "HEAD"], { allowFail: true }), null, "copy HEAD is detached");
  assert.equal(git(TMP, ws.repo, ["rev-parse", "HEAD"]), ws.baseline.commit);
  assert.deepEqual(readTree(ws.repo), without(expected, FILES.globalIgnored), "copy files = baseline tree");
  assert.ok(fs.lstatSync(path.join(ws.repo, FILES.link)).isSymbolicLink());
  const marker = JSON.parse(fs.readFileSync(path.join(wsDir(runId), "workspace.json"), "utf8"));
  assert.equal(marker.v, 1);
  assert.equal(marker.runId, runId);
  assert.equal(marker.sourcePath, fs.realpathSync(source));
  assert.equal(marker.sourceGitDir, fs.realpathSync(path.join(source, ".git")));
  assert.deepEqual(await readCommit(ws, ws.baseline.commit), ws.baseline);

  // Without userHome the global ignore is not applied (documented): secret.env is in that baseline.
  const run2 = newRun();
  const ws2 = await createWorkspace({ root: ROOT, runId: run2, source, gitPath: GIT });
  assert.deepEqual(readCommitTree(TMP, path.join(source, ".git"), ws2.baseline.commit), expected, "without userHome secret.env is included");
  assertSourceUnchanged(source, before, "after the second run");
  assert.deepEqual(markers.fired(), [], "no hook, fsmonitor, filter, pager, diff driver or alternateRefsCommand from the source or user HOME ran");

  // Repeated create does not touch the existing workspace; openWorkspace reads it back.
  const markerBytes = fs.readFileSync(path.join(wsDir(runId), "workspace.json"));
  write(ws.repo, "agent work.txt", "agent\n");
  const copyBefore = readTree(ws.repo);
  await assert.rejects(createWorkspace({ root: ROOT, runId, source, gitPath: GIT, userHome }), code("workspace_exists"));
  assert.deepEqual(fs.readFileSync(path.join(wsDir(runId), "workspace.json")), markerBytes);
  assert.deepEqual(readTree(ws.repo), copyBefore, "copy not overwritten");
  const opened = await openWorkspace({ root: ROOT, runId, gitPath: GIT });
  assert.deepEqual(opened.baseline, ws.baseline);
  assert.equal(opened.head, ws.head);
  await verifyWorkspace(opened);
  assertSourceUnchanged(source, before, "after the refused re-create");
  assert.deepEqual(markers.fired(), []);
});

test("openWorkspace: foreign marker -> workspace_foreign, missing -> workspace_not_found; run and input checks", async () => {
  const ws = await freshWorkspace();
  const file = path.join(ws.dir, "workspace.json");
  const marker = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...marker, runId: randomUUID() }));
  await assert.rejects(openWorkspace({ root: ROOT, runId: ws.runId, gitPath: GIT }), code("workspace_foreign"));
  await assert.rejects(openWorkspace({ root: ROOT, runId: newRun(), gitPath: GIT }), code("workspace_not_found"));

  const source = sharedSource();
  const before = fingerprint(TMP, source);
  const missing = randomUUID();
  await assert.rejects(createWorkspace({ root: ROOT, runId: missing, source, gitPath: GIT }), code("run_not_found"));
  assert.equal(fs.existsSync(path.join(ROOT, "runs", missing)), false);
  await assert.rejects(createWorkspace({ root: ROOT, runId: "../escape", source, gitPath: GIT }), code("invalid_input"));
  assertSourceUnchanged(source, before, "refused inputs");
});

test("clean source: baseline tree is HEAD's tree, parent is HEAD, copy detached on it, source unchanged", async () => {
  const source = smallSource();
  const head = git(TMP, source, ["rev-parse", "HEAD"]);
  const before = fingerprint(TMP, source);
  const ws = await freshWorkspace(source);
  assert.equal(ws.head, head);
  assert.equal(ws.baseline.parent, head);
  assert.equal(ws.baseline.tree, git(TMP, source, ["rev-parse", "HEAD^{tree}"]), "clean work tree = HEAD tree");
  assert.equal(git(TMP, ws.repo, ["symbolic-ref", "-q", "HEAD"], { allowFail: true }), null, "copy HEAD is detached");
  assert.equal(git(TMP, ws.repo, ["rev-parse", "HEAD"]), ws.baseline.commit);
  assert.deepEqual(readTree(ws.repo), readTree(source));
  assertSourceUnchanged(source, before, "clean source");
  assert.deepEqual(refs(TMP, source, "refs/canvastty/"), [`${ws.baseline.commit} refs/canvastty/${ws.runId}/baseline`]);
});

test("repository without a first commit: baseline has no parent, head null, source index untouched", async () => {
  const source = initRepo(TMP, sourcePath("unborn"));
  write(source, "staged ü.txt", "staged\n");
  git(TMP, source, ["add", "staged ü.txt"]);
  write(source, "untracked.txt", "untracked\n");
  const before = fingerprint(TMP, source);
  const ws = await freshWorkspace(source);
  assert.equal(ws.head, null);
  assert.equal(ws.baseline.parent, null);
  assert.equal(git(TMP, source, ["rev-list", "--parents", "-n", "1", ws.baseline.commit]), ws.baseline.commit, "no parent");
  assert.deepEqual(readTree(ws.repo), { "staged ü.txt": "staged\n", "untracked.txt": "untracked\n" });
  assert.equal(git(TMP, ws.repo, ["rev-parse", "HEAD"]), ws.baseline.commit);
  assertSourceUnchanged(source, before, "unborn");
});

// Each case builds a source that must be refused before anything is written anywhere.
const REFUSALS = [
  ["no .git", "not_a_repository", (dir) => { fs.mkdirSync(dir); write(dir, "f.txt", "x\n"); }],
  ["bare repository", "unsupported_repository", (dir) => { fs.mkdirSync(dir); git(TMP, dir, ["init", "-q", "--bare"]); }],
  ["linked worktree (.git file)", "unsupported_repository", (dir) => {
    const main = smallSource();
    git(TMP, main, ["worktree", "add", "-q", "--detach", dir]);
    return main;
  }],
  ["sparse checkout (sparse-checkout set)", "unsupported_repository", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    git(TMP, dir, ["sparse-checkout", "set", "--no-cone", "/sub dir/"]);
    assert.equal(fs.existsSync(path.join(dir, "a.txt")), false, "a.txt left the work tree");
  }],
  ["skip-worktree bit on a file", "unsupported_repository", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    git(TMP, dir, ["update-index", "--skip-worktree", "a.txt"]);
  }],
  [".git/commondir in the source", "unsupported_repository", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    write(dir, ".git/commondir", "../elsewhere\n");
  }],
  ["core.bare=true with a work tree", "unsupported_repository", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    git(TMP, dir, ["config", "core.bare", "true"]);
  }],
  ...["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"].map((f) => [f, "operation_in_progress", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    write(dir, `.git/${f}`, `${git(TMP, dir, ["rev-parse", "HEAD"])}\n`);
  }]),
  ...["rebase-merge", "rebase-apply", "sequencer"].map((d) => [`${d}/`, "operation_in_progress", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    write(dir, `.git/${d}/head-name`, "refs/heads/main\n");
  }]),
  ["conflict stages in the index (MERGE_HEAD removed)", "operation_in_progress", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    git(TMP, dir, ["checkout", "-q", "-b", "other"]);
    write(dir, "a.txt", "other\n"); commitAll(TMP, dir, "other");
    git(TMP, dir, ["checkout", "-q", "main"]);
    write(dir, "a.txt", "main\n"); commitAll(TMP, dir, "main");
    assert.equal(git(TMP, dir, ["merge", "-q", "other"], { allowFail: true }), null, "merge conflicts");
    for (const f of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"]) fs.rmSync(path.join(dir, ".git", f), { force: true });
    assert.match(git(TMP, dir, ["ls-files", "-u"]), /a\.txt/);
  }],
  [".gitmodules committed", "submodules_unsupported", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    write(dir, ".gitmodules", "[submodule \"x\"]\n\tpath = x\n\turl = ./x\n"); commitAll(TMP, dir, "modules");
  }],
  ["gitlink in the index", "submodules_unsupported", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    git(TMP, dir, ["update-index", "--add", "--cacheinfo", `160000,${git(TMP, dir, ["rev-parse", "HEAD"])},vendor lib`]);
  }],
  ["gitlink only in HEAD", "submodules_unsupported", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    git(TMP, dir, ["update-index", "--add", "--cacheinfo", `160000,${git(TMP, dir, ["rev-parse", "HEAD"])},vendor lib`]);
    git(TMP, dir, ["commit", "-q", "-m", "gitlink"]);
    git(TMP, dir, ["rm", "-q", "--cached", "vendor lib"]);
  }],
  ["filter=lfs in a committed .gitattributes", "lfs_unsupported", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    write(dir, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n"); commitAll(TMP, dir, "lfs");
  }],
  ["filter=lfs in an untracked nested .gitattributes", "lfs_unsupported", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    write(dir, "assets dir/.gitattributes", "*.psd filter=lfs\n");
  }],
  ["filter=lfs in info/attributes", "lfs_unsupported", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    write(dir, ".git/info/attributes", "*.bin filter=lfs\n");
  }],
  ["untracked nested repository", "nested_repository", (dir) => {
    const src = smallSource(); fs.renameSync(src, dir);
    initRepo(TMP, path.join(dir, "vendor inner"));
    write(dir, "vendor inner/x.txt", "x\n");
  }]
];

test("refused sources: exact code, source unchanged, no workspace/ created", async () => {
  for (const [label, expectedCode, build] of REFUSALS) {
    const dir = sourcePath(label.replace(/[^\w]+/g, " ").trim());
    const main = build(dir);
    const before = fingerprint(TMP, dir);
    const mainBefore = main && fingerprint(TMP, main);
    const runId = newRun();
    await assert.rejects(createWorkspace({ root: ROOT, runId, source: dir, gitPath: GIT }), code(expectedCode), label);
    assert.equal(fs.existsSync(wsDir(runId)), false, `${label}: workspace/ not created`);
    assertSourceUnchanged(dir, before, label);
    if (main) assertSourceUnchanged(main, mainBefore, `${label} (main repository)`);
    assert.deepEqual(fs.existsSync(path.join(dir, ".git")) && fs.statSync(path.join(dir, ".git")).isDirectory()
      ? refs(TMP, dir, "refs/canvastty/") : [], [], `${label}: no ref published`);
  }
});

test("snapshotCopyTree / commitSnapshot / readCommit / setControlRef: copy tree rules, nested repo refused", async () => {
  const ws = await freshWorkspace();
  write(ws.repo, "a.txt", "a v2\n");
  fs.rmSync(path.join(ws.repo, "b.txt"));
  write(ws.repo, "new ü file.txt", "new\n");
  write(ws.repo, "build/out.bin", "ignored\n");
  const indexBefore = fs.readFileSync(path.join(ws.repo, ".git", "index"));
  const tree = await snapshotCopyTree(ws, ws.baseline.tree);
  assert.deepEqual(readCommitTree(TMP, ws.control, tree), {
    ".gitignore": "build/\n", "a.txt": "a v2\n", "sub dir/c ü.txt": "c v1\n", "new ü file.txt": "new\n"
  });
  assert.deepEqual(fs.readFileSync(path.join(ws.repo, ".git", "index")), indexBefore, "the agent's index is not used");
  const commit = await commitSnapshot(ws, tree, ws.baseline.commit, "snap\n");
  assert.deepEqual(await readCommit(ws, commit), { commit, tree, parent: ws.baseline.commit });
  const ref = `refs/canvastty/snapshot/${randomUUID()}`;
  await setControlRef(ws, ref, commit);
  assert.equal(git(TMP, ws.control, ["rev-parse", ref]), commit);
  await assert.rejects(setControlRef(ws, ref, ws.baseline.commit), (e) => e instanceof WorkspaceError, "control ref is create-only");
  assert.equal(git(TMP, ws.control, ["rev-parse", ref]), commit);

  initRepo(TMP, path.join(ws.repo, "inner repo"));
  write(ws.repo, "inner repo/x.txt", "x\n");
  await assert.rejects(snapshotCopyTree(ws, ws.baseline.tree), code("nested_repository"));
});

test("publishRef: created, exists_same, ref_conflict without overwrite (also for a fast-forward), no tmp ref left", async () => {
  const ws = await freshWorkspace();
  const source = ws.sourcePath;
  const before = fingerprint(TMP, source);
  write(ws.repo, "a.txt", "a v2\n");
  const t1 = await snapshotCopyTree(ws, ws.baseline.tree);
  const c1 = await commitSnapshot(ws, t1, ws.baseline.commit, "c1\n");
  write(ws.repo, "a.txt", "a v3\n");
  const t2 = await snapshotCopyTree(ws, ws.baseline.tree);
  const c2 = await commitSnapshot(ws, t2, c1, "c2 (descendant of c1)\n");

  assert.equal(await readSourceRef(ws, "stage-1"), null);
  assert.equal(await publishRef(ws, "stage-1", c1), "created");
  assert.equal(await readSourceRef(ws, "stage-1"), c1);
  assert.equal(await publishRef(ws, "stage-1", c1), "exists_same");
  await assert.rejects(publishRef(ws, "stage-1", c2), (e) => {
    code("ref_conflict")(e);
    assert.equal(e.detail?.existing, c1, "conflict reports the existing commit");
    return true;
  });
  assert.equal(await readSourceRef(ws, "stage-1"), c1, "fast-forward did not happen");
  assert.equal(git(TMP, source, ["cat-file", "-t", c1]), "commit", "objects are in the source");
  const own = refs(TMP, source, `refs/canvastty/${ws.runId}/`);
  assert.deepEqual(own.sort(), [`${ws.baseline.commit} refs/canvastty/${ws.runId}/baseline`, `${c1} refs/canvastty/${ws.runId}/stage-1`].sort(), "no tmp-* ref left");
  assert.deepEqual(refs(TMP, ws.control, "refs/canvastty/tmp/"), [], "no temporary ref left in control.git");
  assert.deepEqual((await listSourceRefs(ws)).sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: "baseline", commit: ws.baseline.commit }, { name: "stage-1", commit: c1 }]);
  assertSourceUnchanged(source, before, "publishRef");
});

test("applyTreeToCopy: removes non-ignored extras, keeps ignored files and the agent's .git; ignored path in the way -> restore_conflict, copy unchanged", async () => {
  const ws = await freshWorkspace();
  const source = ws.sourcePath;
  const before = fingerprint(TMP, source);
  write(ws.repo, "a.txt", "a changed\n");
  write(ws.repo, "extra ü.txt", "extra\n");
  write(ws.repo, "build/keep.out", "ignored\n");
  const t1 = await snapshotCopyTree(ws, ws.baseline.tree);
  const gitBefore = { head: fs.readFileSync(path.join(ws.repo, ".git", "HEAD")), index: fs.readFileSync(path.join(ws.repo, ".git", "index")) };
  await applyTreeToCopy(ws, t1, ws.baseline.tree);
  assert.deepEqual(readTree(ws.repo), {
    ".gitignore": "build/\n", "a.txt": "a v1\n", "b.txt": "b v1\n", "sub dir/c ü.txt": "c v1\n", "build/keep.out": "ignored\n"
  });
  assert.deepEqual(fs.readFileSync(path.join(ws.repo, ".git", "HEAD")), gitBefore.head);
  assert.deepEqual(fs.readFileSync(path.join(ws.repo, ".git", "index")), gitBefore.index);

  // Target has gen/data.txt; in the current state gen/ is ignored and occupied by a local file.
  write(ws.repo, "gen/data.txt", "target\n");
  const target = await snapshotCopyTree(ws, ws.baseline.tree);
  fs.rmSync(path.join(ws.repo, "gen"), { recursive: true });
  write(ws.repo, ".gitignore", "build/\ngen/\n");
  const from = await snapshotCopyTree(ws, ws.baseline.tree);
  write(ws.repo, "gen/data.txt", "local ignored\n");
  const copyBefore = readTree(ws.repo);
  await assert.rejects(applyTreeToCopy(ws, from, target), code("restore_conflict"));
  assert.deepEqual(readTree(ws.repo), copyBefore, "copy unchanged after the conflict");
  assertSourceUnchanged(source, before, "applyTreeToCopy");
});

test("vectors written by the agent into the copy's .git do not run in snapshotCopyTree/applyTreeToCopy", async () => {
  const ws = await freshWorkspace();
  const markers = new Markers(path.join(TMP, `markers agent ${ws.runId}`));
  armGitDir(TMP, path.join(ws.repo, ".git"), markers, "copy");
  write(ws.repo, ".gitattributes", "* filter=canvastty-x diff=canvastty-x\n");
  write(ws.repo, "a.txt", "agent edit\n");
  const outcome = [];
  // The copy's .git fingerprint changed, so a primitive may refuse (copy_git_tampered); either way nothing may run.
  const run = async (label, fn) => {
    try { outcome.push([label, await fn()]); } catch (e) { code("copy_git_tampered")(e); outcome.push([label, e.code]); }
  };
  let tree = null;
  await run("snapshotCopyTree", async () => (tree = await snapshotCopyTree(ws, ws.baseline.tree)));
  if (tree) await run("applyTreeToCopy", () => applyTreeToCopy(ws, tree, ws.baseline.tree));
  assert.deepEqual(markers.fired(), [], `nothing ran (${JSON.stringify(outcome)})`);
  await assert.rejects(verifyWorkspace(ws), code("copy_git_tampered"));
  assert.deepEqual(markers.fired(), []);
});

const TAMPERS = [
  ["repo/ replaced by a symlink to the source", "workspace_tampered", (ws) => {
    fs.renameSync(ws.repo, `${ws.repo}.moved`);
    fs.symlinkSync(ws.sourcePath, ws.repo);
  }],
  ["control.git/config changed", "workspace_tampered", (ws) => fs.appendFileSync(path.join(ws.control, "config"), "[core]\n\tfsmonitor = /bin/true\n")],
  ["control.git alternates changed", "workspace_tampered", (ws) => fs.appendFileSync(path.join(ws.control, "objects", "info", "alternates"), "/tmp\n")],
  ["hook added to control.git", "workspace_tampered", (ws) => write(ws.control, "hooks/post-index-change", "#!/bin/sh\n")],
  ["control.git replaced by a symlink", "workspace_tampered", (ws) => {
    fs.renameSync(ws.control, `${ws.control}.moved`);
    fs.symlinkSync(`${ws.control}.moved`, ws.control);
  }],
  ["copy .git replaced by a gitdir: file", "copy_git_tampered", (ws) => {
    fs.renameSync(path.join(ws.repo, ".git"), path.join(ws.dir, "copy-git.moved"));
    fs.writeFileSync(path.join(ws.repo, ".git"), `gitdir: ${path.join(ws.sourcePath, ".git")}\n`);
  }],
  ["commondir added to copy .git", "copy_git_tampered", (ws) => fs.writeFileSync(path.join(ws.repo, ".git", "commondir"), `${path.join(ws.sourcePath, ".git")}\n`)],
  ["copy .git/config changed", "copy_git_tampered", (ws) => fs.appendFileSync(path.join(ws.repo, ".git", "config"), "[filter \"x\"]\n\tclean = /bin/true\n")],
  ["copy alternates changed", "copy_git_tampered", (ws) => fs.appendFileSync(path.join(ws.repo, ".git", "objects", "info", "alternates"), "/tmp\n")]
];

test("tampered workspace metadata is detected by verifyWorkspace; the source is not touched", async () => {
  for (const [label, expectedCode, tamper] of TAMPERS) {
    const ws = await freshWorkspace();
    const before = fingerprint(TMP, ws.sourcePath);
    await verifyWorkspace(ws);
    tamper(ws);
    await assert.rejects(verifyWorkspace(ws), code(expectedCode), label);
    const opened = await openWorkspace({ root: ROOT, runId: ws.runId, gitPath: GIT }).catch((e) => e);
    if (opened instanceof Error) code(expectedCode)(opened);
    else await assert.rejects(verifyWorkspace(opened), code(expectedCode), `${label} (reopened)`);
    assertSourceUnchanged(ws.sourcePath, before, label);
  }
});

test("applyTreeToCopy on repo/ replaced by a symlink to the source -> workspace_tampered, source unchanged", async () => {
  const ws = await freshWorkspace(smallSource());
  write(ws.repo, "would land in the source.txt", "x\n");
  write(ws.repo, "a.txt", "changed in the copy\n");
  const tree = await snapshotCopyTree(ws, ws.baseline.tree);
  const before = fingerprint(TMP, ws.sourcePath);
  fs.renameSync(ws.repo, `${ws.repo}.moved`);
  fs.symlinkSync(ws.sourcePath, ws.repo);
  // Unguarded, this would write both paths into the source work tree.
  await assert.rejects(applyTreeToCopy(ws, ws.baseline.tree, tree), code("workspace_tampered"));
  assertSourceUnchanged(ws.sourcePath, before, "applyTreeToCopy through a symlinked repo/");
});

test("Git failure after mkdir removes workspace/, keeps the baseline ref; retry reuses it; bad gitPath refused", async () => {
  const source = smallSource();
  const before = fingerprint(TMP, source);
  // A git that fails `clone` (step 5, after baseline publication) and behaves normally otherwise.
  const binDir = path.join(TMP, "fake git ü");
  fs.mkdirSync(binDir);
  const fakeGit = path.join(binDir, "git");
  fs.writeFileSync(fakeGit, `#!/bin/sh\nfor a in "$@"; do [ "$a" = clone ] && { echo 'simulated clone failure' >&2; exit 128; }; done\nexec '${GIT}' "$@"\n`, { mode: 0o755 });
  const runId = newRun();
  await assert.rejects(createWorkspace({ root: ROOT, runId, source, gitPath: fakeGit }),
    (e) => (e instanceof WorkspaceError || e instanceof GitError) && /git_error|git_failed/.test(e.code));
  assert.equal(fs.existsSync(wsDir(runId)), false, "no half-built workspace/");
  const kept = refs(TMP, source, `refs/canvastty/${runId}/`);
  assert.equal(kept.length, 1, "baseline ref stays");
  assertSourceUnchanged(source, before, "failed clone");

  const ws = await createWorkspace({ root: ROOT, runId, source, gitPath: GIT });
  assert.equal(`${ws.baseline.commit} refs/canvastty/${runId}/baseline`, kept[0], "retry with the same tree reuses the published baseline");
  assert.deepEqual(refs(TMP, source, `refs/canvastty/${runId}/`), kept);

  const run2 = newRun();
  await assert.rejects(createWorkspace({ root: ROOT, runId: run2, source, gitPath: path.join(TMP, "no such git") }),
    (e) => e instanceof WorkspaceError || e instanceof GitError);
  assert.equal(fs.existsSync(wsDir(run2)), false);
  assertSourceUnchanged(source, before, "bad gitPath");
});

test("changed baseline after a published ref -> baseline_conflict, workspace/ removed, existing ref kept", async () => {
  const source = smallSource();
  const runId = newRun();
  const ws = await createWorkspace({ root: ROOT, runId, source, gitPath: GIT });
  fs.rmSync(ws.dir, { recursive: true });
  write(source, "a.txt", "changed after baseline\n");
  const before = fingerprint(TMP, source);
  await assert.rejects(createWorkspace({ root: ROOT, runId, source, gitPath: GIT }), code("baseline_conflict"));
  assert.equal(fs.existsSync(wsDir(runId)), false);
  assert.deepEqual(refs(TMP, source, `refs/canvastty/${runId}/`), [`${ws.baseline.commit} refs/canvastty/${runId}/baseline`]);
  assertSourceUnchanged(source, before, "baseline_conflict");
});

test("gc --prune=now in the source keeps baseline and published commits readable from the copy and control.git", async () => {
  const source = smallSource();
  write(source, "untracked only in baseline.txt", "loose\n");
  const ws = await freshWorkspace(source);
  write(ws.repo, "stage file.txt", "stage 1\n");
  const tree = await snapshotCopyTree(ws, ws.baseline.tree);
  const commit = await commitSnapshot(ws, tree, ws.baseline.commit, "stage 1\n");
  assert.equal(await publishRef(ws, "stage-1", commit), "created");
  const baselineFiles = readCommitTree(TMP, ws.control, ws.baseline.commit);
  const stageFiles = readCommitTree(TMP, ws.control, commit);

  git(TMP, source, ["gc", "-q", "--prune=now"]);

  assert.deepEqual(await readCommit(ws, ws.baseline.commit), ws.baseline);
  assert.deepEqual(await readCommit(ws, commit), { commit, tree, parent: ws.baseline.commit });
  assert.deepEqual(readCommitTree(TMP, ws.control, ws.baseline.commit), baselineFiles);
  assert.deepEqual(readCommitTree(TMP, ws.control, commit), stageFiles);
  assert.deepEqual(readCommitTree(TMP, path.join(ws.repo, ".git"), ws.baseline.commit), baselineFiles, "copy reads baseline");
  assert.deepEqual(readCommitTree(TMP, path.join(ws.repo, ".git"), commit), stageFiles, "copy reads the published commit");
  await verifyWorkspace(ws);
});
