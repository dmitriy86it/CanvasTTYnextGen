// "Stop and hide" on the real CloseDialog (docs/agent-orchestration/implementation/workspaces-spec.md §5): the real
// TerminalManager in Electron's main with a fake PTY, orchestration answers controlled by the page. Covers a partial
// refusal (one terminal's signal fails), a signal without an exit, a run whose state cannot be read, new work during
// the stop, and an explicit hide that stops nothing. No real CLI, model or user data; a temporary build directory.
// Usage: node scripts/smoke-workspaces-close.mjs [--out <dir>]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { build } from "esbuild";
import { step, watch } from "./smoke-watchdog.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outArg = process.argv.indexOf("--out");
const DIR = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), "ws-close-"));
fs.mkdirSync(DIR, { recursive: true });
const H = path.join(ROOT, "scripts", "workspaces-close-harness");
await build({ entryPoints: [path.join(H, "main.ts")], outfile: path.join(DIR, "main.cjs"), bundle: true, platform: "node", format: "cjs",
  external: ["electron"], alias: { "node-pty": path.join(H, "no-pty.ts") }, logLevel: "error" });
await build({ entryPoints: [path.join(H, "page.tsx")], outfile: path.join(DIR, "page.js"), bundle: true, platform: "browser", format: "iife",
  jsx: "automatic", loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".ico": "dataurl", ".jpg": "dataurl", ".webp": "dataurl", ".gif": "dataurl" }, define: { "process.env.NODE_ENV": "\"production\"" }, logLevel: "error" });
fs.writeFileSync(path.join(DIR, "preload.js"), `const { ipcRenderer } = require("electron");
window.hipc = { invoke: (...a) => ipcRenderer.invoke(...a), on: (ch, fn) => ipcRenderer.on(ch, (_e, p) => fn(p)) };\n`);
fs.writeFileSync(path.join(DIR, "index.html"), `<!doctype html><meta charset="utf-8"><title>close harness</title><div id="root"></div><script src="page.js"></script>\n`);
step("launch the close harness");
const child = spawn(electronPath, [path.join(DIR, "main.cjs"), `--user-data-dir=${path.join(DIR, "user-data")}`],
  { env: { ...process.env, HARNESS_DIR: DIR }, stdio: ["ignore", "pipe", "pipe"] });
watch(child);
let out = "", err = "";
child.stdout.on("data", (c) => { out += c; });
child.stderr.on("data", (c) => { err += c; });
const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
const code = await new Promise((r) => child.once("exit", (c) => r(c)));
clearTimeout(timer);
const line = out.trim().split("\n").reverse().find((l) => l.startsWith("{"));
const result = line ? JSON.parse(line) : { ok: false, failures: [{ name: "no result", got: err.slice(-2000) }] };
fs.writeFileSync(path.join(DIR, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, electronExit: code, dir: DIR }, null, 2));
process.exitCode = result.ok && code === 0 ? 0 : 1;
