// Shape of the preload bridge (src/preload/index.ts) as seen from the renderer.
// Present only when running inside the Electron shell; the plain browser build
// leaves `window.missionDesktop` undefined, so every caller must guard on it.

import type { UpdateSnapshot } from "@shared/update.ts";
import type { UpdateDialogChoice, UpdateDialogRequest } from "@shared/update-dialog.ts";

export {};

declare global {
  interface MissionDesktop {
    isDesktop: boolean;
    version(): Promise<string>;
    openExternal(url: string): Promise<void>;
    installIntegrations(): Promise<{ ok: boolean; message: string }>;
    removeIntegrations(): Promise<{ ok: boolean; message: string }>;
    /** Claim the renderer module's private capability once. */
    claimProductIssueAuthorization?(): string | null;
    /** Arm one exact report only for the module that claimed the private capability. */
    authorizeProductIssue?(
      capability: string,
      input: { requestId: string; draftIdentity: string },
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
      /**
       * Subscribe to the update questions the shell needs answered, and announce that this
       * renderer can draw them. Returns an unsubscribe.
       *
       * OPTIONAL, for `setCardJumpKeys`'s reason below and with the same teeth: an older
       * preload beside this bundle - what a partly-applied desktop update looks like - has
       * no such member, and an unguarded call would throw inside a mount effect and take
       * the dashboard down. With no member to subscribe through, this renderer never
       * announces itself, so the shell settles each question as its own dismissal - the
       * same answer as "Later" - and offers the release again at the next check. Nothing
       * falls back to a platform sheet; there is none left in the update path.
       */
      onDialog?(cb: (request: UpdateDialogRequest) => void): () => void;
      /** Answer one question by the id it arrived with. */
      answerDialog?(id: string, choice: UpdateDialogChoice): void;
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
