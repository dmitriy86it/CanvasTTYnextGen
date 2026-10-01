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
import { buildProfile } from "../src/main/services/orchestration/sandbox.ts";
import { openRun, readRun } from "../src/main/services/orchestration/store.ts";
import { agentState, availableActions, runStatusKey } from "../src/renderer/src/features/orchestration/runModel.ts";
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
// the login shell as the checks call it (-ilc <line>), without the machine's profile files
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });

function providersFile(env) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), ...env } };
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
const PLAN = { answer: { stages: [{ title: "fix", task: "make a.txt say 2" }], question: null } };
const REVIEW = { answer: { verdict: "accept", findings: [], question: null } };
const FINAL = { answer: { verdict: "complete", findings: [], question: null } };
const EXEC = { answer: { summary: "done", done: true }, writes: [{ rel: "a.txt", base64: Buffer.from("2\n").toString("base64") }] };

function manager(env, { v2 = true } = {}) {
  const root = path.join(TMP, `root-${++n}`);
  const m = createRunManager({
    platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providersFile(env), () => LAUNCH),
    ...(v2 ? { journalV2: true } : {})
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

// ---------------- the lead proposes; the autopilot waits while the network is open ----------------

test("empty commands, autopilot, the lead proposes: the network of native checks is open, so it waits for «Принять»; then the checks run and confirm", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt" });
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
  assert.equal((await send(m, await view(m, runId), { kind: "checks_decide", decision: "accept" })).status, "accepted");
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
  assert.equal((await send(m, done, { kind: "checks_decide", decision: "accept" })).code, "invalid_state");
  await m.shutdown();
});

test("step by step: «Изменить» drops the proposal turn's plan, a new plan turn follows with the person's commands; replans are not spent", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt" });
  const runId = await start(m, src, { commands: [], mode: "steps" });
  let v = await settled(m, runId, "the proposal");
  assert.equal(v.reason, "awaiting_checks_decision");
  assert.equal((await send(m, v, { kind: "checks_decide", decision: "edit", checks: ["grep -qx 2 a.txt", "test -f a.txt", "test -f a.txt"] })).code, "invalid_command", "repeated lines");
  assert.equal((await send(m, await view(m, runId), { kind: "checks_decide", decision: "edit", checks: ["grep -qx 2 a.txt", "test -f a.txt"] })).status, "accepted");
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
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "none" });
  const runId = await start(m, src, { commands: [], finish: { commit: true, push: true, qa: true } }, {
    workMode: "worktree", finish: { commit: true, push: { remote: "qa", branch: "qa-branch", remoteUrl: remote }, qa: { environment: "qa", command: `echo run >> ${qaLog}`, verify: "true" } }
  });
  let v = await settled(m, runId, "the proposal");
  assert.deepEqual([v.reason, v.proposal.checks.length, typeof v.proposal.none], ["awaiting_checks_decision", 0, "string"]);
  assert.equal((await send(m, v, { kind: "checks_decide", decision: "accept" })).status, "accepted");
  v = await settled(m, runId, "the push/QA confirmation");
  assert.deepEqual([v.status, v.reason], ["paused", "awaiting_finish_confirmation"]);
  assert.deepEqual(v.progress.finish.map((f) => [f.step, f.status]), [["commit", "done"], ["push", "not_started"], ["qa", "not_started"]]);
  assert.throws(() => g(remote, "rev-parse", "--verify", "-q", "refs/heads/qa-branch"), "nothing pushed without the person");
  assert.equal(fs.existsSync(qaLog), false, "no QA without the person");
  assert.deepEqual(availableActions(v), ["finish_confirm", "stop"]);
  assert.deepEqual([v.confirm.push, v.confirm.qa, v.confirm.commit], [true, true, v.progress.finish[0].commit]);
  assert.match(v.confirm.tree, /^[0-9a-f]{40}$/);
  assert.equal((await send(m, v, { kind: "resume" })).code, "invalid_state");
  // another tree than the one shown, a step left undecided: refused
  assert.equal((await send(m, v, { kind: "finish_confirm", tree: "0".repeat(40), commit: v.confirm.commit, push: "confirm", qa: "confirm" })).code, "invalid_state");
  assert.equal((await send(m, v, { kind: "finish_confirm", tree: v.confirm.tree, commit: v.confirm.commit, push: "confirm", qa: null })).code, "invalid_command");
  // decided independently: no push, QA yes
  assert.equal((await send(m, v, { kind: "finish_confirm", tree: v.confirm.tree, commit: v.confirm.commit, push: "decline", qa: "confirm" })).status, "accepted");
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
  const last = (await records(m, runId)).at(-1);
  assert.deepEqual([last.type, last.data.status, last.data.completion.kind], ["run.status", "completed", "no_checks"]);
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
});

// ---------------- the flag ----------------

test("without the flag: a new run is written in v1 and its commands are required, as before", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]) }, { v2: false });
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

test("a decision recorded before the end, the run still on its pause: reopening writes paused(recovered); Resume continues", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  // one MOCK_STATE for both processes: the lead's session is resumed after the restart
  const env = { MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt", MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")) };
  const m = manager(env);
  const runId = await start(m, src, { commands: [] });
  const v = await settled(m, runId, "the proposal");
  assert.equal(v.reason, "awaiting_checks_decision");
  await m.shutdown();
  // the end came after the decision and its command.completed, before run.status(running) (the order of §2.4)
  const w = await openRun(m.root, runId);
  const st = w.state();
  const commandId = randomUUID();
  await w.recordCommand(commandId, "checks_decide", { expectedRevision: st.orch.revision, command: { kind: "checks_decide", decision: "accept" } });
  await w.recordEvent("checks.decided", { proposalTurnId: st.orch.checksProposal.turnId, decision: "accept", by: "person", commandId, checks: await w.putText(JSON.stringify({ checks: [{ id: "cmd-1", command: "grep -qx 2 a.txt", origin: "lead" }] })), count: 1 });
  await w.completeCommand(commandId, { status: "accepted", code: null });
  await w.close();
  const again = createRunManager({ platform: "darwin", root: m.root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providersFile(env), () => LAUNCH), journalV2: true });
  // any command opens it: the opening decides the pause first, so the stale revision says so
  const first = await send(again, await view(again, runId), { kind: "resume" });
  assert.deepEqual(first, { status: "rejected", code: "stale_revision" }, "opening wrote the pause");
  const r = await view(again, runId);
  assert.deepEqual([r.status, r.reason], ["paused", "recovered"]);
  const h = await records(again, runId);
  const at = h.findIndex((x) => x.type === "checks.decided");
  assert.deepEqual(h.slice(at + 1).filter((x) => x.type === "run.status").map((x) => [x.data.status, x.data.reason])[0], ["paused", "recovered"]);
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
    const { record, line } = buildRecord(prev, runId, r.ts, r.type, r.data, 2, prev === null ? { minReaderVersion: 2, formatPreview: true } : null);
    out.push(line);
    prev = record;
  }
  return Buffer.concat(out);
}
const corrupt = (buf, runId) => { const p = parseJournal(buf, runId); return p.integrity.status === "corrupt" ? [p.integrity.detail.code, p.records[p.records.length]?.type ?? JSON.parse(buf.toString().split("\n")[p.integrity.detail.line - 1]).type] : [p.integrity.status]; };

test("a completed run the completion function does not allow, and an autopilot acceptance while the network is open: replay_conflict", OPTS, async () => {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL]), MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "grep -qx 2 a.txt" });
  const runId = await start(m, src, { commands: [] });
  await send(m, await settled(m, runId, "the proposal"), { kind: "checks_decide", decision: "accept" });
  assert.equal((await settled(m, runId)).status, "completed");
  await m.shutdown();
  const buf = journalOf(m, runId);
  assert.equal(parseJournal(buf, runId).integrity.status, "ok");
  const last = (recs) => recs.at(-1);
  // completed "without checks" while it had checks; completed without the final review that completes it
  assert.deepEqual(corrupt(rewrite(buf, runId, (r) => { last(r).data.completion.kind = "no_checks"; return r; }), runId), ["replay_conflict", "run.status"]);
  assert.deepEqual(corrupt(rewrite(buf, runId, (r) => r.filter((x) => !(x.type === "review.recorded" && x.data.stage === null))), runId), ["replay_conflict", "run.status"]);
  // completed confirmed while the check failed
  assert.deepEqual(corrupt(rewrite(buf, runId, (r) => { for (const x of r) if (x.type === "check.finished") x.data.status = "failed", x.data.exitCode = 1; return r; }), runId)[0], "replay_conflict");
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
  const m = manager({ MOCK_SCRIPT: script([PLAN]), MOCK_CHECKS: "proposed" });
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
