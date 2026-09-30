// S4 of the real series: is the project's own MCP configuration of the form server (release-form,
// tests/fixtures/orchestration/mcp-elicit-server.mjs) loaded by the CLI — found in the project, discovered by the CLI,
// and ready (the server started and answered initialize) — without a model request.
//
//   node scripts/s4-config-probe.mjs --provider claude|codex --dir <project> [--log <MCP_ELICIT_LOG file>]
//   → JSON { configured, discovered, ready, how, evidence, blockedReason? }
//
// Claude: the host control protocol of `claude -p` (initialize, mcp_status; no user message), as «Проверить окружение»
// does (probe.ts); ready = status connected and an initialize line of claude-code in the server's log.
// Codex: app-server config/read (the project layer and why it is disabled) and mcpServerStatus/list. Readiness needs a
// thread (runtime status): thread/start (ephemeral, no turn) runs only when the project layer is already enabled — on a
// project Codex does not trust, thread/start writes trust_level = "trusted" for it into ~/.codex/config.toml (0.155.1),
// which this probe must never cause. The global config files are hashed before and after; a change is reported.
// Nothing is printed from other servers but their count; tokens are redacted.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "release-form";
const redact = (s) => String(s).replace(/(Bearer|token|api[_-]?key)(["'=:\s]+)[^\s"',]+/gi, "$1$2<redacted>");
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const hash = (f) => { try { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch { return null; } };
export const GLOBAL_FILES = [path.join(os.homedir(), ".codex", "config.toml"), path.join(os.homedir(), ".claude", "settings.json")];

// What the project folder itself asks for, and where the server logs.
export function configuredIn(provider, dir) {
  if (provider === "claude") {
    const server = readJson(path.join(dir, ".mcp.json"))?.mcpServers?.[NAME];
    const enabled = [".claude/settings.json", ".claude/settings.local.json"].some((f) => (readJson(path.join(dir, f))?.enabledMcpjsonServers ?? []).includes(NAME));
    return { configured: !!server && enabled, log: server?.env?.MCP_ELICIT_LOG ?? null, detail: `.mcp.json ${server ? "has" : "lacks"} ${NAME}; enabledMcpjsonServers ${enabled ? "includes" : "lacks"} it` };
  }
  let toml = "";
  try { toml = fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf8"); } catch {}
  const has = new RegExp(`^\\[mcp_servers\\.(?:"${NAME}"|${NAME})\\]`, "m").test(toml);
  return { configured: has, log: /MCP_ELICIT_LOG\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? null, detail: `.codex/config.toml ${has ? "has" : "lacks"} [mcp_servers.${NAME}]` };
}

// initialize lines the server logged since `since` for this client.
export function initializeLines(logText, since, provider) {
  const client = provider === "claude" ? "claude-code" : "codex-mcp-client";
  return String(logText ?? "").split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((e) => e.type === "initialize" && Date.parse(e.ts) >= since && e.client?.name === client);
}

// Claude: the mcp item of the environment probe ("name (status), …") and the server's log.
export function claudeVerdict({ mcpValue, probeError, inits }) {
  if (probeError) return { discovered: false, ready: false, blockedReason: `the CLI did not answer: ${redact(probeError)}` };
  const entries = String(mcpValue ?? "").split(/,\s*(?=[^,]+\()/).map((x) => /^(.*) \(([^)]*)\)$/.exec(x.trim())).filter(Boolean);
  const own = entries.find((m) => m[1] === NAME);
  const status = own?.[2] ?? null;
  const ready = status === "connected" && inits.length > 0;
  return { discovered: !!own, ready, status, others: entries.length - (own ? 1 : 0),
    ...(ready ? {} : { blockedReason: !own ? `${NAME} is not among the servers the CLI reports` : status !== "connected" ? `${NAME} is ${status}` : "no initialize in the server's log" }) };
}

// Codex: config/read with layers, mcpServerStatus/list (with a thread when there is one), the server's log.
export function codexVerdict({ dir, config, status, inits, thread }) {
  const layers = config?.layers ?? [];
  const project = layers.find((l) => l.name?.type === "project" && path.resolve(String(l.name.dotCodexFolder ?? "")) === path.join(dir, ".codex"));
  const inEffective = Object.hasOwn(config?.config?.mcp_servers ?? {}, NAME);
  const own = (status?.data ?? []).find((x) => x.name === NAME) ?? null;
  const discovered = inEffective && !!own;
  const ready = discovered && thread && own.runtimeStatus === "connected" && inits.length > 0;
  const blockedReason = project?.disabledReason ? redact(project.disabledReason)
    : !project ? "Codex reports no project layer for this folder"
      : !discovered ? `${NAME} is not in the effective configuration`
        : !thread ? "readiness not checked: no thread was started"
          : !ready ? `${NAME} is ${own.runtimeStatus ?? "without a runtime status"}${inits.length ? "" : ", no initialize in the server's log"}` : null;
  return { discovered, ready: !!ready, projectLayer: project ? { enabled: !project.disabledReason, mcp: Object.keys(project.config?.mcp_servers ?? {}) } : null,
    runtimeStatus: own?.runtimeStatus ?? null, tools: own ? Object.keys(own.tools ?? {}) : [], ...(blockedReason ? { blockedReason } : {}) };
}

// A JSON-RPC conversation with `codex app-server` (as probe.ts), killed at the end.
function appServer(dir) {
  const c = spawn("codex", ["app-server"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let buf = "", next = 1;
  const waiting = new Map();
  c.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.id !== undefined && !m.method && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch {}
    }
  });
  c.on("close", () => { for (const r of waiting.values()) r({ error: { message: "app-server exited" } }); waiting.clear(); });
  c.stdin.on("error", () => {});
  return {
    call: (method, params, ms = 60_000) => new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      setTimeout(() => { if (waiting.delete(id)) resolve({ error: { message: "no answer" } }); }, ms);
      c.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    }),
    notify: (method) => c.stdin.write(`${JSON.stringify({ method })}\n`),
    end: () => { try { process.kill(-c.pid, "SIGKILL"); } catch {} }
  };
}

export async function probe({ provider, dir, log }) {
  dir = fs.realpathSync(dir);
  const conf = configuredIn(provider, dir);
  const logFile = log ?? conf.log;
  const before = Object.fromEntries(GLOBAL_FILES.map((f) => [f, hash(f)]));
  const since = Date.now();
  const readLog = () => { try { return fs.readFileSync(logFile, "utf8"); } catch { return ""; } };
  let verdict, how;
  if (provider === "claude") {
    how = "claude -p --input-format stream-json: control requests initialize and mcp_status (probe.ts probeClaude), no user message";
    const { probeClaude } = await import("../src/main/services/orchestration/probe.ts");
    const r = await probeClaude({ executable: "claude", cwd: dir, env: process.env, timeoutMs: 60_000 });
    const inits = initializeLines(readLog(), since, "claude");
    verdict = { ...claudeVerdict({ mcpValue: r.items.find((i) => i.id === "mcp")?.value, probeError: r.ok ? null : r.error, inits }), initialize: inits.map((e) => ({ ts: e.ts, client: `${e.client.name} ${e.client.version}` })) };
  } else {
    const c = appServer(dir);
    try {
      const init = await c.call("initialize", { clientInfo: { name: "canvastty-s4-probe", title: "CanvasTTY S4 probe", version: "0" }, capabilities: null });
      if (init.error) throw new Error(`initialize: ${init.error.message}`);
      c.notify("initialized");
      const cfg = await c.call("config/read", { includeLayers: true, cwd: dir });
      let status = await c.call("mcpServerStatus/list", { detail: "toolsAndAuthOnly" });
      const first = codexVerdict({ dir, config: cfg.result, status: status.result, inits: [], thread: false });
      let thread = false;
      // only on a folder whose project layer Codex already loads (trusted): then thread/start writes no trust
      if (first.discovered && first.projectLayer?.enabled) {
        const t = await c.call("thread/start", { cwd: dir, ephemeral: true });
        const threadId = t.result?.thread?.id;
        if (threadId) {
          thread = true;
          for (let k = 0; k < 40; k++) {
            status = await c.call("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" });
            if (["connected", "failed", "authenticationRequired", "disabled"].includes(status.result?.data?.find((x) => x.name === NAME)?.runtimeStatus)) break;
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      }
      const inits = initializeLines(readLog(), since, "codex");
      how = `codex app-server: config/read {includeLayers} and mcpServerStatus/list${thread ? " (+ thread/start ephemeral, no turn, on a trusted folder)" : " (no thread: the folder is not trusted or the server not discovered)"}`;
      verdict = { ...codexVerdict({ dir, config: cfg.result, status: status.result, inits, thread }), initialize: inits.map((e) => ({ ts: e.ts, client: `${e.client.name} ${e.client.version}` })),
        ...(cfg.error ? { configError: redact(cfg.error.message) } : {}) };
    } catch (e) {
      how = "codex app-server";
      verdict = { discovered: false, ready: false, blockedReason: redact(e.message) };
    } finally { c.end(); }
  }
  const changed = GLOBAL_FILES.filter((f) => hash(f) !== before[f]);
  const { discovered, ready, blockedReason, ...rest } = verdict;
  return {
    provider, dir, configured: conf.configured, discovered, ready, how,
    evidence: { configured: conf.detail, log: logFile, ...rest, globalFilesChanged: changed },
    ...(blockedReason ? { blockedReason } : {}),
    ...(changed.length ? { warning: `global files changed during the probe: ${changed.join(", ")}` } : {})
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const provider = arg("--provider"), dir = arg("--dir");
  if (!["claude", "codex"].includes(provider) || !dir) { console.error("usage: s4-config-probe.mjs --provider claude|codex --dir <project> [--log <file>]"); process.exit(2); }
  console.log(JSON.stringify(await probe({ provider, dir, log: arg("--log") }), null, 2));
}
