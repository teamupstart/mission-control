import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { SESSION_SETTINGS_FLAG_ID } from "../../src/shared/feature-flag-registry.ts";
import { SESSION_SETTINGS_ACCESS } from "../../src/shared/session-settings-metadata.ts";
import { api, connect, dispatch } from "../fixtures/session-control.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { openRepositorySetup } from "../fixtures/setup-panel.ts";
import { expect, test } from "../fixtures/test.ts";
import { enableVoice } from "../fixtures/voice.ts";

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
  const directory = artifactsDir("session-settings-explicit-opt-in");
  mkdirSync(directory, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${directory}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/session-settings-explicit-opt-in/${name}.png`);
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

async function pauseDashboardTimers(page: Page) {
  const time = new Date();
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 500));
}

test("a registered session changes the theme in two open windows and the peer retries a failed refresh", async ({ page, browser, daemon }) => {
  await enableSettingsPreview(daemon);
  // This browser-only case starts with saved desktop consent. The Electron case below grants it by clicking Trust.
  withDaemonDb(daemon, db => db.prepare("INSERT INTO app_config (key, value) VALUES (?, ?)").run(
    SESSION_SETTINGS_ACCESS.key, JSON.stringify(true),
  ));
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

test("a stalled theme save releases the next choice and reconciles open dashboards", async ({ dashboard: page, daemon, browser }) => {
  const peer = await browser.newPage();
  try {
    const peerReady = peer.waitForResponse(response => response.url().endsWith("/api/ui/skin") && response.ok());
    await peer.goto(daemon.baseURL);
    await peerReady;
    const picker = await openDisplay(page);
    await expect(picker.getByRole("radio", { name: "Default", exact: true })).toBeChecked();

    const stalled = page.waitForEvent("requestfailed", {
      predicate: request => request.url().endsWith("/api/ui/config") && request.method() === "PUT"
        && request.postDataJSON()?.skin === "daylight",
      timeout: 8_000,
    });
    void stalled.catch(() => {});
    await page.route("**/api/ui/config", async route => {
      const request = route.request();
      if (request.method() !== "PUT" || request.postDataJSON()?.skin !== "daylight") return route.continue();
      await stalled.catch(() => {});
      await route.abort().catch(() => {});
    });

    const firstWrite = page.waitForRequest(request => request.url().endsWith("/api/ui/config")
      && request.method() === "PUT" && request.postDataJSON()?.skin === "daylight");
    await picker.getByRole("radio", { name: "Daylight", exact: true }).click();
    await firstWrite;
    const saved = page.waitForResponse(response => response.url().endsWith("/api/ui/config")
      && response.request().method() === "PUT" && response.request().postDataJSON()?.skin === "paper" && response.ok());
    const paper = picker.getByRole("radio", { name: "Paper", exact: true });
    await paper.click();
    await stalled;
    await saved;
    await expect(paper).toBeChecked();
    await expect(peer.locator("html")).toHaveAttribute("data-skin", "paper");
    expect(await api(daemon, "/api/ui/config")).toMatchObject({ config: { skin: "paper" } });
    await paper.scrollIntoViewIfNeeded();
    await evidence(page, "paper-after-stalled-save");
  } finally {
    await peer.close();
  }
});

test("a desktop Trust click revokes access across dashboards and a refused save can retry", async ({ daemon, browser }) => {
  test.skip(process.platform !== "darwin", "the sandboxed desktop fixture requires macOS");
  await api(daemon, "/api/feature-flags", { kind: "master", enabled: true }, "PUT");
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
    await expect(access).not.toBeChecked();
    await expect(access).toBeEnabled();
    await expect(peerAccess).not.toBeChecked();
    await expect(peerAccess).toBeDisabled();
    const client = await connect(daemon, await dispatch(daemon, "Access"));
    try {
      await callSettings(client, { operation: "get", key: "ui.skin" }, "access_disabled");
      await evidence(page, "trust-off-before-consent");
      await access.click();
      await expect(access).toBeChecked();
      await expect(access).toBeEnabled();
      await expect(peerAccess).toBeChecked();
      expect(await callSettings(client, { operation: "get", key: "ui.skin" })).toMatchObject({ ok: true });
      let refuseWrite = true;
      let refuseRead = false;
      let stalled: Promise<unknown> | undefined;
      await page.route(`**${ACCESS_ENDPOINT}`, route => {
        if (route.request().method() === "GET" && refuseRead) return route.fulfill({ status: 503 });
        if (route.request().method() === "PUT" && refuseWrite) {
          refuseWrite = false;
          return route.fulfill({ status: 503 });
        }
        if (route.request().method() === "PUT" && stalled) {
          const failed = stalled;
          stalled = undefined;
          return failed.catch(() => {}).then(() => route.abort()).catch(() => {});
        }
        return route.continue();
      });
      const alert = page.getByRole("alert").filter({ hasText: "Could not save session settings access." });
      const readAlert = page.getByRole("alert").filter({ hasText: "Could not read session settings access." });
      await access.click();
      await expect(alert).toBeVisible();
      await expect(access).toBeChecked();
      await expect(access).toBeEnabled();
      expect(await api(daemon, ACCESS_ENDPOINT)).toEqual({ enabled: true });
      await evidence(page, "trust-access-save-failed");

      const failed = page.waitForEvent("requestfailed", {
        predicate: request => request.url().endsWith(ACCESS_ENDPOINT) && request.method() === "PUT",
        timeout: 8_000,
      });
      void failed.catch(() => {});
      stalled = failed;
      await access.click();
      await expect(access).toBeDisabled();
      await failed;
      await expect(alert).toBeVisible();
      await expect(access).toBeChecked();
      await expect(access).toBeEnabled();
      await evidence(page, "trust-retry-after-stalled-save");

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

      // The real save succeeds. Hold back both the event-driven and post-save reads.
      refuseRead = true;
      const saved = page.waitForResponse(response => response.url().endsWith(ACCESS_ENDPOINT)
        && response.request().method() === "PUT" && response.ok());
      await access.click();
      expect(await (await saved).json()).toEqual({ enabled: false });
      await expect(readAlert).toBeVisible();
      await expect(access).not.toBeChecked();
      await expect(access).toBeDisabled();
      await expect(peerAccess).not.toBeChecked();
      await callSettings(client, { operation: "get", key: "ui.skin" }, "access_disabled");
      await evidence(page, "trust-read-failed-after-revoke");

      refuseRead = false;
      await page.getByRole("tab", { name: "Display", exact: true }).click();
      await page.getByRole("tab", { name: "Trust", exact: true }).click();
      await expect(readAlert).toBeHidden();
      await expect(access).not.toBeChecked();
      await expect(access).toBeEnabled();

      // A definite save refusal leaves the known choice usable. If a subsequent reconnect
      // cannot read the choice, the alert explains why the checkbox is now disabled.
      refuseWrite = true;
      await access.click();
      await expect(alert).toBeVisible();
      await expect(access).toBeEnabled();
      refuseRead = true;
      await application.evaluate(() =>
        (globalThis as unknown as { stopControlDaemon(): Promise<void> }).stopControlDaemon());
      await startDaemon();
      await expect(readAlert).toBeVisible();
      await expect(alert).toBeHidden();
      await expect(access).not.toBeChecked();
      await expect(access).toBeDisabled();
      expect(await api(daemon, ACCESS_ENDPOINT)).toEqual({ enabled: false });
      await evidence(page, "trust-read-error-after-refused-save");
    } finally {
      await client.close();
    }
  } finally {
    await Promise.all([peer.close(), application.close()]);
  }
});

test("the first dashboard snapshot recovers a preference missed during connection", async ({ page, daemon }) => {
  await enableSettingsPreview(daemon);
  withDaemonDb(daemon, db => db.prepare("INSERT INTO app_config (key, value) VALUES (?, ?)").run(
    SESSION_SETTINGS_ACCESS.key, JSON.stringify(true),
  ));
  await api(daemon, "/api/ui/config", { richText: false }, "PUT");
  const client = await connect(daemon, await dispatch(daemon, "Change formatting before dashboard connects"));
  let releaseStream!: () => void;
  const streamGate = new Promise<void>(resolve => { releaseStream = resolve; });
  try {
    await page.route("**/events", async route => {
      await streamGate;
      await route.continue();
    });
    const streamRequested = page.waitForRequest(request => request.url().endsWith("/events"));
    const hydration = page.waitForResponse(response => response.url().endsWith("/api/ui/config")
      && response.request().method() === "GET" && response.ok());
    await page.goto(`${daemon.baseURL}/#/settings/display`, { waitUntil: "domcontentloaded" });
    await streamRequested;
    expect(await (await hydration).json()).toMatchObject({ config: { richText: false } });
    const format = page.getByRole("checkbox", { name: /Format messages/i });
    await expect(format).not.toBeChecked();
    expect(await callSettings(client, { operation: "set", key: "ui.richText", value: true }))
      .toMatchObject({ value: true });

    releaseStream();
    await expect(format).toBeChecked();
    await evidence(page, "format-recovered-on-first-snapshot");
  } finally {
    releaseStream();
    await client.close();
  }
});

test("typed Harnesses defaults and Display preferences update an open dashboard", async ({ dashboard: page, daemon }) => {
  await enableSettingsPreview(daemon);
  withDaemonDb(daemon, db => db.prepare("INSERT INTO app_config (key, value) VALUES (?, ?)").run(
    SESSION_SETTINGS_ACCESS.key, JSON.stringify(true),
  ));
  const client = await connect(daemon, await dispatch(daemon, "Change launch defaults"));
  try {
    await openDisplay(page);
    const format = page.getByRole("checkbox", { name: /Format messages/i });
    await expect(format).toBeChecked();
    expect(await callSettings(client, { operation: "set", key: "ui.richText", value: false }))
      .toMatchObject({ value: false });
    await expect(format).not.toBeChecked();

    await page.getByRole("tab", { name: "Harnesses", exact: true }).click();
    const runtime = page.getByRole("combobox", { name: "Session runtime for dispatched Claude Code sessions" });
    await expect(runtime).toHaveValue("sdk");
    expect(await callSettings(client, { operation: "find", query: "claude session runtime" })).toMatchObject({
      matches: [{ key: "harnesses.sessionRuntime.claude", access: "read-write" }],
    });
    const key = "harnesses.sessionRuntime.claude";
    expect(await callSettings(client, { operation: "get", key })).toMatchObject({ value: "sdk" });
    // The open panel re-reads the same route after the Harnesses notification.
    const read = page.waitForResponse(response => response.url().endsWith("/api/harnesses/config")
      && response.request().method() === "GET" && response.ok());
    expect(await callSettings(client, { operation: "set", key, value: "terminal" })).toMatchObject({ value: "terminal" });
    await read;
    await expect(runtime).toHaveValue("terminal");
    await runtime.scrollIntoViewIfNeeded();
    await evidence(page, "typed-harness-runtime-live");

    const saved = page.waitForResponse(response => response.url().endsWith("/api/harnesses/config")
      && response.request().method() === "PUT" && response.ok());
    await runtime.selectOption("sdk");
    await saved;
    expect(await callSettings(client, { operation: "get", key })).toMatchObject({ value: "sdk" });
    expect(await callSettings(client, { operation: "get", key: "harnesses.sessionRuntime.codex" })).toMatchObject({ value: "sdk" });
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();
    const judgePasses = page.getByRole("checkbox", { name: "Skip judges that already passed" });
    await expect(judgePasses).toBeChecked();
    const judgeKey = "workflows.skipPassedJudges";
    expect(await callSettings(client, { operation: "set", key: judgeKey, value: false })).toMatchObject({ value: false });
    await expect(judgePasses).not.toBeChecked();
    const preference = page.waitForResponse(response => response.url().endsWith("/api/workflows/config")
      && response.request().method() === "PATCH" && response.ok());
    await judgePasses.check();
    await preference;
    expect(await callSettings(client, { operation: "get", key: judgeKey })).toMatchObject({ value: true });

    await api(daemon, "/api/feature-flags", { kind: "flag", id: "inbox", enabled: true }, "PUT");
    await page.getByRole("tab", { name: "Reports", exact: true }).click();
    const guidance = page.getByRole("textbox", { name: "Report guidance" });
    await expect(guidance).toBeVisible();
    await guidance.fill("Post only on completion.");
    const reportSave = page.waitForResponse(response => response.url().endsWith("/api/reports/guidance")
      && response.request().method() === "PUT" && response.ok());
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(await (await reportSave).json()).toMatchObject({ guidance: "Post only on completion." });
    await callSettings(client, { operation: "set", key: "reports.guidance", value: "Post exceptional findings." }, "protected");
    expect(await api(daemon, "/api/reports/guidance")).toMatchObject({ guidance: "Post only on completion." });
    await expect(guidance).toHaveValue("Post only on completion.");
    await evidence(page, "report-guidance-operator-only");
  } finally {
    await client.close();
  }
});

test("saving Workflow retention from a stale panel preserves a session's judge preference", async ({ dashboard: page, daemon }) => {
  await enableSettingsPreview(daemon);
  withDaemonDb(daemon, db => db.prepare("INSERT INTO app_config (key, value) VALUES (?, ?)").run(
    SESSION_SETTINGS_ACCESS.key, JSON.stringify(true),
  ));
  const client = await connect(daemon, await dispatch(daemon, "Change judge preference"));
  let releaseRefresh!: () => void;
  const holdRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  try {
    await page.getByRole("button", { name: /^Settings\b/ }).click();
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();
    const reuse = page.getByRole("checkbox", { name: "Skip judges that already passed" });
    await expect(reuse).toBeEnabled();
    await expect(reuse).toBeChecked();
    await page.route("**/api/workflows/config", async route => {
      if (route.request().method() === "GET") await holdRefresh;
      await route.continue();
    });
    const key = "workflows.skipPassedJudges";
    expect(await callSettings(client, { operation: "set", key, value: false })).toMatchObject({ value: false });
    await expect(reuse).toBeChecked();
    const limit = page.getByRole("spinbutton", { name: "Newest completed runs kept" });
    await limit.fill("1100");
    const saved = page.waitForResponse(response => response.url().endsWith("/api/workflows/config")
      && response.request().method() !== "GET" && response.ok());
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    expect(await (await saved).json()).toMatchObject({ retention: { maxCompletedRuns: 1100 } });
    expect(await callSettings(client, { operation: "get", key })).toMatchObject({ value: false });
    await expect(reuse).not.toBeChecked();
    await evidence(page, "workflow-retention-preserves-session-preference");
  } finally {
    releaseRefresh();
    await client.close();
  }
});

test("an individual flag intent updates open dashboards and a human edit reads back through the tool", async ({ page, browser, daemon }) => {
  await enableSettingsPreview(daemon);
  withDaemonDb(daemon, db => db.prepare("INSERT INTO app_config (key, value) VALUES (?, ?)").run(
    SESSION_SETTINGS_ACCESS.key, JSON.stringify(true),
  ));
  const client = await connect(daemon, await dispatch(daemon, "Show Idle rail section counts"));
  const peer = await browser.newPage();
  try {
    const key = "featureFlags.idle-rail-section-counts";
    for (const window of [page, peer]) await window.goto(`${daemon.baseURL}/#/settings/feature-flags`);
    const filter = (window: Page) => window.getByRole("textbox", { name: "Filter feature flags" });
    for (const window of [page, peer]) await filter(window).fill("Counts on Idle rail sections");
    const flag = (window: Page) => window.getByRole("button", { name: /^Counts on Idle rail sections:/ });
    for (const window of [page, peer]) await expect(flag(window)).toHaveAttribute("aria-pressed", "false");
    expect(await callSettings(client, { operation: "find", query: "counts on idle rail sections" })).toMatchObject({
      matches: [{ key, access: "read-write" }],
    });
    expect(await callSettings(client, { operation: "set", key, value: true })).toMatchObject({ value: true });
    expect(await callSettings(client, { operation: "get", key })).toMatchObject({ value: true });
    for (const window of [page, peer]) await expect(flag(window)).toHaveAttribute("aria-pressed", "true");
    await evidence(peer, "specialized-flag-live");
    await flag(page).click();
    await expect(flag(peer)).toHaveAttribute("aria-pressed", "false");
    expect(await callSettings(client, { operation: "get", key })).toMatchObject({ value: false });
  } finally {
    await Promise.all([client.close(), peer.close()]);
  }
});

test("a stale retention confirmation is refused and the operator can confirm again", async ({ dashboard: page, daemon }) => {
  await enableSettingsPreview(daemon);
  withDaemonDb(daemon, db => db.prepare("INSERT INTO app_config (key, value) VALUES (?, ?)").run(
    SESSION_SETTINGS_ACCESS.key, JSON.stringify(true),
  ));
  const client = await connect(daemon, await dispatch(daemon, "Keep more Workflow history"));
  try {
    await page.goto(`${daemon.baseURL}/#/settings/workflows`);
    const limit = page.getByRole("spinbutton", { name: "Newest completed runs kept" });
    await expect(limit).toHaveValue("1000");
    await limit.fill("900");
    const apply = page.getByRole("button", { name: "Apply", exact: true });
    const confirm = page.getByRole("button", { name: "Shorten retention", exact: true });
    await apply.click();
    await expect(confirm).toBeVisible();
    const key = "workflows.retention.maxCompletedRuns";
    const refreshed = page.waitForResponse(async response => response.url().endsWith("/api/workflows/config")
      && response.request().method() === "GET" && response.ok()
      && (await response.json()).retention.maxCompletedRuns === 1200);
    await callSettings(client, { operation: "set", key, value: 1200 });
    await refreshed;
    const write = (status: number) => page.waitForResponse(response => response.url().endsWith("/api/workflows/config")
      && response.request().method() === "PATCH" && response.status() === status);
    await Promise.all([write(409), confirm.click()]);
    await expect(page.getByText(/Workflow retention would shorten/)).toBeVisible();
    expect(await callSettings(client, { operation: "get", key })).toMatchObject({ value: 1200 });
    await evidence(page, "inspector-retention-stale-confirmation");
    await apply.click();
    await Promise.all([write(200), confirm.click()]);
    expect(await callSettings(client, { operation: "get", key })).toMatchObject({ value: 900 });
  } finally {
    await client.close();
  }
});

test("Voice refreshes from a session and a reaffirmation refuses an older dashboard placement write", async ({ dashboard: page, daemon }) => {
  await enableSettingsPreview(daemon);
  await enableVoice(daemon);
  withDaemonDb(daemon, db => db.prepare("INSERT INTO app_config (key, value) VALUES (?, ?)").run(
    SESSION_SETTINGS_ACCESS.key, JSON.stringify(true),
  ));
  const client = await connect(daemon, await dispatch(daemon, "Adjust Voice settings"));
  try {
    await pauseDashboardTimers(page);
    await page.goto(`${daemon.baseURL}/#/settings/voice`);
    const delay = page.getByRole("combobox", { name: "End-of-speech delay" });
    await expect(delay).toBeEnabled();
    const value = await delay.inputValue() === "2000" ? 1500 : 2000;
    await callSettings(client, { operation: "set", key: "voice.endOfSpeechMs", value });
    await expect(delay).toHaveValue(String(value));

    const placement = page.getByRole("group", { name: "Confirmation card" });
    const toast = placement.getByRole("radio", { name: /Corner toast/ });
    await expect(toast).toBeChecked();
    const url = `${daemon.baseURL}/api/voice/confirmation`;
    const pending = page.waitForRequest(request => request.url() === url && request.method() === "PUT");
    await page.route(url, route => route.abort(), { times: 1 });
    await placement.getByRole("radio", { name: /Floating pill/ }).click();
    const older = (await pending).postDataJSON();
    expect(older.expectedVersion).toBeDefined();
    const key = "ui.voice.confirmation";
    await callSettings(client, { operation: "set", key, value: "toast" });
    const late = await page.request.put(url, { data: older });
    expect(late.status()).toBe(409);
    expect(await late.json()).toMatchObject({ confirmation: "toast" });
    await expect(toast).toBeChecked();
    await evidence(page, "inspector-voice-live");
  } finally {
    await client.close();
  }
});

test("the open Task Sources editor shows a Jira filter changed through mission_settings", async ({ dashboard: page, daemon }) => {
  await enableSettingsPreview(daemon);
  withDaemonDb(daemon, db => db.prepare("INSERT INTO app_config (key, value) VALUES (?, ?)").run(
    SESSION_SETTINGS_ACCESS.key, JSON.stringify(true),
  ));
  const path = "/api/task-sources/config";
  const { revision } = await api(daemon, path);
  const id = "settings-fixture-jira";
  await api(daemon, path, { revision, sources: [{
    id, kind: "jira", label: "Example issue queue", repoRoot: daemon.repo, config: { jql: "project = ONE" },
  }] }, "PUT");
  const client = await connect(daemon, await dispatch(daemon, "Change the Jira filter"));
  try {
    await pauseDashboardTimers(page);
    await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
    const query = page.getByLabel("JQL filter");
    await expect(query).toHaveValue("project = ONE");
    const key = `taskSources.${createHash("sha256").update(id).digest("base64url")}.config.jql`;
    await callSettings(client, { operation: "set", key, value: "project = TWO" });
    await expect(query).toHaveValue("project = TWO");
    await evidence(page, "inspector-task-sources-live");
  } finally {
    await client.close();
  }
});

test.describe("saved Repository Index", () => {
  test.use({ daemonEnv: { MC_E2E_USE_REPO_INDEX_DEFAULTS: "1" } });

  test("the open Repository Index drops a directory changed through mission_settings", async ({ dashboard: page, daemon }) => {
    await enableSettingsPreview(daemon);
    withDaemonDb(daemon, db => db.prepare("INSERT INTO app_config (key, value) VALUES (?, ?)").run(
      SESSION_SETTINGS_ACCESS.key, JSON.stringify(true),
    ));
    const client = await connect(daemon, await dispatch(daemon, "Stop indexing the dev folder"));
    try {
      await pauseDashboardTimers(page);
      await openRepositorySetup(page, daemon.baseURL);
      const directory = page.getByText("~/dev", { exact: true });
      await expect(directory).toBeVisible();
      const key = "repoIndex.directories";
      const { value, version } = await callSettings(client, { operation: "get", key });
      await callSettings(client, { operation: "set", key, expectedVersion: version,
        value: value.filter((row: { path: string }) => row.path !== "~/dev") });
      await expect(directory).toHaveCount(0);
      await expect(page.getByText("~/workspace", { exact: true })).toBeVisible();
      await evidence(page, "inspector-repository-index-live");
    } finally {
      await client.close();
    }
  });
});
