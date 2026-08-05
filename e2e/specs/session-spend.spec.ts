import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * What a driven session's work COSTS, from the turn that spent it to the figure in the topbar.
 *
 * The regression this exists for was invisible in every other layer. The Spend popover showed
 * an Automation line with real money on it and no session spend at all - a fleet of working
 * agents reading as if it had cost nothing - because Claude session spend had exactly one
 * writer, Claude Code's OpenTelemetry export, and that export had stopped producing. Nothing
 * errored. The ledger cannot tell "nothing was spent" from "nobody wrote it down", so the
 * dashboard rendered the second as the first.
 *
 * Only this layer catches it. The unit tests can prove `claudeTurnUsage` parses a frame and
 * that `applyDriverEvent` writes a row; the HTTP tests can prove `/v1/metrics` lands in the
 * ledger. None of them can prove that a session someone dispatched ends up with a number in
 * the topbar, which is the only form the bug ever took.
 *
 * So the spend here is never seeded through a route. It is EARNED: a real dispatch, a real SDK
 * session, a real `result` frame off the fake CLI's stream carrying the same `uuid`,
 * `modelUsage` and `total_cost_usd` keys the vendor emits. The fake spends no tokens and the
 * accounting path is otherwise untouched.
 */

const TASK = "write a haiku about flexbox";

const EVIDENCE = fileURLToPath(new URL("../../docs/evidence/session-spend/", import.meta.url));

/** The daemon's loopback token, for the routes that require it. */
function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

/**
 * Photograph a surface for the evidence packet, when asked.
 *
 * Gated on `MC_E2E_EVIDENCE` exactly as `dispatch-and-converse.spec.ts` gates its own captures:
 * the assertions above each call are what run in CI, and the screenshot is a by-product for a
 * reviewer who cannot run the suite. A capture is never the assertion - a PNG proves a pixel
 * existed, not that a figure was correct - so the file is only ever written beside an
 * expectation that already checked the number.
 */
async function capture(target: Locator | Page, name: string, observed: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Park the pointer in the corner first. Clicking the chip leaves the cursor on it, and
  // `Tooltip` portals its bubble to the body at a high z-index - so a capture taken straight
  // after the click photographs a tooltip clipped across the popover's own heading, which
  // obscures the very figure the image exists to show. Unhovering is not cosmetic here: the
  // reviewer is meant to read `Fleet today`, not a half-rendered bubble on top of it.
  const page = "mouse" in target ? target : target.page();
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0);
  console.log(`OBSERVED ${observed}`);
  await target.screenshot({ path: join(EVIDENCE, name) });
  console.log(`CAPTURED docs/evidence/session-spend/${name}`);
}

/**
 * Dispatch one agent and wait for its card.
 *
 * The Escape after the repo field is load-bearing: `RepoCombobox` portals its listbox over the
 * Task field below it, so the next `fill` would land on a covered control. Its own handler
 * calls `stopPropagation`, so this closes the list and not the modal.
 */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.getByLabel("Kind").selectOption("ship");
  // Pinned to none, or the daemon's configured default applies and this repo is not
  // allowlisted for Live delivery, which refuses the dispatch outright.
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("article.card")).toHaveCount(1);
}

test("a dispatched session's turn puts real money in the topbar", async ({
  dashboard,
  daemon,
}) => {
  // Asserted first so the appearance below is a change and not a coincidence: with no work
  // done, there is no chip at all rather than a confident $0.00 for an unmeasured fleet.
  const chip = dashboard.getByRole("button", { name: /^Spend - / });
  await expect(chip).toHaveCount(0);

  await dispatch(dashboard, daemon);

  // The turn the dispatch itself runs reports $2.50 on its `result` frame. Nothing was posted
  // to `/v1/metrics` and no OTel exporter is involved - this is the driver's own stream.
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("≈$2.50");

  // The bar at rest, photographed BEFORE the click. Taken afterwards it catches a sliver of the
  // open popover along its bottom edge, because the popover is anchored inside the header's own
  // box - which makes a capture meant to show the chip alone look like a rendering fault.
  await capture(
    dashboard.locator("header.topbar"),
    "topbar-chip-session.png",
    "the topbar chip carries ≈$2.50 from a driven session, with no OTel exporter involved",
  );

  await chip.click();
  const popover = dashboard.getByRole("dialog", { name: "Spend today" });
  await expect(popover).toBeVisible();

  // The line that was empty in the bug. Scoped inside the popover because `Tooltip` portals a
  // hidden copy of each tip into the body, so an unscoped text locator matches twice.
  await expect(popover.locator(".spend-row", { hasText: "Fleet today" })).toContainText("≈$2.50");
  // Tokens ride the same rows, so the breakdown is proof the per-model view was read and not
  // just the total: 1,000 input + 500 output + 20,000 cache read + 3,000 cache write = 24,500,
  // which `compactTokens` rounds to the nearest thousand.
  await expect(popover.locator(".spend-row", { hasText: "Tokens today" })).toContainText("25k");

  // And it is SESSION spend, not the automation line. The distinction is the whole complaint:
  // automation was the only thing being counted.
  await expect(popover.locator(".spend-row.is-automation")).toHaveCount(0);

  await capture(
    popover,
    "spend-popover-session.png",
    "Fleet today reads ≈$2.50 and Tokens today 25k, earned by one dispatched turn, with no Automation line",
  );
});

test("the session's own card carries what that session cost", async ({ dashboard, daemon }) => {
  // The fleet total is an aggregate, so it would still read correctly if every row were filed
  // under the wrong note key. This is what proves the attribution: the row reached the card
  // that earned it, through `noteKeyFor` and the driver's `bound` event.
  await dispatch(dashboard, daemon);

  const card = dashboard.locator("article.card").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Agent SDK");
  await expect(card.getByText(/\$2\.50/)).toBeVisible();

  await capture(
    card,
    "session-card-cost.png",
    "the dispatched session's own card carries ≈$2.50, so the row reached the card that earned it",
  );
});

test("Cost settings names the sessions telemetry is not covering", async ({
  dashboard,
  daemon,
}) => {
  // The state with no other symptom, and the reason it gets a warning of its own. Session
  // spend is landing, so every signal a person would think to check reads healthy - the switch
  // is on, the env block is in the file, the topbar has numbers on it - while Claude Code's
  // exporter has never delivered. The numbers are therefore ONLY the sessions Mission Control
  // drives, and anything a human started in a terminal is missing from a total that looks
  // complete. Before this, nothing on screen said so.
  const res = await fetch(`${daemon.baseURL}/api/cost/config`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ enabled: true }),
  });
  expect(res.ok, `enabling cost telemetry answered ${res.status}`).toBe(true);

  await dispatch(dashboard, daemon);

  const chip = dashboard.getByRole("button", { name: /^Spend - / });
  await expect(chip).toBeVisible();
  await chip.click();
  await dashboard
    .getByRole("dialog", { name: "Spend today" })
    .getByRole("button", { name: "Cost settings" })
    .click();
  await expect(dashboard).toHaveURL(/#\/settings\/cost$/);

  // Names which sessions are uncounted, rather than claiming telemetry is fine or that
  // nothing has reported.
  const warning = dashboard.getByText(
    /Claude Code has never exported telemetry to this daemon/,
  );
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("only sessions Mission Control runs");
  await expect(warning).toContainText("Sessions you started yourself in a terminal are not counted");

  // And NOT the first-run hint, which would be a contradiction: spend has plainly reported.
  await expect(dashboard.getByText(/No Claude telemetry has reported yet/)).toHaveCount(0);

  await capture(
    dashboard.locator("section.settings-section").first(),
    "cost-settings-warning.png",
    "Cost settings names the uncounted sessions while the toggle is on and spend is landing",
  );
});
