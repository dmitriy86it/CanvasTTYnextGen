// A credential a CLI puts in its answers — an error message, stderr, fields the probe does not ask for — reaches
// neither the person's error nor the series' report and log.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { cliText, probeClaude, probeCodex } from "../src/main/services/orchestration/probe.ts";
import { safeReport } from "../scripts/safe-environment.mjs";
import { s4Gate } from "../scripts/s4-gate.mjs";

const NODE = fs.realpathSync(process.execPath);
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 60_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-secrets-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// made at run time, so this file itself holds nothing a secret scanner (scripts/audit-secrets.mjs) takes for a token
const SK = ["sk", "test", "S3CRET0123456789abcdefXYZ"].join("-");
const GH = ["gh", "p_FAKE0000111122223333444455556666"].join("");
const SECRETS = [SK, "hunter2pw", "pw123secret", GH];
const leaks = (value) => SECRETS.filter((x) => JSON.stringify(value ?? null).includes(x));

function fake(name, body) {
  const js = path.join(TMP, `${name}.mjs`);
  fs.writeFileSync(js, `import readline from "node:readline";\nconst out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");\n` +
    `process.stderr.write("fatal: token ${SK} password=hunter2pw\\n");\n${body}`);
  const exe = path.join(TMP, name);
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${NODE}" "${js}" "$@"\n`, { mode: 0o755 });
  return exe;
}
const run = (exe, probe, ready) => probe({ executable: exe, cwd: TMP, env: { PATH: process.env.PATH }, timeoutMs: 5000 }, ready);

test("cliText masks credentials in a CLI's words", () => {
  const t = cliText(`401: Authorization: Bearer ${SK} at https://u:pw123secret@mcp.example.com password=hunter2pw ${GH}`);
  assert.deepEqual(leaks(t), [], t);
  assert.match(t, /^401/);
});

test("Codex: secrets in errors, stderr and unasked fields stay out of the result", OPTS, async () => {
  const exe = fake("codex-secrets", `
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l); if (m.id === undefined) return;
  const leak = { env: { API_KEY: "${SK}" }, headers: { Authorization: "Bearer ${GH}" }, url: "https://u:pw123secret@mcp.example.com" };
  const R = {
    initialize: {},
    "config/read": m.params?.includeLayers ? { config: { mcp_servers: { "release-form": leak } }, layers: [{ name: { type: "project", dotCodexFolder: ${JSON.stringify(TMP)} + "/.codex" }, config: { mcp_servers: { "release-form": leak } }, disabledReason: "untrusted; token=hunter2pw" }] } : { config: { model: "gpt", mcp_servers: { x: leak } } },
    "mcpServerStatus/list": { data: [{ name: "release-form", authStatus: "unsupported", ...leak, tools: { release_ticket: { description: "uses ${SK}" } } }] }
  }[m.method];
  out(R ? { id: m.id, result: R } : { id: m.id, error: { code: -1, message: "denied: password=hunter2pw, Bearer ${SK}" } });
});`);
  const r = await run(exe, probeCodex, "release-form");
  assert.equal(r.ok, true);
  assert.deepEqual(leaks(r), [], JSON.stringify(r));
  assert.equal(r.items.find((i) => i.id === "skills").confirmed, false, "the failed list is shown as not confirmed");
  assert.deepEqual(leaks(safeReport({ providers: [{ provider: "codex", ...r }] })), []);
});

test("Codex and Claude: a failed start shows no stderr and no secret in the person's error", OPTS, async () => {
  const codex = fake("codex-dies", `
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l); if (m.id === undefined) return;
  out({ id: m.id, error: { code: -1, message: "cannot start: https://u:pw123secret@example.com api_key=${GH}" } });
});`);
  const c = await run(codex, probeCodex);
  assert.equal(c.ok, false);
  assert.match(c.error, /^initialize: cannot start/);
  assert.deepEqual(leaks(c), [], c.error);
  const claude = fake("claude-dies", `
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.type === "control_request") out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "auth: Bearer ${SK}" } });
});`);
  const k = await run(claude, probeClaude);
  assert.equal(k.ok, false);
  assert.deepEqual(leaks(k), [], k.error);
});

test("Claude: an mcp_status with secrets in unasked fields keeps names and states only", OPTS, async () => {
  const exe = fake("claude-secrets", `
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l); if (m.type !== "control_request") return;
  const ok = (response) => out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
  if (m.request.subtype === "initialize") ok({ commands: [], agents: [], models: [], account: { subscriptionType: "max", apiKey: "${SK}" } });
  else ok({ mcpServers: [{ name: "release-form", status: "connected", config: { env: { TOKEN: "${GH}" }, url: "https://u:pw123secret@x" }, tools: [{ name: "release_ticket" }] }] });
});`);
  const r = await run(exe, probeClaude);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.find((i) => i.id === "mcp").servers, [{ name: "release-form", connection: "connected", auth: null, tools: ["release_ticket"] }]);
  assert.deepEqual(leaks(r), []);
});

test("the series: report fields and gate reasons carry no CLI words", () => {
  const report = { providers: [{ provider: "codex", ok: false, error: "initialize: token=hunter2pw", items: [{ id: "skills", value: SK, confirmed: false, note: `Bearer ${GH}` }],
    readiness: { server: "release-form", projectLayer: "disabled", disabledReason: "untrusted pw123secret", inProjectLayer: true, inConfig: true, threadStarted: false, status: null, error: "thread/start: api_key=hunter2pw" } }] };
  assert.deepEqual(leaks(safeReport(report)), []);
  const g = s4Gate({ provider: "codex", report, logText: "", since: 0, client: "codex-mcp-client" });
  assert.equal(g.ok, false);
  assert.deepEqual(leaks(g), [], JSON.stringify(g.reasons));
});

test("S7 compares names from the fields: a server whose connection is not checked stays in", async () => {
  const { mcpNames } = await import("../scripts/safe-environment.mjs");
  const safe = safeReport({ providers: [{ provider: "codex", ok: true, items: [{ id: "mcp", value: "a (connection not checked), b (connected)", confirmed: true,
    servers: [{ name: "a", connection: null, auth: "unsupported", tools: [] }, { name: "b", connection: "connected", auth: null, tools: ["t"] }] }] }] });
  assert.deepEqual(mcpNames(safe, "codex"), ["a", "b"]);
  assert.deepEqual(mcpNames(safe, "claude"), []);
});
