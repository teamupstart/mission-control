// The macOS application menu. Electron's default menu has no Settings item, so we
// install a full template that keeps the standard roles (edit/window - the source of
// copy-paste, minimize, close) and adds the conventional App → Settings… entry bound to
// ⌘,. Choosing it just forwards to a handler; the actual editor lives in the renderer
// (see App / SettingsPage).
//
// The template itself is `./menu-template.ts`, which imports no electron runtime and is
// therefore unit-testable. This file is the install, and it is RE-installable: the View
// menu's three zoom accelerators are held or given up depending on whether the dashboard is
// currently claiming the number row for the fleet's session jumps, so the menu is rebuilt whenever
// that answer changes.

import { app, Menu } from "electron";
import { appMenuTemplate, type AppMenuHandlers, type AppMenuState } from "./menu-template.ts";

export type { AppMenuHandlers };

/**
 * The handlers and the last known renderer claim, so a rebuild driven by one does not have
 * to be handed the other. Held here rather than in `index.ts` because this module is the
 * only thing that installs a menu, and two callers each holding half of the state is how the
 * menu comes to disagree with itself.
 */
let installed: AppMenuHandlers | null = null;
let state: AppMenuState = { rendererOwnsNumberRow: false };

function build(): void {
  if (!installed) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(app.name, installed, state)));
}

export function installAppMenu(handlers: AppMenuHandlers): void {
  installed = handlers;
  build();
}

/**
 * Follow the dashboard's claim on ⌘0/⌘-/⌘=.
 *
 * Idempotent, and deliberately so: the renderer reports its preference on load, on every
 * change, and on every reload, so the overwhelmingly common call is one that changes nothing.
 * Rebuilding the whole application menu on each of those would replace the menu bar for no
 * reason, so an unchanged answer returns immediately.
 */
export function setRendererOwnsNumberRow(owns: boolean): void {
  if (state.rendererOwnsNumberRow === owns) return;
  state = { rendererOwnsNumberRow: owns };
  build();
}
