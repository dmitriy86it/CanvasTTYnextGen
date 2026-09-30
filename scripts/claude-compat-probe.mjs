// Claude Code compatibility probe for a new CLI version (docs/agent-orchestration/evidence/claude-<version>/).
// TWO real turns through the application's own native path (manager.ts nativeRuntime -> createNativeAgents ->
// providers.ts buildNativeTurn/startNativeTurn -> sessions.ts claudeHostDriver -> turn.ts + supervisor): a new
// temporary Git project with one file, 1) a short first turn that reads README.md and answers one word, 2) the same
// session resumed (--resume). Rights: «Как в моём терминале» (access terminal: no permission flag). Any permission
// prompt of the CLI is DENIED and recorded. Each turn: hard limit 120 s, no retry; the probe stops at the first failure.
//   --real          the installed `claude` (REAL model requests, two turns) — run by the coordinator, not by tests
//   --dry           tests/fixtures/orchestration/mock-claude.mjs behind a --version wrapper (no model request)
//   --expect <v>    the version the real CLI must report (default 2.1.282); another one stops before any turn
//   --out <dir>     default docs/agent-orchestration/evidence/claude-<expect>/ (probe.json, probe.log; --dry: probe-dry.*)
// Recorded: versions, system/init model/permissionMode/field names, event types and control_request subtypes in
// order, the answer text cut to 200 chars, result subtype/is_error/cost, exit code, session id equality, and that no
// process of the turn's tree is left. Not recorded: prompts, environment values, user configuration contents.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { nativeRuntime } from "../src/main/services/orchestration/manager.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REAL = process.argv.includes("--real");
const DRY = process.argv.includes("--dry");
if (REAL === DRY) throw new Error("exactly one of --real or --dry");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const EXPECT = arg("--expect") ?? "2.1.282";
const OUT = path.resolve(arg("--out") ?? path.join(ROOT, "docs", "agent-orchestration", "evidence", `claude-${EXPECT}`));
const STEM = DRY ? "probe-dry" : "probe";
const TURN_MS = 120_000;
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(ROOT, "src", "orchestration", "supervisor.mjs")], env: {} };
const SCHEMA = { type: "object", properties: { word: { type: "string", maxLength: 64 } }, required: ["word"], additionalProperties: false };
const WORD = "lantern";

fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cto-claude-probe-")));
const t0 = Date.now();
const lines = [];
const anon = (s) => String(s ?? "").replaceAll(TMP, "<tmp>").replaceAll(os.homedir(), "~");
const log = (m) => { const l = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${anon(m)}`; lines.push(l); process.stderr.write(`${l}\n`); };
const report = { mode: DRY ? "dry" : "real", expect: EXPECT, startedAt: new Date(t0).toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, versions: {}, turns: [], checks: [], ok: false };
const check = (ok, what, got) => { report.checks.push({ ok, what, ...(ok ? {} : { got }) }); log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` ${JSON.stringify(got)?.slice(0, 300)}`}`); return ok; };
function save() {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, `${STEM}.json`), `${anon(JSON.stringify(report, null, 2))}\n`);
  fs.writeFileSync(path.join(OUT, `${STEM}.log`), `${lines.join("\n")}\n`);
}

// ---------- the CLIs ----------
const which = (name) => { try { return execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || null; } catch { return null; } };
let claudeExe, codexExe;
// The base environment of a CanvasTTY terminal, without what the calling agent session (Claude Code) set for itself.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => typeof v === "string"
  && k !== "ELECTRON_RUN_AS_NODE" && k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_") && !k.startsWith("CANVASTTY_")));
if (DRY) {
  const state = path.join(TMP, "mock-state");
  fs.mkdirSync(state);
  const wrap = (name, version, mock) => {
    const f = path.join(TMP, "bin", name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `#!/bin/sh\n[ "$1" = "--version" ] && { echo "${version}"; exit 0; }\nexec "${NODE}" "${path.join(ROOT, "tests", "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
    return f;
  };
  claudeExe = wrap("claude", `${EXPECT} (Claude Code)`, "mock-claude.mjs");
  codexExe = wrap("codex", "codex-cli 0.155.1", "mock-codex.mjs");
  // the mock's script: the answer of each turn, and one Bash prompt in the first (the probe must deny it)
  const script = path.join(TMP, "mock-script");
  fs.mkdirSync(script);
  for (const n of [1, 2]) fs.writeFileSync(path.join(script, `${n}.json`), JSON.stringify({ word: WORD }));
  fs.writeFileSync(path.join(script, "1.asks.json"), JSON.stringify([{ tool: "Bash", command: "echo mock" }]));
  Object.assign(baseEnv, { MOCK_STATE: state, MOCK_SCRIPT: script, MOCK_LEDGER: path.join(TMP, "ledger.jsonl") });
} else {
  claudeExe = which("claude");
  codexExe = which("codex");
  if (!claudeExe) { log("claude not found on PATH"); save(); process.exit(1); }
  if (!codexExe) { log("codex not found on PATH (nativeRuntime measures both CLIs)"); save(); process.exit(1); }
}
const available = (provider, executable) => ({
  state: "available", provider, executable, launcher: "native",
  environment: { PATH: [path.dirname(executable), ...(process.env.PATH ?? "").split(":")].join(":") }, checked: []
});
const clis = { get: (p) => available(p, p === "claude" ? claudeExe : codexExe) };

// ---------- the project ----------
const GIT = findGit(process.env);
const project = path.join(TMP, "probe-project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "README.md"), `# probe\n\nThe word is: ${WORD}\n`);
for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=probe", "-c", "user.email=probe@localhost", "commit", "-q", "-m", "init"]]) {
  execFileSync(GIT, a, { cwd: project, stdio: "ignore" });
}

// ---------- processes ----------
function psTable() {
  return execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" }).trim().split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number)).map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
}
function tree(root) {
  const rows = psTable();
  const out = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (out.has(r.ppid) && !out.has(r.pid)) { out.add(r.pid); grew = true; } }
  return [...out].filter((pid) => rows.some((r) => r.pid === pid));
}

// ---------- one turn ----------
async function turn(n, runtime, task, sessionId) {
  const rec = { n, kind: sessionId ? "resume" : "new", events: [], controlRequests: [], asks: [], init: null, answerText: null, result: null };
  report.turns.push(rec);
  const ask = async (q) => {
    // the probe never grants anything: every prompt is denied and recorded (tool and kind, the summary cut)
    rec.asks.push({ kind: q.kind, tool: q.tool, summary: anon(String(q.summary ?? "")).slice(0, 120), options: q.options, decision: "deny" });
    log(`turn ${n}: the CLI asked (${q.kind} ${q.tool}); denied`);
    return { decision: "deny" };
  };
  const prepared = runtime.agents.prepare({
    purpose: "execute", role: "executor", cwd: project, task, schema: SCHEMA, sessionId, timeoutMs: TURN_MS, ask,
    access: { claude: "terminal", codex: "terminal" }
  });
  if (!prepared.ok) { check(false, `turn ${n}: prepared`, prepared); return null; }
  const pids = new Set();
  let cliPid = null;
  const snap = () => { if (cliPid) for (const p of tree(cliPid)) pids.add(p); };
  const started = Date.now();
  const t = prepared.start({
    process(event, info) { if (event === "cli_started" && info.pid) { cliPid = info.pid; pids.add(info.pid); } },
    frame(f) {
      if (f.kind !== "event") { rec.events.push(`!${f.kind}`); return; }
      const v = f.value;
      rec.events.push(typeof v.subtype === "string" ? `${f.type}/${v.subtype}` : f.type);
      if (f.type === "control_request") rec.controlRequests.push(String(v.request?.subtype));
      if (f.type === "system" && v.subtype === "init") {
        snap();
        rec.init = {
          fields: Object.keys(v).sort(), session_id: v.session_id, model: v.model, permissionMode: v.permissionMode,
          claude_code_version: v.claude_code_version ?? null, tools: Array.isArray(v.tools) ? v.tools.length : null,
          mcp_servers: Array.isArray(v.mcp_servers) ? v.mcp_servers.length : null, output_style: v.output_style ?? null, apiKeySource: v.apiKeySource ?? null
        };
      }
      if (f.type === "assistant") {
        const text = (Array.isArray(v.message?.content) ? v.message.content : []).filter((b) => b?.type === "text").map((b) => b.text).join(" ").trim();
        if (text) rec.answerText = text.slice(0, 200);
      }
      if (f.type === "result") {
        snap();
        rec.result = {
          subtype: v.subtype, is_error: v.is_error, total_cost_usd: v.total_cost_usd ?? null, num_turns: v.num_turns ?? null, duration_ms: v.duration_ms ?? null,
          session_id: v.session_id, permission_denials: Array.isArray(v.permission_denials) ? v.permission_denials.length : null,
          fields: Object.keys(v).sort(), structured_output: v.structured_output ?? null
        };
      }
    }
  });
  // a second guard over the turn's own limit: never more than 120 s (+ the supervisor's grace) per turn
  let guarded = false;
  const guard = setTimeout(() => { guarded = true; log(`turn ${n}: ${TURN_MS / 1000} s passed, stopping`); t.stop(); }, TURN_MS + 5_000);
  const r = await t.result;
  clearTimeout(guard);
  rec.elapsedMs = Date.now() - started;
  rec.outcome = r.outcome;
  rec.guardStopped = guarded;
  rec.sessionId = r.sessionId;
  rec.report = r.report.status === "valid" ? { status: "valid", value: r.report.value } : { status: r.report.status, errors: r.report.errors ?? [] };
  rec.contract = { status: r.contract.status, errors: r.contract.errors };
  rec.process = { ...r.transport.process, pgid: r.transport.pids?.pgid ?? null, supervisor: r.transport.pids?.supervisor ?? null };
  rec.stderrTail = anon(r.transport.stderr?.tail ?? "").slice(-400);
  if (r.transport.pids?.supervisor) pids.add(r.transport.pids.supervisor);
  await new Promise((res) => setTimeout(res, 1_000));
  const rows = psTable();
  const alive = [...pids].filter((pid) => rows.some((x) => x.pid === pid));
  const inGroup = rec.process.pgid ? rows.filter((x) => x.pgid === rec.process.pgid).map((x) => x.pid) : [];
  rec.leftover = { watched: pids.size, alive, inGroup };
  log(`turn ${n}: ${r.outcome} in ${(rec.elapsedMs / 1000).toFixed(1)} s; events ${rec.events.length}; control_request ${JSON.stringify(rec.controlRequests)}`);
  return rec;
}

// ---------- the run ----------
let exit = 1;
try {
  if (REAL) {
    const line = execFileSync(claudeExe, ["--version"], { encoding: "utf8" }).split("\n")[0].trim();
    report.versions.claudeInstalled = line;
    if (line !== `${EXPECT} (Claude Code)`) { check(false, `installed claude is ${EXPECT}`, line); throw new Error("stop"); }
  }
  // the application's runtime: both CLIs' --version, the login-shell environment of the project, the native agents
  const runtime = await nativeRuntime({ clis, launch: () => LAUNCH, baseEnv: () => baseEnv, clientVersion: "claude-compat-probe" })(project);
  report.versions.claude = runtime.versions.claude;
  report.versions.codex = runtime.versions.codex;
  report.shell = runtime.shell;
  check(runtime.versions.claude === `${EXPECT} (Claude Code)`, `runtime measured claude ${EXPECT}`, runtime.versions.claude);

  const t1 = await turn(1, runtime, `Read README.md in the current folder and answer with the one word it names (the "word" field). Do not run commands, do not change files.`, null);
  if (!t1) throw new Error("stop");
  const ok1 = [
    check(t1.outcome === "completed", "turn 1 completed", t1.outcome),
    check(!!t1.init, "turn 1 system/init observed", t1.events.slice(0, 10)),
    check(t1.result?.subtype === "success" && t1.result?.is_error === false, "turn 1 result success", t1.result && { subtype: t1.result.subtype, is_error: t1.result.is_error }),
    check(t1.init?.session_id === t1.sessionId && t1.result?.session_id === t1.sessionId, "turn 1 session id consistent", { init: t1.init?.session_id, result: t1.result?.session_id, turn: t1.sessionId }),
    check(t1.leftover.alive.length === 0 && t1.leftover.inGroup.length === 0, "turn 1 left no process", t1.leftover)
  ].every(Boolean);
  check(t1.report.status === "valid" && String(t1.report.value?.word).toLowerCase() === WORD, `turn 1 answer is "${WORD}"`, t1.report);
  if (!ok1) throw new Error("stop");

  // the second turn: no prompt in the mock; the real CLI resumes the same session
  const t2 = await turn(2, runtime, "Which word did you answer in your previous message? Answer with that word only (the \"word\" field). Use no tools.", t1.sessionId);
  if (!t2) throw new Error("stop");
  const ok2 = [
    check(t2.outcome === "completed", "turn 2 completed", t2.outcome),
    check(t2.init?.session_id === t1.sessionId && t2.result?.session_id === t1.sessionId && t2.sessionId === t1.sessionId, "turn 2 resumed the same session id",
      { init: t2.init?.session_id, result: t2.result?.session_id, turn: t2.sessionId, first: t1.sessionId }),
    check(t2.result?.subtype === "success" && t2.result?.is_error === false, "turn 2 result success", t2.result && { subtype: t2.result.subtype, is_error: t2.result.is_error }),
    check(t2.leftover.alive.length === 0 && t2.leftover.inGroup.length === 0, "turn 2 left no process", t2.leftover)
  ].every(Boolean);
  check(t2.report.status === "valid" && String(t2.report.value?.word).toLowerCase() === WORD, `turn 2 remembers "${WORD}"`, t2.report);
  if (DRY) check(t1.asks.length === 1 && t1.controlRequests.includes("can_use_tool"), "dry: the scripted prompt reached the probe and was denied", t1.asks);
  report.ok = ok1 && ok2 && report.checks.every((c) => c.ok);
  exit = report.ok ? 0 : 1;
} catch (e) {
  if (e.message !== "stop") { log(`error: ${e.stack ?? e}`); report.error = anon(String(e.message ?? e)).slice(0, 500); }
} finally {
  save();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ ok: report.ok, out: anon(path.join(OUT, `${STEM}.json`)), checks: report.checks.filter((c) => !c.ok).map((c) => c.what) })}\n`);
}
process.exit(exit);
