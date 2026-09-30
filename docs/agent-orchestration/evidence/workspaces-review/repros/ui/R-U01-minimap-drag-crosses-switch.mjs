// R-U01. A minimap drag begun in workspace A goes on after ⌘digit switches to B: the rest of the drag moves B's camera
// (computed from A's camera at the press) and that camera is saved for B.
// Spec: workspaces-spec.md §5 "Жест, начатый в A, заканчивается в A … перетаскивание холста … отменяются до следующего
// кадра", §4 "Запоздалая запись камеры A пишется в A и не трогает B", §7 W3/W11.
// Setting used: minimapInteractionMode = "drag" (a user setting; the default is "click").
// Exit 1 when B's camera (shown or saved) changed. Usage: node R-U01-minimap-drag-crosses-switch.mjs [--out <dir>]
import { near, outDir, q, setup, sleep, start } from "./ui-env.mjs";

const OUT = outDir("r-u01");
const env = setup("r-u01");
const result = { repro: "R-U01", ok: false, steps: {} };
let h;
try {
  h = await start({ ...env, port: 9570, shots: OUT });
  const { app } = h;
  await h.size(1280, 800);
  await h.ready();
  await app.ev(`window.canvasTTY.settings.update({ minimapInteractionMode: "drag" }).then(() => true)`);
  const A = (await h.api(`w.create(${JSON.stringify({ title: "Альфа", root: env.projectA, activate: false })})`)).workspaces.at(-1).id;
  const B = (await h.api(`w.create(${JSON.stringify({ title: "Бета", root: env.projectB, activate: false })})`)).workspaces.at(-1).id;
  await h.reload();
  const order = (await h.state()).workspaces.filter((w) => !w.closed).map((w) => w.id);
  // B gets a camera of its own, saved
  await h.switchTo(B);
  await app.panBy({ x: 150, y: 60 });
  await sleep(900);
  const camB = await h.cameraNow();
  result.steps.camBSaved = near(await h.stored(B), camB);
  await h.switchTo(A);
  const camA = await h.cameraNow();
  result.steps.minimapMode = await app.ev(`${q(".canvas-minimap")}?.dataset.interactionMode`);
  // press on the minimap where elementFromPoint confirms it, move: A's camera follows
  const p = await app.pointOn(q(".canvas-minimap"));
  result.steps.pressHitsMinimap = await h.hits(q(".canvas-minimap"), p.x, p.y);
  await app.mouse("mouseMoved", p.x, p.y);
  await app.mouse("mousePressed", p.x, p.y, "left", 1);
  for (let i = 1; i <= 4; i++) { await app.mouse("mouseMoved", p.x + 5 * i, p.y + 3 * i, "left", 1); await sleep(16); }
  await sleep(100);
  const camAMoved = await h.cameraNow();
  result.steps.minimapDragMovesA = !near(camAMoved, camA);
  // ⌘digit of B with the button still held
  await h.chord(order.indexOf(B) + 1);
  await app.waitFor(`${h.tab(B)}?.getAttribute("aria-selected") === "true"`, "B by ⌘digit");
  await sleep(100);
  const camBAtSwitch = await h.cameraNow();
  result.steps.bShownAtSwitch = near(camBAtSwitch, camB);
  // the rest of the same drag, then release
  for (let i = 5; i <= 12; i++) { await app.mouse("mouseMoved", p.x + 5 * i, p.y + 3 * i, "left", 1); await sleep(16); }
  await app.mouse("mouseReleased", p.x + 60, p.y + 36, "left", 0);
  await sleep(1_200); // past the camera saver's 500 ms
  const camBAfter = await h.cameraNow();
  const storedB = await h.stored(B);
  const storedA = await h.stored(A);
  Object.assign(result, { A, B, camA, camAMoved, camB, camBAfter, storedB, storedA });
  result.bCameraUnchanged = near(camBAfter, camB);
  result.bStoredUnchanged = near(storedB, camB);
  await app.shot("r-u01-after");
  result.ok = result.steps.pressHitsMinimap && result.steps.minimapDragMovesA && result.bCameraUnchanged && result.bStoredUnchanged;
  if (!result.steps.pressHitsMinimap || !result.steps.minimapDragMovesA) result.inconclusive = "the press did not start a minimap drag in A";
} catch (e) {
  result.error = String(e?.stack ?? e);
} finally {
  await h?.app.stop();
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
