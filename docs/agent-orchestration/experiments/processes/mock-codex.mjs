// Fake `codex` for turn.mjs tests. Plausible event shapes only: it proves the harness, not compatibility
// with the real CLI. Usage (like the real one):
//   node mock-codex.mjs exec --json [...] -o <file> [--output-schema <f>] -
//   node mock-codex.mjs exec resume <thread_id> --json [...] -o <file> -
// Unknown flags are ignored (value flags: -o -c -C -s -m -p --output-schema --sandbox --model --profile --cd).
// Reads the task from stdin to EOF; stores len/sha256/exact bytes in MOCK_STATE/<thread_id>.json.
// A "WORD=<x>" in the first task is remembered and echoed as report.memory on resume.
// If the output schema has a `token` property the answer is {token, answer} instead: token = "TOKEN=<x>" of the
// session's first task (also on resume), answer "ok" / "resumed".
// Env: MOCK_MODE (below), MOCK_STATE (dir), MOCK_LEDGER (file, one {pid,label} line per process started,
//      plus our own pid and our parent's — the supervisor under runTurn),
//      CTTYEXP (marker put into argv of any descendant), MOCK_LINE_BYTES, MOCK_EVENTS, MOCK_EVENT_BYTES,
//      MOCK_REPORT_BYTES, MOCK_STDERR_BYTES (sizes for the matching modes).
// Modes: ok | fail | bad_schema | not_json | exit_after_success | no_terminal | sleep | oversized_line |
//        many_big_events | hold_stdout | no_report_file | wrong_session | big_report | stderr_flood |
//        no_read_stdin (never reads stdin, full successful turn, exit 0) |
//        result_then_hang (full successful turn, ledger line {pid,label:"result_sent"}, then waits for a signal) |
//        wrong_token (token answer with a token that is not the session's) | no_context (token "" on resume)
// The helpers are shared with mock-claude.mjs.
import { createHash, randomUUID } from "node:crypto";
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

// ---- codex ----
async function main() {
  ledger(process.pid, "mock-codex");
  ledger(process.ppid, "parent"); // under runTurn: the supervisor
  const args = process.argv.slice(2);
  const valueFlags = new Set(["-o", "--output-last-message", "-c", "-C", "--cd", "-s", "--sandbox", "-m", "--model", "-p", "--profile", "--output-schema"]);
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) flags[args[i]] = args[++i];
    else if (args[i].startsWith("-") && args[i] !== "-") flags[args[i]] = true;
    else pos.push(args[i]);
  }
  const reportFile = flags["-o"] ?? flags["--output-last-message"];
  if (pos[0] !== "exec" || !flags["--json"] || !reportFile || pos.at(-1) !== "-") {
    process.stderr.write(`mock-codex: unexpected argv ${JSON.stringify(args)}\n`);
    process.exitCode = 2;
    return;
  }
  const resumeId = pos[1] === "resume" ? pos[2] : null;
  const task = MODE === "no_read_stdin" ? Buffer.alloc(0) : await readTask();
  const prev = resumeId ? loadState(resumeId) : null;
  if (resumeId && !prev) {
    process.stderr.write(`mock-codex: no session ${resumeId}\n`);
    process.exitCode = 1;
    return;
  }
  const id = resumeId ?? randomUUID();
  const st = saveTurn(id, prev, task, { reportFile });
  const threadId = MODE === "wrong_session" ? randomUUID() : id;

  if (MODE === "hold_stdout") holdStdout("mock-codex-holder");
  if (MODE === "stderr_flood") await stderrFlood();
  await emit({ type: "thread.started", thread_id: threadId });
  await emit({ type: "turn.started" });
  if (MODE === "sleep") return hold();
  if (MODE === "no_terminal") return;
  if (MODE === "oversized_line") await emit({ type: "item.completed", item: { id: "item_big", type: "reasoning", text: "a".repeat(SIZES.line) } });
  if (MODE === "many_big_events") {
    const text = "b".repeat(SIZES.eventBytes - 80);
    for (let i = 0; i < SIZES.events; i++) await emit({ type: "item.completed", item: { id: `item_r${i}`, type: "reasoning", text } });
  }
  if (MODE === "fail") {
    await emit({ type: "turn.failed", error: { message: "mock failure" } });
    process.exitCode = 1;
    return;
  }
  const schema = readSchema(flags["--output-schema"] ? fs.readFileSync(flags["--output-schema"], "utf8") : "null");
  const text = MODE === "not_json" ? "this is not json {" : JSON.stringify(reportFor(st, schema, resumeId !== null));
  await emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
  if (MODE !== "no_report_file") fs.writeFileSync(reportFile, text);
  await emit({ type: "turn.completed", usage: { input_tokens: task.length, cached_input_tokens: 0, output_tokens: text.length } });
  if (MODE === "exit_after_success") process.exitCode = 3;
  if (MODE === "result_then_hang") { ledger(process.pid, "result_sent"); hold(); }
}

if (import.meta.main) main();
