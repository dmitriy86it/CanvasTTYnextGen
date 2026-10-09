// Link gesture smoke: the lead's port dragged onto the executor card with real mouse events (DevTools protocol), in
// several layouts, window sizes, zooms and project path lengths; the keyboard link (Tab to the port, Enter, Tab to
// "Link here", Enter) and Escape. Cards are placed by dragging their headers; the drop point is hit-tested with
// elementFromPoint to belong to the executor card. Success = exactly one new link lead -> executor, nothing else.
// Development build (`out/`), temporary user data, fake CLIs (no model is started: linking calls none).
// Usage: node scripts/smoke-link-gesture.mjs [--out <dir>] [--tag before|after] [--only <name,...>]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, ROOT, canvasState, card, createAgent, launch, q, sleep, workspace } from "./orchestration-app-kit.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg("--out", path.join(ROOT, "docs/agent-orchestration/evidence/stage-13-review/review7/verify")));
const TAG = arg("--tag", "run");
const ONLY = arg("--only", "")?.split(",").filter(Boolean);
const NO_SETTLE = process.argv.includes("--no-settle"); // as the series: cards right after the window is resized
const REAL_CLI = process.argv.includes("--real-cli"); // the installed CLIs are only asked for their version, never a model
const SHOTS = path.join(OUT, TAG);
fs.mkdirSync(SHOTS, { recursive: true });

const { TMP, D, project } = workspace("cto-link-");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
const env = { HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: D("ledger.jsonl") };
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: `${path.dirname(NODE)}:/usr/bin:/bin`, env: { ...env, CODEX_HOME: D("mock-state", ".codex") } },
  claude: { executable: wrap("claude"), version: "2.1.282 (Claude Code)", path: `${path.dirname(NODE)}:/usr/bin:/bin`, env }
}));

// Projects: a short path, one as long as the repository's path (the series' layout), a long one.
const repoLen = ROOT.length;
const shortProj = project("p");
const repoLikeProj = project("r".repeat(Math.max(1, repoLen - (TMP.length + 1))));
const longDir = D("a-rather-long-folder-name-for-the-link-gesture", "nested-deeper-still-with-more-words");
fs.mkdirSync(path.dirname(longDir), { recursive: true });
fs.renameSync(project("long-src"), longDir);

const LEAD = "Агент Codex (лид)";
const EXEC = "Агент Claude (исполнитель)";
const rect = (app, sel) => app.ev(`(() => { const el = ${sel}; if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const agentAt = (app, x, y) => app.ev(`document.elementFromPoint(${x}, ${y})?.closest("[data-agent-id]")?.dataset.agentId ?? null`);
const stackAt = (app, x, y) => app.ev(`document.elementsFromPoint(${x}, ${y}).slice(0, 6).map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\\s+/).join(".") : ""))`);
const messages = (app) => app.ev(`[...document.querySelectorAll(".agent-card__message, .orch-linking-hint, .dialog-error, [role=alert]")].map((e) => e.textContent.trim()).filter(Boolean)`);
const zoomOf = (app) => app.ev(`Number(${q(".workspace__scene")}.style.transform.match(/scale\\(([\\d.]+)\\)/)[1])`);

// Moves a card by dragging its header so that the card's top-left corner lands at `to` (client coordinates).
async function moveCard(app, agentId, to) {
  const r = await rect(app, card(agentId));
  const h = await rect(app, card(agentId, ".agent-card__header"));
  // grab the header left of the delete button, where the drag starts
  const grab = { x: h.left + Math.min(40, h.width / 4), y: h.top + h.height / 2 };
  if ((await agentAt(app, grab.x, grab.y)) !== agentId) throw new Error(`header of ${agentId} not hit at ${JSON.stringify(grab)}`);
  await app.drag(grab, { x: grab.x + (to.x - r.left), y: grab.y + (to.y - r.top) }, 16);
  await sleep(200);
}

// A drop point on the target card, checked by elementFromPoint: body centre, card centre, header, then a grid.
async function dropPoint(app, agentId) {
  const r = await rect(app, card(agentId));
  const b = await rect(app, card(agentId, ".agent-card__body"));
  const W = await app.ev("innerWidth"), H = await app.ev("innerHeight");
  const cands = [{ x: b.left + b.width / 2, y: b.top + b.height / 2, where: "body-centre" }, { x: r.left + r.width / 2, y: r.top + r.height / 2, where: "card-centre" },
    { x: r.left + r.width / 2, y: r.top + 12, where: "header" }];
  for (let i = 1; i < 6; i++) for (let j = 1; j < 6; j++) cands.push({ x: r.left + (r.width * i) / 6, y: r.top + (r.height * j) / 6, where: `grid-${i}-${j}` });
  for (const c of cands) if (c.x > 2 && c.y > 2 && c.x < W - 2 && c.y < H - 2 && (await agentAt(app, c.x, c.y)) === agentId) return c;
  return null;
}

const results = [];
let portN = 9500 + Math.floor(Math.random() * 300);

async function withApp(name, { width = 1280, height = 800 } = {}, fn) {
  const userData = D(`u${portN}`); // fresh per run, repeats included; short: the agent runtime socket lives inside
  const app = await launch({ userData, providers: REAL_CLI ? undefined : providers, port: portN++, shots: SHOTS, hermetic: !REAL_CLI });
  const res = { name, window: { width, height } };
  try {
    await app.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    if (!NO_SETTLE) await sleep(400);
    await fn(app, res);
  } catch (e) {
    res.ok = false;
    res.error = String(e?.message ?? e).slice(0, 800);
    await app.shot(`${name}-error`).catch(() => {});
  } finally {
    await app.quit();
  }
  results.push(res);
  console.log(`${res.ok ? "PASS" : "FAIL"} ${name}${res.ok ? "" : ` — ${res.reason ?? res.error ?? ""}`}`);
}

async function twoCards(app, dir) {
  await createAgent(app, LEAD, dir);
  await createAgent(app, EXEC, dir);
  const c = await canvasState(app);
  return { lead: c.agents.find((a) => a.role === "lead").agentId, exec: c.agents.find((a) => a.role === "executor").agentId };
}

// Places the lead near the window's centre (or keeps it) and the executor at `place(leadRect, portCentre, execRect)`.
async function arrange(app, ids, place) {
  if (!place) return;
  const W = await app.ev("innerWidth"), H = await app.ev("innerHeight");
  const lr0 = await rect(app, card(ids.lead));
  const to = { x: Math.round(W / 2 - lr0.width / 2), y: Math.round(H / 2 - lr0.height - 20) };
  // Zoomed in (S5a) the lead's new place covers the executor's header, which the next move grabs: the executor goes to
  // its place for that position first, then the lead, then the executor once more from where the lead really landed.
  const target = { left: to.x, top: to.y, right: to.x + lr0.width, bottom: to.y + lr0.height, width: lr0.width, height: lr0.height };
  const er0 = await rect(app, card(ids.exec));
  if (target.left < er0.right && er0.left < target.right && target.top < er0.bottom && er0.top < target.bottom) {
    const port0 = await app.center(card(ids.lead, ".agent-card__port"));
    await moveCard(app, ids.exec, place(target, { x: port0.x - lr0.left + to.x, y: port0.y - lr0.top + to.y }, er0));
  }
  await moveCard(app, ids.lead, to);
  const lr = await rect(app, card(ids.lead));
  const port = await app.center(card(ids.lead, ".agent-card__port"));
  const er = await rect(app, card(ids.exec));
  await moveCard(app, ids.exec, place(lr, port, er));
}

// The gesture itself: port -> hit-tested point on the executor; exactly one new link lead -> executor.
async function gesture(app, res, ids, { dropAt } = {}) {
  const before = await canvasState(app);
  const port = await app.center(card(ids.lead, ".agent-card__port"));
  const drop = dropAt ? { ...(await dropAt()), where: "driver:body-centre" } : await dropPoint(app, ids.exec);
  if (!drop) { res.ok = false; res.reason = "no visible point on the executor card"; return; }
  // the driver's timing: nothing between measuring and dragging; the hit tests come after (the layout does not move)
  const measure = async () => {
    res.portHit = (await agentAt(app, port.x, port.y)) === ids.lead;
    res.dropHitsExecutor = (await agentAt(app, drop.x, drop.y)) === ids.exec;
    res.geometry = { zoom: await zoomOf(app), port: round(port), drop: round(drop), lead: round(await rect(app, card(ids.lead))), exec: round(await rect(app, card(ids.exec))),
      execRelativeToPort: { dx: Math.round(drop.x - port.x), dy: Math.round(drop.y - port.y) } };
    res.stackAtDrop = await stackAt(app, drop.x, drop.y);
  };
  if (!dropAt) await measure();
  await app.drag(port, drop, 20);
  if (dropAt) await measure();
  await app.waitFor(`window.canvasTTY.orchestration.canvas().then((r) => r.value.links.length !== ${before.links.length})`, "link", 3000).catch(() => {});
  await sleep(300);
  const after = await canvasState(app);
  const added = after.links.filter((l) => !before.links.some((b) => b.linkId === l.linkId));
  res.linksAdded = added.map((l) => ({ from: l.fromAgentId === ids.lead ? "lead" : l.fromAgentId, to: l.toAgentId === ids.exec ? "exec" : l.toAgentId }));
  res.linksTotal = after.links.length;
  res.messages = await messages(app);
  res.ok = added.length === 1 && added[0].fromAgentId === ids.lead && added[0].toAgentId === ids.exec && after.links.length === before.links.length + 1;
  if (!res.ok) res.reason = `links added ${added.length}; UI messages: ${JSON.stringify(res.messages)}`;
  await app.shot(`${res.name}`);
}
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? Math.round(v) : v]));

// The mouse drag from the lead's port towards the executor, `intervene` in the middle, then the release over the
// executor; the events the port saw are logged by passive listeners. A retry gesture must make exactly one link.
async function midDragIntervention(app, res, intervene) {
  const ids = await twoCards(app, repoLikeProj);
  await arrange(app, ids, layouts.right);
  const before = await canvasState(app);
  const port = card(ids.lead, ".agent-card__port");
  await app.ev(`(() => { window.__ev = []; const p = ${port};
    for (const type of ["pointerdown", "pointerup", "pointercancel", "lostpointercapture", "gotpointercapture"])
      p.addEventListener(type, (e) => { if (type === "pointerdown") window.__pid = e.pointerId; window.__ev.push({ type, pointerId: e.pointerId, buttons: e.buttons }); }, { capture: true, passive: true });
    p.addEventListener("pointermove", (e) => { window.__ev.push({ type: "pointermove", buttons: e.buttons }); }, { capture: true, passive: true }); })()`);
  const from = await app.center(port);
  const to = await dropPoint(app, ids.exec);
  await app.mouse("mouseMoved", from.x, from.y);
  await app.mouse("mousePressed", from.x, from.y, "left", 1);
  for (let i = 1; i <= 6; i++) { await app.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10, "left", 1); await sleep(16); }
  res.previewBefore = await app.ev(`!!${q(".agent-link--preview")}`);
  await intervene(port, to);
  res.previewAfterIntervention = await app.ev(`!!${q(".agent-link--preview")}`);
  await app.mouse("mouseMoved", to.x, to.y, "left", 1);
  await app.mouse("mouseReleased", to.x, to.y, "left", 0);
  await sleep(800);
  res.portEvents = await app.ev("window.__ev");
  res.lostCaptureEvents = res.portEvents.filter((e) => e.type === "lostpointercapture").length;
  res.linksAfterIntervention = (await canvasState(app)).links.length - before.links.length;
  res.previewAfterRelease = await app.ev(`!!${q(".agent-link--preview")}`);
  await app.shot(`${res.name}-after-intervention`);
  const again = { name: `${res.name}-retry` };
  await gesture(app, again, ids);
  res.retry = { ok: again.ok, linksAdded: again.linksAdded, messages: again.messages };
  res.ok = res.previewBefore && !res.previewAfterIntervention && !res.previewAfterRelease && res.linksAfterIntervention === 0 && again.ok;
  if (!res.ok) res.reason = JSON.stringify({ previewBefore: res.previewBefore, previewAfter: res.previewAfterIntervention, lost: res.lostCaptureEvents, links: res.linksAfterIntervention, retry: res.retry });
}

const GAP = 60;
const layouts = {
  // executor below the lead, its centre left of the port (the series' failure: port x≈179, target x≈105)
  "below-left": (lr, port, er) => ({ x: Math.round(port.x - 75 - er.width / 2), y: Math.round(lr.bottom + 40) }),
  right: (lr, port, er) => ({ x: Math.round(port.x + GAP + 20), y: Math.round(lr.top) }),
  left: (lr, port, er) => ({ x: Math.round(lr.left - er.width - GAP - 40), y: Math.round(lr.top) }),
  below: (lr, port, er) => ({ x: Math.round(lr.left), y: Math.round(lr.bottom + GAP) })
};

const scenarios = {
  // 0: exactly as the series driver: natural placement, repository-length path, drop at the body's centre (no hit test)
  "S0-driver-1280x800-repo-length-path": () => withApp("S0-driver-1280x800-repo-length-path", {}, async (app, res) => {
    const ids = await twoCards(app, repoLikeProj);
    await gesture(app, res, ids, { dropAt: () => app.center(card(ids.exec, ".agent-card__body")) });
  }),
  // 0r: the series exactly, on this repository's folder (only named by the cards: nothing reads or writes it)
  "S0r-driver-1280x800-this-repo": () => withApp("S0r-driver-1280x800-this-repo", {}, async (app, res) => {
    const ids = await twoCards(app, ROOT);
    await gesture(app, res, ids, { dropAt: () => app.center(card(ids.exec, ".agent-card__body")) });
  }),
  // 0b: the same natural layout, drop point hit-tested
  "S0b-natural-1280x800-repo-length-path": () => withApp("S0b-natural-1280x800-repo-length-path", {}, async (app, res) => {
    await gesture(app, res, await twoCards(app, repoLikeProj));
  }),
  ...Object.fromEntries(Object.entries({ "S1-below-left-1280x800": "below-left", "S2-right": "right", "S3-left": "left", "S4-below": "below" })
    .map(([name, layout]) => [name, () => withApp(name, {}, async (app, res) => {
      const ids = await twoCards(app, repoLikeProj);
      await arrange(app, ids, layouts[layout]);
      res.layout = layout;
      await gesture(app, res, ids);
    })])),
  ...Object.fromEntries([["S5a-zoom-in-pan", 2, "3"], ["S5b-zoom-out-pan", 2, "2"]].map(([name, times, nth]) => [name, () => withApp(name, {}, async (app, res) => {
    await app.panBy({ x: -140, y: 90 });
    for (let i = 0; i < times; i++) await app.clickEl(q(`.canvas-controls button:nth-child(${nth})`));
    const ids = await twoCards(app, repoLikeProj);
    for (const layout of ["below-left"]) await arrange(app, ids, layouts[layout]);
    res.layout = "below-left";
    await gesture(app, res, ids);
  })])),
  "S6-1440x900-natural": () => withApp("S6-1440x900-natural", { width: 1440, height: 900 }, async (app, res) => {
    await gesture(app, res, await twoCards(app, repoLikeProj));
  }),
  "S6b-1440x900-below-left": () => withApp("S6b-1440x900-below-left", { width: 1440, height: 900 }, async (app, res) => {
    const ids = await twoCards(app, repoLikeProj);
    await arrange(app, ids, layouts["below-left"]);
    res.layout = "below-left";
    await gesture(app, res, ids);
  }),
  ...Object.fromEntries([["S7a-short-path", shortProj], ["S7b-long-path", longDir]].flatMap(([name, dir]) => [
    [`${name}-natural`, () => withApp(`${name}-natural`, {}, async (app, res) => { res.projectPathLength = dir.length; await gesture(app, res, await twoCards(app, dir)); })],
    [`${name}-below-left`, () => withApp(`${name}-below-left`, {}, async (app, res) => {
      res.projectPathLength = dir.length;
      const ids = await twoCards(app, dir);
      await arrange(app, ids, layouts["below-left"]);
      await gesture(app, res, ids);
    })]
  ])),
  // Keyboard: Tab to the port, Enter, Tab to "Link here" on the executor, Enter.
  "K1-keyboard-link": () => withApp("K1-keyboard-link", {}, async (app, res) => {
    const ids = await twoCards(app, repoLikeProj);
    await arrange(app, ids, layouts.right);
    const before = await canvasState(app);
    await app.ev("document.activeElement?.blur()");
    const tabTo = async (sel, what) => {
      for (let i = 0; i < 120; i++) {
        if (await app.ev(`document.activeElement === ${sel}`)) return i;
        await app.key("Tab", "Tab", 9);
      }
      throw new Error(`Tab never reaches ${what}`);
    };
    res.tabsToPort = await tabTo(card(ids.lead, ".agent-card__port"), "the port");
    await app.key("Enter", "Enter", 13, "\r");
    res.hint = await app.ev(`${q(".orch-linking-hint")}?.textContent ?? null`);
    res.tabsToConnect = await tabTo(card(ids.exec, ".agent-card__connect"), "Link here");
    await app.key("Enter", "Enter", 13, "\r");
    await app.waitFor(`window.canvasTTY.orchestration.canvas().then((r) => r.value.links.length !== ${before.links.length})`, "link", 3000).catch(() => {});
    const after = await canvasState(app);
    const added = after.links.filter((l) => !before.links.some((b) => b.linkId === l.linkId));
    res.linksAdded = added.length;
    res.messages = await messages(app);
    res.ok = added.length === 1 && added[0].fromAgentId === ids.lead && added[0].toAgentId === ids.exec && !(await app.ev(`!!${q(".orch-linking-hint")}`));
    if (!res.ok) res.reason = `links added ${added.length}; ${JSON.stringify(res.messages)}`;
    await app.shot("K1-keyboard-link");
  }),
  // Escape after the port is pressed (click/Enter mode): the mode ends, no "Link here", no link.
  "K2-escape-after-port-press": () => withApp("K2-escape-after-port-press", {}, async (app, res) => {
    const ids = await twoCards(app, repoLikeProj);
    await arrange(app, ids, layouts.right);
    const before = await canvasState(app);
    await app.ev(`${card(ids.lead, ".agent-card__port")}.focus()`);
    await app.key("Enter", "Enter", 13, "\r");
    res.modeStarted = await app.ev(`!!${card(ids.exec, ".agent-card__connect")}`);
    await app.key("Escape", "Escape", 27);
    res.modeEnded = await app.ev(`!${card(ids.exec, ".agent-card__connect")} && !${q(".orch-linking-hint")}`);
    await sleep(300);
    res.linksAdded = (await canvasState(app)).links.length - before.links.length;
    res.ok = res.modeStarted && res.modeEnded && res.linksAdded === 0;
    if (!res.ok) res.reason = JSON.stringify({ modeStarted: res.modeStarted, modeEnded: res.modeEnded, linksAdded: res.linksAdded });
    await app.shot("K2-escape-after-port-press");
  }),
  // K4a, FAULT INJECTION (not a human action): mid-drag the page itself releases the port's pointer capture. The
  // `lostpointercapture` is delivered with the next pointer event (the drag continuing), so it is checked after that
  // move; then the preview is gone, the release over the executor links nothing, and an ordinary gesture afterwards
  // makes exactly one link.
  "K4a-injected-lost-capture": () => withApp("K4a-injected-lost-capture", {}, async (app, res) => {
    res.injection = "releasePointerCapture() called by the test inside the page mid-drag";
    await midDragIntervention(app, res, async (port, to) => {
      await app.ev(`${port}.releasePointerCapture(window.__pid)`);
      await sleep(200);
      res.lostCaptureBeforeNextMove = await app.ev("window.__ev.filter((e) => e.type === 'lostpointercapture').length");
      await app.mouse("mouseMoved", to.x - 30, to.y + 20, "left", 1); // the drag goes on, button held
      await sleep(200);
      res.lostCaptureAfterNextMove = await app.ev("window.__ev.filter((e) => e.type === 'lostpointercapture').length");
    });
    if (res.ok && res.lostCaptureAfterNextMove < 1) { res.ok = false; res.reason = "no lostpointercapture observed on the port"; }
  }),
  // K4b: a move without a button held mid-drag (the button went up where no pointerup reached the port, e.g. outside
  // the window); expected as a cancel: no preview, the later release over the executor links nothing, then an
  // ordinary gesture makes exactly one link.
  // The move must carry button "none": a CDP mouseMoved with button "left" and buttons 0 (the earlier K4) reaches the
  // page as a pointermove with buttons 1, an ordinary drag (review9/k4/cdp-left-buttons0-probe.json).
  "K4b-buttonless-move-mid-drag": () => withApp("K4b-buttonless-move-mid-drag", {}, async (app, res) => {
    await midDragIntervention(app, res, async (port, to) => {
      await app.mouse("mouseMoved", to.x - 30, to.y + 20, "none", 0);
      await sleep(200);
    });
  }),
  // Escape in the middle of a mouse drag (preview line shown), then release over the executor: expected no link.
  "K3-escape-mid-drag": () => withApp("K3-escape-mid-drag", {}, async (app, res) => {
    const ids = await twoCards(app, repoLikeProj);
    await arrange(app, ids, layouts.right);
    const before = await canvasState(app);
    const from = await app.center(card(ids.lead, ".agent-card__port"));
    const to = await dropPoint(app, ids.exec);
    await app.mouse("mouseMoved", from.x, from.y);
    await app.mouse("mousePressed", from.x, from.y, "left", 1);
    for (let i = 1; i <= 10; i++) { await app.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10, "left", 1); await sleep(16); }
    res.previewBeforeEscape = await app.ev(`!!${q(".agent-link--preview")}`);
    await app.key("Escape", "Escape", 27);
    res.previewAfterEscape = await app.ev(`!!${q(".agent-link--preview")}`);
    await app.shot("K3-escape-mid-drag-held");
    await app.mouse("mouseReleased", to.x, to.y, "left", 0);
    await sleep(800);
    res.linksAdded = (await canvasState(app)).links.length - before.links.length;
    res.ok = res.previewBeforeEscape && res.linksAdded === 0;
    if (!res.ok) res.reason = JSON.stringify({ previewBeforeEscape: res.previewBeforeEscape, previewAfterEscape: res.previewAfterEscape, linksAdded: res.linksAdded });
    await app.shot("K3-escape-mid-drag");
  })
};

const outStat = fs.statSync(path.join(ROOT, "out", "renderer")).mtime.toISOString();
const REPEAT = Number(arg("--repeat", "1"));
for (let i = 0; i < REPEAT; i++) for (const [name, run] of Object.entries(scenarios)) if (!ONLY?.length || ONLY.some((o) => name.startsWith(o))) await run();
const report = { tag: TAG, at: new Date().toISOString(), build: { outRendererMtime: outStat }, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length,
  results: JSON.parse(JSON.stringify(results).replaceAll(TMP, "<tmp>").replaceAll(ROOT, "<repo>")) };
fs.writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify(report, null, 2));
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${report.passed} passed, ${report.failed} failed -> ${path.join(OUT, `${TAG}.json`)}`);
process.exit(report.failed ? 1 : 0); // a failed scenario fails the smoke (until 1.5.15 S5a failed every run unseen)
