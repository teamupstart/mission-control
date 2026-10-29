import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Settings > Display > Top bar: hiding an optional item takes it off the real bar, minimizing
 * a control draws it as its glyph, the preview shows both before the operator leaves the
 * panel, and the choice survives a reload.
 *
 * The layer the static-markup test cannot reach: that a click in Settings becomes a PUT,
 * comes back through the config store and repaints the bar above every page - and that a
 * "minimized" control is genuinely not drawing its word in a real layout, which only a
 * bounding box can say. The ladder's own one-row guarantee stays with `topbar-one-row.spec.ts`;
 * this spec only confirms a customized bar still keeps to one row.
 *
 * No model tokens: nothing is dispatched. The cost chip is fed one priced datapoint over the
 * daemon's own OTLP route so that "Cost estimate" has something to hide.
 */

const EVIDENCE = artifactsDir("topbar-customization");

async function seedCost(daemon: DaemonHandle): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/v1/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{
            name: "claude_code.cost.usage",
            sum: {
              aggregationTemporality: 1,
              isMonotonic: true,
              dataPoints: [{
                asDouble: 12.5,
                startTimeUnixNano: `${Date.now() - 250}000000`,
                timeUnixNano: `${Date.now()}000000`,
                attributes: [
                  { key: "session.id", value: { stringValue: "topbar-customization" } },
                  { key: "model", value: { stringValue: "claude-sonnet-4-5" } },
                  { key: "query_source", value: { stringValue: "main" } },
                ],
              }],
            },
          }],
        }],
      }],
    }),
  });
  expect(res.ok, `/v1/metrics answered ${res.status}`).toBe(true);
}

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  const page = "mouse" in target ? target : target.page();
  // Off every control first: a Tooltip portals a bubble under a resting pointer.
  await page.mouse.move(0, 900);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/topbar-customization/${name}.png`);
}

/**
 * Whether an element is actually DRAWN, rather than clipped to the 1x1 visually-hidden box a
 * minimized label keeps so the control keeps its accessible name. Playwright counts that box
 * as visible, so the width has to be read. Polled, because the ladder re-fits after a render.
 */
async function expectDrawn(locator: Locator, want: boolean, why: string): Promise<void> {
  await expect
    .poll(async () => ((await locator.boundingBox())?.width ?? 0) > 2, { message: why })
    .toBe(want);
}

/** The real bar's optional items, by the names an operator and a screen reader both use. */
function optionalItems(bar: Locator): Record<string, Locator> {
  return {
    search: bar.getByRole("textbox", { name: /^Filter sessions/ }),
    cost: bar.getByRole("button", { name: /^Spend - / }),
    feedback: bar.getByRole("button", { name: "Report product feedback", exact: true }),
    alerts: bar.getByRole("button", { name: /^Alerts & away mode/ }),
    sessions: bar.locator(".pulse-seg").filter({ hasText: /sessions?$/ }),
  };
}

test("the top bar hides and minimizes what Display says, previews it, and keeps it", async ({
  dashboard,
  daemon,
}) => {
  await seedCost(daemon);
  // Wide enough that the ladder sheds nothing on the default bar, so every "minimized" below
  // is the operator's choice and not the fit's.
  await dashboard.setViewportSize({ width: 1920, height: 1000 });
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);

  const bar = dashboard.locator("header.topbar");
  const items = optionalItems(bar);
  const pages = bar.getByRole("navigation", { name: "Pages" });
  const fleetWord = pages.getByRole("button", { name: "Fleet" }).locator(".tb-label");
  const libraryWord = pages.getByRole("button", { name: "Library" }).locator(".tb-label");
  const missionsWord = bar.getByRole("button", { name: /^Recurring missions/ }).locator(".tb-label");
  const foremanWord = bar.getByRole("button", { name: /^Foreman - / }).locator(".tb-label");

  // The default bar: every item present, every control at full size.
  for (const [name, item] of Object.entries(items)) {
    await expect(item, `${name} is on the default bar`).toHaveCount(1);
  }
  await expectDrawn(fleetWord, true, "Fleet draws its word by default");
  await expectDrawn(missionsWord, true, "Missions draws its word by default");
  await expectDrawn(foremanWord, true, "Foreman draws its word by default");

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const panel = dashboard.locator('[data-anchor="display/topbar"]');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByRole("heading", { name: "Top bar" })).toBeVisible();
  // What Minimized keeps is stated where the choice is made: the label goes, counts stay.
  await expect(panel.getByText(/Minimized hides the text label at every window width/)).toBeVisible();
  await expect(panel.getByText(/any count on the control stays visible/)).toBeVisible();
  await expect(
    panel.getByText("keeps its status dot, issue count and queue count", { exact: false }),
  ).toBeVisible();
  const preview = panel.locator(".topbar-preview");
  await expect(preview).toBeVisible();
  // The preview is the real bar, drawn with every optional item before anything is hidden.
  for (const selector of [".filter-box", ".spend-chip", ".feedback-btn", ".alertbar"]) {
    await expect(preview.locator(selector), `${selector} in the default preview`).toHaveCount(1);
  }
  await expect(preview.locator(".pulse-seg").filter({ hasText: /sessions$/ })).toHaveCount(1);
  await expect(preview.locator(".tb-compact")).toHaveCount(0);
  await shoot(panel, "01-panel-defaults");

  // Hide five optional items...
  for (const name of [
    "Search",
    "Cost estimate",
    "Report product feedback",
    "Alerts and away mode",
    "Session count",
  ]) {
    const box = panel.getByRole("checkbox", { name, exact: true });
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(box).not.toBeChecked();
  }
  // ...and minimize three controls, leaving Library expanded to prove the choice is per item.
  for (const name of ["Fleet", "Recurring missions", "Foreman"]) {
    const group = panel.getByRole("radiogroup", { name: `Top bar: ${name}` });
    await expect(group.getByRole("radio", { name: "Expanded" })).toBeChecked();
    // The segment's visible word, as a person clicks it: the radio itself is a 1px box kept
    // only for the accessibility tree, the same pattern the Board card spec drives.
    await group.getByText("Minimized", { exact: true }).click();
    await expect(group.getByRole("radio", { name: "Minimized" })).toBeChecked();
  }

  // The preview moved with the checklist, before the operator left the panel.
  for (const selector of [".filter-box", ".spend-chip", ".feedback-btn", ".alertbar"]) {
    await expect(preview.locator(selector), `${selector} still in the preview`).toHaveCount(0);
  }
  await expect(preview.locator(".pulse-seg").filter({ hasText: /sessions$/ })).toHaveCount(0);
  await expectDrawn(preview.locator(".page-seg-btn.tb-compact .tb-label"), false, "preview Fleet word");
  await expectDrawn(preview.locator(".missions-btn.tb-compact .tb-label"), false, "preview Missions word");
  await expectDrawn(preview.locator(".foreman-btn.tb-compact .tb-label"), false, "preview Foreman word");
  await expect(preview.locator(".tb-compact")).toHaveCount(3);
  await shoot(panel, "02-panel-customized");

  // A reload, so the bar below is read from the daemon's copy rather than this page's state.
  await dashboard.reload();
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  for (const [name, item] of Object.entries(items)) {
    await expect(item, `${name} is hidden from the bar`).toHaveCount(0);
  }
  // Not optional, and still there: the controls, and the pulse's live segment.
  await expect(bar.getByRole("button", { name: "Dispatch" })).toBeVisible();
  await expect(bar.getByRole("button", { name: /^Settings/ })).toBeVisible();
  await expect(bar.locator(".pulse")).toBeVisible();
  // Minimized: the word is not drawn, the control keeps its name, and Library is untouched.
  await expect(pages.getByRole("button", { name: "Fleet" })).toBeVisible();
  await expectDrawn(fleetWord, false, "Fleet is drawn as its glyph");
  await expectDrawn(missionsWord, false, "Missions is drawn as its glyph");
  await expectDrawn(foremanWord, false, "Foreman is drawn as its dot");
  await expectDrawn(libraryWord, true, "Library was left expanded and still draws its word");
  await shoot(bar, "03-bar-customized");

  // A customized bar still keeps to one row when the window narrows - the ladder still runs.
  await dashboard.setViewportSize({ width: 900, height: 800 });
  await expect
    .poll(() => bar.evaluate((el) => el.getBoundingClientRect().height), {
      message: "the customized bar stays on one row at 900px",
    })
    .toBeLessThan(80);
  // With five items gone the bar fits at 900px without shedding anything - which is the point
  // of hiding them. Narrower still, the ladder takes Library's word too: "expanded" means
  // expanded while there is room, exactly as the shipped bar behaves.
  await expectDrawn(libraryWord, true, "Library keeps its word while the slimmer bar fits");
  await dashboard.setViewportSize({ width: 560, height: 800 });
  await expectDrawn(libraryWord, false, "the ladder still minimizes Library when space runs out");
  await dashboard.setViewportSize({ width: 1920, height: 1000 });

  // Reset all puts the shipped bar back.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await panel.getByRole("button", { name: "Reset all" }).click();
  await expect(panel.getByRole("checkbox", { name: "Search", exact: true })).toBeChecked();
  await expect(
    panel.getByRole("radiogroup", { name: "Top bar: Fleet" }).getByRole("radio", { name: "Expanded" }),
  ).toBeChecked();
  await expect(panel.getByRole("button", { name: "Reset all" })).toHaveCount(0);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  for (const [name, item] of Object.entries(items)) {
    await expect(item, `${name} is back after Reset all`).toHaveCount(1);
  }
  await expectDrawn(fleetWord, true, "Fleet draws its word again");
  await expectDrawn(foremanWord, true, "Foreman draws its word again");
  await shoot(bar, "04-bar-reset");
});

test("hiding Search drops the term it held, so nothing filters the fleet unseen", async ({
  dashboard,
  daemon,
}) => {
  // No reload anywhere in this test. A reload resets the filter on its own, so a test that
  // reloaded before reading the box would pass whether or not hiding Search cleared it.
  // Wide enough that the ladder leaves the filter open rather than folded to its glyph.
  await dashboard.setViewportSize({ width: 1920, height: 1000 });
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const search = dashboard
    .locator("header.topbar")
    .getByRole("textbox", { name: /^Filter sessions/ });
  await search.fill("no-such-session");

  // A hash navigation keeps the dashboard's state, and the real bar is drawn above Settings
  // too - so the term is demonstrably still held when the operator reaches the panel.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await expect(search).toHaveValue("no-such-session");

  const panel = dashboard.locator('[data-anchor="display/topbar"]');
  const box = panel.getByRole("checkbox", { name: "Search", exact: true });
  await box.uncheck();
  await expect(search).toHaveCount(0);

  // Showing it again, on the same page, must hand back an empty box: the term was dropped
  // while the box was gone rather than kept, invisibly, filtering the fleet.
  await box.check();
  await expect(search).toHaveCount(1);
  await expect(search).toHaveValue("");
});

test("a minimized Foreman sheds its mode chip but still shows an issue count", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1920, height: 1000 });
  const pinned = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ compactTopbarItems: ["foreman"] }),
  });
  expect(pinned.ok, "the daemon accepted the minimized Foreman").toBe(true);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();

  const bar = dashboard.locator("header.topbar");
  const foreman = bar.getByRole("button", { name: /^Foreman - / });
  // Minimized with nothing wrong: the word and the mode chip both go, leaving the dot.
  await expect(foreman).toHaveClass(/\btb-compact\b/);
  await expect(foreman).not.toHaveClass(/\bhas-errors\b/);
  await expectDrawn(foreman.locator(".tb-label"), false, "the minimized Foreman drops its word");
  await expectDrawn(foreman.locator(".foreman-chip"), false, "the minimized Foreman drops its mode chip");

  // Now the daemon's own status answer with one health issue added - the shape Foreman's
  // worker reports when a review run fails. Scripted, because producing a real failure would
  // mean a real model call; everything after the reply is the production bar and stylesheet.
  await dashboard.route("**/api/foreman/status", async (route) => {
    const response = await route.fetch();
    const status = (await response.json()) as Record<string, unknown>;
    const now = Date.now();
    status.health = {
      revision: 1,
      truncated: false,
      reportedAt: now,
      current: true,
      issues: [{
        id: "review:scripted",
        operation: "review",
        runner: null,
        model: null,
        error: "scripted review failure",
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        sessions: [],
        sessionsTruncated: false,
      }],
    };
    await route.fulfill({ response, json: status });
  });
  await dashboard.reload();

  const troubled = bar.getByRole("button", { name: /^Foreman - .*, 1 issue$/ });
  await expect(troubled).toHaveClass(/\bhas-errors\b/);
  await expect(troubled).toHaveClass(/\btb-compact\b/);
  // Still minimized - the word stays hidden - but the issue count is drawn, not just present.
  await expectDrawn(troubled.locator(".tb-label"), false, "the troubled Foreman stays minimized");
  await expect(troubled.locator(".foreman-chip")).toHaveText("1 issue");
  await expectDrawn(troubled.locator(".foreman-chip"), true, "the issue count survives minimizing");
  await shoot(bar, "05-minimized-foreman-issue");
});
