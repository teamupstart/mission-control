import { UI_CONFIG_DEFAULTS } from "../../src/shared/protocol.ts";
import type { DisplayItemId } from "../../src/web/lib/board-card.ts";

/**
 * The shipped hidden-items list with some ids un-hidden.
 *
 * `hiddenDisplayItems` is replaced wholesale rather than merged per id, so a spec that needs
 * one off-by-default Display item cannot ask for it in isolation - it has to send the whole
 * array. Sending a literal is what makes a spec quietly depend on which items ship hidden:
 * `[]` also turns ON every future item that ships off, and `["worktree"]` freezes today's
 * answer into a spec that is not about the worktree at all.
 *
 * Derived from `UI_CONFIG_DEFAULTS` instead, so a spec says the one thing it means - "with
 * the workflow details switched on, otherwise as shipped" - and a later default change
 * carries through it rather than silently changing what it was testing.
 *
 * `ids` is typed as `DisplayItemId` rather than a bare `string`, so a typo'd id is a
 * compile error here instead of a silent no-op: `.includes()` against a misspelled id never
 * matches, `hiddenDisplayItems` comes back unchanged, and the spec fails later at whatever
 * assertion expected the item to be visible - reporting the wrong thing entirely.
 */
export function displayItemsShowing(...ids: readonly DisplayItemId[]): string[] {
  return UI_CONFIG_DEFAULTS.hiddenDisplayItems.filter((hidden) => !ids.includes(hidden));
}
