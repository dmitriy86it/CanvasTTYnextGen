// The model of each role (journal v2): a project setting, over it the goal's own choice; "as in the CLI" passes nothing.
// The model goes to one Codex thread (thread/start|resume `model`) or one Claude run (--model); config.toml and Claude's
// settings stay byte for byte. Before the first model call a Codex role's model that model/list does not offer is a
// blocker. Fake CLIs (MOCK_SCRIPT, MOCK_CODEX_MODELS, MOCK_CODEX_CONFIG_MODEL) and local repositories only.
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
import { createProfileStore, suggestProfile, validateProfile } from "../src/main/services/orchestration/profile.ts";
import { buildNativeTurn } from "../src/main/services/orchestration/providers.ts";
import { modelItem } from "../src/main/services/orchestration/readiness.ts";
import { codexAppServerDriver } from "../src/main/services/orchestration/sessions.ts";
import { readRun, readText } from "../src/main/services/orchestration/store.ts";
import { parseCreate } from "../src/main/ipc/orchestrationIpc.ts";
import { roleModel } from "../src/renderer/src/features/orchestration/runModel.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-models-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}
let n = 0;
function project(files) {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  for (const [f, text] of Object.entries({ ".gitignore": "node_modules/\n", ...files })) fs.writeFileSync(path.join(dir, f), text);
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  return dir;
}
function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });

// state: the fake CLIs' record (codex-thread.jsonl: each thread/start|resume and its model; claude-argv.jsonl; the
// turns of each session; codex-probe.jsonl: the lists asked without a thread)
function providersFile(env, state) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: state, ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP }
  }));
  return file;
}
function script(answers) {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  answers.forEach((a, i) => {
    fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(a.answer));
    if (a.writes) fs.writeFileSync(path.join(dir, `${i + 1}.writes.json`), JSON.stringify(a.writes));
  });
  return dir;
}
const C1 = { keep: null, text: "a.txt says 2", covers: ["R1"], evidence: { kind: "change", check: null } };
const PLAN = { answer: { stages: [{ title: "fix", task: "make a.txt say 2", conditions: [C1] }], dropped: [], dropRequirements: [], question: null } };
const REVIEW = { answer: { conditions: [{ id: "C1", status: "met", paths: ["a.txt"], note: "a.txt says 2" }], findings: [], request: "none", question: null } };
const FINAL = { answer: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "a.txt says 2" }] } };
const EXEC = { answer: { summary: "done", done: true }, writes: [{ rel: "a.txt", base64: Buffer.from("2\n").toString("base64") }] };

function manager(env = {}, { v2 = true, root = path.join(TMP, `root-${++n}`), state = fs.mkdtempSync(path.join(TMP, "state-")) } = {}) {
  const m = createRunManager({
    platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providersFile(env, state), () => LAUNCH),
    ...(v2 ? { journalV2: true } : {})
  });
  Object.assign(m, { root, state });
  return m;
}
const view = async (m, runId) => (await m.get(runId)).value.view;
const settled = (m, runId) => until(async () => {
  const v = await view(m, runId);
  return ["completed", "paused", "failed", "stopped"].includes(v.status) && !v.permission ? v : null;
}, "the end");
const lines = (m, file) => {
  const f = path.join(m.state, file);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const turns = (m) => fs.readdirSync(m.state).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f))
  .reduce((k, f) => k + JSON.parse(fs.readFileSync(path.join(m.state, f), "utf8")).turns.length, 0);
async function saveProfile(m, src, profile = {}) {
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), checks: ["grep -qx 2 a.txt"], ...profile });
}
async function create(m, src, goal = {}) {
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["a.txt says 2"], checks: [], mode: "autopilot", commands: ["grep -qx 2 a.txt"], ...goal } });
  return { runId, r };
}
async function linkOf(m, src) {
  const at = (x) => ({ position: { x, y: 0 }, size: { width: 300, height: 200 } });
  const [lead, exec, linkId] = [randomUUID(), randomUUID(), randomUUID()];
  assert.ok((await m.createAgent({ agentId: lead, provider: "codex", project: src, bounds: at(0) })).ok);
  assert.ok((await m.createAgent({ agentId: exec, provider: "claude", project: src, bounds: at(400) })).ok);
  assert.ok((await m.createLink({ linkId, fromAgentId: lead, toAgentId: exec })).ok);
  return linkId;
}
async function goalOf(m, runId) {
  const read = await readRun(m.root, runId);
  return JSON.parse((await readText(m.root, runId, read.state.goal)).toString("utf8"));
}
// the person's own configuration: Codex's config.toml (the project already trusted, as a real Codex would otherwise
// write that entry for a work-folder thread) and Claude's settings — compared byte for byte after the run
function personalConfig(src) {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome);
  fs.mkdirSync(path.join(home, ".claude"));
  const files = {
    [path.join(codexHome, "config.toml")]: `model = "gpt-mock"\nmodel_reasoning_effort = "medium"\n\n[projects.${JSON.stringify(src)}]\ntrust_level = "trusted"\n`,
    [path.join(home, ".claude", "settings.json")]: `${JSON.stringify({ model: "opus", permissions: { allow: [] } }, null, 2)}\n`
  };
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(f, text);
  return { env: { HOME: home, CODEX_HOME: codexHome }, files };
}

test("a role's model goes to its own thread or run only: lead and reviewer to Codex threads, the executor to claude --model; the goal records them; config.toml and Claude's settings stay byte for byte", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const own = personalConfig(src);
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), ...own.env });
  // the project's setting, and the goal's own choice over it for the reviewer
  await saveProfile(m, src, { models: { lead: "gpt-mock-mini", executor: "sonnet", reviewer: null } });
  const { runId, r } = await create(m, src, { models: { reviewer: "gpt-mock" } });
  assert.ok(r.ok, JSON.stringify(r));
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v));
  // the plan's thread (the lead), then two new reviewer threads (review, final review): each with its role's model
  assert.deepEqual(lines(m, "codex-thread.jsonl"), [
    { method: "thread/start", model: "gpt-mock-mini" }, { method: "thread/start", model: "gpt-mock" }, { method: "thread/start", model: "gpt-mock" }]);
  const argv = lines(m, "claude-argv.jsonl");
  assert.equal(argv.length, 1);
  assert.deepEqual(argv[0].slice(argv[0].indexOf("--model"), argv[0].indexOf("--model") + 2), ["--model", "sonnet"]);
  // in the goal of run.created (journal v2) and in the run's facts
  assert.deepEqual((await goalOf(m, runId)).models, { lead: "gpt-mock-mini", executor: "sonnet", reviewer: "gpt-mock" });
  assert.deepEqual(v.progress.models, { lead: "gpt-mock-mini", executor: "sonnet", reviewer: "gpt-mock" });
  // the panel: what each CLI reported at its start
  const entries = (await m.activity(runId, 0, 500)).value.entries;
  assert.deepEqual(["lead", "executor", "reviewer"].map((role) => roleModel(role, entries, v.progress.models)),
    [{ model: "gpt-mock-mini", reported: true }, { model: "sonnet", reported: true }, { model: "gpt-mock", reported: true }]);
  for (const [f, text] of Object.entries(own.files)) assert.equal(fs.readFileSync(f, "utf8"), text, `${f} unchanged`);
  await m.shutdown();
});

test("«As in the CLI»: no model is passed to either CLI, the goal has none, the panel says what the CLI reported", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]) });
  await saveProfile(m, src, { models: { lead: null, executor: null, reviewer: null } });
  const { runId, r } = await create(m, src, { models: { lead: null, executor: null, reviewer: null } });
  assert.ok(r.ok, JSON.stringify(r));
  const v = await settled(m, runId);
  assert.equal(v.status, "completed");
  assert.deepEqual(lines(m, "codex-thread.jsonl").map((x) => x.model), [null, null, null]);
  assert.equal(lines(m, "claude-argv.jsonl")[0].includes("--model"), false);
  assert.equal("models" in await goalOf(m, runId), false);
  assert.equal(v.progress.models, undefined);
  const entries = (await m.activity(runId, 0, 500)).value.entries;
  assert.deepEqual(roleModel("lead", entries, v.progress.models), { model: "mock", reported: true });
  assert.deepEqual(roleModel("executor", [], v.progress.models), { model: null, reported: false }, "nothing reported, nothing chosen: as in the CLI");
  assert.deepEqual(roleModel("executor", [], { lead: null, executor: "opus", reviewer: null }), { model: "opus", reported: false }, "chosen, not yet reported");
  await m.shutdown();
});

test("a Codex model this account is not offered: a readiness blocker and a refused start, before any thread or model turn", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  // the configuration names gpt-mock; model/list offers gpt-other only
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CODEX_MODELS: "gpt-other" });
  await saveProfile(m, src);
  const linkId = await linkOf(m, src);
  const ready = await m.readiness({ linkId, commands: ["grep -qx 2 a.txt"], workMode: "project" });
  assert.equal(ready.value.ready, false);
  const item = ready.value.items.find((i) => i.id === "model");
  assert.deepEqual([item.level, item.facts.code, item.facts.model, item.facts.source, item.facts.roles], ["blocker", "model_unavailable", "gpt-mock", "config", "lead, reviewer"]);
  assert.equal(ready.value.items.at(-1).id, "permissions", "the model item comes before the last one");
  const { r } = await create(m, src);
  assert.equal(r.ok ? "ok" : r.code, "model_unavailable");
  assert.match(r.message, /Codex: model gpt-mock is not available to your account\. Choose another model in the project settings/);
  // the counters of the fake CLIs: model/list was asked, no thread was started and no model turn was made
  assert.ok(lines(m, "codex-probe.jsonl").includes("model/list"));
  assert.deepEqual([lines(m, "codex-thread.jsonl").length, lines(m, "claude-argv.jsonl").length, turns(m)], [0, 0, 0]);
  // a chosen model: the same check, the goal's choice over the project's
  const chosen = await m.readiness({ linkId, commands: ["grep -qx 2 a.txt"], workMode: "project", models: { lead: "gpt-other", reviewer: "gpt-nope" } });
  const c = chosen.value.items.find((i) => i.id === "model");
  assert.deepEqual([c.level, c.facts.model, c.facts.source, c.facts.roles], ["blocker", "gpt-nope", "chosen", "reviewer"]);
  const fine = await m.readiness({ linkId, commands: ["grep -qx 2 a.txt"], workMode: "project", models: { lead: "gpt-other", reviewer: "gpt-other" } });
  assert.equal(fine.value.items.find((i) => i.id === "model").level, "ok");
  await m.shutdown();
});

test("the models Codex offers: every model of model/list (hidden ones count as available, not shown), kept for the session; «Обновить» asks again", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager();
  const linkId = await linkOf(m, src);
  const first = await m.codexModels(linkId);
  assert.deepEqual([first.value.ok, first.value.ids, first.value.shown, first.value.configModel],
    [true, ["gpt-mock", "gpt-mock-mini", "gpt-mock-hidden"], ["gpt-mock", "gpt-mock-mini"], "gpt-mock"]);
  const asked = () => lines(m, "codex-probe.jsonl").filter((x) => x === "model/list").length;
  await m.codexModels(linkId);
  assert.equal(asked(), 1, "kept: not asked again");
  await m.codexModels(linkId, true);
  assert.equal(asked(), 2, "refreshed");
  assert.equal(lines(m, "codex-thread.jsonl").length, 0, "no thread");
  assert.equal(modelItem(first.value, { lead: "gpt-mock-hidden", executor: "anything", reviewer: null }, ["lead", "reviewer"]).level, "ok");
  assert.equal(modelItem({ ...first.value, ok: false, error: "x" }, { lead: "gpt-nope", executor: null, reviewer: null }, ["lead"]).level, "warning", "an unread list blocks nothing");
  await m.shutdown();
});

test("journal v1 has no place for a model: a goal with one is refused there; a run without one is created and runs as before", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({}, { v2: false });
  await saveProfile(m, src, { models: { lead: "gpt-mock-mini", executor: null, reviewer: null } });
  const { r } = await create(m, src);
  assert.equal(r.ok ? "ok" : r.code, "invalid_goal");
  assert.match(r.message, /journal v2/);
  assert.equal(lines(m, "codex-thread.jsonl").length, 0);
  await m.shutdown();
});

test("a run created without a model continues as before after a restart: its threads get no model", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const env = { MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]) };
  const m = manager(env, { state });
  await saveProfile(m, src);
  const { runId, r } = await create(m, src, { reviewPlan: true });
  assert.ok(r.ok, JSON.stringify(r));
  const paused = await settled(m, runId);
  assert.equal(paused.reason, "plan_review");
  await m.shutdown();
  const again = manager(env, { state, root: m.root });
  const v = await view(again, runId);
  const sent = await again.command(runId, { commandId: randomUUID(), expectedRevision: v.revision, command: { kind: "resume" } });
  assert.ok(sent.ok, JSON.stringify(sent));
  const done = await settled(again, runId);
  assert.equal(done.status, "completed");
  assert.deepEqual(lines(again, "codex-thread.jsonl").map((x) => x.model), [null, null, null]);
  assert.equal(lines(again, "claude-argv.jsonl").some((a) => a.includes("--model")), false);
  await again.shutdown();
});

test("the turn itself: Codex thread/start and thread/resume carry the model, Claude gets --model; without one neither is passed; a name that could be a flag is refused", () => {
  const sent = [];
  for (const threadId of [null, "thread-1"]) {
    const d = codexAppServerDriver({ cwd: "/w", task: "t", schema: {}, threadId, clientVersion: "x", ask: async () => ({ decision: "deny" }), model: "gpt-6-sol" });
    const io = { send: (m) => sent.push(m), end() {}, hold() {} };
    d.start(io);
    d.frame({ kind: "event", type: "rpc.response", value: { id: 1, result: {} }, bytes: 0 });
  }
  assert.deepEqual(sent.filter((m) => m.method?.startsWith("thread/")).map((m) => [m.method, m.params.model]), [["thread/start", "gpt-6-sol"], ["thread/resume", "gpt-6-sol"]]);
  const none = [];
  const d = codexAppServerDriver({ cwd: "/w", task: "t", schema: {}, threadId: null, clientVersion: "x", ask: async () => ({ decision: "deny" }) });
  d.start({ send: (m) => none.push(m), end() {}, hold() {} });
  d.frame({ kind: "event", type: "rpc.response", value: { id: 1, result: {} }, bytes: 0 });
  assert.equal("model" in none.find((m) => m.method === "thread/start").params, false);

  const cli = { state: "available", provider: "claude", executable: "/bin/claude", launcher: "native", environment: { PATH: "/bin" }, checked: [] };
  const base = { cli, cliVersion: "2.1.281 (Claude Code)", cwd: "/w", env: {}, task: "t", schema: { type: "object" }, session: { kind: "new" }, ask: async () => ({ decision: "deny" }), clientVersion: "x" };
  const argv = (input) => buildNativeTurn(input).spec.argv;
  const withModel = argv({ ...base, model: "sonnet" });
  assert.deepEqual(withModel.slice(withModel.indexOf("--model"), withModel.indexOf("--model") + 2), ["--model", "sonnet"]);
  assert.equal(argv(base).includes("--model"), false);
  const bad = buildNativeTurn({ ...base, model: "--dangerously-skip-permissions" });
  assert.deepEqual([bad.ok, bad.reason], [false, "invalid_input"]);
});

test("the profile and the goal over IPC: models are names or null; anything else is refused", () => {
  const p = { ...{ v: 1, workMode: "project", checks: [], prepare: { steps: [], auto: true }, env: { direnv: true }, finish: { commit: false, push: null, qa: null }, grants: [] } };
  assert.deepEqual(validateProfile({ ...p, models: { lead: "gpt-6-sol", executor: null, reviewer: null } }).models, { lead: "gpt-6-sol", executor: null, reviewer: null });
  assert.equal("models" in validateProfile({ ...p, models: { lead: null, executor: null, reviewer: null } }), false, "all as in the CLI: not kept");
  assert.throws(() => validateProfile({ ...p, models: { lead: "-x" } }), /models\.lead/);
  assert.throws(() => validateProfile({ ...p, models: { tester: "a" } }), /models/);
  const goal = { text: "x", criteria: ["c"], checks: [], commands: ["true"], mode: "autopilot" };
  const req = (models) => ({ requestId: randomUUID(), source: "/p", goal: { ...goal, models } });
  assert.deepEqual(parseCreate(req({ lead: "gpt-6-sol", executor: null })).goal.models, { lead: "gpt-6-sol", executor: null });
  assert.throws(() => parseCreate(req({ lead: "--x" })), /goal\.models\.lead/);
  assert.throws(() => parseCreate(req({ other: "a" })), /goal\.models/);
});
