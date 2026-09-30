// Runs a 0B probe series through runTurn (plan: probe-plan.mjs): B1 -> B2 -> K1 -> K2 (default) or K1 -> K2 (--series K1,K2).
// Stops at the first failure; no retries.
// Usage:
//   node probe-series.mjs [--mock] [--mock-modes B1=ok,K1=tools_nonempty] [--mock-task-bytes K1=8388608] [--timeout-ms 500|B1=500] [--base <dir>]
//   node probe-series.mjs --dry-run [--mock|--real] [--base <dir>]   -> prints the plan, starts nothing
//   CANVASTTY_REAL_PROBES=B1,B2,K1,K2 node probe-series.mjs --real [--base <dir>]   -> real CLIs (model requests!)
//   CANVASTTY_REAL_PROBES=K1,K2 node probe-series.mjs --real --series K1,K2 [--base <dir>]   -> claude only; codex is never started
// The gate env must equal the chosen series exactly; one series' permission does not cover another.
// Mock (default): argv[0] becomes [node, mock-*.mjs], the rest of argv is the plan's; PATH = node dir + /usr/bin:/bin;
// HOME/CODEX_HOME point into <probe>/home. Report: JSON on stdout and <probe>/series-report.json; rc 0 only if all 4 ok.
// Never prints env values, stderr, tokens.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { buildPlan, SCHEMA, FROM_B1, TOKEN_RE, SERIES, CLAUDE_VERSION } from "./probe-plan.mjs";
import { runTurn, DEFAULT_TURN_LIMITS } from "./turn.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = { codex: path.join(HERE, "mock-codex.mjs"), claude: path.join(HERE, "mock-claude.mjs") };

const die = (msg) => { process.stderr.write(`probe-series: ${msg}\n`); process.exit(2); };
const log = (msg) => process.stderr.write(`probe-series: ${msg}\n`);

let args;
try {
  args = parseArgs({
    strict: true,
    options: {
      mock: { type: "boolean" }, real: { type: "boolean" }, "dry-run": { type: "boolean" }, base: { type: "string" }, series: { type: "string" },
      "mock-modes": { type: "string" }, "mock-task-bytes": { type: "string" }, "timeout-ms": { type: "string" },
    },
  }).values;
} catch (e) { die(e.message); }

// Gate first: nothing is resolved or created before it.
const real = !!args.real;
const dry = !!args["dry-run"];
if (real && args.mock) die("--real and --mock are exclusive");
if (real && (args["mock-modes"] || args["mock-task-bytes"] || args["timeout-ms"])) die("--mock-modes/--mock-task-bytes/--timeout-ms are mock-only");
const seriesKey = args.series ?? "B1,B2,K1,K2";
if (!Object.hasOwn(SERIES, seriesKey)) die(`--series must be one of: ${Object.keys(SERIES).join(" | ")}`);
const IDS = SERIES[seriesKey];
if (real && !dry && process.env.CANVASTTY_REAL_PROBES !== seriesKey) die(`--real requires env CANVASTTY_REAL_PROBES=${seriesKey} (exact)`);

// "B1=x,K1=y" -> {B1:"x",K1:"y"}; a value without "=" applies to all probes.
function perProbe(s, conv = (v) => v) {
  const m = {};
  for (const part of (s ?? "").split(",").filter(Boolean)) {
    const [k, v] = part.includes("=") ? part.split("=", 2) : [null, part];
    for (const id of k ? [k] : IDS) { if (!IDS.includes(id)) die(`unknown probe ${id}`); m[id] = conv(v); }
  }
  return m;
}
const posInt = (v) => (/^[1-9]\d*$/.test(v) ? Number(v) : die(`not a positive integer: ${v}`));
const modes = perProbe(args["mock-modes"]);
const taskBytes = perProbe(args["mock-task-bytes"], posInt);
const timeouts = perProbe(args["timeout-ms"], posInt);

// ---- probe directory ----
const base = path.resolve(args.base ?? os.tmpdir());
const probeDir = path.join(base, `probe-${Date.now()}-${randomBytes(4).toString("hex")}`);
const dir = (...p) => path.join(probeDir, ...p);
for (const d of ["", "repo", "home", "tmp", "attempts", ...IDS.map((id) => `attempts/${id}`), ...(real ? [] : ["mock-state"])]) fs.mkdirSync(dir(d));
fs.writeFileSync(dir("schema.json"), JSON.stringify(SCHEMA));

const home = os.homedir();
const token = randomBytes(16).toString("hex"), token2 = randomBytes(16).toString("hex"), u1 = randomUUID();
const plan = buildPlan({
  probeDir, repo: dir("repo"), home: dir("home"), tmp: dir("tmp"), schemaFile: dir("schema.json"),
  realHome: real ? home : dir("home"), codexHome: real ? path.join(home, ".codex") : dir("home", ".codex"),
  user: real ? process.env.USER ?? "" : "mock",
  path: [...(real ? [path.join(home, ".local/bin")] : []), path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  token, token2, u1,
}).filter((p) => IDS.includes(p.id));

// Continuations must get the token only from the session, never from the task text.
for (const p of plan) {
  if (p.continues) {
    if (p.task.includes(token) || p.task.includes(token2) || TOKEN_RE.test(p.task)) die(`${p.id}: continuation task contains a token`);
  } else if (TOKEN_RE.exec(p.task)?.[1] !== p.expectToken) die(`${p.id}: task does not carry TOKEN=<expected>`);
}

const ledgerFile = dir("mock-ledger.jsonl");
function specEnv(p) {
  return real ? p.env : { ...p.env, MOCK_MODE: modes[p.id] ?? "ok", MOCK_STATE: dir("mock-state"), MOCK_LEDGER: ledgerFile };
}
function padTask(p) {
  const n = taskBytes[p.id], len = Buffer.byteLength(p.task);
  return n > len ? p.task + "#".repeat(n - len) : p.task;
}
const redact = (s) => s.replaceAll(token, "<TOKEN>").replaceAll(token2, "<TOKEN2>");

if (dry) {
  const out = {
    mode: "dry-run", target: real ? "real" : "mock", series: seriesKey, probeDir,
    note: `repo is created at start (git init, README.md, one commit); ${real ? "argv[0] is resolved from the user's PATH at start" : "argv[0] -> [node, mock-*.mjs]"}`,
    probes: plan.map((p) => ({
      id: p.id, provider: p.provider,
      argv: real ? p.argv : [process.execPath, MOCK[p.provider], ...p.argv.slice(1)],
      cwd: p.cwd, env: Object.keys(specEnv(p)), attemptDir: dir("attempts", p.id),
      timeoutMs: timeouts[p.id] ?? p.timeoutMs, taskBytes: Buffer.byteLength(padTask(p)), task: redact(p.task),
      expectSessionId: p.expectSessionId === FROM_B1 ? "<sessionId of B1>" : p.expectSessionId,
      expectInit: p.expectInit, mockMode: real ? undefined : modes[p.id] ?? "ok", success: p.success,
    })),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// ---- repo: one README.md, one commit; no user/system git config, no hooks ----
const gitEnv = { PATH: "/usr/bin:/bin", HOME: dir("home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C" };
const git = (...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...a], { cwd: dir("repo"), env: gitEnv, stdio: "ignore" });
git("init", "-q");
fs.writeFileSync(dir("repo", "README.md"), "# probe repo\n");
git("add", "README.md");
git("-c", "user.name=probe", "-c", "user.email=probe@invalid", "commit", "-q", "-m", "init");

// ---- executables ----
const bin = {}, versions = {};
for (const provider of [...new Set(plan.map((p) => p.provider))]) { // a claude-only series never starts codex, not even --version
  if (!real) { versions[provider] = "mock"; continue; }
  bin[provider] = (process.env.PATH ?? "").split(":").filter((d) => path.isAbsolute(d)).map((d) => path.join(d, provider))
    .find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } });
  if (!bin[provider]) die(`${provider} not found on PATH`);
  const env = plan.find((p) => p.provider === provider).env;
  try { versions[provider] = execFileSync(bin[provider], ["--version"], { env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0]; }
  catch (e) { die(`${provider} --version failed: ${e.code ?? e.status}`); }
  // The init expectation was established for one claude version; on another one refuse before any model request.
  if (provider === "claude" && versions.claude.split(" ")[0] !== CLAUDE_VERSION) die(`claude ${versions.claude}: init expectation is only established for ${CLAUDE_VERSION}`);
}
const argv0 = (p) => (real ? [bin[p.provider]] : [process.execPath, MOCK[p.provider]]);

// ---- success check: every criterion recorded (ok or not), failures listed ----
const sorted = (v) => [...v].sort();
// Names only (never server settings): missing field -> null, so "absent" and [] stay distinct.
const names = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : typeof x?.name === "string" ? x.name : "<unnamed>")) : null);
function evaluate(p, r, expectSession) {
  const criteria = [];
  const need = (name, ok, detail) => criteria.push({ name, ok: !!ok, ...(ok || detail === undefined ? {} : { detail }) });
  need("outcome=completed", r.outcome === "completed", r.outcome);
  need("delivery=ok", r.delivery?.status === "ok", r.delivery?.status ?? "absent");
  need("report valid", r.report.status === "valid", r.report.status);
  const tokenMatch = r.report.value?.token === p.expectToken;
  need("token", tokenMatch, "mismatch");
  const answerOk = r.report.value?.answer === p.expectAnswer;
  need("answer", answerOk, "mismatch");
  const sessionOk = expectSession ? r.sessionId === expectSession && !r.sessionMismatch : !!r.sessionId;
  need("sessionId", sessionOk, expectSession ? "mismatch" : "missing");
  need("stopCause=null", r.stopCause === null, r.stopCause);
  need("group cleared", r.process.groupCleared === true, String(r.process.groupCleared));
  need("nextTurnAllowed", r.nextTurnAllowed === true, "false");
  let init = null;
  if (p.expectInit) {
    const ev = r.sessionEvent;
    const field = (k) => (ev && Object.hasOwn(ev, k) ? names(ev[k]) : null);
    const tools = { expected: p.expectInit.tools, actual: field("tools"), present: !!ev && Object.hasOwn(ev, "tools") };
    const mcp = { expected: p.expectInit.mcp_servers, actual: field("mcp_servers"), present: !!ev && Object.hasOwn(ev, "mcp_servers") };
    tools.ok = tools.actual !== null && isDeepStrictEqual(sorted(tools.actual), sorted(tools.expected));
    mcp.ok = mcp.actual !== null && isDeepStrictEqual(sorted(mcp.actual), sorted(mcp.expected));
    const sid = { expected: p.expectInit.session_id, actual: ev?.session_id ?? null };
    sid.ok = sid.actual === sid.expected;
    init = { eventPresent: !!ev, tools, mcp_servers: mcp, session_id: sid };
    need("sessionEvent present", !!ev, "absent");
    need("init.tools exact", tools.ok, tools.present ? "unexpected" : "field absent");
    need("init.mcp_servers exact", mcp.ok, mcp.present ? "unexpected" : "field absent");
    need("init.session_id", sid.ok, "mismatch");
  }
  const failed = criteria.filter((c) => !c.ok).map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name));
  return { criteria, failed, tokenMatch, answerOk, sessionOk, init };
}

// ---- series ----
let current = null, interrupted = null;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { interrupted ??= sig; current?.stop(); });

const results = [];
const sessions = {};
let failedAt = null;
for (const p of plan) {
  if (failedAt || interrupted) { results.push({ id: p.id, ran: false, ok: false, skipped: failedAt ? `${failedAt} failed` : `interrupted by ${interrupted}` }); continue; }
  const sub = (v) => (v === FROM_B1 ? sessions.B1 : v);
  const expectSession = sub(p.expectSessionId);
  const spec = {
    provider: p.provider, argv: [...argv0(p), ...p.argv.slice(1).map(sub)], cwd: p.cwd, env: specEnv(p), task: padTask(p),
    schema: SCHEMA, attemptDir: dir("attempts", p.id), expectSessionId: expectSession,
    limits: { ...DEFAULT_TURN_LIMITS, timeoutMs: timeouts[p.id] ?? p.timeoutMs },
  };
  log(`${p.id}: start`);
  const t0 = performance.now();
  let r;
  try { current = runTurn(spec); r = await current.result; } catch (e) {
    results.push({ id: p.id, provider: p.provider, ran: false, ok: false, failed: [`preflight: ${e.message}`] });
    failedAt = p.id;
    continue;
  } finally { current = null; }
  const { criteria, failed, tokenMatch, answerOk, sessionOk, init } = evaluate(p, r, expectSession);
  if (r.sessionId) sessions[p.id] = r.sessionId;
  const ok = failed.length === 0 && !interrupted;
  if (interrupted && !failed.length) failed.push(`interrupted by ${interrupted}`);
  results.push({
    id: p.id, provider: p.provider, ran: true, ok, failed,
    outcome: r.outcome, stopCause: r.stopCause, transport: r.transport.reason ? `${r.transport.status}:${r.transport.reason}` : r.transport.status,
    delivery: r.delivery?.status ?? null, report: r.report.status, tokenMatch, answerOk, sessionOk,
    cliVersion: versions[p.provider] ?? null,
    // claude: model reported by system/init; codex does not report it, this is the model requested in argv
    model: p.provider === "claude" ? { reported: r.sessionEvent?.model ?? null } : { requested: p.argv[p.argv.indexOf("-m") + 1] },
    init, criteria,
    durationMs: Math.round(performance.now() - t0), counters: r.counters, pids: r.pids,
  });
  log(`${p.id}: ${ok ? "ok" : `FAILED (${failed.join("; ")})`}`);
  if (!ok) failedAt = p.id;
}

const report = { mode: real ? "real" : "mock", series: seriesKey, probeDir, ...(real ? {} : { ledger: ledgerFile }), versions, ok: results.every((x) => x.ok), probes: results };
fs.writeFileSync(dir("series-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
