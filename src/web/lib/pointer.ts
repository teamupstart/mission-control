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

/**
 * The selector for "something that already answers a click of its own" - a link, a control,
 * or anything ARIA has told the reader behaves like one.
 */
const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, label, summary,'
  + ' [role="button"], [role="link"], [role="menuitem"], [contenteditable="true"]';

/**
 * Whether a click landed on a panel's own surface rather than on a control inside it.
 *
 * A panel that wants its background to mean something - selecting the Board tile it sits in,
 * say - must not steal the clicks its own buttons and links already answer. Asking the target
 * whether it has an interactive ancestor is how that line is drawn once, rather than by each
 * handler listing the controls it happens to know about.
 *
 * Takes the element rather than the event so the decision is testable without a DOM.
 */
export function isSurfaceClick(target: { closest(selector: string): unknown } | null): boolean {
  return target != null && target.closest(INTERACTIVE_SELECTOR) == null;
}
