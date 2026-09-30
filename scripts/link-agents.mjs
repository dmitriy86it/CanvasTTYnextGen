// The link gesture of the UI drivers: the Codex lead's port dragged onto the Claude executor with real mouse events,
// optionally with a bounded diagnostic journal (the series' --diag-link). Kept apart from the driver so that its failure
// paths can be tested with a fake app.
//
// The journal is written on success and on any failure — also when the cards or the points do not exist yet — and a
// failure while writing it never replaces the gesture's own error. The observers are passive capture listeners put in
// place before the cards are made (no step is added between measuring the points and the gesture); they never prevent
// or stop an event and are removed at the end, as is the wrapper that records the mouse commands sent. The renderer adds
// its own steps through window.__canvasTTYLinkTrace (linkTrace.ts): the port handler's decision, createLink and its outcome.
import fs from "node:fs";

export const OBSERVE = `(() => {
  const log = window.__canvasTTYLinkDiag = { origin: performance.timeOrigin, href: location.href, events: [], dropped: 0 };
  window.__canvasTTYLinkTrace = [];
  const push = (e) => { if (log.events.length < 400) log.events.push(e); else log.dropped++; };
  const tag = (el) => el && el.nodeType === 1 ? (String(el.className || el.tagName).slice(0, 50) + (el.closest?.("[data-agent-id]") ? " @" + el.closest("[data-agent-id]").dataset.agentId.slice(0, 8) : "")) : String(el);
  const layout = () => ({ cards: [...document.querySelectorAll("[data-agent-id]")].map((c) => { const r = c.getBoundingClientRect(), p = c.querySelector(".agent-card__port")?.getBoundingClientRect(); return { id: c.dataset.agentId.slice(0, 8), z: getComputedStyle(c).zIndex, rect: [r.left, r.top, r.width, r.height].map(Math.round), port: p ? [p.left, p.top, p.width, p.height].map(Math.round) : null }; }),
    scene: document.querySelector(".workspace__scene")?.style.transform ?? null, focus: document.hasFocus(), visibility: document.visibilityState, size: [innerWidth, innerHeight] });
  const full = new Set(["pointerdown", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"]);
  const added = [];
  const on = (type, f, opts) => { window.addEventListener(type, f, opts); added.push([type, f, opts]); };
  window.__canvasTTYLinkDiagRemove = () => { for (const [type, f, opts] of added) window.removeEventListener(type, f, opts); delete window.__canvasTTYLinkTrace; delete window.__canvasTTYLinkDiagRemove; };
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"]) on(type, (e) => {
    const last = log.events[log.events.length - 1];
    if (type === "pointermove" && last?.type === type && last.target === tag(e.target) && last.buttons === e.buttons) { last.n++; last.to = [e.clientX, e.clientY]; return; }
    push({ t: Math.round(performance.now()), type, pointerId: e.pointerId, button: e.button, buttons: e.buttons, x: e.clientX, y: e.clientY, target: tag(e.target), n: 1,
      ...(full.has(type) ? { under: document.elementsFromPoint(e.clientX, e.clientY).slice(0, 4).map(tag), layout: layout() } : {}) });
  }, { capture: true, passive: true });
  for (const type of ["resize", "focus", "blur", "visibilitychange"]) on(type, () => push({ t: Math.round(performance.now()), type, focus: document.hasFocus(), visibility: document.visibilityState, size: [innerWidth, innerHeight] }), { capture: true, passive: true });
  on("error", (e) => push({ t: Math.round(performance.now()), type: "error", message: String(e.message).slice(0, 200) }), { capture: true });
  on("unhandledrejection", (e) => push({ t: Math.round(performance.now()), type: "unhandledrejection", message: String(e.reason?.message ?? e.reason).slice(0, 200) }));
  log.layoutAtStart = layout();
  return true;
})()`;

export const DUMP = `(() => { const d = window.__canvasTTYLinkDiag; return { observers: d ? { ...d, sameDocument: d.origin === performance.timeOrigin } : "missing: the page was replaced after the observers were set",
  trace: window.__canvasTTYLinkTrace ?? null, focus: document.hasFocus(), visibility: document.visibilityState, size: [innerWidth, innerHeight],
  messages: [...document.querySelectorAll("[data-agent-id]")].map((c) => ({ id: c.dataset.agentId.slice(0, 8), text: c.textContent.trim().slice(0, 200) })) }; })()`;
export const UNOBSERVE = "window.__canvasTTYLinkDiagRemove?.(), true";

const short = (id) => (typeof id === "string" ? id.slice(0, 8) : null);
const pairs = (canvas) => canvas?.links?.map((l) => [short(l.fromAgentId), short(l.toAgentId)]) ?? null;

// Resolves to the new link (this lead to this executor, not merely one more link). diagFile: null (no journal) or the
// path of this gesture's own file.
export async function linkAgents({ app, dir, createAgent, canvasState, card, diagFile = null, anon = String, log = () => {} }) {
  const diag = diagFile ? { stage: "start", sent: [] } : null;
  const stage = (s) => { if (diag) diag.stage = s; };
  const mouse = app.mouse;
  let observed = false, before = null, after = null, lead = null, exec = null, from = null, to = null, link = null, failure = null;
  try {
    if (diag) { stage("observe"); await app.ev(OBSERVE); observed = true; }
    stage("create lead card"); await createAgent(app, "Агент Codex (лид)", dir);
    stage("create executor card"); await createAgent(app, "Агент Claude (исполнитель)", dir);
    stage("read canvas"); before = await canvasState(app);
    lead = before.agents.filter((a) => a.provider === "codex").at(-1) ?? null;
    exec = before.agents.filter((a) => a.provider === "claude").at(-1) ?? null;
    if (!lead || !exec) throw new Error(`the canvas has no ${lead ? "executor" : "lead"} card`);
    // both ends hit-tested: the press on the lead's own port, the drop on the executor's body (the drop zone)
    stage("point on the lead's port"); from = await app.pointOn(card(lead.agentId, ".agent-card__port"));
    stage("point on the executor"); to = await app.pointOn(card(exec.agentId, ".agent-card__body"));
    if (diag) app.mouse = (type, x, y, button, buttons) => { diag.sent.push({ t: Date.now(), type, x, y, button, buttons }); return mouse(type, x, y, button, buttons); };
    stage("drag"); await app.drag(from, to, 20);
    app.mouse = mouse;
    stage("wait for the link");
    await app.waitFor(`window.canvasTTY.orchestration.canvas().then((r) => r.value.links.some((l) => l.fromAgentId === ${JSON.stringify(lead.agentId)} && l.toAgentId === ${JSON.stringify(exec.agentId)}))`, "link");
    stage("read canvas after"); after = await canvasState(app);
    link = after.links.find((l) => l.fromAgentId === lead.agentId && l.toAgentId === exec.agentId) ?? null;
    stage("done");
  } catch (e) {
    failure = e;
  } finally {
    app.mouse = mouse;
    if (diag) {
      const notes = [];
      const page = observed ? await app.ev(DUMP).catch((e) => ({ error: String(e?.message ?? e) })) : null;
      if (observed) await app.ev(UNOBSERVE).catch((e) => notes.push(`observers not removed: ${e?.message ?? e}`));
      if (!after) after = await canvasState(app).catch((e) => { notes.push(`canvas after: ${e?.message ?? e}`); return null; });
      try {
        fs.writeFileSync(diagFile, `${anon(JSON.stringify({ ok: !failure, stage: diag.stage, failure: failure ? String(failure?.message ?? failure) : null,
          lead: short(lead?.agentId), exec: short(exec?.agentId), points: { from, to }, sent: diag.sent,
          linksBefore: pairs(before), linksAfter: pairs(after), notes, page }, null, 1))}\n`);
      } catch (e) { log(`link diagnostics not written: ${e?.message ?? e}`); }
      await app.shot?.(diagFile.replace(/^.*\//, "").replace(/\.json$/, "")).catch(() => {});
      log(`link diagnostics: ${failure ? `no link at «${diag.stage}»` : "linked"} (${diagFile.replace(/^.*\//, "")})`);
    }
  }
  if (failure) throw failure;
  return link;
}
