// The main window. It loads the daemon's own origin (http://127.0.0.1:7317) in
// production, or the Vite dev server when MISSION_DEV_SERVER_URL is set - never
// file://, so the SPA's same-origin relative URLs, the SSE stream, and the
// daemon's loopback-Host security check all keep working unchanged.
//
// Closing the window HIDES it (the app stays resident in the menu bar so alerts
// keep firing); only a real quit destroys it.

import { BrowserWindow, screen, shell } from "electron";
import { BASE_URL } from "@shared/harness-runtime.mjs";
import { isQuitting } from "./lifecycle.ts";

let win: BrowserWindow | null = null;

// The window has no native title bar, so the topbar doubles as one and gives up
// its left edge to the traffic lights. With that inset its controls stay on one
// row down to ~1280px; below that the session stats wrap to a second row, which
// costs more height than removing the title bar saved. Open with room to spare -
// but never wider than the display.
const PREFERRED = { width: 1400, height: 860 };

function initialSize(): { width: number; height: number } {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(PREFERRED.width, width),
    height: Math.min(PREFERRED.height, height),
  };
}

export const getMainWindow = (): BrowserWindow | null => win;

function targetUrl(): string {
  return process.env.MISSION_DEV_SERVER_URL || BASE_URL;
}

/** Origins the window is allowed to navigate to in-place; everything else opens externally. */
function allowedOrigins(): string[] {
  const origins = [new URL(BASE_URL).origin];
  const dev = process.env.MISSION_DEV_SERVER_URL;
  if (dev) origins.push(new URL(dev).origin);
  return origins;
}

function isInternal(url: string): boolean {
  try {
    return allowedOrigins().includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/** Load the target, retrying while the daemon/Vite server is still coming up. */
async function loadWithRetry(w: BrowserWindow, url: string, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await w.loadURL(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await w.loadURL(url).catch(() => {}); // last attempt; let any error render
}

export function createWindow(preloadPath: string): BrowserWindow {
  win = new BrowserWindow({
    ...initialSize(),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Mission Control",
    backgroundColor: "#0e1116",
    // The app's own dark topbar IS the title bar: no native strip, traffic
    // lights inset over the topbar's left padding (see .topbar in styles.css).
    // "hiddenInset" would park them at the standard y for a 38px bar, ~15px
    // above the centre of our taller topbar row; position them explicitly so
    // they line up with the brand instead.
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 20, y: 28 },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the renderer's SSE stream + alert timers running at full rate when
      // the window is hidden, so a hidden app still delivers notifications and
      // the away digest (the whole point of the desktop app).
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win?.show());
  void loadWithRetry(win, targetUrl());

  // External links (PR pages, docs, …) open in the system browser; in-app
  // navigation stays pinned to the daemon/Vite origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternal(url)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isInternal(url)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });

  win.on("close", (e) => {
    if (!isQuitting()) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });

  return win;
}

/** Reveal + focus the window, recreating it if it was destroyed. */
export function showWindow(preloadPath: string): void {
  if (!win) {
    createWindow(preloadPath);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
