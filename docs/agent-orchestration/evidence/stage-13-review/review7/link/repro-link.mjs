// Reproduction of the S7 link failure (series-S3-S7-attempt1): no model, no run, userData in a temporary folder.
// 1280×800 like the series driver, two cards on the given project folder, the series' own gesture (port centre →
// executor body centre, 20 steps), with the whole chain recorded in the renderer.
// Usage: node repro-link.mjs <projectDir> <outDir> [--kit-drag]   (--kit-drag: the driver's linkAgents as it is now)
import fs from "node:fs"; import path from "node:path";
import { canvasState, card, createAgent, launch, workspace } from "../../../../../../scripts/orchestration-app-kit.mjs";
const [projectDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const { D } = workspace("cto-r7-link-");
const PORT = 9600 + Math.floor(Math.random() * 90); // apart from the series (9700–9789)
const app = await launch({ userData: D("userData"), port: PORT, shots: outDir });
await app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const out = { projectDir };
// --throttle N: the renderer's CPU slowed N times (a loaded machine), from before the cards are made
const thr = process.argv.indexOf("--throttle");
if (thr > 0) await app.call("Emulation.setCPUThrottlingRate", { rate: Number(process.argv[thr + 1]) });
// --hide: the window minimized (not seen on screen) before the cards are made, as when it runs behind other windows
if (process.argv.includes("--hide")) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("osascript", ["-e", `tell application "System Events" to set visible of (first process whose unix id is ${app.child.pid}) to false`]);
  await new Promise((r) => setTimeout(r, 1000)); out.hidden = await app.ev("document.visibilityState");
}
const rect = (sel) => app.ev(`(() => { const el = ${sel}; return el ? el.getBoundingClientRect().toJSON() : null; })()`);
try {
  await createAgent(app, "Агент Codex (лид)", projectDir);
  await createAgent(app, "Агент Claude (исполнитель)", projectDir);
  // do the rectangles still change after createAgent returns? (60 frames, distinct values)
  out.settle = await app.ev(`new Promise((done) => { const seen = new Set(), t0 = performance.now(); let n = 0;
    const step = () => { const r = (s) => { const el = document.querySelector(s); if (!el) return "none"; const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round).join(","); };
      seen.add(r('[data-agent-role="lead"] .agent-card__port') + " | " + r('[data-agent-role="executor"] .agent-card__body'));
      if (++n < 60) requestAnimationFrame(step); else done([...seen, Math.round(performance.now() - t0) + "ms"]); };
    requestAnimationFrame(step); })`);
  const c = await canvasState(app);
  const lead = c.agents.filter((a) => a.provider === "codex").at(-1), exec = c.agents.filter((a) => a.provider === "claude").at(-1);
  out.zoom = await app.ev(`document.querySelector(".workspace__scene").style.transform`);
  out.worldBounds = { lead: lead.bounds, exec: exec.bounds };
  out.before = { leadCard: await rect(card(lead.agentId)), port: await rect(card(lead.agentId, ".agent-card__port")), execCard: await rect(card(exec.agentId)), execBody: await rect(card(exec.agentId, ".agent-card__body")) };
  // Recorder: every pointer event on the way (capture phase), capture changes, card geometry at each event, and
  // what the drop handler's elementsFromPoint sees. createLink is wrapped if the bridge allows it.
  out.recorder = await app.ev(`(() => {
    const log = window.__linkLog = [];
    const cards = () => [...document.querySelectorAll("[data-agent-id]")].map((el) => ({ id: el.dataset.agentId.slice(0, 8), role: el.dataset.agentRole, z: el.style.zIndex, r: el.getBoundingClientRect().toJSON() }));
    const desc = (el) => el ? (el.className?.baseVal ?? el.className ?? el.tagName) + (el.closest("[data-agent-id]") ? " @" + el.closest("[data-agent-id]").dataset.agentId.slice(0, 8) : "") : null;
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"])
      window.addEventListener(type, (e) => {
        const entry = { type, x: e.clientX, y: e.clientY, buttons: e.buttons, target: desc(e.target), hit: desc(document.elementFromPoint(e.clientX, e.clientY)) };
        if (type !== "pointermove") { entry.cards = cards(); entry.stack = document.elementsFromPoint(e.clientX, e.clientY).map(desc).slice(0, 8); }
        log.push(entry);
      }, true);
    let wrapped = false;
    try { const o = window.canvasTTY.orchestration; const f = o.createLink; o.createLink = (req) => { log.push({ type: "createLink", req }); return f(req).then((r) => { log.push({ type: "createLink:reply", r }); return r; }); }; wrapped = o.createLink !== f; } catch (e) { wrapped = String(e); }
    return { wrapped };
  })()`);
  const from = await app.center(card(lead.agentId, ".agent-card__port")), to = await app.center(card(exec.agentId, ".agent-card__body"));
  out.from = from; out.to = to;
  out.hitStart = await app.ev(`(() => { const h = document.elementFromPoint(${from.x}, ${from.y}); return h ? h.className + " in " + (h.closest("[data-agent-id]")?.dataset.agentRole ?? "-") : null; })()`);
  out.hitEnd = await app.ev(`(() => { const h = document.elementFromPoint(${to.x}, ${to.y}); return h ? h.className + " in " + (h.closest("[data-agent-id]")?.dataset.agentRole ?? "-") : null; })()`);
  await app.shot("01-before-drag");
  if (process.argv.includes("--kit-drag")) {
    // the fixed driver: both ends hit-tested (pointOn). --cover: a foreign element over the body's centre first.
    if (process.argv.includes("--cover")) await app.ev(`(() => { const d = document.createElement("div"); d.id = "r7-cover"; d.style.cssText = "position:fixed;z-index:99999;background:red;left:${to.x - 30}px;top:${to.y - 15}px;width:60px;height:30px"; document.body.append(d); })()`);
    if (process.argv.includes("--cover-all")) await app.ev(`(() => { const r = ${card(exec.agentId)}.getBoundingClientRect(); const d = document.createElement("div"); d.style.cssText = "position:fixed;z-index:99999;background:red;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px"; document.body.append(d); })()`);
    if (process.argv.includes("--moving")) await app.ev(`(() => { const st = document.createElement("style"); st.textContent = "@keyframes r7m { to { margin-left: 40px } } [data-agent-role=executor] .agent-card__body { animation: r7m 1s linear infinite alternate }"; document.head.append(st); })()`);
    try { const a = await app.pointOn(card(lead.agentId, ".agent-card__port")), b = await app.pointOn(card(exec.agentId, ".agent-card__body")); out.kitPoints = { a, b }; await app.drag(a, b, 20); }
    catch (e) { out.kitError = String(e.message); }
  } else if (process.argv.includes("--interleave")) {
    // a second mouse (the person's real cursor over the window) moving without a button in the middle of the drag
    await app.mouse("mouseMoved", from.x, from.y); await app.mouse("mousePressed", from.x, from.y, "left", 1);
    for (let i = 1; i <= 20; i++) {
      await app.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 20, from.y + ((to.y - from.y) * i) / 20, "left", 1);
      if (i === 10) await app.mouse("mouseMoved", 640, 700, "none", 0);
      await new Promise((r) => setTimeout(r, 16));
    }
    await app.mouse("mouseReleased", to.x, to.y, "left", 0);
  } else if (process.argv.includes("--escape") || process.argv.includes("--escape-early")) {
    // Escape during the drag (--escape: after the preview is shown; --escape-early: right after the press), then the
    // release over the executor: must link nothing
    const early = process.argv.includes("--escape-early");
    await app.mouse("mouseMoved", from.x, from.y); await app.mouse("mousePressed", from.x, from.y, "left", 1);
    if (early) await app.key("Escape", "Escape", 27);
    for (let i = 1; i <= 20; i++) {
      await app.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 20, from.y + ((to.y - from.y) * i) / 20, "left", 1);
      if (i === 10 && !early) { out.previewBeforeEscape = await app.ev(`!!document.querySelector(".agent-link--preview")`); await app.key("Escape", "Escape", 27); out.previewAfterEscape = await app.ev(`!!document.querySelector(".agent-link--preview")`); }
      await new Promise((r) => setTimeout(r, 16));
    }
    await app.mouse("mouseReleased", to.x, to.y, "left", 0);
    await new Promise((r) => setTimeout(r, 300));
    out.previewAfterRelease = await app.ev(`!!document.querySelector(".agent-link--preview")`);
  } else await app.drag(from, to, 20);
  await new Promise((r) => setTimeout(r, 1500));
  await app.shot("02-after-drag");
  const after = await canvasState(app);
  out.links = { before: c.links.length, after: after.links.length };
  out.after = { leadCard: await rect(card(lead.agentId)), execCard: await rect(card(exec.agentId)) };
  out.cardMessages = await app.ev(`[...document.querySelectorAll(".agent-card__message")].map((m) => m.textContent)`);
  const log = await app.ev("window.__linkLog");
  out.events = log.filter((e) => e.type !== "pointermove");
  out.moves = log.filter((e) => e.type === "pointermove").map((e) => [Math.round(e.x), Math.round(e.y), e.target, e.hit]);
} catch (e) { out.error = String(e?.stack ?? e); await app.shot("error").catch(() => {}); }
finally { fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(out, null, 1)); await app.quit(); }
console.log(JSON.stringify({ settle: out.settle, preview: [out.previewBeforeEscape, out.previewAfterEscape, out.previewAfterRelease], kitPoints: out.kitPoints, kitError: out.kitError, links: out.links, from: out.from, to: out.to, hitStart: out.hitStart, hitEnd: out.hitEnd, error: out.error, recorder: out.recorder }));
process.exit(0);
