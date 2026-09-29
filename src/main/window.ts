// The main window. It loads the daemon's own origin (http://127.0.0.1:7317) in
// production, or the Vite dev server when MISSION_DEV_SERVER_URL is set - never
// file://, so the SPA's same-origin relative URLs, the SSE stream, and the
// daemon's loopback-Host security check all keep working unchanged.
//
// Closing the window HIDES it (the app stays resident in the menu bar so alerts
// keep firing); only a real quit destroys it.

import { BrowserWindow, screen, shell, type Event as ElectronEvent } from "electron";
import { setTimeout as delay } from "node:timers/promises";
import { BASE_URL } from "@shared/harness-runtime.mjs";
import { isQuitting } from "./lifecycle.ts";
import { daemonHealthy } from "./daemon.ts";
import { WindowStartup, WINDOW_STARTUP_TIMEOUT_MS } from "./window-startup.ts";
import { startupPage, STARTUP_RETRY_URL } from "./startup-page.ts";

let win: BrowserWindow | null = null;
let startup: WindowStartup | null = null;
const loadedListeners = new Set<() => void>();

export function onMainWindowLoaded(listener: () => void): void {
  loadedListeners.add(listener);
}

export function stopWindowStartup(): void {
  startup?.stop();
}

/**
 * Told when the window - and with it the renderer - is destroyed.
 *
 * One subscriber today: the update dialog presenter, which is holding promises the updater
 * awaits. A renderer that goes away while a question is on screen would otherwise leave
 * `checkForUpdates()` waiting for an answer that can never arrive, which wedges the update
 * for the life of the process. Listeners are permanent, because so are their owners.
 */
const closedListeners = new Set<() => void>();

export function onMainWindowClosed(listener: () => void): void {
  closedListeners.add(listener);
}

// The window has no native title bar, so the topbar doubles as one and gives up
// its left edge to the traffic lights. Open at a comfortable desktop size; the
// topbar's container-query ladder handles narrower half-screen windows without
// making this preferred width a responsive breakpoint. Never exceed the display.
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

async function dashboardReady(url: string, signal: AbortSignal): Promise<boolean> {
  if (!process.env.MISSION_DEV_SERVER_URL) return daemonHealthy(800, signal);
  // Vite owns the development origin and has no daemon health route of its own.
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.any([signal, AbortSignal.timeout(800)]) });
    return response.ok;
  } catch {
    return false;
  }
}

export function createWindow(preloadPath: string): BrowserWindow {
  if (win) return win;
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

  const window = win;
  const url = targetUrl();
  // Both local status pages and the dashboard must release navigation on Retry or quit.
  const navigate = async (target: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    let responseStatus = -1;
    const didNavigate = (_event: ElectronEvent, _url: string, status: number) => { responseStatus = status; };
    const stop = () => { if (!window.isDestroyed()) window.webContents.stop(); };
    const timer = setTimeout(stop, WINDOW_STARTUP_TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });
    window.webContents.on("did-navigate", didNavigate);
    try {
      await window.loadURL(target);
      // Electron resolves loadURL for a fully rendered HTTP error page as well.
      if (responseStatus >= 400) throw new Error(`Dashboard navigation returned HTTP ${responseStatus}`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      window.webContents.removeListener("did-navigate", didNavigate);
    }
  };
  const loading = new WindowStartup({
    now: () => Date.now(),
    show: (state, signal) => navigate(`data:text/html;charset=utf-8,${encodeURIComponent(startupPage(state))}`, signal),
    ready: (signal) => dashboardReady(url, signal),
    load: (signal) => navigate(url, signal),
    pause: (signal) => delay(1000, undefined, { signal }),
    loaded: () => { for (const listener of loadedListeners) listener(); },
    log: (error) => console.error("[mission-control] dashboard startup navigation failed:", error),
  });
  startup = loading;
  window.once("ready-to-show", () => { if (!window.isDestroyed()) window.show(); });

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
    if (url === STARTUP_RETRY_URL) {
      e.preventDefault();
      void loading.start();
      return;
    }
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
    loading.stop();
    startup = null;
    win = null;
    for (const listener of closedListeners) listener();
  });

  void loading.start();
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
