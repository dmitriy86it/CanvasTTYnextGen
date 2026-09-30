// Stage 13: the actions after success — commit, push to the configured branch, the configured QA deployment. Each is
// the user's own `git` or deploy command in their login shell (their identity, hooks, signing, credentials), so it
// does what it would do in their terminal. What CanvasTTY adds: an intent in the journal before the action, a result
// confirmed by a separate check (the commit in the log, the branch on the remote, the QA verification), and after an
// unknown outcome only that check — never the action again.
import type { OrchestrationQaVersion } from "../../../shared/orchestration.ts";
import type { FinishStep } from "./journal.ts";
import { shq } from "./shellRun.ts";

// paths: exactly what is committed (null in older journals: everything); tree: the checked tree the commit must hold
export interface CommitParams { message: string; paths: string[] | null; runId: string; tree?: string }
export interface PushParams { remote: string; branch: string; commit: string; tree?: string }
// reportsVersion: the verification follows the version contract (absent in older journals: it does not)
export interface QaParams { environment: string; command: string; verify: string; commit: string | null; branch: string | null; tree?: string; reportsVersion?: boolean }
export type FinishParams = { step: "commit"; commit: CommitParams } | { step: "push"; push: PushParams } | { step: "qa"; qa: QaParams };

export const trailer = (runId: string) => `CanvasTTY-Run: ${runId}`;

export function commitMessage(goalText: string, runId: string): string {
  const first = goalText.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "CanvasTTY run";
  return `${first.length > 72 ? `${first.slice(0, 71)}…` : first}\n\n${trailer(runId)}\n`;
}

// Lines of the user's shell. A fact the application reads from a line (the new commit id, the remote's addresses, the
// remote branch) is the stdout of that git command alone, redirected to a fresh result file named in the line itself
// (not through the environment, which the person's rc files may change); the shell's own output — a login shell
// without a tty prints warnings, prompts' errors, anything — is only kept as evidence, never read. `>|` writes over the
// empty file the application made even with the person's noclobber.
const into = (file: string) => `>| ${shq(file)}`;
export function commitLine(p: CommitParams, out: string): string {
  if (p.paths === null) return `git add -A && git commit -q -m ${shq(p.message)} && git rev-parse HEAD ${into(out)}`;
  const paths = p.paths.map(shq).join(" ");
  // --only: exactly these paths, whatever else the person has staged
  return `git add -A -- ${paths} && git commit -q --only -m ${shq(p.message)} -- ${paths} && git rev-parse HEAD ${into(out)}`;
}
export const pushLine = (p: PushParams) => `git push ${shq(p.remote)} ${shq(`${p.commit}:refs/heads/${p.branch}`)}`;
export const remoteHeadLine = (p: { remote: string; branch: string }, out: string) => `git ls-remote ${shq(p.remote)} ${shq(`refs/heads/${p.branch}`)} ${into(out)}`;
// Every address the remote fetches from and pushes to (pushurl and insteadOf/pushInsteadOf expanded), each list in its
// own file: both must be there, and every address in them must be the one the person allowed.
export const remoteUrlLine = (remote: string, fetchOut: string, pushOut: string) =>
  `git remote get-url --all ${shq(remote)} ${into(fetchOut)} && git remote get-url --push --all ${shq(remote)} ${into(pushOut)}`;
export function remoteUrlsMatch(fetch: string | null, push: string | null, allowed: string): boolean {
  const urls = (text: string | null) => (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f = urls(fetch), p = urls(push);
  return f.length > 0 && p.length > 0 && [...f, ...p].every((u) => u === allowed);
}
// The version contract: a passing verification writes the commit id it observed on the environment to the fresh file
// $CANVASTTY_QA_RESULT. Only its first non-empty line counts, and only a full id; the command's text and output never do.
export function qaVersion(report: string | null, expected: string | null): { version: OrchestrationQaVersion; observed: string | null } {
  const first = (report ?? "").split(/\r?\n/).map((l) => l.trim().toLowerCase()).find((l) => l !== "");
  if (!first) return { version: "not_reported", observed: null };
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(first)) return { version: "invalid", observed: null };
  return { version: first === expected ? "confirmed" : "mismatch", observed: first };
}
export const findCommitLine = (runId: string, out: string) => `git log -n 1 --format=%H --fixed-strings --grep=${shq(trailer(runId))} HEAD ${into(out)}`;

// Values the QA commands can use: which commit and branch were delivered.
export function qaEnv(p: QaParams): Record<string, string> {
  return {
    CANVASTTY_QA_ENVIRONMENT: p.environment,
    ...(p.commit ? { CANVASTTY_COMMIT: p.commit } : {}),
    ...(p.branch ? { CANVASTTY_BRANCH: p.branch } : {})
  };
}

// A result file holding exactly one full commit id (`git rev-parse HEAD`, `git log --format=%H`), or null.
export const resultOid = (text: string | null): string | null => /^(?:[0-9a-f]{40}|[0-9a-f]{64})\n?$/.exec(text ?? "")?.[0].trim() ?? null;
// `git ls-remote <remote> refs/heads/<b>`: the commit the branch points at, or null when it is absent.
export function remoteHead(text: string, branch: string): string | null {
  for (const l of text.split(/\r?\n/)) {
    const [oid, ref] = l.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && /^[0-9a-f]{40,64}$/.test(oid ?? "")) return oid;
  }
  return null;
}

export const FINISH_STEPS: readonly FinishStep[] = ["commit", "push", "qa"];
