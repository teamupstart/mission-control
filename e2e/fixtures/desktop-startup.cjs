// Exercise the production window against the spec's gated, isolated daemon origin.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const [origin, windowModule, profile] = process.argv.slice(2);
process.env.MISSION_PORT = new URL(origin).port;
delete process.env.MISSION_DEV_SERVER_URL;
app.setPath("userData", profile);
const { createWindow } = require(windowModule);

app.whenReady().then(() => {
  ipcMain.handle("mission:update-get-state", () => ({
    phase: "unmanaged", currentVersion: "1.25.0", reason: "isolated fixture",
    lastCheckedAt: null, lastOutcome: null,
  }));
  ipcMain.handle("mission:card-jump-keys", () => undefined);
  ipcMain.handle("mission:version", () => "1.25.0");
  createWindow(path.join(process.cwd(), "dist/preload/index.cjs"));
});
app.on("window-all-closed", () => app.quit());
// The fixture imports window.ts without index.ts, which normally owns before-quit.
app.on("before-quit", () => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
