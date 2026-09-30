// How a check result becomes a fact of the run (stage-4-contract.md §7): the intent is journaled before any process
// starts, the result only when it is known, and a check whose result never arrived stays not_verified(interrupted)
// after reopening — with nothing re-run. Temporary directories only; no process of a real check is started here.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkPreparedDeps, commandSha256, createRegistry, resolveCheck } from "../src/main/services/orchestration/checks.ts";
import { evidenceFingerprint } from "../src/main/services/orchestration/evidence.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRun, openRun, readRun } from "../src/main/services/orchestration/store.ts";
import { createWorkspace } from "../src/main/services/orchestration/workspace.ts";

const GIT = findGit(process.env);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-check-store-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "");
const g = (cwd, ...args) => execFileSync(GIT, args, {
  cwd,
  env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  encoding: "utf8"
}).trim();

const code = (c) => (e) => { assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.stack ?? e}`); return true; };
const journalBytes = (root, runId) => fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const oid = (c) => c.repeat(40);

// A registry command that exists on every machine these tests run on.
const NODE = fs.realpathSync(process.execPath);
const REGISTRY = createRegistry([
  { id: "unit", title: "unit tests", executable: NODE, argv: ["--test", "tests/"], timeoutMs: 60_000, maxOutputBytes: 65_536 }
]);
const DEPS = checkPreparedDeps({
  lockfileRelPath: "package-lock.json", lockfileSha256: sha("lock v1"), nodeModulesPath: path.join(TMP, "node_modules")
});

let n = 0;
async function start() {
  const root = path.join(TMP, `root-${++n}`);
  const src = path.join(TMP, `src-${n}`);
  fs.mkdirSync(src, { recursive: true });
  g(src, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "a.txt"), "one\n");
  g(src, "add", "a.txt");
  g(src, "commit", "-q", "-m", "init");
  const runId = randomUUID();
  const writer = await createRun(root, runId, { goal: "checks" });
  const ws = await createWorkspace({ root, runId, source: src, gitPath: GIT });
  await writer.recordWorkspaceCreated({
    sourcePathSha256: sha(ws.sourcePath), baseline: { commit: ws.baseline.commit, tree: ws.baseline.tree }, head: ws.head
  });
  return { root, src, runId, writer, ws, base: { commit: ws.baseline.commit, tree: ws.baseline.tree } };
}

const started = (ws, base, checkRunId) => ({
  checkRunId, checkId: "unit", commandSha256: commandSha256(resolveCheck(REGISTRY, "unit")),
  base, treeBefore: ws.baseline.tree, profileSha256: sha("profile v1")
});

function facts(overrides = {}) {
  const command = resolveCheck(REGISTRY, "unit");
  return {
    copy: { treeBefore: oid("a"), treeAfter: oid("a"), base: { commit: oid("b"), tree: oid("a") } },
    command: { ...command, executableSha256: sha("node") },
    deps: { lockfileRelPath: DEPS.lockfileRelPath, lockfileSha256: DEPS.lockfileSha256, nodeModulesRealpath: DEPS.nodeModulesPath, nodeModulesStamp: sha("stamp v1") },
    tools: { node: "26.8.1", electron: null, git: "2.50.1" },
    platform: { platform: "darwin", arch: "arm64", release: "27.0.0" },
    sandbox: { profileSha256: sha("profile v1"), selftest: { passed: true, checks: 30, failed: [] } },
    env: { names: ["CI", "HOME", "LANG", "PATH", "TMPDIR"] },
    result: { status: "passed", reason: null, exitCode: 0, signal: null, groupCleared: true, sandboxCleared: true },
    ...overrides
  };
}

test("the intent is journaled before the result; a passed check becomes a fact of the run", async () => {
  const { root, runId, writer, ws, base } = await start();
  const checkRunId = randomUUID();
  await writer.recordCheckStarted(started(ws, base, checkRunId));

  const state = writer.state();
  assert.equal(state.checks[checkRunId].status, "in_flight", "started alone is not a verdict");
  assert.equal(state.checks[checkRunId].evidenceFingerprint, null);

  const output = await writer.putText("1 passing\n");
  const fingerprint = evidenceFingerprint(facts());
  await writer.recordCheckFinished({
    checkRunId, status: "passed", reason: null, exitCode: 0, signal: null, groupCleared: true,
    treeAfter: ws.baseline.tree, output, outputDropped: 0, evidenceFingerprint: fingerprint, durationMs: 1234
  });
  await writer.close();

  const { state: read, integrity } = await readRun(root, runId);
  assert.equal(integrity.status, "ok");
  const check = read.checks[checkRunId];
  assert.deepEqual([check.status, check.reason, check.exitCode, check.groupCleared], ["passed", null, 0, true]);
  assert.deepEqual(check.output, output, "the output is a text reference, not part of the event body");
  assert.equal(check.evidenceFingerprint, fingerprint);
  assert.equal(check.treeAfter, ws.baseline.tree);
});

test("a check started and never finished is not_verified(interrupted) after reopening, with nothing re-run", async () => {
  const { root, runId, writer, ws, base } = await start();
  const checkRunId = randomUUID();
  await writer.recordCheckStarted(started(ws, base, checkRunId));
  await writer.close(); // the service died while the check was running

  const before = journalBytes(root, runId);
  const reopened = await openRun(root, runId);
  const check = reopened.state().checks[checkRunId];
  assert.deepEqual([check.status, check.reason], ["not_verified", "interrupted"]);
  assert.equal(check.groupCleared, null, "nothing is claimed about the processes");
  const events = journalBytes(root, runId).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.type === "check.started").length, 1, "no new intent: the check is not re-run");
  assert.ok(!events.some((e) => e.type === "check.finished"), "and no result is invented");
  assert.ok(journalBytes(root, runId).length >= before.length);

  // the same conclusion from a pure read, and the interrupted check does not block a new one
  const { state } = await readRun(root, runId);
  assert.deepEqual([state.checks[checkRunId].status, state.checks[checkRunId].reason], ["not_verified", "interrupted"]);
  const next = randomUUID();
  await reopened.recordCheckStarted(started(ws, base, next));
  assert.equal(reopened.state().checks[next].status, "in_flight");
  await reopened.close();
});

test("the journal refuses check events that contradict it", async () => {
  const { root, runId, writer, ws, base } = await start();
  const checkRunId = randomUUID();
  const before = journalBytes(root, runId);

  // a result without its intent
  const finish = {
    checkRunId, status: "passed", reason: null, exitCode: 0, signal: null, groupCleared: true,
    treeAfter: ws.baseline.tree, output: null, outputDropped: 0, evidenceFingerprint: sha("e"), durationMs: 1
  };
  await assert.rejects(writer.recordCheckFinished(finish), code("invalid_input"), "no intent");
  // a base that is not the applicable base of the copy
  await assert.rejects(writer.recordCheckStarted({ ...started(ws, base, checkRunId), base: { commit: oid("c"), tree: oid("d") } }),
    code("invalid_input"), "stale base");
  // an id that is not in the registry cannot even be resolved, and the journal refuses the shape too
  assert.throws(() => resolveCheck(REGISTRY, "typecheck"), code("unknown_check"));
  await assert.rejects(writer.recordCheckStarted({ ...started(ws, base, checkRunId), checkId: "Not An Id" }), code("invalid_input"));
  assert.deepEqual(journalBytes(root, runId), before, "a refusal writes nothing");

  await writer.recordCheckStarted(started(ws, base, checkRunId));
  await assert.rejects(writer.recordCheckStarted(started(ws, base, checkRunId)), code("invalid_input"), "started twice");

  // passed and failed are verdicts of the tool: they require a confirmed exit and a cleared process group
  for (const bad of [
    { ...finish, status: "passed", exitCode: 1 },
    { ...finish, status: "passed", groupCleared: false },
    { ...finish, status: "failed", exitCode: 0 },
    { ...finish, status: "failed", groupCleared: false },
    { ...finish, status: "not_verified", reason: null },
    { ...finish, status: "passed", reason: "timeout" },
    { ...finish, status: "not_verified", reason: "no_such_reason" }
  ]) {
    await assert.rejects(writer.recordCheckFinished(bad), code("invalid_input"), JSON.stringify([bad.status, bad.reason, bad.exitCode, bad.groupCleared]));
  }
  // the honest shape of a check that was stopped
  await writer.recordCheckFinished({ ...finish, status: "not_verified", reason: "stopped", exitCode: null, signal: "SIGTERM", groupCleared: true });
  assert.deepEqual([writer.state().checks[checkRunId].status, writer.state().checks[checkRunId].reason], ["not_verified", "stopped"]);
  await assert.rejects(writer.recordCheckFinished(finish), code("invalid_input"), "finished twice");
  await writer.close();
});

test("a check is refused while a restore of the copy is unfinished", async () => {
  const { root, runId, writer, ws, base } = await start();
  const { prepareRestore } = await import("../src/main/services/orchestration/snapshots.ts");
  fs.writeFileSync(path.join(ws.repo, "a.txt"), "agent edit\n");
  const prepared = await prepareRestore(ws, { name: "baseline", commit: ws.baseline.commit }, ws.baseline);
  await writer.recordSnapshot({ kind: "recovery", ref: prepared.recovery.ref, commit: prepared.recovery.commit, tree: prepared.recovery.tree });
  await writer.recordRestoreStarted({ target: prepared.target, targetCommit: prepared.targetCommit, recoveryCommit: prepared.recoveryCommit });

  const before = journalBytes(root, runId);
  await assert.rejects(writer.recordCheckStarted(started(ws, base, randomUUID())), code("invalid_input"),
    "the copy's content is not confirmed while a restore is unfinished");
  assert.deepEqual(journalBytes(root, runId), before);
  await writer.close();
});

test("evidenceFingerprint covers what the contract says and never holds environment values", () => {
  const base = evidenceFingerprint(facts());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(base, evidenceFingerprint(facts()), "the same facts give the same fingerprint");
  assert.equal(evidenceFingerprint(facts({ env: { names: ["TMPDIR", "PATH", "LANG", "HOME", "CI"] } })), base, "names are order-independent");

  const changed = {
    "the tree before": { copy: { ...facts().copy, treeBefore: oid("f") } },
    "the tree after": { copy: { ...facts().copy, treeAfter: oid("f") } },
    "the command": { command: { ...facts().command, argv: ["--test", "other/"] } },
    "the lockfile": { deps: { ...facts().deps, lockfileSha256: sha("lock v2") } },
    "the prepared directory": { deps: { ...facts().deps, nodeModulesRealpath: "/elsewhere/node_modules" } },
    "the dependency stamp": { deps: { ...facts().deps, nodeModulesStamp: sha("stamp v2") } },
    "the tool versions": { tools: { node: "22.23.2", electron: null, git: "2.50.1" } },
    "the platform": { platform: { platform: "linux", arch: "arm64", release: "6.0" } },
    "the profile": { sandbox: { profileSha256: sha("profile v2"), selftest: facts().sandbox.selftest } },
    "the selftest": { sandbox: { profileSha256: facts().sandbox.profileSha256, selftest: { passed: false, checks: 30, failed: ["net-external"] } } },
    "the result": { result: { ...facts().result, status: "failed", exitCode: 1 } },
    "the sandbox scan": { result: { ...facts().result, sandboxCleared: false } },
    "an environment name": { env: { names: ["CI", "HOME", "LANG", "PATH", "TMPDIR", "SECRET_TOKEN"] } }
  };
  for (const [what, override] of Object.entries(changed)) {
    assert.notEqual(evidenceFingerprint(facts(override)), base, `${what} must change the fingerprint`);
  }
  assert.ok(!JSON.stringify(facts()).includes("secret-value"), "the facts carry names, not values");
});
