import { useEffect, useRef } from "react";

/**
 * Escape, for the four Library authoring surfaces.
 *
 * The bug this exists for: opening a Persona, an Action or a Command was a dead end.
 * Escape was ABSENT rather than swallowed - `App.tsx` runs its page-shortcut work and then
 * returns for any page that is not the fleet, above its whole Escape ladder, and nothing
 * under `src/web/workflows/` registered one. The comment above that guard states the
 * architecture rather than describing an oversight: every page that is not the fleet owns
 * its own keys, and `SettingsPage` demonstrates it with a page-local listener. So the
 * ladder belongs here, to the surfaces, exactly as Settings' does to Settings.
 *
 * Copying `SettingsPage`'s handler verbatim would have been DEAD in the pane that fills
 * the screen. It bails when the event target is inside
 * `input, textarea, select, [contenteditable='true']`, and CodeMirror's content host is
 * `contenteditable` - so on the one surface where a person is most likely to be lost, the
 * key would have done nothing at all. This hook keeps the same instinct (a text box's own
 * Escape comes first) but SPENDS the press instead of dropping it: the first Escape leaves
 * the editing surface, the next leaves the page. A ladder, not a bail.
 *
 * No CodeMirror keymap extension is needed for that, and introducing one would be a new
 * pattern in `src/web` for no gain. `basicSetup` binds Escape three times
 * (`simplifySelection`, `closeCompletion`, `closeSearchPanel`), none of them declares
 * `preventDefault` or `stopPropagation`, and CodeMirror calls `preventDefault()` only when
 * a bound command returns `true`. With a collapsed cursor the press bubbles to `window`
 * with `defaultPrevented === false`; with a live selection or an open completion it bubbles
 * already-prevented, and the `ignore` rung below leaves that press to CodeMirror. That is
 * why a selected-text Escape takes THREE presses to leave the page (collapse, blur, leave)
 * and why that is intended rather than a defect.
 */

/**
 * What owns Escape right now, as a pure function of the press and the page. Extracted so
 * the decision ORDER is testable in a runner with no DOM - the same shape
 * `pageShortcutRoute` and `overlayGuards` already take.
 */
export type LibraryEscapeStep =
  /** Not ours: another key, or a handler below us already claimed this press. */
  | "ignore"
  /** An overlay owns the screen; it closes itself and the page stays put. */
  | "stand-down"
  /** The keyboard is inside something that edits text. Leave that, and nothing else. */
  | "leave-editor"
  /** Leave the page. */
  | "leave-page";

export function libraryEscapeStep(state: {
  key: string;
  /**
   * Set by anything that already answered this press: React's `onKeyDown` handlers on the
   * workflow connect dialog and the pipeline insert picker, the context menu, and
   * CodeMirror itself when a bound command took the key.
   */
  defaultPrevented: boolean;
  /**
   * Whether any `<Overlay>` is registered. Read through App's getter over a ref, so it is
   * correct in the same commit a modal mounts - a stale `false` here would leave the page
   * out from under a dialog the operator is reading.
   */
  overlayOpen: boolean;
  /** Whether the FOCUSED element sits inside an editing surface. See `isInsideEditor`. */
  focusInEditor: boolean;
}): LibraryEscapeStep {
  if (state.key !== "Escape" || state.defaultPrevented) return "ignore";
  // Before the editor rung, not after it: the dirty gate's own dialog is raised while the
  // keyboard is still in the field that made the draft dirty, and a page that peeled the
  // editor there would answer a press meant for the dialog.
  if (state.overlayOpen) return "stand-down";
  return state.focusInEditor ? "leave-editor" : "leave-page";
}

/**
 * Every focused region that answers Escape ITSELF, and so has a prior claim on the press.
 *
 * The rule is about regions, not about text: a surface the keyboard is inside owns the first
 * press, and only a page with the keyboard outside all of them is free to leave. Three kinds
 * qualify, and the last two are why this is not simply `SettingsPage`'s list:
 *
 * - **Form fields** - `input, textarea, select, [contenteditable='true']`, `SettingsPage`'s
 *   list verbatim, because this is the same rule about the same elements rather than a
 *   second one. It SPENDS the press blurring rather than dropping it, which is the whole
 *   difference: a page whose Escape is dead in its fields is the bug this fixes.
 * - **`.cm-editor`** - CodeMirror's content host is `contenteditable`, so a handler that
 *   bailed on that list alone would be dead in the pane that fills the Persona and Action
 *   screens.
 * - **`.react-flow`** - the workflow builder's canvas. React Flow binds Escape to unselect
 *   (`elementSelectionKeys` in `NodeWrapper.onKeyDown` / `EdgeWrapper.onKeyDown`) and does
 *   NOT `preventDefault` it - only its arrow-key branch does - so unlike every other nested
 *   Escape in these surfaces it does not announce itself through the `ignore` rung. Without
 *   this entry, one press meant as "deselect this node" ALSO took the whole page, and
 *   `WorkflowCanvas`'s `onFocusCapture` selects whatever receives focus, so merely tabbing
 *   into the canvas reached that state. Matched on the container rather than on
 *   `.react-flow__node`, so an edge, the pane and the controls are covered without this file
 *   having to track React Flow's internals.
 *
 * Matched with `closest` against the live focus AND the event's target, because neither alone
 * answers "where was the keyboard when this was pressed" on every surface:
 *
 * - The **focus** is what CodeMirror and the form fields report honestly, and it is the only
 *   one that is right when a press is retargeted on its way out.
 * - The **target** is what survives a re-render. React Flow's unselect replaces the focused
 *   edge - it is an `SVGElement`, and a fresh one - so by the time this listener runs on
 *   `window`, `document.activeElement` has already fallen back to `<body>` and the live focus
 *   says "nothing", while the target still names the edge. Reading focus alone meant one
 *   press on a focused edge left the whole page.
 *
 * Either one being inside a layer is enough, so a surface has to be outside all of them
 * before a press is read as "leave the page".
 */
export const LIBRARY_EDITOR_SELECTOR =
  ".cm-editor, .react-flow, input, textarea, select, [contenteditable='true']";

export function isInsideEditor(element: Element | null): boolean {
  return element !== null && element.closest(LIBRARY_EDITOR_SELECTOR) !== null;
}

/**
 * Give up focus, whatever kind of element is holding it.
 *
 * Duck-typed rather than `instanceof HTMLElement`, because `blur` is on the
 * `HTMLOrForeignElement` mixin and the graph's focusable elements are not HTML: React Flow
 * renders an edge as `<g tabindex="0">` inside the `<svg>` (`edgesFocusable` defaults to true
 * and nothing here turns it off), which is an `SVGElement`. An `instanceof HTMLElement` guard
 * skipped the blur for those while `preventDefault()` still fired, so the press was spent
 * doing nothing - the same dead end this hook exists to remove, one level in.
 */
function blurElement(element: Element | null): void {
  const focusable = element as (Element & { blur?: () => void }) | null;
  if (typeof focusable?.blur === "function") focusable.blur();
}

/**
 * Install the ladder for as long as an authoring surface is mounted.
 *
 * A plain BUBBLE-phase `window` listener, matching `SettingsPage` and `Overlay`, and for
 * `SettingsPage`'s stated reason: a capture-phase listener would run ahead of the
 * shortcut-recording panel's own capture handler and navigate away mid-record. Both
 * callbacks are held in refs so the listener subscribes exactly once - `onLeave` closes
 * over the router, which changes identity whenever a draft's dirtiness does.
 */
export function useLibraryEscape({
  isOverlayOpen,
  onLeave,
}: {
  isOverlayOpen: () => boolean;
  /**
   * Leave the page. MUST route through the router's `navigate`, which is what raises the
   * leave-with-unsaved-changes dialog instead of dropping a draft. A second navigation
   * path here - `history`, `location.hash` - would be a way out that bypasses the gate.
   */
  onLeave: () => void;
}): void {
  const overlayRef = useRef(isOverlayOpen);
  const leaveRef = useRef(onLeave);
  overlayRef.current = isOverlayOpen;
  leaveRef.current = onLeave;

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const focused = document.activeElement;
      const pressedOn = event.target instanceof Element ? event.target : null;
      const step = libraryEscapeStep({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        overlayOpen: overlayRef.current(),
        focusInEditor: isInsideEditor(focused) || isInsideEditor(pressedOn),
      });
      if (step === "ignore" || step === "stand-down") return;
      // Claimed either way, so a press spent on the editor is not ALSO read as a page
      // exit by anything listening above us.
      event.preventDefault();
      if (step === "leave-editor") {
        // The live focus, not the target: the target may already be detached, and blurring
        // it would leave the real focus where it is and stall the ladder on the next press.
        blurElement(focused);
        return;
      }
      leaveRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
