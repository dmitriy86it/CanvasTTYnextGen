// R-M04. Acceptance criterion M5 (spec §3 "Откат", §7 M5): run SettingsStore and normalizePersistedTerminalSessions
// from HEAD (git archive HEAD) on files written by the new build. The repository has no such test (no test or script
// mentions M5 / git archive), so this repro performs the check itself. Expectation: every item survives with the same
// position and size; the only difference from the same file without workspaceId is the dropped workspaceId.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { SettingsStore } from "../../../../../../src/main/services/SettingsStore.ts";
import { persistedTerminalSession } from "../../../../../../src/main/services/TerminalSessionStore.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");

test("R-M04 (M5): HEAD normalizers read files of the new build losing only workspaceId", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rm04-")));
  try {
    const head = path.join(tmp, "head");
    fs.mkdirSync(head);
    execFileSync("sh", ["-c", `git -C "${REPO}" archive HEAD src | tar -x -C "${head}"`]);
    const Old = await import(pathToFileURL(path.join(head, "src/main/services/SettingsStore.ts")).href);
    const OldTerm = await import(pathToFileURL(path.join(head, "src/main/services/TerminalSessionStore.ts")).href);

    // a settings.json as the new build writes it
    const newDir = path.join(tmp, "new");
    fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(newDir, "settings.json"), JSON.stringify({
      settingsVersion: 15, persistCanvasRegions: true, persistStickyNotes: true,
      canvasRegions: [{ id: "r", title: "R", color: "#112233", position: { x: 11, y: 12 }, size: { width: 401, height: 301 }, workspaceId: "ws-a" }],
      stickyNotes: [{ id: "n", text: "t", position: { x: 21, y: 22 }, size: { width: 302, height: 222 }, workspaceId: "ws-a" }],
      pluginCanvas: [{ id: "p", pluginId: "example.plugin", contributionId: "canvas", title: "P", position: { x: 31, y: 32 }, size: { width: 403, height: 303 }, workspaceId: "ws-a" }],
      browserCanvas: { position: { x: 41, y: 42 }, size: { width: 921, height: 621 }, workspaceId: "ws-a" }
    }));
    const s = new SettingsStore(newDir, "en"); await s.load(); await s.update({}); // written by the new build
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
    assert.deepEqual(a, b, "HEAD reads the new file exactly as the same file without workspaceId");
    const geo = (x) => [...x.canvasRegions, ...x.stickyNotes, ...x.pluginCanvas, x.browserCanvas].map((i) => [i.position, i.size]);
    assert.deepEqual(geo(a), geo(written), "positions and sizes are kept");

    const t = persistedTerminalSession({ id: "t", provider: "terminal", profile: "normal", title: "x", titleCustomized: false, cwd: "/tmp",
      position: { x: 51, y: 52 }, size: { width: 701, height: 431 }, workspaceId: "ws-a" });
    const old = OldTerm.normalizePersistedTerminalSessions({ version: 1, sessions: [t] });
    assert.equal(old.sessions.length, 1);
    assert.deepEqual([old.sessions[0].position, old.sessions[0].size], [t.position, t.size]);
    assert.equal(old.sessions[0].workspaceId, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
