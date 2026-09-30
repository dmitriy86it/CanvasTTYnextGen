// evidenceFingerprint (ARCHITECTURE-PROPOSAL §9, stage-4-contract.md §6): what a check result is a statement about.
// A different fingerprint makes an earlier result stale, not failed. Only names of environment variables are recorded,
// never their values, so nothing secret reaches the journal.
import { createHash } from "node:crypto";
import { canonical } from "./journal.ts";
import type { CheckStatus, NotVerifiedReason } from "./journal.ts";
import type { CheckCommand, PreparedDeps } from "./checks.ts";

export interface EvidenceFacts {
  copy: { treeBefore: string; treeAfter: string | null; base: { commit: string; tree: string } };
  command: CheckCommand & { executableSha256: string };
  // What the check actually resolved `node_modules` through: the real path of the prepared directory and a stamp of
  // every entry in it (see depsStamp in checkService.ts), not just the path and the lockfile it was installed from.
  deps: Pick<PreparedDeps, "lockfileRelPath" | "lockfileSha256"> & { nodeModulesRealpath: string; nodeModulesStamp: string };
  tools: { node: string; electron: string | null; git: string };
  platform: { platform: string; arch: string; release: string };
  sandbox: { profileSha256: string; selftest: { passed: boolean; checks: number; failed: readonly string[] } };
  env: { names: readonly string[] };
  result: {
    status: CheckStatus;
    reason: NotVerifiedReason | null;
    exitCode: number | null;
    signal: string | null;
    groupCleared: boolean;
    sandboxCleared: boolean;
  };
}

// Canonical JSON of the facts, hashed. The shape is versioned: a change in what is covered must change `v`.
export function evidenceFingerprint(f: EvidenceFacts): string {
  const body = {
    v: 2, // 2: deps name the real directory and its stamp; result says whether the sandbox scan confirmed the cleanup
    copy: { treeBefore: f.copy.treeBefore, treeAfter: f.copy.treeAfter, base: { commit: f.copy.base.commit, tree: f.copy.base.tree } },
    command: {
      id: f.command.id, executable: f.command.executable, executableSha256: f.command.executableSha256,
      argv: [...f.command.argv], timeoutMs: f.command.timeoutMs, maxOutputBytes: f.command.maxOutputBytes
    },
    deps: {
      lockfileRelPath: f.deps.lockfileRelPath, lockfileSha256: f.deps.lockfileSha256,
      nodeModulesRealpath: f.deps.nodeModulesRealpath, nodeModulesStamp: f.deps.nodeModulesStamp
    },
    tools: { node: f.tools.node, electron: f.tools.electron, git: f.tools.git },
    platform: { platform: f.platform.platform, arch: f.platform.arch, release: f.platform.release },
    sandbox: {
      profileSha256: f.sandbox.profileSha256,
      selftest: { passed: f.sandbox.selftest.passed, checks: f.sandbox.selftest.checks, failed: [...f.sandbox.selftest.failed].sort() }
    },
    env: { names: [...f.env.names].sort() }, // names only: values may hold anything
    result: {
      status: f.result.status, reason: f.result.reason, exitCode: f.result.exitCode,
      signal: f.result.signal, groupCleared: f.result.groupCleared, sandboxCleared: f.result.sandboxCleared
    }
  };
  return createHash("sha256").update(canonical(body)).digest("hex");
}

// What the fingerprint honestly does not cover (ARCHITECTURE-PROPOSAL §9): global caches (~/.npm, the Electron cache),
// other tools on PATH, external services, wall clock and locale, flaky tests, OS state, and ignored files in the copy
// other than the build artefacts the contract allows. Documented in stage-4-contract.md, not enforced here.
export const EVIDENCE_NOT_COVERED: readonly string[] = Object.freeze([
  "global_caches", "other_tools_on_path", "external_services", "clock_and_locale", "flaky_tests", "os_state", "ignored_files"
]);
