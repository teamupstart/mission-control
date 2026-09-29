// Exercise the production window against the spec's gated, isolated daemon origin.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const [origin, windowModule, profile, scenario] = process.argv.slice(2);
process.env.MISSION_PORT = new URL(origin).port;
delete process.env.MISSION_DEV_SERVER_URL;
app.setPath("userData", profile);
const { createWindow, stopWindowStartup } = require(windowModule);

// Inject only the failed or unsettled Electron operation, leaving recovery to window.ts.
const loadURL = BrowserWindow.prototype.loadURL;
let firstLocalPage = true;
globalThis.startupPageFailures = 0;
globalThis.startupPageStopped = false;
BrowserWindow.prototype.loadURL = function (url, ...args) {
  if (firstLocalPage && url.startsWith("data:text/html")) {
    firstLocalPage = false;
    if (scenario === "local page failure") {
      globalThis.startupPageFailures++;
      return Promise.reject(new Error("fixture: first local page failed"));
    }
    if (scenario === "local page cancellation") {
      return new Promise((_resolve, reject) => {
        const stop = this.webContents.stop.bind(this.webContents);
        this.webContents.stop = () => {
          this.webContents.stop = stop;
          globalThis.startupPageStopped = true;
          stop();
          reject(new Error("fixture: pending local page stopped"));
        };
        // Render the page but hold its completion until the native cancellation fires.
        loadURL.call(this, url, ...args).catch(reject);
      });
    }
  }
  return loadURL.call(this, url, ...args);
};
app.on("fixture:stop-startup", stopWindowStartup);

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
