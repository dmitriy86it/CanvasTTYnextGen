// Fake `claude` for turn.mjs tests. Plausible event shapes only: it proves the harness, not compatibility
// with the real CLI. Usage (like the real one):
//   node mock-claude.mjs -p --output-format stream-json --verbose --session-id <uuid> --json-schema <s> [...]
//   node mock-claude.mjs -p --output-format stream-json --verbose --resume <uuid> --json-schema <s> [...]
// Unknown flags are ignored (value flags listed below). Task from stdin to EOF; state/ledger/env/sizes as in
// mock-codex.mjs (token answers too, from --json-schema). Modes: ok | fail | bad_schema | no_structured |
//   exit_after_success | no_terminal | sleep | oversized_line | many_big_events | hold_stdout | wrong_session |
//   big_report | stderr_flood | no_read_stdin | result_then_hang | wrong_token | no_context (as in mock-codex.mjs) |
//   tools_nonempty (system/init.tools = ["Bash"]) | tools_plus_bash (observed tools + "Bash") | extra_mcp (one MCP server in init) |
//   init_no_tools (init without the tools field) | wrong_answer (answer is not the expected one)
// system/init.tools mirrors what Claude Code 2.1.278 sent to the model in the real K1 run (transcript, 2026-09-22):
// `--tools ""` together with `--json-schema` -> ["StructuredOutput"]; otherwise [] (mock simplification).
import { randomUUID } from "node:crypto";
import { MODE, SIZES, ledger, emit, readTask, loadState, saveTurn, reportFor, holdStdout, stderrFlood, hold, readSchema } from "./mock-codex.mjs";

ledger(process.pid, "mock-claude");
ledger(process.ppid, "parent"); // under runTurn: the supervisor
const args = process.argv.slice(2);
const valueFlags = new Set(["--output-format", "--input-format", "--session-id", "--resume", "-r", "--json-schema", "--model",
  "--permission-mode", "--allowedTools", "--disallowedTools", "--append-system-prompt", "--system-prompt", "--add-dir", "--mcp-config", "--settings", "--setting-sources",
  "--tools", "--max-budget-usd", "--permission-prompts"]);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (valueFlags.has(args[i])) flags[args[i]] = args[++i];
  else flags[args[i]] = true;
}
const resumeId = flags["--resume"] ?? flags["-r"] ?? null;
if (!flags["-p"] || flags["--output-format"] !== "stream-json" || !flags["--verbose"] || !flags["--json-schema"]) {
  process.stderr.write(`mock-claude: unexpected argv ${JSON.stringify(args)}\n`);
  process.exitCode = 2;
} else {
  const task = MODE === "no_read_stdin" ? Buffer.alloc(0) : await readTask();
  const prev = resumeId ? loadState(resumeId) : null;
  if (resumeId && !prev) {
    process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
    process.exitCode = 1;
  } else {
    await run(task, prev);
  }
}

async function run(task, prev) {
  const id = resumeId ?? flags["--session-id"] ?? randomUUID();
  const st = saveTurn(id, prev, task, { jsonSchema: flags["--json-schema"] });
  const sessionId = MODE === "wrong_session" ? randomUUID() : id;
  const assistant = (text, n) => ({
    type: "assistant", session_id: sessionId,
    message: { id: `msg_${n}`, type: "message", role: "assistant", model: "mock", content: [{ type: "text", text }], stop_reason: null },
  });

  if (MODE === "hold_stdout") holdStdout("mock-claude-holder");
  if (MODE === "stderr_flood") await stderrFlood();
  const observed = flags["--tools"] === "" && flags["--json-schema"] ? ["StructuredOutput"] : [];
  const tools = MODE === "tools_nonempty" ? ["Bash"] : MODE === "tools_plus_bash" ? [...observed, "Bash"] : observed;
  const mcp_servers = MODE === "extra_mcp" ? [{ name: "extra-server", status: "connected" }] : [];
  await emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), ...(MODE === "init_no_tools" ? {} : { tools }), mcp_servers, model: "mock-claude", permissionMode: "default" });
  if (MODE === "sleep") return hold();
  if (MODE === "no_terminal") return;
  if (MODE === "oversized_line") await emit(assistant("a".repeat(SIZES.line), "big"));
  if (MODE === "many_big_events") {
    const text = "b".repeat(SIZES.eventBytes - 200);
    for (let i = 0; i < SIZES.events; i++) await emit(assistant(text, `r${i}`));
  }
  const base = { type: "result", duration_ms: 1, num_turns: 1, session_id: sessionId, total_cost_usd: 0, usage: { input_tokens: task.length, output_tokens: 1 } };
  if (MODE === "fail") {
    await emit({ ...base, subtype: "error_during_execution", is_error: true });
    process.exitCode = 1;
    return;
  }
  const report = reportFor(st, readSchema(flags["--json-schema"]), resumeId !== null);
  const text = "Done."; // result text is not the answer; structured_output is
  await emit(assistant(text, 0));
  await emit({ ...base, subtype: "success", is_error: false, result: text, ...(MODE === "no_structured" ? {} : { structured_output: report }) });
  if (MODE === "exit_after_success") process.exitCode = 3;
  if (MODE === "result_then_hang") { ledger(process.pid, "result_sent"); hold(); }
}
