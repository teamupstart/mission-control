import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Reports and inbox upgrades' browser assertion, against the shipped registry: its row appears in
// Settings > Feature flags, off by default, and switching it in one window reaches a second one
// without a reload. `inbox-display-name.spec.ts` drives the names it changes.
test("the Reports and inbox upgrades row appears off and its toggle reaches a second window without a reload", async ({ dashboard: page, context, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peer = await context.newPage();
  await peer.goto(page.url());
  let peerNavigations = 0;
  peer.on("framenavigated", (frame) => { if (frame === peer.mainFrame()) peerNavigations++; });
  const toggle = (window: Page) => window.getByRole("button", { name: /^Reports and inbox upgrades:/ });
  const stored = async () => ((await (await fetch(`${daemon.baseURL}/api/feature-flags`)).json()) as {
    config: { overrides: Record<string, boolean> };
  }).config.overrides.inbox;

  await expect(page.locator('[data-anchor="feature-flags/inbox"]')).toContainText("Reports and inbox upgrades");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(peer)).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(peer)).toBeEnabled();

  await toggle(page).click();
  await expect(toggle(page)).toHaveAccessibleName("Reports and inbox upgrades: on");
  await expect(toggle(peer)).toHaveAttribute("aria-pressed", "true");
  expect(await stored()).toBe(true);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(artifactsDir("inbox"), { recursive: true });
    await peer.locator('[data-anchor="feature-flags/inbox"]').screenshot({ path: join(artifactsDir("inbox"), "flag-on-peer.png") });
  }

  await toggle(peer).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  expect(await stored()).toBe(false);
  expect(peerNavigations, "the second window changed without navigating").toBe(0);

  // The panel's filter finds it by a keyword.
  await page.getByRole("textbox", { name: "Filter feature flags" }).fill("display name");
  await expect(toggle(page)).toBeVisible();
});
