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
 * Chords this template gives up WHILE the renderer is claiming them, and takes back when it
 * is not.
 *
 * `⌘0`, `⌘-` and `⌘=` are the last three of the Board card's twelve jump shortcuts (see
 * `src/web/lib/card-shortcuts.ts`), and each is also the default accelerator of a zoom role
 * in Electron's stock `viewMenu`. Both cannot have them at once, because a menu accelerator
 * is registered with the system and is handled before the renderer sees the keystroke.
 *
 * CONDITIONAL, and that is the whole point of `rendererOwnsNumberRow` below. Giving them up
 * unconditionally was a bug: an operator who unchecked Jump shortcut got keys that did
 * nothing at all, because the renderer had stopped handling them and the menu no longer
 * owned them either - so the preference could switch the feature off but could not give the
 * keys back, which is exactly what its own description promises. The menu is the fallback
 * holder: whenever the dashboard is not claiming the number row, zoom answers to these keys
 * as it always did.
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

export interface AppMenuState {
  /**
   * Whether the dashboard is currently claiming ⌘0/⌘-/⌘= for Board card jumps.
   *
   * Follows the PREFERENCE (and the layout that can use it), not the live card count, and
   * that is deliberate. The set of slots a board is filling changes every time a session
   * appears or leaves, and a zoom shortcut that worked until a tenth agent showed up and
   * then silently stopped would be worse than one that is plainly the board's for as long
   * as the feature is on. So it moves when a person moves it: unchecking Jump shortcut, or
   * leaving the Board layout, hands these keys straight back to zoom.
   *
   * The consequence to own is the other side of that: while the feature is on and the board
   * is holding fewer than ten cards, these three keys belong to a board that has no card to
   * give them to, and do nothing in the desktop app. That is a stated rule rather than an
   * accident - the number row is the board's while the board is using it - and `docs/ui.md`
   * says so where an operator reads it.
   */
  rendererOwnsNumberRow: boolean;
}

export function appMenuTemplate(
  appName: string,
  handlers: AppMenuHandlers,
  state: AppMenuState = { rendererOwnsNumberRow: false },
): MenuItemConstructorOptions[] {
  // Given up only while the renderer is claiming them. The roles carry Electron's own
  // accelerators, labels and behavior, so the fallback is the stock View menu rather than an
  // imitation of it - which is what makes "the keys come back" true rather than approximate.
  const zoom: MenuItemConstructorOptions[] = state.rendererOwnsNumberRow
    ? [
        { label: "Actual Size", click: (_item, window) => zoomWindow(window, "reset") },
        { label: "Zoom In", click: (_item, window) => zoomWindow(window, ZOOM_STEP) },
        { label: "Zoom Out", click: (_item, window) => zoomWindow(window, -ZOOM_STEP) },
      ]
    : [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }];
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
      // The stock submenu is exactly this list, so writing it out costs nothing and buys the
      // one thing the role cannot express: three zoom entries whose accelerators depend on
      // whether the dashboard is using those keys. Reload, DevTools and full screen keep
      // their standard accelerators in both states, none of which the dashboard binds -
      // `⌃R` is a dashboard chord and is not `⌘R`.
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        ...zoom,
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}
