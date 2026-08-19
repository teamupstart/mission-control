const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Driver.js moves the spotlight, but 1.8.0 does not contain Tab inside its popover. */
export function containTourTab(
  event: KeyboardEvent,
  surfaces: HTMLElement | readonly HTMLElement[],
): void {
  if (event.key !== "Tab") return;
  const roots: readonly HTMLElement[] = Array.isArray(surfaces)
    ? surfaces
    : [surfaces as HTMLElement];
  const controls = roots.flatMap((surface) => [...surface.querySelectorAll<HTMLElement>(FOCUSABLE)])
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  if (controls.length === 0) {
    event.preventDefault();
    roots[0]?.focus();
    return;
  }

  const first = controls[0]!;
  const last = controls[controls.length - 1]!;
  const active = document.activeElement;
  if (!roots.some((surface) => surface.contains(active))) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && (active === first || roots.includes(active as HTMLElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export interface FocusBookmark {
  element: HTMLElement | null;
  id: string | null;
  ariaLabel: string | null;
}

export function captureFocusBookmark(element: Element | null): FocusBookmark {
  const focusable = element instanceof HTMLElement ? element : null;
  return {
    element: focusable,
    id: focusable?.id || null,
    ariaLabel: focusable?.getAttribute("aria-label") || null,
  };
}

/** Restore the original node, or its semantic replacement after route restoration remounts it. */
export function restoreFocusBookmark(bookmark: FocusBookmark): boolean {
  if (bookmark.element?.isConnected) {
    bookmark.element.focus();
    return true;
  }
  const byId = bookmark.id ? document.getElementById(bookmark.id) : null;
  if (byId instanceof HTMLElement) {
    byId.focus();
    return true;
  }
  if (!bookmark.ariaLabel) return false;
  const replacement = [...document.querySelectorAll<HTMLElement>("[aria-label]")]
    .find((element) => element.getAttribute("aria-label") === bookmark.ariaLabel);
  replacement?.focus();
  return replacement != null;
}
