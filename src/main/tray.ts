// Menu-bar presence. The tray shows a live one-line fleet summary and a menu of
// app-level actions. Counts come from polling the daemon's /api/report (the same
// projection the Roundup panel uses) - simple and robust; sub-second latency
// isn't needed for a status glance.

import { Tray, Menu, nativeImage, app } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { existsSync } from "node:fs";
import { BASE_URL } from "@shared/harness-runtime.mjs";

interface ReportCounts {
  needsYou: number;
  working: number;
  idle: number;
  queued: number;
}

export interface TrayHandlers {
  onOpen: () => void;
  onInstallIntegrations: () => void;
  onRemoveIntegrations: () => void;
  onQuit: () => void;
}

let tray: Tray | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let last: ReportCounts = { needsYou: 0, working: 0, idle: 0, queued: 0 };

function trayImage(iconPath: string): Electron.NativeImage {
  if (iconPath && existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      img.setTemplateImage(true); // recolors for light/dark menu bars
      return img;
    }
  }
  return nativeImage.createEmpty();
}

function summary(c: ReportCounts): string {
  return `${c.needsYou} need you · ${c.working} working · ${c.idle} idle`;
}

function render(handlers: TrayHandlers): void {
  if (!tray) return;
  const c = last;
  tray.setToolTip(`Agent Wrangler — ${summary(c)}`);
  // A short title next to the icon draws the eye when something needs you.
  tray.setTitle(c.needsYou > 0 ? ` ${c.needsYou}` : "");

  const template: MenuItemConstructorOptions[] = [
    { label: `Agent Wrangler`, enabled: false },
    { label: summary(c), enabled: false },
    { type: "separator" },
    { label: "Open Dashboard", click: () => handlers.onOpen() },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { label: "Install Claude integrations…", click: () => handlers.onInstallIntegrations() },
    { label: "Remove Claude integrations", click: () => handlers.onRemoveIntegrations() },
    { type: "separator" },
    { label: "Quit Agent Wrangler", click: () => handlers.onQuit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

async function refresh(handlers: TrayHandlers): Promise<void> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${BASE_URL}/api/report`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return;
    const report = (await res.json()) as { counts?: Partial<ReportCounts> };
    const c = report.counts ?? {};
    last = {
      needsYou: c.needsYou ?? 0,
      working: c.working ?? 0,
      idle: c.idle ?? 0,
      queued: c.queued ?? 0,
    };
    render(handlers);
  } catch {
    /* daemon momentarily unreachable - keep the last summary */
  }
}

export function createTray(iconPath: string, handlers: TrayHandlers): Tray {
  tray = new Tray(trayImage(iconPath));
  tray.on("click", () => handlers.onOpen());
  render(handlers);
  void refresh(handlers);
  poll = setInterval(() => void refresh(handlers), 3000);
  return tray;
}

export function destroyTray(): void {
  if (poll) clearInterval(poll);
  poll = null;
  tray?.destroy();
  tray = null;
}
