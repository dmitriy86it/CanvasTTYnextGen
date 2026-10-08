// 1.5.13: no prompts for commands Claude's sandbox already holds (run 7303d772, «Рабочая папка»), and the
// "read-only commands until the run ends" decision. The CLI is tests/fixtures/orchestration/mock-claude.mjs: it sends
// the can_use_tool requests a script asks for, with the fields the real CLI sends (decision_reason_type, the input's
// dangerouslyDisableSandbox), and records the host's reply in decisions.jsonl.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { CLAUDE_WORKSPACE_SETTINGS, claudeAccessArgs, claudeSandboxExclusions } from "../src/main/services/orchestration/access.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { readOnlyCommand } from "../src/main/services/orchestration/readOnly.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-readonly-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@localhost" };
let n = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(50);
  }
}
function project() {
  const dir = path.join(TMP, `p-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync(GIT, a, { cwd: dir, env: GIT_ENV });
  return fs.realpathSync(dir);
}
function wrapper(name, mock) {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return f;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
function script(answers) {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  answers.forEach((a, i) => {
    fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(a.answer));
    if (a.asks) fs.writeFileSync(path.join(dir, `${i + 1}.asks.json`), JSON.stringify(a.asks));
  });
  return dir;
}
const PLAN = { answer: { stages: [{ title: "look", task: "look at the code" }], question: null } };
const REVIEW = { answer: { verdict: "accept", findings: [], question: null } };
const FINAL = { answer: { verdict: "complete", findings: [], question: null } };
const EXEC = (asks) => ({ answer: { summary: "done", done: true }, asks });
function manager(state, scriptDir) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: state, MOCK_SCRIPT: scriptDir } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p } }));
  const root = path.join(TMP, `root-${++n}`);
  const m = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH) });
  m.root = root;
  return m;
}
const view = async (m, runId) => (await m.get(runId)).value.view;
const decide = (m, v, decision) => m.command(v.runId, { commandId: randomUUID(), expectedRevision: v.revision,
  command: { kind: "permission", requestId: v.permission.requestId, decision } });
const decisions = (state) => (fs.existsSync(path.join(state, "decisions.jsonl"))
  ? fs.readFileSync(path.join(state, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
// Answers every prompt with what pick(view) says, keeping each prompt seen, until the run settles.
async function drive(m, runId, pick) {
  const seen = [];
  for (;;) {
    const v = await until(async () => {
      const x = await view(m, runId);
      return x.permission && !seen.some((s) => s.permission.requestId === x.permission.requestId) ? x
        : ["completed", "paused", "failed", "stopped"].includes(x.status) && !x.permission ? x : null;
    }, "a prompt or the end");
    if (!v.permission) return { seen, end: v };
    seen.push(v);
    await decide(m, v, pick(v));
  }
}
async function run(access, asks) {
  const src = project();
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const m = manager(state, script([PLAN, EXEC(asks), REVIEW, FINAL]));
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: [], access: { claude: access, codex: "workspace" } });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: src, goal: { text: "look", criteria: ["c"], checks: [], commands: ["true"], mode: "autopilot" } })).ok);
  return { m, runId, state, src };
}

// the commands Claude asked about in run 7303d772 (career-os), as the CLI sent them
const R1 = `cd "apps/api" && bash -c '
sed -n 386,436p tests/analysis/test_analysis_api.py
grep -niE "market_snapshot|market" src/career_os/modules/analysis/{service,models,schemas,domain}.py | head -20
grep -rniE "31|legacy|n=2|trend|stale|unlicensed|attribution|ttl" src/career_os/providers/market.py | head'`;
const R2 = `cd "apps/api/src/career_os" && for f in modules/*/api.py; do echo "== $f"; grep -nE -A3 '@router\\.(get|post|put|patch|delete)\\($' $f | grep -E '"/' ; grep -nE '^(async )?def ' $f; done`;
const R3 = `cd "." && O="--include=*.py --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=.next"; echo "## task impact"; grep -rniE $O 'ai_task_impact|task.impact|automation.factor|automation_risk' apps tests | head`;
const R4 = `cd "." && g(){ grep -rniE --include='*.py' --exclude-dir=node_modules "$@"; }; echo "## tutor"; g 'tutor' apps tests | head`;
// what Claude 2.1.294 said about them (scripts/claude-workspace-probe.mjs P5, 2026-10-08)
const SUBCOMMANDS = { decision_reason_type: "subcommandResults" };
const VARIABLE = { decision_reason_type: "other", decision_reason: "A variable in this command can't be checked before it runs" };
const BRACE = { decision_reason_type: "other", decision_reason: "Contains brace with quote character (expansion obfuscation)" };
const bash = (command, request, extra = {}) => ({ tool: "Bash", input: { command, description: "look", ...extra }, request });

test("the read-only commands of run 7303d772 are read-only; writes, the network, git and anything unknown are not", () => {
  for (const c of [R1, R2, R3, "ls -la && wc -l src/*.ts 2>&1 | tail -3", `grep -rliE "backup" apps 2>/dev/null | grep -v node_modules | head`]) {
    assert.equal(readOnlyCommand(c), true, c);
  }
  for (const c of [R4, `G='grep -rn'; $G x apps`, "echo hi > out.txt", "cat a >> b", "sed -i s/a/b/ f", "sed -n 'w /tmp/x' f", "find . -delete",
    "find . -exec rm {} \\;", "find $X", "rg --pre ./x foo", "sort -o out f", "uniq a b", "git status", "git diff", "curl https://example.com",
    "cat $(echo f)", "cat `echo f`", "echo hi & rm -rf x", "(cd x; ls)", "npm test", "mkdir -p x", `bash -c "$X"`, "cat <<EOF\nx\nEOF", "tee f",
    "awk '{print}' f", "until [ -s f ]; do sleep 1; done",
    "PATH=/tmp/x grep a f", "PATH=/tmp/x; grep a f", "IFS=x; cat f", "BASH_ENV=/tmp/x bash -c 'cat f'", "path=(/tmp/x); grep a f", "path=/tmp/x; grep a f",
    "for PATH in /tmp/x; do grep a f; done", "LC_ALL=C grep a f", "sort --compress-program=./x f", "sort -T /tmp f", "printf -v PATH x",
    `O='$(touch x)'; cat "\${(e)O}"`, "cat ${(e)O}", `cat "\${X@P}"`, "cat $[1]", "rg --hostname-bin=./x a", "rg -z a", "file -C -m x",
    "echo $'\\'' ; rm -rf x ; echo '", "sed -n 1p *", "find *", "rg x *", "sort *", "uniq *", "printf *", "sed -n 1p {-i,f}", "rg x ./-[-]pre=x", "cat a # '\nrm -rf x\n'", `cat $"x"`, "ls; python3 -c 'open(\"x\",\"w\")'", "cat 'unterminated"]) {
    assert.equal(readOnlyCommand(c), false, c);
  }
});

test("«Рабочая папка»: Claude runs with its sandbox and the session answers the prompts the sandbox holds", () => {
  const args = claudeAccessArgs("workspace");
  assert.deepEqual(args.slice(0, 3), ["--permission-mode", "acceptEdits", "--settings"]);
  const settings = JSON.parse(args[3]);
  assert.deepEqual(settings, JSON.parse(JSON.stringify(CLAUDE_WORKSPACE_SETTINGS)));
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.autoAllowBashIfSandboxed, true);
  assert.deepEqual(settings.sandbox.network.allowedDomains, [], "no outside host");
});

test("«Рабочая папка»: the commands of 7303d772 run without a prompt; leaving the sandbox, the network and a write outside still ask", OPTS, async () => {
  const outside = path.join(TMP, "outside.txt");
  const { m, runId, state } = await run("workspace", [
    bash(R1, SUBCOMMANDS), bash(R2, VARIABLE), bash(R4, BRACE), bash(R3, VARIABLE),
    bash(`u=https://example.com; curl -sS $u`, VARIABLE, { dangerouslyDisableSandbox: true }), // asks to leave the sandbox
    { tool: "SandboxNetworkAccess", input: { host: "registry.npmjs.org" } }, // the sandbox's own network prompt
    { tool: "Write", input: { file_path: outside, content: "x" } }, // a write outside the folder
    bash("npm run lint", { decision_reason_type: "rule", matched_ask_rule: "Bash(npm run lint)" }) // the user's own ask rule
  ]);
  const { seen, end } = await drive(m, runId, () => "deny");
  assert.deepEqual(seen.map((v) => v.permission.tool), ["Bash", "SandboxNetworkAccess", "Write", "Bash"], "only what leaves the sandbox or a rule asks for");
  assert.match(seen[0].permission.summary, /^u=https:\/\/example\.com; curl/);
  assert.equal(end.status, "completed", JSON.stringify(end));
  const replies = decisions(state).filter((d) => d.tool === "Bash" || d.tool === "SandboxNetworkAccess" || d.tool === "Write");
  assert.deepEqual(replies.slice(0, 4).map((d) => d.reply.behavior), ["allow", "allow", "allow", "allow"]);
  assert.deepEqual(replies.slice(0, 4).map((d) => d.reply.updatedInput.dangerouslyDisableSandbox), [undefined, undefined, undefined, undefined], "they stay in the sandbox");
  assert.deepEqual(replies.slice(4).map((d) => d.reply.behavior), ["deny", "deny", "deny", "deny"]);
  assert.equal(fs.existsSync(outside), false);
  await m.shutdown();
});

test("commands the user's settings run outside the sandbox: the session answers no Bash prompt by itself", () => {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const cwd = fs.mkdtempSync(path.join(TMP, "cwd-"));
  assert.equal(claudeSandboxExclusions(home, cwd), false);
  fs.mkdirSync(path.join(cwd, ".claude"));
  fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ sandbox: { excludedCommands: [] } }));
  assert.equal(claudeSandboxExclusions(home, cwd), false);
  fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), "not json");
  assert.equal(claudeSandboxExclusions(home, cwd), true, "a settings file that cannot be read: fail closed");
  fs.rmSync(path.join(cwd, ".claude", "settings.json"));
  const config = fs.mkdtempSync(path.join(TMP, "config-"));
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ sandbox: { excludedCommands: ["docker"] } }));
  assert.equal(claudeSandboxExclusions(home, cwd), false);
  assert.equal(claudeSandboxExclusions(home, cwd, config), true, "CLAUDE_CONFIG_DIR");
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ sandbox: { excludedCommands: ["docker"] } }));
  assert.equal(claudeSandboxExclusions(home, cwd), true);
});

test("without the sandbox (the user's own settings) the same prompts reach the person", OPTS, async () => {
  const { m, runId } = await run("terminal", [bash(R2, VARIABLE), bash(R4, BRACE)]);
  const { seen, end } = await drive(m, runId, () => "allow_once");
  assert.equal(seen.length, 2);
  assert.equal(end.status, "completed");
  await m.shutdown();
});

test("«read-only until the run ends»: offered after 3 read-only prompts, answers the later ones of this run only", OPTS, async () => {
  const ro = ["cat a.txt", "head -5 a.txt", "grep -n 1 a.txt", "sed -n 1,2p a.txt", "wc -l a.txt", "ls -la"];
  const asks = [...ro.slice(0, 5).map((c) => bash(c)), bash("rm -f a.txt"), bash(ro[5])];
  const first = await run("terminal", asks);
  const { seen, end } = await drive(first.m, first.runId, (v) => (v.permission.options.includes("allow_readonly_run") ? "allow_readonly_run" : "allow_once"));
  assert.deepEqual(seen.map((v) => v.permission.options.includes("allow_readonly_run")), [false, false, false, true, false],
    "the 4th read-only prompt offers it; the write after it does not");
  assert.deepEqual(seen.map((v) => v.permission.summary), [...ro.slice(0, 4), "rm -f a.txt"], "the 5th and 6th read-only commands asked nobody");
  assert.equal(end.status, "completed");
  const replies = decisions(first.state).filter((d) => d.tool === "Bash");
  assert.equal(replies.length, 7);
  assert.ok(replies.every((d) => d.reply.behavior === "allow"));
  await first.m.shutdown();
  // another run: nothing carried over
  const second = await run("terminal", [bash(ro[0])]);
  const again = await drive(second.m, second.runId, () => "allow_once");
  assert.equal(again.seen.length, 1);
  assert.equal(again.seen[0].permission.options.includes("allow_readonly_run"), false);
  await second.m.shutdown();
});
