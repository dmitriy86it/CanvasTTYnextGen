// Stage 9 E2E: the real application (development build) with its own temporary userData and temporary Git project,
// fake Codex/Claude CLIs (tests/fixtures/orchestration/mock-*.mjs), every action through the window over the DevTools
// protocol (mouse events as the user makes them). The test only observes the journal, the project and the processes.
//   launch 1: run A — a two-stage goal to completed (checkpoint per stage, source branch and files unchanged); the
//             history text fails to load (file unreadable) and loads on Repeat; run B — Pause after the turn, Step,
//             Resume, Stop during the executor's turn and nothing after it; run C — the main process is SIGKILLed while
//             the executor's turn runs;
//   launch 2: cards, link and history kept, nothing repeated by itself, the recovery actions; "Retry turn" and
//             "Resume" with the IPC reply dropped, repeated from the panel (after a window reload, and without one),
//             each done once; run C to completed; run D — main SIGKILLed while the check runs;
//   launch 3: run D recovered, nothing repeated by itself; Resume runs the interrupted check again; completed.
// After each kill every process of the killed application must be gone (supervisor, CLI group, check sandbox).
// Dropped replies come from CANVASTTY_ORCHESTRATION_TEST_DROP_REPLIES, read through developmentEnv (ignored when
// packaged). Needs `npm run build` first. Starts no real model.
// Usage: node scripts/e2e-orchestration.mjs [--out <dir>]   (report.json and screenshots; paths anonymized)
// Stage 12: the runs pick the separate copy (workMode "copy"): the source-unchanged checks are that mode's promise;
// the project-folder mode is covered by scripts/smoke-native-ui.mjs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readRun } from "../src/main/services/orchestration/store.ts";
import { FIXTURES, NODE, byText, canvasState, card, createAgent, launch as launchApp, openTab, q, runs, sleep, startGoal, workspace } from "./orchestration-app-kit.mjs";

const { TMP, D, git, project, script } = workspace("cto-e2e-");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : D("out");
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const notes = {};
const t0 = Date.now();
const log = (m) => process.stderr.write(`[e2e +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 600)}`); log(`${ok ? "ok  " : "FAIL"} ${what}`); };

// ---------- project, scripts, fake CLIs ----------
const source = project("project");
const planOf = (...titles) => ({ report: { stages: titles.map((t, i) => ({ title: t, task: `Stage ${i + 1}: ${t}` })), question: null } });
const verdict = (v, findings = []) => ({ report: { verdict: v, findings, question: null } });
const HOLD_CHECK = D("hold-check");
const slowTest = `import test from "node:test";\nimport fs from "node:fs";\ntest("slow", async () => { while (fs.existsSync(${JSON.stringify(HOLD_CHECK)})) await new Promise((r) => setTimeout(r, 100)); });\n`;
// One counter per CLI across all runs: a call held in the wrapper (below) and then killed never reaches the fake CLI.
const codexScript = script("codex", [
  planOf("module a", "module b"), verdict("accept"), verdict("accept"), verdict("complete"), // A
  planOf("note"), verdict("fix", ["note must export a string"]), // B
  planOf("note"), verdict("accept"), verdict("complete"), // C
  planOf("note"), verdict("accept"), verdict("complete") // D
]);
const claudeScript = script("claude", [
  { report: { summary: "stage 1: src/a.mjs", done: true }, writes: [["src/a.mjs", "export const a = 1;\n"]] }, // A1
  { report: { summary: "stage 2: src/b.mjs", done: true }, writes: [["src/b.mjs", "export const b = 2;\n"]] }, // A2
  { report: { summary: "note added", done: true }, writes: [["src/note.mjs", "export const note = 1;\n"]] }, // B round 1
  { report: { summary: "note added after recovery", done: true }, writes: [["src/note.mjs", "export const note = 'c';\n"]] }, // C retried turn
  { report: { summary: "note and a slow test", done: true }, writes: [["src/note.mjs", "export const note = 'd';\n"], ["tests/slow.test.mjs", slowTest]] } // D
]);
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
const ledger = D("ledger.jsonl");
const HOLD = D("hold-executor");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  const hold = p === "claude" ? `case "$1" in --help|--version) ;; *) while [ -e "${HOLD}" ]; do sleep 0.1; done ;; esac\n` : "";
  fs.writeFileSync(f, `#!/bin/sh\n${hold}exec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, ...extra });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
    env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: `${path.dirname(NODE)}:/usr/bin:/bin`,
    env: env({ MOCK_SCRIPT: claudeScript }) }
}));
const DROP = D("drop-replies");
fs.mkdirSync(DROP);
const userData = D("user-data");
const counter = (d) => { try { return Number(fs.readFileSync(path.join(d, "counter"), "utf8")); } catch { return 0; } };
const calls = () => ({ codex: counter(codexScript), claude: counter(claudeScript) });

// ---------- observation ----------
const journal = (runId) => fs.readFileSync(path.join(userData, "orchestration", "runs", runId, "journal.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ops = (runId) => journal(runId).filter((r) => r.type === "orch.turn" || r.type === "check.started")
  .map((r) => ({ seq: r.seq, op: r.type === "check.started" ? "check" : r.data.purpose }));
const count = (runId, type, pred = () => true) => journal(runId).filter((r) => r.type === type && pred(r.data)).length;
const timeline = (runId) => journal(runId).map((r) => `${r.seq}:${r.type}${r.type === "run.status" ? `(${r.data.status}${r.data.reason ? `/${r.data.reason}` : ""})`
  : r.type === "orch.turn" ? `(${r.data.purpose})` : r.type === "command.received" ? `(${r.data.kind})` : r.type === "check.finished" ? `(${r.data.status}${r.data.reason ? `/${r.data.reason}` : ""})`
  : r.type === "recovery.decided" ? `(${r.data.action})` : r.type === "checkpoint.created" ? `(${r.data.stage})` : ""}`);
// The source project as the user sees it: HEAD, its branch, every ref outside refs/canvastty, the status and a hash of
// every working file (outside .git).
function sourceState() {
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(`${path.relative(source, p)} ${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
  } };
  walk(source);
  const refs = git(source, "for-each-ref", "--format=%(refname) %(objectname)").trim().split("\n");
  return {
    head: git(source, "rev-parse", "HEAD").trim(), branch: git(source, "symbolic-ref", "HEAD").trim(),
    refs: refs.filter((r) => !r.startsWith("refs/canvastty/")).join("\n"),
    status: git(source, "status", "--porcelain", "--untracked-files=all"), files: files.sort().join("\n"),
    canvastty: refs.filter((r) => r.startsWith("refs/canvastty/")).map((r) => r.split(" ")[0])
  };
}
// Every process under `pid` (ps: pid, ppid, pgid, command).
function tree(pid) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8" }).split("\n").filter(Boolean)
    .map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return { pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4] }; });
  const out = [];
  const add = (p) => { for (const r of rows.filter((x) => x.ppid === p)) { out.push(r); add(r.pid); } };
  add(pid);
  return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const tmpProcesses = () => execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).split("\n")
  .filter((l) => l.includes(TMP) && !l.includes("e2e-orchestration.mjs"));
const kinds = (procs) => ({
  supervisor: procs.filter((p) => p.command.includes("supervisor.mjs")).length,
  claudeWrapper: procs.filter((p) => p.command.includes(D("claude-mock"))).length,
  checkNode: procs.filter((p) => p.command.includes("--test")).length,
  total: procs.length
});
// SIGKILL of the main process only (not its group): what a crash of the application does. Then every process that was
// under it must end by itself (lifeline EOF → supervisor clears the CLI group or the check sandbox).
async function crash(app, what) {
  const before = tree(app.child.pid);
  notes[`${what}:processesBeforeKill`] = kinds(before);
  const killedAt = Date.now();
  process.kill(app.child.pid, "SIGKILL");
  const exit = await app.exited;
  let left = before;
  while (Date.now() - killedAt < 30_000 && (left = before.filter((p) => alive(p.pid))).length) await sleep(200);
  const strays = tmpProcesses();
  notes[`${what}:exit`] = exit;
  notes[`${what}:allGoneMs`] = left.length ? null : Date.now() - killedAt;
  expect(exit.signal === "SIGKILL", `${what}: the main process was killed (SIGKILL, no shutdown)`, exit);
  expect(left.length === 0 && strays.length === 0, `${what}: every process of the killed application ended by itself (${before.length} processes)`,
    { left: left.map((p) => p.command.slice(0, 160)), strays: strays.map((s) => s.slice(0, 160)) });
}

// ---------- UI helpers ----------
const launch = () => launchApp({ userData, providers, port: PORT, shots: SHOTS, env: { CANVASTTY_ORCHESTRATION_TEST_DROP_REPLIES: DROP } });
const panelActions = (app) => app.ev(`[...document.querySelectorAll(".orch-panel__actions button, .orch-panel__section button, .orch-summary > button")].filter((b) => !b.closest(".orch-history, .orch-details")).map((b) => b.textContent.trim())`);
const panelStatus = (app) => app.ev(`(() => { const s = ${q(".orch-panel__status")}; return s ? { cls: s.className.replace("orch-panel__section", "").trim(), text: s.querySelector("strong")?.textContent, reason: s.querySelector("span")?.textContent ?? null } : null; })()`);
const statusIs = (app, status, what, ms = 60_000) => app.waitFor(`${q(`.orch-panel__status--${status}`)} && true`, what, ms);
const clickAction = (app, label) => app.clickEl(byText(".orch-panel__actions button, .orch-panel__section button, .orch-summary > button", label));
const openRun = async (app, linkId) => {
  await app.waitFor(`${byText(`[data-agent-link-id="${linkId}"] button`, "Открыть запуск")} && true`, "open run button");
  await app.clickEl(byText(`[data-agent-link-id="${linkId}"] button`, "Открыть запуск"));
  await app.waitFor(`${q(".orch-panel__status")} && true`, "run panel");
};
const until = async (fn, what, ms = 60_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { if ((last = fn())) return last; await sleep(100); }
  throw new Error(`timeout: ${what}`);
};

let app;
let runA, runB, runC, runD;
const before = sourceState();
try {
  // ================= launch 1 =================
  app = await launch();
  await createAgent(app, "Агент Codex (лид)", source);
  await createAgent(app, "Агент Claude (исполнитель)", source);
  let c = await canvasState(app);
  const lead = c.agents.find((a) => a.provider === "codex");
  const exec = c.agents.find((a) => a.provider === "claude");
  await app.drag(await app.center(card(lead.agentId, ".agent-card__port")), await app.center(card(exec.agentId, ".agent-card__body")), 20);
  await app.waitFor(`${q(".agent-link__chip")} && true`, "link chip");
  const linkId = (await canvasState(app)).links[0].linkId;
  const lastRun = async () => (await canvasState(app)).links[0].runIds.at(-1);

  // ---- 1. run A: two stages to completed ----
  log("run A");
  await startGoal(app, linkId, { task: "add src/a.mjs, then src/b.mjs", criteria: "both modules exist\nnode --test passes", workMode: "copy" });
  runA = await lastRun();
  await statusIs(app, "completed", "run A completed", 120_000);
  const opsA = ops(runA).map((o) => o.op);
  notes.runA = timeline(runA);
  expect(JSON.stringify(opsA) === JSON.stringify(["plan", "execute", "check", "review", "execute", "check", "review", "final_review"]),
    "A: plan → executor → check → review for each of two stages → final review", opsA);
  const cps = journal(runA).filter((r) => r.type === "checkpoint.created");
  const seqOf = (type, pred) => journal(runA).find((r) => r.type === type && pred(r.data))?.seq;
  const reviews = journal(runA).filter((r) => r.type === "review.recorded" && r.data.stage !== null);
  const execute2 = ops(runA).filter((o) => o.op === "execute")[1].seq;
  expect(cps.length === 2 && cps[0].data.stage === 1 && cps[1].data.stage === 2 && cps[0].seq > reviews[0].seq && cps[0].seq < execute2
    && cps[1].seq > reviews[1].seq && cps[1].seq < seqOf("orch.turn", (d) => d.purpose === "final_review"),
  "A: a checkpoint after each stage's accepting review, before the next operation", cps.map((r) => [r.seq, r.data.stage]));
  expect(count(runA, "check.finished", (d) => d.status === "passed") === 2 && count(runA, "check.finished") === 2, "A: both checks passed", timeline(runA));
  const finalA = journal(runA).filter((r) => r.type === "run.status").at(-1).data;
  expect(finalA.status === "completed", "A: the journal ends completed", finalA);
  const afterA = sourceState();
  expect(afterA.head === before.head && afterA.branch === before.branch && afterA.refs === before.refs && afterA.status === before.status && afterA.files === before.files,
    "A: the source's HEAD, branch, refs, status and working files are unchanged", { before, afterA });
  expect(afterA.canvastty.length > 0 && afterA.canvastty.every((r) => r.startsWith(`refs/canvastty/${runA}/`)), "A: the source only gained refs/canvastty/<runId>/* refs", afterA.canvastty);
  notes.sourceRefsAfterA = afterA.canvastty.map((r) => r.replace(runA, "<runA>"));
  expect(await app.ev(`document.querySelectorAll(".orch-plan li").length === 2`), "A: the panel shows the two-stage plan", null);
  await app.shot("01-run-a-completed");

  // ---- 5. the history text fails to load, then loads on Repeat ----
  const texts = path.join(userData, "orchestration", "runs", runA, "texts");
  await openTab(app, "history");
  const report = `[...document.querySelectorAll('.orch-history li[data-history-kind="report"]')].at(-1)`;
  for (const f of fs.readdirSync(texts)) fs.chmodSync(path.join(texts, f), 0o000);
  await app.clickEl(`${report}.querySelector(".orch-details__toggle")`);
  await app.waitFor(`${report}.querySelector('[data-details-state="error"]') && true`, "text load error");
  const errorText = await app.ev(`${report}.querySelector(".orch-details__error").textContent`);
  notes.textLoadError = errorText;
  expect(errorText.startsWith("Не удалось загрузить текст") && !errorText.includes("/") && !/E[A-Z]{3,}/.test(errorText),
    "5: a failed text load is said in words (no path, no errno code)", errorText);
  await app.reveal(`${report}.querySelector(".orch-details__error")`);
  await app.shot("02-text-load-failed");
  for (const f of fs.readdirSync(texts)) fs.chmodSync(path.join(texts, f), 0o600);
  await app.clickEl(`${report}.querySelector(".orch-details__error button")`);
  await app.waitFor(`${report}.querySelector('[data-details-state="loaded"] li')?.textContent === "stage 1: src/a.mjs"`, "text after repeat");
  expect(true, "5: Repeat loads the text once it is readable", null);
  await app.reveal(`${report}.querySelector('[data-details-state="loaded"]')`);
  await app.shot("03-text-loaded-after-repeat");
  await app.clickEl(q(".orch-panel__close"));

  // ---- 2. run B: Pause after the turn, Step, Resume, Stop ----
  log("run B");
  fs.writeFileSync(HOLD, "");
  await startGoal(app, linkId, { workMode: "copy" });
  runB = await lastRun();
  await app.waitFor(`${card(exec.agentId, ".agent-card__state")}?.textContent === "Работает"`, "B executor working", 60_000);
  await clickAction(app, "Пауза после хода");
  await statusIs(app, "pausing", "B pausing");
  expect(JSON.stringify(await panelActions(app)).includes("Не останавливаться"), "B: while pausing, Keep running and Stop are offered", await panelActions(app));
  await app.shot("04-run-b-pausing");
  fs.rmSync(HOLD);
  await statusIs(app, "paused", "B paused after the turn");
  await sleep(1500);
  const opsPaused = ops(runB).map((o) => o.op);
  expect(JSON.stringify(opsPaused) === JSON.stringify(["plan", "execute"]) && count(runB, "turn.finished") === 2,
    "B: Pause lets the executor's turn end and starts nothing after it", opsPaused);
  const pausedActions = await panelActions(app);
  expect(["Продолжить", "Один шаг", "Стоп"].every((a) => pausedActions.includes(a)), "B: paused: Resume, Step, Stop", pausedActions);
  await clickAction(app, "Один шаг");
  await until(() => ops(runB).length === 3 && count(runB, "run.status", (d) => d.status === "paused") >= 2 && journal(runB).at(-1).type === "run.status" ? true : null, "B step done", 60_000);
  await statusIs(app, "paused", "B paused after the step");
  await sleep(1500);
  const opsStep = ops(runB).map((o) => o.op);
  expect(JSON.stringify(opsStep) === JSON.stringify(["plan", "execute", "check"]), "B: Step runs exactly one operation (the check) and pauses", opsStep);
  notes.runBStepReason = (await panelStatus(app)).reason;
  fs.writeFileSync(HOLD, "");
  await clickAction(app, "Продолжить");
  await app.waitFor(`${card(exec.agentId, ".agent-card__state")}?.textContent === "Работает"`, "B round 2 executor working", 60_000);
  const opsResumed = ops(runB).map((o) => o.op);
  expect(JSON.stringify(opsResumed) === JSON.stringify(["plan", "execute", "check", "review", "execute"]), "B: Resume continues: review (fix), executor round 2", opsResumed);
  const callsAtStop = calls();
  await clickAction(app, "Стоп");
  await statusIs(app, "stopped", "B stopped");
  const stopSeq = journal(runB).find((r) => r.type === "command.received" && r.data.kind === "stop").seq;
  fs.rmSync(HOLD, { force: true });
  await sleep(3000);
  const afterStop = journal(runB).filter((r) => r.seq > stopSeq);
  expect(!afterStop.some((r) => r.type === "orch.turn" || r.type === "check.started" || r.type === "turn.intent"),
    "B: after the accepted Stop no operation starts", afterStop.map((r) => r.type));
  const stoppedTurn = journal(runB).filter((r) => r.type === "turn.finished").at(-1).data;
  expect(stoppedTurn.outcome === "stopped" && JSON.stringify(calls()) === JSON.stringify(callsAtStop),
    "B: the active executor turn ended stopped; no CLI call after the Stop", [stoppedTurn.outcome, calls(), callsAtStop]);
  notes.runB = timeline(runB);
  await app.shot("05-run-b-stopped");
  await app.clickEl(q(".orch-panel__close"));

  // ---- 3a. run C: main killed while the executor's turn runs ----
  log("run C");
  fs.writeFileSync(HOLD, "");
  await startGoal(app, linkId, { workMode: "copy" });
  runC = await lastRun();
  await app.waitFor(`${card(exec.agentId, ".agent-card__state")}?.textContent === "Работает"`, "C executor working", 60_000);
  await until(() => tree(app.child.pid).some((p) => p.command.includes(D("claude-mock"))) || null, "C CLI process", 20_000);
  const historyC = journal(runC).length;
  const canvasBefore = await canvasState(app);
  const callsC = calls();
  await app.shot("06-run-c-before-kill");
  await crash(app, "turn crash");
  fs.rmSync(HOLD);

  // ================= launch 2 =================
  log("launch 2");
  app = await launch();
  await app.waitFor(`document.querySelectorAll("[data-agent-id]").length === 2 && ${q(".agent-link__chip")} && true`, "cards after the crash");
  await sleep(2000);
  c = await canvasState(app);
  expect(JSON.stringify(c) === JSON.stringify(canvasBefore), "3: after the crash: cards, geometry and link (with its runs) as before", { c, canvasBefore });
  expect(journal(runC).length === historyC && JSON.stringify(calls()) === JSON.stringify(callsC) && (await runs(app)).every((r) => !r.open),
    "3: nothing repeated by itself: no journal record, no CLI call, no run opened", [journal(runC).length, historyC, calls(), callsC]);
  await openRun(app, linkId);
  await sleep(1000);
  const statusC = await panelStatus(app);
  const actionsC = await panelActions(app);
  notes.turnCrashPanel = { statusC, actionsC };
  expect(statusC?.cls.includes("paused") && statusC.text?.includes("Неизвестно, чем закончился ход"),
    "3: the interrupted turn is shown as paused, outcome unknown", statusC);
  expect(["Принять результат хода", "Повторить ход", "Вернуть к последнему checkpoint", "Стоп"].every((a) => actionsC.includes(a)) && !actionsC.includes("Продолжить"),
    "3: the recovery actions are offered (accept, retry, reset, Stop), not Resume", actionsC);
  await openTab(app, "history");
  await app.waitFor(`document.querySelectorAll(".orch-history li").length > 0`, "history tab");
  expect(true, "3: the history of the run is shown", null);
  expect(journal(runC).length === historyC || count(runC, "run.recovered") === 1, "3: opening the panel starts nothing", timeline(runC).slice(historyC));
  await app.shot("07-run-c-after-restart");

  // ---- 4. retry turn with the reply dropped; repeated after a window reload ----
  fs.writeFileSync(path.join(DROP, "recover"), "");
  await clickAction(app, "Повторить ход");
  await app.waitFor(`${q(".orch-panel__unknown")} && true`, "unknown result shown");
  const notice = await app.ev(`${q(".dialog-error")}?.textContent ?? null`);
  expect(notice?.startsWith("Нет связи с приложением") && !fs.existsSync(path.join(DROP, "recover")), "4: the dropped reply is reported; the command is pending", notice);
  expect(count(runC, "recovery.decided") === 1 && count(runC, "command.received", (d) => d.kind === "recover") === 1, "4: main carried the recover out once", timeline(runC));
  await app.shot("08-reply-lost");
  await app.call("Page.reload", { ignoreCache: false });
  await sleep(500);
  await app.waitFor(`${q(".agent-link__chip")} && true`, "chip after reload");
  await openRun(app, linkId);
  await app.waitFor(`${q(".orch-panel__unknown button")} && true`, "pending command after reload");
  const repeatLabel = await app.ev(`${q(".orch-panel__unknown button")}.textContent`);
  expect(repeatLabel === "Повторить: восстановление", "4: after a window reload the panel still offers to repeat the command", repeatLabel);
  await app.shot("09-pending-after-reload");
  await app.clickEl(q(".orch-panel__unknown button"));
  await app.waitFor(`!${q(".orch-panel__unknown")}`, "pending settled");
  await sleep(1000);
  expect(count(runC, "recovery.decided") === 1 && count(runC, "command.received", (d) => d.kind === "recover") === 1 && ops(runC).length === 2,
    "4: the repeat after the reload is answered with the recorded result, nothing done twice", timeline(runC));
  await statusIs(app, "paused", "C paused after recover");
  // ---- 4. resume with the reply dropped; repeated without a reload ----
  fs.writeFileSync(path.join(DROP, "resume"), "");
  await clickAction(app, "Продолжить");
  await app.waitFor(`${q(".orch-panel__unknown button")} && true`, "resume pending");
  await app.clickEl(q(".orch-panel__unknown button"));
  await app.waitFor(`!${q(".orch-panel__unknown")}`, "resume settled");
  await statusIs(app, "completed", "C completed", 120_000);
  const opsC = ops(runC).map((o) => o.op);
  expect(count(runC, "command.received", (d) => d.kind === "resume") === 1 && JSON.stringify(opsC) === JSON.stringify(["plan", "execute", "execute", "check", "review", "final_review"]),
    "4: the repeated Resume is carried out once; the retried turn runs once, then check, review, final review", opsC);
  notes.runC = timeline(runC);
  await app.shot("10-run-c-completed");
  await app.clickEl(q(".orch-panel__close"));

  // ---- 3b. run D: main killed while the check runs ----
  log("run D");
  fs.writeFileSync(HOLD_CHECK, "");
  await startGoal(app, linkId, { workMode: "copy" });
  runD = await lastRun();
  await until(() => count(runD, "check.started") === 1 || null, "D check started", 90_000);
  await until(() => tree(app.child.pid).some((p) => p.command.includes("--test")) || null, "D check process", 20_000);
  await sleep(500);
  const historyD = journal(runD).length;
  const callsD = calls();
  await app.shot("11-run-d-check-running");
  await crash(app, "check crash");
  fs.rmSync(HOLD_CHECK);

  // ================= launch 3 =================
  log("launch 3");
  app = await launch();
  await app.waitFor(`${q(".agent-link__chip")} && true`, "chip after the second crash");
  await sleep(2000);
  expect(journal(runD).length === historyD && JSON.stringify(calls()) === JSON.stringify(callsD), "3: after the crash during the check nothing repeated by itself", [journal(runD).length, historyD]);
  await openRun(app, linkId);
  await sleep(1000);
  const statusD = await panelStatus(app);
  const actionsD = await panelActions(app);
  notes.checkCrashPanel = { statusD, actionsD };
  expect(statusD?.cls.includes("paused") && statusD.text?.includes("восстановлен"), "3: the run with the interrupted check is shown paused, recovered", statusD);
  expect(["Продолжить", "Один шаг", "Стоп"].every((a) => actionsD.includes(a)), "3: Resume, Step and Stop are offered", actionsD);
  expect(count(runD, "check.started") === 1 && JSON.stringify(calls()) === JSON.stringify(callsD), "3: the interrupted check is not run again by itself", timeline(runD));
  await app.shot("12-run-d-after-restart");
  await clickAction(app, "Продолжить");
  await statusIs(app, "completed", "D completed", 120_000);
  // The interrupted check gets no journal record of its own: reading the run decides it (markInterruptedChecks).
  const startedD = journal(runD).filter((r) => r.type === "check.started").map((r) => r.data.checkRunId);
  const { state: stD } = await readRun(path.join(userData, "orchestration"), runD);
  const checksD = startedD.map((id) => `${stD.checks[id].status}${stD.checks[id].reason ? `/${stD.checks[id].reason}` : ""}`);
  expect(JSON.stringify(checksD) === JSON.stringify(["not_verified/interrupted", "passed"]) && count(runD, "run.recovered") === 1,
    "3: the interrupted check is not_verified(interrupted); Resume runs it again (a new check run) and it passes", checksD);
  notes.runD = timeline(runD);
  await app.shot("13-run-d-completed");

  const end = sourceState();
  expect(end.head === before.head && end.branch === before.branch && end.refs === before.refs && end.status === before.status && end.files === before.files,
    "1: at the end the source's HEAD, branch, refs, status and working files are unchanged", { before, end });
  notes.quit = await app.quit();
  expect(tmpProcesses().length === 0, "no process of the test left", tmpProcesses());
} catch (error) {
  await app?.shot("failure").catch(() => {});
  failures.push(`fatal: ${String(error?.stack ?? error)}`);
  log(`fatal: ${error?.stack ?? error}`);
  for (const [k, id] of Object.entries({ runA, runB, runC, runD })) if (id) try { notes[`${k}:timeline`] = timeline(id); } catch {}
} finally {
  try { fs.rmSync(HOLD, { force: true }); fs.rmSync(HOLD_CHECK, { force: true }); } catch {}
  await app?.stop().catch(() => {});
}
const anon = (v) => JSON.parse(JSON.stringify(v).split(TMP).join("<tmp>").split(process.env.HOME ?? "\0").join("~")
  .replaceAll(runA ?? "\0", "<runA>").replaceAll(runB ?? "\0", "<runB>").replaceAll(runC ?? "\0", "<runC>").replaceAll(runD ?? "\0", "<runD>"));
const summary = anon({ ok: failures.length === 0, passed: passed.length, failed: failures.length, failures, checks: passed, notes, durationMs: Date.now() - t0 });
fs.writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: summary.ok, passed: summary.passed, failures: summary.failures, out: OUT }, null, 2)}\n`);
process.exitCode = failures.length ? 1 : 0;
if (outArg > 0 && failures.length === 0) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
