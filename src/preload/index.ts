// Preload bridge. The dashboard is a plain web app that talks to the daemon over
// HTTP, so it needs almost nothing from Electron - this exposes a minimal,
// safe surface under `window.missionDesktop` for the few app-level affordances
// (open a link in the system browser, install the Claude integrations, read the
// app version). contextIsolation keeps this the only channel into the renderer.

import { contextBridge, ipcRenderer } from "electron";
import type { UpdateSnapshot } from "../shared/update.ts";

interface ProductIssueAuthorizationInput {
  requestId: string;
  draftIdentity: string;
}
// This preload is sandboxed, so it cannot import arbitrary Node builtins. Web Crypto belongs
// to the isolated renderer world and keeps the capability private from the page just as the
// former Node implementation intended.
const productIssueAuthorizationCapability = globalThis.crypto.randomUUID();
let productIssueAuthorizationClaimed = false;

contextBridge.exposeInMainWorld("missionDesktop", {
  isDesktop: true,
  version: (): Promise<string> => ipcRenderer.invoke("mission:version"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("mission:open-external", url),
  installIntegrations: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("mission:install-integrations"),
  removeIntegrations: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("mission:remove-integrations"),
  claimProductIssueAuthorization: (): string | null => {
    if (productIssueAuthorizationClaimed) return null;
    productIssueAuthorizationClaimed = true;
    return productIssueAuthorizationCapability;
  },
  authorizeProductIssue: (
    capability: string,
    input: ProductIssueAuthorizationInput,
  ): boolean => {
    if (
      !productIssueAuthorizationClaimed ||
      capability !== productIssueAuthorizationCapability ||
      navigator.userActivation?.isActive !== true
    ) return false;
    return ipcRenderer.sendSync("mission:product-issue-report-click", input) === true;
  },
  updates: {
    getState: (): Promise<UpdateSnapshot> => ipcRenderer.invoke("mission:update-get-state"),
    check: (): Promise<UpdateSnapshot> => ipcRenderer.invoke("mission:update-check"),
    apply: (): Promise<boolean> => ipcRenderer.invoke("mission:update-apply"),
    install: (): Promise<boolean> => ipcRenderer.invoke("mission:update-install"),
    cancel: (): Promise<void> => ipcRenderer.invoke("mission:update-cancel"),
    defer: (): Promise<void> => ipcRenderer.invoke("mission:update-defer"),
    onState: (cb: (snapshot: UpdateSnapshot) => void): (() => void) => {
      const listener = (_event: unknown, snapshot: UpdateSnapshot): void => cb(snapshot);
      ipcRenderer.on("mission:update-state", listener);
      return () => ipcRenderer.removeListener("mission:update-state", listener);
    },
  },
  // Report whether the Board is claiming ⌘0/⌘-/⌘= for its card jump shortcuts, so the
  // native View menu can hold those zoom accelerators whenever it is not. One boolean
  // rather than the live slot set: see `main/menu-template.ts` for why the answer follows
  // the preference and not the card count.
  setCardJumpKeys: (claimed: boolean): Promise<void> =>
    ipcRenderer.invoke("mission:card-jump-keys", claimed),
  // Main pushes this when the native "Settings…" item (⌘,) is chosen. Returns an
  // unsubscribe so the renderer can detach on unmount.
  onOpenSettings: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("mission:open-settings", listener);
    return () => ipcRenderer.removeListener("mission:open-settings", listener);
  },
});
