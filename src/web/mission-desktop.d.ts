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
    /** Bind the app's private current-preview reader once; later callers cannot replace it. */
    bindProductIssuePreview?(
      provider: () => { requestId: string; draftIdentity: string } | null,
    ): boolean;
    updates: {
      getState(): Promise<UpdateSnapshot>;
      check(): Promise<UpdateSnapshot>;
      /** Start the build; the app stays open and reports progress. */
      apply(): Promise<boolean>;
      /** Restart into the prepared build. */
      install(): Promise<boolean>;
      cancel(): Promise<void>;
      defer(): Promise<void>;
      onState(cb: (snapshot: UpdateSnapshot) => void): () => void;
    };
    /**
     * Tell the shell whether the Board is claiming ⌘0/⌘-/⌘= for its card jump shortcuts.
     *
     * The native View menu holds those zoom accelerators whenever the dashboard is not, so
     * this is what makes switching the Jump shortcut preference off give the keys back
     * rather than leave three keys nothing answers to.
     *
     * OPTIONAL, unlike the members above it, and the `?` is doing real work. A guard written
     * `window.missionDesktop?.setCardJumpKeys(...)` covers the BRIDGE being absent and not
     * this METHOD's, so a bridge object that predates the member - an older preload beside a
     * newer renderer bundle, which is what a partly-applied desktop update looks like - throws
     * a TypeError inside a mount effect and takes the whole dashboard down with it. Declaring
     * it optional makes the compiler refuse the unguarded call, so the guard cannot be dropped
     * again by an edit that still typechecks. Add later members the same way.
     */
    setCardJumpKeys?(claimed: boolean): Promise<void>;
    /** Subscribe to the native Settings… menu item (⌘,). Returns an unsubscribe. */
    onOpenSettings(cb: () => void): () => void;
  }

  interface Window {
    missionDesktop?: MissionDesktop;
  }
}
