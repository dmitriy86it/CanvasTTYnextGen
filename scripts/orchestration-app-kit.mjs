// Shared by the Electron orchestration UI smoke and E2E (scripts/smoke-orchestration-ui.mjs, scripts/e2e-orchestration.mjs):
// temporary Git projects, fake CLI scripts, and the real application window driven over the DevTools protocol with
// mouse and key events as the user makes them. Starts no real model: the providers come from a development-only
// variable (CANVASTTY_ORCHESTRATION_TEST_PROVIDERS) that a packaged build ignores.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { hermeticEnv, HERMETIC_PATH, step, watch } from "./smoke-watchdog.mjs";

export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const FIXTURES = path.join(ROOT, "tests", "fixtures", "orchestration");
// whether the built app writes new runs in journal v2, as src/main/index.ts decides: the switch or the development flag
export const JOURNAL_V2 = process.env.CANVASTTY_JOURNAL_V2 === "1"
  || /^export const JOURNAL_V2_BY_DEFAULT = true;/m.test(fs.readFileSync(path.join(ROOT, "src", "main", "services", "orchestration", "journal.ts"), "utf8"));
export const NODE = fs.realpathSync(process.execPath);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function workspace(prefix) {
  const TMP = fs.realpathSync(fs.mkdtempSync(`/tmp/${prefix}`));
  const D = (...p) => path.join(TMP, ...p);
  fs.writeFileSync(D("gitconfig"), "");
  const gitEnv = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: D("gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@localhost", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@localhost" };
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" });
  // check-project without its deliberately failing test, with prepared node_modules, committed on main
  function project(name) {
    const dir = D(name);
    fs.cpSync(path.join(FIXTURES, "check-project"), dir, { recursive: true });
    fs.rmSync(path.join(dir, "tests", "broken.test.mjs"));
    fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "left-pad", "index.mjs"), "export default (s) => s;\n");
    for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "smoke project"]]) git(dir, ...args);
    return dir;
  }
  // A fake CLI script: the n-th call answers step n ({report, writes?: [[rel, text]]}).
  function script(name, steps) {
    const d = D("script", name);
    fs.mkdirSync(d, { recursive: true });
    steps.forEach((s, i) => {
      fs.writeFileSync(path.join(d, `${i + 1}.json`), JSON.stringify(s.report));
      if (s.writes) fs.writeFileSync(path.join(d, `${i + 1}.writes.json`), JSON.stringify(s.writes.map(([rel, text]) => ({ rel, base64: Buffer.from(text).toString("base64") }))));
    });
    return d;
  }
  return { TMP, D, git, project, script };
}

// Polls `evaluate()` until it returns a truthy value. An exception is never success: it is kept and named in the
// timeout, next to the last value (a false condition stays false).
export async function waitForValue(evaluate, what, ms = 20_000, pause = (t) => sleep(t)) {
  step(`wait: ${what}`);
  const end = Date.now() + ms;
  let last, error = null;
  while (Date.now() < end) {
    try { last = await evaluate(); error = null; } catch (e) { error = String(e?.message ?? e); last = undefined; }
    if (error === null && last) return last;
    await pause(100);
  }
  throw new Error(`timeout: ${what} (${JSON.stringify(last)}${error ? `; last error: ${error}` : ""})`);
}

// The process listening on a TCP port (lsof), or null.
function listenerOf(port) {
  try { return Number(execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n")[0]) || null; } catch { return null; }
}
// The command line of a process (ps), or "".
function argsOf(pid) {
  try { return execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" }); } catch { return ""; }
}

// The application with its own --user-data-dir. `child.pid` is the main process itself (Electron binary, no wrapper).
// `executable`: a packaged app's binary instead of the development build; without `providers` the real CLIs are used.
// Any failure after the spawn stops this launch's own child (SIGTERM, SIGKILL after `killAfterMs`), waits for its exit,
// closes the WebSocket and rethrows the original error (a cleanup failure is attached as `cleanupError`). Callers end
// with `app.stop()` in finally: idempotent, touches only the own child. The second argument is for tests only.
// `switches`: extra Chromium switches for the test window.
// `hermetic` (default): the app runs with hermeticEnv() (scripts/smoke-watchdog.mjs) and every program it starts is
// checked at exit; a packaged `executable` ignores the switch, so its programs are only reported. false: a run that
// means the real CLIs (the real-* series, --real-cli).
// The window stays painted and its timers run while other windows cover it: a covered window is "hidden" to Chromium,
// which stops frames (a screenshot then never returns) and slows timers. This hides the open product case "the app
// minimised or covered" (docs/agent-orchestration/TROUBLESHOOTING.md T135): smokes do not cover it.
export const PAINTED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const SHOT_TIMEOUT_MS = 15_000;
export async function launch({ userData, providers, port, shots, env = {}, executable, switches = [], hermetic = true },
  { spawnFn = spawn, fetchFn = fetch, WebSocketImpl = WebSocket, listenerOf: ownerOf = listenerOf, argsOf: argsFor = argsOf, pause = sleep, killAfterMs = 20_000 } = {}) {
  // A port already served by another window (a parallel run, a leftover app) would be driven instead of this one:
  // the new app cannot bind it and the page list below comes from the other.
  if (await fetchFn(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)) throw new Error(`port ${port} is taken by another DevTools server`);
  step(`launch ${userData}`);
  const extra = { ...(providers ? { CANVASTTY_ORCHESTRATION_TEST_PROVIDERS: providers } : {}), ...env };
  const flags = [...new Set([...PAINTED, ...switches])];
  console.log("occluded-window throttling disabled for smoke");
  if (hermetic) console.log(`[smoke] hermetic: PATH=${HERMETIC_PATH}${executable ? " (a packaged app ignores CANVASTTY_SMOKE_HERMETIC: its programs are reported, not checked)" : ""}`);
  const child = spawnFn(executable ?? electronPath, [...(executable ? [] : [ROOT]), `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, ...flags], {
    env: hermetic ? hermeticEnv(extra) : { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"]
  });
  watch(child, "app", { check: hermetic, report: !!executable, allow: executable ? [executable.replace(/(\.app)\/.*$/, "$1")] : [] });
  let out = "";
  // the app's own smoke lines ("[smoke] …") belong to the smoke's log
  child.stdout.on("data", (c) => { for (const l of String(c).split("\n")) if (l.startsWith("[smoke]")) console.log(l); });
  child.stdout.on("data", (c) => { out = (out + c).slice(-64 * 1024); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-64 * 1024); });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (e) => resolve({ code: null, signal: null, error: String(e?.message ?? e) }));
  });
  let ws = null;
  const alive = () => child.exitCode === null && child.signalCode === null;
  async function stop() {
    try { ws?.close(); } catch {}
    if (alive()) child.kill("SIGTERM");
    const timer = setTimeout(() => { if (alive()) child.kill("SIGKILL"); }, killAfterMs);
    try { return await exited; } finally { clearTimeout(timer); }
  }
  try {
    return await drive();
  } catch (error) {
    try { await stop(); } catch (e) { if (error && typeof error === "object") error.cleanupError = e; }
    throw error;
  }

  async function drive() {
    let page;
    for (let i = 0; i < 120 && !page; i++) {
      await pause(250);
      page = await fetchFn(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((ts) => ts.find((t) => t.type === "page" && t.url.startsWith("file:"))).catch(() => undefined);
    }
    // Only this launch's own window is driven: the DevTools port must be served by the child just spawned, started with
    // this userData. Anything else is refused (and only the own child is stopped, never the other process).
    if (!page) throw new Error(`no window. Output:\n${out.slice(-3000)}`);
    const owner = ownerOf(port);
    if (owner !== child.pid) throw new Error(`port ${port} is served by pid ${owner}, not by the launched app (pid ${child.pid})`);
    if (!argsFor(owner).includes(`--user-data-dir=${userData}`)) throw new Error(`pid ${owner} does not run with this launch's userData`);
    ws = new WebSocketImpl(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = (e) => reject(new Error(`WebSocket ${page.webSocketDebuggerUrl}: ${e?.message ?? "error"}`)); });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); };
    ws.onclose = () => { for (const f of pending.values()) f({ error: { message: "connection closed" } }); pending.clear(); };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const app = {
      child,
      exited,
      call,
      async ev(expression) {
        const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value;
      },
      waitFor: (expression, what, ms = 20_000) => waitForValue(() => app.ev(expression), what, ms),
      async center(selector) {
        const c = await app.ev(`(() => { const el = ${selector}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        if (!c) throw new Error(`no element: ${selector}`);
        return c;
      },
      mouse: (type, x, y, button = "left", buttons = 0) => call("Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount: type === "mouseMoved" ? 0 : 1 }),
      // A point where the element is really hit (elementFromPoint lands inside it, as in clickEl), measured once its
      // rectangle is the same over two frames: its centre, else the first hit point of a 5×5 grid over it. No such point
      // (or still moving after 30 frames): an error naming why.
      async pointOn(selector) {
        const r = await app.ev(`(async () => { const el = ${selector}; if (!el) return { error: "no element" };
          const frame = () => new Promise((f) => requestAnimationFrame(f)), key = () => JSON.stringify(el.getBoundingClientRect());
          let prev = key(), n = 0;
          for (await frame(); key() !== prev; await frame()) { prev = key(); if (++n > 30) return { error: "still moving after 30 frames" }; }
          const b = el.getBoundingClientRect();
          const f = [.1, .3, .5, .7, .9];
          for (const [i, j] of [[.5, .5], ...f.flatMap((i) => f.map((j) => [i, j]))]) {
            const x = b.left + b.width * i, y = b.top + b.height * j;
            const h = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
            if (h && el.contains(h)) return { x, y };
          }
          const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return { error: h ? "covered by " + (h.closest("[data-agent-id]") ? "agent " + h.closest("[data-agent-id]").dataset.agentId + " " : "") + (h.className || h.tagName) : "outside the window" }; })()`);
        if (r.error) throw new Error(`no visible point on ${selector}: ${r.error}`);
        return r;
      },
      async click(x, y, button = "left") {
        await app.mouse("mouseMoved", x, y);
        await app.mouse("mousePressed", x, y, button, button === "left" ? 1 : 2);
        await app.mouse("mouseReleased", x, y, button, 0);
        await sleep(120);
      },
      // A click is made only where the element is really hit: first it is brought into view (the canvas is panned by a
      // drag on empty canvas, the run panel is scrolled with the wheel), then elementFromPoint must land inside it.
      async clickEl(selector) {
        step(`click ${selector.slice(0, 200)}`);
        await app.reveal(selector);
        const c = await app.center(selector);
        const hit = await app.ev(`(() => { const el = ${selector}; const h = document.elementFromPoint(${c.x}, ${c.y}); return !!el && !!h && (el === h || el.contains(h)); })()`);
        if (!hit) throw new Error(`not clickable (covered or outside the window): ${selector}`);
        await app.click(c.x, c.y);
      },
      async reveal(selector) {
        for (let i = 0; i < 30; i++) {
          const r = await app.ev(`(() => { const el = ${selector}; if (!el) return null; const r = el.getBoundingClientRect();
            const scroller = el.closest(".orch-summary, .orch-panel__body, .orch-dialog"); // the panel's body or a dialog taller than the window
            const sbox = scroller?.getBoundingClientRect() ?? { left: 0, top: 40, right: innerWidth, bottom: innerHeight };
            // a dialog's pinned bottom (Start / Save) covers what scrolls under it: the visible part ends above it
            const foot = scroller?.matches(".orch-dialog") ? scroller.querySelector(".orch-form__actions") : null;
            const box = { left: sbox.left, top: sbox.top, right: sbox.right, bottom: foot && !foot.contains(el) ? Math.min(sbox.bottom, foot.getBoundingClientRect().top) : sbox.bottom };
            return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
              panel: !!scroller, box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
              scene: !!el.closest(".workspace__scene"), w: innerWidth, h: innerHeight }; })()`);
          if (!r) throw new Error(`no element: ${selector}`);
          const inside = r.top >= r.box.top + 4 && r.bottom <= r.box.bottom - 4 && r.left >= r.box.left + 4 && r.right <= r.box.right - 4;
          const free = !r.scene || (await app.ev(`(() => { const el = ${selector}; const h = document.elementFromPoint(${r.cx}, ${r.cy}); return !!h && el.contains(h); })()`));
          if (inside && free) return;
          if (r.panel) {
            const dy = r.top < r.box.top ? r.top - r.box.top - 40 : r.bottom - r.box.bottom + 40;
            // over the top of the panel's body, away from a scrollable text block
            await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: (r.box.left + r.box.right) / 2, y: r.box.top + 12, deltaX: 0, deltaY: dy });
            await sleep(150);
            continue;
          }
          if (!r.scene) throw new Error(`outside the window: ${selector}`);
          await app.panBy({ x: r.w / 2 - r.cx, y: r.h / 2 - r.cy });
        }
        throw new Error(`could not bring into view: ${selector} ${JSON.stringify(await app.ev(`(() => { const el = ${selector}; const b = el.closest(".orch-panel__body"); const r = el.getBoundingClientRect(); return { r: r.toJSON(), st: b?.scrollTop, sh: b?.scrollHeight, ch: b?.clientHeight, br: b?.getBoundingClientRect().toJSON() }; })()`))}`);
      },
      // Empty canvas at (x, y): the workspace itself, not a card, HOME, a menu, a dialog, the panel or an overlay.
      isEmpty: (x, y) => app.ev(`(() => { const el = document.elementFromPoint(${x}, ${y}); return !!el && !!el.closest(".workspace")
        && !el.closest('.home-zone, [data-canvas-layer-id], [data-interactive="true"], .canvas-overlay-slot > *, .canvas-menu, .agent-link__chip, .dialog-backdrop, .orch-panel, .orch-linking-hint, .radial-launcher'); })()`),
      // A free rectangle of the canvas (every sample point empty), scanning the window; null if there is none.
      async freeRect(w, h) {
        return app.ev(`(() => {
          const empty = (x, y) => { const el = document.elementFromPoint(x, y); return !!el && !!el.closest(".workspace")
            && !el.closest('.home-zone, [data-canvas-layer-id], [data-interactive="true"], .canvas-overlay-slot > *, .canvas-menu, .agent-link__chip, .dialog-backdrop, .orch-panel, .orch-linking-hint, .radial-launcher'); };
          for (let y = 60; y + ${h} < innerHeight - 10; y += 20) for (let x = 10; x + ${w} < innerWidth - 10; x += 20) {
            let ok = true;
            for (let i = 0; i <= 4 && ok; i++) for (let j = 0; j <= 4 && ok; j++) ok = empty(x + (${w} * i) / 4, y + (${h} * j) / 4);
            if (ok) return { x, y };
          }
          return null; })()`);
      },
      // Pans by dragging empty canvas: the start is a hit-tested empty point from which the whole move stays inside the window.
      async panBy(delta) {
        const W = await app.ev("innerWidth"), H = await app.ev("innerHeight");
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        let best = null;
        for (let y = 60; y < H - 20; y += 40) for (let x = 20; x < W - 20; x += 40) {
          const end = { x: clamp(x + delta.x, 10, W - 10), y: clamp(y + delta.y, 50, H - 10) };
          const gain = Math.abs(end.x - x) + Math.abs(end.y - y);
          if ((!best || gain > best.gain) && await app.isEmpty(x, y)) best = { start: { x, y }, end, gain };
        }
        if (!best) throw new Error("no empty canvas to drag");
        await app.drag(best.start, best.end, 20);
      },
      async drag(from, to, steps = 12) {
        await app.mouse("mouseMoved", from.x, from.y);
        await app.mouse("mousePressed", from.x, from.y, "left", 1);
        for (let i = 1; i <= steps; i++) {
          await app.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, "left", 1);
          await sleep(16);
        }
        await app.mouse("mouseReleased", to.x, to.y, "left", 0);
        await sleep(150);
      },
      async key(key, code = key, keyCode = 0, text) {
        await call("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, text });
        await call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
        await sleep(120);
      },
      async type(selector, value) {
        await app.ev(`(() => { const el = ${selector}; el.focus(); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await sleep(60);
      },
      // A screenshot answers within SHOT_TIMEOUT_MS or is asked once more; then the step fails by name, it never
      // waits for the run's time limit.
      async shot(name) {
        step(`shot ${name}`);
        let failure;
        for (let attempt = 1; attempt <= 2; attempt++) {
          let timer;
          try {
            const r = await Promise.race([call("Page.captureScreenshot", { format: "png" }),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${SHOT_TIMEOUT_MS / 1000} s`)), SHOT_TIMEOUT_MS); })]);
            fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.data, "base64"));
            return;
          } catch (e) {
            failure = e;
          } finally {
            clearTimeout(timer);
          }
        }
        throw new Error(`screenshot "${name}" failed twice: ${failure?.message ?? failure}`);
      },
      // Soft quit (SIGTERM, Electron's before-quit path), SIGKILL after the timeout; resolves with the exit.
      quit: stop,
      // The same, idempotent: for finally blocks, after a quit or a failed step.
      stop,
      output: () => out
    };
    await app.waitFor("document.querySelector('.workspace') && window.canvasTTY?.orchestration && true", "canvas");
    await pause(800);
    return app;
  }
}

export const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
// Seen as it is, without any scrolling: inside the window, not cut off by a scrolling ancestor, and hit at its centre.
export const visibleNow = (app, selector) => app.ev(`(() => { const el = ${selector}; if (!el) return { exists: false, ok: false }; const r = el.getBoundingClientRect();
  let ok = r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  for (let p = el.parentElement; p; p = p.parentElement) { if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowY)) { const b = p.getBoundingClientRect(); if (r.top < b.top - 1 || r.bottom > b.bottom + 1) ok = false; } }
  const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { exists: true, ok: ok && !!h && el.contains(h), top: Math.round(r.top), bottom: Math.round(r.bottom) }; })()`);
// The run panel's tabs (overview, activity, changes, log, history).
export const openTab = (app, tab) => app.clickEl(q(`[data-orch-tab="${tab}"]`));
export const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
export const card = (agentId, inner = "") => q(`[data-agent-id="${agentId}"] ${inner}`.trim());
export const canvasState = (app) => app.ev("window.canvasTTY.orchestration.canvas().then((r) => r.value)");
export const runs = (app) => app.ev("window.canvasTTY.orchestration.list().then((r) => r.value.map((s) => ({ runId: s.view.runId, status: s.view.status, reason: s.view.reason, open: s.open })))");
export const cardText = (app, agentId, inner) => app.ev(`${card(agentId, inner)}?.textContent ?? null`);

// The card appears with its top-left corner at the pressed point: the point is chosen so that the whole card
// (at the current zoom, with room for the port and the link chip) lands on empty canvas. If there is none, the
// canvas is panned by a drag on empty canvas and the search repeats.
export async function createAgent(app, label, projectDir) {
  const zoom = await app.ev(`Number(${q(".workspace__scene")}.style.transform.match(/scale\\(([\\d.]+)\\)/)[1])`);
  let spot = null;
  for (let i = 0; i < 4 && !spot; i++) {
    spot = await app.freeRect(Math.ceil(300 * zoom) + 60, Math.ceil(176 * zoom) + 40);
    if (!spot) await app.panBy({ x: -500, y: 0 });
  }
  if (!spot) throw new Error("no empty canvas for a card");
  const point = { x: spot.x + 20, y: spot.y + 20 };
  if (!(await app.isEmpty(point.x, point.y))) throw new Error(`not empty canvas at ${JSON.stringify(point)}`);
  await app.click(point.x, point.y, "right");
  await app.waitFor(`${byText(".canvas-menu [role=menuitem]", label)} && true`, `menu item ${label}`);
  await app.clickEl(byText(".canvas-menu [role=menuitem]", label));
  await app.waitFor(`${q(".orch-dialog input")} && true`, "agent dialog");
  await app.type(q(".orch-dialog input"), projectDir);
  await app.clickEl(q(".orch-dialog button[type=submit]"));
  await app.waitFor(`!${q(".orch-dialog")}`, "agent dialog closed");
}

// The goal dialog of a link, filled and submitted; resolves when the run panel is open. `onDialog` runs checks on the
// open dialog before the submit.
// Stage 12: `commands` are the check lines typed into the dialog (omitted: the ones readiness suggests from the project's
// files are kept); `workMode` picks the work place. Omitted: the project folder, as before PR 5 made «a separate copy»
// the dialog's default for a new project — the smokes keep what they were written for unless they ask.
export async function startGoal(app, linkId, { reviewPlan = false, task = "add a file src/note.mjs", criteria = "src/note.mjs exists\nnode --test passes", commands, workMode, onDialog, acknowledge = true } = {}) {
  await app.clickEl(byText(`[data-agent-link-id="${linkId}"] button`, "Новая цель"));
  await app.waitFor(`${q(".orch-dialog textarea")} && true`, "goal dialog");
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[0]`, task);
  await app.type(`document.querySelectorAll(".orch-dialog textarea")[1]`, criteria);
  // stage 13: the dialog starts from the project settings; they are loaded before anything is changed
  await app.waitFor(`${q("[data-orch-profile]")} && ${q("[data-orch-profile]")}.dataset.orchProfile !== "loading"`, "project settings", 20_000);
  if (commands) await app.type(q("[data-orch-commands]"), commands.join("\n"));
  const mode = workMode ?? "project";
  const switching = mode !== await app.ev(`${q("[data-orch-workmode]")}?.dataset.orchWorkmode`);
  if (switching || reviewPlan) await app.ev(`${q(".orch-dialog .orch-advanced")}.open = true`);
  if (switching) await app.clickEl(q(`[data-orch-workmode] input[value="${mode}"]`));
  if (switching && !workMode && !reviewPlan) await app.ev(`${q(".orch-dialog .orch-advanced")}.open = false`);
  await onDialog?.();
  if (reviewPlan) await app.clickEl(`[...document.querySelectorAll(".orch-dialog .orch-check")].find((l) => l.textContent.includes("Показать план")).querySelector("input")`);
  // Readiness is asked from main after the text settles; items to confirm are acknowledged like a user would.
  await app.waitFor(`["ready", "confirm", "blocked", "error"].includes(${q("[data-orch-readiness]")}?.dataset.orchReadiness)`, "readiness", 15_000);
  const confirms = await app.ev(`document.querySelectorAll(".orch-ready__item--confirm input[type=checkbox]").length`);
  if (acknowledge) for (let i = 0; i < confirms; i += 1) await app.clickEl(`document.querySelectorAll(".orch-ready__item--confirm input[type=checkbox]")[${i}]`);
  await app.waitFor(`!${q(".orch-dialog button[type=submit]")}.disabled`, "start enabled", 10_000);
  await app.clickEl(q(".orch-dialog button[type=submit]"));
  await app.waitFor(`${q(".orch-panel")} && !${q(".orch-dialog")}`, "run panel after start");
}
