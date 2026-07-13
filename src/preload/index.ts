// Preload bridge. The dashboard is a plain web app that talks to the daemon over
// HTTP, so it needs almost nothing from Electron - this exposes a minimal,
// safe surface under `window.fleetDesktop` for the few app-level affordances
// (open a link in the system browser, install the Claude integrations, read the
// app version). contextIsolation keeps this the only channel into the renderer.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("fleetDesktop", {
  isDesktop: true,
  version: (): Promise<string> => ipcRenderer.invoke("fleet:version"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("fleet:open-external", url),
  installIntegrations: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("fleet:install-integrations"),
  removeIntegrations: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("fleet:remove-integrations"),
  // Main pushes this when the native "Settings…" item (⌘,) is chosen. Returns an
  // unsubscribe so the renderer can detach on unmount.
  onOpenSettings: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("fleet:open-settings", listener);
    return () => ipcRenderer.removeListener("fleet:open-settings", listener);
  },
});
