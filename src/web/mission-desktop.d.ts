// Shape of the preload bridge (src/preload/index.ts) as seen from the renderer.
// Present only when running inside the Electron shell; the plain browser build
// leaves `window.missionDesktop` undefined, so every caller must guard on it.

import type { UpdateSnapshot } from "@shared/update.ts";

export {};

declare global {
  interface MissionDesktop {
    isDesktop: boolean;
    version(): Promise<string>;
    openExternal(url: string): Promise<void>;
    installIntegrations(): Promise<{ ok: boolean; message: string }>;
    removeIntegrations(): Promise<{ ok: boolean; message: string }>;
    updates: {
      getState(): Promise<UpdateSnapshot>;
      check(): Promise<UpdateSnapshot>;
      apply(): Promise<boolean>;
      defer(): Promise<void>;
      onState(cb: (snapshot: UpdateSnapshot) => void): () => void;
    };
    /** Subscribe to the native Settings… menu item (⌘,). Returns an unsubscribe. */
    onOpenSettings(cb: () => void): () => void;
  }

  interface Window {
    missionDesktop?: MissionDesktop;
  }
}
