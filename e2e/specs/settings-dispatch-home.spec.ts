import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Settings → Dispatch: the guided-dispatch preference's durable home.
 *
 * Until this category existed the preference had exactly one surface - the switch in the
 * dispatch modal's own header - which is to say it was reachable only by someone who was
 * already dispatching and had already noticed it. That is a fine place to reach for it
 * mid-dispatch and a useless place to look it up. This spec is the claim that it can now be
 * looked up: found in the rail, found by name in ⌘K, and deep-linked.
 *
 * THE LOAD-BEARING TEST is the first one, and only a browser can make it. The unit layer
 * proves the index entry points at an anchor the panel renders and that the registry stayed
 * contiguous; what it cannot see is whether the checkbox in the panel and the switch in the
 * modal are the SAME preference. They are two components in two module graphs over one store,
 * and the failure mode - each ending up with its own copy - renders identically and passes
 * every markup assertion. Clicking one and reading the other is the only thing that says so.
 *
 * NO TEST IN THIS FILE SUBMITS A DISPATCH. The modal is opened to see which of two forms it
 * is, then closed, so no agent binary runs and nothing here spends model tokens.
 */

/**
 * `Meta+k`, not `ControlOrMeta+k` - the same trap `palette.spec.ts` documents. `chordFromEvent`
 * derives the Command modifier from `e.metaKey` alone, so on Linux, where Playwright maps
 * `ControlOrMeta` to Control, this would arrive as "ctrl+k" and match nothing.
 */
const CHORD = "Meta+k";

/**
 * The panel's checkbox, by the label it is wrapped in.
 *
 * A prefix regex rather than an exact name: the `settings-toggle` vocabulary puts the label
 * AND its description inside one `<label>`, so the control's accessible name is the whole
 * paragraph. That is how the two shipped toggles (`display/format-messages`,
 * `keyboard/hints`) are already built, and matching the front of it selects this one without
 * pinning a sentence of prose into a selector.
 */
const guidedCheckbox = (page: Page): Locator =>
  page.getByRole("checkbox", { name: /^Guided dispatch/ });

/** The dispatch modal's rail strip, which is on screen exactly while a pass is running. */
const rail = (dialog: Locator): Locator =>
  dialog.getByRole("navigation", { name: "Guided dispatch" });

const taskBox = (dialog: Locator): Locator =>
  dialog.getByPlaceholder("What should this agent do?");

/** Leave Settings the way the rail offers, rather than by editing the hash. */
async function toFleet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "← Fleet" }).click();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
}

/** Open the dispatch modal from the fleet, the way every other spec does. */
async function openDispatch(page: Page): Promise<Locator> {
  // Never `{ exact: true }`: the keycap renders inside the button's label, so the accessible
  // name is "+Dispatch".
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  return dialog;
}

const EVIDENCE = artifactsDir("settings-dispatch-home");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // `Tooltip` opens on hover and portals a bubble over whatever is being photographed.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-dispatch-home/${name}.png`);
}

test("the Settings panel and the dispatch modal are one preference, in both directions", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/dispatch`);

  // Off, because the shared fixture pins it off. Asserted rather than assumed: every claim
  // below is about a change of state, and none of them could fail if it started on.
  const toggle = guidedCheckbox(dashboard);
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await shoot(dashboard, "01-panel-off");

  await toggle.check();
  await expect(toggle).toBeChecked();
  await shoot(dashboard, "02-panel-on");

  // Panel → modal. The questions are up, which is the whole point of the preference, and the
  // header switch that used to be its only home agrees with the checkbox that just moved.
  await toFleet(dashboard);
  const guidedDialog = await openDispatch(dashboard);
  await expect(rail(guidedDialog)).toBeVisible();
  await expect(guidedDialog.getByText("Which repo is this for?")).toBeVisible();
  await expect(guidedDialog.getByRole("switch", { name: "Guided" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await shoot(dashboard, "03-modal-guided");

  // Modal → panel, the direction the tests above cannot cover. Turning it off from the
  // header has to move the checkbox in Settings, or these are two values that merely agreed
  // once because they were both born from the same default.
  await guidedDialog.getByRole("switch", { name: "Guided" }).click();
  await expect(rail(guidedDialog)).toBeHidden();
  await dashboard.keyboard.press("Escape");
  await expect(guidedDialog).toBeHidden();

  await dashboard.goto(`${daemon.baseURL}/#/settings/dispatch`);
  await expect(guidedCheckbox(dashboard)).not.toBeChecked();

  // And the modal is today's form again - the counterpart to the guided frame above, so
  // "back to the ordinary form" is a state a reviewer can see rather than a sentence.
  await toFleet(dashboard);
  const plainDialog = await openDispatch(dashboard);
  await expect(rail(plainDialog)).toBeHidden();
  await expect(plainDialog.getByRole("listbox")).toHaveCount(0);
  await expect(taskBox(plainDialog)).toBeFocused();
  await shoot(dashboard, "04-modal-plain");
});

test("Dispatch is a rail peer under This screen, after Keyboard, and deep-links", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings`);

  // The rail's browser-scoped group, in the order it draws. Pinned as a list rather than by
  // asking whether Dispatch is merely present, because the registry's contract is an ORDER:
  // the arrow keys walk the flat array while the rail draws group by group, so a Dispatch
  // entry that landed outside its group would still render here and would move the selection
  // somewhere the eye is not. This is that invariant with a browser behind it.
  const thisScreen = dashboard.locator(".settings-nav-group").filter({ hasText: "This screen" });
  // Suffix regexes rather than exact strings: each row draws its category glyph inside the
  // button, so the rendered text is "▦Display", not "Display". Matching the end pins the
  // membership and the order without freezing the other two categories' icons into this file.
  await expect(thisScreen.getByRole("tab")).toHaveText([/Display$/, /Keyboard$/, /Dispatch$/]);

  const tab = thisScreen.getByRole("tab", { name: "Dispatch" });
  // The glyph, asserted because it is a claim rather than decoration: `+` is the chord that
  // opens the dispatch form and the keycap the topbar's Dispatch button already draws beside
  // the same word, which is what makes this rail row recognisably about that surface.
  await expect(tab).toHaveText(/^\+Dispatch$/);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");

  // Clicking a rail row is a route change, so the category is a link someone can keep.
  await expect(dashboard).toHaveURL(/#\/settings\/dispatch$/);

  // The panel header's own claim. `browser`, not the `machine` its Harnesses neighbour
  // carries: this preference changes how THIS dashboard composes a dispatch and reaches no
  // session the daemon launched.
  const head = dashboard.locator(".settings-panel-head");
  await expect(head.getByRole("heading", { name: "Dispatch" })).toBeVisible();
  await expect(head).toContainText("This browser");

  // The deep link is the same destination arrived at cold, not merely a hash the rail wrote.
  await dashboard.goto(`${daemon.baseURL}/#/settings/dispatch`);
  await dashboard.reload();
  await expect(
    dashboard.locator(".settings-nav-group").getByRole("tab", { name: "Dispatch" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(guidedCheckbox(dashboard)).toBeVisible();
});

test("⌘K finds the preference by name and flips it where it stands", async ({ dashboard }) => {
  // From the fleet, deliberately: the point of indexing this is that it is reachable without
  // knowing it lives in Settings, so the test must not start on the page it would jump to.
  await dashboard.keyboard.press(CHORD);
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await expect(palette).toBeVisible();

  // "guided" - the word, not the category, and not "dispatch". Four rows already answer to
  // "dispatch" (the shortcut, both harness cards, the Harnesses category), so the name is
  // what has to carry this one.
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("guided");
  const row = dashboard.getByRole("option", { name: /^Guided dispatch, setting, off$/ });
  await expect(row).toBeVisible();
  // The row says which panel owns it, so a jump is never a mystery destination.
  await expect(row).toContainText("Dispatch ·");
  await shoot(dashboard, "05-palette-off");

  await dashboard.keyboard.press("Enter");

  // Flipped IN PLACE: the switch on the row moved and the palette is still open on the fleet.
  // A bindable toggle that lost its runtime source still works - it silently degrades to a
  // jump into Settings - so "did not navigate" is the assertion that tells the two apart.
  await expect(dashboard.getByRole("option", { name: /^Guided dispatch, setting, on$/ })).toBeVisible();
  await expect(palette).toBeVisible();
  await expect(dashboard).toHaveURL(/#\/fleet$/);
  await shoot(dashboard, "06-palette-on");

  // And it flipped the real preference rather than a row's own idea of one.
  await dashboard.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  const dialog = await openDispatch(dashboard);
  await expect(rail(dialog)).toBeVisible();
});

test("the preference reaches the daemon, so the panel is not writing to the browser alone", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/dispatch`);
  await guidedCheckbox(dashboard).check();

  // `updateUiConfig` is optimistic with a rollback, so a checked box is not by itself proof
  // the write landed - it is exactly what a refused update looks like for one frame. The
  // daemon's own answer is.
  await expect
    .poll(async () => {
      const response = await fetch(`${daemon.baseURL}/api/ui/config`);
      const body = (await response.json()) as { config?: { guidedDispatch?: boolean } };
      return body.config?.guidedDispatch;
    })
    .toBe(true);

  // And it survives the reload, which is the operator-facing half of the same claim: the
  // preference is a setting, not a mood this tab is in.
  await dashboard.reload();
  await expect(guidedCheckbox(dashboard)).toBeChecked();
});
