// R-U04. Keyboard focus (Tab, as a person presses it) reaching a control of a card that is outside the view scrolls the
// `.workspace` element (overflow: hidden, but scrollable by focus). The scroll is never undone: the workspace switcher,
// the canvas controls, the minimap and the run panel (all inside `.workspace`) move out of the window until a reload.
// This is the "outside the window" of smoke-orchestration-ui: there the smoke's own `.focus()` on the lead card's port
// did the same (observer log orch-par/p2b: scrollLeft 0 → 978 on focus of .agent-card__port).
// Spec: workspaces-spec.md §5 (the switcher above the canvas is how workspaces are reached), §7 W1–W11 at 1280×800.
// Exit 1 when `.workspace` scrolled or the switcher left the window. Usage: node R-U04-….mjs [--out <dir>]
import { outDir, q, setup, sleep, start } from "./ui-env.mjs";

const OUT = outDir("r-u04");
const env = setup("r-u04");
const result = { repro: "R-U04", ok: false };
let h;
try {
  h = await start({ ...env, port: 9573, shots: OUT });
  const { app } = h;
  await h.size(1280, 800);
  await h.ready();
  // one note far to the right and below, on the canvas that is shown (common)
  await app.ev(`window.canvasTTY.settings.update({ persistStickyNotes: true, stickyNotes: [{ id: "far-note", text: "far", position: { x: 4200, y: 2600 }, size: { width: 300, height: 220 } }] }).then(() => true)`);
  await h.reload();
  const note = q('[data-sticky-note-id="far-note"]');
  result.noteOutsideView = await app.ev(`(() => { const r = ${note}.getBoundingClientRect(); return r.left >= innerWidth || r.top >= innerHeight; })()`);
  const barBefore = await app.ev(`${q("[data-workspace-bar]")}.getBoundingClientRect().toJSON()`);
  await app.ev("document.activeElement?.blur(); true");
  let presses = 0;
  for (; presses < 300; presses++) {
    await app.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await app.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    if (await app.ev(`!!${note}?.contains(document.activeElement)`)) break;
  }
  await sleep(300);
  result.tabPresses = presses + 1;
  result.focusInFarNote = await app.ev(`!!${note}?.contains(document.activeElement)`);
  result.scroll = await app.ev(`(() => { const w = ${q(".workspace")}; return { left: w.scrollLeft, top: w.scrollTop }; })()`);
  result.barAfter = await app.ev(`${q("[data-workspace-bar]")}.getBoundingClientRect().toJSON()`);
  result.barBefore = barBefore;
  result.barInsideWindow = await app.ev(`(() => { const r = ${q("[data-workspace-bar]")}.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`);
  result.barHitAtCentre = await app.ev(`(() => { const el = ${q("[data-workspace-bar]")}; const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const h = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null; return !!h && el.contains(h); })()`);
  // does anything bring it back? a click on empty canvas, Escape, Home
  await app.key("Escape", "Escape", 27);
  await app.clickEl(`document.querySelectorAll(".canvas-controls button")[0]`).catch((e) => { result.homeButton = String(e.message); });
  await sleep(400);
  result.scrollAfterHome = await app.ev(`(() => { const w = ${q(".workspace")}; return { left: w.scrollLeft, top: w.scrollTop }; })()`);
  await app.shot("r-u04-after-tab");
  result.ok = result.focusInFarNote && result.scroll.left === 0 && result.scroll.top === 0 && result.barInsideWindow;
  if (!result.focusInFarNote) result.inconclusive = "Tab never reached the far note";
} catch (e) {
  result.error = String(e?.stack ?? e);
} finally {
  await h?.app.stop();
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
