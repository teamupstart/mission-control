import { useCallback } from "react";
import { LAYOUT_MODES, UI_CONFIG_DEFAULTS } from "@shared/protocol.ts";
import type { LayoutMode } from "@shared/protocol.ts";
import { updateUiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * Which arrangement the dashboard is in. The same sessions and actions are available;
 * only the shape around them changes:
 *
 * - `console` split-pane: a rail of every session, one always-open detail beside it.
 * - `board`   kanban by state: a column per tone, drilling into the console detail on click.
 *
 * Stored in the daemon (`app_config.ui.layout`), per machine. It used to be `localStorage`,
 * which is really per ORIGIN and per Electron profile - so the product rename minted a
 * fresh profile and silently reset it, and so does every new Vite port. The daemon is the
 * per-machine store this always wanted; see `lib/uiConfig.ts`.
 */
export type { LayoutMode };

export const LAYOUTS: { id: LayoutMode; label: string; description: string }[] = [
  {
    id: "board",
    label: "Board",
    description:
      "A column per state, so the fleet's shape reads at a glance. Opening a session drills into the console - that column becomes the rail, the full detail fills the rest, and Esc returns you to the board.",
  },
  {
    id: "console",
    label: "Console",
    description:
      "A dense rail of every session with one always-open detail pane beside it. The conversation is permanent, not a click away.",
  },
];

/**
 * Which piece of state a layout has to drop to put its overview back.
 *
 * In the console the detail IS the selection. The board has its own open layer so arrow-key selection can move over
 * tiles without drilling into each one; Enter promotes that selection into the open layer.
 *
 * A future layout answers here rather than growing another layout-specific ternary
 * inside App. Escape peels the same layers, one press at a time.
 */
export function detailLayer(mode: LayoutMode): "selection" | "board" {
  return mode === "board" ? "board" : "selection";
}

/**
 * A stored value is only trusted if it's still a layout we ship. Anything else -
 * a hand-edited key, a mode from a future version, a half-written string - falls
 * back to Console rather than rendering nothing.
 *
 * `LAYOUT_MODES` is the shared list the daemon's schema validates against too, so a mode
 * cannot be renderable here and rejected there (or the reverse). `LAYOUTS` carries the
 * prose, which the daemon has no use for.
 */
export function parseLayoutMode(raw: string | null | undefined): LayoutMode {
  return (LAYOUT_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as LayoutMode)
    : UI_CONFIG_DEFAULTS.layout;
}

/** The chosen layout, stored in the daemon. */
export function useLayoutMode(): [LayoutMode, (mode: LayoutMode) => void] {
  const layout = useUiConfig().layout;
  const set = useCallback((next: LayoutMode) => {
    void updateUiConfig({ layout: parseLayoutMode(next) });
  }, []);
  return [layout, set];
}
