// MCP servers in the environment probe: found, connection, sign-in and tools apart; Codex's readiness of one project
// server (a trusted folder only, an ephemeral thread without a turn); the S4 gate before any model turn.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { codexMcpServers, codexProjectLayer, probeCodex } from "../src/main/services/orchestration/probe.ts";
import { freshInitialize, s4Gate } from "../scripts/s4-gate.mjs";

const NODE = fs.realpathSync(process.execPath);
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 60_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-mcp-ready-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("authStatus is sign-in, never the connection: without runtimeStatus the connection is not checked", () => {
  assert.deepEqual(codexMcpServers([{ name: "release-form", authStatus: "unsupported" }]), [{ name: "release-form", connection: null, auth: "unsupported", tools: [] }]);
  assert.deepEqual(codexMcpServers([{ name: "a", runtimeStatus: "connected", authStatus: "unsupported", tools: { release_ticket: {} } }]),
    [{ name: "a", connection: "connected", auth: "unsupported", tools: ["release_ticket"] }]);
  assert.deepEqual(codexMcpServers([{ name: "b", tools: [{ name: "x" }, "y"] }])[0].tools, ["x", "y"]);
});

test("the project layer: this folder's .codex only, disabled with Codex's reason", () => {
  const cwd = "/p/app";
  assert.deepEqual(codexProjectLayer([{ name: { type: "project", dotCodexFolder: "/p/app/.codex" } }], cwd), { state: "enabled", disabledReason: null, mcpServers: [] });
  assert.deepEqual(codexProjectLayer([{ name: { type: "project", dotCodexFolder: "/p/app/.codex" }, disabledReason: "add it as trusted" }], cwd), { state: "disabled", disabledReason: "add it as trusted", mcpServers: [] });
  assert.equal(codexProjectLayer([{ name: { type: "project", dotCodexFolder: "/p/other/.codex" } }, { name: { type: "user" } }], cwd).state, "absent");
  for (const why of [true, 1, { reason: "untrusted" }]) assert.equal(codexProjectLayer([{ name: { type: "project", dotCodexFolder: "/p/app/.codex" }, disabledReason: why }], cwd).state, "disabled", JSON.stringify(why));
});

// A fake codex app-server answering as 0.155.1 does: no runtimeStatus without a thread, the thread's list with it.
// FAKE: trusted | untrusted | notool | failed | slow | noconfig | page2 | pageerr | loop; every method is logged to calls.log.
function fakeCodex(mode) {
  const dir = fs.mkdtempSync(path.join(TMP, `${mode}-`));
  fs.mkdirSync(path.join(dir, ".codex"));
  const js = path.join(dir, "fake.mjs");
  fs.writeFileSync(js, `
import fs from "node:fs"; import readline from "node:readline";
const mode = ${JSON.stringify(mode)}, cwd = ${JSON.stringify(dir)};
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l); if (m.id === undefined) return;
  fs.appendFileSync(cwd + "/calls.log", m.method + " " + JSON.stringify(m.params ?? {}) + "\\n");
  const p = m.params ?? {};
  const layer = { name: { type: "project", dotCodexFolder: cwd + "/.codex" }, config: { mcp_servers: mode === "noconfig" ? {} : { "release-form": {} } }, ...(mode === "untrusted" ? { disabledReason: "add " + cwd + " as a trusted project" } : {}) };
  const inConfig = mode !== "untrusted" && mode !== "noconfig";
  const entry = p.threadId
    ? { name: "release-form", authStatus: "unsupported", runtimeStatus: mode === "failed" ? "failed" : mode === "slow" ? "starting" : "connected", tools: mode === "notool" ? {} : { release_ticket: {} } }
    : { name: "release-form", authStatus: "unsupported" };
  const R = {
    initialize: {},
    "config/read": { config: { model: "gpt", ...(inConfig ? { mcp_servers: { "release-form": {} } } : {}) }, ...(p.includeLayers ? { layers: [{ name: { type: "user" } }, layer] } : {}) },
    // paged modes: another server first; release-form on page 2 (page2), page 2 fails (pageerr), the cursor loops (loop)
    "mcpServerStatus/list": mode === "page2" || mode === "pageerr" || mode === "loop"
      ? (!p.cursor ? { data: [{ name: "other", authStatus: "unsupported" }], nextCursor: "c2" }
        : mode === "loop" ? { data: [{ name: "other2" }], nextCursor: "c2" }
        : mode === "pageerr" ? undefined
        : { data: [entry], nextCursor: null })
      : { data: inConfig ? [entry] : [] },
    "thread/start": { thread: { id: "t1" } }
  }[m.method];
  out(R ? { id: m.id, result: R } : { id: m.id, error: { code: -32601, message: "method not found" } });
});`);
  const exe = path.join(dir, "codex");
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${NODE}" "${js}" "$@"\n`, { mode: 0o755 });
  const calls = () => fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n");
  return { dir, run: (ready) => probeCodex({ executable: exe, cwd: dir, env: { PATH: process.env.PATH }, timeoutMs: 5000 }, ready), calls };
}

test("readiness: a trusted folder starts one ephemeral thread and reads the connection from it", OPTS, async () => {
  const f = fakeCodex("trusted");
  const r = await f.run("release-form");
  assert.equal(r.items.find((i) => i.id === "mcp").value, "release-form (connection not checked)", "the list without a thread checks no connection");
  assert.deepEqual(r.readiness, { server: "release-form", projectLayer: "enabled", disabledReason: null, inProjectLayer: true, inConfig: true, threadStarted: true,
    status: { name: "release-form", connection: "connected", auth: "unsupported", tools: ["release_ticket"] }, error: null });
  const starts = f.calls().filter((c) => c.startsWith("thread/start "));
  assert.deepEqual(starts.map((c) => JSON.parse(c.slice(13))), [{ cwd: f.dir, ephemeral: true }], "no turn, no access override");
  assert.ok(!f.calls().some((c) => c.startsWith("turn/")));
});

test("readiness: an untrusted folder never starts a thread (Codex would write its trust into the person's config)", OPTS, async () => {
  const f = fakeCodex("untrusted");
  const r = await f.run("release-form");
  assert.equal(r.readiness.projectLayer, "disabled");
  assert.match(r.readiness.disabledReason, /trusted project/);
  assert.equal(r.readiness.threadStarted, false);
  assert.ok(!f.calls().some((c) => c.startsWith("thread/start")));
});

test("readiness: without the option the probe starts no thread", OPTS, async () => {
  const f = fakeCodex("trusted");
  const r = await f.run(undefined);
  assert.equal(r.readiness, undefined);
  assert.ok(!f.calls().some((c) => c.startsWith("thread/start")));
});

test("pages: release-form on page 2, before the thread and inside it (with its threadId on every page)", OPTS, async () => {
  const f = fakeCodex("page2");
  const r = await f.run("release-form");
  assert.equal(r.readiness.threadStarted, true, JSON.stringify(r.readiness));
  assert.deepEqual(r.readiness.status, { name: "release-form", connection: "connected", auth: "unsupported", tools: ["release_ticket"] });
  assert.equal(r.readiness.error, null);
  assert.deepEqual(r.items.find((i) => i.id === "mcp").servers.map((x) => x.name), ["other", "release-form"]);
  const lists = f.calls().filter((c) => c.startsWith("mcpServerStatus/list ")).map((c) => JSON.parse(c.slice(21)));
  assert.ok(lists.some((p) => p.threadId === "t1" && p.cursor === "c2"), "the thread's second page keeps the threadId");
  assert.ok(lists.filter((p) => p.cursor).every((p) => p.cursor === "c2"));
  assert.deepEqual(gate(codexReport(r.readiness)), { ok: true, reasons: [] });
});

test("pages: a failing next page and a looping cursor are errors, never a result", OPTS, async () => {
  for (const [mode, re] of [["pageerr", /page 2: method not found/], ["loop", /the cursor repeats/]]) {
    const f = fakeCodex(mode);
    const r = await f.run("release-form");
    assert.match(r.readiness.error, re, mode);
    assert.equal(r.readiness.threadStarted, false, `${mode}: no thread on an incomplete list`);
    assert.equal(r.items.find((i) => i.id === "mcp").note, "the list is incomplete", mode);
    assert.equal(gate(codexReport(r.readiness)).ok, false, mode);
    assert.ok(f.calls().filter((c) => c.startsWith("mcpServerStatus/list")).length <= 6, `${mode}: bounded`);
  }
});

test("pages: no tool and a disabled layer still block", OPTS, async () => {
  assert.equal(gate(codexReport((await fakeCodex("notool").run("release-form")).readiness)).ok, false);
  assert.equal(gate(codexReport((await fakeCodex("untrusted").run("release-form")).readiness)).ok, false);
});

test("readiness: a connection that does not settle ends as a timeout", { ...OPTS, timeout: 90_000 }, async () => {
  const r = await fakeCodex("slow").run("release-form");
  assert.equal(r.readiness.threadStarted, true);
  assert.equal(r.readiness.status.connection, "starting");
  assert.match(r.readiness.error, /^timeout/);
});

// ---- the gate ----
const since = Date.parse("2026-09-26T10:00:00Z");
const log = (client, ts = "2026-09-26T10:00:01Z") => JSON.stringify({ ts, type: "initialize", client: { name: client, version: "0.155.1" } });
const ready = (patch = {}) => ({ server: "release-form", projectLayer: "enabled", disabledReason: null, inProjectLayer: true, inConfig: true, threadStarted: true,
  status: { name: "release-form", connection: "connected", auth: "unsupported", tools: ["release_ticket"] }, error: null, ...patch });
const codexReport = (readiness, extra = {}) => ({ providers: [{ provider: "codex", ok: true, error: null, items: [], readiness, ...extra }] });
const gate = (report, logText = log("codex-mcp-client")) => s4Gate({ provider: "codex", report, logText, since, client: "codex-mcp-client" });

test("gate: all five together pass", () => {
  assert.deepEqual(gate(codexReport(ready())), { ok: true, reasons: [] });
});

test("gate: each missing condition blocks the start", () => {
  const blocked = (report, re, logText) => { const g = gate(report, logText); assert.equal(g.ok, false); assert.ok(g.reasons.some((x) => re.test(x)), JSON.stringify(g.reasons)); };
  blocked(codexReport(ready({ projectLayer: "disabled", disabledReason: "add it as trusted", inConfig: false, threadStarted: false, status: null })), /project layer is disabled/);
  blocked(codexReport(ready({ projectLayer: "absent" })), /project layer is absent/);
  blocked(codexReport(ready({ inConfig: false })), /not in the effective configuration/);
  blocked(codexReport(ready({ inProjectLayer: false })), /not defined in the project layer/); // e.g. only in ~/.codex/config.toml
  blocked(codexReport(ready({ status: { name: "release-form", connection: "connected", auth: "unsupported", tools: [] } })), /release_ticket is not discovered/, undefined);
  // authStatus unsupported with no runtimeStatus: listed, never connected
  blocked(codexReport(ready({ threadStarted: false, status: { name: "release-form", connection: null, auth: "unsupported", tools: [] } })), /connection is not checked/);
  blocked(codexReport(ready({ status: { name: "release-form", connection: "failed", auth: "unsupported", tools: ["release_ticket"] } })), /connection is failed/);
  blocked(codexReport(ready({ error: "timeout: the server's connection did not settle" })), /timeout/);
  blocked(codexReport(ready({ server: "other" })), /no readiness of release-form/);
  blocked(codexReport(undefined), /no readiness/);
  blocked({ providers: [{ provider: "codex", ok: false, error: "initialize: no answer", items: [] }] }, /probe failed/);
  blocked(null, /no probe result/);
  blocked(codexReport(ready()), /no initialize/, log("codex-mcp-client", "2026-09-26T09:59:59Z")); // before this probe
  blocked(codexReport(ready()), /no initialize/, log("claude-code")); // another CLI
  blocked(codexReport(ready()), /no initialize/, "");
});

test("gate: Claude needs its mcp_status connected and a fresh initialize", () => {
  const rep = (connection) => ({ providers: [{ provider: "claude", ok: true, error: null, items: [{ id: "mcp", value: "", confirmed: true, servers: [{ name: "release-form", connection, auth: null, tools: [] }] }] }] });
  const g = (report, logText = log("claude-code")) => s4Gate({ provider: "claude", report, logText, since, client: "claude-code" });
  assert.equal(g(rep("connected")).ok, true);
  assert.equal(g(rep("pending")).ok, false);
  assert.equal(g(rep("connected"), log("codex-mcp-client")).ok, false);
  assert.equal(g({ providers: [{ provider: "claude", ok: true, error: null, items: [] }] }).ok, false);
});

test("freshInitialize: only this client, only from this probe on, broken lines skipped", () => {
  const text = [log("codex-mcp-client", "2026-09-26T09:00:00Z"), "not json", log("codex-mcp-client"), log("claude-code")].join("\n");
  assert.equal(freshInitialize(text, since, "codex-mcp-client").length, 1);
});
