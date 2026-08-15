/**
 * Whether a click only marks the end of a drag-select rather than a click on the thing
 * underneath it. Copying text from a Board tile is a fair thing to want on a triage
 * board, and the mouseup that ends that drag must not navigate away from what was read.
 *
 * Takes the selection rather than reading it, so the decision can be tested without a DOM.
 */
export function isDragSelection(sel: { isCollapsed: boolean } | null): boolean {
  return sel != null && !sel.isCollapsed;
}
