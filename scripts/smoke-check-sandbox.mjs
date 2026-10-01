// Project-check smoke (stage-4-contract.md): the whole check path — trusted registry, generated profile, self-test with
// sandbox-probe.mjs, the supervisor inside the sandbox with its scan, the journal — with the helpers run by Electron in
// Node mode (ELECTRON_RUN_AS_NODE=1), not by the plain node that runs this script.
//   default     node_modules/electron and src/orchestration/*.mjs (the development layout)
//   --packaged  builds the unpacked app into a NEW temporary directory (electron-builder --dir; release/ is never
//               touched) and uses its binary and Contents/Resources/orchestration/*.mjs. Needs `npm run build` first.
//   --packaged --app <path/Raoden Loom.app>  that already built application instead of building one
// The target is the fixture project in tests/fixtures/orchestration/check-project, copied into a temporary repository;
// no model runs, the user's profile and data are not used. macOS only (the profile is Seatbelt).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { checkPreparedDeps, createRegistry } from "../src/main/services/orchestration/checks.ts";
import { runProjectCheck } from "../src/main/services/orchestration/checkService.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRun, readRun } from "../src/main/services/orchestration/store.ts";
import { createWorkspace } from "../src/main/services/orchestration/workspace.ts";
import { step } from "./smoke-watchdog.mjs";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = path.join(PROJECT_ROOT, "tests", "fixtures", "orchestration", "check-project");
const HELPERS = ["sandbox-probe.mjs", "supervisor.mjs"];
const packaged = process.argv.includes("--packaged");
const appArg = process.argv.indexOf("--app");
const explicitApp = appArg > 0 ? path.resolve(process.argv[appArg + 1] ?? "") : null;
if (explicitApp && !packaged) throw new Error("--app needs --packaged");
if (process.platform !== "darwin") throw new Error("The check sandbox smoke runs on macOS only.");

const NODE = fs.realpathSync(process.execPath);
const GIT = findGit(process.env);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-check-smoke-")));
const escapees = [];
const failures = [];
const expect = (condition, what) => { if (!condition) failures.push(what); };

try {
  const { command, helpers } = packaged ? (explicitApp ? packagedApp(explicitApp) : buildPackage()) : { command: electronPath, helpers: path.join(PROJECT_ROOT, "src", "orchestration") };
  const launch = { command, args: [path.join(helpers, "supervisor.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };
  process.stdout.write(`Check sandbox smoke: mode=${packaged ? "packaged" : "development"} electron=${command} helpers=${helpers} os=${os.release()}\n`);

  step("check sandbox: setup");
  const c = await setup();
  const escapeeScript = `
    const { spawn } = require("node:child_process");
    require("node:fs").mkdirSync("out", { recursive: true });
    spawn("/bin/sh", ["-c", 'echo $$ > out/escapee.pid; exec /bin/sleep 30'], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => {}, 500);`;
  const registry = createRegistry([
    { id: "unit", title: "unit tests", executable: NODE, argv: ["--test", "tests/sum.test.mjs"], timeoutMs: 120_000, maxOutputBytes: 65_536 },
    { id: "unit-broken", title: "the failing test", executable: NODE, argv: ["--test", "tests/broken.test.mjs"], timeoutMs: 120_000, maxOutputBytes: 65_536 },
    { id: "escapee", title: "leaves a detached /bin/sleep", executable: NODE, argv: ["-e", escapeeScript], timeoutMs: 60_000, maxOutputBytes: 8192 }
  ]);
  const report = {};
  for (const id of ["unit", "unit-broken", "escapee"]) {
    const r = await runProjectCheck({ ws: c.ws, registry, id, deps: c.deps, writer: c.writer, launch, state: c.writer.state() });
    const journal = (await readRun(c.root, c.runId)).state.checks[r.checkRunId] ?? null;
    report[id] = {
      status: r.status, reason: r.reason, exitCode: r.process.exitCode, cleanup: r.cleanup,
      selftest: r.sandbox.selftest && { passed: r.sandbox.selftest.passed, checks: r.sandbox.selftest.checks, failed: r.sandbox.selftest.failed.map((f) => f.name) },
      journal: journal && { status: journal.status, reason: journal.reason }
    };
    expect(r.sandbox.selftest?.passed === true && r.sandbox.selftest.checks > 0, `${id}: self-test did not pass: ${JSON.stringify(r.sandbox.selftest?.failed ?? r.detail)}`);
    expect(journal?.status === r.status && journal?.reason === r.reason, `${id}: journal ${JSON.stringify(journal)} differs from the result`);
  }
  expect(report.unit.status === "passed" && report.unit.cleanup.sandboxCleared === true, `unit: ${JSON.stringify(report.unit)}`);
  expect(report["unit-broken"].status === "failed", `unit-broken: ${JSON.stringify(report["unit-broken"])}`);

  const pidFile = path.join(c.ws.repo, "out", "escapee.pid");
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8").trim()) : null;
  if (pid) escapees.push(pid);
  report.escapee.pid = pid;
  report.escapee.pidAlive = pid ? alive(pid) : null;
  expect(pid !== null, "escapee: the detached /bin/sleep never started");
  expect(report.escapee.pidAlive === false, `escapee ${pid} is still alive after the result`);
  expect(report.escapee.cleanup.sandboxCleared === true && report.escapee.cleanup.killed >= 1, `escapee: the scan did not kill it: ${JSON.stringify(report.escapee.cleanup)}`);
  expect(report.escapee.status === "passed", `escapee: ${report.escapee.status}/${report.escapee.reason}`);
  await c.writer.close();

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) throw new Error(`Check sandbox smoke failed:\n- ${failures.join("\n- ")}`);
  process.stdout.write(`Check sandbox smoke passed (${packaged ? "packaged" : "development"}).\n`);
} finally {
  // Only the pid this smoke caused, and only while it is still the /bin/sleep it started (pids are reused).
  for (const pid of escapees) {
    const cmd = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    if (cmd === "/bin/sleep 30") try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// electron-builder --dir into the temporary directory: the same config as `npm run package`, a different output.
function buildPackage() {
  if (!fs.existsSync(path.join(PROJECT_ROOT, "out", "main", "index.js"))) throw new Error("out/ is missing; run npm run build first.");
  const output = path.join(tmp, "release");
  execFileSync(path.join(PROJECT_ROOT, "node_modules", ".bin", "electron-builder"),
    ["--dir", "--publish", "never", `-c.directories.output=${output}`],
    { cwd: PROJECT_ROOT, stdio: "inherit", env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
  const dir = fs.readdirSync(output).find((name) => name.startsWith("mac") && fs.existsSync(path.join(output, name, "Raoden Loom.app")));
  if (!dir) throw new Error(`Raoden Loom.app was not built below ${output}`);
  return packagedApp(path.join(output, dir, "Raoden Loom.app"));
}

function packagedApp(app) {
  if (!fs.existsSync(path.join(app, "Contents", "MacOS", "Raoden Loom"))) throw new Error(`not a Raoden Loom.app: ${app}`);
  const helpers = path.join(app, "Contents", "Resources", "orchestration");
  const shipped = fs.readdirSync(helpers).sort();
  if (shipped.join() !== HELPERS.join()) throw new Error(`Unexpected orchestration helpers: ${shipped.join(", ")}`);
  return { command: path.join(app, "Contents", "MacOS", "Raoden Loom"), helpers };
}

async function setup() {
  const gitconfig = path.join(tmp, "gitconfig");
  fs.writeFileSync(gitconfig, "");
  const g = (cwd, ...args) => execFileSync(GIT, args, {
    cwd, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  });
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  const root = path.join(tmp, "root");
  const src = path.join(tmp, "src");
  fs.cpSync(FIXTURE, src, { recursive: true });
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => ` ${s}`;\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fixture project");
  const runId = randomUUID();
  const writer = await createRun(root, runId, { goal: "check sandbox smoke" });
  const ws = await createWorkspace({ root, runId, source: src, gitPath: GIT });
  await writer.recordWorkspaceCreated({
    sourcePathSha256: sha(ws.sourcePath), baseline: { commit: ws.baseline.commit, tree: ws.baseline.tree }, head: ws.head
  });
  const deps = checkPreparedDeps({
    lockfileRelPath: "package-lock.json",
    lockfileSha256: sha(fs.readFileSync(path.join(src, "package-lock.json"))),
    nodeModulesPath: path.join(src, "node_modules")
  });
  return { root, runId, writer, ws, deps };
}
