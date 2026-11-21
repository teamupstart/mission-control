import { mkdirSync } from "node:fs";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

test("shipped flag row, live master and flag, reload, search and alpha link", async ({ dashboard: page, context, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const tabs = await page.getByRole("tab").allTextContents();
  expect(tabs.findIndex(text => text.includes("Feature flags"))).toBe(tabs.findIndex(text => text.includes("Setup")) + 1);
  // The shipped registry's first preview flag, off until the operator opts in.
  const requests = page.getByRole("button", { name: /^Session control requests:/ });
  await expect(requests).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: /^Save/ })).toHaveCount(0);
  const peer = await context.newPage();
  await peer.goto(page.url());
  const master = page.getByRole("checkbox", { name: /Enable all feature flags/ });
  const peerMaster = peer.getByRole("checkbox", { name: /Enable all feature flags/ });
  await expect(peerMaster).toBeEnabled();
  await expect(master).not.toBeChecked();
  await master.check();
  await expect(peerMaster).toBeChecked();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(master).toBeChecked();
  await master.uncheck();
  await expect(peerMaster).not.toBeChecked();
  // One flag's own click reaches the other window live, without a reload.
  let peerNavigations = 0;
  peer.on("framenavigated", frame => { if (frame === peer.mainFrame()) peerNavigations++; });
  const peerRequests = peer.getByRole("button", { name: /^Session control requests:/ });
  await requests.click();
  await expect(peerRequests).toHaveAttribute("aria-pressed", "true");
  await requests.click();
  await expect(peerRequests).toHaveAttribute("aria-pressed", "false");
  expect(peerNavigations).toBe(0);
  await page.getByRole("button", { name: "Search everything" }).click();
  await page.getByRole("combobox", { name: "Search everything" }).fill("Enable all feature flags");
  await page.getByRole("option", { name: /Enable all feature flags, setting/ }).click();
  await expect(page.locator('[data-anchor="feature-flags/enable-all"]')).toHaveClass(/settings-flash/);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(artifactsDir("feature-flags"), { recursive: true });
    await page.screenshot({ path: `${artifactsDir("feature-flags")}shipped.png` });
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
