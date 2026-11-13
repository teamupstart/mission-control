import { useCallback } from "react";
import { uiConfig, updateUiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * Whether the session rail beside an open session is folded down to a strip.
 *
 * The rail is the column of sessions to the left of the detail pane: the Console's, and the
 * Board drill-in's, which is the same rail in two shapes (the focused column, or every state
 * group when "Show all sessions" is on). Folding it hands its width to the conversation and the
 * terminal. The strip that replaces it still counts what each state holds, and is itself the
 * button that unfolds it - see `FoldedSessionRail`.
 *
 * Stored in the daemon (`UiConfig.sessionRailFolded`), per machine, and read through this one
 * hook so the Console, the Board, and App's shortcut can never disagree about it.
 */
export function useSessionRailFolded(): [boolean, (folded: boolean) => void] {
  const folded = useUiConfig().sessionRailFolded;
  const set = useCallback((next: boolean) => setSessionRailFolded(next), []);
  return [folded, set];
}

/**
 * Fold or unfold the rail. A no-op when it is already there, so a click on a control whose
 * state has not repainted yet does not write the same value twice.
 */
export function setSessionRailFolded(folded: boolean): void {
  if (uiConfig().sessionRailFolded === folded) return;
  void updateUiConfig({ sessionRailFolded: folded });
}

/**
 * Flip the fold, reading the CURRENT value at call time.
 *
 * A module function rather than a hook for the reason `toggleLineDensity` gives: App's keydown
 * listener is registered by an effect with an explicit dependency list, and a value closed over
 * from render would make every press after the first recompute the same answer.
 */
export function toggleSessionRail(): void {
  setSessionRailFolded(!uiConfig().sessionRailFolded);
}
