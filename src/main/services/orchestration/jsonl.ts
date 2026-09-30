// Byte-level JSONL framer: split on 0x0A before decoding, so a UTF-8 sequence cut
// between chunks is never decoded half-way; decode each complete line with a
// fatal TextDecoder; never truncate before JSON.parse.
import { constants } from "node:os";
import type { EventFrame, Frame, OrchestrationProvider, TransportStatus } from "./types.ts";

export interface FramerLimits {
  maxMessageBytes: number; // one line, without '\n'
  maxStreamBytes: number; // whole stdout for one run
  // JSON-RPC lines (codex app-server) carry no `type`: their method, or "rpc.response" for a reply, stands in for it.
  rpc?: boolean;
}

export const DEFAULT_FRAMER_LIMITS: FramerLimits = { maxMessageBytes: 16 * 1024 * 1024, maxStreamBytes: 512 * 1024 * 1024 };

const HEAD_BYTES = 200; // diagnostics only, after the decision is made
const INITIAL_CAPACITY = 4096;
const KEEP_CAPACITY = 1024 * 1024; // a line buffer that grew past this is released after the line

export class JsonlFramer {
  // One growing buffer (doubling, capped at maxMessageBytes): no per-fragment Buffer objects,
  // amortized O(n) copying however small the chunks are.
  private buf = Buffer.allocUnsafe(INITIAL_CAPACITY);
  private len = 0;
  private skipping = false; // inside an oversized line: count nothing, drop bytes until '\n'
  private total = 0;
  private dead = false;

  private readonly emit: (frame: Frame) => void;
  private readonly limits: FramerLimits;

  constructor(emit: (frame: Frame) => void, limits: FramerLimits = DEFAULT_FRAMER_LIMITS) {
    this.emit = emit;
    this.limits = limits;
  }

  push(chunk: Buffer): void {
    if (this.dead) return;
    this.total += chunk.length;
    if (this.total > this.limits.maxStreamBytes) {
      this.dead = true;
      this.release();
      this.emit({ kind: "error", code: "stream_limit", bytes: this.total, head: "" });
      return;
    }
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl < 0 ? chunk.length : nl;
      this.append(chunk.subarray(start, end));
      if (nl < 0) return;
      this.finishLine();
      start = nl + 1;
    }
  }

  // Call once on stdout 'end'. A tail without '\n' is reported, never trusted.
  // An oversized tail was already reported when it crossed the limit.
  end(): void {
    if (this.dead) return;
    this.dead = true;
    if (!this.skipping && this.len > 0) {
      this.emit({ kind: "error", code: "unterminated_tail", bytes: this.len, head: this.head() });
    }
    this.release();
  }

  private append(slice: Buffer): void {
    if (slice.length === 0 || this.skipping) return;
    const need = this.len + slice.length;
    if (need > this.limits.maxMessageBytes) {
      // Reported once, right now (not at '\n'/EOF); `bytes` is how much was seen when the limit was crossed.
      const head = (this.len > 0 ? this.buf.subarray(0, this.len) : slice).subarray(0, HEAD_BYTES).toString("utf8");
      this.skipping = true;
      this.release();
      this.emit({ kind: "error", code: "oversized", bytes: need, head });
      return;
    }
    if (need > this.buf.length) {
      let cap = this.buf.length;
      while (cap < need) cap *= 2;
      const next = Buffer.allocUnsafe(Math.min(cap, this.limits.maxMessageBytes));
      this.buf.copy(next, 0, 0, this.len);
      this.buf = next;
    }
    slice.copy(this.buf, this.len); // copy: the chunk may be reused by the caller
    this.len = need;
  }

  private finishLine(): void {
    if (this.skipping) {
      this.skipping = false; // resync: the next line is parsed normally
      return;
    }
    let line = this.buf.subarray(0, this.len);
    this.len = 0;
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
    if (line.length > 0) this.parse(line);
    if (this.buf.length > KEEP_CAPACITY) this.release();
  }

  // `line` is a view into this.buf: everything here is synchronous and copies what it keeps.
  private parse(line: Buffer): void {
    const head = () => line.subarray(0, HEAD_BYTES).toString("utf8");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      return this.emit({ kind: "error", code: "invalid_utf8", bytes: line.length, head: head() });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.emit({ kind: "error", code: "invalid_json", bytes: line.length, head: head() });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return this.emit({ kind: "error", code: "not_object", bytes: line.length, head: head() });
    }
    const v = value as Record<string, unknown>;
    const type = !this.limits.rpc ? v.type
      : typeof v.method === "string" ? v.method
        : "id" in v && ("result" in v || "error" in v) ? "rpc.response" : undefined;
    if (typeof type !== "string") {
      return this.emit({ kind: "error", code: "missing_type", bytes: line.length, head: head() });
    }
    this.emit({ kind: "event", type, value: value as Record<string, unknown>, bytes: line.length });
  }

  private head(): string {
    return this.buf.subarray(0, Math.min(this.len, HEAD_BYTES)).toString("utf8");
  }

  private release(): void {
    this.buf = Buffer.allocUnsafe(INITIAL_CAPACITY);
    this.len = 0;
  }
}

// ---- turn transport ----
//
// Three different things, never merged:
//  1. agent result   — the terminal event on stdout (codex turn.completed/turn.failed, claude `result`);
//  2. process end    — leader exit code/signal + stdout EOF, and whether the signal was one the supervisor sent;
//  3. run decision   — made by turn.ts (decideOutcome) from the transport, the report and the Stop.
// Ordering vs Stop uses main's own clock: a terminal event is "before Stop" only if main had
// received it strictly before it issued Stop (a result that crosses the Stop in flight does not count).

export interface Transport {
  status: TransportStatus;
  reason: string | null; // null only for "completed"
}

export function terminalOf(provider: OrchestrationProvider, f: Frame): "ok" | "fail" | null {
  if (f.kind !== "event") return null;
  if (provider === "codex") return f.type === "turn.completed" ? "ok" : f.type === "turn.failed" ? "fail" : null;
  if (f.type !== "result") return null;
  return f.value.subtype === "success" && f.value.is_error === false ? "ok" : "fail";
}

// A bidirectional session (stage 12) names its own terminal event and session id, and may send more frames after the
// terminal one (usage, status notifications): those are counted, not a protocol error.
export interface SessionRules {
  terminal(f: EventFrame): "ok" | "fail" | null;
  sessionId(f: EventFrame): string | null;
}

export interface CollectorLimits {
  maxEvents: number; // events kept for display; the rest are counted, not stored
  maxErrors: number; // error frames kept (at least the first is always kept); the rest are counted
  maxHistoryBytes?: number; // sum of kept events' line bytes; independent of maxEvents (default: unbounded)
}

export interface Terminal {
  type: string;
  index: number; // frame index in the stream
  at: number; // main's clock when the frame was received
  result: "ok" | "fail";
  value: Record<string, unknown>;
}

// Frame sink with bounded memory. Keeps what reconcile() needs (errors, terminal events, last index)
// exactly, the session id, and for display only the first events that fit both maxEvents and maxHistoryBytes.
export class TurnCollector {
  readonly events: Frame[] = [];
  readonly errors: Frame[] = [];
  readonly terminals: Terminal[] = []; // at most 2: enough to detect "multiple"
  droppedEvents = 0;
  droppedEventBytes = 0;
  droppedErrors = 0;
  errorCount = 0;
  historyBytes = 0;
  overflowAt: number | null = null; // the one overflow record: frame index where dropping started
  frameCount = 0;
  sessionId: string | null = null; // codex thread.started.thread_id; claude system/init.session_id
  sessionConflict = false; // a later id (codex thread.started, claude init/result) differs from sessionId
  sessionEvent: Record<string, unknown> | null = null; // the event that gave sessionId, kept whatever the history limits

  private historyFull = false; // once an event is dropped, later ones are too: history is a prefix, no gaps
  private readonly provider: OrchestrationProvider;
  private readonly limits: CollectorLimits;

  readonly session: SessionRules | null;
  afterTerminal = 0; // session only: frames after the terminal event

  constructor(provider: OrchestrationProvider, limits: CollectorLimits = { maxEvents: 1000, maxErrors: 100 }, session: SessionRules | null = null) {
    this.provider = provider;
    this.limits = limits;
    this.session = session;
  }

  push = (f: Frame, at: number = performance.now()): void => {
    const index = this.frameCount++;
    if (f.kind === "error") {
      this.errorCount++;
      if (this.errors.length < Math.max(1, this.limits.maxErrors)) this.errors.push(f);
      else this.drop("errors", index);
      return;
    }
    if (this.session && this.terminals.length > 0) this.afterTerminal++;
    const t = this.session ? (this.terminals.length ? null : this.session.terminal(f)) : terminalOf(this.provider, f);
    if (t && this.terminals.length < 2) this.terminals.push({ type: f.type, index, at, result: t, value: f.value });
    this.noteSession(f);
    this.historyFull ||= this.events.length >= this.limits.maxEvents || this.historyBytes + f.bytes > (this.limits.maxHistoryBytes ?? Infinity);
    if (!this.historyFull) {
      this.events.push(f);
      this.historyBytes += f.bytes;
    } else {
      this.droppedEventBytes += f.bytes;
      this.drop("events", index);
    }
  };

  private noteSession(f: EventFrame): void {
    const v = f.value;
    let id: unknown;
    if (this.session) id = this.session.sessionId(f);
    else if (this.provider === "codex") {
      if (f.type === "thread.started") id = v.thread_id;
    } else if ((f.type === "system" && v.subtype === "init") || (f.type === "result" && this.sessionId !== null)) {
      id = v.session_id;
    }
    if (typeof id !== "string") return;
    if (this.sessionId === null) {
      this.sessionId = id;
      this.sessionEvent = v;
    } else if (id !== this.sessionId) this.sessionConflict = true;
  }

  private drop(what: "events" | "errors", index: number): void {
    if (what === "events") this.droppedEvents++;
    else this.droppedErrors++;
    this.overflowAt ??= index;
  }
}

export interface ProcessFacts {
  exitCode: number | null;
  signal: string | null;
  stdoutEnded: boolean; // false => something other than the leader held stdout until cleanup (supervisor `done` facts)
  stderrEnded?: boolean; // same for stderr; undefined = not known (treated as ended)
  stopRequestedAt: number | null; // main's clock (same as TurnCollector `at`); null = no Stop
  signalsToLeader: readonly string[]; // from the supervisor `done` status: signals sent while the leader was alive
}

// Exit caused by a signal the supervisor sent: killed by it, or a shell-style 128+n exit code for it.
export function exitedByOurSignal(p: ProcessFacts): boolean {
  if (p.signal !== null) return p.signalsToLeader.includes(p.signal);
  if (p.exitCode === null || p.exitCode <= 128) return false;
  const code = p.exitCode - 128;
  return p.signalsToLeader.some((s) => constants.signals[s as keyof typeof constants.signals] === code);
}

export function reconcile(c: TurnCollector, p: ProcessFacts): Transport {
  const exitOk = p.exitCode === 0 && p.signal === null;
  const exitStr = `exit=${p.exitCode} signal=${p.signal}`;
  // A Stop explains the ending only if the supervisor actually signalled the live leader.
  const stopHit = p.stopRequestedAt !== null && p.signalsToLeader.length > 0;
  const ours = exitedByOurSignal(p);
  if (c.errorCount > 0) return { status: "protocol_error", reason: c.errors.map((e) => (e.kind === "error" ? e.code : "")).join(",") };
  if (c.terminals.length > 1) return { status: "protocol_error", reason: "multiple_terminal_events" };
  if (!p.stdoutEnded) return { status: "protocol_error", reason: "stdout_held_open" };
  if (p.stderrEnded === false) return { status: "protocol_error", reason: "stderr_held_open" };
  const t = c.terminals[0];
  if (!t) {
    // Interrupted before any result: our signal, or the CLI quit cleanly on it.
    if (stopHit && (ours || exitOk)) return { status: "stopped", reason: exitStr };
    // Stop was in flight but the process ended some other way (e.g. exit 42): not a clean stop.
    if (p.stopRequestedAt !== null && !exitOk) return { status: "failed", reason: `exit_during_stop ${exitStr}` };
    return { status: "protocol_error", reason: `no_terminal_event ${exitStr}` };
  }
  // The terminal event must be the last frame: anything after it is unexpected (a session may add notifications).
  if (!c.session && t.index !== c.frameCount - 1) return { status: "protocol_error", reason: "events_after_terminal" };
  if (t.result === "fail") return { status: "failed", reason: "terminal_failure" };
  if (exitOk) return { status: "completed", reason: null };
  // Success event but non-zero exit: accepted only if Stop came after the result and our signal ended the process.
  if (p.stopRequestedAt !== null && t.at < p.stopRequestedAt && ours) return { status: "completed", reason: null };
  return { status: "failed", reason: `success_event_but_${exitStr}` };
}
