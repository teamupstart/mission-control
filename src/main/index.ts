// Agent Wrangler - macOS desktop shell.
//
// Wraps the existing loopback daemon + React UI in a native app: it supervises
// the daemon (adopting one that's already running), shows the dashboard in a
// window that hides-on-close, and keeps a menu-bar presence so alerts fire with
// no window open. The daemon and UI are reused unchanged; this process only adds
// the native shell.

import { app, dialog, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import { stateDir } from "@shared/harness-runtime.mjs";
import { startDaemon, waitForHealthy } from "./daemon.ts";
import type { DaemonController } from "./daemon.ts";
import { createWindow, getMainWindow, showWindow } from "./window.ts";
import { createTray, destroyTray } from "./tray.ts";
import { installIntegrations, removeIntegrations } from "./integrations.ts";
import { isQuitting, setQuitting } from "./lifecycle.ts";

app.setName("Agent Wrangler");

// One app instance only; a second launch just reveals the running window (see the
// "second-instance" handler). Quitting before `ready` fires means whenReady()
// below never runs in the losing instance, so no second daemon is started.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const appRoot = app.getAppPath();
const paths = {
  serverEntry: join(appRoot, "dist", "server", "index.mjs"),
  webDir: join(appRoot, "dist", "web"),
  preload: join(appRoot, "dist", "preload", "index.cjs"),
  trayIcon: join(appRoot, "build", "trayTemplate.png"),
};

let daemon: DaemonController | null = null;

function showIntegrationResult(title: string, message: string): void {
  const win = getMainWindow();
  const opts = { type: "info" as const, title, message };
  if (win) void dialog.showMessageBox(win, opts);
  else void dialog.showMessageBox(opts);
}

function registerIpc(): void {
  ipcMain.handle("fleet:version", () => app.getVersion());
  ipcMain.handle("fleet:open-external", (_e, url: string) => shell.openExternal(url));
  ipcMain.handle("fleet:install-integrations", () => {
    const r = installIntegrations();
    showIntegrationResult(r.ok ? "Integrations installed" : "Install failed", r.message);
    return r;
  });
  ipcMain.handle("fleet:remove-integrations", () => {
    const r = removeIntegrations();
    showIntegrationResult("Integrations", r.message);
    return r;
  });
}

app.on("second-instance", () => showWindow(paths.preload));

app.on("activate", () => showWindow(paths.preload));

// The window hides on close and stays resident (menu bar), so we intentionally
// do NOT quit when all windows are gone - the tray keeps the app (and alerts)
// alive until the user explicitly quits.
app.on("window-all-closed", () => {
  /* keep running for the tray */
});

app.on("before-quit", () => {
  setQuitting(true);
  destroyTray();
  daemon?.stop();
});

app.whenReady().then(async () => {
  registerIpc();

  // Auto-grant the Notification permission for the daemon/Vite origin so the
  // dashboard's "Enable desktop alerts" resolves to `granted` (OS-level delivery
  // is still governed by System Settings → Notifications → Agent Wrangler).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "notifications");
  });

  daemon = await startDaemon({
    serverEntry: paths.serverEntry,
    webDir: paths.webDir,
    // Log alongside the daemon's own state (honors FLEET_HOME), matching where
    // it keeps its db + token.
    logPath: join(stateDir(), "daemon.log"),
  });

  // Give the daemon a moment to bind before the window loads its origin (the
  // window also retries, so this is just to avoid a visible "connecting" flash).
  if (!process.env.FLEET_DEV_SERVER_URL) await waitForHealthy(15000);

  createWindow(paths.preload);
  createTray(paths.trayIcon, {
    onOpen: () => showWindow(paths.preload),
    onInstallIntegrations: () => {
      const r = installIntegrations();
      showIntegrationResult(r.ok ? "Integrations installed" : "Install failed", r.message);
    },
    onRemoveIntegrations: () => {
      const r = removeIntegrations();
      showIntegrationResult("Integrations", r.message);
    },
    onQuit: () => {
      setQuitting(true);
      app.quit();
    },
  });
});
