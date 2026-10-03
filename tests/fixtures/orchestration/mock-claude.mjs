// Fake `claude` for the turn engine tests. Plausible event shapes only: it proves the harness, not compatibility
// with the real CLI. Usage (like the real one):
//   node mock-claude.mjs -p --output-format stream-json --verbose --session-id <uuid> --json-schema <s> [...]
//   node mock-claude.mjs -p --output-format stream-json --verbose --resume <uuid> --json-schema <s> [...]
// Unknown flags are ignored (value flags listed below). Task from stdin to EOF; state/ledger/env/sizes as in
// mock-common.mjs (token answers too, from --json-schema). Modes: ok | fail | bad_schema | no_structured |
//   exit_after_success | no_terminal | sleep | oversized_line | many_big_events | hold_stdout | wrong_session |
//   big_report | stderr_flood | no_read_stdin | result_then_hang | wrong_token | no_context (as in mock-codex.mjs) |
//   tools_nonempty (system/init.tools = ["Bash"]) | tools_plus_bash (observed tools + "Bash") | extra_mcp (one MCP server in init) |
//   init_no_tools (init without the tools field) | wrong_answer (answer is not the expected one) |
//   tools_nested (tools = [["StructuredOutput"]]) | tools_string (tools = "StructuredOutput") |
//   init_no_mcp (init without mcp_servers) | init_no_session (init without session_id) |
//   permission_mode_other (structured-edit: init.permissionMode "acceptEdits") |
//   init_no_permission_mode (structured-edit: init without permissionMode) |
//   edit_slow (structured-edit: init, one assistant event, ledger {pid,label:"edit_started"}, then waits for a signal) |
//   no_policy (structured-edit: the emulated policy grants everything, reads and writes outside cwd included) |
//   denials_absent (refused tool uses get an ordinary error result, MOCK_TOOL_ERROR or "denied", and the result event
//     has no permission_denials) | denials_empty (permission_denials: []) | denials_foreign (permission_denials names
//     other tool_use ids) | tool_no_result (a refused tool use gets no tool_result at all; permission_denials lists it)
// MOCK_TOOL_ERROR_CUT=path|token|session: a refusal text padded so that a 300-char cut falls in the middle of the cwd
//   (spelled without /private), of the task's token ("token for later: <x>.") or of the session id.
// structured-edit (recognised by `--tools` containing Edit): init.tools = the `--tools` items + "StructuredOutput",
// init.permissionMode = `--permission-mode`. Task lines `MOCK_WRITE <rel> <base64>` (and MOCK_SCRIPT writes, see
// mock-common.mjs) become a Write tool_use + tool_result each: a path outside cwd (after path.resolve) or in .git/ or
// .claude/ gets an is_error "denied" result and no file; otherwise the file is written (parents created). MOCK_SCRIPT
// reads become a Read tool_use + tool_result each: outside cwd -> is_error "denied", otherwise the file's text. Denied
// tool uses are listed in result.permission_denials. This emulates the CLI permission policy; it does not check it.
// system/init.tools mirrors what Claude Code 2.1.278 sent to the model in the real K1 run (transcript, 2026-09-22):
// `--tools ""` together with `--json-schema` -> ["StructuredOutput"]; otherwise [] (mock simplification).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MODE, SIZES, ledger, emit, readTask, loadState, saveTurn, reportFor, holdStdout, stderrFlood, hold, readSchema, scriptedTurn, lineReader, recordDecision, mcpToolCall, mcpConnect, withProposal } from "./mock-common.mjs";

ledger(process.pid, "mock-claude");
ledger(process.ppid, "parent"); // under startTurn: the supervisor
const args = process.argv.slice(2);
const valueFlags = new Set(["--output-format", "--input-format", "--session-id", "--resume", "-r", "--json-schema", "--model",
  "--permission-mode", "--allowedTools", "--disallowedTools", "--append-system-prompt", "--system-prompt", "--add-dir", "--mcp-config", "--settings", "--setting-sources",
  "--tools", "--max-budget-usd", "--permission-prompts", "--permission-prompt-tool", "--fallback-model", "--agents", "--plugin-dir", "--plugin-url"]);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (valueFlags.has(args[i])) flags[args[i]] = args[++i];
  else flags[args[i]] = true;
}
const resumeId = flags["--resume"] ?? flags["-r"] ?? null;
// Stage 13: `--help` lists the permission modes (as 2.1.281 prints them); a host session without --json-schema is the
// environment probe (initialize / mcp_status only, no user message).
const HELP = `Usage: claude [options] [command] [prompt]
  --dangerously-skip-permissions  Bypass all permission checks.
  --permission-mode <mode>  Permission mode to use for the session (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
  --settings <file-or-json>  Path to a settings JSON file or a JSON string to load additional settings from
`;
if (flags["--help"]) {
  process.stdout.write(HELP);
} else if (flags["--input-format"] === "stream-json" && !flags["--json-schema"]) {
  await probe();
} else if (flags["--input-format"] === "stream-json") {
  await host();
} else if (!flags["-p"] || flags["--output-format"] !== "stream-json" || !flags["--verbose"] || !flags["--json-schema"]) {
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
  const script = scriptedTurn();
  const id = resumeId ?? flags["--session-id"] ?? randomUUID();
  const st = saveTurn(id, prev, task, { jsonSchema: flags["--json-schema"] });
  const sessionId = MODE === "wrong_session" ? randomUUID() : id;
  const assistant = (text, n) => ({
    type: "assistant", session_id: sessionId,
    message: { id: `msg_${n}`, type: "message", role: "assistant", model: "mock", content: [{ type: "text", text }], stop_reason: null },
  });

  if (MODE === "hold_stdout") holdStdout("mock-claude-holder");
  if (MODE === "stderr_flood") await stderrFlood();
  const edit = typeof flags["--tools"] === "string" && flags["--tools"].split(",").includes("Edit");
  const observed = edit ? [...flags["--tools"].split(","), "StructuredOutput"]
    : flags["--tools"] === "" && flags["--json-schema"] ? ["StructuredOutput"] : [];
  const tools = MODE === "tools_nonempty" ? ["Bash"] : MODE === "tools_plus_bash" ? [...observed, "Bash"]
    : MODE === "tools_nested" ? [observed] : MODE === "tools_string" ? observed.join(",") : observed;
  const mcp_servers = MODE === "extra_mcp" ? [{ name: "extra-server", status: "connected" }] : [];
  await emit({
    type: "system", subtype: "init", ...(MODE === "init_no_session" ? {} : { session_id: sessionId }), cwd: process.cwd(),
    ...(MODE === "init_no_tools" ? {} : { tools }), ...(MODE === "init_no_mcp" ? {} : { mcp_servers }),
    model: "mock-claude", ...permissionMode(edit),
  });
  if (MODE === "sleep") return hold();
  if (edit && MODE === "edit_slow") {
    await emit(assistant("Working on it.", "slow"));
    ledger(process.pid, "edit_started");
    return hold();
  }
  const denials = [];
  if (edit) {
    const ctx = { sessionId, task: task.toString("utf8") };
    for (const [i, file] of (script?.reads ?? []).entries()) await read(file, i, sessionId, denials, ctx);
    const lines = [...task.toString("utf8").matchAll(/^MOCK_WRITE (\S+) (\S*)$/gm)].map((m) => ({ rel: m[1], base64: m[2] }));
    for (const [i, w] of [...lines, ...(script?.writes ?? [])].entries()) await write(w, i, sessionId, denials, ctx);
  }
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
  const report = script ? withProposal(script.answer, readSchema(flags["--json-schema"])) : reportFor(st, readSchema(flags["--json-schema"]), resumeId !== null);
  const text = "Done."; // result text is not the answer; structured_output is
  await emit(assistant(text, 0));
  await emit({ ...base, subtype: "success", is_error: false, result: text, ...(MODE === "no_structured" ? {} : { structured_output: report }), ...(edit ? denialsField(denials) : {}) });
  if (MODE === "exit_after_success") process.exitCode = 3;
  if (MODE === "result_then_hang") { ledger(process.pid, "result_sent"); hold(); }
}

function denialsField(denials) {
  if (MODE === "denials_absent") return {};
  if (MODE === "denials_empty") return { permission_denials: [] };
  if (MODE === "denials_foreign") return { permission_denials: denials.map((d) => ({ ...d, tool_use_id: `${d.tool_use_id}_other` })) };
  return { permission_denials: denials };
}
function refusedText(ctx) {
  const cut = process.env.MOCK_TOOL_ERROR_CUT;
  if (!cut) return process.env.MOCK_TOOL_ERROR ?? "denied";
  const frag = cut === "path" ? process.cwd().replace(/^\/private\//, "/") : cut === "token" ? /token for later: (\S+?)\./.exec(ctx.task)?.[1] ?? "" : ctx.sessionId;
  return `${"x".repeat(300 - Math.floor(frag.length / 2))}${frag} is outside the allowed directories (denied)`;
}

function permissionMode(edit) {
  if (!edit) return { permissionMode: "default" };
  if (MODE === "init_no_permission_mode") return {};
  return { permissionMode: MODE === "permission_mode_other" ? "acceptEdits" : flags["--permission-mode"] };
}

// The emulated policy: nothing outside cwd, nothing in .git/ or .claude/ (no_policy: everything allowed).
function deniedPath(file, forWrite) {
  if (MODE === "no_policy") return false;
  const top = path.relative(process.cwd(), file).split(path.sep)[0];
  return top === "" && forWrite || top === ".." || path.isAbsolute(top) || forWrite && (top === ".git" || top === ".claude");
}

async function read(rel, i, sessionId, denials, ctx) {
  const file = path.resolve(process.cwd(), rel);
  const toolUseId = `toolu_mock_r${i}`;
  const input = { file_path: file };
  await emit({
    type: "assistant", session_id: sessionId,
    message: { id: `msg_r${i}`, type: "message", role: "assistant", model: "mock", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: toolUseId, name: "Read", input }] },
  });
  let content, isError = true;
  if (deniedPath(file, false)) {
    content = refusedText(ctx);
    denials.push({ tool_name: "Read", tool_use_id: toolUseId, tool_input: input });
    if (MODE === "tool_no_result") return;
  } else {
    try { content = fs.readFileSync(file, "utf8"); isError = false; } catch (e) { content = `read error ${e.code}`; }
  }
  await emit({
    type: "user", session_id: sessionId,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, ...(isError ? { is_error: true } : {}), content }] },
  });
}

async function write({ rel, base64 }, i, sessionId, denials, ctx) {
  const file = path.resolve(process.cwd(), rel);
  const denied = deniedPath(file, true);
  const toolUseId = `toolu_mock_${i}`;
  await emit({
    type: "assistant", session_id: sessionId,
    message: { id: `msg_w${i}`, type: "message", role: "assistant", model: "mock", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: toolUseId, name: "Write", input: { file_path: file, content: `<${base64.length} base64 chars>` } }] },
  });
  if (denied) {
    denials.push({ tool_name: "Write", tool_use_id: toolUseId, tool_input: { file_path: file } });
    if (MODE === "tool_no_result") return;
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(base64, "base64"));
  }
  await emit({
    type: "user", session_id: sessionId,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, ...(denied ? { is_error: true } : {}), content: denied ? refusedText(ctx) : `wrote ${rel}` }] },
  });
}

// ---- stage 12: `--input-format stream-json --permission-prompt-tool stdio` (the host control protocol) ----
// The task is the first user message; each write (MOCK_WRITE lines, script writes) and each script ask goes through a
// can_use_tool request when MOCK_ASK is set or the script asks, and happens only on "allow". The reply is recorded
// (recordDecision). After the result the mock waits for EOF on stdin, like the real CLI in this mode.
async function host() {
  if (flags["--permission-prompt-tool"] !== "stdio" || flags["--output-format"] !== "stream-json" || !flags["--json-schema"]) {
    process.stderr.write(`mock-claude: unexpected argv ${JSON.stringify(args)}\n`);
    process.exitCode = 2;
    return;
  }
  for (const f of ["--safe-mode", "--restricted", "--bare", "--tools", "--strict-mcp-config", "--setting-sources", "--permission-mode", "--dangerously-skip-permissions"]) {
    // stage 13: a rights mode the person chose is passed, and allowed only when the test says so (MOCK_ALLOW_ACCESS)
    if ((f === "--permission-mode" || f === "--dangerously-skip-permissions") && process.env.MOCK_ALLOW_ACCESS) continue;
    // the default «Рабочая папка» (access.ts "workspace"): acceptEdits with Claude's sandbox in --settings
    if (f === "--permission-mode" && flags[f] === "acceptEdits" && /"sandbox":\{"enabled":true/.test(String(flags["--settings"] ?? ""))) continue;
    if (flags[f] !== undefined) { process.stderr.write(`mock-claude: a native session must not pass ${f}\n`); process.exitCode = 2; return; }
  }
  if (process.env.MOCK_STATE) fs.appendFileSync(path.join(process.env.MOCK_STATE, "claude-argv.jsonl"), JSON.stringify(args) + "\n");
  const input = lineReader(process.stdin);
  let interrupted = false;
  const first = await input.next((m) => m.type === "user");
  if (!first) { process.exitCode = 1; return; }
  const task = Buffer.from(String(first.message?.content ?? ""));
  const prev = resumeId ? loadState(resumeId) : null;
  if (resumeId && !prev) { process.stderr.write(`No conversation found with session ID: ${resumeId}\n`); process.exitCode = 1; return; }
  const script = scriptedTurn();
  const sessionId = resumeId ?? flags["--session-id"] ?? randomUUID();
  const st = saveTurn(sessionId, prev, task, { jsonSchema: flags["--json-schema"], host: true });
  // interrupts are answered whenever they come
  const watchInterrupt = async () => {
    const m = await input.next((x) => x.type === "control_request" && x.request?.subtype === "interrupt");
    if (!m) return;
    interrupted = true;
    await emit({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    await emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, duration_ms: 1, num_turns: 1 });
    process.exit(0);
  };
  void watchInterrupt();
  await emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), model: "mock-claude",
    tools: ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch", "AskUserQuestion", "StructuredOutput"],
    mcp_servers: [{ name: "mock-mcp", status: "connected" }], skills: ["mock-skill"], plugins: [{ name: "mock-plugin", path: "/x" }],
    slash_commands: ["compact", "mock-skill"],
    // MOCK_REPORT_MODE: the CLI runs another mode than asked (as Claude does when auto mode is not available)
    permissionMode: process.env.MOCK_REPORT_MODE ?? flags["--permission-mode"] ?? (flags["--dangerously-skip-permissions"] ? "bypassPermissions" : projectDefaultMode()) });
  if (MODE === "sleep") return hold();
  let n = 0;
  // a.suggestions / a.request (stage 13): the CLI's own suggestions and extra request fields (matched_ask_rule,
  // decision_reason_type, requires_user_interaction, description) as the real CLI sends them.
  const ask = async (tool, toolInput, a = {}) => {
    const requestId = `req_${n++}`;
    await emit({ type: "control_request", request_id: requestId, request: {
      subtype: "can_use_tool", tool_name: tool, input: toolInput, tool_use_id: `toolu_${requestId}`,
      permission_suggestions: a.suggestions ?? (tool === "AskUserQuestion" ? [] : [{ type: "addRules", rules: [{ toolName: tool }], behavior: "allow", destination: "session" }]),
      ...(a.request ?? {})
    } });
    const reply = await input.next((m) => m.type === "control_response" && m.response?.request_id === requestId);
    const r = reply?.response?.response ?? null;
    recordDecision({ n: script?.n ?? 0, tool, reply: r });
    return r;
  };
  for (const a of script?.asks ?? (process.env.MOCK_ASK ? [{ tool: process.env.MOCK_ASK, command: "echo mock" }] : [])) {
    if (a.tool === "elicitation") {
      // an MCP server's form (host answers elicitations): accept with content, decline or cancel
      const requestId = `req_${n++}`;
      await emit({ type: "control_request", request_id: requestId, request: { subtype: "elicitation", mcp_server_name: a.server ?? "mock-mcp",
        message: a.message ?? "Fill the form", mode: a.url ? "url" : "form", ...(a.url ? { url: a.url, elicitation_id: "el1" } : { requested_schema: a.schema }) } });
      const reply = await input.next((m) => m.type === "control_response" && m.response?.request_id === requestId);
      recordDecision({ n: script?.n ?? 0, tool: "elicitation", reply: reply?.response?.response ?? null });
      continue;
    }
    if (a.tool === "mcp") {
      // stage 13 (S4 rehearsal): a real call of a local MCP server; its form goes to the host as an elicitation request
      const text = await mcpToolCall(a.server, a.name, a.arguments ?? {}, "mock-claude", async (p) => {
        const requestId = `req_${n++}`;
        await emit({ type: "control_request", request_id: requestId, request: { subtype: "elicitation", mcp_server_name: a.server, message: p.message, mode: p.mode ?? "form", requested_schema: p.requestedSchema } });
        const reply = await input.next((m) => m.type === "control_response" && m.response?.request_id === requestId);
        const r = reply?.response?.response ?? { action: "cancel" };
        recordDecision({ n: script?.n ?? 0, tool: "elicitation", reply: r });
        return r;
      });
      if (a.saveTo) { const f = path.resolve(process.cwd(), a.saveTo); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, `${text}\n`); }
      await emit({ type: "assistant", session_id: sessionId, message: { id: `msg_m${n}`, type: "message", role: "assistant", model: "mock", stop_reason: "tool_use",
        content: [{ type: "tool_use", id: `toolu_m${n}`, name: `mcp__${a.server}__${a.name}`, input: a.arguments ?? {} }] } });
      await emit({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_m${n}`, content: text }] } });
      n++;
      continue;
    }
    if (a.tool === "Task") {
      // a sub-agent: the Task tool use, one message inside it (parent_tool_use_id), its result
      await emit({ type: "assistant", session_id: sessionId, message: { id: `msg_t${n}`, type: "message", role: "assistant", model: "mock", stop_reason: "tool_use",
        content: [{ type: "tool_use", id: `toolu_task${n}`, name: "Task", input: { description: a.description ?? "explore the code", subagent_type: "Explore", prompt: "look" } }] } });
      await emit({ type: "assistant", session_id: sessionId, parent_tool_use_id: `toolu_task${n}`, message: { id: `msg_s${n}`, type: "message", role: "assistant", model: "mock",
        content: [{ type: "text", text: "sub-agent looking" }], stop_reason: null } });
      await emit({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_task${n}`, content: "found it" }] } });
      n++;
      continue;
    }
    const toolInput = a.tool === "AskUserQuestion"
      ? { questions: [{ question: a.question ?? "Which one?", header: "Q", multiSelect: false, options: (a.options ?? ["a", "b"]).map((label) => ({ label, description: "" })) }] }
      : a.tool === "ExitPlanMode" ? { plan: a.plan ?? "1. do it" }
        : a.input ?? { command: a.command ?? "echo mock", description: "mock" };
    const r = await ask(a.tool, toolInput, a);
    await emit({ type: "assistant", session_id: sessionId, message: { id: `msg_a${n}`, type: "message", role: "assistant", model: "mock", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: `toolu_a${n}`, name: a.tool, input: toolInput }] } });
    await emit({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_a${n}`,
      ...(r?.behavior === "allow" ? {} : { is_error: true }), content: r?.behavior === "allow" ? "ok" : String(r?.message ?? "denied") }] } });
  }
  const lines = [...task.toString("utf8").matchAll(/^MOCK_WRITE (\S+) (\S*)$/gm)].map((m) => ({ rel: m[1], base64: m[2] }));
  for (const [i, w] of [...lines, ...(script?.writes ?? [])].entries()) {
    const file = path.resolve(process.cwd(), w.rel);
    const toolInput = { file_path: file, content: Buffer.from(w.base64, "base64").toString("utf8") };
    const r = process.env.MOCK_ASK === "Write" ? await ask("Write", toolInput) : { behavior: "allow" };
    await emit({ type: "assistant", session_id: sessionId, message: { id: `msg_w${i}`, type: "message", role: "assistant", model: "mock", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: `toolu_w${i}`, name: "Write", input: { file_path: file } }] } });
    if (r?.behavior === "allow") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(w.base64, "base64")); }
    await emit({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_w${i}`,
      ...(r?.behavior === "allow" ? {} : { is_error: true }), content: r?.behavior === "allow" ? `wrote ${w.rel}` : "denied" }] } });
  }
  if (interrupted) return;
  if (MODE === "fail") {
    await emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, duration_ms: 1, num_turns: 1 });
  } else {
    const report = script ? withProposal(script.answer, readSchema(flags["--json-schema"])) : reportFor(st, readSchema(flags["--json-schema"]), resumeId !== null);
    await emit({ type: "assistant", session_id: sessionId, message: { id: "msg_0", type: "message", role: "assistant", model: "mock", content: [{ type: "text", text: "Done." }], stop_reason: null } });
    await emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "Done.", duration_ms: 1, num_turns: 1, total_cost_usd: 0, structured_output: report });
  }
  await input.next(() => false); // EOF
}

// Without a mode flag the CLI starts in the project's own default mode (.claude/settings.json permissions.defaultMode).
function projectDefaultMode() {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), ".claude", "settings.json"), "utf8")).permissions?.defaultMode ?? "default"; } catch { return "default"; }
}

// ---- stage 13: the environment probe (control requests without a user message) ----
async function probe() {
  if (process.env.MOCK_STATE) fs.appendFileSync(path.join(process.env.MOCK_STATE, "claude-probe.jsonl"), JSON.stringify(args) + "\n");
  const input = lineReader(process.stdin);
  for (;;) {
    const m = await input.next((x) => x.type === "control_request" || x.type === "user");
    if (!m) return;
    if (m.type === "user") { process.stderr.write("mock-claude: the probe must not send a user message\n"); process.exit(3); }
    const sub = m.request?.subtype;
    const ok = (response) => emit({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
    if (sub === "initialize") await ok({ commands: [{ name: "compact" }, { name: "mock-skill" }], agents: [{ name: "Explore" }], models: [{ value: "a" }], account: { subscriptionType: "max" } });
    else if (sub === "mcp_status") {
      // the project's .mcp.json servers enabled in .claude/settings.json connect, as with claude -p (S4C rehearsal)
      const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), f), "utf8")); } catch { return null; } };
      const on = read(".claude/settings.json")?.enabledMcpjsonServers ?? [];
      const own = await Promise.all(Object.entries(read(".mcp.json")?.mcpServers ?? {}).filter(([n]) => on.includes(n))
        .map(async ([name, spec]) => ({ name, status: (await mcpConnect(spec, "mock-claude")) ? "connected" : "failed" })));
      await ok({ mcpServers: [{ name: "mock-mcp", status: "connected" }, { name: "needs-login", status: "needs-auth" }, ...own] });
    }
    else await emit({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `mock: ${sub}` } });
  }
}
