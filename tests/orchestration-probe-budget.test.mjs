// The environment probe's one deadline (probe.ts): every request and page gets what is left of it, a list slower than
// the old half of the time still counts when it ends within the whole, a missing or a late answer, and the CLI's exit,
// are told apart and never become a whole list, the CLI's processes end, and the timing carries no secret.
// A fake app-server with controlled (shortened) delays; no real CLI, no model.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CLEANUP_MS, PROBE_MS, probeClaude, probeCodex } from "../src/main/services/orchestration/probe.ts";
import { safeReport } from "../scripts/safe-environment.mjs";
import { s7Verdict, mcpListState } from "../scripts/s7-criteria.mjs";

const NODE = fs.realpathSync(process.execPath);
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 60_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-probe-budget-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SECRET = ["sk", "test", "BUDGETSECRET0123456789abcdef"].join("-");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// delays: { "<method>": ms, "mcpServerStatus/list#<page>": ms }; never: a method never answered; pages: how many
// list pages; refuse: methods answered with an error carrying a secret; exitOn: the method on which the process exits; stubborn: the process ignores the end of its input
function fakeCodex(name, { delays = {}, never = [], refuse = [], pages = 1, exitOn = null, stubborn = false } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, `${name}-`));
  const js = path.join(dir, "fake.mjs");
  fs.writeFileSync(js, `
import fs from "node:fs"; import readline from "node:readline";
fs.writeFileSync(${JSON.stringify(path.join(dir, "pid"))}, String(process.pid));
${stubborn ? 'process.stdin.on("end", () => setInterval(() => {}, 1000));' : ""}
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const D = ${JSON.stringify(delays)}, NEVER = ${JSON.stringify(never)}, REFUSE = ${JSON.stringify(refuse)}, PAGES = ${pages}, EXIT = ${JSON.stringify(exitOn)};
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l); if (m.id === undefined) return;
  fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.log"))}, m.method + "\\n");
  if (m.method === EXIT) process.exit(3);
  if (NEVER.includes(m.method)) return;
  const page = m.method === "mcpServerStatus/list" ? (m.params?.cursor ? Number(m.params.cursor.slice(1)) : 1) : 0;
  const R = {
    initialize: {}, "config/read": { config: { model: "m" } }, "skills/list": { data: [] }, "plugin/installed": { marketplaces: [] },
    "hooks/list": { data: [] }, "account/read": { account: { type: "apiKey" } },
    "mcpServerStatus/list": { data: [{ name: "srv" + page, authStatus: "unsupported", tools: {} }], nextCursor: page < PAGES ? "p" + (page + 1) : null }
  }[REFUSE.includes(m.method) ? "" : m.method];
  const send = () => out(R ? { id: m.id, result: R } : { id: m.id, error: { code: -1, message: "denied: api_key=${SECRET}" } });
  const d = D[m.method + (page ? "#" + page : "")] ?? D[m.method] ?? 0;
  d ? setTimeout(send, d) : send();
});`);
  const exe = path.join(dir, "codex");
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${NODE}" "${js}" "$@"\n`, { mode: 0o755 });
  return { exe, dir, pid: () => Number(fs.readFileSync(path.join(dir, "pid"), "utf8")), calls: () => fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") };
}
const probe = (f, timeoutMs) => probeCodex({ executable: f.exe, cwd: f.dir, env: { PATH: process.env.PATH }, timeoutMs });
const mcpOf = (r) => r.items.find((i) => i.id === "mcp");
const listTimes = (r) => r.timing.filter((t) => t.method === "mcpServerStatus/list");

test("the limit: one deadline for the whole probe, at most 90 s; the ending of processes is apart from it", () => {
  assert.ok(PROBE_MS > 15_000 && PROBE_MS <= 90_000, `PROBE_MS ${PROBE_MS}`);
  assert.ok(CLEANUP_MS > 0 && CLEANUP_MS <= 10_000);
});

test("a list slower than the old half of the time, within the whole deadline, is the whole list", OPTS, async () => {
  const f = fakeCodex("slow-list", { delays: { "mcpServerStatus/list": 1700 } });
  const r = await probe(f, 3000); // the old rule gave the list 1500 ms of 3000
  assert.deepEqual([mcpOf(r).confirmed, mcpOf(r).complete, mcpOf(r).incomplete], [true, true, undefined]);
  assert.equal(listTimes(r)[0].outcome, "answered");
  assert.equal(r.limitMs, 3000);
});

test("earlier requests use up part of the time: the list gets only the rest of it", OPTS, async () => {
  const f = fakeCodex("used-up", { delays: { "skills/list": 1200, "mcpServerStatus/list": 600 } });
  const r = await probe(f, 6000);
  const [l] = listTimes(r);
  assert.equal(mcpOf(r).complete, true);
  assert.ok(l.startMs >= 1200, JSON.stringify(l));
  assert.ok(Math.abs(l.allottedMs - (6000 - l.startMs)) <= 2, `the list waits only what is left: ${JSON.stringify(l)}`);
  const g = fakeCodex("used-up-over", { delays: { "skills/list": 2000, "mcpServerStatus/list": 1500 } });
  const q = await probe(g, 3000);
  assert.deepEqual([mcpOf(q).confirmed, mcpOf(q).complete, mcpOf(q).incomplete], [false, false, "timeout"]);
  assert.equal(listTimes(q)[0].outcome, "wait_expired");
  assert.ok(listTimes(q)[0].allottedMs <= 1000, JSON.stringify(listTimes(q)[0]));
});

test("no answer at all: a timeout told as no answer, never a list; nothing asked after; the process ends", OPTS, async () => {
  const f = fakeCodex("never", { never: ["mcpServerStatus/list"] });
  const t0 = performance.now();
  const r = await probe(f, 1500);
  const took = performance.now() - t0;
  assert.deepEqual([mcpOf(r).incomplete, mcpOf(r).note], ["timeout", "timeout: page 1 got no answer in time"]);
  assert.equal(listTimes(r)[0].outcome, "wait_expired");
  assert.ok(took < 1500 + CLEANUP_MS + 1000, `took ${took}`);
  assert.equal(f.calls().at(-1), "mcpServerStatus/list", "no request after the deadline");
  assert.equal(mcpListState(safeReport({ providers: [{ provider: "codex", ...r }] }).providers[0].items.find((i) => i.id === "mcp")), "failed");
  assert.equal(alive(f.pid()), false);
});

test("pages share the one budget: page 2 gets what page 1 left; past it, no page 3 and no thread", OPTS, async () => {
  const f = fakeCodex("pages", { pages: 2, delays: { "mcpServerStatus/list#1": 700, "mcpServerStatus/list#2": 700 } });
  const r = await probe(f, 8000); // room for a slow start under load; the check below is relative
  const [p1, p2] = listTimes(r);
  assert.equal(mcpOf(r).complete, true);
  assert.deepEqual(mcpOf(r).servers.map((x) => x.name), ["srv1", "srv2"]);
  assert.deepEqual([p1.page, p2.page], [1, 2]);
  assert.ok(p2.allottedMs <= p1.allottedMs - 650, JSON.stringify([p1, p2]));
  // page 2 never within the limit (its delay is past it), whatever the machine's load
  const g = fakeCodex("pages-over", { pages: 3, delays: { "mcpServerStatus/list#1": 300, "mcpServerStatus/list#2": 10_000 } });
  const q = await probeCodex({ executable: g.exe, cwd: g.dir, env: { PATH: process.env.PATH }, timeoutMs: 2500 }, "srv3");
  assert.deepEqual([mcpOf(q).confirmed, mcpOf(q).complete, mcpOf(q).incomplete], [true, false, "timeout"], "page 1 is shown, the list is partial");
  assert.deepEqual(listTimes(q).map((t) => [t.page, t.outcome]).slice(0, 2), [[1, "answered"], [2, "wait_expired"]]);
  assert.ok(!g.calls().includes("thread/start"));
  assert.equal(q.readiness.threadStarted, false);
  assert.match(q.readiness.error, /^timeout: config\/read not asked$/);
  assert.equal(listTimes(q).length, 2, "no page after the deadline");
});

test("the CLI exits while the list is asked: told as its exit, not a timeout and not a list", OPTS, async () => {
  const f = fakeCodex("exits", { exitOn: "mcpServerStatus/list" });
  const r = await probe(f, 3000);
  assert.deepEqual([mcpOf(r).incomplete, mcpOf(r).note], ["cli_exited", "the CLI exited before page 1 was answered"]);
  assert.equal(listTimes(r)[0].outcome, "cli_exited");
  assert.equal(r.timing.at(-1).method, "mcpServerStatus/list", "nothing asked of an exited CLI");
});

test("a process that ignores the end of its input is ended after the bounded cleanup", OPTS, async () => {
  const f = fakeCodex("stubborn", { stubborn: true, never: ["mcpServerStatus/list"] });
  const t0 = performance.now();
  await probe(f, 1000);
  assert.ok(performance.now() - t0 < 1000 + CLEANUP_MS + 1500);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(f.pid()), false);
});

test("the timing: fixed fields only, and no secret from a refusal or the parameters", OPTS, async () => {
  const f = fakeCodex("refusal", { refuse: ["hooks/list", "mcpServerStatus/list"] });
  const r = await probeCodex({ executable: f.exe, cwd: f.dir, env: { PATH: process.env.PATH, OPENAI_API_KEY: SECRET }, timeoutMs: 3000 }, "srv1");
  // both refused with the secret in the message: the timing says protocol_error only
  assert.deepEqual(r.timing.filter((t) => t.outcome === "protocol_error").map((t) => t.method), ["hooks/list", "mcpServerStatus/list", "mcpServerStatus/list"]);
  assert.equal(mcpOf(r).incomplete, "request_failed");
  for (const t of r.timing) assert.deepEqual(Object.keys(t).sort(), ["allottedMs", "durationMs", "leftMs", "method", "outcome", "page", "startMs"]);
  const safe = safeReport({ providers: [{ provider: "codex", ...r }] });
  assert.ok(!JSON.stringify(r.timing).includes(SECRET) && !JSON.stringify(safe).includes(SECRET));
  assert.deepEqual(safeReport({ providers: [{ provider: "codex", ok: true, items: [], limitMs: 60000, timing: [
    { method: "mcpServerStatus/list", page: 1, startMs: 1, durationMs: 2, allottedMs: 3, leftMs: 4, outcome: "answered", params: SECRET },
    { method: `x ${SECRET}`, page: 1, startMs: 1, durationMs: 1, allottedMs: 1, leftMs: 1, outcome: "answered" },
    { method: "config/read", page: null, startMs: 1, durationMs: 1, allottedMs: 1, leftMs: 1, outcome: SECRET }] }] }).providers[0].timing,
  [{ method: "mcpServerStatus/list", page: 1, startMs: 1, durationMs: 2, allottedMs: 3, leftMs: 4, outcome: "answered" }]);
});

test("Claude: an mcp_status with no answer is a timeout told as no answer, timed, not a list", OPTS, async () => {
  const js = path.join(TMP, "claude-silent.mjs");
  fs.writeFileSync(js, `import readline from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); if (m.type !== "control_request" || m.request.subtype !== "initialize") return;
  out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: [], agents: [], models: [] } } }); });`);
  const exe = path.join(TMP, "claude-silent");
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${NODE}" "${js}" "$@"\n`, { mode: 0o755 });
  const r = await probeClaude({ executable: exe, cwd: TMP, env: { PATH: process.env.PATH }, timeoutMs: 1200 });
  const item = r.items.find((i) => i.id === "mcp");
  assert.deepEqual([item.confirmed, item.complete, item.incomplete, item.note], [false, false, "timeout", "no answer in time"]);
  assert.deepEqual(r.timing.map((t) => [t.method, t.outcome]), [["initialize", "answered"], ["mcp_status", "wait_expired"]]);
  assert.equal(s7Verdict({ state: "done", providers: [{ provider: "claude", ok: true, items: [item] }, { provider: "codex", ok: true, items: [{ id: "mcp", confirmed: true, complete: true, servers: [] }] }] }).ok, false);
});

// Established cause (2026-09-27): Node's timers count whole milliseconds of a cached clock and can fire before
// performance.now() reaches the deadline (measured: 36 of 400 waits, up to 1.6 ms early). The wait for the last page
// ended, `left()` was still a sliver above 0, and the readiness sent config/read in it (16 of 60 runs). Made
// deterministic here: the monotonic clock runs 1% slow against the timers, so every wait ends a few ms "early".
test("a wait that ends at the deadline ends the budget, even when the finer clock says a sliver is left", OPTS, async (t) => {
  const real = performance.now.bind(performance);
  const t0 = real();
  t.after(() => { performance.now = real; });
  performance.now = () => t0 + (real() - t0) * 0.99;
  const f = fakeCodex("early-timer", { pages: 2, delays: { "mcpServerStatus/list#2": 10_000 } });
  const r = await probeCodex({ executable: f.exe, cwd: f.dir, env: { PATH: process.env.PATH }, timeoutMs: 1500 }, "srv1");
  performance.now = real;
  const [p2] = listTimes(r).filter((x) => x.page === 2);
  assert.equal(p2.outcome, "wait_expired");
  assert.equal(mcpOf(r).incomplete, "timeout");
  assert.ok(!f.calls().slice(f.calls().lastIndexOf("mcpServerStatus/list") + 1).length, `nothing asked after the deadline's wait: ${f.calls().join(",")}`);
  assert.equal(r.readiness.error, "timeout: config/read not asked");
  assert.deepEqual(r.timing.filter((x) => x.startMs >= p2.startMs + p2.durationMs).map((x) => x.outcome).filter((o) => o !== "not_sent"), []);
});
