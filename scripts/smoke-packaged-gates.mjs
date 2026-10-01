// Packaged gates (stage 10): what a packaged Raoden Loom.app must not carry or honour. macOS; nothing is built here.
//   1. contents: no docs, tests, fixtures, fake CLIs, test agents, E2E or smoke drivers in Resources or app.asar;
//      orchestration/ holds only supervisor.mjs and sandbox-probe.mjs;
//   2. the bundled main (app.asar/out/main/index.js): the test providers, the IPC smoke and the dropped replies are
//      read only through developmentEnv(), and developmentEnv() returns undefined when app.isPackaged;
//   3. behaviour: the app started with all three variables set (temporary --user-data-dir and HOME) does not run the
//      IPC smoke (no marker, it does not quit) and starts none of the fake CLIs the variables point at.
// Starts no model and no provider CLI. Usage: node scripts/smoke-packaged-gates.mjs --app <path/Raoden Loom.app>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { step, watch } from "./smoke-watchdog.mjs";

const appArg = process.argv.indexOf("--app");
if (appArg < 0) throw new Error("usage: --app <path/Raoden Loom.app>");
const APP = fs.realpathSync(path.resolve(process.argv[appArg + 1]));
const RESOURCES = path.join(APP, "Contents", "Resources");
const BIN = path.join(APP, "Contents", "MacOS", "Raoden Loom");
const NAMES = ["CANVASTTY_ORCHESTRATION_TEST_PROVIDERS", "CANVASTTY_ORCHESTRATION_IPC_SMOKE", "CANVASTTY_ORCHESTRATION_TEST_DROP_REPLIES"];
const failures = [];
const report = { app: APP };
const expect = (ok, what, got) => { if (!ok) failures.push(`${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// asar: [pickle 8 bytes: 4, headerSize][header pickle: payload size at +4 of it, JSON]; file data after 8 + headerSize.
function asar(file) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const json = Buffer.alloc(head.readUInt32LE(12));
  fs.readSync(fd, json, 0, json.length, 16);
  const tree = JSON.parse(json.toString("utf8"));
  const paths = [];
  const walk = (node, base) => { for (const [name, child] of Object.entries(node.files ?? {})) { paths.push(base + name); if (child.files) walk(child, `${base}${name}/`); } };
  walk(tree, "");
  const read = (rel) => {
    const entry = rel.split("/").reduce((n, part) => n.files[part], tree);
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, 8 + headerSize + Number(entry.offset));
    return buf.toString("utf8");
  };
  return { paths, read, close: () => fs.closeSync(fd) };
}

// ---- 1. contents ----
const archive = asar(path.join(RESOURCES, "app.asar"));
const resourceFiles = fs.readdirSync(RESOURCES, { recursive: true }).map((p) => p.split("\\").join("/"));
const all = [...resourceFiles, ...archive.paths.map((p) => `app.asar/${p}`)];
const FORBIDDEN = [/(^|\/)docs(\/|$)/, /(^|\/)tests?(\/|$)/, /(^|\/)fixtures(\/|$)/, /(^|\/)mock-[^/]*$/, /test-agents/, /chaos-crash|store-crash|reaper-/,
  /(^|\/)scripts(\/|$)/, /e2e-orchestration|orchestration-app-kit|smoke-[^/]*\.mjs$/, /check-project|series-project/];
const forbidden = all.filter((p) => !p.includes("/node_modules/") && FORBIDDEN.some((r) => r.test(p)));
report.contents = { resourceFiles: resourceFiles.length, asarEntries: archive.paths.length, orchestration: fs.readdirSync(path.join(RESOURCES, "orchestration")).sort() };
expect(forbidden.length === 0, "no docs, tests, fixtures, fake CLIs or test drivers in the package", forbidden.slice(0, 20));
expect(report.contents.orchestration.join() === "sandbox-probe.mjs,supervisor.mjs", "orchestration/ holds only the two helpers", report.contents.orchestration);

// ---- 2. the bundled main ----
const main = archive.read("out/main/index.js");
archive.close();
const gate = /function developmentEnv\(name\) \{\s*return app\.isPackaged \? void 0 : process\.env\[name\];\s*\}/.test(main);
const reads = Object.fromEntries(NAMES.map((n) => {
  const lines = main.split("\n").filter((l) => l.includes(n) && !l.includes(`${n}_READY`));
  return [n, { lines: lines.length, viaDevelopmentEnv: lines.length > 0 && lines.every((l) => l.includes(`developmentEnv("${n}")`)) }];
}));
report.bundle = { developmentEnvGate: gate, reads };
expect(gate, "developmentEnv() returns undefined when packaged (bundled main)", null);
for (const n of NAMES) expect(reads[n].viaDevelopmentEnv, `${n} is read only through developmentEnv (bundled main)`, reads[n]);

// ---- 3. behaviour ----
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-gates-")));
try {
  const ledger = path.join(tmp, "fake-cli-started");
  const fake = path.join(tmp, "fake-cli");
  fs.writeFileSync(fake, `#!/bin/sh\necho "$0 $*" >> "${ledger}"\nexit 1\n`, { mode: 0o755 });
  const providers = path.join(tmp, "providers.json");
  fs.writeFileSync(providers, JSON.stringify({ codex: { executable: fake, version: "codex-cli 0.155.1", path: "/usr/bin:/bin", env: {} },
    claude: { executable: fake, version: "2.1.281 (Claude Code)", path: "/usr/bin:/bin", env: {} } }));
  fs.mkdirSync(path.join(tmp, "drop"));
  for (const k of ["stop", "resume", "recover"]) fs.writeFileSync(path.join(tmp, "drop", k), "");
  fs.mkdirSync(path.join(tmp, "home"));
  const env = { PATH: "/usr/bin:/bin", HOME: path.join(tmp, "home"), TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: process.env.LANG ?? "en_US.UTF-8",
    CANVASTTY_ORCHESTRATION_TEST_PROVIDERS: providers, CANVASTTY_ORCHESTRATION_IPC_SMOKE: path.join(tmp, "ipc-smoke-script.mjs"),
    CANVASTTY_ORCHESTRATION_TEST_DROP_REPLIES: path.join(tmp, "drop") };
  step("launch the packaged app");
  const child = watch(spawn(BIN, [`--user-data-dir=${path.join(tmp, "user-data")}`], { env, stdio: ["ignore", "pipe", "pipe"] }));
  let out = "";
  child.stdout.on("data", (c) => { out = (out + c).slice(-64 * 1024); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-64 * 1024); });
  let exit = null;
  child.once("exit", (code, signal) => { exit = { code, signal }; });
  await sleep(15_000);
  const runningAfter15s = exit === null;
  child.kill("SIGTERM");
  for (let i = 0; i < 100 && exit === null; i++) await sleep(200);
  if (exit === null) child.kill("SIGKILL");
  report.behaviour = {
    runningAfter15s, exit, ipcSmokeMarker: out.includes("CANVASTTY_ORCHESTRATION_IPC_SMOKE_READY"),
    fakeCliStarted: fs.existsSync(ledger), dropFilesLeft: fs.readdirSync(path.join(tmp, "drop")).length,
    userDataCreated: fs.existsSync(path.join(tmp, "user-data"))
  };
  expect(runningAfter15s && !report.behaviour.ipcSmokeMarker, "the IPC smoke variable is ignored: no marker, the app keeps running", report.behaviour);
  expect(!report.behaviour.fakeCliStarted, "no fake CLI from the test providers variable was started", report.behaviour);
  expect(report.behaviour.userDataCreated, "the app used the temporary --user-data-dir", report.behaviour);
  if (!runningAfter15s) report.behaviour.output = out.slice(-4000);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
report.ok = failures.length === 0;
report.failures = failures;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failures.length ? 1 : 0;
