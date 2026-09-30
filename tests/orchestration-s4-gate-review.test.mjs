// Independent review of the S4X readiness gate (scripts/s4-gate.mjs, probe.ts codexReadiness): ways to get "ready"
// with a condition unmet. A fake codex app-server answers from a per-test spec; every method is logged, so a
// thread/start that must not happen is seen. D1 (a non-string disabledReason) and D2 (a server outside the project
// layer) of the review are fixed and kept here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { codexProjectLayer, probeCodex } from "../src/main/services/orchestration/probe.ts";
import { freshInitialize, s4Gate } from "../scripts/s4-gate.mjs";

const NODE = fs.realpathSync(process.execPath);
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 60_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-s4-gate-review-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SINCE = Date.parse("2026-09-27T10:00:00.000Z");
const init = (ts, name = "codex-mcp-client", type = "initialize") => JSON.stringify({ ts, pid: 1, type, client: { name } });
const LOG = init("2026-09-27T10:00:01.000Z");
const ready = (patch = {}) => ({ server: "release-form", projectLayer: "enabled", disabledReason: null, inConfig: true, inProjectLayer: true, threadStarted: true,
  status: { name: "release-form", connection: "connected", auth: "unsupported", tools: ["release_ticket"] }, error: null, ...patch });
const report = (readiness, extra = {}) => ({ providers: [{ provider: "claude", ok: true, error: null, items: [] }, { provider: "codex", ok: true, error: null, items: [], readiness, ...extra }] });
const gate = (rep, logText = LOG, since = SINCE) => s4Gate({ provider: "codex", report: rep, logText, since, client: "codex-mcp-client" });

test("the gate itself: every unmet condition blocks", () => {
  assert.deepEqual(gate(report(ready())), { ok: true, reasons: [] });
  const blocked = [
    ["readiness of the other provider only", { providers: [{ provider: "claude", ok: true, items: [], readiness: ready() }, { provider: "codex", ok: true, items: [] }] }],
    ["probe failed", report(ready(), { ok: false, error: "x" })],
    ["another server", report(ready({ server: "other" }))],
    ["error with all else fine", report(ready({ error: "timeout: the server's connection did not settle" }))],
    ["enabled with a reason", report(ready({ disabledReason: "add it as trusted" }))],
    ["layer absent", report(ready({ projectLayer: "absent" }))],
    ["not in config", report(ready({ inConfig: false }))],
    ["not defined in the project layer", report(ready({ inProjectLayer: false }))],
    ["project layer field missing", report(ready({ inProjectLayer: undefined }))],
    ["tools of the list without a thread", report(ready({ threadStarted: false, status: { name: "release-form", connection: null, auth: "unsupported", tools: ["release_ticket"] } }))],
    ["unsupported is not connected", report(ready({ status: { name: "release-form", connection: null, auth: "unsupported", tools: ["release_ticket"] } }))],
    ["starting", report(ready({ status: { name: "release-form", connection: "starting", auth: null, tools: ["release_ticket"] } }))],
    ["no tool", report(ready({ status: { name: "release-form", connection: "connected", auth: null, tools: ["other_tool"] } }))],
    ["no status", report(ready({ status: null }))],
    ["no report", null]
  ];
  for (const [what, rep] of blocked) assert.equal(gate(rep).ok, false, what);
});

test("a fresh initialize: from Codex, at or after since, a real initialize line", () => {
  assert.equal(freshInitialize(init("2026-09-27T10:00:00.000Z"), SINCE, "codex-mcp-client").length, 1, "at since");
  for (const [what, log, since] of [
    ["1 ms before since", init("2026-09-27T09:59:59.999Z"), SINCE],
    ["from Claude", init("2026-09-27T10:00:01.000Z", "claude-code"), SINCE],
    ["a call line, not initialize", init("2026-09-27T10:00:01.000Z", "codex-mcp-client", "call"), SINCE],
    ["no ts", JSON.stringify({ type: "initialize", client: { name: "codex-mcp-client" } }), SINCE],
    ["bad ts", init("yesterday"), SINCE],
    ["since missing", LOG, undefined],
    ["client as a plain string", JSON.stringify({ ts: "2026-09-27T10:00:01.000Z", type: "initialize", client: "codex-mcp-client" }), SINCE],
    ["broken JSON", `${LOG.slice(0, -1)}\n`, SINCE],
    ["empty log", "", SINCE]
  ]) {
    assert.equal(freshInitialize(log, since, "codex-mcp-client").length, 0, what);
    assert.equal(s4Gate({ provider: "codex", report: report(ready()), logText: log, since, client: "codex-mcp-client" }).ok, false, what);
  }
});

// A fake codex app-server: spec = { layers, config, list, threadList, threadStart }; every method logged.
function fakeCodex(spec) {
  const dir = fs.mkdtempSync(path.join(TMP, "app-"));
  fs.mkdirSync(path.join(dir, ".codex"));
  const js = path.join(dir, "fake.mjs");
  fs.writeFileSync(js, `
import fs from "node:fs"; import readline from "node:readline";
const spec = ${JSON.stringify(spec)}, cwd = ${JSON.stringify(dir)};
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l); if (m.id === undefined) return;
  fs.appendFileSync(cwd + "/calls.log", m.method + "\\n");
  const p = m.params ?? {};
  const layers = (spec.layers ?? []).map((x) => x === "PROJECT" ? { name: { type: "project", dotCodexFolder: cwd + "/.codex" }, ...(spec.projectExtra ?? {}) } : x);
  if (m.method === "thread/start" && spec.threadStart === "error") return out({ id: m.id, error: { code: -1, message: "boom" } });
  const R = {
    initialize: {},
    "config/read": { config: spec.config ?? {}, ...(p.includeLayers ? { layers } : {}) },
    "mcpServerStatus/list": { data: p.threadId ? spec.threadList ?? [] : spec.list ?? [] },
    "thread/start": { thread: { id: "t1" } }
  }[m.method];
  out(R ? { id: m.id, result: R } : { id: m.id, error: { code: -32601, message: "method not found" } });
});`);
  const exe = path.join(dir, "codex");
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${NODE}" "${js}" "$@"\n`, { mode: 0o755 });
  return {
    run: () => probeCodex({ executable: exe, cwd: dir, env: { PATH: process.env.PATH }, timeoutMs: 3000 }, "release-form"),
    calls: () => fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n")
  };
}
const CONFIG = { mcp_servers: { "release-form": {} } };
const LISTED = { name: "release-form", authStatus: "unsupported", tools: { release_ticket: {} } };
const CONNECTED = { ...LISTED, runtimeStatus: "connected" };
// the server defined in this folder's own .codex layer, the list without a thread as 0.155.1 gives it
const OWN = { layers: ["PROJECT"], projectExtra: { config: CONFIG }, config: CONFIG, list: [LISTED] };

test("control: the fake as a ready project passes the gate, so each case below fails for its own reason", OPTS, async () => {
  const f = fakeCodex({ ...OWN, threadList: [CONNECTED] });
  const r = await f.run();
  assert.deepEqual(gate(report(r.readiness)), { ok: true, reasons: [] });
  assert.equal(f.calls().filter((m) => m === "thread/start").length, 1);
});

test("the thread's list decides: tools only without a thread, a missing entry or a failed thread/start block", OPTS, async () => {
  for (const [what, spec] of [
    ["the thread's entry has no tools", { ...OWN, threadList: [{ ...CONNECTED, tools: {} }] }],
    ["the thread lists another server only", { ...OWN, threadList: [{ ...CONNECTED, name: "release-form-2" }] }],
    ["thread/start fails", { ...OWN, threadStart: "error" }]
  ]) {
    const f = fakeCodex(spec);
    const r = await f.run();
    assert.equal(gate(report(r.readiness)).ok, false, `${what}: ${JSON.stringify(r.readiness)}`);
  }
});

test("an untrusted folder: no thread/start, whatever the list without a thread says", OPTS, async () => {
  const f = fakeCodex({ layers: ["PROJECT"], projectExtra: { config: CONFIG, disabledReason: "add it as a trusted project" }, config: CONFIG, list: [CONNECTED], threadList: [CONNECTED] });
  const r = await f.run();
  assert.equal(r.readiness.threadStarted, false);
  assert.ok(!f.calls().includes("thread/start"), f.calls().join(","));
  assert.equal(gate(report(r.readiness)).ok, false);
});

test("a disabledReason Codex sends as an object still disables the layer", OPTS, async () => {
  assert.equal(codexProjectLayer([{ name: { type: "project", dotCodexFolder: "/p/app/.codex" }, disabledReason: { message: "untrusted" } }], "/p/app").state, "disabled");
  const f = fakeCodex({ layers: ["PROJECT"], projectExtra: { config: CONFIG, disabledReason: { message: "untrusted" } }, config: CONFIG, list: [LISTED], threadList: [CONNECTED] });
  await f.run();
  assert.ok(!f.calls().includes("thread/start"), "thread/start in an untrusted folder");
});

test("release-form defined only in another layer does not count as the project's server", OPTS, async () => {
  const f = fakeCodex({ layers: [{ name: { type: "user" }, config: CONFIG }, "PROJECT"], projectExtra: { config: {} }, config: CONFIG, list: [LISTED], threadList: [CONNECTED] });
  const r = await f.run();
  assert.equal(r.readiness.inProjectLayer, false);
  assert.ok(!f.calls().includes("thread/start"), "no thread for a server outside the project layer");
  assert.match(gate(report(r.readiness)).reasons.join("; "), /not defined in the project layer/);
});
