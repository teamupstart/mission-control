const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const dashboardUrl = process.argv[2];
if (!dashboardUrl) throw new Error("the desktop update fixture needs a dashboard URL");

const alphaMode = process.argv[3] === "alpha";
let snapshot = alphaMode ? {
  phase: "idle", currentVersion: "1.9.0", lastCheckedAt: null, lastOutcome: null, alpha: false,
} : {
  phase: "preparing",
  currentVersion: "1.9.0",
  newVersion: "1.9.1",
  releaseTag: "v1.9.1",
  stage: "build",
  cancelling: false,
  lastOutcome: null,
};

app.whenReady().then(async () => {
  ipcMain.handle("mission:update-get-state", () => snapshot);
  ipcMain.handle("mission:update-check", () => snapshot);
  ipcMain.handle("mission:update-apply", () => true);
  ipcMain.handle("mission:update-install", () => false);
  ipcMain.handle("mission:update-cancel", () => undefined);
  ipcMain.handle("mission:update-defer", () => undefined);
  ipcMain.handle("mission:card-jump-keys", () => undefined);
  ipcMain.handle("mission:version", () => "1.9.0");

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      preload: path.join(process.cwd(), "dist/preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  ipcMain.handle("mission:update-set-alpha", (event, alpha) => {
    if (event.sender !== window.webContents || typeof alpha !== "boolean") throw new Error("Invalid alpha change");
    snapshot = { ...snapshot, alpha };
    window.webContents.send("mission:update-state", snapshot);
    return snapshot;
  });
  await window.loadURL(dashboardUrl);
});

app.on("window-all-closed", () => app.quit());
