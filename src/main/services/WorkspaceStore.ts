// Project workspaces (docs/agent-orchestration/implementation/workspaces-spec.md §2–§4). One JSON file in userData,
// written atomically through one queue. It holds the workspaces themselves (name, main folder, camera); which card
// belongs where is an optional field of each card in its own store, so no older file is rewritten here.
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COMMON_WORKSPACE_ID,
  type CameraState,
  type WorkspaceRecord,
  type WorkspacesResult,
  type WorkspacesState
} from "../../shared/contracts.ts";

export const WORKSPACES_FILE = "workspaces.json";
// The files that hold the canvas before workspaces; copied before the first workspaces.json is written.
export const MIGRATION_FILES = ["settings.json", "terminal-sessions.json", "browser-state.json", join("orchestration", "canvas.json")];
const MAX_WORKSPACES = 64;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const MAX_COORD = 10_000_000;

class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const refuse = (code: string, message: string): never => { throw new Refusal(code, message); };

interface FileState { v: 1; activeId: string; workspaces: WorkspaceRecord[] }

const common = (): WorkspaceRecord => ({
  id: COMMON_WORKSPACE_ID, title: "", root: null, createdAt: new Date().toISOString(), closed: false, camera: null
});

export function validCamera(value: unknown): CameraState | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Partial<CameraState>;
  if (![c.x, c.y, c.zoom].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (Math.abs(c.x!) > MAX_COORD || Math.abs(c.y!) > MAX_COORD || c.zoom! < MIN_ZOOM || c.zoom! > MAX_ZOOM) return null;
  return { x: c.x!, y: c.y!, zoom: c.zoom! };
}

// A file that is not exactly this shape is damaged: it is kept aside and the migration runs again (§3 step 2).
function parseFile(raw: string): FileState | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<FileState>;
  if (o.v !== 1 || !Array.isArray(o.workspaces) || typeof o.activeId !== "string" || o.workspaces.length > MAX_WORKSPACES) return null;
  // One bad record makes the whole file damaged: dropping it here would lose it for good with the next write.
  const workspaces: WorkspaceRecord[] = [];
  for (const w of o.workspaces) {
    if (!w || typeof w !== "object" || typeof w.id !== "string" || !ID.test(w.id) || workspaces.some((x) => x.id === w.id)) return null;
    if (typeof w.title !== "string" || w.title.length > 80 || (w.root !== null && typeof w.root !== "string") || typeof w.createdAt !== "string") return null;
    if (w.closed !== undefined && typeof w.closed !== "boolean") return null;
    const camera = w.camera == null ? null : validCamera(w.camera);
    if (w.camera != null && !camera) return null;
    workspaces.push({ id: w.id, title: w.title, root: w.root, createdAt: w.createdAt, closed: w.closed === true, camera });
  }
  // The common canvas always exists: every card without a known workspace is shown there.
  if (!workspaces.some((w) => w.id === COMMON_WORKSPACE_ID)) workspaces.unshift(common());
  if (!workspaces.some((w) => !w.closed)) workspaces[0] = { ...workspaces[0], closed: false };
  const open = workspaces.filter((w) => !w.closed);
  const activeId = open.some((w) => w.id === o.activeId) ? o.activeId : open[0].id;
  return { v: 1, activeId, workspaces };
}

function newerVersion(raw: string): boolean {
  try {
    const v = (JSON.parse(raw) as { v?: unknown } | null)?.v;
    return typeof v === "number" && v > 1;
  } catch {
    return false;
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export interface MigrationResult { state: FileState | null; error: string | null; backupDir: string | null }

// §3. Runs before any other store of the application is created (initializeServices), so the files it copies are
// still: no write queue exists yet, and the single-instance lock keeps a second process away. Each step can be
// interrupted; until workspaces.json is written (the commit), the next start begins again with a fresh copy.
export async function migrateWorkspaces(userData: string, now = () => new Date()): Promise<MigrationResult> {
  const file = join(userData, WORKSPACES_FILE);
  const raw = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : e));
  if (typeof raw === "string") {
    const parsed = parseFile(raw);
    if (parsed) return { state: parsed, error: null, backupDir: null };
    // A file of a newer build is not damage: this build leaves it alone and works without workspaces.
    if (newerVersion(raw)) return { state: null, error: "workspaces.json was written by a newer version", backupDir: null };
    try {
      await rename(file, `${file}.damaged-${randomUUID()}`);
    } catch (e) {
      return { state: null, error: `workspaces.json is damaged and could not be moved aside: ${(e as NodeJS.ErrnoException).code ?? "error"}`, backupDir: null };
    }
  } else if (raw instanceof Error) {
    return { state: null, error: `workspaces.json could not be read: ${raw.code ?? raw.message}`, backupDir: null };
  }

  const backupRoot = join(userData, "backup");
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const partial = join(backupRoot, `pre-workspaces-${stamp}.partial`);
  const done = join(backupRoot, `pre-workspaces-${stamp}`);
  try {
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    for (const name of await readdir(backupRoot)) {
      if (name.startsWith("pre-workspaces-") && name.endsWith(".partial")) await rm(join(backupRoot, name), { recursive: true, force: true });
    }
    await mkdir(partial, { recursive: true, mode: 0o700 });
    const manifest: { file: string; status: "copied" | "absent"; sha256?: string; bytes?: number }[] = [];
    for (const name of MIGRATION_FILES) {
      let bytes: Buffer;
      try {
        bytes = await readFile(join(userData, name));
      } catch (error) {
        // A file an older installation never made is not an error; any other failure to read it is.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { manifest.push({ file: name, status: "absent" }); continue; }
        throw error;
      }
      const target = join(partial, name);
      await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
      await copyFile(join(userData, name), target);
      const copied = await readFile(target);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (createHash("sha256").update(copied).digest("hex") !== sha) throw new Error(`${name} changed while it was copied`);
      manifest.push({ file: name, status: "copied", sha256: sha, bytes: bytes.length });
    }
    await writeFile(join(partial, "manifest.json"), JSON.stringify({ createdAt: now().toISOString(), files: manifest }, null, 2), { mode: 0o600 });
    await rename(partial, done);
    const state: FileState = { v: 1, activeId: COMMON_WORKSPACE_ID, workspaces: [common()] };
    await writeAtomic(file, JSON.stringify(state));
    return { state, error: null, backupDir: done };
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => {}); // the next start would remove it anyway
    const code = (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? "error";
    return { state: null, error: `the backup before workspaces could not be made: ${code}`, backupDir: null };
  }
}

// Is a workspace empty enough to be removed (§4)? Asked of the other stores when a removal is requested.
export interface WorkspaceUse { cards: number; runs: number }

export class WorkspaceStore {
  private state: FileState;
  private readonly available: boolean;
  private readonly error: string | null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly use: (id: string) => Promise<WorkspaceUse>;
  private removing: string | null = null; // while a removal counts the cards, nothing new may be placed there

  constructor(userData: string, migration: MigrationResult, use: (id: string) => Promise<WorkspaceUse>) {
    this.file = join(userData, WORKSPACES_FILE);
    this.use = use;
    this.available = migration.state !== null;
    this.error = migration.error;
    this.state = migration.state ?? { v: 1, activeId: COMMON_WORKSPACE_ID, workspaces: [common()] };
  }

  get(): WorkspacesState {
    return { available: this.available, error: this.error, activeId: this.state.activeId, workspaces: structuredClone(this.state.workspaces) };
  }

  // A card may be placed in (or moved to) an open, known workspace.
  isOpen(id: string): boolean {
    return id !== this.removing && this.state.workspaces.some((w) => w.id === id && !w.closed);
  }

  activeId(): string {
    return this.state.activeId;
  }

  // One change at a time; the file follows the state, a failed write leaves both as they were.
  private change<T>(fn: (s: FileState) => Promise<{ next: FileState; value: T }> | { next: FileState; value: T }): Promise<WorkspacesResult<T>> {
    const run = this.queue.then(async (): Promise<WorkspacesResult<T>> => {
      try {
        if (!this.available) refuse("workspaces_unavailable", this.error ?? "workspaces are not available");
        const { next, value } = await fn(this.state);
        if (next !== this.state) {
          try {
            await writeAtomic(this.file, JSON.stringify(next));
          } catch (error) {
            refuse("store_failed", `workspaces could not be saved: ${(error as NodeJS.ErrnoException)?.code ?? "error"}`);
          }
          this.state = next;
        }
        return { ok: true, value };
      } catch (error) {
        if (error instanceof Refusal) return { ok: false, code: error.code, message: error.message };
        return { ok: false, code: "internal_error", message: String((error as Error)?.message ?? error).slice(0, 300) };
      }
    });
    this.queue = run;
    return run;
  }

  private find(s: FileState, id: string): WorkspaceRecord {
    return s.workspaces.find((w) => w.id === id) ?? refuse("workspace_not_found", "no such workspace");
  }

  private withState = (next: FileState) => ({ next, value: this.snapshot(next) });
  private snapshot(s: FileState): WorkspacesState {
    return { available: this.available, error: this.error, activeId: s.activeId, workspaces: structuredClone(s.workspaces) };
  }

  create(input: { title: string; root: string | null; activate?: boolean }): Promise<WorkspacesResult<WorkspacesState>> {
    return this.change((s) => {
      if (s.workspaces.length >= MAX_WORKSPACES) refuse("too_many_workspaces", `at most ${MAX_WORKSPACES} workspaces`);
      const title = input.title.trim().slice(0, 80);
      if (!title) refuse("invalid_argument", "a workspace needs a name");
      const w: WorkspaceRecord = { id: randomUUID(), title, root: input.root, createdAt: new Date().toISOString(), closed: false, camera: null };
      return this.withState({ ...s, activeId: input.activate === false ? s.activeId : w.id, workspaces: [...s.workspaces, w] });
    });
  }

  update(id: string, patch: { title?: string; root?: string | null }): Promise<WorkspacesResult<WorkspacesState>> {
    return this.change((s) => {
      const w = this.find(s, id);
      const title = patch.title === undefined ? w.title : patch.title.trim().slice(0, 80);
      if (!title && id !== COMMON_WORKSPACE_ID) refuse("invalid_argument", "a workspace needs a name");
      const next = { ...w, title, root: patch.root === undefined ? w.root : patch.root };
      return this.withState({ ...s, workspaces: s.workspaces.map((x) => (x.id === id ? next : x)) });
    });
  }

  activate(id: string): Promise<WorkspacesResult<WorkspacesState>> {
    return this.change((s) => {
      const w = this.find(s, id);
      if (s.activeId === id && !w.closed) return { next: s, value: this.snapshot(s) };
      // opening a hidden workspace shows it again in the switcher
      return this.withState({ ...s, activeId: id, workspaces: s.workspaces.map((x) => (x.id === id ? { ...x, closed: false } : x)) });
    });
  }

  setCamera(id: string, camera: CameraState): Promise<WorkspacesResult<null>> {
    return this.change((s) => {
      this.find(s, id);
      const valid = validCamera(camera) ?? refuse("invalid_argument", "the camera must be finite and within range");
      return { next: { ...s, workspaces: s.workspaces.map((x) => (x.id === id ? { ...x, camera: valid } : x)) }, value: null };
    });
  }

  // Hiding stops nothing (§4): the processes of the workspace go on and stay reachable from the activity widget.
  close(id: string): Promise<WorkspacesResult<WorkspacesState>> {
    return this.change((s) => {
      this.find(s, id);
      const open = s.workspaces.filter((w) => !w.closed && w.id !== id);
      if (open.length === 0) refuse("last_open_workspace", "the last open workspace cannot be hidden");
      const workspaces = s.workspaces.map((x) => (x.id === id ? { ...x, closed: true } : x));
      return this.withState({ ...s, workspaces, activeId: s.activeId === id ? open[0].id : s.activeId });
    });
  }

  reopen(id: string): Promise<WorkspacesResult<WorkspacesState>> {
    return this.change((s) => {
      this.find(s, id);
      return this.withState({ ...s, workspaces: s.workspaces.map((x) => (x.id === id ? { ...x, closed: false } : x)) });
    });
  }

  // Only an empty workspace goes: no card of any kind and no run whose history belongs to it.
  remove(id: string): Promise<WorkspacesResult<WorkspacesState>> {
    const run = this.change(async (s) => {
      this.find(s, id);
      if (id === COMMON_WORKSPACE_ID) refuse("workspace_common", "the common canvas cannot be removed");
      this.removing = id; // cleared once the removal is written or refused
      const use = await this.use(id);
      if (use.cards > 0) refuse("workspace_not_empty", `the workspace still has ${use.cards} card(s)`);
      if (use.runs > 0) refuse("workspace_has_history", `the workspace holds the history of ${use.runs} run(s)`);
      const workspaces = s.workspaces.filter((x) => x.id !== id);
      if (!workspaces.some((w) => !w.closed)) refuse("last_open_workspace", "the last open workspace cannot be removed");
      const activeId = s.activeId === id ? workspaces.find((w) => !w.closed)!.id : s.activeId;
      return this.withState({ ...s, workspaces, activeId });
    });
    return run.finally(() => { this.removing = null; });
  }
}
