// S7's automatic part and the MCP list behind it: each CLI answers once without an error; a whole list (or a confirmed
// empty one) apart from a missing, partial or failed one — also after safeReport; the page deadline holds before and
// after every request, and a late answer changes nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { codexMcpList, probeClaude, probeCodex } from "../src/main/services/orchestration/probe.ts";
import { safeReport } from "../scripts/safe-environment.mjs";
import { mcpListState, s7Verdict } from "../scripts/s7-criteria.mjs";
import { s4Gate } from "../scripts/s4-gate.mjs";

const NODE = fs.realpathSync(process.execPath);
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 60_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-s7-env-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SECRET = ["sk", "test", "S7SECRET0123456789abcdefXYZ"].join("-");

// ---- S7 criteria over the safe environment ----
const mcp = (servers, extra = {}) => ({ id: "mcp", confirmed: true, complete: true, servers, ...extra });
const prov = (provider, items = [mcp([{ name: "a", connection: "connected", auth: null, tools: [] }])], ok = true) => ({ provider, ok, failed: !ok, items });
const env = (...providers) => ({ state: "done", providers });
const failedWhat = (v) => v.checks.filter((c) => !c.ok).map((c) => c.what);

test("S7: both CLIs answered once, whole lists → the automatic part passes; the manual part is not counted", () => {
  const v = s7Verdict(env(prov("claude"), prov("codex")));
  assert.equal(v.ok, true, JSON.stringify(v.checks));
  assert.deepEqual(v.mcp, { claude: "whole", codex: "whole" });
  assert.match(v.manual, /not counted/);
});

test("S7: two failed answers, one failed answer, a duplicate or a missing provider never pass", () => {
  const both = s7Verdict(env(prov("claude", [], false), prov("codex", [], false)));
  assert.equal(both.ok, false);
  assert.ok(failedWhat(both).includes("claude answered without an error") && failedWhat(both).includes("codex answered without an error"));
  assert.equal(s7Verdict(env(prov("claude"), prov("codex", [], false))).ok, false);
  const dup = s7Verdict(env(prov("claude"), prov("claude"), prov("codex")));
  assert.equal(dup.ok, false);
  assert.ok(failedWhat(dup).includes("exactly one answer from Claude and one from Codex"));
  assert.ok(failedWhat(dup).includes("claude answered without an error"), "a duplicate is not taken as the answer");
  assert.equal(s7Verdict(env(prov("codex"))).ok, false);
  assert.equal(s7Verdict({ state: "error", providers: [prov("claude"), prov("codex")] }).ok, false);
  assert.equal(s7Verdict(null).ok, false);
});

test("S7: a confirmed empty list counts; a missing, partial, failed or unlabelled list does not", () => {
  assert.equal(mcpListState(mcp([])), "empty");
  assert.equal(s7Verdict(env(prov("claude", [mcp([])]), prov("codex", [mcp([])]))).ok, true);
  assert.equal(mcpListState(undefined), "missing");
  assert.equal(s7Verdict(env(prov("claude"), prov("codex", [mcp([{ name: "a" }]), mcp([{ name: "a" }], { complete: false, incomplete: "timeout" })]))).mcp.codex, "missing", "two mcp items: neither counts");
  assert.equal(mcpListState(mcp([{ name: "a" }], { complete: false, incomplete: "page_failed" })), "partial");
  assert.equal(mcpListState({ id: "mcp", confirmed: false, complete: false, incomplete: "timeout" }), "failed");
  assert.equal(mcpListState({ id: "mcp", confirmed: true, servers: [] }), "missing", "no completeness said is not a whole list");
  for (const items of [[], [mcp([{ name: "a" }], { complete: false, incomplete: "timeout" })], [{ id: "mcp", confirmed: false, complete: false, incomplete: "request_failed" }]]) {
    const v = s7Verdict(env(prov("claude"), prov("codex", items)));
    assert.equal(v.ok, false, JSON.stringify(items));
    assert.ok(failedWhat(v).includes("codex: the MCP list is whole (a confirmed empty list counts)"));
  }
});

test("safeReport keeps completeness and its code, drops any other value", () => {
  const r = safeReport({ providers: [{ provider: "codex", ok: true, items: [
    { id: "mcp", value: "a", confirmed: true, complete: false, incomplete: "page_failed", note: `page 2: ${SECRET}`, servers: [{ name: "a" }] },
    { id: "x", value: "", confirmed: false, complete: false, incomplete: `timeout ${SECRET}` }] }] });
  assert.deepEqual(r.providers[0].items[0], { id: "mcp", confirmed: true, complete: false, incomplete: "page_failed", servers: [{ name: "a", connection: null, auth: null, tools: [] }] });
  assert.deepEqual(r.providers[0].items[1], { id: "x", confirmed: false, complete: false }, "an unknown code is dropped, never kept as text");
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

// ---- the page deadline, with a stub call and controlled delays ----
function stub(pages, delays = []) {
  const asked = [];
  const call = async (_method, params, ms) => {
    const i = asked.length;
    asked.push({ params, ms });
    const d = delays[i] ?? 0;
    const page = pages[i];
    // like the app-server conversation: waits at most ms, a later answer is dropped
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: true, value: page }), d);
      if (ms !== undefined && ms < d) { clearTimeout(t); setTimeout(() => resolve({ ok: false, error: "no answer in time", why: "wait_expired" }), ms); }
    });
  };
  return { call, asked };
}

test("deadline: already over before the first page → nothing is asked", async () => {
  const s = stub([{ data: [{ name: "a" }], nextCursor: null }]);
  const r = await codexMcpList(s.call, {}, performance.now() - 1);
  assert.equal(r.incomplete, "timeout");
  assert.equal(s.asked.length, 0);
});

test("deadline: the only page answered too late is not a list, even with nextCursor null", async () => {
  const s = stub([{ data: [{ name: "a" }], nextCursor: null }], [300]);
  const r = await codexMcpList(s.call, {}, performance.now() + 100);
  assert.equal(r.incomplete, "timeout");
  assert.equal(r.error, "timeout: page 1 got no answer in time", "no answer is never reported as a late answer");
  assert.ok(s.asked[0].ms <= 100, "the request waits at most what is left");
});

test("deadline: the last page answered too late → timeout, and no request after the deadline", async () => {
  const s = stub([{ data: [{ name: "a" }], nextCursor: "c2" }, { data: [{ name: "b" }], nextCursor: null }], [0, 400]);
  const until = performance.now() + 150;
  const r = await codexMcpList(s.call, { threadId: "t1" }, until);
  assert.equal(r.incomplete, "timeout");
  assert.equal(s.asked.length, 2);
  assert.deepEqual(s.asked[1].params, { threadId: "t1", cursor: "c2" });
  await new Promise((res) => setTimeout(res, 450));
  assert.equal(s.asked.length, 2, "nothing more was asked, the late answer changed nothing");
  assert.equal(r.incomplete, "timeout");
});

test("deadline: an answer that comes after the deadline is not used, and is told apart from no answer", async () => {
  const until = performance.now() + 60;
  // a call that answers only after the deadline (the list's own check after the answer)
  const call = async () => { await new Promise((r) => setTimeout(r, 120)); return { ok: true, value: { data: [{ name: "a" }], nextCursor: null } }; };
  const r = await codexMcpList(call, {}, until);
  assert.deepEqual([r.incomplete, r.error, r.servers.length], ["timeout", "timeout: page 1 answered after the deadline", 0]);
  const exited = await codexMcpList(async () => ({ ok: false, error: "the CLI exited", why: "cli_exited" }), {}, performance.now() + 1000);
  assert.deepEqual([exited.incomplete, exited.error], ["cli_exited", "the CLI exited before page 1 was answered"]);
});

test("deadline: pages in time → the whole list", async () => {
  const s = stub([{ data: [{ name: "a" }], nextCursor: "c2" }, { data: [{ name: "b" }], nextCursor: null }]);
  const r = await codexMcpList(s.call, {}, performance.now() + 1000);
  assert.deepEqual([r.error, r.incomplete, r.servers.map((x) => x.name)], [null, null, ["a", "b"]]);
});

// ---- the app's probe against a fake app-server whose last page comes late ----
function fakeCodex(delayPage2) {
  const dir = fs.mkdtempSync(path.join(TMP, "codex-"));
  fs.mkdirSync(path.join(dir, ".codex"));
  const js = path.join(dir, "fake.mjs");
  fs.writeFileSync(js, `
import fs from "node:fs"; import readline from "node:readline";
const cwd = ${JSON.stringify(dir)};
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l); if (m.id === undefined) return;
  fs.appendFileSync(cwd + "/calls.log", m.method + " " + JSON.stringify(m.params ?? {}) + "\\n");
  const p = m.params ?? {};
  const R = {
    initialize: {},
    "config/read": { config: { mcp_servers: { "release-form": {} } }, ...(p.includeLayers ? { layers: [{ name: { type: "project", dotCodexFolder: cwd + "/.codex" }, config: { mcp_servers: { "release-form": {} } } }] } : {}) },
    "mcpServerStatus/list": p.cursor ? { data: [{ name: "release-form", authStatus: "unsupported", tools: { release_ticket: {} } }], nextCursor: null } : { data: [{ name: "other" }], nextCursor: "c2" },
    "thread/start": { thread: { id: "t1" } }
  }[m.method];
  const send = () => out(R ? { id: m.id, result: R } : { id: m.id, error: { code: -1, message: "denied: api_key=${SECRET}" } });
  if (m.method === "mcpServerStatus/list" && p.cursor) setTimeout(send, ${delayPage2}); else send();
});`);
  const exe = path.join(dir, "codex");
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${NODE}" "${js}" "$@"\n`, { mode: 0o755 });
  return { dir, exe, calls: () => fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") };
}

test("probe: a late last page leaves the list partial and starts no thread; no secret in the new fields", OPTS, async () => {
  const f = fakeCodex(2500);
  const r = await probeCodex({ executable: f.exe, cwd: f.dir, env: { PATH: process.env.PATH }, timeoutMs: 2000 }, "release-form");
  const item = r.items.find((i) => i.id === "mcp");
  assert.deepEqual([item.confirmed, item.complete, item.incomplete], [true, false, "timeout"], JSON.stringify(item));
  assert.equal(r.readiness.threadStarted, false);
  assert.match(r.readiness.error, /^timeout/);
  assert.ok(!f.calls().some((c) => c.startsWith("thread/start")), "no thread after the deadline");
  assert.equal(s4Gate({ provider: "codex", report: { providers: [{ provider: "codex", ...r }] }, logText: "", since: 0, client: "codex-mcp-client" }).ok, false);
  const safe = safeReport({ providers: [{ provider: "codex", ...r }] });
  assert.equal(safe.providers[0].items.find((i) => i.id === "mcp").incomplete, "timeout");
  assert.equal(s7Verdict({ state: "done", providers: [{ provider: "claude", ok: true, items: [mcp([])] }, safe.providers[0]] }).mcp.codex, "partial");
  assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(safe).includes(SECRET));
});

test("probe: pages in time → a whole list", OPTS, async () => {
  const f = fakeCodex(0);
  const r = await probeCodex({ executable: f.exe, cwd: f.dir, env: { PATH: process.env.PATH }, timeoutMs: 4000 });
  const item = r.items.find((i) => i.id === "mcp");
  assert.deepEqual([item.confirmed, item.complete, item.incomplete], [true, true, undefined]);
  assert.deepEqual(item.servers.map((x) => x.name), ["other", "release-form"]);
});

test("probe: Claude without an mcpServers list is not a confirmed empty list", OPTS, async () => {
  const js = path.join(TMP, "claude-nolist.mjs");
  fs.writeFileSync(js, `import readline from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); if (m.type !== "control_request") return;
  out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: m.request.subtype === "initialize" ? { commands: [], agents: [], models: [] } : { servers: "${SECRET}" } } }); });`);
  const exe = path.join(TMP, "claude-nolist");
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${NODE}" "${js}" "$@"\n`, { mode: 0o755 });
  const r = await probeClaude({ executable: exe, cwd: TMP, env: { PATH: process.env.PATH }, timeoutMs: 5000 });
  const item = r.items.find((i) => i.id === "mcp");
  assert.deepEqual([item.confirmed, item.complete, item.incomplete], [false, false, "no_list"]);
  assert.equal(mcpListState(item), "failed");
  assert.ok(!JSON.stringify(r).includes(SECRET));
});
