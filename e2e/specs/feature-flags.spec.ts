import { mkdirSync } from "node:fs";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/** A desktop update bridge whose alpha switch starts off and publishes each change. */
function fakeAlphaBridge(): void {
  let snapshot = { phase: "up-to-date", alpha: false, currentVersion: "1.2.3" };
  const listeners = new Set<(value: typeof snapshot) => void>();
  Object.defineProperty(window, "missionDesktop", { value: {
    isDesktop: true, version: async () => "1.2.3", onOpenSettings: () => () => {},
    updates: { getState: async () => snapshot,
      setAlpha: async (alpha: boolean) => {
        snapshot = { ...snapshot, alpha };
        for (const listener of listeners) listener(snapshot);
        return snapshot;
      },
      onState: (listener: (value: typeof snapshot) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
  } });
}

test("shipped preview, live master and individual changes, reload, search, and alpha opt-in enabling all", async ({ dashboard: page, context, daemon }) => {
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
  // The alpha control belongs to the desktop bridge, not to the daemon. Opting in to alpha
  // switches on Enable all and keeps the explicit off left on Resident active hours above.
  await page.addInitScript(fakeAlphaBridge);
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await page.reload();
  await expect(page.getByText("Switching alpha on also switches on Enable all", { exact: false })).toBeVisible();
  const alpha = page.getByRole("checkbox", { name: "Alpha updates" });
  await expect(alpha).not.toBeChecked();
  await expect(peerMaster).not.toBeChecked();
  await alpha.check();
  await expect(alpha).toBeChecked();
  await expect(peerMaster).toBeChecked();
  await expect(peer.getByRole("button", { name: "Automatic PR branch updates: on" })).toBeVisible();
  await expect(peerActiveHours).toHaveAttribute("aria-pressed", "false");
  // Leaving alpha changes no flag.
  await alpha.uncheck();
  await expect(alpha).not.toBeChecked();
  await page.getByRole("link", { name: "Feature flags" }).click();
  await expect(page.getByRole("tab", { name: /Feature flags/ })).toHaveAttribute("aria-selected", "true");
  await expect(master).toBeChecked();
  await expect(page.getByText("Switching on Alpha updates also switches this on.")).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE) await page.screenshot({ path: `${artifactsDir("feature-flags")}alpha-enables-all.png`, animations: "disabled" });
});

test("a failed Enable all write keeps alpha on and offers a retry that survives navigation and never locks alpha", async ({ dashboard: page, context, daemon }) => {
  const peer = await context.newPage();
  await peer.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peerMaster = peer.getByRole("checkbox", { name: /Enable all feature flags/ });
  await expect(peerMaster).toBeEnabled();
  await expect(peerMaster).not.toBeChecked();
  // The daemon refuses the first write, the second never reaches it, and the third stalls
  // until the test releases it.
  let writes = 0;
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/feature-flags", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    writes++;
    if (writes === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "flag store unavailable" }) });
    if (writes === 2) return route.abort("connectionrefused");
    await stalled;
    return route.continue();
  });
  await page.addInitScript(fakeAlphaBridge);
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await page.reload();
  const alpha = page.getByRole("checkbox", { name: "Alpha updates" });
  const updates = page.getByRole("region", { name: "Application updates" });
  const alert = updates.getByRole("alert");
  const retry = updates.getByRole("button", { name: "Retry" });
  await alpha.check();
  await expect(alert).toContainText("Alpha updates are on, but Enable all feature flags could not be switched on: flag store unavailable");
  await expect(alpha).toBeChecked();
  await expect(peerMaster).not.toBeChecked();
  // Leaving Setup and coming back keeps the failure and its Retry.
  await updates.getByRole("link", { name: "Feature flags" }).click();
  await expect(page.getByRole("tab", { name: /Feature flags/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: /Setup/ }).click();
  await expect(alert).toContainText("flag store unavailable");
  await retry.click();
  await expect(alert).toContainText("Alpha updates are on, but Enable all feature flags could not be switched on:");
  await expect(alert).not.toContainText("flag store unavailable");
  await expect(alpha).toBeChecked();
  await expect(peerMaster).not.toBeChecked();
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(artifactsDir("feature-flags"), { recursive: true });
    await page.mouse.move(1, 1);
    await updates.screenshot({ path: `${artifactsDir("feature-flags")}alpha-enable-all-retry.png`, animations: "disabled" });
  }
  // While the retried write stalls, Retry waits but the alpha switch stays usable.
  await retry.click();
  await expect.poll(() => writes).toBe(3);
  await expect(retry).toBeDisabled();
  await expect(alpha).toBeEnabled();
  await alpha.uncheck();
  await expect(alpha).not.toBeChecked();
  await alpha.check();
  await expect(alpha).toBeChecked();
  expect(writes, "a second opt-in does not race the pending write").toBe(3);
  release();
  await expect(alert).toHaveCount(0);
  await expect(peerMaster).toBeChecked();
  await expect(alpha).toBeChecked();
  expect(writes).toBe(3);
});
