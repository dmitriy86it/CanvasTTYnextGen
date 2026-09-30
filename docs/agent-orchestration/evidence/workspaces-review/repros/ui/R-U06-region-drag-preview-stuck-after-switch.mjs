// R-U06. A region drag in A interrupted by ⌘digit (button still held): the region card unmounts without ending its
// drag, WorkspaceCanvas keeps `regionMovePreview`, and after the return to A the region and the cards inside it are drawn
// at the preview place while settings keep the old place. The next drag of a card inside starts from the drawn (not
// saved) place.
// Spec: workspaces-spec.md §5 "Жест, начатый в A, заканчивается в A. При переключении … перенос группы отменяются до
// следующего кадра" (a region move carries its cards: a group move).
// Exit 1 when, back in A, the drawn region or note differs from what settings hold. Usage: node R-U06-….mjs [--out <dir>]
import { outDir, q, setup, sleep, start } from "./ui-env.mjs";

const OUT = outDir("r-u06");
const env = setup("r-u06");
const result = { repro: "R-U06", ok: false };
let h;
try {
  h = await start({ ...env, port: 9575, shots: OUT });
  const { app } = h;
  await h.size(1280, 800);
  await h.ready();
  const A = (await h.api(`w.create(${JSON.stringify({ title: "Альфа", root: env.projectA, activate: false })})`)).workspaces.at(-1).id;
  const B = (await h.api(`w.create(${JSON.stringify({ title: "Бета", root: env.projectB, activate: false })})`)).workspaces.at(-1).id;
  await app.ev(`window.canvasTTY.settings.update({ persistCanvasRegions: true, persistStickyNotes: true,
    canvasRegions: [{ id: "rg", title: "Область A", color: "#88AA44", position: { x: 1500, y: 150 }, size: { width: 700, height: 420 }, workspaceId: ${JSON.stringify(A)} }],
    stickyNotes: [{ id: "nt", text: "в области", position: { x: 1560, y: 230 }, size: { width: 300, height: 220 }, workspaceId: ${JSON.stringify(A)} }] }).then(() => true)`);
  await h.reload();
  const order = (await h.state()).workspaces.filter((w) => !w.closed).map((w) => w.id);
  await h.switchTo(A);
  const title = q('[data-canvas-region-id="rg"] .canvas-region__title');
  await app.reveal(title);
  const p = await app.pointOn(title);
  result.pressHitsTitle = await h.hits(title, p.x, p.y);
  const rect = (sel) => app.ev(`(() => { const r = ${sel}?.getBoundingClientRect(); return r ? { x: Math.round(r.left), y: Math.round(r.top) } : null; })()`);
  const drawnBefore = { region: await rect(q('[data-canvas-region-id="rg"]')), note: await rect(q('[data-sticky-note-id="nt"]')) };
  await app.mouse("mouseMoved", p.x, p.y);
  await app.mouse("mousePressed", p.x, p.y, "left", 1);
  for (let i = 1; i <= 8; i++) { await app.mouse("mouseMoved", p.x + 15 * i, p.y + 8 * i, "left", 1); await sleep(16); }
  await sleep(100);
  result.previewMovedRegion = JSON.stringify(await rect(q('[data-canvas-region-id="rg"]'))) !== JSON.stringify(drawnBefore.region);
  await h.chord(order.indexOf(B) + 1);
  await app.waitFor(`${h.tab(B)}?.getAttribute("aria-selected") === "true"`, "B by ⌘digit");
  await app.mouse("mouseMoved", p.x + 150, p.y + 80, "left", 1);
  await app.mouse("mouseReleased", p.x + 150, p.y + 80, "left", 0);
  await sleep(300);
  await h.switchTo(A);
  await sleep(300);
  const s = await app.ev("window.canvasTTY.settings.get()");
  result.saved = { region: s.canvasRegions.find((r) => r.id === "rg")?.position, note: s.stickyNotes.find((n) => n.id === "nt")?.position };
  result.drawnBefore = drawnBefore;
  result.drawnAfter = { region: await rect(q('[data-canvas-region-id="rg"]')), note: await rect(q('[data-sticky-note-id="nt"]')) };
  result.regionDrawnAtSavedPlace = JSON.stringify(result.drawnAfter.region) === JSON.stringify(drawnBefore.region);
  result.noteDrawnAtSavedPlace = JSON.stringify(result.drawnAfter.note) === JSON.stringify(drawnBefore.note);
  result.savedUnchanged = result.saved.region?.x === 1500 && result.saved.region?.y === 150 && result.saved.note?.x === 1560 && result.saved.note?.y === 230;
  await app.shot("r-u06-back-in-a");
  result.ok = result.savedUnchanged && result.regionDrawnAtSavedPlace && result.noteDrawnAtSavedPlace;
  if (!result.pressHitsTitle || !result.previewMovedRegion) result.inconclusive = "the press did not start a region drag";
} catch (e) {
  result.error = String(e?.stack ?? e);
} finally {
  await h?.app.stop();
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
