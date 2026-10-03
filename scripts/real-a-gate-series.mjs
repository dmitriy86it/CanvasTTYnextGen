// Stage A release gate, part 2: a real series of the development build with journal v2 (CANVASTTY_JOURNAL_V2=1), new
// projects in rights «Рабочая папка» (the default), autopilot, each scenario on its own temporary userData and project:
//   R1  a goal with its check commands → completed, confirmed, every condition met
//   R2  the check commands left empty → the lead proposes them, they run in the check sandbox, accepted by the
//       autopilot → completed, confirmed
//   R3  a project without tests, commands empty → no command proposed, «Завершено без проверок»; push to a local bare
//       repository is asked of the person, never made by itself (a worktree: a separate copy cannot push), declined
//   R4  «Стоп» during a Claude turn → stopped, no process of the run left
//   R5  «Пауза после хода» during a Claude turn, then «Продолжить» → completed
// R1, R2, R4, R5 run in a separate copy (workMode copy). A permission prompt of a CLI is recorded and denied (the
// person's safe answer); it is the evidence of what the work-folder mode asks.
//   --rehearse   fake CLIs (no model request): checks this script
//   --real       the installed codex and claude (REAL model requests)
// --only R1,R3 · --out <dir> (default docs/agent-orchestration/evidence/real-a-gate) · --calls <n> the series' model
// call budget (default 36) · --minutes <n> (default 90). A scenario starts only if its turn limit fits what is left;
// the series stops at the first scenario that does not reach its expected state, and on a CLI usage limit (its feed is
// kept). The app's code is not changed; only its journal, activity and the projects are read.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURES, NODE, byText, canvasState, launch as launchApp, q, sleep, startGoal, workspace } from "./orchestration-app-kit.mjs";

const REAL = process.argv.includes("--real");
const REHEARSE = process.argv.includes("--rehearse");
if (REAL === REHEARSE) throw new Error("exactly one of --real or --rehearse");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const ORDER = (arg("--only") ?? "R1,R2,R3,R4,R5").split(",");
const CALLS = Number(arg("--calls") ?? 36);
const SERIES_MS = Number(arg("--minutes") ?? 90) * 60_000;
const { TMP, D, git } = workspace(REAL ? "cto-a-gate-" : "cto-a-gate-rh-");
const OUT = path.resolve(arg("--out") ?? (REAL ? path.join(FIXTURES, "..", "..", "..", "docs", "agent-orchestration", "evidence", "real-a-gate") : D("out")));
fs.mkdirSync(OUT, { recursive: true });
const SHOTS = D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const t0 = Date.now();
const report = { mode: REAL ? "real" : "rehearse", startedAt: new Date(t0).toISOString(), budget: { calls: CALLS, minutes: SERIES_MS / 60_000 }, versions: {}, scenarios: {}, failures: [] };
const logLines = [];
const anon = (s) => String(s ?? "").replaceAll(TMP, "<tmp>").replaceAll(os.homedir(), "~");
const log = (m) => { const l = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${anon(m)}`; logLines.push(l); process.stderr.write(`${l}\n`); };
class Halt extends Error {}
const halt = (why) => { throw new Halt(why); };

const LIMITS = { R1: 7, R2: 8, R3: 7, R4: 3, R5: 7 };
const CLAMP = {
  task: "Add a function clamp(x, lo, hi) in src/clamp.mjs (ES module, named export) that returns x limited to [lo, hi] and throws RangeError when lo > hi. Add a unit test tests/clamp.test.mjs. Do not modify tests/clamp.accept.test.mjs.",
  criteria: "tests/clamp.accept.test.mjs passes unchanged\nall tests pass"
};
const DOCS = { task: "Add a section \"Usage\" to README.md that says in two sentences how to read notes/ideas.md. Change no other file.", criteria: "README.md has a Usage section about notes/ideas.md" };
const SCEN = {
  R1: { goal: CLAMP, project: "series", commands: ["node --test"], workMode: "copy" },
  R2: { goal: CLAMP, project: "series", commands: [], workMode: "copy" },
  R3: { goal: DOCS, project: "docs", commands: [], workMode: "worktree", push: true },
  R4: { goal: CLAMP, project: "series", commands: ["node --test"], workMode: "copy", action: "stop" },
  R5: { goal: CLAMP, project: "series", commands: ["node --test"], workMode: "copy", action: "pause" }
};

// ---------- CLIs ----------
const which = (name) => { try { return execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(); } catch { return null; } };
if (REAL) for (const cli of ["codex", "claude"]) {
  const bin = which(cli);
  report.versions[cli] = bin ? execFileSync(bin, ["--version"], { encoding: "utf8" }).split("\n")[0].trim() : null;
  if (!bin) { process.stdout.write(`${JSON.stringify({ ok: false, stop: `${cli} not found` })}\n`); process.exit(1); }
}
// the person's global CLI files: recorded before and after (a CLI may write its own trust or state there)
const GLOBAL = [".codex/config.toml", ".claude/settings.json"].map((f) => path.join(os.homedir(), f));
const hashes = () => Object.fromEntries(GLOBAL.map((f) => [anon(f), fs.existsSync(f) ? execFileSync("shasum", ["-a", "256", f], { encoding: "utf8" }).split(" ")[0] : null]));
report.globalBefore = hashes();

// rehearsal: v2 answers of the fake lead/reviewer and executor, per scenario
const HOLD = D("hold-claude");
function rehearsalProviders(name, dir) {
  const { script } = workspace("cto-a-gate-rh-s-");
  const change = (text, covers) => ({ keep: null, text, covers, evidence: { kind: "change", check: null } });
  const docs = name === "R3";
  const conds = docs ? [change("README.md has a Usage section", ["R1"])] : [change("src/clamp.mjs exists", ["R1"]), change("tests pass", ["R2"])];
  const ids = conds.map((_, i) => `C${i + 1}`);
  const paths = docs ? ["README.md"] : ["src/clamp.mjs"];
  const plan = { report: { stages: [{ title: "work", task: "do it", conditions: conds }], dropped: [], dropRequirements: [], question: null } };
  const review = { report: { conditions: ids.map((id) => ({ id, status: "met", paths, note: "done" })), findings: [], request: "none", question: null } };
  const final = { report: { conditions: [], findings: [], request: "none", question: null, requirements: (docs ? ["R1"] : ["R1", "R2"]).map((id) => ({ id, status: "met", note: "done" })) } };
  const exec = docs ? { report: { summary: "usage", done: true }, writes: [["README.md", "# notes\n\n## Usage\n\nOpen notes/ideas.md. Read it top down.\n"]] }
    : { report: { summary: "clamp", done: true }, writes: [["src/clamp.mjs", "export function clamp(x, lo, hi) {\n  if (lo > hi) throw new RangeError(\"empty range\");\n  return Math.min(hi, Math.max(lo, x));\n}\n"]] };
  const codex = script(`${name}-codex`, [plan, review, final, plan, review, final]);
  const claude = script(`${name}-claude`, [exec, exec]);
  const st = path.join(dir, "mock-state");
  fs.mkdirSync(path.join(st, ".codex"), { recursive: true });
  const wrap = (p) => {
    const f = path.join(dir, `${p}-mock`);
    fs.writeFileSync(f, `#!/bin/sh\n${p === "claude" ? `case "$1" in --help|--version) ;; *) while [ -e "${HOLD}" ]; do sleep 0.1; done ;; esac\n` : ""}exec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
    return f;
  };
  const env = (extra) => ({ HOME: st, MOCK_STATE: st, ...extra });
  const checks = name === "R2" ? { MOCK_CHECKS: "proposed", MOCK_CHECK_COMMAND: "node --test" } : name === "R3" ? { MOCK_CHECKS: "none" } : {};
  const file = path.join(dir, "providers.json");
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: `${path.dirname(NODE)}:/usr/bin:/bin`, env: env({ MOCK_SCRIPT: codex, CODEX_HOME: path.join(st, ".codex"), ...checks }) },
    claude: { executable: wrap("claude"), version: "2.1.287 (Claude Code)", path: `${path.dirname(NODE)}:/usr/bin:/bin`, env: env({ MOCK_SCRIPT: claude }) }
  }));
  return file;
}

// ---------- projects ----------
function makeProject(name, kind) {
  const dir = D(name, "project");
  if (kind === "series") fs.cpSync(path.join(FIXTURES, "series-project"), dir, { recursive: true });
  else {
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "# notes\n\nA folder of notes.\n");
    fs.writeFileSync(path.join(dir, "notes", "ideas.md"), "# Ideas\n\n- one\n- two\n");
  }
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "gate project"]]) git(dir, ...a);
  return dir;
}

// ---------- observation ----------
const journalOf = (root, runId) => fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const lastStatus = (j) => j.filter((r) => r.type === "run.status").at(-1)?.data ?? null;
function tree(pid) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").filter(Boolean)
    .map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return { pid: +m[1], ppid: +m[2], command: m[3] }; });
  const out = [];
  const add = (p) => { for (const r of rows.filter((x) => x.ppid === p)) { out.push(r); add(r.pid); } };
  add(pid);
  return out;
}
const runProcesses = (mainPid) => tree(mainPid).filter((p) => p.command.includes("supervisor.mjs")).flatMap((s) => [s, ...tree(s.pid)]);
const isClaude = (p) => !p.command.includes("supervisor.mjs") && p.command.split(" ").slice(0, 2).some((t) => path.basename(t).startsWith("claude"));
const clickAction = (app, label) => app.clickEl(byText(".orch-panel__actions button, .orch-panel__section button, .orch-summary > button, .orch-panel__row button", label));
const calls = () => Object.values(report.scenarios).reduce((n, s) => n + (s.calls ?? 0), 0);
const LIMIT_TEXT = /usage limit|rate limit|limit reached|hit your limit|quota|429|overloaded|try again (at|later|in)/i;

async function scenario(name) {
  const s = SCEN[name];
  const rec = { workMode: s.workMode, commands: s.commands, turnsLimit: LIMITS[name], prompts: [] };
  report.scenarios[name] = rec;
  const dir = D(name);
  fs.mkdirSync(dir, { recursive: true });
  const project = makeProject(name, s.project);
  let remote = null;
  if (s.push) {
    remote = D(name, "remote.git");
    git(TMP, "init", "-q", "--bare", remote);
    git(project, "remote", "add", "origin", remote);
  }
  const userData = path.join(dir, "user-data");
  const root = path.join(userData, "orchestration");
  const providers = REHEARSE ? rehearsalProviders(name, dir) : undefined;
  if (s.action && REHEARSE) fs.writeFileSync(HOLD, "");
  const app = await launchApp({ userData, providers, port: 9300 + Math.floor(Math.random() * 500), shots: SHOTS, env: { CANVASTTY_JOURNAL_V2: "1" }, hermetic: REHEARSE });
  let runId = null;
  try {
    const ids = await app.ev(`(async () => {
      const o = window.canvasTTY.orchestration;
      const mk = async (provider, x) => (await o.createAgent({ agentId: crypto.randomUUID(), provider, project: ${JSON.stringify(project)}, bounds: { position: { x, y: 80 }, size: { width: 300, height: 176 } }, workspaceId: "common" })).value.agentId;
      const lead = await mk("codex", 40), exec = await mk("claude", 420);
      return (await o.createLink({ linkId: crypto.randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
    })()`);
    await app.ev("location.reload()");
    await app.waitFor(`${q(`[data-agent-link-id="${ids}"]`)} && true`, "the link chip");
    if (s.push) {
      const saved = await app.ev(`(async () => { const o = window.canvasTTY.orchestration; const info = (await o.profile(${JSON.stringify(ids)})).value;
        const r = await o.saveProfile(${JSON.stringify(ids)}, { ...info.profile, finish: { ...info.profile.finish, commit: true, push: { remote: "origin", branch: "gate", remoteUrl: null } } });
        return r.ok ? r.value.access : r; })()`);
      log(`${name}: push to origin/gate configured; access ${JSON.stringify(saved)}`);
    }
    try {
      await startGoal(app, ids, {
        task: s.goal.task, criteria: s.goal.criteria, commands: s.commands, workMode: s.workMode,
        onDialog: async () => {
          const inputs = `document.querySelectorAll(".orch-limits input")`;
          for (const [i, v] of [LIMITS[name], 2, 1, 20].entries()) await app.type(`${inputs}[${i}]`, String(v));
          if (s.push) await app.clickEl(q('[data-finish-option="push"] input'));
        }
      });
    } catch (e) {
      halt(`${name}: the goal was not started: ${await app.ev(`[...document.querySelectorAll(".orch-dialog .dialog-error, .orch-dialog [role=alert]")].map((e) => e.textContent).join(" | ")`).catch(() => "?")} (${e.message.slice(0, 120)})`);
    }
    runId = (await canvasState(app)).links[0].runIds.at(-1);
    rec.runId = runId;
    log(`${name}: run ${runId.slice(0, 8)} started (${s.workMode}, commands ${JSON.stringify(s.commands)})`);
    const view = () => app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.view)`);
    // waits for one of `want`; records and denies each permission prompt on the way
    const until = async (want, ms = 22 * 60_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (Date.now() - t0 > SERIES_MS) halt("series time limit reached");
        const v = await view();
        if (v.permission) {
          const p = v.permission;
          rec.prompts.push({ at: new Date().toISOString(), role: p.role ?? null, provider: p.provider ?? null, kind: p.kind, tool: p.tool ?? null, summary: anon(p.summary ?? "").slice(0, 400), answer: "deny" });
          log(`${name}: permission prompt ${p.kind} ${p.tool ?? ""}: ${anon(p.summary ?? "").slice(0, 160)} → deny`);
          await app.clickEl(q(`[data-orch-permission] [data-decision="deny"]`)).catch(async () => app.ev(`window.canvasTTY.orchestration.command(${JSON.stringify(runId)}, { commandId: crypto.randomUUID(), expectedRevision: ${v.revision}, command: { kind: "permission", requestId: ${JSON.stringify(p.requestId)}, decision: "deny" } })`));
          await sleep(1500);
          continue;
        }
        if (want(v)) return v;
        if (["completed", "stopped", "failed"].includes(v.status) || (v.status === "paused" && !want(v))) return v;
        await sleep(1000);
      }
      halt(`${name}: no expected state in time`);
    };
    const claudeRunning = async () => {
      const end = Date.now() + 15 * 60_000;
      while (Date.now() < end) {
        const j = journalOf(root, runId);
        const intent = j.filter((r) => r.type === "turn.intent" && r.data.provider === "claude").at(-1);
        const finished = intent && j.some((r) => r.type === "turn.finished" && r.data.turnId === intent.data.turnId);
        if (intent && !finished && tree(app.child.pid).some(isClaude)) return intent.data.turnId;
        const st = lastStatus(j);
        if (st && st.status !== "running" && st.status !== "preparing") halt(`${name}: left running before a Claude turn: ${JSON.stringify(st)}`);
        await sleep(REAL ? 300 : 100);
      }
      halt(`${name}: no Claude turn started`);
    };

    let v;
    if (s.action === "stop") {
      const turnId = await claudeRunning();
      log(`${name}: Claude turn ${turnId.slice(0, 8)} running; «Стоп»`);
      await clickAction(app, "Стоп");
      if (REHEARSE) fs.rmSync(HOLD, { force: true });
      v = await until((x) => x.status === "stopped", 3 * 60_000);
      const fin = journalOf(root, runId).find((r) => r.type === "turn.finished" && r.data.turnId === turnId);
      rec.stoppedTurn = fin?.data.outcome ?? null;
      await sleep(5000);
      rec.leftProcesses = runProcesses(app.child.pid).map((p) => anon(p.command).slice(0, 160));
      rec.ok = v.status === "stopped" && rec.leftProcesses.length === 0;
    } else if (s.action === "pause") {
      const turnId = await claudeRunning();
      log(`${name}: Claude turn ${turnId.slice(0, 8)} running; «Пауза после хода»`);
      await clickAction(app, "Пауза после хода");
      if (REHEARSE) fs.rmSync(HOLD, { force: true });
      const p = await until((x) => x.status === "paused" && x.reason === "user_request", 15 * 60_000);
      rec.paused = { status: p.status, reason: p.reason, turn: journalOf(root, runId).find((r) => r.type === "turn.finished" && r.data.turnId === turnId)?.data.outcome ?? null };
      log(`${name}: paused (${p.reason}); «Продолжить»`);
      if (p.status !== "paused") { v = p; rec.ok = false; }
      else {
        await clickAction(app, "Продолжить");
        await sleep(1500);
        v = await until((x) => x.status === "completed");
        rec.ok = v.status === "completed" && lastStatus(journalOf(root, runId))?.completion?.kind === "confirmed";
      }
    } else if (s.push) {
      v = await until((x) => x.status === "completed" || (x.status === "paused" && x.reason === "awaiting_finish_confirmation"));
      rec.remoteBeforeDecision = git(remote, "for-each-ref", "--format=%(refname)").trim();
      if (v.status === "paused" && v.reason === "awaiting_finish_confirmation") {
        rec.finishPause = { confirm: v.confirm ?? null };
        log(`${name}: push waits for the person; remote refs: ${JSON.stringify(rec.remoteBeforeDecision)}; «Не отправлять»`);
        await app.waitFor(`${q("[data-orch-finish-confirm]")} && true`, "finish confirmation", 30_000);
        await app.clickEl(q('[data-orch-finish-choice="push:decline"]'));
        await app.clickEl(q("[data-orch-finish-submit]"));
        await sleep(1500);
        v = await until((x) => x.status === "completed");
      }
      rec.remoteAtEnd = git(remote, "for-each-ref", "--format=%(refname)").trim();
      rec.ok = v.status === "completed" && lastStatus(journalOf(root, runId))?.completion?.kind === "no_checks" && rec.remoteBeforeDecision === "" && rec.remoteAtEnd === "";
    } else {
      v = await until((x) => x.status === "completed");
      rec.ok = v.status === "completed" && lastStatus(journalOf(root, runId))?.completion?.kind === "confirmed";
    }
    await app.shot(`${name}-end`).catch(() => {});
    // what the journal says
    const j = journalOf(root, runId);
    const st = lastStatus(j);
    rec.status = st;
    rec.calls = j.filter((r) => r.type === "turn.intent").length;
    rec.turns = j.filter((r) => r.type === "turn.intent").map((r) => `${r.data.role ?? ""}/${r.data.provider}`);
    rec.turnOutcomes = j.filter((r) => r.type === "turn.finished").map((r) => r.data.outcome);
    rec.protocolErrors = j.filter((r) => /protocol/.test(JSON.stringify(r.data ?? {}))).map((r) => `${r.type}: ${JSON.stringify(r.data).slice(0, 300)}`);
    rec.journalVersion = [...new Set(j.map((r) => r.v))];
    rec.access = v.progress?.access ?? null;
    rec.conditions = v.progress?.conditions ? { met: v.progress.conditions.met, total: v.progress.conditions.total, requirements: v.progress.conditions.requirements?.map((r) => `${r.id}:${r.status}`) } : null;
    rec.checks = v.progress?.checks?.map((c) => `${c.command ?? c.checkId}:${c.status}`) ?? null;
    rec.checksFrom = v.progress?.checksFrom ?? null;
    rec.permissionRecords = j.filter((r) => r.type.startsWith("permission.")).map((r) => `${r.type}: ${anon(JSON.stringify(r.data)).slice(0, 300)}`);
    rec.integrity = await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.integrity ?? r.value.view.integrity ?? null)`).catch(() => null);
    // without evidence: completed must be confirmed with every condition met, or no_checks with no command run
    if (st?.status === "completed") {
      const k = st.completion?.kind;
      rec.groundless = !(k === "confirmed" && rec.conditions && rec.conditions.met === rec.conditions.total) && !(k === "no_checks");
      if (rec.groundless) rec.ok = false;
    }
    if (rec.protocolErrors.length) rec.ok = false;
    const activity = await app.ev(`window.canvasTTY.orchestration.activity(${JSON.stringify(runId)}, 0, 5000).then((r) => r.value.entries)`).catch(() => []);
    rec.usageLimit = activity.some((e) => (e.kind === "error" || e.kind === "warning") && LIMIT_TEXT.test(JSON.stringify(e.detail ?? e.text ?? "")));
    fs.mkdirSync(path.join(OUT, name), { recursive: true });
    fs.writeFileSync(path.join(OUT, name, "journal.jsonl"), anon(fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8")));
    fs.writeFileSync(path.join(OUT, name, "activity.json"), `${anon(JSON.stringify(activity, null, 1))}\n`);
    log(`${name}: ${rec.ok ? "OK" : "NOT OK"} — ${st?.status}${st?.reason ? `/${st.reason}` : ""} ${st?.completion?.kind ?? ""}; calls ${rec.calls}; prompts ${rec.prompts.length}; protocol errors ${rec.protocolErrors.length}`);
    if (rec.usageLimit) halt(`${name}: a CLI usage limit (feed kept in ${name}/activity.json)`);
  } finally {
    if (runId) {
      const v = await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(runId)}).then((r) => r.value.view.status)`).catch(() => null);
      if (["running", "pausing", "preparing", "paused"].includes(v)) await clickAction(app, "Стоп").catch(() => {});
    }
    fs.rmSync(HOLD, { force: true });
    await app.quit().catch(() => app.stop());
  }
}

try {
  for (const name of ORDER) {
    if (calls() + LIMITS[name] > CALLS) halt(`${name}: its turn limit ${LIMITS[name]} does not fit the calls left (${CALLS - calls()})`);
    await scenario(name);
    if (!report.scenarios[name].ok) { report.failures.push(name); halt(`${name} did not reach its expected state`); }
  }
} catch (e) {
  report.halted = anon(e instanceof Halt ? e.message : e?.stack ?? String(e));
  log(`HALT: ${report.halted}`);
}
report.globalAfter = hashes();
report.globalChanged = Object.keys(report.globalBefore).filter((k) => report.globalBefore[k] !== report.globalAfter[k]);
report.calls = calls();
report.durationMs = Date.now() - t0;
report.ok = !report.halted && ORDER.every((n) => report.scenarios[n]?.ok);
for (const [n, s] of Object.entries(report.scenarios)) if (s.runId) s.runId = `<${n}>`;
fs.writeFileSync(path.join(OUT, "report.json"), `${anon(JSON.stringify(report, null, 2))}\n`);
fs.writeFileSync(path.join(OUT, "series.log"), `${logLines.join("\n")}\n`);
process.stdout.write(`${JSON.stringify({ ok: report.ok, halted: report.halted ?? null, calls: report.calls, minutes: +(report.durationMs / 60_000).toFixed(1), out: anon(OUT), shots: anon(SHOTS) })}\n`);
process.exitCode = report.ok ? 0 : 1;
