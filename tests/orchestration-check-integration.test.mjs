// A real check of a real (tiny) project inside the real Seatbelt sandbox: the whole stage-4 path with nothing stubbed
// — trusted registry, generated profile, self-test, supervisor, journal (stage-4-contract.md §9). The target is the
// fixture project in tests/fixtures/orchestration/check-project, copied into a temporary source repository; the
// CanvasTTY repository itself is never the target and the real userData is never used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { checkPreparedDeps, createRegistry } from "../src/main/services/orchestration/checks.ts";
import { runProjectCheck } from "../src/main/services/orchestration/checkService.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRun, openRun, readRun } from "../src/main/services/orchestration/store.ts";
import { createWorkspace } from "../src/main/services/orchestration/workspace.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "orchestration", "check-project");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const SUPERVISOR = path.join(HERE, "..", "src", "orchestration", "supervisor.mjs");
const LAUNCH = { command: NODE, args: [SUPERVISOR], env: {} };
const DARWIN = process.platform === "darwin";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-check-integration-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "");
const g = (cwd, ...args) => execFileSync(GIT, args, {
  cwd,
  env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  encoding: "utf8"
}).trim();
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// node --test on one file: the check that passes and the check that fails, plus one that tries the network.
const registry = createRegistry([
  { id: "unit", title: "unit tests", executable: NODE, argv: ["--test", "tests/sum.test.mjs"], timeoutMs: 120_000, maxOutputBytes: 65_536 },
  { id: "unit-broken", title: "the failing test", executable: NODE, argv: ["--test", "tests/broken.test.mjs"], timeoutMs: 120_000, maxOutputBytes: 65_536 },
  { id: "net", title: "a check that wants the network", executable: NODE, argv: ["-e", "await fetch('http://example.com')"], timeoutMs: 60_000, maxOutputBytes: 8192 }
]);

let n = 0;
// A source project with prepared dependencies: the fixture plus a node_modules the check may only read.
async function setup() {
  const root = path.join(TMP, `root-${++n}`);
  const src = path.join(TMP, `src-${n}`);
  fs.cpSync(FIXTURE, src, { recursive: true });
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => ` ${s}`;\n");
  fs.writeFileSync(path.join(src, "node_modules", ".package-lock.json"), "{}\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fixture project");

  const runId = randomUUID();
  const writer = await createRun(root, runId, { goal: "project checks" });
  const ws = await createWorkspace({ root, runId, source: src, gitPath: GIT });
  await writer.recordWorkspaceCreated({
    sourcePathSha256: sha(ws.sourcePath), baseline: { commit: ws.baseline.commit, tree: ws.baseline.tree }, head: ws.head
  });
  const deps = checkPreparedDeps({
    lockfileRelPath: "package-lock.json",
    lockfileSha256: sha(fs.readFileSync(path.join(src, "package-lock.json"))),
    nodeModulesPath: path.join(src, "node_modules")
  });
  return { root, src, runId, writer, ws, deps };
}

const runCheck = (c, id, extra = {}) =>
  runProjectCheck({ ws: c.ws, registry, id, deps: c.deps, writer: c.writer, launch: LAUNCH, state: c.writer.state(), ...extra });

test("a real check of the fixture project inside the sandbox: passed, with the evidence it is a statement about",
  { skip: !DARWIN && "the minimal profile is macOS only" }, async () => {
    const c = await setup();
    const result = await runCheck(c, "unit");
    assert.equal(result.status, "passed", `reason=${result.reason} detail=${JSON.stringify(result.detail)}`);
    assert.equal(result.reason, null);
    assert.equal(result.process.exitCode, 0);
    assert.equal(result.cleanup.groupCleared, true);
    assert.equal(result.cleanup.observed, "process_group_and_sandbox_scan");
    assert.equal(result.cleanup.sandboxCleared, true, "the scan inside the sandbox confirmed nothing of the check is left");
    assert.ok(result.sandbox.selftest.passed, "the self-test ran and passed before the check");
    assert.ok(result.sandbox.selftest.checks > 0);
    assert.match(result.evidenceFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(result.copy.treeBefore, result.copy.treeAfter, "the check did not change the tree it speaks about");

    const { state, integrity } = await readRun(c.root, c.runId);
    assert.equal(integrity.status, "ok");
    const check = state.checks[result.checkRunId];
    assert.deepEqual([check.status, check.reason, check.checkId], ["passed", null, "unit"]);
    assert.equal(check.evidenceFingerprint, result.evidenceFingerprint);
    assert.ok(check.output, "the output is stored as a text reference");
    const output = fs.readFileSync(path.join(c.root, "runs", c.runId, "texts", check.output.sha256), "utf8");
    assert.match(output, /(#|ℹ) pass 1/, "and it is the real output of node --test");
    assert.match(output, /sum adds numbers/);
    await c.writer.close();
  });

test("the failing test of the same project: failed is a verdict of the tool, not a runner problem",
  { skip: !DARWIN && "the minimal profile is macOS only" }, async () => {
    const c = await setup();
    const result = await runCheck(c, "unit-broken");
    assert.equal(result.status, "failed", `reason=${result.reason} detail=${JSON.stringify(result.detail)}`);
    assert.equal(result.reason, null);
    assert.notEqual(result.process.exitCode, 0);
    assert.equal(result.cleanup.groupCleared, true);
    const { state } = await readRun(c.root, c.runId);
    assert.deepEqual([state.checks[result.checkRunId].status, state.checks[result.checkRunId].reason], ["failed", null]);
    await c.writer.close();
  });

test("a check that wants the network fails inside the profile, and the profile is not widened for it",
  { skip: !DARWIN && "the minimal profile is macOS only" }, async () => {
    const c = await setup();
    const result = await runCheck(c, "net");
    assert.equal(result.status, "failed", "the network is refused, so the check itself fails");
    assert.ok(result.output.bytes > 0);
    await c.writer.close();
  });

test("the copy is writable from inside the sandbox, but the control data of the run is not",
  { skip: !DARWIN && "the minimal profile is macOS only" }, async () => {
    const c = await setup();
    // a check that writes an ignored artefact in the copy and tries to touch the journal and control.git
    const probe = createRegistry([{
      id: "probe", title: "writes in the copy, tries the run's own data", executable: NODE,
      argv: ["-e", `
        const fs = require("node:fs"), path = require("node:path");
        fs.mkdirSync("out", { recursive: true });
        fs.writeFileSync(path.join("out", "artefact.txt"), "built\\n");
        const run = ${JSON.stringify(path.join(c.root, "runs", c.runId))};
        const tried = {};
        for (const [name, p] of Object.entries({
          journal: path.join(run, "journal.jsonl"),
          control: path.join(run, "workspace", "control.git", "config"),
          marker: path.join(run, "workspace", "workspace.json"),
          texts: path.join(run, "texts")
        })) {
          try { fs.readFileSync(p); tried[name] = "read"; } catch (e) { tried[name] = e.code; }
        }
        console.log(JSON.stringify(tried));
      `],
      timeoutMs: 60_000, maxOutputBytes: 8192
    }]);
    const result = await runProjectCheck({
      ws: c.ws, registry: probe, id: "probe", deps: c.deps, writer: c.writer, launch: LAUNCH, state: c.writer.state()
    });
    assert.equal(result.status, "passed", `reason=${result.reason} detail=${JSON.stringify(result.detail)}`);
    assert.equal(fs.readFileSync(path.join(c.ws.repo, "out", "artefact.txt"), "utf8"), "built\n",
      "the check wrote in the copy: an ignored build artefact is allowed and does not change the tree");

    const output = fs.readFileSync(path.join(c.root, "runs", c.runId, "texts", result.output.ref.sha256), "utf8");
    const tried = JSON.parse(output.trim().split("\n").at(-1));
    for (const [what, code] of Object.entries(tried)) {
      assert.equal(code, "EPERM", `${what} must be refused by the profile, got ${code}`);
    }
    await c.writer.close();
  });

test("an unknown check id is refused; a stale lockfile is not_verified(deps_changed) before anything starts",
  { skip: !DARWIN && "the minimal profile is macOS only" }, async () => {
    const c = await setup();
    await assert.rejects(runCheck(c, "typecheck"), (e) => e.code === "unknown_check");

    fs.writeFileSync(path.join(c.ws.repo, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n');
    const result = await runCheck(c, "unit");
    assert.deepEqual([result.status, result.reason], ["not_verified", "deps_changed"]);
    const { state } = await readRun(c.root, c.runId);
    assert.deepEqual(state.checks, {}, "a refusal before the start writes no event at all");
    await c.writer.close();
  });

test("a check interrupted with the run open stays not_verified(interrupted) after reopening",
  { skip: !DARWIN && "the minimal profile is macOS only" }, async () => {
    const c = await setup();
    const started = [];
    // the journal gets the intent, then the run is closed as if the service died while the check was running
    const writer = {
      putText: (x) => c.writer.putText(x),
      recordCheckStarted: async (d) => { started.push(d); await c.writer.recordCheckStarted(d); throw new Error("service died"); },
      recordCheckFinished: (d) => c.writer.recordCheckFinished(d)
    };
    const result = await runProjectCheck({
      ws: c.ws, registry, id: "unit", deps: c.deps, writer, launch: LAUNCH, state: c.writer.state()
    });
    assert.deepEqual([result.status, result.reason], ["not_verified", "store_failed"], "the result was never confirmed");
    assert.equal(started.length, 1);
    await c.writer.close();

    const reopened = await openRun(c.root, c.runId);
    const check = reopened.state().checks[started[0].checkRunId];
    assert.deepEqual([check.status, check.reason], ["not_verified", "interrupted"]);
    await reopened.close();
  });
