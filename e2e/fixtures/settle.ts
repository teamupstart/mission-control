import { expect, type Locator } from "@playwright/test";

/**
 * Wait for a locator to stop moving before acting on it.
 *
 * A live card settles for a second or so after anything happens to it - a dispatch's titler
 * renames it, the driver reports its model, the branch line arrives, a pulse segment appears
 * and re-flows the ones beside it - and every one of those re-lays-out the element you were
 * about to click. Playwright requires a stable box before it will click, and under a loaded
 * machine (the full suite runs several daemons at once) that churn can outlast the whole
 * retry budget. The observed failure is `element is not stable` followed by `element was
 * detached from the DOM, retrying`, and it is a flake rather than a defect: the control is
 * present, correct, and hit reliably the moment the fleet is quiet.
 *
 * Two consecutive identical reads is the cheapest honest definition of "settled". It is a
 * BARRIER, never a mask: the assertions that the control EXISTS and says the right thing run
 * before this, so a genuinely missing or wrong control fails exactly as loudly as it did.
 *
 * Shared rather than copied per spec because it was already written twice, and the second
 * copy is how the third one gets slightly different numbers. `line-drawers.spec.ts` keeps its
 * own `settledBox` on purpose: that one wants five stable reads on a FIXED cadence and the
 * box back, because it measures geometry rather than waiting to click, and collapsing the two
 * would make one caller's timing an accident of the other's.
 */
export async function settled(locator: Locator): Promise<void> {
  let last = JSON.stringify(await locator.boundingBox());
  await expect.poll(async () => {
    const next = JSON.stringify(await locator.boundingBox());
    const same = next === last;
    last = next;
    return same;
  }, { timeout: 30_000 }).toBe(true);
}
