// Independent review of the finish result channel (tests/orchestration-finish-result-channel.test.mjs covers the S6
// cases): what else must not confirm an address, a commit or a push — a second address, a failed fetch-side query, a
// result file swapped for a symlink, an rc file that pre-writes the allowed address, the person's noclobber — and what
// the evidence says when a fact is missing (D1-D3 of the review, fixed).
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
import { readRun, readText } from "../src/main/services/orchestration/store.ts";
import { commitMessage } from "../src/main/services/orchestration/finish.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const SUPERVISOR = path.join(HERE, "..", "src", "orchestration", "supervisor.mjs");
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const HOUR = 3600_000;

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-result-review-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
// `git` in front of the real one: what $FAKE_DIR/<mode> asks for, otherwise the real git
const FAKE_BIN = path.join(TMP, "fake-bin");
fs.mkdirSync(FAKE_BIN);
fs.writeFileSync(path.join(FAKE_BIN, "git"), `#!/bin/sh
F="$FAKE_DIR"
case "$*" in
  *get-url*--push*) [ -f "$F/geturl-push-fail" ] && { echo "fatal: no such remote" >&2; exit 2; } ;;
  *get-url*)
    [ -f "$F/geturl-fetch-fail" ] && { "${GIT}" "$@"; exit 2; }
    [ -f "$F/geturl-fetch-empty" ] && exit 0 ;;
  rev-parse\\ HEAD) [ -f "$F/revparse-extra" ] && { "${GIT}" "$@"; echo "hint: a git wrapper's own line"; echo "wrapper: stderr note" >&2; exit 0; } ;;
esac
exec "${GIT}" "$@"
`, { mode: 0o755 });
const GIT_ENV = { PATH: `${FAKE_BIN}:/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
// The login shell (`-ilc <line>`): the line goes to the ledger; before it runs, like an rc file could, it may swap each
// result file named in the line for a symlink ($FAKE_DIR/symlink) or pre-write the allowed address into it
// ($FAKE_DIR/prewrite); $FAKE_DIR/noclobber runs the line with noclobber set.
const SHELL = path.join(TMP, "rc-shell");
fs.writeFileSync(SHELL, `#!/bin/sh
[ "$1" = "-ilc" ] && shift
printf '%s\\n' "$1" >> "$LEDGER"
for p in $(printf '%s' "$1" | grep -o ">| '[^']*'" | sed "s/^>| '//; s/'\\$//"); do
  [ -f "$FAKE_DIR/symlink" ] && { rm -f "$p"; ln -s "$FAKE_DIR/forged" "$p"; }
  [ -f "$FAKE_DIR/prewrite" ] && cat "$FAKE_DIR/allowed" > "$p"
done
if [ -f "$FAKE_DIR/noclobber" ]; then /bin/sh -C -c "$1"; else /bin/sh -c "$1"; fi
`, { mode: 0o755 });
const REGISTRY = createRegistry([{ id: "unused", title: "unused", executable: NODE, argv: ["-e", "0"], timeoutMs: 60_000, maxOutputBytes: 8192 }]);

let n = 0;
const file = (name) => path.join(TMP, `${name}-${++n}`);
const agents = () => createTestAgents({
  plan: { report: plan("one") },
  execute: { report: executed(), edit: (repo) => fs.writeFileSync(repo.path("a.txt"), "2\n") },
  review: { report: review("accept") },
  final_review: { report: review("complete") }
});
// every activity entry the service reports, whatever the method
const recorder = (entries) => new Proxy({}, { get: (_, method) => (...args) => { entries.push({ method, args }); } });

const open = [];
afterEach(async () => { for (const r of open.splice(0)) await r.shutdown().catch(() => {}); });
function setup({ modes = [], remoteUrl } = {}) {
  const src = file("src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "a.txt"), "1\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "init");
  const bare = file("remote.git"), other = file("other.git");
  g(TMP, "init", "-q", "--bare", bare);
  g(TMP, "init", "-q", "--bare", other);
  g(src, "remote", "add", "qa", bare);
  const fake = file("fake");
  fs.mkdirSync(fake);
  for (const m of modes) fs.writeFileSync(path.join(fake, m), "");
  fs.writeFileSync(path.join(fake, "allowed"), `${bare}\n`);
  fs.writeFileSync(path.join(fake, "forged"), `${bare}\n`);
  const root = file("root"), ledger = file("ledger");
  fs.writeFileSync(ledger, "");
  const activity = [];
  const runId = randomUUID();
  const goal = {
    text: "a to 2", criteria: ["a is 2"], checks: [], commands: ["true"], workMode: "project", mode: "autopilot", limits: { runMs: HOUR },
    finish: { commit: { message: commitMessage("a to 2", runId) }, push: { remote: "qa", branch: "qa-branch", remoteUrl: remoteUrl === undefined ? bare : remoteUrl }, qa: null }
  };
  const lines = () => fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
  return {
    src, root, bare, other, activity, count: (re) => lines().filter((l) => re.test(l)).length,
    async create() {
      const r = await createOrchestrationService({
        root, gitPath: GIT, agents: agents(), stopGraceMs: 5000, activity: () => recorder(activity),
        checks: { registry: REGISTRY, deps: null, launch: { command: NODE, args: [SUPERVISOR], env: {} }, shell: { shell: SHELL, env: { ...GIT_ENV, LEDGER: ledger, FAKE_DIR: fake } } }
      }).createRun({ source: src, goal, runId });
      open.push(r);
      return r;
    }
  };
}
const reason = (run) => { const v = run.view(); return v.status === "paused" ? `paused(${v.reason})` : v.status; };
async function records(root, runId) {
  const r = await readRun(root, runId);
  assert.equal(r.integrity.status, "ok", JSON.stringify(r.integrity));
  return r.state;
}
const lastFinish = (st, step) => st.orch.finish.filter((f) => f.step === step).at(-1);
const branchOf = (bare) => { try { return g(bare, "rev-parse", "--verify", "-q", "refs/heads/qa-branch"); } catch { return null; } };
async function blocked(t, run) {
  assert.equal(reason(run), "paused(needs_user_action)");
  assert.equal(t.count(/^git push /), 0, "the push did not start");
  assert.equal(lastFinish(await records(t.root, run.runId), "push"), undefined, "no push intent");
  assert.deepEqual([branchOf(t.bare), branchOf(t.other)], [null, null], "nothing reached a remote");
}
const pushTexts = (t) => t.activity.filter((e) => e.method === "finish" && e.args[0] === "push").map((e) => `${e.args[1]}: ${e.args[2]}`);

test("a second address of the remote, even with the allowed one first, blocks the push", OPTS, async () => {
  const t = setup();
  g(t.src, "config", "--add", "remote.qa.url", t.other);
  const run = await t.create();
  await run.idle();
  await blocked(t, run);
  // a mismatch names what was found
  assert.match(pushTexts(t).join("\n"), new RegExp(`blocked: the address of qa is not the one you allowed: got .*${t.other}`));
});

test("a failed or empty fetch-side address query blocks the push, whatever the push side said", OPTS, async () => {
  for (const mode of ["geturl-fetch-fail", "geturl-fetch-empty"]) {
    const t = setup({ modes: [mode] });
    const run = await t.create();
    await run.idle();
    await blocked(t, run);
  }
});

test("a result file swapped for a symlink to a file with the allowed address is not read", OPTS, async () => {
  const t = setup({ modes: ["symlink"] });
  const run = await t.create();
  await run.idle();
  // the commit id cannot be read either: the commit is unconfirmed, nothing is pushed
  assert.equal(lastFinish(await records(t.root, run.runId), "commit").status, "unknown");
  assert.equal(t.count(/^git push /), 0);
  assert.deepEqual([branchOf(t.bare), branchOf(t.other)], [null, null]);
});

test("an rc file that pre-writes the allowed address does not hide a push URL elsewhere", OPTS, async () => {
  const t = setup({ modes: ["prewrite"] });
  g(t.src, "config", "remote.qa.pushurl", t.other);
  const run = await t.create();
  await run.idle();
  await blocked(t, run);
});

test("the person's noclobber: `>|` still writes the result files, committed, pushed and confirmed", OPTS, async () => {
  const t = setup({ modes: ["noclobber"] });
  const run = await t.create();
  await run.idle();
  assert.equal(reason(run), "completed");
  const st = await records(t.root, run.runId);
  assert.deepEqual([lastFinish(st, "push").status, branchOf(t.bare)], ["done", g(t.src, "rev-parse", "HEAD")]);
});

test("a commit made whose id is not confirmed is not recorded as \"nothing to commit\"", OPTS, async () => {
  const t = setup({ modes: ["revparse-extra"] });
  const run = await t.create();
  await run.idle();
  const commit = lastFinish(await records(t.root, run.runId), "commit");
  assert.equal(commit.status, "unknown");
  assert.equal(t.count(/^git push /), 0);
  const evidence = (await readText(t.root, run.runId, commit.evidence)).toString("utf8");
  assert.doesNotMatch(evidence, /nothing to commit/);
  assert.match(evidence, /commit made, id not confirmed/);
  assert.match(evidence, /wrapper: stderr note/, "the shell output's tail is kept");
});

test("a failed address query is reported as a failure with its exit, not as another address", OPTS, async () => {
  const t = setup({ modes: ["geturl-push-fail"] });
  const run = await t.create();
  await run.idle();
  await blocked(t, run);
  const text = pushTexts(t).join("\n");
  assert.doesNotMatch(text, /not the one you allowed/, text);
  assert.match(text, /blocked: the address query of qa failed: exit 2/, text);
  assert.match(text, /fatal: no such remote/, text);
});

test("a push target without a saved address is not pushed unchecked", OPTS, async () => {
  const t = setup({ remoteUrl: null });
  g(t.src, "config", "remote.qa.pushurl", t.other);
  const run = await t.create();
  await run.idle();
  await blocked(t, run);
  assert.match(pushTexts(t).join("\n"), /blocked: the allowed address of qa is not saved/);
  assert.equal(t.count(/get-url/), 0, "no address query either");
});
