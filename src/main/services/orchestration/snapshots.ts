// Snapshots of the managed copy (stage-3-contract.md): recovery and intermediate snapshots, stage checkpoints and
// restoring the copy. Built on the workspace.ts primitives, which run Git only in the orchestrator's control.git.
// Order with the journal: every function here finishes its Git result (create-only ref) first; the caller then
// records the matching Store event. Nothing here accepts a stage by itself, touches the source index, tree, HEAD or
// branches, or starts an agent.
import { randomUUID } from "node:crypto";
import type { WorkspaceRestore, WorkspaceState } from "./journal.ts";
import {
  WorkspaceError,
  applyTreeToCopy,
  assertNoIncompleteRestore,
  commitSnapshot,
  listSourceRefs,
  publishRef,
  readCommit,
  readCommitObject,
  readSourceRef,
  setControlRef,
  snapshotCopyTree,
  verifyWorkspace
} from "./workspace.ts";
import type { SnapshotInfo, Workspace } from "./workspace.ts";

export type SnapshotErrorCode = "checkpoint_conflict" | "checkpoint_out_of_order" | "tree_changed" | "restore_target_mismatch" | "invalid_input";

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  readonly detail: unknown;

  constructor(code: SnapshotErrorCode, message: string, detail?: unknown) {
    super(`${code}: ${message}`);
    this.name = "SnapshotError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

const fail = (code: SnapshotErrorCode, message: string, detail?: unknown): never => { throw new SnapshotError(code, message, detail); };
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// The applicable base of the copy comes from the journal (RunState.workspace.current); it is never assumed here.
// That the base is journaled cannot be checked here and stays a requirement on the caller; that it is a consistent
// commit/tree pair can be, and is.
async function requireBase(ws: Workspace, base: SnapshotInfo | undefined): Promise<SnapshotInfo> {
  if (!OID.test(base?.commit ?? "") || !OID.test(base?.tree ?? "")) fail("invalid_input", "base must be a snapshot with a commit and a tree");
  const info = await readCommit(ws, base!.commit).catch(() => fail("invalid_input", "base.commit is not a readable commit", { base }));
  if (info.tree !== base!.tree) fail("invalid_input", "base.tree is not the tree of base.commit", { commit: base!.commit, tree: info.tree, given: base!.tree });
  return base!;
}

export interface SnapshotResult { kind: "recovery" | "intermediate"; ref: string; commit: string; tree: string }
export interface CheckpointResult { stage: number; commit: string; tree: string; parent: string; reused: boolean }
export interface PreparedRestore extends WorkspaceRestore {
  recovery: SnapshotResult; // published before anything in the copy changes
  fromTree: string;
  toTree: string;
}

const trailer = (ws: Workspace, what: string) => `CanvasTTY-Snapshot: ${ws.runId}:${what}`;

// A snapshot of the copy's working tree. Recovery snapshots are published in the source repository
// (refs/canvastty/<runId>/recovery-<k>), intermediate ones stay in control.git (refs/canvastty/snapshot/<id>).
// `base` decides which paths count as tracked (a file accepted into it stays in even once a new ignore rule hides it),
// so it is required: the caller passes the copy's applicable base from the journal.
export async function createSnapshot(ws: Workspace, kind: "recovery" | "intermediate", base: SnapshotInfo): Promise<SnapshotResult> {
  if (kind !== "recovery" && kind !== "intermediate") fail("invalid_input", "kind must be recovery or intermediate");
  await verifyWorkspace(ws);
  await requireBase(ws, base);
  await assertNoIncompleteRestore(ws);
  const tree = await snapshotCopyTree(ws, base.tree);
  if (kind === "intermediate") {
    const id = randomUUID();
    const commit = await commitSnapshot(ws, tree, base.commit, `CanvasTTY intermediate snapshot\n\n${trailer(ws, `snapshot-${id}`)}\n`);
    const ref = `refs/canvastty/snapshot/${id}`;
    await setControlRef(ws, ref, commit);
    return { kind, ref, commit, tree };
  }
  // ponytail: the next free recovery number is read, then claimed create-only; a concurrent claim of the same number
  // fails with ref_conflict (no overwrite). Only one trusted service calls this per run, under the Store writer lock.
  const used = (await listSourceRefs(ws)).map((r) => /^recovery-(\d+)$/.exec(r.name)).filter((m) => m !== null).map((m) => Number(m[1]));
  const k = used.length ? Math.max(...used) + 1 : 1;
  const commit = await commitSnapshot(ws, tree, base.commit, `CanvasTTY recovery snapshot ${k}\n\n${trailer(ws, `recovery-${k}`)}\n`);
  await publishRef(ws, `recovery-${k}`, commit);
  return { kind, ref: `refs/canvastty/${ws.runId}/recovery-${k}`, commit, tree };
}

// Checkpoint of an accepted stage, only when the trusted service calls it. The parent is checkpoint n-1 (or the
// baseline for n = 1). An existing stage-<n> with the same tree and parent is the same result (reused: true);
// anything else is checkpoint_conflict and the existing ref is left as it is.
export async function createCheckpoint(ws: Workspace, stage: number, options: { expectedTree?: string } = {}): Promise<CheckpointResult> {
  if (!Number.isSafeInteger(stage) || stage < 1) fail("invalid_input", "stage must be an integer >= 1");
  await verifyWorkspace(ws);
  await assertNoIncompleteRestore(ws);
  const parent = stage === 1 ? ws.baseline.commit : await readSourceRef(ws, `stage-${stage - 1}`);
  if (parent === null) return fail("checkpoint_out_of_order", `stage-${stage - 1} does not exist`);
  const parentInfo = await readCommit(ws, parent);
  const tree = await snapshotCopyTree(ws, parentInfo.tree);
  if (options.expectedTree !== undefined && options.expectedTree !== tree) {
    fail("tree_changed", "the copy no longer matches the reviewed tree", { expected: options.expectedTree, actual: tree });
  }
  const existing = await readSourceRef(ws, `stage-${stage}`);
  if (existing !== null) return sameOrConflict(ws, stage, existing, tree, parent);
  const commit = await commitSnapshot(ws, tree, parent, `CanvasTTY checkpoint: stage ${stage}\n\n${trailer(ws, `stage-${stage}`)}\n`);
  try {
    await publishRef(ws, `stage-${stage}`, commit);
  } catch (error) {
    // someone created stage-<n> between our read and our create-only update
    if (error instanceof WorkspaceError && error.code === "ref_conflict") {
      const now = await readSourceRef(ws, `stage-${stage}`);
      if (now !== null) return sameOrConflict(ws, stage, now, tree, parent);
    }
    throw error;
  }
  return { stage, commit, tree, parent, reused: false };
}

// A stage-<n> ref this run published but whose checkpoint.created never reached the journal (stage-5-contract.md
// §12): it is taken over only if it is exactly the commit createCheckpoint writes for that intent — the recorded tree,
// the expected parent as its only parent, CanvasTTY as author and committer, and the checkpoint message with this
// run's trailer. Anything else stays an unknown ref.
export async function matchesCheckpointIntent(ws: Workspace, stage: number, commit: string,
  intent: { tree: string; parent: string }): Promise<boolean> {
  if (!Number.isSafeInteger(stage) || stage < 1) return false;
  let text: string;
  try {
    text = await readCommitObject(ws, commit);
  } catch {
    return false;
  }
  const split = text.indexOf("\n\n");
  if (split < 0) return false;
  const headers = text.slice(0, split).split("\n");
  const message = text.slice(split + 2);
  const values = (key: string) => headers.filter((h) => h.startsWith(`${key} `)).map((h) => h.slice(key.length + 1));
  const person = (v: string) => /^CanvasTTY <canvastty@localhost> \d+ [+-]\d{4}$/.test(v);
  const [authors, committers] = [values("author"), values("committer")];
  return values("tree").join() === intent.tree
    && values("parent").length === 1 && values("parent")[0] === intent.parent
    && authors.length === 1 && person(authors[0]) && committers.length === 1 && person(committers[0])
    && headers.every((h) => /^(tree|parent|author|committer) /.test(h))
    && message === `CanvasTTY checkpoint: stage ${stage}\n\n${trailer(ws, `stage-${stage}`)}\n`;
}

async function sameOrConflict(ws: Workspace, stage: number, existing: string, tree: string, parent: string): Promise<CheckpointResult> {
  const info = await readCommit(ws, existing);
  if (info.tree === tree && info.parent === parent) return { stage, commit: existing, tree, parent, reused: true };
  return fail("checkpoint_conflict", `stage-${stage} already exists with other content`, { existing, existingTree: info.tree, tree });
}

// Step 1 of a restore: checks the target against the journal's commit, then publishes a recovery snapshot of the
// copy. Nothing in the copy has changed yet. The caller records snapshot.created and workspace.restore_started.
export async function prepareRestore(ws: Workspace, target: { name: "baseline" | `stage-${number}`; commit: string },
  base: SnapshotInfo): Promise<PreparedRestore> {
  const name = target?.name;
  if (typeof name !== "string" || !/^(?:baseline|stage-[1-9]\d{0,8})$/.test(name)) fail("invalid_input", "target must be baseline or stage-<n>");
  await verifyWorkspace(ws);
  await requireBase(ws, base);
  await assertNoIncompleteRestore(ws);
  const actual = name === "baseline" ? ws.baseline.commit : await readSourceRef(ws, name);
  if (actual === null || actual !== target.commit) {
    fail("restore_target_mismatch", `${name} in the source repository is not the journal's commit`, { journal: target.commit, source: actual });
  }
  const targetInfo = await readCommit(ws, target.commit);
  const recovery = await createSnapshot(ws, "recovery", base);
  return { target: name, targetCommit: target.commit, recoveryCommit: recovery.commit, recovery, fromTree: recovery.tree, toTree: targetInfo.tree };
}

// Step 2: makes the copy's working tree equal the target for non-ignored files (removed ones are in the recovery
// snapshot); ignored files are left alone, and a target path held by an ignored file is restore_conflict with the
// copy unchanged. The copy's own .git (HEAD, index) is not touched. Returns only on a confirmed result, which is what
// lets the caller record workspace.restored; restore_incomplete means the copy's contents are unknown (restore_failed).
export async function applyRestore(ws: Workspace, prepared: PreparedRestore): Promise<{ status: "restored" }> {
  await verifyWorkspace(ws);
  await assertNoIncompleteRestore(ws);
  await applyTreeToCopy(ws, prepared.fromTree, prepared.toTree, prepared); // throws unless the result is confirmed
  return { status: "restored" };
}

// Refs of this run in the source repository compared with the journal: a ref without its event is reported, never
// accepted or deleted; a journaled ref that is gone is reported as missing.
export async function inspectWorkspaceRefs(ws: Workspace, state: WorkspaceState | null): Promise<{
  unjournaled: { name: string; commit: string }[];
  missing: { name: string; commit: string }[];
  temporary: { name: string; commit: string }[];
}> {
  const refs = await listSourceRefs(ws);
  const journaled = new Map<string, string>();
  if (state) {
    journaled.set("baseline", state.baseline.commit);
    for (const [n, c] of Object.entries(state.checkpoints)) journaled.set(`stage-${n}`, c.commit);
    for (const s of state.snapshots) if (s.kind === "recovery") journaled.set(s.ref.slice(`refs/canvastty/${ws.runId}/`.length), s.commit);
  }
  const temporary = refs.filter((r) => r.name.startsWith("tmp-"));
  const unjournaled = refs.filter((r) => !r.name.startsWith("tmp-") && journaled.get(r.name) !== r.commit);
  const missing = [...journaled].filter(([name, commit]) => !refs.some((r) => r.name === name && r.commit === commit))
    .map(([name, commit]) => ({ name, commit }));
  return { unjournaled, missing, temporary };
}
