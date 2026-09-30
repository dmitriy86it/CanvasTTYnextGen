// S0 on macOS with packaged builds and test profiles only: 1.5.3 (release/1.5.3, copied), the development code packaged
// as "CanvasTTY" and as "Raoden Loom" (same app.asar). HOME is temporary; no profile of the person is named anywhere.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "<REPO>/scripts/orchestration-app-kit.mjs";

const S = path.dirname(new URL(import.meta.url).pathname);
const APPS = {
  v153: path.join(S, "apps/v153/CanvasTTY.app/Contents/MacOS/CanvasTTY"),
  devCanvas: path.join(S, "pkg-canvastty/mac-arm64/CanvasTTY.app/Contents/MacOS/CanvasTTY"),
  raoden: path.join(S, "pkg-raoden/mac-arm64/Raoden Loom.app/Contents/MacOS/Raoden Loom")
};
// Profiles and HOME in a short temporary directory: the agent browser socket lives under userData (Unix socket path limit).
const B = fs.mkdtempSync("/tmp/cto-s0-");
console.log("profiles in", B);
const HOME = path.join(B, "home");
fs.mkdirSync(HOME, { recursive: true });
const PROJECT = path.join(B, "project");
fs.mkdirSync(PROJECT, { recursive: true });
const RESULTS = [];
const note = (step, build, change, observed, ok) => { RESULTS.push({ step, build, change, observed, ok }); console.log(ok ? "ok  " : "FAIL", step, JSON.stringify(observed).slice(0, 300)); };
const REAL_SUPPORT = path.join(os.homedir(), "Library", "Application Support");
const supportList = () => fs.readdirSync(REAL_SUPPORT).sort();
const keychain = () => Object.fromEntries(["canvastty", "CanvasTTY", "Raoden Loom", "Raoden", "raoden-loom"].map((n) => {
  try { execFileSync("security", ["find-generic-password", "-s", `${n} Safe Storage`], { stdio: "pipe" }); return [n, "present"]; } catch { return [n, "absent"]; }
}));
let port = 9300 + Math.floor(Math.random() * 200);
const open = async (build, userData, extraEnv = {}) => {
  const app = await launch({ userData, port: port++, shots: S, executable: APPS[build], env: { HOME, SHELL: "/bin/sh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...extraEnv } });
  await app.waitFor("document.querySelector('.workspace') && window.canvasTTY && true", `${build} window`, 60_000);
  await sleep(1500);
  return app;
};
const api = (app, expr) => app.ev(`(async () => { const r = await (${expr}); if (r && r.ok === false) throw new Error(r.code + " " + r.message); return r && typeof r === "object" && "ok" in r ? r.value : r; })()`);
// Files the application opens in the person's own profile or the home directory's CanvasTTY files, while it runs.
const realOpens = (pid) => {
  let out = "";
  try { out = execFileSync("lsof", ["-p", String(pid), "-Fn"], { encoding: "utf8" }); } catch {}
  return out.split("\n").filter((l) => l.startsWith("n") && (l.includes(`${REAL_SUPPORT}/canvastty`) || l.includes(`${REAL_SUPPORT}/CanvasTTY`) || l.includes(`${REAL_SUPPORT}/Raoden`) || l.includes("/.canvastty")) && !l.includes(B));
};
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);

const support0 = supportList();
const keys0 = keychain();
note("keychain before", "-", "-", keys0, true);

let app;
if (!process.env.ONLY_SI) {
// ---------- U: 1.5.3 → Raoden → 1.5.3 (rollback) → Raoden, one test profile ----------
const P = path.join(B, "p-upgrade");
fs.rmSync(P, { recursive: true, force: true });
const NOTE = { id: "s0-note", text: "S0 заметка", position: { x: 1400, y: 900 }, size: { width: 300, height: 220 } };
const REGION = { id: "s0-region", title: "S0 область", color: "#88AA44", position: { x: 1300, y: 800 }, size: { width: 800, height: 500 } };
const lead = randomUUID(), exec = randomUUID(), link = randomUUID();
const bounds = (x) => ({ position: { x, y: 1600 }, size: { width: 300, height: 222 } });

app = await open("v153", P);
await api(app, `window.canvasTTY.settings.update(${JSON.stringify({ persistStickyNotes: true, persistCanvasRegions: true, stickyNotes: [NOTE], canvasRegions: [REGION] })})`);
await api(app, `window.canvasTTY.orchestration.createAgent(${JSON.stringify({ agentId: lead, provider: "codex", project: PROJECT, bounds: bounds(1400) })})`);
await api(app, `window.canvasTTY.orchestration.createAgent(${JSON.stringify({ agentId: exec, provider: "claude", project: PROJECT, bounds: bounds(1800) })})`);
await api(app, `window.canvasTTY.orchestration.createLink(${JSON.stringify({ linkId: link, fromAgentId: lead, toAgentId: exec })})`);
note("U1 data made by 1.5.3", "v153", "test profile, note, region, two agents, one link", { opens: realOpens(app.child.pid) }, realOpens(app.child.pid).length === 0);
await app.quit();
const settings153 = read(path.join(P, "settings.json"));
const canvas153 = read(path.join(P, "orchestration", "canvas.json"));
note("U1 files of 1.5.3", "v153", "-", { note: settings153?.stickyNotes?.length, region: settings153?.canvasRegions?.length, agents: canvas153?.agents?.length, links: canvas153?.links?.length, workspacesJson: fs.existsSync(path.join(P, "workspaces.json")) }, settings153?.stickyNotes?.length === 1 && canvas153?.agents?.length === 2);

app = await open("raoden", P);
const ws1 = await api(app, "window.canvasTTY.workspaces.get()");
const s1 = await api(app, "window.canvasTTY.settings.get()");
const c1 = await api(app, "window.canvasTTY.orchestration.canvas()");
const backups = fs.existsSync(path.join(P, "backup")) ? fs.readdirSync(path.join(P, "backup")) : [];
note("U2 Raoden opens the 1.5.3 profile", "raoden", "productName Raoden Loom, same app.asar as dev", {
  available: ws1.available, workspaces: ws1.workspaces.map((w) => w.id), note: s1.stickyNotes.map((n) => n.text), region: s1.canvasRegions.map((r) => r.title),
  agents: c1.agents.length, links: c1.links.length, backups, opens: realOpens(app.child.pid)
}, ws1.available && ws1.workspaces.length === 1 && s1.stickyNotes[0]?.text === NOTE.text && s1.canvasRegions.length === 1 && c1.agents.length === 2 && c1.links.length === 1 && backups.length === 1 && realOpens(app.child.pid).length === 0);
const beta = (await api(app, `window.canvasTTY.workspaces.create(${JSON.stringify({ title: "Бета", root: PROJECT, activate: false })})`)).workspaces.at(-1).id;
await api(app, `window.canvasTTY.settings.update(${JSON.stringify({ stickyNotes: [{ ...NOTE, workspaceId: beta }] })})`);
await api(app, `window.canvasTTY.orchestration.moveAgentGroup(${JSON.stringify([lead, exec])}, ${JSON.stringify(beta)})`);
await app.quit();
const settingsR = read(path.join(P, "settings.json"));
const canvasR = read(path.join(P, "orchestration", "canvas.json"));
note("U2 files after Raoden", "raoden", "note and agent group moved to workspace Бета", { noteWs: settingsR.stickyNotes[0]?.workspaceId === beta, agentWs: canvasR.agents.map((a) => a.workspaceId === beta) }, settingsR.stickyNotes[0]?.workspaceId === beta && canvasR.agents.every((a) => a.workspaceId === beta));

app = await open("v153", P);
const s3 = await api(app, "window.canvasTTY.settings.get()");
const c3 = await api(app, "window.canvasTTY.orchestration.canvas()");
note("U3 rollback: 1.5.3 opens the profile written by Raoden", "v153", "-", { note: s3.stickyNotes.map((n) => [n.text, n.workspaceId ?? null]), region: s3.canvasRegions.length, agents: c3.agents.length, links: c3.links.length, opens: realOpens(app.child.pid) },
  s3.stickyNotes[0]?.text === NOTE.text && s3.canvasRegions.length === 1 && c3.agents.length === 2 && c3.links.length === 1 && realOpens(app.child.pid).length === 0);
// the old build writes both files once: a settings change and a card move
await api(app, `window.canvasTTY.settings.update(${JSON.stringify({ stickyNotes: s3.stickyNotes.map((n) => ({ ...n, text: n.text + " (1.5.3)" })) })})`);
await api(app, `window.canvasTTY.orchestration.moveAgent(${JSON.stringify(lead)}, ${JSON.stringify(bounds(1450))})`);
await app.quit();
const settings3 = read(path.join(P, "settings.json"));
const canvas3 = read(path.join(P, "orchestration", "canvas.json"));
note("U3 what 1.5.3 keeps when it writes", "v153", "note edited, lead card moved", {
  noteWorkspaceId: settings3.stickyNotes[0]?.workspaceId ?? null, agents: canvas3.agents.length, agentWorkspaceIds: canvas3.agents.map((a) => a.workspaceId ?? null), links: canvas3.links.length,
  ownersKey: "owners" in canvas3, workspacesJsonKept: fs.existsSync(path.join(P, "workspaces.json"))
}, canvas3.agents.length === 2 && canvas3.links.length === 1 && settings3.stickyNotes.length === 1);

app = await open("raoden", P);
const ws4 = await api(app, "window.canvasTTY.workspaces.get()");
const s4 = await api(app, "window.canvasTTY.settings.get()");
const c4 = await api(app, "window.canvasTTY.orchestration.canvas()");
const backups4 = fs.readdirSync(path.join(P, "backup"));
note("U4 Raoden again after the rollback", "raoden", "-", {
  workspaces: ws4.workspaces.map((w) => w.title || "common"), note: s4.stickyNotes.map((n) => [n.text, n.workspaceId ?? "common"]), agents: c4.agents.map((a) => a.workspaceId ?? "common"), links: c4.links.length, backups: backups4.length
}, s4.stickyNotes.length === 1 && c4.agents.length === 2 && c4.links.length === 1 && backups4.length === 1);
await app.quit();

// ---------- F: first start of Raoden without data ----------
const F = path.join(B, "p-fresh");
fs.rmSync(F, { recursive: true, force: true });
app = await open("raoden", F);
const wsF = await api(app, "window.canvasTTY.workspaces.get()");
note("F first start without data", "raoden", "empty test profile", { workspaces: wsF.workspaces.map((w) => w.id), opens: realOpens(app.child.pid) }, wsF.workspaces.length === 1 && wsF.workspaces[0].id === "common" && realOpens(app.child.pid).length === 0);
await app.quit();
const manifest = read(path.join(F, "backup", fs.readdirSync(path.join(F, "backup"))[0], "manifest.json"));
note("F backup of a fresh profile", "raoden", "-", manifest.files.map((f) => `${f.file}:${f.status}`), manifest.files.every((f) => ["absent", "copied"].includes(f.status)));

// ---------- PR: CANVASTTY_USER_DATA_DIR and --user-data-dir together ----------
const PE = path.join(B, "p-prio-env"), PS = path.join(B, "p-prio-switch");
fs.rmSync(PE, { recursive: true, force: true }); fs.rmSync(PS, { recursive: true, force: true });
app = await open("raoden", PS, { CANVASTTY_USER_DATA_DIR: PE });
await app.quit();
note("PR both set", "raoden", "env CANVASTTY_USER_DATA_DIR=A, --user-data-dir=B", { envDir: fs.existsSync(PE) ? fs.readdirSync(PE).filter((f) => f.endsWith(".json")).sort() : null, switchDir: fs.existsSync(PS) ? fs.readdirSync(PS).sort() : null },
  fs.existsSync(path.join(PE, "settings.json")) && !fs.existsSync(path.join(PS, "settings.json")));

}
// ---------- SI: two different .app on one test profile, both orders, direct exec and `open -n` ----------
const STORES = ["settings.json", "workspaces.json", "browser-state.json", "terminal-sessions.json", "plugins.json", path.join("orchestration", "canvas.json")];
const stamp = (dir) => Object.fromEntries(STORES.map((f) => { try { const s = fs.statSync(path.join(dir, f)); return [f, `${s.size}:${s.mtimeMs}`]; } catch { return [f, null]; } }));
const top = (dir) => fs.readdirSync(dir).sort();
const procCount = (dir) => { try { return execFileSync("pgrep", ["-f", "--", `--user-data-dir=${dir}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length; } catch { return 0; } };
async function second(build, dir, mode) {
  const t0 = Date.now();
  if (mode === "exec") {
    const child = spawn(APPS[build], [`--user-data-dir=${dir}`], { env: { ...process.env, HOME, SHELL: "/bin/sh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdio: "ignore" });
    const code = await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r("killed after 30 s"); }, 30_000); child.once("exit", (c) => { clearTimeout(t); r(c); }); });
    return { code, seconds: (Date.now() - t0) / 1000 };
  }
  const bundle = APPS[build].split("/Contents/MacOS/")[0];
  execFileSync("open", ["-n", "-W", "-a", bundle, "--env", `HOME=${HOME}`, "--env", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "--args", `--user-data-dir=${dir}`], { timeout: 60_000 });
  return { code: "open -W returned", seconds: (Date.now() - t0) / 1000 };
}
for (const [first, sec] of [["devCanvas", "raoden"], ["raoden", "devCanvas"]]) {
  for (const mode of ["exec", "open"]) {
    const D = path.join(B, `p-si-${first}-${mode}`);
    fs.rmSync(D, { recursive: true, force: true });
    app = await open(first, D);
    await sleep(2000);
    const before = { stamp: stamp(D), top: top(D), procs: procCount(D) };
    const r = await second(sec, D, mode);
    await sleep(1500);
    const after = { stamp: stamp(D), top: top(D), procs: procCount(D) };
    const firstAlive = app.child.exitCode === null && (await app.ev("1 + 1").catch(() => null)) === 2;
    note(`SI ${first} then ${sec} (${mode})`, `${first}+${sec}`, "one test profile", { second: r, storesUnchanged: JSON.stringify(before.stamp) === JSON.stringify(after.stamp), added: after.top.filter((x) => !before.top.includes(x)), removed: before.top.filter((x) => !after.top.includes(x)), procs: [before.procs, after.procs], firstAlive },
      r.seconds < 15 && JSON.stringify(before.stamp) === JSON.stringify(after.stamp) && after.top.filter((x) => !before.top.includes(x)).length === 0 && before.procs === after.procs && firstAlive);
    await app.quit();
  }
}

const keys1 = keychain();
note("keychain after", "-", "-", keys1, JSON.stringify(keys0) === JSON.stringify(keys1));
const support1 = supportList();
note("Application Support: no entry added or removed", "-", "-", { added: support1.filter((x) => !support0.includes(x)), removed: support0.filter((x) => !support1.includes(x)) }, JSON.stringify(support0) === JSON.stringify(support1));
fs.writeFileSync(path.join(S, process.env.ONLY_SI ? "s0-si-results.json" : "s0-real-results.json"), JSON.stringify(RESULTS, null, 2));
console.log(RESULTS.every((r) => r.ok) ? "ALL OK" : `${RESULTS.filter((r) => !r.ok).length} FAILED`);
process.exit(0);
