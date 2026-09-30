// Wiring of a project check (stage-4-contract.md §8): the trusted registry, the sandbox, the stage-3 copy and the
// journal, joined into one call. Everything that decides whether a result may be trusted lives here or in the files it
// calls; checkRunner.ts only runs the process. No branch here runs a check outside the sandbox.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { release } from "node:os";
import { join, sep } from "node:path";
import { resolveCheck } from "./checks.ts";
import type { CheckCommand, CheckRegistry, PreparedDeps } from "./checks.ts";
import { startCheck } from "./checkRunner.ts";
import type { CheckResult, PostflightResult, PreflightResult, SandboxApi } from "./checkRunner.ts";
import { evidenceFingerprint } from "./evidence.ts";
import { git } from "./git.ts";
import type { NotVerifiedReason, RunState } from "./journal.ts";
import * as sandboxModule from "./sandbox.ts";
import type { RunWriter } from "./store.ts";
import { WorkspaceError, linkDependencies, ownsDependencyLink, readIncompleteRestore, snapshotCopyTree, verifyWorkspace } from "./workspace.ts";
import type { Workspace } from "./workspace.ts";
import type { SupervisorLaunch } from "./types.ts";

export interface RunProjectCheckOptions {
  ws: Workspace;
  registry: CheckRegistry;
  id: string;
  deps: PreparedDeps;
  writer: RunWriter;
  launch: SupervisorLaunch;
  state: RunState; // the trusted journal state: its workspace.current is the applicable base
  sandbox?: SandboxApi; // sandbox.ts by default; a test may pass its own, never "no sandbox"
  sandboxExec?: string;
  clock?: () => number;
}

const hashFile = (path: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(path).on("data", (c) => hash.update(c)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
});

const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");

async function lockfileSha(ws: Workspace, deps: PreparedDeps): Promise<string | null> {
  return readFile(join(ws.repo, deps.lockfileRelPath)).then(sha256, () => null);
}

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);

// The dependencies the check resolves through, fixed before it runs and compared after it: the real prepared
// directory, the identity of the `node_modules` link in the copy (a link removed and made again is a different link,
// whatever it points at) and a stamp of every entry of the prepared directory.
interface DepsState { realpath: string; link: string; stamp: string }

class DepsRefused extends Error {
  detail: unknown;
  constructor(detail: unknown) { super("deps_changed"); this.detail = detail; }
}
const refuseDeps = (detail: unknown): never => { throw new DepsRefused(detail); };

// ponytail: a stamp of lstat facts (type, mode, size, mtime, ctime, inode, link target) per entry, not a content hash.
// ctime cannot be set back from user space, so any write shows; the stamp names these very files on this machine and
// is not portable. Hash the content if evidence ever has to be compared across machines.
// A link is accepted only when the END of its chain lies inside `dir` (the real prepared directory): what it points at
// is then an entry of this same walk and stamped as well. A link leading outside, or one that does not resolve, is
// refused — whatever it points at would be used by the check and covered by nothing. Links are never changed here.
async function depsStamp(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (rel: string): Promise<void> => {
    const entries = (await readdir(join(dir, rel))).sort();
    for (const name of entries) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const st = await lstat(join(dir, path), { bigint: true });
      let target = "";
      if (st.isSymbolicLink()) {
        target = await readlink(join(dir, path));
        const end = await realpath(join(dir, path)).catch((e) => refuseDeps({ link: path, target, error: "does not resolve", cause: String(e) }));
        if (!isInside(end, dir)) refuseDeps({ link: path, target, resolves: end, error: "points outside the prepared dependencies" });
        target += `\0${end}`;
      }
      hash.update(`${path}\0${st.mode}\0${st.size}\0${st.mtimeNs}\0${st.ctimeNs}\0${st.ino}\0${target}\n`);
      if (st.isDirectory()) await walk(path);
    }
  };
  await walk("");
  return hash.digest("hex");
}

// A `node_modules` anywhere else in the copy would be resolved before the prepared one, and nothing checks it.
async function nestedNodeModules(repo: string, rel = ""): Promise<string | null> {
  for (const entry of await readdir(join(repo, rel), { withFileTypes: true })) {
    if (rel === "" && (entry.name === ".git" || entry.name === "node_modules")) continue;
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.name === "node_modules") return path;
    if (entry.isDirectory()) {
      const found = await nestedNodeModules(repo, path);
      if (found !== null) return found;
    }
  }
  return null;
}

// The state of the dependencies as the check sees them. Only a link to the prepared directory is accepted; a
// directory the project or an agent brought, a link elsewhere or a broken one is refused and left exactly as it is.
async function readDeps(ws: Workspace, prepared: string): Promise<DepsState> {
  const link = join(ws.repo, "node_modules");
  const st = await lstat(link, { bigint: true }).catch(() => refuseDeps({ nodeModules: "missing" }));
  if (!st.isSymbolicLink()) refuseDeps({ nodeModules: "not a link to the prepared dependencies", type: st.isDirectory() ? "directory" : "other" });
  const target = await realpath(link).catch(() => null);
  if (target !== prepared) refuseDeps({ nodeModules: "points elsewhere", target, prepared });
  if (!(await ownsDependencyLink(ws))) refuseDeps({ nodeModules: "not the link the orchestrator made (replaced, or made by someone else)" });
  const nested = await nestedNodeModules(ws.repo);
  if (nested !== null) refuseDeps({ nodeModules: "another node_modules in the copy", path: nested });
  return { realpath: prepared, link: `${st.ino}:${st.birthtimeNs}`, stamp: await depsStamp(prepared) };
}

// The prepared directory must be a real directory outside the orchestration data: inside it, it would be the run's
// own writable data rather than something prepared. The link is the orchestrator's own (linkDependencies records it),
// so snapshots and checkpoints leave it out whatever the ignore rules say; it is still made BEFORE the tree is read.
async function prepareDeps(ws: Workspace, deps: PreparedDeps): Promise<DepsState> {
  const prepared = await realpath(deps.nodeModulesPath).catch(() => refuseDeps({ prepared: "missing", path: deps.nodeModulesPath }));
  if (!(await stat(prepared)).isDirectory()) refuseDeps({ prepared: "not a directory", path: prepared });
  if (isInside(prepared, await realpath(ws.root))) refuseDeps({ prepared: "inside the orchestration data", path: prepared });
  const link = join(ws.repo, "node_modules");
  if (!(await lstat(link).then(() => true, () => false))) {
    await linkDependencies(ws, prepared).catch((e) => refuseDeps({ nodeModules: `could not be linked: ${String(e)}` }));
  }
  return readDeps(ws, prepared);
}

async function depsRefusal(work: () => Promise<DepsState>): Promise<DepsState | { detail: unknown }> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DepsRefused) return { detail: error.detail };
    return { detail: String(error) };
  }
}

async function gitVersion(ws: Workspace): Promise<string> {
  const { stdout } = await git({ gitPath: ws.gitPath, gitDir: ws.control, home: join(ws.tmp, "home") }, ["--version"]);
  return stdout.toString("utf8").trim();
}

// The result, plus the dependencies it was run against (null when refused before they were read): the same realpath
// and stamp the evidence fingerprint covers, so a caller can see what the fingerprint is a statement about.
// deps and executableSha256 are what preflight saw (null / "" when it refused before looking): the facts the result is about.
export type ProjectCheckResult = CheckResult & { deps: { realpath: string; stamp: string } | null; executableSha256: string };

// The current content of a check's executable, for stable state keys (stage-5-contract.md §10). The same hash the
// evidence of a run covers; a file that cannot be read gives a marker that matches no earlier result.
export async function currentExecutableSha256(command: CheckCommand): Promise<string> {
  try {
    const real = await realpath(command.executable);
    if (real !== command.executable) return `unusable:realpath`;
    return await hashFile(real);
  } catch (error) {
    return `unusable:${(error as NodeJS.ErrnoException)?.code ?? "error"}`;
  }
}

export async function runProjectCheck(opts: RunProjectCheckOptions): Promise<ProjectCheckResult> {
  return startProjectCheck(opts).result;
}

// The dependencies a check would run against right now, without running one: the same realpath and stamp the
// evidence covers (stage-5-contract.md §10 builds its stable state keys from them). Refusals are returned, not thrown.
export async function inspectPreparedDeps(ws: Workspace, deps: PreparedDeps): Promise<
  { ok: true; realpath: string; stamp: string; lockfileSha256: string | null } | { ok: false; detail: unknown }> {
  const state = await depsRefusal(() => prepareDeps(ws, deps));
  if ("detail" in state) return { ok: false, detail: state.detail };
  return { ok: true, realpath: state.realpath, stamp: state.stamp, lockfileSha256: await lockfileSha(ws, deps) };
}

// The same check with a handle: stop() is the runner's stop (stage 4 §4), so a check can be cancelled while it runs.
export function startProjectCheck(opts: RunProjectCheckOptions): { checkRunId: string; stop(): void; result: Promise<ProjectCheckResult> } {
  const command: CheckCommand = resolveCheck(opts.registry, opts.id); // unknown_check: nothing is created
  const base = opts.state.workspace?.current ?? null;
  const sandbox = opts.sandbox ?? (sandboxModule satisfies SandboxApi);
  let executableSha256 = "";
  let tools = { node: process.versions.node, electron: process.versions.electron ?? null, git: "unknown" };
  let depsBefore: DepsState | null = null;
  let treeBefore: string | null = null;

  // Everything that must hold before a process starts. A refusal here is not_verified and writes no event.
  const preflight = async (): Promise<PreflightResult> => {
    try {
      await verifyWorkspace(opts.ws);
    } catch (error) {
      if (error instanceof WorkspaceError) {
        return { ok: false, reason: error.code === "restore_incomplete" ? "restore_incomplete" : "workspace_unverified", detail: error.detail };
      }
      throw error;
    }
    if (await readIncompleteRestore(opts.ws)) return { ok: false, reason: "restore_incomplete" };
    if (base === null) return { ok: false, reason: "workspace_unverified", detail: "the journal has no workspace" };

    // The executable is checked here as well as in the registry: the sandbox is the process leader, so a missing or
    // replaced binary would otherwise come back as a non-zero exit, i.e. a verdict of a tool that never ran.
    try {
      const real = await realpath(command.executable);
      if (real !== command.executable) return { ok: false, reason: "spawn_failed", detail: { executable: command.executable, real } };
      if (!(await stat(real)).isFile()) return { ok: false, reason: "spawn_failed", detail: { executable: real, what: "not a file" } };
      executableSha256 = await hashFile(real);
    } catch (error) {
      return { ok: false, reason: "spawn_failed", detail: { executable: command.executable, cause: String(error) } };
    }

    const lock = await lockfileSha(opts.ws, opts.deps);
    if (lock !== opts.deps.lockfileSha256) {
      return { ok: false, reason: "deps_changed", detail: { expected: opts.deps.lockfileSha256, actual: lock } };
    }
    const deps = await depsRefusal(() => prepareDeps(opts.ws, opts.deps));
    if ("detail" in deps) return { ok: false, reason: "deps_changed", detail: deps.detail };
    depsBefore = deps;
    tools = { ...tools, git: await gitVersion(opts.ws) };
    treeBefore = await snapshotCopyTree(opts.ws, base.tree);
    return { ok: true, base, treeBefore };
  };

  // What must still hold afterwards: the dependencies it was run against (checked first: a replaced link also changes
  // the tree, and the dependency is the cause) and the tree the result speaks about. Ignored build artefacts are not
  // part of the tree, so writing them is allowed; any other change means the result is not about the recorded tree.
  const postflight = async (): Promise<PostflightResult> => {
    let treeAfter: string | null = null;
    try {
      treeAfter = await snapshotCopyTree(opts.ws, base!.tree);
    } catch (error) {
      return { ok: false, reason: "tree_changed", treeAfter: null, detail: String(error) };
    }
    const before = depsBefore!;
    const after = await depsRefusal(() => readDeps(opts.ws, before.realpath));
    if ("detail" in after) return { ok: false, reason: "deps_changed", treeAfter, detail: after.detail };
    if (after.link !== before.link) return { ok: false, reason: "deps_changed", treeAfter, detail: { nodeModules: "the link was replaced during the check" } };
    if (after.stamp !== before.stamp) return { ok: false, reason: "deps_changed", treeAfter, detail: { prepared: "changed during the check", path: before.realpath } };
    const lock = await lockfileSha(opts.ws, opts.deps);
    if (lock !== opts.deps.lockfileSha256) {
      return { ok: false, reason: "deps_changed", treeAfter, detail: { expected: opts.deps.lockfileSha256, actual: lock } };
    }
    if (treeAfter !== treeBefore) return { ok: false, reason: "tree_changed", treeAfter, detail: { treeBefore, treeAfter } };
    return { ok: true, treeAfter };
  };

  const started = startCheck({
    ws: opts.ws,
    registry: opts.registry,
    id: opts.id,
    deps: opts.deps,
    writer: opts.writer,
    launch: opts.launch,
    resolveCheck,
    sandbox,
    preflight,
    postflight,
    clock: opts.clock,
    sandboxExec: opts.sandboxExec,
    evidence: (facts) => evidenceFingerprint({
      copy: {
        treeBefore: facts.copy.treeBefore ?? "",
        treeAfter: facts.copy.treeAfter,
        base: facts.copy.base ?? { commit: "", tree: "" }
      },
      command: { ...facts.command, executableSha256 },
      deps: {
        lockfileRelPath: facts.deps.lockfileRelPath, lockfileSha256: facts.deps.lockfileSha256,
        nodeModulesRealpath: depsBefore?.realpath ?? "", nodeModulesStamp: depsBefore?.stamp ?? ""
      },
      tools,
      platform: { platform: process.platform, arch: process.arch, release: release() },
      sandbox: {
        profileSha256: facts.sandbox.profileSha256 ?? "",
        selftest: {
          passed: facts.sandbox.selftest?.passed ?? false,
          checks: facts.sandbox.selftest?.checks ?? 0,
          failed: (facts.sandbox.selftest?.failed ?? []).map((f) => f.name)
        }
      },
      env: facts.env,
      result: {
        status: facts.result.status, reason: facts.result.reason as NotVerifiedReason | null,
        exitCode: facts.result.exitCode, signal: facts.result.signal,
        groupCleared: facts.result.groupCleared, sandboxCleared: facts.result.sandboxCleared
      }
    })
  });
  const result = started.result.then((r): ProjectCheckResult => {
    const deps = depsBefore as DepsState | null; // assigned inside preflight; TS keeps the initial narrowing
    return { ...r, deps: deps && { realpath: deps.realpath, stamp: deps.stamp }, executableSha256 };
  });
  return { checkRunId: started.checkRunId, stop: started.stop, result };
}
