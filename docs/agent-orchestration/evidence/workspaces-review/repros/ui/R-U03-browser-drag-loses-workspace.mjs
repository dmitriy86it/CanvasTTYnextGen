// R-U03. The Browser card placed in workspace B loses its owner on the first drag (or resize) of its header: BrowserCard
// commits { position, size } without workspaceId, App saves it as is, and main's normalizer reads a missing field as
// "common". The card vanishes from B and appears on the common canvas.
// Spec: workspaces-spec.md §1 (ownership is the explicit workspaceId), §4 "Browser … Перенос только явным действием",
// §7 W10. Exit 1 when the drag changed the owner. Usage: node R-U03-browser-drag-loses-workspace.mjs [--out <dir>]
import { outDir, q, setup, sleep, start } from "./ui-env.mjs";

const OUT = outDir("r-u03");
const env = setup("r-u03");
const result = { repro: "R-U03", ok: false };
let h;
try {
  h = await start({ ...env, port: 9571, shots: OUT });
  const { app } = h;
  await h.size(1280, 800);
  await h.ready();
  const B = (await h.api(`w.create(${JSON.stringify({ title: "Бета", root: env.projectB, activate: false })})`)).workspaces.at(-1).id;
  await app.ev("window.canvasTTY.browser.open('about:blank').then(() => true)");
  await app.ev(`window.canvasTTY.settings.update({ browserCanvas: { position: { x: 1500, y: 200 }, size: { width: 920, height: 620 }, workspaceId: ${JSON.stringify(B)} } }).then(() => true)`);
  await h.reload();
  await h.switchTo(B);
  const header = q('[data-canvas-layer-id="browser"] .browser-card__header');
  await app.waitFor(`${header} && true`, "browser card in B");
  await app.reveal(header);
  const before = await app.ev("window.canvasTTY.settings.get()").then((s) => s.browserCanvas);
  // a point of the header that is not one of its controls, confirmed by elementFromPoint
  const p = await app.ev(`(() => { const el = ${header}; const b = el.getBoundingClientRect();
    for (let x = b.left + 6; x < b.right - 6; x += 8) for (const y of [b.top + b.height / 2, b.top + 8, b.bottom - 8]) {
      const hit = document.elementFromPoint(x, y);
      if (hit && el.contains(hit) && !hit.closest("button, input, [data-browser-action]")) return { x, y };
    }
    return null; })()`);
  if (!p) throw new Error("no free point on the browser header");
  result.pressHitsHeader = await h.hits(header, p.x, p.y);
  await app.drag(p, { x: p.x + 80, y: p.y + 40 }, 12);
  await sleep(800);
  const after = await app.ev("window.canvasTTY.settings.get()").then((s) => s.browserCanvas);
  Object.assign(result, {
    B, before, after,
    moved: !!after && (after.position.x !== before.position.x || after.position.y !== before.position.y),
    stillShownInB: await app.ev(`!!${q('[data-canvas-layer-id="browser"]')}`),
    ownerAfter: after?.workspaceId ?? "(none: common)"
  });
  await app.shot("r-u03-after-drag");
  result.ok = result.moved && after?.workspaceId === B && result.stillShownInB;
  if (!result.moved) result.inconclusive = "the drag did not move the browser card";
} catch (e) {
  result.error = String(e?.stack ?? e);
} finally {
  await h?.app.stop();
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
