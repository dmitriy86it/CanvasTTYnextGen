// v2 of R-U07: the first version read B's saved camera after a fixed sleep(900) following the pan. The camera saver
// writes after 500 ms of quiet, and under load that write had not landed yet (coordinator's run: "camB":null, while
// after the action B's saved camera was {365,179}, the active workspace A and the card shown: the app was right). This
// version waits by condition until B's saved camera equals the camera shown after the pan, then does the same action
// and the same checks.
// R-U07. Opening a plugin canvas app that is already open, while its card lives in another workspace: App's
// openPluginCanvasContribution takes the "existing" branch and sets the focus camera without switching to the card's
// workspace and without a workspace label. The workspace shown (B) moves its camera to where A's card is — the card is
// not in B — and that camera is saved for B.
// Spec: workspaces-spec.md §5 (a card is shown in its own workspace; "терминал → его пространство → focusCamera" for the
// widget; Browser elsewhere is named), §4 "Запоздалая запись камеры A пишется в A и не трогает B".
// Trigger: window.canvasTTY.plugins.openCanvas (the IPC a plugin or an integration uses; main answers with onOpenCanvas).
// The plugin is the repository's example (examples/plugins/studio-kit) seeded into the temporary userData as installed.
// Exit 1 when B's camera changed while the card is not shown in B. Usage: node R-U07-….mjs [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { near, outDir, q, setup, sleep, start } from "./ui-env.mjs";

const ROOT = path.resolve(new URL("../../../../../../", import.meta.url).pathname);
const OUT = outDir("r-u07");
const env = setup("r-u07");
const PLUGIN = "com.example.studio-kit";
fs.mkdirSync(path.join(env.userData, "plugins"), { recursive: true });
fs.cpSync(path.join(ROOT, "examples", "plugins", "studio-kit"), path.join(env.userData, "plugins", PLUGIN), { recursive: true });
fs.writeFileSync(path.join(env.userData, "plugins.json"), JSON.stringify({ [PLUGIN]: { sourceUrl: "https://github.com/example/studio-kit", enabled: true, installedAt: 1 } }));
const result = { repro: "R-U07", ok: false };
let h;
try {
  h = await start({ ...env, port: 9577, shots: OUT });
  const { app } = h;
  await h.size(1280, 800);
  await h.ready();
  result.pluginLoaded = await app.ev(`window.canvasTTY.plugins.list().then((l) => l.some((p) => p.manifest.id === ${JSON.stringify(PLUGIN)} && p.enabled))`);
  const A = (await h.api(`w.create(${JSON.stringify({ title: "Альфа", root: env.projectA, activate: false })})`)).workspaces.at(-1).id;
  const B = (await h.api(`w.create(${JSON.stringify({ title: "Бета", root: env.projectB, activate: false })})`)).workspaces.at(-1).id;
  await app.ev(`window.canvasTTY.settings.update({ pluginCanvas: [{ id: "pc1", pluginId: ${JSON.stringify(PLUGIN)}, contributionId: "notes", title: "Notes", position: { x: 2600, y: 1400 }, size: { width: 680, height: 440 }, workspaceId: ${JSON.stringify(A)} }] }).then(() => true)`);
  await h.reload();
  await h.switchTo(A);
  result.cardShownInA = await app.ev(`!!${q('[data-canvas-layer-id="plugin:pc1"]')}`);
  await h.switchTo(B);
  await app.panBy({ x: 120, y: 60 });
  const shownB = await h.cameraNow();
  await app.waitFor(`window.canvasTTY.workspaces.get().then((s) => { const c = s.workspaces.find((w) => w.id === ${JSON.stringify(B)}).camera;
    return !!c && Math.abs(c.x - ${shownB.x}) <= 1 && Math.abs(c.y - ${shownB.y}) <= 1 && Math.abs(c.zoom - ${shownB.zoom}) < 1e-6; })`, "B's camera saved", 15_000);
  const camB = await h.stored(B);
  await app.ev(`window.canvasTTY.plugins.openCanvas(${JSON.stringify(PLUGIN)}, "notes").then(() => true)`);
  await sleep(1_500);
  const s = await h.state();
  Object.assign(result, {
    A, B, camB,
    activeAfter: s.activeId === A ? "A" : s.activeId === B ? "B" : s.activeId,
    cameraNow: await h.cameraNow(),
    storedB: await h.stored(B),
    cardShownNow: await app.ev(`!!${q('[data-canvas-layer-id="plugin:pc1"]')}`),
    pluginCanvasCount: (await app.ev("window.canvasTTY.settings.get()")).pluginCanvas.length
  });
  result.bCameraUnchanged = near(result.storedB, camB) && (result.activeAfter !== "B" || near(result.cameraNow, camB));
  await app.shot("r-u07-after-open");
  // correct: either the card is shown (its workspace opened) or B keeps its camera; never B moved to an empty place
  result.ok = result.pluginLoaded && result.cardShownInA && result.bCameraUnchanged && (result.activeAfter === "A" ? result.cardShownNow : true);
  if (!result.pluginLoaded || !result.cardShownInA) result.inconclusive = "the seeded plugin card was not drawn in A";
} catch (e) {
  result.error = String(e?.stack ?? e);
} finally {
  await h?.app.stop();
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
