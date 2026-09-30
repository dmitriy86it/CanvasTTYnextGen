// Stage 13 review 6: one admission rule for the next process of the run's own operations. After the run's deadline or
// the person's Stop nothing more starts — the next preparation step, the push after the remote's address or after the
// commit, a push's ls-remote, a QA deploy's verification — whatever the operation that just ended returned. What did
// run stays unconfirmed in the journal; after the person raises the limit and resumes, only its confirmation runs.
// Real service, Store, Git and shell operations (a test login shell that records every line it is asked to run);
// scripted test agents; the service's clock is the test's, so the deadline passes exactly where a test says.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, test } from "node:test";
import { createOrchestrationService } from "../src/main/services/orchestration/orchestrationService.ts";
import { createRegistry } from "../src/main/services/orchestration/checks.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { readRun, readText } from "../src/main/services/orchestration/store.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const SUPERVISOR = path.join(HERE, "..", "src", "orchestration", "supervisor.mjs");
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const HOUR = 3600_000;

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-cancel-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
// The login shell as the service calls it (`-ilc <line>`): every line is written to the ledger before it runs. Every
// process the service starts goes through a launch wrapper that counts it first: a process started and stopped before
// its shell wrote the ledger still counts (launches === ledger lines, or something was started that did not run).
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nprintf '%s\\n' "$1" >> "$LEDGER"\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const REGISTRY = createRegistry([{ id: "unused", title: "unused", executable: NODE, argv: ["-e", "0"], timeoutMs: 60_000, maxOutputBytes: 8192 }]);

let n = 0;
const file = (name) => path.join(TMP, `${name}-${++n}`);
// The service's clock: it stands at the run's creation until set(), then follows real time from the value set.
function testClock() {
  const t0 = Date.now();
  let base = t0, since = null;
  return { t0, now: () => (since === null ? base : base + Date.now() - since), set(ms) { base = ms; since = Date.now(); }, hold(ms) { base = ms; since = null; } };
}
const agents = () => createTestAgents({
  plan: { report: plan("one") },
  execute: { report: executed(), edit: (repo) => fs.writeFileSync(repo.path("a.txt"), "2\n") },
  review: { report: review("accept") },
  final_review: { report: review("complete") }
});

const open = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.shutdown().catch(() => {});
});
function setup({ finish, prepare, runMs = HOUR, remote = false }) {
  const src = file("src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "a.txt"), "1\n");
  fs.writeFileSync(path.join(src, ".gitignore"), "prepared-*\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "init");
  const bare = remote ? file("remote.git") : null;
  if (bare) { g(TMP, "init", "-q", "--bare", bare); g(src, "remote", "add", "qa", bare); }
  const root = file("root"), ledger = file("ledger"), launches = file("launches"), wrapper = file("launch");
  fs.writeFileSync(ledger, "");
  fs.writeFileSync(launches, "");
  fs.writeFileSync(wrapper, `#!/bin/sh\necho x >> "${launches}"\nexec "${NODE}" "${SUPERVISOR}" "$@"\n`, { mode: 0o755 });
  const clock = testClock();
  const svc = () => createOrchestrationService({
    root, gitPath: GIT, agents: agents(), clock: clock.now, stopGraceMs: 5000,
    checks: { registry: REGISTRY, deps: null, launch: { command: wrapper, args: [], env: {} }, shell: { shell: SHELL, env: { ...GIT_ENV, LEDGER: ledger } } }
  });
  const goal = {
    text: "a to 2", criteria: ["a is 2"], checks: [], commands: ["true"], workMode: "project", mode: "autopilot", limits: { runMs },
    finish: { commit: finish.commit ? { message: "run" } : null, push: finish.push ? { remote: "qa", branch: "qa-branch", remoteUrl: bare } : null, qa: finish.qa ?? null },
    ...(prepare ? { prepare: { steps: prepare } } : {})
  };
  const lines = () => fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
  return {
    src, root, clock, bare, lines, count: (re) => lines().filter((l) => re.test(l)).length,
    // every process started so far ran its line: none was started and stopped on the way
    allRan: () => assert.equal(fs.readFileSync(launches, "utf8").length / 2, lines().length, "a process was started that did not run"),
    async create() { const r = await svc().createRun({ source: src, goal }); open.push(r); return r; },
    async reopen(runId) { const r = await svc().openRun(runId); open.push(r); return r; }
  };
}
const send = (run, command) => run.command({ commandId: randomUUID(), expectedRevision: run.view().revision, command });
const reason = (run) => { const v = run.view(); return v.status === "paused" ? `paused(${v.reason})` : v.status; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); }
  throw new Error(`timed out waiting for ${what}`);
}
// Calls fn synchronously (from the service's own change notification) when the nth operation matching `match` starts
// or ends: the moment the service has just marked it active (before its deadline timer is armed), or has just
// cleared it (before the next process of the same operation is admitted).
function on(run, edge, match, nth, fn) {
  let prev = null, seen = 0, done = false;
  const off = run.onChange(() => {
    const a = run.view().active;
    const hit = edge === "start" ? a && !prev && match(a) : prev && !a && match(prev);
    prev = a;
    if (hit && !done && ++seen === nth) { done = true; fn(); }
  });
  return off;
}
const finishOf = (step) => (a) => a.kind === "finish" && a.step === step;
async function records(root, runId) {
  const r = await readRun(root, runId);
  assert.equal(r.integrity.status, "ok", JSON.stringify(r.integrity));
  return r.state;
}
const text = async (root, runId, ref) => (await readText(root, runId, ref)).toString("utf8");
const lastFinish = (st, step) => st.orch.finish.filter((f) => f.step === step).at(-1);

// Closing and reopening: the journal replays, the run is where it was, and nothing starts by itself.
async function reopened(t, run, expected) {
  const runId = run.runId;
  await run.shutdown();
  const before = t.lines().length;
  const again = await t.reopen(runId);
  await again.idle();
  assert.equal((await readRun(t.root, runId)).integrity.status, "ok");
  assert.equal(reason(again), expected, "reopening keeps the pause");
  assert.equal(again.view().active, null);
  assert.equal(t.lines().length, before, "reopening starts no process");
  t.allRan();
  return again;
}
// A spent runMs: Resume alone stays refused; the limit is raised, then only the person's resumes continue.
async function raiseAndResume(t, run) {
  assert.deepEqual(await send(run, { kind: "resume" }), { status: "rejected", code: "invalid_state" }, "Resume does not bypass the spent runMs");
  assert.equal(reason(run), "paused(limit_reached)");
  assert.equal((await send(run, { kind: "raise_limit", limit: "runMs", value: 100 * HOUR })).status, "accepted");
  assert.equal(reason(run), "paused(user_request)");
  assert.equal((await send(run, { kind: "resume" })).status, "accepted");
  await run.idle();
}

const QA = (deploy, deploys, verified) => ({ environment: "qa", command: `echo d >> ${deploys}; ${deploy}`, verify: `echo v >> ${verified}` });
const lateDeploy = (pidFile, gotInt, latch) => `trap 'touch ${gotInt}' INT; trap '' TERM; echo $$ > ${pidFile}; while [ ! -f ${latch} ]; do sleep 0.05; done; exit 0`;
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");

async function deployedNotConfirmed(t, run, why) {
  const st = await records(t.root, run.runId);
  const qa = lastFinish(st, "qa");
  assert.deepEqual([qa.status, qa.established, qa.version ?? null], ["unknown", false, null], "deployed, not confirmed");
  assert.match(await text(t.root, run.runId, qa.evidence), new RegExp(`^deploy: exit 0\\nverification: not started \\(${why}\\)`));
  assert.equal(run.view().progress.finish[2].status, "unknown");
}
// After the resumes: the verification of the deploy that ran, never a second deploy.
async function verifiedOnce(t, run, deploys, verified) {
  assert.equal(reason(run), "paused(finish_unconfirmed)", "the verification is the person's command: one more resume first");
  assert.equal(read(verified), "", "not before that resume");
  assert.equal((await send(run, { kind: "resume" })).status, "accepted");
  await run.idle();
  assert.equal(run.view().status, "completed", reason(run));
  assert.deepEqual([read(deploys), read(verified)], ["d\n", "v\n"], "one deploy, one verification");
  const qa = lastFinish(await records(t.root, run.runId), "qa");
  assert.deepEqual([qa.status, qa.established], ["done", true]);
}

// ---------------- QA: deploy, then its verification ----------------

test("the deadline stops a QA deploy that then succeeds: no verification, paused(limit_reached), the deploy is not repeated", OPTS, async () => {
  const [pidFile, gotInt, latch, deploys, verified] = ["pid", "int", "latch", "deploys", "verified"].map(file);
  const t = setup({ finish: { commit: true, qa: QA(lateDeploy(pidFile, gotInt, latch), deploys, verified) } });
  const run = await t.create();
  // the deploy starts 200 ms (service time) before the deadline: its timer stops it, the deploy notes it and succeeds
  on(run, "start", finishOf("qa"), 1, () => t.clock.set(t.clock.t0 + HOUR - 200));
  await until(() => fs.existsSync(gotInt), "the deadline stopping the deploy");
  fs.writeFileSync(latch, "");
  await run.idle();
  assert.equal(reason(run), "paused(limit_reached)", "a late success does not undo the deadline");
  t.allRan();
  assert.equal(read(verified), "", "the verification did not start");
  assert.equal(t.count(/^echo v >>/), 0, "no verification process in the ledger");
  await deployedNotConfirmed(t, run, "the run's time limit was reached");
  const again = await reopened(t, run, "paused(limit_reached)");
  await raiseAndResume(t, again);
  await verifiedOnce(t, again, deploys, verified);
});

test("the deadline passes between a QA deploy and its verification: the verification is not admitted", OPTS, async () => {
  const [deploys, verified] = ["deploys", "verified"].map(file);
  const t = setup({ finish: { commit: true, qa: QA("true", deploys, verified) } });
  const run = await t.create();
  on(run, "end", finishOf("qa"), 1, () => t.clock.set(t.clock.t0 + HOUR + 1)); // the deploy is done; nothing started yet
  await run.idle();
  assert.equal(reason(run), "paused(limit_reached)");
  t.allRan();
  assert.equal(read(deploys), "d\n");
  assert.equal(t.count(/^echo v >>/), 0, "no verification process in the ledger");
  await deployedNotConfirmed(t, run, "the run's time limit was reached");
  const again = await reopened(t, run, "paused(limit_reached)");
  await raiseAndResume(t, again);
  await verifiedOnce(t, again, deploys, verified);
});

test("Stop during a QA deploy that then succeeds: no verification, stopped, nothing continues", OPTS, async () => {
  const [pidFile, gotInt, latch, deploys, verified] = ["pid", "int", "latch", "deploys", "verified"].map(file);
  const t = setup({ finish: { commit: true, qa: QA(lateDeploy(pidFile, gotInt, latch), deploys, verified) } });
  const run = await t.create();
  await until(() => fs.existsSync(pidFile), "the deploy running");
  assert.equal((await send(run, { kind: "stop" })).status, "accepted");
  assert.equal(run.view().status, "stopping", "the Stop is journaled before the deploy ends");
  await until(() => fs.existsSync(gotInt), "the deploy asked to stop");
  fs.writeFileSync(latch, "");
  await run.idle();
  assert.equal(reason(run), "stopped");
  t.allRan();
  assert.equal(read(verified), "");
  assert.equal(t.count(/^echo v >>/), 0, "no verification process in the ledger");
  await deployedNotConfirmed(t, run, "the person stopped the run");
  assert.equal((await send(run, { kind: "resume" })).code, "invalid_state", "a stopped run does not continue");
  const again = await reopened(t, run, "stopped");
  assert.equal((await send(again, { kind: "resume" })).code, "invalid_state");
  assert.equal(read(deploys), "d\n", "deployed once");
});

// ---------------- commit, the remote's address, push, its ls-remote ----------------

test("the deadline passes right after the commit: the push is not started; after raising the limit it runs once", OPTS, async () => {
  const t = setup({ finish: { commit: true, push: true }, remote: true });
  const run = await t.create();
  on(run, "end", finishOf("commit"), 1, () => t.clock.set(t.clock.t0 + HOUR + 1));
  await run.idle();
  assert.equal(reason(run), "paused(limit_reached)");
  t.allRan();
  const st = await records(t.root, run.runId);
  assert.equal(lastFinish(st, "commit").status, "done", "the commit that ran is a fact");
  assert.equal(lastFinish(st, "push"), undefined, "no push intent");
  assert.equal(t.count(/^git (config|remote|push|ls-remote)/), 0, "no address check, push or ls-remote started");
  const again = await reopened(t, run, "paused(limit_reached)");
  await raiseAndResume(t, again);
  assert.equal(again.view().status, "completed", reason(again));
  assert.equal(t.count(/^git push /), 1);
  assert.equal(t.count(/^git commit|&& git commit /), 1, "committed once");
  assert.equal(g(t.bare, "rev-parse", "qa-branch"), lastFinish(await records(t.root, again.runId), "commit").commit);
});

test("the deadline passes between the remote's address check and the push: nothing is pushed, no intent is recorded", OPTS, async () => {
  const t = setup({ finish: { commit: true, push: true }, remote: true });
  const run = await t.create();
  on(run, "end", finishOf("push"), 1, () => t.clock.set(t.clock.t0 + HOUR + 1)); // the address check ended
  await run.idle();
  assert.equal(reason(run), "paused(limit_reached)");
  t.allRan();
  assert.equal(t.count(/^git push /), 0, "the push did not start");
  assert.equal(lastFinish(await records(t.root, run.runId), "push"), undefined, "an action that did not start is not recorded as started");
  assert.throws(() => g(t.bare, "rev-parse", "--verify", "-q", "refs/heads/qa-branch"), "nothing reached the remote");
  const again = await reopened(t, run, "paused(limit_reached)");
  await raiseAndResume(t, again);
  assert.equal(again.view().status, "completed", reason(again));
  assert.equal(t.count(/^git push /), 1);
});

test("the deadline passes between a push and its ls-remote: pushed, not confirmed; after the resumes only ls-remote runs", OPTS, async () => {
  const t = setup({ finish: { commit: true, push: true }, remote: true });
  const run = await t.create();
  on(run, "end", finishOf("push"), 2, () => t.clock.set(t.clock.t0 + HOUR + 1)); // the push itself ended
  await run.idle();
  assert.equal(reason(run), "paused(limit_reached)");
  t.allRan();
  assert.equal(t.count(/^git push /), 1);
  assert.equal(t.count(/^git ls-remote /), 0, "the confirmation did not start");
  const push = lastFinish(await records(t.root, run.runId), "push");
  assert.deepEqual([push.status, push.established], ["unknown", false], "a push without its confirmation is not confirmed");
  assert.match(await text(t.root, run.runId, push.evidence), /^push: exit 0\nls-remote: not started \(the run's time limit was reached\)/);
  const again = await reopened(t, run, "paused(limit_reached)");
  await raiseAndResume(t, again);
  assert.equal(reason(again), "paused(finish_unconfirmed)");
  assert.equal((await send(again, { kind: "resume" })).status, "accepted");
  await again.idle();
  assert.equal(again.view().status, "completed", reason(again));
  assert.deepEqual([t.count(/^git push /), t.count(/^git ls-remote /)], [1, 1], "pushed once, confirmed once");
  const confirmed = lastFinish(await records(t.root, again.runId), "push");
  assert.deepEqual([confirmed.status, confirmed.established], ["done", true]);
});

// ---------------- environment preparation: the next step ----------------

const STEPS = (first) => [{ command: first, unless: "prepared-1" }, { command: "touch prepared-2", unless: "prepared-2" }];

test("the deadline passes between two preparation steps: the second does not start; it runs after the limit is raised", OPTS, async () => {
  const t = setup({ finish: {}, prepare: STEPS("touch prepared-1") });
  const run = await t.create();
  on(run, "end", (a) => a.kind === "prepare", 1, () => t.clock.set(t.clock.t0 + HOUR + 1));
  await run.idle();
  assert.equal(reason(run), "paused(limit_reached)");
  t.allRan();
  assert.equal(t.count(/^touch prepared-2$/), 0, "the second step did not start");
  const prep = (await records(t.root, run.runId)).orch.prepares;
  assert.deepEqual(prep.map((p) => p.status), ["stopped"], "the preparation did not finish");
  const again = await reopened(t, run, "paused(limit_reached)");
  await raiseAndResume(t, again);
  assert.equal(again.view().status, "completed", reason(again));
  assert.deepEqual([t.count(/^touch prepared-1$/), t.count(/^touch prepared-2$/)], [1, 1], "the first step is not repeated");
});

test("Stop during a preparation step that then succeeds: the next step does not start", OPTS, async () => {
  const [pidFile, gotInt, latch] = ["pid", "int", "latch"].map(file);
  const t = setup({ finish: {}, prepare: STEPS(`${lateDeploy(pidFile, gotInt, latch).replace(/; exit 0$/, "")}; touch prepared-1`) });
  const run = await t.create();
  await until(() => fs.existsSync(pidFile), "the first step running");
  assert.equal((await send(run, { kind: "stop" })).status, "accepted");
  await until(() => fs.existsSync(gotInt), "the step asked to stop");
  fs.writeFileSync(latch, "");
  await run.idle();
  assert.equal(reason(run), "stopped");
  t.allRan();
  assert.equal(t.count(/^touch prepared-2$/), 0, "the second step did not start");
  assert.equal(Object.keys((await records(t.root, run.runId)).turns).length, 0, "no turn either");
  await reopened(t, run, "stopped");
});

// ---------------- the deadline timer follows the service's clock ----------------

test("the deadline timer reads the service's clock: a held clock does not stop the operation, a clock past the deadline does", OPTS, async () => {
  const [pidFile, gotInt, latch, deploys, verified] = ["pid", "int", "latch", "deploys", "verified"].map(file);
  const t = setup({ finish: { commit: true, qa: QA(lateDeploy(pidFile, gotInt, latch), deploys, verified) } });
  const run = await t.create();
  // 100 ms before the deadline, and the clock stands there: the real timer fires again and again, the deadline is not reached
  on(run, "start", finishOf("qa"), 1, () => t.clock.hold(t.clock.t0 + HOUR - 100));
  await until(() => fs.existsSync(pidFile) || (fs.existsSync(deploys) && !run.view().active), "the deploy running, or already ended");
  await sleep(600); // six timer periods of real time; the service's clock has not moved
  assert.equal(fs.existsSync(gotInt), false, "a timer that fired while the clock stood still did not stop the deploy");
  assert.deepEqual([run.view().status, run.view().active], ["running", { kind: "finish", step: "qa" }]);
  t.clock.set(t.clock.t0 + HOUR + 1); // the clock passes the deadline: the next firing stops the deploy
  await until(() => fs.existsSync(gotInt), "the deadline stopping the deploy");
  fs.writeFileSync(latch, "");
  await run.idle();
  assert.equal(reason(run), "paused(limit_reached)");
  t.allRan();
  assert.equal(read(verified), "", "and its verification is not admitted");
});
