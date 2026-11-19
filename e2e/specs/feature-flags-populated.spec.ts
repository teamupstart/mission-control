import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { buildFeatureFlags } from "../fixtures/feature-flags-build.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

let build: Awaited<ReturnType<typeof buildFeatureFlags>>;
test.beforeAll(async () => {
  const nodeEnv = process.env.NODE_ENV;
  build = await buildFeatureFlags();
  expect(process.env.NODE_ENV, "private builds must not contaminate later dev-server specs").toBe(nodeEnv);
});
test.afterAll(() => build?.cleanup());
// eslint-disable-next-line no-empty-pattern
test.use({ daemonEnv: async ({}, use) => use({ MISSION_WEB_DIR: build.webDir, MC_E2E_FEATURE_FLAGS_BUNDLE: build.daemonBundle }) });
async function shoot(page: Page, name: string) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(artifactsDir("feature-flags"), { recursive: true });
  await page.screenshot({ path: `${artifactsDir("feature-flags")}${name}.png` });
}

test("populated flags apply live, preserve choices, filter Advanced and roll back refusals", async ({ dashboard: page, context, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  let writes = 0;
  page.on("request", request => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/feature-flags") writes++;
  });
  const peer = await context.newPage();
  await peer.goto(page.url());
  let peerNavigations = 0;
  peer.on("framenavigated", frame => { if (frame === peer.mainFrame()) peerNavigations++; });
  const pill = (window: Page, name: string) => window.getByRole("button", { name: new RegExp(`^${name}:`) });
  const navigation = pill(page, "Preview navigation");
  const peerNavigation = pill(peer, "Preview navigation");
  const master = page.getByRole("checkbox", { name: /Enable all feature flags/ });
  const advanced = page.getByRole("button", { name: /Advanced/ });
  const filter = page.getByRole("textbox", { name: "Filter feature flags" });
  const config = async () => (await (await fetch(`${daemon.baseURL}/api/feature-flags`)).json()).config;
  await expect(navigation).toHaveAttribute("aria-pressed", "false");
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await expect(peerNavigation).toBeEnabled();
  await shoot(page, "populated");
  await master.click();
  await expect(navigation).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await master.uncheck();
  await navigation.click();
  await expect(peerNavigation).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await config()).overrides["preview-navigation"]).toBe(true);
  await page.reload();
  await expect(navigation).toHaveAttribute("aria-pressed", "true");
  await navigation.click();
  await expect(peerNavigation).toHaveAttribute("aria-pressed", "false");
  await master.click();
  const dialog = page.getByRole("dialog", { name: "Enable all feature flags" });
  await expect(dialog.getByText("Preview navigation", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expectContentClearsBorder(dialog);
  await shoot(page, "dialog");
  const beforeCancel = writes;
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(master).not.toBeChecked();
  await master.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect((await config()).enableAll).toBe(false);
  expect(writes).toBe(beforeCancel);
  await master.click();
  await dialog.getByRole("button", { name: "Keep them off" }).click();
  await expect(master).toBeChecked();
  await expect(navigation).toHaveAttribute("aria-pressed", "false");
  await expect(pill(peer, "Preview timeline")).toHaveAttribute("aria-pressed", "true");
  await master.uncheck();
  await master.click();
  await dialog.getByRole("button", { name: "Turn them on too" }).click();
  await expect(peerNavigation).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await config()).overrides).toEqual({});
  await advanced.click();
  await pill(page, "Compact history").click();
  await expect(advanced).toContainText("1 turned off");
  await shoot(page, "advanced");
  await advanced.click();
  await filter.fill("archive");
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(pill(page, "Compact history")).toBeVisible();
  await expect(navigation).toHaveCount(0);
  await filter.fill("nothing-matches-this");
  await expect(page.getByText("No feature flags match your filter.")).toBeVisible();
  await filter.fill("wayfinding");
  await expect(navigation).toBeVisible();
  await expect(pill(page, "Preview timeline")).toHaveCount(0);
  for (const query of ["preview-timeline", "chronological", "Preview timeline"]) {
    await filter.fill(query);
    await expect(pill(page, "Preview timeline")).toBeVisible();
    await expect(navigation).toHaveCount(0);
  }
  await filter.fill("");
  await page.getByRole("button", { name: "Search everything" }).click();
  await page.getByRole("combobox", { name: "Search everything" }).fill("Preview navigation");
  await page.getByRole("option", { name: /Preview navigation, setting, on/ }).click();
  await expect(peerNavigation).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("option", { name: /Preview navigation, setting, off/ })).toBeVisible();
  await page.keyboard.press("Escape");
  // Hold the refusal to observe optimism before rollback, not only the eventual state.
  let refuse!: () => void;
  const held = new Promise<void>(resolve => { refuse = resolve; });
  await page.route("**/api/feature-flags", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    await held;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture refused write" }) });
  });
  await navigation.click();
  await expect(navigation).toHaveAttribute("aria-pressed", "true");
  await expect(peerNavigation).toHaveAttribute("aria-pressed", "false");
  refuse();
  await expect(navigation).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-anchor="feature-flags/preview-navigation"]').getByRole("alert")).toHaveText("Fixture refused write");
  expect((await config()).overrides["preview-navigation"]).toBe(false);
  await page.unroute("**/api/feature-flags");
  expect(peerNavigations).toBe(0);
  await master.uncheck();
  await master.click();
  await expect(dialog.getByText("Compact history", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Preview navigation", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Turn them on too" }).click();
  await expect.poll(async () => (await config()).overrides).toEqual({});
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 760]) {
      await page.setViewportSize({ width, height: 900 });
      const skinWrite = await page.request.put(`${daemon.baseURL}/api/ui/config`, { data: { skin: theme === "light" ? "daylight" : "default", layout: width === 1440 ? "console" : "board" } });
      expect(skinWrite.ok()).toBe(true);
      await page.reload();
      await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
      await filter.fill("");
      await expect(navigation).toBeVisible();
      await navigation.scrollIntoViewIfNeeded();
      await shoot(page, `populated-${theme}-${width}`);
      await advanced.click();
      await shoot(page, `advanced-${theme}-${width}`);
      await navigation.click();
      await master.uncheck();
      await master.click();
      await expectContentClearsBorder(dialog);
      await shoot(page, `dialog-${theme}-${width}`);
      await dialog.getByRole("button", { name: "Turn them on too" }).click();
      await expect(navigation).toHaveAttribute("aria-pressed", "true");
    }
  }
});

test("a refused master write rolls back, reports its error and leaves the peer unchanged", async ({ dashboard: page, context, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peer = await context.newPage();
  await peer.goto(page.url());
  const master = page.getByRole("checkbox", { name: /Enable all feature flags/ });
  const peerMaster = peer.getByRole("checkbox", { name: /Enable all feature flags/ });
  const preview = (window: Page, name: string) => window.getByRole("button", { name: new RegExp(`^${name}:`) });
  const config = async () => (await (await fetch(`${daemon.baseURL}/api/feature-flags`)).json()).config;
  await expect(master).toBeEnabled();
  await expect(peerMaster).toBeEnabled();
  await expect(master).not.toBeChecked();
  await expect(peerMaster).not.toBeChecked();
  for (const name of ["Preview navigation", "Preview timeline"]) {
    await expect(preview(page, name)).toHaveAttribute("aria-pressed", "false");
    await expect(preview(peer, name)).toHaveAttribute("aria-pressed", "false");
  }
  const before = await config();
  // Hold the response so rollback cannot pass without observing the optimistic change.
  let refuse!: () => void;
  const held = new Promise<void>(resolve => { refuse = resolve; });
  await page.route("**/api/feature-flags", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    await held;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture refused master write" }) });
  });
  const request = page.waitForRequest(request => request.method() === "PUT" && new URL(request.url()).pathname === "/api/feature-flags");
  await master.check();
  expect((await request).postDataJSON()).toEqual({ kind: "master", enabled: true });
  await expect(master).toBeChecked();
  await expect(master).toBeDisabled();
  await expect(peerMaster).not.toBeChecked();
  for (const name of ["Preview navigation", "Preview timeline"]) {
    await expect(preview(page, name)).toHaveAttribute("aria-pressed", "true");
    await expect(preview(peer, name)).toHaveAttribute("aria-pressed", "false");
  }
  refuse();
  await expect(master).not.toBeChecked();
  await expect(master).toBeEnabled();
  await expect(page.locator('[data-anchor="feature-flags/enable-all"]').getByRole("alert")).toHaveText("Fixture refused master write");
  await expect(peerMaster).not.toBeChecked();
  for (const name of ["Preview navigation", "Preview timeline"]) {
    await expect(preview(page, name)).toHaveAttribute("aria-pressed", "false");
    await expect(preview(peer, name)).toHaveAttribute("aria-pressed", "false");
  }
  expect(await config()).toEqual(before);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("feature-flags/workflow-repair-2");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}master-refused.png` });
    await peer.screenshot({ path: `${dir}peer-unchanged.png` });
  }
});
