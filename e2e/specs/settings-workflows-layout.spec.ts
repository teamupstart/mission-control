import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * The Workflows settings panel reads as two columns, with its live readings above the fold.
 *
 * What was wrong: the panel was one column 2115px tall inside an 831px scrollport - 2.55
 * screens - and the five escalation tiles plus the health counters were the LAST things on
 * it, below y=1720, while 640px of width sat unused beside them the whole way down. So the
 * two tiles that can mean "somebody must look" (*Needs you*, *GitHub Inspector gates*) were
 * the least reachable things on the panel an operator opens to find them.
 *
 * Only this layer can settle it. The render test pins which column each anchor's markup
 * lands in, and markup is exactly what cannot answer this: `.sc-split` is a CSS grid, so
 * whether the two columns are actually SIDE BY SIDE, whether the strip is actually within
 * the first screenful, and how tall the laid-out panel really is are all facts about used
 * geometry that a string of HTML does not contain. A panel could satisfy every assertion in
 * `workflow-settings-panel.test.ts` and still stack into one 2115px column if a media query
 * or a `max-width` disagreed.
 *
 * So the claims here are all measured rectangles:
 *
 *   1. The columns overlap vertically and do not overlap horizontally - which is what
 *      "beside", rather than "above", means.
 *   2. The escalation strip's bottom is inside the first 831px of the panel.
 *   3. Retention sits with the counters it is measured against, in the readings column.
 *   4. The panel is under two screens tall, where it used to be 2.55.
 *
 * No model tokens: nothing here dispatches, runs a workflow or reaches a Persona. It reads
 * one settings panel against the daemon's own config and status routes.
 */

const EVIDENCE = artifactsDir("settings-workflows-layout");

/** The settings scrollport at the suite's 1440x900 viewport, measured on the live app. */
const SCROLLPORT = 831;

/** Photograph a state this spec has already asserted on, behind the suite's evidence flag. */
async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-workflows-layout/${name}.png`);
}

/** A laid-out rectangle, or a failure naming what could not be measured. */
async function rect(target: Locator, what: string): Promise<{
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
}> {
  const box = await target.boundingBox();
  if (!box) throw new Error(`${what} has no laid-out box`);
  return {
    top: box.y,
    bottom: box.y + box.height,
    left: box.x,
    right: box.x + box.width,
    height: box.height,
  };
}

test("Settings Workflows draws policy beside its readings, with the strip above the fold", async ({
  dashboard,
}) => {
  await dashboard.goto(`${dashboard.url().split("#")[0]}#/settings/workflows`);
  await expect(dashboard.getByRole("tab", { name: /Workflows/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const panel = dashboard.locator("section.wf-settings");
  await expect(panel).toBeVisible();

  // The strip only draws once the status read lands, and every geometric claim below is
  // about where it sits - so wait for the tile rather than measuring an absent one.
  const strip = panel.locator(".sc-strip-links");
  await expect(strip).toBeVisible();
  await expect(strip.getByText("Needs you")).toBeVisible();
  await expect(strip.getByText("GitHub Inspector gates")).toBeVisible();

  const controls = panel.locator(".sc-controls");
  const readings = panel.locator(".wf-readings");
  await expect(controls).toBeVisible();
  await expect(readings).toBeVisible();

  // 1. BESIDE, not above. Horizontal ranges are disjoint and vertical ranges overlap; a
  //    panel that had collapsed back to one column fails both halves of this.
  const left = await rect(controls, "the control column");
  const right = await rect(readings, "the readings column");
  expect(
    left.right,
    "the control column overlaps the readings column horizontally",
  ).toBeLessThanOrEqual(right.left + 1);
  expect(
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top),
    "the two columns do not overlap vertically, so they are stacked and not side by side",
  ).toBeGreaterThan(100);

  // 2. The escalation summary is within the first screenful of the panel. Measured from the
  //    PANEL's top rather than the viewport's, so the assertion does not silently depend on
  //    how tall the page header happens to be on the day.
  const stripBox = await rect(strip, "the escalation strip");
  expect(
    stripBox.bottom - left.top,
    "the escalation strip is no longer inside the first screenful of the panel",
  ).toBeLessThan(SCROLLPORT);

  // 3. Retention is with the counters that measure it, and the switches are not.
  const retention = await rect(
    panel.locator('.sc-card[data-anchor="workflows/retention"]'),
    "the retention card",
  );
  const health = await rect(
    panel.locator('.sc-card[data-anchor="workflows/health"]'),
    "the health card",
  );
  const liveDelivery = await rect(
    panel.locator('.sc-card[data-anchor="workflows/live-delivery"]'),
    "the Live delivery card",
  );
  expect(retention.left, "retention left the readings column").toBeGreaterThanOrEqual(
    right.left - 1,
  );
  expect(health.left, "the health counters left the readings column").toBeGreaterThanOrEqual(
    right.left - 1,
  );
  expect(liveDelivery.right, "Live delivery left the control column").toBeLessThanOrEqual(
    right.left + 1,
  );

  // 4. Under two screens, where the single column was 2.55. Asserted as a bound rather than
  //    an exact height: the copy in these cards is edited often, and a test that pinned the
  //    pixel would fail on a reworded sentence while saying nothing about the scroll.
  expect(
    left.height,
    "the panel is back over two screens tall",
  ).toBeLessThan(SCROLLPORT * 2);
  expect(
    Math.max(left.height, right.height),
    "the panel is back over two screens tall",
  ).toBeLessThan(SCROLLPORT * 2);

  // The six health counters read two across rather than as six full-width rows, which is
  // what a used-width measurement can see and markup cannot: two rows sharing a line have
  // the same `top`.
  const rows = panel.locator('.sc-card[data-anchor="workflows/health"] .sc-health-row');
  await expect(rows).toHaveCount(6);
  const tops = await rows.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
  );
  expect(
    new Set(tops).size,
    "the health counters are laid out one per line, not two across",
  ).toBe(3);

  // The retention boxes are on one row with their Apply, and each keeps the full phrase as
  // its accessible name - which is how this spec reaches them without a `data-testid`.
  const raw = dashboard.getByLabel("Raw evidence days");
  const history = dashboard.getByLabel("Completed run days");
  const newest = dashboard.getByLabel("Newest completed runs kept");
  const apply = panel.getByRole("button", { name: "Apply" });
  await expect(raw).toBeVisible();
  await expect(newest).toBeVisible();
  await expect(apply).toBeVisible();
  const boxes = await Promise.all([
    rect(raw, "the raw evidence box"),
    rect(history, "the run history box"),
    rect(newest, "the newest-kept box"),
    rect(apply, "the Apply button"),
  ]);
  const lines = new Set(boxes.map((box) => Math.round(box.top / 8)));
  expect(
    lines.size,
    "the retention boxes and their Apply are not on one row",
  ).toBe(1);

  // The panel still grows NO run list: `WorkflowRuns.tsx` owns that, and the wide column
  // holds readings. A tile is a link INTO that list, which is the distinction being kept.
  await expect(panel.locator(".sc-table, .sc-pager, .sc-ledger")).toHaveCount(0);
  await expect(strip.getByRole("link", { name: /Needs you/ })).toHaveAttribute(
    "href",
    /#\/runs\?status=waiting_for_session/,
  );

  // Two captures, because they answer different halves of the claim. The element shot shows
  // both columns end to end; only the VIEWPORT shot can show what is above the fold, which is
  // the whole point of moving the strip - a 1271px panel photographed as an element says
  // nothing about which of it fits in 900px of window.
  await shoot(panel, "workflows-two-column");
  await shoot(dashboard, "workflows-two-column-viewport");

  // A NARROW window collapses the split, and the readings must still lead.
  //
  // This is a measured regression, not a hypothetical. `.wf-settings > .sc-split` is two
  // classes and the shared collapse is one, inside a media query - and a media query does
  // not raise specificity - so the first cut of the width rule outranked the collapse at
  // every width and Workflows never folded at all: at an 820px window it squeezed both
  // columns into 320px and a sliver and ran to 3345px, four screens. The fix gates the
  // two-column rule on `min-width` and gives the readings `order: -1` when folded, because
  // the shared "controls lead on narrow" default would put five policy cards above the two
  // tiles that mean "somebody must look" - rebuilding this panel's original defect at the
  // one size where scrolling costs most.
  await dashboard.setViewportSize({ width: 900, height: 900 });
  await expect(strip).toBeVisible();
  const folded = {
    controls: await rect(controls, "the folded control column"),
    readings: await rect(readings, "the folded readings column"),
    strip: await rect(strip, "the folded strip"),
  };
  expect(
    folded.controls.left,
    "the columns are still side by side at 900px, so the split never collapsed",
  ).toBeCloseTo(folded.readings.left, -1);
  expect(
    folded.readings.top,
    "the readings column fell below the policy cards when the split collapsed",
  ).toBeLessThan(folded.controls.top);
  expect(
    folded.strip.bottom - folded.readings.top,
    "the escalation strip is not the first thing in the collapsed panel",
  ).toBeLessThan(200);

  await shoot(dashboard, "workflows-collapsed-viewport");
});
