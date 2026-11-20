import { mkdirSync } from "node:fs";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

test("shipped preview, live master and individual changes, reload, search and alpha link", async ({ dashboard: page, context, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const tabs = await page.getByRole("tab").allTextContents();
  expect(tabs.findIndex(text => text.includes("Feature flags"))).toBe(tabs.findIndex(text => text.includes("Setup")) + 1);
  const nativeOff = { name: "Codex resident native MCP: off" };
  const nativeOn = { name: "Codex resident native MCP: on" };
  await expect(page.getByRole("button", nativeOff)).toBeVisible();
  const prOff = { name: "Automatic PR branch updates: off" };
  await expect(page.getByRole("button", prOff)).toHaveAttribute("aria-pressed", "false");
  // Resident active hours ships as a preview too, off until the operator chooses it.
  const activeHours = page.getByRole("button", { name: /^Resident active hours:/ });
  await expect(activeHours).toHaveAttribute("aria-pressed", "false");
  // So does Task shaping. `task-shaping-flag.spec.ts` drives its row and the API gate itself.
  await expect(page.getByRole("button", { name: "Task shaping: off" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Save/ })).toHaveCount(0);
  const peer = await context.newPage();
  await peer.goto(page.url());
  let peerNavigations = 0;
  peer.on("framenavigated", frame => { if (frame === peer.mainFrame()) peerNavigations++; });
  const peerActiveHours = peer.getByRole("button", { name: /^Resident active hours:/ });
  const master = page.getByRole("checkbox", { name: /Enable all feature flags/ });
  const peerMaster = peer.getByRole("checkbox", { name: /Enable all feature flags/ });
  await expect(peerMaster).toBeEnabled();
  await expect(master).not.toBeChecked();
  await master.check();
  await expect(peerMaster).toBeChecked();
  await expect(peer.getByRole("button", nativeOn)).toBeVisible();
  await expect(peer.getByRole("button", { name: "Automatic PR branch updates: on" })).toBeVisible();
  await expect(peerActiveHours).toHaveAttribute("aria-pressed", "true");
  await expect(peer.getByRole("button", { name: "Task shaping: on" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(master).toBeChecked();
  await master.uncheck();
  await expect(peerMaster).not.toBeChecked();
  await page.getByRole("button", nativeOff).click();
  await expect(peer.getByRole("button", nativeOn)).toBeVisible();
  await expect(peer.getByRole("button", prOff)).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", nativeOn).click();
  await expect(peer.getByRole("button", nativeOff)).toBeVisible();
  // Toggling Resident active hours in one window changes the other without a reload.
  await expect(peerActiveHours).toHaveAttribute("aria-pressed", "false");
  await activeHours.click();
  await expect(peerActiveHours).toHaveAttribute("aria-pressed", "true");
  await activeHours.click();
  await expect(peerActiveHours).toHaveAttribute("aria-pressed", "false");
  expect(peerNavigations, "the peer window never reloaded").toBe(0);
  await page.getByRole("button", { name: "Search everything" }).click();
  await page.getByRole("combobox", { name: "Search everything" }).fill("Enable all feature flags");
  await page.getByRole("option", { name: /Enable all feature flags, setting/ }).click();
  await expect(page.locator('[data-anchor="feature-flags/enable-all"]')).toHaveClass(/settings-flash/);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(artifactsDir("feature-flags"), { recursive: true });
    await page.screenshot({ path: `${artifactsDir("feature-flags")}preview.png` });
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
