// Orchestration smoke: starts CanvasTTY with CANVASTTY_ORCHESTRATION_SMOKE=1 (a fixed built-in /bin/sh mock, no real
// provider CLI) and checks the result marker. Default: the development build (`npm run build` first).
// --packaged: the unpacked application in release/ (`npm run package` first), plus a look at what it ships.
// --packaged --app <path/Raoden Loom.app | linux-unpacked dir>: that application instead of the one in release/.
// A temporary --user-data-dir and HOME keep the user's profile untouched.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const READY_MARKER = "CANVASTTY_ORCHESTRATION_SMOKE_READY ";
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const PASS_ENV = ["PATH", "TMPDIR", "LANG", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"];
const packaged = process.argv.includes("--packaged");
const appArg = process.argv.indexOf("--app");
const explicitApp = appArg > 0 ? resolve(process.argv[appArg + 1] ?? "") : null;
if (explicitApp && !packaged) throw new Error("--app needs --packaged");

if (process.platform !== "darwin" && process.platform !== "linux") {
  throw new Error("The orchestration smoke runs on macOS and Linux only.");
}

const electronVersion = JSON.parse(readFileSync(join(PROJECT_ROOT, "node_modules/electron/package.json"), "utf8")).version;
process.stdout.write(`Orchestration smoke: mode=${packaged ? "packaged" : "development"} node=${process.version} electron=${electronVersion} platform=${process.platform}-${process.arch} os=${release()}\n`);

const root = await mkdtemp(join(tmpdir(), "canvastty-orchestration-"));
try {
  let command = electronPath;
  let args = [PROJECT_ROOT];
  let resources = null;
  if (packaged) {
    ({ command, resources } = packagedApplication());
    args = [];
    const shipped = await inspectPackage(resources);
    process.stdout.write(`Packaged app: ${command}\nPackaged helper: ${shipped.helper}; asar entries: ${shipped.asarEntries}; resource files: ${shipped.resourceFiles}\n`);
  }
  args.push(`--user-data-dir=${join(root, "user-data")}`, "--disable-gpu");
  // As in smoke-browser-electron: hosted Linux runners cannot install a root-owned chrome-sandbox.
  if (process.platform === "linux" && process.env.CI === "true") args.push("--no-sandbox");

  const env = { HOME: join(root, "home"), CANVASTTY_ORCHESTRATION_SMOKE: "1" };
  for (const name of PASS_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  const report = await runSmoke(command, args, env);
  const failures = verify(report, resources);
  process.stdout.write(`${READY_MARKER}${JSON.stringify(report)}\n`);
  if (failures.length) throw new Error(`Orchestration smoke failed: ${failures.join("; ")}`);
  process.stdout.write(`Orchestration smoke passed (${packaged ? "packaged" : "development"}).\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

// The marker's own ok is re-checked field by field, so a smoke that silently skips a check cannot pass.
function verify(report, resources) {
  const failures = [...(report.ok ? [] : [`smoke reported ok:false (${report.failures?.join("; ")})`])];
  const check = (condition, what) => { if (!condition) failures.push(what); };
  const [first, second] = report.turns ?? [];
  check(first?.outcome === "completed" && first.delivery === "ok" && first.report === "valid", "turn 1 not completed/ok/valid");
  check(report.answer?.bytes === report.expected?.bytes && report.answer?.cksum === report.expected?.cksum, "task length/cksum mismatch");
  check(report.answer?.envLeak === false, "CLI environment leak");
  check(second?.outcome === "stopped", "turn 2 not stopped");
  for (const turn of [first, second]) {
    check(turn?.groupCleared === true && turn.pidsGone === true, "group not cleared or pids alive");
    for (const pid of [turn?.pids.supervisor, turn?.pids.pgid && -turn.pids.pgid]) {
      if (!pid) continue;
      try { process.kill(pid, 0); failures.push(`pid ${pid} still alive`); } catch (error) { if (error.code !== "ESRCH") failures.push(`pid ${pid}: ${error.code}`); }
    }
  }
  if (resources) check(report.helperPath === join(resources, "orchestration", "supervisor.mjs"), `helper path ${report.helperPath}`);
  return failures;
}

function packagedApplication() {
  if (explicitApp) {
    if (!existsSync(explicitApp)) throw new Error(`--app ${explicitApp} does not exist`);
    const app = realpathSync(explicitApp); // the app reports its helper by real path (/tmp is /private/tmp on macOS)
    return process.platform === "linux"
      ? { command: join(app, "canvastty"), resources: join(app, "resources") }
      : { command: join(app, "Contents", "MacOS", "Raoden Loom"), resources: join(app, "Contents", "Resources") };
  }
  const release = join(PROJECT_ROOT, "release");
  if (process.platform === "linux") {
    const unpacked = join(release, "linux-unpacked");
    return { command: join(unpacked, "canvastty"), resources: join(unpacked, "resources") };
  }
  const dir = readdirSync(release).find((name) => name.startsWith("mac") && existsSync(join(release, name, "Raoden Loom.app")));
  if (!dir) throw new Error(`Raoden Loom.app was not found below ${release}; run npm run package first.`);
  const app = join(release, dir, "Raoden Loom.app");
  return { command: join(app, "Contents", "MacOS", "Raoden Loom"), resources: join(app, "Contents", "Resources") };
}

// The helper is where the app resolves it, and neither the resources nor app.asar carry docs, test fixtures or mocks.
async function inspectPackage(resources) {
  const helper = join(resources, "orchestration", "supervisor.mjs");
  if (!existsSync(helper)) throw new Error(`Packaged helper missing: ${helper}`);
  const helperDir = await readdir(join(resources, "orchestration"));
  // supervisor.mjs (turns and checks) and sandbox-probe.mjs (the check sandbox self-test), nothing else.
  if (helperDir.sort().join() !== "sandbox-probe.mjs,supervisor.mjs") throw new Error(`Unexpected files in orchestration/: ${helperDir.join(", ")}`);
  const resourceFiles = (await readdir(resources, { recursive: true })).map((p) => p.split("\\").join("/"));
  const asarEntries = await asarPaths(join(resources, "app.asar"));
  const forbidden = [...resourceFiles, ...asarEntries.map((p) => `app.asar/${p}`)].filter((p) =>
    /(^|\/)docs(\/|$)/.test(p) || /(^|\/)tests\/fixtures(\/|$)/.test(p) || /(^|\/)mock-[^/]*$/.test(p));
  if (forbidden.length) throw new Error(`Package ships forbidden paths: ${forbidden.slice(0, 20).join(", ")}`);
  return { helper, asarEntries: asarEntries.length, resourceFiles: resourceFiles.length };
}

// asar header: 16-byte pickle prefix, the JSON length at offset 12, then the JSON file tree.
async function asarPaths(file) {
  const handle = await open(file, "r");
  try {
    const prefix = Buffer.alloc(16);
    await handle.read(prefix, 0, 16, 0);
    const json = Buffer.alloc(prefix.readUInt32LE(12));
    await handle.read(json, 0, json.length, 16);
    const paths = [];
    const walk = (node, base) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        paths.push(base + name);
        if (child.files) walk(child, `${base}${name}/`);
      }
    };
    walk(JSON.parse(json.toString("utf8")), "");
    return paths;
  } finally {
    await handle.close();
  }
}

async function runSmoke(command, args, env) {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const consume = (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT_BYTES); };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const result = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Orchestration smoke timed out.\n${output.slice(-16_384)}`));
    }, TIMEOUT_MS);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
  });
  const markerIndex = output.lastIndexOf(READY_MARKER);
  if (markerIndex === -1) {
    throw new Error(`Orchestration smoke marker was missing (code=${result.code}, signal=${result.signal}).\n${runtimeHints(output)}${output.slice(-16_384)}`);
  }
  const report = JSON.parse(output.slice(markerIndex + READY_MARKER.length).split(/\r?\n/u, 1)[0]);
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`Orchestration smoke exited unsuccessfully (code=${result.code}, signal=${result.signal}): ${JSON.stringify(report)}`);
  }
  return report;
}

// Names what the Electron runtime itself reported before the marker; the smoke still fails, nothing is skipped.
function runtimeHints(output) {
  const hints = [];
  if (output.includes("sandbox initialization failed")) {
    hints.push("Chromium could not initialize its own sandbox (reproduced when this smoke runs inside another Seatbelt sandbox, e.g. sandbox-exec); the run ended before the orchestration hook reported, so it says nothing about orchestration");
  }
  const fatal = output.split(/\r?\n/u).filter((line) => line.includes(":FATAL:")).slice(0, 3);
  for (const line of fatal) hints.push(`Electron FATAL: ${line.slice(0, 300)}`);
  return hints.length ? `Runtime diagnostics:\n${hints.map((hint) => `- ${hint}`).join("\n")}\n---\n` : "";
}
