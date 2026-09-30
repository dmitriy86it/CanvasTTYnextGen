// Stable state keys and progress of the orchestration cycle (stage-5-contract.md §10). Pure functions.
// The stage-4 evidenceFingerprint stays the record of one concrete check run: it covers the profile path, which holds
// the unique checkRunId, and the result itself, so two runs on the same state never share it. These keys cover only
// what the state is: the copy's tree, the prepared dependencies and the check definitions, including the current
// content of each check's executable (the registry's commandSha256 covers only its path, argv and limits).
import { canonical, sha256Hex } from "./journal.ts";

export interface DepsFacts { lockfileSha256: string | null; realpath: string; stamp: string }
export interface CheckDef { id: string; commandSha256: string; executableSha256: string }

export function checkKey(tree: string, check: CheckDef, deps: DepsFacts): string {
  return sha256Hex(canonical({
    v: 2, tree, checkId: check.id, commandSha256: check.commandSha256, executableSha256: check.executableSha256,
    lockfileSha256: deps.lockfileSha256, nodeModulesRealpath: deps.realpath, nodeModulesStamp: deps.stamp
  }));
}

export function runKey(tree: string, checks: readonly CheckDef[], deps: DepsFacts): string {
  return sha256Hex(canonical({
    v: 2, tree, lockfileSha256: deps.lockfileSha256, nodeModulesRealpath: deps.realpath, nodeModulesStamp: deps.stamp,
    checks: [...checks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((c) => ({ id: c.id, commandSha256: c.commandSha256, executableSha256: c.executableSha256 }))
  }));
}

export const normalizeFinding = (f: string): string => f.trim().replace(/\s+/g, " ").toLowerCase();

// Order- and spelling-insensitive identity of a set of open findings.
export function findingsKey(findings: readonly string[]): string {
  return sha256Hex(canonical([...new Set(findings.map(normalizeFinding))].sort()));
}

// One round of a stage as the lead reviewed it: the state it saw, what failed there, what it still objected to.
export interface RoundFacts {
  runKey: string;
  failing: readonly string[]; // required check ids without a passed result on that state
  findings: readonly string[]; // normalized
  findingsKey: string;
  userInput: boolean; // an answer or a clarification arrived after the previous review of this stage
  accepted: boolean;
}

// §10 progress of `cur` over `prev`. The first round of a stage has nothing to fall behind and counts as progress.
export function roundProgress(prev: RoundFacts | null, cur: RoundFacts): boolean {
  if (prev === null || cur.accepted || cur.userInput) return true;
  if (prev.findings.some((f) => !cur.findings.includes(f))) return true; // the lead closed a finding
  return cur.runKey !== prev.runKey && prev.failing.some((c) => !cur.failing.includes(c)); // a failing check now passes
}

export type LoopKind = "no_progress" | "same_findings" | "repeated_state";

// §10 loop_suspected, checked before the next executor round. `rounds` are the reviewed rounds of the current stage
// under the current plan, oldest first.
export function detectLoop(rounds: readonly RoundFacts[], noProgressRounds: number): LoopKind | null {
  if (rounds.length < 2) return null;
  const progress = rounds.map((r, i) => roundProgress(i === 0 ? null : rounds[i - 1], r));
  let stalled = 0;
  for (let i = progress.length - 1; i >= 0 && !progress[i]; i--) stalled++;
  if (stalled >= noProgressRounds) return "no_progress";
  const last = rounds[rounds.length - 1], prev = rounds[rounds.length - 2];
  if (last.findingsKey === prev.findingsKey && last.runKey !== prev.runKey && !progress[progress.length - 1]) return "same_findings";
  const outcome = (r: RoundFacts) => `${r.runKey}|${[...r.failing].sort().join(",")}`;
  for (let i = rounds.length - 2; i >= 0; i--) {
    if (progress[i + 1]) break; // progress between that round and now: the repeat is not a loop
    if (outcome(rounds[i]) === outcome(last)) return "repeated_state";
  }
  return null;
}
