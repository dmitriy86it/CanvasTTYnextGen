// Stage 13, real S6 (2026-09-26): the user's login shell prints its own noise (zsh without a tty: `can't change option:
// monitor`, a gitstatus error block) into the output of every line. The actions after success read their facts — the
// remote's addresses, the new commit id, the commit found by its trailer, the remote branch — only from a result file
// the git command's own stdout is redirected to, never from the shell's output. The test login shell prints noise on
// stdout and stderr before and after every line, with a plausible commit id and a plausible ls-remote line (the
// project's HEAD on refs/heads/qa-branch); a fake `git` in front of the real one can fail, empty, overfill or block the
// address queries, or make a push that sends nothing.
// Real service, Store, Git and shell operations; scripted test agents; local bare repositories as remotes.
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
import { readRun } from "../src/main/services/orchestration/store.ts";
import { commitMessage } from "../src/main/services/orchestration/finish.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const SUPERVISOR = path.join(HERE, "..", "src", "orchestration", "supervisor.mjs");
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const HOUR = 3600_000;
const FAKE_OID = "0123456789abcdef0123456789abcdef01234567";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-result-channel-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
// `git` in front of the real one: what $FAKE_DIR/<mode> asks for, otherwise the real git
const FAKE_BIN = path.join(TMP, "fake-bin");
fs.mkdirSync(FAKE_BIN);
fs.writeFileSync(path.join(FAKE_BIN, "git"), `#!/bin/sh
F="$FAKE_DIR"
case "$*" in
  push\\ *) [ -f "$F/push-noop" ] && { echo "Everything up-to-date" >&2; exit 0; } ;;
  *get-url*)
    [ -f "$F/geturl-block" ] && { touch "$F/blocked"; while :; do sleep 0.05; done; }
    case "$*" in *--push*)
      [ -f "$F/geturl-push-fail" ] && { "${GIT}" "$@"; exit 2; }
      [ -f "$F/geturl-push-empty" ] && exit 0
      [ -f "$F/geturl-push-big" ] && { u=$("${GIT}" "$@"); i=0; while [ $i -lt 2000 ]; do echo "$u"; i=$((i+1)); done; exit 0; } ;;
    esac ;;
esac
exec "${GIT}" "$@"
`, { mode: 0o755 });
const GIT_ENV = { PATH: `${FAKE_BIN}:/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
// The login shell (`-ilc <line>`): the line goes to the ledger, then noise around it on both streams (the S6 shape plus
// a plausible commit id and ls-remote line), unless $FAKE_DIR/quiet exists; the line's own exit status is kept.
const SHELL = path.join(TMP, "noisy-shell");
fs.writeFileSync(SHELL, `#!/bin/sh
[ "$1" = "-ilc" ] && shift
printf '%s\\n' "$1" >> "$LEDGER"
noise() {
  [ -f "$FAKE_DIR/quiet" ] && return
  h=$(git rev-parse HEAD 2>/dev/null)
  printf '%s\\n' "(anon):setopt:7: can't change option: monitor" "" "[ERROR]: gitstatus failed to initialize." "    GITSTATUS_LOG_LEVEL=DEBUG"
  printf '%s\\n%s\\trefs/heads/qa-branch\\n%s\\n%s\\trefs/heads/qa-branch\\n' "$h" "$h" "${FAKE_OID}" "${FAKE_OID}"
}
noise; noise >&2
/bin/sh -c "$1"; s=$?
noise; noise >&2
exit $s
`, { mode: 0o755 });
const REGISTRY = createRegistry([{ id: "unused", title: "unused", executable: NODE, argv: ["-e", "0"], timeoutMs: 60_000, maxOutputBytes: 8192 }]);

let n = 0;
const file = (name) => path.join(TMP, `${name}-${++n}`);
function testClock() {
  const t0 = Date.now();
  let base = t0, since = null;
  return { t0, now: () => (since === null ? base : base + Date.now() - since), set(ms) { base = ms; since = Date.now(); } };
}
const agents = () => createTestAgents({
  plan: { report: plan("one") },
  execute: { report: executed(), edit: (repo) => fs.writeFileSync(repo.path("a.txt"), "2\n") },
  review: { report: review("accept") },
  final_review: { report: review("complete") }
});

const open = [];
afterEach(async () => { for (const r of open.splice(0)) await r.shutdown().catch(() => {}); });
function setup({ modes = [], hooks = {}, shell = null } = {}) {
  const src = file("src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "a.txt"), "1\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "init");
  for (const [name, body] of Object.entries(hooks)) fs.writeFileSync(path.join(src, ".git", "hooks", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const bare = file("remote.git"), other = file("other.git");
  g(TMP, "init", "-q", "--bare", bare);
  g(TMP, "init", "-q", "--bare", other);
  g(src, "remote", "add", "qa", bare);
  const fake = file("fake");
  fs.mkdirSync(fake);
  for (const m of modes) fs.writeFileSync(path.join(fake, m), "");
  const root = file("root"), ledger = file("ledger");
  fs.writeFileSync(ledger, "");
  const clock = testClock();
  const svc = () => createOrchestrationService({
    root, gitPath: GIT, agents: agents(), clock: clock.now, stopGraceMs: 5000,
    checks: { registry: REGISTRY, deps: null, launch: { command: NODE, args: [SUPERVISOR], env: {} }, shell: shell ?? { shell: SHELL, env: { ...GIT_ENV, LEDGER: ledger, FAKE_DIR: fake } } }
  });
  const runId = randomUUID();
  const goal = {
    text: "a to 2", criteria: ["a is 2"], checks: [], commands: ["true"], workMode: "project", mode: "autopilot", limits: { runMs: HOUR },
    finish: { commit: { message: commitMessage("a to 2", runId) }, push: { remote: "qa", branch: "qa-branch", remoteUrl: bare }, qa: null }
  };
  const lines = () => fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
  return {
    src, root, clock, bare, other, fake, lines, count: (re) => lines().filter((l) => re.test(l)).length,
    mode: (m, on = true) => (on ? fs.writeFileSync(path.join(fake, m), "") : fs.rmSync(path.join(fake, m), { force: true })),
    async create() { const r = await svc().createRun({ source: src, goal, runId }); open.push(r); return r; },
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
function on(run, edge, match, nth, fn) {
  let prev = null, seen = 0, done = false;
  return run.onChange(() => {
    const a = run.view().active;
    const hit = edge === "start" ? a && !prev && match(a) : prev && !a && match(prev);
    prev = a;
    if (hit && !done && ++seen === nth) { done = true; fn(); }
  });
}
const finishOf = (step) => (a) => a.kind === "finish" && a.step === step;
async function records(root, runId) {
  const r = await readRun(root, runId);
  assert.equal(r.integrity.status, "ok", JSON.stringify(r.integrity));
  return r.state;
}
const lastFinish = (st, step) => st.orch.finish.filter((f) => f.step === step).at(-1);
const branchOf = (bare) => { try { return g(bare, "rev-parse", "--verify", "-q", "refs/heads/qa-branch"); } catch { return null; } };
// The address check stopped the push before anything was sent: no push process, no push intent, no branch anywhere.
async function blocked(t, run, expected = "paused(needs_user_action)") {
  assert.equal(reason(run), expected);
  assert.equal(t.count(/^git push /), 0, "the push did not start");
  assert.equal(lastFinish(await records(t.root, run.runId), "push"), undefined, "no push intent");
  assert.deepEqual([branchOf(t.bare), branchOf(t.other)], [null, null], "nothing reached a remote");
}
// No result file outlives its attempt.
const leftovers = (t, runId) => { const d = path.join(t.root, "runs", runId, "finish"); return fs.existsSync(d) ? fs.readdirSync(d) : []; };

test("1, 8: the allowed address among the shell's noise: committed, pushed and confirmed; the commit id is git's, not the noise", OPTS, async () => {
  for (const quiet of [false, true]) {
    const t = setup({ modes: quiet ? ["quiet"] : [] });
    const run = await t.create();
    await run.idle();
    assert.equal(reason(run), "completed", `${quiet ? "quiet" : "noisy"} shell`);
    const st = await records(t.root, run.runId);
    const head = g(t.src, "rev-parse", "HEAD");
    assert.deepEqual([lastFinish(st, "commit").status, lastFinish(st, "commit").commit], ["done", head], "the commit id git wrote");
    assert.notEqual(head, FAKE_OID);
    assert.deepEqual([lastFinish(st, "push").status, branchOf(t.bare)], ["done", head], "the remote branch is the commit");
    assert.deepEqual(leftovers(t, run.runId), []);
    // every attempt had its own files
    const outs = t.lines().flatMap((l) => [...l.matchAll(/>\| '([^']+)'/g)].map((m) => m[1]));
    assert.ok(outs.length >= 4, t.lines().join("\n"));
    assert.equal(new Set(outs).size, outs.length, "no result file is used twice");
  }
});

test("2, 3: a push URL, an insteadOf or a pushInsteadOf to another address blocks the push", OPTS, async () => {
  for (const [key, value] of [["remote.qa.pushurl", "other"], ["url.OTHER.insteadOf", "bare"], ["url.OTHER.pushInsteadOf", "bare"]]) {
    const t = setup();
    g(t.src, "config", key.replace("OTHER", t.other), value === "other" ? t.other : t.bare);
    const run = await t.create();
    await run.idle();
    await blocked(t, run);
  }
});

test("4, 5: a failed, empty or overfull address query blocks the push, whatever the other query said", OPTS, async () => {
  for (const mode of ["geturl-push-fail", "geturl-push-empty", "geturl-push-big"]) {
    const t = setup({ modes: [mode] });
    const run = await t.create();
    await run.idle();
    await blocked(t, run);
    assert.deepEqual(leftovers(t, run.runId), [], mode);
  }
});

test("6: Stop during the address check: the push does not start, the run stops", OPTS, async () => {
  const t = setup({ modes: ["geturl-block"] });
  const run = await t.create();
  await until(() => fs.existsSync(path.join(t.fake, "blocked")), "the address check running");
  assert.equal((await send(run, { kind: "stop" })).status, "accepted");
  await run.idle();
  await blocked(t, run, "stopped");
  assert.deepEqual(leftovers(t, run.runId), []);
});

test("6: the run's time limit during the address check: the push does not start, paused(limit_reached)", OPTS, async () => {
  const t = setup({ modes: ["geturl-block"] });
  const run = await t.create();
  on(run, "start", finishOf("push"), 1, () => t.clock.set(t.clock.t0 + HOUR - 200));
  await run.idle();
  await blocked(t, run, "paused(limit_reached)");
});

test("7: a push that sent nothing is not confirmed by the noise's ls-remote line, neither after the push nor when established", OPTS, async () => {
  const t = setup({ modes: ["push-noop"] });
  const run = await t.create();
  await run.idle();
  const head = g(t.src, "rev-parse", "HEAD");
  let push = lastFinish(await records(t.root, run.runId), "push");
  assert.deepEqual([push.status, push.commit, branchOf(t.bare)], ["failed", head, null], "the branch is absent on the remote");
  assert.notEqual(reason(run), "completed");

  // the confirmation alone (a push whose ls-remote did not start): established from the result file too
  const u = setup({ modes: ["push-noop"] });
  const again = await u.create();
  on(again, "end", finishOf("push"), 2, () => u.clock.set(u.clock.t0 + HOUR + 1)); // the push itself ended
  await again.idle();
  assert.equal(reason(again), "paused(limit_reached)");
  assert.equal((await send(again, { kind: "raise_limit", limit: "runMs", value: 100 * HOUR })).status, "accepted");
  assert.equal((await send(again, { kind: "resume" })).status, "accepted");
  await again.idle();
  assert.equal(reason(again), "paused(finish_unconfirmed)");
  assert.equal((await send(again, { kind: "resume" })).status, "accepted");
  await again.idle();
  push = lastFinish(await records(u.root, again.runId), "push");
  assert.deepEqual([push.status, push.established, branchOf(u.bare)], ["not_done", true, null]);
  assert.equal(u.count(/^git push /), 1, "pushed once");
});

test("7: a commit found by its trailer after a restart is git's id, not the noise's", OPTS, async () => {
  const started = file("started");
  // the commit is made; its post-commit hook holds the line until the application has closed (no result recorded)
  const t = setup({ hooks: { "post-commit": `touch ${started}; while :; do sleep 0.05; done` } });
  const init = g(t.src, "rev-parse", "HEAD");
  const run = await t.create();
  await until(() => fs.existsSync(started), "the commit made, its line still running");
  await run.shutdown();
  const head = g(t.src, "rev-parse", "HEAD");
  assert.notEqual(head, init);
  const again = await t.reopen(run.runId);
  await again.idle();
  assert.equal(reason(again), "paused(app_closed)");
  // the stopped commit line is "unknown": the person resumes past the pause that says so, then only git log runs
  for (const expected of ["paused(finish_unconfirmed)", null]) {
    assert.equal((await send(again, { kind: "resume" })).status, "accepted");
    await again.idle();
    if (expected) assert.equal(reason(again), expected);
  }
  assert.equal(t.count(/git commit /), 1, "committed once");
  const commit = (await records(t.root, again.runId)).orch.finish.find((f) => f.step === "commit" && f.established);
  assert.ok(commit, JSON.stringify((await records(t.root, again.runId)).orch.finish));
  assert.deepEqual([commit.status, commit.commit], ["done", head]);
});

// Opt-in, never in the default run: the person's own login shell ($SHELL -ilc with their rc files, unchanged), as in
// the real S6. Git's global and system config stay the test's (no signing, no rewrites of the person's); the remote
// is a local bare repository; no network, no model.
//   CANVASTTY_REAL_SHELL_TEST=1 node --test --test-name-pattern="real login shell" tests/orchestration-finish-result-channel.test.mjs
test("the person's real login shell: commit, the address check, push and ls-remote go through", {
  ...OPTS, skip: OPTS.skip || (process.env.CANVASTTY_REAL_SHELL_TEST !== "1" && "set CANVASTTY_REAL_SHELL_TEST=1 to run with the real $SHELL")
}, async () => {
  assert.ok(process.env.SHELL && path.isAbsolute(process.env.SHELL), "$SHELL is an absolute path");
  const { GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL } = GIT_ENV;
  const env = { HOME: os.homedir(), USER: os.userInfo().username, SHELL: process.env.SHELL, PATH: `${process.env.PATH}:${path.dirname(GIT)}`,
    GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL };
  const t = setup({ shell: { shell: process.env.SHELL, env } });
  const run = await t.create();
  await run.idle();
  const st = await records(t.root, run.runId);
  const head = g(t.src, "rev-parse", "HEAD");
  assert.equal(reason(run), "completed", JSON.stringify(st.orch.finish));
  assert.deepEqual([lastFinish(st, "commit").commit, lastFinish(st, "push").status, branchOf(t.bare)], [head, "done", head]);
  assert.deepEqual(leftovers(t, run.runId), []);
});
