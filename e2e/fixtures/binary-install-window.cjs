// Exercise the real local consent window without starting a daemon or installer.
const {app, BrowserWindow, dialog} = require("electron");
const [windowModule, profile] = process.argv.slice(2);
app.setPath("userData", profile);
dialog.showMessageBox = () => { throw new Error("Installation consent must not use a platform sheet"); };
globalThis.installationChoice = null;
app.whenReady().then(async () => {
  const {confirmBinaryInstallation} = require(windowModule);
  globalThis.installationChoice = await confirmBinaryInstallation({
    action: "install",
    destination: "/Users/operator/Applications/Mission Control.app",
    message: "This temporary copy cannot be enrolled or updated here. Install the verified app at a persistent destination before using it.",
  });
});
app.on("window-all-closed", () => {});
app.on("before-quit", () => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
