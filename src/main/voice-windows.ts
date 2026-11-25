import { BrowserWindow, screen, type BrowserWindowConstructorOptions, type Rectangle } from "electron";
import { setVoiceConfirmationFocus } from "./menu.ts";

export type VoiceSurface = "pill" | "popover";

const surfaceWidth = { pill: 480, popover: 356 };

export function voiceWindowOptions(surface: VoiceSurface, preload: string): BrowserWindowConstructorOptions {
  return {
    width: surfaceWidth[surface], height: 1, show: false,
    transparent: true, frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    hasShadow: false, acceptFirstMouse: true,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  };
}

/** The renderer measures live content. Only this window's main frame may change its geometry. */
export function attachVoiceWindow(win: BrowserWindow, surface: VoiceSurface, trayBounds: () => Rectangle | undefined, targetUrl: string) {
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => { if (url !== targetUrl) event.preventDefault(); });
  const contents = win.webContents;
  const focusConfirmation = () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    win.show();
    contents.send("voice:focus-control");
  };
  win.on("hide", () => setVoiceConfirmationFocus(focusConfirmation, false));
  win.once("closed", () => setVoiceConfirmationFocus(focusConfirmation, false));
  win.setIgnoreMouseEvents(true, { forward: true });
  contents.ipc.on("voice:pointer", (event, inside) => {
    if (event.senderFrame === contents.mainFrame && typeof inside === "boolean") win.setIgnoreMouseEvents(!inside, { forward: true });
  });
  contents.ipc.on("voice:layout", (event, height, history) => {
    if (event.senderFrame !== contents.mainFrame || !Number.isFinite(height)) return;
    if (height <= 0) { win.hide(); return; }
    const tray = surface === "popover" ? trayBounds() : undefined;
    const display = tray ? screen.getDisplayMatching(tray) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    // Screen and BrowserWindow use display-independent pixels. The DOM measures
    // content, positions the tray pointer and hit-tests in zoomed CSS pixels.
    const zoom = contents.getZoomFactor();
    const width = Math.min(Math.ceil(surfaceWidth[surface] * zoom), area.width);
    const anchor = tray ? tray.x + tray.width / 2 : area.x + area.width / 2;
    const idealX = Math.round(anchor - (tray ? width - 48 * zoom : width / 2));
    const x = Math.max(area.x, Math.min(idealX, area.x + area.width - width));
    if (tray) contents.send("voice:anchor", (width - (anchor - x)) / zoom);
    const y = Math.max(area.y, tray ? tray.y + tray.height : area.y);
    win.setBounds({ x, y,
      width, height: Math.min(Math.ceil(height * zoom), Math.max(1, area.y + area.height - y)) });
    const cursor = screen.getCursorScreenPoint();
    contents.send("voice:hit-test", (cursor.x - x) / zoom, (cursor.y - y) / zoom);
    if (history === true && surface === "popover") win.show();
    else if (!win.isVisible()) win.showInactive();
    setVoiceConfirmationFocus(focusConfirmation, history !== true);
  });
}
