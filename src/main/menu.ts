// The macOS application menu. Electron's default menu has no Settings item, so we
// install a full template that keeps the standard roles (edit/view/window - the
// source of copy-paste, reload, devtools, etc.) and adds the conventional
// App → Settings… entry bound to ⌘,. Choosing it just forwards to a handler; the
// actual editor lives in the renderer (see App / SettingsModal).

import { app, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";

export interface AppMenuHandlers {
  onOpenSettings: () => void;
}

export function installAppMenu(handlers: AppMenuHandlers): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
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
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
