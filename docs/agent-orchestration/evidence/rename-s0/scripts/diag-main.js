// S0 diagnostic: names and paths as Electron resolves them; the same profile choice as CanvasTTY (src/main/index.ts:61).
const { app, session, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const out = process.env.S0_OUT || path.join(require("node:os").tmpdir(), `s0diag-${process.pid}.json`);
const KEYS = ["userData", "sessionData", "logs", "crashDumps", "temp", "appData"];
const paths = () => Object.fromEntries(KEYS.map((k) => { try { return [k, app.getPath(k)]; } catch (e) { return [k, `ERR ${e.message}`]; } }));
const r = { pid: process.pid, argv: process.argv.slice(1), exe: app.getPath("exe"), name: app.getName(), nameProp: app.name, t0: Date.now() };
r.beforeProfileChoice = paths();
if (process.env.S0_ENV_DIR) app.setPath("userData", process.env.S0_ENV_DIR);
r.afterProfileChoice = paths();
app.on("window-all-closed", () => {}); // hold for S0_HOLD_MS, not until the last window closes
r.lock = app.requestSingleInstanceLock();
const write = () => fs.writeFileSync(out, JSON.stringify(r, null, 2));
if (!r.lock) { r.exitedAt = Date.now(); write(); app.exit(0); }
else app.whenReady().then(async () => {
  r.atReady = paths();
  const part = session.fromPartition("persist:s0-browser");
  r.partitionStoragePath = part.storagePath;
  r.defaultStoragePath = session.defaultSession.storagePath;
  await part.cookies.set({ url: "https://s0.invalid", name: "s0", value: "cookie-1", expirationDate: Math.floor(Date.now() / 1000) + 3600 });
  await part.cookies.flushStore();
  r.cookiesSeen = (await part.cookies.get({ name: "s0" })).map((c) => c.value);
  const page = path.join(app.getPath("temp"), `s0-ls-${process.pid}.html`);
  fs.writeFileSync(page, "<!doctype html><title>s0</title>");
  const w = new BrowserWindow({ show: false, webPreferences: { partition: "persist:s0-browser" } });
  await w.loadFile(page);
  r.localStorageBefore = await w.webContents.executeJavaScript("localStorage.getItem('s0')");
  await w.webContents.executeJavaScript("localStorage.setItem('s0', 'ls-1'); true");
  w.destroy();
  r.ready = true;
  write();
  setTimeout(() => app.quit(), Number(process.env.S0_HOLD_MS || 1500));
});
