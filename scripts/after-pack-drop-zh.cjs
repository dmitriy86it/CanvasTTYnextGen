// electron-builder afterPack: the product has no Chinese interface (ru, en), so Electron's own Chinese locale resources
// are left out of the package; every other language stays. `electronLanguages` is not used: it would also drop the
// grammatical-gender variants (de_FEMININE.lproj, …) of the languages kept.
const fs = require("node:fs");
const path = require("node:path");

const CHINESE = /^zh(?:[-_].*)?\.(?:lproj|pak)$/i;

exports.default = async function dropChineseLocales(context) {
  const dirs = [];
  if (context.electronPlatformName === "darwin") {
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    dirs.push(path.join(app, "Contents", "Resources"), path.join(app, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources"));
  } else {
    dirs.push(path.join(context.appOutDir, "locales"));
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (CHINESE.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
};

exports.CHINESE = CHINESE;
