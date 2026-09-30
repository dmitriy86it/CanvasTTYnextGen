// Review repros for three stage-5 defects of the orchestration service (stage-5-contract.md): the run-wide runMs
// deadline and per-turn timeouts, a checkpoint published in Git whose checkpoint.created was never journaled, and a
// check result that outlives a replaced executable. Real service, Store, copy, Git and sandboxed checks; scripted
// test agents only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, after, test } from "node:test";
import { createOrchestrationService } from "../src/main/services/orchestration/orchestrationService.ts";
import { checkPreparedDeps, createRegistry } from "../src/main/services/orchestration/checks.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { readRun, readText } from "../src/main/services/orchestration/store.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "orchestration", "check-project");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform !== "darwin" && "the check sandbox is macOS only", timeout: 180_000 };
const LONG = 90_000;

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-svc-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "");
const g = (cwd, ...args) => execFileSync(GIT, args, {
  cwd, encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
}).trim();
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REGISTRY_ENTRIES = [
  { id: "ok", title: "passes at once", executable: NODE, argv: ["-e", "process.exit(0)"], timeoutMs: 60_000, maxOutputBytes: 8192 },
  { id: "sleep", title: "only waits", executable: NODE, argv: ["-e", "setTimeout(() => {}, 30000)"], timeoutMs: 120_000, maxOutputBytes: 8192 }
];
const registry = createRegistry(REGISTRY_ENTRIES);

let n = 0;
function project() {
  const root = path.join(TMP, `root-${++n}`);
  const src = path.join(TMP, `src-${n}`);
  fs.cpSync(FIXTURE, src, { recursive: true });
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fixture project");
  const deps = checkPreparedDeps({
    lockfileRelPath: "package-lock.json", lockfileSha256: sha(fs.readFileSync(path.join(src, "package-lock.json"))),
    nodeModulesPath: path.join(src, "node_modules")
  });
  return { root, src, deps };
}

const open = []; // handles to shut down after each test
function service(p, agents, extra = {}) {
  const svc = createOrchestrationService({
    root: p.root, gitPath: GIT, agents,
    checks: { registry: extra.registry ?? registry, deps: p.deps, launch: LAUNCH }, ...extra.deps
  });
  return {
    createRun: async (goal) => { const r = await svc.createRun({ source: p.src, goal }); open.push(r); return r; },
    openRun: async (runId) => { const r = await svc.openRun(runId); open.push(r); return r; }
  };
}
afterEach(async () => {
  for (const release of gates.splice(0)) release();
  for (const r of open.splice(0)) {
    try {
      const v = r.view();
      if (!v.halted && ["preparing", "running", "pausing", "paused"].includes(v.status)) await send(r, { kind: "stop" });
      await Promise.race([r.idle(), sleep(30_000)]);
    } catch { /* already failed or halted */ }
    await r.close().catch(() => {});
  }
});

const goal = (extra = {}) => ({ text: "make the sum right", criteria: ["tests pass"], checks: ["ok"], ...extra });
const send = (run, command, commandId = randomUUID(), expectedRevision = run.view().revision) =>
  run.command({ commandId, expectedRevision, command });
const gates = []; // released after each test, so a held turn never outlives it
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  gates.push(resolve);
  return { promise, resolve };
}
async function waitFor(pred, what, ms = LONG) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// Raw journal records in order (readRun shows an in-flight check as not_verified(interrupted)).
function journal(root, runId) {
  const out = [];
  for (const line of fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail while writing */ }
  }
  return out;
}
const ofType = (recs, type) => recs.filter((r) => r.type === type);
const statuses = (recs) => ofType(recs, "run.status").map((r) => r.data.reason ? `${r.data.status}(${r.data.reason})` : r.data.status);
const types = (recs) => recs.map((r) => r.type).filter((t) => !t.startsWith("command.")).join(" ");
async function state(root, runId) {
  let r = await readRun(root, runId);
  for (let i = 0; i < 50 && r.integrity.status === "torn_tail"; i++) { await sleep(20); r = await readRun(root, runId); }
  assert.equal(r.integrity.status, "ok", `journal integrity ${JSON.stringify(r.integrity)}`);
  return r.state;
}
const createdAt = async (p, runId) =>
  JSON.parse((await readText(p.root, runId, (await state(p.root, runId)).goal)).toString("utf8")).createdAt;
const turnIdsOf = (s, purpose) => Object.keys(s.orch.turns).filter((id) => s.orch.turns[id].purpose === purpose);
const count = (agents, purpose) => agents.log.filter((e) => e.purpose === purpose).length;
const status = (run) => { const v = run.view(); return v.status === "paused" ? `paused(${v.reason})` : v.status; };
// On a timeout the message carries the journal, which is what the before/after report is about.
const waitStatus = (p, run, want, ms) => waitFor(() => status(run) === want, `status ${want}`, ms)
  .catch((e) => { throw new Error(`${e.message}; now ${status(run)}; journal: ${types(journal(p.root, run.runId))}; statuses ${statuses(journal(p.root, run.runId)).join(",")}`); });
// Diagnostics for a precondition that is not reached: the run's status and its journal as a timeline, in ms since
// the run's createdAt (the origin of runMs), so a report shows whether the deadline passed first.
const timeline = (p, runId, t0) => journal(p.root, runId)
  .filter((r) => !r.type.startsWith("command."))
  .map((r) => `${Date.parse(r.ts) - t0}:${r.type}${r.type === "run.status" ? `(${r.data.status}${r.data.reason ? `/${r.data.reason}` : ""})` : r.data?.purpose ? `(${r.data.purpose})` : ""}`)
  .join(" ");
// The bound is on a run that stopped changing for quietMs, not on the whole preparation: on a held clock a slow machine
// only makes the preparation longer, which is not what these tests are about.
async function waitPre(p, run, t0, pred, what, quietMs) {
  let last = Date.now();
  const off = run.onChange(() => { last = Date.now(); });
  try {
    while (!(await pred())) {
      if (Date.now() - last > quietMs) {
        throw new Error(`timed out waiting for ${what}: no change for ${quietMs} ms; now ${status(run)}; +${Date.now() - t0} ms since createdAt; timeline ${timeline(p, run.runId, t0)}`);
      }
      await sleep(20);
    }
  } finally { off(); }
}
// The service's clock (deps.clock) stands still at the run's creation until the operation under test starts, then
// follows real time. release() runs from the run's onChange, which the service calls synchronously when it marks the
// operation active and just before it arms the deadline timer, so the timer gets the whole runMs from that moment.
// However slow the preparation (copy, plan turn, check setup), it cannot use up runMs before the operation exists.
// All deadline assertions below are in this clock's time (the time the service itself measures runMs in).
// A clock standing still is not enough: every earlier operation arms a real timer for deadline() - clock(), i.e. runMs,
// so one slow sandboxed check would hit the deadline before the operation under test. After createRun has read
// createdAt (synchronously, before its first await) createRun() below sets the clock back by BEHIND_MS, so those timers
// are armed for runMs + BEHIND_MS and the cycle never sees the deadline; release() puts it back at createdAt.
const BEHIND_MS = 3600_000;
function heldClock() {
  const held = Date.now();
  let behind = 0;
  let offset = null; // real ms minus service ms, once released
  return {
    held,
    now: () => (offset === null ? held - behind : Date.now() - offset),
    rewind() { behind = BEHIND_MS; },
    hold() { behind = 0; }, // back at createdAt, standing still: a deadline timer armed now waits for release()
    get released() { return offset !== null; },
    get heldMs() { return offset; }, // real time the preparation took while the clock stood still
    release() { if (offset === null) offset = Date.now() - held; }
  };
}
// createRun on a held clock: the run's createdAt is the held instant, then the clock goes behind it until release().
async function createHeld(svc, clock, goal) {
  const pending = svc.createRun(goal);
  clock.rewind();
  return pending;
}
function releaseWhen(run, clock, pred) {
  const check = () => { if (!clock.released && pred(run.view())) clock.release(); };
  const off = run.onChange(check);
  check();
  return off;
}
const activeTurn = (run, purpose) => { const a = run.view().active; return a?.kind === "turn" && a.purpose === purpose; };

// Records every request (with its time) and every stop() the service calls.
function watched(agents, now = () => Date.now()) {
  const requests = [];
  const stops = [];
  return {
    get log() { return agents.log; },
    requests, stops,
    prepare(req) {
      requests.push({ ...req, at: Date.now() });
      const p = agents.prepare(req);
      if (!p.ok) return p;
      return {
        ...p,
        start() {
          const t = p.start();
          return { sessionId: t.sessionId, result: t.result, stop() { stops.push({ purpose: req.purpose, at: now() }); t.stop(); } };
        }
      };
    }
  };
}

const defaults = {
  plan: { report: plan("one") },
  execute: { report: executed() },
  review: { report: review("accept") },
  final_review: { report: review("complete") }
};
const never = new Promise(() => {});

// ---------------- 1. runMs: one deadline for the whole run ----------------

test("runMs expires during an executor turn: the turn is stopped, turn.finished(stopped), paused(limit_reached)", OPTS, async (t) => {
  const p = project();
  const clock = heldClock();
  const agents = watched(createTestAgents({ ...defaults, execute: { hold: never, report: executed() } }), clock.now);
  const run = await createHeld(service(p, agents, { deps: { stopGraceMs: 1000, clock: clock.now } }), clock, goal({ limits: { runMs: 3000 } }));
  const t0 = await createdAt(p, run.runId);
  assert.equal(t0, clock.held, "createdAt is the held instant");
  const off = releaseWhen(run, clock, (v) => v.active?.kind === "turn" && v.active.purpose === "execute");
  await waitPre(p, run, t0, () => clock.released, "the executor turn", LONG);
  off();
  t.diagnostic(`executor turn started; service clock released after ${clock.heldMs} ms of preparation (runMs 3000)`);
  assert.ok(activeTurn(run, "execute") && clock.now() < t0 + 3000, "precondition: the executor turn started before the deadline");

  await waitStatus(p, run, "paused(limit_reached)", 3000 + 1000 + 4000);
  assert.ok(clock.now() - t0 < 3000 + 1000 + 3000, "paused around the deadline, not later");
  assert.deepEqual(agents.stops.map((s) => s.purpose), ["execute"], "the service stopped the running turn");
  assert.ok(agents.stops[0].at >= t0 + 3000 - 50, "not before the deadline");
  const recs = journal(p.root, run.runId);
  const s = await state(p.root, run.runId);
  const [execId] = turnIdsOf(s, "execute");
  assert.equal(s.turns[execId].status, "stopped", "turn.finished records the stop");
  const finished = ofType(recs, "turn.finished").find((r) => r.data.turnId === execId).seq;
  const paused = ofType(recs, "run.status").at(-1);
  assert.deepEqual([paused.data.status, paused.data.reason], ["paused", "limit_reached"]);
  assert.ok(finished < paused.seq, "the turn's fact comes before the pause");
  assert.deepEqual(s.checks, {}, "nothing after the stopped turn");
  await sleep(500);
  assert.equal(agents.log.length, 2, "no new turn");
});

test("runMs expires during a check: the check is not_verified(stopped), paused(limit_reached), no review", OPTS, async (t) => {
  const p = project();
  const clock = heldClock();
  const agents = watched(createTestAgents(defaults), clock.now);
  const runMs = 6000;
  const run = await createHeld(service(p, agents, { deps: { stopGraceMs: 1500, clock: clock.now } }), clock, goal({ checks: ["sleep"], limits: { runMs } }));
  const t0 = await createdAt(p, run.runId);
  assert.equal(t0, clock.held, "createdAt is the held instant");
  // The check operation includes its preflight and sandbox selftest, which come before check.started and can take
  // longer than runMs on a loaded machine. The clock stands at createdAt from the moment the check is active (the
  // deadline timer, armed then, re-arms while the service's clock says there is time left) and follows real time
  // from check.started, so runMs runs out while the check's process runs, however slow its setup.
  const hold = () => { if (run.view().active?.kind === "check") clock.hold(); };
  const off = run.onChange(hold);
  hold();
  await waitPre(p, run, t0, () => ofType(journal(p.root, run.runId), "check.started").length === 1, "check.started", LONG);
  off();
  clock.release();
  t.diagnostic(`check.started; service clock released after ${clock.heldMs} ms of preparation (runMs ${runMs})`);
  assert.ok(clock.now() < t0 + runMs, "precondition: the check started before the deadline");

  await waitStatus(p, run, "paused(limit_reached)", runMs + 1500 + 5000);
  assert.ok(clock.now() - t0 < 15_000, "stopped at the deadline, not after the 30 s sleep");
  await waitFor(() => ofType(journal(p.root, run.runId), "check.finished").length === 1, "check.finished", 10_000);
  const recs = journal(p.root, run.runId);
  const fin = ofType(recs, "check.finished")[0].data;
  assert.deepEqual([fin.status, fin.reason], ["not_verified", "stopped"]);
  assert.equal(count(agents, "review"), 0, "no review after the stopped check");
  assert.equal(ofType(recs, "check.started").length, 1, "no further check");
  assert.deepEqual(statuses(recs).slice(-1), ["paused(limit_reached)"]);
});

test("late answer after the deadline: turn.finished is a fact, no review.recorded, no completed", OPTS, async () => {
  const p = project();
  const gate = deferred();
  // the service's clock is held until the final review starts (heldClock), so the preparation cannot use up runMs
  const clock = heldClock();
  const runMs = 3000;
  const agents = watched(createTestAgents({ ...defaults, final_review: { hold: gate.promise, ignoreStop: true, report: review("complete") } }), clock.now);
  const run = await createHeld(service(p, agents, { deps: { stopGraceMs: 800, clock: clock.now } }), clock, goal({ limits: { runMs } }));
  const t0 = await createdAt(p, run.runId);
  assert.equal(t0, clock.held, "createdAt is the held instant");
  const off = releaseWhen(run, clock, (v) => v.active?.kind === "turn" && v.active.purpose === "final_review");
  await waitPre(p, run, t0, () => clock.released, "the final review", LONG);
  off();
  assert.ok(activeTurn(run, "final_review") && clock.now() < t0 + runMs, "precondition: the final review started before the deadline");

  // past the deadline and the grace: the service must have given up on the turn
  await waitStatus(p, run, "paused(limit_reached)", runMs + 800 + 5000);
  assert.deepEqual(agents.stops.map((s) => s.purpose), ["final_review"]);
  assert.ok(agents.stops[0].at >= t0 + runMs - 50, "stopped at the deadline, not before");

  gate.resolve(); // the lead answers "complete" after all
  const s0 = await state(p.root, run.runId);
  const [finalId] = turnIdsOf(s0, "final_review");
  await waitFor(async () => (await state(p.root, run.runId)).turns[finalId].status !== "in_flight", "the late turn.finished", 10_000);
  await sleep(800);
  const recs = journal(p.root, run.runId);
  const s = await state(p.root, run.runId);
  assert.equal(s.turns[finalId].status, "completed", "the late answer is recorded as a fact");
  assert.equal(ofType(recs, "review.recorded").filter((r) => r.data.turnId === finalId).length, 0, "but not as a review");
  assert.ok(!statuses(recs).includes("completed"), `no completed: ${statuses(recs).join(",")}`);
  assert.equal(status(run), "paused(limit_reached)");
  assert.equal(count(agents, "final_review"), 1);
});

test("a run within its runMs budget completes as before", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents(defaults));
  const run = await service(p, agents, { deps: { stopGraceMs: 800 } }).createRun(goal({ limits: { runMs: 60_000 } }));
  await waitStatus(p, run, "completed", 60_000);
  assert.equal(agents.stops.length, 0, "nothing was stopped");
  assert.deepEqual(agents.log.map((e) => e.purpose), ["plan", "execute", "review", "final_review"]);
});

test("the timeoutMs given to an agent is min(role limit, time left of runMs)", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents(defaults));
  const runMs = 60_000, leadTurnMs = 5000;
  const run = await service(p, agents).createRun(goal({ limits: { runMs, leadTurnMs } }));
  await waitStatus(p, run, "completed", 60_000);
  const t0 = await createdAt(p, run.runId);
  for (const r of agents.requests) {
    const left = t0 + runMs - r.at;
    const want = Math.min(r.role === "lead" ? leadTurnMs : 45 * 60_000, left);
    assert.ok(r.timeoutMs <= want + 50 && r.timeoutMs >= want - 2000, `${r.purpose}: timeoutMs ${r.timeoutMs}, expected ≈ ${want}`);
  }
  const exec = agents.requests.find((r) => r.purpose === "execute");
  assert.ok(exec.timeoutMs <= runMs, `the executor's 45 min are cut to what is left of runMs (${exec.timeoutMs})`);
  for (const e of agents.log) if (e.timeoutMs !== undefined) {
    assert.equal(e.timeoutMs, agents.requests[agents.log.indexOf(e)].timeoutMs, "the agent log carries the same timeoutMs");
  }
});

test("executorTurnMs is enforced by the service: stop() at the timeout, turn.finished(stopped), paused(environment_error)", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents({ ...defaults, execute: { hold: never, report: executed() } }));
  const run = await service(p, agents, { deps: { stopGraceMs: 1000 } }).createRun(goal({ limits: { executorTurnMs: 1500 } }));
  await waitFor(() => activeTurn(run, "execute"), "the executor turn", 10_000);
  const started = Date.now();
  await waitStatus(p, run, "paused(environment_error)", 1500 + 1000 + 5000);
  assert.deepEqual(agents.stops.map((s) => s.purpose), ["execute"]);
  assert.ok(agents.stops[0].at - started >= 1300, `stopped at the turn timeout, not earlier (${agents.stops[0].at - started} ms)`);
  const s = await state(p.root, run.runId);
  const [execId] = turnIdsOf(s, "execute");
  assert.equal(s.turns[execId].status, "stopped");
  assert.deepEqual(s.checks, {});
});

test("after the deadline no internal step runs either: reopen, resume → paused(limit_reached), no completed", OPTS, async () => {
  const p = project();
  const gate = deferred();
  // the first service's clock never leaves the run's creation (heldClock, not released): the run pauses before its
  // deadline however slow the machine; the second service's clock stands past the deadline
  const clock = heldClock();
  const runMs = 3000;
  const agents = watched(createTestAgents({ ...defaults, final_review: { hold: gate.promise, report: review("complete") } }), clock.now);
  const run = await createHeld(service(p, agents, { deps: { clock: clock.now } }), clock, goal({ limits: { runMs } }));
  const t0 = await createdAt(p, run.runId);
  assert.equal(t0, clock.held, "createdAt is the held instant");
  await waitPre(p, run, t0, () => activeTurn(run, "final_review"), "the final review", LONG);
  assert.ok(clock.now() < t0 + runMs, "precondition: the final review started before the deadline");
  assert.equal((await send(run, { kind: "pause_after_turn", on: true })).status, "accepted");
  gate.resolve();
  await waitStatus(p, run, "paused(user_request)", 5000);
  assert.ok(clock.now() < t0 + runMs, "precondition: paused before the deadline, the next step is `completed`");
  await run.close();
  open.splice(open.indexOf(run), 1);

  const agents2 = watched(createTestAgents(defaults));
  const again = await service(p, agents2, { deps: { clock: () => t0 + runMs + 300 } }).openRun(run.runId);
  await sleep(800);
  assert.equal(agents2.log.length, 0, "nothing starts on reopen");
  assert.ok(again.view().status === "paused", `reopened paused (${status(again)})`);
  const size = journal(p.root, run.runId).length;
  assert.equal((await send(again, { kind: "resume" })).status, "accepted");
  await waitFor(() => status(again) !== "running", "the run to settle", 10_000);
  await again.idle();
  const recs = journal(p.root, run.runId).slice(size);
  assert.equal(status(again), "paused(limit_reached)", `after resume: ${types(recs)} / ${statuses(recs).join(",")}`);
  assert.deepEqual(recs.filter((r) => ["stage.accepted", "checkpoint.created", "turn.intent", "check.started"].includes(r.type)), []);
  assert.equal(agents2.log.length, 0);
});

test("raise_limit runMs: a value with no future deadline is invalid_command; a sufficient one → user_request, resume completes", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents({ ...defaults, execute: (_r, k) => k === 1 ? { delayMs: 3500, report: executed() } : { report: executed() } }));
  const run = await service(p, agents, { deps: { stopGraceMs: 800 } }).createRun(goal({ limits: { runMs: 3000 } }));
  const t0 = await createdAt(p, run.runId);
  await waitStatus(p, run, "paused(limit_reached)", 15_000);
  await sleep(t0 + 5500 - Date.now());

  const low = await send(run, { kind: "raise_limit", limit: "runMs", value: 4000 }); // above 3000, but createdAt + 4000 is past
  assert.deepEqual(low, { status: "rejected", code: "invalid_command" });
  assert.equal(status(run), "paused(limit_reached)");
  assert.deepEqual(await send(run, { kind: "raise_limit", limit: "runMs", value: 120_000 }), { status: "accepted", code: null });
  assert.equal(status(run), "paused(user_request)");
  assert.equal((await send(run, { kind: "resume" })).status, "accepted");
  await waitStatus(p, run, "completed", 60_000);
});

// ---------------- 2. A published checkpoint whose checkpoint.created was not journaled ----------------

// Fails every journal write whose line satisfies `when`, once armed; nothing of that line reaches the file.
function faultyIo(when) {
  const io = {
    armed: true, failed: 0,
    async write(fh, buf) {
      if (io.armed && when(buf.toString("utf8"))) { io.failed++; throw new Error("review: the disk is gone"); }
      return fh.write(buf);
    }
  };
  return io;
}

// Runs to the failing checkpoint.created of `stage`, then closes the halted handle. The ref is in Git, the event not.
async function haltAtCheckpoint(p, stages, stage) {
  const io = faultyIo((line) => line.includes('"type":"checkpoint.created"') && line.includes(`"stage":${stage},`));
  const agents = watched(createTestAgents({ ...defaults, plan: { report: plan(...stages) } }));
  const run = await service(p, agents, { deps: { storeIo: io } }).createRun(goal());
  await waitFor(() => run.view().halted, "halted", LONG);
  await waitFor(() => !run.view().active, "no active operation", 10_000);
  assert.equal(io.failed, 1);
  const ref = `refs/canvastty/${run.runId}/stage-${stage}`;
  const commit = g(p.src, "rev-parse", ref);
  const recs = journal(p.root, run.runId);
  assert.equal(ofType(recs, "stage.accepted").length, stage);
  assert.equal(ofType(recs, "checkpoint.created").length, stage - 1);
  await run.close();
  open.splice(open.indexOf(run), 1);
  io.armed = false;
  return { runId: run.runId, ref, commit, logBefore: agents.log.length };
}

for (const [stages, stage] of [[["one"], 1], [["one", "two"], 2]]) {
  test(`checkpoint ${stage} in Git without checkpoint.created: reopen pauses, resume records it with the same commit and completes`, OPTS, async () => {
    const p = project();
    const mainBefore = g(p.src, "rev-parse", "main");
    const headBefore = g(p.src, "rev-parse", "HEAD");
    const h = await haltAtCheckpoint(p, stages, stage);

    const agents = watched(createTestAgents({ ...defaults, plan: { report: plan(...stages) } }));
    const run = await service(p, agents).openRun(h.runId);
    assert.equal(status(run), "paused(recovered)");
    let s = await state(p.root, h.runId);
    assert.equal(s.orch.pendingCheckpoint, stage);
    await sleep(800);
    assert.equal(agents.log.length, 0, "nothing starts on reopen");

    assert.equal((await send(run, { kind: "resume" })).status, "accepted");
    await waitFor(() => !["running", "pausing"].includes(run.view().status), "the run to settle", LONG);
    await run.idle();
    assert.equal(status(run), "completed", `journal: ${types(journal(p.root, h.runId))}`);
    s = await state(p.root, h.runId);
    assert.equal(s.workspace.checkpoints[String(stage)].commit, h.commit, "checkpoint.created with the published commit");
    assert.equal(g(p.src, "rev-parse", h.ref), h.commit, "the ref was not recreated");
    const cps = ofType(journal(p.root, h.runId), "checkpoint.created").map((r) => r.data.stage);
    assert.deepEqual(cps, stages.map((_, i) => i + 1), "one checkpoint.created per stage");
    assert.equal(g(p.src, "rev-parse", "main"), mainBefore, "the user's branch did not move");
    assert.equal(g(p.src, "rev-parse", "HEAD"), headBefore);
  });
}

const tampers = {
  "another tree and message": (p, h) => {
    const empty = g(p.src, "mktree");
    return g(p.src, "commit-tree", empty, "-p", g(p.src, "rev-parse", `${h.commit}^`), "-m", "not a checkpoint");
  },
  // what createCheckpoint's reuse check (tree + parent) alone would let through
  "the same tree and parent, another message": (p, h) =>
    g(p.src, "commit-tree", g(p.src, "rev-parse", `${h.commit}^{tree}`), "-p", g(p.src, "rev-parse", `${h.commit}^`), "-m", "CanvasTTY checkpoint: stage 1")
};
for (const [name, forge] of Object.entries(tampers)) {
  test(`checkpoint 1 in Git rewritten after the failure (${name}): resume → paused(shared_git_tampered), nothing recorded`, OPTS, async () => {
    const p = project();
    const mainBefore = g(p.src, "rev-parse", "main");
    const h = await haltAtCheckpoint(p, ["one"], 1);
    const forged = forge(p, h);
    assert.notEqual(forged, h.commit);
    g(p.src, "update-ref", h.ref, forged);

    const agents = watched(createTestAgents(defaults));
    const run = await service(p, agents).openRun(h.runId);
    assert.equal((await send(run, { kind: "resume" })).status, "accepted");
    await waitFor(() => status(run) !== "running", "the run to settle", 30_000);
    await run.idle();
    assert.equal(status(run), "paused(shared_git_tampered)", `journal: ${types(journal(p.root, h.runId))}`);
    assert.deepEqual(ofType(journal(p.root, h.runId), "checkpoint.created"), []);
    assert.equal(agents.log.length, 0);
    assert.equal(g(p.src, "rev-parse", h.ref), forged, "the service does not rewrite the ref");
    assert.equal(g(p.src, "rev-parse", "main"), mainBefore);
  });
}

// ---------------- 3. A check result is about the executable's current content ----------------

// A trusted executable outside the copy and the source (absolute, its own realpath). Its content is replaced by
// writing a sibling file and renaming it over the path: same path, same argv, other bytes.
function exeCheck(name) {
  const dir = path.join(TMP, `bin-${name}`);
  fs.mkdirSync(dir);
  const exe = path.join(dir, "check");
  const put = (code) => {
    const tmp = path.join(dir, `.check-${randomUUID()}`);
    fs.writeFileSync(tmp, `#!/bin/sh\n# ${randomUUID()}\nexit ${code}\n`, { mode: 0o755 });
    fs.renameSync(tmp, exe);
  };
  put(0);
  const reg = createRegistry([{ id: "exe", title: "the replaceable check", executable: fs.realpathSync(exe), argv: [], timeoutMs: 60_000, maxOutputBytes: 8192 }]);
  return { reg, put };
}
const checkStatuses = (recs) => ofType(recs, "check.finished").map((r) => r.data.status);

test("executable replaced while the lead reviews: a new check fails, the stage is not accepted on the old result", OPTS, async () => {
  const p = project();
  const e = exeCheck("a");
  const gate = deferred();
  const agents = watched(createTestAgents({
    ...defaults,
    // round 2 puts the passing program back and changes the tree, so the run can finish on a real passed check
    execute: (_r, k) => k === 1 ? { report: executed() } : (e.put(0), { report: executed(), edit: (c) => fs.writeFileSync(c.path("fixed.txt"), "x\n") }),
    review: (_r, k) => k === 1 ? { hold: gate.promise, report: review("accept") } : { report: review("accept") }
  }));
  const run = await service(p, agents, { registry: e.reg }).createRun(goal({ checks: ["exe"] }));
  await waitFor(() => activeTurn(run, "review"), "the first review", LONG);
  assert.deepEqual(checkStatuses(journal(p.root, run.runId)), ["passed"], "precondition: the check passed");
  e.put(1);
  gate.resolve();
  await waitFor(() => ["completed", "paused", "stopped", "failed"].includes(run.view().status), "the run to settle", LONG);
  await run.idle();
  const recs = journal(p.root, run.runId);
  assert.ok(ofType(recs, "check.started").length >= 2, `a new check after the replacement: ${types(recs)}`);
  assert.equal(checkStatuses(recs)[1], "failed", "the replaced program fails");
  const firstAccept = ofType(recs, "stage.accepted")[0];
  const failedSeq = ofType(recs, "check.finished")[1].seq;
  assert.ok(!firstAccept || firstAccept.seq > failedSeq, "no stage.accepted on the stale passed result");
  assert.equal(count(agents, "execute"), 2, "the executor got the stage back");
  assert.equal(status(run), "completed", `statuses ${statuses(recs).join(",")}`);
  assert.equal(checkStatuses(recs).at(-1), "passed");
});

test("executable replaced, then close and reopen: resume does not reuse the old passed result", OPTS, async () => {
  const p = project();
  const e = exeCheck("b");
  const gate = deferred();
  const agents = watched(createTestAgents({ ...defaults, review: { hold: gate.promise, report: review("accept") } }));
  const run = await service(p, agents, { registry: e.reg }).createRun(goal({ checks: ["exe"] }));
  await waitFor(() => activeTurn(run, "review"), "the review", LONG);
  assert.equal((await send(run, { kind: "pause_after_turn", on: true })).status, "accepted");
  gate.resolve();
  await waitStatus(p, run, "paused(user_request)", 10_000);
  await run.close();
  open.splice(open.indexOf(run), 1);
  e.put(1);

  const agents2 = watched(createTestAgents({
    ...defaults,
    execute: () => (e.put(0), { report: executed(), edit: (c) => fs.writeFileSync(c.path("fixed.txt"), "x\n") })
  }));
  const again = await service(p, agents2, { registry: e.reg }).openRun(run.runId);
  const size = journal(p.root, run.runId).length;
  assert.equal((await send(again, { kind: "resume" })).status, "accepted");
  await waitFor(() => ["completed", "paused", "stopped", "failed"].includes(again.view().status), "the run to settle", LONG);
  await again.idle();
  const recs = journal(p.root, run.runId).slice(size);
  assert.ok(ofType(recs, "check.started").length >= 1, `the check runs again after reopen: ${types(recs)}`);
  assert.equal(checkStatuses(recs)[0], "failed");
  const acc = ofType(recs, "stage.accepted")[0];
  assert.ok(!acc || acc.seq > ofType(recs, "check.finished")[0].seq, "no stage.accepted on the old result");
  assert.equal(count(agents2, "execute"), 1, "the executor got the stage back");
  assert.equal(status(again), "completed", `statuses ${statuses(recs).join(",")}`);
});

test("executable unchanged across close, reopen and resume: no repeated check", OPTS, async () => {
  const p = project();
  const e = exeCheck("c");
  const gate = deferred();
  const agents = watched(createTestAgents({ ...defaults, review: { hold: gate.promise, report: review("accept") } }));
  const run = await service(p, agents, { registry: e.reg }).createRun(goal({ checks: ["exe"] }));
  await waitFor(() => activeTurn(run, "review"), "the review", LONG);
  assert.equal((await send(run, { kind: "pause_after_turn", on: true })).status, "accepted");
  gate.resolve();
  await waitStatus(p, run, "paused(user_request)", 10_000);
  await run.close();
  open.splice(open.indexOf(run), 1);

  const agents2 = watched(createTestAgents(defaults));
  const again = await service(p, agents2, { registry: e.reg }).openRun(run.runId);
  assert.equal((await send(again, { kind: "resume" })).status, "accepted");
  await waitStatus(p, again, "completed", LONG);
  const recs = journal(p.root, run.runId);
  assert.equal(ofType(recs, "check.started").length, 1, "the passed result is reused");
  assert.deepEqual(agents2.log.map((x) => x.purpose), ["final_review"]);
});
