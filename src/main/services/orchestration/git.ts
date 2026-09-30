// Hardened Git invocation (docs/agent-orchestration/implementation/stage-3-contract.md, "Безопасный вызов Git").
// No shell, environment built from scratch, explicit GIT_DIR (discovery is never used), config vectors disabled by -c.
// The flags alone prove nothing: every vector is covered by a marker-script test.
import { execFile } from "node:child_process";
import { accessSync, constants as fsc, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export interface GitContext {
  gitPath: string; // absolute
  gitDir: string; // explicit GIT_DIR, never discovery
  workTree?: string; // GIT_WORK_TREE
  indexFile?: string; // GIT_INDEX_FILE
  home: string; // empty service dir used as HOME/XDG_CONFIG_HOME
  userHome?: string; // only for the documented exception (global ignore); otherwise GIT_CONFIG_GLOBAL=/dev/null
}

export interface GitRunOptions {
  input?: string | Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
  identity?: boolean; // fixed author/committer env
  useUserGlobalConfig?: boolean; // only `ls-files --others --exclude-standard` for the baseline
}

export type GitErrorCode = "git_failed" | "git_timeout" | "git_output_limit" | "git_spawn";

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(code: GitErrorCode, message: string, exitCode: number | null, stderr: string, cause?: unknown) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = "GitError";
    this.code = code;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export const HARDENED_CONFIG: readonly string[] = Object.freeze([
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.pager=cat",
  "core.editor=false",
  "core.askPass=",
  "credential.helper=",
  "core.sshCommand=false",
  "diff.external=",
  "core.alternateRefsCommand=",
  "protocol.allow=never",
  "protocol.file.allow=always",
  "gc.auto=0",
  "maintenance.auto=false",
  "fetch.writeCommitGraph=false"
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const IDENTITY = { name: "CanvasTTY", email: "canvastty@localhost" };
const HARDENED_ARGS = HARDENED_CONFIG.flatMap((kv) => ["-c", kv]);

function gitEnv(ctx: GitContext, options: GitRunOptions): NodeJS.ProcessEnv {
  const userGlobal = options.useUserGlobalConfig === true && ctx.userHome !== undefined;
  const env: NodeJS.ProcessEnv = {
    PATH: [dirname(ctx.gitPath), "/usr/bin", "/bin"].join(delimiter),
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: "false",
    GIT_PAGER: "cat",
    GIT_EDITOR: "false",
    GIT_DIR: ctx.gitDir
  };
  if (userGlobal) {
    env.HOME = ctx.userHome; // global config and core.excludesFile as the user's `git status` sees them
  } else {
    env.HOME = ctx.home;
    env.XDG_CONFIG_HOME = ctx.home;
    env.GIT_CONFIG_GLOBAL = "/dev/null";
  }
  if (ctx.workTree !== undefined) env.GIT_WORK_TREE = ctx.workTree;
  if (ctx.indexFile !== undefined) env.GIT_INDEX_FILE = ctx.indexFile;
  if (options.identity) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = IDENTITY.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = IDENTITY.email;
  }
  return env;
}

export function git(ctx: GitContext, args: readonly string[], options: GitRunOptions = {}): Promise<{ stdout: Buffer; stderr: string }> {
  if (!isAbsolute(ctx.gitPath) || !isAbsolute(ctx.gitDir) || !isAbsolute(ctx.home)) {
    return Promise.reject(new GitError("git_spawn", "gitPath, gitDir and home must be absolute", null, ""));
  }
  const what = `git ${args[0] ?? ""}`;
  return new Promise((resolve, reject) => {
    const child = execFile(ctx.gitPath, [...HARDENED_ARGS, ...args], {
      cwd: ctx.workTree ?? ctx.home, // gitDir may not exist yet (init, clone)
      env: gitEnv(ctx, options),
      encoding: "buffer",
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
      windowsHide: true
    }, (error, stdout, stderrBuf) => {
      const stderr = stderrBuf.subarray(0, MAX_STDERR).toString("utf8");
      if (!error) return resolve({ stdout, stderr });
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(new GitError("git_output_limit", `${what}: output limit exceeded`, null, stderr, error));
      else if (typeof e.code === "string") reject(new GitError("git_spawn", `${what}: ${e.code}`, null, stderr, error));
      else if (e.killed) reject(new GitError("git_timeout", `${what}: timed out`, null, stderr, error));
      else reject(new GitError("git_failed", `${what} exited with ${String(e.code)}`, typeof e.code === "number" ? e.code : null, stderr, error));
    });
    child.stdin?.on("error", () => {}); // EPIPE when git exits without reading its input; the exit status reports it
    child.stdin?.end(options.input ?? "");
  });
}

export function findGit(env: NodeJS.ProcessEnv): string | null {
  const name = process.platform === "win32" ? "git.exe" : "git";
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue; // a relative PATH entry would resolve against the cwd
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsc.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}
