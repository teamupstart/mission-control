/**
 * The DOM anchor a "Go to review" affordance jumps to.
 *
 * Kept beside neither component on purpose: `PaneDialogPrompt` renders the target and the
 * two composer surfaces render the jumps, and a hand-typed id in three files is a broken
 * link waiting for a rename. Per session, because a grid draws several conversations at
 * once and an unscoped `.pane-dialog` lookup would jump to whichever one came first.
 */
export function paneDialogAnchorId(sessionId: string): string {
  return `pane-dialog-${sessionId}`;
}

/** Scroll the session's open dialog into view and put focus on it. */
export function revealPaneDialog(sessionId: string): void {
  const el = document.getElementById(paneDialogAnchorId(sessionId));
  if (!el) return;
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  // `preventScroll` so focus does not fight the smooth scroll just requested. The section
  // carries `tabIndex={-1}` for this call and takes no place in the tab order.
  el.focus({ preventScroll: true });
}
