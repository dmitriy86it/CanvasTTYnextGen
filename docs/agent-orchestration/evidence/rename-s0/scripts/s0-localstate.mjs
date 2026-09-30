// S0-6, Local State: who writes it when a second instance starts on a running profile. Test profiles only, no root,
// no system setting. Cases: one instance alone; the same app again; the renamed app over the running one, both orders.
// Discriminator: before the second start, "Local State" is replaced by a directory in the test profile; a process that
// then tries to write it logs the failure to its own stderr, and both stderr streams are captured apart.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { launch, sleep } from "<REPO>/scripts/orchestration-app-kit.mjs";

const S = path.dirname(new URL(import.meta.url).pathname);
const APPS = {
  raoden: path.join(S, "pkg-raoden/mac-arm64/Raoden Loom.app/Contents/MacOS/Raoden Loom"),
  devCanvas: path.join(S, "pkg-canvastty/mac-arm64/CanvasTTY.app/Contents/MacOS/CanvasTTY")
};
const B = fs.mkdtempSync("/tmp/cto-s0l-");
const HOME = path.join(B, "home");
fs.mkdirSync(HOME);
const ENV = { HOME, SHELL: "/bin/sh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
const STORES = ["settings.json", "workspaces.json", "browser-state.json", "plugins.json"];
let port = 9760;
const ls = (dir) => {
  const f = path.join(dir, "Local State");
  if (!fs.existsSync(f)) return { exists: false };
  const st = fs.statSync(f);
  if (st.isDirectory()) return { exists: true, directory: true, entries: fs.readdirSync(f) };
  const text = fs.readFileSync(f, "utf8");
  let keys = null;
  try { keys = Object.keys(JSON.parse(text)).sort(); } catch {}
  return { exists: true, bytes: st.size, mtimeMs: Math.round(st.mtimeMs), birthtimeMs: Math.round(st.birthtimeMs), sha256: createHash("sha256").update(text).digest("hex").slice(0, 16), keys };
};
const stores = (dir) => Object.fromEntries(STORES.map((f) => { try { return [f, createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex").slice(0, 16)]; } catch { return [f, null]; } }));
const localStateLines = (text) => text.split("\n").filter((l) => /Local State|ImportantFileWriter|local_state|pref_service|JsonPrefStore/i.test(l)).map((l) => l.replace(/^\[\d+:\d+\/[\d.]+:/, "[").slice(0, 200));
const firstOpen = async (build, dir) => {
  const app = await launch({ userData: dir, port: port++, shots: S, executable: APPS[build], env: ENV });
  await app.waitFor("document.querySelector('.workspace') && window.canvasTTY && true", `${build} window`, 60_000);
  await sleep(3500);
  return app;
};
function second(build, dir) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let err = "";
    const child = spawn(APPS[build], [`--user-data-dir=${dir}`], { env: { ...process.env, ...ENV }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c) => { err += c; });
    child.stderr.on("data", (c) => { err += c; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, ms: Date.now() - t0, localStateLog: localStateLines(err), bytes: err.length }); });
  });
}

const cases = [
  { name: "A one instance, no second", first: "raoden", second: null, block: false },
  { name: "B same app over itself", first: "raoden", second: "raoden", block: false },
  { name: "C renamed over running (devCanvas over raoden)", first: "raoden", second: "devCanvas", block: false },
  { name: "D renamed over running (raoden over devCanvas)", first: "devCanvas", second: "raoden", block: false },
  { name: "E = C, Local State blocked by a directory", first: "raoden", second: "devCanvas", block: true },
  { name: "F = D, Local State blocked by a directory", first: "devCanvas", second: "raoden", block: true }
];
const out = [];
for (const c of cases) {
  const dir = path.join(B, `p-${out.length}`);
  const app = await firstOpen(c.first, dir);
  const r = { case: c.name, beforeSecond: ls(dir), storesBefore: stores(dir) };
  const outMark = app.output().length;
  if (c.block) {
    if (fs.existsSync(path.join(dir, "Local State"))) fs.rmSync(path.join(dir, "Local State"));
    fs.mkdirSync(path.join(dir, "Local State"));
  }
  if (c.second) r.second = await second(c.second, dir);
  else await sleep(300);
  await sleep(1500);
  r.afterSecond = ls(dir);
  r.storesUnchanged = JSON.stringify(stores(dir)) === JSON.stringify(r.storesBefore);
  r.firstAlive = (await app.ev("1 + 1").catch(() => null)) === 2;
  r.firstLogSinceSecond = localStateLines(app.output().slice(outMark)); // the kit keeps the last 64 KiB
  if (c.block) fs.rmSync(path.join(dir, "Local State"), { recursive: true, force: true }); // let the first write it on quit
  await app.quit();
  r.afterFirstQuit = ls(dir);
  // reopen the profile with the first build: it starts, its stores are as before
  const again = await firstOpen(c.first, dir);
  r.reopen = { responds: (await again.ev("1 + 1").catch(() => null)) === 2, storesAsBefore: JSON.stringify(stores(dir)) === JSON.stringify(r.storesBefore) };
  await again.quit();
  r.afterReopenQuit = ls(dir);
  out.push(r);
  console.log(JSON.stringify(r));
}
fs.writeFileSync(path.join(S, "s0-localstate-results.json"), JSON.stringify(out, null, 2));
fs.rmSync(B, { recursive: true, force: true });
