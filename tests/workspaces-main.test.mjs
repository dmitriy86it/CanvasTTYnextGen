// Project workspaces in main (docs/agent-orchestration/implementation/workspaces-spec.md §2–§4, §7 M1–M8): the
// migration keeps every older file byte for byte and survives an interruption at each step; the owner of a run is
// written with its reservation; a linked group moves only whole and only without an unfinished run; history stays
// with its workspace; only an empty workspace can be removed. Anonymised fixtures in a temporary folder only.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { COMMON_WORKSPACE_ID } from "../src/shared/contracts.ts";
import { runOwners, workspaceOf } from "../src/shared/workspaceOwnership.ts";
import { migrateWorkspaces, MIGRATION_FILES, WorkspaceStore, WORKSPACES_FILE } from "../src/main/services/WorkspaceStore.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { normalizePersistedTerminalSessions, persistedTerminalSession } from "../src/main/services/TerminalSessionStore.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager } from "../src/main/services/orchestration/manager.ts";
import { createTestAgents, executed, plan, review } from "./fixtures/orchestration/test-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-workspaces-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const MAC = { skip: process.platform !== "darwin" && "runs check in the macOS sandbox", timeout: 180_000 };
const ROOT = process.getuid?.() === 0;

// An older installation: every kind of canvas item, with positions, sizes and a link with a finished run's id.
let n = 0;
function oldUserData() {
  const dir = path.join(TMP, `ud-${++n}`);
  fs.mkdirSync(path.join(dir, "orchestration"), { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    settingsVersion: 15, persistCanvasRegions: true, persistStickyNotes: true,
    canvasRegions: [{ id: "region-1", title: "Backend", color: "#AABBCC", position: { x: 10, y: 20 }, size: { width: 800, height: 600 } }],
    stickyNotes: [{ id: "note-1", text: "todo", position: { x: 30, y: 40 }, size: { width: 300, height: 220 } }],
    pluginCanvas: [{ id: "plug-1", pluginId: "example.plugin", contributionId: "canvas", title: "Plugin", position: { x: 50, y: 60 }, size: { width: 400, height: 300 } }],
    browserCanvas: { position: { x: 70, y: 80 }, size: { width: 920, height: 620 } }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "terminal-sessions.json"), JSON.stringify({ version: 1, sessions: [
    { id: "term-1", provider: "terminal", profile: "normal", title: "shell", titleCustomized: false, cwd: "/tmp", position: { x: 90, y: 100 }, size: { width: 700, height: 430 } }
  ] }));
  fs.writeFileSync(path.join(dir, "browser-state.json"), JSON.stringify({ version: 1, tabs: [{ id: "t1", url: "https://example.com/" }], activeTabId: "t1" }));
  const lead = randomUUID(), exec = randomUUID();
  fs.writeFileSync(path.join(dir, "orchestration", "canvas.json"), JSON.stringify({ v: 1, agents: [
    { agentId: lead, provider: "codex", role: "lead", project: "/tmp", bounds: { position: { x: 110, y: 120 }, size: { width: 300, height: 222 } }, createdAt: "2026-09-01T00:00:00Z" },
    { agentId: exec, provider: "claude", role: "executor", project: "/tmp", bounds: { position: { x: 500, y: 120 }, size: { width: 300, height: 222 } }, createdAt: "2026-09-01T00:00:00Z" }
  ], links: [{ linkId: randomUUID(), fromAgentId: lead, toAgentId: exec, createdAt: "2026-09-01T00:00:00Z", runIds: [randomUUID()] }] }));
  return dir;
}
// The application's own reading of a settings file (on a copy, so the file itself is not touched).
async function normalizeSettings(value) {
  const dir = fs.mkdtempSync(path.join(TMP, "settings-"));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(value));
  const store = new SettingsStore(dir, "en");
  await store.load();
  return store.get();
}
const fileHashes = (dir) => Object.fromEntries(MIGRATION_FILES.filter((f) => fs.existsSync(path.join(dir, f))).map((f) => [f, sha(path.join(dir, f))]));
const backups = (dir) => (fs.existsSync(path.join(dir, "backup")) ? fs.readdirSync(path.join(dir, "backup")).sort() : []);

test("M1: the migration rewrites no older file, keeps every card on the common canvas and copies the files first; a repeat changes nothing", async () => {
  const dir = oldUserData();
  const before = fileHashes(dir);
  const r = await migrateWorkspaces(dir);
  assert.equal(r.error, null);
  assert.deepEqual(fileHashes(dir), before, "no older file changed");
  assert.deepEqual(r.state.workspaces.map((w) => [w.id, w.closed, w.camera]), [[COMMON_WORKSPACE_ID, false, null]]);
  const manifest = JSON.parse(fs.readFileSync(path.join(r.backupDir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.files.map((f) => [f.file, f.status, f.sha256]), MIGRATION_FILES.map((f) => [f, "copied", before[f]]));
  for (const f of MIGRATION_FILES) assert.equal(sha(path.join(r.backupDir, f)), before[f]);

  // every card of every kind is read back as it was and belongs to the common canvas
  const known = (id) => r.state.workspaces.some((w) => w.id === id);
  const settings = await normalizeSettings(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")));
  const items = [...settings.canvasRegions, ...settings.stickyNotes, ...settings.pluginCanvas, settings.browserCanvas];
  assert.deepEqual(items.map((i) => [i.position.x, i.position.y, i.size.width, i.size.height]),
    [[10, 20, 800, 600], [30, 40, 300, 220], [50, 60, 400, 300], [70, 80, 920, 620]]);
  const terms = normalizePersistedTerminalSessions(JSON.parse(fs.readFileSync(path.join(dir, "terminal-sessions.json"), "utf8"))).sessions;
  const canvas = JSON.parse(fs.readFileSync(path.join(dir, "orchestration", "canvas.json"), "utf8"));
  for (const item of [...items, ...terms, ...canvas.agents]) assert.equal(workspaceOf(item, known), COMMON_WORKSPACE_ID);
  assert.equal(runOwners(canvas, known)(canvas.links[0].runIds[0]), COMMON_WORKSPACE_ID, "an older run belongs to the common canvas");

  const again = await migrateWorkspaces(dir);
  assert.equal(again.backupDir, null, "no second backup");
  assert.deepEqual(again.state, r.state);
  assert.equal(backups(dir).length, 1);
});

test("M2: an interrupted migration finishes on the next start; a missing optional file is absent, another read error stops the migration", async () => {
  // interrupted inside the copy: a partial backup and no workspaces.json
  const dir = oldUserData();
  fs.mkdirSync(path.join(dir, "backup", "pre-workspaces-2026-01-01T00-00-00-000Z.partial"), { recursive: true });
  fs.writeFileSync(path.join(dir, "backup", "pre-workspaces-2026-01-01T00-00-00-000Z.partial", "settings.json"), "half");
  const r = await migrateWorkspaces(dir);
  assert.equal(r.error, null);
  assert.deepEqual(backups(dir).filter((b) => b.endsWith(".partial")), [], "the partial copy is gone");
  assert.ok(fs.existsSync(path.join(dir, WORKSPACES_FILE)));

  // interrupted after the copy, before the commit: the next start copies again and commits
  const dir2 = oldUserData();
  const first = await migrateWorkspaces(dir2, () => new Date("2026-02-01T00:00:00Z"));
  fs.rmSync(path.join(dir2, WORKSPACES_FILE));
  const second = await migrateWorkspaces(dir2, () => new Date("2026-02-02T00:00:00Z"));
  assert.equal(second.error, null);
  assert.notEqual(second.backupDir, first.backupDir);
  assert.ok(fs.existsSync(path.join(dir2, WORKSPACES_FILE)));

  // an installation that never made some files
  const dir3 = path.join(TMP, "ud-fresh");
  fs.mkdirSync(dir3);
  fs.writeFileSync(path.join(dir3, "settings.json"), "{}");
  const fresh = await migrateWorkspaces(dir3);
  const manifest = JSON.parse(fs.readFileSync(path.join(fresh.backupDir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.files.map((f) => [f.file, f.status]), [["settings.json", "copied"], ...MIGRATION_FILES.slice(1).map((f) => [f, "absent"])]);
});

test("M2: a file that cannot be read stops the migration; nothing is changed and workspaces are refused until the next start", { skip: ROOT && "root reads every file" }, async () => {
  const dir = oldUserData();
  const before = fileHashes(dir);
  fs.chmodSync(path.join(dir, "terminal-sessions.json"), 0o000);
  try {
    const r = await migrateWorkspaces(dir);
    assert.equal(r.state, null);
    assert.match(r.error, /EACCES/);
    assert.equal(fs.existsSync(path.join(dir, WORKSPACES_FILE)), false);
    assert.deepEqual(backups(dir), [], "no half backup left");
    const store = new WorkspaceStore(dir, r, async () => ({ cards: 0, runs: 0 }));
    assert.deepEqual([store.get().available, store.get().workspaces.map((w) => w.id)], [false, [COMMON_WORKSPACE_ID]]);
    const refused = await store.create({ title: "A", root: null });
    assert.equal(refused.code, "workspaces_unavailable");
  } finally {
    fs.chmodSync(path.join(dir, "terminal-sessions.json"), 0o600);
  }
  assert.deepEqual(fileHashes(dir), before);
  assert.equal((await migrateWorkspaces(dir)).error, null, "the next start migrates");
});

test("M3/M4: a damaged workspaces.json is kept aside and made again; a card of an unknown workspace is shown on the common canvas", async () => {
  const dir = oldUserData();
  await migrateWorkspaces(dir);
  fs.writeFileSync(path.join(dir, WORKSPACES_FILE), "{ not json");
  const r = await migrateWorkspaces(dir);
  assert.equal(r.error, null);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(`${WORKSPACES_FILE}.damaged-`)));
  assert.equal(backups(dir).length, 2, "a new backup before the new file");
  const known = (id) => r.state.workspaces.some((w) => w.id === id);
  assert.equal(workspaceOf({ workspaceId: "gone-workspace" }, known), COMMON_WORKSPACE_ID);
  assert.equal(runOwners({ agents: [], links: [], owners: { r1: "gone-workspace" } }, known)("r1"), COMMON_WORKSPACE_ID);
});

test("M3: one invalid record makes the whole workspaces.json damaged: kept aside byte for byte, never rewritten without it", async () => {
  const rec = (extra = {}) => ({ id: "alpha", title: "Alpha", root: "/tmp/alpha", createdAt: "2026-09-01T00:00:00.000Z", closed: false, camera: { x: 1, y: 2, zoom: 1 }, ...extra });
  const commonRec = { id: COMMON_WORKSPACE_ID, title: "", root: null, createdAt: "2026-09-01T00:00:00.000Z", closed: false, camera: null };
  const { createdAt: _c, ...noCreatedAt } = rec();
  const { id: _i, ...noId } = rec();
  const bad = {
    "no createdAt": [noCreatedAt], "no id": [noId], "id not a string": [rec({ id: 7 })], "duplicate id": [rec(), rec()],
    "title too long": [rec({ title: "x".repeat(81) })], "title not a string": [rec({ title: null })], "root not a string": [rec({ root: 1 })],
    "closed not boolean": [rec({ closed: "yes" })], "camera out of range": [rec({ camera: { x: 0, y: 0, zoom: 99 } })],
    "too many": Array.from({ length: 64 }, (_, i) => rec({ id: `w${i}` }))
  };
  for (const [what, records] of Object.entries(bad)) {
    const dir = oldUserData();
    const original = JSON.stringify({ v: 1, activeId: COMMON_WORKSPACE_ID, workspaces: [commonRec, ...records] });
    fs.writeFileSync(path.join(dir, WORKSPACES_FILE), original);
    const r = await migrateWorkspaces(dir);
    assert.equal(r.error, null, what);
    assert.deepEqual(r.state.workspaces.map((w) => w.id), [COMMON_WORKSPACE_ID], `${what}: the migration ran again`);
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith(`${WORKSPACES_FILE}.damaged-`));
    assert.equal(kept.length, 1, what);
    assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), original, `${what}: the original bytes are kept`);
    assert.equal(backups(dir).length, 1, `${what}: a backup before the new file`);
  }
  // Normalizations that lose nothing stay: a missing common is added, all hidden reopens one, a stale activeId is fixed;
  // absent closed and camera are allowed.
  const dir = oldUserData();
  const { closed: _d, camera: _e, ...plain } = rec({ id: "beta" });
  fs.writeFileSync(path.join(dir, WORKSPACES_FILE), JSON.stringify({ v: 1, activeId: "gone", workspaces: [rec({ closed: true }), plain] }));
  const r = await migrateWorkspaces(dir);
  assert.deepEqual(r.state.workspaces.map((w) => [w.id, w.closed, w.camera]), [[COMMON_WORKSPACE_ID, false, null], ["alpha", true, { x: 1, y: 2, zoom: 1 }], ["beta", false, null]]);
  assert.equal(r.state.activeId, COMMON_WORKSPACE_ID);
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes(".damaged-")));
});

test("M3: a workspaces.json of a newer build is left alone and workspaces are unavailable; a removal closes the workspace to new cards while it counts", async () => {
  const dir = oldUserData();
  const newer = JSON.stringify({ v: 2, activeId: "x", workspaces: [] });
  fs.writeFileSync(path.join(dir, WORKSPACES_FILE), newer);
  const r = await migrateWorkspaces(dir);
  assert.equal(r.state, null);
  assert.match(r.error, /newer version/);
  assert.equal(fs.readFileSync(path.join(dir, WORKSPACES_FILE), "utf8"), newer, "not moved aside, not rewritten");
  assert.deepEqual(backups(dir), [], "no backup either");

  const dir2 = path.join(TMP, "ud-removing");
  fs.mkdirSync(dir2);
  let seen = null;
  let store;
  store = new WorkspaceStore(dir2, await migrateWorkspaces(dir2), async (id) => { seen = store.isOpen(id); return { cards: 0, runs: 0 }; });
  const id = (await store.create({ title: "Alpha", root: null, activate: false })).value.workspaces[1].id;
  assert.equal(store.isOpen(id), true);
  assert.equal((await store.remove(id)).ok, true);
  assert.equal(seen, false, "no card can be placed there while the removal counts");
  const kept = (await store.create({ title: "Beta", root: null, activate: false })).value.workspaces.at(-1).id;
  store = new WorkspaceStore(dir2, await migrateWorkspaces(dir2), async () => ({ cards: 1, runs: 0 }));
  assert.equal((await store.remove(kept)).code, "workspace_not_empty");
  assert.equal(store.isOpen(kept), true, "a refused removal leaves the workspace open");
});

test("the workspaceId of every item survives the application's own normalizers", async () => {
  const s = await normalizeSettings({
    persistCanvasRegions: true, persistStickyNotes: true,
    canvasRegions: [{ id: "r", title: "R", color: "#112233", position: { x: 0, y: 0 }, size: { width: 400, height: 300 }, workspaceId: "ws-a" }],
    stickyNotes: [{ id: "n", text: "", position: { x: 0, y: 0 }, size: { width: 300, height: 220 }, workspaceId: "ws-a" }],
    pluginCanvas: [{ id: "p", pluginId: "example.plugin", contributionId: "canvas", title: "P", position: { x: 0, y: 0 }, size: { width: 400, height: 300 }, workspaceId: "ws-a" }],
    browserCanvas: { position: { x: 0, y: 0 }, size: { width: 920, height: 620 }, workspaceId: "ws-a" }
  });
  assert.deepEqual([...s.canvasRegions, ...s.stickyNotes, ...s.pluginCanvas, s.browserCanvas].map((i) => i.workspaceId), ["ws-a", "ws-a", "ws-a", "ws-a"]);
  const bad = await normalizeSettings({ persistStickyNotes: true, stickyNotes: [{ id: "n", text: "", position: { x: 0, y: 0 }, size: { width: 300, height: 220 }, workspaceId: "../x" }] });
  assert.equal(bad.stickyNotes[0].workspaceId, undefined, "an invalid id is dropped: the note is on the common canvas");
  const t = persistedTerminalSession({ id: "t", provider: "terminal", profile: "normal", title: "x", titleCustomized: false, cwd: "/tmp",
    position: { x: 1, y: 2 }, size: { width: 700, height: 430 }, workspaceId: "ws-a" });
  assert.equal(normalizePersistedTerminalSessions({ version: 1, sessions: [t] }).sessions[0].workspaceId, "ws-a");
});

test("M8: the store refuses removing a workspace with cards or history, the common canvas and the last open one; hiding stops nothing", async () => {
  const dir = path.join(TMP, "ud-store");
  fs.mkdirSync(dir);
  const use = new Map();
  const store = new WorkspaceStore(dir, await migrateWorkspaces(dir), async (id) => use.get(id) ?? { cards: 0, runs: 0 });
  const a = (await store.create({ title: "Alpha", root: "/tmp" })).value;
  const aId = a.activeId;
  assert.deepEqual(a.workspaces.map((w) => w.title), ["", "Alpha"]);
  use.set(aId, { cards: 1, runs: 0 });
  assert.equal((await store.remove(aId)).code, "workspace_not_empty");
  use.set(aId, { cards: 0, runs: 2 });
  assert.equal((await store.remove(aId)).code, "workspace_has_history");
  assert.equal((await store.remove(COMMON_WORKSPACE_ID)).code, "workspace_common");
  // hide both: the last open one stays
  assert.equal((await store.close(COMMON_WORKSPACE_ID)).ok, true);
  assert.equal((await store.close(aId)).code, "last_open_workspace");
  const reopened = (await store.activate(COMMON_WORKSPACE_ID)).value;
  assert.deepEqual([reopened.activeId, reopened.workspaces.find((w) => w.id === COMMON_WORKSPACE_ID).closed], [COMMON_WORKSPACE_ID, false]);
  use.set(aId, { cards: 0, runs: 0 });
  assert.equal((await store.remove(aId)).ok, true, "an empty workspace goes");
  // the file follows: a restart reads the same state
  const again = new WorkspaceStore(dir, await migrateWorkspaces(dir), async () => ({ cards: 0, runs: 0 }));
  assert.deepEqual(again.get().workspaces.map((w) => w.id), [COMMON_WORKSPACE_ID]);
});

test("W3 in main: a camera write names its workspace; a late write for A never changes B; out-of-range cameras are refused", async () => {
  const dir = path.join(TMP, "ud-camera");
  fs.mkdirSync(dir);
  const store = new WorkspaceStore(dir, await migrateWorkspaces(dir), async () => ({ cards: 0, runs: 0 }));
  const bId = (await store.create({ title: "B", root: null })).value.activeId;
  await store.setCamera(bId, { x: 5, y: 6, zoom: 1 });
  await store.setCamera(COMMON_WORKSPACE_ID, { x: -100, y: 40, zoom: 0.5 }); // the late write of the workspace left
  const cams = Object.fromEntries(store.get().workspaces.map((w) => [w.id, w.camera]));
  assert.deepEqual(cams, { [COMMON_WORKSPACE_ID]: { x: -100, y: 40, zoom: 0.5 }, [bId]: { x: 5, y: 6, zoom: 1 } });
  assert.equal((await store.setCamera(bId, { x: Infinity, y: 0, zoom: 1 })).code, "invalid_argument");
  assert.equal((await store.setCamera(bId, { x: 0, y: 0, zoom: 0 })).code, "invalid_argument");
  const restarted = new WorkspaceStore(dir, await migrateWorkspaces(dir), async () => ({ cards: 0, runs: 0 }));
  assert.deepEqual(restarted.get().workspaces.find((w) => w.id === bId).camera, { x: 5, y: 6, zoom: 1 });
  assert.equal(restarted.activeId(), bId, "the active workspace is kept");
});

// Orchestration: owners, links and groups.
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: TMP,
  GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
function project() {
  const src = path.join(TMP, `src-${++n}`);
  fs.cpSync(path.join(HERE, "fixtures", "orchestration", "check-project"), src, { recursive: true });
  fs.rmSync(path.join(src, "tests", "broken.test.mjs"));
  fs.mkdirSync(path.join(src, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
  g(src, "init", "-q", "-b", "main");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fixture");
  return src;
}
const OPEN = new Set([COMMON_WORKSPACE_ID, "ws-a", "ws-b"]);
const managerDeps = (root) => ({
  root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000, workspaceOpen: (id) => OPEN.has(id), workspaceKnown: (id) => OPEN.has(id),
  agents: async () => createTestAgents({ plan: { report: plan("only stage") }, execute: { report: executed() }, review: { report: review("accept") }, final_review: { report: review("complete") } })
});
const manager = (root) => createRunManager(managerDeps(root));
const box = (x = 0) => ({ position: { x, y: 0 }, size: { width: 300, height: 222 } });
const goal = (extra = {}) => ({ text: "extend sum", criteria: ["sum works"], checks: ["node-test"], ...extra });
const code = (r) => (r.ok ? "ok" : r.code);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (await fn()) return;
  throw new Error(`not reached: ${what}`);
}
// A run to "completed" passes its check in the macOS sandbox. Where that sandbox cannot be applied (the tests run
// inside another sandbox) the run pauses with sandbox_unavailable by design and can never complete: say so at once,
// with the run's state, instead of timing out without it.
async function untilCompleted(m, runId) {
  let last = null;
  await until(async () => {
    const v = (await m.get(runId)).value?.view;
    last = v ? `${v.status}${v.reason ? `:${v.reason}` : ""}` : "no view";
    if (v?.status === "paused" && v.reason === "sandbox_unavailable") {
      throw new Error("the run paused with sandbox_unavailable: the check sandbox cannot be applied in this environment (a nested sandbox?)");
    }
    return v?.status === "completed";
  }, "completed").catch((error) => { throw new Error(`${error.message} (last state: ${last})`); });
}
async function group(m, src, ws) {
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds: box(), workspaceId: ws })).value;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds: box(400), workspaceId: ws })).value;
  const link = (await m.createLink({ linkId: randomUUID(), fromAgentId: lead.agentId, toAgentId: exec.agentId })).value;
  return { lead, exec, link };
}

test("cards go only to an open workspace, and a link joins cards of one workspace only", async () => {
  const m = manager(path.join(TMP, "orch-rules"));
  const src = project();
  assert.equal(code(await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds: box(), workspaceId: "ws-gone" })), "workspace_unavailable");
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds: box(), workspaceId: "ws-a" })).value;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds: box(), workspaceId: "ws-b" })).value;
  assert.equal(code(await m.createLink({ linkId: randomUUID(), fromAgentId: lead.agentId, toAgentId: exec.agentId })), "link_workspaces");
  // a repeat of a create with another workspace is not the same card
  assert.equal(code(await m.createAgent({ agentId: lead.agentId, provider: "codex", project: src, bounds: box(), workspaceId: "ws-b" })), "request_conflict");
  await m.shutdown();
});

test("§1 in links: a card of an unknown workspace is on the common canvas and links with a common card; a hidden workspace is not common", async () => {
  const known = new Set([COMMON_WORKSPACE_ID, "ws-x", "ws-hidden"]);
  const open = new Set([COMMON_WORKSPACE_ID, "ws-x", "ws-hidden"]);
  const m = createRunManager({ ...managerDeps(path.join(TMP, "orch-known")), workspaceOpen: (id) => open.has(id), workspaceKnown: (id) => known.has(id) });
  const src = project();
  const card = async (provider, ws) => (await m.createAgent({ agentId: randomUUID(), provider, project: src, bounds: box(), workspaceId: ws })).value;
  const link = async (a, b) => code(await m.createLink({ linkId: randomUUID(), fromAgentId: a.agentId, toAgentId: b.agentId }));
  const ghostLead = await card("codex", "ws-x"), hiddenLead = await card("codex", "ws-hidden");
  const commonExec = await card("claude", COMMON_WORKSPACE_ID);
  known.delete("ws-x"); open.delete("ws-x"); // its workspaces.json record is gone
  open.delete("ws-hidden"); // hidden, still known
  assert.equal(await link(hiddenLead, commonExec), "link_workspaces");
  assert.equal(await link(ghostLead, commonExec), "ok");
  await m.shutdown();
});

test("folder_busy and readiness name the run that holds the folder, its owner workspace and whether its journal was read", async () => {
  const root = path.join(TMP, "orch-holder");
  const src = project();
  const [la, ea, lb, eb, linkA, linkB, reserved, held] = Array.from({ length: 8 }, () => randomUUID());
  const card = (agentId, provider, workspaceId) => ({ agentId, provider, role: provider === "codex" ? "lead" : "executor", project: src, bounds: box(), createdAt: "2026-09-01T00:00:00.000Z", workspaceId });
  const at = "2026-09-01T00:00:00.000Z";
  fs.mkdirSync(path.join(root, "runs", held), { recursive: true });
  fs.writeFileSync(path.join(root, "runs", held, "journal.jsonl"), "{ damaged\n"); // counts as busy: fail closed
  // link A: a reserved id whose run was never created (not busy), then the run that holds the folder, owned by ws-b
  fs.writeFileSync(path.join(root, "canvas.json"), JSON.stringify({ v: 1,
    agents: [card(la, "codex", "ws-a"), card(ea, "claude", "ws-a"), card(lb, "codex", COMMON_WORKSPACE_ID), card(eb, "claude", COMMON_WORKSPACE_ID)],
    links: [{ linkId: linkA, fromAgentId: la, toAgentId: ea, createdAt: at, runIds: [reserved, held] }, { linkId: linkB, fromAgentId: lb, toAgentId: eb, createdAt: at, runIds: [] }],
    owners: { [held]: "ws-b" } }));
  const m = manager(root);
  const r = await m.startOnLink({ linkId: linkB, requestId: randomUUID(), goal: goal() });
  assert.deepEqual({ ...r }, { ok: false, code: "folder_busy", message: "another run works in this project folder now", runId: held, workspaceId: "ws-b", runReadable: false });
  const ready = await m.readiness({ linkId: linkB, commands: [], workMode: "project" });
  const item = ready.value.items.find((i) => i.id === "busy");
  assert.equal(item.level, "blocker");
  assert.deepEqual([item.facts.runId, item.facts.workspaceId, item.facts.runReadable], [held, "ws-b", false]);
  await m.shutdown();
});

test("M6: a reservation that cannot be written leaves neither a run nor an owner; the repeat makes one run owned by its workspace", { ...MAC, skip: MAC.skip || (ROOT && "root writes anywhere") }, async () => {
  const root = path.join(TMP, "orch-owner");
  const m = manager(root);
  const { link } = await group(m, project(), "ws-a");
  const requestId = randomUUID();
  fs.chmodSync(root, 0o500); // canvas.json cannot be replaced: the reservation fails
  let failed;
  try {
    failed = await m.startOnLink({ linkId: link.linkId, requestId, goal: goal() });
  } finally {
    fs.chmodSync(root, 0o700);
  }
  assert.equal(code(failed), "store_failed");
  assert.deepEqual((await m.list()).value, [], "no run");
  const c0 = (await m.canvas()).value;
  assert.deepEqual([c0.links[0].runIds, c0.owners], [[], undefined], "no reservation, no owner");
  const started = await m.startOnLink({ linkId: link.linkId, requestId, goal: goal() });
  assert.deepEqual(started.value, { runId: requestId, created: true });
  assert.deepEqual((await m.startOnLink({ linkId: link.linkId, requestId, goal: goal() })).value, { runId: requestId, created: false }, "a repeat");
  assert.deepEqual((await m.list()).value.map((r) => r.view.runId), [requestId], "one run");
  assert.deepEqual((await m.canvas()).value.owners, { [requestId]: "ws-a" });
  await untilCompleted(m, requestId);
  await m.shutdown();
});

test("M6: after a crash between the reservation and the run, the reserved id is hidden, and the repeat keeps its owner", MAC, async () => {
  const root = path.join(TMP, "orch-crash");
  const m = manager(root);
  const { lead, link } = await group(m, project(), "ws-a");
  await m.shutdown();
  // the state a crash right after the reservation write leaves: the id and its owner, no run
  const requestId = randomUUID();
  const file = path.join(root, "canvas.json");
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  c.links[0].runIds.push(requestId);
  c.owners = { [requestId]: "ws-a" };
  fs.writeFileSync(file, JSON.stringify(c));
  // the lead card moves to another workspace meanwhile: the owner of the reserved run must not follow it
  c.agents = c.agents.map((a) => ({ ...a, workspaceId: "ws-b" }));
  fs.writeFileSync(file, JSON.stringify(c));
  const m2 = manager(root);
  const shown = (await m2.canvas()).value;
  assert.deepEqual([shown.links[0].runIds, shown.owners], [[], undefined], "a reserved id without a run is not shown");
  assert.equal(lead.workspaceId, "ws-a");
  const started = await m2.startOnLink({ linkId: link.linkId, requestId, goal: goal() });
  assert.deepEqual(started.value, { runId: requestId, created: true });
  assert.deepEqual((await m2.canvas()).value.owners, { [requestId]: "ws-a" }, "the owner written with the reservation");
  assert.deepEqual((await m2.list()).value.map((r) => r.view.runId), [requestId]);
  await untilCompleted(m2, requestId);
  await m2.shutdown();
});

test("M7: a group with a paused run cannot move; after its run ends it moves whole, and the run's history stays with the old workspace, also after the link goes", MAC, async () => {
  const root = path.join(TMP, "orch-move");
  const m = manager(root);
  const { lead, exec, link } = await group(m, project(), "ws-a");
  const runId = randomUUID();
  await m.startOnLink({ linkId: link.linkId, requestId: runId, goal: goal({ reviewPlan: true }) });
  await until(async () => (await m.get(runId)).value.view.status === "paused", "paused at the plan review");
  assert.equal(code(await m.moveAgentGroup([lead.agentId, exec.agentId], "ws-b")), "group_active_run", "a paused run is not finished");
  assert.equal(code(await m.moveAgentGroup([lead.agentId], "ws-b")), "group_changed", "only the whole group the person saw");
  const rev = (await m.get(runId)).value.view.revision;
  await m.command(runId, { commandId: randomUUID(), expectedRevision: rev, command: { kind: "stop" } });
  await until(async () => (await m.get(runId)).value.view.status === "stopped", "stopped");
  assert.equal(code(await m.moveAgentGroup([exec.agentId, lead.agentId], "ws-gone")), "workspace_unavailable");
  const moved = await m.moveAgentGroup([exec.agentId, lead.agentId], "ws-b");
  assert.equal(code(moved), "ok");
  const c = (await m.canvas()).value;
  assert.deepEqual(c.agents.map((a) => a.workspaceId), ["ws-b", "ws-b"]);
  const known = (id) => OPEN.has(id);
  assert.equal(runOwners(c, known)(runId), "ws-a", "the history stays where the run was started");
  assert.equal(code(await m.deleteLink(link.linkId)), "ok");
  const after = (await m.canvas()).value;
  assert.equal(runOwners(after, known)(runId), "ws-a", "and stays after the link goes");
  assert.equal((await m.get(runId)).value.view.status, "stopped", "the run itself is untouched");
  await m.shutdown();
});

test("M7: an older run of a link (no owner written) is fixed to the link's workspace before the link or card goes", MAC, async () => {
  const root = path.join(TMP, "orch-legacy");
  const m = manager(root);
  const { lead, link } = await group(m, project(), "ws-a");
  const runId = randomUUID();
  await m.startOnLink({ linkId: link.linkId, requestId: runId, goal: goal() });
  await until(async () => (await m.get(runId)).value.view.status === "completed", "completed");
  await m.shutdown();
  // as an older build left it: no owners
  const file = path.join(root, "canvas.json");
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  delete c.owners;
  fs.writeFileSync(file, JSON.stringify(c));
  const m2 = manager(root);
  assert.equal(runOwners((await m2.canvas()).value, (id) => OPEN.has(id))(runId), "ws-a", "derived from the link");
  assert.equal(code(await m2.deleteAgent(lead.agentId)), "ok");
  const after = (await m2.canvas()).value;
  assert.deepEqual([after.links.length, after.owners], [0, { [runId]: "ws-a" }], "written down before the link went");
  await m2.shutdown();
});

test("M7: a run whose journal cannot be read counts as unfinished: its group does not move and its link is not deleted", MAC, async () => {
  const root = path.join(TMP, "orch-unreadable");
  const m = manager(root);
  const { lead, exec, link } = await group(m, project(), "ws-a");
  const runId = randomUUID();
  await m.startOnLink({ linkId: link.linkId, requestId: runId, goal: goal() });
  await until(async () => (await m.get(runId)).value.view.status === "completed", "completed");
  await m.shutdown();
  fs.writeFileSync(path.join(root, "runs", runId, "journal.jsonl"), "{ damaged\n");
  const m2 = manager(root);
  assert.equal(code(await m2.moveAgentGroup([lead.agentId, exec.agentId], "ws-b")), "group_active_run", "fail closed");
  assert.notEqual(code(await m2.deleteLink(link.linkId)), "ok");
  await m2.shutdown();
});
