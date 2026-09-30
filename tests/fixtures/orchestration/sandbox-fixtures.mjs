// Throwaway fixture for the check sandbox: a source project, a real Р2 run and a real Р3 working copy, so the
// self-test and the independent probes see the actual layout instead of a hand-made imitation.
// Everything lives under one mkdtemp directory whose name starts with canvastty-sandbox-; the real $HOME is never
// touched and no fictitious credential file is ever created outside this fixture.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findGit } from "../../../src/main/services/orchestration/git.ts";
import { createRun } from "../../../src/main/services/orchestration/store.ts";
import { createWorkspace } from "../../../src/main/services/orchestration/workspace.ts";
import { commitAll, git, initRepo, write } from "./git-fixtures.mjs";

export const PREFIX = "canvastty-sandbox-";

// The names the credential deny list of the profile covers, plus one file it deliberately does not.
export const CREDENTIALS = [".ssh/id_ed25519", ".aws/credentials", ".codex/auth.json", ".claude/.credentials.json",
  ".claude.json", ".config/gh/hosts.yml", ".npmrc", ".gitconfig", ".config/git/config", "Library/Keychains/login.keychain-db",
  ".netrc", ".docker/config.json", ".kube/config", ".gnupg/pubring.kbx"];
export const READABLE_IN_HOME = "notes.txt";

export const ORCHESTRATION_DIR = path.join(fileURLToPath(new URL("../../../src/orchestration/", import.meta.url)));

export const mkbase = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)));

// A source project with a commit, an ignored node_modules with a real dependency, and a fake home around it.
export async function makeFixture() {
  const base = mkbase();
  const home = path.join(base, "fake home"); // a space in every path: the profile must quote it
  const root = path.join(home, "Library", "Application Support", "CanvasTTY");
  const source = path.join(home, "dev", "проект"); // non-ASCII: the profile is UTF-8
  const gitTmp = path.join(base, "git-home");
  fs.mkdirSync(gitTmp, { recursive: true });

  for (const rel of [...CREDENTIALS, READABLE_IN_HOME]) write(home, rel, `FIXTURE-${rel}\n`);
  initRepo(gitTmp, source);
  write(source, ".gitignore", "node_modules\n");
  write(source, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write(source, "src/app.js", 'module.exports = "app";\n');
  commitAll(gitTmp, source, "base");
  write(source, "node_modules/dep-a/index.js", 'module.exports = require("dep-b") + "-a";\n');
  write(source, "node_modules/dep-a/package.json", '{"name":"dep-a","version":"1.0.0","main":"index.js"}\n');
  write(source, "node_modules/dep-b/index.js", 'module.exports = "b";\n');
  write(source, "node_modules/dep-b/package.json", '{"name":"dep-b","version":"1.0.0","main":"index.js"}\n');

  const gitPath = findGit(process.env);
  if (gitPath === null) throw new Error("git is not on PATH");
  const runId = randomUUID();
  const writer = await createRun(root, runId, { goal: "sandbox self-test fixture" });
  const ws = await createWorkspace({ root, runId, source, gitPath });
  // The copy reaches the prepared dependencies the way the runner will: a symlink into the read-only source tree.
  fs.symlinkSync(path.join(source, "node_modules"), path.join(ws.repo, "node_modules"));

  const checkRunId = randomUUID();
  const checkDir = path.join(root, "runs", runId, "checks", checkRunId);
  fs.mkdirSync(path.join(checkDir, "tmp"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(checkDir, "home"), { recursive: true, mode: 0o700 });

  const paths = {
    root, repo: ws.repo, tmp: path.join(checkDir, "tmp"), home: path.join(checkDir, "home"),
    sourcePath: ws.sourcePath, sourceGitDir: ws.sourceGitDir,
    nodeModules: path.join(source, "node_modules"), realHome: home
  };
  const launch = { command: process.execPath, args: [path.join(ORCHESTRATION_DIR, "supervisor.mjs")], env: {} };

  return {
    base, home, root, source, runId, checkRunId, checkDir, ws, writer, paths, launch, gitTmp, gitPath,
    runDir: path.join(root, "runs", runId),
    git: (cwd, args) => git(gitTmp, cwd, args),
    async cleanup() {
      await writer.close().catch(() => {});
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

// A neighbouring run of the same root, with the lowercase UUID Р2 and Р3 require.
export function makeNeighbourRun(root) {
  const dir = path.join(root, "runs", randomUUID());
  fs.mkdirSync(path.join(dir, "workspace"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "marker.txt"), "neighbour\n");
  return dir;
}

export const env = (paths, extra = {}) => ({
  PATH: "/usr/bin:/bin", HOME: paths.home, TMPDIR: paths.tmp, LANG: "C", LC_ALL: "C", TZ: "UTC", CI: "1", ...extra
});
