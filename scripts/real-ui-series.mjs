// Final real checks through the UI (implementation/real-ui-check-plan.md): R1 a goal to completed, R2 Stop during a
// started Claude turn, R3 a clean quit during a started Claude turn, restart without continuation, Resume to completed.
// Every user action is a mouse event in the application's window (DevTools protocol, as in the E2E); the test only
// reads the journal, the processes and git. A temporary userData and a new temporary Git project are used.
//   --rehearse               development build + fake CLIs whose Claude turn is held (no model request)
//   --real --app <.app>      that packaged application + the real Codex/Claude CLIs (REAL model requests)
// --out <dir>: report.json, screenshots, logs (anonymized). Stops at the first unexpected state; never raises limits,
// never repeats a scenario.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURES, NODE, byText, canvasState, card, createAgent, launch as launchApp, openTab, q, sleep, startGoal, workspace } from "./orchestration-app-kit.mjs";

const REAL = process.argv.includes("--real");
const REHEARSE = process.argv.includes("--rehearse");
if (REAL === REHEARSE) throw new Error("exactly one of --real or --rehearse");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const APP = REAL ? fs.realpathSync(path.resolve(arg("--app") ?? "")) : null;
const EXECUTABLE = APP && path.join(APP, "Contents", "MacOS", "Raoden Loom");
const SUPPORTED = { codex: "codex-cli 0.155.1", claude: "2.1.281 (Claude Code)" };
const LIMITS = { R1: { turns: 8, roundsPerStage: 2, replans: 1, runMin: 20 }, R2: { turns: 3, roundsPerStage: 2, replans: 1, runMin: 20 }, R3: { turns: 8, roundsPerStage: 2, replans: 1, runMin: 20 } };
const SERIES_TURNS = 19;
const SERIES_MS = 90 * 60_000;
const RUN_MS = 20 * 60_000;

const { TMP, D, git } = workspace(REAL ? "cto-real-ui-" : "cto-real-ui-rehearse-");
const OUT = path.resolve(arg("--out") ?? D("out"));
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9950 + Math.floor(Math.random() * 40);
const t0 = Date.now();
const report = { mode: REAL ? "real" : "rehearse", startedAt: new Date(t0).toISOString(), scenarios: {}, checks: [], failures: [], notes: {} };
const logLines = [];
const log = (m) => { const l = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`; logLines.push(l); process.stderr.write(`${l}\n`); };
const check = (ok, what, got) => { report.checks.push({ ok, what, ...(ok ? {} : { got }) }); log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` ${JSON.stringify(got)?.slice(0, 500)}`}`); if (!ok) report.failures.push(what); return ok; };
class Halt extends Error {}
const halt = (why) => { throw new Halt(why); };

// ---------- CLIs ----------
const which = (name) => { try { return execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(); } catch { return null; } };
let providersFile;
const HOLD = D("hold-executor");
if (REAL) {
  for (const cli of ["codex", "claude"]) {
    const bin = which(cli);
    const version = bin ? execFileSync(bin, ["--version"], { encoding: "utf8" }).split("\n")[0].trim() : null;
    report.notes[`${cli}Version`] = version;
    if (version !== SUPPORTED[cli]) { process.stdout.write(`${JSON.stringify({ ok: false, stop: `unsupported ${cli} version: ${version}` })}\n`); process.exit(1); }
  }
  log(`versions: ${report.notes.codexVersion}; ${report.notes.claudeVersion}`);
} else {
  const script = (name, steps) => {
    const d = D("script", name);
    fs.mkdirSync(d, { recursive: true });
    steps.forEach((s, i) => {
      fs.writeFileSync(path.join(d, `${i + 1}.json`), JSON.stringify(s.report));
      if (s.writes) fs.writeFileSync(path.join(d, `${i + 1}.writes.json`), JSON.stringify(s.writes.map(([rel, text]) => ({ rel, base64: Buffer.from(text).toString("base64") }))));
    });
    return d;
  };
  const plan = { report: { stages: [{ title: "clamp", task: "Write src/clamp.mjs and tests/clamp.test.mjs" }], question: null } };
  const verdict = (v) => ({ report: { verdict: v, findings: [], question: null } });
  const clamp = { report: { summary: "clamp written", done: true }, writes: [["src/clamp.mjs", "export function clamp(x, lo, hi) {\n  if (lo > hi) throw new RangeError(\"empty range\");\n  return Math.min(hi, Math.max(lo, x));\n}\n"],
    ["tests/clamp.test.mjs", "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { clamp } from \"../src/clamp.mjs\";\ntest(\"clamp\", () => assert.equal(clamp(3, 1, 2), 2));\n"]] };
  const codex = script("codex", [plan, verdict("accept"), verdict("complete"), plan, plan, verdict("accept"), verdict("complete")]);
  const claude = script("claude", [clamp, clamp]);
  fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
  const wrap = (p) => {
    const f = D(`${p}-mock`);
    fs.writeFileSync(f, `#!/bin/sh\n${p === "claude" ? `while [ -e "${HOLD}" ]; do sleep 0.1; done\n` : ""}exec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
    return f;
  };
  const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: D("ledger.jsonl"), ...extra });
  providersFile = D("providers.json");
  fs.writeFileSync(providersFile, JSON.stringify({
    codex: { executable: wrap("codex"), version: SUPPORTED.codex, path: `${path.dirname(NODE)}:/usr/bin:/bin`, env: env({ MOCK_SCRIPT: codex, CODEX_HOME: D("mock-state", ".codex") }) },
    claude: { executable: wrap("claude"), version: SUPPORTED.claude, path: `${path.dirname(NODE)}:/usr/bin:/bin`, env: env({ MOCK_SCRIPT: claude }) }
  }));
}

// ---------- the project (series-project, as C1 of stage 6) ----------
const source = D("project");
fs.cpSync(path.join(FIXTURES, "series-project"), source, { recursive: true });
for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "series project"]]) git(source, ...a);
fs.mkdirSync(path.join(source, "node_modules"));
fs.writeFileSync(path.join(source, "node_modules", ".package-lock.json"), "{}\n"); // ignored by the project's .gitignore
const ACCEPT = "tests/clamp.accept.test.mjs";
function sourceState() {
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else files.push(`${path.relative(source, p)} ${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
  } };
  walk(source);
  const refs = git(source, "for-each-ref", "--format=%(refname) %(objectname)").trim().split("\n").filter(Boolean);
  return { head: git(source, "rev-parse", "HEAD").trim(), branch: git(source, "symbolic-ref", "HEAD").trim(),
    refs: refs.filter((r) => !r.startsWith("refs/canvastty/")).join("\n"), status: git(source, "status", "--porcelain", "--untracked-files=all"),
    files: files.sort().join("\n"), canvastty: refs.filter((r) => r.startsWith("refs/canvastty/")).map((r) => r.split(" ")[0]) };
}
const before = sourceState();
const sourceUnchanged = (s) => s.head === before.head && s.branch === before.branch && s.refs === before.refs && s.status === before.status && s.files === before.files;

// ---------- observation ----------
const userData = D("user-data");
const journal = (runId) => fs.readFileSync(path.join(userData, "orchestration", "runs", runId, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const timeline = (runId) => journal(runId).map((r) => `${r.seq}:${r.type}${r.type === "run.status" ? `(${r.data.status}${r.data.reason ? `/${r.data.reason}` : ""})`
  : r.type === "orch.turn" ? `(${r.data.purpose})` : r.type === "command.received" ? `(${r.data.kind})` : r.type === "turn.finished" ? `(${r.data.outcome})`
  : r.type === "check.finished" ? `(${r.data.status}${r.data.reason ? `/${r.data.reason}` : ""})` : r.type === "checkpoint.created" ? `(${r.data.stage})` : r.type === "turn.intent" ? `(${r.data.provider})` : ""}`);
const turnsBy = (runId) => { const t = { codex: 0, claude: 0 }; for (const r of journal(runId)) if (r.type === "turn.intent") t[r.data.provider]++; return t; };
const lastStatus = (runId) => journal(runId).filter((r) => r.type === "run.status").at(-1)?.data;
const ms = (a, b) => Date.parse(b) - Date.parse(a);
function tree(pid) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").filter(Boolean)
    .map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return { pid: +m[1], ppid: +m[2], command: m[3] }; });
  const out = [];
  const add = (p) => { for (const r of rows.filter((x) => x.ppid === p)) { out.push(r); add(r.pid); } };
  add(pid);
  return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
// The CLI itself (its executable, or the rehearsal's shell wrapper as first argument); never the supervisor or a helper.
// (`codex app-server` is the HOME limits reader of LimitsService, not an orchestration process.)
const isCli = (p, cli) => !p.command.includes("supervisor.mjs") && !p.command.includes(" app-server") && p.command.split(" ").slice(0, 2).some((t) => path.basename(t).startsWith(cli) || t.includes(`/${cli}/`));
// The processes of orchestration operations: every supervisor under main and everything under it.
const runProcesses = (mainPid) => tree(mainPid).filter((p) => p.command.includes("supervisor.mjs")).flatMap((s) => [s, ...tree(s.pid)]);
const anonCmd = (c) => c.slice(0, 240);

// ---------- UI ----------
const launch = () => launchApp({ userData, port: PORT, shots: SHOTS, executable: EXECUTABLE ?? undefined, providers: providersFile });
const panelStatus = (app) => app.ev(`(() => { const s = ${q(".orch-panel__status")}; return s ? { status: [...s.classList].find((c) => c.startsWith("orch-panel__status--"))?.slice(20), reason: s.querySelector("span")?.textContent ?? null } : null; })()`);
const clickAction = (app, label) => app.clickEl(byText(".orch-panel__actions button, .orch-panel__section button, .orch-summary > button", label));
const setLimits = (app, l) => async () => {
  const inputs = `document.querySelectorAll(".orch-limits input")`;
  for (const [i, v] of [l.turns, l.roundsPerStage, l.replans, l.runMin].entries()) await app.type(`${inputs}[${i}]`, String(v));
  const got = await app.ev(`[...${inputs}].map((i) => i.value)`);
  if (got.join() !== [l.turns, l.roundsPerStage, l.replans, l.runMin].join()) halt(`limits not set in the dialog: ${got}`);
};
const GOAL = { task: "Add a function clamp(x, lo, hi) in src/clamp.mjs (ES module, named export) that returns x limited to [lo, hi] and throws RangeError when lo > hi. Add a unit test tests/clamp.test.mjs. Do not modify tests/clamp.accept.test.mjs.",
  criteria: "tests/clamp.accept.test.mjs passes unchanged\nall tests pass\nno files outside src/ and tests/ change" };
let usedTurns = 0;
const guardSeries = () => { if (Date.now() - t0 > SERIES_MS) halt("series time limit (90 min) reached"); };
// Waits for the run's panel status; any other pause or end is unexpected. Returns the status.
// Only statuses recorded after `afterSeq` count (a status from before the last command is not its result).
async function waitRun(runId, want, { allowPaused = [], ms = RUN_MS + 60_000, afterSeq = -1 } = {}) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    guardSeries();
    const st = journal(runId).filter((r) => r.type === "run.status" && r.seq > afterSeq).at(-1)?.data;
    if (st && want.includes(st.status)) return st;
    if (st && (st.status === "failed" || st.status === "stopped" || (st.status === "paused" && !allowPaused.includes(st.reason)))) return st;
    await sleep(1000);
  }
  halt(`run ${runId.slice(0, 8)} did not reach ${want} in time`);
}
async function newRun(app, linkId, limits, name) {
  if (usedTurns + limits.turns > SERIES_TURNS) halt("series turn budget would be exceeded");
  usedTurns += limits.turns;
  await startGoal(app, linkId, { task: GOAL.task, criteria: GOAL.criteria, onDialog: setLimits(app, limits) });
  const runId = (await canvasState(app)).links[0].runIds.at(-1);
  report.scenarios[name] = { runId, limits };
  log(`${name}: run ${runId.slice(0, 8)} started`);
  return runId;
}
// A Claude CLI process of this app that has really started, with the executor turn in flight in the journal.
async function claudeStarted(app, runId, ms = RUN_MS) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    guardSeries();
    const j = journal(runId);
    const intent = j.filter((r) => r.type === "turn.intent" && r.data.provider === "claude").at(-1);
    const finished = intent && j.some((r) => r.type === "turn.finished" && r.data.turnId === intent.data.turnId);
    const procs = intent && !finished ? tree(app.child.pid).filter((p) => isCli(p, "claude")) : [];
    if (procs.length) return { turnId: intent.data.turnId, intentSeq: intent.seq, intentTs: intent.ts, processes: procs.map((p) => ({ pid: p.pid, ppid: p.ppid, command: anonCmd(p.command) })), seenAt: new Date().toISOString() };
    const st = lastStatus(runId);
    if (st && st.status !== "running") halt(`run ${runId.slice(0, 8)} left running before the Claude turn: ${JSON.stringify(st)}`);
    await sleep(REAL ? 250 : 100);
  }
  halt("no Claude process started in time");
}
function verifyCompleted(runId, name) {
  const j = journal(runId);
  const ops = j.filter((r) => r.type === "orch.turn" || r.type === "check.started").map((r) => (r.type === "check.started" ? "check" : r.data.purpose));
  const checks = j.filter((r) => r.type === "check.finished").map((r) => `${r.data.status}${r.data.reason ? `/${r.data.reason}` : ""}`);
  const cps = j.filter((r) => r.type === "checkpoint.created").map((r) => r.data.stage);
  report.scenarios[name].operations = ops;
  report.scenarios[name].checks = checks;
  report.scenarios[name].turns = turnsBy(runId);
  check(lastStatus(runId)?.status === "completed", `${name}: run completed`, lastStatus(runId));
  check(checks.at(-1) === "passed", `${name}: the last check passed`, checks);
  check(cps.length >= 1, `${name}: checkpoint created for each accepted stage (${cps.join(",")})`, cps);
  const refs = sourceState().canvastty.filter((r) => r.startsWith(`refs/canvastty/${runId}/`));
  const stages = refs.filter((r) => /\/stage-\d+$/.test(r)).sort();
  const last = stages.at(-1);
  report.scenarios[name].refs = refs.map((r) => r.replace(runId, `<${name}>`));
  if (!check(!!last && refs.includes(`refs/canvastty/${runId}/baseline`), `${name}: baseline and stage refs in the source`, refs)) return;
  const base = `refs/canvastty/${runId}/baseline`;
  const changed = git(source, "diff", "--name-only", base, last).trim().split("\n").filter(Boolean);
  report.scenarios[name].checkpointChanges = changed;
  check(changed.length > 0 && changed.every((f) => f.startsWith("src/") || f.startsWith("tests/")), `${name}: the checkpoint changes only src/ and tests/`, changed);
  const blob = (ref) => git(source, "rev-parse", `${ref}:${ACCEPT}`).trim();
  check(blob(last) === blob(base) && blob(base) === blob("HEAD"), `${name}: ${ACCEPT} identical (git blob) in the checkpoint`, [blob(last), blob(base)]);
  check(changed.includes("src/clamp.mjs"), `${name}: src/clamp.mjs is in the checkpoint`, changed);
}

let app;
try {
  if (!REAL) fs.writeFileSync(HOLD, "");
  // ============ launch 1 ============
  app = await launch();
  report.notes.executable = REAL ? "<pkg>/release/mac-arm64/Raoden Loom.app" : "development build";
  await createAgent(app, "Агент Codex (лид)", source);
  await createAgent(app, "Агент Claude (исполнитель)", source);
  let c = await canvasState(app);
  const lead = c.agents.find((a) => a.provider === "codex");
  const exec = c.agents.find((a) => a.provider === "claude");
  await app.drag(await app.center(card(lead.agentId, ".agent-card__port")), await app.center(card(exec.agentId, ".agent-card__body")), 20);
  await app.waitFor(`${q(".agent-link__chip")} && true`, "link chip");
  const linkId = (await canvasState(app)).links[0].linkId;
  await app.shot("00-linked");

  // ---- R1 ----
  if (!REAL) fs.rmSync(HOLD);
  const r1 = await newRun(app, linkId, LIMITS.R1, "R1");
  const s1 = await waitRun(r1, ["completed"]);
  report.scenarios.R1.timeline = timeline(r1);
  report.scenarios.R1.durationMs = ms(journal(r1)[0].ts, journal(r1).at(-1).ts);
  await app.shot("01-r1-final");
  if (s1.status !== "completed") { check(false, "R1: run completed", s1); if (s1.status === "paused") await clickAction(app, "Стоп"); halt(`R1 ended ${JSON.stringify(s1)}`); }
  verifyCompleted(r1, "R1");
  check(sourceUnchanged(sourceState()), "R1: the source project (HEAD, branch, refs, status, files) is unchanged", sourceState());
  if (report.failures.length) halt("R1 criteria");
  await app.clickEl(q(".orch-panel__close"));

  // ---- R2 ----
  if (!REAL) fs.writeFileSync(HOLD, "");
  const r2 = await newRun(app, linkId, LIMITS.R2, "R2");
  const started2 = await claudeStarted(app, r2);
  report.scenarios.R2.cliStarted = started2;
  log(`R2: Claude process ${started2.processes.map((p) => p.pid).join(",")} for turn ${started2.turnId.slice(0, 8)}`);
  await clickAction(app, "Стоп");
  const stopSent = Date.now();
  await app.shot("02-r2-stop-clicked");
  const s2 = await waitRun(r2, ["stopped", "completed", "failed"], { ms: 120_000 });
  if (!REAL) fs.rmSync(HOLD, { force: true }); // only now: a wrapper released earlier would still start the fake CLI
  const j2 = journal(r2);
  const stopRec = j2.find((r) => r.type === "command.received" && r.data.kind === "stop");
  const fin2 = j2.find((r) => r.type === "turn.finished" && r.data.turnId === started2.turnId);
  report.scenarios.R2.stop = { commandSeq: stopRec?.seq, turnFinishedSeq: fin2?.seq, turnOutcome: fin2?.data.outcome, status: s2 };
  if (!stopRec || !fin2 || fin2.seq < stopRec.seq) { report.scenarios.R2.counted = false; halt("R2: the Claude turn ended before the Stop reached main; not counted"); }
  report.scenarios.R2.counted = true;
  check(s2.status === "stopped" && fin2.data.outcome === "stopped", "R2: the started Claude turn ended stopped, the run is stopped", report.scenarios.R2.stop);
  while (Date.now() - stopSent < 60_000) await sleep(1000);
  const after2 = journal(r2).filter((r) => r.seq > stopRec.seq && ["orch.turn", "turn.intent", "check.started"].includes(r.type));
  check(after2.length === 0, "R2: no operation after the accepted Stop (60 s)", after2.map((r) => r.type));
  const live2 = started2.processes.filter((p) => alive(p.pid));
  const cli2 = runProcesses(app.child.pid);
  check(live2.length === 0 && cli2.length === 0, "R2: no live CLI (or supervisor) process of the run", { live2, cli2: cli2.map((p) => anonCmd(p.command)) });
  report.scenarios.R2.turns = turnsBy(r2);
  report.scenarios.R2.timeline = timeline(r2);
  report.scenarios.R2.durationMs = ms(j2[0].ts, journal(r2).at(-1).ts);
  check(sourceUnchanged(sourceState()), "R2: the source project is unchanged", null);
  if (report.failures.length) halt("R2 criteria");
  await app.clickEl(q(".orch-panel__close"));

  // ---- R3 ----
  if (!REAL) fs.writeFileSync(HOLD, "");
  const r3 = await newRun(app, linkId, LIMITS.R3, "R3");
  const started3 = await claudeStarted(app, r3);
  report.scenarios.R3.cliStarted = started3;
  log(`R3: Claude process ${started3.processes.map((p) => p.pid).join(",")} for turn ${started3.turnId.slice(0, 8)}; quitting`);
  await app.shot("03-r3-before-quit");
  const treeBefore = tree(app.child.pid);
  const canvasBefore = await canvasState(app);
  // Quit: SIGTERM to the main process. Electron handles it as app.quit() (the same before-quit path as Quit/Cmd+Q in the
  // app menu, which synthetic DevTools key events cannot reach): the app's shutdown stops the operation, then exits.
  const quitAt = Date.now();
  app.child.kill("SIGTERM");
  const exit3 = await Promise.race([app.exited, sleep(60_000).then(() => null)]);
  report.scenarios.R3.quit = { exit: exit3, ms: Date.now() - quitAt };
  if (!exit3) halt("R3: the app did not exit within 60 s after quit");
  check(exit3.code === 0 && exit3.signal === null, "R3: the app quit cleanly (code 0)", exit3);
  let left = treeBefore;
  while (Date.now() - quitAt < 30_000 && (left = treeBefore.filter((p) => alive(p.pid))).length) await sleep(250);
  check(left.length === 0, `R3: every process of the app ended (${treeBefore.length})`, left.map((p) => anonCmd(p.command)));
  const j3 = journal(r3);
  const fin3 = j3.find((r) => r.type === "turn.finished" && r.data.turnId === started3.turnId);
  report.scenarios.R3.afterQuit = { status: lastStatus(r3), turnOutcome: fin3?.data.outcome ?? null };
  if (fin3 && fin3.data.outcome !== "stopped") { report.scenarios.R3.counted = false; halt(`R3: the Claude turn had ended (${fin3.data.outcome}) before the quit; not counted`); }
  check(fin3?.data.outcome === "stopped" && lastStatus(r3)?.status === "paused" && lastStatus(r3)?.reason === "user_request",
    "R3: the started turn was stopped by the quit; the run is paused(user_request)", report.scenarios.R3.afterQuit);
  if (report.failures.length) halt("R3 quit criteria");
  const len3 = j3.length;

  // ============ launch 2 ============
  app = await launch();
  await app.waitFor(`document.querySelectorAll("[data-agent-id]").length === 2 && ${q(".agent-link__chip")} && true`, "cards after restart");
  const restartAt = Date.now();
  c = await canvasState(app);
  check(JSON.stringify(c) === JSON.stringify(canvasBefore), "R3: after restart cards, link and runs as before", null);
  while (Date.now() - restartAt < 60_000) await sleep(1000);
  const cli3 = runProcesses(app.child.pid);
  check(journal(r3).length === len3 && cli3.length === 0, "R3: nothing continued by itself (60 s): no journal record, no CLI", { grew: journal(r3).length - len3, cli3: cli3.length });
  await app.clickEl(byText(`[data-agent-link-id="${linkId}"] button`, "Открыть запуск"));
  await app.waitFor(`${q(".orch-panel__status--paused")} && true`, "R3 paused in the panel");
  report.scenarios.R3.panelAfterRestart = await panelStatus(app);
  await openTab(app, "history");
  await app.waitFor(`document.querySelectorAll(".orch-history li").length > 0`, "history tab");
  check(true, "R3: the history is shown after restart", null);
  await app.shot("04-r3-after-restart");
  if (report.failures.length) halt("R3 restart criteria");
  if (!REAL) fs.rmSync(HOLD);
  const beforeResume = journal(r3).at(-1).seq;
  await clickAction(app, "Продолжить");
  const s3 = await waitRun(r3, ["completed"], { afterSeq: beforeResume });
  report.scenarios.R3.timeline = timeline(r3);
  report.scenarios.R3.durationMs = ms(journal(r3)[0].ts, journal(r3).at(-1).ts);
  await app.shot("05-r3-final");
  if (s3.status !== "completed") { check(false, "R3: run completed after Resume", s3); if (s3.status === "paused") await clickAction(app, "Стоп"); halt(`R3 ended ${JSON.stringify(s3)}`); }
  verifyCompleted(r3, "R3");
  check(sourceUnchanged(sourceState()), "R3: the source project is unchanged", null);
  const treeEnd = tree(app.child.pid);
  report.notes.finalQuit = await app.quit();
  await sleep(3000);
  check(treeEnd.every((p) => !alive(p.pid)), "series end: no process of the app left", treeEnd.filter((p) => alive(p.pid)).map((p) => anonCmd(p.command)));
} catch (error) {
  report.halted = String(error instanceof Halt ? error.message : error?.stack ?? error);
  log(`HALT: ${report.halted}`);
  await app?.shot("halt").catch(() => {});
  for (const s of Object.values(report.scenarios)) if (s.runId && !s.timeline) try { s.timeline = timeline(s.runId); s.turns = turnsBy(s.runId); } catch {}
} finally {
  try { fs.rmSync(HOLD, { force: true }); } catch {}
  if (app && app.child.exitCode === null && app.child.signalCode === null) await app.quit().catch(() => {});
}
report.durationMs = Date.now() - t0;
report.turnsTotal = Object.values(report.scenarios).reduce((n, s) => { const t = s.turns ?? {}; return n + (t.codex ?? 0) + (t.claude ?? 0); }, 0);
report.ok = !report.halted && report.failures.length === 0;
report.sourceAtEnd = { unchanged: sourceUnchanged(sourceState()), canvasttyRefs: sourceState().canvastty.length };
report.paths = { tmp: "<tmp>", userData: "<tmp>/user-data", project: "<tmp>/project" };
const ids = Object.entries(report.scenarios).map(([n, s]) => [s.runId, `<${n}>`]);
const anon = (text) => { let t = text.split(TMP).join("<tmp>").split(os.homedir()).join("~"); if (APP) t = t.split(path.dirname(path.dirname(path.dirname(APP)))).join("<pkg>"); for (const [id, n] of ids) if (id) t = t.split(id).join(n); return t; };
fs.writeFileSync(path.join(OUT, "report.json"), anon(`${JSON.stringify(report, null, 2)}\n`));
fs.writeFileSync(path.join(OUT, "series.log"), anon(`${logLines.join("\n")}\n`));
for (const [n, s] of Object.entries(report.scenarios)) if (s.runId) try { fs.writeFileSync(path.join(OUT, `${n}-journal-types.txt`), anon(`${timeline(s.runId).join("\n")}\n`)); } catch {}
process.stdout.write(`${JSON.stringify({ ok: report.ok, halted: report.halted ?? null, failures: report.failures, turnsTotal: report.turnsTotal, out: OUT, tmp: TMP })}\n`);
process.exitCode = report.ok ? 0 : 1;
