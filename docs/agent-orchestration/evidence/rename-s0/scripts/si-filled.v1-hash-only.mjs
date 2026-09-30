// S0-6 on a filled synthetic profile: does a second start (same app or the renamed one) change browser data, plugin data
// or run history? Every file of the profile is hashed; the writes the first process makes on its own in the same window
// are measured by control runs (no second start) and kept apart from what changes only when a second start happens.
// Test profiles only; no Keychain call (no secret API), no root, no system setting.
//   BASE_USER_DATA=<userData of a finished scripts/e2e-orchestration.mjs run> node si-filled.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { launch, sleep } from "<REPO>/scripts/orchestration-app-kit.mjs";

const S = path.dirname(new URL(import.meta.url).pathname);
const APPS = {
  raoden: path.join(S, "pkg-raoden/mac-arm64/Raoden Loom.app/Contents/MacOS/Raoden Loom"),
  devCanvas: path.join(S, "pkg-canvastty/mac-arm64/CanvasTTY.app/Contents/MacOS/CanvasTTY")
};
const SEED = process.env.BASE_USER_DATA;
if (!SEED || !fs.existsSync(path.join(SEED, "orchestration", "runs"))) throw new Error("BASE_USER_DATA with orchestration/runs is required");
const B = fs.mkdtempSync("/tmp/cto-sf-");
const HOME = path.join(B, "home");
fs.mkdirSync(HOME);
const ENV = { HOME, SHELL: "/bin/sh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
const PLUGIN = "s0.data-probe";
let port = 9700;

const category = (rel) => {
  if (rel.startsWith("Partitions/")) return "browser: Partitions";
  if (rel === "browser-state.json" || rel.startsWith("browser/")) return "browser: state";
  if (rel.startsWith("plugin-storage/") || rel.startsWith("plugins/") || rel === "plugins.json" || rel.startsWith("plugin-")) return "plugins";
  if (rel.startsWith("orchestration/runs/")) return "run history";
  if (rel.startsWith("orchestration/")) return "orchestration other";
  if (/^(settings|workspaces|terminal-sessions)\.json$/.test(rel)) return "app stores";
  if (rel === "Local State") return "Local State";
  return "chromium other";
};
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { out[path.relative(dir, p)] = createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { out[path.relative(dir, p)] = "unreadable"; } }
    }
  };
  walk(dir);
  return out;
}
const diff = (a, b) => {
  const r = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] === b[k]) continue;
    r.push({ path: k, kind: !(k in a) ? "added" : !(k in b) ? "removed" : "changed", category: category(k) });
  }
  return r.sort((x, y) => x.path.localeCompare(y.path));
};
const byCategory = (snap) => {
  const r = {};
  for (const k of Object.keys(snap)) r[category(k)] = (r[category(k)] ?? 0) + 1;
  return r;
};
const firstOpen = async (build, dir) => {
  const app = await launch({ userData: dir, port: port++, shots: B, executable: APPS[build], env: ENV });
  await app.waitFor("document.querySelector('.workspace') && window.canvasTTY && true", `${build} window`, 60_000);
  await sleep(3500);
  return app;
};
function second(build, dir) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(APPS[build], [`--user-data-dir=${dir}`], { env: { ...process.env, ...ENV }, stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, ms: Date.now() - t0 }); });
  });
}

// ---------- the filled profile: run history from the e2e run, plugin data, browser data ----------
const base = path.join(B, "base");
fs.cpSync(SEED, base, { recursive: true });
for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(base, f), { force: true });
fs.rmSync(path.join(base, "browser", "runtime"), { recursive: true, force: true });
fs.mkdirSync(path.join(base, "plugins", PLUGIN), { recursive: true });
fs.writeFileSync(path.join(base, "plugins", PLUGIN, "canvastty.plugin.json"), JSON.stringify({
  apiVersion: 1, id: PLUGIN, name: "S0 data probe", version: "0.0.1", description: "Synthetic plugin data for S0-6", permissions: ["storage"],
  contributions: [{ id: "probe", kind: "canvas-app", title: "Probe", entry: "probe.html", defaultSize: { width: 400, height: 300 } }]
}));
fs.writeFileSync(path.join(base, "plugins", PLUGIN, "probe.html"), "<!doctype html><title>probe</title>");
const registry = fs.existsSync(path.join(base, "plugins.json")) ? JSON.parse(fs.readFileSync(path.join(base, "plugins.json"), "utf8")) : {};
registry[PLUGIN] = { sourceUrl: "https://github.com/example/s0-data-probe", enabled: true, installedAt: 1 };
fs.writeFileSync(path.join(base, "plugins.json"), JSON.stringify(registry));
let pageDone;
const pageSeen = new Promise((r) => { pageDone = r; });
const server = http.createServer((req, res) => {
  if (req.url === "/done") { pageDone(); res.end("ok"); return; }
  res.setHeader("content-type", "text/html");
  res.setHeader("set-cookie", "s0probe=synthetic; Max-Age=31536000; Path=/");
  res.end(`<!doctype html><title>s0 data</title><script>
    localStorage.setItem("s0", "synthetic-" + "x".repeat(2000));
    const open = indexedDB.open("s0db", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("s");
    open.onsuccess = () => { const tx = open.result.transaction("s", "readwrite"); tx.objectStore("s").put("synthetic", "k"); tx.oncomplete = () => fetch("/done"); };
  </script>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
{
  const app = await firstOpen("raoden", base);
  const stored = await app.ev(`window.canvasTTY.plugins.storageSet(${JSON.stringify(PLUGIN)}, "notes", { text: "synthetic plugin data", n: 42 }).then(() => true, (e) => String(e))`);
  await app.ev(`window.canvasTTY.browser.open(${JSON.stringify(pageUrl)}).then(() => true, (e) => String(e))`);
  await Promise.race([pageSeen, sleep(30_000).then(() => { throw new Error("the browser page did not finish"); })]);
  await sleep(2000);
  await app.quit();
  if (stored !== true) throw new Error(`plugin storage: ${stored}`);
}
server.close();
const baseSnap = snapshot(base);
const filled = byCategory(baseSnap);
for (const need of ["browser: Partitions", "plugins", "run history"]) if (!(filled[need] > 0)) throw new Error(`the profile has no ${need} files`);
const nonEmpty = {
  partitionsLocalStorage: Object.keys(baseSnap).filter((k) => k.startsWith("Partitions/") && /Local Storage\//.test(k)).length,
  partitionsIndexedDB: Object.keys(baseSnap).filter((k) => k.startsWith("Partitions/") && /IndexedDB\//.test(k)).length,
  partitionsCookies: Object.keys(baseSnap).filter((k) => k.startsWith("Partitions/") && /Cookies$/.test(k)).length,
  pluginStorage: Object.keys(baseSnap).filter((k) => k.startsWith("plugin-storage/")).length,
  runs: fs.readdirSync(path.join(base, "orchestration", "runs")).filter((n) => !n.startsWith(".")).length,
  runJournals: Object.keys(baseSnap).filter((k) => /^orchestration\/runs\/[^/]+\/journal\.jsonl$/.test(k)).length
};

// ---------- control and second-start cases, each on its own copy of the filled profile ----------
const cases = [
  { name: "control raoden (no second) #1", first: "raoden", second: null },
  { name: "control raoden (no second) #2", first: "raoden", second: null },
  { name: "B raoden over raoden", first: "raoden", second: "raoden" },
  { name: "C devCanvas over raoden", first: "raoden", second: "devCanvas" },
  { name: "control devCanvas (no second) #1", first: "devCanvas", second: null },
  { name: "control devCanvas (no second) #2", first: "devCanvas", second: null },
  { name: "D raoden over devCanvas", first: "devCanvas", second: "raoden" }
];
const results = [];
for (const [i, c] of cases.entries()) {
  const dir = path.join(B, `p${i}`);
  fs.cpSync(base, dir, { recursive: true });
  const app = await firstOpen(c.first, dir);
  const s0 = snapshot(dir);
  const r = { case: c.name, first: c.first, second: c.second };
  // the same window length with and without a second start: the second's own exit time, or the longest seen (≤ 2 s)
  if (c.second) r.secondExit = await second(c.second, dir);
  else await sleep(2000);
  await sleep(1500);
  const s1 = snapshot(dir);
  r.firstAlive = (await app.ev("1 + 1").catch(() => null)) === 2;
  await app.quit();
  const s2 = snapshot(dir);
  const again = await firstOpen(c.first, dir);
  r.reopen = {
    responds: (await again.ev("1 + 1").catch(() => null)) === 2,
    pluginData: await again.ev(`window.canvasTTY.plugins.storageGet(${JSON.stringify(PLUGIN)}, "notes")`).catch((e) => String(e)),
    runs: await again.ev("window.canvasTTY.orchestration.list().then((r) => r.value.length)").catch((e) => String(e))
  };
  await again.quit();
  r.duringWindow = diff(s0, s1);
  r.startToQuit = diff(baseSnap, s2);
  results.push(r);
  console.log(c.name, JSON.stringify({ window: r.duringWindow.length, quit: r.startToQuit.length, alive: r.firstAlive, reopen: r.reopen }));
}

// ---------- attribution ----------
const key = (d) => `${d.kind} ${d.path}`;
const attribution = {};
for (const first of ["raoden", "devCanvas"]) {
  const controls = results.filter((r) => r.first === first && !r.second);
  const routineWindow = new Set(controls.flatMap((r) => r.duringWindow.map(key)));
  const routineQuit = new Set(controls.flatMap((r) => r.startToQuit.map(key)));
  for (const r of results.filter((x) => x.first === first && x.second)) {
    attribution[r.case] = {
      windowOnlyWithSecond: r.duringWindow.filter((d) => !routineWindow.has(key(d))),
      quitOnlyWithSecond: r.startToQuit.filter((d) => !routineQuit.has(key(d))),
      dataCategoriesTouchedInWindow: [...new Set(r.duringWindow.map((d) => d.category))]
    };
  }
}
const out = { filledProfile: { filesByCategory: filled, nonEmpty }, results, attribution };
fs.writeFileSync(path.join(S, "si-filled-results.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ filled, nonEmpty, attribution }, null, 2));
fs.rmSync(B, { recursive: true, force: true });
