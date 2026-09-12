// Mission Control - macOS desktop shell.
//
// Wraps the existing loopback daemon + React UI in a native app: packaged builds
// supervise the daemon (adopting one that's already running), while development
// leaves it to `dev:server`. The shell shows the dashboard in a window that
// hides-on-close and keeps a menu-bar presence so alerts fire with no window
// open. The daemon and UI are reused unchanged.

import { app, dialog, ipcMain, session, shell } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stateDir } from "@shared/harness-runtime.mjs";
import { startDaemon, waitForHealthy } from "./daemon.ts";
import type { DaemonController } from "./daemon.ts";
import {
  ownElectronBackgroundStart,
  type BackgroundStartOwnership,
} from "./daemon-policy.ts";
import { startForeman, type ForemanController } from "./foreman.ts";
import { createWindow, getMainWindow, onMainWindowClosed, showWindow } from "./window.ts";
import { installAppMenu, setRendererOwnsNumberRow } from "./menu.ts";
import { createTray, destroyTray } from "./tray.ts";
import { installIntegrations, removeIntegrations } from "./integrations.ts";
import { armProductIssueAuthorization } from "./product-issue-authorization.ts";
import { isQuitting, setQuitting } from "./lifecycle.ts";
import {
  createDefaultUpdaterPort,
  requestUpdateQuit,
  UpdateController,
  type UpdateDialogs,
} from "./updater.ts";
import type { UpdateSnapshot } from "../shared/update.ts";
import { UPDATE_DIALOGS } from "../shared/update-dialog.ts";
import type { UpdateDialogChoice, UpdateDialogContent } from "../shared/update-dialog.ts";
import { UpdateDialogPresenter } from "./update-dialog.ts";
import { initializeExecutableEnvironment } from "../server/executables/locator.ts";

app.setName("Mission Control");

// One app instance only; a second launch just reveals the running window (see the
// "second-instance" handler). Quitting before `ready` fires means whenReady()
// below never runs in the losing instance, so no second daemon is started.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const appRoot = app.getAppPath();
const paths = {
  serverEntry: join(appRoot, "dist", "server", "index.mjs"),
  foremanEntry: join(appRoot, "dist", "server", "foreman-worker.mjs"),
  webDir: join(appRoot, "dist", "web"),
  preload: join(appRoot, "dist", "preload", "index.cjs"),
  trayIcon: join(appRoot, "build", "trayTemplate.png"),
};

let backgroundStart: BackgroundStartOwnership<DaemonController, ForemanController> | null = null;
let updater: UpdateController | null = null;
let stopUpdateSubscription: (() => void) | null = null;

function showIntegrationResult(title: string, message: string): void {
  const win = getMainWindow();
  const opts = { type: "info" as const, title, message };
  if (win) void dialog.showMessageBox(win, opts);
  else void dialog.showMessageBox(opts);
}

/**
 * Every update question, drawn by the dashboard.
 *
 * These were seven `dialog.showMessageBox` calls, which is the one surface in the product
 * that did not look like the product: a grey platform sheet with system buttons, shown for
 * the one job - the app updating itself - where an operator most needs to recognise who is
 * asking. The words and the answers now live in `shared/update-dialog.ts` and the drawing
 * in `web/components/UpdateDialog.tsx`. No platform sheet is left in this path: a second,
 * unthemed auto-update surface is the thing being removed, not a fallback worth keeping.
 */
const updateDialogPresenter = new UpdateDialogPresenter({
  canPresent: () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !win.isVisible()) return false;
    return !win.webContents.isLoading();
  },
  reveal: () => showWindow(paths.preload),
  send: (request) => {
    const wc = getMainWindow()?.webContents;
    if (!wc || wc.isDestroyed() || wc.isLoading()) return false;
    wc.send("mission:update-dialog", request);
    return true;
  },
  newId: () => randomUUID(),
  delay: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});

/** Ask, and translate the modal's two words back into the updater's own vocabulary. */
function askUpdate(content: UpdateDialogContent): Promise<UpdateDialogChoice> {
  return updateDialogPresenter.present(content);
}

const updateDialogs: UpdateDialogs = {
  async available(release) {
    if ((await askUpdate(UPDATE_DIALOGS.available(release))) !== "confirm") return "defer";
    // Unchanged from the flow this replaced. The build is about to start, and its progress
    // is drawn in the dashboard. Someone who accepted from the menu bar with the window
    // hidden would otherwise get no sign at all - which is the complaint that path exists
    // to answer.
    showWindow(paths.preload);
    return "apply";
  },
  async upToDate(version) {
    await askUpdate(UPDATE_DIALOGS.upToDate(version));
  },
  async preparing(version, stage) {
    // Unchanged from the flow this replaced: this phase revealed the window before it said
    // anything, because the progress it is reporting on is drawn there.
    showWindow(paths.preload);
    await askUpdate(UPDATE_DIALOGS.preparing(version, stage));
  },
  async ready(version) {
    return (await askUpdate(UPDATE_DIALOGS.ready(version))) === "confirm" ? "install" : "defer";
  },
  async applying(version) {
    await askUpdate(UPDATE_DIALOGS.applying(version));
  },
  async error(message) {
    await askUpdate(UPDATE_DIALOGS.error(message));
  },
  async outcome(outcome) {
    await askUpdate(UPDATE_DIALOGS.outcome(outcome));
  },
};

// A destroyed renderer cannot answer, and `checkForUpdates()` is awaiting one. Settle
// anything outstanding as the dismissal it would have got from "Later", rather than leaving
// the update wedged on an answer that can never arrive. Skipped during a quit, where the
// process is going away and nothing is waiting on the result.
onMainWindowClosed(() => {
  if (!isQuitting()) updateDialogPresenter.detach();
});

// Reveal the dashboard and tell the renderer to open the Settings panel. Backs
// both the native "Settings…" menu item (⌘,) and any future app-level trigger.
function openSettings(): void {
  showWindow(paths.preload);
  const wc = getMainWindow()?.webContents;
  if (!wc) return;
  if (wc.isLoading()) wc.once("did-finish-load", () => wc.send("mission:open-settings"));
  else wc.send("mission:open-settings");
}

function pushUpdateSnapshot(snapshot: UpdateSnapshot): void {
  const wc = getMainWindow()?.webContents;
  if (!wc) return;
  if (wc.isLoading()) wc.once("did-finish-load", () => wc.send("mission:update-state", snapshot));
  else wc.send("mission:update-state", snapshot);
}

function registerIpc(updateController: UpdateController): void {
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
  ipcMain.on("mission:product-issue-report-click", (event, input: unknown) => {
    event.returnValue = false;
    const mainContents = getMainWindow()?.webContents;
    if (!mainContents || event.sender !== mainContents) return;
    event.returnValue = armProductIssueAuthorization(input);
  });
  ipcMain.handle("mission:update-get-state", () => updateController.getSnapshot());
  ipcMain.handle("mission:update-check", () => updateController.check(true));
  ipcMain.handle("mission:update-apply", () => updateController.apply());
  ipcMain.handle("mission:update-install", () => updateController.install());
  ipcMain.handle("mission:update-cancel", () => updateController.cancel());
  ipcMain.handle("mission:update-defer", () => updateController.defer());
  // The dialog channels are `on`, not `handle`: main is the one asking, so the renderer
  // pushes an announcement and an answer rather than invoking for a result. Both are
  // refused from any sender but the dashboard's own contents, the way the product-issue
  // authorization above is.
  ipcMain.on("mission:update-dialog-ready", (event) => {
    if (event.sender !== getMainWindow()?.webContents) return;
    updateDialogPresenter.attach();
  });
  ipcMain.on("mission:update-dialog-choice", (event, payload: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return;
    const answer = payload as { id?: unknown; choice?: unknown } | null;
    updateDialogPresenter.answer(answer?.id, answer?.choice);
  });
  // Which of ⌘0/⌘-/⌘= the View menu may keep. The dashboard reports whether it is claiming
  // the number row for the fleet's session jumps; the menu holds those accelerators whenever it is
  // not, so switching the preference off gives the keys back to zoom instead of leaving
  // three keys that nothing answers to. See `menu-template.ts`.
  ipcMain.handle("mission:card-jump-keys", (_e, claimed: boolean) => {
    setRendererOwnsNumberRow(claimed === true);
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
  stopUpdateSubscription?.();
  stopUpdateSubscription = null;
  updater?.stop();
  destroyTray();
  backgroundStart?.stop();
});

app.whenReady().then(async () => {
  // Finder, Dock, and LaunchAgent environments are routinely minimal. Build the same
  // bounded executable snapshot the daemon owns before the shell starts any child process.
  await initializeExecutableEnvironment();
  // Auto-grant the Notification permission for the daemon/Vite origin so the
  // dashboard's "Enable desktop alerts" resolves to `granted` (OS-level delivery
  // is still governed by System Settings → Notifications → Mission Control).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "notifications");
  });

  backgroundStart = ownElectronBackgroundStart(
    process.env.MISSION_DEV_SERVER_URL,
    () =>
      startDaemon({
        serverEntry: paths.serverEntry,
        webDir: paths.webDir,
        // Logs live beside the daemon's own state (honors MISSION_HOME), matching where
        // it keeps its db + token.
        logPath: join(stateDir(), "daemon.log"),
      }),
    async () =>
      startForeman({
        workerEntry: paths.foremanEntry,
        cwd: appRoot,
        logPath: join(stateDir(), "foreman.log"),
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
  registerIpc(updater);
  stopUpdateSubscription = updater.subscribe(pushUpdateSnapshot);
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
  const background = await backgroundStart.ready;
  if (background) await waitForHealthy(15000);
});
