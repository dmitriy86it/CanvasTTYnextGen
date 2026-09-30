// Stage 12: a check is a command of the user's own project (`php artisan test`, `composer test`, `npm test`), run
// as the user runs it in a terminal: their login shell, in the folder the agents work in, with the same environment,
// no sandbox. What the application adds: the process group is supervised (stop, timeout, cleanup), the output is kept
// bounded, and the result is tied to the tree it ran on (the tree before and after; a check that changes tracked
// files is not a verdict about the tree it started on).
import { createHash, randomUUID } from "node:crypto";
import { runShell } from "./shellRun.ts";
import { commandSha256 } from "./checks.ts";
import { canonical } from "./journal.ts";
import type { CheckCommand, CheckResult, CheckStatus, CheckWriter, NotVerifiedReason, StopCause } from "./checkRunner.ts";
import type { RunState } from "./journal.ts";
import type { SupervisorLaunch } from "./types.ts";
import { snapshotCopyTree, verifyWorkspace } from "./workspace.ts";
import type { Workspace } from "./workspace.ts";

export const NO_SANDBOX_SHA256 = createHash("sha256").update("canvastty:no-sandbox:user-shell").digest("hex");

export interface ShellCheckOptions {
  ws: Workspace;
  command: CheckCommand; // executable = the user's shell, argv = ["-ilc", <command line>]
  env: Readonly<Record<string, string>>; // the login-shell environment of the run
  writer: CheckWriter;
  launch: SupervisorLaunch;
  state: RunState;
  clock?: () => number;
}

export type ShellCheckResult = CheckResult & { deps: null; executableSha256: string };

export function startShellCheck(opts: ShellCheckOptions): { checkRunId: string; stop(): void; result: Promise<ShellCheckResult> } {
  const checkRunId = randomUUID();
  const clock = opts.clock ?? (() => Date.now());
  const startedAt = clock();
  const c = opts.command;
  let stopCause: StopCause | null = null;
  let requestStop = (cause: StopCause) => { stopCause ??= cause; };
  const sha = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

  const result = (async (): Promise<ShellCheckResult> => {
    const base = opts.state.workspace?.current ?? null;
    const empty = { ref: null, bytes: 0, dropped: 0, head: "", tail: "" };
    const make = (status: CheckStatus, reason: NotVerifiedReason | null, detail: unknown, extra: Partial<CheckResult> = {}): ShellCheckResult => ({
      checkRunId, checkId: c.id, status, reason, detail: detail ?? null,
      process: { exitCode: null, signal: null, supervisorExitCode: null, stopCause },
      cleanup: { groupCleared: false, sandboxCleared: false, killed: null, observed: "process_group_and_sandbox_scan" },
      output: empty, copy: { treeBefore: null, treeAfter: null, base }, sandbox: { profileSha256: null, selftest: null },
      evidenceFingerprint: "", durationMs: clock() - startedAt, deps: null, executableSha256: "", ...extra
    });
    if (!base) return make("not_verified", "workspace_unverified", "the journal has no workspace");
    try { await verifyWorkspace(opts.ws); } catch (e) { return make("not_verified", "workspace_unverified", String((e as Error).message)); }
    if (stopCause) return make("not_verified", "stopped", null);
    let treeBefore: string;
    try { treeBefore = await snapshotCopyTree(opts.ws, base.tree); } catch (e) { return make("not_verified", "workspace_unverified", String((e as Error).message)); }
    try {
      await opts.writer.recordCheckStarted({ checkRunId, checkId: c.id, commandSha256: commandSha256(c), base, treeBefore, profileSha256: NO_SANDBOX_SHA256 });
    } catch (e) {
      return make("not_verified", "store_failed", String((e as Error)?.message ?? e));
    }

    // ---- the process, under the supervisor (its own process group; stop = INT, TERM, KILL) ----
    const run = runShell({
      shell: c.executable, line: c.argv[1] ?? "", cwd: opts.ws.repo, env: opts.env, launch: opts.launch,
      timeoutMs: c.timeoutMs, maxOutputBytes: c.maxOutputBytes, clock
    });
    requestStop = (cause) => { if (stopCause) return; stopCause = cause; run.stop(); };
    if (stopCause) { const cause = stopCause; stopCause = null; requestStop(cause); }
    const sr = await run.result;
    if (sr.stopCause === "timeout") stopCause ??= "timeout";
    const { exitCode, signal, groupCleared } = sr;
    const supExit = sr.supervisorExitCode;
    const { bytes, dropped } = sr.output;
    let ref = null;
    try { ref = bytes > 0 ? await opts.writer.putText(sr.output.text) : null; } catch { ref = null; }
    let treeAfter: string | null = null;
    try { treeAfter = await snapshotCopyTree(opts.ws, base.tree); } catch { treeAfter = null; }

    let status: CheckStatus, reason: NotVerifiedReason | null;
    const stopped = stopCause as StopCause | null; // set from callbacks
    if (stopped === "timeout") [status, reason] = ["not_verified", "timeout"];
    else if (stopped) [status, reason] = ["not_verified", "stopped"];
    else if (sr.spawnError || supExit === null) [status, reason] = ["not_verified", "spawn_failed"];
    else if (!groupCleared) [status, reason] = ["not_verified", "cleanup_unverified"];
    else if (treeAfter !== treeBefore) [status, reason] = ["not_verified", "tree_changed"];
    else [status, reason] = exitCode === 0 && signal === null ? ["passed", null] : ["failed", null];

    const evidenceFingerprint = sha({ checkRunId, command: c.id, argv: [...c.argv], treeBefore, treeAfter, exitCode, signal, groupCleared, envNames: Object.keys(opts.env).length });
    const r = make(status, reason, null, {
      process: { exitCode, signal, supervisorExitCode: supExit, stopCause },
      cleanup: { groupCleared, sandboxCleared: false, killed: null, observed: "process_group_and_sandbox_scan" },
      output: { ref, bytes, dropped, head: sr.output.head, tail: sr.output.tail },
      copy: { treeBefore, treeAfter, base }, evidenceFingerprint, durationMs: clock() - startedAt
    });
    try {
      await opts.writer.recordCheckFinished({
        checkRunId, checkId: c.id, status, reason, exitCode, signal, groupCleared, treeAfter, output: ref, outputDropped: dropped,
        evidenceFingerprint, durationMs: r.durationMs
      });
    } catch (e) {
      return { ...r, status: "not_verified", reason: "store_failed", detail: String((e as Error)?.message ?? e) };
    }
    return r;
  })();
  return { checkRunId, stop: () => requestStop("user"), result };
}
