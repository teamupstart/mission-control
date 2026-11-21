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
        const bridge = window as unknown as { refuseNextAlphaSave?: string; holdNextAlphaSave?: boolean; releaseAlphaSave?: () => void };
        if (bridge.holdNextAlphaSave) {
          delete bridge.holdNextAlphaSave;
          await new Promise<void>(resolve => { bridge.releaseAlphaSave = resolve; });
        }
        const refusal = bridge.refuseNextAlphaSave;
        if (refusal) { delete bridge.refuseNextAlphaSave; throw new Error(refusal); }
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
  // So does Task shaping. `task-shaping-flag.spec.ts` drives its row and the API gate itself.
  await expect(page.getByRole("button", { name: "Task shaping: off" })).toBeVisible();
  // And Session control requests. `session-control-requests.spec.ts` drives the card it gates.
  await expect(page.getByRole("button", { name: "Session control requests: off" })).toBeVisible();
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
  await expect(peer.getByRole("button", { name: "Session control requests: on" })).toBeVisible();
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
  const alert = updates.getByRole("alert").filter({ hasText: "Enable all feature flags could not be switched on" });
  const retry = updates.getByRole("button", { name: "Retry" });
  await alpha.check();
  await expect(alert).toContainText("Alpha updates are on, but Enable all feature flags could not be switched on: flag store unavailable");
  await expect(alpha).toBeChecked();
  await expect(peerMaster).not.toBeChecked();
  // While an opt-out saves, Retry waits; a refused opt-out leaves alpha on, so its failure and
  // Retry stay too.
  await page.evaluate(() => Object.assign(window, { refuseNextAlphaSave: "update preferences are read-only", holdNextAlphaSave: true }));
  await alpha.click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseAlphaSave?: () => void }).releaseAlphaSave)).toBe("function");
  await expect(retry).toBeDisabled();
  await page.evaluate(() => (window as unknown as { releaseAlphaSave(): void }).releaseAlphaSave());
  await expect(updates.getByRole("alert").filter({ hasText: "update preferences are read-only" })).toBeVisible();
  await expect(alpha).toBeChecked();
  await expect(alert).toContainText("flag store unavailable");
  await expect(retry).toBeEnabled();
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

test("an Enable all write the daemon never answers times out and frees Retry", async ({ dashboard: page, context, daemon }) => {
  const peer = await context.newPage();
  await peer.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peerMaster = peer.getByRole("checkbox", { name: /Enable all feature flags/ });
  await expect(peerMaster).toBeEnabled();
  // The first write is held open past the panel's bound; the retry goes through.
  let writes = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/feature-flags", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    writes++;
    if (writes === 1) {
      await held;
      return route.abort().catch(() => {});
    }
    return route.continue();
  });
  await page.addInitScript(fakeAlphaBridge);
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await page.reload();
  const alpha = page.getByRole("checkbox", { name: "Alpha updates" });
  const updates = page.getByRole("region", { name: "Application updates" });
  const alert = updates.getByRole("alert").filter({ hasText: "Enable all feature flags could not be switched on" });
  await alpha.check();
  await expect(alert).toContainText("Mission Control did not answer within 10 seconds", { timeout: 20_000 });
  const retry = updates.getByRole("button", { name: "Retry" });
  await expect(retry).toBeEnabled();
  await expect(peerMaster).not.toBeChecked();
  await retry.click();
  await expect(alert).toHaveCount(0);
  await expect(peerMaster).toBeChecked();
  expect(writes).toBe(2);
  release();
});

test("a failure that lands after another window switched Enable all on never comes back", async ({ dashboard: page, context, daemon }) => {
  const peer = await context.newPage();
  await peer.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peerMaster = peer.getByRole("checkbox", { name: /Enable all feature flags/ });
  await expect(peerMaster).toBeEnabled();
  // The alpha opt-in's write is held, then refused once the peer has switched Enable all on.
  let writes = 0;
  let settled = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/feature-flags", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    writes++;
    await held;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "flag store unavailable" }) }).catch(() => {});
    settled = true;
  });
  await page.addInitScript(fakeAlphaBridge);
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await page.reload();
  const alpha = page.getByRole("checkbox", { name: "Alpha updates" });
  const updates = page.getByRole("region", { name: "Application updates" });
  const alert = updates.getByRole("alert").filter({ hasText: "Enable all feature flags could not be switched on" });
  const master = page.getByRole("checkbox", { name: /Enable all feature flags/ });
  await alpha.check();
  await expect.poll(() => writes).toBe(1);
  await peerMaster.check();
  // This window has seen the peer's Enable all before its own write settles.
  await updates.getByRole("link", { name: "Feature flags" }).click();
  await expect(master).toBeChecked();
  await page.getByRole("tab", { name: /Setup/ }).click();
  release();
  await expect.poll(() => settled).toBe(true);
  await expect(alert).toHaveCount(0);
  // Switching Enable all off again must not resurface the superseded failure.
  await peerMaster.uncheck();
  await updates.getByRole("link", { name: "Feature flags" }).click();
  await expect(master).not.toBeChecked();
  await page.getByRole("tab", { name: /Setup/ }).click();
  await expect(alpha).toBeChecked();
  await expect(alert).toHaveCount(0);
  await expect(updates.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("a failure landing after Enable all went on and off elsewhere offers no Retry", async ({ dashboard: page, context, daemon }) => {
  const peer = await context.newPage();
  await peer.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peerMaster = peer.getByRole("checkbox", { name: /Enable all feature flags/ });
  await expect(peerMaster).toBeEnabled();
  let writes = 0;
  let settled = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/feature-flags", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    writes++;
    await held;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "flag store unavailable" }) }).catch(() => {});
    settled = true;
  });
  await page.addInitScript(fakeAlphaBridge);
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await page.reload();
  const alpha = page.getByRole("checkbox", { name: "Alpha updates" });
  const updates = page.getByRole("region", { name: "Application updates" });
  const master = page.getByRole("checkbox", { name: /Enable all feature flags/ });
  const setup = page.getByRole("tab", { name: /Setup/ });
  await alpha.check();
  await expect.poll(() => writes).toBe(1);
  // Enable all goes on, and this window sees it while its own write is still pending...
  await peerMaster.check();
  await updates.getByRole("link", { name: "Feature flags" }).click();
  await expect(master).toBeChecked();
  await setup.click();
  await expect(alpha).toBeChecked();
  // ...then the operator switches it off again before that write fails.
  await peerMaster.uncheck();
  await updates.getByRole("link", { name: "Feature flags" }).click();
  await expect(master).not.toBeChecked();
  await setup.click();
  release();
  await expect.poll(() => settled).toBe(true);
  await expect(alpha).toBeChecked();
  await expect(updates.getByRole("alert")).toHaveCount(0);
  await expect(updates.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(peerMaster).not.toBeChecked();
});

test("opting in to alpha with Enable all already on sends no flag write", async ({ dashboard: page, context, daemon }) => {
  const peer = await context.newPage();
  await peer.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peerMaster = peer.getByRole("checkbox", { name: /Enable all feature flags/ });
  await expect(peerMaster).toBeEnabled();
  await peerMaster.check();
  const intents: unknown[] = [];
  await page.route("**/api/feature-flags", async route => {
    if (route.request().method() === "PUT") intents.push(route.request().postDataJSON());
    return route.continue();
  });
  await page.addInitScript(fakeAlphaBridge);
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  await page.reload();
  const master = page.getByRole("checkbox", { name: /Enable all feature flags/ });
  await expect(master).toBeChecked();
  await page.getByRole("tab", { name: /Setup/ }).click();
  const alpha = page.getByRole("checkbox", { name: "Alpha updates" });
  await alpha.check();
  await expect(alpha).toBeChecked();
  // The operator's own later choice is the only write this window sends.
  await page.getByRole("region", { name: "Application updates" }).getByRole("link", { name: "Feature flags" }).click();
  await master.uncheck();
  await expect(peerMaster).not.toBeChecked();
  expect(intents).toEqual([{ kind: "master", enabled: false }]);
});
