import type { PaneHandles } from "@shared/pane.ts";
import { defaultExec, type TerminalExec } from "./exec.ts";
import { bindPane, type BoundPane, type TerminalHandles } from "./registry.ts";

/**
 * The two named `Session` fields, read as the handle list the registries speak.
 *
 * This is `legacyHandles` (`discovery/correlate.ts`) run backwards, and the two are a pair:
 * one lands an enumerated pane in `Session.tmux` / `Session.wezterm`, this one picks it back
 * up. Both name vendors, and neither should - they are the whole of what is left of the
 * assumption that there are exactly two backends with a field each, and phase 3 of
 * `docs/plans/pluggable-integrations/plan.md` deletes them together when `Session` carries a
 * list. Every OTHER reader is already generic: what it holds is a `BoundPane`, which cannot
 * be asked which vendor it got.
 *
 * A backend with no field to land in correlates and names a session normally and simply
 * records no handle, so it reads as handleless here - the honest shape of a half-finished
 * migration, and the reason this file is small enough to delete rather than untangle.
 */
export function handlesOf(s: PaneHandles): TerminalHandles {
  return {
    multiplexer: s.tmux
      ? {
          backend: "tmux",
          session: s.tmux.session,
          windowIndex: s.tmux.windowIndex,
          paneId: s.tmux.paneId,
        }
      : null,
    // `WeztermInfo` still holds the numeric ids wezterm reports; the adapters normalized
    // pane ids to strings at their boundary, so the conversion belongs here rather than at
    // each write site, which is where it used to be (`String(session.wezterm.paneId)`).
    emulator: s.wezterm
      ? { backend: "wezterm", paneId: String(s.wezterm.paneId), tabId: String(s.wezterm.tabId) }
      : null,
  };
}

/**
 * The one pane a session's reads and writes address, or null when it has none.
 *
 * The composition rule decides which handle that is (`bindPane`), so a caller of this cannot
 * pick the wrong one - and cannot tell which it got. Keyed identically to `paneToken`, which
 * is what makes the write lock guard the same pane the write lands on.
 */
export function bindSession(s: PaneHandles, exec: TerminalExec = defaultExec): BoundPane | null {
  return bindPane(handlesOf(s), exec);
}
