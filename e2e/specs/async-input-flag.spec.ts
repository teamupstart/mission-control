import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Ask without stopping's browser assertion, against the shipped registry: its row appears in
// Settings > Feature flags, off by default, and switching it in one window reaches a second one
// without a reload. The daemon reads the same stored choice for every ask
// (`async-input-ask-and-continue.spec.ts` drives what it changes).
test("the Ask without stopping row appears and its toggle reaches a second window without a reload", async ({ dashboard: page, context, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peer = await context.newPage();
  await peer.goto(page.url());
  let peerNavigations = 0;
  peer.on("framenavigated", (frame) => { if (frame === peer.mainFrame()) peerNavigations++; });
  const toggle = (window: Page) => window.getByRole("button", { name: /^Ask without stopping:/ });
  const stored = async () => ((await (await fetch(`${daemon.baseURL}/api/feature-flags`)).json()) as {
    config: { overrides: Record<string, boolean> };
  }).config.overrides["async-input"];

  await expect(page.locator('[data-anchor="feature-flags/async-input"]')).toContainText("Ask without stopping");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(peer)).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(peer)).toBeEnabled();

  await toggle(page).click();
  await expect(toggle(page)).toHaveAccessibleName("Ask without stopping: on");
  await expect(toggle(peer)).toHaveAttribute("aria-pressed", "true");
  expect(await stored()).toBe(true);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(artifactsDir("feature-flags"), { recursive: true });
    await peer.screenshot({ path: `${artifactsDir("feature-flags")}async-input-on-peer.png` });
  }

  await toggle(peer).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  expect(await stored()).toBe(false);
  expect(peerNavigations, "the second window changed without navigating").toBe(0);

  // The panel's filter finds it by a keyword.
  await page.getByRole("textbox", { name: "Filter feature flags" }).fill("request_input");
  await expect(toggle(page)).toBeVisible();
});
