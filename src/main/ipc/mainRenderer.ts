import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";

// Only the main window's own top frame may use the application's IPC (no electron import: testable under node).
export function assertMainRenderer(
  event: IpcMainEvent | IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null
): void {
  const expected = getMainWindow();
  if (
    !expected
    || expected.isDestroyed()
    || event.sender !== expected.webContents
    || event.senderFrame !== expected.webContents.mainFrame
  ) {
    throw new Error("Browser IPC is available only to the trusted CanvasTTY renderer.");
  }
}
