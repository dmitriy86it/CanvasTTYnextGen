// Seatbelt profile for a project check and the self-test that proves the profile before the project's command runs
// (docs/agent-orchestration/implementation/stage-4-contract.md §2, §3).
//
// Two invariants hold everywhere in this file:
//   - there is no fallback: nothing here ever returns "run it unsandboxed". Every failure is an exception or
//     `passed: false`, which the caller turns into not_verified(sandbox_unavailable);
//   - confidentiality of the home directory is NOT provided and NOT claimed. Reading is denied by list, not by
//     default, because no tool starts without /usr, /System, /Library and the dyld cache.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import type { SupervisorLaunch } from "./types.ts";
import type { Workspace } from "./workspace.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

const PROBE = "sandbox-probe.mjs"; // ships next to supervisor.mjs, outside the asar
const PREFIX = "canvastty-sandbox-"; // every artefact this file creates, in temporary and in run directories
const PROBE_TIMEOUT_MS = 90_000;
const DETACH_WAIT_MS = 20_000;
const STOP_GRACE_MS = 5000;

// Credential stores of the real user. Defence in depth carried over from experiments/permissions/sb/runner.sb; it is
// not a confidentiality guarantee and the self-test does not verify it (fabricating markers in the real home is not
// allowed). What the profile does guarantee is the table in contract §2.
const CRED_DIRS = [".ssh", ".aws", ".codex", ".claude", ".config/gh", ".config/git", ".docker", ".kube", ".gnupg", "Library/Keychains"];
const CRED_FILES = [".claude.json", ".npmrc", ".gitconfig", ".netrc"];

export interface SandboxPaths {
  root: string; // <root>: orchestration data; nothing below it is readable or writable except the three paths below
  repo: string; // <root>/runs/<runId>/workspace/repo — read/write, cwd of the check, its .git included
  tmp: string; // <root>/runs/<runId>/checks/<checkRunId>/tmp — read/write, TMPDIR of the check
  home: string; // <root>/runs/<runId>/checks/<checkRunId>/home — read/write, HOME of the check
  sourcePath: string; // the source project working tree — denied
  sourceGitDir: string; // Workspace.sourceGitDir — denied, except objects/ (the copy's alternates)
  nodeModules: string; // PreparedDeps.nodeModulesPath — read-only
  realHome?: string; // the home the credential deny list is relative to; os.homedir() by default
}

export interface SelftestResult {
  passed: boolean;
  checks: number;
  failed: { name: string; detail: string }[];
}

export function sandboxSupport(platform: NodeJS.Platform = process.platform): { supported: boolean; reason?: "sandbox_unavailable" } {
  if (platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return { supported: false, reason: "sandbox_unavailable" };
  return { supported: true };
}

// ---------- profile ----------

// Seatbelt string literals are C-like. A path that cannot be written as one (a newline or a control byte) is refused
// rather than escaped: it would make the profile unreadable and is never a legitimate run directory.
function sbString(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`path has control characters: ${JSON.stringify(value)}`);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

const subpath = (p: string) => `(subpath ${sbString(p)})`;
const ancestors = (p: string) => `(path-ancestors ${sbString(p)})`;

function canonical(value: unknown, what: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${what} must be an absolute path`);
  try {
    return realpathSync(value);
  } catch (error) {
    throw new Error(`${what} does not resolve to an existing path: ${value}`, { cause: error });
  }
}

interface Resolved {
  root: string; repo: string; tmp: string; home: string;
  sourcePath: string; sourceGitDir: string; sourceObjects: string; nodeModules: string; realHome: string;
}

function resolvePaths(paths: SandboxPaths): Resolved {
  if (paths === null || typeof paths !== "object") throw new Error("paths must be an object");
  const sourceGitDir = canonical(paths.sourceGitDir, "sourceGitDir");
  return {
    root: canonical(paths.root, "root"),
    repo: canonical(paths.repo, "repo"),
    tmp: canonical(paths.tmp, "tmp"),
    home: canonical(paths.home, "home"),
    sourcePath: canonical(paths.sourcePath, "sourcePath"),
    sourceGitDir,
    // Git's own layout inside the gitDir Р3 resolved; the gitDir itself is never built from sourcePath.
    sourceObjects: canonical(join(sourceGitDir, "objects"), "sourceGitDir/objects"),
    nodeModules: canonical(paths.nodeModules, "nodeModules"),
    realHome: canonical(paths.realHome ?? homedir(), "realHome")
  };
}

export function buildProfile(paths: SandboxPaths): { text: string; sha256: string } {
  const p = resolvePaths(paths);
  const creds = [...CRED_DIRS.map((d) => subpath(join(p.realHome, d))), ...CRED_FILES.map((f) => `(literal ${sbString(join(p.realHome, f))})`)];
  const text = `(version 1)
; CanvasTTY project-check sandbox — docs/agent-orchestration/implementation/stage-4-contract.md §2.
; Minimal profile: no network, no localhost, no Unix sockets, no PTY, no opt-in fragments, no -D parameters.
; Seatbelt keeps the LAST matching rule, so every broad deny stands before the narrow allows that carve out of it.
(deny default)
(import "system.sb")
(allow process-fork process-exec)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)
; Reading is denied by list, not by default: nothing runs without /usr, /bin, /System, /Library and the dyld cache.
; Confidentiality of the home directory is therefore not provided and not claimed.
(allow file-read*)
; Known credential stores of the user: defence in depth, not a confidentiality guarantee.
(deny file-read* file-write*
  ${creds.join("\n  ")})
; Orchestration data and the source project as a whole, re-opened path by path below.
(deny file-read* file-write* ${subpath(p.root)} ${subpath(p.sourcePath)} ${subpath(p.sourceGitDir)})
; This check and nothing else: the copy with its .git (the cwd), its TMPDIR and its HOME.
(allow file-read* file-write* ${subpath(p.repo)} ${subpath(p.tmp)} ${subpath(p.home)})
; stat (not readdir) of the parents of every allowed path: cd, realpath and the alternates lookup fail without it.
(allow file-read-metadata ${ancestors(p.repo)} ${ancestors(p.tmp)} ${ancestors(p.home)}
  ${ancestors(p.nodeModules)} ${ancestors(p.sourceObjects)})
; Read-only: the prepared dependencies and the source objects the copy's alternates point at.
(allow file-read* ${subpath(p.nodeModules)} ${subpath(p.sourceObjects)})
(allow file-write* (literal "/dev/null"))
`;
  return { text, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

// ---------- self-test ----------

interface Op { name: string; op: string; [key: string]: unknown }
interface Spec { ops: Op[]; out?: string }
interface ProbeResult { name: string; ok: boolean; detail: string; results?: ProbeResult[] }

// One judged pair: the control outside must succeed, the sandboxed run must match the name's prefix.
function walk(results: readonly ProbeResult[], mode: "control" | "inside", failed: { name: string; detail: string }[]): number {
  let count = 0;
  for (const r of results) {
    count++;
    const wantOk = mode === "control" || !r.name.includes("deny.");
    if (r.ok !== wantOk) {
      const name = mode === "control" ? `control.${r.name}` : r.name;
      failed.push({ name, detail: r.ok ? "the operation succeeded where a refusal was required" : `refused: ${r.detail}` });
    }
    if (Array.isArray(r.results)) count += walk(r.results, mode, failed);
  }
  return count;
}

function parseProbe(text: string): ProbeResult[] | null {
  for (const line of text.split("\n").reverse()) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      const results = (v as { results?: unknown }).results;
      if (Array.isArray(results)) return results as ProbeResult[];
    } catch { /* not the result line */ }
  }
  return null;
}

async function readWhenReady(path: string, deadline: number): Promise<ProbeResult[] | null> {
  for (;;) {
    const text = await readFile(path, "utf8").catch(() => null);
    const parsed = text === null ? null : parseProbe(text);
    if (parsed !== null) return parsed;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface Run { results: ProbeResult[] | null; detail: string }

// Every path the probe touches comes from here, so the probe itself stays layout-agnostic and usable as the control.
export async function runSelftest(opts: { dir: string; ws: Workspace; launch: SupervisorLaunch; paths: SandboxPaths }): Promise<SelftestResult> {
  const failed: { name: string; detail: string }[] = [];
  const bail = (name: string, detail: string): SelftestResult => ({ passed: false, checks: 0, failed: [{ name, detail }] });

  if (!sandboxSupport().supported) return bail("sandbox.support", `${SANDBOX_EXEC} is not available on ${process.platform}`);
  const { dir, ws, launch, paths } = opts ?? {};
  if (typeof dir !== "string" || !isAbsolute(dir)) return bail("sandbox.selftest", "dir must be an absolute path");
  const supervisor = launch?.args?.[0];
  if (typeof supervisor !== "string") return bail("sandbox.probe", "launch.args[0] must be the supervisor path");
  const probePath = join(dirname(supervisor), PROBE);
  if (!existsSync(probePath)) return bail("sandbox.probe", `the self-test probe is missing at ${probePath}`);

  let p: Resolved;
  let profile: { text: string; sha256: string };
  try {
    p = resolvePaths(paths);
    profile = buildProfile(paths);
  } catch (error) {
    return bail("sandbox.profile", String((error as Error)?.message ?? error));
  }

  const stamp = randomUUID().slice(0, 8);
  const cleanup: string[] = [];
  const servers: net.Server[] = [];

  try {
    const wsDir = canonical(ws?.dir, "ws.dir");
    const control = canonical(ws?.control, "ws.control");
    const wsTmp = canonical(ws?.tmp, "ws.tmp");
    const runDir = canonical(dirname(wsDir), "run directory");
    const texts = join(runDir, "texts");
    const locks = join(runDir, "locks");
    const profilePath = join(dir, "selftest-profile.sb");
    await writeFile(profilePath, profile.text, { mode: 0o600 });

    // Markers read by both runs: the control proves they exist and are readable, the sandboxed run must be refused.
    // Nothing is fabricated in the real home, and no real control file of the run is created or modified.
    await mkdir(join(runDir, "checks"), { recursive: true, mode: 0o700 });
    const otherCheck = await mkdtemp(join(runDir, "checks", PREFIX));
    const otherRun = join(p.root, "runs", randomUUID()); // a neighbour run: Р3 and the Store require a lowercase UUID
    await mkdir(otherRun, { recursive: true, mode: 0o700 });
    cleanup.push(otherCheck, otherRun);
    const shared = {
      restoreSlot: join(wsDir, `${PREFIX}${stamp}-restore.json`), // the directory restore.json lives in, same rule
      text: join(texts, `${PREFIX}${stamp}`),
      otherCheck: join(otherCheck, "marker"),
      otherRun: join(otherRun, "marker")
    };
    for (const path of Object.values(shared)) {
      await writeFile(path, `${PREFIX}${stamp}\n`, { mode: 0o600 });
      cleanup.push(path);
    }

    // Outside listeners: the control connects to them, the sandboxed run must not. A LAN address of this host stands
    // in for an external peer, so the check needs no internet; without one it falls back to a public address.
    // A client that destroys its end leaves ECONNRESET on this side; unhandled it would crash the caller.
    const quiet = (c: net.Socket) => { c.on("error", () => {}); c.end("ok"); };
    const tcp = net.createServer(quiet).on("error", () => {});
    servers.push(tcp);
    await new Promise<void>((res, rej) => { tcp.once("error", rej); tcp.listen({ host: "0.0.0.0", port: 0 }, res); });
    tcp.unref();
    const port = (tcp.address() as net.AddressInfo).port;
    const lan = Object.values(networkInterfaces()).flatMap((v) => v ?? []).find((i) => i.family === "IPv4" && !i.internal)?.address;
    const external = lan === undefined ? { host: "1.1.1.1", port: 443 } : { host: lan, port };

    const sockDir = await mkdtemp(join(tmpdir(), PREFIX));
    cleanup.push(sockDir);
    const sockPath = join(sockDir, "probe.sock");
    const uds = net.createServer(quiet).on("error", () => {});
    servers.push(uds);
    await new Promise<void>((res, rej) => { uds.once("error", rej); uds.listen(sockPath, res); });
    uds.unref();

    const marker = (base: string, tag: string, suffix = "") => {
      const path = join(base, `${PREFIX}${tag}-${stamp}${suffix}`);
      cleanup.push(path);
      return path;
    };

    const inherited = (tag: string, kind: string): Op[] => [
      { name: `${kind}.deny.read-workspace-json`, op: "read", path: join(wsDir, "workspace.json") },
      { name: `${kind}.deny.write-control-git`, op: "write", path: marker(control, `${tag}-${kind}`) },
      { name: `${kind}.deny.tcp-localhost`, op: "tcp", host: "127.0.0.1", port },
      { name: `${kind}.deny.ptmx`, op: "ptmx" },
      { name: `${kind}.deny.signal-outside`, op: "signal", pid: process.pid },
      { name: `${kind}.allow.write-tmp`, op: "write", path: marker(p.tmp, `${tag}-${kind}`) }
    ];

    const detachOut = (tag: string) => marker(p.tmp, tag, "-detach.json");

    const spec = (tag: string): Spec => {
      const repoFile = marker(p.repo, tag);
      const tmpFile = marker(p.tmp, tag);
      return {
        ops: [
          // allowed: the copy with its .git, the check's TMPDIR and HOME, the read-only dependencies and objects
          { name: "allow.write-repo", op: "write", path: repoFile },
          { name: "allow.read-repo", op: "read", path: repoFile },
          { name: "allow.write-repo-git", op: "write", path: marker(join(p.repo, ".git"), tag) },
          { name: "allow.readdir-repo-git", op: "readdir", path: join(p.repo, ".git"), nonEmpty: true },
          { name: "allow.write-tmp", op: "write", path: tmpFile },
          { name: "allow.read-tmp", op: "read", path: tmpFile },
          { name: "allow.write-home", op: "write", path: marker(p.home, tag) },
          { name: "allow.readdir-node-modules", op: "readdir", path: p.nodeModules, nonEmpty: true },
          { name: "allow.readdir-source-objects", op: "readdir", path: p.sourceObjects, nonEmpty: true },
          // denied: the control data of this run
          { name: "deny.read-workspace-json", op: "read", path: join(wsDir, "workspace.json") },
          { name: "deny.write-workspace-json", op: "touch", path: join(wsDir, "workspace.json") },
          { name: "deny.read-restore-json-slot", op: "read", path: shared.restoreSlot },
          { name: "deny.write-restore-json-slot", op: "write", path: marker(wsDir, tag, "-restore.json") },
          { name: "deny.read-control-git", op: "read", path: join(control, "config") },
          { name: "deny.write-control-git", op: "write", path: marker(control, tag) },
          { name: "deny.readdir-workspace-tmp", op: "readdir", path: wsTmp },
          { name: "deny.write-workspace-tmp", op: "write", path: marker(wsTmp, tag) },
          { name: "deny.read-journal", op: "read", path: join(runDir, "journal.jsonl") },
          { name: "deny.write-journal", op: "touch", path: join(runDir, "journal.jsonl") },
          { name: "deny.read-text", op: "read", path: shared.text },
          { name: "deny.readdir-texts", op: "readdir", path: texts },
          { name: "deny.write-texts", op: "write", path: marker(texts, tag) },
          { name: "deny.readdir-locks", op: "readdir", path: locks },
          { name: "deny.write-locks", op: "write", path: marker(locks, tag) },
          { name: "deny.readdir-root", op: "readdir", path: p.root },
          // denied: a neighbouring check of this run and a neighbouring run
          { name: "deny.read-other-check", op: "read", path: shared.otherCheck },
          { name: "deny.write-other-check", op: "write", path: marker(otherCheck, tag) },
          { name: "deny.read-other-run", op: "read", path: shared.otherRun },
          { name: "deny.write-other-run", op: "write", path: marker(otherRun, tag) },
          // denied: the source project, except the dependencies and the objects checked above
          { name: "deny.readdir-source-tree", op: "readdir", path: p.sourcePath, nonEmpty: true },
          { name: "deny.read-source-git-config", op: "read", path: join(p.sourceGitDir, "config") },
          // denied: anywhere else on the disk
          { name: "deny.write-user-tmpdir", op: "write", path: marker(canonical(tmpdir(), "tmpdir"), tag) },
          // denied: network, Unix sockets, PTY
          { name: "deny.tcp-localhost", op: "tcp", host: "127.0.0.1", port },
          { name: "deny.tcp-external", op: "tcp", ...external },
          { name: "deny.tcp-listen", op: "tcp-listen" },
          { name: "deny.dns", op: "dns", host: "example.com" },
          { name: "deny.unix-connect", op: "unix-connect", path: sockPath },
          { name: "deny.unix-listen", op: "unix-listen", path: marker(p.tmp, tag, ".sock") },
          { name: "deny.ptmx", op: "ptmx" },
          // signals reach the sandbox and nothing outside it: the check supervisor's scan relies on exactly this.
          // Own child first (the positive side inside), then this process, which is always outside.
          { name: "allow.signal-own-child", op: "signal-child" },
          { name: "deny.signal-outside", op: "signal", pid: process.pid },
          // the same restrictions in a child and in a detached descendant that outlives the process group
          { name: "inherit.child", op: "child", spec: { ops: inherited(tag, "child") } },
          { name: "inherit.detach", op: "detach", spec: { ops: inherited(tag, "detach"), out: detachOut(tag) } }
        ]
      };
    };

    // Positive controls first: a refusal of something unreachable proves nothing (contract §3).
    const outsideSpec = spec("control");
    const insideSpec = spec("sandbox");
    const outside = await runProbe(launch, [probePath, JSON.stringify(outsideSpec)], { env: { ...process.env, ...launch.env } });
    const outsideDetached = await readWhenReady(detachOut("control"), Date.now() + DETACH_WAIT_MS);

    const inside = await runProbe(launch, [
      ...launch.args, SANDBOX_EXEC, "-f", profilePath, "--",
      "/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", launch.command, probePath, JSON.stringify(insideSpec)
    ], {
      cwd: p.repo,
      env: {
        ...launch.env, PATH: "/usr/bin:/bin", HOME: p.home, TMPDIR: p.tmp, LANG: "C", LC_ALL: "C", TZ: "UTC", CI: "1",
        SUP_ENV_ALLOW: "PATH,HOME,TMPDIR,LANG,LC_ALL,TZ,CI"
      },
      supervised: true
    });
    const insideDetached = await readWhenReady(detachOut("sandbox"), Date.now() + DETACH_WAIT_MS);

    const judge = (run: Run, detached: ProbeResult[] | null, mode: "control" | "inside"): number => {
      const prefix = mode === "control" ? "control." : "";
      if (run.results === null) {
        failed.push({ name: `${prefix}sandbox.probe`, detail: run.detail });
        return 0;
      }
      let count = walk(run.results, mode, failed);
      if (detached === null) failed.push({ name: `${prefix}inherit.detach.result`, detail: "the detached descendant wrote no result" });
      else count += walk(detached, mode, failed);
      return count;
    };
    judge(outside, outsideDetached, "control");
    const checks = judge(inside, insideDetached, "inside");
    return { passed: failed.length === 0, checks, failed };
  } catch (error) {
    return { passed: false, checks: 0, failed: [...failed, { name: "sandbox.selftest", detail: String((error as Error)?.message ?? error) }] };
  } finally {
    for (const s of servers) s.close();
    for (const path of cleanup.reverse()) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

// The sandboxed run goes through the supervisor exactly as the project's command will (contract §4): fd0 control,
// fd1/fd2 the target's output (relayed), fd3 status, fd4 the empty task (/dev/null). The control run needs none of that.
async function runProbe(launch: SupervisorLaunch, args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; supervised?: boolean }): Promise<Run> {
  // fd4 (supervised): /dev/null, opened here and closed right after the spawn, as in checkRunner. stdio "ignore" leaves
  // fd4 to one of node's own descriptors in the supervisor, which it cannot use as the task channel (ENOTTY).
  const devNull = opts.supervised === true ? openSync("/dev/null", "r") : null;
  let child;
  try {
    child = spawn(launch.command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: devNull !== null ? ["pipe", "pipe", "pipe", "pipe", devNull] : ["ignore", "pipe", "pipe"]
    });
  } finally {
    if (devNull !== null) closeSync(devNull);
  }
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8").on("data", (d: string) => { out += d; });
  child.stderr?.setEncoding("utf8").on("data", (d: string) => { err += d; });
  (child.stdio[3] as Readable | null)?.resume(); // status lines are not judged; an unread pipe would block the supervisor

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res, rej) => {
    child.once("error", rej);
    child.once("close", (code, signal) => res({ code, signal }));
  });
  const timer = setTimeout(() => {
    // Stop through the supervisor's own channel; a control run has no channel, so it is signalled.
    if (opts.supervised === true) child.stdin?.write("{\"cmd\":\"stop\"}\n");
    else child.kill("SIGKILL");
    setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS).unref();
  }, PROBE_TIMEOUT_MS);
  let done: { code: number | null; signal: NodeJS.Signals | null };
  try {
    done = await exit;
  } catch (error) {
    clearTimeout(timer);
    return { results: null, detail: `the probe did not start: ${String((error as Error)?.message ?? error)}` };
  }
  clearTimeout(timer);
  const results = parseProbe(out);
  return { results, detail: results !== null ? "" : `no probe output (exit ${done.code}, signal ${done.signal}): ${err.slice(0, 600)}` };
}
