import { useSyncExternalStore } from "react";
import { fleetRows, type FleetToneGroup } from "./fleet-order.ts";

/**
 * Which repository frames the operator has folded away.
 *
 * A MODULE STORE rather than each view's own `useState`, and the reason is a defect this
 * started life with. Collapse began as local state in `BoardView` and `ConsoleView`, which is
 * where a purely presentational fold belongs - but folding a frame takes its cards out of the
 * DOM, and the arrow keys walk index arrays `App` derives from `orderSessions`. Nothing had
 * told navigation the rows were gone, so the cursor stepped into them: no tile drew as
 * selected, the scroll-into-view had no element to reach, and Enter would have opened a
 * session that was not on screen. That is exactly the "ordering computed by two rules" failure
 * `fleet-order.ts` exists to prevent, arriving through a third rule only the view knew.
 *
 * So the fold lives here, where `App` can read it to build the navigation arrays and both
 * views can read it to render. One store, three readers, the same arrangement `uiConfig` has
 * for `groupBoardByRepo` and for the same reason: three consumers that must not disagree.
 *
 * UN-PERSISTED, still. A fold is "let me read the rest of this column", not a setting, and it
 * should not still be in force tomorrow morning - the same call `revealed` and `wideCol` make
 * in `BoardView`. It is deliberately NOT in `UiConfig`: nothing should survive a reload.
 *
 * SHARED between the board and the console rail, which local state made separate. The board's
 * focused column becomes that rail on drill-in, so two fold states meant the same repository
 * could be open on one side of the morph and folded on the other.
 */

let collapsed: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ReadonlySet<string> {
  return collapsed;
}

/**
 * Fold or unfold one frame, by the row key `fleetRows` computed for it.
 *
 * The ROW key, never the repository root. A repository is framed once per tone column and once
 * per side of the idle column's free/held boundary, so up to four rows share a root - and
 * keying by root would mean folding one in `idle` also folded away the sibling waiting for you
 * in `needs you`, which is the one thing a fold must never do.
 */
export function toggleRepoCollapsed(key: string): void {
  const next = new Set(collapsed);
  if (!next.delete(key)) next.add(key);
  collapsed = next;
  for (const listener of listeners) listener();
}

/** The folded set, for a component that renders frames. */
export function useRepoCollapsed(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The sessions inside a folded frame, which navigation must step over.
 *
 * Expanded through `fleetRows` - the SAME expansion the views render - rather than by matching
 * session ids against repository roots. A view draws what `fleetRows` returns, so asking it
 * which rows are folded is asking the thing that decides; a parallel rule here would be the
 * second source of truth all over again, one layer up.
 *
 * Returns an empty set when nothing is folded, which is the overwhelmingly common case, so the
 * caller's filter can be skipped entirely.
 */
export function hiddenSessionIds(
  groups: readonly FleetToneGroup[],
  collapsedKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  if (collapsedKeys.size === 0) return EMPTY;
  const hidden = new Set<string>();
  for (const group of groups) {
    for (const row of fleetRows(group)) {
      if (row.kind !== "repo" || !collapsedKeys.has(row.key)) continue;
      for (const block of row.blocks) {
        if (block.kind === "session") hidden.add(block.session.id);
        else for (const session of block.sessions) hidden.add(session.id);
      }
    }
  }
  return hidden;
}

/** Shared empty set, so the common no-folds path allocates nothing. */
const EMPTY: ReadonlySet<string> = new Set<string>();
