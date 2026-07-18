import { useCallback, useEffect, useState } from "react";

/**
 * Which arrangement the dashboard is in. The same sessions, the same cards, the
 * same actions - only the shape around them changes:
 *
 * - `grid`    the original: every session a card, one expands in place to focus.
 * - `console` split-pane: a rail of every session, one always-open detail beside it.
 * - `board`   kanban by state: a column per tone, drilling into the console detail on click.
 *
 * Persisted per-machine, like alert settings and keybindings - it's a preference
 * about this screen, not a fact about the fleet, so it never goes near the daemon.
 */
export type LayoutMode = "grid" | "console" | "board";

export const LAYOUTS: { id: LayoutMode; label: string; description: string }[] = [
  {
    id: "grid",
    label: "Cards",
    description: "Every session a card in a responsive grid. One expands in place to fill the screen.",
  },
  {
    id: "console",
    label: "Console",
    description:
      "A dense rail of every session with one always-open detail pane beside it. The conversation is permanent, not a click away.",
  },
  {
    id: "board",
    label: "Board",
    description:
      "A column per state, so the fleet's shape reads at a glance. Opening a session slides its detail over, without reflowing the board.",
  },
];

const KEY = "mission-control.layout";
const DEFAULT: LayoutMode = "grid";

/**
 * A stored value is only trusted if it's still a layout we ship. Anything else -
 * a hand-edited key, a mode from a future version, a half-written string - falls
 * back to the grid rather than rendering nothing.
 */
export function parseLayoutMode(raw: string | null | undefined): LayoutMode {
  return LAYOUTS.some((l) => l.id === raw) ? (raw as LayoutMode) : DEFAULT;
}

function load(): LayoutMode {
  try {
    return parseLayoutMode(localStorage.getItem(KEY));
  } catch {
    return DEFAULT;
  }
}

/** The chosen layout, persisted per-machine in localStorage. */
export function useLayoutMode(): [LayoutMode, (mode: LayoutMode) => void] {
  const [mode, setMode] = useState<LayoutMode>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* storage unavailable - keep in-memory only */
    }
  }, [mode]);
  const set = useCallback((next: LayoutMode) => setMode(parseLayoutMode(next)), []);
  return [mode, set];
}
