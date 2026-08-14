import { useEffect } from "react";

/**
 * Open, focus and dismiss for the two anchored surfaces the Library workspace grew: the
 * header's overflow menu and a property chip's control popover.
 *
 * **Escape is answered in React, not on `window`, and that is the load-bearing part.**
 * Phase 1's ladder (`useLibraryEscape`) is a bubble-phase `window` listener whose first rung
 * stands down for a press another handler already claimed. A second `window` listener here
 * would be racing it for the same key, and which one won would be decided by subscription
 * order - so the popover returns a React `onKeyDown` instead. React's handler runs at the
 * root container, below `window`, so it sees the press first; it calls `preventDefault()`,
 * and the ladder reads `defaultPrevented` and returns `ignore`. Escape closes the popover
 * and the page stays exactly where it was, by the mechanism Phase 1 already documented
 * rather than by a new one.
 *
 * That only holds while the keyboard is inside the surface, so `onKeyDown` goes on a host
 * that wraps the TRIGGER as well as the popover: a mouse click leaves focus on the trigger,
 * and a menu you can open but not close from the keyboard is the dead end this whole plan is
 * about, one level in.
 *
 * Opening focuses the popover's own container - `tabIndex={-1}` - rather than the first
 * control inside it. Focusing the control was the obvious thing and it was wrong twice over:
 * every control in this app carries a `Tooltip` that fires on FOCUS, so the bubble appeared
 * over the popover it had just opened and hid that popover's own label; and a click landing
 * on the popover's padding would otherwise blur to `<body>`, taking Escape with it. A
 * container that holds focus itself fixes both, and `Tab` still reaches the control it holds.
 *
 * Outside dismissal is `pointerdown` rather than `click`, matching `OpenInMenu`: a press
 * that starts outside should dismiss before whatever it lands on gets its own event, so a
 * click on the control behind the popover does one thing rather than two.
 */
export function useLibraryPopover({
  open,
  onClose,
  popoverRef,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}): { onKeyDown: (event: React.KeyboardEvent) => void } {
  // Give the popover the keyboard as it appears, so it can be closed by the key that closes
  // everything else here - and so a press meant for it is never answered by the page behind.
  useEffect(() => {
    if (!open) return;
    popoverRef.current?.focus({ preventScroll: true });
  }, [open, popoverRef]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      // The trigger counts as inside: it toggles, and a dismissal that fired first would
      // close the popover only for the click to reopen it.
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose, open, popoverRef, triggerRef]);

  return {
    onKeyDown: (event) => {
      // Only while it is actually up. The host wraps the trigger, and Escape returns focus
      // TO the trigger - so without this guard the next press was still being claimed by a
      // closed popover, and the page's own Escape was dead for as long as the chip or the
      // menu button kept focus. Phase 1's whole point, undone by a listener with no state.
      if (!open || event.key !== "Escape") return;
      // Claimed, so Phase 1's ladder reads this press as already answered and leaves the
      // page alone. Both halves matter: without `preventDefault` the ladder would ALSO
      // leave for `#/library`, and with only `stopPropagation` a `window` listener would
      // still see it - the ladder listens above the React root, not inside it.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus({ preventScroll: true });
    },
  };
}
