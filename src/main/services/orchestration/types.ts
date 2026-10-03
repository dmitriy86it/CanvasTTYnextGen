// Shared types of the one-turn orchestration engine (docs/agent-orchestration/implementation/stage-1-contract.md).
// All `at` values are performance.now() of the main process; supervisor timestamps are never compared with them.

export type OrchestrationProvider = "codex" | "claude";

export interface SupervisorLaunch {
  command: string; // process.execPath (Electron in the app)
  args: readonly string[]; // [supervisorPath]; the CLI argv is appended
  env: Readonly<Record<string, string>>; // only { ELECTRON_RUN_AS_NODE: "1" } in the app; {} under Node
}

export interface TurnLimits {
  maxMessageBytes: number; // one stdout line, without '\n'
  maxStreamBytes: number; // whole stdout of the turn
  maxHistoryEvents: number;
  maxHistoryBytes: number; // independent of maxHistoryEvents
  maxStderrBytes: number; // kept head + tail bytes; the rest is counted
  maxDiagnostics: number;
  maxReportBytes: number; // codex report file / claude structured_output JSON
  timeoutMs: number;
  stdoutGraceMs: number; // last guard: wait for stdout/stderr EOF after the supervisor exited (with its relay: never needed)
}

export interface SupervisorTimings {
  graceIntMs?: number;
  graceTermMs?: number;
  leftoverMs?: number;
}

export type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

// The supported JSON Schema subset (see schema.ts); anything else is rejected by compileSchema.
export interface AnswerSchema {
  type?: SchemaType | readonly SchemaType[];
  properties?: Readonly<Record<string, AnswerSchema>>;
  required?: readonly string[];
  additionalProperties?: false;
  enum?: readonly unknown[];
  items?: AnswerSchema;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
}

// Optional observation of a running turn (stage 11): what the CLI reports, as it arrives. Called synchronously from the
// stream handlers; whatever an observer does or throws never changes the turn, its limits or its outcome.
export interface TurnObserver {
  frame?(frame: Frame): void;
  stderr?(chunk: Buffer): void;
  process?(event: "spawned" | "cli_started" | "leader_exit", info: { pid?: number | null; code?: number | null; signal?: string | null }): void;
}

export interface TurnSpec {
  provider: OrchestrationProvider;
  argv: readonly string[]; // [cliExecutable, ...args]; "{REPORT_FILE}" only for codex
  cwd: string; // existing absolute directory
  env: Readonly<Record<string, string>>; // exact CLI environment; ELECTRON_*, NODE_*, SUP_* are rejected
  task: string | Uint8Array; // fd4 -> CLI stdin, then EOF
  schema: AnswerSchema;
  // the schema the report is checked against, when wider than the one the CLI is given (a review's marks: the CLI is
  // offered the ids it decides; an extra mark is left out by the application, not a refused report). Default: schema.
  accept?: AnswerSchema;
  attemptDir?: string; // codex: report file attemptDir/report-<uuid>.json, must not exist yet
  expectSessionId?: string | null;
  limits: TurnLimits;
  supervisor?: SupervisorTimings;
  // Stage 12: a bidirectional protocol (codex app-server JSON-RPC, claude stream-json input with the host control
  // protocol). `task` is unused: the driver writes the opening messages and keeps stdin open until it ends it. `env`
  // is the CLI's whole environment (NODE_* included; only SUP_* and ELECTRON_RUN_AS_NODE are refused).
  session?: SessionDriver;
}

export interface SessionIO {
  send(message: unknown): void; // one JSON line on the CLI's stdin
  end(): void; // EOF on the CLI's stdin
  hold(on: boolean): void; // the turn's deadline stops while a person is asked (a permission, a question)
}

export interface SessionDriver {
  rpc: boolean; // JSON-RPC lines (typed by method) instead of `type` lines
  terminal(f: EventFrame): "ok" | "fail" | null;
  sessionId(f: EventFrame): string | null;
  start(io: SessionIO): void;
  frame(f: EventFrame): void; // every event frame, in order; a throw ends the turn as a protocol error
  answer(): unknown; // the structured answer after a successful terminal event (undefined: none)
  interrupt?(): void; // asked before the supervisor's signals on a stop
}

export type TurnOutcome =
  | "completed"
  | "invalid_report"
  | "delivery_failed"
  | "failed"
  | "stopped"
  | "timeout"
  | "protocol_error"
  | "cleanup_unverified"
  | "harness_error";

export type FrameErrorCode =
  | "oversized"
  | "invalid_utf8"
  | "invalid_json"
  | "not_object"
  | "missing_type"
  | "unterminated_tail"
  | "stream_limit";

export type EventFrame = { kind: "event"; type: string; value: Record<string, unknown>; bytes: number };
export type ErrorFrame = { kind: "error"; code: FrameErrorCode; bytes: number; head: string };
export type Frame = EventFrame | ErrorFrame;

export type TransportStatus = "completed" | "failed" | "stopped" | "protocol_error";
export type StopCause = "user" | "timeout" | "stdout_held_open" | "protocol_error";
export type ReportStatus = "valid" | "invalid_json" | "schema_mismatch" | "missing" | "too_large" | "not_checked";
export type DeliveryStatus = "ok" | "failed" | "unconfirmed";

export interface TurnReport {
  status: ReportStatus;
  errors?: string[];
  value?: unknown;
}

export interface DeliveryError {
  where: "main" | "supervisor";
  code: string | undefined;
  at: number;
}

export interface TurnDelivery {
  status: DeliveryStatus; // ok = written to the CLI's stdin pipe and closed; NOT proof that the agent read it
  errors: DeliveryError[];
}

export interface TurnDiagnostic {
  at: number;
  what: string;
  [detail: string]: unknown;
}

// How each output stream ended, as the supervisor saw it (see supervisor.mjs): "eof" before any cleanup signal;
// "held_until_cleanup" a group member held it until the group was signalled; "held_abandoned" held outside the group,
// cut after a bounded wait; "held_after_supervisor_exit" main gave up on it after the supervisor exited (a harness
// failure); "relay_failed" the supervisor could not pass the bytes on; "unknown" no supervisor fact.
export type StreamEnd = "eof" | "held_until_cleanup" | "held_abandoned" | "held_capped" | "relay_failed" | "held_after_supervisor_exit" | "unknown";

// The step that decided the outcome, first match in decideOutcome's order ("ok" = completed).
export type TurnEndingStep =
  | "ok" | "harness" | "supervisor_error" | "delivery" | "timeout" | "stop"
  | "protocol_parse" | "multiple_terminal_events" | "events_after_terminal" | "no_terminal_event"
  // held by a member of the CLI's group until the cleanup / by a process outside the group (no cleanup reached it)
  | "stream_held_until_cleanup" | "stream_held_abandoned"
  // written to past the supervisor's read cap after the CLI's exit, no group signal: the writer is not known
  | "stream_held_capped"
  // the application's own output transfer failed (outcome harness_error), not the CLI
  | "relay_failed" | "relay_incomplete" | "held_after_supervisor_exit" | "stream_unknown"
  | "terminal_failure" | "protocol_stop" | "exit_code" | "session_mismatch" | "invalid_report" | "cleanup_failed";

// Compact, safe diagnosis of how a turn ended: enums, signal names, frame error codes and integers only
// (no stream content, no env, no paths, no free text).
export interface TurnEnding {
  step: TurnEndingStep;
  streams: { stdout: StreamEnd; stderr: StreamEnd };
  ms: {
    terminalToLeaderExit: number | null; // main's clock: terminal event read -> leader_exit status read
    leaderExitToStdoutEof: number | null; // the supervisor's clock, as the rest below
    leaderExitToStderrEof: number | null;
    leaderExitToDone: number | null;
  };
  signals: { leader: string[]; group: string[] };
  framing: { count: number; codes: FrameErrorCode[] };
  // cappedStreams: streams still written to after the leader's exit past the supervisor's read cap (0..2)
  counts: { frames: number; stdoutBytes: number; stderrBytes: number; cappedStreams: number };
}

export interface TurnResult {
  outcome: TurnOutcome;
  transport: { status: TransportStatus; reason: string | null };
  report: TurnReport;
  delivery: TurnDelivery;
  sessionId: string | null;
  sessionEvent: Record<string, unknown> | null; // the event that gave sessionId, kept whatever the history limits
  sessionMismatch: boolean;
  stopCause: StopCause | null;
  nextTurnAllowed: boolean; // outcome === "completed"
  process: {
    exitCode: number | null;
    signal: string | null;
    stdoutEnded: boolean;
    signalsToLeader: string[];
    groupCleared: boolean;
    supervisorExitCode: number | null;
    supervisorDone: boolean;
  };
  counters: {
    stdoutBytes: number;
    frames: number;
    keptEvents: number;
    droppedEvents: number;
    droppedEventBytes: number;
    stderrBytes: number;
    stderrDroppedBytes: number;
    droppedDiagnostics: number;
  };
  history: Frame[];
  terminal: { type: string; index: number; at: number } | null;
  errors: Frame[];
  stderr: { head: string; tail: string; bytes: number; droppedBytes: number };
  diagnostics: TurnDiagnostic[];
  timeline: { at: number; ev: string }[];
  pids: { supervisor: number | null; pgid: number | null };
  reportFile: string | null;
  ending?: TurnEnding; // always set by startTurn; absent only where no turn ran (agents.ts failedTurnResult)
}
