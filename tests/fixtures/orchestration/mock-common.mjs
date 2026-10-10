// Helpers shared by mock-codex.mjs and mock-claude.mjs (fakes for the turn engine tests; plausible event shapes
// only, they prove the harness, not compatibility with the real CLIs). Importing this file has no side effects.
// Env: MOCK_MODE (mode, see the mocks), MOCK_STATE (dir), MOCK_LEDGER (file, one {pid,label} line per process
//      started, plus the mock's own pid and its parent's — the supervisor under startTurn),
//      CTTYEXP (marker put into argv of any descendant), MOCK_LINE_BYTES, MOCK_EVENTS, MOCK_EVENT_BYTES,
//      MOCK_REPORT_BYTES, MOCK_STDERR_BYTES (sizes for the matching modes),
//      MOCK_SCRIPT (dir, see scriptedTurn).
// A "WORD=<x>" in the first task is remembered and echoed as report.memory on resume. If the schema has a `token`
// property the answer is {token, answer} instead: token = "TOKEN=<x>" of the session's first task (also on resume).
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MODE = process.env.MOCK_MODE ?? "ok";
const num = (name, dflt) => Number(process.env[name] ?? dflt);
export const SIZES = {
  line: num("MOCK_LINE_BYTES", 20 << 20),
  events: num("MOCK_EVENTS", 2000),
  eventBytes: num("MOCK_EVENT_BYTES", 64 << 10),
  report: num("MOCK_REPORT_BYTES", 1 << 20),
  stderr: num("MOCK_STDERR_BYTES", 16 << 20),
};

export const ledger = (pid, label) => {
  if (process.env.MOCK_LEDGER) fs.appendFileSync(process.env.MOCK_LEDGER, JSON.stringify({ pid, label }) + "\n");
};

// stdout/stderr are async pipes on macOS: always wait for the write, never process.exit() with data queued.
const write = (stream, s) => new Promise((r) => { if (stream.write(s)) r(); else stream.once("drain", r); });
export const emit = (o) => write(process.stdout, JSON.stringify(o) + "\n");

export function readTask() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (d) => chunks.push(d));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const stateFile = (id) => path.join(process.env.MOCK_STATE, `${id}.json`);
export function loadState(id) {
  try { return JSON.parse(fs.readFileSync(stateFile(id), "utf8")); } catch { return null; }
}
export function saveTurn(id, prev, task, extra) {
  const st = prev ?? { id, word: null, token: /TOKEN=([A-Za-z0-9_-]+)/.exec(task.toString("utf8"))?.[1] ?? null, turns: [] };
  st.word ??= /WORD=(\S+)/.exec(task.toString("utf8"))?.[1] ?? null;
  st.turns.push({ mode: MODE, argv: process.argv.slice(2), len: task.length, sha256: createHash("sha256").update(task).digest("hex"), base64: task.toString("base64"), ...extra });
  fs.writeFileSync(stateFile(id), JSON.stringify(st));
  return st;
}

// The structured answer. bad_schema: valid JSON of the wrong shape; big_report: over MOCK_REPORT_BYTES.
export function reportFor(st, schema, resumed) {
  const t = st.turns.at(-1);
  if (schema?.properties?.token) {
    const token = MODE === "wrong_token" ? `wrong-${st.token ?? ""}` : MODE === "no_context" && resumed ? "" : st.token ?? "";
    return { token, answer: MODE === "wrong_answer" ? "wrong" : resumed ? "resumed" : "ok" };
  }
  if (MODE === "bad_schema") return { status: "unknown", summary: 42 };
  const summary = MODE === "big_report" ? "x".repeat(SIZES.report) : `received ${t.len} bytes`;
  return { status: "done", summary, sha256: t.sha256, memory: st.word ?? "" };
}

// Descendant in our process group (not detached) that keeps our stdout open after we exit.
export function holdStdout(label) {
  const d = spawn(process.execPath, ["-e", "setInterval(()=>{},1e3)", `${process.env.CTTYEXP ?? "CTTYEXP"}-${label}`], { stdio: ["ignore", "inherit", "ignore"] });
  ledger(d.pid, label);
  d.unref(); // the leader exits; the descendant keeps stdout
}

export async function stderrFlood() {
  const chunk = "e".repeat((64 << 10) - 1) + "\n";
  for (let n = 0; n < SIZES.stderr; n += chunk.length) await write(process.stderr, chunk);
}

export const hold = () => setInterval(() => {}, 1e3);
export const readSchema = (s) => { try { return JSON.parse(s); } catch { return null; } };


// MOCK_CHECKS (journal v2, journal-v2-format.md §2.1): the lead's check-command proposal added to a scripted plan
// answer (stages, no question) of the turn whose schema asks for it (properties.checks):
//   proposed — one command (MOCK_CHECK_COMMAND, default "true") with why and source;
//   none     — no command, with why there is none;
//   invalid  — a command without a reason (an empty why: the report is invalid);
//   forced   — the proposal of "proposed" also where the schema does not ask for it (a goal with its own commands).
// Unset: the answer as scripted.
export function withProposal(answer, schema) {
  const mode = process.env.MOCK_CHECKS;
  // journal v2: a plan turn that proposes nothing answers checks: null (journal-v2-format.md §2.1)
  if (schema?.properties?.checks?.type === "null" && mode !== "forced" && answer && typeof answer === "object" && Array.isArray(answer.stages) && !("checks" in answer)) return { ...answer, checks: null };
  if (!mode || !answer || typeof answer !== "object" || !Array.isArray(answer.stages) || answer.question !== null || "checks" in answer) return answer;
  if (!schema?.properties?.checks && mode !== "forced") return answer;
  const command = process.env.MOCK_CHECK_COMMAND ?? "true";
  const checks = mode === "none" ? { checks: [], none: "the project has no test, build or lint command for this goal" }
    : mode === "invalid" ? { checks: [{ command, why: " ", source: [] }], none: null } // the schema takes it, the rule "says why" does not
      : { checks: [{ command, why: "runs the project's tests", source: ["package.json"] }], none: null };
  return { ...answer, checks };
}

// MOCK_SCRIPT=<dir>: the n-th call of any mock (n from <dir>/counter, starting at 1) answers <dir>/<n>.json instead of
// reportFor; <dir>/<n>.writes.json (optional, [{rel, base64}]) adds file writes
// and <dir>/<n>.reads.json (optional, [path]) file reads for mock-claude structured-edit.
// A missing <n>.json throws: a cycle that makes more calls than scripted fails loudly. Unset: null.
// Calls are expected one at a time (the counter is read-modify-write, not locked).
// MOCK_SCRIPT_PER_CWD=1 (C1: runs in parallel, each in its own copy): <dir>/<k>/ is the script of the k-th work folder
// that made a call; a folder keeps its k (claimed with mkdir, safe across processes).
export function scriptedTurn(cwd = process.cwd()) {
  let dir = process.env.MOCK_SCRIPT;
  if (!dir) return null;
  // MOCK_TURN_DELAY_MS: each scripted turn takes this long (runs that must overlap on a fast machine)
  const delay = Number(process.env.MOCK_TURN_DELAY_MS ?? 0);
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  if (process.env.MOCK_SCRIPT_PER_CWD === "1") dir = path.join(dir, slotOf(dir, fs.realpathSync(cwd)));
  const counter = path.join(dir, "counter");
  let n = 1;
  try { n = Number(fs.readFileSync(counter, "utf8")) + 1; } catch {}
  fs.writeFileSync(counter, String(n));
  const answer = JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), "utf8"));
  const optional = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, `${n}.${name}.json`), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; return []; }
  };
  return { n, answer, writes: optional("writes"), reads: optional("reads"), asks: optional("asks") };
}

// ---- stage 12 protocols: stdin stays open, one JSON line per message ----
// <dir>/<n>.asks.json (optional): [{ tool, command? , question?, options? }] — permission prompts or questions the mock
// sends before answering; each reply is appended to MOCK_STATE/decisions.jsonl as {n, tool, reply}. {tool:"mcp", server,
// name, arguments, saveTo? (mock-claude: the result line is appended there)} calls a real MCP server of
// <cwd>/.mcp.json (mcpToolCall). MOCK_ASK=<tool>
// asks once per turn without a script.
export function lineReader(stream) {
  let buf = "";
  const queue = [];
  const waiters = [];
  let ended = false;
  stream.setEncoding("utf8");
  stream.on("data", (d) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.findIndex((x) => x.pred(msg));
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg); else queue.push(msg);
    }
  });
  stream.on("end", () => { ended = true; for (const w of waiters.splice(0)) w.resolve(null); });
  return {
    // The next message matching pred (null at EOF).
    next(pred = () => true) {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    ended: () => ended
  };
}
export function recordDecision(entry) {
  if (process.env.MOCK_STATE) fs.appendFileSync(path.join(process.env.MOCK_STATE, "decisions.jsonl"), JSON.stringify(entry) + "\n");
}

// Stage 13 rehearsal of S4: a real MCP tool call. Starts the stdio server `name` of <cwd>/.mcp.json (both mocks read
// that file; the real Codex reads its config.toml), calls one tool and hands each elicitation/create to onElicit (the
// CLI's own way to the person), whose result goes back to the server. Returns the tool result's text.
export async function mcpToolCall(name, tool, args, clientName, onElicit) {
  const spec = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".mcp.json"), "utf8")).mcpServers[name];
  const child = spawn(spec.command, spec.args ?? [], { env: { ...process.env, ...(spec.env ?? {}) }, stdio: ["pipe", "pipe", "ignore"] });
  const out = lineReader(child.stdout);
  const send = (o) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: clientName, version: "mock" } } });
  await out.next((m) => m.id === 1);
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  let text = "";
  for (;;) {
    const m = await out.next();
    if (!m) break;
    if (m.method === "elicitation/create") { send({ id: m.id, result: await onElicit(m.params) }); continue; }
    if (m.id === 2) { text = m.result?.content?.[0]?.text ?? JSON.stringify(m.error ?? null); break; }
  }
  child.stdin.end();
  return text;
}

// Stage 13 rehearsal of S4X readiness: what Codex does for a thread's MCP server — start it, initialize, list its tools.
// Returns the tool names (null when the server did not answer).
export async function mcpConnect(spec, clientName) {
  const child = spawn(spec.command, spec.args ?? [], { env: { ...process.env, ...(spec.env ?? {}) }, stdio: ["pipe", "pipe", "ignore"] });
  const out = lineReader(child.stdout);
  const send = (o) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: clientName, version: "mock" } } });
  const init = await out.next((m) => m.id === 1);
  let tools = null;
  if (init) {
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list", params: {} });
    tools = ((await out.next((m) => m.id === 2))?.result?.tools ?? []).map((t) => t.name);
  }
  child.stdin.end();
  return tools;
}

function slotOf(dir, cwd) {
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let k = 1; k < 100; k++) {
    const claim = path.join(dir, `claim-${k}`);
    try { fs.mkdirSync(claim); fs.writeFileSync(path.join(claim, "cwd"), cwd); return String(k); } catch (e) { if (e.code !== "EEXIST") throw e; }
    let owner = "";
    for (let i = 0; i < 100 && !owner; i++) { try { owner = fs.readFileSync(path.join(claim, "cwd"), "utf8"); } catch { pause(20); } }
    if (owner === cwd) return String(k);
  }
  throw new Error("mock: no script slot left");
}
