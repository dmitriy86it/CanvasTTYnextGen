// startCheck(opts): one project check, run from the managed copy (stage 3) under the Seatbelt profile
// (stage 4 contract, docs/agent-orchestration/implementation/stage-4-contract.md) and the per-turn supervisor
// (src/orchestration/supervisor.mjs) without the JSONL protocol: fd1/fd2 are the check's own stdout/stderr.
//
// The supervisor runs INSIDE the sandbox (sandbox-exec -f <profile> -- node supervisor.mjs <executable> ...), so its
// SUP_SANDBOX_SWEEP scan sees exactly the processes of this check's sandbox instance — escapees included — and kills
// them before `done`. A result with no confirmed empty sandbox is never `passed` or `failed`.
//
// The runner owns only launch, stop, timeout, output limit, process accounting and the result. Workspace and
// dependency verification (stage 3), the sandbox profile, the evidence fingerprint and the journal are injected:
// checks.ts / sandbox.ts / store.ts stay their owners' files. There is no branch that runs a check without the
// sandbox: `sandboxExec` is a path, never a switch.
//
// Never `passed`: a stop, a timeout, a supervisor error, an unverified cleanup, a changed tree or dependencies,
// or a failed journal write.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { canonical, sha256Hex, type TextRef } from "./journal.ts";
import type { SandboxPaths as SandboxPathsFromProfile } from "./sandbox.ts";
import type { SupervisorLaunch, SupervisorTimings } from "./types.ts";
import type { Workspace } from "./workspace.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
// The whole environment of the checked process: names go into SUP_ENV_ALLOW, the supervisor passes nothing else.
export const CHECK_ENV_NAMES: readonly string[] =
  Object.freeze(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "CI"]);

const SUP_DEFAULTS = { graceIntMs: 5000, graceTermMs: 3000, leftoverMs: 2000 }; // mirrors supervisor.mjs
const SUP_KILL_WAIT_MS = 1000;
const SUP_STREAM_WAIT_MS = 1000; // mirrors supervisor.mjs STREAM_WAIT_MS
const GUARD_MARGIN_MS = 5000;
const DEFAULT_OUTPUT_GRACE_MS = 2000; // stdout/stderr held open by an escapee after the supervisor is gone
const SUP_SWEEP_MS = 3000; // mirrors supervisor.mjs SUP_SWEEP_MS
const SWEEP_SCANS_MS = 2000; // scans that end past the sweep deadline (~200 ms each), with room
const MAX_STATUS_LINE = 64 * 1024;

export type CheckStatus = "passed" | "failed" | "not_verified";
export type NotVerifiedReason =
  | "sandbox_unavailable" | "spawn_failed" | "timeout" | "stopped" | "output_limit"
  | "cleanup_unverified" | "deps_changed" | "tree_changed" | "workspace_unverified"
  | "restore_incomplete" | "interrupted" | "store_failed";
export type StopCause = "user" | "timeout" | "output_limit";

// §1: the command comes from the trusted registry only; from an agent's answer nothing but `id`.
export interface CheckCommand {
  id: string;
  title: string;
  executable: string;
  argv: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface CheckRegistry { commands: readonly CheckCommand[] }
export interface PreparedDeps { lockfileRelPath: string; lockfileSha256: string; nodeModulesPath: string }

export type SelftestResult = { passed: boolean; checks: number; failed: readonly { name: string; detail?: string }[] };
// Owned by sandbox.ts; the runner creates the directories and passes them through.
// The paths the profile is built from live in sandbox.ts; a type-only import keeps this file free of a runtime
// dependency on it (the sandbox is always injected) while there is exactly one definition of the shape.
export type SandboxPaths = SandboxPathsFromProfile & { checkDir: string };
export interface SandboxApi {
  sandboxSupport(platform?: NodeJS.Platform): { supported: boolean; reason?: "sandbox_unavailable" };
  buildProfile(paths: SandboxPaths): { text: string; sha256: string };
  runSelftest(opts: { dir: string; ws: Workspace; launch: SupervisorLaunch; paths: SandboxPaths }): Promise<SelftestResult>;
}

// Stage 3 verification plus dependencies, done by the caller: verifyWorkspace, readIncompleteRestore, the lockfile
// hash, that `node_modules` is ignored in the copy (else deps_changed) and its node_modules link, snapshotCopyTree.
export type PreflightResult =
  | { ok: true; base: { commit: string; tree: string }; treeBefore: string }
  | { ok: false; reason: NotVerifiedReason; detail?: unknown };
export type PostflightResult =
  | { ok: true; treeAfter: string }
  | { ok: false; reason: NotVerifiedReason; treeAfter?: string | null; detail?: unknown };

export interface EvidenceFacts {
  checkRunId: string;
  command: CheckCommand;
  deps: PreparedDeps;
  copy: { treeBefore: string | null; treeAfter: string | null; base: { commit: string; tree: string } | null };
  sandbox: { profileSha256: string | null; selftest: SelftestResult | null };
  env: { names: readonly string[] }; // names only, never values
  result: {
    status: CheckStatus; reason: NotVerifiedReason | null;
    exitCode: number | null; signal: string | null; groupCleared: boolean; sandboxCleared: boolean;
  };
}

// The journal side (store.ts). RunWriter satisfies it once the coordinator adds the two check events.
export interface CheckWriter {
  putText(content: string | Uint8Array): Promise<TextRef>;
  recordCheckStarted(data: {
    checkRunId: string; checkId: string; commandSha256: string;
    base: { commit: string; tree: string }; treeBefore: string; profileSha256: string;
  }): Promise<void>;
  recordCheckFinished(data: {
    checkRunId: string; checkId: string; status: CheckStatus; reason: NotVerifiedReason | null;
    exitCode: number | null; signal: string | null; groupCleared: boolean;
    treeAfter: string | null; output: TextRef | null; outputDropped: number;
    evidenceFingerprint: string; durationMs: number;
  }): Promise<void>;
}

export interface StartCheckOptions {
  ws: Workspace;
  registry: CheckRegistry;
  id: string;
  deps: PreparedDeps;
  writer: CheckWriter;
  launch: SupervisorLaunch;
  resolveCheck: (registry: CheckRegistry, id: unknown) => CheckCommand; // checks.ts; throws unknown_check
  sandbox: SandboxApi;
  preflight: () => Promise<PreflightResult>;
  postflight: () => Promise<PostflightResult>;
  evidence: (facts: EvidenceFacts) => string | Promise<string>;
  clock?: () => number;
  sandboxExec?: string; // path to sandbox-exec; a test may point it at a stand-in, never at "no sandbox"
  outputGraceMs?: number;
  supervisor?: SupervisorTimings;
}

export interface CheckResult {
  checkRunId: string;
  checkId: string;
  status: CheckStatus;
  reason: NotVerifiedReason | null;
  detail: unknown | null;
  process: { exitCode: number | null; signal: string | null; supervisorExitCode: number | null; stopCause: StopCause | null };
  // groupCleared: the target's process group is gone. sandboxCleared: the supervisor's in-sandbox scan came back
  // empty twice after killing `killed` leftovers (null: no scan result at all). false = not observed, never "clean".
  cleanup: { groupCleared: boolean; sandboxCleared: boolean; killed: number | null; observed: "process_group_and_sandbox_scan" };
  output: { ref: TextRef | null; bytes: number; dropped: number; head: string; tail: string };
  copy: { treeBefore: string | null; treeAfter: string | null; base: { commit: string; tree: string } | null };
  sandbox: { profileSha256: string | null; selftest: SelftestResult | null };
  evidenceFingerprint: string;
  durationMs: number;
}

interface DoneStatus {
  ev: "done";
  error?: string;
  code?: string;
  leaderExit: { code: number | null; signal: string | null } | null;
  stopRequested?: boolean;
  groupCleared?: boolean;
  sandbox?: { cleared: boolean; killed: number; scans: number; error: string | null };
}

export interface DecideFacts {
  supervisorSpawnError: string | null;
  done: DoneStatus | null;
  supervisorExitCode: number | null;
  exitCode: number | null;
  signal: string | null;
  stopCause: StopCause | null;
  stopRequested: boolean; // the supervisor requested a stop we did not ask for (lifeline EOF)
  groupCleared: boolean;
  sandboxCleared: boolean;
  postReason: NotVerifiedReason | null;
}

// §5, first match wins. Pure, so every rule is testable without processes.
export function decideCheck(f: DecideFacts): { status: CheckStatus; reason: NotVerifiedReason | null } {
  const nv = (reason: NotVerifiedReason) => ({ status: "not_verified" as const, reason });
  if (f.supervisorSpawnError) return nv("spawn_failed");
  if (f.done?.error === "spawn") return nv("spawn_failed");
  if (!f.done || f.done.error) return nv("interrupted"); // no `done`, guard deadline, fd4 missing: supervisor error
  if (f.stopCause === "output_limit") return nv("output_limit");
  if (f.stopCause === "timeout") return nv("timeout");
  if (f.stopCause === "user" || f.stopRequested) return nv("stopped");
  if (f.postReason) return nv(f.postReason);
  if (!(f.groupCleared && f.sandboxCleared === true && f.supervisorExitCode === 0)) return nv("cleanup_unverified");
  if (f.exitCode === 0) return { status: "passed", reason: null };
  if (f.exitCode !== null) return { status: "failed", reason: null };
  return nv("interrupted"); // killed by a signal without any stop of ours
}

function headTail(maxBytes: number): {
  push(d: Buffer): void; head: Buffer; tail: Buffer; bytes: number; dropped: number;
} {
  const headMax = Math.floor(maxBytes / 2), tailMax = maxBytes - headMax;
  const head: Buffer[] = [];
  const box = {
    push(d: Buffer) {
      box.bytes += d.length;
      if (headLen < headMax) {
        const k = Math.min(headMax - headLen, d.length);
        head.push(d.subarray(0, k));
        headLen += k;
        d = d.subarray(k);
      }
      if (d.length) {
        const t = Buffer.concat([tail, d.subarray(Math.max(0, d.length - tailMax))]);
        tail = t.subarray(Math.max(0, t.length - tailMax));
      }
    },
    get head() { return Buffer.concat(head); },
    get tail() { return tail; },
    bytes: 0,
    get dropped() { return Math.max(0, box.bytes - headLen - tail.length); }
  };
  let headLen = 0, tail = Buffer.alloc(0);
  return box;
}

export function startCheck(opts: StartCheckOptions): { checkRunId: string; stop(): void; result: Promise<CheckResult> } {
  const command = opts.resolveCheck(opts.registry, opts.id); // unknown_check: nothing is created
  const checkRunId = randomUUID();
  const clock = opts.clock ?? (() => Date.now());
  const startedAt = clock();
  const outputGraceMs = opts.outputGraceMs ?? DEFAULT_OUTPUT_GRACE_MS;

  let stopCause: StopCause | null = null;
  let requestStop: (cause: StopCause) => void = (cause) => { stopCause ??= cause; }; // replaced once fd0 exists

  const state = {
    treeBefore: null as string | null,
    treeAfter: null as string | null,
    base: null as { commit: string; tree: string } | null,
    profileSha256: null as string | null,
    selftest: null as SelftestResult | null,
    started: false
  };

  async function build(
    status: CheckStatus, reason: NotVerifiedReason | null, detail: unknown,
    proc: CheckResult["process"], cleanup: CheckResult["cleanup"],
    output: { ref: TextRef | null; bytes: number; dropped: number; head: string; tail: string }
  ): Promise<CheckResult> {
    let evidenceFingerprint = "";
    try {
      evidenceFingerprint = await opts.evidence({
        checkRunId, command, deps: opts.deps,
        copy: { treeBefore: state.treeBefore, treeAfter: state.treeAfter, base: state.base },
        sandbox: { profileSha256: state.profileSha256, selftest: state.selftest },
        env: { names: CHECK_ENV_NAMES },
        result: { status, reason, exitCode: proc.exitCode, signal: proc.signal, groupCleared: cleanup.groupCleared, sandboxCleared: cleanup.sandboxCleared }
      });
    } catch (e) {
      detail = { detail, evidence: String((e as Error)?.message ?? e) };
    }
    const result: CheckResult = {
      checkRunId, checkId: command.id, status, reason, detail: detail ?? null,
      process: proc, cleanup, output,
      copy: { treeBefore: state.treeBefore, treeAfter: state.treeAfter, base: state.base },
      sandbox: { profileSha256: state.profileSha256, selftest: state.selftest },
      evidenceFingerprint, durationMs: clock() - startedAt
    };
    if (!state.started) return result; // refused before check.started: no event at all
    try {
      await opts.writer.recordCheckFinished({
        checkRunId, checkId: command.id, status: result.status, reason: result.reason,
        exitCode: proc.exitCode, signal: proc.signal, groupCleared: cleanup.groupCleared,
        treeAfter: state.treeAfter, output: output.ref, outputDropped: output.dropped,
        evidenceFingerprint, durationMs: result.durationMs
      });
    } catch (e) {
      return { ...result, status: "not_verified", reason: "store_failed", detail: { detail: result.detail, store: String((e as Error)?.message ?? e) } };
    }
    return result;
  }

  const NO_PROC: CheckResult["process"] = { exitCode: null, signal: null, supervisorExitCode: null, stopCause: null };
  const NO_CLEANUP: CheckResult["cleanup"] = { groupCleared: false, sandboxCleared: false, killed: null, observed: "process_group_and_sandbox_scan" };
  const NO_OUTPUT = { ref: null, bytes: 0, dropped: 0, head: "", tail: "" };
  const refuse = (reason: NotVerifiedReason, detail?: unknown) =>
    build("not_verified", reason, detail, { ...NO_PROC, stopCause }, NO_CLEANUP, NO_OUTPUT);

  async function run(): Promise<CheckResult> {
    const support = opts.sandbox.sandboxSupport();
    if (!support.supported) return refuse("sandbox_unavailable", { platform: process.platform });
    if (stopCause) return refuse("stopped");

    const pre = await opts.preflight();
    if (!pre.ok) return refuse(pre.reason, pre.detail);
    state.base = pre.base;
    state.treeBefore = pre.treeBefore;

    const checkDir = path.join(opts.ws.root, "runs", opts.ws.runId, "checks", checkRunId);
    const paths: SandboxPaths = {
      checkDir, root: opts.ws.root, repo: opts.ws.repo, tmp: path.join(checkDir, "tmp"), home: path.join(checkDir, "home"),
      sourcePath: opts.ws.sourcePath, sourceGitDir: opts.ws.sourceGitDir, nodeModules: opts.deps.nodeModulesPath
    };
    const selftestDir = path.join(checkDir, "selftest");
    const profilePath = path.join(checkDir, "profile.sb");
    try {
      for (const d of [checkDir, paths.tmp, paths.home, selftestDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      const profile = opts.sandbox.buildProfile(paths);
      state.profileSha256 = profile.sha256;
      fs.writeFileSync(profilePath, profile.text, { mode: 0o600, flag: "wx" });
    } catch (e) {
      return refuse("sandbox_unavailable", { profile: String((e as Error)?.message ?? e) });
    }

    try {
      state.selftest = await opts.sandbox.runSelftest({ dir: selftestDir, ws: opts.ws, launch: opts.launch, paths });
    } catch (e) {
      return refuse("sandbox_unavailable", { selftest: String((e as Error)?.message ?? e) });
    }
    if (!state.selftest.passed) return refuse("sandbox_unavailable", { selftest: state.selftest.failed });
    if (stopCause) return refuse("stopped");

    try {
      await opts.writer.recordCheckStarted({
        checkRunId, checkId: command.id, commandSha256: sha256Hex(canonical(command)),
        base: pre.base, treeBefore: pre.treeBefore, profileSha256: state.profileSha256 as string
      });
    } catch (e) {
      return refuse("store_failed", { started: String((e as Error)?.message ?? e) });
    }
    state.started = true;

    const facts = await execute(profilePath, paths);

    const post = await opts.postflight();
    state.treeAfter = post.ok ? post.treeAfter : post.treeAfter ?? null;

    const groupCleared = facts.done?.groupCleared === true;
    const sandboxCleared = facts.done?.sandbox?.cleared === true; // absent: the scan never ran or never reported
    const decided = decideCheck({
      supervisorSpawnError: facts.spawnError,
      done: facts.done, supervisorExitCode: facts.supervisorExitCode,
      exitCode: facts.exitCode, signal: facts.signal,
      stopCause, stopRequested: facts.done?.stopRequested === true,
      groupCleared, sandboxCleared, postReason: post.ok ? null : post.reason
    });

    let ref: TextRef | null = null;
    let storeDetail: unknown = null;
    const text = Buffer.concat([facts.output.head, facts.output.tail]);
    if (text.length) {
      try {
        ref = await opts.writer.putText(text);
      } catch (e) {
        storeDetail = { output: String((e as Error)?.message ?? e) };
      }
    }
    const detail = {
      ...(facts.spawnError ? { spawnError: facts.spawnError } : {}),
      ...(facts.done?.error ? { supervisor: facts.done.error, code: facts.done.code ?? null } : {}),
      ...(facts.harness ? { harness: facts.harness } : {}),
      ...(facts.done?.sandbox?.error ? { sandbox: facts.done.sandbox.error } : {}),
      ...(post.ok ? {} : { post: post.detail ?? null }),
      ...(storeDetail ? storeDetail : {})
    };
    const result = await build(
      storeDetail ? "not_verified" : decided.status,
      storeDetail ? "store_failed" : decided.reason,
      Object.keys(detail).length ? detail : null,
      { exitCode: facts.exitCode, signal: facts.signal, supervisorExitCode: facts.supervisorExitCode, stopCause },
      { groupCleared, sandboxCleared, killed: facts.done?.sandbox?.killed ?? null, observed: "process_group_and_sandbox_scan" },
      { ref, bytes: facts.output.bytes, dropped: facts.output.dropped, head: facts.output.head.toString("utf8"), tail: facts.output.tail.toString("utf8") }
    );
    return result;
  }

  interface ExecFacts {
    spawnError: string | null;
    done: DoneStatus | null;
    harness: string | null;
    supervisorExitCode: number | null;
    exitCode: number | null;
    signal: string | null;
    output: { head: Buffer; tail: Buffer; bytes: number; dropped: number };
  }

  function execute(profilePath: string, paths: SandboxPaths): Promise<ExecFacts> {
    const env: Record<string, string> = {
      ...opts.launch.env,
      PATH: `${path.dirname(command.executable)}:/usr/bin:/bin`,
      HOME: paths.home,
      TMPDIR: paths.tmp,
      LANG: "C", LC_ALL: "C", TZ: "UTC", CI: "1",
      SUP_ENV_ALLOW: CHECK_ENV_NAMES.join(","),
      SUP_SANDBOX_SWEEP: "1"
    };
    const t = { ...SUP_DEFAULTS, ...(opts.supervisor ?? {}) };
    if (opts.supervisor?.graceIntMs !== undefined) env.SUP_GRACE_INT_MS = String(t.graceIntMs);
    if (opts.supervisor?.graceTermMs !== undefined) env.SUP_GRACE_TERM_MS = String(t.graceTermMs);
    if (opts.supervisor?.leftoverMs !== undefined) env.SUP_LEFTOVER_MS = String(t.leftoverMs);

    // sandbox-exec execs the supervisor, so the supervisor's pid is the spawned pid and its parent is this process:
    // the supervisor's sandbox guard depends on both. A missing sandbox-exec is this spawn's own error (spawn_failed).
    const args = [
      "-f", profilePath, "--",
      opts.launch.command, ...opts.launch.args,
      command.executable, ...command.argv
    ];
    // fd4: the supervisor requires the task channel, a check has no task, so it gets /dev/null (immediate EOF).
    // stdio "ignore" is NOT usable here: for fd >= 3 Node hands the child a pipe-like fd the supervisor cannot
    // open as a stream (ENOTTY), so /dev/null is opened explicitly and closed in this process right after spawn.
    const devNull = fs.openSync("/dev/null", "r");
    let sup;
    try {
      sup = spawn(opts.sandboxExec ?? SANDBOX_EXEC, args,
        { cwd: opts.ws.repo, env, stdio: ["pipe", "pipe", "pipe", "pipe", devNull] });
    } finally {
      fs.closeSync(devNull);
    }

    const control = sup.stdio[0] as Writable;
    const stdout = sup.stdio[1] as Readable;
    const stderr = sup.stdio[2] as Readable;
    const status = sup.stdio[3] as Readable;

    const out = headTail(command.maxOutputBytes);
    let spawnError: string | null = null, harness: string | null = null;
    let done: DoneStatus | null = null, statusEnded = false;
    let supExit: { code: number | null; signal: string | null } | null = null;
    let leaderExit: { code: number | null; signal: string | null } | null = null;
    let stdoutEnded = false, stderrEnded = false, finished = false, limitHit = false;
    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    let settle!: (f: ExecFacts) => void;
    const done$ = new Promise<ExecFacts>((r) => { settle = r; });

    requestStop = (cause: StopCause) => {
      if (stopCause !== null || finished) return;
      stopCause = cause;
      if (control.writable) control.write('{"cmd":"stop"}\n');
    };
    if (stopCause !== null) { const c = stopCause; stopCause = null; requestStop(c); } // stop() before the spawn

    control.on("error", () => {});
    sup.on("error", (e: NodeJS.ErrnoException) => { spawnError = e.code ?? String(e); finish(null); });
    sup.on("exit", (code, signal) => {
      supExit = { code, signal };
      // An escapee can hold stdout/stderr forever; after the grace they are given up on, not waited for.
      later(outputGraceMs, () => {
        if (!stdoutEnded) { stdoutEnded = true; stdout.destroy(); }
        if (!stderrEnded) { stderrEnded = true; stderr.destroy(); }
        check();
      });
      check();
    });

    const onData = (d: Buffer) => {
      out.push(d);
      if (!limitHit && out.bytes > command.maxOutputBytes) { limitHit = true; requestStop("output_limit"); }
    };
    stdout.on("data", onData);
    stderr.on("data", onData);
    stdout.on("end", () => { stdoutEnded = true; check(); });
    stderr.on("end", () => { stderrEnded = true; check(); });

    let line = "", overlong = false;
    status.setEncoding("utf8");
    status.on("data", (d: string) => {
      let start = 0;
      for (let nl = d.indexOf("\n"); nl >= 0; nl = d.indexOf("\n", start)) {
        const whole = overlong ? null : line + d.slice(start, nl);
        line = ""; overlong = false; start = nl + 1;
        if (whole !== null) onStatus(whole);
      }
      if (!overlong) {
        line += d.slice(start);
        if (line.length > MAX_STATUS_LINE) { line = ""; overlong = true; }
      }
    });
    status.on("end", () => { statusEnded = true; check(); });

    function onStatus(text: string): void {
      let m: { ev?: string; code?: unknown; signal?: string | null };
      try {
        m = JSON.parse(text) as typeof m;
      } catch {
        return;
      }
      if (!m || typeof m.ev !== "string") return;
      if (m.ev === "leader_exit") leaderExit = { code: typeof m.code === "number" ? m.code : null, signal: m.signal ?? null };
      else if (m.ev === "done" && !done) { done = m as unknown as DoneStatus; check(); }
    }

    later(command.timeoutMs, () => requestStop("timeout"));
    const guardMs = command.timeoutMs + t.graceIntMs + t.graceTermMs + t.leftoverMs
      // the supervisor's relay (turn.ts has the same): SIGKILL wait, relay flush, stdin settle, stream wait with the group gone
      + 3 * SUP_KILL_WAIT_MS + SUP_STREAM_WAIT_MS + SUP_SWEEP_MS + SWEEP_SCANS_MS + 2 * outputGraceMs + GUARD_MARGIN_MS;
    later(guardMs, () => finish("guard_deadline"));

    function check(): void {
      if (!finished && (done || statusEnded) && supExit && stdoutEnded && stderrEnded) finish(null);
    }

    function finish(reason: string | null): void {
      if (finished) return;
      finished = true;
      harness = reason ?? (done ? null : "status_eof_without_done");
      for (const timer of timers) clearTimeout(timer);
      if (reason) { stdout.destroy(); stderr.destroy(); status.destroy(); }
      control.end(); // lifeline EOF: a supervisor somehow still alive stops the group
      const le = (done as DoneStatus | null)?.leaderExit ?? leaderExit;
      settle({
        spawnError, done, harness,
        supervisorExitCode: supExit?.code ?? null,
        exitCode: le?.code ?? null, signal: le?.signal ?? null,
        output: { head: out.head, tail: out.tail, bytes: out.bytes, dropped: out.dropped }
      });
    }

    return done$;
  }

  return { checkRunId, stop: () => requestStop("user"), result: run() };
}
