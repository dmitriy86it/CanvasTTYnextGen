// Independent review (2) of the environment probe: the pages of Codex's mcpServerStatus/list (codexMcpList, readiness
// inside the thread) and what CLI words reach the person or the series' report (cliText, safeReport, s4Gate). P1-P3,
// S1, S2 of the review are fixed and kept here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { cliText, codexMcpList, probeCodex } from "../src/main/services/orchestration/probe.ts";
import { errorKind, safeReport } from "../scripts/safe-environment.mjs";
import { s4Gate } from "../scripts/s4-gate.mjs";
import { mcpListState, s7Verdict } from "../scripts/s7-criteria.mjs";

const NODE = fs.realpathSync(process.execPath);
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 60_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-probe-review2-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// a scripted mcpServerStatus/list: pages[cursor ?? ""] is the answer (or an error string); every call's params kept
function pagedCall(pages) {
  const seen = [], waits = [];
  const call = async (method, params, ms) => {
    seen.push(params);
    waits.push(ms);
    const page = pages[params.cursor ?? ""];
    return typeof page === "string" ? { ok: false, error: page } : page ? { ok: true, value: page } : { ok: false, error: "no such page" };
  };
  return { call, seen, waits };
}
// the probe's deadline is on the monotonic clock (performance.now())
const NOW = () => performance.now();
const FAR = () => NOW() + 60_000;

test("pages: threadId on every page, an empty cursor ends the list", async () => {
  const { call, seen, waits } = pagedCall({ "": { data: [{ name: "a" }], nextCursor: "c2" }, c2: { data: [{ name: "b" }], nextCursor: "" } });
  const until = FAR();
  assert.deepEqual(await codexMcpList(call, { threadId: "t1" }, until), { servers: [{ name: "a" }, { name: "b" }], error: null, incomplete: null });
  assert.deepEqual(seen, [{ threadId: "t1" }, { threadId: "t1", cursor: "c2" }]);
  // each request may wait only the remainder of the deadline
  assert.ok(waits.every((ms) => ms > 0 && ms <= until - NOW() + 1000), JSON.stringify(waits));
});

test("pages: a failed page 2, a repeated cursor, the page limit and the deadline are errors, never a complete list", async () => {
  const failing = await codexMcpList(pagedCall({ "": { data: [{ name: "release-form" }], nextCursor: "c2" }, c2: "boom" }).call, {}, FAR());
  assert.match(failing.error, /^page 2: boom/);
  assert.equal(failing.incomplete, "page_failed");
  const first = await codexMcpList(pagedCall({ "": "boom" }).call, {}, FAR());
  assert.deepEqual([first.incomplete, first.servers], ["request_failed", []]);
  assert.equal(failing.servers.length, 1, "page 1 kept for display only");
  const loop = await codexMcpList(pagedCall({ "": { data: [], nextCursor: "c2" }, c2: { data: [], nextCursor: "c2" } }).call, {}, FAR());
  assert.deepEqual([loop.incomplete, loop.error], ["cursor_repeats", "the cursor repeats"]);
  const endless = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i ? `c${i}` : "", { data: [], nextCursor: `c${i + 1}` }]));
  const limit = pagedCall(endless);
  const lim = await codexMcpList(limit.call, {}, FAR());
  assert.deepEqual([lim.incomplete, /more than 20 pages/.test(lim.error)], ["page_limit", true]);
  assert.equal(limit.seen.length, 20);
  // the deadline already passed: nothing is asked at all
  const gone = pagedCall(endless);
  const expired = await codexMcpList(gone.call, {}, NOW() - 1);
  assert.deepEqual([expired.incomplete, expired.servers, gone.seen.length], ["timeout", [], 0]);
  assert.match(expired.error, /page 1 not asked/);
  // a wall-clock deadline (Date.now) is far in the future on the monotonic clock: it must not be mistaken for one
  assert.ok(Date.now() > NOW() + 1e9, "the two clocks are apart, so a unit mix-up would show");
  // an answer that comes after the deadline is not used, even a complete one
  const slow = async () => { await new Promise((r) => setTimeout(r, 60)); return { ok: true, value: { data: [{ name: "late" }] } }; };
  const tooLate = await codexMcpList(slow, {}, NOW() + 20);
  assert.deepEqual([tooLate.incomplete, tooLate.servers], ["timeout", []]);
  assert.match(tooLate.error, /page 1 answered after the deadline/);
  // the three ends stay apart: no answer in time, the CLI's exit, a refusal
  const ended = async (why) => codexMcpList(async () => ({ ok: false, error: "x", why }), {}, FAR());
  assert.deepEqual([(await ended("wait_expired")).incomplete, (await ended("wait_expired")).error], ["timeout", "timeout: page 1 got no answer in time"]);
  assert.deepEqual([(await ended("cli_exited")).incomplete, (await ended("cli_exited")).error], ["cli_exited", "the CLI exited before page 1 was answered"]);
  assert.deepEqual([(await ended("refused")).incomplete, (await ended("refused")).error], ["request_failed", "x"]);
  // page 1 in time, page 2 may wait only what is left, and its late answer is not used
  const waited = [];
  const onePage = async (m, p, ms) => { waited.push(ms); await new Promise((r) => setTimeout(r, 30)); return { ok: true, value: { data: [{ name: "a" }], nextCursor: p.cursor ? "" : "c2" } }; };
  const cut = await codexMcpList(onePage, {}, NOW() + 45);
  assert.equal(cut.incomplete, "timeout");
  assert.match(cut.error, /page 2 answered after the deadline/);
  assert.equal(waited.length, 2);
  assert.ok(waited[1] <= 20 && waited[1] < waited[0], JSON.stringify(waited));
});

test("pages: a cursor that is not a string is not the end of the list; null and undefined are", async () => {
  for (const c of [2, true, {}, ["c2"]]) {
    const r = await codexMcpList(pagedCall({ "": { data: [{ name: "a" }], nextCursor: c } }).call, {}, FAR());
    assert.match(String(r.error), /^page 1: an unreadable cursor/, JSON.stringify(c));
    assert.equal(r.incomplete, "cursor_unreadable");
  }
  for (const c of [null, undefined]) assert.equal((await codexMcpList(pagedCall({ "": { data: [], nextCursor: c } }).call, {}, FAR())).error, null);
});

test("pages: data that is not an array is not an empty page", async () => {
  for (const data of [{ "release-form": {} }, null, "x", undefined]) {
    const r = await codexMcpList(pagedCall({ "": { data: [{ name: "a" }], nextCursor: "c2" }, c2: { data } }).call, {}, FAR());
    assert.match(String(r.error), /^page 2: no list/, JSON.stringify(data));
    assert.equal(r.incomplete, "no_list");
  }
});

// A fake codex app-server: list pages without a thread and inside it, as spec says.
function fakeCodex(spec) {
  const dir = fs.mkdtempSync(path.join(TMP, "app-"));
  fs.mkdirSync(path.join(dir, ".codex"));
  const js = path.join(dir, "fake.mjs");
  fs.writeFileSync(js, `
import readline from "node:readline";
const spec = ${JSON.stringify(spec)}, cwd = ${JSON.stringify(dir)};
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
import fs from "node:fs";
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l); if (m.id === undefined) return;
  const p = m.params ?? {};
  const key = m.method + (p.includeLayers ? "+layers" : "") + (p.threadId ? "+thread" : "") + (p.cursor ? "+" + p.cursor : "");
  fs.appendFileSync(cwd + "/calls.log", key + "\\n");
  const cfg = { mcp_servers: { "release-form": {} } };
  const pages = p.threadId ? spec.threadPages : spec.pages;
  const R = {
    initialize: {},
    "config/read": { config: cfg, ...(p.includeLayers ? { layers: [{ name: { type: "project", dotCodexFolder: cwd + "/.codex" }, config: cfg }] } : {}) },
    "mcpServerStatus/list": pages[p.cursor ?? ""],
    "thread/start": { thread: { id: "t1" } }
  }[m.method];
  const send = () => out(R ? { id: m.id, result: R } : { id: m.id, error: { code: -32601, message: "method not found" } });
  if ((spec.exitOn ?? []).includes(key)) process.exit(0);
  const d = (spec.delay ?? {})[key];
  d ? setTimeout(send, d) : send();
});
if (spec.linger) {
  // ignores the end of stdin and leaves a child of its own: only a kill of the group ends them
  process.stdin.on("end", () => {});
  const { spawn } = await import("node:child_process");
  const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(cwd + "/pids", process.pid + " " + kid.pid);
  setInterval(() => {}, 1000);
}`);
  const exe = path.join(dir, "codex");
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${NODE}" "${js}" "$@"\n`, { mode: 0o755 });
  const run = (timeoutMs = 3000) => probeCodex({ executable: exe, cwd: dir, env: { PATH: process.env.PATH }, timeoutMs }, "release-form");
  run.calls = () => fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n");
  run.pids = () => fs.readFileSync(path.join(dir, "pids"), "utf8").trim().split(" ").map(Number);
  return run;
}
const LISTED = { name: "release-form", authStatus: "unsupported", tools: { release_ticket: {} } };
const LOG = JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), type: "initialize", client: { name: "codex-mcp-client" } });
const gate = (report) => s4Gate({ provider: "codex", report, logText: LOG, since: Date.now(), client: "codex-mcp-client" });

test("control: release-form on page 2 inside the thread, connected: the gate passes", OPTS, async () => {
  const r = await fakeCodex({ pages: { "": { data: [LISTED] } }, threadPages: { "": { data: [{ name: "x" }], nextCursor: "c2" }, c2: { data: [{ ...LISTED, runtimeStatus: "connected" }] } } })();
  assert.deepEqual(gate({ providers: [{ provider: "codex", ok: true, items: [], readiness: r.readiness }] }), { ok: true, reasons: [] });
});

test("the same server twice in the thread's pages with different states is not connected", OPTS, async () => {
  const r = await fakeCodex({ pages: { "": { data: [LISTED] } },
    threadPages: { "": { data: [{ ...LISTED, runtimeStatus: "connected" }], nextCursor: "c2" }, c2: { data: [{ ...LISTED, runtimeStatus: "failed", tools: {} }] } } })();
  assert.equal(gate({ providers: [{ provider: "codex", ok: true, items: [], readiness: r.readiness }] }).ok, false, JSON.stringify(r.readiness));
  assert.match(r.readiness.error, /release-form is listed 2 times/);
});

test("cliText masks the usual forms", () => {
  // built at run time: the repository's secret scanner rejects token-shaped and home-path literals
  const gh = ["gh", "p_0123456789abcdef0123456789abcdef0123"].join("");
  const home = path.posix.join("/", "Users", "me", "project", ".codex", "config.toml");
  for (const [raw, secret] of [
    ["Authorization: Bearer abcdef123456", "abcdef123456"], ["failed with api_key=sk-1234", "sk-1234"], ['{"api_key": "sk-1234"}', "sk-1234"],
    ["X-Api-Key: hunter2x", "hunter2x"], ["https://user:hunter2x@host/x", "hunter2x"], [`token ${gh}`, gh.slice(0, 14)],
    ["client_secret=abc", "abc"], ["Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNz"]
  ]) assert.ok(!cliText(raw).includes(secret), `${raw} -> ${cliText(raw)}`);
  assert.equal(cliText(`cannot open ${home}`), `cannot open ${home}`, "a path stays");
  assert.ok(cliText(`${"x ".repeat(150)} Bearer abcdef123456`).length <= 200);
  assert.ok(!cliText(`${"a".repeat(190)} Bearer abcdef123456`).includes("abcdef"), "masked before it is cut");
});

test("cliText: a base64 secret with a slash is not taken for a path", () => {
  const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  assert.ok(!cliText(`signature mismatch for ${aws}`).includes(aws), cliText(`signature mismatch for ${aws}`));
  assert.ok(!cliText(`key ${aws.replace("wJ", "./wJ")}`).includes("K7MDENG"), "a relative-looking run is masked too");
  assert.equal(cliText("~/projects/some-very-long-folder-name/app"), "~/projects/some-very-long-folder-name/app");
});

test("safeReport and the gate keep no CLI words", () => {
  const secret = "Bearer sk-secret-123";
  const report = { providers: [{ provider: "codex", ok: false, error: `initialize: ${secret}`,
    items: [{ id: "mcp", value: secret, confirmed: true, note: secret, servers: [{ name: "release-form", connection: "connected", auth: "unsupported", tools: ["release_ticket", 7], env: { TOKEN: secret }, command: secret }] }],
    readiness: { server: "release-form", projectLayer: "disabled", disabledReason: secret, inProjectLayer: true, inConfig: true, threadStarted: false, status: null, error: `config/read: ${secret}` } }] };
  const kept = JSON.stringify(safeReport(report));
  assert.ok(!kept.includes("sk-secret"), kept);
  assert.deepEqual(safeReport(report).providers[0].items[0].servers[0], { name: "release-form", connection: "connected", auth: "unsupported", tools: ["release_ticket"] });
  assert.equal(safeReport(report).providers[0].readiness.error, "config/read");
  const reasons = s4Gate({ provider: "codex", report: { providers: [{ ...report.providers[0], readiness: { ...report.providers[0].readiness, error: `thread/start: ${secret}` } }] }, logText: "", since: 0, client: "codex-mcp-client" }).reasons.join("; ");
  assert.ok(!reasons.includes("sk-secret"), reasons);
});

test("a looping cursor that carries a secret reaches no error, note, report or reason", OPTS, async () => {
  const SECRET = "tok_abcdef0123456789secret";
  const loop = { "": { data: [], nextCursor: SECRET }, [SECRET]: { data: [], nextCursor: SECRET } };
  const r = await fakeCodex({ pages: loop, threadPages: loop })();
  assert.match(r.readiness.error, /the cursor repeats/);
  assert.match(r.items.find((i) => i.id === "mcp").note, /the cursor repeats/);
  const report = { providers: [{ provider: "codex", ...r }] };
  for (const [what, text] of [["probe result", JSON.stringify(r)], ["safeReport", JSON.stringify(safeReport(report))],
    ["gate reasons", gate(report).reasons.join("; ")], ["errorKind", errorKind(r.readiness.error)]]) {
    assert.ok(!text.includes("tok_abc"), `${what}: ${text}`);
  }
  assert.equal(gate(report).ok, false);
});

// One deadline for the whole probe (3 s here, readiness included): nothing is asked after it, an answer after it is not
// used, and no readiness comes without time. Delays of 4 s are past it.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const noneAfterDeadline = (r) => {
  const t = r.timing;
  assert.ok(t.length > 0);
  for (const x of t) {
    assert.deepEqual(Object.keys(x).sort(), ["allottedMs", "durationMs", "leftMs", "method", "outcome", "page", "startMs"], "no params or CLI text in the timing");
    if (x.outcome !== "not_sent") assert.ok(x.startMs < r.limitMs && x.allottedMs <= r.limitMs - x.startMs + 1, JSON.stringify(x));
  }
};

test("readiness: config/read not answered in time ends it; nothing is asked after it", OPTS, async () => {
  const run = fakeCodex({ pages: { "": { data: [LISTED] } }, threadPages: { "": { data: [{ ...LISTED, runtimeStatus: "connected" }] } }, delay: { "config/read+layers": 4000 } });
  const r = await run();
  assert.equal(r.readiness.error, "timeout: config/read got no answer in time");
  assert.deepEqual([r.readiness.threadStarted, r.readiness.inConfig, r.readiness.status], [false, false, null]);
  const calls = run.calls();
  assert.deepEqual(calls.slice(calls.indexOf("config/read+layers") + 1), [], calls.join(","));
  assert.equal(r.timing.find((x) => x.method === "config/read" && x.outcome !== "answered")?.outcome, "wait_expired");
  noneAfterDeadline(r);
  assert.equal(gate({ providers: [{ provider: "codex", ok: true, items: [], readiness: r.readiness }] }).ok, false);
  assert.equal(safeReport({ providers: [{ provider: "codex", ...r }] }).providers[0].readiness.error, "timeout");
});

test("readiness: thread/start not answered in time is not used; no list inside the thread follows", OPTS, async () => {
  const run = fakeCodex({ pages: { "": { data: [LISTED] } }, threadPages: { "": { data: [{ ...LISTED, runtimeStatus: "connected" }] } }, delay: { "thread/start": 4000 } });
  const r = await run();
  assert.equal(r.readiness.error, "timeout: thread/start got no answer in time");
  assert.equal(r.readiness.threadStarted, false);
  assert.ok(!run.calls().some((c) => c.includes("+thread")), run.calls().join(","));
  noneAfterDeadline(r);
  assert.equal(gate({ providers: [{ provider: "codex", ok: true, items: [], readiness: r.readiness }] }).ok, false);
});

test("readiness: page 2 inside the thread not in time: no status from it, the gate blocks", OPTS, async () => {
  const run = fakeCodex({ pages: { "": { data: [LISTED] } }, delay: { "mcpServerStatus/list+thread+c2": 4000 },
    threadPages: { "": { data: [{ name: "x" }], nextCursor: "c2" }, c2: { data: [{ ...LISTED, runtimeStatus: "connected" }] } } });
  const r = await run();
  assert.equal(r.readiness.error, "timeout: page 2 got no answer in time");
  assert.notEqual(r.readiness.status?.connection, "connected");
  noneAfterDeadline(r);
  assert.equal(gate({ providers: [{ provider: "codex", ok: true, items: [], readiness: r.readiness }] }).ok, false);
});

test("the main MCP list: a page not in time makes it partial, S7 does not count it; later requests are not sent", OPTS, async () => {
  const run = fakeCodex({ pages: { "": { data: [LISTED], nextCursor: "c2" }, c2: { data: [{ name: "other" }] } }, threadPages: { "": { data: [] } },
    delay: { "mcpServerStatus/list+c2": 4000 } });
  const r = await run();
  const item = r.items.find((i) => i.id === "mcp");
  assert.deepEqual([item.confirmed, item.complete, item.incomplete, item.servers.map((x) => x.name)], [true, false, "timeout", ["release-form"]]);
  const safe = safeReport({ providers: [{ provider: "codex", ...r }] });
  assert.equal(mcpListState(safe.providers[0].items.find((i) => i.id === "mcp")), "partial");
  // the readiness after the list had no time left: its requests were not sent
  assert.ok(!run.calls().includes("config/read+layers"), run.calls().join(","));
  assert.match(r.readiness.error, /^timeout: config\/read not asked/);
  noneAfterDeadline(r);
  const e = { state: "done", providers: [{ provider: "claude", ok: true, failed: false, items: [{ id: "mcp", confirmed: true, complete: true, servers: [] }] }, safe.providers[0]] };
  assert.equal(s7Verdict(e).ok, false);
});

test("the CLI exits during the list: cli_exited, told apart from a timeout; S7 does not count it", OPTS, async () => {
  const run = fakeCodex({ pages: { "": { data: [LISTED], nextCursor: "c2" } }, threadPages: {}, exitOn: ["mcpServerStatus/list+c2"] });
  const r = await run();
  const item = r.items.find((i) => i.id === "mcp");
  assert.deepEqual([item.complete, item.incomplete], [false, "cli_exited"]);
  assert.equal(r.timing.find((x) => x.method === "mcpServerStatus/list" && x.page === 2)?.outcome, "cli_exited");
  assert.equal(safeReport({ providers: [{ provider: "codex", ...r }] }).providers[0].items.find((i) => i.id === "mcp").incomplete, "cli_exited");
});

test("the processes end: a CLI that ignores the end of its input and leaves a child is killed with its group", { ...OPTS, timeout: 30_000 }, async () => {
  const run = fakeCodex({ pages: { "": { data: [] } }, threadPages: {}, linger: true });
  await run(2000);
  const pids = run.pids();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(pids.map(alive), [false, false], JSON.stringify(pids));
});

test("timing in the report: fixed methods and outcomes, whole milliseconds, nothing else", () => {
  const safe = safeReport({ providers: [{ provider: "codex", ok: true, items: [], limitMs: 60000.4, timing: [
    { method: "mcpServerStatus/list", page: 2, startMs: 10.6, durationMs: 3.2, allottedMs: 50000, leftMs: 49990, outcome: "wait_expired", params: { cursor: "tok_secret" } },
    { method: "Bearer sk-secret-123", page: null, startMs: 1, durationMs: 1, allottedMs: 1, leftMs: 1, outcome: "answered" },
    { method: "initialize", page: null, startMs: 1, durationMs: 1, allottedMs: 1, leftMs: 1, outcome: "sk-secret-123" },
    { method: "thread/start", page: "x", startMs: -5, durationMs: NaN, allottedMs: 1, leftMs: 1, outcome: "late" }] }] });
  const t = safe.providers[0];
  assert.ok(!JSON.stringify(safe).includes("secret"));
  assert.equal(t.limitMs, 60000);
  assert.deepEqual(t.timing, [
    { method: "mcpServerStatus/list", page: 2, startMs: 11, durationMs: 3, allottedMs: 50000, leftMs: 49990, outcome: "wait_expired" },
    { method: "thread/start", page: null, startMs: null, durationMs: null, allottedMs: 1, leftMs: 1, outcome: "late" }]);
});

// S7's automatic part over the series' safe environment
const mcpItem = (extra) => ({ id: "mcp", confirmed: true, complete: true, servers: [{ name: "a", connection: "connected", auth: null, tools: [] }], ...extra });
const env = (claude = {}, codex = {}, extra = {}) => ({ state: "done", providers: [
  { provider: "claude", ok: true, failed: false, items: [mcpItem()], ...claude }, { provider: "codex", ok: true, failed: false, items: [mcpItem()], ...codex }], ...extra });

test("S7: only two single, error-free answers with whole or confirmed empty lists pass; the manual part is never counted", () => {
  assert.equal(s7Verdict(env()).ok, true);
  assert.equal(s7Verdict(env({ items: [mcpItem({ servers: [] })] })).ok, true, "a confirmed empty list");
  assert.deepEqual(s7Verdict(env({ items: [mcpItem({ servers: [] })] })).mcp, { claude: "empty", codex: "whole" });
  for (const [what, e] of [
    ["probe failed", env({ ok: false, failed: true })],
    ["ok but failed", env({ failed: true })],
    ["two Codex answers", { state: "done", providers: [...env().providers, env().providers[1]] }],
    ["one provider only", { state: "done", providers: [env().providers[0]] }],
    ["no mcp item", env({ items: [] })],
    ["completeness not said", env({ items: [mcpItem({ complete: undefined })] })],
    ["partial", env({}, { items: [mcpItem({ complete: false, incomplete: "page_failed" })] })],
    ["not received", env({}, { items: [{ id: "mcp", confirmed: false, complete: false, incomplete: "request_failed" }] })],
    ["unconfirmed but complete", env({}, { items: [mcpItem({ confirmed: false })] })],
    ["the check errored", env({}, {}, { state: "error" })],
    ["the manual part said equal", env({ ok: false }, {}, { personCheck: "equal", manual: "equal" })]
  ]) assert.equal(s7Verdict(e).ok, false, what);
  assert.match(s7Verdict(env()).manual, /not counted/);
  assert.ok(!s7Verdict(env()).checks.some((c) => /manual|terminal/i.test(c.what)));
  // the four non-whole states stay apart
  assert.deepEqual([undefined, mcpItem({ complete: false }), { id: "mcp", confirmed: false, complete: false }, mcpItem({ complete: undefined })].map(mcpListState),
    ["missing", "partial", "failed", "missing"]);
});

test("S7 fields in the report: only a boolean complete and a known incomplete code", () => {
  const safe = safeReport({ providers: [{ provider: "codex", ok: true, items: [
    { id: "mcp", confirmed: true, complete: "yes", incomplete: "Bearer sk-secret-123", servers: [] },
    { id: "skills", confirmed: true, complete: false, incomplete: "cursor_repeats", note: "Bearer sk-secret-123" }] }] });
  assert.ok(!JSON.stringify(safe).includes("sk-secret"));
  assert.deepEqual(safe.providers[0].items, [{ id: "mcp", confirmed: true, servers: [] }, { id: "skills", confirmed: true, complete: false, incomplete: "cursor_repeats" }]);
});

// What the series' driver reads from the page (real-autopilot-series.mjs probeEnvironment, its own expression run on a
// minimal stand-in of the rendered ProjectSettings): a confirmed empty list has data-env-complete="yes" and no server
// element; it must stay "empty", apart from a missing, partial or failed list.
function driverRead(providers) {
  const src = fs.readFileSync(new URL("../scripts/real-autopilot-series.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async function probeEnvironment"));
  const expr = /app\.ev\(`(\(\(\) => \{ const el = [\s\S]*?\}\)\(\))`\)/.exec(body)[1].replaceAll('${q("[data-orch-env-check]")}', "ROOT");
  const node = (dataset, children = {}) => ({ dataset, querySelector: (sel) => (children[sel] ?? [])[0] ?? null, querySelectorAll: (sel) => children[sel] ?? [] });
  const root = node({ orchEnvCheck: "done" }, { "[data-env-provider]": providers.map((p) => node({ envProvider: p.provider }, {
    "[data-env-item]": p.items.map((i) => node({ envItem: i.id, confirmed: i.confirmed ? "yes" : "no",
      ...(i.complete !== undefined ? { envComplete: i.complete ? "yes" : "no" } : {}), ...(i.incomplete ? { envIncomplete: i.incomplete } : {}) },
    { "[data-mcp-server]": (i.servers ?? []).map((m) => node({ mcpServer: m.name, mcpConnection: m.connection ?? "", mcpAuth: "", mcpTools: "" })) })) })) });
  return new Function("ROOT", `return ${expr}`)(root);
}

test("S7: a confirmed empty list as the driver reads it from the page is empty, not missing", () => {
  const read = (item) => mcpListState(safeReport(driverRead([{ provider: "claude", items: [item] }])).providers[0].items[0]);
  assert.equal(read({ id: "mcp", confirmed: true, complete: true, servers: [] }), "empty");
  assert.equal(read({ id: "mcp", confirmed: true, complete: true, servers: [{ name: "a", connection: "connected" }] }), "whole");
  assert.equal(read({ id: "mcp", confirmed: true, complete: false, incomplete: "timeout", servers: [{ name: "a" }] }), "partial");
  assert.equal(read({ id: "mcp", confirmed: false, complete: false, incomplete: "request_failed" }), "failed");
  assert.equal(read({ id: "mcp", confirmed: true }), "missing", "no completeness said");
  const e = { state: "done", ...safeReport(driverRead([{ provider: "claude", items: [{ id: "mcp", confirmed: true, complete: true }] },
    { provider: "codex", items: [{ id: "mcp", confirmed: true, complete: true, servers: [{ name: "a" }] }] }])) };
  assert.deepEqual([s7Verdict(e).ok, s7Verdict(e).mcp], [true, { claude: "empty", codex: "whole" }]);
});

test("S7: two MCP lists in one answer are neither taken for the whole one", () => {
  assert.equal(s7Verdict(env({ items: [mcpItem(), mcpItem({ complete: false })] })).ok, false);
  assert.equal(s7Verdict(env({ items: [mcpItem(), mcpItem()] })).mcp.claude, "missing");
});
