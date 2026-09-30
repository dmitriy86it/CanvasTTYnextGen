// One diagnostic probe of Codex for a project, on the application's own path: the CLI the app resolves
// (createProviderCliRegistry), the environment it builds (nativeRuntime: the login shell in the project folder, direnv
// off as in a new profile) and probeCodex itself — without Claude, a thread, a turn or an MCP tool call.
//   node scripts/codex-probe-diagnostic.mjs <project> <out.json> [--limit-ms 90000]
// The probe's own deadline is the limit (at most 90 s), then only the bounded ending of its processes. Printed and
// written: the safe fields only (safe-environment.mjs) — the timing of each request, the MCP item's completeness and
// server names; never parameters, configuration, the CLI's output or error text.
import fs from "node:fs";
import { createProviderCliRegistry } from "../src/main/services/providerCliRegistry.ts";
import { nativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { probeCodex } from "../src/main/services/orchestration/probe.ts";
import { AGENT_BROWSER_ENV } from "../src/main/services/agent-browser/protocol.ts";
import { AGENT_RUNTIME_ENV } from "../src/agent-runtime/runtime-protocol.mjs";
import { safeReport } from "./safe-environment.mjs";

const [project, outFile] = process.argv.slice(2);
const i = process.argv.indexOf("--limit-ms");
const limitMs = i > 0 ? Number(process.argv[i + 1]) : 90_000;
if (!project || !outFile || !(limitMs > 0 && limitMs <= 90_000)) throw new Error("usage: <project> <out.json> [--limit-ms <= 90000]");

// terminalEnvironment() of TerminalManager.ts (not imported: it loads node-pty, built for Electron)
const reserved = new Set([...Object.values(AGENT_BROWSER_ENV), ...Object.values(AGENT_RUNTIME_ENV)]);
const baseEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => typeof v === "string" && !reserved.has(k)
  && !k.startsWith("CANVASTTY_PLUGIN_HOOK_") && k !== "CANVASTTY_LIFECYCLE_HOOKS_ENABLED" && k !== "ELECTRON_RUN_AS_NODE")), TERM: "xterm-256color", COLORTERM: "truecolor" });

const t0 = performance.now();
const rt = await nativeRuntime({ clis: createProviderCliRegistry(), launch: () => ({}), baseEnv, clientVersion: JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version })(project);
const runtimeMs = Math.round(performance.now() - t0);
const p0 = performance.now();
const r = await probeCodex({ executable: rt.executables.codex, cwd: project, env: rt.env, timeoutMs: limitMs });
const probeMs = Math.round(performance.now() - p0); // with the ending of the processes
const safe = safeReport({ providers: [{ provider: "codex", ...r }] }).providers[0];
const mcp = safe.items.find((x) => x.id === "mcp");
const out = { versions: { codex: rt.versions.codex.split("\n")[0].slice(0, 40) }, direnv: rt.direnv, runtimeMs, probeMs, limitMs: safe.limitMs, ok: safe.ok,
  mcp: { confirmed: mcp?.confirmed ?? false, complete: mcp?.complete ?? null, incomplete: mcp?.incomplete ?? null, servers: (mcp?.servers ?? []).map((x) => ({ name: x.name, connection: x.connection, auth: x.auth, tools: x.tools.length })) },
  items: safe.items.map((x) => ({ id: x.id, confirmed: x.confirmed })), timing: safe.timing };
fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
