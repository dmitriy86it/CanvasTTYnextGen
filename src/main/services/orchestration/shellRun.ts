// One command line of the user's login shell under the supervisor (stage 13): its own process group (stop = INT, TERM,
// KILL), a timeout, bounded output (head + tail, the middle counted). Used by checks, environment preparation and the
// actions after success. Nothing here decides what a result means.
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { SupervisorLaunch } from "./types.ts";

const GRACE_MS = 15_000; // after the supervisor's own stop sequence

export type ShellStopCause = "user" | "timeout";
export interface ShellRunResult {
  exitCode: number | null;
  signal: string | null;
  groupCleared: boolean;
  supervisorExitCode: number | null;
  spawnError: string | null; // the supervisor or the shell could not start
  stopCause: ShellStopCause | null;
  output: { text: string; head: string; tail: string; bytes: number; dropped: number };
  durationMs: number;
}

export interface ShellRunOptions {
  shell: string; // the user's login shell (absolute)
  line: string; // run as `<shell> -ilc <line>`
  argv?: readonly string[]; // instead: the whole command under the supervisor (A1.1: sandbox-exec … <shell> -c <line>)
  cwd: string;
  env: Readonly<Record<string, string>>;
  launch: SupervisorLaunch;
  timeoutMs: number;
  maxOutputBytes: number;
  clock?: () => number;
}

interface SupDone { leaderExit?: { code: number | null; signal: string | null } | null; groupCleared?: boolean; error?: string }

export function runShell(opts: ShellRunOptions): { stop(): void; result: Promise<ShellRunResult> } {
  const clock = opts.clock ?? (() => Date.now());
  const startedAt = clock();
  let stopCause: ShellStopCause | null = null;
  const sup = spawn(opts.launch.command, [...opts.launch.args, ...(opts.argv ?? [opts.shell, "-ilc", opts.line])], {
    cwd: opts.cwd, env: { ...opts.launch.env, SUP_CHILD_ENV: JSON.stringify(opts.env) }, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"]
  });
  const control = sup.stdio[0] as Writable;
  (sup.stdio[4] as Writable).end(); // no input: EOF on the command's stdin
  control.on("error", () => {});
  (sup.stdio[4] as Writable).on("error", () => {});
  const requestStop = (cause: ShellStopCause) => {
    if (stopCause) return;
    stopCause = cause;
    if (control.writable) control.write('{"cmd":"stop"}\n');
  };
  const half = Math.floor(opts.maxOutputBytes / 2);
  let head = Buffer.alloc(0), tail = Buffer.alloc(0), bytes = 0;
  const take = (d: Buffer) => {
    bytes += d.length;
    if (head.length < half) { const k = Math.min(half - head.length, d.length); head = Buffer.concat([head, d.subarray(0, k)]); d = d.subarray(k); }
    if (d.length) { const t = Buffer.concat([tail, d]); tail = t.subarray(Math.max(0, t.length - (opts.maxOutputBytes - half))); }
  };
  (sup.stdio[1] as Readable).on("data", take);
  (sup.stdio[2] as Readable).on("data", take);
  let done: SupDone | null = null;
  let line = "";
  (sup.stdio[3] as Readable).setEncoding("utf8").on("data", (d: string) => {
    line += d;
    for (let nl = line.indexOf("\n"); nl >= 0; nl = line.indexOf("\n")) {
      const text = line.slice(0, nl); line = line.slice(nl + 1);
      try { const m = JSON.parse(text); if (m?.ev === "done") done = m as SupDone; } catch { /* not a status line */ }
    }
  });
  const result = (async (): Promise<ShellRunResult> => {
    const timeout = setTimeout(() => requestStop("timeout"), opts.timeoutMs);
    let spawnError: string | null = null;
    const supExit = await new Promise<number | null>((resolve) => {
      const guard = setTimeout(() => { try { sup.kill("SIGKILL"); } catch { /* gone */ } resolve(null); }, opts.timeoutMs + GRACE_MS * 2);
      sup.on("error", (e) => { spawnError = String(e?.message ?? e); clearTimeout(guard); resolve(null); });
      sup.on("close", (code) => { clearTimeout(guard); resolve(code); });
    });
    clearTimeout(timeout);
    control.end();
    const d = done as SupDone | null;
    if (!spawnError && (!d || d.error)) spawnError = d?.error ?? "the supervisor reported no result";
    const dropped = Math.max(0, bytes - head.length - tail.length);
    const text = dropped > 0 ? `${head.toString("utf8")}\n[… ${dropped} bytes not kept …]\n${tail.toString("utf8")}` : Buffer.concat([head, tail]).toString("utf8");
    return {
      exitCode: d?.leaderExit?.code ?? null, signal: d?.leaderExit?.signal ?? null, groupCleared: d?.groupCleared === true,
      supervisorExitCode: supExit, spawnError, stopCause,
      // head and tail: the first and the last 2000 characters of all the output (a short one is in both)
      output: { text, head: text.slice(0, 2000), tail: text.slice(-2000), bytes, dropped },
      durationMs: clock() - startedAt
    };
  })();
  return { stop: () => requestStop("user"), result };
}

// A shell word, quoted for any POSIX shell.
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
