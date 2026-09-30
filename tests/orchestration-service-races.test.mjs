// Races and failures of the orchestration service (stage-5-contract.md §1, §5, §6, §7, §10, §12, §13): stop, pause and
// step against a running turn or check, late answers, duplicate and stale commands, limits, loops without progress,
// a clarification during the final review, a failing journal write and a crash with an operation in flight.
// Every scenario runs the real service, Store, copy and sandboxed checks with the scripted test agents, and asserts
// both what the handle reports and what the journal says.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, after, test } from "node:test";
import { createOrchestrationService } from "../src/main/services/orchestration/orchestrationService.ts";
import { checkPreparedDeps, createRegistry } from "../src/main/services/orchestration/checks.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { readRun } from "../src/main/services/orchestration/store.ts";
import { createRunManager } from "../src/main/services/orchestration/manager.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "orchestration", "check-project");
const CRASH_CHILD = path.join(HERE, "fixtures", "orchestration", "chaos-crash-child.mjs");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const SUPERVISOR = path.join(HERE, "..", "src", "orchestration", "supervisor.mjs");
const LAUNCH = { command: NODE, args: [SUPERVISOR], env: {} };
const OPTS = { skip: process.platform !== "darwin" && "the check sandbox is macOS only", timeout: 180_000 };
const LONG = 90_000;

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-chaos-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "");
const g = (cwd, ...args) => execFileSync(GIT, args, {
  cwd,
  env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  encoding: "utf8"
}).trim();
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sleepCheck = (marker = "chaos") => ({
  id: "sleep", title: "a check that only waits", executable: NODE,
  argv: ["-e", `setTimeout(() => {}, 30000) /* ${marker} */`], timeoutMs: 120_000, maxOutputBytes: 8192
});
const REGISTRY_ENTRIES = [
  { id: "unit", title: "unit tests", executable: NODE, argv: ["--test", "tests/sum.test.mjs"], timeoutMs: 120_000, maxOutputBytes: 65_536 },
  { id: "unit-broken", title: "the failing test", executable: NODE, argv: ["--test", "tests/broken.test.mjs"], timeoutMs: 120_000, maxOutputBytes: 65_536 },
  sleepCheck()
];
const registry = createRegistry(REGISTRY_ENTRIES);

let n = 0;
// A source project with prepared dependencies (as in orchestration-check-integration.test.mjs) and its own root.
function project() {
  const root = path.join(TMP, `root-${++n}`);
  const src = path.join(TMP, `src-${n}`);
  fs.cpSync(FIXTURE, src, { recursive: true });
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => ` ${s}`;\n");
  fs.writeFileSync(path.join(src, "node_modules", ".package-lock.json"), "{}\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fixture project");
  const depsInput = {
    lockfileRelPath: "package-lock.json",
    lockfileSha256: sha(fs.readFileSync(path.join(src, "package-lock.json"))),
    nodeModulesPath: path.join(src, "node_modules")
  };
  return { root, src, depsInput, deps: checkPreparedDeps(depsInput) };
}

const open = []; // run handles still to be shut down after the test
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
  for (const r of open.splice(0)) {
    try {
      const v = r.view();
      if (!v.halted && ["preparing", "running", "pausing", "paused"].includes(v.status)) await send(r, { kind: "stop" });
      await Promise.race([r.idle(), sleep(30_000)]);
    } catch { /* the test already failed or the handle is halted */ }
    await r.close().catch(() => {});
  }
});

const goal = (extra = {}) => ({ text: "make the sum right", criteria: ["tests pass"], checks: ["unit"], ...extra });
const send = (run, command, commandId = randomUUID(), expectedRevision = run.view().revision) =>
  run.command({ commandId, expectedRevision, command });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
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

// Raw journal records in order; a line still being written is skipped.
function journal(root, runId) {
  const file = path.join(root, "runs", runId, "journal.jsonl");
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail while writing */ }
  }
  return out;
}
const ofType = (recs, type) => recs.filter((r) => r.type === type);
const statuses = (recs) => ofType(recs, "run.status").map((r) => r.data.reason ? `${r.data.status}(${r.data.reason})` : r.data.status);
// readRun takes no lock: a line being appended right now shows up as torn_tail, so that is retried briefly.
async function state(root, runId) {
  let r = await readRun(root, runId);
  for (let i = 0; i < 50 && r.integrity.status === "torn_tail"; i++) { await sleep(20); r = await readRun(root, runId); }
  const { state: s, integrity } = r;
  assert.equal(integrity.status, "ok", `journal integrity ${JSON.stringify(integrity)}`);
  return s;
}
// turnIds of a purpose in orch.turn order
const turnIdsOf = (s, purpose) => Object.keys(s.orch.turns).filter((id) => s.orch.turns[id].purpose === purpose);
const purposes = (agents) => agents.log.map((e) => e.purpose);
const count = (agents, purpose) => purposes(agents).filter((p) => p === purpose).length;
const status = (run) => { const v = run.view(); return v.status === "paused" ? `paused(${v.reason})` : v.status; };
const waitStatus = (run, want, ms) => waitFor(() => status(run) === want, `status ${want} (now ${status(run)})`, ms);
const activeTurn = (run, purpose) => { const a = run.view().active; return a?.kind === "turn" && a.purpose === purpose; };

// Records every request and every stop() call; optionally defers the real stop so "stopping" is observable.
function watched(agents, { stopDelayMs = 0 } = {}) {
  const requests = [];
  const stops = [];
  return {
    get log() { return agents.log; },
    requests, stops,
    prepare(req) {
      requests.push(req);
      const p = agents.prepare(req);
      if (!p.ok) return p;
      return {
        ...p,
        start() {
          const t = p.start();
          return {
            sessionId: t.sessionId, result: t.result,
            stop() {
              stops.push({ purpose: req.purpose, at: Date.now() });
              if (stopDelayMs) setTimeout(() => t.stop(), stopDelayMs); else t.stop();
            }
          };
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
const writeFile = (name, content) => (repo) => fs.writeFileSync(repo.path(name), content);

// ---- 1. Stop during an agent turn ----

test("stop during an executor turn: answered at once, stopping, the turn is stopped, then stopped and nothing more", OPTS, async () => {
  const p = project();
  const gate = deferred();
  const agents = watched(createTestAgents({ ...defaults, execute: { hold: gate.promise, report: executed() } }), { stopDelayMs: 400 });
  const run = await service(p, agents).createRun(goal());
  await waitFor(() => activeTurn(run, "execute"), "the executor turn");

  const t0 = Date.now();
  const res = await send(run, { kind: "stop" });
  const elapsed = Date.now() - t0;
  assert.deepEqual(res, { status: "accepted", code: null });
  assert.ok(elapsed < 1000, `stop must not wait for the turn (${elapsed} ms)`);
  assert.equal(run.view().status, "stopping", "the turn has not finished yet, so the run is stopping");

  await waitStatus(run, "stopped", 10_000);
  assert.equal(agents.stops.length, 1, "the service called stop() of the active turn once");
  assert.equal(agents.stops[0].purpose, "execute");
  const executeEntry = agents.log.find((e) => e.purpose === "execute");
  assert.ok(executeEntry.stopped && executeEntry.settled);

  const frozen = agents.log.length;
  await sleep(800);
  assert.equal(agents.log.length, frozen, "no turn starts after stop");
  assert.equal(run.view().status, "stopped");

  const recs = journal(p.root, run.runId);
  const st = statuses(recs);
  assert.deepEqual(st.slice(-2), ["stopping", "stopped"]);
  const s = await state(p.root, run.runId);
  const [execId] = turnIdsOf(s, "execute");
  assert.equal(s.turns[execId].status, "stopped", "turn.finished records outcome stopped");
  const finishedSeq = ofType(recs, "turn.finished").find((r) => r.data.turnId === execId).seq;
  const stoppedSeq = ofType(recs, "run.status").at(-1).seq;
  assert.ok(finishedSeq < stoppedSeq, "stopped is written after the turn's facts");
  assert.deepEqual(s.checks, {}, "no check ran");
});

// ---- 2. Stop during a check ----

test("stop during a check: the check is not_verified(stopped), the run is stopped, no review follows", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents(defaults));
  const run = await service(p, agents, { deps: { stopGraceMs: 60_000 } }).createRun(goal({ checks: ["sleep"] }));
  await waitFor(() => run.view().active?.kind === "check", "the check to become active");
  // raw journal: readRun shows an in-flight check as not_verified(interrupted), the view of a closed run
  await waitFor(() => ofType(journal(p.root, run.runId), "check.started").length === 1, "check.started in the journal");

  const t0 = Date.now();
  const res = await send(run, { kind: "stop" });
  assert.equal(res.status, "accepted");
  assert.ok(Date.now() - t0 < 1000, "stop answers at once while the check runs");
  assert.equal(run.view().status, "stopping");
  await waitStatus(run, "stopped", 25_000);
  assert.ok(Date.now() - t0 < 25_000, "stopped because the check was stopped, not because its 30 s sleep ended");

  const s = await state(p.root, run.runId);
  const checks = Object.values(s.checks);
  assert.equal(checks.length, 1);
  assert.deepEqual([checks[0].checkId, checks[0].status, checks[0].reason], ["sleep", "not_verified", "stopped"]);
  const st = statuses(journal(p.root, run.runId));
  assert.deepEqual(st.slice(-2), ["stopping", "stopped"]);
  await sleep(800);
  assert.equal(count(agents, "review"), 0, "no review turn after a stop");
  assert.deepEqual(turnIdsOf(await state(p.root, run.runId), "review"), []);
  assert.equal(Object.keys((await state(p.root, run.runId)).checks).length, 1, "no further check");
});

// ---- 3. Late answer ----

test("late answer after the grace: stopped without the turn, the late turn.finished is recorded, nothing continues", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents({ ...defaults, execute: { ignoreStop: true, delayMs: 2500, report: executed("late") } }));
  const run = await service(p, agents, { deps: { stopGraceMs: 400 } }).createRun(goal());
  await waitFor(() => activeTurn(run, "execute"), "the executor turn");

  const t0 = Date.now();
  assert.equal((await send(run, { kind: "stop" })).status, "accepted");
  await waitStatus(run, "stopped", 5_000);
  const stoppedAfter = Date.now() - t0;
  assert.ok(stoppedAfter >= 350, `stopped only after stopGraceMs (${stoppedAfter} ms)`);
  assert.ok(stoppedAfter < 2000, `stopped before the late answer (${stoppedAfter} ms)`);
  let s = await state(p.root, run.runId);
  const [execId] = turnIdsOf(s, "execute");
  assert.equal(s.turns[execId].status, "in_flight", "the turn stays unfinished in the journal at stopped");
  assert.equal(agents.stops.length, 1);

  await waitFor(async () => (await state(p.root, run.runId)).turns[execId].status !== "in_flight", "the late turn.finished", 10_000);
  s = await state(p.root, run.runId);
  assert.equal(s.turns[execId].status, "completed", "the late result is a recorded fact");
  assert.equal(s.status, "stopped", "and does not change the terminal status");
  const recs = journal(p.root, run.runId);
  const stoppedSeq = ofType(recs, "run.status").find((r) => r.data.status === "stopped").seq;
  const lateSeq = ofType(recs, "turn.finished").find((r) => r.data.turnId === execId).seq;
  assert.ok(stoppedSeq < lateSeq);
  assert.deepEqual(statuses(recs).slice(-2), ["stopping", "stopped"], "no status after the late answer");

  const frozen = agents.log.length;
  await sleep(1500);
  assert.equal(agents.log.length, frozen, "the late answer starts nothing");
  assert.deepEqual((await state(p.root, run.runId)).checks, {}, "not even a check");
  assert.equal(run.view().status, "stopped");
});

test("late answer within the grace: stopped only after the late turn.finished, and nothing continues", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents({ ...defaults, execute: { ignoreStop: true, delayMs: 1200, report: executed("late") } }));
  const run = await service(p, agents, { deps: { stopGraceMs: 20_000 } }).createRun(goal());
  await waitFor(() => activeTurn(run, "execute"), "the executor turn");

  const t0 = Date.now();
  assert.equal((await send(run, { kind: "stop" })).status, "accepted");
  assert.equal(run.view().status, "stopping");
  await waitStatus(run, "stopped", 10_000);
  assert.ok(Date.now() - t0 < 5000, "stopped once the late answer came, long before the grace");
  const recs = journal(p.root, run.runId);
  const s = await state(p.root, run.runId);
  const [execId] = turnIdsOf(s, "execute");
  assert.equal(s.turns[execId].status, "completed");
  const lateSeq = ofType(recs, "turn.finished").find((r) => r.data.turnId === execId).seq;
  const stoppedSeq = ofType(recs, "run.status").find((r) => r.data.status === "stopped").seq;
  assert.ok(lateSeq < stoppedSeq, "stopped is written after the facts of the operation");
  const frozen = agents.log.length;
  await sleep(1000);
  assert.equal(agents.log.length, frozen);
  assert.deepEqual((await state(p.root, run.runId)).checks, {});
});

// ---- 4. Duplicate command ----

test("duplicate command: the stored result, no second action; a reused id with another payload is refused without a record", OPTS, async () => {
  const p = project();
  const gate = deferred();
  const agents = watched(createTestAgents({ ...defaults, execute: { hold: gate.promise, report: executed() } }));
  const run = await service(p, agents).createRun(goal());
  await waitFor(() => activeTurn(run, "execute"), "the executor turn");

  // pause_after_turn twice with the same id: the second one carries a revision that is stale by now, and still gets
  // the stored result (the duplicate is recognised before the revision is compared)
  const pauseId = randomUUID();
  const rev = run.view().revision;
  const first = await send(run, { kind: "pause_after_turn", on: true }, pauseId, rev);
  assert.deepEqual(first, { status: "accepted", code: null });
  assert.equal(run.view().status, "pausing");
  const revAfter = run.view().revision;
  const again = await send(run, { kind: "pause_after_turn", on: true }, pauseId, rev);
  assert.deepEqual(again, first);
  assert.equal(run.view().revision, revAfter, "a duplicate changes no revision");
  let recs = journal(p.root, run.runId);
  assert.equal(statuses(recs).filter((x) => x === "pausing").length, 1, "exactly one run.status(pausing)");
  assert.equal(ofType(recs, "command.received").filter((r) => r.data.commandId === pauseId).length, 1);

  // the same id with another payload: command_id_reused and not a byte written
  const size = recs.length;
  const reused = await send(run, { kind: "pause_after_turn", on: false }, pauseId, revAfter);
  assert.deepEqual(reused, { status: "rejected", code: "command_id_reused" });
  assert.equal(journal(p.root, run.runId).length, size, "journal unchanged");
  assert.equal(run.view().status, "pausing");

  // a clarify sent twice at the same time: one clarification.added, both answers agree
  const clarifyId = randomUUID();
  const r2 = run.view().revision;
  const both = await Promise.all([
    send(run, { kind: "clarify", text: "use integers" }, clarifyId, r2),
    send(run, { kind: "clarify", text: "use integers" }, clarifyId, r2)
  ]);
  assert.ok(both.some((r) => r.status === "accepted"), JSON.stringify(both));
  for (const r of both) assert.ok(r.status === "accepted" || r.status === "in_progress", JSON.stringify(r));
  assert.deepEqual(await send(run, { kind: "clarify", text: "use integers" }, clarifyId, r2), { status: "accepted", code: null });
  recs = journal(p.root, run.runId);
  assert.equal(ofType(recs, "clarification.added").length, 1, "exactly one clarification");
  const s = await state(p.root, run.runId);
  assert.equal(s.orch.clarifications, 1);
  assert.deepEqual(s.commands[clarifyId].result, { status: "accepted", code: null });

  gate.resolve();
  await waitStatus(run, "paused(user_request)");
});

// ---- 5. Stale revision ----

test("stale revision: rejected(stale_revision), no status change, revision unchanged", OPTS, async () => {
  const p = project();
  const gate = deferred();
  const agents = watched(createTestAgents({ ...defaults, execute: { hold: gate.promise, report: executed() } }));
  const run = await service(p, agents).createRun(goal());
  await waitFor(() => activeTurn(run, "execute"), "the executor turn");

  const old = run.view().revision;
  assert.equal((await send(run, { kind: "clarify", text: "one more thing" })).status, "accepted");
  const rev = run.view().revision;
  assert.ok(rev > old, "an accepted command changes the revision");
  const statusCount = statuses(journal(p.root, run.runId)).length;

  const staleId = randomUUID();
  const res = await send(run, { kind: "pause_after_turn", on: true }, staleId, old);
  assert.deepEqual(res, { status: "rejected", code: "stale_revision" });
  assert.equal(run.view().status, "running");
  assert.equal(run.view().revision, rev, "a rejected command changes no revision");
  assert.equal(statuses(journal(p.root, run.runId)).length, statusCount, "no run.status written");
  const s = await state(p.root, run.runId);
  assert.deepEqual(s.commands[staleId].result, { status: "rejected", code: "stale_revision" });
  // repeating it returns the stored refusal, even with the current revision
  assert.deepEqual(await send(run, { kind: "pause_after_turn", on: true }, staleId, old), res);
  assert.equal(run.view().status, "running");

  const future = await send(run, { kind: "pause_after_turn", on: true }, randomUUID(), rev + 5);
  assert.deepEqual(future, { status: "rejected", code: "stale_revision" }, "a revision from the future is not current either");
  assert.equal(run.view().status, "running");
  gate.resolve();
});

// ---- 6. Pause during a turn ----

test("pause during a turn: pausing, the turn finishes, paused(user_request), nothing next; resume continues to completed", OPTS, async () => {
  const p = project();
  const gate = deferred();
  const agents = watched(createTestAgents({ ...defaults, execute: { hold: gate.promise, report: executed() } }));
  const run = await service(p, agents).createRun(goal());
  await waitFor(() => activeTurn(run, "execute"), "the executor turn");

  assert.deepEqual(await send(run, { kind: "pause_after_turn", on: true }), { status: "accepted", code: null });
  assert.equal(run.view().status, "pausing");
  assert.equal(agents.stops.length, 0, "pause does not stop the turn");
  assert.deepEqual(await send(run, { kind: "resume" }), { status: "rejected", code: "invalid_state" }, "resume is not for pausing");

  gate.resolve();
  await waitStatus(run, "paused(user_request)");
  const frozen = agents.log.length;
  await sleep(1000);
  assert.equal(agents.log.length, frozen, "no next turn");
  let s = await state(p.root, run.runId);
  assert.deepEqual(s.checks, {}, "and no check: the next operation did not start");
  const [execId] = turnIdsOf(s, "execute");
  assert.equal(s.turns[execId].status, "completed", "the turn's result was recorded");
  assert.deepEqual(statuses(journal(p.root, run.runId)).slice(-2), ["pausing", "paused(user_request)"]);

  assert.deepEqual(await send(run, { kind: "resume" }), { status: "accepted", code: null });
  await waitStatus(run, "completed");
  s = await state(p.root, run.runId);
  assert.ok(Object.values(s.checks).some((c) => c.checkId === "unit" && c.status === "passed"));
  assert.equal(count(agents, "execute"), 1);
});

test("pause, then pause_after_turn off: running again and the cycle goes on past the turn", OPTS, async () => {
  const p = project();
  const gate = deferred();
  const agents = watched(createTestAgents({ ...defaults, execute: { hold: gate.promise, report: executed() } }));
  const run = await service(p, agents).createRun(goal());
  await waitFor(() => activeTurn(run, "execute"), "the executor turn");

  assert.equal((await send(run, { kind: "pause_after_turn", on: true })).status, "accepted");
  assert.equal(run.view().status, "pausing");
  assert.deepEqual(await send(run, { kind: "pause_after_turn", on: false }), { status: "accepted", code: null });
  assert.equal(run.view().status, "running");
  assert.deepEqual(await send(run, { kind: "pause_after_turn", on: false }), { status: "rejected", code: "invalid_state" },
    "off is only valid from pausing");
  gate.resolve();
  await waitFor(() => run.view().active?.kind === "check" || count(agents, "review") > 0, "the next operation after the turn");
  assert.notEqual(run.view().status, "paused");
  assert.deepEqual(statuses(journal(p.root, run.runId)).filter((x) => x.startsWith("paus")), ["pausing"]);
  await waitStatus(run, "completed");
});

// ---- 7. Step ----

test("step: exactly one external operation, then paused(step_done)", OPTS, async () => {
  const p = project();
  const gate = deferred();
  const agents = watched(createTestAgents({ ...defaults, execute: { hold: gate.promise, report: executed() } }));
  const run = await service(p, agents).createRun(goal());
  await waitFor(() => activeTurn(run, "execute"), "the executor turn");
  await send(run, { kind: "pause_after_turn", on: true });
  gate.resolve();
  await waitStatus(run, "paused(user_request)");
  const turnsBefore = agents.log.length;

  // next is the required check: one step runs it and nothing else
  assert.deepEqual(await send(run, { kind: "step" }), { status: "accepted", code: null });
  await waitStatus(run, "paused(step_done)");
  await sleep(500);
  let s = await state(p.root, run.runId);
  assert.equal(Object.keys(s.checks).length, 1, "one check");
  assert.equal(agents.log.length, turnsBefore, "and no turn");
  assert.equal(status(run), "paused(step_done)");

  // next is the review: one step runs that turn and nothing else
  assert.equal((await send(run, { kind: "step" })).status, "accepted");
  await waitStatus(run, "paused(step_done)");
  await sleep(500);
  s = await state(p.root, run.runId);
  assert.equal(agents.log.length, turnsBefore + 1);
  assert.equal(agents.log.at(-1).purpose, "review");
  assert.equal(Object.keys(s.checks).length, 1, "no check after the review turn");
  const st = statuses(journal(p.root, run.runId));
  assert.equal(st.filter((x) => x === "paused(step_done)").length, 2);

  assert.equal((await send(run, { kind: "resume" })).status, "accepted");
  await waitStatus(run, "completed");
});

// ---- 8. Limits ----

test("limit turns: paused(limit_reached) before the next operation; raise_limit → paused(user_request); resume continues", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents(defaults));
  const run = await service(p, agents).createRun(goal({ limits: { turns: 2 } }));
  await waitStatus(run, "paused(limit_reached)");
  assert.deepEqual(purposes(agents), ["plan", "execute"]);
  assert.deepEqual((await state(p.root, run.runId)).checks, {}, "rule 2 comes before the check");

  assert.deepEqual(await send(run, { kind: "resume" }), { status: "rejected", code: "invalid_state" });
  const low = await send(run, { kind: "raise_limit", limit: "turns", value: 2 });
  assert.equal(low.status, "rejected", "the new value must be above the current one");
  assert.equal(status(run), "paused(limit_reached)");

  assert.deepEqual(await send(run, { kind: "raise_limit", limit: "turns", value: 10 }), { status: "accepted", code: null });
  assert.equal(status(run), "paused(user_request)");
  const recs = journal(p.root, run.runId);
  assert.deepEqual(ofType(recs, "limits.changed").map((r) => [r.data.kind, r.data.value]), [["turns", 10]]);
  assert.equal((await state(p.root, run.runId)).orch.limitOverrides.turns, 10);
  await sleep(300);
  assert.equal(agents.log.length, 2, "raise_limit alone starts nothing");

  assert.equal((await send(run, { kind: "resume" })).status, "accepted");
  await waitStatus(run, "completed");
});

test("limit roundsPerStage: reviews always fix → limit_reached instead of another executor round", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents({
    ...defaults,
    // every round changes the tree and gets a different finding, so there is progress and no loop: only the limit stops it
    execute: (req, k) => ({ report: executed(), edit: writeFile("work.txt", `round ${k}\n`) }),
    review: (req, k) => ({ report: review("fix", [`finding ${k}`]) })
  }));
  const run = await service(p, agents).createRun(goal({ limits: { roundsPerStage: 2, noProgressRounds: 10 } }));
  await waitStatus(run, "paused(limit_reached)");
  assert.equal(count(agents, "execute"), 2);
  assert.equal(count(agents, "review"), 2);
  const s = await state(p.root, run.runId);
  assert.deepEqual(turnIdsOf(s, "execute").map((id) => s.orch.turns[id].round), [1, 2]);
  assert.deepEqual(s.orch.accepted, {});
});

test("limit replans: reviews always replan → limit_reached instead of another plan", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents({
    ...defaults,
    execute: (req, k) => ({ report: executed(), edit: writeFile("work.txt", `turn ${k}\n`) }),
    review: (req, k) => ({ report: review("replan", [`plan was wrong ${k}`]) })
  }));
  const run = await service(p, agents).createRun(goal({ limits: { replans: 1, noProgressRounds: 10 } }));
  await waitStatus(run, "paused(limit_reached)");
  assert.equal(count(agents, "plan"), 2, "the first plan and one replan");
  const s = await state(p.root, run.runId);
  assert.equal(s.orch.plan.version, 2);
  assert.equal(ofType(journal(p.root, run.runId), "plan.recorded").length, 2);
});

// ---- 9. Loops without progress ----

test("loop: the same findings twice on different runKeys → loop_suspected before the roundsPerStage limit", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents({
    ...defaults,
    execute: (req, k) => ({ report: executed(), edit: writeFile("work.txt", `attempt ${k}\n`) }),
    review: { report: review("fix", ["The sum is wrong", "add a test"]) }
  }));
  const run = await service(p, agents).createRun(goal({ limits: { roundsPerStage: 8, noProgressRounds: 10 } }));
  await waitStatus(run, "paused(loop_suspected)");
  assert.equal(count(agents, "execute"), 2, "paused before the executor's round 3");
  const s = await state(p.root, run.runId);
  const reviews = s.orch.reviews.filter((r) => r.stage === 1);
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].findingsKey, reviews[1].findingsKey);
  assert.notEqual(reviews[0].runKey, reviews[1].runKey);
});

test("loop: the state returns A → B → A with the same failing check → loop_suspected", OPTS, async () => {
  const p = project();
  const agents = watched(createTestAgents({
    ...defaults,
    execute: (req, k) => ({ report: executed(), edit: writeFile("work.txt", k % 2 ? "A\n" : "B\n") }),
    // findings only grow: nothing is closed, so no round is progress, yet the findingsKey differs every time (not rule 2)
    review: (req, k) => ({ report: review("fix", Array.from({ length: k }, (_, i) => `finding ${i + 1}`)) })
  }));
  const run = await service(p, agents).createRun(goal({ checks: ["unit-broken"], limits: { roundsPerStage: 8, noProgressRounds: 10 } }));
  await waitStatus(run, "paused(loop_suspected)");
  assert.equal(count(agents, "execute"), 3, "rounds A, B, A, then the repetition is noticed");
  const s = await state(p.root, run.runId);
  const reviews = s.orch.reviews.filter((r) => r.stage === 1);
  assert.equal(reviews.length, 3);
  assert.equal(reviews[0].runKey, reviews[2].runKey);
  assert.notEqual(reviews[0].runKey, reviews[1].runKey);
  assert.equal(new Set(reviews.map((r) => r.findingsKey)).size, 3);
  assert.ok(Object.values(s.checks).every((c) => c.checkId === "unit-broken" && c.status === "failed"));
});

// ---- 10. Clarify during the final review ----

test("clarify during the final review: that review cannot complete the run; a new final review with version 1 does", OPTS, async () => {
  const p = project();
  const gate = deferred();
  const agents = watched(createTestAgents({
    ...defaults,
    final_review: (req, k) => k === 1 ? { hold: gate.promise, report: review("complete") } : { report: review("complete") }
  }));
  const run = await service(p, agents).createRun(goal());
  await waitFor(() => activeTurn(run, "final_review"), "the final review", LONG);

  assert.deepEqual(await send(run, { kind: "clarify", text: "also handle negative numbers" }), { status: "accepted", code: null });
  gate.resolve();
  await waitStatus(run, "completed");
  assert.equal(count(agents, "final_review"), 2);

  const s = await state(p.root, run.runId);
  const finals = turnIdsOf(s, "final_review");
  assert.deepEqual(finals.map((id) => s.orch.turns[id].clarificationVersion), [0, 1]);
  const finalReviews = s.orch.reviews.filter((r) => r.stage === null);
  assert.deepEqual(finalReviews.map((r) => [r.verdict, r.clarificationVersion]), [["complete", 0], ["complete", 1]]);
  const recs = journal(p.root, run.runId);
  assert.deepEqual(statuses(recs).filter((x) => x === "completed"), ["completed"]);
  const completedSeq = ofType(recs, "run.status").find((r) => r.data.status === "completed").seq;
  const secondFinalSeq = ofType(recs, "orch.turn").find((r) => r.data.turnId === finals[1]).seq;
  assert.ok(secondFinalSeq < completedSeq, "completed only after the second final review");
  const clarSeq = ofType(recs, "clarification.added")[0].seq;
  const firstFinalDone = ofType(recs, "turn.finished").find((r) => r.data.turnId === finals[0]).seq;
  assert.ok(clarSeq < firstFinalDone, "the clarification arrived while the first final review was running");
});

// ---- 11. Journal write failure ----

// Fails every journal write once armed and `when(line)` holds; nothing of the failing line reaches the file.
function faultyIo() {
  const io = {
    armed: false, when: () => true, failed: 0,
    async write(fh, buf) {
      if (io.armed && io.when(buf.toString("utf8"))) { io.failed++; throw new Error("chaos: the disk is gone"); }
      return fh.write(buf);
    }
  };
  return io;
}

async function assertHaltedThenRecovers(p, run, agents, io) {
  assert.equal(run.view().halted, true);
  const size = fs.statSync(path.join(p.root, "runs", run.runId, "journal.jsonl")).size;
  const turns = agents.log.length;
  for (const command of [{ kind: "stop" }, { kind: "clarify", text: "anything" }, { kind: "pause_after_turn", on: true }]) {
    assert.deepEqual(await send(run, command), { status: "rejected", code: "store_failed" }, command.kind);
  }
  await sleep(1000);
  assert.equal(agents.log.length, turns, "a halted service starts nothing");
  assert.equal(fs.statSync(path.join(p.root, "runs", run.runId, "journal.jsonl")).size, size, "and writes nothing");
  await run.close();

  // a fresh service without the failing io: Store recovery, then nothing runs by itself
  io.armed = false;
  const agents2 = watched(createTestAgents(defaults));
  const again = await service(p, agents2).openRun(run.runId);
  assert.equal(again.view().halted, false);
  assert.equal(status(again), "paused(outcome_unknown)");
  await sleep(1000);
  assert.equal(agents2.log.length, 0, "no turn after reopening");
  assert.equal(status(again), "paused(outcome_unknown)");
  const s = await state(p.root, run.runId);
  const [execId] = turnIdsOf(s, "execute");
  assert.equal(s.turns[execId].status, "outcome_unknown");
  return again;
}

test("journal write fails on a command during a turn: halted, the turn is stopped, commands store_failed, reopen pauses", OPTS, async () => {
  const p = project();
  const gate = deferred();
  const io = faultyIo();
  const agents = watched(createTestAgents({ ...defaults, execute: { hold: gate.promise, report: executed() } }));
  const run = await service(p, agents, { deps: { storeIo: io } }).createRun(goal());
  await waitFor(() => activeTurn(run, "execute"), "the executor turn");

  io.armed = true;
  const res = await send(run, { kind: "clarify", text: "this never reaches the disk" });
  assert.deepEqual(res, { status: "rejected", code: "store_failed" });
  assert.equal(io.failed, 1);
  await waitFor(() => agents.stops.length === 1, "stop() of the active turn");
  assert.equal(agents.stops[0].purpose, "execute");
  gate.resolve();
  await assertHaltedThenRecovers(p, run, agents, io);
});

test("journal write fails on turn.finished: halted, no check and no turn after it, reopen pauses", OPTS, async () => {
  const p = project();
  const gate = deferred();
  const io = faultyIo();
  io.when = (line) => line.includes('"type":"turn.finished"');
  const agents = watched(createTestAgents({ ...defaults, execute: { hold: gate.promise, report: executed() } }));
  const run = await service(p, agents, { deps: { storeIo: io } }).createRun(goal());
  await waitFor(() => activeTurn(run, "execute"), "the executor turn");

  io.armed = true;
  gate.resolve();
  await waitFor(() => run.view().halted, "halted");
  assert.equal(io.failed, 1);
  assert.equal(run.view().active, null, "no operation after the failure");
  assert.deepEqual((await readRun(p.root, run.runId)).state.checks, {}, "no check started");
  await assertHaltedThenRecovers(p, run, agents, io);
});

// ---- 12. Restart after an unfinished operation ----

// Runs the service in a child, waits until `ready(state)` holds in the journal, then SIGKILLs only that child.
async function crashChild(p, mode, entries, checks) {
  const cfg = { mode, root: p.root, src: p.src, git: GIT, node: NODE, supervisor: SUPERVISOR, registry: entries, deps: p.depsInput, checks };
  const child = spawn(NODE, [CRASH_CHILD, JSON.stringify(cfg)], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  try {
    const runId = await waitFor(() => out.includes("\n") && out.split("\n")[0], "the child's runId", 30_000)
      .catch((e) => { throw new Error(`${e.message}; child stderr: ${err}`); });
    return { runId, child, exited };
  } catch (e) {
    child.kill("SIGKILL");
    await exited;
    throw e;
  }
}
// Stage 9: after a crash the application lists the run (not opened) as opening it will record it, so the panel offers
// the actions the next command is accepted with; reading writes nothing. Resolves nothing either (no git, CLI, launch).
async function listedAfterCrash(p, runId) {
  const file = path.join(p.root, "runs", runId, "journal.jsonl");
  const bytes = fs.readFileSync(file).length;
  const none = () => { throw new Error("not resolved on a read"); };
  const m = createRunManager({ root: p.root, gitPath: none, launch: none, nodePath: none, agents: async () => none() });
  const got = (await m.get(runId)).value;
  const listed = (await m.list()).value.find((s) => s.view.runId === runId);
  assert.deepEqual(listed, got, "list and get show the same");
  assert.equal(fs.readFileSync(file).length, bytes, "reading the run writes nothing");
  return got;
}
async function kill(c) {
  assert.ok(Number.isInteger(c.child.pid));
  process.kill(c.child.pid, "SIGKILL");
  const { signal } = await c.exited;
  assert.equal(signal, "SIGKILL");
}

test("crash with a turn in flight: reopened paused(outcome_unknown), no repeat; retry_turn then resume runs a new turn", OPTS, async () => {
  const p = project();
  const c = await crashChild(p, "turn", REGISTRY_ENTRIES, ["unit"]);
  let execId;
  try {
    execId = await waitFor(async () => {
      const { state: s } = await readRun(p.root, c.runId);
      const id = s && turnIdsOf(s, "execute")[0];
      return id && s.turns[id] ? id : null;
    }, "turn.intent of the executor", 30_000);
  } finally {
    await kill(c);
  }

  const listed = await listedAfterCrash(p, c.runId);
  assert.deepEqual([listed.open, listed.view.status, listed.view.reason], [false, "paused", "outcome_unknown"],
    "before it is opened the run is listed paused(outcome_unknown), not running");
  const agents = watched(createTestAgents(defaults));
  const run = await service(p, agents).openRun(c.runId);
  assert.equal(status(run), "paused(outcome_unknown)");
  assert.equal(run.view().revision, listed.view.revision, "a command sent with the listed revision is not stale");
  let s = await state(p.root, c.runId);
  assert.equal(s.turns[execId].status, "outcome_unknown");
  await sleep(1000);
  assert.equal(agents.log.length, 0, "nothing is repeated automatically");
  assert.equal(status(run), "paused(outcome_unknown)");

  assert.deepEqual(await send(run, { kind: "resume" }), { status: "rejected", code: "invalid_state" }, "only recover from outcome_unknown");
  assert.equal((await send(run, { kind: "recover", action: "reset_to_checkpoint" })).status, "rejected", "reset needs confirm");
  assert.deepEqual(await send(run, { kind: "recover", action: "retry_turn" }), { status: "accepted", code: null });
  assert.equal(status(run), "paused(user_request)");
  const decided = ofType(journal(p.root, c.runId), "recovery.decided");
  assert.deepEqual(decided.map((r) => [r.data.action, r.data.turnId]), [["retry_turn", execId]]);
  await sleep(300);
  assert.equal(agents.log.length, 0, "the decision alone starts nothing");

  assert.equal((await send(run, { kind: "resume" })).status, "accepted");
  await waitFor(() => count(agents, "execute") === 1, "a new executor turn");
  const retry = agents.requests.find((r) => r.purpose === "execute");
  assert.equal(retry.sessionId, null, "the retried turn starts a new session");
  s = await state(p.root, c.runId);
  const execIds = turnIdsOf(s, "execute");
  assert.equal(execIds.length, 2);
  assert.notEqual(execIds[1], execId, "a new turn, not the unknown one");
  assert.equal(s.turns[execId].status, "outcome_unknown", "the unknown turn stays unknown");
  await waitStatus(run, "completed");
});

test("crash during a check: reopened with the check not_verified(interrupted), nothing re-run, the check process is gone", OPTS, async () => {
  const p = project();
  const marker = `chaos-${randomUUID()}`;
  const entries = [REGISTRY_ENTRIES[0], sleepCheck(marker)];
  const c = await crashChild(p, "check", entries, ["sleep"]);
  let checkRunId;
  try {
    checkRunId = await waitFor(() => ofType(journal(p.root, c.runId), "check.started")[0]?.data.checkRunId,
      "check.started", 60_000);
    await sleep(300); // let the sandboxed process really run
  } finally {
    await kill(c);
  }

  // the supervisor's lifeline ends with the child: the check process must not outlive it
  await waitFor(() => !execFileSync("ps", ["-Ao", "command="], { encoding: "utf8" }).includes(marker),
    "the orphaned check process to disappear", 15_000);

  const listed = await listedAfterCrash(p, c.runId);
  assert.deepEqual([listed.open, listed.view.status, listed.view.reason], [false, "paused", "recovered"],
    "before it is opened the run is listed paused(recovered), not running");
  const agents = watched(createTestAgents(defaults));
  const run = await service(p, agents, { registry: createRegistry(entries) }).openRun(c.runId);
  assert.equal(status(run), "paused(recovered)", "no turn was unfinished, only the check");
  assert.equal(run.view().revision, listed.view.revision, "a command sent with the listed revision is not stale");
  let s = await state(p.root, c.runId);
  assert.deepEqual([s.checks[checkRunId].status, s.checks[checkRunId].reason], ["not_verified", "interrupted"]);
  await sleep(1500);
  s = await state(p.root, c.runId);
  assert.equal(Object.keys(s.checks).length, 1, "the check is not re-run automatically");
  assert.equal(agents.log.length, 0);
  assert.equal(status(run), "paused(recovered)");
});
