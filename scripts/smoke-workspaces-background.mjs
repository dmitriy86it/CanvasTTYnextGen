// Project workspaces with the window in the background, as in an ordinary launch: no Chromium switch that keeps a
// covered or minimized window painted (smoke-workspaces-ui.mjs uses them for reproducible screenshots; this check must
// not). Fake Codex/Claude CLIs, a temporary userData, projects and HOME; no real model, no user data.
//
// It tells three things apart: output that is drawn late because the window was hidden (normal), data lost while
// hidden, and a wrong state written while hidden. And it reproduces a switch of workspace while a wheel pan still waits
// for its frame: the pan was made in A and must not move B's camera.
// Needs `npm run build` first. Usage: node scripts/smoke-workspaces-background.mjs [--shots <dir>]
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, launch, q, sleep, workspace, JOURNAL_V2 } from "./orchestration-app-kit.mjs";

const { D, project, script } = workspace("cto-ws-background-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9950 + Math.floor(Math.random() * 40);
const failures = [];
const passed = [];
const notes = {};
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 500)}`); };

const projectA = project("alpha");
// The build's journal version (JOURNAL_V2): in v2 the lead plans with a condition (R1 by the check) and the reviewer
// answers in v2 forms (journal-v2-format.md §2.7, §2.8), as in smoke-activity-ui.
const planV2 = (title, task) => ({ report: { stages: [{ title, task, conditions: [{ keep: null, text: "node --test passes", covers: ["R1"], evidence: { kind: "check", check: "cmd-1" } }] }],
  dropped: [], dropRequirements: [], question: null } });
const reviewV2 = { report: { conditions: [], findings: [], request: "none", question: null } };
const finalV2 = { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "node --test passes" }] } };
const plan = (title, task) => (JOURNAL_V2 ? planV2(title, task) : { report: { stages: [{ title, task }], question: null } });
const review = JOURNAL_V2 ? reviewV2 : { report: { verdict: "accept", findings: [], question: null } };
const final = JOURNAL_V2 ? finalV2 : { report: { verdict: "complete", findings: [], question: null } };
const codexScript = script("codex", [plan("Заметка", "Add src/note.mjs"), review, final]);
const claudeScript = script("claude", [
  { report: { summary: "Добавлен src/note.mjs.", done: true }, writes: [["src/note.mjs", "export const note = 1;\n"]] }
]);
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
fs.mkdirSync(D("home"), { recursive: true });
const ledger = D("ledger.jsonl");
const HOLD = { codex: D("hold-codex"), claude: D("hold-claude") };
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\n${p === "claude" ? `case "$*" in *--json-schema*) while [ -e "${HOLD[p]}" ]; do sleep 0.1; done ;; esac` : `case "$*" in --help*|--version*|*generate-json-schema*) ;; *) while [ -e "${HOLD[p]}" ]; do sleep 0.1; done ;; esac`}\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const SHELL = D("login-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, ...extra });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: PATHS, env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({ MOCK_SCRIPT: claudeScript }) },
  shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));
const hold = (p, on) => (on ? fs.writeFileSync(HOLD[p], "") : fs.rmSync(HOLD[p], { force: true }));
const USER_DATA = D("user-data");

let app;
const api = (expr) => app.ev(`(async () => { const o = window.canvasTTY.orchestration; const w = window.canvasTTY.workspaces; const r = await (${expr}); if (r && r.ok === false) throw new Error(r.code + " " + r.message); return r && "ok" in r ? r.value : r; })()`);
const viewOf = (runId) => api(`o.get(${JSON.stringify(runId)})`).then((s) => s.view);
const pageReady = async () => {
  await app.waitFor("document.querySelector('.workspace') && document.querySelector('[data-workspace-bar]') && window.canvasTTY?.orchestration && true", "canvas");
  await sleep(800);
};
const size = (width, height) => app.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
const tab = (id) => q(`[data-workspace-tab="${id}"]`);
const state = () => api("w.get()");
const stored = async (id) => (await state()).workspaces.find((w) => w.id === id).camera;
const cameraNow = () => app.ev(`(() => { const m = ${q(".workspace__scene")}.style.transform.match(/translate\\(([-\\d.]+)px, ([-\\d.]+)px\\) scale\\(([\\d.]+)\\)/); return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) }; })()`);
const near = (a, b) => !!a && !!b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.zoom - b.zoom) < 1e-6;
const visibility = () => app.ev("document.visibilityState");
const switchTo = async (id) => {
  await app.clickEl(tab(id));
  await app.waitFor(`${tab(id)}?.getAttribute("aria-selected") === "true"`, `workspace ${id} active`);
  await sleep(300);
};
const chord = async (key, code, keyCode) => {
  await app.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers: 4 });
  await app.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers: 4 });
};
// An empty point of the canvas: the wheel there pans the camera (checked with elementFromPoint, as a person's pointer).
const EMPTY = { x: 900, y: 520 };
const wheel = (dy) => app.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: EMPTY.x, y: EMPTY.y, deltaX: 0, deltaY: dy });
// Poll from this process, never from a page timer: timers of a hidden page are slowed, and that is what is measured.
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(100); }
  return null;
}
async function hide() {
  await app.ev("window.canvasTTY.window.minimize()");
  return until(async () => (await visibility()) === "hidden", 10_000);
}
async function show() {
  await app.call("Page.bringToFront", {});
  let ms = await until(async () => (await visibility()) === "visible", 5_000);
  if (ms === null) { // a minimized window that bringToFront did not restore: maximize restores it on macOS
    await app.ev("window.canvasTTY.window.toggleMaximize()");
    ms = await until(async () => (await visibility()) === "visible", 5_000);
    notes.restoredBy = "toggleMaximize";
  } else notes.restoredBy ??= "Page.bringToFront";
  return ms;
}

try {
  app = await launch({ userData: USER_DATA, providers, port: PORT, shots: SHOTS, env: { HOME: D("home"), SHELL: "/bin/sh" } });
  await size(1280, 800);
  await pageReady();
  const A = (await api(`w.create(${JSON.stringify({ title: "Альфа", root: projectA, activate: false })})`)).workspaces.at(-1).id;
  const B = (await api(`w.create(${JSON.stringify({ title: "Бета", root: null, activate: false })})`)).workspaces.at(-1).id;
  await app.call("Page.reload", {});
  await pageReady();
  await switchTo(A);
  expect(await app.ev(`(() => { const h = document.elementFromPoint(${EMPTY.x}, ${EMPTY.y}); return !!h && !h.closest('[data-interactive="true"], [data-canvas-layer-id]'); })()`), "the wheel point is empty canvas", null);

  // ---------- 1. work goes on while the window is minimized; nothing is lost; the view catches up on return ----------
  const bounds = (x, y) => ({ position: { x, y }, size: { width: 300, height: 222 } });
  const lead = await api(`o.createAgent(${JSON.stringify({ agentId: randomUUID(), provider: "codex", project: projectA, workspaceId: A, bounds: bounds(1500, 40) })})`);
  const exec = await api(`o.createAgent(${JSON.stringify({ agentId: randomUUID(), provider: "claude", project: projectA, workspaceId: A, bounds: bounds(1900, 40) })})`);
  const link = await api(`o.createLink(${JSON.stringify({ linkId: randomUUID(), fromAgentId: lead.agentId, toAgentId: exec.agentId })})`);
  const term = await api(`window.canvasTTY.terminal.create({ provider: "terminal", profile: "normal", cwd: ${JSON.stringify(projectA)}, position: { x: 1500, y: 700 }, workspaceId: ${JSON.stringify(A)} })`);
  hold("claude", true);
  const goal = { text: "Заметка", criteria: ["node --test passes"], checks: [], commands: ["node --test"], workMode: "project", mode: "autopilot" };
  const runId = (await api(`o.startOnLink(${JSON.stringify({ linkId: link.linkId, requestId: randomUUID(), goal })})`)).runId;
  for (let i = 0; i < 300 && !((await viewOf(runId)).active?.purpose === "execute"); i++) await sleep(150);
  await app.call("Page.reload", {}); // the cards and the run made through the API, read as after any start
  await pageReady();
  await app.waitFor(`${q(`[data-activity-run="${runId}"]`)} && ${q(`[data-canvas-layer-id="terminal:${term.id}"] .xterm-rows`)} && true`, "run in the widget, terminal drawn");
  expect(!(await app.ev(`!!${q(`[data-activity-recent="${runId}"]`)}`)), "before hiding: the run is at work, not among the results", null);

  notes.hideMs = await hide();
  expect(notes.hideMs !== null, "the minimized window is hidden to the page (no switch keeps it painted)", await visibility());
  const END = `END_${Date.now()}`;
  // 200 numbered lines while hidden, then the run is let go and finishes while hidden
  await app.ev(`window.canvasTTY.terminal.input(${JSON.stringify(term.id)}, "i=1; while [ $i -le 200 ]; do echo LINE_$i; i=$((i+1)); done; echo ${END}\\n")`);
  hold("claude", false);
  const doneMs = await until(async () => (await viewOf(runId)).status === "completed", 60_000);
  expect(doneMs !== null, "while hidden: the run goes on to completed in main", (await viewOf(runId)).status);
  const buf = await app.ev(`window.canvasTTY.terminal.readBuffer(${JSON.stringify(term.id)}).then((b) => b.buffer)`);
  const lines = [...buf.matchAll(/LINE_(\d+)\r?\n/g)].map((m) => Number(m[1]));
  expect(buf.includes(END) && [...Array(200)].every((_, i) => lines.includes(i + 1)), "while hidden: every line reached main's buffer (no loss)", { lines: lines.length, end: buf.includes(END) });
  notes.hiddenAfterWork = await visibility();
  notes.drawnWhileHidden = await app.ev(`${q(`[data-canvas-layer-id="terminal:${term.id}"] .xterm-rows`)}?.textContent.includes(${JSON.stringify(END)})`);
  notes.widgetUpdatedWhileHidden = await app.ev(`!!${q(`[data-activity-recent="${runId}"]`)}`);

  notes.showMs = await show();
  expect(notes.showMs !== null, "the window is visible again", await visibility());
  notes.terminalCatchUpMs = await until(() => app.ev(`${q(`[data-canvas-layer-id="terminal:${term.id}"] .xterm-rows`)}?.textContent.includes(${JSON.stringify(END)})`), 10_000);
  expect(notes.terminalCatchUpMs !== null, "after the return: the terminal shows the last line printed while hidden", null);
  notes.widgetCatchUpMs = await until(() => app.ev(`!!${q(`[data-activity-recent="${runId}"]`)} && !${q(`[data-activity-run="${runId}"]`)}`), 10_000);
  expect(notes.widgetCatchUpMs !== null, "after the return: the widget shows the run as finished, as main has it", null);
  await app.shot("1-after-return");

  // ---------- 2. a finished gesture, then the window goes to the background: the camera is still saved for A ----------
  const beforeGesture = await cameraNow();
  await wheel(240);
  await until(async () => !near(await cameraNow(), beforeGesture), 3_000);
  await sleep(100); // the gesture is over: its frame is drawn
  const camA = await cameraNow();
  expect(!near(camA, beforeGesture), "the wheel moved A's camera", { beforeGesture, camA });
  await hide();
  notes.cameraSavedHiddenMs = await until(async () => near(await stored(A), camA), 15_000);
  expect(notes.cameraSavedHiddenMs !== null, "hidden right after the gesture: A's camera is saved for A (maybe late)", { stored: await stored(A), camA });
  await show();
  await app.quit();
  app = await launch({ userData: USER_DATA, providers, port: PORT + 1, shots: SHOTS, env: { HOME: D("home"), SHELL: "/bin/sh" } });
  await size(1280, 800);
  await pageReady();
  expect((await state()).activeId === A && near(await cameraNow(), camA), "after a restart: A with the camera of that gesture", { now: await cameraNow(), camA });

  // ---------- 3. a switch while a wheel pan of A waits for its frame ----------
  // Frames are held in a queue, as when the switch comes before the next frame; then they run.
  const camB = await stored(B); // null: B was never shown, it opens at HOME
  await switchTo(B);
  const camBShown = await cameraNow();
  await switchTo(A);
  const camA2 = await cameraNow();
  await app.ev(`(() => { const q = []; let n = 1e7; window.__frames = q; window.__raf = window.requestAnimationFrame; window.__caf = window.cancelAnimationFrame;
    window.requestAnimationFrame = (cb) => { const id = ++n; q.push({ id, cb }); return id; };
    window.cancelAnimationFrame = (id) => { const i = q.findIndex((f) => f.id === id); if (i >= 0) q.splice(i, 1); else window.__caf(id); }; })()`);
  await wheel(300);
  await sleep(100);
  const queued = await app.ev("window.__frames.length");
  expect(queued > 0 && near(await cameraNow(), camA2), "a wheel pan of A waits for its frame", { queued, now: await cameraNow(), camA2 });
  const order = (await state()).workspaces.filter((w) => !w.closed).map((w) => w.id);
  await chord(String(order.indexOf(B) + 1), `Digit${order.indexOf(B) + 1}`, 48 + order.indexOf(B) + 1); // ⌘ digit of B
  await app.waitFor(`${tab(B)}?.getAttribute("aria-selected") === "true"`, "B by ⌘digit");
  notes.framesAtRelease = await app.ev(`(() => { const q = window.__frames.splice(0); window.requestAnimationFrame = window.__raf; window.cancelAnimationFrame = window.__caf; for (const f of q) f.cb(performance.now()); return q.length; })()`);
  await sleep(1_200); // past the camera saver's delay
  const bNow = await cameraNow();
  expect(near(bNow, camBShown), "the pending pan of A did not move B's camera", { bNow, camBShown });
  const bStored = await stored(B);
  expect(near(bStored, camBShown) || (camB === null && bStored === null) || near(bStored, camB ?? camBShown), "B's saved camera is B's own", { bStored, camBShown });
  expect(near(await stored(A), camA2), "A's saved camera is the one A showed at the switch", { stored: await stored(A), camA2 });
  await app.shot("3-after-pending-frame");

  // ---------- 4. a switch in the middle of a pointer pan of A (middle button held) ----------
  await switchTo(A);
  const camA3 = await cameraNow();
  const camB3 = await stored(B);
  const m = (type, x, y, buttons) => app.call("Input.dispatchMouseEvent", { type, x, y, button: "middle", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  await m("mousePressed", EMPTY.x, EMPTY.y, 4);
  await m("mouseMoved", EMPTY.x + 60, EMPTY.y + 40, 4);
  await sleep(150);
  expect(!near(await cameraNow(), camA3), "the middle-button drag pans A", { now: await cameraNow(), camA3 });
  await chord(String(order.indexOf(B) + 1), `Digit${order.indexOf(B) + 1}`, 48 + order.indexOf(B) + 1);
  await app.waitFor(`${tab(B)}?.getAttribute("aria-selected") === "true"`, "B by ⌘digit during the drag");
  await m("mouseMoved", EMPTY.x + 160, EMPTY.y + 120, 4);
  await sleep(100);
  await m("mouseReleased", EMPTY.x + 160, EMPTY.y + 120, 0);
  await sleep(1_200);
  expect(near(await cameraNow(), camB3) && near(await stored(B), camB3), "the rest of A's drag did not move or save B's camera", { now: await cameraNow(), stored: await stored(B), camB3 });
} catch (error) {
  failures.push(`error: ${error?.stack ?? error}`);
  await app?.shot("failure").catch(() => {});
} finally {
  await app?.stop();
  hold("claude", false);
  hold("codex", false);
}
console.log(JSON.stringify({ ok: failures.length === 0, passed, failures, notes, shots: SHOTS }, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
