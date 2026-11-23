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

/** The Settings picker, which is a different element from the strip `shoot` photographs. */
async function shootSettings(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.getByRole("radiogroup", { name: "Line density" }).screenshot({
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


test("the Settings picker sets the density, and the strip and the daemon both follow", async ({
  page,
  daemon,
}) => {
  // Raised by the Inspector on the first review round, and it was right: the specs above
  // drive the caret and the chord, so a broken radio - or a Settings render path that threw
  // before reaching this panel - could have shipped with every new spec still green. The
  // panel is a third writer of one preference, and a third writer needs its own proof.
  await page.setViewportSize(VIEWPORT);
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  const picker = page.getByRole("radiogroup", { name: "Line density" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("radio")).toHaveCount(3);

  const expanded = picker.getByRole("radio", { name: /^Expanded/ });
  const condensed = picker.getByRole("radio", { name: /^Condensed/ });
  // The shipped default, read on the surface an operator would read it on.
  await expect(condensed).toBeChecked();
  await expect(expanded).not.toBeChecked();
  observed("Settings > Display > Top bar > The Line opened with Condensed checked, the shipped default");

  // ---- the thumbnails are icons, not full-width pictures ----
  //
  // The exact regression `settings-conversation-picker.spec.ts` was written for, and this
  // panel copies that component's shape: an inline <svg> carrying a viewBox and no
  // width/height is a replaced element with a ratio and no intrinsic size, so it takes 100%
  // of the line and scales its height by the ratio. Exact rather than bounded because 44x32
  // is a fixed CSS size no font metric moves.
  const thumbs = picker.locator(".view-thumb");
  await expect(thumbs).toHaveCount(3);
  for (const box of await thumbs.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    }),
  )) {
    expect(box, "a density thumbnail is drawing at pane width again").toEqual({
      width: 44,
      height: 32,
    });
  }

  // ---- selecting Expanded reaches the daemon ----

  await expanded.check();
  await expect(expanded).toBeChecked();
  await expect
    .poll(async () => (await (await fetch(`${daemon.baseURL}/api/ui/config`)).json()).config.lineDensity)
    .toBe("expanded");
  observed("choosing Expanded in Settings wrote app_config.ui.lineDensity through the daemon");

  // ---- and the strip itself follows, which is the point of the setting ----

  await page.goto(`${daemon.baseURL}/#/fleet`);
  const line = page.getByRole("navigation", { name: "The Line" });
  await expect(line).toBeVisible();
  await expect(line).not.toHaveClass(/is-condensed/);
  await expect(line.locator(".ls-sub")).toHaveCount(6);
  observed("the fleet's strip drew expanded, with its six sentences back");

  // ---- and back again, so neither direction is a one-way door ----

  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const backPicker = page.getByRole("radiogroup", { name: "Line density" });
  await expect(backPicker.getByRole("radio", { name: /^Expanded/ })).toBeChecked();
  await backPicker.getByRole("radio", { name: /^Condensed/ }).check();
  await expect
    .poll(async () => (await (await fetch(`${daemon.baseURL}/api/ui/config`)).json()).config.lineDensity)
    .toBe("condensed");

  await page.goto(`${daemon.baseURL}/#/fleet`);
  const backLine = page.getByRole("navigation", { name: "The Line" });
  await expect(backLine).toHaveClass(/is-condensed/);
  await expect(backLine.locator(".ls-sub")).toHaveCount(0);
  observed("choosing Condensed again folded the strip back, both ways round");

  // ---- the caret and the panel are the same preference, not two ----
  //
  // Three writers, one value. If the panel held its own state the strip would fold here and
  // the radio would still read Condensed on the next visit.
  await backLine.getByRole("button", { name: "Expand the Line" }).click();
  await expect(backLine).not.toHaveClass(/is-condensed/);
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await expect(
    page.getByRole("radiogroup", { name: "Line density" }).getByRole("radio", { name: /^Expanded/ }),
  ).toBeChecked();
  observed("folding with the caret moved the Settings radio too - one preference, three controls");
  await shootSettings(page, "settings-picker");
});


test("Disabled removes the strip, survives a reload and Shift+L, and the preview shows each choice", async ({
  page,
  daemon,
}) => {
  // The third answer. "The Line" is a name few operators know the strip by, so the panel
  // draws the real strip at the selected density above the choices; this proves the preview
  // follows the radio, and that Disabled really takes the strip off the fleet and keeps it
  // off until Settings brings it back.
  await page.setViewportSize(VIEWPORT);
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  const picker = page.getByRole("radiogroup", { name: "Line density" });
  await expect(picker).toBeVisible();
  // It lives under Display > Top bar, the band directly under which the strip is drawn -
  // inside that section, after the bar's own lists, and not as a section of its own.
  const topbarSection = page.locator('[data-anchor="display/topbar"]');
  await expect(topbarSection.getByRole("heading", { name: "Top bar", level: 3 })).toBeVisible();
  await expect(topbarSection.getByRole("radiogroup", { name: "Line density" })).toBeVisible();
  await expect(topbarSection.getByRole("heading", { name: "The Line", level: 4 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The Line", level: 3 })).toHaveCount(0);
  observed("the Line setting renders inside Settings > Display > Top bar, under its own subheading");
  // The preview is `inert` and `aria-hidden`, so it is not a second Line to a screen reader -
  // which is also why it is reached by its stage rather than by role.
  const preview = page.locator(".line-preview-stage");
  await expect(page.getByText("The pipeline strip under the top bar on the fleet")).toBeVisible();

  // ---- the preview draws the real strip at the shipped default ----
  await expect(preview.locator("nav.line")).toHaveClass(/is-condensed/);
  await expect(preview.locator(".line-stage")).toHaveCount(6);
  await expect(preview.locator(".ls-name")).toHaveText([
    "Intake", "Backlog", "Working", "Review", "Decide", "Shipped",
  ]);
  await expect(preview.locator(".ls-sub")).toHaveCount(0);
  observed("the Line preview drew six condensed stages with their names and counts");
  await shootPreview(page, "settings-preview-condensed");
  await shootPlacement(page, "settings-topbar-section");

  // ---- Expanded: the same strip, with its sentences ----
  await picker.getByRole("radio", { name: /^Expanded/ }).check();
  await expect(preview.locator("nav.line")).not.toHaveClass(/is-condensed/);
  await expect(preview.locator(".ls-sub")).toHaveCount(6);
  await expect(preview.locator(".ls-sub").nth(1)).toHaveText("nothing ready · 5 parked");
  observed("choosing Expanded redrew the preview with a sentence under every stage");
  await shootPreview(page, "settings-preview-expanded");

  // ---- Disabled: no strip, and the preview says so ----
  const disabled = picker.getByRole("radio", { name: /^Disabled/ });
  await disabled.check();
  await expect(disabled).toBeChecked();
  await expect(preview.locator("nav.line")).toHaveCount(0);
  await expect(preview).toContainText("Nothing is drawn here. The fleet starts directly under the top bar.");
  // Stored as its own key, never as a third density an older daemon could not parse - and
  // the density it was switched off from is kept for switching it back on.
  const lineConfig = async (): Promise<{ lineHidden: boolean; lineDensity: string }> => {
    const { config } = await (await fetch(`${daemon.baseURL}/api/ui/config`)).json();
    return { lineHidden: config.lineHidden, lineDensity: config.lineDensity };
  };
  await expect.poll(lineConfig).toEqual({ lineHidden: true, lineDensity: "expanded" });
  observed("choosing Disabled emptied the preview and stored lineHidden true, keeping lineDensity \"expanded\"");
  await shootPreview(page, "settings-preview-disabled");

  // ---- the fleet draws no strip, and the chord does not quietly bring it back ----
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "The Line" })).toHaveCount(0);
  await page.keyboard.press("Shift+L");
  await expect(page.getByRole("navigation", { name: "The Line" })).toHaveCount(0);
  expect(await lineConfig()).toEqual({ lineHidden: true, lineDensity: "expanded" });
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "The Line" })).toHaveCount(0);
  observed("the fleet drew no Line, Shift+L left it off, and it stayed off across a reload");

  // ---- Settings is the way back ----
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.getByRole("radiogroup", { name: "Line density" }).getByRole("radio", { name: /^Condensed/ }).check();
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.getByRole("navigation", { name: "The Line" })).toHaveClass(/is-condensed/);
  expect(await lineConfig()).toEqual({ lineHidden: false, lineDensity: "condensed" });
  observed("choosing Condensed in Settings brought the strip back and stored lineHidden false");
});

/** The Line block of Display > Top bar: its preview and its choices. */
async function shootPreview(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.locator(".topbar-line-setting").screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/line-density/${name}.png`);
}

/**
 * The whole Display > Top bar section, heading to Line block, in a viewport tall enough to
 * hold it - an element taller than the window is stitched under the sticky top bar.
 */
async function shootPlacement(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  const before = page.viewportSize();
  await page.setViewportSize({ width: VIEWPORT.width, height: 2600 });
  await page.mouse.move(0, 0);
  await page.locator('[data-anchor="display/topbar"]').screenshot({ path: `${EVIDENCE}${name}.png` });
  if (before) await page.setViewportSize(before);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/line-density/${name}.png`);
}

test("the See work tour borrows a condensed Line over Disabled, and leaves Disabled stored", async ({
  dashboard,
  daemon,
}) => {
  // The tour's first stop spotlights the strip, so with the Line switched off App draws it
  // condensed for as long as the tour runs - and must not write that back as a preference,
  // or finishing the tour would quietly undo the operator's Disabled.
  const stored = async (): Promise<boolean> =>
    (await (await fetch(`${daemon.baseURL}/api/ui/config`)).json()).config.lineHidden;
  const pinned = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lineHidden: true }),
  });
  expect(pinned.ok).toBe(true);
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.setViewportSize(VIEWPORT);
  await dashboard.reload();
  await expect(dashboard.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  const line = dashboard.getByRole("navigation", { name: "The Line" });
  await expect(line).toHaveCount(0);
  observed("with Disabled saved, the fleet drew no Line before the tour");

  // ---- the tour starts, and its first stop has a strip to point at ----
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await dashboard.keyboard.press("Meta+k");
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Search everything" }).fill("See the work");
  await palette.getByRole("option", { name: /Start See the work tour, command/ }).click();
  const stop = dashboard
    .getByRole("dialog", { name: "Fleet and the Line" })
    .or(dashboard.getByRole("status", { name: "Fleet and the Line" }));
  await expect(stop).toBeVisible();
  await expect(line).toBeVisible();
  await expect(line).toHaveClass(/is-condensed/);
  await expect(line.locator(".line-stage")).toHaveCount(6);
  // No caret on the borrowed strip: folding it would send a density, which the daemon
  // reads as switching the Line back on. And the borrowing itself wrote nothing.
  await expect(line.locator(".ls-fold")).toHaveCount(0);
  expect(await stored()).toBe(true);
  observed("during the See work tour the Line drew condensed while lineHidden stayed true");

  // ---- leaving the tour takes the borrowed strip away again ----
  await stop.getByRole("button", { name: "Exit tour" }).click();
  await expect(stop).toBeHidden();
  await expect(line).toHaveCount(0);
  expect(await stored()).toBe(true);
  observed("exiting the tour removed the Line again, and lineHidden still read true");
});
