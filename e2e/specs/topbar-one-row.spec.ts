import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The topbar stays on ONE row, and the ladder that keeps it there sheds no more than it had
 * to.
 *
 * This is the layer that catches it and the other three cannot. `topbar-ladder.test.ts` reads
 * the stylesheet and can prove a rung is well formed, but not that it fires, or that the bar
 * it fires on then fits. The Electron geometry tests measure a laid-out height but never run
 * the ladder against a real fleet. And the defect this spec exists for was invisible to all of
 * them: the rungs fired on the width the bar HAD, while whether they needed to fire depended
 * on the width its content NEEDED - so a bar that had been measured on an idle fleet wrapped
 * into two rows the moment a session started working, at the widths an operator actually uses.
 *
 * A wrapped bar is not cosmetic. `--topbar-h` is measured off this element and every
 * full-height surface sizes itself against it, so a second row takes ~45px off the
 * conversation underneath.
 */

/** The daemon's loopback token, which the cost ingest route requires. */
function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

/**
 * One priced datapoint, so the cost chip is on the bar.
 *
 * Not decoration: the chip is ~168px of the bar's width and it was added after the rungs were
 * last measured, which is part of why they no longer held.
 */
async function seedCost(daemon: DaemonHandle): Promise<void> {
  const attributes = [
    { key: "session.id", value: { stringValue: "topbar-row" } },
    { key: "model", value: { stringValue: "claude-sonnet-4-5" } },
    { key: "query_source", value: { stringValue: "main" } },
  ];
  const res = await fetch(`${daemon.baseURL}/v1/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{
            name: "claude_code.cost.usage",
            sum: {
              aggregationTemporality: 1,
              isMonotonic: true,
              dataPoints: [{
                asDouble: 181.77,
                startTimeUnixNano: `${Date.now() - 250}000000`,
                timeUnixNano: `${Date.now()}000000`,
                attributes,
              }],
            },
          }],
        }],
      }],
    }),
  });
  expect(res.ok, `/v1/metrics answered ${res.status}`).toBe(true);
}

/** The prompt `fake-claude.mjs` answers by raising an `AskUserQuestion` and blocking. */
const ASK_TURN = "ask me which linter to use";

/**
 * Put a BUSY fleet on the bar, and leave it there.
 *
 * The pulse is the one child of the bar whose width is a function of the fleet rather than of
 * the layout, and it is the whole reason a threshold cannot work: each segment is ~150px, so
 * `live · 0 sessions` is 165px and a fleet with every segment showing is 622px. A spec that
 * dispatched and moved on would measure the narrow end of that range and pass against the
 * exact ladder this change replaced.
 *
 * A dispatched agent is only `working` for as long as the fake takes to answer, which is not
 * long enough to assert against. Parking it on its own `AskUserQuestion` is stable: the
 * session sits in an attention tone with the question outstanding for as long as nobody
 * answers it, which holds `need you` on the readout indefinitely.
 */
async function busyFleet(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The combobox portals its listbox over the fields below and reopens on every keystroke.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("keep the title bar honest");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  const card = page.locator("article.card").first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Expand conversation" }).click();
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill(ASK_TURN);
  await composer.press("Enter");
  await expect(card.locator(".pane-dialog")).toBeVisible({ timeout: 15_000 });

  // `live · 1 session · 1 need you` - three segments, the same shape as the reported
  // screenshot's `live · 4 sessions · 2 working`, and ~146px wider than the two-segment idle
  // readout every threshold in the old ladder had been measured against. Asserted so the rest
  // of the spec cannot quietly degrade into measuring an idle bar and passing on the ladder
  // this change replaced.
  await expect(page.locator(".pulse .pulse-seg")).toHaveCount(3);
}

interface Bar {
  /** How many rows the bar's controls are laid out on. */
  rows: number;
  /** The rungs currently applied, e.g. `1 2 3`. */
  rung: string;
  /** The bar's own height, and the height it published for everything beneath it. */
  height: number;
  topbarH: string;
}

/**
 * Read the bar after letting the fit run.
 *
 * The wait is not slack. `ResizeObserver` delivers after layout and before paint, so a sample
 * taken between a viewport change and that delivery catches a bar the operator never sees -
 * which reads as an intermittent two-row failure at scattered widths.
 */
async function readBar(page: Page): Promise<Bar> {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  return await page.evaluate(() => {
    const bar = document.querySelector("header.topbar") as HTMLElement;
    const style = getComputedStyle(bar);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    // One row is as tall as the tallest control on it. A second row costs the 12px row-gap
    // plus a ~30px control, so this is never a close call.
    const tallest = Math.max(0, ...[...bar.children].map((k) => (k as HTMLElement).offsetHeight));
    return {
      rows: bar.clientHeight - padY > tallest + 2 ? 2 : 1,
      rung: bar.dataset.rung ?? "",
      height: bar.offsetHeight,
      topbarH: getComputedStyle(document.documentElement).getPropertyValue("--topbar-h").trim(),
    };
  });
}

/**
 * Assert whether an element is actually DRAWN, rather than clipped to the 1x1 visually-hidden
 * box a shed label keeps so it can hold on to its accessible name. Playwright counts that box
 * as visible, so `toBeVisible` cannot tell the two apart and the width has to be read.
 *
 * Polled, because one of these transitions: the filter animates back open over 160ms when it
 * takes focus. A single read right after the click lands mid-animation on a field that is
 * genuinely opening, which is a pass reported as a failure.
 */
async function expectDrawn(locator: Locator, want: boolean, why: string): Promise<void> {
  await expect
    .poll(async () => ((await locator.boundingBox())?.width ?? 0) > 2, { message: why })
    .toBe(want);
}

test("a working fleet keeps the title bar on one row at the width it used to stack at", async ({
  dashboard,
  daemon,
}) => {
  await seedCost(daemon);
  await busyFleet(dashboard, daemon);
  await expect(dashboard.getByRole("button", { name: /^Spend - / })).toBeVisible();

  // The reported width, in this browser's terms. The report came from the desktop shell,
  // where the bar is the window's title bar and gives up another ~45px to the traffic-light
  // inset, so the container it wrapped at (~1300px) sits behind a wider window than it does
  // here. Matching the CONTAINER is what makes this the reported case rather than a number
  // that happens to be in the screenshot's filename.
  await dashboard.setViewportSize({ width: 1360, height: 900 });
  const bar = await readBar(dashboard);
  expect(bar.rows, `the bar wrapped to ${bar.rows} rows`).toBe(1);
  expect(bar.topbarH, "--topbar-h must report the height the bar actually settled at")
    .toBe(`${bar.height}px`);

  // And it bought that row by collapsing the search, which is the cheapest ink on the bar -
  // not by stripping the controls beside it. Asserted by what is DRAWN: a shed label keeps a
  // 1x1 box so it keeps its accessible name, and Playwright counts that as visible.
  await expectDrawn(
    dashboard.getByPlaceholder("Filter (/)"),
    false,
    "the search field is still open, so the row was bought some other way",
  );
  await expectDrawn(
    dashboard.getByRole("button", { name: /^Fleet/ }).locator(".tb-label"),
    true,
    "the page segment lost its words, which this width did not need it to",
  );
  await expectDrawn(
    dashboard.locator(".pulse").getByText("need you"),
    true,
    "the pulse lost its words, which this width did not need it to",
  );
});

test("the search is still a working control once it has collapsed to its glyph", async ({
  dashboard,
  daemon,
}) => {
  await seedCost(daemon);
  await busyFleet(dashboard, daemon);
  // Narrower than the case above, so the field is collapsed with room to spare rather than
  // right on the width its rung fires at.
  await dashboard.setViewportSize({ width: 1200, height: 900 });

  const card = dashboard.locator("article.card");
  await expect(card).toHaveCount(1);
  const field = dashboard.getByPlaceholder("Filter (/)");
  await expectDrawn(field, false, "precondition: the field starts collapsed at this width");

  // The box is a <label>, so its glyph is the field's click target - that is what makes the
  // collapse a control instead of a dead icon.
  await dashboard.locator(".filter-box").click();
  await expect(field).toBeFocused();
  await expectDrawn(field, true, "clicking the glyph did not reopen the field");

  await field.fill("nothing matches this");
  await expect(card).toHaveCount(0);

  // And a filter that is actually filtering stays open when focus leaves, because a fleet
  // missing cards with nothing on screen saying why is worse than a wide bar.
  await dashboard.locator("header.topbar .brand").click();
  await expect(field).not.toBeFocused();
  await expectDrawn(field, true, "a field holding a term collapsed back to a glyph");

  await field.fill("");
  await expect(card).toHaveCount(1);
});

test("the bar never stacks until it has nothing left to shed, at any width", async ({
  dashboard,
  daemon,
}) => {
  await seedCost(daemon);
  await busyFleet(dashboard, daemon);

  // The invariant, stated without a magic number: at every width the bar is either on one row
  // or has already spent every rung it has. Anything else is a rung that fired too late -
  // which is exactly the bug, and exactly what a threshold cannot promise, since the width a
  // state stops fitting at moves ~150px with every pulse segment the fleet adds.
  const stacked: string[] = [];
  for (let width = 1900; width >= 760; width -= 20) {
    await dashboard.setViewportSize({ width, height: 900 });
    const bar = await readBar(dashboard);
    if (bar.rows === 1) continue;
    if (bar.rung === "1 2 3 4 5") continue;
    stacked.push(`${width}px (rungs applied: "${bar.rung}")`);
  }
  expect(stacked, "the bar stacked while it still had rungs in hand").toEqual([]);

  // The ladder is a ladder, not a ratchet: it has to give the words back on the way out. A
  // fit that only ever collapsed would satisfy the sweep above completely, and leave the bar
  // reading as a row of unnamed glyphs for the rest of the session.
  //
  // Read across 800 -> 1470 rather than out at 1900, because on this page the bar stops
  // growing long before the window does: `.app` caps at 1400px, so its container is pinned at
  // 1344px from there on and every width above it is the same bar.
  const word = dashboard.getByRole("button", { name: /^Fleet/ }).locator(".tb-label");
  await dashboard.setViewportSize({ width: 800, height: 900 });
  await readBar(dashboard);
  await expectDrawn(word, false, "precondition: a narrow window sheds the page segment's words");

  await dashboard.setViewportSize({ width: 1360, height: 900 });
  const back = await readBar(dashboard);
  expect(back.rows).toBe(1);
  await expectDrawn(word, true, "the words never came back when the room did");
});
