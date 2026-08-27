import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * Folding the Line, end to end: a caret -> a PUT -> the band -> the conversation below it.
 *
 * The other three layers each assert something real and none of them can see this one. The
 * markup test proves condensed drops `ls-sub` and keeps every accessible name; the Electron
 * geometry test proves the two bands measure 86px and 38.5px in a laid-out window; the unit
 * test proves the cache round-trips a density. What none of them can see is the WIRE: that
 * pressing the caret reaches `app_config.ui.lineDensity`, that the daemon stores it, and
 * that a reload comes back folded the way it was left. A build whose `updateUiConfig` call
 * was dropped passes all three and loses the setting on every reload.
 *
 * So the assertions here are about the round trip and about the pixels the fold actually
 * buys - measured in the browser, on the built dashboard, against the real stylesheet.
 *
 * What this file deliberately does NOT assert is that the conversation pane gains exactly
 * what the band gives up. That needs a laid-out console, and the console only renders once
 * the fleet has a session (`layoutHasContent` in `App`) - reaching one from here would mean
 * dispatching an agent to measure a stylesheet. `line-strip-electron.test.ts` owns that
 * claim instead, in a shell it builds itself, and asserts the two numbers are equal.
 *
 * The `page` fixture rather than `dashboard`, deliberately: `dashboard` PINS
 * `lineDensity: "expanded"` so that ~all other Line specs keep asserting the sentences they
 * always asserted (see `fixtures/test.ts`). This spec is the one that must see the SHIPPED
 * default, so it takes the raw page and sets its own preconditions - the same division
 * `settings-conversation-picker.spec.ts` draws.
 *
 * No agent is dispatched, so no binary runs and no tokens are spent.
 */

const EVIDENCE = artifactsDir("line-density");

/** What the fold is worth, measured at 1512x900 in `docs/plans/line-collapse/plan.md`:
 *  86px -> 38.5px. Asserted as a floor, because a font metric nobody chose should not
 *  turn this red, and a fold worth 10px should. */
const MIN_FOLD_SAVING = 35;

const VIEWPORT = { width: 1512, height: 900 };

function observed(what: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${what}`);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // strip is a row of adjacent buttons.
  await page.mouse.move(0, 0);
  await page.getByRole("navigation", { name: "The Line" }).screenshot({
    path: `${EVIDENCE}${name}.png`,
  });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/line-density/${name}.png`);
}

/** The strip's used height, which is the whole subject of this file. */
async function bandHeight(page: Page): Promise<number> {
  return page
    .getByRole("navigation", { name: "The Line" })
    .evaluate((el) => el.getBoundingClientRect().height);
}

test("the Line ships condensed, folds open, and remembers which way it was left", async ({
  page,
  daemon,
}) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  // A profile that has never touched the setting, so what renders is the shipped default
  // and not a leftover from another spec in this context.
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();

  const line = page.getByRole("navigation", { name: "The Line" });
  await expect(line).toBeVisible();

  // ---- the shipped default is condensed ----

  await expect(line).toHaveClass(/is-condensed/);
  const condensedBand = await bandHeight(page);
  observed(`an untouched profile opened condensed: the band used ${condensedBand}px`);
  await shoot(page, "condensed");

  // Every stage is still there, still named, and still says what its number counts. This is
  // the claim that makes shipping condensed by default defensible rather than a regression.
  const names = await line.getByRole("button").evaluateAll((buttons) =>
    buttons
      .map((button) => button.getAttribute("aria-label") ?? "")
      .filter((name) => !/^(Condense|Expand) the Line$/.test(name)),
  );
  expect(names).toHaveLength(6);
  expect(names[0]).toMatch(/^Intake, \d/);
  expect(names[2]).toMatch(/^Working, \d/);
  // And the sentence a condensed row stops PRINTING is still in the accessible name, so the
  // fold costs a screen reader nothing.
  await expect(line.getByRole("button", { name: /^Working,/ })).toHaveAccessibleName(
    /no sessions open/,
  );
  // While being genuinely absent from the visible row, which is where the height came from.
  await expect(line.locator(".ls-sub")).toHaveCount(0);
  observed("condensed kept all six stages and their accessible names, and drew no sentence rows");

  // ---- the caret unfolds it, and the band grows by what it hands back ----

  const caret = line.getByRole("button", { name: "Expand the Line" });
  await expect(caret).toHaveAttribute("aria-expanded", "false");
  await caret.click();

  await expect(line).not.toHaveClass(/is-condensed/);
  await expect(line.getByRole("button", { name: "Condense the Line" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  // The sentences are back, from the daemon's fold, in the visible row.
  await expect(line.locator(".ls-sub")).toHaveCount(6);
  await expect(line.getByRole("button", { name: /^Working,/ })).toContainText("no sessions open");

  const expandedBand = await bandHeight(page);
  const saved = expandedBand - condensedBand;
  expect(
    saved,
    `condensing freed only ${saved}px (${expandedBand} -> ${condensedBand}), under the `
      + `${MIN_FOLD_SAVING}px that makes this worth its own control`,
  ).toBeGreaterThanOrEqual(MIN_FOLD_SAVING);
  observed(`the caret expanded the strip ${condensedBand}px -> ${expandedBand}px`);
  await shoot(page, "expanded");

  // ---- it survives a reload, which is the only proof the daemon stored it ----

  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
  const reloaded = page.getByRole("navigation", { name: "The Line" });
  await expect(reloaded).not.toHaveClass(/is-condensed/);
  await expect(reloaded.locator(".ls-sub")).toHaveCount(6);
  observed("the expanded choice survived a full reload, so the daemon stored it");

  // And the daemon really is where it lives - not `localStorage`, which is only the
  // first-paint cache. Read the config route directly rather than trusting the render.
  const stored = await (await fetch(`${daemon.baseURL}/api/ui/config`)).json();
  expect(stored.config.lineDensity).toBe("expanded");
  observed("app_config.ui.lineDensity reads \"expanded\" from the daemon's own route");
});

test("Shift+L folds the Line from the fleet, and not from inside the composer", async ({
  page,
  daemon,
}) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();

  const line = page.getByRole("navigation", { name: "The Line" });
  await expect(line).toHaveClass(/is-condensed/);

  await page.keyboard.press("Shift+L");
  await expect(line).not.toHaveClass(/is-condensed/);
  await page.keyboard.press("Shift+L");
  await expect(line).toHaveClass(/is-condensed/);
  observed("Shift+L folded and unfolded the strip from the fleet");

  // The chord is a bare letter, so the one thing it must never do is eat an L out of
  // something being typed. The topbar filter is the text field every fleet page has.
  const filter = page.getByPlaceholder(/filter/i).first();
  await filter.click();
  await filter.fill("");
  await page.keyboard.press("Shift+L");
  await expect(line).toHaveClass(/is-condensed/);
  await expect(filter).toHaveValue("L");
  observed("inside the filter box Shift+L typed an L and left the strip folded");
});


test("the condensed row holds its band as the window narrows, and keeps the caret reachable", async ({
  page,
  daemon,
}) => {
  // The invariant the whole design rests on. Condensed is ONE ROW carrying six segments, a
  // readout and a caret; a row that WRAPPED would grow the band and step the fleet down a
  // line - and it would do it at the window sizes nobody develops at. The expanded strip
  // gets this for free (its stages are `flex: 1 1 0` cards that shrink), so it is only the
  // folded row that has to be checked.
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();

  const line = page.getByRole("navigation", { name: "The Line" });
  await expect(line).toHaveClass(/is-condensed/);

  await page.setViewportSize({ width: 1512, height: 900 });
  const reference = await bandHeight(page);

  for (const width of [1400, 1180, 1000, 900, 820, 760]) {
    await page.setViewportSize({ width, height: 900 });
    // Same band at every width: the readout ellipsizes and then hides, the segments never wrap.
    expect(await bandHeight(page), `the band changed at ${width}px wide`).toBe(reference);
    // Every stage still shares one top edge - the direct measure of "it did not wrap".
    const rows = await line.locator(".line-stage").evaluateAll(
      (els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().top))).size,
    );
    expect(rows, `the stages wrapped onto ${rows} rows at ${width}px wide`).toBe(1);
    // And the fold is still operable, which is what stops a narrow window being a trap.
    const caret = line.getByRole("button", { name: /^(Condense|Expand) the Line$/ });
    await expect(caret).toBeVisible();
    const offScreen = await caret.evaluate(
      (el, w) => el.getBoundingClientRect().right > w + 0.5,
      width,
    );
    expect(offScreen, `the caret was pushed off screen at ${width}px wide`).toBe(false);
    // Nothing overflowed the document sideways either.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `the page scrolled sideways at ${width}px wide`).toBeLessThanOrEqual(0);
  }
  observed(`the condensed band stayed ${reference}px from 1512px down to 760px, never wrapping`);
});
