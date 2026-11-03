import { BrowserWindow } from "electron";
import { startupNoticePage } from "./startup-notice.ts";

/**
 * Show a startup notice in a small window that closes itself after `holdMs`.
 *
 * Used only when a notification cannot carry the notice. A window - unlike a parentless macOS
 * message box - can be closed by this process, which is what keeps the launch from holding the
 * bundle the update helper is waiting on. Resolves when the window has closed, whichever of the
 * person or the timer closed it.
 */
export function showStartupNoticeWindow(notice: string, holdMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const win = new BrowserWindow({
      width: 440, height: 120, show: false, center: true, resizable: false, minimizable: false,
      maximizable: false, fullscreenable: false, alwaysOnTop: true, title: "Mission Control",
      webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false},
    });
    const timer = setTimeout(() => { if (!win.isDestroyed()) win.close(); }, holdMs);
    win.once("closed", () => { clearTimeout(timer); resolve(); });
    win.once("ready-to-show", () => win.show());
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupNoticePage(notice))}`).catch(() => {
      if (!win.isDestroyed()) win.close();
    });
  });
}
