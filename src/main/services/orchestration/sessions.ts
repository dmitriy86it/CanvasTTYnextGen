// Stage 12 (docs/agent-orchestration/implementation/stage-12-native-sessions.md): drivers of the two bidirectional
// protocols the agents run under, so that they keep the user's own configuration and the CLI's own permission
// prompts. Nothing here answers a prompt: every request goes to `ask` (the person), and only its reply is sent back.
//
// Codex: `codex app-server` (JSON-RPC lines without "jsonrpc"), shapes from `codex app-server generate-ts` (0.155.1).
// Claude: `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`, the host
// control protocol of the Agent SDK (control_request can_use_tool / control_response, interrupt).
import { randomUUID } from "node:crypto";
import type { OrchestrationForm } from "../../../shared/orchestration.ts";
import { parseFormSchema } from "./forms.ts";
import type { EventFrame, SessionDriver, SessionIO } from "./types.ts";

export type PermissionKind = "command" | "file_change" | "permissions" | "tool" | "question" | "elicitation" | "plan";
export type PermissionOption = "allow_once" | "allow_session" | "deny";
export interface PermissionQuestion { id: string; question: string; options: string[]; multiple: boolean; other: boolean; secret?: boolean }
// What the person is asked. Raw values of the CLI; sanitizing for display and the journal is the caller's.
export interface PermissionAsk {
  kind: PermissionKind;
  tool: string; // "Bash", "Edit", "command", an MCP tool name…
  summary: string; // the command line, the path, the reason: what the CLI said it wants
  input: unknown; // the tool input or request params as sent by the CLI
  options: PermissionOption[];
  questions?: PermissionQuestion[];
  form?: OrchestrationForm; // elicitation
  plan?: string; // plan: the plan text
  server?: string; // elicitation: the MCP server's name
  // The CLI says this prompt must reach a person (a user's ask rule, a safety check, a tool whose card is the answer),
  // or CanvasTTY cannot tell what exactly is allowed: a saved decision never answers it.
  alwaysAsk?: boolean;
}
// content: the validated values of a form (elicitation, allow_once = accept); feedback: why a plan goes back (deny).
export interface PermissionReply { decision: PermissionOption; answers?: Record<string, string[]>; content?: Record<string, unknown>; feedback?: string }
// signal: aborted when the CLI withdraws the request (or the turn ends); the reply is then not sent.
export type AskPerson = (ask: PermissionAsk, signal: AbortSignal) => Promise<PermissionReply>;

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

// Shared plumbing: one pending request per CLI request id, withdrawn on cancel or at the end of the turn.
function asker(ask: AskPerson, io: () => SessionIO | null) {
  const pending = new Map<string, AbortController>();
  return {
    request(key: string, question: PermissionAsk, reply: (r: PermissionReply) => void): void {
      const ctrl = new AbortController();
      pending.set(key, ctrl);
      io()?.hold(true);
      void ask(question, ctrl.signal).then((r) => {
        if (!ctrl.signal.aborted) reply(r);
      }, () => {
        // No reply could be obtained (the run is closing): nothing is sent, the CLI keeps waiting until the stop.
      }).finally(() => {
        if (pending.get(key) === ctrl) { pending.delete(key); io()?.hold(false); }
      });
    },
    cancel(key: string): void {
      const ctrl = pending.get(key);
      if (!ctrl) return;
      pending.delete(key);
      ctrl.abort();
      io()?.hold(false);
    },
    cancelAll(): void { for (const key of [...pending.keys()]) this.cancel(key); }
  };
}

// ---------------- Codex app-server ----------------

export interface CodexSessionInput {
  cwd: string;
  task: string;
  schema: unknown;
  threadId: string | null; // resume the role's thread
  clientVersion: string;
  ask: AskPerson;
  access?: Record<string, string>; // thread parameters of the chosen rights mode (access.ts); none: the user's config decides
  // The run's own copy or worktree: trusted for this thread only. Codex otherwise writes a [projects."<cwd>"] trust entry
  // into the person's config.toml for every run that works with a workspace-write sandbox in a folder it does not know
  // (codex-cli 0.155.1, evidence/codex-trust-probe). The person's own project folder is never passed here.
  trustCwd?: boolean;
  model?: string; // this thread's model (thread/start, thread/resume); absent: the user's config.toml decides
}

// An MCP form of either CLI, as the person is asked it.
function formAsk(server: string, message: string, mode: unknown, url: unknown, schema: unknown, input: unknown): PermissionAsk {
  const form: OrchestrationForm = mode === "url"
    ? (typeof url === "string" && /^https?:\/\//.test(url) ? { mode: "url", url } : { mode: "unsupported", reason: "the page address is not http(s)" })
    : parseFormSchema(schema);
  return {
    kind: "elicitation", tool: server || "MCP", summary: message, input, server,
    options: form.mode === "unsupported" ? ["deny"] : ["allow_once", "deny"], form
  };
}

export function codexAppServerDriver(input: CodexSessionInput): SessionDriver {
  let io: SessionIO | null = null;
  let nextId = 1;
  const calls = new Map<number, (result: Record<string, unknown>) => void>();
  let threadId: string | null = input.threadId;
  let turnId: string | null = null;
  let lastText: string | null = null;
  let ended = false;
  const people = asker(input.ask, () => io);
  // Paths of a file change, from its item/started, by item id: the approval request itself carries none.
  const fileChanges = new Map<string, string[]>();

  const call = (method: string, params: unknown, then: (result: Record<string, unknown>) => void): void => {
    const id = nextId++;
    calls.set(id, then);
    io?.send({ id, method, params });
  };
  const end = () => { if (!ended) { ended = true; people.cancelAll(); io?.end(); } };

  function startTurn(): void {
    call("turn/start", {
      threadId, input: [{ type: "text", text: input.task, text_elements: [] }], outputSchema: input.schema
    }, (r) => { turnId = str(rec(r.turn).id) || turnId; });
  }

  function serverRequest(id: unknown, method: string, p: Record<string, unknown>): void {
    const key = `rpc:${str(id)}`;
    const respond = (result: unknown) => io?.send({ id, result });
    const approval = (kind: PermissionKind, tool: string, summary: string, legacy: boolean) =>
      people.request(key, { kind, tool, summary, input: p, options: ["allow_once", "allow_session", "deny"] }, (r) => respond({
        decision: legacy
          ? (r.decision === "allow_once" ? "approved" : r.decision === "allow_session" ? "approved_for_session" : { denied: { rejection: "declined by the user in CanvasTTY" } })
          : (r.decision === "allow_once" ? "accept" : r.decision === "allow_session" ? "acceptForSession" : "decline")
      }));
    switch (method) {
      case "item/commandExecution/requestApproval":
        return approval("command", "command", str(p.command) || str(p.reason), false);
      case "item/fileChange/requestApproval": {
        const paths = fileChanges.get(str(p.itemId)) ?? [];
        const summary = [paths.join(", "), str(p.reason) || str(p.grantRoot)].filter(Boolean).join(" · ") || "file changes";
        // Without the paths nobody could tell what a saved decision would cover: always asked.
        return people.request(key, {
          kind: "file_change", tool: "file change", summary, input: { ...p, paths }, options: ["allow_once", "allow_session", "deny"],
          ...(paths.length ? {} : { alwaysAsk: true })
        }, (r) => respond({ decision: r.decision === "allow_once" ? "accept" : r.decision === "allow_session" ? "acceptForSession" : "decline" }));
      }
      case "execCommandApproval":
        return approval("command", "command", Array.isArray(p.command) ? p.command.map(str).join(" ") : str(p.command), true);
      case "applyPatchApproval":
        return approval("file_change", "file change", Object.keys(rec(p.fileChanges)).join(", ") || str(p.reason), true);
      case "item/permissions/requestApproval":
        return people.request(key, {
          kind: "permissions", tool: "permissions", summary: str(p.reason) || str(p.permissions), input: p, options: ["allow_once", "allow_session", "deny"]
        }, (r) => respond(r.decision === "deny"
          ? { permissions: {}, scope: "turn" }
          : { permissions: grantedOf(p.permissions), scope: r.decision === "allow_session" ? "session" : "turn" }));
      case "item/tool/requestUserInput": {
        const questions = (Array.isArray(p.questions) ? p.questions : []).map(rec).map((q) => ({
          id: str(q.id), question: str(q.question) || str(q.header),
          options: (Array.isArray(q.options) ? q.options : []).map((o) => str(rec(o).label) || str(o)), multiple: false, other: q.isOther === true,
          ...(q.isSecret === true ? { secret: true } : {})
        }));
        return people.request(key, { kind: "question", tool: "question", summary: questions.map((q) => q.question).join(" / "), input: p, options: ["allow_once", "deny"], questions },
          (r) => respond({ answers: Object.fromEntries(questions.map((q) => [q.id, { answers: r.decision === "deny" ? [] : r.answers?.[q.id] ?? [] }])) }));
      }
      case "mcpServer/elicitation/request": {
        const ask = formAsk(str(p.serverName), str(p.message), p.mode === "openai/form" || p.mode === "openaiForm" ? "form" : p.mode, p.url, p.requestedSchema, p);
        return people.request(key, ask, (r) => respond(r.decision === "deny"
          ? { action: "decline", content: null, _meta: null }
          : { action: "accept", content: ask.form?.mode === "form" ? (r.content ?? {}) : null, _meta: null }));
      }
      default:
        // Requests of client-managed auth, attestation or client tools: this client offers none of them.
        io?.send({ id, error: { code: -32601, message: `CanvasTTY does not handle ${method}` } });
    }
  }

  return {
    rpc: true,
    terminal(f) {
      if (f.type !== "turn/completed") return null;
      return str(rec(rec(f.value.params).turn).status) === "completed" ? "ok" : "fail";
    },
    sessionId(f) {
      if (f.type === "thread/started") return str(rec(rec(f.value.params).thread).id) || null;
      if (f.type === "rpc.response") return str(rec(rec(f.value.result).thread).id) || null;
      return null;
    },
    start(sessionIo) {
      io = sessionIo;
      call("initialize", { clientInfo: { name: "canvastty", title: "Raoden Loom", version: input.clientVersion }, capabilities: null }, () => {
        io?.send({ method: "initialized" });
        // No approvalPolicy or sandbox: the user's own config.toml and profile decide, as in the terminal. With a chosen
        // rights mode, exactly its sandbox and approval policy for this thread. The only config is the trust of the run's
        // own folder, for this thread (trustCwd). A chosen model goes to this thread only (`model`), never to config.toml.
        const then = (r: Record<string, unknown>) => { threadId = str(rec(r.thread).id) || threadId; startTurn(); };
        const params = { cwd: input.cwd, ...(input.access ?? {}), ...(input.model ? { model: input.model } : {}), ...(input.trustCwd ? { config: { projects: { [input.cwd]: { trust_level: "trusted" } } } } : {}) };
        if (threadId) call("thread/resume", { threadId, ...params }, then);
        else call("thread/start", params, then);
      });
    },
    frame(f: EventFrame) {
      const v = f.value;
      if (f.type === "rpc.response") {
        const then = calls.get(Number(v.id));
        calls.delete(Number(v.id));
        if (v.error !== undefined) throw new Error(`codex app-server refused request ${str(v.id)}: ${str(rec(v.error).message).slice(0, 200)}`);
        then?.(rec(v.result));
        return;
      }
      if ("id" in v && typeof v.method === "string") return serverRequest(v.id, v.method, rec(v.params));
      if (f.type === "serverRequest/resolved") return people.cancel(`rpc:${str(rec(v.params).requestId)}`);
      if (f.type === "item/started") {
        const item = rec(rec(v.params).item);
        if (item.type === "fileChange" && Array.isArray(item.changes)) {
          fileChanges.set(str(item.id), item.changes.map((c) => str(rec(c).path)).filter(Boolean));
        }
      }
      if (f.type === "item/completed") {
        const item = rec(rec(v.params).item);
        if (item.type === "agentMessage" && typeof item.text === "string") lastText = item.text;
      }
      if (f.type === "turn/started") turnId = str(rec(rec(v.params).turn).id) || turnId;
      if (f.type === "turn/completed") end();
    },
    answer() {
      if (lastText === null) return undefined;
      try { return JSON.parse(lastText); } catch { return undefined; }
    },
    interrupt() {
      people.cancelAll();
      if (threadId && turnId) call("turn/interrupt", { threadId, turnId }, () => {});
    }
  };
}

// A grant is exactly what was asked for, never more.
function grantedOf(requested: unknown): Record<string, unknown> {
  const r = rec(requested);
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined));
}

// ---------------- Claude host protocol ----------------

// sandboxed: the «Рабочая папка» mode (access.ts): every Bash command runs in Claude's sandbox unless it asks to leave it
export interface ClaudeSessionInput { task: string; ask: AskPerson; sandboxed?: boolean }

export function claudeHostDriver(input: ClaudeSessionInput): SessionDriver {
  let io: SessionIO | null = null;
  let structured: unknown;
  let ended = false;
  const people = asker(input.ask, () => io);
  const end = () => { if (!ended) { ended = true; people.cancelAll(); io?.end(); } };
  const respond = (requestId: string, response: unknown) =>
    io?.send({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  const refuse = (requestId: string, error: string) =>
    io?.send({ type: "control_response", response: { subtype: "error", request_id: requestId, error } });

  function canUseTool(requestId: string, r: Record<string, unknown>): void {
    const tool = str(r.tool_name);
    const toolInput = rec(r.input);
    const suggestions = Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [];
    if (tool === "AskUserQuestion") {
      const questions = (Array.isArray(toolInput.questions) ? toolInput.questions : []).map(rec).map((q, i) => ({
        id: str(q.question) || String(i), question: str(q.question), multiple: q.multiSelect === true, other: true,
        options: (Array.isArray(q.options) ? q.options : []).map((o) => str(rec(o).label) || str(o))
      }));
      return people.request(requestId, { kind: "question", tool, summary: questions.map((q) => q.question).join(" / "), input: toolInput, options: ["allow_once", "deny"], questions },
        (reply) => respond(requestId, reply.decision === "deny"
          ? { behavior: "deny", message: "The user declined to answer in CanvasTTY." }
          : { behavior: "allow", updatedInput: { ...toolInput, answers: Object.fromEntries(questions.map((q) => [q.id, (reply.answers?.[q.id] ?? []).join(", ")])) } }));
    }
    if (tool === "ExitPlanMode") {
      // Leaving plan mode is the agent asking to go ahead with its plan: shown as the plan, approved or sent back.
      const plan = str(toolInput.plan).slice(0, 20_000);
      return people.request(requestId, { kind: "plan", tool, summary: plan.split("\n")[0].slice(0, 200), input: toolInput, plan, options: ["allow_once", "deny"] },
        (reply) => respond(requestId, reply.decision === "deny"
          ? { behavior: "deny", message: reply.feedback?.trim() || "The user wants to keep planning." }
          : { behavior: "allow", updatedInput: toolInput }));
    }
    const summary = str(toolInput.command) || str(toolInput.file_path) || str(toolInput.path) || str(toolInput.url) || str(toolInput.host)
      || str(r.description) || str(r.blocked_path) || str(r.decision_reason);
    // A prompt forced by the user's ask rule or a safety check, or one whose card is the answer, is always the person's.
    const alwaysAsk = r.matched_ask_rule !== undefined && r.matched_ask_rule !== null
      || r.decision_reason_type === "rule" || r.decision_reason_type === "safetyCheck" || r.requires_user_interaction === true;
    // 1.5.13: in the sandbox, a Bash prompt that only says the CLI could not read the command line before it runs (a
    // variable, a quoted brace, `bash -c '…'`: run 7303d772) is answered here. The command still runs in the sandbox —
    // it writes only in the work folder and reaches no outside host; a command that asks to leave the sandbox, a user's
    // ask rule and a safety check still reach the person.
    if (input.sandboxed && tool === "Bash" && toolInput.dangerouslyDisableSandbox !== true && !alwaysAsk
      && (r.decision_reason_type === "other" || r.decision_reason_type === "subcommandResults")) {
      return respond(requestId, { behavior: "allow", updatedInput: toolInput });
    }
    people.request(requestId, {
      kind: "tool", tool, summary, input: toolInput,
      options: suggestions.length ? ["allow_once", "allow_session", "deny"] : ["allow_once", "deny"],
      ...(alwaysAsk ? { alwaysAsk: true } : {})
    }, (reply) => respond(requestId, reply.decision === "deny"
      ? { behavior: "deny", message: "The user denied this action in CanvasTTY." }
      // "For the session": the CLI's own suggested rules, kept for this session only. The CLI suggests some of them for
      // the project's local settings (the terminal's "don't ask again"); the button says session, so they stay there.
      : { behavior: "allow", updatedInput: toolInput, ...(reply.decision === "allow_session" ? { updatedPermissions: suggestions.map((s) => ({ ...rec(s), destination: "session" })) } : {}) }));
  }

  return {
    rpc: false,
    terminal(f) {
      if (f.type !== "result") return null;
      return f.value.subtype === "success" && f.value.is_error === false ? "ok" : "fail";
    },
    sessionId(f) {
      if ((f.type === "system" && f.value.subtype === "init") || f.type === "result") return str(f.value.session_id) || null;
      return null;
    },
    start(sessionIo) {
      io = sessionIo;
      io.send({ type: "user", message: { role: "user", content: input.task }, parent_tool_use_id: null, session_id: "" });
    },
    frame(f) {
      const v = f.value;
      if (f.type === "control_request") {
        const requestId = str(v.request_id);
        const r = rec(v.request);
        if (r.subtype === "can_use_tool") return canUseTool(requestId, r);
        if (r.subtype === "elicitation") {
          const ask = formAsk(str(r.mcp_server_name), str(r.message), r.mode, r.url, r.requested_schema, r);
          return people.request(requestId, ask, (reply) => respond(requestId, reply.decision === "deny"
            ? { action: "decline" }
            : { action: "accept", ...(ask.form?.mode === "form" ? { content: reply.content ?? {} } : {}) }));
        }
        return refuse(requestId, `CanvasTTY does not handle ${str(r.subtype)}`);
      }
      if (f.type === "control_cancel_request") return people.cancel(str(v.request_id));
      if (f.type === "result") {
        structured = v.structured_output;
        end();
      }
    },
    answer() { return structured; },
    interrupt() {
      people.cancelAll();
      io?.send({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
    }
  };
}
