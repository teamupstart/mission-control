// The macOS application menu. Electron's default menu has no Settings item, so we
// install a full template that keeps the standard roles (edit/window - the source of
// copy-paste, minimize, close) and adds the conventional App → Settings… entry bound to
// ⌘,. Choosing it just forwards to a handler; the actual editor lives in the renderer
// (see App / SettingsPage).
//
// The template itself is `./menu-template.ts`, which imports no electron runtime and is
// therefore unit-testable. This file is the install.

import { app, Menu } from "electron";
import { appMenuTemplate, type AppMenuHandlers } from "./menu-template.ts";

export type { AppMenuHandlers };

export function installAppMenu(handlers: AppMenuHandlers): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(app.name, handlers)));
}
