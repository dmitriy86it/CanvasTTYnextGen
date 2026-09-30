// Independent review: the turn lifecycle after the CLI's answer (false protocol_error / stdout_held_open).
// Black box through startTurn's result, with the real supervisor. The regression cases run at PRODUCTION timers:
// no spec.supervisor, limits = DEFAULT_TURN_LIMITS (stdoutGraceMs 2000). Bounds are generous (< 20 s), never ratios.
// Every descendant writes its own pid to RVW_PIDS once it is ready (SIGTERM handler installed), the CLI waits for it
// before answering, and lives at most 15 s whatever happens; all of them are accounted for after each turn.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_TURN_LIMITS, startTurn } from "../src/main/services/orchestration/turn.ts";
import { claudeHostDriver, codexAppServerDriver } from "../src/main/services/orchestration/sessions.ts";
import { ProcLedger, assertNoneAlive, describe } from "./fixtures/orchestration/proc-ledger.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCH = Object.freeze({ command: process.execPath, args: [path.join(ROOT, "src/orchestration/supervisor.mjs")], env: {} });
const MARK = "RVWLIFE-" + randomBytes(4).toString("hex");
const SECRET = "sk-RVWSECRET-" + randomBytes(6).toString("hex");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${MARK}-`)));
const BOUND = 20_000;
const T = { timeout: 90_000 };
const SCHEMA = { type: "object", properties: { summary: { type: "string", minLength: 1 } }, required: ["summary"], additionalProperties: false };
const PROD = DEFAULT_TURN_LIMITS; // stdoutGraceMs 2000, no spec.supervisor => supervisor defaults
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// CLI prelude (CommonJS, node -e). kid({hold, term, setsid}, then): starts a descendant, calls then() once it is ready.
// hold: inherits the CLI's stdout/stderr; otherwise stdio "ignore". term: ignores SIGTERM. setsid: leaves the group.
const PRELUDE = `const fs=require("fs"),{spawn}=require("child_process");
const out=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");
const F=process.env.RVW_PIDS;const lines=()=>fs.readFileSync(F,"utf8").split("\\n").filter(Boolean).length;
const kid=(o,then)=>{const n0=lines();
 const code=(o.term?"process.on('SIGTERM',()=>{});":"")+"require('fs').appendFileSync(process.env.RVW_PIDS,process.pid+String.fromCharCode(10));setTimeout(()=>{},15000);";
 const c=spawn(process.execPath,["-e",code,${JSON.stringify(MARK)}],{stdio:o.hold?["ignore","inherit","inherit"]:"ignore",detached:!!o.setsid});c.unref();
 const iv=setInterval(()=>{if(lines()>n0){clearInterval(iv);then();}},10);};
`;
const kidCall = (k, then) => (k ? `kid(${JSON.stringify(k)},()=>{${then}});` : then);

const ANSWER = { codex: (file = "file") => `out({type:"thread.started",thread_id:"T1"});fs.writeFileSync(${file},JSON.stringify({summary:"ok"}));out({type:"turn.completed"});`,
  claude: (so = `{summary:"ok"}`) => `out({type:"system",subtype:"init",session_id:"S1"});out({type:"result",subtype:"success",is_error:false,result:"t",session_id:"S1",structured_output:${so}});` };

let n = 0;
// kind: exec-codex | exec-claude | session-codex | session-claude. body: CLI code after the prelude (exec) or the
// code run when the turn is asked (session); `file` is the codex exec report path.
function mk(kind, body, over = {}) {
  const pids = path.join(TMP, `pids-${++n}`);
  fs.writeFileSync(pids, "");
  const [mode, provider] = kind.split("-");
  const cwd = over.cwd ?? TMP;
  const env = { PATH: process.env.PATH, RVW_PIDS: pids, ...over.env };
  let spec;
  if (mode === "exec") {
    spec = {
      provider, argv: [process.execPath, "-e", PRELUDE + `const file=process.argv[2];` + body, MARK, ...(provider === "codex" ? ["{REPORT_FILE}"] : [])],
      cwd, env, task: "", schema: SCHEMA, attemptDir: TMP, expectSessionId: null
    };
  } else if (provider === "codex") {
    const cli = PRELUDE + `const rl=require("readline").createInterface({input:process.stdin});
rl.on("line",(l)=>{const m=JSON.parse(l);if(m.method==="initialize")out({id:m.id,result:{}});
if(m.method==="thread/start")out({id:m.id,result:{thread:{id:"T1"}}});
if(m.method==="turn/start"){out({id:m.id,result:{turn:{id:"U1"}}});${body}}});`;
    spec = {
      provider, argv: [process.execPath, "-e", cli], cwd, env, task: "", schema: SCHEMA, expectSessionId: null,
      session: codexAppServerDriver({ cwd, task: "t", schema: SCHEMA, threadId: null, clientVersion: "review", ask: async () => { throw new Error("unexpected ask"); } })
    };
  } else {
    const cli = PRELUDE + `const rl=require("readline").createInterface({input:process.stdin});
rl.on("line",(l)=>{const m=JSON.parse(l);if(m.type==="user"){${body}}});`;
    spec = {
      provider, argv: [process.execPath, "-e", cli], cwd, env, task: "", schema: SCHEMA, expectSessionId: null,
      session: claudeHostDriver({ task: "t", ask: async () => { throw new Error("unexpected ask"); } })
    };
  }
  spec.limits = { ...PROD, ...over.limits };
  if (over.supervisor) spec.supervisor = over.supervisor;
  return { spec, pids };
}
const codexSessionAnswer = `out({method:"item/completed",params:{item:{type:"agentMessage",text:JSON.stringify({summary:"ok"})}}});out({method:"turn/completed",params:{turn:{id:"U1",status:"completed"}}});`;
const answerFor = (kind) => ({ "exec-codex": ANSWER.codex(), "exec-claude": ANSWER.claude(), "session-codex": codexSessionAnswer, "session-claude": ANSWER.claude() })[kind];

const readPids = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);

// Runs one turn; hooks(getHandle) returns an observer. Bounded: the result must come within BOUND ms.
async function go(t, { spec, pids }, { observer = null, during = null, escapee = false } = {}) {
  const t0 = performance.now();
  let h = null;
  h = startTurn(spec, LAUNCH, observer ? observer(() => h) : undefined);
  if (during) during(h);
  let timer;
  const r = await Promise.race([h.result, new Promise((res) => { timer = setTimeout(res, BOUND, null); })]);
  clearTimeout(timer);
  const ms = Math.round(performance.now() - t0);
  const ledger = new ProcLedger(null);
  for (const p of readPids(pids)) ledger.track(p, escapee ? "escapee" : "descendant");
  if (r) { ledger.track(r.pids.supervisor, "supervisor"); ledger.track(r.pids.pgid, "group", { group: true }); }
  if (!r) {
    h.stop();
    await Promise.race([h.result, sleep(15_000)]);
    ledger.killOwn();
    assert.fail(`startTurn did not resolve within ${BOUND} ms`);
  }
  t.diagnostic(`${ms} ms: outcome=${r.outcome} transport=${r.transport.status}(${r.transport.reason}) stopCause=${r.stopCause} report=${r.report.status} ` +
    `groupCleared=${r.process.groupCleared} supExit=${r.process.supervisorExitCode} stdoutEnded=${r.process.stdoutEnded} diag=[${r.diagnostics.map((d) => d.what).join(",")}]` +
    ` new=${JSON.stringify(newFields(r))}`);
  if (escapee) for (const p of readPids(pids)) { try { process.kill(p, "SIGKILL"); } catch {} }
  const lr = await assertNoneAlive(t, ledger, { ms: 3000, mark: MARK });
  t.diagnostic(`processes: ${describe(lr)}`);
  assert.ok(ms < BOUND, `bounded: ${ms} ms`);
  assert.equal(r.nextTurnAllowed, r.outcome === "completed", "nextTurnAllowed iff completed");
  if (r.outcome === "completed") assertCleanSuccess(r);
  return { r, ms };
}

// Success is only this: terminal event, valid report, delivery ok, group cleared, supervisor exit 0, streams closed by themselves.
function assertCleanSuccess(r) {
  assert.equal(r.transport.status, "completed");
  assert.ok(r.terminal, "a terminal event");
  assert.equal(r.report.status, "valid");
  assert.equal(r.delivery.status, "ok");
  assert.equal(r.stopCause, null);
  assert.equal(r.process.groupCleared, true);
  assert.equal(r.process.supervisorExitCode, 0);
  assert.equal(r.process.stdoutEnded, true);
  assert.equal(r.process.exitCode, 0);
}
const assertNotCompleted = (r) => { assert.notEqual(r.outcome, "completed"); assert.equal(r.nextTurnAllowed, false); };

// Fields the baseline TurnResult does not have: where the fix's compact lifecycle diagnostic must live.
const BASE_TOP = new Set(["outcome", "transport", "report", "delivery", "sessionId", "sessionEvent", "sessionMismatch", "stopCause", "nextTurnAllowed",
  "process", "counters", "history", "terminal", "errors", "stderr", "diagnostics", "timeline", "pids", "reportFile"]);
const BASE_PROCESS = new Set(["exitCode", "signal", "stdoutEnded", "signalsToLeader", "groupCleared", "supervisorExitCode", "supervisorDone"]);
const BASE_TRANSPORT = new Set(["status", "reason"]);
function newFields(r) {
  const pick = (o, base) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !base.has(k)));
  const o = { ...pick(r, BASE_TOP) };
  const p = pick(r.process, BASE_PROCESS), tr = pick(r.transport, BASE_TRANSPORT);
  if (Object.keys(p).length) o["process."] = p;
  if (Object.keys(tr).length) o["transport."] = tr;
  return o;
}

const KINDS = ["exec-codex", "exec-claude", "session-codex", "session-claude"];

// ---- control ----

for (const kind of KINDS) {
  test(`${kind}, production timers: plain answer, no descendant -> completed`, T, async (t) => {
    const { r } = await go(t, mk(kind, answerFor(kind)));
    assert.equal(r.outcome, "completed", JSON.stringify(r.diagnostics));
  });
}

// ---- the regression: a descendant that does not hold the output ----

for (const kind of KINDS) {
  test(`${kind}, production timers: lingering descendant with stdio ignore -> completed after bounded cleanup`, T, async (t) => {
    const { r } = await go(t, mk(kind, kidCall({}, answerFor(kind))));
    assert.equal(r.outcome, "completed", `${r.transport.reason} ${JSON.stringify(r.diagnostics)}`);
  });
}

for (const kind of ["exec-codex", "session-codex"]) {
  test(`${kind}, production timers: stdio-ignore descendant that ignores SIGTERM -> completed, killed, bounded`, T, async (t) => {
    const { r } = await go(t, mk(kind, kidCall({ term: true }, answerFor(kind))));
    assert.equal(r.outcome, "completed", `${r.transport.reason} ${JSON.stringify(r.diagnostics)}`);
  });
}

test("exec-codex, production timers: several ignore-descendants + large output: every byte reaches main, completed", T, async (t) => {
  const N = 400, pad = "x".repeat(10_000);
  const body = kidCall({}, kidCall({}, `for(let i=0;i<${N};i++)out({type:"item.completed",i,pad:${JSON.stringify(pad)}});process.stderr.write("E".repeat(300000));${ANSWER.codex()}`));
  const { r } = await go(t, mk("exec-codex", body));
  const line = (o) => Buffer.byteLength(JSON.stringify(o) + "\n");
  const expected = line({ type: "thread.started", thread_id: "T1" }) + line({ type: "turn.completed" }) +
    Array.from({ length: N }, (_, i) => line({ type: "item.completed", i, pad })).reduce((a, b) => a + b, 0);
  assert.equal(r.counters.stdoutBytes, expected, "no stdout byte lost or added");
  assert.equal(r.counters.frames, N + 2);
  assert.equal(r.counters.stderrBytes, 300_000, "no stderr byte lost");
  assert.equal(r.outcome, "completed");
});

// ---- descendants that really hold the output ----

for (const kind of ["exec-codex", "exec-claude", "session-codex"]) {
  test(`${kind}, production timers: descendant inherits stdout and survives the leader -> not completed (stdout_held_open), group cleared`, T, async (t) => {
    const { r } = await go(t, mk(kind, kidCall({ hold: true }, answerFor(kind))));
    assertNotCompleted(r);
    assert.deepEqual([r.outcome, r.transport.status, r.transport.reason], ["protocol_error", "protocol_error", "stdout_held_open"]);
    assert.equal(r.process.groupCleared, true);
  });
}

test("exec-codex, production timers: stdout holder that ignores SIGTERM (needs SIGKILL) -> not completed, bounded", T, async (t) => {
  const { r } = await go(t, mk("exec-codex", kidCall({ hold: true, term: true }, answerFor("exec-codex"))));
  assertNotCompleted(r);
  assert.deepEqual([r.transport.status, r.transport.reason], ["protocol_error", "stdout_held_open"]);
  assert.equal(r.process.groupCleared, true);
});

test("exec-codex: stdout holder killed quickly by the supervisor's cleanup (leftoverMs 100) -> still not completed", T, async (t) => {
  // The holder's EOF comes only because cleanup killed it: output did not close by itself.
  const { r } = await go(t, mk("exec-codex", kidCall({ hold: true }, answerFor("exec-codex")), { supervisor: { leftoverMs: 100 } }));
  assertNotCompleted(r);
  assert.deepEqual([r.transport.status, r.transport.reason], ["protocol_error", "stdout_held_open"]);
});

test("exec-codex, production timers: setsid escapee holding stdout -> not completed, bounded", T, async (t) => {
  const { r } = await go(t, mk("exec-codex", kidCall({ hold: true, setsid: true }, answerFor("exec-codex"))), { escapee: true });
  assertNotCompleted(r);
  assert.equal(r.transport.status, "protocol_error");
});

// ---- protocol failures stay failures (also with a harmless lingering descendant) ----

const PROTO = {
  "missing terminal": `out({type:"thread.started",thread_id:"T1"});fs.writeFileSync(file,JSON.stringify({summary:"ok"}));`,
  "corrupted JSONL line": `out({type:"thread.started",thread_id:"T1"});process.stdout.write("{not json\\n");fs.writeFileSync(file,JSON.stringify({summary:"ok"}));out({type:"turn.completed"});`,
  "two terminal events": `out({type:"thread.started",thread_id:"T1"});fs.writeFileSync(file,JSON.stringify({summary:"ok"}));out({type:"turn.completed"});out({type:"turn.completed"});`,
  "event after terminal": `out({type:"thread.started",thread_id:"T1"});fs.writeFileSync(file,JSON.stringify({summary:"ok"}));out({type:"turn.completed"});out({type:"item.completed"});`,
  "unterminated tail": `out({type:"thread.started",thread_id:"T1"});fs.writeFileSync(file,JSON.stringify({summary:"ok"}));out({type:"turn.completed"});process.stdout.write("{}");`
};
for (const [what, body] of Object.entries(PROTO)) {
  for (const k of [null, {}]) {
    test(`exec-codex, production timers: ${what}${k ? " + ignore-descendant" : ""} -> protocol_error`, T, async (t) => {
      const { r } = await go(t, mk("exec-codex", kidCall(k, body)));
      assertNotCompleted(r);
      assert.equal(r.outcome, "protocol_error");
    });
  }
}

test("session-codex, production timers: turn ends without turn/completed (EOF) + ignore-descendant -> not completed", T, async (t) => {
  const body = kidCall({}, `out({method:"item/completed",params:{item:{type:"agentMessage",text:JSON.stringify({summary:"ok"})}}});process.stdin.destroy();process.exitCode=0;rl.close();`);
  const { r } = await go(t, mk("session-codex", body));
  assertNotCompleted(r);
});

// ---- invalid answers ----

for (const kind of KINDS) {
  test(`${kind}, production timers: schema mismatch + ignore-descendant -> invalid_report`, T, async (t) => {
    const bad = { "exec-codex": ANSWER.codex().replace(`{summary:"ok"}`, `{summary:""}`), "exec-claude": ANSWER.claude(`{summary:""}`),
      "session-codex": codexSessionAnswer.replace(`{summary:"ok"}`, `{summary:""}`), "session-claude": ANSWER.claude(`{summary:""}`) }[kind];
    const { r } = await go(t, mk(kind, kidCall({}, bad)));
    assertNotCompleted(r);
    assert.deepEqual([r.outcome, r.report.status], ["invalid_report", "schema_mismatch"]);
  });
}

// ---- Stop / timeout ----
// Contract (turn.ts decideOutcome, reconcile in jsonl.ts): a Stop or timeout that main issued wins over any result,
// even a valid one received before it ("stopped" / "timeout", nextTurnAllowed false). A Stop issued after the
// supervisor's `done` is ignored by startTurn; the tests below issue it strictly before that.

const HOLD = "setInterval(()=>{},1e3);";
const afterFirstFrame = (getH) => ({ frame: () => getH()?.stop() });

for (const kind of ["exec-codex", "session-codex"]) {
  test(`${kind}: Stop during the answer -> stopped, no next turn`, T, async (t) => {
    const body = kind === "exec-codex" ? `out({type:"thread.started",thread_id:"T1"});${HOLD}` : `out({method:"turn/started",params:{}});`;
    const { r } = await go(t, mk(kind, body), { observer: afterFirstFrame });
    assertNotCompleted(r);
    assert.deepEqual([r.outcome, r.stopCause], ["stopped", "user"]);
  });
}

for (const kind of ["exec-codex", "session-codex", "exec-claude"]) {
  test(`${kind}, production timers: Stop during cleanup (after the answer, a SIGTERM-ignoring descendant lingers) -> stopped`, T, async (t) => {
    const { r } = await go(t, mk(kind, kidCall({ term: true }, answerFor(kind))), {
      observer: (getH) => ({ process: (ev) => { if (ev === "leader_exit") getH()?.stop(); } })
    });
    assert.equal(r.stopCause, "user", "the Stop was issued before done");
    assertNotCompleted(r);
    assert.equal(r.outcome, "stopped");
    assert.equal(r.process.groupCleared, true);
  });
}

test("exec-codex: timeout during the answer -> timeout", T, async (t) => {
  const { r } = await go(t, mk("exec-codex", `out({type:"thread.started",thread_id:"T1"});${HOLD}`, { limits: { timeoutMs: 800 } }));
  assertNotCompleted(r);
  assert.deepEqual([r.outcome, r.stopCause], ["timeout", "timeout"]);
});

test("exec-codex, production supervisor timers: timeout during cleanup (SIGTERM-ignoring descendant) -> timeout if it fired, never a stopped-then-completed", T, async (t) => {
  const { r } = await go(t, mk("exec-codex", kidCall({ term: true }, answerFor("exec-codex")), { limits: { timeoutMs: 1500 } }));
  const fired = r.timeline.some((x) => x.ev === "stop:timeout");
  t.diagnostic(`timeout fired during cleanup: ${fired}`);
  if (fired) { assertNotCompleted(r); assert.equal(r.outcome, "timeout"); }
  else assert.equal(r.outcome, "completed");
});

// ---- late frames after Stop / timeout never enable a next turn ----

const LATE = `out({type:"thread.started",thread_id:"T1"});process.on("SIGINT",()=>{fs.writeFileSync(file,JSON.stringify({summary:"late"}));out({type:"turn.completed"});process.exitCode=0;clearInterval(iv2);});const iv2=setInterval(()=>{},1e3);`;
test("exec-codex: valid answer + terminal sent in reaction to Stop -> stopped, no next turn", T, async (t) => {
  const { r } = await go(t, mk("exec-codex", LATE), { observer: afterFirstFrame });
  assertNotCompleted(r);
  assert.deepEqual([r.outcome, r.stopCause], ["stopped", "user"]);
});
test("exec-codex: valid answer + terminal sent in reaction to the timeout's SIGINT (+ ignore-descendant) -> timeout", T, async (t) => {
  const { r } = await go(t, mk("exec-codex", kidCall({}, LATE), { limits: { timeoutMs: 800 } }));
  assertNotCompleted(r);
  assert.deepEqual([r.outcome, r.stopCause], ["timeout", "timeout"]);
});
test("session-codex: answer + turn/completed sent after the interrupt -> stopped, no next turn", T, async (t) => {
  const body = `out({method:"turn/started",params:{}});`;
  const cli = mk("session-codex", body);
  // The mock answers on the driver's interrupt request (turn/interrupt) too.
  cli.spec.argv = [cli.spec.argv[0], "-e", cli.spec.argv[2].replace(`if(m.method==="turn/start")`, `if(m.method==="turn/interrupt"){${codexSessionAnswer}}if(m.method==="turn/start")`)];
  const { r } = await go(t, cli, { observer: afterFirstFrame });
  assertNotCompleted(r);
  assert.equal(r.stopCause, "user");
});

// ---- diagnostics safety ----

function assertSafeDiagnostic(r, secretPath) {
  const added = newFields(r);
  assert.ok(Object.keys(added).length > 0, "the fix adds a compact lifecycle diagnostic field to TurnResult (none found)");
  const text = JSON.stringify(added);
  assert.ok(text.length < 2048, `compact: ${text.length} bytes`);
  for (const bad of [SECRET, secretPath, TMP, process.env.HOME]) assert.ok(!text.includes(bad), `diagnostic field leaks ${bad === SECRET ? "the secret" : "a path"}: ${text}`);
  const leaf = (v, at) => {
    if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return;
    if (typeof v === "string") return assert.match(v, /^[A-Za-z0-9_.:-]{0,64}$/, `enum-like string at ${at}: ${v}`);
    if (Array.isArray(v)) { assert.ok(v.length <= 32, `short array at ${at}`); return v.forEach((x, i) => leaf(x, `${at}[${i}]`)); }
    assert.equal(typeof v, "object", `leaf type at ${at}`);
    for (const [k, x] of Object.entries(v)) leaf(x, `${at}.${k}`);
  };
  leaf(added, "result");
  // What main keeps about the ending besides the raw streams: no secret, no environment, no path.
  const meta = JSON.stringify({ transport: r.transport, stopCause: r.stopCause, process: r.process, diagnostics: r.diagnostics, timeline: r.timeline });
  for (const bad of [SECRET, secretPath]) assert.ok(!meta.includes(bad), `result metadata leaks: ${meta.slice(0, 500)}`);
}

for (const [what, k] of [["ignore-descendant (completed)", {}], ["stdout holder (protocol_error)", { hold: true }]]) {
  test(`exec-codex, production timers: secret in env, cwd, stdout event, stderr; ${what} -> diagnostic has none of it`, T, async (t) => {
    const cwd = path.join(TMP, `cwd-${SECRET}`);
    fs.mkdirSync(cwd, { recursive: true });
    const body = kidCall(k, `process.stderr.write("token=" + process.env.RVW_SECRET + "\\n");out({type:"item.completed",text:process.env.RVW_SECRET});${ANSWER.codex()}`);
    const { r } = await go(t, mk("exec-codex", body, { cwd, env: { RVW_SECRET: SECRET } }));
    assert.ok(r.stderr.head.includes(SECRET), "the secret really went through stderr");
    assertSafeDiagnostic(r, cwd);
  });
}

// ---- step 2: adversarial cases against the relay ----

test("exec-codex, production timers: a descendant holding stdout exits by itself 500 ms after the leader -> completed (closed by itself)", T, async (t) => {
  const body = `const {spawn:sp}=require("child_process");const c=sp(process.execPath,["-e","require('fs').appendFileSync(process.env.RVW_PIDS,process.pid+String.fromCharCode(10));setTimeout(()=>{},700)",${JSON.stringify(MARK)}],{stdio:["ignore","inherit","inherit"]});c.unref();
const iv=setInterval(()=>{if(lines()>0){clearInterval(iv);${ANSWER.codex()}}},10);`;
  const { r } = await go(t, mk("exec-codex", body));
  assert.equal(r.outcome, "completed", `${r.transport.reason} ${JSON.stringify(r.ending)}`);
});

test("exec-codex, production timers: descendant inherits only stderr and survives -> not completed (stderr_held_open)", T, async (t) => {
  const body = `const c=spawn(process.execPath,["-e","require('fs').appendFileSync(process.env.RVW_PIDS,process.pid+String.fromCharCode(10));setTimeout(()=>{},15000)",${JSON.stringify(MARK)}],{stdio:["ignore","ignore","inherit"]});c.unref();
const iv=setInterval(()=>{if(lines()>0){clearInterval(iv);${ANSWER.codex()}}},10);`;
  const { r } = await go(t, mk("exec-codex", body));
  assertNotCompleted(r);
  assert.deepEqual([r.transport.status, r.transport.reason], ["protocol_error", "stderr_held_open"]);
});

for (const stallMs of [1500, 4000]) {
  test(`exec-codex, production timers: main stalls ${stallMs} ms at leader_exit with ~1 MB still in flight -> completed, every byte`, T, async (t) => {
    const N = 100, pad = "y".repeat(10_000);
    const body = `for(let i=0;i<${N};i++)out({type:"item.completed",i,pad:${JSON.stringify(pad)}});${ANSWER.codex()}`;
    const { r } = await go(t, mk("exec-codex", body), {
      observer: () => ({ process: (ev) => { if (ev === "leader_exit") { const end = Date.now() + stallMs; while (Date.now() < end); } } })
    });
    const line = (o) => Buffer.byteLength(JSON.stringify(o) + "\n");
    const expected = line({ type: "thread.started", thread_id: "T1" }) + line({ type: "turn.completed" }) +
      Array.from({ length: N }, (_, i) => line({ type: "item.completed", i, pad })).reduce((a, b) => a + b, 0);
    assert.equal(r.outcome, "completed", `${r.transport.reason} ${JSON.stringify(r.ending)}`);
    assert.equal(r.counters.stdoutBytes, expected);
  });
}

test("SIGKILL of main while the CLI floods stdout -> supervisor and CLI gone (lifeline + EPIPE on the relay)", T, async (t) => {
  const { spec, pids } = mk("exec-codex", `fs.appendFileSync(F,process.pid+"\\n");const s=JSON.stringify({type:"x",s:"a".repeat(1000)})+"\\n";const w=()=>{while(process.stdout.write(s));};process.stdout.on("drain",w);w();`);
  const turnUrl = new URL("../src/main/services/orchestration/turn.ts", import.meta.url).href;
  const code = `const { startTurn } = await import(${JSON.stringify(turnUrl)});
    const h = startTurn(JSON.parse(process.env.RVW_SPEC), JSON.parse(process.env.RVW_LAUNCH)); setInterval(() => {}, 1e3);`;
  const { spawn } = await import("node:child_process");
  const w = spawn(process.execPath, ["--input-type=module", "-e", code, MARK], {
    stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, RVW_SPEC: JSON.stringify(spec), RVW_LAUNCH: JSON.stringify(LAUNCH) }
  });
  const ledger = new ProcLedger(null);
  ledger.track(w.pid, "wrapper(main)");
  const end = Date.now() + 10_000;
  while (readPids(pids).length === 0 && Date.now() < end) await sleep(20);
  assert.ok(readPids(pids).length > 0, "CLI started");
  await sleep(300);
  for (const p of readPids(pids)) ledger.track(p, "cli");
  w.kill("SIGKILL");
  const lr = await assertNoneAlive(t, ledger, { ms: 15_000, mark: MARK });
  t.diagnostic(`after SIGKILL of main: ${describe(lr)}`);
});

test("exec-codex, production timers: slow consumer in main (15 ms per frame, no stall at exit) -> completed, every byte", T, async (t) => {
  const N = 150, pad = "z".repeat(10_000);
  const body = `for(let i=0;i<${N};i++)out({type:"item.completed",i,pad:${JSON.stringify(pad)}});${ANSWER.codex()}`;
  const { r } = await go(t, mk("exec-codex", body), { observer: () => ({ frame: () => { const end = Date.now() + 15; while (Date.now() < end); } }) });
  assert.equal(r.outcome, "completed", `${r.transport.reason} ${JSON.stringify(r.ending)}`);
  assert.equal(r.counters.frames, N + 2);
});

// ---- round 2: "bytes still owed to main => not held" must never turn a writing holder into a success ----
// The holder inherits stdout, registers its pid and then writes after the leader's exit: every `ms` ms one line
// (0 = flood with backpressure). Lives at most 15 s.
function writingHolder({ ms, setsid = false, json = true, lifeMs = 15000 }) {
  const lineExpr = json ? `JSON.stringify({type:"x",method:"x/y",params:{},pad:"p".repeat(200)})+String.fromCharCode(10)` : `"not json"+String.fromCharCode(10)`;
  const kidCode = `require("fs").appendFileSync(process.env.RVW_PIDS,process.pid+String.fromCharCode(10));const s=${lineExpr};` +
    (ms > 0 ? `setInterval(()=>process.stdout.write(s),${ms});` : `const w=()=>{while(process.stdout.write(s));};process.stdout.on("drain",w);setTimeout(w,50);`) +
    `setTimeout(()=>process.exit(0),${lifeMs});`;
  return (then) => `const c=spawn(process.execPath,["-e",${JSON.stringify(kidCode)},${JSON.stringify(MARK)}],{stdio:["ignore","inherit","inherit"],detached:${setsid}});c.unref();
const iv=setInterval(()=>{if(lines()>0){clearInterval(iv);${then}}},10);`;
}
const stall = (ms) => () => ({ process: (ev) => { if (ev === "leader_exit") { const end = Date.now() + ms; while (Date.now() < end); } } });
const slowFrames = (ms) => () => ({ frame: () => { const end = Date.now() + ms; while (Date.now() < end); } });

for (const [what, holder, observer, kind, escapee] of [
  ["holder writes a line every 2 ms", { ms: 2 }, null, "exec-codex"],
  ["holder floods stdout", { ms: 0 }, null, "exec-codex"],
  ["holder writes every 2 ms, main slow (5 ms per frame)", { ms: 2 }, slowFrames(5), "exec-codex"],
  ["holder writes every 2 ms, main stalls 3 s at leader_exit", { ms: 2 }, stall(3000), "exec-codex"],
  ["holder floods, main stalls 3 s at leader_exit", { ms: 0 }, stall(3000), "exec-codex"],
  ["session: holder writes JSON notifications every 2 ms after turn/completed", { ms: 2 }, null, "session-codex"],
  ["session: same, main stalls 3 s at leader_exit", { ms: 2 }, stall(3000), "session-codex"],
  ["session: holder floods JSON notifications, main slow (2 ms per frame)", { ms: 0 }, slowFrames(2), "session-codex"],
  ["setsid escapee writes every 2 ms", { ms: 2, setsid: true }, null, "exec-codex", true],
  ["setsid escapee floods", { ms: 0, setsid: true }, null, "exec-codex", true]
]) {
  test(`round 2, production timers: ${what} -> not completed, bounded`, T, async (t) => {
    const { r } = await go(t, mk(kind, writingHolder(holder)(answerFor(kind))), { observer, escapee });
    assertNotCompleted(r);
    t.diagnostic(`ending=${JSON.stringify(r.ending)}`);
  });
}

for (const [what, holder, observer, escapee] of [
  ["session: in-group holder writes JSON every 2 ms for 6 s then exits, main slow (5 ms per frame)", { ms: 2, lifeMs: 6000 }, slowFrames(5), false],
  ["session: setsid escapee writes JSON every 2 ms for 6 s then exits, main normal", { ms: 2, lifeMs: 6000, setsid: true }, null, true]
]) {
  test(`round 2, production timers: ${what} -> not completed (it held stdout past the leader)`, T, async (t) => {
    const { r } = await go(t, mk("session-codex", writingHolder(holder)(answerFor("session-codex"))), { observer, escapee });
    t.diagnostic(`ending=${JSON.stringify(r.ending)}`);
    assertNotCompleted(r);
  });
}

// ---- round 3: read-at-once after the leader's exit, AFTER_EXIT_CAP, Stop/timeout/main gone in STREAM_WAIT ----

// A burst of `bytes` JSON lines right after the leader's exit, then the holder exits by itself after `lifeMs`.
function burstHolder({ bytes, lifeMs, setsid = false }) {
  const kidCode = `require("fs").appendFileSync(process.env.RVW_PIDS,process.pid+String.fromCharCode(10));` +
    `setTimeout(()=>{const s=JSON.stringify({method:"x/y",params:{pad:"q".repeat(1000)}})+String.fromCharCode(10);let n=0;` +
    `const w=()=>{while(n<${bytes}){n+=s.length;if(!process.stdout.write(s))return process.stdout.once("drain",w);}};w();},100);` +
    `setTimeout(()=>process.exit(0),${lifeMs});`;
  return (then) => `const c=spawn(process.execPath,["-e",${JSON.stringify(kidCode)},${JSON.stringify(MARK)}],{stdio:["ignore","inherit","inherit"],detached:${setsid}});c.unref();
const iv=setInterval(()=>{if(lines()>0){clearInterval(iv);${then}}},10);`;
}

test("round 3 (documents the accepted limit): session, in-group holder writes 900 KB after the answer and exits by itself at 1.5 s", T, async (t) => {
  const { r } = await go(t, mk("session-codex", burstHolder({ bytes: 900_000, lifeMs: 1500 })(answerFor("session-codex"))));
  t.diagnostic(`ACCEPTED-LIMIT outcome=${r.outcome} ending=${JSON.stringify(r.ending)}`);
});

for (const [what, holder, observer, escapee] of [
  ["session: holder writes 3 MB (over the cap) and exits at 1.5 s", { bytes: 3_000_000, lifeMs: 1500 }, null, false],
  ["session: holder writes 3 MB, main stalls 3 s", { bytes: 3_000_000, lifeMs: 1500 }, stall(3000), false],
  ["session: setsid escapee writes 900 KB and lives 6 s", { bytes: 900_000, lifeMs: 6000, setsid: true }, null, true],
  ["session: setsid escapee writes 3 MB and lives 6 s, main slow (2 ms per frame)", { bytes: 3_000_000, lifeMs: 6000, setsid: true }, slowFrames(2), true]
]) {
  test(`round 3, production timers: ${what} -> not completed, bounded`, T, async (t) => {
    const { r } = await go(t, mk("session-codex", burstHolder(holder)(answerFor("session-codex"))), { observer, escapee });
    t.diagnostic(`ending=${JSON.stringify(r.ending)}`);
    assertNotCompleted(r);
  });
}

// A quiet setsid escapee holding stdout: the group is gone at once, LEFTOVER (2 s) runs out, then STREAM_WAIT (1 s).
const quietEscapee = (kind) => mk(kind, kidCall({ hold: true, setsid: true }, answerFor(kind)));
test("round 3: Stop inside STREAM_WAIT (2.4 s after leader_exit, quiet escapee) -> stopped, done soon after", T, async (t) => {
  let stopAt = 0;
  const { r, ms } = await go(t, quietEscapee("exec-codex"), {
    escapee: true, observer: (getH) => ({ process: (ev) => { if (ev === "leader_exit") setTimeout(() => { stopAt = performance.now(); getH()?.stop(); }, 2400); } })
  });
  assertNotCompleted(r);
  assert.equal(r.stopCause, "user");
  const fin = r.timeline.find((x) => x.ev === "finish").at;
  t.diagnostic(`finish - stop = ${Math.round(fin - r.timeline.find((x) => x.ev === "stop:user").at)} ms; total ${ms}`);
  assert.ok(ms < 8000, `bounded: ${ms}`);
});
test("round 3: timeout inside STREAM_WAIT (timeoutMs 2400, quiet escapee) -> timeout", T, async (t) => {
  const { r, ms } = await go(t, mk("exec-codex", kidCall({ hold: true, setsid: true }, answerFor("exec-codex")), { limits: { timeoutMs: 2400 } }), { escapee: true });
  assertNotCompleted(r);
  assert.equal(r.outcome, "timeout");
  assert.ok(ms < 8000, `bounded: ${ms}`);
});

test("round 3: main SIGKILLed inside STREAM_WAIT (quiet escapee holds stdout) -> supervisor gone within 5 s", T, async (t) => {
  const { spec, pids } = quietEscapee("exec-codex");
  const turnUrl = new URL("../src/main/services/orchestration/turn.ts", import.meta.url).href;
  const code = `const { startTurn } = await import(${JSON.stringify(turnUrl)});
    startTurn(JSON.parse(process.env.RVW_SPEC), JSON.parse(process.env.RVW_LAUNCH), { process: (ev, i) => { if (ev === "spawned") require("fs").writeFileSync(process.env.RVW_SUP, String(i.pid)); } }); setInterval(() => {}, 1e3);`
    .replace('require("fs")', "(await import('node:fs')).default");
  const supFile = path.join(TMP, `sup-${++n}`);
  const { spawn } = await import("node:child_process");
  const w = spawn(process.execPath, ["--input-type=module", "-e", code.replace("(ev, i) =>", "async (ev, i) =>"), MARK], {
    stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, RVW_SPEC: JSON.stringify(spec), RVW_LAUNCH: JSON.stringify(LAUNCH), RVW_SUP: supFile }
  });
  const end = Date.now() + 10_000;
  while ((readPids(pids).length === 0 || !fs.existsSync(supFile)) && Date.now() < end) await sleep(20);
  const sup = Number(fs.readFileSync(supFile, "utf8"));
  await sleep(2400); // leader exits at once; LEFTOVER 2 s is over: inside STREAM_WAIT
  w.kill("SIGKILL");
  const ledger = new ProcLedger(null);
  ledger.track(sup, "supervisor");
  const lr = await ledger.waitGone(5000);
  for (const p of readPids(pids)) { try { process.kill(p, "SIGKILL"); } catch {} }
  t.diagnostic(`after SIGKILL of main in STREAM_WAIT: ${describe(lr)}`);
  ledger.killOwn();
  assert.equal(lr.alive.length, 0, "supervisor exited within 5 s of losing main");
});

test("round 3: supervisor memory stays bounded while a holder floods and main stalls 4 s (read-at-once + cap)", T, async (t) => {
  const rssFile = path.join(os.tmpdir(), `rvw-rss-${process.pid}-${++n}`); // not under TMP: the sampler must not carry MARK
  const { spawn } = await import("node:child_process");
  let sampler = null;
  const { r } = await go(t, mk("exec-codex", writingHolder({ ms: 0 })(answerFor("exec-codex"))), {
    observer: () => ({
      process: (ev, i) => {
        if (ev === "spawned") sampler = spawn("/bin/sh", ["-c", `while kill -0 ${i.pid} 2>/dev/null; do ps -o rss= -p ${i.pid} >> ${rssFile}; sleep 0.1; done`], { stdio: "ignore" });
        if (ev === "leader_exit") { const end = Date.now() + 4000; while (Date.now() < end); }
      }
    })
  });
  sampler?.kill();
  const rss = fs.readFileSync(rssFile, "utf8").split("\n").filter(Boolean).map(Number);
  t.diagnostic(`supervisor rss KiB: first=${rss[0]} max=${Math.max(...rss)} samples=${rss.length}; outcome=${r.outcome} ending=${JSON.stringify(r.ending?.streams)} capped=${r.ending?.counts?.cappedStreams}`);
  assertNotCompleted(r);
  assert.ok(Math.max(...rss) - rss[0] < 64 * 1024, "supervisor grew by less than 64 MiB");
});

test("round 3: the CLI itself writes an unterminated last line while a quiet descendant holds stdout -> still a failure; label noted", T, async (t) => {
  const { r } = await go(t, mk("exec-codex", kidCall({ hold: true }, `${ANSWER.codex()}process.stdout.write('{"type":"broken"');`)));
  t.diagnostic(`step=${r.ending?.step} transport=${r.transport.reason} framing=${JSON.stringify(r.ending?.framing)}`);
  assertNotCompleted(r);
  assert.equal(r.outcome, "protocol_error");
});
