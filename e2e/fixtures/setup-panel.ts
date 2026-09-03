import { expect, type Locator, type Page } from "@playwright/test";

import { SETUP_FAMILY_INFO, type SetupFamilyId } from "../../src/shared/setup-catalog.ts";

/**
 * Helpers for driving the Setup panel's family rail.
 *
 * Shared rather than repeated, because two facts about the panel now touch every spec that
 * asserts on a Setup row and neither is visible from the row itself:
 *
 *  1. **One family is mounted at a time.** A row in an unselected family is not off screen,
 *     it is absent - so a spec has to say which family it is reading. Which family the panel
 *     OPENS on is derived from where this machine's gaps are, and that differs between a CI
 *     runner and a developer's laptop, so no spec should inherit it.
 *  2. **A satisfied row has no "Ready" pill.** It states its status through its dot's
 *     accessible name, which is the one reading that covers every state uniformly.
 */

/** Select `family` in the rail and wait for its pane to be the one showing. */
export async function openSetupFamily(page: Page, family: SetupFamilyId): Promise<void> {
  const label = SETUP_FAMILY_INFO[family].label;
  // The rail item's accessible name is "<label>: N of M ready", or bare while its rows are
  // still loading, so anchor on the label and accept either.
  await page.getByRole("button", { name: new RegExp(`^${label}(:|$)`) }).click();
  await expect(page.locator(`#setup-family-${family}`)).toHaveAttribute("aria-current", "true");
}

/** One Setup row, by the anchor `setupRowAnchor` gives it. */
export function setupRow(page: Page, anchor: string): Locator {
  return page.locator(`[data-anchor="setup/${anchor}"]`);
}

/** Assert one row's status, read the way a screen reader reads it. */
export async function expectRowStatus(page: Page, anchor: string, status: string): Promise<void> {
  await expect(setupRow(page, anchor).getByRole("img", { name: status })).toBeVisible();
}
