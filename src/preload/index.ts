// Preload bridge. The dashboard is a plain web app that talks to the daemon over
// HTTP, so it needs almost nothing from Electron - this exposes a minimal,
// safe surface under `window.missionDesktop` for the few app-level affordances
// (open a link in the system browser, install the Claude integrations, read the
// app version). contextIsolation keeps this the only channel into the renderer.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("missionDesktop", {
  isDesktop: true,
  version: (): Promise<string> => ipcRenderer.invoke("mission:version"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("mission:open-external", url),
  installIntegrations: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("mission:install-integrations"),
  removeIntegrations: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("mission:remove-integrations"),
  // Main pushes this when the native "Settings…" item (⌘,) is chosen. Returns an
  // unsubscribe so the renderer can detach on unmount.
  onOpenSettings: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("mission:open-settings", listener);
    return () => ipcRenderer.removeListener("mission:open-settings", listener);
  },
});
