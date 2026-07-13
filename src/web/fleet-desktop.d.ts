// Shape of the preload bridge (src/preload/index.ts) as seen from the renderer.
// Present only when running inside the Electron shell; the plain browser build
// leaves `window.fleetDesktop` undefined, so every caller must guard on it.

export {};

declare global {
  interface FleetDesktop {
    isDesktop: boolean;
    version(): Promise<string>;
    openExternal(url: string): Promise<void>;
    installIntegrations(): Promise<{ ok: boolean; message: string }>;
    removeIntegrations(): Promise<{ ok: boolean; message: string }>;
    /** Subscribe to the native Settings… menu item (⌘,). Returns an unsubscribe. */
    onOpenSettings(cb: () => void): () => void;
  }

  interface Window {
    fleetDesktop?: FleetDesktop;
  }
}
