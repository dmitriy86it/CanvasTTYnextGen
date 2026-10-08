// «Проверить сейчас» (UX audit 2026-10-05, top-10 №8): what the start would meet, checked before it and never with a
// model call. Three parts beside the readiness items:
//   - the sign-in of each CLI, where the CLI itself can say it locally: only when its own help lists the subcommand
//     (`codex login --help` → status, `claude auth --help` → status); a CLI that cannot is not asked, no item is shown;
//   - the self-test of the check sandbox (A1.1, the 8 operations) and git in it (real series, attempt 4);
//   - the preparation and the check commands on the source as it is, in a temporary work folder made the way the run
//     makes it (a copy or a worktree, dependencies cloned as a run clones them); never in the project folder itself.
// The temporary folder, its refs in the project's repository and a worktree's branch are removed afterwards, whatever
// happened.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestrationReadinessItem } from "../../../shared/orchestration.ts";
import { neededSteps, worktreeSteps } from "./prepare.ts";
import type { PrepareStep } from "./prepare.ts";
import { buildCheckProfile, checkSelftest } from "./sandbox.ts";
import { runShell } from "./shellRun.ts";
import type { ShellRunResult } from "./shellRun.ts";
import type { SupervisorLaunch } from "./types.ts";
import { cloneDependencies, createWorkspace, readDependencyRecord } from "./workspace.ts";
import type { CloneDir, Workspace } from "./workspace.ts";

export const PREFLIGHT_TIMEOUT_MS = 10 * 60_000; // the preparation and every command together
const AUTH_MS = 15_000;
const OUTPUT_LINES = 6; // of a failed command, shown under it
// as in a lead's check (userCheck.ts): git must not read the person's global configuration in the profile
const SANDBOX_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

interface Said { code: number | null; out: string }
const say = (file: string, args: string[], env: Readonly<Record<string, string>>, timeout = AUTH_MS): Promise<Said> =>
  new Promise((resolve) => {
    execFile(file, args, { env: { ...env }, timeout, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0;
      resolve({ code, out: `${stdout}\n${stderr}` });
    });
  });

// The sign-in of the CLIs, as each says it without a model (the account's name or e-mail is never kept). A CLI whose
// answer is not understood gets no item: nothing is guessed.
export async function authItems(rt: { env: Readonly<Record<string, string>>; executables?: Record<"codex" | "claude", string>; codexEnv?: Readonly<Record<string, string>> }): Promise<OrchestrationReadinessItem[]> {
  if (!rt.executables) return [];
  const ex = rt.executables;
  const offers = async (file: string, group: string, env: Readonly<Record<string, string>>) => /^\s+status\b/m.test((await say(file, [group, "--help"], env)).out);
  const nothing: Said = { code: null, out: "" };
  const [codex, claude] = await Promise.all([
    offers(ex.codex, "login", rt.codexEnv ?? rt.env).then((yes) => (yes ? say(ex.codex, ["login", "status"], rt.codexEnv ?? rt.env) : nothing)),
    offers(ex.claude, "auth", rt.env).then((yes) => (yes ? say(ex.claude, ["auth", "status", "--json"], rt.env) : nothing))
  ]);
  const items: OrchestrationReadinessItem[] = [];
  if (/not logged in/i.test(codex.out)) items.push({ id: "auth_codex", level: "warning", detail: "Codex: not signed in", facts: { provider: "codex" } });
  else if (codex.code === 0 && /logged in/i.test(codex.out)) {
    const how = /logged in using ([\w .-]{1,40})/i.exec(codex.out)?.[1]?.trim() ?? "";
    items.push({ id: "auth_codex", level: "ok", detail: "Codex: signed in", facts: { provider: "codex", method: how } });
  }
  const signed = ((): { loggedIn?: unknown; authMethod?: unknown } | null => {
    try { return JSON.parse(claude.out.slice(claude.out.indexOf("{"), claude.out.lastIndexOf("}") + 1)) as { loggedIn?: unknown }; } catch { return null; }
  })();
  if (signed && typeof signed.loggedIn === "boolean") {
    items.push(signed.loggedIn
      ? { id: "auth_claude", level: "ok", detail: "Claude: signed in", facts: { provider: "claude", method: typeof signed.authMethod === "string" ? signed.authMethod.slice(0, 40) : "" } }
      : { id: "auth_claude", level: "warning", detail: "Claude: not signed in", facts: { provider: "claude" } });
  }
  return items;
}

// The check sandbox before any check (A1.1): its self-test in a temporary Git folder, then `git status` in it as a
// lead's check would run it. A failure is a warning: only a lead's proposed commands run in the profile.
export async function sandboxItems(opts: {
  launch: SupervisorLaunch; root: string; realHome?: string; gitPath: string | null;
  rt: { shell: string; env: Readonly<Record<string, string>> }; tmp?: string;
}): Promise<OrchestrationReadinessItem[]> {
  const base = await mkdtemp(join(opts.tmp ?? tmpdir(), "canvastty-pf-")); // short: a Unix socket path in it stays under 104 bytes
  try {
    const work = join(base, "work");
    const tmp = join(base, "tmp");
    await mkdir(work);
    await mkdir(tmp);
    if (opts.gitPath) await say(opts.gitPath, ["init", "-q", work], { PATH: "/usr/bin:/bin", HOME: tmp });
    const profile = buildCheckProfile({ work, tmp, root: opts.root, realHome: opts.realHome });
    const profilePath = join(tmp, ".canvastty-profile.sb");
    await writeFile(profilePath, profile.text, { mode: 0o400 });
    const st = await checkSelftest({ profilePath, work, tmp, root: opts.root, realHome: opts.realHome, launch: opts.launch });
    if (!st.passed) {
      return [{ id: "sandbox", level: "warning", detail: `the check sandbox self-test failed: ${st.failed.map((f) => f.name).join(", ")}`.slice(0, 300), facts: { checks: st.checks, failed: st.failed.map((f) => f.name).join(", ").slice(0, 200) } }];
    }
    const items: OrchestrationReadinessItem[] = [{ id: "sandbox", level: "ok", detail: "check sandbox self-test", facts: { checks: st.checks } }];
    const r = await runShell({
      shell: opts.rt.shell, line: "git status --porcelain", profile: profilePath, cwd: work,
      env: { ...opts.rt.env, ...SANDBOX_ENV, TMPDIR: tmp }, launch: opts.launch, timeoutMs: 30_000, maxOutputBytes: 16 * 1024
    }).result;
    const ok = r.exitCode === 0 && r.signal === null && !r.spawnError;
    items.push(ok ? { id: "sandbox_git", level: "ok", detail: "git in the check sandbox" }
      : { id: "sandbox_git", level: "warning", detail: "git does not work in the check sandbox", facts: { exitCode: r.exitCode, output: firstLines(r.spawnError ?? r.output.head) } });
    return items;
  } catch (error) {
    return [{ id: "sandbox", level: "warning", detail: `the check sandbox could not be tried: ${String((error as Error)?.message ?? error)}`.slice(0, 300), facts: { checks: 0, failed: "sandbox.selftest" } }];
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

const firstLines = (text: string): string => text.split("\n").filter((l) => l.trim()).slice(0, OUTPUT_LINES).join("\n").slice(0, 800);

export interface SourceChecksInput {
  project: string; // the lead's project (absolute, real)
  workMode: "project" | "copy" | "worktree";
  commands: readonly string[];
  prepare?: { steps: readonly PrepareStep[]; auto: boolean };
  rt: { shell: string; env: Readonly<Record<string, string>> };
  launch: SupervisorLaunch;
  gitPath: string;
  cloneDir?: CloneDir;
  timeoutMs?: number;
  tmp?: string; // where the temporary folder is made (os.tmpdir())
  clock?: () => number;
}

// The preparation and the check commands on the source before any change. In the project folder nothing runs: the
// commands would run there at the start anyway, and nothing is run in the person's folder before they start.
export async function sourceChecks(input: SourceChecksInput): Promise<{ items: OrchestrationReadinessItem[]; durationMs: number }> {
  const clock = input.clock ?? (() => Date.now());
  const started = clock();
  const done = (items: OrchestrationReadinessItem[]) => ({ items, durationMs: clock() - started });
  if (input.commands.length === 0) return done([]);
  if (input.workMode === "project") {
    return done([{ id: "source", level: "info", detail: "the check commands run in the project folder at the start; not run before it", facts: { mode: "project", commands: input.commands.length } }]);
  }
  const deadline = started + (input.timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
  const runId = randomUUID();
  const tmpRoot = await mkdtemp(join(input.tmp ?? tmpdir(), "canvastty-preflight-"));
  const items: OrchestrationReadinessItem[] = [];
  let ws: Workspace | null = null;
  try {
    await mkdir(join(tmpRoot, "runs", runId), { recursive: true });
    try {
      ws = await createWorkspace({ root: tmpRoot, runId, source: input.project, gitPath: input.gitPath, mode: input.workMode });
    } catch (error) {
      return done([{ id: "source", level: "warning", detail: `the temporary work folder could not be made: ${String((error as Error)?.message ?? error)}`.slice(0, 300), facts: { mode: input.workMode, code: "workspace_failed" } }]);
    }
    await cloneDependencies(ws, input.cloneDir).catch(() => []);
    const left = () => deadline - clock();
    const run = (line: string): Promise<ShellRunResult> =>
      runShell({ shell: input.rt.shell, line, cwd: ws!.repo, env: input.rt.env, launch: input.launch, timeoutMs: Math.max(1, left()), maxOutputBytes: 65_536, clock }).result;
    const outcome = (r: ShellRunResult): "passed" | "failed" | "timeout" =>
      r.stopCause === "timeout" ? "timeout" : r.exitCode === 0 && r.signal === null && !r.spawnError ? "passed" : "failed";

    // the preparation the run would do first: the profile's steps when it prepares by itself, what is still missing
    let prepared = true;
    if (input.prepare?.auto) {
      const steps = await worktreeSteps(input.project, input.prepare.steps);
      const cloned = Object.fromEntries((await readDependencyRecord(ws)).filter((d) => d.result === "cloned" && d.lock && d.sha256).map((d) => [d.lock!, d.sha256!]));
      for (const { step } of await neededSteps(ws.repo, steps, cloned)) {
        if (left() <= 0) { items.push({ id: "source_prepare", level: "warning", detail: "time is up before the preparation", facts: { command: step.command.slice(0, 200), result: "timeout" } }); prepared = false; break; }
        const r = await run(step.command);
        const result = outcome(r);
        if (result !== "passed") {
          items.push({ id: "source_prepare", level: "warning", detail: `the preparation ${result === "timeout" ? "ran out of time" : "failed"}`, facts: { command: step.command.slice(0, 200), result, exitCode: r.exitCode, output: firstLines(r.spawnError ?? r.output.head) } });
          prepared = false;
          break;
        }
      }
      if (prepared) items.push({ id: "source_prepare", level: "ok", detail: "the preparation", facts: { result: "passed" } });
    }
    for (const [i, line] of input.commands.entries()) {
      const id = `source_${i + 1}`;
      const command = line.slice(0, 200);
      if (!prepared) { items.push({ id, level: "info", detail: "not run: the preparation did not finish", facts: { command, result: "not_run" } }); continue; }
      if (left() <= 0) { items.push({ id, level: "warning", detail: "not run: time is up", facts: { command, result: "timeout" } }); continue; }
      const r = await run(line);
      const result = outcome(r);
      items.push(result === "passed"
        ? { id, level: "ok", detail: "passes on the source", facts: { command, result, durationMs: r.durationMs } }
        : { id, level: "warning", detail: result === "timeout" ? "ran out of time on the source" : "fails on the source, before any change", facts: { command, result, exitCode: r.exitCode, output: result === "failed" ? firstLines(r.spawnError ?? r.output.head) : "" } });
    }
    // commands already failing on the source would be held as required by the agents: said once, plainly
    const failing = items.filter((i) => /^source_\d+$/.test(i.id) && i.facts?.result === "failed").length;
    if (failing) items.push({ id: "source_failing", level: "warning", detail: "the checks already fail before any change", facts: { failing } });
    // said plainly: where the commands ran, and that the person's folder was not touched
    items.push({ id: "source_where", level: "info", detail: "ran in a temporary copy, removed afterwards; nothing ran in the project folder", facts: { mode: input.workMode } });
    return done(items);
  } finally {
    await removeTemporary(input, tmpRoot, runId, ws);
  }
}

// What the temporary work folder left in the project's repository: its refs (refs/canvastty/<id>/…) and, for a
// worktree, its registration and branch. Then the folder itself. Each step on its own: one failing does not keep the rest.
async function removeTemporary(input: SourceChecksInput, tmpRoot: string, runId: string, ws: Workspace | null): Promise<void> {
  const git = (...args: string[]) => say(input.gitPath, ["-C", input.project, ...args], { PATH: "/usr/bin:/bin", HOME: tmpRoot, GIT_CONFIG_NOSYSTEM: "1" }, 60_000);
  if (input.workMode === "worktree") {
    if (ws) await git("worktree", "remove", "--force", ws.repo);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    await git("worktree", "prune");
    await git("branch", "-D", ws?.branch ?? `canvastty/${runId.slice(0, 8)}`);
  }
  const refs = await git("for-each-ref", "--format=%(refname)", `refs/canvastty/${runId}/`);
  for (const ref of refs.out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(`refs/canvastty/${runId}/`))) await git("update-ref", "-d", ref);
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}
