// The product has no Chinese interface: saved zh settings open in Russian (settings-normalizer.test.mjs) and Electron's
// own zh* locale resources are removed from the package by the afterPack hook, every other language kept.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const hook = require("../scripts/after-pack-drop-zh.cjs");

test("the afterPack hook is configured and matches only Chinese locale resources", () => {
  assert.match(fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"), /^afterPack: scripts\/after-pack-drop-zh\.cjs$/m);
  for (const n of ["zh_CN.lproj", "zh_TW.lproj", "zh_CN_FEMININE.lproj", "zh-CN.pak", "zh-TW.pak", "ZH.lproj"]) assert.ok(hook.CHINESE.test(n), n);
  for (const n of ["ru.lproj", "en.lproj", "en_GB.lproj", "de_FEMININE.lproj", "zu.lproj", "ru.pak", "Info.plist", "zh_CN.strings"]) assert.ok(!hook.CHINESE.test(n), n);
});

test("on macOS it removes zh*.lproj from the app and the Electron framework and keeps the rest", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-"));
  const app = path.join(out, "Raoden Loom.app", "Contents");
  const dirs = [path.join(app, "Resources"), path.join(app, "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources")];
  for (const d of dirs) for (const n of ["zh_CN.lproj", "zh_TW_NEUTER.lproj", "ru.lproj", "de_FEMININE.lproj"]) fs.mkdirSync(path.join(d, n), { recursive: true });
  try {
    await hook.default({ electronPlatformName: "darwin", appOutDir: out, packager: { appInfo: { productFilename: "Raoden Loom" } } });
    for (const d of dirs) assert.deepEqual(fs.readdirSync(d).sort(), ["de_FEMININE.lproj", "ru.lproj"]);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
