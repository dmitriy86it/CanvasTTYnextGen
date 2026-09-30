// OrchestrationStore (docs/agent-orchestration/implementation/stage-2-contract.md): run directories, writer lock,
// the append-only journal writer, content-addressed texts, lock-free reading and deletion.
// Main-process module; the storage root is a parameter. It starts no processes and does not import electron.
import { randomUUID } from "node:crypto";
import { constants as fsc } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  JournalError,
  MAX_JOURNAL_BYTES,
  MAX_LINE_BYTES,
  MAX_TEXT_BYTES,
  TERMINAL_STATUSES,
  ZERO_HASH,
  applyRecord,
  buildRecord,
  canonical,
  isTextRef,
  isUuid,
  isValidEventData,
  markInterruptedChecks,
  markInterruptedOperations,
  STAGE13_EVENTS,
  needsRecovery,
  newerVersion,
  parseJournal,
  sha256Hex,
  unfinishedWork
} from "./journal.ts";
import type { Stage13Event } from "./journal.ts";
import type {
  CheckAssessedData, CheckStatus, ClarificationAddedData, CommandResult, EventType, JournalIntegrity, LimitsChangedData, NotVerifiedReason,
  OrchTurnData, PausedReason, PlanRecordedData, QuestionAnsweredData, QuestionAskedData, RecoveryDecidedData, ReportStoreError,
  ReviewRecordedData, RunState, RunStatus, StageAcceptedData, TextRef, WorkspaceFailedRestore, WorkspaceRestore, WorkspaceSnapshot
} from "./journal.ts";
export type {
  CheckAssessedData, ClarificationAddedData, LimitKind, LimitsChangedData, OrchState, OrchTurnData, PlanRecordedData, QuestionAnsweredData,
  QuestionAskedData, RecoveryAction, RecoveryDecidedData, ReviewRecordedData, ReviewVerdict, StageAcceptedData, TurnPurpose
} from "./journal.ts";
import type { ProviderTurnResult } from "./providers.ts";

export type StoreErrorCode =
  | "invalid_run_id"
  | "invalid_input"
  | "run_exists"
  | "run_not_found"
  | "writer_locked"
  | "writer_closed"
  | "write_failed"
  | "writer_poisoned"
  | "journal_corrupt"
  | "journal_torn_tail"
  | "journal_newer_version"
  | "run_newer_version"
  | "text_missing"
  | "text_corrupt"
  | "text_too_large"
  | "report_not_stored";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly detail: unknown;

  constructor(code: StoreErrorCode, message: string, detail?: unknown, cause?: unknown) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = "StoreError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

// Test-only fault injection for the journal append path. write is called once per line and must return
// the FileHandle.write result ({bytesWritten}) or a byte count; anything short of the full line poisons the writer.
export interface StoreIo {
  write?(fh: FileHandle, buf: Buffer): Promise<unknown>;
  sync?(fh: FileHandle): Promise<void>;
}

export interface RunReadResult {
  state: RunState | null;
  integrity: JournalIntegrity;
  canContinue: boolean;
}

export type CommandCheck =
  | { status: "new" }
  | { status: "duplicate_completed"; result: CommandResult }
  | { status: "duplicate_in_progress" }
  | { status: "command_id_reused" };

export interface TurnIntentInput {
  turnId: string;
  commandId: string | null;
  role: "lead" | "executor";
  provider: "codex" | "claude";
  mode: string;
  sessionId: string | null;
  task: string;
}

export interface RunWriter {
  readonly runId: string;
  readonly staleLock: unknown; // the dead owner's lock generation this writer succeeded, else null
  state(): RunState;
  putText(content: string | Uint8Array): Promise<TextRef>;
  recordCommand(commandId: string, kind: string, payload: unknown): Promise<CommandCheck>;
  completeCommand(commandId: string, result: CommandResult): Promise<void>;
  recordTurnIntent(input: TurnIntentInput): Promise<void>;
  recordTurnResult(turnId: string, result: ProviderTurnResult): Promise<void>;
  setRunStatus(status: RunStatus, reason: PausedReason | null): Promise<void>;
  // Workspace facts (stage-3-contract.md). Called only after the Git result (ref) is confirmed.
  recordWorkspaceCreated(data: { sourcePathSha256: string; baseline: { commit: string; tree: string }; head: string | null }): Promise<void>;
  recordSnapshot(data: WorkspaceSnapshot): Promise<void>;
  recordCheckpoint(data: { stage: number; commit: string; tree: string; parent: string }): Promise<void>;
  recordRestoreStarted(data: WorkspaceRestore): Promise<void>;
  recordRestoreFailed(data: WorkspaceFailedRestore): Promise<void>;
  recordRestored(data: WorkspaceRestore): Promise<void>;
  recordCheckStarted(data: CheckStartedInput): Promise<void>;
  recordCheckFinished(data: CheckFinishedInput): Promise<void>;
  // Orchestration decisions (stage-5-contract.md §8); texts are TextRefs the caller got from putText.
  recordOrchTurn(data: OrchTurnData): Promise<void>;
  recordPlan(data: PlanRecordedData): Promise<void>;
  recordReview(data: ReviewRecordedData): Promise<void>;
  recordQuestion(data: QuestionAskedData): Promise<void>;
  recordAnswer(data: QuestionAnsweredData): Promise<void>;
  recordCheckAssessed(data: CheckAssessedData): Promise<void>;
  recordStageAccepted(data: StageAcceptedData): Promise<void>;
  recordClarification(data: ClarificationAddedData): Promise<void>;
  recordLimitsChanged(data: LimitsChangedData): Promise<void>;
  recordRecoveryDecision(data: RecoveryDecidedData): Promise<void>;
  // Stage 13 events (journal.ts schemas): preparation, failure classes, grants, actions after success.
  recordEvent(type: Stage13Event, data: Record<string, unknown>): Promise<void>;
  // Called with the new lastSeq after each record is durable (stage-7-contract.md: the position subscribers follow).
  onAppend(listener: (seq: number) => void): () => void;
  close(): Promise<void>;
}

// What the runner knows before it starts a process, and what it knows after (stage-4-contract.md §7).
export interface CheckStartedInput {
  checkRunId: string; checkId: string; commandSha256: string;
  base: { commit: string; tree: string }; treeBefore: string; profileSha256: string;
}
export interface CheckFinishedInput {
  checkRunId: string; status: CheckStatus; reason: NotVerifiedReason | null;
  exitCode: number | null; signal: string | null; groupCleared: boolean;
  treeAfter: string | null; output: TextRef | null; outputDropped: number;
  evidenceFingerprint: string; durationMs: number;
}

export interface CreateRunOptions { goal: string; clock?: () => Date; io?: StoreIo }
export interface OpenRunOptions { acceptTornTail?: boolean; clock?: () => Date; io?: StoreIo; hooks?: LockHooks }

const JOURNAL = "journal.jsonl";
const LOCKS = "locks";
const TEXTS = "texts";
const QUARANTINE = "quarantine";
const MAX_CONTRACT_ERRORS = 16;
const MAX_CONTRACT_ERROR_CHARS = 256;
const INTENT_KEYS = new Set(["turnId", "commandId", "role", "provider", "mode", "sessionId", "task"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
// Copies the listed fields (TextRefs as {sha256, bytes}); an absent field stays undefined and fails the schema.
function pick(data: object, keys: readonly string[]): Record<string, unknown> {
  const src = (isRecord(data) ? data : {}) as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => {
    const v = src[k];
    return [k, isRecord(v) && Object.hasOwn(v, "sha256") ? { sha256: v.sha256, bytes: v.bytes } : v];
  }));
}
const fail = (code: StoreErrorCode, message: string, detail?: unknown): never => { throw new StoreError(code, message, detail); };

function runPath(root: string, runId: string): string {
  if (typeof root !== "string" || !isAbsolute(root)) fail("invalid_input", "root must be an absolute path");
  if (!isUuid(runId)) fail("invalid_run_id", "runId must be a lowercase UUID");
  return join(root, "runs", runId);
}

async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return; // directories cannot be opened for fsync there
  const fh = await open(dir, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeDurable(path: string, data: Uint8Array | string, flag = "wx"): Promise<void> {
  const fh = await open(path, flag, 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeFully(fh: FileHandle, buf: Buffer): Promise<{ bytesWritten: number }> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    if (bytesWritten <= 0) break;
    off += bytesWritten;
  }
  return { bytesWritten: off };
}

// Missing journal -> run_not_found. A journal over the limit is not read, only its first line's worth ({ head }): enough
// to tell a newer version's journal (acceptance-review-spec.md §2.2).
async function readJournal(path: string): Promise<Buffer | { head: Buffer }> {
  let fh: FileHandle;
  try {
    fh = await open(path, "r");
  } catch (error) {
    if (errCode(error) === "ENOENT" || errCode(error) === "ENOTDIR") fail("run_not_found", "no journal for this run");
    throw error;
  }
  try {
    const head = async () => {
      const b = Buffer.alloc(MAX_LINE_BYTES + 1);
      return { head: b.subarray(0, (await fh.read(b, 0, b.length, 0)).bytesRead) };
    };
    if ((await fh.stat()).size > MAX_JOURNAL_BYTES) return head();
    const buf = await fh.readFile();
    return buf.length > MAX_JOURNAL_BYTES ? head() : buf;
  } finally {
    await fh.close();
  }
}

const TOO_LARGE_DETAIL = { line: 1, offset: 0, code: "journal_too_large" as const };

// ---------- writer lock ----------

// Generation lock (stage-2-contract.md, "Исправления по ревью Р2"). Every claim creates locks/writer-<N>.json
// exclusively (link() of a complete, fsynced temp file) and generation files are never deleted while the run exists,
// so each N is created at most once: among everyone who saw generation N, exactly one wins the create of N+1.
// The holder is the owner of the highest generation until it marks it released or its pid is gone (ESRCH).
// A claimer that loses the create gets writer_locked and deletes or rewrites nothing.

interface LockInfo { pid: number; token: string; createdAt: string; released: boolean }
export interface LockHooks { beforeLockClaim?(): Promise<void> } // tests only: a barrier between decision and claim

const GEN_FILE = /^writer-(\d{12})\.json$/;
const genPath = (locks: string, gen: number) => join(locks, `writer-${String(gen).padStart(12, "0")}.json`);

// Run directories that have a writer (or a deletion) in this process: a second one never reaches the file lock.
const openWriters = new Set<string>();

async function readLock(path: string): Promise<LockInfo | null> {
  try {
    const v: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(v) && Number.isSafeInteger(v.pid) && (v.pid as number) > 0 && typeof v.token === "string"
      && typeof v.released === "boolean") return v as unknown as LockInfo;
  } catch { /* missing or unreadable: not provably free */ }
  return null;
}

function ownerAlive(pid: number): boolean {
  if (pid === process.pid) return true; // this process: an unclosed writer, never stale
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errCode(error) !== "ESRCH"; // EPERM: alive, not ours
  }
}

async function highestGeneration(locks: string): Promise<number> {
  let top = 0;
  for (const name of await readdir(locks)) {
    const m = GEN_FILE.exec(name);
    if (m) top = Math.max(top, Number(m[1]));
  }
  return top;
}

async function acquireLock(dir: string, hooks?: LockHooks): Promise<{ token: string; gen: number; stale: LockInfo | null }> {
  if (openWriters.has(dir)) fail("writer_locked", "a writer for this run is open in this process");
  openWriters.add(dir);
  try {
    const locks = join(dir, LOCKS);
    await mkdir(locks, { mode: 0o700 }).catch((error) => { if (errCode(error) !== "EEXIST") throw error; });
    const top = await highestGeneration(locks);
    let stale: LockInfo | null = null;
    if (top > 0) {
      const held = await readLock(genPath(locks, top));
      if (held === null) return fail("writer_locked", `lock generation ${top} is unreadable; the owner is not known to be gone`);
      if (!held.released) {
        if (ownerAlive(held.pid)) fail("writer_locked", "the run has a live writer", held);
        stale = held;
      }
    }
    const gen = top + 1;
    await hooks?.beforeLockClaim?.();
    const token = randomUUID();
    const tmp = join(locks, `.tmp-${token}`);
    try {
      await writeDurable(tmp, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString(), released: false }));
      await link(tmp, genPath(locks, gen)).catch((error) => {
        if (errCode(error) === "EEXIST") fail("writer_locked", `lock generation ${gen} was claimed by another writer first`);
        throw error;
      });
    } finally {
      await unlink(tmp).catch(() => {});
    }
    await fsyncDir(locks);
    return { token, gen, stale };
  } catch (error) {
    openWriters.delete(dir);
    if (errCode(error) === "ENOENT") fail("run_not_found", "run directory is missing");
    throw error;
  }
}

// Marks our own generation released; a generation that is not ours (token mismatch) is left alone.
async function releaseLock(dir: string, token: string, gen: number): Promise<void> {
  try {
    const locks = join(dir, LOCKS);
    const path = genPath(locks, gen);
    const held = await readLock(path);
    if (held?.token !== token) return;
    const tmp = join(locks, `.tmp-${randomUUID()}`);
    await writeDurable(tmp, JSON.stringify({ ...held, released: true }));
    await rename(tmp, path);
    await fsyncDir(locks);
  } finally {
    openWriters.delete(dir);
  }
}

// ---------- texts ----------

async function readTextFile(path: string, ref: TextRef): Promise<Buffer> {
  let fh: FileHandle;
  try {
    fh = await open(path, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (errCode(error) === "ENOENT") fail("text_missing", `text ${ref.sha256} is missing`);
    if (errCode(error) === "ELOOP" || errCode(error) === "EMLINK") fail("text_corrupt", `text ${ref.sha256} is a symlink`);
    throw error;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size !== ref.bytes) fail("text_corrupt", `text ${ref.sha256} has the wrong size`);
    const buf = await fh.readFile();
    if (buf.length !== ref.bytes || sha256Hex(buf) !== ref.sha256) fail("text_corrupt", `text ${ref.sha256} does not match its hash`);
    return buf;
  } finally {
    await fh.close();
  }
}

export async function readText(root: string, runId: string, ref: TextRef): Promise<Buffer> {
  const dir = runPath(root, runId);
  if (!isTextRef(ref)) fail("invalid_input", "ref must be {sha256, bytes}");
  return readTextFile(join(dir, TEXTS, ref.sha256), ref);
}

// ---------- writer ----------

const clip = (s: string) => {
  let t = s.slice(0, MAX_CONTRACT_ERROR_CHARS);
  if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1); // do not end on half a surrogate pair
  return t;
};

function isProviderTurnResult(r: unknown): r is ProviderTurnResult {
  return isRecord(r) && isRecord(r.contract) && isRecord(r.report) && isRecord(r.transport) && isRecord(r.transport.process);
}

interface WriterInit {
  runId: string;
  dir: string;
  fh: FileHandle;
  lock: { token: string; gen: number };
  staleLock: LockInfo | null;
  state: RunState | null;
  size: number;
  clock?: () => Date;
  io?: StoreIo;
}

class Writer implements RunWriter {
  readonly runId: string;
  readonly staleLock: unknown;
  private readonly dir: string;
  private readonly fh: FileHandle;
  private readonly lock: { token: string; gen: number };
  private readonly clock: () => Date;
  private readonly io: StoreIo;
  private current: RunState | null; // null only inside createRun, before run.created
  private size: number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(seq: number) => void>();
  private poisoned = false;
  private closing: Promise<void> | null = null;

  constructor(init: WriterInit) {
    this.runId = init.runId;
    this.dir = init.dir;
    this.fh = init.fh;
    this.lock = init.lock;
    this.staleLock = init.staleLock;
    this.current = init.state;
    this.size = init.size;
    this.clock = init.clock ?? (() => new Date());
    this.io = init.io ?? {};
  }

  state(): RunState {
    if (this.current === null) return fail("writer_closed", "the run was not created");
    return structuredClone(this.current);
  }

  // Applied once by openRun: a check whose result never reached the journal is interrupted from now on.
  markInterrupted(): void {
    if (this.current) { markInterruptedChecks(this.current); markInterruptedOperations(this.current); }
  }

  // Serializes journal work; seq and every state-dependent check are decided when the item leaves the queue.
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new StoreError("writer_closed", "the writer is closed"));
    const run = this.queue.then(() => {
      if (this.poisoned) fail("writer_poisoned", "an earlier write failed; close and reopen the run");
      return fn();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private checkUsable(): void {
    if (this.closing) fail("writer_closed", "the writer is closed");
    if (this.poisoned) fail("writer_poisoned", "an earlier write failed; close and reopen the run");
  }

  // Inside the queue only. The record is replayed on a copy first, so the writer never writes what replay rejects;
  // state advances only after the full line is written and fsynced.
  private async appendNow(type: EventType, data: Record<string, unknown>): Promise<void> {
    if (!isValidEventData(type, data)) fail("invalid_input", `${type} data does not match the schema`);
    const cur = this.current;
    const { record, line } = buildRecord(cur ? { seq: cur.lastSeq, hash: cur.lastHash } : null, this.runId,
      this.clock().toISOString(), type, data);
    if (line.length - 1 > MAX_LINE_BYTES) fail("invalid_input", `${type} record is over ${MAX_LINE_BYTES} bytes`);
    if (this.size + line.length > MAX_JOURNAL_BYTES) fail("invalid_input", "the journal is full");
    let next: RunState;
    try {
      next = applyRecord(cur ? structuredClone(cur) : null, record);
    } catch (error) {
      if (error instanceof JournalError) return fail("invalid_input", error.message, { code: error.code });
      throw error;
    }
    try {
      const written = await (this.io.write ?? writeFully)(this.fh, line);
      const n = typeof written === "number" ? written : isRecord(written) ? written.bytesWritten : undefined;
      if (n !== line.length) throw new Error(`short write: ${String(n)} of ${line.length} bytes`);
      await (this.io.sync ? this.io.sync(this.fh) : this.fh.sync());
    } catch (error) {
      this.poisoned = true;
      throw new StoreError("write_failed", `appending ${type} failed; the journal state is unknown`, null, error);
    }
    this.current = next;
    this.size += line.length;
    for (const l of [...this.listeners]) {
      try { l(next.lastSeq); } catch { /* a listener never breaks the journal */ }
    }
  }

  onAppend(listener: (seq: number) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  append(type: EventType, data: Record<string, unknown>): Promise<void> {
    return this.enqueue(() => this.appendNow(type, data));
  }

  async putText(content: string | Uint8Array): Promise<TextRef> {
    this.checkUsable();
    if (typeof content !== "string" && !(content instanceof Uint8Array)) fail("invalid_input", "text must be a string or bytes");
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    if (buf.length > MAX_TEXT_BYTES) fail("text_too_large", `text of ${buf.length} bytes is over ${MAX_TEXT_BYTES}`);
    const ref = { sha256: sha256Hex(buf), bytes: buf.length };
    const texts = join(this.dir, TEXTS);
    const target = join(texts, ref.sha256);
    const existing = await readTextFile(target, ref).then(() => true, (error) => {
      if (error instanceof StoreError) return false; // missing, or damaged: replaced below
      throw error;
    });
    if (!existing) {
      const tmp = join(texts, `.tmp-${randomUUID()}`);
      try {
        await writeDurable(tmp, buf);
        await rename(tmp, target);
      } catch (error) {
        await unlink(tmp).catch(() => {});
        throw error;
      }
    }
    await fsyncDir(texts);
    return ref;
  }

  async recordCommand(commandId: string, kind: string, payload: unknown): Promise<CommandCheck> {
    if (!isUuid(commandId)) fail("invalid_input", "commandId must be a lowercase UUID");
    // Checked before the duplicate lookup: a bad kind is refused, never matched against a stored command.
    if (typeof kind !== "string" || kind.length === 0 || kind.length > 64) fail("invalid_input", "kind must be a string of 1..64 characters");
    let payloadHash: string;
    try {
      payloadHash = sha256Hex(canonical(payload));
    } catch (error) {
      return fail("invalid_input", `payload is not canonical JSON: ${(error as Error).message}`);
    }
    return this.enqueue(async (): Promise<CommandCheck> => {
      const cmd = this.current?.commands[commandId];
      if (cmd) {
        if (cmd.kind !== kind || cmd.payloadHash !== payloadHash) return { status: "command_id_reused" };
        if (cmd.status === "completed" && cmd.result) return { status: "duplicate_completed", result: { ...cmd.result } };
        return { status: "duplicate_in_progress" };
      }
      await this.appendNow("command.received", { commandId, kind, payloadHash });
      return { status: "new" };
    });
  }

  completeCommand(commandId: string, result: CommandResult): Promise<void> {
    return this.append("command.completed", { commandId, result });
  }

  async recordTurnIntent(input: TurnIntentInput): Promise<void> {
    if (!isRecord(input) || Object.keys(input).some((k) => !INTENT_KEYS.has(k)) || typeof input.task !== "string") {
      fail("invalid_input", "turn intent must be {turnId, commandId, role, provider, mode, sessionId, task: string}");
    }
    const fields = {
      turnId: input.turnId, commandId: input.commandId ?? null, role: input.role, provider: input.provider,
      mode: input.mode, sessionId: input.sessionId ?? null
    };
    // Check the shape before writing the task text, so bad input leaves no file behind.
    if (!isValidEventData("turn.intent", { ...fields, task: { sha256: ZERO_HASH, bytes: 0 } })) {
      fail("invalid_input", "turn.intent data does not match the schema");
    }
    const task = await this.putText(input.task);
    await this.append("turn.intent", { ...fields, task });
  }

  // Only the normalized, bounded facts are kept: no env, argv, stderr, CLI event history, diagnostics or model text.
  // The outcome is result.outcome, never transport.outcome. The structured report goes to texts/ as canonical JSON.
  // A report that cannot be stored is never truncated or dropped silently: turn.finished keeps the provider's actual
  // outcome with nextTurnAllowed=false and report.storeError, and the call then rejects with report_not_stored.
  async recordTurnResult(turnId: string, result: ProviderTurnResult): Promise<void> {
    this.checkUsable();
    if (!isProviderTurnResult(result)) return fail("invalid_input", "recordTurnResult takes a ProviderTurnResult (contract + transport)");
    let ref: TextRef | null = null;
    let storeError: ReportStoreError | null = null;
    let storeCause: unknown = null;
    if (result.report.value !== undefined) {
      try {
        const json = Buffer.from(canonical(result.report.value), "utf8");
        if (json.length > MAX_TEXT_BYTES) storeError = "too_large";
        else ref = await this.putText(json);
      } catch (error) {
        storeError = "write_failed";
        storeCause = error;
      }
    }
    const errors = result.contract.errors;
    const t = result.transport;
    await this.append("turn.finished", {
      turnId,
      outcome: result.outcome,
      nextTurnAllowed: storeError === null && result.nextTurnAllowed,
      sessionId: result.sessionId,
      contract: {
        status: result.contract.status,
        errors: Array.isArray(errors) ? errors.slice(0, MAX_CONTRACT_ERRORS).map((e) => (typeof e === "string" ? clip(e) : e)) : errors
      },
      report: { status: result.report.status, ref, storeError },
      transport: { outcome: t.outcome, exitCode: t.process.exitCode, signal: t.process.signal, groupCleared: t.process.groupCleared }
    });
    if (storeError !== null) {
      throw new StoreError("report_not_stored",
        storeError === "too_large"
          ? `the report is over ${MAX_TEXT_BYTES} bytes of canonical JSON; turn.finished records outcome ${result.outcome} without it and forbids the next turn`
          : `the report could not be written; turn.finished records outcome ${result.outcome} without it and forbids the next turn`,
        { storeError, outcome: result.outcome }, storeCause);
    }
  }

  setRunStatus(status: RunStatus, reason: PausedReason | null): Promise<void> {
    return this.append("run.status", { status, reason: reason ?? null });
  }

  // Copies only the contract fields, so extra properties are dropped here and the schema checks the rest.
  recordWorkspaceCreated(data: { sourcePathSha256: string; baseline: { commit: string; tree: string }; head: string | null }): Promise<void> {
    return this.append("workspace.created", {
      sourcePathSha256: data?.sourcePathSha256, baseline: { commit: data?.baseline?.commit, tree: data?.baseline?.tree }, head: data?.head
    });
  }

  recordSnapshot(data: WorkspaceSnapshot): Promise<void> {
    return this.append("snapshot.created", { kind: data?.kind, ref: data?.ref, commit: data?.commit, tree: data?.tree });
  }

  recordCheckpoint(data: { stage: number; commit: string; tree: string; parent: string }): Promise<void> {
    return this.append("checkpoint.created", { stage: data?.stage, commit: data?.commit, tree: data?.tree, parent: data?.parent });
  }

  recordRestoreStarted(data: WorkspaceRestore): Promise<void> {
    return this.append("workspace.restore_started", { target: data?.target, targetCommit: data?.targetCommit, recoveryCommit: data?.recoveryCommit });
  }

  // The copy is partially restored or its state is unknown: pendingRestore stays, no stage can be accepted from it.
  recordRestoreFailed(data: WorkspaceFailedRestore): Promise<void> {
    return this.append("workspace.restore_failed",
      { target: data?.target, targetCommit: data?.targetCommit, recoveryCommit: data?.recoveryCommit, result: data?.result });
  }

  recordRestored(data: WorkspaceRestore): Promise<void> {
    return this.append("workspace.restored", { target: data?.target, targetCommit: data?.targetCommit, recoveryCommit: data?.recoveryCommit });
  }

  // The intent is stored before any process starts; the result only after it is known.
  recordCheckStarted(data: CheckStartedInput): Promise<void> {
    return this.append("check.started", {
      checkRunId: data?.checkRunId, checkId: data?.checkId, commandSha256: data?.commandSha256,
      base: data?.base === undefined ? undefined : { commit: data.base?.commit, tree: data.base?.tree },
      treeBefore: data?.treeBefore, profileSha256: data?.profileSha256
    });
  }

  recordCheckFinished(data: CheckFinishedInput): Promise<void> {
    return this.append("check.finished", {
      checkRunId: data?.checkRunId, status: data?.status, reason: data?.reason ?? null,
      exitCode: data?.exitCode ?? null, signal: data?.signal ?? null, groupCleared: data?.groupCleared,
      treeAfter: data?.treeAfter ?? null, output: data?.output ?? null, outputDropped: data?.outputDropped,
      evidenceFingerprint: data?.evidenceFingerprint, durationMs: data?.durationMs
    });
  }

  // Orchestration events: only the contract fields are copied (a missing one fails the schema), like the ones above.
  recordOrchTurn(data: OrchTurnData): Promise<void> {
    return this.append("orch.turn", pick(data, ["turnId", "purpose", "stage", "round", "planVersion", "clarificationVersion"]));
  }

  recordPlan(data: PlanRecordedData): Promise<void> {
    return this.append("plan.recorded", pick(data, ["turnId", "version", "plan", "firstStage", "stageCount"]));
  }

  recordReview(data: ReviewRecordedData): Promise<void> {
    return this.append("review.recorded",
      pick(data, ["turnId", "stage", "verdict", "findings", "findingsKey", "findingsCount", "clarificationVersion", "runKey"]));
  }

  recordQuestion(data: QuestionAskedData): Promise<void> {
    return this.append("question.asked", pick(data, ["questionId", "turnId", "text"]));
  }

  recordAnswer(data: QuestionAnsweredData): Promise<void> {
    return this.append("question.answered", pick(data, ["questionId", "commandId", "text"]));
  }

  recordCheckAssessed(data: CheckAssessedData): Promise<void> {
    return this.append("check.assessed", pick(data, ["checkRunId", "stage", "round", "checkKey", "runKey"]));
  }

  recordStageAccepted(data: StageAcceptedData): Promise<void> {
    return this.append("stage.accepted", pick(data, ["stage", "reviewTurnId", "tree"]));
  }

  recordClarification(data: ClarificationAddedData): Promise<void> {
    return this.append("clarification.added", pick(data, ["version", "commandId", "text"]));
  }

  recordLimitsChanged(data: LimitsChangedData): Promise<void> {
    return this.append("limits.changed", pick(data, ["commandId", "kind", "value"]));
  }

  recordRecoveryDecision(data: RecoveryDecidedData): Promise<void> {
    return this.append("recovery.decided", pick(data, ["commandId", "action", "turnId"]));
  }

  recordEvent(type: Stage13Event, data: Record<string, unknown>): Promise<void> {
    if (!STAGE13_EVENTS.includes(type)) return Promise.reject(new StoreError("invalid_input", `${String(type)} is not a stage 13 event`));
    return this.append(type, data);
  }

  // Idempotent. Waits for queued appends, then marks our lock generation released if it is still ours.
  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.queue;
      try {
        await this.fh.close();
      } finally {
        await releaseLock(this.dir, this.lock.token, this.lock.gen);
      }
    })();
    return this.closing;
  }
}

// ---------- run operations ----------

export async function createRun(root: string, runId: string, options: CreateRunOptions): Promise<RunWriter> {
  const dir = runPath(root, runId);
  if (!isRecord(options) || typeof options.goal !== "string") return fail("invalid_input", "goal must be a string");
  if (Buffer.byteLength(options.goal, "utf8") > MAX_TEXT_BYTES) fail("text_too_large", `goal is over ${MAX_TEXT_BYTES} bytes`);
  const runs = join(root, "runs");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (errCode(error) === "EEXIST") fail("run_exists", `run ${runId} already exists`);
    throw error;
  }
  let lock: { token: string; gen: number } | null = null;
  let writer: Writer | null = null;
  try {
    await mkdir(join(dir, TEXTS), { mode: 0o700 });
    await fsyncDir(runs);
    lock = await acquireLock(dir);
    const fh = await open(join(dir, JOURNAL), fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | fsc.O_EXCL, 0o600);
    writer = new Writer({ runId, dir, fh, lock, staleLock: null, state: null, size: 0, clock: options.clock, io: options.io });
    await fsyncDir(dir);
    const goal = await writer.putText(options.goal);
    await writer.append("run.created", { goal });
    return writer;
  } catch (error) {
    // The directory is ours (exclusive mkdir) and holds nothing confirmed: remove it rather than leave a broken run.
    if (writer) await writer.close().catch(() => {});
    else if (lock) await releaseLock(dir, lock.token, lock.gen).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function openRun(root: string, runId: string, options: OpenRunOptions = {}): Promise<RunWriter> {
  const dir = runPath(root, runId);
  const journalPath = join(dir, JOURNAL);
  await stat(journalPath).catch((error) => {
    if (errCode(error) === "ENOENT" || errCode(error) === "ENOTDIR") fail("run_not_found", `run ${runId} not found`);
    throw error;
  });
  // A newer version's journal is refused before the lock: nothing in its directory is created, repaired or written
  // (acceptance-review-spec.md §2.2).
  refuseNewer(await readJournal(journalPath));
  const lock = await acquireLock(dir, options.hooks);
  let writer: Writer;
  let torn: { offset: number; bytes: number; sha256: string; quarantine: string } | null = null;
  let fh: FileHandle | null = null;
  try {
    const buf = await readJournal(journalPath);
    if (!Buffer.isBuffer(buf)) return fail("journal_corrupt", "the journal is over the size limit", TOO_LARGE_DETAIL);
    refuseNewer(buf);
    const parsed = parseJournal(buf, runId);
    const integrity = parsed.integrity;
    if (integrity.status === "corrupt") fail("journal_corrupt", `line ${integrity.detail.line}: ${integrity.detail.code}`, integrity.detail);
    if (integrity.status === "torn_tail" && !options.acceptTornTail) {
      fail("journal_torn_tail", "the journal ends with a torn record; reopen with acceptTornTail", integrity.detail);
    }
    fh = await open(journalPath, fsc.O_WRONLY | fsc.O_APPEND);
    if (integrity.status === "torn_tail") {
      const tail = buf.subarray(integrity.detail.offset);
      const sha256 = sha256Hex(tail);
      const quarantine = `torn-${integrity.detail.offset}-${sha256}.bin`;
      const qdir = join(dir, QUARANTINE);
      await mkdir(qdir, { recursive: true, mode: 0o700 });
      await writeDurable(join(qdir, quarantine), tail, "w"); // same name = same bytes, so overwriting is harmless
      await fsyncDir(qdir);
      await fsyncDir(dir);
      await fh.truncate(integrity.detail.offset);
      await fh.sync();
      torn = { offset: integrity.detail.offset, bytes: tail.length, sha256, quarantine };
    }
    writer = new Writer({
      runId, dir, fh, lock, staleLock: lock.stale, state: parsed.state, size: parsed.validBytes,
      clock: options.clock, io: options.io
    });
  } catch (error) {
    await fh?.close().catch(() => {});
    await releaseLock(dir, lock.token, lock.gen).catch(() => {});
    throw error;
  }
  try {
    if (torn) await writer.append("journal.tail_repaired", torn);
    // A check whose result never reached the journal stays not_verified(interrupted); it is never re-run.
    writer.markInterrupted();
    const state = writer.state();
    const pending = unfinishedWork(state);
    // Recovery only records what is unknown; it never re-runs a CLI or re-executes a command.
    if (needsRecovery(state)) {
      await writer.append("run.recovered", {
        unfinishedTurns: pending.turns, unfinishedCommands: pending.commands, previousStatus: state.status
      });
    }
  } catch (error) {
    await writer.close().catch(() => {});
    throw error;
  }
  return writer;
}

const refuseNewer = (buf: Buffer | { head: Buffer }): void => {
  const version = newerVersion(Buffer.isBuffer(buf) ? buf : buf.head);
  if (version !== null) fail("journal_newer_version", `the journal was written by version ${version}`, { version });
};

// Only reads: takes no lock and changes no file. A writer appending at the same moment can show up as torn_tail.
export async function readRun(root: string, runId: string): Promise<RunReadResult> {
  const dir = runPath(root, runId);
  const buf = await readJournal(join(dir, JOURNAL));
  if (!Buffer.isBuffer(buf)) {
    const version = newerVersion(buf.head);
    return { state: null, canContinue: false, integrity: version === null ? { status: "corrupt", detail: TOO_LARGE_DETAIL }
      : { status: "newer_version", detail: { version, chain: { status: "corrupt", detail: TOO_LARGE_DETAIL } } } };
  }
  const parsed = parseJournal(buf, runId);
  // a newer version's state is shown as journaled: what it still runs is not called interrupted here
  if (parsed.state && parsed.integrity.status !== "newer_version_compatible") { markInterruptedChecks(parsed.state); markInterruptedOperations(parsed.state); }
  return { state: parsed.state, integrity: parsed.integrity, canContinue: parsed.integrity.status === "ok" };
}

// Takes the writer lock (a live writer -> writer_locked), renames the directory out of the way atomically, then
// removes it. Provider transcripts (~/.codex, ~/.claude) are not ours and are never touched.
// ponytail: a crash after the rename leaves runs/.deleting-* behind; sweep them at startup if that ever matters.
export async function deleteRun(root: string, runId: string, options: { hooks?: LockHooks } = {}): Promise<void> {
  const dir = runPath(root, runId);
  await stat(dir).catch((error) => {
    if (errCode(error) === "ENOENT" || errCode(error) === "ENOTDIR") fail("run_not_found", `run ${runId} not found`);
    throw error;
  });
  // A newer version's run is never deleted here (acceptance-review-spec.md §2.2): recognized as openRun does, before the
  // lock, so its directory is not touched. A run without a readable journal is deleted as before.
  const head = await readJournal(join(dir, JOURNAL)).catch(() => null);
  const version = head === null ? null : newerVersion(Buffer.isBuffer(head) ? head : head.head);
  if (version !== null) fail("run_newer_version", `the run was created by version ${version}`, { version });
  const lock = await acquireLock(dir, options.hooks);
  const trash = join(root, "runs", `.deleting-${runId}-${randomUUID()}`);
  try {
    await rename(dir, trash);
  } catch (error) {
    await releaseLock(dir, lock.token, lock.gen).catch(() => {});
    throw error;
  }
  openWriters.delete(dir);
  await rm(trash, { recursive: true, force: true });
}
