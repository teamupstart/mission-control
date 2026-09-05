import { expect, type Locator } from "@playwright/test";

/**
 * Assert an element is the one the running tour is spotlighting.
 *
 * Read through `aria-controls`, not Driver's `driver-active-element` class, and the reason has
 * one home here rather than a comment per call site. Driver puts both on the active element in
 * the same call and clears both on the same transition, so they are the same claim - but React
 * OWNS `className` on any target whose classes are derived from state. A stop whose own
 * `prepare` changes that state, as Set up this machine does when it leaves the Settings route
 * to point at the gear, schedules a commit that runs after Driver's `classList.add` and
 * rewrites the attribute, taking the class with it. Deterministically, not as a race.
 *
 * Nothing in the app renders `aria-controls="driver-popover-content"`, so it survives that
 * commit - which is also why `styles.css` frames the spotlight by it as well as by the class.
 * A spec asserting the class alone reads as a broken spotlight on exactly the stops where the
 * frame is still drawn, and as a passing one where it is not.
 */
export async function expectSpotlight(target: Locator): Promise<void> {
  await expect(target).toHaveAttribute("aria-controls", "driver-popover-content");
}
