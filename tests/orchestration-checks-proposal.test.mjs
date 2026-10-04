// Journal v2, A1 (docs/agent-orchestration/implementation/journal-v2-format.md §2.1–§2.5, §7): optional check commands
// behind the development flag — the lead proposes them, the person accepts or edits them (the autopilot too while the
// checks' network is open), a run without checks completes as such and pushes or deploys only after the person's
// confirmation. Fake CLIs (MOCK_SCRIPT, MOCK_CHECKS) and local bare repositories only.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { autoAccepts, nextAction } from "../src/main/services/orchestration/cycle.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { NO_SANDBOX_SHA256, buildRecord, parseJournal } from "../src/main/services/orchestration/journal.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { buildCheckProfile, buildProfile, checkSelftest } from "../src/main/services/orchestration/sandbox.ts";
import { openRun, readRun } from "../src/main/services/orchestration/store.ts";
import { parseCommand } from "../src/main/ipc/orchestrationIpc.ts";
import { agentState, availableActions, historyLines, runHeadline, runStatusKey } from "../src/renderer/src/features/orchestration/runModel.ts";
import { outcomeKey, roleStatus, runStatus, stateLabel } from "../src/renderer/src/features/orchestration/runStatus.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-v2c-")));
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
// the login shell as the checks call it (-ilc <line>; in the check profile -c <line>), without the machine's profile files
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });

function providersFile(env, checkEnv = {}) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP, ...checkEnv }
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
// journal v2 answers (A2, journal-v2-format.md §2.7): the plan's one condition C1 (a change) covers R1, the goal's one
// criterion; the review marks it met on a.txt, which the executor changes; the final review marks R1 met. A3: the
// reviewer answers them (no verdict: request none, no findings)
const C1 = { keep: null, text: "a.txt says 2", covers: ["R1"], evidence: { kind: "change", check: null } };
const PLAN = { answer: { stages: [{ title: "fix", task: "make a.txt say 2", conditions: [C1] }], dropped: [], dropRequirements: [], question: null } };
const REVIEW = { answer: { conditions: [{ id: "C1", status: "met", paths: ["a.txt"], note: "a.txt says 2" }], findings: [], request: "none", question: null } };
const FINAL = { answer: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "a.txt says 2" }] } };
// v1 answers (no conditions: the v1 schemas forbid the keys)
const PLAN_V1 = { answer: { stages: [{ title: "fix", task: "make a.txt say 2" }], question: null } };
const REVIEW_V1 = { answer: { verdict: "accept", findings: [], question: null } };
const FINAL_V1 = { answer: { verdict: "complete", findings: [], question: null } };
const EXEC = { answer: { summary: "done", done: true }, writes: [{ rel: "a.txt", base64: Buffer.from("2\n").toString("base64") }] };

// leadSandbox false: as without Seatbelt (A1) — the lead's commands would run in the user's shell, the person decides
function manager(env, { v2 = true, leadSandbox, checkEnv, root = path.join(TMP, `root-${++n}`) } = {}) {
  const m = createRunManager({
    platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providersFile(env, checkEnv), () => LAUNCH),
    ...(v2 ? { journalV2: true } : {}), ...(leadSandbox !== undefined ? { leadSandbox } : {})
  });
  m.root = root;
  return m;
}
const view = async (m, runId) => (await m.get(runId)).value.view;
const settled = (m, runId, what = "the end") => until(async () => {
  const v = await view(m, runId);
  return ["completed", "paused", "failed", "stopped"].includes(v.status) && !v.permission ? v : null;
}, what);
const records = async (m, runId) => (await m.history(runId, 0, 500)).value.records;
const send = async (m, v, command) => {
  const r = await m.command(v.runId, { commandId: randomUUID(), expectedRevision: v.revision, command });
  return r.ok ? r.value : { status: "error", code: r.code };
};
const journalOf = (m, runId) => fs.readFileSync(path.join(m.root, "runs", runId, "journal.jsonl"));
async function start(m, src, goal, profile = {}) {
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), checks: ["false"], ...profile });
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["a.txt says 2"], checks: [], mode: "autopilot", ...goal } });
  assert.ok(r.ok, JSON.stringify(r));
  return runId;
}
const shown = (v) => ({
  key: runStatusKey(v), lead: agentState("lead", v), executor: agentState("executor", v),
  row: runStatus("ru", { view: v, entries: [], open: false, stageTitles: null, now: Date.now() }).state,
  card: roleStatus("en", "lead", { view: v, entries: [], open: false, stageTitles: null, now: Date.now() }).state,
  outcome: outcomeKey(v, "complete")
});

// ---------------- the lead proposes; without the check profile the autopilot waits ----------------

test("empty commands, autopilot, the lead proposes; no check profile (no Seatbelt): the network is open, so it waits for «Принять»; then the checks run and confirm", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt" }, { leadSandbox: false });
  const runId = await start(m, src, { commands: [] });
  const v = await settled(m, runId, "the proposal");
  assert.deepEqual([v.status, v.reason], ["paused", "awaiting_checks_decision"]);
  assert.deepEqual(v.proposal.checks.map((c) => [c.id, c.command, c.why]), [["cmd-1", "grep -qx 2 a.txt", "runs the project's tests"]]);
  assert.deepEqual(availableActions(v), ["checks_decide", "stop"]);
  const h = await records(m, runId);
  assert.equal(JSON.parse(journalOf(m, runId).toString().split("\n")[0]).v, 2);
  const proposed = h.find((r) => r.type === "checks.proposed");
  assert.deepEqual([proposed.data.count, proposed.data.sandboxNetwork], [1, "open"]);
  assert.equal(h.some((r) => r.type === "plan.recorded" || r.type === "check.started"), false, "nothing runs before the decision");
  // only the decision and Stop on this pause
  for (const command of [{ kind: "resume" }, { kind: "step" }, { kind: "clarify", text: "x" }]) {
    assert.deepEqual(await send(m, await view(m, runId), command), { status: "rejected", code: "invalid_state" }, command.kind);
  }
  assert.equal((await send(m, await view(m, runId), { kind: "checks.decide", decision: "accept" })).status, "accepted");
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.deepEqual([done.progress.completion, done.progress.checksFrom], ["confirmed", "proposal"]);
  assert.deepEqual(done.progress.checks.map((c) => [c.id, c.title, c.status]), [["cmd-1", "grep -qx 2 a.txt", "passed"]]);
  const all = await records(m, runId);
  const decided = all.find((r) => r.type === "checks.decided");
  assert.deepEqual([decided.data.decision, decided.data.by, decided.data.count], ["accept", "person", 1]);
  assert.equal(all.filter((r) => r.type === "plan.recorded").length, 1, "the proposal turn's plan, recorded after the acceptance");
  assert.deepEqual(all.at(-1).data.completion.kind, "confirmed");
  assert.deepEqual(shown(done), { key: "completed", lead: "completed", executor: "completed", row: "completed", card: "completed", outcome: "completed" });
  // a second decision: there is nothing to decide
  assert.equal((await send(m, done, { kind: "checks.decide", decision: "accept" })).code, "invalid_state");
  await m.shutdown();
});

test("step by step: «Изменить» drops the proposal turn's plan, a new plan turn follows with the person's commands; replans are not spent", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt" });
  const runId = await start(m, src, { commands: [], mode: "steps" });
  let v = await settled(m, runId, "the proposal");
  assert.equal(v.reason, "awaiting_checks_decision");
  assert.equal((await send(m, v, { kind: "checks.decide", decision: "edit", checks: ["grep -qx 2 a.txt", "test -f a.txt", "test -f a.txt"] })).code, "invalid_command", "repeated lines");
  assert.equal((await send(m, await view(m, runId), { kind: "checks.decide", decision: "edit", checks: ["grep -qx 2 a.txt", "test -f a.txt"] })).status, "accepted");
  v = await settled(m, runId, "the plan review");
  assert.deepEqual([v.status, v.reason], ["paused", "plan_review"]);
  for (;;) {
    if (v.status !== "paused") break;
    assert.equal((await send(m, v, { kind: "resume" })).status, "accepted", JSON.stringify(v));
    v = await settled(m, runId);
  }
  assert.equal(v.status, "completed", JSON.stringify(v));
  assert.deepEqual([v.progress.completion, v.progress.checksFrom], ["confirmed", "edited"]);
  assert.deepEqual(v.progress.checks.map((c) => [c.title, c.status]), [["grep -qx 2 a.txt", "passed"], ["test -f a.txt", "passed"]]);
  const all = await records(m, runId);
  const decided = all.find((r) => r.type === "checks.decided");
  assert.deepEqual([decided.data.decision, decided.data.by, decided.data.count], ["edit", "person", 2]);
  const plans = all.filter((r) => r.type === "plan.recorded");
  const proposalTurn = all.find((r) => r.type === "checks.proposed").data.turnId;
  assert.deepEqual(plans.map((p) => [p.data.version, p.data.turnId === proposalTurn]), [[1, false]], "one plan, of the second plan turn");
  assert.equal(all.filter((r) => r.type === "checks.proposed").length, 1, "proposed once");
  await m.shutdown();
});

// ---------------- the lead proposes none: completed without checks ----------------

test("the lead proposes none: completed without checks — never «Completed»; the commit is made, push and QA wait for the person and run as decided", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const remote = path.join(TMP, `remote-${++n}.git`);
  g(TMP, "init", "-q", "--bare", remote);
  g(src, "remote", "add", "qa", remote);
  const qaLog = path.join(TMP, `qa-${++n}.log`);
  // no check profile: the network rule alone would make the autopilot wait — Q1 is what lets it go on
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "none" }, { leadSandbox: false });
  const runId = await start(m, src, { commands: [], finish: { commit: true, push: true, qa: true } }, {
    workMode: "worktree", finish: { commit: true, push: { remote: "qa", branch: "qa-branch", remoteUrl: remote }, qa: { environment: "qa", command: `echo run >> ${qaLog}`, verify: "true" } }
  });
  // A1.1 Q1: none proposed — the autopilot goes on by itself, the network rule does not apply (no pause)
  let v = await settled(m, runId, "the push/QA confirmation");
  const early = await records(m, runId);
  assert.equal(early.some((r) => r.type === "run.status" && r.data.reason === "awaiting_checks_decision"), false, "no pause for the decision");
  const auto = early.find((r) => r.type === "checks.decided").data;
  assert.deepEqual([auto.by, auto.commandId, auto.count, early.find((r) => r.type === "checks.proposed").data.count], ["autopilot", null, 0, 0]);
  assert.deepEqual([v.status, v.reason], ["paused", "awaiting_finish_confirmation"]);
  assert.deepEqual(v.progress.finish.map((f) => [f.step, f.status]), [["commit", "done"], ["push", "not_started"], ["qa", "not_started"]]);
  assert.throws(() => g(remote, "rev-parse", "--verify", "-q", "refs/heads/qa-branch"), "nothing pushed without the person");
  assert.equal(fs.existsSync(qaLog), false, "no QA without the person");
  assert.deepEqual(availableActions(v), ["finish_confirm", "stop"]);
  assert.deepEqual([v.confirm.push, v.confirm.qa, v.confirm.commit], [true, true, v.progress.finish[0].commit]);
  assert.match(v.confirm.tree, /^[0-9a-f]{40}$/);
  assert.equal((await send(m, v, { kind: "resume" })).code, "invalid_state");
  // a step left undecided: refused; another tree than the one here: the view shows the current one to decide again
  assert.equal((await send(m, v, { kind: "finish.confirm", tree: v.confirm.tree, commit: v.confirm.commit, push: "confirm", qa: null })).code, "invalid_command");
  assert.equal((await send(m, v, { kind: "finish.confirm", tree: "0".repeat(40), commit: v.confirm.commit, push: "confirm", qa: "confirm" })).code, "stale_revision");
  // the work changed during the pause (I1-1): the decision shown is refused, the view shows the new tree, nothing is stuck
  const shownTree = v.confirm.tree;
  const committed = fs.readFileSync(path.join(v.workDir, "a.txt"));
  fs.writeFileSync(path.join(v.workDir, "a.txt"), "edited during the pause\n");
  assert.equal((await send(m, v, { kind: "finish.confirm", tree: v.confirm.tree, commit: v.confirm.commit, push: "confirm", qa: "confirm" })).code, "stale_revision");
  v = await view(m, runId);
  assert.notEqual(v.confirm.tree, shownTree);
  assert.equal(v.confirm.commit, null, "the new tree has no commit yet");
  fs.writeFileSync(path.join(v.workDir, "a.txt"), committed); // back to the committed tree: the shown commit applies again
  assert.equal((await send(m, v, { kind: "finish.confirm", tree: v.confirm.tree, commit: v.confirm.commit, push: "confirm", qa: "confirm" })).code, "stale_revision");
  v = await view(m, runId);
  assert.deepEqual([v.confirm.tree, v.confirm.commit === v.progress.finish[0].commit], [shownTree, true]);
  // decided independently: no push, QA yes
  assert.equal((await send(m, v, { kind: "finish.confirm", tree: v.confirm.tree, commit: v.confirm.commit, push: "decline", qa: "confirm" })).status, "accepted");
  const done = await settled(m, runId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(done.progress.completion, "no_checks");
  const push = done.progress.finish.find((f) => f.step === "push");
  assert.deepEqual([push.status, push.declined], ["not_started", true]);
  assert.throws(() => g(remote, "rev-parse", "--verify", "-q", "refs/heads/qa-branch"), "declined: nothing pushed");
  assert.equal(fs.readFileSync(qaLog, "utf8").trim(), "run", "QA ran once, as confirmed");
  // every place says "without checks", none says completed
  assert.deepEqual(shown(done), { key: "completed_no_checks", lead: "completed_no_checks", executor: "completed_no_checks", row: "completed_no_checks", card: "completed_no_checks", outcome: "completed_no_checks" });
  assert.notEqual(stateLabel("ru", "completed_no_checks"), stateLabel("ru", "completed"));
  assert.match(stateLabel("ru", "completed_no_checks"), /без проверок/);
  assert.match(stateLabel("en", "completed_no_checks"), /without checks/);
  const all = await records(m, runId);
  const last = all.at(-1);
  assert.deepEqual([last.type, last.data.status, last.data.completion.kind], ["run.status", "completed", "no_checks"]);
  // the journal's lines and the activity say so too (I1-6)
  assert.equal(historyLines(all).filter((l) => l.kind === "status").at(-1).parts.status, "completed_no_checks");
  const act = (await m.activity(runId, 0, 1000)).value.entries.filter((e) => e.kind === "status");
  assert.equal(act.at(-1).detail.status, "completed_no_checks");
  assert.equal(act.some((e) => e.detail.status === "completed"), false);
  // each decision: its record, command.completed, then the run goes on (journal-v2-format.md §2.4)
  for (const t of ["finish.confirmed"]) {
    const at = all.findIndex((r) => r.type === t);
    assert.deepEqual(all.slice(at, at + 3).map((r) => [r.type, r.data.status ?? null]), [[t, null], ["command.completed", null], ["run.status", "running"]], t);
  }
  await m.shutdown();
});

// ---------------- invalid reports ----------------

test("an invalid proposal (a command without a reason) and a proposal with the goal's own commands are invalid reports; nothing is recorded of them", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const bad = manager({ MOCK_SCRIPT: script([PLAN]), MOCK_CHECKS: "invalid" });
  const a = await start(bad, src, { commands: [] });
  const va = await settled(bad, a);
  assert.deepEqual([va.status, va.reason], ["paused", "invalid_report"]);
  assert.equal((await records(bad, a)).some((r) => r.type.startsWith("checks.")), false);
  await bad.shutdown();

  const forced = manager({ MOCK_SCRIPT: script([PLAN]), MOCK_CHECKS: "forced" });
  const b = await start(forced, src, { commands: ["grep -qx 2 a.txt"] });
  const vb = await settled(forced, b);
  assert.deepEqual([vb.status, vb.reason], ["paused", "invalid_report"], "the goal's commands are set: a proposal is not asked for");
  assert.equal((await records(forced, b)).some((r) => r.type.startsWith("checks.") || r.type === "plan.recorded"), false);
  await forced.shutdown();
});

test("the goal's own commands in v2: the run of v1 (regression) — no checks.* records, completed and confirmed", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]) });
  const runId = await start(m, src, { commands: ["grep -qx 2 a.txt"] });
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v));
  assert.deepEqual([v.progress.completion, v.progress.checksFrom], ["confirmed", "goal"]);
  const all = await records(m, runId);
  assert.equal(JSON.parse(journalOf(m, runId).toString().split("\n")[0]).v, 2);
  assert.equal(all.some((r) => r.type.startsWith("checks.")), false);
  await m.shutdown();
  // the second stage of reading (the goal's text): «completed, confirmed» with the goal's command failed or never run,
  // or a proposal for a goal that has its own commands — corrupt, phase texts (I1-5)
  const buf = journalOf(m, runId);
  const file = path.join(m.root, "runs", runId, "journal.jsonl");
  const texts = async (fn) => {
    const b = rewrite(buf, runId, fn);
    assert.equal(parseJournal(b, runId).integrity.status, "ok", "the records alone replay");
    fs.writeFileSync(file, b);
    const r = await readRun(m.root, runId);
    assert.notEqual(r.state, null, "listed with its state, as a replay conflict is");
    return [r.integrity.status, r.integrity.detail?.phase ?? null, r.canContinue];
  };
  assert.deepEqual(await texts((r) => r), ["ok", null, true]);
  assert.deepEqual(await texts((r) => { for (const x of r) if (x.type === "check.finished") Object.assign(x.data, { status: "failed", exitCode: 1 }); return r; }), ["corrupt", "texts", false]);
  assert.deepEqual(await texts((r) => r.filter((x) => !x.type.startsWith("check."))), ["corrupt", "texts", false]);
  fs.writeFileSync(file, buf);
});

// ---------------- the flag ----------------

test("without the flag: a new run is written in v1 and its commands are required, as before", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN_V1, EXEC, REVIEW_V1, FINAL_V1]) }, { v2: false });
  const runId = await start(m, src, { commands: ["grep -qx 2 a.txt"] });
  const v = await settled(m, runId);
  assert.equal(v.status, "completed");
  assert.equal(v.progress.completion, undefined, "a v1 view, as before");
  const first = JSON.parse(journalOf(m, runId).toString().split("\n")[0]);
  assert.deepEqual([first.v, "minReaderVersion" in first, "formatPreview" in first], [1, false, false]);
  // empty commands without a mode: refused as before (with a mode the project's commands are taken, as before)
  const r = await m.create({ requestId: randomUUID(), source: src, goal: { text: "x", criteria: ["c"], checks: [], commands: [] } });
  assert.equal(r.ok ? "ok" : r.code, "invalid_goal");
  const info = await m.profile(await linkOf(m, src));
  assert.equal(info.ok ? info.value.optionalChecks : "error", undefined, "the dialog keeps the field required");
  await m.shutdown();
});
async function linkOf(m, src) {
  const at = (x) => ({ position: { x, y: 0 }, size: { width: 300, height: 200 } });
  const [lead, exec, linkId] = [randomUUID(), randomUUID(), randomUUID()];
  assert.ok((await m.createAgent({ agentId: lead, provider: "codex", project: src, bounds: at(0) })).ok);
  assert.ok((await m.createAgent({ agentId: exec, provider: "claude", project: src, bounds: at(400) })).ok);
  assert.ok((await m.createLink({ linkId, fromAgentId: lead, toAgentId: exec })).ok);
  return linkId;
}

// ---------------- recovery (§2.5) ----------------

for (const completed of [false, true]) test(`a decision recorded before the end${completed ? " with its command.completed" : ""}, the run still on its pause: reopening pauses it as recovered; Resume continues`, OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  // one MOCK_STATE for both processes: the lead's session is resumed after the restart
  const env = { MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt", MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")) };
  const m = manager(env, { leadSandbox: false });
  const runId = await start(m, src, { commands: [] });
  const v = await settled(m, runId, "the proposal");
  assert.equal(v.reason, "awaiting_checks_decision");
  await m.shutdown();
  // the end came after the decision — before its command.completed, or after it — before run.status(running) (§2.4)
  const w = await openRun(m.root, runId);
  const st = w.state();
  const commandId = randomUUID();
  await w.recordCommand(commandId, "checks.decide", { expectedRevision: st.orch.revision, command: { kind: "checks.decide", decision: "accept" } });
  await w.recordEvent("checks.decided", { proposalTurnId: st.orch.checksProposal.turnId, decision: "accept", by: "person", commandId, checks: await w.putText(JSON.stringify({ checks: [{ id: "cmd-1", command: "grep -qx 2 a.txt", origin: "lead" }] })), count: 1 });
  if (completed) await w.completeCommand(commandId, { status: "accepted", code: null });
  await w.close();
  const again = createRunManager({ platform: "darwin", root: m.root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providersFile(env), () => LAUNCH), journalV2: true, leadSandbox: false });
  // any command opens it: the opening decides the pause first, so the stale revision says so
  const first = await send(again, await view(again, runId), { kind: "resume" });
  assert.deepEqual(first, { status: "rejected", code: "stale_revision" }, "opening wrote the pause");
  const r = await view(again, runId);
  assert.deepEqual([r.status, r.reason], ["paused", "recovered"]);
  const h = await records(again, runId);
  const at = h.findIndex((x) => x.type === "checks.decided");
  // the pause: the store's run.recovered (an unfinished command), or reopen()'s paused(recovered); nothing ran before it
  const next = h.slice(at + 1).filter((x) => x.type !== "command.completed")[0];
  assert.deepEqual(completed ? [next.type, next.data.status, next.data.reason] : [next.type], completed ? ["run.status", "paused", "recovered"] : ["run.recovered"]);
  // the decision stands: its command is accepted, never interrupted (§2.5, I1-3)
  assert.deepEqual(h.find((x) => x.type === "command.completed" && x.data.commandId === commandId).data.result, { status: "accepted", code: null });
  assert.equal((await send(again, r, { kind: "resume" })).status, "accepted");
  const done = await settled(again, runId);
  assert.deepEqual([done.status, done.progress.completion], ["completed", "confirmed"], JSON.stringify(done));
  await again.shutdown();
});

// ---------------- «Завершено» and the autopilot's acceptance past the rules: an integrity error on replay ----------------

// The journal with its records changed by `fn` (records: {type, data}), the chain rebuilt as this build writes v2.
function rewrite(buf, runId, fn) {
  const recs = fn(buf.toString().trim().split("\n").map((l) => JSON.parse(l)));
  const out = [];
  let prev = null;
  for (const r of recs) {
    const { record, line } = buildRecord(prev, runId, r.ts, r.type, r.data, 2, prev === null ? { minReaderVersion: 2 } : null);
    out.push(line);
    prev = record;
  }
  return Buffer.concat(out);
}
const corrupt = (buf, runId) => { const p = parseJournal(buf, runId); return p.integrity.status === "corrupt" ? [p.integrity.detail.code, p.records[p.records.length]?.type ?? JSON.parse(buf.toString().split("\n")[p.integrity.detail.line - 1]).type] : [p.integrity.status]; };

test("a completed run the completion function does not allow, and an autopilot acceptance while the network is open: replay_conflict", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt" }, { leadSandbox: false });
  const runId = await start(m, src, { commands: [] });
  await send(m, await settled(m, runId, "the proposal"), { kind: "checks.decide", decision: "accept" });
  assert.equal((await settled(m, runId)).status, "completed");
  await m.shutdown();
  const buf = journalOf(m, runId);
  assert.equal(parseJournal(buf, runId).integrity.status, "ok");
  const last = (recs) => recs.at(-1);
  // completed "without checks" while it had checks; completed without the final review that completes it
  assert.deepEqual(corrupt(rewrite(buf, runId, (r) => { last(r).data.completion.kind = "no_checks"; return r; }), runId), ["replay_conflict", "run.status"]);
  assert.deepEqual(corrupt(rewrite(buf, runId, (r) => r.filter((x) => !(x.type === "review.assessed" && x.data.stage === null))), runId), ["replay_conflict", "run.status"]);
  // completed with a stage of the plan not accepted (I1-4)
  assert.deepEqual(corrupt(rewrite(buf, runId, (r) => r.filter((x) => x.type !== "stage.accepted")), runId), ["replay_conflict", "run.status"]);
  // between the proposal and the decision only the commands' records and run.status (I1-7): a clarification is not
  const cmd = (ts, kind, type, data) => { const id = randomUUID(); return [{ ts, type: "command.received", data: { commandId: id, kind, payloadHash: "c".repeat(64) } }, { ts, type, data: data(id) }, { ts, type: "command.completed", data: { commandId: id, result: { status: "accepted", code: null } } }]; };
  assert.deepEqual(corrupt(rewrite(buf, runId, (r) => {
    const i = r.findIndex((x) => x.type === "checks.proposed");
    r.splice(i + 1, 0, ...cmd(r[i].ts, "clarify", "clarification.added", (id) => ({ version: 1, commandId: id, text: r[0].data.goal })));
    return r;
  }), runId), ["replay_conflict", "clarification.added"]);
  // the decision under another command (I1-8)
  assert.deepEqual(corrupt(rewrite(buf, runId, (r) => { r.find((x) => x.type === "command.received" && x.data.kind === "checks.decide").data.kind = "resume"; return r; }), runId), ["replay_conflict", "checks.decided"]);
  // completed confirmed while the check failed
  assert.deepEqual(corrupt(rewrite(buf, runId, (r) => { for (const x of r) if (x.type === "check.finished") Object.assign(x.data, { status: "failed", exitCode: 1 }); return r; }), runId)[0], "replay_conflict");
  // the autopilot accepted although the network of the checks is open
  const autopilot = (network) => (r) => {
    const from = r.findIndex((x) => x.type === "checks.proposed"), to = r.findIndex((x) => x.type === "checks.decided");
    r[from].data.sandboxNetwork = network;
    Object.assign(r[to].data, { by: "autopilot", commandId: null });
    return [...r.slice(0, from + 1), r[to], ...r.slice(to + 1).filter((x) => !(x.type === "command.completed" && x.data.commandId === r[to - 1]?.data?.commandId))];
  };
  assert.deepEqual(corrupt(rewrite(buf, runId, autopilot("open")), runId), ["replay_conflict", "checks.decided"]);
  // "denied" said of checks that ran without a sandbox
  assert.deepEqual(corrupt(rewrite(buf, runId, autopilot("denied")), runId), ["replay_conflict", "check.started"]);
  // the same run with the checks under the Seatbelt profile: the autopilot's acceptance, checks and confirmation replay
  const sandboxed = rewrite(buf, runId, (r) => {
    const out = autopilot("denied")(r);
    for (const x of out) if (x.type === "check.started") x.data.profileSha256 = "1".repeat(64);
    return out;
  });
  const p = parseJournal(sandboxed, runId);
  assert.equal(p.integrity.status, "ok", JSON.stringify(p.integrity));
  assert.deepEqual([p.state.status, p.state.completion.kind, p.state.orch.checksDecision.by], ["completed", "confirmed", "autopilot"]);
  assert.equal(NO_SANDBOX_SHA256.length, 64);
  // the reader of the store says so too: never continued
  fs.writeFileSync(path.join(m.root, "runs", runId, "journal.jsonl"), rewrite(buf, runId, (r) => { last(r).data.completion.kind = "no_checks"; return r; }));
  const read = await readRun(m.root, runId);
  assert.deepEqual([read.integrity.status, read.integrity.detail.code, read.canContinue], ["corrupt", "replay_conflict", false]);
});

// ---------------- the decision function (§7 p. 5) ----------------

test("the cycle: the autopilot accepts by itself only when the network is denied; steps and an open network wait for the person", OPTS, async () => {
  assert.deepEqual([autoAccepts({}, "denied"), autoAccepts({ mode: "autopilot" }, "denied"), autoAccepts({}, "open"), autoAccepts({ mode: "steps" }, "denied")], [true, true, false, false]);
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN]), MOCK_CHECKS: "proposed" }, { leadSandbox: false });
  const runId = await start(m, src, { commands: [] });
  await settled(m, runId, "the proposal");
  await m.shutdown();
  const buf = journalOf(m, runId);
  // the state right after the proposal, running: what the cycle decides for each mode and network
  const at = (network) => {
    const b = rewrite(buf, runId, (r) => {
      const i = r.findIndex((x) => x.type === "checks.proposed");
      r[i].data.sandboxNetwork = network;
      return r.slice(0, i + 1);
    });
    return parseJournal(b, runId).state;
  };
  const goal = (mode) => ({ v: 1, text: "x", criteria: ["c"], checks: [], commands: [], reviewPlan: false, createdAt: Date.now(), limits: { turns: 40, roundsPerStage: 8, replans: 3, noProgressRounds: 3, runMs: 3600_000, leadTurnMs: 60_000, executorTurnMs: 60_000 }, ...(mode ? { mode } : {}) });
  const decide = (state, g) => nextAction({ state, goal: g, limits: g.limits, snapshot: { tree: "t", runKey: "k", checkKeys: {} }, now: Date.now(), findingsOf: () => [] }).kind;
  assert.equal(decide(at("denied"), goal()), "accept_checks");
  assert.equal(decide(at("denied"), goal("autopilot")), "accept_checks");
  assert.equal(decide(at("open"), goal()), "pause");
  assert.equal(decide(at("denied"), goal("steps")), "pause");
  // A1.1 Q1: none proposed — the autopilot goes on whatever the network; step by step the person decides
  assert.deepEqual([autoAccepts({}, "open", 0), autoAccepts({ mode: "steps" }, "open", 0), autoAccepts({}, "open", 1)], [true, false, false]);
});

// ---------------- the premise of §7 p. 5 on the real Seatbelt ----------------

test("the Seatbelt profile of the checks denies the network: outside TCP, localhost, DNS (a real sandbox-exec; native checks do not run under it in A1)", { skip: process.platform !== "darwin" && "Seatbelt is macOS only", timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "sb-"));
  for (const d of ["root/r", "root/t", "root/h", "src/.git/objects", "nm"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const profile = buildProfile({ root: `${dir}/root`, repo: `${dir}/root/r`, tmp: `${dir}/root/t`, home: `${dir}/root/h`, sourcePath: `${dir}/src`, sourceGitDir: `${dir}/src/.git`, nodeModules: `${dir}/nm` });
  fs.writeFileSync(path.join(dir, "p.sb"), profile.text);
  const server = net.createServer((c) => c.end()).listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  const connect = (host, port) => `const s=require("net").connect(${port},"${host}");s.setTimeout(4000);s.on("connect",()=>process.exit(0));s.on("timeout",()=>process.exit(4));s.on("error",(e)=>{console.log(e.code);process.exit(3)})`;
  const run = (sandboxed, code) => spawnSync(sandboxed ? "/usr/bin/sandbox-exec" : NODE, [...(sandboxed ? ["-f", path.join(dir, "p.sb"), NODE] : []), "-e", code], { encoding: "utf8", timeout: 15_000 });
  const local = connect("127.0.0.1", server.address().port);
  assert.equal(run(false, local).status, 0, "the listener is reachable outside the sandbox");
  const inLocal = run(true, local);
  assert.deepEqual([inLocal.status, inLocal.stdout.trim()], [3, "EPERM"], "localhost: refused by the sandbox");
  const external = connect("1.1.1.1", 443);
  const inExternal = run(true, external);
  assert.deepEqual([inExternal.status, inExternal.stdout.trim()], [3, "EPERM"], "outside TCP: refused by the sandbox, whatever the machine's own network");
  const dns = run(true, `require("dns").lookup("example.com",(e)=>{console.log(e?e.code:"ok");process.exit(e?3:0)})`);
  assert.equal(dns.status, 3, "no name resolution inside");
  server.close();
});

// =============== A1.1: the lead's proposed checks in the check profile (journal-v2-format.md §2.6) ===============

const DARWIN = { ...OPTS, skip: process.platform !== "darwin" && "Seatbelt is macOS only" };
const startedOf = async (m, runId) => (await records(m, runId)).filter((r) => r.type === "check.started").map((r) => [r.data.checkId, r.data.profileSha256 === NO_SANDBOX_SHA256 ? "shell" : "profile"]);

test("A1.1 Q1 step by step: none proposed — «Лид не нашёл команд проверки» with «Продолжить без проверок» and «Добавить команды»", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "none" });
  const a = await start(m, src, { commands: [], mode: "steps" });
  let v = await settled(m, a, "the pause");
  assert.deepEqual([v.reason, v.proposal.checks.length, runHeadline(v).headline, availableActions(v)], ["awaiting_checks_decision", 0, "awaiting_checks_none", ["checks_decide", "stop"]]);
  assert.equal((await send(m, v, { kind: "checks.decide", decision: "accept" })).status, "accepted", "«Продолжить без проверок»");
  for (;;) {
    v = await settled(m, a);
    if (v.status !== "paused") break;
    assert.equal((await send(m, v, { kind: "resume" })).status, "accepted", JSON.stringify(v));
  }
  assert.deepEqual([v.status, v.progress.completion], ["completed", "no_checks"]);
  // «Добавить команды»: the person's lines, run in their shell
  const src2 = project({ "a.txt": "1\n" });
  const m2 = manager({ MOCK_SCRIPT: script([PLAN, PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "none" });
  const b = await start(m2, src2, { commands: [], mode: "steps" });
  assert.equal((await send(m2, await settled(m2, b, "the pause"), { kind: "checks.decide", decision: "edit", checks: ["grep -qx 2 a.txt"] })).status, "accepted");
  for (;;) {
    v = await settled(m2, b);
    if (v.status !== "paused") break;
    assert.equal((await send(m2, v, { kind: "resume" })).status, "accepted", JSON.stringify(v));
  }
  assert.deepEqual([v.status, v.progress.completion, v.progress.checksFrom], ["completed", "confirmed", "edited"]);
  assert.deepEqual(await startedOf(m2, b), [["cmd-1", "shell"]], "a person's command: their shell, as before");
  await m.shutdown();
  await m2.shutdown();
});

test("A1.1: the autopilot accepts the lead's commands itself and they run in the check profile — under sandbox-exec (a write outside is refused)", DARWIN, async () => {
  const src = project({ "a.txt": "1\n" });
  const outside = path.join(TMP, `outside-${++n}`);
  // passes only where a write outside the work folder is refused: the proof that it ran in the profile
  // and where the work folder's git directory is not written (a hook would run later by the person's git: review S1-1)
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed",
    MOCK_CHECK_COMMAND: `grep -qx 2 a.txt && ! touch ${outside} 2>/dev/null && ! (mkdir -p .git/hooks && echo exit > .git/hooks/pre-commit) 2>/dev/null` });
  const runId = await start(m, src, { commands: [] });
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v));
  assert.equal(fs.existsSync(outside), false, "nothing written outside the work folder");
  const all = await records(m, runId);
  assert.equal(all.some((r) => r.type === "run.status" && r.data.reason === "awaiting_checks_decision"), false, "no pause for the decision");
  assert.deepEqual([all.find((r) => r.type === "checks.proposed").data.sandboxNetwork, all.find((r) => r.type === "checks.decided").data.by], ["denied", "autopilot"]);
  assert.deepEqual(await startedOf(m, runId), [["cmd-1", "profile"]]);
  assert.deepEqual([v.progress.completion, v.progress.checksFrom], ["confirmed", "proposal"]);
  await m.shutdown();
});

test("A1.1 (real series attempt 4, R2): git runs in the check profile — it does not read the global config the profile denies; reading ~/.gitconfig is still refused", DARWIN, async () => {
  const src = project({ "a.txt": "1\n", "b.txt": "b\n" });
  // a home of the person with a .gitconfig, as the profile's deny list sees it (realHome) and as git looks for it (HOME)
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = person\n");
  fs.mkdirSync(path.join(home, "Library", "Keychains"), { recursive: true }); // the profile's self-test reads it (refused)
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed",
    MOCK_CHECK_COMMAND: `git diff HEAD --exit-code -- b.txt && grep -qx 2 a.txt && cat ${home}/.gitconfig 2>&1 | grep -q "Operation not permitted"` },
  // the person's environment: no GIT_CONFIG_* of the test's own (undefined: left out of the file), so git looks in $HOME
  { leadSandbox: { realHome: home }, checkEnv: { HOME: home, GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_NOSYSTEM: undefined } });
  const runId = await start(m, src, { commands: [] });
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v));
  assert.deepEqual(await startedOf(m, runId), [["cmd-1", "profile"]]);
  assert.deepEqual([v.progress.completion, v.progress.checksFrom], ["confirmed", "proposal"]);
  await m.shutdown();
});

test("A1.1 (review S1-3): a detached process the lead's check leaves behind is killed with the check — the tree it passed on stays", DARWIN, async () => {
  const src = project({ "a.txt": "1\n" });
  const late = `"${NODE}" -e 'require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => require(\\"fs\\").writeFileSync(\\"a.txt\\", \\"late\\"), 3000)"], { detached: true, stdio: "ignore" }).unref()'`;
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: `grep -qx 2 a.txt && ${late}` });
  const runId = await start(m, src, { commands: [] });
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.progress.completion], ["completed", "confirmed"], JSON.stringify(v));
  await sleep(5000);
  assert.equal(fs.readFileSync(path.join(v.workDir, "a.txt"), "utf8"), "2\n", "nothing outlived the check");
  await m.shutdown();
});

test("A1.1: the person's commands run in their shell as before — the goal's own, and the person's lines of an edited set next to the lead's in the profile", DARWIN, async () => {
  const src = project({ "a.txt": "1\n" });
  const outside = path.join(TMP, `outside-${++n}`);
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]) });
  const runId = await start(m, src, { commands: [`grep -qx 2 a.txt && touch ${outside}`] });
  assert.equal((await settled(m, runId)).status, "completed");
  assert.equal(fs.existsSync(outside), true, "the goal's own command wrote outside: no sandbox");
  assert.deepEqual(await startedOf(m, runId), [["cmd-1", "shell"]]);
  await m.shutdown();
  // mixed: the lead's line stays in the profile, the person's runs in the shell; a person decided, so no autopilot rule
  const src2 = project({ "a.txt": "1\n" });
  const m2 = manager({ MOCK_SCRIPT: script([PLAN, PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt" });
  const b = await start(m2, src2, { commands: [], mode: "steps" });
  assert.equal((await send(m2, await settled(m2, b, "the proposal"), { kind: "checks.decide", decision: "edit", checks: ["grep -qx 2 a.txt", "test -f a.txt"] })).status, "accepted");
  let v;
  for (;;) {
    v = await settled(m2, b);
    if (v.status !== "paused") break;
    assert.equal((await send(m2, v, { kind: "resume" })).status, "accepted", JSON.stringify(v));
  }
  assert.equal(v.status, "completed", JSON.stringify(v));
  assert.deepEqual(await startedOf(m2, b), [["cmd-1", "profile"], ["cmd-2", "shell"]]);
  await m2.shutdown();
  // second stage: the lead's line of the edited set run without the profile and without an amendment — corrupt, texts
  const buf = journalOf(m2, b);
  const file = path.join(m2.root, "runs", b, "journal.jsonl");
  fs.writeFileSync(file, rewrite(buf, b, (r) => { r.find((x) => x.type === "check.started" && x.data.checkId === "cmd-1").data.profileSha256 = NO_SANDBOX_SHA256; return r; }));
  const read = await readRun(m2.root, b);
  assert.deepEqual([read.integrity.status, read.integrity.detail?.phase], ["corrupt", "texts"]);
});

test("A1.1 (review S1-2): a lead's line of a denied run reopened where the profile is not offered (leadSandbox false) still runs only in the profile", DARWIN, async () => {
  const src = project({ "a.txt": "1\n" });
  const outside = path.join(TMP, `outside-${++n}`);
  const env = { MOCK_SCRIPT: script([PLAN, PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: `grep -qx 2 a.txt && touch ${outside}` };
  const m = manager(env);
  const runId = await start(m, src, { commands: [], mode: "steps" });
  // «Изменить» keeps the lead's line next to the person's: the decision is "edit", not "accept"
  assert.equal((await send(m, await settled(m, runId, "the proposal"), { kind: "checks.decide", decision: "edit", checks: [`grep -qx 2 a.txt && touch ${outside}`, "test -f a.txt"] })).status, "accepted");
  await settled(m, runId, "the new plan");
  await m.shutdown();
  const again = manager(env, { leadSandbox: false, root: m.root });
  let v;
  for (;;) {
    v = await settled(again, runId);
    if (v.status !== "paused" || v.reason === "check_needs_permissions") break;
    assert.equal((await send(again, v, { kind: "resume" })).status, "accepted", JSON.stringify(v));
  }
  assert.equal(v.reason, "check_needs_permissions", JSON.stringify(v));
  assert.equal(fs.existsSync(outside), false, "nothing written outside the work folder");
  assert.deepEqual(await startedOf(again, runId), [["cmd-1", "profile"]]);
  await again.shutdown();
});

test("A1.1: a lead's check the sandbox refuses pauses «Проверке нужно больше прав» — even the autopilot; only the person's line (S1-4: no «without the sandbox» for the lead's command) lets it go on", DARWIN, async () => {
  const src = project({ "a.txt": "1\n" });
  const outside = path.join(TMP, `outside-${++n}`);
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: `grep -qx 2 a.txt && touch ${outside}` });
  const runId = await start(m, src, { commands: [] });
  let v = await settled(m, runId, "the refusal");
  assert.deepEqual([v.status, v.reason, runHeadline(v).headline], ["paused", "check_needs_permissions", "check_needs_permissions"]);
  assert.deepEqual(v.refused, { checkId: "cmd-1", command: `grep -qx 2 a.txt && touch ${outside}` });
  assert.deepEqual(v.progress.checks.map((c) => [c.status, c.class]), [["failed", "sandbox"]], "not the code's failure");
  assert.deepEqual(availableActions(v), ["check_amend", "stop"]);
  for (const command of [{ kind: "resume" }, { kind: "step" }, { kind: "clarify", text: "x" }]) {
    assert.deepEqual(await send(m, v, command), { status: "rejected", code: "invalid_state" }, command.kind);
  }
  assert.equal((await send(m, v, { kind: "check.amend", checkId: "cmd-2" })).code, "invalid_state", "not the refused check");
  assert.equal((await send(m, v, { kind: "check.amend", checkId: "cmd-1", line: "a\nb" })).code, "invalid_command");
  // the autopilot never lets it out by itself
  await sleep(500);
  assert.equal((await view(m, runId)).reason, "check_needs_permissions");
  // the former «Запустить без песочницы» (no line) is no command at all: refused by main and by the IPC parser
  assert.equal((await send(m, await view(m, runId), { kind: "check.amend", checkId: "cmd-1" })).code, "invalid_command");
  const base = { runId, commandId: randomUUID(), expectedRevision: 1 };
  assert.throws(() => parseCommand({ ...base, command: { kind: "check.amend", checkId: "cmd-1" } }), /line/);
  assert.equal(parseCommand({ ...base, command: { kind: "check.amend", checkId: "cmd-1", line: "x" } }).command.line, "x");
  // «Изменить команду», saved unchanged: the person's command now, in their shell
  assert.equal((await send(m, await view(m, runId), { kind: "check.amend", checkId: "cmd-1", line: `grep -qx 2 a.txt && touch ${outside}` })).status, "accepted");
  v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v));
  assert.equal(fs.existsSync(outside), true);
  assert.deepEqual(await startedOf(m, runId), [["cmd-1", "profile"], ["cmd-1", "shell"]]);
  const all = await records(m, runId);
  const amended = all.find((r) => r.type === "checks.amended");
  assert.deepEqual([amended.data.checkId, typeof amended.data.line?.sha256], ["cmd-1", "string"]);
  const at = all.indexOf(amended);
  assert.deepEqual(all.slice(at + 1, at + 3).map((r) => [r.type, r.data.status ?? null]), [["command.completed", null], ["run.status", "running"]]);
  await m.shutdown();

  // the network: refused in the profile → the same pause; «Изменить команду» → the person's line, in their shell
  const src2 = project({ "a.txt": "1\n" });
  const net1 = `grep -qx 2 a.txt && "${NODE}" -e 'require("net").connect(443,"1.1.1.1").on("connect",()=>process.exit(0)).on("error",(e)=>{console.error(e.code);process.exit(1)})'`;
  const m2 = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: net1 });
  const b = await start(m2, src2, { commands: [] });
  v = await settled(m2, b, "the refusal");
  assert.deepEqual([v.reason, v.progress.checks[0].class], ["check_needs_permissions", "sandbox"]);
  assert.equal((await send(m2, v, { kind: "check.amend", checkId: "cmd-1", line: "grep -qx 2 a.txt" })).status, "accepted");
  v = await settled(m2, b);
  assert.deepEqual([v.status, v.progress.checks[0].title], ["completed", "grep -qx 2 a.txt"]);
  assert.deepEqual(await startedOf(m2, b), [["cmd-1", "profile"], ["cmd-1", "shell"]]);
  await m2.shutdown();
});

test("A1.1: the profile's self-test fails — the check does not run, the run pauses with the cause", DARWIN, async () => {
  const src = project({ "a.txt": "1\n" });
  // a home without the credential stores: the refusal to read them cannot be proven (ENOENT, not EPERM)
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt" }, { leadSandbox: { realHome: home } });
  const runId = await start(m, src, { commands: [] });
  const v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "sandbox_unavailable"]);
  assert.deepEqual(await startedOf(m, runId), [], "nothing ran");
  await m.shutdown();
  // the self-test itself: the real profile passes; a profile that allows everything does not
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cst-")));
  for (const x of ["work", "tmp", "root"]) fs.mkdirSync(path.join(d, x));
  const paths = { work: path.join(d, "work"), tmp: path.join(d, "tmp"), root: path.join(d, "root") };
  fs.writeFileSync(path.join(d, "p.sb"), buildCheckProfile(paths).text);
  fs.writeFileSync(path.join(d, "open.sb"), "(version 1)\n(allow default)\n");
  assert.deepEqual(await checkSelftest({ profilePath: path.join(d, "p.sb"), ...paths, launch: LAUNCH }), { passed: true, checks: 8, failed: [] });
  const open = await checkSelftest({ profilePath: path.join(d, "open.sb"), ...paths, launch: LAUNCH });
  assert.deepEqual(open.failed.map((f) => f.name).sort(), ["deny.read-root", "deny.read-secrets", "deny.tcp-external", "deny.write-git", "deny.write-home"]);
  assert.equal(fs.existsSync(path.join(paths.work, ".git")), false, "the open profile's self-test left nothing behind");
  // a worktree's work folder: .git is a file (review S2-1) — refused all the same, the self-test passes
  fs.writeFileSync(path.join(paths.work, ".git"), "gitdir: /nowhere\n");
  assert.deepEqual(await checkSelftest({ profilePath: path.join(d, "p.sb"), ...paths, launch: LAUNCH }), { passed: true, checks: 8, failed: [] });
  assert.deepEqual((await checkSelftest({ profilePath: path.join(d, "open.sb"), ...paths, launch: LAUNCH })).failed.map((f) => f.name).includes("deny.write-git"), true);
  assert.equal(fs.readFileSync(path.join(paths.work, ".git"), "utf8"), "gitdir: /nowhere\n");
  // a work folder that covers the home or a credential store is refused before any profile (review S1-6)
  assert.throws(() => buildCheckProfile({ ...paths, work: os.homedir() }), /covers/);
  fs.mkdirSync(path.join(d, "home", ".ssh", "x"), { recursive: true });
  assert.throws(() => buildCheckProfile({ ...paths, realHome: path.join(d, "home"), work: path.join(d, "home", ".ssh", "x") }), /covers/);
  fs.rmSync(d, { recursive: true, force: true });
});

test("A1.1 in the profile, as a project's tests do: node --test and npm test with local node_modules, a server on localhost the test starts", DARWIN, async () => {
  const test = `import test from "node:test"; import assert from "node:assert"; import dep from "dep"; import http from "node:http";
test("dep", () => assert.equal(dep, 2));
test("localhost", async () => { const s = http.createServer((q, r) => r.end("hi")).listen(0, "127.0.0.1"); await new Promise((r) => s.once("listening", r));
  assert.equal(await (await fetch("http://127.0.0.1:" + s.address().port)).text(), "hi"); s.close(); });
test("a.txt", async () => assert.equal((await import("node:fs")).readFileSync("a.txt", "utf8"), "2\\n"));
`;
  const src = project({ "a.txt": "1\n", "package.json": JSON.stringify({ name: "x", type: "module", scripts: { test: "node --test" } }), "a.test.js": test });
  fs.mkdirSync(path.join(src, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep", type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(src, "node_modules", "dep", "index.js"), "export default 2;\n");
  const npm = path.join(path.dirname(NODE), "npm");
  const line = `PATH="${path.dirname(NODE)}:$PATH" "${NODE}" --test && PATH="${path.dirname(NODE)}:$PATH" "${npm}" test`;
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: line });
  const runId = await start(m, src, { commands: [] });
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v.progress?.checks ?? v));
  assert.deepEqual(await startedOf(m, runId), [["cmd-1", "profile"]]);
  await m.shutdown();
});

// ---------------- A1.1 replay: the amendment and the profile of the lead's checks ----------------

test("A1.1 replay: a lead's check of a denied run without the profile and without the person's amendment, an amendment without a refusal — replay_conflict", DARWIN, async () => {
  const src = project({ "a.txt": "1\n" });
  const outside = path.join(TMP, `outside-${++n}`);
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: `grep -qx 2 a.txt && touch ${outside}` });
  const runId = await start(m, src, { commands: [] });
  await send(m, await settled(m, runId, "the refusal"), { kind: "check.amend", checkId: "cmd-1", line: `grep -qx 2 a.txt && touch ${outside}` });
  assert.equal((await settled(m, runId)).status, "completed");
  await m.shutdown();
  const buf = journalOf(m, runId);
  assert.equal(parseJournal(buf, runId).integrity.status, "ok");
  // without the amendment, the run in the shell is one the profile should have had
  const dropAmend = (r) => {
    const i = r.findIndex((x) => x.type === "checks.amended");
    const id = r[i].data.commandId;
    return r.filter((x) => x.data.commandId !== id);
  };
  assert.deepEqual(corrupt(rewrite(buf, runId, dropAmend), runId), ["replay_conflict", "check.started"]);
  // the lead's command without the sandbox, as such (no line): no longer a record of the format (S1-4)
  assert.equal(corrupt(rewrite(buf, runId, (r) => { r.find((x) => x.type === "checks.amended").data.line = null; return r; }), runId)[1], "checks.amended");
  // an amendment of a check the sandbox did not refuse (classified as the code's)
  assert.deepEqual(corrupt(rewrite(buf, runId, (r) => { r.find((x) => x.type === "check.classified").data.class = "code"; return r; }), runId), ["replay_conflict", "checks.amended"]);
  // "refused by the sandbox" said of a check that ran in the shell (the run after the amendment, made a failure)
  assert.deepEqual(corrupt(rewrite(buf, runId, (r) => {
    const fin = r.filter((x) => x.type === "check.finished").at(-1);
    Object.assign(fin.data, { status: "failed", exitCode: 1 });
    r.splice(r.indexOf(fin) + 1, 0, { ts: fin.ts, type: "check.classified", data: { checkRunId: fin.data.checkRunId, class: "sandbox" } });
    return r;
  }), runId), ["replay_conflict", "check.classified"]);
});
