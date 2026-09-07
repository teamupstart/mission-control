import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
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

const EVIDENCE = artifactsDir("topbar-one-row");

test("the desktop title bar keeps its brand clear of the native window controls", async ({
  dashboard,
}) => {
  // The ordinary E2E browser has no native shell. Apply the class that main.tsx derives from
  // the preload bridge; desktop-preload-electron.test.ts owns that preceding bridge boundary.
  await dashboard.evaluate(() => document.documentElement.classList.add("is-desktop"));
  await dashboard.setViewportSize({ width: 1000, height: 700 });

  const topbar = dashboard.locator("header.topbar");
  const brand = topbar.locator(".brand");
  await expect(brand).toBeVisible();
  const left = (await brand.boundingBox())?.x ?? 0;

  // Electron pins the last macOS traffic light inside the first 80px. The full-width
  // Console and Board shells reserve 84px so the app mark never paints beneath it.
  expect(left, `the brand starts at x=${left}px inside the native controls`).toBeGreaterThanOrEqual(84);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.mouse.move(0, 200);
    await topbar.screenshot({ path: `${EVIDENCE}desktop-traffic-light-inset.png` });
    console.log(`CAPTURED ${EVIDENCE}desktop-traffic-light-inset.png (brand x=${left}px)`);
  }
});

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
 * answers it, which holds `need you` and `to answer` on the readout indefinitely.
 */
async function busyFleet(page: Page, daemon: DaemonHandle): Promise<number> {
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

  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = page.locator(".console-detail");
  await expect(card).toBeVisible();
  await expect(card.locator(".badge-idle")).toBeVisible({ timeout: 15_000 });
  await expect(card).toBeVisible();
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill(ASK_TURN);
  await composer.press("Enter");
  await expect(card.locator(".pane-dialog")).toBeVisible({ timeout: 15_000 });

  // `live · 1 session · 1 need you · 1 to answer` - four segments. A session parked on a
  // pane dialog raises both amber figures since the attention pills were reconciled: `need
  // you` counts the session, `to answer` counts the dialog the inbox can now drain. That is
  // wider still than the three-segment readout this spec was first measured against, and
  // ~300px wider than the two-segment idle readout every threshold in the old ladder had been
  // measured against. Asserted so the rest of the spec cannot quietly degrade into measuring
  // an idle bar and passing on the ladder this change replaced.
  await expect(page.locator(".pulse .pulse-seg")).toHaveCount(4);
  await expect(
    page
      .getByRole("button", { name: "Foreman - the auto-responder (dry-run)" })
      .locator(".ghost-badge"),
  ).toHaveText("1");

  // The fourth segment is width the reported bar did not carry: the report's fleet read
  // `live · 4 sessions · 2 working` - three segments - and every pinned width below was
  // calibrated against that shape. Handing back its measured width lets the tests keep
  // pinning the reported CASE - a bar exactly this side of a rung - rather than the reported
  // number, which the busier readout has moved by one segment. Measured, not a constant,
  // because it moves with font metrics: the segment is ~146px in this browser and ~20px wider
  // on CI's Linux fonts, which is exactly the difference that made a constant fail there
  // while passing here.
  return await page.evaluate(() => {
    const seg = [...document.querySelectorAll(".pulse .pulse-seg")].find((el) =>
      (el.textContent ?? "").includes("to answer"),
    ) as HTMLElement | undefined;
    // +1 for the hairline divider the extra segment brought with it.
    return seg ? Math.ceil(seg.offsetWidth) + 1 : 0;
  });
}

interface Bar {
  /** How many rows the bar's controls are laid out on. */
  rows: number;
  /** The rungs currently applied, e.g. `1 2 3`. */
  rung: string;
  /** The bar's own height, and the height it published for everything beneath it. */
  height: number;
  topbarH: string;
  /** The room the bar has, and how much text it is carrying - the fit's two guards. */
  container: number;
  textLength: number;
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
      container: Math.round(
        bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      ),
      textLength: (bar.textContent ?? "").length,
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

/**
 * Why no assertion here pins the EXACT rung the bar settles at, and why the page segment's
 * words are no longer asserted drawn at any wide width:
 *
 * With the reconciled pills the busy fixture carries four pulse segments, and on CI's font
 * stack that bar's rung-3 content comes within a few pixels of the widest container this
 * page allows (`.app` caps at 1400px, so the bar is pinned at ~1344px from ~1470px of window
 * on - no viewport makes it wider). A few pixels is less than the bar moves on its own: the
 * connection segment swaps `live` for `reconnecting` when an SSE drop happens (the is-down
 * compensation cancels all but ~4px of it), and a re-fit walked during the same commit as a
 * content change measures mid-transition geometry. On that knife-edge the SAME width and the
 * SAME content settle on rung 3 or rung 4 depending on which fit ran last - both correct to
 * within a pixel, so a spec that demands one of them is asserting a rounding direction, and
 * it failed on CI exactly that way while passing on macOS's narrower fonts.
 *
 * So the wide-bar assertions here stick to claims with real margin: the bar is on ONE row,
 * the search is collapsed (needed at every one of these widths), the PULSE's words are drawn
 * (rung 5 is ~400px away from the pin), and the ladder gives rungs back when room returns.
 * "It shed no more than it had to" is owned by the sweep's invariant, which never pins a
 * width at all.
 */

test("a working fleet keeps the title bar on one row at the width it used to stack at", async ({
  dashboard,
  daemon,
}) => {
  await seedCost(daemon);
  const extra = await busyFleet(dashboard, daemon);
  await expect(dashboard.getByRole("button", { name: /^Spend - / })).toBeVisible();

  // The reported width, in this browser's terms. The report came from the desktop shell,
  // where the bar is the window's title bar and gives up another ~45px to the traffic-light
  // inset, so the container it wrapped at (~1300px) sits behind a wider window than it does
  // here. Matching the CONTAINER is what makes this the reported case rather than a number
  // that happens to be in the screenshot's filename - and the container is widened by the
  // segment this fixture carries that the reported bar did not, so the bar's ROOM relative
  // to its content is the reported one.
  await dashboard.setViewportSize({ width: 1360 + extra, height: 900 });
  const bar = await readBar(dashboard);

  // Photographed BEFORE the assertion, so the same command run against the commit this fixes
  // produces the two-row frame rather than stopping at a red assertion with nothing to look
  // at. "One row" is checkable in the DOM as a height; it is only legible as a title bar here.
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.mouse.move(0, 0); // Tooltip portals a bubble under a resting pointer.
    await dashboard.locator("header.topbar").screenshot({ path: `${EVIDENCE}topbar-1360.png` });
    console.log(`CAPTURED ${EVIDENCE}topbar-1360.png (${bar.rows} row(s), ${bar.height}px)`);
  }

  expect(bar.rows, `the bar wrapped to ${bar.rows} rows`).toBe(1);
  expect(bar.topbarH, "--topbar-h must report the height the bar actually settled at")
    .toBe(`${bar.height}px`);

  // And it bought that row by collapsing the search, which is the cheapest ink on the bar -
  // never by stripping the readout an operator scans. Asserted by what is DRAWN: a shed
  // label keeps a 1x1 box so it keeps its accessible name, and Playwright counts that as
  // visible. The page segment's words are deliberately NOT asserted here - see the
  // knife-edge note above busyFleet's callers.
  await expectDrawn(
    dashboard.getByPlaceholder("Filter (/)"),
    false,
    "the search field is still open, so the row was bought some other way",
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

  const card = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row");
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

test("a font-metrics change re-fits the bar, though neither guard can see it", async ({
  dashboard,
  daemon,
}) => {
  await seedCost(daemon);
  const extra = await busyFleet(dashboard, daemon);
  await dashboard.setViewportSize({ width: 1360 + extra, height: 900 });

  const before = await readBar(dashboard);
  expect(before.rows, "precondition: the bar starts on one row").toBe(1);

  // A browser minimum font size, which some browsers apply over explicit `px` values. It is
  // the awkward case for a measured ladder because it reaches the bar without going through
  // React and without moving the bar's own width: the children get bigger, the bar is pinned
  // by its parent, and the text is untouched. Both of the fit's guards are blind to it - the
  // render path keys on available width and text length, and the observer used to treat every
  // block-size-only notification as its own fit settling and skip the re-fit. The bar wrapped
  // and stayed wrapped for the life of the page.
  await dashboard.addStyleTag({ content: "header.topbar * { font-size: 18px !important }" });
  const after = await readBar(dashboard);

  // Asserted, not assumed: if the injection moved either of these, the observer's ordinary
  // resize path would have caught it and this test would be passing for the wrong reason,
  // guarding nothing.
  expect(after.container, "the bar's own width moved, so this is not the case under test")
    .toBe(before.container);
  expect(after.textLength, "the bar's text moved, so this is not the case under test")
    .toBe(before.textLength);

  expect(after.rows, `the bar wrapped to ${after.rows} rows and did not re-fit`).toBe(1);
  // Spending a rung would prove the re-fit ran rather than the bar having had room to spare -
  // but which rung the busy bar STARTS on sits on the knife-edge described above busyFleet's
  // callers, so strictly-greater flakes when `before` lands a rung deep. Greater-or-equal
  // keeps the ratchet direction honest, and the regression this test exists for cannot slip
  // through it: a fit that never re-ran leaves the 18px bar WRAPPED, and the rows assert
  // above is the one that catches it.
  expect(after.rung.split(" ").length).toBeGreaterThanOrEqual(before.rung.split(" ").length);
  expect(after.topbarH, "--topbar-h did not follow the bar through the re-fit")
    .toBe(`${after.height}px`);
});

test("the bar never stacks until it has nothing left to shed, at any width", async ({
  dashboard,
  daemon,
}) => {
  await seedCost(daemon);
  const extra = await busyFleet(dashboard, daemon);

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

  // The ladder is a ladder, not a ratchet: it has to give rungs back on the way out. A fit
  // that only ever collapsed would satisfy the sweep above completely, and leave the bar
  // reading as a row of unnamed glyphs for the rest of the session.
  //
  // What "back" can honestly mean is bounded by the knife-edge note above busyFleet's
  // callers: whether the widest bar releases the page segment's words is a rounding
  // direction on CI's fonts, so the ratchet check is made on claims with margin - the rung
  // list SHRANK from the narrow bar's, and the pulse's own words returned (rung 5 is the
  // deepest rung and ~400px clear of the pin).
  const pulseWords = dashboard.locator(".pulse").getByText("need you");
  await dashboard.setViewportSize({ width: 800, height: 900 });
  const narrow = await readBar(dashboard);
  await expectDrawn(pulseWords, false, "precondition: a narrow window sheds the pulse's words");

  await dashboard.setViewportSize({ width: 1360 + extra, height: 900 });
  const back = await readBar(dashboard);
  expect(back.rows).toBe(1);
  expect(
    back.rung.split(" ").filter(Boolean).length,
    `the wide bar still holds the narrow bar's rungs ("${back.rung}" after "${narrow.rung}")`,
  ).toBeLessThan(narrow.rung.split(" ").filter(Boolean).length);
  await expectDrawn(pulseWords, true, "the pulse's words never came back when the room did");
});
