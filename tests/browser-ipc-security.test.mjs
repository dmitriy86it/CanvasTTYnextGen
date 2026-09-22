import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ipcPath = new URL("../src/main/ipc/registerIpc.ts", import.meta.url);

test("privileged browser IPC validates the trusted main renderer", async () => {
  const source = await readFile(ipcPath, "utf8");

  assert.match(source, /function assertMainRenderer/);
  assert.match(source, /event\.sender !== expected\.webContents/);
  assert.match(source, /event\.senderFrame !== expected\.webContents\.mainFrame/);

  for (const channel of [
    "browserGetState",
    "browserOpen",
    "browserClose",
    "browserNewTab",
    "browserSelectTab",
    "browserCloseTab",
    "browserNavigate",
    "browserBack",
    "browserForward",
    "browserReload",
    "browserFocus",
    "browserSetViewport"
  ]) {
    const handler = source.slice(source.indexOf(`IPC.${channel}`), source.indexOf(`IPC.${channel}`) + 320);
    assert.match(handler, /assertMainRenderer\(event, getMainWindow\)/, `${channel} must validate its sender`);
  }
});

// Channels that are called by sandboxed pages rather than the main renderer. Each one
// authenticates its sender against the page it belongs to instead of the main window.
const NON_MAIN_RENDERER_CHANNELS = new Map([
  ["pluginsHostInvoke", "plugin windows; assertPluginWindowSender binds the sender URL to its entry"],
  ["browserPageWheelDecision", "browser tab preload; the gesture controller requires the active tab sender"],
  ["browserPageWheel", "browser tab preload; the gesture controller requires the active tab sender"]
]);

test("every IPC handler validates its sender", async () => {
  const source = await readFile(ipcPath, "utf8");
  const registrations = [...source.matchAll(/\b(ipcMain\.(?:handle|on)|handleMain|onMain)\(IPC\.(\w+)/g)];
  assert.ok(registrations.length > 60, "IPC registrations must be discoverable");

  for (const [index, match] of registrations.entries()) {
    const [, registrar, channel] = match;
    if (registrar === "handleMain" || registrar === "onMain") continue;
    if (NON_MAIN_RENDERER_CHANNELS.has(channel)) continue;
    const end = registrations[index + 1]?.index ?? source.indexOf("\n}\n", match.index);
    const body = source.slice(match.index, end);
    assert.match(body, /assertMainRenderer\(event, getMainWindow\)/, `${channel} must validate its sender`);
  }
});
