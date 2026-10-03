// A provider's usage limit is not an environment error (ROADMAP R13 open defect; real series S3 attempt 2,
// evidence/real-stage-13/series-S3-S5-S6-attempt2): the run pauses as before (journal v1: paused(environment_error)),
// but the next step names the provider and its reset time and offers waiting, not fixing dependencies. The run's own
// budget (paused(limit_reached)) keeps its hint: raise the limit and resume.
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
import { causeText, headlineKey, nextStepText, providerLimit, viewCause } from "../src/renderer/src/features/orchestration/runModel.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-provider-limit-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = await fn(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}
let n = 0;
function project() {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "project\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync(GIT, a, { cwd: dir, env: GIT_ENV });
  return dir;
}
function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
function manager(env) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: fs.realpathSync("/bin/sh"), checkEnv: { PATH: "/usr/bin:/bin", HOME: TMP }
  }));
  return createRunManager({
    platform: "darwin", root: path.join(TMP, `root-${++n}`), gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used by a native goal"); },
    native: testNativeRuntime(file, () => LAUNCH)
  });
}
async function pausedRun(m, goal) {
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: project(), goal: { text: "x", criteria: ["y"], checks: [], commands: ["true"], workMode: "project", ...goal } })).ok);
  const view = await until(async () => { const v = (await m.get(runId)).value.view; return v.status === "paused" ? v : null; }, "paused");
  const entries = (await m.activity(runId, 0, 500)).value.entries;
  return { view, entries };
}

test("Codex usage limit: paused as before, the next step names Codex and its reset, no dependency hint", OPTS, async () => {
  const m = manager({ MOCK_MODE: "usage_limit" });
  const { view, entries } = await pausedRun(m, {});
  assert.equal(view.reason, "environment_error", "the journal is unchanged (v1)");
  assert.deepEqual(providerLimit(view, entries), { provider: "codex", resetsAt: "Sep 28th, 2026 11:51 PM" });
  const en = nextStepText("en", view, entries);
  const ru = nextStepText("ru", view, entries);
  assert.match(en, /Codex/);
  assert.match(en, /Sep 28th, 2026 11:51 PM/);
  assert.match(ru, /Codex/);
  assert.match(ru, /Sep 28th, 2026 11:51 PM/);
  for (const s of [en, ru]) assert.doesNotMatch(s, /dependenc|зависимост|raise the limit|поднимите лимит/i, s);
  await m.shutdown();
});

test("a plain CLI failure is still an environment error with its hint", OPTS, async () => {
  const m = manager({ MOCK_MODE: "fail" });
  const { view, entries } = await pausedRun(m, {});
  assert.equal(view.reason, "environment_error");
  assert.equal(providerLimit(view, entries), null);
  assert.match(nextStepText("en", view, entries), /fix the environment/);
  await m.shutdown();
});

test("the run's own turn budget: paused(limit_reached), the hint is to raise the limit and resume", OPTS, async () => {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "1.json"), JSON.stringify({ stages: [{ title: "note", task: "add note.txt" }], question: null }));
  const m = manager({ MOCK_SCRIPT: dir });
  const { view, entries } = await pausedRun(m, { limits: { turns: 1 } });
  assert.equal(view.reason, "limit_reached");
  assert.equal(providerLimit(view, entries), null);
  assert.match(nextStepText("en", view, entries), /raise the limit below and resume/);
  assert.match(nextStepText("ru", view, entries), /поднимите лимит ниже и продолжите/);
  await m.shutdown();
});

// The recorded Codex refusal of its configured model (codex-cli 0.155.1, evidence/real-a-gate R1): the journal says
// paused(environment_error); the cause is read from the turn's activity, the journal is not changed.
test("Codex model not supported by the account: the pause names the model and where to change it, not the environment", () => {
  const entries = fs.readFileSync(path.join(HERE, "fixtures", "orchestration", "codex-model-unsupported.activity.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const view = { status: "paused", reason: "environment_error", progress: null };
  assert.deepEqual(viewCause(view, entries), { kind: "model_unsupported", reason: "environment_error", provider: "codex", model: "gpt-6.1-sol" });
  assert.equal(headlineKey(view, entries), "model_unsupported");
  assert.equal(causeText("ru", viewCause(view, entries)), "Codex: модель gpt-6.1-sol не поддерживается вашим аккаунтом");
  assert.equal(nextStepText("ru", view, entries), "Codex: модель gpt-6.1-sol не поддерживается вашим аккаунтом. Модель задана в ~/.codex/config.toml — смените её (codex → /model) и нажмите «Продолжить».");
  assert.match(nextStepText("en", view, entries), /^Codex: the model gpt-6\.1-sol is not supported by your account\. The model is set in ~\/\.codex\/config\.toml/);
  assert.equal(providerLimit(view, entries), null, "not a usage limit");
  // without the message the same pause stays an environment error
  const plain = entries.filter((e) => e.kind !== "error");
  assert.equal(viewCause(view, plain).kind, "ending");
});
