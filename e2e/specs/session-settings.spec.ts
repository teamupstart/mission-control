import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { SESSION_SETTINGS_FLAG_ID } from "../../src/shared/feature-flag-registry.ts";
import { api, connect, dispatch } from "../fixtures/session-control.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

const ACCESS_ENDPOINT = "/api/session-settings-access";
const ACCESS_LABEL = "Allow sessions to access Mission Control settings";

async function openDisplay(page: Page) {
  await page.getByRole("button", { name: /^Settings\b/ }).click();
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
  const directory = artifactsDir("session-settings-inspector");
  mkdirSync(directory, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${directory}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/session-settings-inspector/${name}.png`);
}

async function callSettings(client: Awaited<ReturnType<typeof connect>>, args: Record<string, unknown>, error?: string) {
  const result = await client.callTool({ name: "mission_settings", arguments: args });
  const [part] = result.content as Array<{ text: string }>;
  expect(Boolean(result.isError), part?.text).toBe(Boolean(error));
  const payload = JSON.parse(part.text);
  if (error) expect(payload).toEqual({ ok: false, error, hint: expect.any(String) });
  return payload;
}

async function enableSettingsPreview(daemon: Parameters<typeof api>[0]) {
  await api(daemon, "/api/feature-flags", { kind: "flag", id: SESSION_SETTINGS_FLAG_ID, enabled: true }, "PUT");
}

test("a registered session changes the theme in two open windows and the peer retries a failed refresh", async ({ page, browser, daemon }) => {
  await enableSettingsPreview(daemon);
  const session = await dispatch(daemon, "Theme request");
  const client = await connect(daemon, session);
  const peer = await browser.newPage();
  try {
    const peerReady = peer.waitForResponse(response => response.url().endsWith("/api/ui/skin") && response.ok());
    await Promise.all([page.goto(daemon.baseURL), peer.goto(daemon.baseURL)]);
    const [picker, peerPicker] = await Promise.all([openDisplay(page), openDisplay(peer)]);
    for (const control of [picker, peerPicker]) {
      await expect(control.getByRole("radio", { name: "Default", exact: true })).toBeChecked();
    }
    for (const window of [page, peer]) {
      await window.evaluate(() => document.documentElement.dataset.settingsFixture = "open");
    }
    await peerReady;

    expect(await callSettings(client, { operation: "find", query: "theme" })).toMatchObject({
      matches: [{ key: "ui.skin", label: "Skin", access: "read-write" }],
    });
    expect(await callSettings(client, { operation: "get", key: "ui.skin" })).toMatchObject({
      value: "default", choices: expect.arrayContaining([{ value: "daylight", label: "Daylight" }]),
    });
    let peerReads = 0;
    await peer.route("**/api/ui/skin", route => ++peerReads === 1
      ? route.fulfill({ status: 503 }) : route.continue());
    expect(await callSettings(client, { operation: "set", key: "ui.skin", value: "daylight" })).toMatchObject({ value: "daylight" });
    for (const [window, control] of [[page, picker], [peer, peerPicker]] as const) {
      await control.scrollIntoViewIfNeeded();
      const selected = control.getByRole("radio", { name: "Daylight", exact: true });
      await expect(selected).toBeChecked();
      await expect(selected).toBeInViewport();
      await expect(window.locator("html")).toHaveAttribute("data-skin", "daylight");
      await expect(window.locator("html")).toHaveAttribute("data-settings-fixture", "open");
      await expect(window.locator("body")).toHaveCSS("background-color", "rgb(245, 247, 250)");
    }
    expect(peerReads).toBeGreaterThanOrEqual(2);
    await evidence(page, "daylight-live");
    await evidence(peer, "daylight-peer");
    await peer.reload();
    await expect(peerPicker.getByRole("radio", { name: "Daylight", exact: true })).toBeChecked();

    const persisted = page.waitForResponse(response => response.url().endsWith("/api/ui/config")
      && response.request().method() === "PUT" && response.ok());
    await picker.getByRole("radio", { name: "Paper", exact: true }).check();
    await persisted;
    expect(await callSettings(client, { operation: "get", key: "ui.skin" })).toMatchObject({ value: "paper" });
    await expect(peer.locator("html")).toHaveAttribute("data-skin", "paper");

    await daemon.crash();
    await daemon.restart();
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

test("a desktop Trust click revokes access across dashboards and a refused save can retry", async ({ daemon, browser }) => {
  test.skip(process.platform !== "darwin", "the sandboxed desktop fixture requires macOS");
  await enableSettingsPreview(daemon);
  await daemon.crash();
  const authorizationModule = join(daemon.home, "session-settings-authorization.cjs");
  buildSync({
    stdin: {
      contents: 'export * from "./src/main/session-control-authorization.ts"; export * from "./src/main/dashboard-click-ipc.ts";',
      resolveDir: process.cwd(), loader: "ts",
    },
    outfile: authorizationModule, bundle: true, platform: "node", format: "cjs",
  });
  const application = await electron.launch({
    args: [fileURLToPath(new URL("../fixtures/desktop-session-control.cjs", import.meta.url)), authorizationModule],
  });
  const peer = await browser.newPage();
  try {
    const page = await application.firstWindow();
    const startDaemon = async () => {
      const pid = await application.evaluate((_electron, config) =>
        (globalThis as unknown as { startControlDaemon(config: unknown): Promise<number> }).startControlDaemon(config),
      daemon.desktopLaunchConfig());
      await expect.poll(async () => {
        const response = await fetch(`${daemon.baseURL}/api/health`).catch(() => null);
        return response?.ok ? (await response.json()).pid : null;
      }).toBe(pid);
    };
    await startDaemon();
    await Promise.all([page.goto(daemon.baseURL), peer.goto(daemon.baseURL)]);
    const [access, peerAccess] = await Promise.all([openTrust(page), openTrust(peer)]);
    await expect(access).toBeChecked();
    await expect(access).toBeEnabled();
    await expect(peerAccess).toBeChecked();
    await expect(peerAccess).toBeDisabled();
    const client = await connect(daemon, await dispatch(daemon, "Access"));
    try {
      expect(await callSettings(client, { operation: "get", key: "ui.skin" })).toMatchObject({ ok: true });
      let refuseWrite = true;
      await page.route(`**${ACCESS_ENDPOINT}`, route => {
        if (route.request().method() !== "PUT" || !refuseWrite) return route.continue();
        refuseWrite = false;
        return route.fulfill({ status: 503 });
      });
      const alert = page.getByRole("alert").filter({ hasText: "Could not save session settings access." });
      await access.click();
      await expect(alert).toBeVisible();
      await expect(access).toBeChecked();
      await expect(access).toBeEnabled();
      expect(await api(daemon, ACCESS_ENDPOINT)).toEqual({ enabled: true });
      await evidence(page, "trust-access-save-failed");

      await access.click();
      await expect(alert).toBeHidden();
      await expect(access).not.toBeChecked();
      await expect(access).toBeEnabled();
      await expect(peerAccess).not.toBeChecked();
      const unauthorized = await fetch(`${daemon.baseURL}${ACCESS_ENDPOINT}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
      });
      expect(unauthorized.status).toBe(403);
      for (const args of [
        { operation: "find", query: "theme" },
        { operation: "get", key: "ui.skin" },
        { operation: "set", key: "ui.skin", value: "daylight" },
      ]) await callSettings(client, args, "access_disabled");
      await evidence(page, "access-revoked");

      await access.click();
      await expect(access).toBeChecked();
      await expect(peerAccess).toBeChecked();
      await access.click();
      await expect(peerAccess).not.toBeChecked();
      await application.evaluate(() =>
        (globalThis as unknown as { stopControlDaemon(): Promise<void> }).stopControlDaemon());
      await startDaemon();
      expect(await api(daemon, ACCESS_ENDPOINT)).toEqual({ enabled: false });
    } finally {
      await client.close();
    }
  } finally {
    await Promise.all([peer.close(), application.close()]);
  }
});
