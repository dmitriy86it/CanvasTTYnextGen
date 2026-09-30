// Control: the first instance alone, same timing as the SI check; does "Local State" appear without a second instance?
import fs from "node:fs"; import path from "node:path";
import { launch, sleep } from "<REPO>/scripts/orchestration-app-kit.mjs";
const S = path.dirname(new URL(import.meta.url).pathname);
const B = fs.mkdtempSync("/tmp/cto-s0c-"); const HOME = path.join(B, "home"); fs.mkdirSync(HOME);
const out = [];
for (const build of ["raoden/mac-arm64/Raoden Loom.app/Contents/MacOS/Raoden Loom", "canvastty/mac-arm64/CanvasTTY.app/Contents/MacOS/CanvasTTY"]) {
  const D = path.join(B, `p-${out.length}`);
  const app = await launch({ userData: D, port: 9700 + out.length, shots: S, executable: path.join(S, `pkg-${build}`), env: { HOME, SHELL: "/bin/sh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  await app.waitFor("document.querySelector('.workspace') && window.canvasTTY && true", "window", 60_000);
  await sleep(1500 + 2000); // as in the SI check: open() waits 1.5 s, then 2 s before the snapshot
  const t0 = fs.readdirSync(D).includes("Local State");
  await sleep(1800); // as long as the second instance and the pause after it took
  const t1 = fs.readdirSync(D).includes("Local State");
  const st = t1 ? fs.statSync(path.join(D, "Local State")) : null;
  await app.quit();
  out.push({ build: build.split("/")[0], localStateAtSnapshot: t0, localStateAfter: t1, afterQuit: fs.readdirSync(D).includes("Local State") });
}
console.log(JSON.stringify(out, null, 1));
fs.rmSync(B, { recursive: true, force: true });
