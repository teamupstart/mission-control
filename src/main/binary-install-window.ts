import { BrowserWindow } from "electron";
import type { BinaryEnrollment } from "../shared/binary-enrollment.ts";
import { binaryInstallationPage, BINARY_INSTALL_CONFIRM_URL, BINARY_INSTALL_CANCEL_URL } from "./startup-page.ts";

/** Local, themed consent before a temporary copy may start any daemon or installer. */
export function confirmBinaryInstallation(enrollment: BinaryEnrollment): Promise<boolean> {
  if (enrollment.action !== "install") return Promise.resolve(false);
  const window = new BrowserWindow({
    width: 720, height: 600, minWidth: 540, minHeight: 480,
    show: false, title: "Mission Control", backgroundColor: "#0e1116",
    titleBarStyle: "hidden", trafficLightPosition: {x: 20, y: 28},
    webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false},
  });
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (accepted: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (!window.isDestroyed()) window.destroy();
      if (error) reject(error); else resolve(accepted);
    };
    window.once("closed", () => finish(false));
    window.webContents.once("render-process-gone", () => finish(false));
    window.webContents.setWindowOpenHandler(() => ({action: "deny"}));
    window.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      if (url === BINARY_INSTALL_CONFIRM_URL) finish(true);
      else if (url === BINARY_INSTALL_CANCEL_URL) finish(false);
    });
    window.webContents.on("before-input-event", (event, input) => {
      if (input.key === "Escape") { event.preventDefault(); finish(false); }
    });
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(binaryInstallationPage(enrollment))}`)
      .then(() => { if (!settled) window.show(); })
      .catch(error => finish(false, error));
  });
}
