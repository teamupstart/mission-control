// Menu-bar presence. The tray shows a live one-line session summary and a menu of
// app-level actions. Counts come from polling the daemon's /api/report (the same
// projection the Roundup panel uses) - simple and robust; sub-second latency
// isn't needed for a status glance.

import { Tray, Menu, nativeImage, app } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { existsSync } from "node:fs";
import { BASE_URL } from "@shared/harness-runtime.mjs";

import { join } from "node:path";
import { voiceTray, type TrayVoiceState } from "./voice-tray.ts";

interface ReportCounts {
  needsYou: number;
  working: number;
  idle: number;
  backlog: number;
}

export interface TrayHandlers {
  setMuted: (muted: boolean) => Promise<boolean>;
  onOpen: () => void;
  onCheckForUpdates: () => void;
  onInstallIntegrations: () => void;
  onRemoveIntegrations: () => void;
  onQuit: () => void;
}

let presentation: ReturnType<typeof voiceTray> = null;
let menu: Menu | null = null;
let muteConfirmation: NodeJS.Timeout | undefined;
let muteError = "";
let updateImage: ((image: string | undefined) => void) | null = null;
let refreshMenu: (() => void) | null = null;

export function setTrayVoice(state: TrayVoiceState): void {
  const next = voiceTray(state.mode, state.muted ?? state.mode === "muted");
  if (next?.nextMuted !== presentation?.nextMuted) {
    clearTimeout(muteConfirmation);
    muteConfirmation = undefined;
    muteError = "";
  }
  if (presentation?.image !== next?.image) updateImage?.(next?.image);
  if (presentation?.status === next?.status && presentation?.action === next?.action) return;
  presentation = next;
  refreshMenu?.();
}

let tray: Tray | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let last: ReportCounts = { needsYou: 0, working: 0, idle: 0, backlog: 0 };

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

async function requestMute(handlers: TrayHandlers, muted: boolean): Promise<void> {
  if (muteConfirmation || presentation?.nextMuted !== muted) return;
  // The POST can succeed before the state event arrives. Keep both click paths
  // disabled until the published mute bit changes, or offer retry after a missed event.
  const deadline = setTimeout(failed, 5000);
  muteConfirmation = deadline;
  muteError = "";
  render(handlers);
  if (!await handlers.setMuted(muted)) failed();

  function failed() {
    if (muteConfirmation !== deadline) return;
    clearTimeout(deadline);
    muteConfirmation = undefined;
    muteError = `${muted ? "Mute" : "Unmute"} not confirmed. Try again.`;
    render(handlers);
    if (menu) tray?.popUpContextMenu(menu);
  }
}

function render(handlers: TrayHandlers): void {
  if (!tray) return;
  const c = last;
  tray.setToolTip(`Mission Control - ${summary(c)}`);
  // A short title next to the icon draws the eye when something needs you.
  tray.setTitle(c.needsYou > 0 ? ` ${c.needsYou}` : "");

  const template: MenuItemConstructorOptions[] = [
    { label: `Mission Control`, enabled: false },
    { label: summary(c), enabled: false },
    { type: "separator" },
    { label: "Open Dashboard", click: () => handlers.onOpen() },
    { label: "Check for Updates…", click: () => handlers.onCheckForUpdates() },
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
    { label: "Quit Mission Control", click: () => handlers.onQuit() },
  ];
  if (presentation) {
    const { status, action, nextMuted } = presentation;
    template.splice(3, 0,
      { label: status, enabled: false },
      ...(muteError ? [{ label: muteError, enabled: false }] : []),
      { label: action, enabled: !muteConfirmation, click: () => void requestMute(handlers, nextMuted) },
      { type: "separator" },
    );
  }
  menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(presentation ? null : menu);
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
      backlog: c.backlog ?? 0,
    };
    render(handlers);
  } catch {
    /* daemon momentarily unreachable - keep the last summary */
  }
}

export function createTray(iconPath: string, voiceImageDir: string, handlers: TrayHandlers): Tray {
  tray = new Tray(trayImage(iconPath));
  updateImage = image => tray?.setImage(trayImage(image ? join(voiceImageDir, image) : iconPath));
  refreshMenu = () => render(handlers);
  tray.on("click", () => {
    if (presentation) void requestMute(handlers, presentation.nextMuted);
    else handlers.onOpen();
  });
  tray.on("right-click", () => {
    if (presentation && menu) tray?.popUpContextMenu(menu);
  });
  render(handlers);
  void refresh(handlers);
  poll = setInterval(() => void refresh(handlers), 3000);
  return tray;
}

export function destroyTray(): void {
  if (poll) clearInterval(poll);
  poll = null;
  menu = null;
  clearTimeout(muteConfirmation);
  muteConfirmation = undefined;
  muteError = "";
  presentation = null;
  updateImage = refreshMenu = null;
  tray?.destroy();
  tray = null;
}
