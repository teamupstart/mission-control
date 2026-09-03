import { expect, type Locator } from "@playwright/test";

/**
 * Every modal's content clears its own border, measured rather than asserted from markup.
 *
 * The defect this exists for is invisible to every other layer. `.modal` owns one
 * `--modal-inset` and applies it as `padding-inline`, so content is inset at any depth and
 * only the bands that draw to the border opt back out. Before that inversion the inset was
 * opt-in per region, and three surfaces never opted in - the standing-instructions session
 * modal, the bind-workflow dialog, and both `.modal-actions` footers, whose class had no CSS
 * rule at all. Their text sat on the border.
 *
 * A markup test cannot see this: the JSX is well formed either way and the difference is
 * entirely in resolved geometry. So this reads laid-out rectangles out of the live browser
 * and compares each text-bearing element against the panel's own border box.
 *
 * The reported offender is the WORST one, with its text, because "some element in this dialog
 * is 0px from the edge" is not something a person can act on.
 */

/**
 * The smallest gap that still reads as a gap.
 *
 * Deliberately below the 18px shell inset rather than equal to it. This asserts that text is
 * not printed onto the border - the defect - and not that every band settled on the same
 * number: `.file-picker-foot` insets its keycap legend by 12px of its own, and an assertion
 * pinned to 18px would fail on a band that is not wrong, while one pinned at exactly 12px
 * sits on a knife edge that fractional layout can tip either way.
 */
const MINIMUM_GAP = 10;

interface Offender {
  gap: number;
  tag: string;
  className: string;
  text: string;
}

/**
 * Assert that no text in `panel` comes within `MINIMUM_GAP` of its left or right border.
 *
 * `panel` is the dialog itself, not the backdrop: the backdrop is full-viewport, and
 * measuring against it would pass every one of the broken surfaces.
 */
export async function expectContentClearsBorder(panel: Locator): Promise<void> {
  await expect(panel).toBeVisible();
  const worst = await panel.evaluate((root: HTMLElement): Offender | null => {
    const bounds = root.getBoundingClientRect();
    let offender: Offender | null = null;
    for (const element of root.querySelectorAll<HTMLElement>("*")) {
      // Only elements that render text of their own. A wrapper's box may legitimately reach
      // the border - that is what a header band or a divider is - and its text does not.
      const own = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
      if (!own) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const gap = Math.min(rect.left - bounds.left, bounds.right - rect.right);
      if (offender === null || gap < offender.gap) {
        offender = {
          gap,
          tag: element.tagName.toLowerCase(),
          className: element.className,
          text: own.slice(0, 60),
        };
      }
    }
    return offender;
  });

  expect(worst, "the dialog rendered no text at all, so nothing was measured").not.toBeNull();
  expect(
    worst!.gap,
    `text sits ${worst!.gap}px from the panel border: <${worst!.tag} class="${worst!.className}"> ` +
      `"${worst!.text}". A modal's inset comes from .modal's --modal-inset; a band that must ` +
      `reach the border carries .modal-bleed and keeps its own padding.`,
  ).toBeGreaterThanOrEqual(MINIMUM_GAP);
}
