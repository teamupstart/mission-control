import { useMemo, useSyncExternalStore } from "react";
import type { Session } from "@shared/types.ts";
import type { Tone } from "./format.ts";
import { updateUiConfig, uiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * How wide each Board column is drawn: collapsed to a strip, normal, or expanded.
 *
 * Two facts with two lifetimes, owned here together so the rules between them live in one
 * place. The COLLAPSED set is saved in `UiConfig.collapsedBoardColumns`: folding Backlog away
 * is how someone wants their board to look, and it should still be folded after a reload. The
 * EXPANDED column is this module's own state and is never saved: expanding is "let me read that
 * properly", a gesture rather than a setting, exactly as it was when `BoardView` held it.
 *
 * A module store rather than `BoardView` state because `App` reads the collapsed set too: a
 * collapsed column takes its cards out of the DOM, and the arrow keys and ⌘-number shortcuts
 * walk arrays `App` builds. The same reason `repo-collapse.ts` is a store.
 */

/** A Board column: the Backlog, or one of the session tones. */
export type BoardColumnId = "backlog" | Tone;
export type ColumnWidth = "collapsed" | "normal" | "wide";

export interface ColumnWidths {
  collapsed: ReadonlySet<string>;
  /** At most ONE expanded column: a board with three wide columns is a board you scroll. */
  wide: string | null;
}

/** The width one column is drawn at. A column is never both collapsed and expanded. */
export function columnWidthOf(state: ColumnWidths, id: string): ColumnWidth {
  if (state.wide === id) return "wide";
  return state.collapsed.has(id) ? "collapsed" : "normal";
}

/**
 * The widths after setting one column. Expanding a column returns the previously expanded
 * one to NORMAL, never to collapsed; collapsing the expanded column also clears the expansion.
 */
export function withColumnWidth(state: ColumnWidths, id: string, width: ColumnWidth): ColumnWidths {
  const collapsed = new Set(state.collapsed);
  if (width === "collapsed") collapsed.add(id);
  else collapsed.delete(id);
  const wide = width === "wide" ? id : state.wide === id ? null : state.wide;
  return { collapsed, wide };
}

/**
 * The sessions a collapsed column is hiding, so navigation can step over them the way it steps
 * over a folded repository frame. Only tone columns hold sessions; a collapsed Backlog hides
 * tasks, which the arrow keys never walked.
 */
export function collapsedColumnSessionIds(
  groups: readonly { tone: string; sessions: readonly Session[] }[],
  collapsed: ReadonlySet<string>,
): ReadonlySet<string> {
  if (collapsed.size === 0) return EMPTY;
  const hidden = new Set<string>();
  for (const group of groups) {
    if (!collapsed.has(group.tone)) continue;
    for (const session of group.sessions) hidden.add(session.id);
  }
  return hidden;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

let wide: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function wideSnapshot(): string | null {
  return wide;
}

/** The widths right now, outside React. */
export function columnWidths(): ColumnWidths {
  return { collapsed: new Set(uiConfig().collapsedBoardColumns), wide };
}

/** The live widths, re-rendering on a change to either the saved or the unsaved half. */
export function useColumnWidths(): ColumnWidths {
  const stored = useUiConfig().collapsedBoardColumns;
  const expanded = useSyncExternalStore(subscribe, wideSnapshot, wideSnapshot);
  const collapsed = useMemo(() => new Set(stored), [stored]);
  return useMemo(() => ({ collapsed, wide: expanded }), [collapsed, expanded]);
}

/**
 * Counts width gestures, so a refused save can tell whether it is still the latest one. The
 * value of `wide` cannot: a later gesture may leave it exactly where the refused one did.
 */
let gesture = 0;

function setWide(next: string | null): void {
  if (next === wide) return;
  wide = next;
  for (const listener of listeners) listener();
}

/**
 * Set one column's width. The collapsed half is written through `updateUiConfig`, which
 * applies it at once and takes it back if the daemon refuses, so a strip is never drawn for
 * a fold that was not saved.
 *
 * A refused save takes the expanded half back too. Expanding a collapsed column moves both
 * halves at once, and a rollback of only the collapsed set would leave the column both
 * collapsed and expanded: drawn wide, then snapping back to a strip, not to normal, the moment
 * another column was expanded. Collapsing the expanded column is the mirror case.
 */
export function setColumnWidth(id: BoardColumnId, width: ColumnWidth): void {
  const mine = ++gesture;
  const stored = uiConfig().collapsedBoardColumns;
  const before = wide;
  const next = withColumnWidth({ collapsed: new Set(stored), wide }, id, width);
  setWide(next.wide);
  if (next.collapsed.has(id) !== stored.includes(id)) {
    // Only this column's entry moves. Ids this build does not know - from a newer build, or
    // one this build retired - are carried through untouched.
    const list = stored.filter((entry) => entry !== id);
    void updateUiConfig({ collapsedBoardColumns: width === "collapsed" ? [...list, id] : list })
      .then((saved) => {
        // Only while this is still the latest gesture: a later one is the truth, even when
        // it left the expansion where this one did.
        if (!saved && gesture === mine) setWide(before);
      });
  }
}
