// The macOS application menu, as a template and nothing else.
//
// Split out from `menu.ts` so the one decision in here that a person can get wrong is
// testable in `test/` for milliseconds: which keys the menu claims from the renderer. A menu
// accelerator is registered with the OS, so it is handled BEFORE the web page sees the
// keystroke - a chord the dashboard binds and this template also claims is a chord the
// dashboard silently never receives, and the only symptom is a shortcut that works in a
// browser and not in the app people actually ship.
//
// Nothing here imports `electron` at runtime: `MenuItemConstructorOptions` and `WebContents`
// are types, so they erase. Keep it that way, or this stops being loadable outside the
// desktop process.

import type { MenuItemConstructorOptions, WebContents } from "electron";

export interface AppMenuHandlers {
  onOpenSettings: () => void;
  onCheckForUpdates: () => void;
}

/**
 * Chords the renderer owns, which this template must therefore not claim.
 *
 * `⌘0`, `⌘-` and `⌘=` are the last three of the Board card's twelve jump shortcuts (see
 * `src/web/lib/card-shortcuts.ts`), and each is also the default accelerator of a zoom role
 * in Electron's stock `viewMenu`. Both cannot have them, and the resolution is written down
 * here rather than left to be discovered: the jump keys are a dashboard feature an operator
 * switched on, and page zoom keeps its menu items - so it stays one click away - while
 * giving up its keyboard shortcuts.
 *
 * This is the DESKTOP half of a decision with two halves. A dashboard opened in an ordinary
 * browser tab has a browser's own chrome in front of it, which no page and no file in this
 * repository can rewrite the way this one rewrites a menu; what happens there, and why the
 * keys are the same on both surfaces anyway, is recorded in `src/web/lib/card-shortcuts.ts`.
 *
 * Exported so the test asserts the exclusion rather than restating it. `Plus` and
 * `Shift+Plus` are in the list because that is how Electron spells the zoom-in role's
 * accelerator, and `⌘+` is the same physical key as `⌘=`.
 */
export const RENDERER_OWNED_ACCELERATORS: readonly string[] = [
  "CommandOrControl+0",
  "CommandOrControl+-",
  "CommandOrControl+=",
  "CommandOrControl+Plus",
  "CommandOrControl+Shift+Plus",
];

/** Electron's own zoom step, so these items feel exactly as they did as roles. */
const ZOOM_STEP = 0.5;

/**
 * Zoom the window the menu was invoked over, or return it to 100%.
 *
 * A plain click handler rather than the `zoomIn`/`zoomOut`/`resetZoom` roles, and the reason
 * is mechanical: a role's accelerator cannot be cleared. Electron resolves it as
 * `options.accelerator || getDefaultAccelerator(role)`, so an empty string is falsy and the
 * stock `⌘0`/`⌘-`/`⌘+` come straight back, while `registerAccelerator: false` keeps the chord
 * PRINTED beside a label it no longer answers to. Doing the zoom here is the only shape that
 * leaves the item working, the menu honest, and the keys free.
 *
 * Takes `unknown` because the second click argument has been typed as both `BrowserWindow`
 * and `BaseWindow` across Electron releases and only one of those declares `webContents`.
 * The property is read structurally, which is true of every window that has one; a window
 * without web contents, or no window at all, is an ordinary no-op.
 */
function zoomWindow(window: unknown, step: number | "reset"): void {
  const contents = (window as { webContents?: WebContents } | undefined)?.webContents;
  if (!contents) return;
  contents.setZoomLevel(step === "reset" ? 0 : contents.getZoomLevel() + step);
}

export function appMenuTemplate(
  appName: string,
  handlers: AppMenuHandlers,
): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: "about" },
        { label: "Check for Updates…", click: () => handlers.onCheckForUpdates() },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => handlers.onOpenSettings(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      // Spelled out rather than `role: "viewMenu"`, and the zoom items are the whole reason.
      // The stock submenu is exactly this list with `⌘0`/`⌘-`/`⌘+` attached to the three zoom
      // roles; written out, the zooming still happens and the keys reach the Board's jump
      // shortcuts. Reload, DevTools and full screen keep their standard accelerators, none of
      // which the dashboard binds - `⌃R` is a dashboard chord and is not `⌘R`.
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { label: "Actual Size", click: (_item, window) => zoomWindow(window, "reset") },
        { label: "Zoom In", click: (_item, window) => zoomWindow(window, ZOOM_STEP) },
        { label: "Zoom Out", click: (_item, window) => zoomWindow(window, -ZOOM_STEP) },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}
