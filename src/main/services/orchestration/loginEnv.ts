// The environment a CLI gets when the user starts it in a CanvasTTY terminal of the project: the terminal's own
// environment (terminalEnvironment) passed through the user's interactive login shell in that folder, so PATH,
// version managers and exported variables from the rc files are the same. Values are never logged or journaled.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LoginEnvResult =
  | { ok: true; shell: string; env: Record<string, string> }
  | { ok: false; shell: string; reason: "no_shell" | "timeout" | "failed" | "empty"; detail: string };

const MARK = "\u0000CANVASTTY_ENV_BEGIN\u0000";
// Values of the shell process itself, not of the session: the CLI gets its own.
const PROCESS_ONLY = new Set(["_", "SHLVL", "PWD", "OLDPWD"]);
const MAX_BYTES = 4 * 1024 * 1024;

export function captureLoginEnv(opts: { cwd: string; base: Readonly<Record<string, string>>; timeoutMs?: number }): Promise<LoginEnvResult> {
  const shell = opts.base.SHELL || "/bin/zsh";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: LoginEnvResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      // -i -l: the rc files a terminal reads. The marker separates what rc files print from the environment itself.
      child = spawn(shell, ["-ilc", "printf '\\000CANVASTTY_ENV_BEGIN\\000'; command env -0"], {
        cwd: opts.cwd, env: { ...opts.base }, stdio: ["ignore", "pipe", "ignore"], detached: true
      });
    } catch (e) {
      return finish({ ok: false, shell, reason: "no_shell", detail: String((e as Error).message).slice(0, 200) });
    }
    timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
      finish({ ok: false, shell, reason: "timeout", detail: `${shell} did not finish its startup files in ${timeoutMs} ms` });
    }, timeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => finish({ ok: false, shell, reason: "no_shell", detail: e.code ?? "spawn error" }));
    child.stdout!.on("data", (d: Buffer) => { if (out.length < MAX_BYTES) out = Buffer.concat([out, d]); });
    child.on("close", (code) => {
      const text = out.toString("utf8");
      const at = text.lastIndexOf(MARK);
      if (at < 0) return finish({ ok: false, shell, reason: "failed", detail: `${shell} exited with ${code} before printing its environment` });
      const env: Record<string, string> = {};
      for (const entry of text.slice(at + MARK.length).split("\u0000")) {
        const eq = entry.indexOf("=");
        if (eq <= 0) continue;
        const name = entry.slice(0, eq);
        if (!PROCESS_ONLY.has(name)) env[name] = entry.slice(eq + 1);
      }
      if (!env.PATH) return finish({ ok: false, shell, reason: "empty", detail: "the login shell reported no PATH" });
      finish({ ok: true, shell, env });
    });
  });
}

// Stage 13: a project's direnv environment on top of the login shell, as a terminal with the direnv hook has it after
// `cd` into the folder. Only for an .envrc the user already allowed: CanvasTTY never runs `direnv allow`. What is
// reported is the fact (applied, not allowed, none), never a value.
export type DirenvState = "applied" | "not_allowed" | "none" | "not_installed" | "failed" | "off";

function findOnPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? "").split(":")) {
    if (!dir) continue;
    const p = `${dir}/${name}`;
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function runCapture(file: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = "", err = "";
    let child;
    try { child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true }); } catch (e) { return resolve({ code: null, out: "", err: String(e) }); }
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.stdout!.on("data", (d: Buffer) => { if (out.length < MAX_BYTES) out += d.toString("utf8"); });
    child.stderr!.on("data", (d: Buffer) => { if (err.length < 8192) err += d.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, out, err }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

async function hasEnvrc(dir: string): Promise<boolean> {
  for (let d = dir; ; d = dirname(d)) {
    if (await lstat(join(d, ".envrc")).then(() => true, () => false)) return true;
    if (dirname(d) === d) return false;
  }
}

// pending: the run will work in a worktree that does not exist yet (cwd is its project): the worktree's .envrc is a new
// path direnv has never allowed, so it is not applied (CanvasTTY never allows it, nor carries the project's over).
export async function applyDirenv(opts: { cwd: string; env: Record<string, string>; enabled: boolean; timeoutMs?: number; pending?: boolean }): Promise<{ env: Record<string, string>; direnv: DirenvState }> {
  if (!opts.enabled) return { env: opts.env, direnv: "off" };
  if (opts.pending) return { env: opts.env, direnv: (await hasEnvrc(opts.cwd)) ? "not_allowed" : "none" };
  if (!(await hasEnvrc(opts.cwd))) return { env: opts.env, direnv: "none" };
  const direnv = findOnPath("direnv", opts.env.PATH);
  if (!direnv) return { env: opts.env, direnv: "not_installed" };
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const status = await runCapture(direnv, ["status", "--json"], opts.cwd, opts.env, timeoutMs);
  let allowed: boolean | null = null;
  try {
    const s = JSON.parse(status.out) as { state?: { foundRC?: { allowed?: number } | null } };
    const a = s.state?.foundRC?.allowed;
    allowed = a === undefined ? null : a === 0;
  } catch {
    // older direnv: the text status
    const m = /Found RC allowed (\S+)/.exec(status.out);
    allowed = m ? m[1] === "true" || m[1] === "0" : null;
  }
  if (allowed !== true) return { env: opts.env, direnv: allowed === false ? "not_allowed" : "failed" };
  const exp = await runCapture(direnv, ["export", "json"], opts.cwd, opts.env, timeoutMs);
  if (exp.code !== 0) return { env: opts.env, direnv: "failed" };
  if (exp.out.trim() === "") return { env: opts.env, direnv: "applied" }; // nothing to change
  try {
    const diff = JSON.parse(exp.out) as Record<string, string | null>;
    const env = { ...opts.env };
    for (const [k, v] of Object.entries(diff)) { if (v === null) delete env[k]; else if (typeof v === "string") env[k] = v; }
    return { env, direnv: "applied" };
  } catch {
    return { env: opts.env, direnv: "failed" };
  }
}
