// The production window and the production window-background handler, against the spec's
// isolated daemon. `index.ts` is not loaded (it would supervise a daemon of its own), so this
// registers exactly what `index.ts` registers for the skin bridge, through the same function.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const [origin, windowModule, backgroundModule, profile] = process.argv.slice(2);
process.env.MISSION_HOME = path.dirname(profile);
process.env.MISSION_PORT = new URL(origin).port;
delete process.env.MISSION_DEV_SERVER_URL;
app.setPath("userData", profile);
const { createWindow, getMainWindow, windowBackgroundFile } = require(windowModule);
const { registerWindowBackgroundIpc } = require(backgroundModule);

app.whenReady().then(() => {
  ipcMain.handle("mission:update-get-state", () => ({
    phase: "unmanaged", currentVersion: "1.25.0", reason: "isolated fixture",
    lastCheckedAt: null, lastOutcome: null,
  }));
  ipcMain.handle("mission:card-jump-keys", () => undefined);
  ipcMain.handle("mission:version", () => "1.25.0");
  registerWindowBackgroundIpc(ipcMain, getMainWindow);
  const window = createWindow(path.join(process.cwd(), "dist/preload/index.cjs"), null);
  // Read straight after construction, before any page has loaded: this is the first frame.
  globalThis.firstPaintBackground = window.getBackgroundColor();
  globalThis.windowBackgroundFile = windowBackgroundFile();
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
