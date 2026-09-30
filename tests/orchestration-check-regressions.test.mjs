// Regressions for three review defects of stage 4 (stage-4-contract.md §4–§6), reproduced through the real coordinator
// (runProjectCheck), the real supervisor, the real Seatbelt sandbox and the real journal. Nothing is stubbed: the
// preflight, postflight and cleanup that decide the result are the ones the service ships.
//   1. a change to the counted tree of the copy after the check must be not_verified(tree_changed);
//   2. the prepared dependencies actually used must be verified before and after, never replaced, never writable;
//   3. passed/failed need a verified cleanup of every process the check started, a detached escapee included.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { checkPreparedDeps, createRegistry } from "../src/main/services/orchestration/checks.ts";
import { runProjectCheck } from "../src/main/services/orchestration/checkService.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRun, readRun } from "../src/main/services/orchestration/store.ts";
import { createWorkspace } from "../src/main/services/orchestration/workspace.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "orchestration", "check-project");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const SUPERVISOR = path.join(HERE, "..", "src", "orchestration", "supervisor.mjs");
const LAUNCH = { command: NODE, args: [SUPERVISOR], env: {} };
const DARWIN = process.platform === "darwin";
const SKIP = { skip: !DARWIN && "the minimal profile is macOS only" };

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-regress-")));
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "");
const g = (cwd, ...args) => execFileSync(GIT, args, {
  cwd,
  env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  encoding: "utf8"
}).trim();
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// Every pid an escapee reported. Only these are ever killed, and only while they are still the /bin/sleep we started.
const escapees = new Set();
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
};
const commandOf = (pid) => {
  try { return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return null; }
};
async function reap(pid) {
  if (!(Number.isInteger(pid) && pid > 1)) return;
  if (commandOf(pid) !== "/bin/sleep 30") return; // gone, or the pid was reused by something that is not ours
  try { process.kill(pid, "SIGKILL"); } catch {}
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
}
after(async () => {
  for (const pid of escapees) await reap(pid);
  fs.rmSync(TMP, { recursive: true, force: true });
});

let n = 0;
// The same source project as the integration test: the fixture plus a node_modules the check may only read.
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
  const writer = await createRun(root, runId, { goal: "check regressions" });
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

let ids = 0;
// One `node -e` command in its own registry, under an id no other test uses.
function nodeCheck(c, script, { timeoutMs = 60_000 } = {}) {
  const id = `regress-${++ids}`;
  const registry = createRegistry([{ id, title: id, executable: NODE, argv: ["-e", script], timeoutMs, maxOutputBytes: 8192 }]);
  return runProjectCheck({ ws: c.ws, registry, id, deps: c.deps, writer: c.writer, launch: LAUNCH, state: c.writer.state() });
}

const outputOf = (c, result) => result.output.ref
  ? fs.readFileSync(path.join(c.root, "runs", c.runId, "texts", result.output.ref.sha256), "utf8") : "";

// Status, reason and the journal side by side, printed before any assertion so a red run still says what it returned.
async function report(t, c, result) {
  const { state } = await readRun(c.root, c.runId);
  const check = state.checks[result.checkRunId] ?? null;
  t.diagnostic(`result: ${result.status}/${result.reason} exit=${result.process.exitCode} ` +
    `cleanup=${JSON.stringify(result.cleanup)} treeBefore=${result.copy.treeBefore} treeAfter=${result.copy.treeAfter}`);
  t.diagnostic(`detail: ${JSON.stringify(result.detail)}`);
  t.diagnostic(`journal: ${check ? `${check.status}/${check.reason}` : "no event"} (checks in journal: ${Object.keys(state.checks).length})`);
  return { check, checks: state.checks };
}

// Everything under a directory, names and bytes, symlinks by their target: equal digests mean an untouched tree.
function digestDir(dir) {
  const hash = createHash("sha256");
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const p = path.join(rel, name), st = fs.lstatSync(path.join(dir, p));
      hash.update(`${p}\0${st.mode}\0`);
      if (st.isDirectory()) walk(p);
      else if (st.isSymbolicLink()) hash.update(fs.readlinkSync(path.join(dir, p)));
      else hash.update(fs.readFileSync(path.join(dir, p)));
    }
  };
  walk("");
  return hash.digest("hex");
}

async function waitFor(file, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (fs.existsSync(file)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Defect 1: the tree the result speaks about.

test("1a. the check edits a tracked source file and exits 0: not_verified(tree_changed)", SKIP, async (t) => {
  const c = await setup();
  const result = await nodeCheck(c, `require("node:fs").appendFileSync("src/sum.mjs", "export const extra = 1;\\n")`);
  const { check } = await report(t, c, result);
  assert.deepEqual([result.status, result.reason], ["not_verified", "tree_changed"]);
  assert.notEqual(result.copy.treeBefore, result.copy.treeAfter);
  assert.deepEqual([check.status, check.reason], ["not_verified", "tree_changed"]);
  assert.notEqual(check.treeBefore, check.treeAfter);
  await c.writer.close();
});

test("1b. the check creates a new untracked, non-ignored file and exits 0: not_verified(tree_changed)", SKIP, async (t) => {
  const c = await setup();
  const result = await nodeCheck(c, `require("node:fs").writeFileSync("src/extra.mjs", "export const extra = 1;\\n")`);
  const { check } = await report(t, c, result);
  assert.deepEqual([result.status, result.reason], ["not_verified", "tree_changed"]);
  assert.notEqual(result.copy.treeBefore, result.copy.treeAfter);
  assert.deepEqual([check.status, check.reason], ["not_verified", "tree_changed"]);
  await c.writer.close();
});

test("1c. control: a check that writes only into ignored out/ passes with the same tree", SKIP, async (t) => {
  const c = await setup();
  const result = await nodeCheck(c, `
    const fs = require("node:fs");
    fs.mkdirSync("out/deep", { recursive: true });
    fs.writeFileSync("out/deep/bundle.js", "built\\n");`);
  const { check } = await report(t, c, result);
  assert.deepEqual([result.status, result.reason], ["passed", null]);
  assert.equal(result.copy.treeBefore, result.copy.treeAfter);
  assert.deepEqual([check.status, check.reason], ["passed", null]);
  assert.equal(check.treeBefore, check.treeAfter);
  await c.writer.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Defect 2: the prepared dependencies the check actually used.

test("2a. a real node_modules directory already in the copy: deps_changed before the start, left untouched", SKIP, async (t) => {
  const c = await setup();
  const own = path.join(c.ws.repo, "node_modules");
  fs.mkdirSync(path.join(own, "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(own, "left-pad", "index.mjs"), "export default () => 'not the prepared one';\n");
  const before = digestDir(own);
  const result = await nodeCheck(c, `process.exit(0)`);
  const { checks } = await report(t, c, result);
  assert.deepEqual([result.status, result.reason], ["not_verified", "deps_changed"]);
  assert.deepEqual(checks, {}, "a refusal before the start writes no event");
  assert.equal(result.deps, null, "refused before any dependencies were read");
  assert.ok(fs.lstatSync(own).isDirectory() && !fs.lstatSync(own).isSymbolicLink(), "the user's directory is not replaced");
  assert.equal(digestDir(own), before, "nor is its content touched");
  await c.writer.close();
});

test("2b. a node_modules symlink in the copy to some other directory: deps_changed, the link left as is", SKIP, async (t) => {
  const c = await setup();
  const elsewhere = path.join(TMP, `elsewhere-${n}`);
  fs.mkdirSync(path.join(elsewhere, "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "left-pad", "index.mjs"), "export default () => 'elsewhere';\n");
  const link = path.join(c.ws.repo, "node_modules");
  fs.symlinkSync(elsewhere, link);
  const result = await nodeCheck(c, `process.exit(0)`);
  const { checks } = await report(t, c, result);
  assert.deepEqual([result.status, result.reason], ["not_verified", "deps_changed"]);
  assert.deepEqual(checks, {}, "a refusal before the start writes no event");
  assert.equal(result.deps, null, "refused before any dependencies were read");
  assert.equal(fs.readlinkSync(link), elsewhere, "the link is left as it was");
  await c.writer.close();
});

test("2c. the check replaces the node_modules link with a real directory and exits 0: deps_changed", SKIP, async (t) => {
  const c = await setup();
  const result = await nodeCheck(c, `
    const fs = require("node:fs");
    fs.unlinkSync("node_modules");
    fs.mkdirSync("node_modules/left-pad", { recursive: true });
    fs.writeFileSync("node_modules/left-pad/index.mjs", "export default () => 'substituted';\\n");`);
  const { check } = await report(t, c, result);
  assert.deepEqual([result.status, result.reason], ["not_verified", "deps_changed"]);
  assert.deepEqual([check.status, check.reason], ["not_verified", "deps_changed"]);
  await c.writer.close();
});

test("2d. the check removes the link and re-creates an identical one: deps_changed", SKIP, async (t) => {
  const c = await setup();
  const result = await nodeCheck(c, `
    const fs = require("node:fs");
    const target = fs.readlinkSync("node_modules");
    fs.unlinkSync("node_modules");
    fs.symlinkSync(target, "node_modules");
    console.log(JSON.stringify({ relinked: target }));`);
  const { check } = await report(t, c, result);
  t.diagnostic(`output: ${outputOf(c, result).trim()}`);
  assert.deepEqual([result.status, result.reason], ["not_verified", "deps_changed"]);
  assert.deepEqual([check.status, check.reason], ["not_verified", "deps_changed"]);
  await c.writer.close();
});

test("2e. writes into the prepared dependencies from inside the check are refused; the source stays byte-identical", SKIP, async (t) => {
  const c = await setup();
  const before = digestDir(c.deps.nodeModulesPath);
  const abs = c.deps.nodeModulesPath;
  const result = await nodeCheck(c, `
    const fs = require("node:fs"), path = require("node:path");
    const tried = {};
    for (const [via, dir] of [["link", "node_modules"], ["source", ${JSON.stringify(abs)}]]) {
      for (const [op, fn] of Object.entries({
        overwrite: () => fs.writeFileSync(path.join(dir, "left-pad", "index.mjs"), "export default () => 'owned';\\n"),
        create: () => fs.writeFileSync(path.join(dir, "planted.js"), "planted\\n"),
        unlink: () => fs.unlinkSync(path.join(dir, ".package-lock.json")),
        mkdir: () => fs.mkdirSync(path.join(dir, "planted-dir"))
      })) {
        try { fn(); tried[via + "." + op] = "done"; } catch (e) { tried[via + "." + op] = e.code; }
      }
    }
    console.log(JSON.stringify(tried));`);
  await report(t, c, result);
  const output = outputOf(c, result);
  t.diagnostic(`output: ${output.trim()}`);
  const tried = JSON.parse(output.trim().split("\n").at(-1));
  for (const [what, code] of Object.entries(tried)) assert.equal(code, "EPERM", `${what} must be refused, got ${code}`);
  assert.equal(digestDir(c.deps.nodeModulesPath), before, "the prepared dependencies are byte-identical");
  assert.deepEqual([result.status, result.reason], ["passed", null]);
  await c.writer.close();
});

test("2f. the prepared node_modules is changed from outside while the check runs: deps_changed", SKIP, async (t) => {
  const c = await setup();
  const marker = path.join(c.ws.repo, "out", "started");
  const running = nodeCheck(c, `
    const fs = require("node:fs");
    fs.mkdirSync("out", { recursive: true });
    fs.writeFileSync("out/started", "");
    setTimeout(() => {}, 1500);`);
  const seen = await waitFor(marker, 60_000);
  t.diagnostic(`command started: ${seen}`);
  if (seen) fs.appendFileSync(path.join(c.deps.nodeModulesPath, "left-pad", "index.mjs"), "// changed from outside\n");
  const result = await running;
  const { check } = await report(t, c, result);
  assert.ok(seen, "the command reported its start");
  assert.deepEqual([result.status, result.reason], ["not_verified", "deps_changed"]);
  assert.deepEqual([check.status, check.reason], ["not_verified", "deps_changed"]);
  await c.writer.close();
});

test("2g. a normal check passes, and its evidence follows the dependencies actually used", SKIP, async (t) => {
  const c = await setup();
  const read = `require("node:fs").readFileSync("node_modules/left-pad/index.mjs")`;
  // The fingerprint itself differs on every run (the profile path contains the checkRunId), so the dependency part of
  // the evidence is compared directly: result.deps is exactly what evidence v2 hashes as nodeModulesRealpath/Stamp.
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const r = await nodeCheck(c, read);
    await report(t, c, r);
    t.diagnostic(`deps: ${JSON.stringify(r.deps)}`);
    runs.push(r);
  }
  for (const r of runs) {
    assert.deepEqual([r.status, r.reason], ["passed", null]);
    assert.equal(r.deps?.realpath, fs.realpathSync(c.deps.nodeModulesPath), "the directory actually used");
    assert.equal(typeof r.deps?.stamp, "string");
  }
  assert.equal(runs[0].deps.stamp, runs[1].deps.stamp, "untouched dependencies give the same stamp");

  // same lockfile, different content of the prepared node_modules
  fs.writeFileSync(path.join(c.deps.nodeModulesPath, "left-pad", "index.mjs"), "export default (s) => `  ${s}`;\n");
  const third = await nodeCheck(c, read);
  const { check } = await report(t, c, third);
  t.diagnostic(`deps: ${JSON.stringify(third.deps)}`);
  assert.deepEqual([third.status, third.reason], ["passed", null]);
  assert.deepEqual([check.status, check.reason], ["passed", null]);
  assert.equal(third.deps?.realpath, runs[0].deps.realpath);
  assert.notEqual(third.deps?.stamp, runs[0].deps.stamp, "changed dependencies change the stamp the evidence hashes");
  await c.writer.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Defect 2, second review: a symlink inside the prepared node_modules whose final target lies outside it. The stamp
// recorded the link (lstat, readlink), not what it points at, so content outside could change under a passing check.

// A package outside the prepared directory, CommonJS so the command can drop require.cache and load it again.
function externalPackage(c) {
  const dir = path.join(TMP, `external-${n}`, "linked-package");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.cjs"), "module.exports = 1;\n");
  return dir;
}

// Loads linked-package, reports the start, waits for the coordinator's change, drops the cache and loads it again.
const reload = `
  const fs = require("node:fs"), path = require("node:path");
  const entry = path.resolve("node_modules/linked-package/index.cjs");
  const first = require(entry);
  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/started", "");
  const end = Date.now() + 10000;
  const again = () => {
    if (!fs.existsSync("out/changed") && Date.now() < end) return setTimeout(again, 20);
    delete require.cache[require.resolve(entry)]; // the cache is keyed by the real path of the file
    console.log(JSON.stringify({ first, second: require(entry) }));
  };
  again();`;

test("2h. a linked-package that points outside the prepared node_modules: deps_changed before the start, nothing touched", SKIP, async (t) => {
  const c = await setup();
  const external = externalPackage(c);
  const link = path.join(c.deps.nodeModulesPath, "linked-package");
  fs.symlinkSync(external, link);
  const before = { link: fs.readlinkSync(link), pkg: digestDir(external), deps: digestDir(c.deps.nodeModulesPath) };

  // The review scenario, verbatim: the command loads 1, the coordinator changes the file outside, the command reloads.
  const running = nodeCheck(c, reload);
  const marker = path.join(c.ws.repo, "out", "started");
  const started = await Promise.race([waitFor(marker, 60_000), running.then(() => false)]);
  t.diagnostic(`command started: ${started}`);
  if (started) {
    fs.writeFileSync(path.join(external, "index.cjs"), "module.exports = 2;\n");
    fs.writeFileSync(path.join(c.ws.repo, "out", "changed"), "");
  }
  const result = await running;
  const { check, checks } = await report(t, c, result);
  t.diagnostic(`output: ${outputOf(c, result).trim()} deps=${JSON.stringify(result.deps)}`);
  assert.deepEqual([result.status, result.reason], ["not_verified", "deps_changed"]);
  assert.equal(started, false, "the command never ran");
  assert.equal(check, null, "no check.started event");
  assert.deepEqual(checks, {});
  assert.equal(result.deps, null);
  assert.match(JSON.stringify(result.detail), /linked-package/, "the diagnostic names the link");
  assert.deepEqual({ link: fs.readlinkSync(link), pkg: digestDir(external), deps: digestDir(c.deps.nodeModulesPath) }, before,
    "the link and the package are left exactly as they were");
  await c.writer.close();
});

test("2i. links that stay inside the prepared node_modules (.bin, a package alias): a normal check passes", SKIP, async (t) => {
  const c = await setup();
  const nm = c.deps.nodeModulesPath;
  fs.mkdirSync(path.join(nm, "inner-package"), { recursive: true });
  fs.writeFileSync(path.join(nm, "inner-package", "index.cjs"), "module.exports = 'inner';\n");
  fs.mkdirSync(path.join(nm, ".bin"), { recursive: true });
  fs.symlinkSync("../inner-package/index.cjs", path.join(nm, ".bin", "inner"));
  fs.symlinkSync("inner-package", path.join(nm, "alias-package")); // relative, a directory
  fs.symlinkSync(path.join(nm, "alias-package"), path.join(nm, "chained")); // a chain, ending inside
  const result = await nodeCheck(c, `
    console.log(JSON.stringify([require("./node_modules/alias-package/index.cjs"), require("./node_modules/.bin/inner"),
      require("./node_modules/chained/index.cjs")]));`);
  const { check } = await report(t, c, result);
  t.diagnostic(`output: ${outputOf(c, result).trim()}`);
  assert.deepEqual([result.status, result.reason], ["passed", null]);
  assert.deepEqual([check.status, check.reason], ["passed", null]);
  assert.deepEqual(JSON.parse(outputOf(c, result).trim()), ["inner", "inner", "inner"]);
  await c.writer.close();
});

// A running check with an internal link; `change` runs from outside once the command has started.
async function changeWhileRunning(t, c, change) {
  const nm = c.deps.nodeModulesPath;
  fs.mkdirSync(path.join(nm, "inner-package"), { recursive: true });
  fs.writeFileSync(path.join(nm, "inner-package", "index.cjs"), "module.exports = 1;\n");
  fs.symlinkSync("inner-package", path.join(nm, "linked-package"));
  const running = nodeCheck(c, reload);
  const started = await waitFor(path.join(c.ws.repo, "out", "started"), 60_000);
  t.diagnostic(`command started: ${started}`);
  if (started) {
    change(nm);
    fs.writeFileSync(path.join(c.ws.repo, "out", "changed"), "");
  }
  const result = await running;
  const { check } = await report(t, c, result);
  t.diagnostic(`output: ${outputOf(c, result).trim()}`);
  assert.ok(started, "the command reported its start");
  assert.deepEqual([result.status, result.reason], ["not_verified", "deps_changed"]);
  assert.deepEqual([check.status, check.reason], ["not_verified", "deps_changed"]);
  await c.writer.close();
}

test("2j. the content behind an internal link changes while the check runs: deps_changed", SKIP, async (t) => {
  await changeWhileRunning(t, await setup(), (nm) => fs.writeFileSync(path.join(nm, "inner-package", "index.cjs"), "module.exports = 2;\n"));
});

test("2k. an internal link is swapped for an external one while the check runs: deps_changed", SKIP, async (t) => {
  const c = await setup();
  const external = externalPackage(c);
  fs.writeFileSync(path.join(external, "index.cjs"), "module.exports = 2;\n");
  await changeWhileRunning(t, c, (nm) => {
    const tmpLink = path.join(nm, ".swap");
    fs.symlinkSync(external, tmpLink);
    fs.renameSync(tmpLink, path.join(nm, "linked-package")); // atomic, as a package manager would
  });
});

test("2l. a chain of internal links that ends outside, and a dangling link: both refused before the start", SKIP, async (t) => {
  for (const kind of ["chain", "dangling"]) {
    const c = await setup();
    const nm = c.deps.nodeModulesPath;
    if (kind === "chain") {
      fs.symlinkSync(externalPackage(c), path.join(nm, "hop"));
      fs.symlinkSync("hop", path.join(nm, "linked-package")); // the first hop stays inside, the final target does not
    } else {
      fs.symlinkSync("does-not-exist", path.join(nm, "linked-package"));
    }
    const result = await nodeCheck(c, "0");
    const { checks } = await report(t, c, result);
    assert.deepEqual([result.status, result.reason], ["not_verified", "deps_changed"], kind);
    assert.deepEqual(checks, {}, `${kind}: no event`);
    assert.ok(fs.lstatSync(path.join(nm, "linked-package")).isSymbolicLink(), `${kind}: the link is left as it is`);
    await c.writer.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Defect 3: an escapee that left the process group through setsid.

// Spawns a detached /bin/sh that writes its pid and execs /bin/sleep 30, waits (bounded) for the pid file, then `tail`.
const escapeScript = (tail) => `
  const fs = require("node:fs"), { spawn } = require("node:child_process");
  fs.mkdirSync("out", { recursive: true });
  spawn("/bin/sh", ["-c", "echo $$ > out/escapee.pid; exec /bin/sleep 30"], { detached: true, stdio: "ignore" }).unref();
  const end = Date.now() + 5000;
  const wait = () => fs.existsSync("out/escapee.pid") || Date.now() > end ? (${tail})() : setTimeout(wait, 20);
  wait();`;

async function escapeePid(c) {
  const file = path.join(c.ws.repo, "out", "escapee.pid");
  assert.ok(await waitFor(file, 5000), "the escapee wrote its pid");
  let pid = NaN;
  for (let i = 0; i < 50 && !Number.isInteger(pid); i++, await sleep(20)) pid = Number(fs.readFileSync(file, "utf8").trim() || NaN);
  assert.ok(Number.isInteger(pid) && pid > 1, "the pid file holds a pid");
  escapees.add(pid);
  return pid;
}

test("3a. a detached escapee and exit 0: passed only with sandboxCleared, and the escapee is dead", SKIP, async (t) => {
  const c = await setup();
  let pid;
  try {
    const result = await nodeCheck(c, escapeScript(`() => process.exit(0)`));
    const { check } = await report(t, c, result);
    pid = await escapeePid(c);
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
    const live = alive(pid);
    t.diagnostic(`escapee pid=${pid} alive=${live} command=${JSON.stringify(commandOf(pid))} sandboxCleared=${result.cleanup.sandboxCleared}`);
    assert.equal(live, false, "the escapee is killed");
    if (result.status === "passed") assert.equal(result.cleanup.sandboxCleared, true, "passed requires sandboxCleared");
    else assert.deepEqual([result.status, result.reason], ["not_verified", "cleanup_unverified"]);
    assert.deepEqual([check.status, check.reason], [result.status, result.reason]);
  } finally {
    await reap(pid);
  }
  await c.writer.close();
});

test("3b. the same escapee with a command that hangs past a short timeout: not_verified(timeout), escapee dead", SKIP, async (t) => {
  const c = await setup();
  let pid;
  try {
    const result = await nodeCheck(c, escapeScript(`() => setInterval(() => {}, 1000)`), { timeoutMs: 2000 });
    const { check } = await report(t, c, result);
    pid = await escapeePid(c);
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
    const live = alive(pid);
    t.diagnostic(`escapee pid=${pid} alive=${live} command=${JSON.stringify(commandOf(pid))} sandboxCleared=${result.cleanup.sandboxCleared}`);
    assert.deepEqual([result.status, result.reason], ["not_verified", "timeout"]);
    assert.deepEqual([check.status, check.reason], ["not_verified", "timeout"]);
    assert.equal(live, false, "the escapee is killed");
  } finally {
    await reap(pid);
  }
  await c.writer.close();
});
