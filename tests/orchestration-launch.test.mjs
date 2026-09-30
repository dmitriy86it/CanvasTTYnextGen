import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ORCHESTRATION_PLATFORMS,
  resolveSupervisorLaunch
} from "../src/main/services/orchestration/supervisorLaunch.ts";

const base = {
  platform: "darwin",
  isPackaged: false,
  resourcesPath: "/Applications/CanvasTTY.app/Contents/Resources",
  appPath: "/work/canvastty",
  execPath: "/Applications/CanvasTTY.app/Contents/MacOS/CanvasTTY"
};

test("supported platforms are macOS and Linux only", () => {
  assert.deepEqual(ORCHESTRATION_PLATFORMS, ["darwin", "linux"]);
});

test("development build runs the source helper with the Electron binary in Node mode", () => {
  const seen = [];
  const r = resolveSupervisorLaunch({ ...base, exists: (p) => { seen.push(p); return true; } });
  assert.equal(r.ok, true);
  assert.equal(r.helperPath, "/work/canvastty/src/orchestration/supervisor.mjs");
  assert.deepEqual(r.launch, {
    command: base.execPath,
    args: ["/work/canvastty/src/orchestration/supervisor.mjs"],
    env: { ELECTRON_RUN_AS_NODE: "1" }
  });
  assert.deepEqual(seen, [r.helperPath]);
});

test("packaged build runs the helper from resourcesPath, outside the asar", () => {
  const r = resolveSupervisorLaunch({ ...base, platform: "linux", isPackaged: true, exists: () => true });
  assert.equal(r.ok, true);
  assert.equal(r.helperPath, "/Applications/CanvasTTY.app/Contents/Resources/orchestration/supervisor.mjs");
  assert.deepEqual(r.launch.args, [r.helperPath]);
  assert.deepEqual(Object.keys(r.launch.env), ["ELECTRON_RUN_AS_NODE"]);
});

test("Windows and other platforms are refused without touching the file system", () => {
  for (const platform of ["win32", "freebsd", "aix"]) {
    const r = resolveSupervisorLaunch({ ...base, platform, exists: () => assert.fail("file system probed") });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unsupported_platform");
    assert.match(r.detail, new RegExp(platform));
  }
});

test("a missing helper is reported, not launched", () => {
  const r = resolveSupervisorLaunch({ ...base, isPackaged: true, exists: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "helper_missing");
  assert.match(r.detail, /orchestration\/supervisor\.mjs/);
});

test("the default existence check finds the helper in this checkout", () => {
  const appPath = fileURLToPath(new URL("..", import.meta.url));
  const r = resolveSupervisorLaunch({ ...base, appPath });
  assert.equal(r.ok, true);
  assert.equal(existsSync(r.helperPath), true);
});
