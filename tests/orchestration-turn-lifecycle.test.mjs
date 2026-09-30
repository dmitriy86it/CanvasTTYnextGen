// Turn lifecycle after the CLI's answer: the supervisor relays stdout/stderr and alone judges how they ended
// (done.streams); main never races its own timer against the supervisor's cleanup. Real supervisor, inline CLIs
// (`node -e`), exec and session (codex app-server, claude host) paths. Asserts orderings and facts, not speed: time
// bounds are generous and only prove that a wait was cut short or stayed bounded.
// Every descendant appends its pid to PIDS once it is ready, lives at most 15 s, and is accounted for after each turn.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_TURN_LIMITS, startTurn } from "../src/main/services/orchestration/turn.ts";
import { claudeHostDriver, codexAppServerDriver } from "../src/main/services/orchestration/sessions.ts";
import { createActivityLog, endingDetail } from "../src/main/services/orchestration/activity.ts";
import { isValidEventData } from "../src/main/services/orchestration/journal.ts";
import { createRun, readRun } from "../src/main/services/orchestration/store.ts";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { pauseEnding } from "../src/renderer/src/features/orchestration/runModel.ts";
import { ProcLedger, assertNoneAlive, describe } from "./fixtures/orchestration/proc-ledger.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCH = Object.freeze({ command: process.execPath, args: [path.join(ROOT, "src/orchestration/supervisor.mjs")], env: {} });
const MARK = "CTTYLIFE-" + randomBytes(4).toString("hex");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${MARK}-`)));
const T = { timeout: 60_000 };
const FAST = { graceIntMs: 300, graceTermMs: 300, leftoverMs: 500 };
const SCHEMA = { type: "object", properties: { summary: { type: "string", minLength: 1 } }, required: ["summary"], additionalProperties: false };
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// kid(opts, then): a descendant; then() once it is ready. Default stdio "ignore". hold: inherits stdout+stderr;
// holdErr: only stderr; term: ignores SIGTERM; setsid: leaves the group.
const PRELUDE = `const fs=require("fs"),{spawn}=require("child_process");
const out=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");
const lines=()=>fs.readFileSync(process.env.PIDS,"utf8").split("\\n").filter(Boolean).length;
const kid=(o,then)=>{const n0=lines();
 const code=(o.term?"process.on('SIGTERM',()=>{});":"")+"require('fs').appendFileSync(process.env.PIDS,process.pid+String.fromCharCode(10));setTimeout(()=>{},15000);";
 const stdio=o.hold?["ignore","inherit","inherit"]:o.holdErr?["ignore","ignore","inherit"]:"ignore";
 spawn(process.execPath,["-e",code,${JSON.stringify(MARK)}],{stdio,detached:!!o.setsid}).unref();
 const iv=setInterval(()=>{if(lines()>n0){clearInterval(iv);then();}},10);};
`;
const ANSWER = {
  "exec-codex": `out({type:"thread.started",thread_id:"T1"});fs.writeFileSync(file,JSON.stringify({summary:"ok"}));out({type:"turn.completed"});`,
  "exec-claude": `out({type:"system",subtype:"init",session_id:"S1"});out({type:"result",subtype:"success",is_error:false,result:"t",session_id:"S1",structured_output:{summary:"ok"}});`,
  "session-codex": `out({method:"item/completed",params:{item:{type:"agentMessage",text:JSON.stringify({summary:"ok"})}}});out({method:"turn/completed",params:{turn:{id:"U1",status:"completed"}}});`,
  "session-claude": `out({type:"system",subtype:"init",session_id:"S1"});out({type:"result",subtype:"success",is_error:false,result:"t",session_id:"S1",structured_output:{summary:"ok"}});`
};
const KINDS = Object.keys(ANSWER);
const withKid = (k, body) => (k ? `kid(${JSON.stringify(k)},()=>{${body}});` : body);

let n = 0;
// body: CLI code after the prelude (exec) or run when the turn is asked (session); `file` = codex exec report path.
function mk(kind, body, { limits = {}, supervisor = FAST } = {}) {
  const pids = path.join(TMP, `pids-${++n}`);
  fs.writeFileSync(pids, "");
  const [mode, provider] = kind.split("-");
  const env = { PATH: process.env.PATH, PIDS: pids };
  const base = { provider, cwd: TMP, env, task: "", schema: SCHEMA, expectSessionId: null, limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: 20_000, ...limits } };
  if (supervisor) base.supervisor = supervisor;
  const onEnd = `rl.on("close",()=>process.exit(0));`;
  let spec;
  if (mode === "exec") {
    spec = { ...base, attemptDir: TMP, argv: [process.execPath, "-e", PRELUDE + "const file=process.argv[2];" + body, MARK, ...(provider === "codex" ? ["{REPORT_FILE}"] : [])] };
  } else if (provider === "codex") {
    const cli = PRELUDE + `const rl=require("readline").createInterface({input:process.stdin});${onEnd}
rl.on("line",(l)=>{const m=JSON.parse(l);if(m.method==="initialize")out({id:m.id,result:{}});
if(m.method==="thread/start")out({id:m.id,result:{thread:{id:"T1"}}});
if(m.method==="turn/start"){out({id:m.id,result:{turn:{id:"U1"}}});${body}}});`;
    spec = { ...base, argv: [process.execPath, "-e", cli, MARK],
      session: codexAppServerDriver({ cwd: TMP, task: "t", schema: SCHEMA, threadId: null, clientVersion: "test", ask: async () => { throw new Error("unexpected ask"); } }) };
  } else {
    const cli = PRELUDE + `const rl=require("readline").createInterface({input:process.stdin});${onEnd}
rl.on("line",(l)=>{const m=JSON.parse(l);if(m.type==="user"){${body}}});`;
    spec = { ...base, argv: [process.execPath, "-e", cli, MARK], session: claudeHostDriver({ task: "t", ask: async () => { throw new Error("unexpected ask"); } }) };
  }
  return { spec, pids };
}

const readPids = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);

// One turn to its result; observer(handle) may act on the turn. Then: invariants and no own process alive.
async function run(t, { spec, pids }, { observer = null, escapee = false } = {}) {
  const t0 = performance.now();
  let h = null;
  h = startTurn(spec, LAUNCH, observer ? observer(() => h) : undefined);
  let timer;
  const r = await Promise.race([h.result, new Promise((res) => { timer = setTimeout(res, 40_000, null); })]);
  clearTimeout(timer);
  const ms = Math.round(performance.now() - t0);
  const ledger = new ProcLedger(null);
  for (const p of readPids(pids)) ledger.track(p, escapee ? "escapee" : "descendant");
  if (escapee) for (const p of readPids(pids)) { try { process.kill(p, "SIGKILL"); } catch {} }
  assert.ok(r, "startTurn did not resolve in 40 s");
  ledger.track(r.pids.supervisor, "supervisor");
  ledger.track(r.pids.pgid, "group", { group: true });
  t.diagnostic(`${ms} ms: outcome=${r.outcome} transport=${r.transport.status}(${r.transport.reason}) stopCause=${r.stopCause} ending=${JSON.stringify(r.ending)}`);
  assert.equal(r.nextTurnAllowed, r.outcome === "completed");
  assert.equal(r.process.supervisorDone, true);
  assert.equal(r.process.groupCleared, true);
  assert.ok(!r.diagnostics.some((d) => /after_supervisor_exit/.test(d.what)), "main's last guard never fires with the relay");
  assert.ok(!JSON.stringify(r.ending).includes(TMP), "ending holds no paths");
  const lr = await assertNoneAlive(t, ledger, { ms: 3000, mark: MARK });
  t.diagnostic(`processes: ${describe(lr)}`);
  r.ms = ms;
  return r;
}
const evIndex = (r, ev) => r.timeline.findIndex((x) => x.ev === ev || x.ev.startsWith(ev));
const onLeaderExit = (fn) => (h) => ({ process: (e) => { if (e === "leader_exit") fn(h()); } });

// ---- success paths ----

for (const kind of KINDS) {
  test(`${kind}: clean exit without descendants -> completed, both streams eof, no group signal`, T, async (t) => {
    const r = await run(t, mk(kind, ANSWER[kind]));
    assert.deepEqual([r.outcome, r.ending.step, r.ending.streams], ["completed", "ok", { stdout: "eof", stderr: "eof" }]);
    assert.deepEqual(r.ending.signals, { leader: [], group: [] });
    assert.equal(r.ending.framing.count, 0);
    assert.ok(Number.isInteger(r.ending.ms.leaderExitToDone));
  });

  test(`${kind}: descendant with stdio "ignore" lingers after a valid answer -> completed, cleaned by SIGTERM`, T, async (t) => {
    const r = await run(t, mk(kind, withKid({}, ANSWER[kind])));
    assert.equal(r.outcome, "completed", JSON.stringify(r.diagnostics));
    assert.deepEqual([r.ending.streams, r.ending.signals.group], [{ stdout: "eof", stderr: "eof" }, ["SIGTERM"]]);
    // valid answer read while the supervisor was still cleaning up: terminal < leader exit < done
    assert.ok(evIndex(r, "terminal:") < evIndex(r, "sup:leader_exit"));
    assert.ok(evIndex(r, "sup:leader_exit") < evIndex(r, "sup:done"));
    assert.ok(r.ending.ms.leaderExitToStdoutEof <= r.ending.ms.leaderExitToDone, "stdout ended before the supervisor finished");
  });
}

test("exec-codex: descendant ignoring SIGTERM -> SIGKILL, bounded; streams were at EOF before cleanup -> completed", T, async (t) => {
  const r = await run(t, mk("exec-codex", withKid({ term: true }, ANSWER["exec-codex"])));
  assert.deepEqual([r.outcome, r.ending.signals.group], ["completed", ["SIGTERM", "SIGKILL"]]);
  assert.ok(r.ms < 20_000);
});

// ---- real holders: failure ----

for (const kind of ["exec-codex", "exec-claude", "session-codex", "session-claude"]) {
  test(`${kind}: descendant really holding stdout -> protocol_error stdout_held_open (held_until_cleanup)`, T, async (t) => {
    const r = await run(t, mk(kind, withKid({ hold: true }, ANSWER[kind])));
    assert.deepEqual([r.outcome, r.transport.reason, r.stopCause, r.process.stdoutEnded], ["protocol_error", "stdout_held_open", null, false]);
    assert.deepEqual([r.ending.step, r.ending.streams.stdout], ["stream_held_until_cleanup", "held_until_cleanup"]);
    assert.ok(r.ending.signals.group.includes("SIGTERM"));
  });
}

test("exec-codex: descendant holding only stderr -> protocol_error stderr_held_open", T, async (t) => {
  const r = await run(t, mk("exec-codex", withKid({ holdErr: true }, ANSWER["exec-codex"])));
  assert.deepEqual([r.outcome, r.transport.reason, r.ending.streams], ["protocol_error", "stderr_held_open", { stdout: "eof", stderr: "held_until_cleanup" }]);
});

test("exec-codex: setsid escapee holding stdout -> held_abandoned, main still gets EOF, bounded", T, async (t) => {
  const r = await run(t, mk("exec-codex", withKid({ hold: true, setsid: true }, ANSWER["exec-codex"])), { escapee: true });
  assert.deepEqual([r.outcome, r.transport.reason, r.ending.streams.stdout, r.ending.step], ["protocol_error", "stdout_held_open", "held_abandoned", "stream_held_abandoned"]);
  assert.deepEqual(r.ending.signals.group, [], "the group itself was already gone");
  assert.ok(r.ms < 20_000);
});

// ---- protocol failures with a lingering descendant ----

test("exec-codex: no terminal event, exit 0, lingering descendant -> protocol_error no_terminal_event", T, async (t) => {
  const r = await run(t, mk("exec-codex", withKid({}, `out({type:"thread.started",thread_id:"T1"});`)));
  assert.deepEqual([r.outcome, r.ending.step, r.ending.streams.stdout], ["protocol_error", "no_terminal_event", "eof"]);
});

test("session-codex: corrupted line before a valid answer -> protocol_error, framing code only", T, async (t) => {
  const r = await run(t, mk("session-codex", `process.stdout.write("{not json SECRETLINE\\n");` + withKid({}, ANSWER["session-codex"])));
  assert.deepEqual([r.outcome, r.ending.step, r.ending.framing], ["protocol_error", "protocol_parse", { count: 1, codes: ["invalid_json"] }]);
  assert.ok(!JSON.stringify(r.ending).includes("SECRETLINE"), "no stream content in ending");
});

// ---- Stop / timeout, during the answer and during cleanup; late events ----

for (const kind of ["exec-codex", "session-codex"]) {
  test(`${kind}: Stop during the answer -> stopped; Stop during cleanup -> stopped, leftover cut short`, T, async (t) => {
    const hang = kind.startsWith("exec") ? `out({type:"thread.started",thread_id:"T1"});setInterval(()=>{},1e3);` : `setInterval(()=>{},1e3);`;
    const a = await run(t, mk(kind, withKid({}, hang)), {
      observer: (h) => ({ frame: () => { setTimeout(() => h().stop(), 50); } })
    });
    assert.deepEqual([a.outcome, a.stopCause, a.ending.step, a.nextTurnAllowed], ["stopped", "user", "stop", false]);

    const leftoverMs = 15_000;
    const b = await run(t, mk(kind, withKid({}, ANSWER[kind]), { supervisor: { ...FAST, leftoverMs } }), { observer: onLeaderExit((h) => h.stop()) });
    assert.deepEqual([b.outcome, b.stopCause, b.nextTurnAllowed, b.ending.signals.group[0]], ["stopped", "user", false, "SIGTERM"]);
    assert.ok(b.ms < leftoverMs, "the Stop cut the leftover wait short");
  });

  test(`${kind}: timeout during the answer and during cleanup -> timeout, never a next turn`, T, async (t) => {
    const a = await run(t, mk(kind, "setInterval(()=>{},1e3);", { limits: { timeoutMs: 800 } }));
    assert.deepEqual([a.outcome, a.stopCause, a.ending.step], ["timeout", "timeout", "timeout"]);
    const leftoverMs = 15_000;
    const b = await run(t, mk(kind, withKid({}, ANSWER[kind]), { limits: { timeoutMs: 1500 }, supervisor: { ...FAST, leftoverMs } }));
    assert.deepEqual([b.outcome, b.stopCause, b.nextTurnAllowed, b.report.status], ["timeout", "timeout", false, "valid"]);
    assert.ok(b.ms < leftoverMs);
  });
}

test("exec-codex: a valid answer written after Stop / timeout never allows a next turn", T, async (t) => {
  // The CLI answers only when interrupted (SIGINT), then exits 0: late, complete, valid.
  const late = `out({type:"thread.started",thread_id:"T1"});process.on("SIGINT",()=>{fs.writeFileSync(file,JSON.stringify({summary:"late"}));out({type:"turn.completed"});process.exit(0);});setInterval(()=>{},1e3);`;
  const stopped = await run(t, mk("exec-codex", late), { observer: (h) => ({ frame: () => setTimeout(() => h().stop(), 50) }) });
  assert.deepEqual([stopped.outcome, stopped.nextTurnAllowed, stopped.terminal?.type], ["stopped", false, "turn.completed"]);
  const timedOut = await run(t, mk("exec-codex", late, { limits: { timeoutMs: 800 } }));
  assert.deepEqual([timedOut.outcome, timedOut.nextTurnAllowed, timedOut.terminal?.type], ["timeout", false, "turn.completed"]);
});

// ---- production timers: stdoutGraceMs = leftoverMs = 2000 (defaults, no spec.supervisor) ----

test("production timers: codex app-server answer + lingering stdio-ignore descendant -> completed (the field regression)", T, async (t) => {
  assert.equal(DEFAULT_TURN_LIMITS.stdoutGraceMs, 2000);
  const r = await run(t, mk("session-codex", withKid({}, ANSWER["session-codex"]), { supervisor: null }));
  assert.equal(r.outcome, "completed", JSON.stringify({ transport: r.transport, ending: r.ending }));
  assert.deepEqual([r.ending.streams, r.ending.signals.group], [{ stdout: "eof", stderr: "eof" }, ["SIGTERM"]]);
  assert.ok(r.ending.ms.leaderExitToDone >= 1500, "the supervisor really waited its leftover before cleaning up");
});

test("production timers: a descendant really holding stdout is still stdout_held_open", T, async (t) => {
  const r = await run(t, mk("session-codex", withKid({ hold: true }, ANSWER["session-codex"]), { supervisor: null }));
  assert.deepEqual([r.outcome, r.transport.reason, r.ending.streams.stdout], ["protocol_error", "stdout_held_open", "held_until_cleanup"]);
});

// ---- persistence: the ending goes into the turn_finished activity entry, flat; the journal record keeps its 1.5.5 keys ----

test("ending persisted: flat safe activity detail round-trips; turn.finished keeps exactly the 1.5.5 keys", T, async (t) => {
  const r = await run(t, mk("exec-codex", `process.stdout.write("{bad SECRETLINE\\n");` + withKid({ hold: true }, ANSWER["exec-codex"])));
  const detail = endingDetail(r.ending);
  assert.deepEqual([detail.endStep, detail.stdoutEnd, detail.groupSignals, detail.framingCodes], ["protocol_parse", "held_until_cleanup", "SIGTERM", "invalid_json"]);
  for (const [k, v] of Object.entries(detail)) assert.ok(v === null || typeof v === "string" || Number.isInteger(v), `${k} is a flat scalar`);
  for (const k of ["msTerminalToExit", "msExitToStdoutEof", "msExitToDone"]) assert.ok(Number.isInteger(detail[k]), k);
  assert.ok(!JSON.stringify(detail).includes("SECRETLINE") && !JSON.stringify(detail).includes(TMP), "no stream content, no paths");
  assert.deepEqual(endingDetail(undefined), {}, "a result without ending (no turn ran) adds nothing");

  const root = fs.mkdtempSync(path.join(TMP, "store-"));
  const runId = randomUUID(), turnId = randomUUID();
  const log = createActivityLog(root);
  await log.open(runId);
  log.append(runId, { role: "lead", provider: "codex", turnId, kind: "turn_finished", text: r.outcome, detail: { purpose: "plan", ...detail } });
  await log.page(runId, 0, 10);
  const back = await createActivityLog(root).page(runId, 0, 10); // a fresh process reading the file
  assert.deepEqual(back.entries[0].detail, { purpose: "plan", ...detail });

  const w = await createRun(root, runId, { goal: "g" });
  await w.setRunStatus("running", null);
  await w.recordTurnIntent({ turnId, commandId: null, role: "lead", provider: "codex", mode: "structured-readonly", sessionId: null, task: "t" });
  await w.recordTurnResult(turnId, { outcome: r.outcome, nextTurnAllowed: r.nextTurnAllowed, sessionId: r.sessionId, report: r.report,
    contract: { status: "verified", errors: [], expected: { sessionId: null }, actual: { sessionId: null } }, transport: r });
  await w.close();
  const rec = fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.type === "turn.finished");
  assert.deepEqual(Object.keys(rec.data).sort(), ["contract", "nextTurnAllowed", "outcome", "report", "sessionId", "transport", "turnId"]);
  assert.deepEqual(Object.keys(rec.data.transport).sort(), ["exitCode", "groupCleared", "outcome", "signal"]);
  // why not there: the record is checked key by key (1.5.5 has the same check), an extra field is refused
  assert.equal(isValidEventData("turn.finished", { ...rec.data, ending: detail }), false);
  assert.equal((await readRun(root, runId)).state.turns[turnId].status, "protocol_error");
});

// ---- end to end: the run manager puts the ending into the lead's turn_finished activity entry ----
// A native run (fake app-server CLIs as in orchestration-native.test.mjs) whose codex leaves a descendant behind on every
// app-server start: holding stdout (a real holder) or with stdout on /dev/null (the field regression). Production timers.

const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const FIXTURES = path.join(ROOT, "tests/fixtures/orchestration");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const until = async (fn, what, ms = 90_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) { const v = await fn(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
};

async function nativeRun(kidRedirect) {
  const dir = fs.mkdtempSync(path.join(TMP, "native-"));
  const src = path.join(dir, "project");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "README.md"), "project\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync(GIT, a, { cwd: src, env: GIT_ENV });
  // the descendant: same process group, 4 s at most; kidRedirect "" keeps the CLI's stdout (a real holder)
  const codex = path.join(dir, "codex");
  fs.writeFileSync(codex, `#!/bin/sh\nif [ "$1" = "app-server" ]; then /bin/sleep 4 ${kidRedirect} & fi\nexec "${NODE}" "${path.join(FIXTURES, "mock-codex.mjs")}" "$@"\n`, { mode: 0o755 });
  const claude = path.join(dir, "claude");
  fs.writeFileSync(claude, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, "mock-claude.mjs")}" "$@"\n`, { mode: 0o755 });
  const script = path.join(dir, "script");
  fs.mkdirSync(script);
  const answers = [{ stages: [{ title: "note", task: "add note.txt" }], question: null }, { summary: "done", done: true },
    { verdict: "accept", findings: [], question: null }, { verdict: "complete", findings: [], question: null }];
  answers.forEach((a, i) => fs.writeFileSync(path.join(script, `${i + 1}.json`), JSON.stringify(a)));
  const state = fs.mkdtempSync(path.join(dir, "state-"));
  const p = { path: `${dir}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: state, MOCK_SCRIPT: script } };
  const providers = path.join(dir, "providers.json");
  fs.writeFileSync(providers, JSON.stringify({
    codex: { executable: codex, version: "codex-cli 0.155.1", ...p }, claude: { executable: claude, version: "2.1.281 (Claude Code)", ...p },
    // A check executable must be its own real path; on Debian/Ubuntu /bin/sh is a symlink to dash.
    shell: fs.realpathSync("/bin/sh"), checkEnv: { PATH: "/usr/bin:/bin", HOME: TMP }
  }));
  const launch = { command: NODE, args: [path.join(ROOT, "src/orchestration/supervisor.mjs")], env: {} };
  const m = createRunManager({
    platform: "darwin", // the engine under test; the platform gate has its own tests
    root: path.join(dir, "root"), gitPath: () => GIT, launch: () => launch, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used by a native goal"); }, native: testNativeRuntime(providers, () => launch)
  });
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "add a note", criteria: ["note.txt exists"], checks: [], commands: ["true"], workMode: "project" } });
  assert.ok(r.ok, JSON.stringify(r));
  const view = await until(async () => { const v = (await m.get(runId)).value.view; return ["completed", "paused", "failed", "stopped"].includes(v.status) ? v : null; }, "the run to settle");
  const entries = (await m.activity(runId, 0, 1000)).value.entries;
  await m.shutdown();
  return { view, finished: entries.filter((e) => e.kind === "turn_finished"), entries };
}

test("run manager: a lead turn whose descendant held stdout pauses the run; its turn_finished says stream_held_until_cleanup", { timeout: 120_000 }, async (t) => {
  const { view, finished, entries } = await nativeRun("");
  t.diagnostic(`${view.status}/${view.reason}: ${JSON.stringify(finished.map((e) => [e.role, e.text, e.detail?.endStep, e.detail?.stdoutEnd]))}`);
  assert.deepEqual([view.status, view.reason], ["paused", "protocol_error"]);
  const lead = finished.find((e) => e.role === "lead");
  assert.equal(lead.text, "protocol_error");
  assert.deepEqual([lead.detail.endStep, lead.detail.stdoutEnd, lead.detail.stderrEnd, lead.detail.groupSignals], ["stream_held_until_cleanup", "held_until_cleanup", "held_until_cleanup", "SIGTERM"]); // sh gave it both streams
  assert.ok(Number.isInteger(lead.detail.msExitToDone));
  assert.equal(pauseEnding(view, entries), "stream_held_until_cleanup", "what the panel shows as the reason");
});

test("run manager: the same run with the descendant's stdout on /dev/null completes; every turn_finished says ok", { timeout: 120_000 }, async (t) => {
  const { view, finished } = await nativeRun(">/dev/null 2>&1 </dev/null");
  t.diagnostic(`${view.status}/${view.reason}: ${JSON.stringify(finished.map((e) => [e.role, e.text, e.detail?.endStep, e.detail?.groupSignals]))}`);
  assert.equal(view.status, "completed", JSON.stringify(view.reason));
  const codexTurns = finished.filter((e) => e.provider === "codex");
  assert.ok(codexTurns.length >= 2);
  for (const e of codexTurns) assert.deepEqual([e.text, e.detail.endStep, e.detail.stdoutEnd, e.detail.groupSignals], ["completed", "ok", "eof", "SIGTERM"]);
});

// ---- the relay never drops bytes; what main reads is checked against what the supervisor wrote ----

const bigBody = (n, pad) => `let i=0;const next=()=>{while(i<${n}){if(!process.stdout.write(JSON.stringify({type:"item.completed",i:i++,pad:"${pad}".repeat(1000)})+"\\n"))return process.stdout.once("drain",next);}${ANSWER["exec-codex"]}};next();`;
const bigBytes = (n, pad) => {
  const line = (o) => Buffer.byteLength(JSON.stringify(o) + "\n");
  let b = line({ type: "thread.started", thread_id: "T1" }) + line({ type: "turn.completed" });
  for (let i = 0; i < n; i++) b += line({ type: "item.completed", i, pad: pad.repeat(1000) });
  return b;
};

test("main busy for 3 s at the leader's exit with output still in flight -> completed, every byte (no timed cut of the relay)", T, async (t) => {
  const r = await run(t, mk("exec-codex", bigBody(1000, "y")), {
    observer: () => ({ process: (ev) => { if (ev === "leader_exit") { const end = Date.now() + 3000; while (Date.now() < end); } } })
  });
  assert.deepEqual([r.outcome, r.ending.step, r.ending.streams.stdout], ["completed", "ok", "eof"]);
  assert.equal(r.counters.stdoutBytes, bigBytes(1000, "y"));
});

test("large output (~30 MB) -> completed, every byte read, main's count equals the supervisor's", T, async (t) => {
  const r = await run(t, mk("exec-codex", bigBody(30_000, "z")));
  assert.deepEqual([r.outcome, r.ending.step], ["completed", "ok"]);
  assert.equal(r.counters.stdoutBytes, bigBytes(30_000, "z"));
  assert.ok(!r.diagnostics.some((d) => d.what === "relay_incomplete"));
});

// A launch wrapper that runs the real supervisor and alters its `done` line: what main must do when the supervisor's
// byte count disagrees with what main read, or the supervisor reports a failed relay.
const TAMPER = path.join(TMP, "tamper.mjs");
fs.writeFileSync(TAMPER, `import { spawn } from "node:child_process"; import fs from "node:fs";
const mode = process.argv[2];
const c = spawn(process.execPath, process.argv.slice(3), { stdio: ["inherit", "inherit", "inherit", "pipe", 4] });
let buf = ""; c.stdio[3].setEncoding("utf8").on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { let l = buf.slice(0, i); buf = buf.slice(i + 1);
  const m = JSON.parse(l); if (m.ev === "done" && m.streams) { if (mode === "bytes") m.streams.stdout.bytes += 1; else m.streams.stdout.status = "relay_failed"; l = JSON.stringify(m); }
  fs.writeSync(3, l + "\\n"); } });
c.on("exit", (code) => process.exit(code ?? 1));
`);
for (const [mode, step] of [["bytes", "relay_incomplete"], ["status", "relay_failed"]]) {
  test(`supervisor says ${step} -> harness_error, step ${step} (the application's failure, not the CLI's), never a next turn`, T, async (t) => {
    const { spec, pids } = mk("exec-codex", ANSWER["exec-codex"]);
    const launch = { command: process.execPath, args: [TAMPER, mode, path.join(ROOT, "src/orchestration/supervisor.mjs")], env: {} };
    const r = await startTurn(spec, launch).result;
    assert.deepEqual([r.outcome, r.ending.step, r.nextTurnAllowed, r.transport.status], ["harness_error", step, false, "completed"]);
    const ledger = new ProcLedger(null);
    for (const p of readPids(pids)) ledger.track(p, "descendant");
    if (r.pids.pgid) ledger.track(r.pids.pgid, "group", { group: true });
    await assertNoneAlive(t, ledger, { ms: 3000, mark: MARK });
  });
}

test("endingDetail keeps frame codes with digits (invalid_utf8), and nothing that is not an enum-like word", () => {
  const d = endingDetail({ step: "protocol_parse", streams: { stdout: "eof", stderr: "eof" }, ms: {}, signals: { leader: [], group: [] },
    framing: { count: 2, codes: ["invalid_utf8", "Bad Code!"] }, counts: { frames: 1 } });
  assert.deepEqual([d.endStep, d.framingCodes, d.framingErrors], ["protocol_parse", "invalid_utf8", 2]);
});

test("main busy at the leader's exit, lingering stdio-ignore descendant, output in flight -> completed, not held (production timers)", T, async (t) => {
  const r = await run(t, mk("exec-codex", withKid({}, bigBody(1000, "w")), { supervisor: null }), {
    observer: () => ({ process: (ev) => { if (ev === "leader_exit") { const end = Date.now() + 3000; while (Date.now() < end); } } })
  });
  assert.deepEqual([r.outcome, r.ending.streams, r.ending.signals.group[0]], ["completed", { stdout: "eof", stderr: "eof" }, "SIGTERM"]);
  assert.equal(r.counters.stdoutBytes, bigBytes(1000, "w"));
});

// ---- round 2: after the leader's exit the supervisor reads the target side at once (capped): statuses never depend on
// main's pace, and a holder that keeps writing is judged by the cleanup like any holder ----

test("large final output of the leader, main slow (2 ms per frame) -> completed, every byte, no false hold", T, async (t) => {
  const r = await run(t, mk("exec-codex", bigBody(1500, "v"), { supervisor: null }), {
    observer: () => ({ frame: () => { const end = Date.now() + 2; while (Date.now() < end); } })
  });
  assert.deepEqual([r.outcome, r.ending.streams, r.ending.counts.cappedStreams], ["completed", { stdout: "eof", stderr: "eof" }, 0]);
  assert.equal(r.counters.stdoutBytes, bigBytes(1500, "v"));
});

// The flood starts once the leader is gone: two writers on one pipe would interleave lines (a framing error first).
test("a group member flooding stdout after the leader's exit passes the read cap -> capped, held_until_cleanup, bounded", T, async (t) => {
  const flood = `spawn(process.execPath,["-e","require('fs').appendFileSync(process.env.PIDS,process.pid+String.fromCharCode(10));const s=JSON.stringify({type:'x',pad:'x'.repeat(4096)})+String.fromCharCode(10);const w=()=>{while(process.stdout.write(s));};process.stdout.on('drain',w);const pp=process.ppid;const iv=setInterval(()=>{try{process.kill(pp,0)}catch{clearInterval(iv);w();}},5);setTimeout(()=>{},15000);",${JSON.stringify(MARK)}],{stdio:["ignore","inherit","ignore"]}).unref();`;
  const r = await run(t, mk("exec-codex", `${flood}const iv=setInterval(()=>{if(lines()>0){clearInterval(iv);${ANSWER["exec-codex"]}}},10);`, { supervisor: null }));
  assert.equal(r.outcome, "protocol_error");
  assert.deepEqual([r.ending.step, r.ending.streams.stdout, r.ending.counts.cappedStreams, r.ending.signals.group[0]],
    ["stream_held_until_cleanup", "held_until_cleanup", 1, "SIGTERM"]);
  assert.ok(r.ms < 20_000);
});

// the stream wait (group gone, a setsid escapee still holds stdout): leftover 500 ms, then up to STREAM_WAIT 1000 ms
for (const how of ["stop", "timeout"]) {
  test(`${how} during the stream wait ends it early; the stream is held_abandoned, never completed`, T, async (t) => {
    const holder = withKid({ hold: true, setsid: true }, ANSWER["exec-codex"]);
    const limits = how === "timeout" ? { timeoutMs: 1500 } : {};
    const spec = mk("exec-codex", holder, { limits, supervisor: { ...FAST, leftoverMs: 500 } });
    const observer = how === "stop" ? onLeaderExit((h) => setTimeout(() => h.stop(), 900)) : null;
    const r = await run(t, spec, { escapee: true, observer });
    assert.deepEqual([r.outcome, r.nextTurnAllowed, r.ending.streams.stdout], [how === "stop" ? "stopped" : "timeout", false, "held_abandoned"]);
    if (how === "stop") assert.ok(r.ending.ms.leaderExitToDone < 1400, `stream wait cut short: ${r.ending.ms.leaderExitToDone} ms`);
  });
}

// ---- round 3: labels ----

test("R3-1: a group member floods past the read cap after the leader's exit and dies without a group signal -> held_capped, not 'outside the group'", T, async (t) => {
  const flood = `spawn(process.execPath,["-e","require('fs').appendFileSync(process.env.PIDS,process.pid+String.fromCharCode(10));const s=JSON.stringify({type:'x',pad:'x'.repeat(4096)})+String.fromCharCode(10);const w=()=>{while(process.stdout.write(s));};process.stdout.on('drain',w);const pp=process.ppid;const iv=setInterval(()=>{try{process.kill(pp,0)}catch{clearInterval(iv);w();}},5);",${JSON.stringify(MARK)}],{stdio:["ignore","inherit","ignore"]}).unref();`;
  // Its writes block once the supervisor stops reading, so it cannot exit by itself: it dies outside the supervisor's
  // cleanup (the test kills it 500 ms after the leader's exit, long before the 2 s leftover wait ends).
  const spec = mk("exec-codex", `${flood}const iv=setInterval(()=>{if(lines()>0){clearInterval(iv);${ANSWER["exec-codex"]}}},10);`, { supervisor: null });
  const r = await run(t, spec, { observer: onLeaderExit(() => setTimeout(() => { for (const p of readPids(spec.pids)) { try { process.kill(p, "SIGKILL"); } catch {} } }, 500)) });
  assert.equal(r.outcome, "protocol_error");
  assert.deepEqual([r.ending.step, r.ending.streams.stdout, r.ending.counts.cappedStreams, r.ending.signals.group], ["stream_held_capped", "held_capped", 1, []]);
});

test("R3-2: a broken last line written by the CLI stays protocol_parse even while a descendant holds stdout", T, async (t) => {
  const r = await run(t, mk("exec-codex", withKid({ hold: true }, `${ANSWER["exec-codex"]}process.stdout.write('{"partial');`)));
  assert.deepEqual([r.outcome, r.ending.step, r.ending.streams.stdout, r.ending.counts.cappedStreams, r.ending.framing.codes],
    ["protocol_error", "protocol_parse", "held_until_cleanup", 0, ["unterminated_tail"]]);
});
