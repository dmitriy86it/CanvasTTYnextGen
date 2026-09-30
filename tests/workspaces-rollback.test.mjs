// M5 (docs/agent-orchestration/implementation/workspaces-spec.md §3 "Откат", §7): the normalizers of the build before
// workspaces read files written by this build and lose only workspaceId: every item keeps its position and size.
// The older build is taken from git history (git archive), offline; without that commit the test is skipped.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { persistedTerminalSession } from "../src/main/services/TerminalSessionStore.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BEFORE_WORKSPACES = "06d8101"; // the last commit without workspaces
const present = (() => {
  try { execFileSync("git", ["-C", REPO, "cat-file", "-e", `${BEFORE_WORKSPACES}^{commit}`], { stdio: "ignore" }); return true; } catch { return false; }
})();

test("M5: the build before workspaces reads files of this build losing only workspaceId", { skip: !present && "the commit before workspaces is not in this clone" }, async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-rollback-")));
  try {
    const old = path.join(tmp, "old-build");
    fs.mkdirSync(old);
    execFileSync("sh", ["-c", `git -C "$1" archive "$2" src | tar -x -C "$3"`, "sh", REPO, BEFORE_WORKSPACES, old]);
    const Old = await import(pathToFileURL(path.join(old, "src/main/services/SettingsStore.ts")).href);
    const OldTerm = await import(pathToFileURL(path.join(old, "src/main/services/TerminalSessionStore.ts")).href);

    const newDir = path.join(tmp, "new");
    fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(newDir, "settings.json"), JSON.stringify({
      settingsVersion: 15, persistCanvasRegions: true, persistStickyNotes: true,
      canvasRegions: [{ id: "r", title: "R", color: "#112233", position: { x: 11, y: 12 }, size: { width: 401, height: 301 }, workspaceId: "ws-a" }],
      stickyNotes: [{ id: "n", text: "t", position: { x: 21, y: 22 }, size: { width: 302, height: 222 }, workspaceId: "ws-a" }],
      pluginCanvas: [{ id: "p", pluginId: "example.plugin", contributionId: "canvas", title: "P", position: { x: 31, y: 32 }, size: { width: 403, height: 303 }, workspaceId: "ws-a" }],
      browserCanvas: { position: { x: 41, y: 42 }, size: { width: 921, height: 621 }, workspaceId: "ws-a" }
    }));
    const s = new SettingsStore(newDir, "en"); await s.load(); await s.update({}); // written by this build
    const written = JSON.parse(fs.readFileSync(path.join(newDir, "settings.json"), "utf8"));
    const stripped = structuredClone(written);
    for (const k of ["canvasRegions", "stickyNotes", "pluginCanvas"]) for (const i of stripped[k]) delete i.workspaceId;
    delete stripped.browserCanvas.workspaceId;

    const readOld = async (value) => {
      const d = fs.mkdtempSync(path.join(tmp, "old-"));
      fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(value));
      const o = new Old.SettingsStore(d, "en"); await o.load(); return o.get();
    };
    const a = await readOld(written), b = await readOld(stripped);
    assert.deepEqual(a, b, "the older build reads the new file exactly as the same file without workspaceId");
    const geo = (x) => [...x.canvasRegions, ...x.stickyNotes, ...x.pluginCanvas, x.browserCanvas].map((i) => [i.position, i.size]);
    assert.deepEqual(geo(a), geo(written), "positions and sizes are kept");

    const t = persistedTerminalSession({ id: "t", provider: "terminal", profile: "normal", title: "x", titleCustomized: false, cwd: "/tmp",
      position: { x: 51, y: 52 }, size: { width: 701, height: 431 }, workspaceId: "ws-a" });
    const oldSessions = OldTerm.normalizePersistedTerminalSessions({ version: 1, sessions: [t] });
    assert.equal(oldSessions.sessions.length, 1);
    assert.deepEqual([oldSessions.sessions[0].position, oldSessions.sessions[0].size], [t.position, t.size]);
    assert.equal(oldSessions.sessions[0].workspaceId, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
