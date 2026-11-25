import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { api, connect, dispatch } from "../fixtures/session-control.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

const ACCESS_ENDPOINT = "/api/session-settings-access";
const ACCESS_LABEL = "Allow sessions to access Mission Control settings";

async function openDisplay(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Display", exact: true }).click();
  return page.getByRole("radiogroup", { name: "Skin" });
}

async function openTrust(page: Page) {
  await page.getByRole("button", { name: /^Settings\b/ }).click();
  await page.getByRole("tab", { name: "Trust", exact: true }).click();
  return page.getByRole("checkbox", { name: ACCESS_LABEL });
}

async function evidence(page: Page, name: string) {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const directory = artifactsDir("session-settings");
  mkdirSync(directory, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${directory}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/session-settings/${name}.png`);
}

test("a registered session changes the theme in two open windows and loses access when revoked", async ({ page, browser, daemon }) => {
  const session = await dispatch(daemon, "Theme request");
  const client = await connect(daemon, session);
  const peer = await browser.newPage();
  try {
    const call = async (args: Record<string, unknown>, error?: string) => {
      const result = await client.callTool({ name: "mission_settings", arguments: args });
      const [part] = result.content as Array<{ text: string }>;
      expect(Boolean(result.isError), part?.text).toBe(Boolean(error));
      const payload = JSON.parse(part.text);
      if (error) expect(payload).toEqual({ ok: false, error, hint: expect.any(String) });
      return payload;
    };

    await Promise.all([page.goto(daemon.baseURL), peer.goto(daemon.baseURL)]);
    const [picker, peerPicker] = await Promise.all([openDisplay(page), openDisplay(peer)]);
    for (const control of [picker, peerPicker]) {
      await expect(control.getByRole("radio", { name: "Default", exact: true })).toBeChecked();
    }
    for (const window of [page, peer]) {
      await window.evaluate(() => document.documentElement.dataset.settingsFixture = "open");
    }

    expect(await call({ operation: "find", query: "theme" })).toMatchObject({
      matches: [{ key: "ui.skin", label: "Skin", access: "read-write" }],
    });
    expect(await call({ operation: "get", key: "ui.skin" })).toMatchObject({
      value: "default", choices: expect.arrayContaining([{ value: "daylight", label: "Daylight" }]),
    });
    expect(await call({ operation: "set", key: "ui.skin", value: "daylight" })).toMatchObject({ value: "daylight" });
    for (const [window, control] of [[page, picker], [peer, peerPicker]] as const) {
      await control.scrollIntoViewIfNeeded();
      const selected = control.getByRole("radio", { name: "Daylight", exact: true });
      await expect(selected).toBeChecked();
      await expect(selected).toBeInViewport();
      await expect(window.locator("html")).toHaveAttribute("data-skin", "daylight");
      await expect(window.locator("html")).toHaveAttribute("data-settings-fixture", "open");
      await expect(window.locator("body")).toHaveCSS("background-color", "rgb(245, 247, 250)");
    }
    await evidence(page, "daylight-live");
    await evidence(peer, "daylight-peer");
    await peer.reload();
    await expect(peerPicker.getByRole("radio", { name: "Daylight", exact: true })).toBeChecked();

    const persisted = page.waitForResponse(response => response.url().endsWith("/api/ui/config")
      && response.request().method() === "PUT" && response.ok());
    await picker.getByRole("radio", { name: "Paper", exact: true }).check();
    await persisted;
    expect(await call({ operation: "get", key: "ui.skin" })).toMatchObject({ value: "paper" });

    await page.getByRole("tab", { name: "Trust", exact: true }).click();
    const access = page.getByRole("checkbox", { name: ACCESS_LABEL });
    await expect(access).toBeChecked();
    await access.click();
    await expect(access).not.toBeChecked();
    await expect(access).toBeEnabled();
    for (const args of [
      { operation: "find", query: "theme" },
      { operation: "get", key: "ui.skin" },
      { operation: "set", key: "ui.skin", value: "daylight" },
    ]) await call(args, "access_disabled");
    await evidence(page, "access-revoked");
    await expect(peer.locator("html")).toHaveAttribute("data-skin", "paper");

    await daemon.crash();
    await daemon.restart();
    expect(await api(daemon, ACCESS_ENDPOINT)).toEqual({ enabled: false });
    expect(await api(daemon, "/api/ui/config")).toMatchObject({ config: { skin: "paper" } });
  } finally {
    await Promise.all([peer.close(), client.close()]);
  }
});

test("the Trust access checkbox stays disabled when the initial read fails", async ({ dashboard: page }) => {
  await page.route(`**${ACCESS_ENDPOINT}`, route => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 503, json: { error: "Access preference unavailable" } });
  });

  const access = await openTrust(page);
  await expect(page.getByRole("alert").filter({ hasText: "Could not read session settings access." })).toBeVisible();
  await expect(access).not.toBeChecked();
  await expect(access).toBeDisabled();
  await evidence(page, "trust-access-read-failed");
});

test("the Trust access checkbox keeps its prior choice after a failed save and can retry", async ({ dashboard: page, daemon }) => {
  const access = await openTrust(page);
  await expect(access).toBeChecked();
  await expect(access).toBeEnabled();

  let refuseWrite = true;
  await page.route(`**${ACCESS_ENDPOINT}`, route => {
    if (route.request().method() !== "PUT" || !refuseWrite) return route.continue();
    refuseWrite = false;
    return route.fulfill({ status: 503, json: { error: "Access preference unavailable" } });
  });

  const alert = page.getByRole("alert").filter({ hasText: "Could not save session settings access." });
  await access.click();
  await expect(alert).toBeVisible();
  await expect(access).toBeChecked();
  await expect(access).toBeEnabled();
  expect(await api(daemon, ACCESS_ENDPOINT)).toEqual({ enabled: true });
  await evidence(page, "trust-access-save-failed");

  await access.click();
  await expect(access).not.toBeChecked();
  await expect(access).toBeEnabled();
  await expect(alert).toBeHidden();
  expect(await api(daemon, ACCESS_ENDPOINT)).toEqual({ enabled: false });
});
