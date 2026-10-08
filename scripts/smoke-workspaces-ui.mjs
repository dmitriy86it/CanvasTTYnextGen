// Electron UI smoke for project workspaces (docs/agent-orchestration/implementation/workspaces-spec.md §7 W1–W10)
// with fake Codex/Claude CLIs. Starts no real model and touches no user project or userData: temporary Git projects,
// a temporary userData seeded as an older installation left it, HOME and SHELL pointed at the temporary directory.
// Every click is a real mouse event on a point that elementFromPoint confirms lands on the element.
// Needs `npm run build` first. Usage: node scripts/smoke-workspaces-ui.mjs [--shots <dir>]
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, launch, q, sleep, startGoal, workspace } from "./orchestration-app-kit.mjs";

const { D, project, script } = workspace("cto-workspaces-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 500)}`); };

const projectA = project("alpha");
const projectB = project("beta");
const projectOld = project("legacy");
const codexScript = script("codex", [
  { report: { stages: [{ title: "Заметка", task: "Add src/note.mjs" }], question: null } }, // A1: plan
  { report: { stages: [{ title: "Импорт", task: "Add src/import.mjs" }], question: null } }, // B1: plan, after a question
  { report: { verdict: "accept", findings: [], question: null } }, // A1: review
  { report: { verdict: "complete", findings: [], question: null } }, // A1: final
  { report: { stages: [{ title: "Вторая заметка", task: "Add src/second.mjs" }], question: null } } // A2: plan
]);
fs.writeFileSync(path.join(codexScript, "2.asks.json"), JSON.stringify([{ tool: "question", question: "Какой формат импорта первым?", options: ["CSV", "JSON"] }]));
const claudeScript = script("claude", [
  { report: { summary: "Добавлен src/note.mjs.", done: true }, writes: [["src/note.mjs", "export const note = 1;\n"]] },
  { report: { summary: "Добавлен src/second.mjs.", done: true }, writes: [["src/second.mjs", "export const second = 1;\n"]] }
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
const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);
const hold = (p, on) => (on ? fs.writeFileSync(HOLD[p], "") : fs.rmSync(HOLD[p], { force: true }));

// ---------- an older installation: one canvas, every kind of card, no workspaces.json ----------
const USER_DATA = D("user-data");
fs.mkdirSync(path.join(USER_DATA, "orchestration"), { recursive: true });
const OLD_LEAD = randomUUID(), OLD_EXEC = randomUUID(), OLD_LINK = randomUUID();
fs.writeFileSync(path.join(USER_DATA, "settings.json"), JSON.stringify({
  settingsVersion: 15, locale: "ru", persistCanvasRegions: true, persistStickyNotes: true,
  canvasRegions: [{ id: "old-region", title: "Старая область", color: "#88AA44", position: { x: 1500, y: 900 }, size: { width: 700, height: 420 } }],
  stickyNotes: [{ id: "old-note", text: "Старая заметка", position: { x: 1560, y: 980 }, size: { width: 300, height: 220 } }]
}));
fs.writeFileSync(path.join(USER_DATA, "orchestration", "canvas.json"), JSON.stringify({ v: 1, agents: [
  { agentId: OLD_LEAD, provider: "codex", role: "lead", project: projectOld, bounds: { position: { x: 2300, y: 900 }, size: { width: 300, height: 222 } }, createdAt: "2026-09-01T00:00:00.000Z" },
  { agentId: OLD_EXEC, provider: "claude", role: "executor", project: projectOld, bounds: { position: { x: 2700, y: 900 }, size: { width: 300, height: 222 } }, createdAt: "2026-09-01T00:00:00.000Z" }
], links: [{ linkId: OLD_LINK, fromAgentId: OLD_LEAD, toAgentId: OLD_EXEC, createdAt: "2026-09-01T00:00:00.000Z", runIds: [] }] }));
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const before = { "settings.json": sha(path.join(USER_DATA, "settings.json")), [path.join("orchestration", "canvas.json")]: sha(path.join(USER_DATA, "orchestration", "canvas.json")) };

let app;
const api = (expr) => app.ev(`(async () => { const o = window.canvasTTY.orchestration; const w = window.canvasTTY.workspaces; const r = await (${expr}); if (r && r.ok === false) throw new Error(r.code + " " + r.message); return r && "ok" in r ? r.value : r; })()`);
const viewOf = (runId) => api(`o.get(${JSON.stringify(runId)})`).then((s) => s.view);
const waitView = async (runId, pred, what, ms = 60_000) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await viewOf(runId); if (pred(v)) return v; await sleep(150); }
  throw new Error(`timeout: ${what} ${JSON.stringify(v)?.slice(0, 400)}`);
};
const size = (width, height) => app.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
const pageReady = async () => {
  await app.waitFor("document.querySelector('.workspace') && document.querySelector('[data-workspace-bar]') && window.canvasTTY?.orchestration && true", "canvas");
  await sleep(800);
};
const reload = async () => { await app.call("Page.reload", {}); await sleep(500); await pageReady(); };
const text = (selector) => app.ev(`${selector}?.textContent ?? null`);
const tab = (id) => q(`[data-workspace-tab="${id}"]`);
const state = () => api("w.get()");
const cameraNow = () => app.ev(`(() => { const m = ${q(".workspace__scene")}.style.transform.match(/translate\\(([-\\d.]+)px, ([-\\d.]+)px\\) scale\\(([\\d.]+)\\)/); return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) }; })()`);
// The window stays painted while other windows cover it (the kit's PAINTED, for every smoke): found here in the run
// ws-final2, visibilityState "hidden", the rows empty until a screenshot forced a frame.
const near = (a, b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.zoom - b.zoom) < 1e-6;
const switchTo = async (id) => {
  await app.clickEl(tab(id));
  await app.waitFor(`${tab(id)}?.getAttribute("aria-selected") === "true"`, `workspace ${id} active`);
  await sleep(150);
};
// A right click on a card's header, where elementFromPoint confirms it, then "Move to workspace…".
const moveMenu = async (layerSelector, header) => {
  await app.reveal(q(`${layerSelector} ${header}`));
  const p = await app.pointOn(q(`${layerSelector} ${header}`));
  await app.click(p.x, p.y, "right");
  await app.waitFor(`${q("[data-ws-move-menu]")} && true`, "move menu item");
  await app.clickEl(q("[data-ws-move-menu]"));
  await app.waitFor(`${q("[data-ws-move]")} && true`, "move dialog");
};
// A key with ⌘ as the user presses it (Input events, not a synthetic DOM event).
const chord = async (key, code, keyCode) => {
  await app.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers: 4 });
  await app.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers: 4 });
  await sleep(200);
};
// The shell prints its own pid: the same process after every switch and move.
const pidOf = async (id, mark) => {
  await app.ev(`window.canvasTTY.terminal.input(${JSON.stringify(id)}, "echo ${mark}=$$\\n")`);
  const out = await app.waitFor(`window.canvasTTY.terminal.readBuffer(${JSON.stringify(id)}).then((b) => (b.buffer.match(/${mark}=(\\d+)/) ?? [])[1] ?? null)`, `pid ${mark}`);
  return out;
};

try {
  app = await launch({ userData: USER_DATA, providers, port: PORT, shots: SHOTS, env: { HOME: D("home"), SHELL: "/bin/sh" } });
  await size(1280, 800);
  await pageReady();

  // ---------- M: the older canvas is kept whole on the common canvas; the backup was made first ----------
  const s0 = await state();
  expect(s0.available && s0.workspaces.length === 1 && s0.workspaces[0].id === "common", "migration: one common canvas", s0);
  const backups = fs.readdirSync(path.join(USER_DATA, "backup"));
  const manifest = JSON.parse(fs.readFileSync(path.join(USER_DATA, "backup", backups[0], "manifest.json"), "utf8"));
  expect(backups.length === 1 && !backups[0].endsWith(".partial"), "migration: one finished backup", backups);
  expect(manifest.files.find((f) => f.file === "settings.json")?.sha256 === before["settings.json"]
    && manifest.files.find((f) => f.file === path.join("orchestration", "canvas.json"))?.sha256 === before[path.join("orchestration", "canvas.json")]
    && manifest.files.find((f) => f.file === "terminal-sessions.json")?.status === "absent", "migration: the backup holds the older files as they were; a file never made is absent", manifest);
  expect(sha(path.join(USER_DATA, "orchestration", "canvas.json")) === before[path.join("orchestration", "canvas.json")], "migration: canvas.json is not rewritten", null);
  expect(await app.ev(`!!${q('[data-canvas-region-id="old-region"]')} && !!${q('[data-sticky-note-id="old-note"]')} && !!${q(`[data-agent-id="${OLD_LEAD}"]`)} && !!${q(`[data-agent-id="${OLD_EXEC}"]`)} && !!${q(`[data-agent-link-id="${OLD_LINK}"]`)}`),
    "migration: the older region, note, agents and link are shown on the common canvas", null);
  const oldCanvas = await api("o.canvas()");
  expect(oldCanvas.agents.map((a) => a.bounds.position.x).join() === "2300,2700" && oldCanvas.agents.every((a) => a.workspaceId === undefined), "migration: agents keep their places and get no field", oldCanvas.agents);
  await app.shot("00-migrated-common-1280");

  // ---------- creating workspaces A and B through the dialog ----------
  const create = async (name, folder) => {
    await app.clickEl(q("[data-workspace-new]"));
    await app.waitFor(`${q("[data-ws-form]")} && true`, "new workspace dialog");
    await app.type(q("[data-ws-root]"), folder);
    await app.type(q("[data-ws-title]"), name);
    await app.clickEl(q("[data-ws-submit]"));
    await app.waitFor(`!${q("[data-ws-form]")}`, "dialog closed");
    const s = await state();
    return s.workspaces.find((w) => w.title === name).id;
  };
  const A = await create("Альфа", projectA);
  expect((await state()).activeId === A, "a new workspace opens", null);
  expect(!(await app.ev(`!!${q('[data-canvas-region-id="old-region"]')} || !!${q(`[data-agent-id="${OLD_LEAD}"]`)}`)), "the common canvas's cards are not drawn in A", null);
  const B = await create("Бета", projectB);
  // the same folder again: the dialog names the workspace that has it
  await app.clickEl(q("[data-workspace-new]"));
  await app.type(q("[data-ws-root]"), projectA);
  await app.waitFor(`${q("[data-ws-twin]")} && true`, "twin warning");
  expect(await app.ev(`${q("[data-ws-submit]")}.disabled`), "a second workspace for the same folder needs a choice", null);
  await app.clickEl(q("[data-ws-open-twin]"));
  await app.waitFor(`${tab(A)}.getAttribute("aria-selected") === "true" && !${q("[data-ws-form]")}`, "open the existing one");

  // ---------- W1: agents and a terminal in A and in B; both runs held at once ----------
  const bounds = (x, y) => ({ position: { x, y }, size: { width: 300, height: 222 } });
  const mk = (provider, project, ws, x, y) => api(`o.createAgent(${JSON.stringify({ agentId: randomUUID(), provider, project, workspaceId: ws, bounds: bounds(x, y) })})`);
  const leadA = await mk("codex", projectA, A, 1500, 40), execA = await mk("claude", projectA, A, 1900, 40);
  const leadB = await mk("codex", projectB, B, 1500, 40), execB = await mk("claude", projectB, B, 1900, 40);
  const linkA = await api(`o.createLink(${JSON.stringify({ linkId: randomUUID(), fromAgentId: leadA.agentId, toAgentId: execA.agentId })})`);
  const linkB = await api(`o.createLink(${JSON.stringify({ linkId: randomUUID(), fromAgentId: leadB.agentId, toAgentId: execB.agentId })})`);
  // same folder, different workspaces: main refuses the link for the workspaces, not the folder
  const stray = await mk("claude", projectA, B, 2300, 40);
  let refused = null;
  try { await api(`o.createLink(${JSON.stringify({ linkId: randomUUID(), fromAgentId: leadA.agentId, toAgentId: stray.agentId })})`); } catch (e) { refused = String(e.message); }
  expect(refused?.includes("link_workspaces"), "W6: a link across workspaces is refused in main", refused);
  await api(`o.deleteAgent(${JSON.stringify(stray.agentId)})`);
  // a terminal made while A is active (no workspace in the request: the active one, as for integrations)
  const termA = await api(`window.canvasTTY.terminal.create({ provider: "terminal", profile: "normal", cwd: ${JSON.stringify(projectA)}, position: { x: 1500, y: 700 } })`);
  expect(termA.workspaceId === A, "a terminal made in A belongs to A", termA.workspaceId);
  await app.waitFor(`${q(`[data-canvas-layer-id="terminal:${termA.id}"] .xterm-rows`)} && true`, "terminal in A drawn");
  const pid0 = await pidOf(termA.id, "PIDA");
  const goal = (t) => ({ text: t, criteria: ["node --test passes"], checks: [], commands: ["node --test"], workMode: "project", mode: "autopilot" });
  hold("claude", true);
  const runA = (await api(`o.startOnLink(${JSON.stringify({ linkId: linkA.linkId, requestId: randomUUID(), goal: goal("Заметка в alpha") })})`)).runId;
  await waitView(runA, (v) => v.active?.kind === "turn" && v.active.purpose === "execute", "A: executor at work");
  const runB = (await api(`o.startOnLink(${JSON.stringify({ linkId: linkB.linkId, requestId: randomUUID(), goal: goal("Импорт в beta") })})`)).runId;
  await waitView(runB, (v) => v.permission?.kind === "question", "B: the lead asks");
  await reload(); // cards and runs made through the API above are read as after any start
  const owners = (await api("o.canvas()")).owners;
  expect(owners[runA] === A && owners[runB] === B, "each run is owned by the workspace it was started in", owners);
  await app.waitFor(`${tab(A)}.querySelector("[data-ws-runs]")?.dataset.wsRuns === "1" && ${tab(B)}.querySelector("[data-ws-attention]")?.dataset.wsAttention === "1"`, "counts in the switcher", 20_000);
  expect(!(await app.ev(`!!${tab(A)}.querySelector("[data-ws-cli]")`)) && (await app.ev(`${tab(A)}.title`)).includes("открытых терминалов: 1"), "W1: the open shell is not counted as work, only named in the hint", await app.ev(`${tab(A)}.title`));
  expect(!(await app.ev(`!!${tab(B)}.querySelector("[data-ws-runs]")`)), "W1: B's run waits for the person: attention, not work", null);
  await app.shot("01-switcher-counts-1280");
  await size(1440, 900);
  await sleep(300);
  expect(await app.ev(`(() => { const r = ${q("[data-workspace-bar]")}.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; })()`), "the switcher fits at 1440×900", null);
  await app.shot("01b-switcher-counts-1440");
  await size(1280, 800);
  await sleep(300);
  expect(await app.ev(`(() => { const r = ${q("[data-workspace-bar]")}.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; })()`), "the switcher fits at 1280×800", null);

  // ---------- W3: the camera of each workspace; a late write of A never reaches B ----------
  await app.panBy({ x: -220, y: -90 });
  const camA = await cameraNow();
  await switchTo(B); // within the saver's delay: A's pending write must go to A
  const camB0 = await cameraNow();
  await app.panBy({ x: 160, y: 70 });
  await sleep(900);
  const camB = await cameraNow();
  let s1 = await state();
  const stored = (s, id) => s.workspaces.find((w) => w.id === id).camera;
  expect(near(stored(s1, A), camA), "W3: A's camera was saved for A", { stored: stored(s1, A), camA });
  expect(near(stored(s1, B), camB) && !near(camB0, camA), "W3: B keeps its own camera; A's late write did not touch it", { stored: stored(s1, B), camB, camB0 });

  // ---------- W6: B's cards are not drawn in A and A's are not hit in B ----------
  expect(await app.ev(`!${q(`[data-agent-id="${leadA.agentId}"]`)} && !${q(`[data-canvas-layer-id="terminal:${termA.id}"]`)} && !!${q(`[data-agent-id="${leadB.agentId}"]`)}`), "W6: in B only B's cards exist in the DOM", null);

  // ---------- W4: B asks while A is open: the widget row opens B and the question ----------
  await switchTo(A);
  expect(near(await cameraNow(), camA), "W3: A's camera is back after the switch", { now: await cameraNow(), camA });
  await app.waitFor(`${q(`[data-activity-run="${runB}"]`)} && true`, "B's run in the common widget");
  expect((await text(q(`[data-activity-run="${runB}"]`))).includes("Бета"), "W4: the widget names the workspace", await text(q(`[data-activity-run="${runB}"]`)));
  await app.clickEl(q(`[data-activity-run="${runB}"] .activity-run__main`));
  await app.waitFor(`${tab(B)}.getAttribute("aria-selected") === "true" && !!${q(".orch-panel")}`, "B and its run panel");
  expect((await app.ev(`${q(".orch-panel")}.textContent`)).includes("Какой формат импорта первым?"), "W4: the panel shows B's question", null);
  await app.shot("02-widget-opens-b-question-1280");
  await app.key("Escape", "Escape", 27);
  await app.waitFor(`!${q(".orch-panel")}`, "panel closed");

  // ⌘1 / ⌘2 on macOS switch by position, as the tabs are ordered
  if (process.platform === "darwin") {
    const order = (await state()).workspaces.filter((w) => !w.closed).map((w) => w.id);
    await chord("2", "Digit2", 50);
    await app.waitFor(`${tab(order[1])}.getAttribute("aria-selected") === "true"`, "⌘2");
    await chord("3", "Digit3", 51);
    await app.waitFor(`${tab(order[2])}.getAttribute("aria-selected") === "true"`, "⌘3");
    expect(true, "⌘2 and ⌘3 switch to the second and third workspace", order);
  }

  // ---------- W2: ten switches start nothing, stop nothing, keep every process and subscription ----------
  const ledger0 = ledgerCount();
  const runs0 = (await api("o.list()")).map((r) => r.view.runId).sort().join();
  let hiddenMark = null;
  for (let i = 0; i < 10; i++) {
    const target = i % 2 === 0 ? A : B;
    await switchTo(target);
    if (i === 3) { // B is open: A's terminal is hidden and keeps getting output
      hiddenMark = `HIDDEN_${Date.now()}`;
      await app.ev(`window.canvasTTY.terminal.input(${JSON.stringify(termA.id)}, "echo ${hiddenMark}\\n")`);
      await sleep(300);
    }
  }
  await switchTo(A);
  expect(ledgerCount() === ledger0, "W2: no CLI started by ten switches", { before: ledger0, after: ledgerCount() });
  expect((await api("o.list()")).map((r) => r.view.runId).sort().join() === runs0, "W2: no new run", null);
  expect((await viewOf(runA)).active?.purpose === "execute" && (await viewOf(runB)).permission?.kind === "question", "W2: both runs go on as they were", null);
  // xterm draws the rows of a terminal in view only: the card is brought into view as a person would scroll to it
  await app.reveal(q(`[data-canvas-layer-id="terminal:${termA.id}"] .terminal-card__header`));
  const shown = await app.waitFor(`${q(`[data-canvas-layer-id="terminal:${termA.id}"] .xterm-rows`)}?.textContent.includes(${JSON.stringify(hiddenMark)})`, "hidden output shown after return").catch(async (e) => {
    // Diagnostics only (the check has already failed): how many xterm surfaces the card has, whether the page is
    // visible and focused, and what the rows hold once a screenshot has forced a frame.
    const rowsSel = `document.querySelectorAll('[data-canvas-layer-id="terminal:${termA.id}"] .xterm-rows')`;
    const before = await app.ev(`({ surfaces: ${rowsSel}.length, text: [...${rowsSel}].map((r) => r.textContent.slice(-120)), visibility: document.visibilityState, focus: document.hasFocus() })`);
    await app.shot("w2-hidden-output-diagnostic");
    const afterShot = await app.ev(`[...${rowsSel}].some((r) => r.textContent.includes(${JSON.stringify(hiddenMark)}))`);
    throw new Error(`${e.message} mark ${hiddenMark} before: ${JSON.stringify(before)} after a screenshot: ${afterShot}`);
  });
  expect(shown, "W2: the output printed while the terminal was hidden is shown after the return", null);
  expect((await pidOf(termA.id, "PIDB")) === pid0, "W2: the same shell process after the switches", pid0);

  // ---------- W5: A's run ends while B is open; its summary from the widget and, after a restart, from A's history ----------
  await switchTo(B);
  hold("claude", false);
  await waitView(runA, (v) => v.status === "completed", "A completed", 90_000);
  await app.waitFor(`${q(`[data-activity-recent="${runA}"] .activity-recent__summary`)} && true`, "A in recent results");
  await app.clickEl(q(`[data-activity-recent="${runA}"] .activity-recent__summary`));
  await app.waitFor(`${tab(A)}.getAttribute("aria-selected") === "true" && !!${q("[data-sum='outcome']")}`, "A's summary from the widget");
  expect((await text(q("[data-sum='outcome']"))).length > 0, "W5: A's summary opens from the widget in A", await text(q("[data-sum='outcome']")));
  await app.shot("03-summary-from-widget-1280");

  // ---------- W7: a running terminal moves A → B without a restart ----------
  await app.key("Escape", "Escape", 27);
  await app.waitFor(`!${q(".orch-panel")}`, "panel closed");
  await moveMenu(`[data-canvas-layer-id="terminal:${termA.id}"]`, ".terminal-card__header");
  await app.ev(`(() => { const s = ${q("[data-ws-move-target]")}; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, ${JSON.stringify(B)}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await app.clickEl(q("[data-ws-move-submit]"));
  await app.waitFor(`!${q("[data-ws-move]")} && !${q(`[data-canvas-layer-id="terminal:${termA.id}"]`)}`, "terminal left A");
  await switchTo(B);
  await app.waitFor(`${q(`[data-canvas-layer-id="terminal:${termA.id}"]`)} && true`, "terminal in B");
  await app.reveal(q(`[data-canvas-layer-id="terminal:${termA.id}"] .terminal-card__header`));
  await app.waitFor(`${q(`[data-canvas-layer-id="terminal:${termA.id}"] .xterm-rows`)}?.textContent.includes(${JSON.stringify(hiddenMark)})`, "terminal in B with its output");
  expect((await pidOf(termA.id, "PIDC")) === pid0, "W7: the moved terminal is the same process with its output", pid0);

  // ---------- W8: a group with an unfinished run cannot move; after the stop it moves whole; history stays ----------
  await moveMenu(`[data-agent-id="${leadB.agentId}"]`, ".agent-card__header");
  expect(await app.ev(`!!${q("[data-ws-move-blocked]")} && ${q("[data-ws-move-submit]")}.disabled && ${q("[data-ws-move-group]")}.querySelectorAll("li").length === 2`), "W8: the group is shown; a run waiting for an answer blocks the move", null);
  await app.shot("04-move-group-blocked-1280");
  await app.key("Escape", "Escape", 27);
  let mainRefusal = null;
  try { await api(`o.moveAgentGroup(${JSON.stringify([leadB.agentId, execB.agentId])}, ${JSON.stringify(A)})`); } catch (e) { mainRefusal = String(e.message); }
  expect(mainRefusal?.includes("group_active_run"), "W8: main refuses the move by itself", mainRefusal);
  const vb = await viewOf(runB);
  await api(`o.command(${JSON.stringify({ runId: runB, commandId: randomUUID(), expectedRevision: vb.revision, command: { kind: "stop" } })})`);
  await waitView(runB, (v) => v.status === "stopped", "B stopped");
  await sleep(500);
  await moveMenu(`[data-agent-id="${leadB.agentId}"]`, ".agent-card__header");
  await app.waitFor(`!${q("[data-ws-move-submit]")}.disabled`, "move allowed after the stop");
  await app.ev(`(() => { const s = ${q("[data-ws-move-target]")}; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, ${JSON.stringify(A)}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await app.clickEl(q("[data-ws-move-submit]"));
  await app.waitFor(`!${q("[data-ws-move]")} && !${q(`[data-agent-id="${leadB.agentId}"]`)} && !${q(`[data-agent-id="${execB.agentId}"]`)}`, "the whole group left B");
  const moved = await api("o.canvas()");
  expect(moved.agents.filter((a) => [leadB.agentId, execB.agentId].includes(a.agentId)).every((a) => a.workspaceId === A) && moved.owners[runB] === B, "W8: both cards are in A, the run's history stays in B", moved.owners);
  await api(`o.deleteLink(${JSON.stringify(linkB.linkId)})`);
  await app.clickEl(q("[data-workspace-menu]"));
  await app.clickEl(q('[data-ws-action="history"]'));
  await app.waitFor(`${q(`[data-ws-history-run="${runB}"]`)} && true`, "B's run in B's history after its link is gone");
  await app.clickEl(q(`[data-ws-history-run="${runB}"] [data-ws-history-open]`));
  await app.waitFor(`!!${q(".orch-panel")} && !!${q("[data-sum='outcome']")}`, "the run opened by id");
  expect((await text(q("[data-sum='outcome']"))).length > 0, "W8: a run of a deleted link opens from the history", await text(q("[data-sum='outcome']")));
  await app.shot("05-history-deleted-link-1280");
  await app.key("Escape", "Escape", 27);

  // ---------- W10: the one browser is in the common canvas; B shows where it is and brings it with its tab ----------
  await switchTo("common");
  await app.ev("window.canvasTTY.browser.open('about:blank').then(() => true)");
  await app.ev(`window.canvasTTY.settings.update({ browserCanvas: { position: { x: 1500, y: 1500 }, size: { width: 920, height: 620 }, workspaceId: "common" } }).then(() => true)`);
  await reload();
  const tabs0 = (await app.ev("window.canvasTTY.browser.getState()")).tabs.map((t) => t.id).join();
  await switchTo(B);
  await chord("k", "KeyK", 75);
  const paletteItem = (label) => `[...document.querySelectorAll(".canvas-command-palette__results [role=option], .canvas-command-palette__results button")].find((b) => b.textContent.includes(${JSON.stringify(label)}))`;
  await app.waitFor(`!!${paletteItem("Пространство: Альфа")} && !!${paletteItem("Открыть браузер")}`, "palette with the workspace commands");
  expect(true, "the palette lists the workspaces", null);
  await app.type(q(".canvas-command-palette__search input"), "браузер");
  await app.clickEl(paletteItem("Открыть браузер"));
  await app.waitFor(`${q("[data-ws-browser-elsewhere]")} && true`, "browser elsewhere notice");
  expect((await text(q("[data-ws-browser-elsewhere]"))).includes("Общий холст"), "W10: B says where the browser is", await text(q("[data-ws-browser-elsewhere]")));
  await app.shot("06-browser-elsewhere-1280");
  await app.clickEl(q("[data-ws-browser-bring]"));
  await app.waitFor(`${q('[data-canvas-layer-id="browser"]')} && true`, "browser card in B");
  expect((await app.ev("window.canvasTTY.settings.get()")).browserCanvas.workspaceId === B
    && (await app.ev("window.canvasTTY.browser.getState()")).tabs.map((t) => t.id).join() === tabs0, "W10: the browser moved to B with its tabs", null);

  // ---------- W9: hiding a workspace with work: cancel, hide (work goes on), then stop and hide ----------
  hold("claude", true);
  const termA2 = await api(`window.canvasTTY.terminal.create({ provider: "terminal", profile: "normal", cwd: ${JSON.stringify(projectA)}, position: { x: 1500, y: 700 }, workspaceId: ${JSON.stringify(A)} })`);
  await switchTo(A);
  // the goal through the dialog of A's link, as a person starts it
  const runsBefore = new Set((await api("o.list()")).map((r) => r.view.runId));
  await startGoal(app, linkA.linkId, { task: "Вторая заметка", criteria: "node --test passes", commands: ["node --test"] });
  const runA2 = (await api("o.list()")).map((r) => r.view.runId).find((id) => !runsBefore.has(id));
  expect((await api("o.canvas()")).owners[runA2] === A, "a goal started from the dialog in A is owned by A", runA2);
  await waitView(runA2, (v) => v.active?.purpose === "execute", "A2: executor at work");
  await app.key("Escape", "Escape", 27);
  await app.waitFor(`!${q(".orch-panel")}`, "panel closed");
  const closeDialog = async () => {
    await app.clickEl(q("[data-workspace-menu]"));
    await app.clickEl(q('[data-ws-action="close"]'));
    await app.waitFor(`${q("[data-ws-close]")} && true`, "close dialog");
  };
  await closeDialog();
  expect(await app.ev(`document.querySelectorAll("[data-ws-close-item]").length === 2`), "W9: the dialog lists the run and the terminal", await text(q("[data-ws-close]")));
  await app.clickEl(q("[data-ws-close-cancel]"));
  expect(!(await state()).workspaces.find((w) => w.id === A).closed && (await viewOf(runA2)).active?.purpose === "execute", "W9: cancel changes nothing", null);
  await closeDialog();
  await app.clickEl(q("[data-ws-close-hide]"));
  await app.waitFor(`!${tab(A)}`, "A hidden from the switcher");
  const ledger1 = ledgerCount();
  expect((await viewOf(runA2)).active?.purpose === "execute" && (await pidOf(termA2.id, "PIDD")) !== null, "W9: hiding stops nothing", null);
  await app.waitFor(`${q(`[data-activity-run="${runA2}"]`)} && true`, "hidden work in the widget");
  await app.clickEl(q(`[data-activity-run="${runA2}"] .activity-run__main`));
  await app.waitFor(`${tab(A)}?.getAttribute("aria-selected") === "true" && !!${q(".orch-panel")}`, "the widget reopens the hidden workspace and its run");
  expect(ledgerCount() === ledger1, "W9: reopening starts nothing", null);
  await app.key("Escape", "Escape", 27);
  await closeDialog();
  await app.clickEl(q("[data-ws-close-stop]"));
  await app.waitFor(`${q("[data-ws-close-summary]")} && true`, "stop results");
  await app.shot("07-stop-and-hide-results-1280");
  await app.waitFor(`!${tab(A)} && !${q("[data-ws-close]")}`, "A hidden after everything stopped", 60_000);
  expect((await viewOf(runA2)).status === "stopped" && !(await app.ev("window.canvasTTY.terminal.list()")).some((s) => s.id === termA2.id), "W9: stop and hide stopped the run and the terminal of A", null);
  hold("claude", false);

  // ---------- reload and restart: the workspaces, their cameras and histories come back; nothing runs again ----------
  await switchTo(B);
  const camB2 = await cameraNow();
  const ledger2 = ledgerCount();
  const camAHidden = stored(await state(), A); // A was visited after W3 (W4, W8, W9): its camera now is the one saved on hiding
  await reload();
  expect((await state()).activeId === B && near(await cameraNow(), camB2), "after a reload: the same workspace and camera", { now: await cameraNow(), camB2 });
  await app.quit();
  app = await launch({ userData: USER_DATA, providers, port: PORT + 1, shots: SHOTS, env: { HOME: D("home"), SHELL: "/bin/sh" } });
  await size(1280, 800);
  await pageReady();
  s1 = await state();
  expect(s1.activeId === B && near(await cameraNow(), camB2), "after a restart: the same workspace and camera", { active: s1.activeId, now: await cameraNow(), camB2 });
  expect(s1.workspaces.find((w) => w.id === A).closed && near(stored(s1, A), camAHidden), "after a restart: A is still hidden and keeps its camera", { stored: stored(s1, A), camAHidden });
  await app.clickEl(q("[data-workspace-menu]"));
  await app.clickEl(q('[data-ws-action="hidden"]'));
  await app.clickEl(q(`[data-ws-hidden-item="${A}"] button`));
  await app.waitFor(`${tab(A)}?.getAttribute("aria-selected") === "true"`, "A reopened from the hidden list");
  await app.clickEl(q("[data-workspace-menu]"));
  await app.clickEl(q('[data-ws-action="history"]'));
  await app.waitFor(`${q(`[data-ws-history-run="${runA}"]`)} && ${q(`[data-ws-history-run="${runA2}"]`)} && !${q(`[data-ws-history-run="${runB}"]`)}`, "A's history after the restart");
  await app.clickEl(q(`[data-ws-history-run="${runA}"] [data-ws-history-open]`));
  await app.waitFor(`!!${q("[data-sum='outcome']")}`, "A's summary after the restart");
  expect(true, "W5: A's completed run opens from A's history after a restart", null);
  expect(ledgerCount() === ledger2, "no CLI started by the reload, the restart and the history", { before: ledger2, after: ledgerCount() });
  await app.shot("08-history-after-restart-1280");
  await app.key("Escape", "Escape", 27);

  // ---------- the removal rules seen from the UI ----------
  await app.clickEl(q("[data-workspace-menu]"));
  await app.clickEl(q('[data-ws-action="remove"]'));
  await app.waitFor(`${q("[data-ws-message]")} && true`, "removal refused");
  expect((await text(q("[data-ws-message]"))).length > 0 && (await state()).workspaces.some((w) => w.id === A), "a workspace with cards and history is not removed", await text(q("[data-ws-message]")));
} catch (error) {
  failures.push(`error: ${error?.stack ?? error}`);
  try { await app?.shot("failure"); } catch {}
} finally {
  hold("claude", false);
  hold("codex", false);
  await app?.stop();
}
const ok = failures.length === 0;
console.log(JSON.stringify({ ok, passed, failures, shots: SHOTS }, null, 2));
process.exit(ok ? 0 : 1);
