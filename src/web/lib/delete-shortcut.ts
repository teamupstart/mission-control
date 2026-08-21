export const DELETE_SHORTCUT_ACTION = "delete";
export const DELETE_SHORTCUT_SCOPE_ATTRIBUTE = "data-delete-shortcut-scope";

const DELETE_BUTTON_SELECTOR = `button[data-keybinding-action="${DELETE_SHORTCUT_ACTION}"]`;

/**
 * Whether Delete owns this keypress after the Diff-default migration.
 *
 * `resolveKeybindings` already gives persisted overrides first claim, so an existing
 * `{ diff: "d" }` normally leaves Delete unset. The explicit Diff check is a second boundary
 * at dispatch time: even a malformed/stale binding map cannot turn that established custom
 * Diff chord into a destructive action merely because a Delete button is visible.
 */
export function deleteShortcutMatchesChord(input: {
  chord: string;
  deleteBinding: string;
  diffBinding: string;
}): boolean {
  return Boolean(
    input.deleteBinding
    && input.chord === input.deleteBinding
    && input.chord !== input.diffBinding
  );
}

function usable(button: HTMLButtonElement): boolean {
  return !button.disabled
    && button.getAttribute("aria-disabled") !== "true"
    && !button.hidden
    && button.getClientRects().length > 0;
}

function only(buttons: readonly HTMLButtonElement[]): HTMLButtonElement | null {
  return buttons.length === 1 ? buttons[0]! : null;
}

/**
 * Activate the one Delete control the current DOM context identifies.
 *
 * Destructive shortcuts must fail closed. A focused Delete button wins, followed by the
 * focused row/surface, then one explicitly current control, and finally a sole visible
 * control. If two unrelated rows both offer Delete, no click is synthesized.
 */
export function activateDeleteShortcut(
  target: EventTarget | null,
  root: ParentNode = document,
): boolean {
  const targetElement = target instanceof Element ? target : null;
  // Overlay owns the authoritative stack. Restrict resolution to its top registration so
  // a Delete control mounted behind a confirmation can never receive the same keypress.
  const topOverlay = root.querySelector<HTMLElement>('.modal-backdrop[data-overlay-top="true"]');
  const activeRoot: ParentNode = topOverlay ?? root;
  const candidates = [...activeRoot.querySelectorAll<HTMLButtonElement>(DELETE_BUTTON_SELECTOR)]
    .filter(usable);

  const focused = targetElement?.closest<HTMLButtonElement>(DELETE_BUTTON_SELECTOR);
  if (focused && candidates.includes(focused)) {
    focused.click();
    return true;
  }

  const scope = targetElement?.closest<HTMLElement>(`[${DELETE_SHORTCUT_SCOPE_ATTRIBUTE}]`);
  if (scope && activeRoot instanceof Node && activeRoot.contains(scope)) {
    const scoped = candidates.filter((button) => scope.contains(button));
    const scopedTarget = only(scoped);
    if (scopedTarget) {
      scopedTarget.click();
      return true;
    }
  }

  const primary = only(candidates.filter((button) => button.dataset.deleteShortcutPrimary === "true"));
  const resolved = primary ?? only(candidates);
  if (!resolved) return false;
  resolved.click();
  return true;
}
