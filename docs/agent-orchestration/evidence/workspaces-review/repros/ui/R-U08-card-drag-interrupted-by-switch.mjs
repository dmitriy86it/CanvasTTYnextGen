// R-U08. A card drag in A interrupted by ⌘digit, button still held, then the rest of the move and the release in B:
// once for a terminal card (header), once for a sticky note (header). Nothing of A's unfinished drag may change B (its
// camera, shown or saved, and its own note), and back in A the card is drawn where main/settings keep it (no stale
// preview; either the old place or a committed new one, but drawn = saved).
// Spec: workspaces-spec.md §5 "Жест, начатый в A, заканчивается в A…", §4 camera, §7 W3/W11.
// Exit 1 on any difference. Usage: node R-U08-card-drag-interrupted-by-switch.mjs [--out <dir>]
import { near, outDir, q, setup, sleep, start } from "./ui-env.mjs";

const OUT = outDir("r-u08");
const env = setup("r-u08");
const result = { repro: "R-U08", ok: true, cases: [] };
let h;
try {
  h = await start({ ...env, port: 9578, shots: OUT });
  const { app } = h;
  await h.size(1280, 800);
  await h.ready();
  const A = (await h.api(`w.create(${JSON.stringify({ title: "Альфа", root: env.projectA, activate: false })})`)).workspaces.at(-1).id;
  const B = (await h.api(`w.create(${JSON.stringify({ title: "Бета", root: env.projectB, activate: false })})`)).workspaces.at(-1).id;
  await app.ev(`window.canvasTTY.settings.update({ persistStickyNotes: true, stickyNotes: [
    { id: "na", text: "A", position: { x: 1500, y: 800 }, size: { width: 300, height: 220 }, workspaceId: ${JSON.stringify(A)} },
    { id: "nb", text: "B", position: { x: 1500, y: 800 }, size: { width: 300, height: 220 }, workspaceId: ${JSON.stringify(B)} }] }).then(() => true)`);
  const term = await app.ev(`window.canvasTTY.terminal.create({ provider: "terminal", profile: "normal", cwd: ${JSON.stringify(env.projectA)}, position: { x: 1500, y: 150 }, workspaceId: ${JSON.stringify(A)} })`);
  await h.reload();
  const order = (await h.state()).workspaces.filter((w) => !w.closed).map((w) => w.id);
  await h.switchTo(B);
  await sleep(900);
  const camB = await h.stored(B);
  const savedOf = async (kind) => kind === "terminal"
    ? (await app.ev("window.canvasTTY.terminal.list()")).find((s) => s.id === term.id).position
    : (await app.ev("window.canvasTTY.settings.get()")).stickyNotes.find((n) => n.id === "na").position;
  const cases = [
    { kind: "terminal", layer: q(`[data-canvas-layer-id="terminal:${term.id}"]`), header: q(`[data-canvas-layer-id="terminal:${term.id}"] .terminal-card__header`) },
    { kind: "note", layer: q('[data-sticky-note-id="na"]'), header: q('[data-sticky-note-id="na"] .sticky-note-card__header') }
  ];
  for (const c of cases) {
    await h.switchTo(A);
    await app.reveal(c.header);
    const p = await app.ev(`(() => { const el = ${c.header}; const b = el.getBoundingClientRect();
      for (let x = b.left + 8; x < b.right - 8; x += 8) for (const y of [b.top + b.height / 2, b.top + 6]) {
        const hit = document.elementFromPoint(x, y); if (hit && el.contains(hit) && !hit.closest("button, input, textarea")) return { x, y }; }
      return null; })()`);
    if (!p) throw new Error(`no free point on the ${c.kind} header`);
    const rect = () => app.ev(`(() => { const r = ${c.layer}?.getBoundingClientRect(); return r ? { x: Math.round(r.left), y: Math.round(r.top) } : null; })()`);
    const savedBefore = await savedOf(c.kind);
    const drawnBefore = await rect();
    const r = { kind: c.kind, pressHitsHeader: await h.hits(c.header, p.x, p.y), savedBefore, drawnBefore };
    await app.mouse("mouseMoved", p.x, p.y);
    await app.mouse("mousePressed", p.x, p.y, "left", 1);
    for (let i = 1; i <= 6; i++) { await app.mouse("mouseMoved", p.x + 15 * i, p.y + 10 * i, "left", 1); await sleep(16); }
    await sleep(80);
    r.cardFollowsInA = JSON.stringify(await rect()) !== JSON.stringify(drawnBefore);
    await h.chord(order.indexOf(B) + 1);
    await app.waitFor(`${h.tab(B)}?.getAttribute("aria-selected") === "true"`, "B by ⌘digit");
    for (let i = 7; i <= 12; i++) { await app.mouse("mouseMoved", p.x + 15 * i, p.y + 10 * i, "left", 1); await sleep(16); }
    await app.mouse("mouseReleased", p.x + 180, p.y + 120, "left", 0);
    await sleep(1_200);
    r.bShownUnchanged = near(await h.cameraNow(), camB);
    r.bStoredUnchanged = near(await h.stored(B), camB);
    r.bNoteUnchanged = JSON.stringify((await app.ev("window.canvasTTY.settings.get()")).stickyNotes.find((n) => n.id === "nb").position) === JSON.stringify({ x: 1500, y: 800 });
    r.aCardInBDom = await app.ev(`!!${c.layer}`);
    await h.switchTo(A);
    await sleep(300);
    r.savedAfter = await savedOf(c.kind);
    r.drawnAfter = await rect();
    const moved = { x: r.savedAfter.x - savedBefore.x, y: r.savedAfter.y - savedBefore.y };
    const zoom = (await h.cameraNow()).zoom;
    // drawn = saved: the screen offset equals the saved offset times the zoom (±2 px)
    r.drawnMatchesSaved = !!r.drawnAfter && Math.abs(r.drawnAfter.x - drawnBefore.x - moved.x * zoom) <= 2 && Math.abs(r.drawnAfter.y - drawnBefore.y - moved.y * zoom) <= 2;
    r.ok = r.bShownUnchanged && r.bStoredUnchanged && r.bNoteUnchanged && !r.aCardInBDom && r.drawnMatchesSaved;
    if (!r.pressHitsHeader || !r.cardFollowsInA) r.inconclusive = "the press did not start a card drag";
    result.cases.push(r);
    if (!r.ok) result.ok = false;
    await app.shot(`r-u08-${c.kind}`);
  }
} catch (e) {
  result.ok = false;
  result.error = String(e?.stack ?? e);
} finally {
  await h?.app.stop();
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
