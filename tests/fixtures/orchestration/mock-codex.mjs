// Fake `codex` for the turn engine tests. Usage (like the real one):
//   node mock-codex.mjs exec --json [...] -o <file> [--output-schema <f>] -
//   node mock-codex.mjs exec resume <thread_id> --json [...] -o <file> -
// Unknown flags are ignored (value flags: -o -c -C -s -m -p --output-schema --sandbox --model --profile --cd).
// Reads the task from stdin to EOF; stores len/sha256/exact bytes in MOCK_STATE/<thread_id>.json (see mock-common.mjs).
// Modes: ok | fail | usage_limit (app-server) | bad_schema | not_json | exit_after_success | no_terminal | sleep | oversized_line |
//        many_big_events | hold_stdout | no_report_file | wrong_session | big_report | stderr_flood |
//        no_read_stdin (never reads stdin, full successful turn, exit 0) |
//        result_then_hang (full successful turn, ledger line {pid,label:"result_sent"}, then waits for a signal) |
//        wrong_token (token answer with a token that is not the session's) | no_context (token "" on resume) |
//        no_thread_id (thread.started without thread_id)
// MOCK_SCRIPT (see mock-common.mjs): the scripted answer is written to the -o file instead of the default one.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MODE, SIZES, ledger, emit, readTask, loadState, saveTurn, reportFor, holdStdout, stderrFlood, hold, readSchema, scriptedTurn, lineReader, recordDecision, mcpToolCall, mcpConnect, withProposal } from "./mock-common.mjs";
// [mcp_servers.<name>] tables of <dir>/.codex/config.toml, as the series driver writes them (JSON-quoted values).
function projectMcp(dir) {
  let toml = "";
  try { toml = fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf8"); } catch { return {}; }
  const out = {};
  for (const [, name, body] of toml.matchAll(/^\[mcp_servers\.([\w-]+)\]\n((?:(?!\[).*\n?)*)/gm)) {
    const val = (k) => new RegExp(`^${k}\\s*=\\s*(.+)$`, "m").exec(body)?.[1];
    const env = Object.fromEntries([...(val("env") ?? "").matchAll(/([\w]+)\s*=\s*("(?:[^"\\]|\\.)*")/g)].map(([, k, v]) => [k, JSON.parse(v)]));
    out[name] = { command: JSON.parse(val("command") ?? '""'), args: JSON.parse(val("args") ?? "[]"), env };
  }
  return out;
}

async function main() {
  ledger(process.pid, "mock-codex");
  ledger(process.ppid, "parent"); // under startTurn: the supervisor
  const args = process.argv.slice(2);
  const valueFlags = new Set(["-o", "--output-last-message", "-c", "-C", "--cd", "-s", "--sandbox", "-m", "--model", "-p", "--profile", "--output-schema"]);
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) flags[args[i]] = args[++i];
    else if (args[i].startsWith("-") && args[i] !== "-") flags[args[i]] = true;
    else pos.push(args[i]);
  }
  if (pos[0] === "app-server") return appServer(args);
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
  const script = scriptedTurn();
  const id = resumeId ?? randomUUID();
  const st = saveTurn(id, prev, task, { reportFile });
  const threadId = MODE === "wrong_session" ? randomUUID() : id;

  if (MODE === "hold_stdout") holdStdout("mock-codex-holder");
  if (MODE === "stderr_flood") await stderrFlood();
  await emit(MODE === "no_thread_id" ? { type: "thread.started" } : { type: "thread.started", thread_id: threadId });
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
  const text = MODE === "not_json" ? "this is not json {" : JSON.stringify(script ? withProposal(script.answer, schema) : reportFor(st, schema, resumeId !== null));
  await emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
  if (MODE !== "no_report_file") fs.writeFileSync(reportFile, text);
  await emit({ type: "turn.completed", usage: { input_tokens: task.length, cached_input_tokens: 0, output_tokens: text.length } });
  if (MODE === "exit_after_success") process.exitCode = 3;
  if (MODE === "result_then_hang") { ledger(process.pid, "result_sent"); hold(); }
}

// ---- stage 12: `codex app-server` (JSON-RPC lines, no "jsonrpc" field) ----
// initialize -> thread/start|thread/resume -> turn/start {input, outputSchema}. Script asks (see mock-common.mjs) or
// MOCK_ASK=command become item/commandExecution/requestApproval server requests; "accept*" runs the (pretend) command.
// Refuses an approvalPolicy/sandbox/config override other than the default «Рабочая папка» unless MOCK_ALLOW_ACCESS.
async function appServer(args) {
  if (args.length !== 1) { process.stderr.write(`mock-codex: app-server takes no flags here ${JSON.stringify(args)}\n`); process.exitCode = 2; return; }
  const input = lineReader(process.stdin);
  const reply = (id, result) => emit({ id, result });
  let threadId = null, prev = null, nextId = 1000;
  for (;;) {
    const m = await input.next((x) => typeof x.method === "string" && "id" in x || x.method === "initialized");
    if (!m) return; // EOF: the client is done
    if (m.method === "initialized") continue;
    const p = m.params ?? {};
    if (m.method === "initialize") { await reply(m.id, { userAgent: "mock-codex/0.155.1" }); continue; }
    // stage 13: the lists the environment probe reads (no thread, no turn)
    // the project's own MCP servers (<cwd>/.codex/config.toml, as the real Codex): loaded only in a trusted folder
    // (MOCK_CODEX_UNTRUSTED=1: not); without a thread no runtime state, auth "unsupported"; in a thread they connect
    const own = projectMcp(p.cwd ?? process.cwd());
    const trusted = process.env.MOCK_CODEX_UNTRUSTED !== "1";
    if (m.method === "mcpServerStatus/list" && Object.keys(own).length) {
      const data = [{ name: "mock-mcp", runtimeStatus: "ready", authStatus: "notLoggedIn" }];
      if (trusted) for (const [name, spec] of Object.entries(own)) {
        const tools = p.threadId ? await mcpConnect(spec, "mock-codex") : null;
        data.push({ name, authStatus: "unsupported", tools: Object.fromEntries((tools ?? []).map((t) => [t, { name: t }])), ...(p.threadId ? { runtimeStatus: tools ? "connected" : "failed" } : {}) });
      }
      await reply(m.id, { data });
      continue;
    }
    const lists = {
      "config/read": { config: { model: process.env.MOCK_CODEX_CONFIG_MODEL ?? "gpt-mock", approval_policy: "on-request", sandbox_mode: "workspace-write", ...(trusted && Object.keys(own).length ? { mcp_servers: own } : {}) }, origins: {},
        ...(p.includeLayers ? { layers: [{ name: { type: "user" } }, ...(fs.existsSync(path.join(p.cwd ?? process.cwd(), ".codex"))
          ? [{ name: { type: "project", dotCodexFolder: path.join(p.cwd ?? process.cwd(), ".codex") }, config: { mcp_servers: own },
            ...(trusted ? {} : { disabledReason: `To load project-local config, hooks, and exec policies, add ${p.cwd} as a trusted project in ~/.codex/config.toml.` }) }] : [])] } : {}) },
      "skills/list": { data: [{ cwd: p.cwds?.[0] ?? "", skills: [{ name: "mock-skill" }], errors: [] }] },
      "plugin/installed": { marketplaces: [{ name: "m", plugins: [{ name: "mock-plugin", installed: true }] }] },
      "mcpServerStatus/list": { data: [{ name: "mock-mcp", runtimeStatus: "ready", authStatus: "notLoggedIn" }] },
      "hooks/list": { data: [{ cwd: "", hooks: [{ eventName: "SessionStart" }] }] },
      "account/read": { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false },
      // MOCK_CODEX_MODELS: the account's models, comma-separated (a "~" prefix: hidden from the picker)
      "model/list": { data: (process.env.MOCK_CODEX_MODELS ?? "gpt-mock,gpt-mock-mini,~gpt-mock-hidden").split(",").filter(Boolean)
        .filter((m) => p.includeHidden === true || !m.startsWith("~"))
        .map((m) => ({ id: m.replace(/^~/, ""), model: m.replace(/^~/, ""), displayName: m, hidden: m.startsWith("~"), isDefault: false })), nextCursor: null }
    };
    if (lists[m.method]) {
      if (process.env.MOCK_STATE) fs.appendFileSync(`${process.env.MOCK_STATE}/codex-probe.jsonl`, JSON.stringify(m.method) + "\n");
      await reply(m.id, lists[m.method]);
      continue;
    }
    const access = ["approvalPolicy", "sandbox"].some((k) => p[k] !== undefined);
    if (access && process.env.MOCK_STATE) fs.appendFileSync(`${process.env.MOCK_STATE}/codex-access.jsonl`, JSON.stringify({ approvalPolicy: p.approvalPolicy, sandbox: p.sandbox }) + "\n");
    // the default «Рабочая папка» (access.ts "workspace") is always accepted; another override only when the test says so
    const workspace = p.sandbox === "workspace-write" && p.approvalPolicy === "on-request";
    // the only config a session may pass: its own folder trusted for this thread (sessions.ts trustCwd)
    const trustOnce = p.config !== undefined && JSON.stringify(p.config) === JSON.stringify({ projects: { [p.cwd]: { trust_level: "trusted" } } });
    if ((p.config !== undefined && !trustOnce) || p.sandboxPolicy !== undefined || (access && !workspace && !process.env.MOCK_ALLOW_ACCESS)) {
      await emit({ id: m.id, error: { code: -32600, message: "mock: a native session must not override the user's config" } });
      continue;
    }
    if (m.method === "thread/start" || m.method === "thread/resume") {
      if (process.env.MOCK_STATE) fs.appendFileSync(`${process.env.MOCK_STATE}/codex-thread.jsonl`, JSON.stringify({ method: m.method, model: p.model ?? null }) + "\n");
      threadId = m.method === "thread/resume" ? p.threadId : randomUUID();
      prev = m.method === "thread/resume" ? loadState(threadId) : null;
      if (m.method === "thread/resume" && !prev) { await emit({ id: m.id, error: { code: -32602, message: `no thread ${threadId}` } }); continue; }
      // as codex-cli 0.155.1 does (evidence/codex-trust-probe): a workspace-write thread in a folder neither the config nor
      // the thread trusts writes a trust entry for it into $CODEX_HOME/config.toml
      const home = process.env.CODEX_HOME;
      const configFile = home && path.join(home, "config.toml");
      const known = configFile && fs.existsSync(configFile) && fs.readFileSync(configFile, "utf8").includes(`[projects.${JSON.stringify(p.cwd)}]`);
      if (configFile && p.sandbox === "workspace-write" && !trustOnce && !known) {
        fs.appendFileSync(configFile, `\n[projects.${JSON.stringify(p.cwd)}]\ntrust_level = "trusted"\n`);
      }
      const sandboxType = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" }[p.sandbox ?? "workspace-write"];
      // MOCK_REPORT_APPROVAL: the thread gets another policy than asked (a managed configuration may decide so)
      await reply(m.id, { thread: { id: threadId }, model: p.model ?? "mock", cwd: p.cwd ?? process.cwd(), approvalPolicy: process.env.MOCK_REPORT_APPROVAL ?? p.approvalPolicy ?? "on-request",
        sandbox: { type: sandboxType }, instructionSources: ["/x/AGENTS.md"] });
      await emit({ method: "thread/started", params: { thread: { id: threadId } } });
      continue;
    }
    if (m.method === "turn/start") {
      const turnId = randomUUID();
      const task = Buffer.from(String(p.input?.[0]?.text ?? ""));
      await reply(m.id, { turn: { id: turnId, status: "inProgress", items: [] } });
      await emit({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
      const script = scriptedTurn();
      const st = saveTurn(threadId, prev, task, { appServer: true, outputSchema: p.outputSchema ?? null });
      prev = st;
      if (MODE === "sleep") {
        const i = await input.next((x) => x.method === "turn/interrupt");
        if (!i) return;
        await reply(i.id, {});
        await emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [], error: null } } });
        continue;
      }
      for (const a of script?.asks ?? (process.env.MOCK_ASK ? [{ tool: "command", command: "echo mock" }] : [])) {
        const id = nextId++;
        const itemId = `item_${id}`;
        if (a.tool === "elicitation") {
          await emit({ id, method: "mcpServer/elicitation/request", params: { threadId, turnId, serverName: a.server ?? "mock-mcp", mode: a.url ? "url" : "form",
            message: a.message ?? "Fill the form", _meta: null, ...(a.url ? { url: a.url, elicitationId: "el1" } : { requestedSchema: a.schema }) } });
          const r = await input.next((x) => x.id === id && !x.method);
          recordDecision({ n: script?.n ?? 0, tool: "elicitation", reply: r?.result ?? r?.error ?? null });
          continue;
        }
        if (a.tool === "mcp") {
          // stage 13 (S4 rehearsal): a real call of a local MCP server; its form goes to the client as an elicitation request
          let k = 0;
          const text = await mcpToolCall(a.server, a.name, a.arguments ?? {}, "mock-codex", async (q) => {
            const rid = `${id}_${k++}`;
            await emit({ id: rid, method: "mcpServer/elicitation/request", params: { threadId, turnId, serverName: a.server, mode: "form", message: q.message, _meta: null, requestedSchema: q.requestedSchema } });
            const r = await input.next((x) => x.id === rid && !x.method);
            recordDecision({ n: script?.n ?? 0, tool: "elicitation", reply: r?.result ?? r?.error ?? null });
            return r?.result ? { action: r.result.action, ...(r.result.content ? { content: r.result.content } : {}) } : { action: "cancel" };
          });
          // the S4X rehearsal: the lead's result line kept in the project (a real lead hands it to the executor)
          if (a.saveTo) { const f = path.resolve(process.cwd(), a.saveTo); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, `${text}\n`); }
          const item = { type: "mcpToolCall", id: itemId, server: a.server, tool: a.name, status: "completed", arguments: a.arguments ?? {}, result: { content: [{ type: "text", text }] } };
          await emit({ method: "item/started", params: { threadId, turnId, item: { ...item, status: "inProgress" } } });
          await emit({ method: "item/completed", params: { threadId, turnId, item } });
          continue;
        }
        if (a.tool === "collab") {
          const item = { type: "collabAgentToolCall", id: itemId, tool: "spawnAgent", status: "inProgress", senderThreadId: threadId, receiverThreadIds: ["sub1"], prompt: "check the tests" };
          await emit({ method: "item/started", params: { threadId, turnId, item } });
          await emit({ method: "item/completed", params: { threadId, turnId, item: { ...item, status: "completed" } } });
          continue;
        }
        if (a.tool === "plan") {
          await emit({ method: "item/completed", params: { threadId, turnId, item: { type: "plan", id: itemId, text: a.plan ?? "1. do it" } } });
          continue;
        }
        if (a.tool === "fileChange") {
          // as 0.155.1: the paths come with the item; the approval request itself carries none
          const changes = (a.paths ?? []).map((p) => ({ path: p, kind: { type: "update", move_path: null }, diff: "" }));
          await emit({ method: "item/started", params: { threadId, turnId, item: { type: "fileChange", id: itemId, changes, status: "inProgress" } } });
          await emit({ id, method: "item/fileChange/requestApproval", params: { threadId, turnId, itemId, startedAtMs: Date.now(), reason: a.reason ?? null, grantRoot: null } });
          const r = await input.next((x) => x.id === id && !x.method);
          recordDecision({ n: script?.n ?? 0, tool: "fileChange", reply: r?.result ?? r?.error ?? null });
          await emit({ method: "item/completed", params: { threadId, turnId, item: { type: "fileChange", id: itemId, changes, status: "completed" } } });
          continue;
        }
        if (a.tool === "question") {
          await emit({ id, method: "item/tool/requestUserInput", params: { threadId, turnId, itemId, isBlocking: true, autoResolutionMs: null,
            questions: [{ id: "q1", header: "Q", question: a.question ?? "Which one?", isOther: true, isSecret: a.secret === true, options: (a.options ?? ["a", "b"]).map((label) => ({ label, description: "" })) }] } });
        } else {
          await emit({ id, method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId, startedAtMs: Date.now(), command: a.command ?? "echo mock", cwd: process.cwd(), reason: null } });
        }
        const r = await input.next((x) => x.id === id && !x.method);
        recordDecision({ n: script?.n ?? 0, tool: a.tool, reply: r?.result ?? r?.error ?? null });
        if (a.tool !== "question") {
          const ok = String(r?.result?.decision ?? "").startsWith("accept");
          await emit({ method: "item/started", params: { threadId, turnId, item: { type: "commandExecution", id: itemId, command: a.command ?? "echo mock", status: "inProgress" } } });
          await emit({ method: "item/completed", params: { threadId, turnId, item: { type: "commandExecution", id: itemId, command: a.command ?? "echo mock",
            status: ok ? "completed" : "declined", exitCode: ok ? 0 : null, aggregatedOutput: ok ? "mock output\n" : null } } });
        }
      }
      if (MODE === "fail") {
        await emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", items: [], error: { message: "mock failure" } } } });
        continue;
      }
      if (MODE === "usage_limit") {
        // The account's usage limit, as codex-cli 0.155.1 ended a real turn (evidence/real-stage-13/series-S3-S5-S6-attempt2,
        // codex-turn-error.jsonl): an error notification, then the turn failed with the same message; the process exits 0.
        const message = "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 28th, 2026 11:51 PM.";
        await emit({ method: "error", params: { threadId, turnId, willRetry: false, error: { message } } });
        await emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", items: [], error: { message } } } });
        continue;
      }
      // MOCK_SCRIPT <n>.writes.json: files the turn writes in its folder (a reviewer that changes the tree, A3)
      for (const w of script?.writes ?? []) { const f = path.resolve(process.cwd(), w.rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(w.base64, "base64")); }
      const text = JSON.stringify(script ? withProposal(script.answer, p.outputSchema ?? null) : reportFor(st, p.outputSchema ?? null, prev !== null && st.turns.length > 1));
      await emit({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "msg_0", text } } });
      await emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      await emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last: { inputTokens: task.length, outputTokens: text.length } } } });
      continue;
    }
    await emit({ id: m.id, error: { code: -32601, message: `mock: ${m.method}` } });
  }
}

main();
