const { app, BrowserWindow, ipcMain, utilityProcess } = require("electron");
const path = require("node:path");
const { armSessionControlAuthorization, serveSessionControlAuthorization } = require(process.argv[2]);

app.whenReady().then(() => {
  ipcMain.handle("mission:card-jump-keys", () => undefined);
  ipcMain.handle("mission:update-get-state", () => null);
  const window = new BrowserWindow({
    width: 1280, height: 900,
    webPreferences: { preload: path.join(process.cwd(), "dist/preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  ipcMain.on("mission:session-control-click", (event, input) => {
    event.returnValue = event.sender === window.webContents && armSessionControlAuthorization(input);
  });
  let child;
  globalThis.startControlDaemon = async ({ entry, env }) => {
    child = utilityProcess.fork(entry, [], { env, stdio: "pipe" });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    serveSessionControlAuthorization(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    return child.pid;
  };
  globalThis.stopControlDaemon = async () => {
    if (!child) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    child = null;
  };
  app.on("before-quit", () => child?.kill());
  window.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
