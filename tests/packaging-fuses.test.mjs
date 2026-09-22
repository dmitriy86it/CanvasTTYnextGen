import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import yaml from "js-yaml";

const builderPath = new URL("../electron-builder.yml", import.meta.url);

test("packaged builds flip the fuses that the helper contract does not need", async () => {
  const config = yaml.load(await readFile(builderPath, "utf8"));
  const fuses = config.electronFuses;

  assert.ok(fuses, "electron-builder.yml must configure electronFuses");
  // Agent helpers run through ELECTRON_RUN_AS_NODE (ADR-20260913-packaged-fuses-keep-run-as-node).
  assert.equal(fuses.runAsNode, true);
  assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(fuses.enableNodeCliInspectArguments, false);
  // Integrity validation is bypassable through the app/ fallback unless onlyLoadAppFromAsar is on.
  assert.equal(fuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(fuses.onlyLoadAppFromAsar, true);
  // One-way transition; see the ADR invariant on cookie encryption.
  assert.equal("enableCookieEncryption" in fuses, false);
  assert.notEqual(config.asar?.disableIntegrity, true);
});
