// Electron UI smoke for 1.5.13: resizable agent cards with live activity, at a laptop size (1280×800), with the fake
// Codex/Claude CLIs and a temporary Git project:
//   1. compact cards during a run: no line is cut by height, none overlaps another, a cut-off line has its tooltip;
//      the waiting executor says «Ждёт: …» and never the lead's line word for word;
//   2. the lead's card expanded: its live feed follows new events; scrolled up it stays put while events come; back at
//      the bottom it follows again;
//   3. the executor's card resized by its corner: a larger card shows more events; the size and the expanded size are
//      saved; «Свернуть»/«Развернуть» and a double click on the header switch between them;
//   4. a marquee over the resized part of the card selects it; a group drag moves both cards and keeps their sizes;
//   5. after a restart the sizes are the same.
// Shots: 01-compact, 02-expanded (the cards only) — copied with --docs to docs/ux-audit/2026-10-05/agent-cards/.
// Needs `npm run build` first. Usage: node scripts/smoke-agent-cards-ui.mjs [--shots <dir>] [--docs]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, JOURNAL_V2, NODE, canvasState, card, createAgent, launch, q, sleep, startGoal, workspace } from "./orchestration-app-kit.mjs";

const { D, project, script } = workspace("cto-cards-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const DOCS = process.argv.includes("--docs") ? path.resolve(new URL("..", import.meta.url).pathname, "docs", "ux-audit", "2026-10-05", "agent-cards") : null;
const failures = [];
const passed = [];
const notes = {};
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 600)}`); };

const alpha = project("career-os-analysis-market-snapshot-service");
const planV2 = { report: { stages: [{ title: "Рыночный снимок", task: "Add src/note.mjs and the files", conditions: [
  { keep: null, text: "node --test passes", covers: ["R1"], evidence: { kind: "check", check: "cmd-1" } }] }], dropped: [], dropRequirements: [], question: null } };
const plan = JOURNAL_V2 ? planV2 : { report: { stages: [{ title: "Рыночный снимок", task: "Add src/note.mjs" }], question: null } };
const review = JOURNAL_V2 ? { report: { conditions: [], findings: [], request: "none", question: null } } : { report: { verdict: "accept", findings: [], question: null } };
const final = JOURNAL_V2 ? { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "ok" }] } }
  : { report: { verdict: "complete", findings: [], question: null } };
const codexScript = script("codex", [plan, review, final]);
// many writes: many events of the executor (a tool start and end each)
const writes = Array.from({ length: 24 }, (_, i) => [`src/notes/very-long-folder-name-for-a-market-snapshot/note-${String(i).padStart(2, "0")}.mjs`, `export const n = ${i};\n`]);
const claudeScript = script("claude", [{ report: { summary: "Добавлены заметки.", done: true }, writes: [["src/note.mjs", "export const note = 1;\n"], ...writes] }]);
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
// a CLI process starts only while its hold file is absent: the smoke decides when each turn may begin
const HOLD = { codex: D("hold-codex"), claude: D("hold-claude") };
const hold = (p, on) => (on ? fs.writeFileSync(HOLD[p], "") : fs.rmSync(HOLD[p], { force: true }));
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\n${p === "claude" ? `case "$*" in *--json-schema*) while [ -e "${HOLD[p]}" ]; do sleep 0.1; done ;; esac` : `case "$*" in --help*|--version*|*generate-json-schema*) ;; *) while [ -e "${HOLD[p]}" ]; do sleep 0.1; done ;; esac`}\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const SHELL = D("login-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -*) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), ...extra });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.160.0", path: PATHS, env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.294 (Claude Code)", path: PATHS, env: env({ MOCK_SCRIPT: claudeScript }) },
  shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));

let app;
const port = () => 9600 + Math.floor(Math.random() * 150);
const start = async () => {
  app = await launch({ userData: D("user-data"), providers, port: port(), shots: SHOTS });
  await app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await app.waitFor(`${q(".workspace")} && true`, "window", 30_000);
};
const api = (expr) => app.ev(`(async () => { const o = window.canvasTTY.orchestration; const r = await (${expr}); if (r && r.ok === false) throw new Error(r.code + " " + r.message); return r && "ok" in r ? r.value : r; })()`);
const viewOf = (runId) => api(`o.get(${JSON.stringify(runId)})`).then((s) => s.view);
const waitView = async (runId, pred, what, ms = 90_000) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await viewOf(runId); if (pred(v)) return v; await sleep(150); }
  throw new Error(`timeout: ${what} ${JSON.stringify(v)?.slice(0, 400)}`);
};
const stored = async (agentId) => (await canvasState(app)).agents.find((a) => a.agentId === agentId);
const rectOf = (sel) => app.ev(`(() => { const r = ${sel}.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; })()`);
// every line of the card's body: one line high, inside the body, none over the next; a cut-off text has its tooltip
const layout = (agentId) => app.ev(`(() => {
  const c = document.querySelector('[data-agent-id="${agentId}"]');
  const body = c.querySelector(".agent-card__body").getBoundingClientRect();
  const blocks = [...c.querySelectorAll(".agent-card__body > *")].filter((e) => !e.matches(".agent-card__feed") && e.getClientRects().length);
  const lines = [...c.querySelectorAll(".agent-card__project strong, .agent-card__project small, .agent-card__state, .agent-card__time, .agent-card__line")];
  const bad = [];
  for (const e of [...blocks, ...lines]) {
    const r = e.getBoundingClientRect();
    if (e.scrollHeight > e.clientHeight + 1) bad.push({ cut: e.className, scroll: e.scrollHeight, client: e.clientHeight, text: e.textContent.slice(0, 60) });
    if (r.top < body.top - 0.5 || r.bottom > body.bottom + 0.5) bad.push({ outside: e.className, top: r.top, bottom: r.bottom, body: [body.top, body.bottom] });
  }
  for (let i = 1; i < blocks.length; i++) {
    const a = blocks[i - 1].getBoundingClientRect(), b = blocks[i].getBoundingClientRect();
    if (a.bottom > b.top + 0.5) bad.push({ overlap: [blocks[i - 1].className, blocks[i].className] });
  }
  for (const e of lines) if (e.scrollWidth > e.clientWidth + 1 && !(e.title || e.closest("[title]"))) bad.push({ noTooltip: e.className, text: e.textContent.slice(0, 60) });
  return { bad, lines: lines.map((e) => e.className.split(" ")[0] + ": " + e.textContent.slice(0, 80)) };
})()`);
const feedState = (agentId) => app.ev(`(() => {
  const f = document.querySelector('[data-agent-id="${agentId}"] [data-agent-feed]');
  if (!f) return null;
  const r = f.getBoundingClientRect();
  const items = [...f.querySelectorAll(".agent-card__feed-item")];
  const visible = items.filter((i) => { const b = i.getBoundingClientRect(); return b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5; }).length;
  return { items: items.length, visible, following: f.dataset.following, top: f.scrollTop, atBottom: f.scrollHeight - f.scrollTop - f.clientHeight < 8, overflow: f.scrollHeight > f.clientHeight,
    text: items.map((i) => i.textContent).join("\\n") };
})()`);
const scrollFeed = (agentId, where) => app.ev(`(() => { const f = document.querySelector('[data-agent-id="${agentId}"] [data-agent-feed]'); f.scrollTop = ${where === "top" ? 0 : "f.scrollHeight"}; f.dispatchEvent(new Event("scroll")); })()`);
// the cards in the middle of the window (below the canvas toolbar)
async function centre(agentIds) {
  for (let i = 0; i < 4; i++) {
    const rects = await Promise.all(agentIds.map((id) => rectOf(card(id))));
    const dx = Math.round(640 - (Math.min(...rects.map((r) => r.x)) + Math.max(...rects.map((r) => r.right))) / 2);
    const dy = Math.round(430 - (Math.min(...rects.map((r) => r.y)) + Math.max(...rects.map((r) => r.bottom))) / 2);
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    await app.panBy({ x: dx, y: dy });
    await sleep(300);
  }
}
async function clip(agentIds, name) {
  await centre(agentIds);
  const rects = await Promise.all(agentIds.map((id) => rectOf(card(id))));
  const x = Math.max(0, Math.min(...rects.map((r) => r.x)) - 24), y = Math.max(0, Math.min(...rects.map((r) => r.y)) - 24);
  const right = Math.min(1280, Math.max(...rects.map((r) => r.right)) + 24), bottom = Math.min(800, Math.max(...rects.map((r) => r.bottom)) + 24);
  // at the canvas zoom 1:1 in pixels: the card's text as a person reads it at 100 %
  const r = await app.call("Page.captureScreenshot", { format: "png", clip: { x, y, width: right - x, height: bottom - y, scale: 1 / (await zoomOf()) } });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, "base64"));
  if (DOCS) { fs.mkdirSync(DOCS, { recursive: true }); fs.copyFileSync(path.join(SHOTS, `${name}.png`), path.join(DOCS, `${name}.png`)); }
}
const zoomOf = () => app.ev(`Number(${q(".workspace__scene")}.style.transform.match(/scale\\(([\\d.]+)\\)/)[1])`);
// a resize by a card's handle, as a person drags it; dx, dy in canvas units
async function resizeBy(agentId, dir, dx, dy) {
  const z = await zoomOf();
  const h = await app.center(card(agentId, `[data-agent-resize="${dir}"]`));
  await app.drag(h, { x: h.x + dx * z, y: h.y + dy * z }, 16);
  await sleep(300);
}
// a card dragged by its header (one screen at a time) until it stands left of another one, tops level
async function besideOf(agentId, otherId) {
  for (let i = 0; i < 12; i++) {
    const [me, other] = [(await stored(agentId)).bounds, (await stored(otherId)).bounds];
    const want = { x: other.position.x - 60 - me.size.width - me.position.x, y: other.position.y - me.position.y };
    if (Math.abs(want.x) < 8 && Math.abs(want.y) < 8) return;
    await app.reveal(card(agentId));
    const z = await zoomOf();
    const r = await rectOf(card(agentId, ".agent-card__identity"));
    const grip = { x: r.x + 10, y: r.y + r.height / 2 };
    const dx = Math.max(-450, Math.min(450, want.x * z)), dy = Math.max(-250, Math.min(250, want.y * z));
    await app.drag(grip, { x: grip.x + dx, y: grip.y + dy }, 12);
    await sleep(400);
  }
}

try {
  await start();
  // 1. a pair, a run held after the plan: the executor waits for its turn
  hold("claude", true);
  await createAgent(app, "Агент Codex (лид)", alpha);
  await createAgent(app, "Агент Claude (исполнитель)", alpha);
  const c = await canvasState(app);
  const lead = c.agents.find((a) => a.provider === "codex"), exec = c.agents.find((a) => a.provider === "claude");
  // side by side, as the shots show them
  await besideOf(lead.agentId, exec.agentId);
  notes.zoom = await zoomOf();
  await app.reveal(card(exec.agentId));
  await app.drag(await app.center(card(lead.agentId, ".agent-card__port")), await app.center(card(exec.agentId, ".agent-card__body")), 20);
  await app.waitFor(`window.canvasTTY.orchestration.canvas().then((r) => r.value.links.length === 1)`, "link");
  const link = (await canvasState(app)).links[0];
  await startGoal(app, link.linkId, { task: "Добавить рыночный снимок", criteria: "node --test passes", commands: ["node --test"], workMode: "copy" });
  const runId = await app.waitFor(`window.canvasTTY.orchestration.list().then((r) => r.value[0]?.view.runId)`, "the run");
  await waitView(runId, (v) => v.active?.kind === "turn" && v.active.purpose === "execute", "the executor's turn is given");
  for (let i = 0; i < 3 && await app.ev(`!!${q(".orch-panel")} || !!${q(".orch-dialog")}`); i++) { await app.key("Escape", "Escape", 27); await sleep(300); }
  await app.reveal(card(exec.agentId));
  await sleep(1200);
  for (const a of [lead, exec]) {
    const l = await layout(a.agentId);
    notes[`compact-${a.provider}`] = l.lines;
    expect(l.bad.length === 0, `compact ${a.provider} card: no line cut by height, outside the body or over another`, l.bad);
  }
  // one card works, the other waits: the waiting one says «Ждёт: …» and never repeats the working one's line
  const linesOf = (a) => app.ev(`[...${card(a.agentId)}.querySelectorAll(".agent-card__line")].map((e) => e.textContent)`);
  const [leadLines, execLines] = [await linesOf(lead), await linesOf(exec)];
  const [waiting, working] = leadLines.some((t) => t.startsWith("Ждёт: ")) ? [leadLines, execLines] : [execLines, leadLines];
  notes.waiting = { leadLines, execLines };
  expect(waiting.filter((t) => t.startsWith("Ждёт: ")).length === 1, "the waiting card: one line «Ждёт: <who works and what it does>»", notes.waiting);
  expect(!waiting.some((t) => t === working[0]), "the waiting card does not repeat the working card's line word for word", notes.waiting);
  expect(await app.ev(`${card(exec.agentId, "[data-agent-expand]")}.dataset.agentExpand`) === "compact" && !(await app.ev(`!!${card(exec.agentId, "[data-agent-feed]")}`)),
    "a compact card: «Развернуть», no feed", null);
  await clip([lead.agentId, exec.agentId], "01-compact");

  // 2. the lead's card expanded: the feed follows, pauses scrolled up, follows again at the bottom
  await app.clickEl(card(lead.agentId, "[data-agent-expand]"));
  await sleep(500);
  const leadSize = (await stored(lead.agentId)).bounds.size;
  expect(leadSize.width === 460 && leadSize.height === 560, "«Развернуть» without a saved size: the default expanded size", leadSize);
  await resizeBy(lead.agentId, "s", 0, -260); // 300 high: short enough for the feed to scroll
  let f = await feedState(lead.agentId);
  notes.leadFeed = f;
  expect(f?.overflow && f.atBottom && f.following === "yes", "the lead's feed: at the bottom, following", f);
  await scrollFeed(lead.agentId, "top");
  await sleep(300);
  const before = await feedState(lead.agentId);
  expect(before.following === "no", "scrolled up: not following", before);
  hold("codex", true); // the review waits: its turn is given (the lead's events) but its CLI does not start yet
  hold("claude", false);
  await waitView(runId, (v) => v.active?.kind === "turn" && v.active.purpose === "review", "the review is given");
  await app.waitFor(`(() => { const f = ${card(lead.agentId, "[data-agent-feed]")}; return f && f.querySelectorAll(".agent-card__feed-item").length > ${before.items}; })()`, "a new lead event", 20_000);
  f = await feedState(lead.agentId);
  expect(f.top === 0 && f.following === "no", "new events while scrolled up: the feed stays where the reader is", f);
  await scrollFeed(lead.agentId, "bottom");
  await sleep(300);
  const back = await feedState(lead.agentId);
  expect(back.following === "yes", "back at the bottom: following again", back);
  hold("codex", false);
  await waitView(runId, (v) => v.status === "completed", "completed");
  await sleep(800);
  f = await feedState(lead.agentId);
  expect(f.items > back.items && f.atBottom, "later events: the feed follows them to the bottom", { back: back.items, now: f });
  expect(!/\/Users\/|\/home\//.test(f.text), "no home folder path in the feed", f.text.slice(0, 300));

  // 3. the executor's card by its corner: more events seen; saved; collapse and expand
  await app.ev(`${card(exec.agentId)}.scrollIntoView()`);
  await resizeBy(exec.agentId, "se", 200, 120);
  const small = await feedState(exec.agentId);
  await resizeBy(exec.agentId, "n", 0, -300);
  const big = await feedState(exec.agentId);
  notes.feedGrows = { small: small?.visible, big: big?.visible, items: big?.items };
  expect(small && big && big.visible > small.visible && big.items >= 40, "a taller card shows more events", notes.feedGrows);
  const execSaved = await stored(exec.agentId);
  expect(execSaved.bounds.size.height > 222 + 300 && execSaved.expanded?.height === execSaved.bounds.size.height, "the size and the expanded size are saved in the canvas store", execSaved);
  for (const a of [lead, exec]) {
    const l = await layout(a.agentId);
    expect(l.bad.length === 0, `expanded ${a.provider} card: no line cut, none over another`, l.bad);
  }
  await besideOf(lead.agentId, exec.agentId);
  await app.reveal(card(exec.agentId));
  await sleep(500);
  await clip([lead.agentId, exec.agentId], "02-expanded");
  const expandedSize = execSaved.bounds.size;
  await app.clickEl(card(exec.agentId, "[data-agent-expand]"));
  await sleep(400);
  let s = await stored(exec.agentId);
  expect(s.bounds.size.width === 300 && s.bounds.size.height === 222 && s.expanded?.height === expandedSize.height, "«Свернуть»: compact, the larger size kept", s);
  const header = await app.center(card(exec.agentId, ".agent-card__identity"));
  await app.call("Input.dispatchMouseEvent", { type: "mousePressed", x: header.x, y: header.y, button: "left", buttons: 1, clickCount: 1 });
  await app.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: header.x, y: header.y, button: "left", buttons: 0, clickCount: 1 });
  await app.call("Input.dispatchMouseEvent", { type: "mousePressed", x: header.x, y: header.y, button: "left", buttons: 1, clickCount: 2 });
  await app.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: header.x, y: header.y, button: "left", buttons: 0, clickCount: 2 });
  await sleep(400);
  s = await stored(exec.agentId);
  expect(s.bounds.size.width === expandedSize.width && s.bounds.size.height === expandedSize.height, "a double click on the header: back to the remembered size", [s.bounds.size, expandedSize]);
  const l3 = await layout(lead.agentId);
  expect(l3.bad.length === 0, "the lead card at the size it was resized to: no line cut", l3.bad);

  // 4. a marquee over the resized part of the executor's card (below the compact size) and the lead's card; a group drag
  await besideOf(lead.agentId, exec.agentId);
  await app.reveal(card(exec.agentId));
  const er = await rectOf(card(exec.agentId)), lr = await rectOf(card(lead.agentId));
  const zoom = await zoomOf();
  // from empty canvas right of the executor, leftwards over its resized part (below its compact size) and the lead's
  // lower part — the home zone may sit left of the cards
  const from = { x: er.right + 30, y: er.y + 222 * zoom + 15 };
  const to = { x: lr.x + 10, y: Math.min(er.bottom, lr.bottom) - 8 };
  expect(await app.isEmpty(from.x, from.y), "the marquee starts on empty canvas", from);
  await app.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, modifiers: 8 });
  await app.call("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1, modifiers: 8 });
  for (let i = 1; i <= 12; i++) await app.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((to.x - from.x) * i) / 12, y: from.y + ((to.y - from.y) * i) / 12, button: "left", buttons: 1, modifiers: 8 });
  await app.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1, modifiers: 8 });
  await sleep(300);
  const selected = await app.ev(`[...document.querySelectorAll(".agent-card--selected")].map((e) => e.dataset.agentId)`);
  expect(selected.includes(exec.agentId), "the marquee over the resized part selects the resized card", { selected, from, er });
  if (!selected.includes(lead.agentId)) notes.marqueeLead = "the lead's card was not under the marquee";
  const sizesBefore = { lead: (await stored(lead.agentId)).bounds, exec: (await stored(exec.agentId)).bounds };
  const grip = await app.center(card(exec.agentId, ".agent-card__identity"));
  await app.drag(grip, { x: grip.x + 60, y: grip.y + 40 }, 12);
  await sleep(600);
  const after = { lead: (await stored(lead.agentId)).bounds, exec: (await stored(exec.agentId)).bounds };
  const moved = (a, b) => Math.round((b.position.x - a.position.x) * 10) / 10;
  expect(moved(sizesBefore.exec, after.exec) > 0 && JSON.stringify(after.exec.size) === JSON.stringify(sizesBefore.exec.size), "the resized card moves and keeps its size", after.exec);
  if (selected.includes(lead.agentId)) {
    expect(moved(sizesBefore.lead, after.lead) === moved(sizesBefore.exec, after.exec) && JSON.stringify(after.lead.size) === JSON.stringify(sizesBefore.lead.size),
      "the group drag moves the other selected card by the same distance, sizes kept", { before: sizesBefore, after });
  }

  // 5. a restart: the same sizes
  await app.quit();
  await start();
  await app.waitFor(`document.querySelectorAll("[data-agent-id]").length === 2`, "cards after the restart", 30_000);
  const restored = await Promise.all([lead, exec].map(async (a) => ({ stored: (await stored(a.agentId)).bounds.size,
    shown: await app.ev(`(() => { const e = ${card(a.agentId)}; return { width: parseFloat(e.style.width), height: parseFloat(e.style.height) }; })()`) })));
  expect(JSON.stringify(restored.map((r) => r.stored)) === JSON.stringify([after.lead.size, after.exec.size])
    && restored.every((r) => r.shown.width === r.stored.width && r.shown.height === r.stored.height), "after a restart the cards have the sizes they had", restored);
} catch (error) {
  failures.push(`error: ${String(error?.stack ?? error).slice(0, 1200)}`);
  try { await app?.shot("error"); } catch { /* the window may be gone */ }
} finally {
  hold("claude", false);
  hold("codex", false);
  const exit = await app?.quit?.();
  console.log(JSON.stringify({ ok: failures.length === 0, passed: passed.length, failures, notes, shots: SHOTS, exit }, null, 2));
  process.exitCode = failures.length ? 1 : 0;
}
