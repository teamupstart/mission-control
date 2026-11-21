import { mkdirSync } from "node:fs";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

test("shipped async-input row, live toggle in a second window, master, reload, search and alpha link", async ({ dashboard: page, context, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const tabs = await page.getByRole("tab").allTextContents();
  expect(tabs.findIndex(text => text.includes("Feature flags"))).toBe(tabs.findIndex(text => text.includes("Setup")) + 1);
  // The first real flag: its row appears from the shipped registry, off by default.
  await expect(page.getByText("No preview features right now. New ones appear here.")).toHaveCount(0);
  const row = page.locator('[data-anchor="feature-flags/async-input"]');
  await expect(row).toContainText("Ask without stopping");
  await expect(page.getByRole("button", { name: /^Save/ })).toHaveCount(0);
  const peer = await context.newPage();
  await peer.goto(page.url());
  const pill = page.getByRole("button", { name: /^Ask without stopping:/ });
  const peerPill = peer.getByRole("button", { name: /^Ask without stopping:/ });
  await expect(pill).toHaveAccessibleName("Ask without stopping: off");
  await expect(peerPill).toHaveAccessibleName("Ask without stopping: off");
  const master = page.getByRole("checkbox", { name: /Enable all feature flags/ });
  const peerMaster = peer.getByRole("checkbox", { name: /Enable all feature flags/ });
  await expect(peerMaster).toBeEnabled();
  await expect(master).not.toBeChecked();
  await master.check();
  await expect(peerMaster).toBeChecked();
  // Enable all reaches the preview the stage left off.
  await expect(peerPill).toHaveAccessibleName("Ask without stopping: on");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(master).toBeChecked();
  await master.uncheck();
  await expect(peerMaster).not.toBeChecked();
  // Every peer-window assertion below is reached without a reload or navigation.
  let peerNavigations = 0;
  peer.on("framenavigated", (frame) => { if (frame === peer.mainFrame()) peerNavigations++; });
  await pill.click();
  await expect(peerPill).toHaveAccessibleName("Ask without stopping: on");
  await expect(peerPill).toHaveAttribute("aria-pressed", "true");
  const stored = await (await fetch(`${daemon.baseURL}/api/feature-flags`)).json() as { config: { overrides: Record<string, boolean> } };
  expect(stored.config.overrides["async-input"]).toBe(true);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(artifactsDir("feature-flags"), { recursive: true });
    await peer.screenshot({ path: `${artifactsDir("feature-flags")}async-input-on-peer.png` });
  }
  await peerPill.click();
  await expect(pill).toHaveAccessibleName("Ask without stopping: off");
  expect(peerNavigations).toBe(0);
  await page.getByRole("button", { name: "Search everything" }).click();
  await page.getByRole("combobox", { name: "Search everything" }).fill("Enable all feature flags");
  await page.getByRole("option", { name: /Enable all feature flags, setting/ }).click();
  await expect(page.locator('[data-anchor="feature-flags/enable-all"]')).toHaveClass(/settings-flash/);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(artifactsDir("feature-flags"), { recursive: true });
    await page.screenshot({ path: `${artifactsDir("feature-flags")}panel.png` });
  }
  // The alpha control belongs to the desktop bridge, not to the daemon.
  await page.addInitScript(() => Object.defineProperty(window, "missionDesktop", { value: {
    isDesktop: true, version: async () => "1.2.3", onOpenSettings: () => () => {},
    updates: { getState: async () => ({ phase: "up-to-date", alpha: true, currentVersion: "1.2.3" }),
      setAlpha: async () => {}, onState: () => () => {} },
  } }));
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await page.reload();
  await expect(page.getByText("Alpha builds do not turn on preview features.", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Feature flags" }).click();
  await expect(master).not.toBeChecked();
});
