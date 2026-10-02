// Observation of a run's managed sessions (stage 11): the CLIs' structured events turned into short, sanitized entries,
// kept in memory and in a bounded file of their own (<root>/activity/<runId>.jsonl), delivered to the renderer in
// batches. It is a view, not a record the cycle depends on: nothing here decides anything, and a failure here never
// changes a turn, a check or the journal. The model's hidden reasoning is never taken: a reasoning event becomes a
// marker without text. Paths are made relative to the working copy; environment, auth and argv are never read.
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import type {
  OrchestrationActivityEntry,
  OrchestrationActivityKind,
  OrchestrationActivityPage,
  OrchestrationActivityRole
} from "../../../shared/orchestration.ts";
import type { Frame, TurnEnding } from "./types.ts";

export const ACTIVITY_LIMITS = Object.freeze({
  textChars: 1200, // one entry's text
  outputChars: 2000, // a command's output tail / a check's output tail
  entriesPerTurn: 1500, // mapped CLI events per turn; after that one "truncated" entry and only process events
  stderrLinesPerTurn: 200,
  memoryEntries: 3000, // kept in memory per run (the newest)
  fileBytes: 4 * 1024 * 1024, // the run's activity file; after that one "truncated" entry, nothing more is written
  batchMs: 120
});

type Draft = Omit<OrchestrationActivityEntry, "id" | "ts" | "runId"> & { ts?: string };

// ---------- sanitizing ----------

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "<secret>"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "<secret>"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g, "<secret>"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "<secret>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<secret>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "<secret>"], // JWT
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 <secret>"],
  [/\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|passw(?:or)?d|pwd|credential|auth)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)[^\s"',;]{4,}\3/gi, "$1$2<secret>"]
];

export function sanitize(text: string, cwd: string | null, max: number = ACTIVITY_LIMITS.textChars): { text: string; truncated: boolean } {
  let s = String(text).replace(ANSI, "").replace(CONTROL, " ");
  for (const [re, to] of SECRET_PATTERNS) s = s.replace(re, to);
  if (cwd) s = s.split(cwd + "/").join("").split(cwd).join(".");
  const home = homedir();
  if (home && home.length > 1) s = s.split(home).join("~");
  s = s.trim();
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}… [+${s.length - max}]`, truncated: true };
}

// A path an agent named, as the user should see it: relative to the copy, or only its last part if it is outside.
export function shownPath(p: unknown, cwd: string | null): string | null {
  if (typeof p !== "string" || !p) return null;
  if (!isAbsolute(p) || !cwd) return sanitize(p, cwd, 300).text;
  const r = relative(cwd, p);
  if (!r) return ".";
  if (r.startsWith("..") || isAbsolute(r)) return `(outside the copy)/${p.split("/").filter(Boolean).at(-1) ?? ""}`;
  return sanitize(r, null, 300).text;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);

// ---------- CLI events -> drafts ----------

const CLAUDE_FILE_TOOLS_WRITE = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CLAUDE_FILE_TOOLS_READ = new Set(["Read", "NotebookRead"]);

// One per turn: tool ids seen so far (a result names only the id).
// Stage 13: a frame CanvasTTY itself adds to a turn (providers.ts), never read from a CLI's output: the rights mode that
// was asked for and what the CLI says it runs with, when they differ.
export const ACCESS_MISMATCH = Symbol("canvastty.accessMismatch");
export interface AccessMismatch { field: string; asked: string; reported: string }

export function createFrameMapper(provider: "codex" | "claude", role: "lead" | "executor" | "reviewer", cwd: string | null) {
  const tools = new Map<string, { name: string; target: string | null }>();
  const base = { role, provider } as const;
  const d = (kind: OrchestrationActivityKind, text: string, detail?: Draft["detail"], max?: number): Draft => {
    const s = sanitize(text, cwd, max);
    return { ...base, turnId: null, kind, text: s.text, ...(detail || s.truncated ? { detail: { ...(detail ?? {}), ...(s.truncated ? { truncated: true } : {}) } } : {}) };
  };

  function claudeTarget(name: string, input: Record<string, unknown> | null): string | null {
    if (!input) return null;
    const p = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof p === "string") return shownPath(p, cwd);
    if (typeof input.pattern === "string") return sanitize(`${input.pattern}${typeof input.path === "string" ? ` in ${shownPath(input.path, cwd)}` : ""}`, cwd, 200).text;
    if (name === "Task" && typeof input.description === "string") return sanitize(input.description, cwd, 200).text;
    return null;
  }

  function claude(v: Record<string, unknown>): Draft[] {
    const out: Draft[] = [];
    const type = v.type;
    if (type === "system" && v.subtype === "init") {
      const toolsList = Array.isArray(v.tools) ? v.tools.filter((t) => typeof t === "string") as string[] : [];
      // Stage 13: what the CLI itself says it loaded for this session (names only, never values).
      const list = (x: unknown, key = "name") => (Array.isArray(x) ? x.map((e) => (typeof e === "string" ? e : str(rec(e)?.[key]) ?? "")).filter(Boolean) : []);
      const mcp = Array.isArray(v.mcp_servers) ? v.mcp_servers.map(rec).filter(Boolean).map((m) => `${str(m!.name) ?? "?"} (${str(m!.status) ?? "?"})`) : [];
      out.push(d("session", `session started${str(v.model) ? ` · ${v.model}` : ""}`, {
        model: str(v.model), tools: toolsList.slice(0, 20).join(", "), permissionMode: str(v.permissionMode),
        toolCount: toolsList.length, mcp: mcp.join(", ").slice(0, 600), skills: list(v.skills).join(", ").slice(0, 600),
        plugins: list(v.plugins).join(", ").slice(0, 400), slashCommands: list(v.slash_commands).length, agents: list(v.agents).join(", ").slice(0, 400),
        outputStyle: str(v.output_style), apiKeySource: str(v.apiKeySource), cwd: shownPath(v.cwd, cwd) ?? null, reported: true
      }));
      return out;
    }
    // Messages of a sub-agent carry the tool use that started it.
    const parent = typeof v.parent_tool_use_id === "string" ? tools.get(v.parent_tool_use_id) : undefined;
    const inSub = parent ? { subagent: parent.target ?? parent.name } : null;
    const msg = rec(v.message);
    const content = Array.isArray(msg?.content) ? msg!.content as unknown[] : [];
    if (type === "assistant") {
      for (const b of content.map(rec)) {
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push(d("message", b.text, inSub ?? undefined));
        else if (b.type === "thinking" || b.type === "redacted_thinking") out.push(d("thinking", ""));
        else if (b.type === "tool_use" && typeof b.name === "string") {
          const target = claudeTarget(b.name, rec(b.input));
          if (typeof b.id === "string") tools.set(b.id, { name: b.name, target });
          const agentType = str(rec(b.input)?.subagent_type);
          if (b.name === "Task" || b.name === "Agent") out.push(d("subagent", target ?? b.name, { tool: b.name, phase: "started", ...(agentType ? { agent: agentType } : {}) }));
          else if (b.name === "StructuredOutput") out.push(d("tool_started", "structured report", { tool: b.name }));
          else out.push(d("tool_started", target ? `${b.name} ${target}` : b.name, { tool: b.name, target, ...(inSub ?? {}) }));
        }
      }
    } else if (type === "user") {
      for (const b of content.map(rec)) {
        if (!b || b.type !== "tool_result") continue;
        const t = typeof b.tool_use_id === "string" ? tools.get(b.tool_use_id) : undefined;
        const name = t?.name ?? "tool";
        const label = t?.target ? `${name} ${t.target}` : name;
        if (b.is_error === true) {
          const body = typeof b.content === "string" ? b.content : Array.isArray(b.content)
            ? (b.content as unknown[]).map((c) => str(rec(c)?.text) ?? "").join(" ") : "";
          const refused = /permission|denied|not allowed|blocked|outside (?:the )?(?:allowed|working)/i.test(body);
          out.push(d(refused ? "refusal" : "error", `${label}: ${body || "error"}`, { tool: name, target: t?.target ?? null }, 400));
        } else if (name === "Task" || name === "Agent") {
          out.push(d("subagent", label, { tool: name, phase: "finished" }));
        } else {
          out.push(d("tool_finished", label, { tool: name, target: t?.target ?? null, ok: true, ...(inSub ?? {}) }));
          if (t?.target && CLAUDE_FILE_TOOLS_WRITE.has(name)) out.push(d("file_changed", t.target, { tool: name }));
          else if (t?.target && CLAUDE_FILE_TOOLS_READ.has(name)) out.push(d("file_read", t.target, { tool: name }));
        }
      }
    } else if (type === "result") {
      const denials = Array.isArray(v.permission_denials) ? v.permission_denials.length : 0;
      out.push(d(v.is_error === true ? "error" : "usage", v.is_error === true ? `CLI reported an error (${str(v.subtype) ?? "error"})` : "CLI finished its answer", {
        costUsd: typeof v.total_cost_usd === "number" ? v.total_cost_usd : null,
        turns: typeof v.num_turns === "number" ? v.num_turns : null,
        durationMs: typeof v.duration_ms === "number" ? v.duration_ms : null, denials
      }));
      if (denials > 0) out.push(d("refusal", `${denials} tool use(s) refused by the permission policy`, { denials }));
    }
    return out;
  }

  function codexItem(started: boolean, item: Record<string, unknown>): Draft[] {
    const t = str(item.type) ?? "item";
    switch (t) {
      case "reasoning": return started ? [] : [d("thinking", "")];
      case "agent_message": return started ? [] : [d("message", str(item.text) ?? "")];
      case "command_execution": {
        const cmd = str(item.command) ?? "";
        if (started) return [d("tool_started", cmd, { tool: "shell" }, 400)];
        const out = sanitize(str(item.aggregated_output) ?? "", cwd, ACTIVITY_LIMITS.outputChars);
        return [d("tool_finished", cmd, {
          tool: "shell", exitCode: typeof item.exit_code === "number" ? item.exit_code : null, status: str(item.status),
          output: out.text || null, outputTruncated: out.truncated
        }, 400)];
      }
      case "file_change": {
        if (started) return [];
        const changes = Array.isArray(item.changes) ? item.changes.map(rec).filter(Boolean) as Record<string, unknown>[] : [];
        return changes.length ? changes.map((c) => d("file_changed", shownPath(c.path, cwd) ?? "?", { change: str(c.kind) }))
          : [d("file_changed", "files changed", {})];
      }
      case "mcp_tool_call": {
        const name = `${str(item.server) ?? "mcp"}.${str(item.tool) ?? str(item.name) ?? "tool"}`;
        return [d(started ? "tool_started" : "tool_finished", name, { tool: name, status: str(item.status) })];
      }
      case "web_search": return started ? [] : [d("tool_finished", `web search: ${str(item.query) ?? ""}`, { tool: "web_search" })];
      case "todo_list": {
        if (started) return [];
        const items = Array.isArray(item.items) ? item.items.map(rec).filter(Boolean) as Record<string, unknown>[] : [];
        return [d("message", items.map((i) => `${i.completed === true ? "[x]" : "[ ]"} ${str(i.text) ?? ""}`).join("\n") || "plan updated", { todo: items.length })];
      }
      case "error": return [d("error", str(item.message) ?? "error")];
      // app-server's plan item (the plan of a plan-mode turn): shown whole when complete.
      case "plan": return started ? [] : [d("message", str(item.text) ?? "", { plan: true }, 4000)];
      default:
        // Sub-agents (collabAgentToolCall: spawn, message, wait, close) as the CLI reports them.
        if (/collab|agent/i.test(t)) {
          const what = str(item.tool) ?? t;
          const prompt = str(item.prompt);
          return [d("subagent", prompt ? `${what}: ${prompt}` : what, { tool: t, status: str(item.status), phase: started ? "started" : "finished", agents: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : null }, 300)];
        }
        if (t.endsWith("_tool_call")) return [d(started ? "tool_started" : "tool_finished", t, { tool: t, status: str(item.status) })];
        return [];
    }
  }

  // codex app-server (stage 12): JSON-RPC notifications with camelCase items, turned into the exec events above.
  // Deltas are not shown one by one (the completed item carries the whole text); requests are the service's.
  function appServer(v: Record<string, unknown>): Draft[] {
    const p = rec(v.params) ?? {};
    const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const item = (raw: unknown) => {
      const i = rec(raw) ?? {};
      return {
        ...i, type: snake(str(i.type) ?? "item"),
        aggregated_output: i.aggregatedOutput, exit_code: i.exitCode,
        server: i.server, tool: i.tool, query: i.query
      };
    };
    switch (v.method) {
      case "thread/started": return [d("session", "session started")];
      case "item/started": case "item/completed": return codexItem(v.method === "item/started", item(p.item));
      case "turn/completed": {
        const turn = rec(p.turn) ?? {};
        return str(turn.status) === "completed" ? [d("usage", "CLI finished its answer", { durationMs: typeof turn.durationMs === "number" ? turn.durationMs : null })]
          : [d("error", `turn ${str(turn.status) ?? "ended"}${str(rec(turn.error)?.message) ? `: ${str(rec(turn.error)?.message)}` : ""}`)];
      }
      case "thread/tokenUsage/updated": {
        const u = rec(rec(p.tokenUsage)?.last) ?? rec(p.tokenUsage) ?? {};
        return [d("usage", "tokens", {
          inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : null, outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : null
        })];
      }
      case "hook/started": case "hook/completed": return [d(v.method === "hook/started" ? "tool_started" : "tool_finished", `hook ${str(rec(p.run)?.eventName) ?? str(p.eventName) ?? ""}`.trim(), { tool: "hook" })];
      case "error": return [d("error", str(rec(p.error)?.message) ?? "error")];
      case "warning": case "configWarning": case "deprecationNotice": return [d("stderr", str(p.message) ?? str(p.summary) ?? String(v.method))];
      default: return [];
    }
  }

  function codex(v: Record<string, unknown>): Draft[] {
    if (typeof v.method === "string") return appServer(v);
    // Stage 13: the reply to thread/start or thread/resume states what the thread really got (confirmed by the CLI).
    const r = rec(v.result);
    if (r && rec(r.thread) && typeof r.model === "string") {
      const sandbox = rec(r.sandbox);
      const ap = r.approvalPolicy;
      return [d("session", `thread · ${r.model}`, {
        model: r.model, approvalPolicy: typeof ap === "string" ? ap : ap ? "granular" : null,
        sandbox: str(sandbox?.type) ?? str(r.sandbox), instructionSources: Array.isArray(r.instructionSources) ? r.instructionSources.length : null,
        cwd: shownPath(r.cwd, cwd) ?? null, reported: true
      })];
    }
    switch (v.type) {
      case "thread.started": return [d("session", "session started")];
      case "item.started": case "item.completed": {
        const item = rec(v.item);
        return item ? codexItem(v.type === "item.started", item) : [];
      }
      case "turn.completed": {
        const u = rec(v.usage);
        return [d("usage", "CLI finished its answer", {
          inputTokens: typeof u?.input_tokens === "number" ? u.input_tokens : null,
          cachedInputTokens: typeof u?.cached_input_tokens === "number" ? u.cached_input_tokens : null,
          outputTokens: typeof u?.output_tokens === "number" ? u.output_tokens : null
        })];
      }
      case "turn.failed": return [d("error", str(rec(v.error)?.message) ?? "turn failed")];
      case "error": return [d("error", str(v.message) ?? "error")];
      default: return [];
    }
  }

  return (frame: Frame): Draft[] => {
    if (frame.kind === "error") return [d("error", `unreadable CLI output line (${frame.code})`, { code: frame.code, bytes: frame.bytes })];
    const mismatch = (frame.value as { [ACCESS_MISMATCH]?: AccessMismatch[] })[ACCESS_MISMATCH];
    if (mismatch) {
      return mismatch.map((m) => d("error", `rights mode not applied: ${m.field} asked ${m.asked}, the CLI reports ${m.reported}`,
        { accessMismatch: true, field: m.field, asked: m.asked, reported: m.reported }));
    }
    return provider === "claude" ? claude(frame.value) : codex(frame.value);
  };
}

// How a turn ended (TurnResult.ending), flattened for a turn_finished entry's detail: enums, signal names, frame error
// codes and integers only. Flat scalars on purpose: the detail type is one level deep, and 1.5.5 reads the same file
// (it keeps any entry with a numeric id and a string kind and ignores detail keys it does not know).
// ponytail: here and not in the journal, because turn.finished is checked key by key and 1.5.5 would call a journal
// with extra fields or a new record type corrupt; move it into the journal once no such version reads it.
const ENDING_STRING = /^[a-z][a-z0-9_]{0,39}$/; // enum values and frame codes (invalid_utf8)
export function endingDetail(e: TurnEnding | undefined): Record<string, string | number | null> {
  if (!e) return {};
  const word = (v: unknown) => (typeof v === "string" && ENDING_STRING.test(v) ? v : null);
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  const sigs = (a: unknown) => (Array.isArray(a) ? a.filter((x) => typeof x === "string" && /^SIG[A-Z0-9]{1,12}$/.test(x)).slice(0, 8) : []);
  const group = sigs(e.signals?.group);
  const codes = Array.isArray(e.framing?.codes) ? e.framing.codes.map(word).filter((c): c is string => c !== null).slice(0, 8) : [];
  return {
    endStep: word(e.step), stdoutEnd: word(e.streams?.stdout), stderrEnd: word(e.streams?.stderr),
    msTerminalToExit: int(e.ms?.terminalToLeaderExit), msExitToStdoutEof: int(e.ms?.leaderExitToStdoutEof),
    msExitToStderrEof: int(e.ms?.leaderExitToStderrEof), msExitToDone: int(e.ms?.leaderExitToDone),
    groupSignals: group.join(",") || null, groupSignalCount: group.length, leaderSignals: sigs(e.signals?.leader).join(",") || null,
    framingErrors: int(e.framing?.count), framingCodes: codes.join(",") || null, frames: int(e.counts?.frames),
    cappedStreams: int(e.counts?.cappedStreams)
  };
}

// ---------- per-run log ----------

export type ActivityListener = (entries: OrchestrationActivityEntry[]) => void;

interface RunLog {
  entries: OrchestrationActivityEntry[]; // the newest, ≤ memoryEntries
  nextId: number;
  firstId: number;
  fileBytes: number;
  fileFull: boolean;
  writeFailed: boolean;
  dropped: number[]; // afterId of memory drops
  restartGapAfter: number | null; // the application ended while a turn of the previous session ran
  live: boolean; // written to by this process
  listeners: Set<ActivityListener>;
  pending: OrchestrationActivityEntry[];
  timer: NodeJS.Timeout | null;
  chain: Promise<void>;
  loaded: Promise<void> | null;
}

// Whether the last entries of a stored log leave a turn open (its process started, never reported finished).
function openTurnAtEnd(entries: readonly OrchestrationActivityEntry[]): boolean {
  const open = new Set<string>();
  for (const e of entries) {
    if (!e.turnId) continue;
    if (e.kind === "task_sent" || e.kind === "process_started") open.add(e.turnId);
    if (e.kind === "turn_finished") open.delete(e.turnId);
  }
  return open.size > 0;
}

export function createActivityLog(root: string, limits = ACTIVITY_LIMITS) {
  const dir = join(root, "activity");
  const logs = new Map<string, RunLog>();
  const fileOf = (runId: string) => join(dir, `${runId}.jsonl`);

  function logFor(runId: string): RunLog {
    let l = logs.get(runId);
    if (!l) {
      l = {
        entries: [], nextId: 1, firstId: 1, fileBytes: 0, fileFull: false, writeFailed: false, dropped: [], restartGapAfter: null,
        live: false, listeners: new Set(), pending: [], timer: null, chain: Promise.resolve(), loaded: null
      };
      logs.set(runId, l);
    }
    return l;
  }

  // The stored entries of a run, read once per process; a torn or foreign line is skipped (and counted as a gap).
  function load(runId: string): Promise<void> {
    const l = logFor(runId);
    if (!l.loaded) {
      l.loaded = (async () => {
        const buf = await readFile(fileOf(runId)).catch(() => null);
        if (!buf) return;
        l.fileBytes = buf.length;
        const stored: OrchestrationActivityEntry[] = [];
        let bad = false;
        for (const line of buf.toString("utf8").split("\n")) {
          if (!line) continue;
          try {
            const e = JSON.parse(line) as OrchestrationActivityEntry;
            if (typeof e?.id === "number" && typeof e.kind === "string") stored.push(e);
            else bad = true;
          } catch { bad = true; }
        }
        const lastId = stored.at(-1)?.id ?? 0;
        if (stored.some((e) => e.kind === "truncated" && e.role === "run")) l.fileFull = true;
        if (openTurnAtEnd(stored) && !l.live) l.restartGapAfter = lastId;
        if (bad) l.dropped.push(lastId);
        // open() is awaited before a run is driven, so nothing of this process precedes the stored entries; should
        // something have been appended anyway, the stored ones it would collide with are left out of memory.
        const mine = l.entries;
        const keep = stored.filter((e) => mine.length === 0 || e.id < mine[0].id).slice(-limits.memoryEntries);
        l.entries = [...keep, ...mine];
        l.firstId = l.entries[0]?.id ?? l.firstId;
        l.nextId = Math.max(l.nextId, lastId + 1);
      })();
    }
    return l.loaded;
  }

  function flush(l: RunLog): void {
    l.timer = null;
    const batch = l.pending;
    l.pending = [];
    if (!batch.length) return;
    for (const listener of l.listeners) { try { listener(batch); } catch { /* the listener's own failure */ } }
  }

  function persist(runId: string, l: RunLog, e: OrchestrationActivityEntry): void {
    if (l.fileFull || l.writeFailed) return;
    let line = JSON.stringify(e) + "\n";
    if (l.fileBytes + Buffer.byteLength(line) > limits.fileBytes) {
      l.fileFull = true;
      line = JSON.stringify({ ...e, kind: "truncated", role: "run", provider: null, turnId: null,
        text: "activity file limit reached: later entries are kept in memory only" }) + "\n";
    }
    l.fileBytes += Buffer.byteLength(line);
    l.chain = l.chain.then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await appendFile(fileOf(runId), line, { mode: 0o600 });
    }).catch(() => { l.writeFailed = true; });
  }

  function append(runId: string, draft: Draft): OrchestrationActivityEntry | null {
    try {
      const l = logFor(runId);
      l.live = true;
      if (!l.loaded) void load(runId);
      const { ts, ...rest } = draft;
      const e: OrchestrationActivityEntry = { id: l.nextId++, ts: ts ?? new Date().toISOString(), ...rest };
      l.entries.push(e);
      if (l.entries.length > limits.memoryEntries) {
        const cut = l.entries.length - limits.memoryEntries;
        l.entries.splice(0, cut);
        l.firstId = l.entries[0].id;
      }
      persist(runId, l, e);
      l.pending.push(e);
      if (!l.timer) l.timer = setTimeout(() => flush(l), limits.batchMs);
      return e;
    } catch {
      return null;
    }
  }

  return {
    append,
    // Reads the stored entries before this process writes any (ids go on from the last stored one).
    open: (runId: string) => load(runId),

    async page(runId: string, afterId: number, limit: number): Promise<OrchestrationActivityPage> {
      await load(runId);
      await logFor(runId).chain;
      const l = logFor(runId);
      const after = l.entries.filter((e) => e.id > afterId);
      const entries = after.slice(0, limit);
      const gaps: OrchestrationActivityPage["gaps"] = [];
      if (l.restartGapAfter !== null) gaps.push({ afterId: l.restartGapAfter, reason: "app_restarted" });
      for (const id of l.dropped) gaps.push({ afterId: id, reason: "dropped" });
      if (l.writeFailed) gaps.push({ afterId: l.entries.at(-1)?.id ?? 0, reason: "write_failed" });
      return { entries, lastId: l.entries.at(-1)?.id ?? 0, more: after.length > entries.length, gaps, firstId: l.firstId };
    },

    subscribe(runId: string, listener: ActivityListener): () => void {
      const l = logFor(runId);
      l.listeners.add(listener);
      return () => { l.listeners.delete(listener); };
    },

    // Tests: everything written so far is on disk.
    async settled(runId: string): Promise<void> { await logFor(runId).chain; },
    exists: (runId: string) => stat(fileOf(runId)).then(() => true, () => false)
  };
}

export type ActivityLog = ReturnType<typeof createActivityLog>;

// ---------- what the service reports ----------

export interface ActivityTurnInfo {
  turnId: string;
  role: "lead" | "executor" | "reviewer";
  provider: "codex" | "claude";
  purpose: string;
  stage: number | null;
  round: number | null;
  cwd: string;
  taskBytes: number;
  taskPreview: string;
  taskSha256: string | null;
}

// The service's side: a sink per run. Every method is total (never throws) — observation cannot fail a run.
export function createRunActivity(log: ActivityLog, runId: string) {
  const put = (role: OrchestrationActivityRole, provider: "codex" | "claude" | null, turnId: string | null, kind: OrchestrationActivityKind,
    text: string, detail?: Draft["detail"]) => log.append(runId, { role, provider, turnId, kind, text, ...(detail ? { detail } : {}) });

  return {
    turn(info: ActivityTurnInfo) {
      const { turnId, role, provider } = info;
      const map = createFrameMapper(provider, role, info.cwd);
      let mapped = 0, stderrLines = 0, stderrTail = "", truncatedNoted = false, stderrNoted = false;
      const task = sanitize(info.taskPreview, info.cwd, 1500);
      put(role, provider, turnId, "task_sent", task.text, {
        purpose: info.purpose, stage: info.stage, round: info.round, bytes: info.taskBytes, sha256: info.taskSha256, truncated: task.truncated
      });
      const stderrLine = (line: string) => {
        if (!line.trim()) return;
        if (stderrLines >= ACTIVITY_LIMITS.stderrLinesPerTurn) {
          if (!stderrNoted) { stderrNoted = true; put(role, provider, turnId, "truncated", "stderr: more lines not shown", { stream: "stderr" }); }
          return;
        }
        stderrLines++;
        put(role, provider, turnId, "stderr", sanitize(line, info.cwd, 500).text);
      };
      return {
        observer: {
          frame(frame: Frame) {
            if (mapped >= ACTIVITY_LIMITS.entriesPerTurn) {
              if (!truncatedNoted) { truncatedNoted = true; put(role, provider, turnId, "truncated", "more CLI events not shown", { limit: ACTIVITY_LIMITS.entriesPerTurn }); }
              return;
            }
            for (const draft of map(frame)) {
              mapped++;
              log.append(runId, { ...draft, turnId });
            }
          },
          stderr(chunk: Buffer) {
            const text = stderrTail + chunk.toString("utf8");
            const lines = text.split("\n");
            stderrTail = (lines.pop() ?? "").slice(-2000);
            for (const line of lines) stderrLine(line);
          },
          process(event: "spawned" | "cli_started" | "leader_exit", p: { pid?: number | null; code?: number | null; signal?: string | null }) {
            if (event === "cli_started") put(role, provider, turnId, "process_started", "CLI process started", { pgid: p.pid ?? null });
            else if (event === "leader_exit") {
              if (stderrTail) { stderrLine(stderrTail); stderrTail = ""; }
              put(role, provider, turnId, "process_exited", "CLI process exited", { code: p.code ?? null, signal: p.signal ?? null });
            }
          }
        },
        finished(outcome: string, detail: Draft["detail"] = {}) {
          put(role, provider, turnId, "turn_finished", outcome, detail);
        }
      };
    },
    check(kind: "check_started" | "check_finished" | "check_output", text: string, detail?: Draft["detail"]) {
      put("check", null, null, kind, text, detail);
    },
    // A permission or question of a CLI (stage 12): asked, answered by the person, or withdrawn by the CLI.
    // applied (stage 13): a decision the person saved for the run or the project was used again, without a dialog.
    permission(role: "lead" | "executor" | "reviewer", provider: "codex" | "claude", turnId: string | null, phase: "requested" | "decided" | "withdrawn" | "applied",
      text: string, detail?: Draft["detail"]) {
      put(role, provider, turnId, phase === "requested" ? "permission_requested" : phase === "applied" ? "permission_applied" : "permission_decided", text, { phase, ...(detail ?? {}) });
    },
    // Stage 13: the environment preparation and the actions after success, run by CanvasTTY itself.
    prepare(kind: "prepare_started" | "prepare_finished", text: string, detail?: Draft["detail"]) {
      put("run", null, null, kind, text, detail);
    },
    finish(step: string, phase: string, text: string, detail?: Draft["detail"]) {
      put("run", null, null, "external_action", `${step}: ${phase}${text ? ` — ${text}` : ""}`, { step, phase, ...(detail ?? {}) });
    },
    status(status: string, reason: string | null) {
      put("run", null, null, "status", reason ? `${status}: ${reason}` : status, { status, reason });
    }
  };
}

export type RunActivity = ReturnType<typeof createRunActivity>;