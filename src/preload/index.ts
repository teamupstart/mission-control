// Preload bridge. The dashboard is a plain web app that talks to the daemon over
// HTTP, so it needs almost nothing from Electron - this exposes a minimal,
// safe surface under `window.missionDesktop` for the few app-level affordances
// (open a link in the system browser, install the Claude integrations, read the
// app version). contextIsolation keeps this the only channel into the renderer.

import { contextBridge, ipcRenderer } from "electron";
import type { UpdateSnapshot } from "../shared/update.ts";

contextBridge.exposeInMainWorld("missionDesktop", {
  isDesktop: true,
  version: (): Promise<string> => ipcRenderer.invoke("mission:version"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("mission:open-external", url),
  installIntegrations: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("mission:install-integrations"),
  removeIntegrations: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("mission:remove-integrations"),
  updates: {
    getState: (): Promise<UpdateSnapshot> => ipcRenderer.invoke("mission:update-get-state"),
    check: (): Promise<UpdateSnapshot> => ipcRenderer.invoke("mission:update-check"),
    apply: (): Promise<boolean> => ipcRenderer.invoke("mission:update-apply"),
    defer: (): Promise<void> => ipcRenderer.invoke("mission:update-defer"),
    onState: (cb: (snapshot: UpdateSnapshot) => void): (() => void) => {
      const listener = (_event: unknown, snapshot: UpdateSnapshot): void => cb(snapshot);
      ipcRenderer.on("mission:update-state", listener);
      return () => ipcRenderer.removeListener("mission:update-state", listener);
    },
  },
  // Main pushes this when the native "Settings…" item (⌘,) is chosen. Returns an
  // unsubscribe so the renderer can detach on unmount.
  onOpenSettings: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("mission:open-settings", listener);
    return () => ipcRenderer.removeListener("mission:open-settings", listener);
  },
});
