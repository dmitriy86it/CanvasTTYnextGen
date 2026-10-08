// «Проверить сейчас» (UX audit 2026-10-05, №8): before the start and without a model call — the CLIs' sign-in,
// Claude's model "not checked", the check sandbox and git in it, and with full the preparation and the commands on
// the source in a temporary work folder of the chosen mode (never the project folder), removed afterwards whatever
// happened. Fake CLIs and local repositories only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { authItems, sourceChecks } from "../src/main/services/orchestration/preflight.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-preflight-test-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV });
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const RT = { shell: SHELL, env: GIT_ENV };

let n = 0;
function project(files = { "a.txt": "1\n" }, commit = true) {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  for (const [f, text] of Object.entries({ ".gitignore": "node_modules/\n", ...files })) fs.writeFileSync(path.join(dir, f), text);
  g(dir, "init", "-q", "-b", "main");
  if (commit) { g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", "init"); }
  return dir;
}
// what a temporary work folder could leave in the project's repository
const traces = (dir) => ({
  refs: g(dir, "for-each-ref", "--format=%(refname)", "refs/canvastty/").trim(),
  branches: g(dir, "branch", "--list", "canvastty/*").trim(),
  worktrees: g(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length
});
const tmpOf = () => fs.mkdtempSync(path.join(TMP, "tmp-"));

test("on the source in a copy: a command that passes, one that fails (its first lines) and one out of time; the copy is gone, nothing left in the repository", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  fs.writeFileSync(path.join(src, "local.txt"), "uncommitted\n"); // a copy starts from the working tree, as a run's does
  const tmp = tmpOf();
  const r = await sourceChecks({
    project: src, workMode: "copy", rt: RT, launch: LAUNCH, gitPath: GIT, tmp, timeoutMs: 8_000,
    commands: ["grep -qx 1 a.txt && test -f local.txt", "echo 'expected 2, got 1' >&2; exit 3", "sleep 30"]
  });
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.equal(by.source_1.level, "ok");
  assert.equal(by.source_1.facts.result, "passed");
  assert.equal(by.source_2.level, "warning");
  assert.equal(by.source_2.facts.result, "failed");
  assert.equal(by.source_2.facts.exitCode, 3);
  assert.match(String(by.source_2.facts.output), /expected 2, got 1/);
  assert.equal(by.source_3.facts.result, "timeout");
  // a command failing before any change: said once, as a warning of its own
  assert.equal(by.source_failing?.level, "warning");
  assert.equal(by.source_failing.facts.failing, 1);
  assert.ok(r.durationMs < 30_000, "the time limit holds for all of them");
  assert.deepEqual(fs.readdirSync(tmp), [], "the temporary folder is removed");
  assert.deepEqual(traces(src), { refs: "", branches: "", worktrees: 1 });
  assert.equal(fs.readFileSync(path.join(src, "a.txt"), "utf8"), "1\n");
});

test("in a worktree: commands run from HEAD on their own branch; the worktree, its branch and refs are removed", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const tmp = tmpOf();
  const r = await sourceChecks({ project: src, workMode: "worktree", rt: RT, launch: LAUNCH, gitPath: GIT, tmp, commands: ["grep -qx 1 a.txt && git rev-parse --abbrev-ref HEAD | grep -q '^canvastty/'"] });
  assert.equal(r.items[0].facts.result, "passed", JSON.stringify(r.items));
  assert.deepEqual(fs.readdirSync(tmp), []);
  assert.deepEqual(traces(src), { refs: "", branches: "", worktrees: 1 });
});

test("in the project folder the commands are not run: they are said to run there at the start", OPTS, async () => {
  const src = project();
  const tmp = tmpOf();
  const r = await sourceChecks({ project: src, workMode: "project", rt: RT, launch: LAUNCH, gitPath: GIT, tmp, commands: ["touch ran.txt"] });
  assert.deepEqual(r.items.map((i) => [i.id, i.level, i.facts.mode]), [["source", "info", "project"]]);
  assert.equal(fs.existsSync(path.join(src, "ran.txt")), false);
  assert.deepEqual(fs.readdirSync(tmp), [], "no temporary folder at all");
});

test("an error on the way still removes the temporary folder and what it put in the repository", OPTS, async () => {
  // a worktree needs a commit to start from: the work folder is refused after the temporary folder was made
  const empty = project({ "a.txt": "1\n" }, false);
  const tmp = tmpOf();
  const r = await sourceChecks({ project: empty, workMode: "worktree", rt: RT, launch: LAUNCH, gitPath: GIT, tmp, commands: ["true"] });
  assert.deepEqual(r.items.map((i) => [i.id, i.level, i.facts.code]), [["source", "warning", "workspace_failed"]]);
  assert.deepEqual(fs.readdirSync(tmp), []);
  // a command whose shell cannot start: a failure of that command, and the copy is removed as well
  const src = project();
  const tmp2 = tmpOf();
  const r2 = await sourceChecks({ project: src, workMode: "copy", rt: { shell: path.join(TMP, "no-such-shell"), env: GIT_ENV }, launch: LAUNCH, gitPath: GIT, tmp: tmp2, commands: ["true"] });
  assert.equal(r2.items[0].facts.result, "failed");
  assert.deepEqual(fs.readdirSync(tmp2), []);
  assert.deepEqual(traces(src), { refs: "", branches: "", worktrees: 1 });
});

test("the sign-in as each CLI says it, never its account; a CLI that cannot say it gets no item", OPTS, async () => {
  const wrap = (name, body) => {
    const f = path.join(TMP, `${name}-${++n}`);
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return f;
  };
  const env = { PATH: "/usr/bin:/bin" };
  // the subcommand's own help lists `status` (as codex 0.160 and claude 2.1.293 do): only then is it asked
  const helps = `[ "$1 $2" = "login --help" ] || [ "$1 $2" = "auth --help" ] && { echo "Commands:"; echo "  status  Show the status"; exit 0; }; `;
  const signed = await authItems({ env, executables: {
    codex: wrap("codex", `${helps}[ "$1 $2" = "login status" ] && { echo "Logged in using ChatGPT" >&2; exit 0; }; exit 2`),
    claude: wrap("claude", `${helps}[ "$1 $2" = "auth status" ] && echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "someone@example.com"}'`)
  } });
  assert.deepEqual(signed.map((i) => [i.id, i.level, i.facts.method]), [["auth_codex", "ok", "ChatGPT"], ["auth_claude", "ok", "claude.ai"]]);
  assert.doesNotMatch(JSON.stringify(signed), /someone@example\.com/);
  const out = await authItems({ env, executables: {
    codex: wrap("codex", `${helps}echo "Not logged in" >&2; exit 1`),
    claude: wrap("claude", `${helps}echo '{"loggedIn": false}'; exit 1`)
  } });
  assert.deepEqual(out.map((i) => [i.id, i.level]), [["auth_codex", "warning"], ["auth_claude", "warning"]]);
  const unknown = await authItems({ env, executables: { codex: wrap("codex", `echo "error: unrecognized subcommand 'login'" >&2; exit 2`), claude: wrap("claude", "echo 'Usage: claude'; exit 1") } });
  assert.deepEqual(unknown, []);
  // a help without `status`: the status is never asked, even though the program would answer it
  const asked = path.join(TMP, `asked-${++n}`);
  const noStatus = await authItems({ env, executables: {
    codex: wrap("codex", `[ "$2" = "--help" ] && { echo "Commands:"; echo "  logout  Remove"; exit 0; }; echo codex >> ${asked}; echo "Logged in using ChatGPT" >&2`),
    claude: wrap("claude", `[ "$2" = "--help" ] && { echo "Commands:"; echo "  login  Sign in"; exit 0; }; echo claude >> ${asked}; echo '{"loggedIn": true}'`)
  } });
  assert.deepEqual(noStatus, []);
  assert.equal(fs.existsSync(asked), false);
});

// the fake CLIs' record: every model turn saves a session file (<uuid>.json); codex-thread.jsonl — each thread/start|resume;
// claude-argv.jsonl — each Claude run
function modelCalls(state) {
  const files = fs.readdirSync(state);
  return { sessions: files.filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).length, threads: files.includes("codex-thread.jsonl"), claudeRuns: files.includes("claude-argv.jsonl") };
}

test("«Проверить сейчас» as main answers it: every item, and not one model call (the fake CLIs' record)", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const file = path.join(TMP, `providers-${++n}.json`);
  const wrapper = (name, mock) => {
    const f = path.join(TMP, `${name}-${++n}`);
    fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
    return f;
  };
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: state } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: wrapper("codex", "mock-codex.mjs"), version: "codex-cli 0.155.1", ...p }, claude: { executable: wrapper("claude", "mock-claude.mjs"), version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, MOCK_STATE: state }
  }));
  const root = path.join(TMP, `root-${++n}`);
  const m = createRunManager({
    platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000, journalV2: true, leadSandbox: false,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), workspaceKnown: () => true
  });
  await createProfileStore(root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["grep -qx 1 a.txt"] });
  const at = (x) => ({ position: { x, y: 0 }, size: { width: 300, height: 200 } });
  const [lead, exec, linkId] = [randomUUID(), randomUUID(), randomUUID()];
  assert.ok((await m.createAgent({ agentId: lead, provider: "codex", project: src, bounds: at(0) })).ok);
  assert.ok((await m.createAgent({ agentId: exec, provider: "claude", project: src, bounds: at(400) })).ok);
  assert.ok((await m.createLink({ linkId, fromAgentId: lead, toAgentId: exec })).ok);
  try {
    const started = Date.now();
    const r = await m.readiness({ linkId, commands: ["grep -qx 1 a.txt", "grep -qx 2 a.txt"], workMode: "copy", full: true, timeoutMs: 60_000 });
    const ms = Date.now() - started;
    assert.ok(r.ok, JSON.stringify(r));
    const by = Object.fromEntries(r.value.items.map((i) => [i.id, i]));
    assert.equal(by.auth_codex?.level, "ok");
    assert.equal(by.auth_claude?.level, "ok");
    assert.equal(by.model_claude?.level, "info");
    assert.equal(by.source_1?.facts.result, "passed");
    assert.equal(by.source_2?.facts.result, "failed");
    assert.equal(r.value.ready, true, "warnings never block the start");
    assert.equal(r.value.items.at(-1).id, "permissions");
    assert.deepEqual(modelCalls(state), { sessions: 0, threads: false, claudeRuns: false });
    assert.deepEqual(fs.readFileSync(path.join(state, "auth.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).sort(), ["claude", "codex"]);
    console.log(`# preflight with the fake CLIs: ${ms} ms`);
    // without full: the light check opening the dialog makes — no command runs, no temporary folder
    const light = await m.readiness({ linkId, commands: ["touch ran.txt"], workMode: "copy" });
    assert.ok(light.ok);
    assert.ok(!light.value.items.some((i) => i.id.startsWith("source")));
    assert.ok(light.value.items.some((i) => i.id === "auth_codex"));
    assert.deepEqual(modelCalls(state), { sessions: 0, threads: false, claudeRuns: false });
  } finally {
    await m.shutdown?.();
  }
});
