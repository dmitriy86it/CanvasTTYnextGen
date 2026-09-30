// Raoden Loom, formerly CanvasTTY (docs/agent-orchestration/implementation/rename-raoden-loom.md §3, §5): only what a
// person reads is renamed; the technical identity that locates the user's data stays "canvastty".
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const builder = read("electron-builder.yml");

test("technical identity is kept: package name, appId, no package productName, desktopName until Linux is checked", () => {
  assert.equal(pkg.name, "canvastty", "app.getName(), the default userData and the Keychain item follow it");
  assert.equal(pkg.productName, undefined, "Electron would take it as app.getName()");
  assert.equal(pkg.desktopName, "CanvasTTY", "blocked until checked on Linux (§3 row 8)");
  assert.match(builder, /^appId: io\.github\.howdeploy\.canvastty$/m);
  const main = read("src/main/index.ts");
  assert.doesNotMatch(main, /app\.setName\(/, "no app.setName: it would move userData and the Keychain item");
  assert.match(read("src/main/services/BrowserService.ts"), /BROWSER_PARTITION = "persist:canvastty-browser"/, "the browser partition keeps its name");
  assert.match(read("src/agent-browser/tool-catalog.mjs"), /canvastty_browser/, "the MCP name CLI permissions refer to");
});

test("the product is named Raoden Loom where a person reads it; files without a space", () => {
  assert.match(builder, /^productName: Raoden Loom$/m);
  for (const line of builder.split("\n").filter((l) => /artifactName:/.test(l))) {
    assert.match(line, /artifactName: Raoden-Loom-\$\{version\}-/, line);
  }
  assert.match(read("src/renderer/index.html"), /<title>Raoden Loom<\/title>/);
  assert.match(read("src/main/startupPage.ts"), /<title>Raoden Loom<\/title>/);
  assert.match(read("src/main/index.ts"), /const name = "Raoden Loom";/, "the macOS menu and About panel");
});

test("the display strings carry no old name and no bare Loom", () => {
  const files = ["src/renderer/src/lib/i18n.ts", "src/renderer/src/components/TitleBar.tsx", "src/renderer/src/features/settings/AboutSettings.tsx",
    "src/main/startupPage.ts", "src/renderer/index.html"];
  for (const f of files) {
    const text = read(f);
    assert.doesNotMatch(text, /(?<![\w$])CanvasTTY(?![\w-])/, `${f}: the old product name`);
    for (const m of text.matchAll(/\bLoom\b/g)) assert.equal(text.slice(m.index - 7, m.index), "Raoden ", `${f}: a bare "Loom"`);
  }
});
