import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The topbar's cost surface, driven the way an operator meets it: telemetry arrives on the
 * daemon's own ingest routes, the chip appears in the bar, and the figures behind it are one
 * click away.
 *
 * This is the layer the other three cannot reach. `renderToStaticMarkup` proves the popover's
 * markup shape and its degradation rules, but not that anything opens it; the in-process HTTP
 * tests prove `/v1/metrics` lands in the ledger, but not that the number reaches a pixel. Only
 * here does a POST become an SSE frame become a chip, and a click become a dialog.
 *
 * Every figure is seeded through a route rather than written to SQLite, because the emission is
 * the thing under test: `recomputeFleetCost` is what turns an ingest into a `cost_fleet` frame,
 * and a row inserted behind its back would only surface on a reload.
 */

/** The daemon's loopback token, which the two guarded ingest routes require. */
function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

async function post(
  daemon: DaemonHandle,
  path: string,
  body: unknown,
  auth = true,
): Promise<void> {
  const res = await fetch(`${daemon.baseURL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { "x-harness-token": token(daemon) } : {}),
    },
    body: JSON.stringify(body),
  });
  expect(res.ok, `${path} answered ${res.status}`).toBe(true);
}

/**
 * One OTel cost datapoint, stamped now.
 *
 * `estimatedCostToday` counts from local midnight and `estimatedBurnPerHour` from an hour
 * ago, so a datapoint at `Date.now()` lands inside both windows and the chip gets both of
 * its figures from one post. The value is chosen so every rendered string is an exact
 * literal: $4.25 today, over 1 PR, is also $4.25 per PR.
 */
function costMetrics(sessionId: string, usd: number, tokens?: number): unknown {
  const attributes = (extra: Record<string, string> = {}) => [
    { key: "session.id", value: { stringValue: sessionId } },
    { key: "model", value: { stringValue: "claude-sonnet-4-5" } },
    { key: "query_source", value: { stringValue: "main" } },
    ...Object.entries(extra).map(([key, value]) => ({ key, value: { stringValue: value } })),
  ];
  const point = (asDouble: number, extra?: Record<string, string>) => ({
    asDouble,
    startTimeUnixNano: `${Date.now() - 250}000000`,
    timeUnixNano: `${Date.now()}000000`,
    attributes: attributes(extra),
  });
  const metric = (name: string, dataPoints: unknown[]) => ({
    name,
    sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints },
  });
  return {
    resourceMetrics: [{
      scopeMetrics: [{
        metrics: [
          metric("claude_code.cost.usage", [point(usd)]),
          ...(tokens === undefined
            ? []
            : [metric("claude_code.token.usage", [point(tokens, { type: "input" })])]),
        ],
      }],
    }],
  };
}

test("the cost chip replaces the usage row and opens the spend popover", async ({
  dashboard,
  daemon,
}) => {
  // Before any telemetry: no chip at all, rather than a confident $0.00 for a fleet that
  // simply has not been measured. Asserted first so the appearance below means something.
  const chip = dashboard.getByRole("button", { name: /^Spend - / });
  await expect(chip).toHaveCount(0);

  await post(daemon, "/v1/metrics", costMetrics("cost-chip-session", 4.25));

  await expect(chip).toBeVisible();
  await expect(chip).toContainText("≈$4.25");
  await expect(chip).toHaveAttribute("aria-expanded", "false");

  // The retired second row. It is gone from the header entirely - not folded, not empty -
  // and the header is one row of controls again.
  await expect(dashboard.locator("header.topbar .topbar-usage")).toHaveCount(0);
  await expect(dashboard.getByRole("button", { name: /^Usage/ })).toHaveCount(0);

  // The chip is a real disclosure control, not a link: it says what it controls, and the
  // popover is a labelled dialog.
  const popover = dashboard.getByRole("dialog", { name: "Spend today" });
  await expect(popover).toBeHidden();
  await chip.click();
  await expect(popover).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "true");

  // Every fact the retired strip carried, scoped INSIDE the popover - `Tooltip` portals a
  // hidden copy of each tip into the body, so an unscoped text locator matches twice.
  await expect(popover.locator(".spend-row", { hasText: "Fleet today" })).toContainText("≈$4.25");
  await expect(popover.locator(".spend-row", { hasText: "Rate now" })).toContainText("$4.25/hr");

  // Escape closes it, and closes only it: the fleet behind is untouched and the chip is
  // still there to reopen.
  await dashboard.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await expect(chip).toBeVisible();
});

test("the popover carries the tokens, the automation line and every quota runway", async ({
  dashboard,
  daemon,
}) => {
  await post(daemon, "/v1/metrics", costMetrics("cost-chip-full", 12.4, 8_400_000));

  // The app's own overhead, attributed by role. Not a session, and never folded into the
  // fleet's own figure - the popover states both, separately.
  await post(
    daemon,
    "/api/usage/automation",
    {
      role: "inspector:review",
      runner: "claude",
      runId: "e2e-inspector-run",
      ts: Date.now(),
      models: [{
        modelId: "claude-sonnet-4-5",
        input: 12_000,
        output: 3_400,
        reasoningOutput: 0,
        cacheRead: 88_000,
        cacheWrite: 4_000,
        reportedCostUsd: 1.85,
      }],
    },
    false, // loopback-only route; it takes no token
  );

  // A subscription's quota windows, which are the only forward-looking thing on the surface.
  const nowSec = Math.floor(Date.now() / 1000);
  await post(daemon, "/statusline", {
    sessionId: "cost-chip-full",
    env: {},
    rateLimits: {
      fiveHour: { usedPercentage: 62, resetsAt: nowSec + 2 * 3600 },
      sevenDay: { usedPercentage: 31, resetsAt: nowSec + 4 * 86_400 },
    },
  });

  const chip = dashboard.getByRole("button", { name: /^Spend - / });
  await expect(chip).toBeVisible();
  await chip.click();

  const popover = dashboard.getByRole("dialog", { name: "Spend today" });
  await expect(popover).toBeVisible();

  await expect(popover.locator(".spend-row", { hasText: "Fleet today" })).toContainText("≈$12.40");
  await expect(popover.locator(".spend-row", { hasText: "Tokens today" })).toContainText("8.4M");
  // The overhead, with the role split printed under it rather than hidden in a tooltip.
  await expect(popover.locator(".spend-row", { hasText: "Automation" })).toContainText("≈$1.85");
  await expect(popover.locator(".spend-sub")).toContainText("GitHub Inspector review $1.85");

  // Both quota windows, each with its consumption and its projection in one figure.
  const runways = popover.locator(".spend-runway");
  await expect(runways).toHaveCount(2);
  await expect(runways.first()).toContainText("Claude · 5-hr window");
  await expect(runways.first()).toContainText("62%");
  await expect(runways.nth(1)).toContainText("Claude · 7-day window");

  // And the way to the setting that governs all of it. The popover closes with the page it
  // navigated away from.
  await popover.getByRole("button", { name: "Cost settings" }).click();
  await expect(dashboard).toHaveURL(/#\/settings\/cost$/);
  await expect(popover).toBeHidden();
});

test("a quota window about to close escalates the chip and names itself on it", async ({
  dashboard,
  daemon,
}) => {
  // The one thing the retired row kept permanently on screen was the runway, and hiding it
  // behind a click is only safe if the chip itself raises its hand. 96% used with 20 minutes
  // left is not a window that resets in time.
  await post(daemon, "/v1/metrics", costMetrics("cost-chip-alarm", 3.1));
  const chip = dashboard.getByRole("button", { name: /^Spend - / });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("$3.10/hr");

  const nowSec = Math.floor(Date.now() / 1000);
  await post(daemon, "/statusline", {
    sessionId: "cost-chip-alarm",
    env: {},
    rateLimits: { fiveHour: { usedPercentage: 96, resetsAt: nowSec + 20 * 60 } },
  });

  // The quota reading takes the rate's slot, so the colour has its subject beside it rather
  // than tinting a dollar figure that has not changed.
  await expect(chip).toContainText("96%");
  await expect(chip).not.toContainText("$3.10/hr");
  // And it is not colour alone: the name says which window and how bad.
  await expect(
    dashboard.getByRole("button", { name: /Claude · 5-hr window 96% used, nearly exhausted/ }),
  ).toBeVisible();
});

test("a fleet with no priced usage still gets a chip that opens onto its runway", async ({
  dashboard,
  daemon,
}) => {
  // An API-key user, or a subscription before its first billable turn: no dollars at all,
  // but a quota window that can still close mid-task. That window is the reason this surface
  // exists, so it must not be unreachable just because nothing has cost anything yet.
  const nowSec = Math.floor(Date.now() / 1000);
  await post(daemon, "/statusline", {
    sessionId: "cost-chip-quota-only",
    env: {},
    rateLimits: { fiveHour: { usedPercentage: 55, resetsAt: nowSec + 3600 } },
  });

  const chip = dashboard.getByRole("button", { name: /^Spend - / });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Spend");

  await chip.click();
  const popover = dashboard.getByRole("dialog", { name: "Spend today" });
  await expect(popover.locator(".spend-runway")).toHaveCount(1);
  // No money rows at all, rather than a row of dashes claiming a measured zero.
  await expect(popover.locator(".spend-rows")).toHaveCount(0);

  // A click outside dismisses it, the way every other topbar popover does.
  await dashboard.locator("header.topbar .brand").click();
  await expect(popover).toBeHidden();
});
