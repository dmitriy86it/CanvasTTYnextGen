// What covers the canvas in the first seconds after launch (1280×800, as the series): elementFromPoint over a grid,
// sampled every 100 ms for 8 s; prints each change. No model, temporary userData.
import { launch, workspace } from "../../../../../../scripts/orchestration-app-kit.mjs";
const { D } = workspace("cto-r7-start-");
const app = await launch({ userData: D("userData"), port: 9600 + Math.floor(Math.random() * 90), shots: D() });
await app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const t0 = Date.now(); let last = "";
while (Date.now() - t0 < 8000) {
  const s = await app.ev(`(() => { const out = {}; for (const [x, y] of [[40, 90], [105, 254], [179, 124], [640, 400]]) { const h = document.elementFromPoint(x, y); out[x + "," + y] = h ? String(h.className?.baseVal ?? h.className).slice(0, 60) : null; }
    out.scene = document.querySelector(".workspace__scene")?.style.transform; return JSON.stringify(out); })()`);
  if (s !== last) { console.log(`+${Date.now() - t0}ms ${s}`); last = s; }
  await new Promise((r) => setTimeout(r, 100));
}
await app.quit();
