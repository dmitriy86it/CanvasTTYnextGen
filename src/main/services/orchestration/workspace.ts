// Run working copy (docs/agent-orchestration/implementation/stage-3-contract.md): source repository checks, the
// orchestrator-owned bare control.git, the baseline, `clone --shared` copy, device checks and the snapshot/restore
// primitives snapshots.ts builds on. Every Git call goes through git.ts with an explicit GIT_DIR; the source repository
// only gains objects and create-only refs/canvastty/<runId>/* refs, its index, tree, HEAD and branches never change.
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { GitError, git } from "./git.ts";
import type { GitContext, GitRunOptions } from "./git.ts";
import { isUuid } from "./journal.ts";

export type WorkspaceErrorCode =
  | "run_not_found"
  | "not_a_repository"
  | "unsupported_repository"
  | "operation_in_progress"
  | "submodules_unsupported"
  | "lfs_unsupported"
  | "nested_repository"
  | "workspace_exists"
  | "workspace_foreign"
  | "workspace_not_found"
  | "workspace_tampered"
  | "copy_git_tampered"
  | "baseline_conflict"
  | "ref_conflict"
  | "restore_conflict"
  | "restore_state_changed"
  | "restore_incomplete"
  | "invalid_input"
  | "git_error";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly detail: unknown;

  constructor(code: WorkspaceErrorCode, message: string, detail?: unknown, cause?: unknown) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = "WorkspaceError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

export interface SnapshotInfo { commit: string; tree: string; parent: string | null }

// Written before the first write of a restore and removed only on a confirmed result: while it is there the copy's
// contents are unknown and every operation on the copy refuses. target/targetCommit/recoveryCommit are what the
// caller knows about the restore; applyTreeToCopy on its own knows neither and leaves them out.
export interface RestoreIntent {
  v: 1; target?: string; targetCommit?: string; recoveryCommit?: string;
  fromTree: string; toTree: string; startedAt: string;
}

// "project" (stage 12, the default): the agents work in the project folder itself, as in the user's terminal; `repo` is
// that folder, snapshots read it with a temporary index of control.git and nothing of CanvasTTY is ever written into it
// (no checkout, no restore, no link). "copy": the managed copy of stages 3–11, chosen explicitly.
// "worktree" (stage 13, explicit): a Git worktree of the project on its own branch `canvastty/<run>` from HEAD, in the
// run's folder; it works like the project folder (no restore, no link) but the user's own folder is not touched. It
// starts from HEAD: the user's uncommitted changes are not in it.
export type WorkMode = "project" | "copy" | "worktree";
// The project folder or a worktree: the agents change the files directly, nothing is ever reset by CanvasTTY.
export const inPlace = (mode: WorkMode) => mode === "project" || mode === "worktree";

export interface Workspace {
  mode: WorkMode;
  runId: string; root: string; dir: string; repo: string; control: string; tmp: string;
  sourcePath: string; sourceGitDir: string; gitPath: string;
  baseline: SnapshotInfo; head: string | null;
  branch: string | null; // the worktree's branch (worktree mode)
}

interface Marker {
  v: 1; runId: string; sourcePath: string; sourceGitDir: string; gitVersion: string; createdAt: string;
  mode?: WorkMode; // absent: "copy" (runs of stages 3–11)
  branch?: string; // worktree mode
  controlFingerprint: string; copyGitFingerprint: string;
}

const MARKER = "workspace.json";
const RESTORE = "restore.json";
const DEPS_LINK = "deps-link.json"; // the orchestrator's own node_modules link in the copy (see linkDependencies)
const DEPS_LINK_PATH = "node_modules";
const HEAVY: GitRunOptions = { timeoutMs: 10 * 60_000, maxOutputBytes: 256 * 1024 * 1024 }; // hashing / listing a whole tree
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF_NAME = /^[a-z0-9][a-z0-9-]{0,99}$/; // "baseline", "stage-3", "recovery-1", "tmp-<uuid>"
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG", "sequencer"];
const LFS = /(?:^|\s)filter=lfs(?:\s|$)/m; // ponytail: plain text match, misses lfs set through an attribute macro
const utf8 = new TextDecoder("utf-8", { fatal: true });

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const fail = (code: WorkspaceErrorCode, message: string, detail?: unknown): never => { throw new WorkspaceError(code, message, detail); };
const refPrefix = (runId: string) => `refs/canvastty/${runId}/`;
const homeOf = (ws: Workspace) => join(ws.tmp, "home");
const controlCtx = (ws: Workspace, extra: Partial<GitContext> = {}): GitContext =>
  ({ gitPath: ws.gitPath, gitDir: ws.control, home: homeOf(ws), ...extra });
const sourceCtx = (ws: Workspace): GitContext => ({ gitPath: ws.gitPath, gitDir: ws.sourceGitDir, home: homeOf(ws) });

const toWorkspaceError = (error: GitError) =>
  new WorkspaceError("git_error", error.message, { code: error.code, exitCode: error.exitCode, stderr: error.stderr }, error);

async function run(ctx: GitContext, args: readonly string[], options?: GitRunOptions): Promise<Buffer> {
  try {
    return (await git(ctx, args, options)).stdout;
  } catch (error) {
    throw error instanceof GitError ? toWorkspaceError(error) : error;
  }
}

const runText = async (ctx: GitContext, args: readonly string[], options?: GitRunOptions) => (await run(ctx, args, options)).toString("utf8").trim();

// NUL-separated output; a name that is not valid UTF-8 cannot round-trip through a JS string and is refused.
function splitZ(buf: Buffer): string[] {
  let text: string;
  try {
    text = utf8.decode(buf);
  } catch {
    return fail("invalid_input", "a path is not valid UTF-8");
  }
  const parts = text.split("\0");
  parts.pop();
  return parts;
}

// `rev-parse --verify -q` exits 1 for a missing name; anything else is an error.
async function revParse(ctx: GitContext, name: string): Promise<string | null> {
  try {
    return (await git(ctx, ["rev-parse", "--verify", "-q", name])).stdout.toString("utf8").trim();
  } catch (error) {
    if (error instanceof GitError && error.code === "git_failed" && error.exitCode === 1) return null;
    throw error instanceof GitError ? toWorkspaceError(error) : error;
  }
}

const exists = (p: string) => lstat(p).then(() => true, (e) => {
  if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return false;
  throw e;
});

// A fresh temporary index in `tmp`, removed afterwards together with its lock file.
async function withIndex<T>(tmp: string, fn: (indexFile: string) => Promise<T>): Promise<T> {
  const indexFile = join(tmp, `index-${randomUUID()}`);
  try {
    return await fn(indexFile);
  } finally {
    await rm(indexFile, { force: true });
    await rm(`${indexFile}.lock`, { force: true });
  }
}

// Where the agents work for each mode: the project folder, the run's worktree, or the managed copy.
function repoPath(mode: WorkMode, sourcePath: string, runDirPath: string, wsDir: string): string {
  return mode === "project" ? sourcePath : mode === "worktree" ? join(runDirPath, "worktree") : join(wsDir, "repo");
}

function runDir(root: string, runId: string): string {
  if (typeof root !== "string" || !isAbsolute(root)) fail("invalid_input", "root must be an absolute path");
  if (!isUuid(runId)) fail("invalid_input", "runId must be a lowercase UUID");
  return join(root, "runs", runId);
}

async function requireRun(dir: string): Promise<void> {
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) fail("run_not_found", "run directory is missing");
}

function requireAbsolute(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value)) fail("invalid_input", `${what} must be an absolute path`);
}

function requireOid(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !OID.test(value)) fail("invalid_input", `${what} must be a full object id`);
}

// ---------- fingerprints ----------

async function fingerprint(base: string, entries: readonly string[]): Promise<string> {
  const h = createHash("sha256");
  const walk = async (rel: string): Promise<void> => {
    const p = join(base, rel);
    const st = await lstat(p).catch((e) => {
      if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return null;
      throw e;
    });
    if (st === null) h.update(`${rel}\0missing\0`);
    else if (st.isSymbolicLink()) h.update(`${rel}\0link\0${await readlink(p)}\0`);
    else if (st.isDirectory()) {
      h.update(`${rel}\0dir\0`);
      for (const name of (await readdir(p)).sort()) await walk(join(rel, name));
    } else if (st.isFile()) {
      h.update(`${rel}\0file\0${st.mode & 0o7777}\0${st.size}\0`).update(await readFile(p)).update("\0");
    } else h.update(`${rel}\0other\0`);
  };
  for (const e of entries) await walk(e);
  return h.digest("hex");
}

const controlFingerprint = (control: string) =>
  fingerprint(control, ["config", "objects/info/alternates", "info", "hooks", "HEAD", "commondir", "gitdir"]);
const copyGitFingerprint = (dotGit: string) => fingerprint(dotGit, ["config", "objects/info/alternates", "info", "hooks"]);

// ---------- source inspection ----------

interface SourceInfo { path: string; gitDir: string; head: string | null; paths: string[]; objectFormat: string }

async function inspect(source: string, gitPath: string, userHome: string | undefined, home: string): Promise<SourceInfo> {
  requireAbsolute(source, "source");
  requireAbsolute(gitPath, "gitPath");
  if (userHome !== undefined) requireAbsolute(userHome, "userHome");
  const path = await realpath(source).catch(() => fail("not_a_repository", "source does not exist"));
  if (!(await stat(path)).isDirectory()) fail("not_a_repository", "source is not a directory");
  const dotGit = join(path, ".git");
  const st = await lstat(dotGit).catch(() => null);
  if (st === null) {
    if (await exists(join(path, "HEAD")) && await exists(join(path, "objects"))) fail("unsupported_repository", "bare repository");
    fail("not_a_repository", "source has no .git");
  }
  if (!st!.isDirectory()) fail("unsupported_repository", ".git is not a directory (linked worktree, submodule checkout or symlink)");
  // commondir would redirect GIT_DIR to another repository's config and hooks
  if (await exists(join(dotGit, "commondir"))) fail("unsupported_repository", ".git has a commondir file");
  const gitDir = await realpath(dotGit);
  for (const name of IN_PROGRESS) if (await exists(join(gitDir, name))) fail("operation_in_progress", `${name} present`, { marker: name });

  const bare: GitContext = { gitPath, gitDir, home };
  const tree: GitContext = { ...bare, workTree: path, userHome };
  if ((await runText(bare, ["rev-parse", "--is-bare-repository"])) === "true") fail("unsupported_repository", "core.bare is set");
  const objectFormat = await runText(bare, ["rev-parse", "--show-object-format"]);

  let head = await revParse(bare, "HEAD^{commit}");
  if (head === null) {
    // unborn only when HEAD is a symbolic ref whose target does not exist yet
    const target = await git(bare, ["symbolic-ref", "-q", "HEAD"]).then((r) => r.stdout.toString("utf8").trim(), () => null);
    if (target === null || (await revParse(bare, target)) !== null) fail("git_error", "HEAD does not resolve to a commit");
    head = null;
  }

  // index: "<tag> <mode> <oid> <stage>\t<path>"
  const tracked: string[] = [];
  const attrBlobs: string[] = [];
  for (const entry of splitZ(await run(bare, ["ls-files", "-s", "-t", "-z"], HEAVY))) {
    const tab = entry.indexOf("\t");
    const [tag, mode, oid, stage] = entry.slice(0, tab).split(" ");
    const p = entry.slice(tab + 1);
    if (stage !== "0") fail("operation_in_progress", "index has conflict stages");
    if (tag === "S") fail("unsupported_repository", "sparse checkout (skip-worktree entries) is not supported", { path: p });
    if (mode === "160000" || p === ".gitmodules") fail("submodules_unsupported", "submodules are not supported", { path: p });
    if (basename(p) === ".gitattributes") attrBlobs.push(oid);
    tracked.push(p);
  }
  if (head !== null) {
    for (const entry of splitZ(await run(bare, ["ls-tree", "-r", "-z", "--full-tree", head], HEAVY))) {
      const tab = entry.indexOf("\t");
      if (entry.startsWith("160000 ") || entry.slice(tab + 1) === ".gitmodules") fail("submodules_unsupported", "HEAD has submodules");
    }
  }

  const untracked: string[] = [];
  for (const p of splitZ(await run(tree, ["ls-files", "--others", "--exclude-standard", "-z"], { ...HEAVY, useUserGlobalConfig: true }))) {
    if (p.endsWith("/")) fail("nested_repository", "untracked nested repository", { path: p });
    if (p === ".gitmodules") fail("submodules_unsupported", "untracked .gitmodules", { path: p });
    untracked.push(p);
  }

  const attrTexts: string[] = [];
  for (const oid of attrBlobs) attrTexts.push((await run(bare, ["cat-file", "blob", oid])).toString("utf8"));
  for (const p of [...tracked, ...untracked]) {
    if (basename(p) !== ".gitattributes") continue;
    const text = await readFile(join(path, p), "utf8").catch(() => ""); // missing or not a file: nothing applies
    attrTexts.push(text);
  }
  attrTexts.push(await readFile(join(gitDir, "info", "attributes"), "utf8").catch(() => ""));
  if (attrTexts.some((t) => LFS.test(t))) fail("lfs_unsupported", "Git LFS attributes are not supported");

  return { path, gitDir, head, paths: [...tracked, ...untracked], objectFormat };
}

export async function inspectSource(source: string, opts: { gitPath: string; userHome?: string; tmp: string }): Promise<{ path: string; gitDir: string; head: string | null }> {
  requireAbsolute(opts?.tmp, "tmp");
  const { path, gitDir, head } = await inspect(source, opts.gitPath, opts.userHome, opts.tmp);
  return { path, gitDir, head };
}

// Paths that exist in the source working tree as a file or symlink and are not below a symlinked directory
// (Git refuses "beyond a symbolic link"; reading through it would leave the tree). Deleted tracked files drop out.
async function presentPaths(root: string, paths: readonly string[]): Promise<string[]> {
  const dirOk = new Map<string, boolean>();
  const realDir = async (rel: string): Promise<boolean> => {
    if (rel === "") return true;
    let ok = dirOk.get(rel);
    if (ok === undefined) {
      const slash = rel.lastIndexOf("/");
      ok = await realDir(slash < 0 ? "" : rel.slice(0, slash))
        && ((await lstat(join(root, rel)).catch(() => null))?.isDirectory() ?? false);
      dirOk.set(rel, ok);
    }
    return ok;
  };
  const out: string[] = [];
  for (const p of new Set(paths)) {
    const slash = p.lastIndexOf("/");
    if (!(await realDir(slash < 0 ? "" : p.slice(0, slash)))) continue;
    const st = await lstat(join(root, p)).catch(() => null);
    if (st?.isFile() || st?.isSymbolicLink()) out.push(p);
  }
  return out;
}

async function assertNoGitlinks(ctx: GitContext, tree: string): Promise<void> {
  for (const entry of splitZ(await run(ctx, ["ls-tree", "-r", "-z", tree], HEAVY))) {
    if (entry.startsWith("160000 ")) fail("nested_repository", "tree contains a gitlink", { path: entry.slice(entry.indexOf("\t") + 1) });
  }
}

// ---------- create / open / verify ----------

export async function createWorkspace(opts: { root: string; runId: string; source: string; gitPath: string; userHome?: string; mode?: WorkMode }): Promise<Workspace> {
  const mode: WorkMode = opts.mode ?? "copy";
  const rd = runDir(opts?.root, opts?.runId);
  requireAbsolute(opts.gitPath, "gitPath");
  await requireRun(rd);

  // 1. checks before any change; HOME for them is a throwaway empty directory
  const checkHome = await mkdtemp(join(tmpdir(), "canvastty-git-home-"));
  let info: SourceInfo;
  try {
    info = await inspect(opts.source, opts.gitPath, opts.userHome, checkHome);
  } finally {
    await rm(checkHome, { recursive: true, force: true });
  }

  // 2. exclusive workspace directory
  const dir = join(rd, "workspace");
  await mkdir(dir, { mode: 0o700 }).catch((e) => {
    if (errCode(e) === "EEXIST") fail("workspace_exists", "workspace already exists; use openWorkspace");
    throw e;
  });

  if (mode === "worktree" && info.head === null) fail("unsupported_repository", "a worktree needs a commit to start from");
  const ws: Workspace = {
    mode, runId: opts.runId, root: opts.root, dir, repo: repoPath(mode, info.path, rd, dir), control: join(dir, "control.git"), tmp: join(dir, "tmp"),
    sourcePath: info.path, sourceGitDir: info.gitDir, gitPath: opts.gitPath,
    baseline: { commit: "", tree: "", parent: info.head }, head: info.head,
    branch: mode === "worktree" ? `canvastty/${opts.runId.slice(0, 8)}` : null
  };
  try {
    await mkdir(homeOf(ws), { recursive: true, mode: 0o700 });

    // 3. control.git: no templates (no sample hooks), own config, alternates to the source objects, copied info/exclude
    await run(controlCtx(ws), ["init", "--bare", "-q", "--template=", `--object-format=${info.objectFormat}`]);
    await run(controlCtx(ws), ["config", "core.autocrlf", "false"]);
    await run(controlCtx(ws), ["config", "gc.auto", "0"]);
    await mkdir(join(ws.control, "objects", "info"), { recursive: true });
    await writeFile(join(ws.control, "objects", "info", "alternates"), `${join(info.gitDir, "objects")}\n`);
    await mkdir(join(ws.control, "info"), { recursive: true });
    await copyFile(join(info.gitDir, "info", "exclude"), join(ws.control, "info", "exclude")).catch(async (e) => {
      if (errCode(e) !== "ENOENT") throw e;
      await writeFile(join(ws.control, "info", "exclude"), "");
    });

    // 4. baseline = source working tree for tracked ∪ untracked-not-ignored paths (a worktree starts from HEAD)
    const paths = await presentPaths(info.path, info.paths);
    const tree = mode === "worktree" ? await runText(controlCtx(ws), ["rev-parse", `${info.head}^{tree}`]) : await withIndex(ws.tmp, async (indexFile) => {
      const ctx = controlCtx(ws, { workTree: info.path, indexFile });
      await run(ctx, ["read-tree", "--empty"]);
      if (paths.length > 0) await run(ctx, ["update-index", "--add", "-z", "--stdin"], { ...HEAVY, input: paths.join("\0") + "\0" });
      return runText(ctx, ["write-tree"]);
    });
    await assertNoGitlinks(controlCtx(ws), tree);
    let commit = await commitSnapshot(ws, tree, info.head, `CanvasTTY baseline\n\nCanvasTTY-Snapshot: ${ws.runId}:baseline\n`);
    try {
      await publishRef(ws, "baseline", commit);
    } catch (error) {
      if (!(error instanceof WorkspaceError && error.code === "ref_conflict")) throw error;
      const existing = (error.detail as { existing: string }).existing;
      const prev = await readCommit(ws, existing).catch(() => null);
      if (prev === null || prev.tree !== tree || prev.parent !== info.head) {
        fail("baseline_conflict", "a different baseline ref already exists in the source repository", { existing });
      }
      commit = existing; // same tree and parent: the earlier attempt's baseline is reused
    }
    await setControlRef(ws, `${refPrefix(ws.runId)}baseline`, commit);
    ws.baseline = { commit, tree, parent: info.head };

    // 5. the copy (copy mode only): shared objects, no templates, checkout by the orchestrator with a config clone just wrote
    const copyGit = join(ws.repo, ".git");
    if (mode === "copy") {
      await run({ gitPath: ws.gitPath, gitDir: copyGit, home: homeOf(ws) },
        ["clone", "--shared", "--no-checkout", "-q", "--template=", "--", info.path, ws.repo], HEAVY);
      await run({ gitPath: ws.gitPath, gitDir: copyGit, workTree: ws.repo, home: homeOf(ws) }, ["checkout", "-q", "--detach", commit], HEAVY);
    }

    // 5b. the worktree (worktree mode): a new branch at HEAD in the user's repository, visible in `git worktree list`
    if (mode === "worktree") {
      await run(sourceCtx(ws), ["worktree", "add", "-q", "-b", ws.branch!, "--", ws.repo, info.head!], HEAVY);
    }

    // 6. fingerprints and the ownership marker; only now the copy exists
    const marker: Marker = {
      v: 1, runId: ws.runId, sourcePath: info.path, sourceGitDir: info.gitDir, mode, ...(ws.branch ? { branch: ws.branch } : {}),
      gitVersion: await runText(controlCtx(ws), ["--version"]), createdAt: new Date().toISOString(),
      // The project's own .git is the user's and changes legitimately (commits, branches): not fingerprinted.
      controlFingerprint: await controlFingerprint(ws.control), copyGitFingerprint: mode === "copy" ? await copyGitFingerprint(copyGit) : ""
    };
    await writeJson(dir, MARKER, marker);
    return ws;
  } catch (error) {
    await rm(dir, { recursive: true, force: true }); // a published baseline ref stays and is reused as exists_same
    throw error;
  }
}

async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  const tmp = join(dir, `.${name}.${randomUUID()}.tmp`);
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(JSON.stringify(value));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, join(dir, name));
  await syncDir(dir);
}

// A rename or an unlink is only durable once the directory itself is synced.
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const dh = await open(dir, "r");
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

async function readMarker(dir: string, runId: string): Promise<Marker> {
  let raw: string;
  try {
    raw = await readFile(join(dir, MARKER), "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return fail("workspace_not_found", "no workspace for this run");
    throw e;
  }
  let m: Partial<Marker> | null = null;
  try {
    m = JSON.parse(raw) as Partial<Marker>;
  } catch { /* not ours */ }
  if (m?.v !== 1 || m.runId !== runId || typeof m.sourcePath !== "string" || typeof m.sourceGitDir !== "string"
    || typeof m.controlFingerprint !== "string" || typeof m.copyGitFingerprint !== "string") {
    return fail("workspace_foreign", "workspace.json does not belong to this run");
  }
  return m as Marker;
}

// Structure, control.git and source identity (workspace_tampered). The copy's .git is checked by verifyWorkspace only,
// so a run whose agent tampered with it can still be opened and inspected.
async function verifyControl(ws: Workspace, marker: Marker): Promise<void> {
  const tampered = (what: string): never => fail("workspace_tampered", `${what} was changed`, { what });
  const realRun = await realpath(runDir(ws.root, ws.runId));
  for (const [p, expected] of [[ws.dir, join(realRun, "workspace")], [ws.repo, repoPath(ws.mode, ws.sourcePath, realRun, join(realRun, "workspace"))],
    [ws.control, join(realRun, "workspace", "control.git")], [ws.tmp, join(realRun, "workspace", "tmp")]]) {
    const st = await lstat(p).catch(() => null);
    if (!st?.isDirectory() || (await realpath(p)) !== expected) tampered(basename(p));
  }
  if ((await controlFingerprint(ws.control)) !== marker.controlFingerprint) tampered("control.git");
  const srcGit = join(ws.sourcePath, ".git");
  const st = await lstat(srcGit).catch(() => null);
  if (!st?.isDirectory() || (await realpath(srcGit)) !== ws.sourceGitDir) tampered("source .git");
}

export async function openWorkspace(opts: { root: string; runId: string; gitPath: string }): Promise<Workspace> {
  const rd = runDir(opts?.root, opts?.runId);
  requireAbsolute(opts.gitPath, "gitPath");
  await requireRun(rd);
  const dir = join(rd, "workspace");
  const marker = await readMarker(dir, opts.runId);
  const mode: WorkMode = marker.mode === "project" || marker.mode === "worktree" ? marker.mode : "copy";
  const ws: Workspace = {
    mode, runId: opts.runId, root: opts.root, dir, repo: repoPath(mode, marker.sourcePath, rd, dir), control: join(dir, "control.git"), tmp: join(dir, "tmp"),
    sourcePath: marker.sourcePath, sourceGitDir: marker.sourceGitDir, gitPath: opts.gitPath,
    baseline: { commit: "", tree: "", parent: null }, head: null, branch: marker.branch ?? null
  };
  await verifyControl(ws, marker);
  // the baseline must agree between control.git and the source repository
  const inControl = await revParse(controlCtx(ws), `${refPrefix(ws.runId)}baseline`);
  const inSource = await readSourceRef(ws, "baseline");
  if (inControl === null || inControl !== inSource) return fail("workspace_tampered", "baseline refs disagree", { inControl, inSource });
  ws.baseline = await readCommit(ws, inControl);
  ws.head = ws.baseline.parent;
  return ws;
}

// Where a run's agents work, from its marker only (nothing verified, nothing written): for the view of a run no process holds.
export async function readWorkspacePlace(root: string, runId: string): Promise<{ mode: WorkMode; repo: string; branch: string | null }> {
  const rd = runDir(root, runId);
  const dir = join(rd, "workspace");
  const marker = await readMarker(dir, runId);
  const mode: WorkMode = marker.mode === "project" || marker.mode === "worktree" ? marker.mode : "copy";
  return { mode, repo: repoPath(mode, marker.sourcePath, rd, dir), branch: marker.branch ?? null };
}

export async function verifyWorkspace(ws: Workspace): Promise<void> {
  const marker = await readMarker(ws.dir, ws.runId);
  await verifyControl(ws, marker);
  if (inPlace(ws.mode)) return; // the project's .git (and the worktree's) is the user's
  const copyGit = join(ws.repo, ".git");
  const st = await lstat(copyGit).catch(() => null);
  if (!st?.isDirectory() || await exists(join(copyGit, "commondir")) || await exists(join(copyGit, "gitdir"))
    || (await copyGitFingerprint(copyGit)) !== marker.copyGitFingerprint) {
    fail("copy_git_tampered", "the copy's .git was changed");
  }
}

// ---------- an unfinished restore ----------

// The intent file of a restore that started and was not confirmed. null when there is none, and also when the file is
// unreadable JSON — assertNoIncompleteRestore keeps blocking on the file's mere presence either way.
export async function readIncompleteRestore(ws: Workspace): Promise<RestoreIntent | null> {
  const raw = await readFile(join(ws.dir, RESTORE), "utf8").catch((e) => {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return null;
    throw e;
  });
  if (raw === null) return null;
  let intent: Partial<RestoreIntent> | null = null;
  try {
    intent = JSON.parse(raw) as Partial<RestoreIntent>;
  } catch { /* present but unreadable */ }
  return intent?.v === 1 && typeof intent.fromTree === "string" && typeof intent.toTree === "string" ? intent as RestoreIntent : null;
}

// Explicit unblocking, by the user's decision only: there is no automatic rollback of a partial restore, and the
// recovery snapshot stays in the journal to be restored from as a separate, user-started restore.
export async function clearIncompleteRestore(ws: Workspace): Promise<void> {
  await rm(join(ws.dir, RESTORE), { force: true });
  await syncDir(ws.dir); // a crash must not bring the file back and block a copy the journal calls restored
}

// Every operation over the copy refuses while the intent file is there: what the copy holds is unknown.
export async function assertNoIncompleteRestore(ws: Workspace): Promise<void> {
  if (!(await exists(join(ws.dir, RESTORE)))) return;
  fail("restore_incomplete", "a restore of this copy did not finish; clear it explicitly to continue",
    { intent: await readIncompleteRestore(ws) });
}

// ---------- primitives for snapshots.ts ----------

// Tree of the copy's working tree on top of baseTree: index paths plus untracked-not-ignored (.gitignore of the copy,
// info/exclude copied from the source; no global ignore), re-read from disk; missing ones are removed.
// Paths that differ between two trees of the run (Git objects only; renames as delete + add).
export async function diffPaths(ws: Workspace, fromTree: string, toTree: string): Promise<string[]> {
  return splitZ(await run(controlCtx(ws), ["diff-tree", "-r", "-z", "--name-only", "--no-renames", fromTree, toTree], HEAVY));
}

export async function snapshotCopyTree(ws: Workspace, baseTree: string): Promise<string> {
  requireOid(baseTree, "baseTree");
  await assertNoIncompleteRestore(ws);
  return copyTree(ws, baseTree);
}

// The same rules, without the block: applyTreeToCopy checks the result of its own restore with the intent file in place.
// The orchestrator's own node_modules link is left out while it is untracked and still the one it made; anything
// the base tree tracks, and any other node_modules, counts like every other path.
async function copyTree(ws: Workspace, baseTree: string): Promise<string> {
  requireOid(baseTree, "baseTree");
  const tree = await withIndex(ws.tmp, async (indexFile) => {
    const ctx = controlCtx(ws, { workTree: ws.repo, indexFile });
    await run(ctx, ["read-tree", baseTree], HEAVY);
    let others = splitZ(await run(ctx, ["ls-files", "--others", "--exclude-standard", "-z"], HEAVY));
    const nested = others.find((p) => p.endsWith("/"));
    if (nested !== undefined) fail("nested_repository", "untracked nested repository in the copy", { path: nested });
    const known = splitZ(await run(ctx, ["ls-files", "--cached", "-z"], HEAVY));
    if (others.includes(DEPS_LINK_PATH) && !known.includes(DEPS_LINK_PATH) && await ownsDependencyLink(ws)) {
      others = others.filter((p) => p !== DEPS_LINK_PATH);
    }
    const paths = [...known, ...others];
    if (paths.length > 0) await run(ctx, ["update-index", "--add", "--remove", "--replace", "-z", "--stdin"], { ...HEAVY, input: paths.join("\0") + "\0" });
    return runText(ctx, ["write-tree"]);
  });
  await assertNoGitlinks(controlCtx(ws), tree);
  return tree;
}

// ---------- the orchestrator's node_modules link ----------

// Checks run against prepared dependencies through a symlink `node_modules` in the copy (stage-4-contract.md). That link
// is the orchestrator's, not the project's: a `node_modules/` rule does not match a symlink, and without this it would
// land in snapshots and checkpoints (with an absolute local path). Ownership is recorded next to the marker, outside the
// copy: the target and the link's identity (inode and birth time). A link removed and made again, re-pointed or made by
// anyone else no longer matches and is treated like any file of the project. The link is only ever created where
// nothing is; nothing is removed or replaced. ponytail: a crash between symlink and record leaves an unowned link that
// checks refuse (deps_changed) until it is removed by hand; an intent record first would close that.
export async function linkDependencies(ws: Workspace, target: string): Promise<void> {
  requireAbsolute(target, "target");
  if (inPlace(ws.mode)) fail("invalid_input", "the project folder keeps its own dependencies");
  const link = join(ws.repo, DEPS_LINK_PATH);
  await symlink(target, link); // EEXIST: something is there already, and it is left alone
  const st = await lstat(link, { bigint: true });
  await writeJson(ws.dir, DEPS_LINK, { v: 1, target, ino: String(st.ino), birthtimeNs: String(st.birthtimeNs) });
}

export async function ownsDependencyLink(ws: Workspace): Promise<boolean> {
  const rec = await readFile(join(ws.dir, DEPS_LINK), "utf8").then((t) => JSON.parse(t) as Record<string, unknown>, (e) => {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  });
  if (rec === null || rec.v !== 1) return false;
  const link = join(ws.repo, DEPS_LINK_PATH);
  const st = await lstat(link, { bigint: true }).catch((e) => {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  });
  if (st === null || !st.isSymbolicLink()) return false;
  return String(st.ino) === rec.ino && String(st.birthtimeNs) === rec.birthtimeNs && await readlink(link) === rec.target;
}

export async function commitSnapshot(ws: Workspace, tree: string, parent: string | null, message: string): Promise<string> {
  requireOid(tree, "tree");
  if (parent !== null) requireOid(parent, "parent");
  if (typeof message !== "string" || message.length === 0) fail("invalid_input", "message must be a non-empty string");
  const args = ["commit-tree", tree, ...(parent === null ? [] : ["-p", parent])];
  return runText(controlCtx(ws), args, { identity: true, input: message });
}

export async function readCommit(ws: Workspace, commit: string): Promise<SnapshotInfo> {
  requireOid(commit, "commit");
  const text = (await run(controlCtx(ws), ["cat-file", "commit", commit])).toString("utf8");
  const header = text.split("\n\n", 1)[0];
  const tree = /^tree ([0-9a-f]+)$/m.exec(header)?.[1];
  if (tree === undefined) return fail("git_error", "commit has no tree", { commit });
  return { commit, tree, parent: /^parent ([0-9a-f]+)$/m.exec(header)?.[1] ?? null };
}

// The whole commit object (headers and message) as Git stores it.
export async function readCommitObject(ws: Workspace, commit: string): Promise<string> {
  requireOid(commit, "commit");
  return (await run(controlCtx(ws), ["cat-file", "commit", commit])).toString("utf8");
}

// Observation (stage 11): what differs between two trees of the control repository. Git objects only: no index, no
// working tree, nothing written, so it can run next to the cycle's own Git work.
export async function diffTreeNames(ws: Workspace, fromTree: string, toTree: string, max = 2000): Promise<{
  files: { path: string; status: "added" | "modified" | "deleted" | "renamed" | "type_changed" }[]; truncated: boolean;
}> {
  requireOid(fromTree, "fromTree");
  requireOid(toTree, "toTree");
  const out = splitZ(await run(controlCtx(ws), ["diff-tree", "-r", "-z", "--no-renames", "--name-status", fromTree, toTree], HEAVY));
  const map: Record<string, "added" | "modified" | "deleted" | "renamed" | "type_changed"> = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "type_changed" };
  const files: { path: string; status: "added" | "modified" | "deleted" | "renamed" | "type_changed" }[] = [];
  for (let i = 0; i + 1 < out.length; i += 2) files.push({ path: out[i + 1], status: map[out[i][0]] ?? "modified" });
  return { files: files.slice(0, max), truncated: files.length > max };
}

export async function diffTreePath(ws: Workspace, fromTree: string, toTree: string, path: string, maxBytes = 256 * 1024): Promise<{ text: string; truncated: boolean }> {
  requireOid(fromTree, "fromTree");
  requireOid(toTree, "toTree");
  if (typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..") || path.includes("\0")) fail("invalid_input", "path must be relative");
  let buf: Buffer;
  try {
    buf = (await git(controlCtx(ws), ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", fromTree, toTree, "--", `:(literal)${path}`],
      { timeoutMs: 60_000, maxOutputBytes: maxBytes })).stdout;
  } catch (error) {
    if (error instanceof GitError && error.code === "git_output_limit") return { text: "", truncated: true };
    throw error instanceof GitError ? toWorkspaceError(error) : error;
  }
  return { text: buf.toString("utf8"), truncated: false };
}

// Create-only; an existing ref with the same commit is accepted (a retried call), any other is ref_conflict.
export async function setControlRef(ws: Workspace, ref: string, commit: string): Promise<void> {
  if (typeof ref !== "string" || !/^refs\/canvastty\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) fail("invalid_input", "ref must be under refs/canvastty/");
  requireOid(commit, "commit");
  await createRef(controlCtx(ws), ref, commit);
}

async function createRef(ctx: GitContext, ref: string, commit: string): Promise<"created" | "exists_same"> {
  const before = await revParse(ctx, ref);
  if (before === commit) return "exists_same";
  if (before !== null) fail("ref_conflict", `${ref} already points elsewhere`, { ref, existing: before });
  try {
    await git(ctx, ["update-ref", "--no-deref", ref, commit, "0".repeat(commit.length)]);
    return "created";
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    const now = await revParse(ctx, ref); // lost a race: someone created it between the check and the update
    if (now === commit) return "exists_same";
    if (now !== null) fail("ref_conflict", `${ref} already points elsewhere`, { ref, existing: now });
    throw toWorkspaceError(error);
  }
}

// refs/canvastty/<runId>/<name> in the source: objects arrive through a fetch into a temporary ref, then the target
// is created only if absent. A fetch straight into the target could fast-forward an existing ref.
export async function publishRef(ws: Workspace, name: string, commit: string): Promise<"created" | "exists_same"> {
  if (typeof name !== "string" || !REF_NAME.test(name) || name.startsWith("tmp-")) fail("invalid_input", "invalid ref name");
  requireOid(commit, "commit");
  const src = sourceCtx(ws);
  const ref = `${refPrefix(ws.runId)}${name}`;
  const existing = await revParse(src, ref);
  if (existing === commit) return "exists_same";
  if (existing !== null) fail("ref_conflict", `${ref} already points elsewhere`, { ref, existing });

  const id = randomUUID();
  const controlTmp = `refs/canvastty/tmp/${id}`;
  const sourceTmp = `${refPrefix(ws.runId)}tmp-${id}`;
  await createRef(controlCtx(ws), controlTmp, commit);
  try {
    await run(src, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-prune",
      "--", ws.control, `${controlTmp}:${sourceTmp}`], HEAVY);
    const result = await createRef(src, ref, commit);
    // a crash before this line leaves the tmp- ref: the objects stay protected, cleanup is explicit
    await run(src, ["update-ref", "--no-deref", "-d", sourceTmp]);
    return result;
  } finally {
    await git(controlCtx(ws), ["update-ref", "--no-deref", "-d", controlTmp]).catch(() => {});
  }
}

export async function readSourceRef(ws: Workspace, name: string): Promise<string | null> {
  if (typeof name !== "string" || !REF_NAME.test(name)) fail("invalid_input", "invalid ref name");
  return revParse(sourceCtx(ws), `${refPrefix(ws.runId)}${name}`);
}

export async function listSourceRefs(ws: Workspace): Promise<{ name: string; commit: string }[]> {
  const prefix = refPrefix(ws.runId);
  const out = await runText(sourceCtx(ws), ["for-each-ref", "--format=%(objectname) %(refname)", prefix]);
  return out === "" ? [] : out.split("\n").map((line) => {
    const sp = line.indexOf(" ");
    return { name: line.slice(sp + 1 + prefix.length), commit: line.slice(0, sp) };
  });
}

// Two-tree `read-tree -m -u` in control.git over the copy: fromTree must describe the copy now (the recovery snapshot).
// Ignored files are left alone: read-tree treats them as expendable, so a path the target adds that is occupied on
// disk by something fromTree does not track (or a directory holding ignored files) is refused up front.
// Three distinguishable outcomes:
//   - refused before the first write, copy unchanged: restore_conflict (a path in the way) or restore_state_changed
//     (the copy is no longer fromTree; `read-tree -m -u` only touches paths the two trees differ in, so a change made
//     after the restore was prepared would survive it unnoticed);
//   - partial or unknown: restore_incomplete, and the intent file stays for an explicit decision;
//   - confirmed: every path of toTree is on disk with its content, every path only fromTree had is gone, and the
//     intent file with it. Paths outside both trees are not touched and not checked.
// Atomicity is not claimed: `read-tree -m -u` writes one file at a time.
export async function applyTreeToCopy(ws: Workspace, fromTree: string, toTree: string,
  about: { target?: string; targetCommit?: string; recoveryCommit?: string } = {}): Promise<void> {
  requireOid(fromTree, "fromTree");
  requireOid(toTree, "toTree");
  if (inPlace(ws.mode)) fail("invalid_input", "CanvasTTY never writes into the project folder: restores exist only for a separate copy");
  await verifyWorkspace(ws); // the only primitive that writes the work tree: a swapped repo/ must not redirect it
  await assertNoIncompleteRestore(ws);
  await withIndex(ws.tmp, async (indexFile) => {
    const ctx = controlCtx(ws, { workTree: ws.repo, indexFile });
    await run(ctx, ["read-tree", fromTree], HEAVY);
    const tracked = new Set(splitZ(await run(ctx, ["ls-files", "--cached", "-z"], HEAVY)));
    const ignored = splitZ(await run(ctx, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], HEAVY));
    const added = splitZ(await run(ctx, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", "--diff-filter=A", fromTree, toTree], HEAVY));
    for (const p of added) {
      const parts = p.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join("/");
        const st = await lstat(join(ws.repo, sub)).catch(() => null);
        if (st === null) break;
        const last = i === parts.length;
        const inWay = (!st.isDirectory() && !tracked.has(sub)) || (last && st.isDirectory() && ignored.some((e) => e.startsWith(`${p}/`)));
        if (inWay) fail("restore_conflict", "an untracked or ignored file is in the way of the target tree", { path: sub });
      }
    }
    const actual = await copyTree(ws, fromTree);
    if (actual !== fromTree) {
      fail("restore_state_changed", "the copy is not the tree this restore was prepared from", { expected: fromTree, actual });
    }
    // stat info for the fresh index; files that differ from fromTree stay "modified" and block their paths
    await git(ctx, ["update-index", "-q", "--refresh"], HEAVY).catch((error) => {
      if (!(error instanceof GitError && error.code === "git_failed")) throw error;
    });
    // from here on the copy may be written: the intent file outlives a crash and blocks every later operation
    const { target, targetCommit, recoveryCommit } = about;
    await writeJson(ws.dir, RESTORE, {
      v: 1, ...(target === undefined ? {} : { target }), ...(targetCommit === undefined ? {} : { targetCommit }),
      ...(recoveryCommit === undefined ? {} : { recoveryCommit }),
      fromTree, toTree, startedAt: new Date().toISOString()
    } satisfies RestoreIntent);
    try {
      await git(ctx, ["read-tree", "-m", "-u", fromTree, toTree], HEAVY);
    } catch (error) {
      if (!(error instanceof GitError)) throw error; // not a Git result: the copy's state is unknown, the file stays
      const now = await copyTree(ws, fromTree).catch(() => null); // an unreadable copy counts as unknown
      if (now !== fromTree) {
        fail("restore_incomplete", "the restore failed partway through; the copy is neither tree",
          { stderr: error.stderr, expected: toTree, actual: now });
      }
      await clearIncompleteRestore(ws); // nothing was written after all
      if (error.code === "git_failed") fail("restore_conflict", "the copy has files in the way of the target tree", { stderr: error.stderr });
      throw toWorkspaceError(error);
    }
    // What the restore had to do, and nothing else: the index holds toTree alone, so `diff-index` never looks at
    // untracked or ignored files. Recomputing the whole tree would not do: it reads .gitignore, which the restore
    // itself rewrites, so a rule the target drops would make a file the restore rightly left alone count as a miss.
    await run(ctx, ["read-tree", toTree], HEAVY);
    await git(ctx, ["update-index", "-q", "--refresh"], HEAVY).catch((error) => {
      if (!(error instanceof GitError && error.code === "git_failed")) throw error;
    });
    const diff = await runText(ctx, ["diff-index", "--raw", toTree], HEAVY);
    if (diff !== "") fail("restore_incomplete", "the copy does not match the target tree", { expected: toTree, diff });
    // Dropped paths must be gone from disk. One exception: a dropped file whose name the target needs as a directory
    // (item -> item/child.txt). Then the directory must be there, and the file it replaced is gone by definition.
    const needed = new Set<string>();
    for (const p of splitZ(await run(ctx, ["ls-files", "--cached", "-z"], HEAVY))) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) needed.add(parts.slice(0, i).join("/"));
    }
    const removed = splitZ(await run(ctx, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", "--diff-filter=D", fromTree, toTree], HEAVY));
    for (const p of removed) {
      const st = await lstat(join(ws.repo, p)).catch(() => null);
      if (st === null) continue;
      if (st.isDirectory() && needed.has(p)) continue; // the target's own files live here now, and diff-index checked them
      fail("restore_incomplete", "a path the target tree drops is still in the copy", { path: p, directory: st.isDirectory() });
    }
    await clearIncompleteRestore(ws);
  });
}
