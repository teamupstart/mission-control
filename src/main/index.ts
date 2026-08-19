// Mission Control - macOS desktop shell.
//
// Wraps the existing loopback daemon + React UI in a native app: packaged builds
// supervise the daemon (adopting one that's already running), while development
// leaves it to `dev:server`. The shell shows the dashboard in a window that
// hides-on-close and keeps a menu-bar presence so alerts fire with no window
// open. The daemon and UI are reused unchanged.

import { app, dialog, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import { stateDir } from "@shared/harness-runtime.mjs";
import { startDaemon, waitForHealthy } from "./daemon.ts";
import type { DaemonController } from "./daemon.ts";
import { startElectronOwnedDaemon } from "./daemon-policy.ts";
import { createWindow, getMainWindow, showWindow } from "./window.ts";
import { installAppMenu } from "./menu.ts";
import { createTray, destroyTray } from "./tray.ts";
import { installIntegrations, removeIntegrations } from "./integrations.ts";
import { setQuitting } from "./lifecycle.ts";
import {
  createDefaultUpdaterPort,
  requestUpdateQuit,
  UpdateController,
  type UpdateDialogs,
} from "./updater.ts";

app.setName("Mission Control");

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
let updater: UpdateController | null = null;

function showIntegrationResult(title: string, message: string): void {
  const win = getMainWindow();
  const opts = { type: "info" as const, title, message };
  if (win) void dialog.showMessageBox(win, opts);
  else void dialog.showMessageBox(opts);
}

async function showNativeMessage(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = getMainWindow();
  return win?.isVisible() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

const updateDialogs: UpdateDialogs = {
  async available(release) {
    const response = await showNativeMessage({
      type: "info",
      title: "Mission Control update",
      message: `Mission Control ${release.newVersion} is available`,
      detail: [release.name, release.notes].filter(Boolean).join("\n\n"),
      buttons: ["Update Now", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return response.response === 0 ? "apply" : "defer";
  },
  async upToDate(version) {
    await showNativeMessage({
      type: "info",
      title: "Mission Control update",
      message: `Mission Control ${version} is up to date`,
      buttons: ["OK"],
    });
  },
  async error(message) {
    await showNativeMessage({
      type: "error",
      title: "Mission Control update",
      message: "The update could not be completed",
      detail: message,
      buttons: ["OK"],
    });
  },
  async outcome(outcome) {
    const failed = outcome.result === "failure";
    await showNativeMessage({
      type: failed ? "error" : "info",
      title: "Mission Control update",
      message: failed
        ? `Mission Control ${outcome.targetVersion} could not be installed`
        : `Mission Control was updated to ${outcome.targetVersion}`,
      ...(failed ? { detail: outcome.message } : {}),
      buttons: ["OK"],
    });
  },
};

// Reveal the dashboard and tell the renderer to open the Settings panel. Backs
// both the native "Settings…" menu item (⌘,) and any future app-level trigger.
function openSettings(): void {
  showWindow(paths.preload);
  const wc = getMainWindow()?.webContents;
  if (!wc) return;
  if (wc.isLoading()) wc.once("did-finish-load", () => wc.send("mission:open-settings"));
  else wc.send("mission:open-settings");
}

function registerIpc(): void {
  ipcMain.handle("mission:version", () => app.getVersion());
  ipcMain.handle("mission:open-external", (_e, url: string) => shell.openExternal(url));
  ipcMain.handle("mission:install-integrations", () => {
    const r = installIntegrations();
    showIntegrationResult(r.ok ? "Integrations installed" : "Install failed", r.message);
    return r;
  });
  ipcMain.handle("mission:remove-integrations", () => {
    const r = removeIntegrations();
    showIntegrationResult("Integrations", r.message);
    return r;
  });
}

app.on("second-instance", () => showWindow(paths.preload));

app.on("activate", () => {
  showWindow(paths.preload);
  updater?.onActivate();
});

// The window hides on close and stays resident (menu bar), so we intentionally
// do NOT quit when all windows are gone - the tray keeps the app (and alerts)
// alive until the user explicitly quits.
app.on("window-all-closed", () => {
  /* keep running for the tray */
});

app.on("before-quit", () => {
  setQuitting(true);
  updater?.stop();
  destroyTray();
  daemon?.stop();
});

app.whenReady().then(async () => {
  registerIpc();

  // Auto-grant the Notification permission for the daemon/Vite origin so the
  // dashboard's "Enable desktop alerts" resolves to `granted` (OS-level delivery
  // is still governed by System Settings → Notifications → Mission Control).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "notifications");
  });

  const daemonStart = startElectronOwnedDaemon(process.env.MISSION_DEV_SERVER_URL, () =>
    startDaemon({
      serverEntry: paths.serverEntry,
      webDir: paths.webDir,
      // Log alongside the daemon's own state (honors MISSION_HOME), matching where
      // it keeps its db + token.
      logPath: join(stateDir(), "daemon.log"),
    }),
  );

  // Install the native update path before awaiting daemon health. A broken daemon must not
  // prevent the user from repairing the packaged app through an update.
  createWindow(paths.preload);
  updater = new UpdateController(
    createDefaultUpdaterPort({
      packaged: app.isPackaged,
      currentVersion: () => app.getVersion(),
      helperSource: join(appRoot, "scripts", "apply-update.mjs"),
      stateDirectory: stateDir(),
      requestQuit: () => requestUpdateQuit(() => setQuitting(true), () => app.quit()),
      dialogs: updateDialogs,
    }),
  );
  const updaterStart = updater.start();
  const onCheckForUpdates = () => void updater?.checkForUpdates();

  installAppMenu({ onOpenSettings: openSettings, onCheckForUpdates });
  createTray(paths.trayIcon, {
    onOpen: () => showWindow(paths.preload),
    onCheckForUpdates,
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
  void updaterStart;

  // The window retries while the daemon starts. In development, `dev:server` owns the daemon
  // and its hot-reload lifecycle, so this resolves to null.
  daemon = await daemonStart;
  if (daemon) await waitForHealthy(15000);
});
