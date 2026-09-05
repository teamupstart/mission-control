import { UI_CONFIG_DEFAULTS } from "../../src/shared/protocol.ts";

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
 */
export function displayItemsShowing(...ids: readonly string[]): string[] {
  return UI_CONFIG_DEFAULTS.hiddenDisplayItems.filter((hidden) => !ids.includes(hidden));
}
