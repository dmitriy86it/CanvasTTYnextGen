// The S4 config probe (scripts/s4-config-probe.mjs) without any CLI: what the project folder asks for, and the verdicts
// from answers shaped like those of Claude Code 2.1.283 (mcp_status) and codex-cli 0.155.1 (config/read, mcpServerStatus/list).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { claudeVerdict, codexVerdict, configuredIn, initializeLines } from "../scripts/s4-config-probe.mjs";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s4-probe-test-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const put = (f, text) => { fs.mkdirSync(path.dirname(path.join(TMP, f)), { recursive: true }); fs.writeFileSync(path.join(TMP, f), text); };

test("configured: Claude needs the server in .mcp.json and enabled; Codex the table in .codex/config.toml", () => {
  put(".mcp.json", JSON.stringify({ mcpServers: { "release-form": { command: "node", args: ["s.mjs"], env: { MCP_ELICIT_LOG: "/x/log.jsonl" } } } }));
  assert.equal(configuredIn("claude", TMP).configured, false, "listed, not enabled");
  put(".claude/settings.json", JSON.stringify({ enabledMcpjsonServers: ["release-form"] }));
  assert.deepEqual([configuredIn("claude", TMP).configured, configuredIn("claude", TMP).log], [true, "/x/log.jsonl"]);
  assert.equal(configuredIn("codex", TMP).configured, false);
  put(".codex/config.toml", `[mcp_servers.release-form]\ncommand = "node"\nenv = { MCP_ELICIT_LOG = "/y/log.jsonl" }\n`);
  assert.deepEqual([configuredIn("codex", TMP).configured, configuredIn("codex", TMP).log], [true, "/y/log.jsonl"]);
});

const since = Date.parse("2026-09-26T16:00:00Z");
const LOG = [
  { ts: "2026-09-26T15:59:00Z", type: "initialize", client: { name: "claude-code", version: "2.1.283" } },
  { ts: "2026-09-26T16:01:00Z", type: "initialize", client: { name: "claude-code", version: "2.1.283" } },
  { ts: "2026-09-26T16:02:00Z", type: "initialize", client: { name: "codex-mcp-client", version: "0.155.1" } }
].map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n";

test("initialize lines: only this client's, only since the probe began", () => {
  assert.equal(initializeLines(LOG, since, "claude").length, 1);
  assert.equal(initializeLines(LOG, since, "codex").length, 1);
  assert.equal(initializeLines("", since, "codex").length, 0);
});

test("Claude: ready only when connected and the server logged initialize", () => {
  const inits = initializeLines(LOG, since, "claude");
  const all = "plugin:context7:context7 (pending), obsidian (failed), release-form (connected), claude.ai Gmail (pending)";
  assert.deepEqual(claudeVerdict({ mcpValue: all, inits }), { discovered: true, ready: true, status: "connected", others: 3 });
  assert.equal(claudeVerdict({ mcpValue: all, inits: [] }).blockedReason, "no initialize in the server's log");
  assert.equal(claudeVerdict({ mcpValue: "release-form (pending)", inits }).blockedReason, "release-form is pending");
  assert.deepEqual([claudeVerdict({ mcpValue: "obsidian (failed)", inits }).discovered, claudeVerdict({ mcpValue: "0", inits }).ready], [false, false]);
  assert.match(claudeVerdict({ probeError: "initialize: no answer", inits }).blockedReason, /did not answer/);
});

const layer = (dir, disabledReason) => ({ name: { type: "project", dotCodexFolder: `${dir}/.codex` }, config: { mcp_servers: { "release-form": {} } }, ...(disabledReason ? { disabledReason } : {}) });
const STATUS = (runtimeStatus) => ({ data: [{ name: "context7", runtimeStatus }, { name: "release-form", runtimeStatus, tools: { release_ticket: {} } }] });

test("Codex: an untrusted folder is blocked with Codex's own reason; a trusted one is ready only with a thread, connected and initialize", () => {
  const why = `To load project-local config, hooks, and exec policies, add ${TMP} as a trusted project in ~/.codex/config.toml.`;
  const untrusted = codexVerdict({ dir: TMP, config: { config: { mcp_servers: { context7: {} } }, layers: [layer(TMP, why)] }, status: { data: [{ name: "context7" }] }, inits: [], thread: false });
  assert.deepEqual([untrusted.discovered, untrusted.ready, untrusted.blockedReason, untrusted.projectLayer], [false, false, why, { enabled: false, mcp: ["release-form"] }]);
  const trusted = { config: { mcp_servers: { "release-form": {} } }, layers: [layer(TMP)] };
  const inits = initializeLines(LOG, since, "codex");
  assert.equal(codexVerdict({ dir: TMP, config: trusted, status: STATUS(null), inits, thread: false }).blockedReason, "readiness not checked: no thread was started");
  const ok = codexVerdict({ dir: TMP, config: trusted, status: STATUS("connected"), inits, thread: true });
  assert.deepEqual([ok.discovered, ok.ready, ok.tools, ok.blockedReason], [true, true, ["release_ticket"], undefined]);
  assert.match(codexVerdict({ dir: TMP, config: trusted, status: STATUS("failed"), inits: [], thread: true }).blockedReason, /release-form is failed, no initialize/);
  assert.equal(codexVerdict({ dir: TMP, config: { layers: [] }, status: null, inits, thread: false }).blockedReason, "Codex reports no project layer for this folder");
});
