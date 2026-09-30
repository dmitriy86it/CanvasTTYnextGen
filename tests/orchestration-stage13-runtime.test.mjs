// Stage 13 runtime review (RT-*): the protocol shapes of codex 0.155.1 and Claude Code 2.1.281 that the fake CLIs did not
// cover before — saved decisions, prompts that must reach a person, file-change paths, the rights mode the CLI really
// runs, the environment probe. Fake CLIs only; no model runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createFrameMapper } from "../src/main/services/orchestration/activity.ts";
import { grantFingerprint, validateProfile, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { probeCodex } from "../src/main/services/orchestration/probe.ts";
import { startNativeTurn } from "../src/main/services/orchestration/providers.ts";
import { sessionEnv } from "../src/main/services/orchestration/turn.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 60_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-rt-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;

function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const EXE = { codex: wrapper("codex", "mock-codex.mjs"), claude: wrapper("claude", "mock-claude.mjs") };
const VERSION = { codex: "codex-cli 0.155.1", claude: "2.1.281 (Claude Code)" };
const SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "string" } }, additionalProperties: false };

// One native turn of a fake CLI; `reply` answers each prompt. Returns the prompts, the CLI's recorded decisions and
// the activity entries the turn produced.
async function turn(provider, { asks = [], env = {}, access, reply = () => ({ decision: "allow_once" }) } = {}) {
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const script = fs.mkdtempSync(path.join(TMP, "script-"));
  fs.writeFileSync(path.join(script, "1.json"), JSON.stringify({ ok: "yes" }));
  fs.writeFileSync(path.join(script, "1.asks.json"), JSON.stringify(asks));
  const cwd = fs.mkdtempSync(path.join(TMP, `cwd-${++n}-`));
  const prompts = [];
  const activity = [];
  const map = createFrameMapper(provider, provider === "codex" ? "lead" : "executor", cwd);
  const started = startNativeTurn({
    cli: { state: "available", provider, executable: EXE[provider], launcher: "native", environment: { PATH: process.env.PATH }, checked: [] },
    cliVersion: VERSION[provider], cwd, env: { PATH: process.env.PATH, HOME: TMP, MOCK_STATE: state, MOCK_SCRIPT: script, ...env },
    task: "do it", schema: SCHEMA, session: { kind: "new" }, clientVersion: "test",
    ask: async (a) => { prompts.push(a); return reply(a); }, ...(access ? { access } : {})
  }, LAUNCH, { frame: (f) => activity.push(...map(f)), stderr: (c) => activity.push({ kind: "stderr", text: c.toString() }) });
  assert.ok(started.ok, JSON.stringify(started));
  const result = await started.result;
  const decisions = fs.existsSync(path.join(state, "decisions.jsonl"))
    ? fs.readFileSync(path.join(state, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { result, prompts, decisions, activity };
}

test("RT-1: a saved decision covers the same Codex command asked again; ids and times are not the action", () => {
  const cmd = (itemId, startedAtMs) => ({ kind: "shell", threadId: "t", turnId: "u", itemId, startedAtMs, environmentId: null, command: "npm test", cwd: "/p", reason: "tests" });
  assert.equal(grantFingerprint("codex", "command", "command", cmd("i1", 1000)), grantFingerprint("codex", "command", "command", cmd("i2", 2000)));
  assert.notEqual(grantFingerprint("codex", "command", "command", cmd("i1", 1)), grantFingerprint("codex", "command", "command", { ...cmd("i1", 1), cwd: "/other" }));
  // inside a tool's own input a "description" or "reason" is a parameter, not wording around the request
  assert.notEqual(grantFingerprint("claude", "tool", "mcp__jira__create", { title: "x", fields: { description: "harmless" } }),
    grantFingerprint("claude", "tool", "mcp__jira__create", { title: "x", fields: { description: "DROP everything" } }));
  // the Bash tool's own top-level description stays wording (as before)
  assert.equal(grantFingerprint("claude", "tool", "Bash", { command: "ls", description: "a" }), grantFingerprint("claude", "tool", "Bash", { command: "ls", description: "b" }));
});

test("RT-2, RT-3, RT-10.2: Claude — rule-forced prompts are always asked; 'for the session' stays in the session", OPTS, async () => {
  const { result, prompts, decisions } = await turn("claude", {
    asks: [
      { tool: "Bash", command: "git push", request: { matched_ask_rule: { source: "userSettings", tool_name: "Bash", rule_content: "git push:*" } } },
      { tool: "Bash", command: "rm -rf build", request: { decision_reason_type: "safetyCheck", decision_reason: "dangerous" } },
      { tool: "Edit", input: { file_path: "/x" }, request: { requires_user_interaction: true } },
      { tool: "Bash", command: "npm run lint", suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run lint:*" }], behavior: "allow", destination: "localSettings" },
        { type: "addDirectories", directories: ["/y"], destination: "projectSettings" }] },
      { tool: "SandboxNetworkAccess", input: { host: "registry.npmjs.org" }, request: { description: "Allow network connection to registry.npmjs.org?" } }
    ],
    reply: (a) => ({ decision: a.tool === "Bash" && a.summary === "npm run lint" ? "allow_session" : "allow_once" })
  });
  assert.equal(result.outcome, "completed", JSON.stringify(result.transport?.diagnostics ?? result));
  assert.deepEqual(prompts.map((p) => p.alwaysAsk === true), [true, true, true, false, false]);
  const session = decisions.find((d) => d.reply?.updatedPermissions)?.reply.updatedPermissions;
  assert.deepEqual(session.map((s) => s.destination), ["session", "session"], "nothing is written to the project's settings");
  assert.equal(session[0].rules[0].ruleContent, "npm run lint:*", "the CLI's own rule, unchanged but for its place");
  assert.equal(prompts[4].summary, "registry.npmjs.org");
});

test("RT-4, RT-5, RT-10.1: Codex — a file change shows its paths; without them it is always asked; plan and secret questions", OPTS, async () => {
  const { result, prompts, decisions, activity } = await turn("codex", {
    asks: [
      { tool: "fileChange", paths: ["/p/src/a.ts", "/p/README.md"], reason: "edit" },
      { tool: "fileChange", paths: [] },
      { tool: "plan", plan: "1. read\n2. fix" },
      { tool: "question", question: "API token?", secret: true }
    ],
    reply: (a) => (a.kind === "question" ? { decision: "allow_once", answers: { q1: ["t"] } } : { decision: "allow_once" })
  });
  assert.equal(result.outcome, "completed", JSON.stringify(result.transport?.diagnostics ?? result));
  const [withPaths, without, question] = prompts;
  assert.match(withPaths.summary, /\/p\/src\/a\.ts, \/p\/README\.md/);
  assert.deepEqual(withPaths.input.paths, ["/p/src/a.ts", "/p/README.md"]);
  assert.equal(withPaths.alwaysAsk, undefined);
  assert.equal(without.alwaysAsk, true, "nobody could tell what a saved decision would cover");
  assert.equal(question.questions[0].secret, true);
  assert.deepEqual(decisions.filter((d) => d.tool === "fileChange").map((d) => d.reply.decision), ["accept", "accept"]);
  assert.ok(activity.some((e) => e.kind === "message" && e.detail?.plan === true && e.text.includes("2. fix")), "the plan item is in the feed");
  // the fingerprint of a file change now depends on its paths
  assert.notEqual(grantFingerprint("codex", "file_change", "file change", withPaths.input), grantFingerprint("codex", "file_change", "file change", { ...withPaths.input, paths: ["/p/other"] }));
});

test("RT-8: a rights mode the CLI did not apply is said in the feed; an applied one is not", OPTS, async () => {
  const codex = await turn("codex", { access: { claude: "terminal", codex: "workspace" }, env: { MOCK_ALLOW_ACCESS: "1", MOCK_REPORT_APPROVAL: "never" } });
  const warn = codex.activity.filter((e) => e.detail?.accessMismatch);
  assert.deepEqual(warn.map((e) => [e.detail.field, e.detail.asked, e.detail.reported]), [["approvalPolicy", "on-request", "never"]]);
  const claude = await turn("claude", { access: { claude: "auto", codex: "terminal" }, env: { MOCK_ALLOW_ACCESS: "1", MOCK_REPORT_MODE: "default" } });
  assert.deepEqual(claude.activity.filter((e) => e.detail?.accessMismatch).map((e) => [e.detail.asked, e.detail.reported]), [["auto", "default"]]);
  const ok = await turn("claude", { access: { claude: "acceptEdits", codex: "terminal" }, env: { MOCK_ALLOW_ACCESS: "1" } });
  assert.equal(ok.activity.filter((e) => e.detail?.accessMismatch).length, 0);
  const terminal = await turn("codex", { env: { MOCK_REPORT_APPROVAL: "never" } });
  assert.equal(terminal.activity.filter((e) => e.detail?.accessMismatch).length, 0, "the terminal mode asks for nothing");
});

test("RT-10.3: a user's variable with a supervisor name is left out and said, the turn still runs", OPTS, async () => {
  assert.deepEqual(sessionEnv({ A: "1", SUP_X: "2", ELECTRON_RUN_AS_NODE: "1" }), { env: { A: "1" }, dropped: ["SUP_X", "ELECTRON_RUN_AS_NODE"] });
  const { result, activity } = await turn("claude", { env: { SUP_USER_VAR: "x" } });
  assert.equal(result.outcome, "completed");
  assert.ok(activity.some((e) => e.kind === "stderr" && e.text.includes("SUP_USER_VAR")));
});

test("RT-6: the probe says found and enabled apart, load errors, and reads every page of MCP servers", OPTS, async () => {
  const fake = path.join(TMP, "probe-codex.mjs");
  fs.writeFileSync(fake, `
import readline from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l); if (m.id === undefined) return;
  const page2 = m.params?.cursor === "p2";
  const R = {
    initialize: {}, "config/read": { config: { model: "gpt", approval_policy: null, sandbox_mode: null } },
    "skills/list": { data: [{ cwd: "/p", skills: [{ name: "on", enabled: true }, { name: "off", enabled: false }], errors: [{ message: "broken" }] }] },
    "plugin/installed": { marketplaces: [{ plugins: [{ name: "p1", installed: true, enabled: true }, { name: "p2", installed: true, enabled: false }, { name: "p3", installed: false }] }], marketplaceLoadErrors: [] },
    "mcpServerStatus/list": page2 ? { data: [{ name: "b", runtimeStatus: "failed" }], nextCursor: null } : { data: [{ name: "a", runtimeStatus: "connected" }], nextCursor: "p2" },
    "hooks/list": { data: [{ hooks: [{ eventName: "PreToolUse", enabled: true, trustStatus: "trusted" }, { eventName: "Stop", enabled: true, trustStatus: "untrusted" }], errors: [] }] }
  }[m.method];
  out(R ? { id: m.id, result: R } : { id: m.id, error: { code: -32601, message: "method not found" } });
});`);
  const exe = path.join(TMP, "probe-codex");
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${NODE}" "${fake}" "$@"\n`, { mode: 0o755 });
  const r = await probeCodex({ executable: exe, cwd: TMP, env: { PATH: process.env.PATH }, timeoutMs: 5000 });
  const item = (id) => r.items.find((x) => x.id === id);
  assert.equal(item("approval").value, "(default)");
  assert.deepEqual([item("skills").value, item("skills").note], ["found 2, enabled 1: on", "1 could not be loaded"]);
  assert.equal(item("plugins").value, "found 2, enabled 1: p1");
  assert.equal(item("hooks").value, "found 2, enabled 1: PreToolUse");
  assert.deepEqual([item("mcp").value, item("mcp").note], ["a (connected), b (failed)", undefined]);
  assert.deepEqual([item("account").confirmed, item("account").note], [false, "method not found"], "an unknown method is never a confirmation");
});

test("profile: QA needs the commit action, like push", async () => {
  const base = await suggestProfile(TMP);
  const qa = { environment: "qa", command: "deploy", verify: "check" };
  assert.throws(() => validateProfile({ ...base, finish: { commit: false, push: null, qa } }), /QA needs the commit action/);
  assert.equal(validateProfile({ ...base, finish: { commit: true, push: null, qa } }).finish.qa.command, "deploy");
});
