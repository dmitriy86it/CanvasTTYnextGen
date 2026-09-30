// Temporary Git repositories for the workspace tests. Every git call here is isolated from the user's config
// (GIT_CONFIG_GLOBAL points at an empty temp file, NOSYSTEM, fixed identity) and runs with hooks and fsmonitor
// disabled on the command line, so the attack scripts planted in a repository fire only if the code under test runs them.
// Paths are passed as argv, never through a shell.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "gc.auto=0"];

export function gitEnv(tmp) {
  const globalConfig = path.join(tmp, "fixture-gitconfig");
  if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, "");
  return {
    PATH: process.env.PATH,
    HOME: tmp,
    XDG_CONFIG_HOME: tmp,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@localhost",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@localhost",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"
  };
}

// Runs git in `cwd` (a work tree or a git dir). Returns trimmed stdout; `raw` returns the Buffer.
export function git(tmp, cwd, args, { input, raw = false, allowFail = false } = {}) {
  try {
    const out = execFileSync("git", [...SAFE, "-C", cwd, ...args], { env: gitEnv(tmp), input, stdio: ["pipe", "pipe", "pipe"] });
    return raw ? out : out.toString("utf8").trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${e.stderr?.toString() ?? e.message}`);
  }
}

export function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

export function initRepo(tmp, dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(tmp, dir, ["init", "-q", "-b", "main"]);
  git(tmp, dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

export function commitAll(tmp, dir, message = "commit") {
  git(tmp, dir, ["add", "-A"]);
  git(tmp, dir, ["commit", "-q", "--allow-empty", "-m", message]);
  return git(tmp, dir, ["rev-parse", "HEAD"]);
}

// A repository with one commit and every kind of path the baseline rules distinguish. `expected` is the
// relative-path -> content map (symlink: "->target") the baseline must contain.
export const FILES = {
  clean: "clean.txt",
  staged: "staged.txt",
  unstaged: "unstaged.txt",
  partial: "partial.txt",
  untracked: "new dir/untracked ü файл.txt",
  ignored: "build/ignored.out",
  trackedIgnored: "tracked.log",
  deleted: "gone.txt",
  link: "link to clean",
  spaced: "dir with space/файл ü.txt",
  globalIgnored: "secret.env"
};

export function makeRichRepo(tmp, dir) {
  initRepo(tmp, dir);
  write(dir, FILES.clean, "clean\n");
  write(dir, FILES.staged, "staged v1\n");
  write(dir, FILES.unstaged, "unstaged v1\n");
  write(dir, FILES.partial, "partial v1\n");
  write(dir, FILES.trackedIgnored, "tracked but ignored\n");
  write(dir, FILES.deleted, "will be deleted\n");
  write(dir, FILES.spaced, "unicode path\n");
  fs.symlinkSync("clean.txt", path.join(dir, FILES.link));
  write(dir, ".gitignore", "build/\n*.log\n");
  git(tmp, dir, ["add", "-f", FILES.trackedIgnored]);
  commitAll(tmp, dir, "initial");
  write(dir, FILES.staged, "staged v2\n");
  git(tmp, dir, ["add", FILES.staged]);
  write(dir, FILES.unstaged, "unstaged v2\n");
  write(dir, FILES.partial, "partial v2 (index)\n");
  git(tmp, dir, ["add", FILES.partial]);
  write(dir, FILES.partial, "partial v3 (work tree)\n");
  write(dir, FILES.untracked, "untracked\n");
  write(dir, FILES.ignored, "ignored\n");
  write(dir, FILES.globalIgnored, "SECRET=1\n");
  fs.rmSync(path.join(dir, FILES.deleted));
  const expected = {
    ".gitignore": "build/\n*.log\n",
    [FILES.clean]: "clean\n",
    [FILES.staged]: "staged v2\n",
    [FILES.unstaged]: "unstaged v2\n",
    [FILES.partial]: "partial v3 (work tree)\n",
    [FILES.trackedIgnored]: "tracked but ignored\n",
    [FILES.spaced]: "unicode path\n",
    [FILES.untracked]: "untracked\n",
    [FILES.globalIgnored]: "SECRET=1\n",
    [FILES.link]: "->clean.txt"
  };
  return { dir, expected };
}

// relative path -> content (symlink: "->target") of a work tree, `.git` excluded; names NFC-normalized.
export function readTree(dir) {
  const out = {};
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (!rel && d.name === ".git") continue;
      const p = path.join(dir, r);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[r.normalize("NFC")] = `->${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) walk(r);
      else out[r.normalize("NFC")] = fs.readFileSync(p, "utf8");
    }
  };
  walk("");
  return out;
}

// relative path -> content of the tree of a commit, read through `gitDir` (symlink: "->target").
export function readCommitTree(tmp, gitDir, commit) {
  const out = {};
  const listing = git(tmp, gitDir, ["ls-tree", "-r", "-z", commit], { raw: true }).toString("utf8");
  for (const entry of listing.split("\0").filter(Boolean)) {
    const [meta, name] = entry.split("\t");
    const [mode, , sha] = meta.split(" ");
    const blob = git(tmp, gitDir, ["cat-file", "blob", sha], { raw: true }).toString("utf8");
    out[name.normalize("NFC")] = mode === "120000" ? `->${blob}` : blob;
  }
  return out;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Everything the orchestrator must not change in a source repository: index bytes, HEAD, all refs, every
// metadata file under .git except objects/ and refs/ storage, and the work tree (tracked, untracked, ignored).
export function fingerprint(tmp, dir) {
  const gitDir = path.join(dir, ".git");
  const meta = {};
  if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
    const walk = (rel) => {
      for (const d of fs.readdirSync(path.join(gitDir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (r === "objects" || r === "refs" || r === "packed-refs") continue;
        if (d.isDirectory()) walk(r);
        else meta[r] = sha256(fs.readFileSync(path.join(gitDir, r)));
      }
    };
    walk("");
  }
  return {
    index: fs.existsSync(path.join(gitDir, "index")) ? sha256(fs.readFileSync(path.join(gitDir, "index"))) : null,
    head: git(tmp, dir, ["rev-parse", "-q", "--verify", "HEAD"], { allowFail: true }),
    refs: refs(tmp, dir).filter((l) => !l.includes(" refs/canvastty/")),
    meta,
    tree: Object.fromEntries(Object.entries(readTree(dir)).map(([k, v]) => [k, sha256(v)]))
  };
}

// "<sha> <refname>" lines for every ref of the repository.
export function refs(tmp, dir, prefix = "") {
  const out = git(tmp, dir, ["for-each-ref", "--format=%(objectname) %(refname)", ...(prefix ? [prefix] : [])], { allowFail: true });
  return out ? out.split("\n") : [];
}

// Executable scripts that append their name to `<dir>/fired.log` when anything runs them. `passthrough`
// copies stdin to stdout (a filter that "works"), otherwise the script exits 0 without reading stdin.
export class Markers {
  constructor(dir) {
    this.dir = dir;
    this.log = path.join(dir, "fired.log");
    fs.mkdirSync(dir, { recursive: true });
  }

  script(name, { passthrough = false } = {}) {
    const p = path.join(this.dir, name);
    fs.writeFileSync(p, `#!/bin/sh\necho ${name} >> '${this.log}'\n${passthrough ? "exec cat\n" : "exit 0\n"}`, { mode: 0o755 });
    return p;
  }

  // Hooks directory whose every commonly run hook is a marker.
  hooks(dir) {
    fs.mkdirSync(dir, { recursive: true });
    for (const h of ["post-checkout", "reference-transaction", "pre-auto-gc", "post-index-change", "fsmonitor-watchman", "post-merge", "pre-commit", "post-commit", "post-rewrite", "pre-push", "post-update"]) {
      fs.copyFileSync(this.script(`hook-${h}`), path.join(dir, h));
      fs.chmodSync(path.join(dir, h), 0o755);
    }
    return dir;
  }

  fired() {
    try { return fs.readFileSync(this.log, "utf8").split("\n").filter(Boolean); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  }
}

// Arms a repository's .git (source or copy) with every config-driven command vector and marker hooks.
// `.gitattributes` routes every path through filter `canvastty-x`; set it in the tree separately if wanted.
export function armGitDir(tmp, gitDir, markers, label) {
  const set = (k, v) => git(tmp, gitDir, ["config", k, v]);
  set("filter.canvastty-x.clean", markers.script(`${label}-filter-clean`, { passthrough: true }));
  set("filter.canvastty-x.smudge", markers.script(`${label}-filter-smudge`, { passthrough: true }));
  set("filter.canvastty-x.process", markers.script(`${label}-filter-process`));
  set("core.fsmonitor", markers.script(`${label}-fsmonitor`));
  set("diff.external", markers.script(`${label}-diff-external`));
  set("core.alternateRefsCommand", markers.script(`${label}-alternate-refs`));
  set("core.pager", markers.script(`${label}-pager`));
  set("core.hooksPath", markers.hooks(path.join(markers.dir, `${label}-hooks-path`)));
  markers.hooks(path.join(gitDir, "hooks"));
  write(gitDir, "info/attributes", "* filter=canvastty-x diff=canvastty-x\n");
  set("diff.canvastty-x.command", markers.script(`${label}-diff-driver`));
  set("diff.canvastty-x.textconv", markers.script(`${label}-textconv`));
}
