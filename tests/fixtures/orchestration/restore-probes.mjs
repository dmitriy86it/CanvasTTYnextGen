// Reproductions of the three restore defects from the external review (docs/agent-orchestration/implementation/
// stage-3-review-fixes.md), written against the fixed API: createSnapshot(ws, kind, base),
// prepareRestore(ws, target, base), applyRestore -> { status: "restored" }.
//
// Every probe builds its own throwaway source repository and workspace inside the mkdtemp directory it is given
// (prefix canvastty-restore-tests-); nothing outside that directory is read, written or removed.
//
//   as a script:  node tests/fixtures/orchestration/restore-probes.mjs      (exit 1 if a check fails, KEEP=1 keeps the dirs)
//   as a library: tests/orchestration-restore.test.mjs imports the probes and asserts on `checks` and `facts`.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { findGit } from "../../../src/main/services/orchestration/git.ts";
import { createCheckpoint, prepareRestore, applyRestore } from "../../../src/main/services/orchestration/snapshots.ts";
import { createWorkspace, readIncompleteRestore } from "../../../src/main/services/orchestration/workspace.ts";
import { commitAll, fingerprint, initRepo, readCommitTree, write } from "./git-fixtures.mjs";

export const PREFIX = "canvastty-restore-tests-";
export const GIT = findGit(process.env);

// A private temporary directory for one probe run or one test file. Paths contain a space and non-ASCII characters.
export const newTmp = (label) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${label} ü-`)));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Bytes and modes of a work tree, `.git` excluded: "file:<mode>:<sha256>", "dir:<mode>" or "link:<target>".
// Comparing two of these is the byte-for-byte "the copy did not change" check.
export function copyState(dir) {
  const out = {};
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (!rel && d.name === ".git") continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      const p = path.join(dir, r);
      const st = fs.lstatSync(p);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) out[r.normalize("NFC")] = `link:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { out[r.normalize("NFC")] = `dir:${mode}`; walk(r); }
      else out[r.normalize("NFC")] = `file:${mode}:${sha256(fs.readFileSync(p))}`;
    }
  };
  walk("");
  return out;
}

// Source repository, run directory and workspace for one probe. `build` writes the files of the first commit.
// Each call gets its own source and root, so the same probe may run twice in one temporary directory.
let cases = 0;
export async function setupWorkspace(tmp, label, build) {
  const n = ++cases;
  const source = initRepo(tmp, path.join(tmp, `src ${n} ${label} проект`));
  build(source);
  commitAll(tmp, source, "initial");
  const root = path.join(tmp, `root ${n} ${label} данные`);
  const runId = randomUUID();
  fs.mkdirSync(path.join(root, "runs", runId), { recursive: true });
  const ws = await createWorkspace({ root, runId, source, gitPath: GIT });
  return { tmp, source, root, runId, ws };
}

// A tree object built in control.git: `baseTree` plus the given "path" -> content blobs. Used to hand
// applyTreeToCopy a target tree no work tree can hold (two paths that differ only in case), which is the one way to
// make `read-tree -m -u` succeed and still leave the copy different from the target.
export function craftTree(tmp, ws, baseTree, files) {
  const home = fs.mkdtempSync(path.join(tmp, "craft-"));
  const env = {
    PATH: process.env.PATH, HOME: home, GIT_DIR: ws.control, GIT_INDEX_FILE: path.join(home, "index"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1"
  };
  const g = (args, input) => execFileSync(GIT, args, { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  g(["read-tree", baseTree]);
  for (const [rel, content] of Object.entries(files)) {
    g(["update-index", "--add", "--cacheinfo", `100644,${g(["hash-object", "-w", "--stdin"], content)},${rel}`]);
  }
  return g(["write-tree"]);
}

export const baselineTarget = (ws) => ({ name: "baseline", commit: ws.baseline.commit });
export const intentPath = (ws) => path.join(ws.dir, "restore.json");
const errorCode = (error) => (error === null ? null : (error?.code ?? `${error?.name}: ${error?.message}`));

// Probe 1 (defect 1). a.txt and zdir/c ü.txt are modified, the restore is prepared, then zdir loses write permission.
// read-tree -m -u restores a.txt (it sorts first) and then fails on zdir: the copy is half restored, so the outcome
// must be restore_incomplete with the intent file left behind, never restore_conflict ("the copy did not change").
export async function probePartialRestore(tmp) {
  const c = await setupWorkspace(tmp, "partial", (dir) => {
    write(dir, "a.txt", "a v1\n");
    write(dir, "zdir/c ü.txt", "c v1\n");
    write(dir, ".gitignore", "build/\n");
  });
  const { ws } = c;
  const sourceBefore = fingerprint(tmp, c.source);
  write(ws.repo, "a.txt", "a changed by the agent\n");
  write(ws.repo, "zdir/c ü.txt", "c changed by the agent\n");
  const prepared = await prepareRestore(ws, baselineTarget(ws), ws.baseline);
  const beforeApply = copyState(ws.repo);

  const zdir = path.join(ws.repo, "zdir");
  const zmode = fs.statSync(zdir).mode & 0o7777;
  let error = null;
  fs.chmodSync(zdir, 0o500);
  try {
    await applyRestore(ws, prepared);
  } catch (e) {
    error = e;
  } finally {
    fs.chmodSync(zdir, zmode);
  }

  const facts = {
    code: errorCode(error),
    error,
    beforeApply,
    afterApply: copyState(ws.repo),
    a: fs.readFileSync(path.join(ws.repo, "a.txt"), "utf8"),
    c: fs.readFileSync(path.join(zdir, "c ü.txt"), "utf8"),
    intent: await readIncompleteRestore(ws),
    intentFile: fs.existsSync(intentPath(ws)),
    recovery: readCommitTree(tmp, ws.control, prepared.recoveryCommit)
  };
  return {
    name: "1. a partial write is reported as restore_incomplete, not as a conflict",
    case: c,
    prepared,
    facts,
    checks: [
      ["applyRestore failed", error !== null],
      ["code is restore_incomplete", facts.code === "restore_incomplete"],
      ["code is not restore_conflict", facts.code !== "restore_conflict"],
      ["a.txt is already restored", facts.a === "a v1\n"],
      ["zdir/c ü.txt is still the agent's version", facts.c === "c changed by the agent\n"],
      ["the copy really is half restored", !isDeepStrictEqual(facts.afterApply, facts.beforeApply)],
      ["readIncompleteRestore reports the intent", facts.intent !== null],
      ["workspace/restore.json stays", facts.intentFile === true],
      ["the recovery snapshot holds the pre-restore copy", facts.recovery["zdir/c ü.txt"] === "c changed by the agent\n"],
      ["source repository unchanged", isDeepStrictEqual(fingerprint(tmp, c.source), sourceBefore)]
    ]
  };
}

// Probe 2 (defect 2). The baseline holds a.txt and b.txt, a.txt is modified and the restore prepared; only then
// b.txt is changed and a non-ignored new.txt appears. read-tree -m -u would touch a.txt only and report success,
// so applyRestore has to refuse with restore_state_changed before it writes anything.
export async function probeStateChanged(tmp) {
  const c = await setupWorkspace(tmp, "state-changed", (dir) => {
    write(dir, "a.txt", "a v1\n");
    write(dir, "b.txt", "b v1\n");
    write(dir, ".gitignore", "build/\n");
  });
  const { ws } = c;
  const sourceBefore = fingerprint(tmp, c.source);
  write(ws.repo, "a.txt", "a changed by the agent\n");
  const prepared = await prepareRestore(ws, baselineTarget(ws), ws.baseline);
  write(ws.repo, "b.txt", "b changed after prepareRestore\n");
  write(ws.repo, "new.txt", "new after prepareRestore\n");

  const beforeApply = copyState(ws.repo);
  let error = null;
  let result;
  try {
    result = await applyRestore(ws, prepared);
  } catch (e) {
    error = e;
  }
  const facts = {
    code: errorCode(error),
    error,
    result,
    beforeApply,
    afterApply: copyState(ws.repo),
    a: fs.readFileSync(path.join(ws.repo, "a.txt"), "utf8"),
    b: fs.readFileSync(path.join(ws.repo, "b.txt"), "utf8"),
    newFile: fs.existsSync(path.join(ws.repo, "new.txt")),
    intent: await readIncompleteRestore(ws),
    intentFile: fs.existsSync(intentPath(ws))
  };
  return {
    name: "2. a copy changed after prepareRestore is refused before the first write",
    case: c,
    prepared,
    facts,
    checks: [
      ["applyRestore failed", error !== null],
      ["code is restore_state_changed", facts.code === "restore_state_changed"],
      ["a.txt is still the agent's version (nothing was written)", facts.a === "a changed by the agent\n"],
      ["b.txt keeps the change made after prepareRestore", facts.b === "b changed after prepareRestore\n"],
      ["new.txt is still there", facts.newFile === true],
      ["the copy did not change at all", isDeepStrictEqual(facts.afterApply, facts.beforeApply)],
      ["no intent file was left", facts.intent === null && facts.intentFile === false],
      ["source repository unchanged", isDeepStrictEqual(fingerprint(tmp, c.source), sourceBefore)]
    ]
  };
}

// Probe 3 (defect 3). accepted.txt is accepted in checkpoint stage-<n>, then .gitignore starts ignoring it and the
// agent changes it. With the applicable base (that checkpoint) the file is tracked, so the recovery snapshot must
// carry its content from disk; with the baseline as base it is untracked and ignored and silently disappears.
export async function probeAcceptedFile(tmp, { stage = 1 } = {}) {
  const c = await setupWorkspace(tmp, `accepted-stage-${stage}`, (dir) => {
    write(dir, "a.txt", "a v1\n");
    write(dir, ".gitignore", "build/\n");
  });
  const { ws } = c;
  const sourceBefore = fingerprint(tmp, c.source);
  for (let s = 1; s < stage; s++) {
    write(ws.repo, "a.txt", `a v${s + 1}\n`);
    await createCheckpoint(ws, s);
  }
  write(ws.repo, "accepted.txt", "accepted v1\n");
  const checkpoint = await createCheckpoint(ws, stage);
  write(ws.repo, ".gitignore", "build/\naccepted.txt\n");
  write(ws.repo, "accepted.txt", "accepted from disk\n");

  const base = { commit: checkpoint.commit, tree: checkpoint.tree, parent: checkpoint.parent };
  const prepared = await prepareRestore(ws, { name: `stage-${stage}`, commit: checkpoint.commit }, base);
  const facts = {
    base,
    recovery: readCommitTree(tmp, ws.control, prepared.recoveryCommit),
    target: readCommitTree(tmp, ws.control, checkpoint.commit)
  };
  return {
    name: `3. a file accepted in stage-${stage} stays in the recovery snapshot after a new ignore rule`,
    case: c,
    prepared,
    checkpoint,
    facts,
    checks: [
      ["the checkpoint really holds accepted.txt", facts.target["accepted.txt"] === "accepted v1\n"],
      ["the recovery commit holds accepted.txt", facts.recovery["accepted.txt"] !== undefined],
      ["with the content from disk", facts.recovery["accepted.txt"] === "accepted from disk\n"],
      ["and the new ignore rule", facts.recovery[".gitignore"] === "build/\naccepted.txt\n"],
      ["source repository unchanged", isDeepStrictEqual(fingerprint(tmp, c.source), sourceBefore)]
    ]
  };
}

export const PROBES = [probePartialRestore, probeStateChanged, (tmp) => probeAcceptedFile(tmp, { stage: 1 })];

export async function runProbes(tmp) {
  const results = [];
  for (const probe of PROBES) {
    try {
      results.push(await probe(tmp));
    } catch (error) {
      results.push({ name: `${probe.name || "probe"} (threw)`, checks: [[`no exception: ${error?.stack ?? error}`, false]] });
    }
  }
  return results;
}

async function main() {
  if (process.getuid?.() === 0) {
    console.log("probe 1 needs an unwritable directory to stay unwritable: do not run as root");
    process.exitCode = 1;
    return;
  }
  const tmp = newTmp("probes");
  let failed = 0;
  try {
    for (const result of await runProbes(tmp)) {
      console.log(`\n${result.name}`);
      for (const [what, ok] of result.checks) {
        if (!ok) failed++;
        console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
      }
    }
  } finally {
    if (process.env.KEEP) console.log(`\nkept: ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) await main();
