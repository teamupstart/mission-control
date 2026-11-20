import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// The first real flag's browser assertion, against the shipped registry: its row appears in
// Settings > Feature flags, and switching it in one window reaches a second one without a
// reload. The daemon's gate follows the same choice, so the shaping API opens and closes with it.
test("the Task shaping row appears and its toggle reaches a second window without a reload", async ({ dashboard: page, context, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peer = await context.newPage();
  await peer.goto(page.url());
  let peerNavigations = 0;
  peer.on("framenavigated", (frame) => { if (frame === peer.mainFrame()) peerNavigations++; });
  const toggle = (window: Page) => window.getByRole("button", { name: /^Task shaping:/ });
  const shapingStatus = async () => (await fetch(`${daemon.baseURL}/api/shaping`)).status;

  await expect(page.getByText("Task shaping", { exact: true })).toBeVisible();
  await expect(page.getByText("Call configured shapers before dispatch and add their context to a worker's first prompt.")).toBeVisible();
  await expect(page.getByText("No preview features right now. New ones appear here.")).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(peer)).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(peer)).toBeEnabled();
  expect(await shapingStatus(), "the shaping API is closed while the flag is off").toBe(404);

  await toggle(page).click();
  await expect(toggle(page)).toHaveAccessibleName("Task shaping: on");
  await expect(toggle(peer)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(shapingStatus).toBe(200);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(artifactsDir("task-shaping-flag"), { recursive: true });
    await peer.screenshot({ path: `${artifactsDir("task-shaping-flag")}peer-on.png` });
  }

  await toggle(peer).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect.poll(shapingStatus).toBe(404);
  expect(peerNavigations, "the second window changed without navigating").toBe(0);

  // The panel's filter finds it by a keyword.
  await page.getByRole("textbox", { name: "Filter feature flags" }).fill("shaper");
  await expect(toggle(page)).toBeVisible();
});
