const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { armProductIssueAuthorization } = require(process.argv[3]);

app.whenReady().then(async () => {
  ipcMain.handle("mission:card-jump-keys", () => undefined);
  ipcMain.handle("mission:update-get-state", () => null);
  ipcMain.on("mission:product-issue-report-click", (event, input) => {
    event.returnValue = event.sender === window.webContents && armProductIssueAuthorization(input);
  });
  const window = new BrowserWindow({
    width: 1000,
    height: 900,
    webPreferences: {
      preload: path.join(process.cwd(), "dist/preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL(process.argv[2]);
});
app.on("window-all-closed", () => app.quit());
