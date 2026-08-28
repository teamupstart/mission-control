import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { shellCommand } from "../../src/server/terminal/shell.ts";
import { setupInstallerShell } from "../../src/server/setup/install.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";

test.use({ daemonEnv: { MC_E2E_CONDUCTOR_STARTS_MISSING: "1" } });

function terminalRecords(recordDir: string): { argv: string[] }[] {
  return recordsIn<{ argv: string[] }>(recordDir, (file) => file.startsWith("cmux-"));
}

test("Setup opens only the daemon-owned install command in the terminal the operator picks", async ({
  page,
  daemon,
}) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  const conductor = page.locator('[data-anchor="setup/dependency-ai-conductor"]');
  await expect(conductor).toContainText("No verified local installer checkout was found");
  await expect(conductor.getByRole("button", { name: "Run in a terminal" })).toHaveCount(0);
  await expect(conductor.getByRole("link", { name: "Open Conductor settings" })).toBeVisible();

  const wezterm = page.locator('[data-anchor="setup/dependency-wezterm"]');
  await expect(wezterm).toContainText("brew install --cask wezterm");
  await expect(wezterm.getByRole("button", { name: "Copy" })).toBeVisible();
  await wezterm.getByLabel("Terminal for WezTerm").selectOption("cmux");

  const requestReady = page.waitForRequest((request) =>
    request.url().endsWith("/api/setup/install") && request.method() === "POST");
  await wezterm.getByRole("button", { name: "Run in a terminal" }).click();
  const request = await requestReady;
  expect(request.postDataJSON()).toEqual({ id: "wezterm", backend: "cmux" });

  await expect(wezterm.getByRole("status")).toContainText(
    "cmux opened the installer. Watch it finish and read its exit code in that window.",
  );
  await expect(wezterm.getByRole("status")).toContainText(
    "When the installer finishes, press Re-check.",
  );

  await expect.poll(() => terminalRecords(daemon.recordDir).length).toBe(1);
  const argv = terminalRecords(daemon.recordDir)[0]?.argv ?? [];
  expect(argv[0]).toBe("new-workspace");
  expect(argv[argv.indexOf("--cwd") + 1]).toBe(daemon.home);
  const actualCommand = argv[argv.indexOf("--command") + 1] ?? "";
  const expectedCommand = shellCommand([
    "/bin/sh",
    "-c",
    setupInstallerShell(["brew", "install", "--cask", "wezterm"]),
  ]);
  expect(actualCommand).toBe(expectedCommand);

  await page.setViewportSize({ width: 680, height: 900 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "setup remedy controls must not create horizontal clipping",
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1200 });

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("guided-setup-phase-2");
    mkdirSync(evidence, { recursive: true });
    await page.mouse.move(1, 1);
    await page.screenshot({
      path: join(evidence, "setup-install-terminal.png"),
      fullPage: true,
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/guided-setup-phase-2/setup-install-terminal.png");
    await conductor.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, "setup-provider-no-candidate.png"),
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/guided-setup-phase-2/setup-provider-no-candidate.png");
  }
});

test("Setup renders the terminal launcher's refusal sentence", async ({ page, daemon }) => {
  await page.route("**/api/setup/install", async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ id: "wezterm", backend: "cmux" });
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        id: "wezterm",
        outcome: "refused",
        label: "cmux",
        detail: "cmux is available but no terminal could raise it.",
      }),
    });
  });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  const wezterm = page.locator('[data-anchor="setup/dependency-wezterm"]');
  await wezterm.getByLabel("Terminal for WezTerm").selectOption("cmux");
  await wezterm.getByRole("button", { name: "Run in a terminal" }).click();
  await expect(wezterm.getByRole("status")).toHaveText(
    "cmux is available but no terminal could raise it.",
  );
  expect(terminalRecords(daemon.recordDir)).toEqual([]);
});

test.describe("with one verified local provider checkout", () => {
  test.use({
    daemonEnv: {
      MC_E2E_CONDUCTOR_STARTS_MISSING: "1",
      MC_E2E_CONDUCTOR_CHECKOUT: "1",
      MC_E2E_CONDUCTOR_NODE_VERSION: "26.7.0",
    },
  });

  test("Setup sends only provider identity and terminal choice", async ({ page, daemon }) => {
    test.setTimeout(45_000);
    expect(daemon.conductorCheckout).not.toBeNull();
    const checkout = daemon.conductorCheckout!;
    await page.goto(`${daemon.baseURL}/#/settings/setup`);

    const conductor = page.locator('[data-anchor="setup/dependency-ai-conductor"]');
    await expect(conductor).toContainText("Verified checkout", { timeout: 20_000 });
    await expect(conductor).toContainText(checkout);
    await conductor.getByLabel("Terminal for ai-conductor").selectOption("cmux");

    const requestReady = page.waitForRequest((request) =>
      request.url().endsWith("/api/setup/install") && request.method() === "POST");
    await conductor.getByRole("button", { name: "Run in a terminal" }).click();
    const request = await requestReady;
    expect(request.postDataJSON()).toEqual({ id: "ai-conductor", backend: "cmux" });

    await expect(conductor.getByRole("status")).toContainText(
      "cmux opened the installer. Watch it finish and read its exit code in that window.",
    );
    await expect.poll(() => terminalRecords(daemon.recordDir).length).toBe(1);
    const argv = terminalRecords(daemon.recordDir)[0]?.argv ?? [];
    const actualCommand = argv[argv.indexOf("--command") + 1] ?? "";
    expect(actualCommand).toContain(`${checkout}/bin/install`);

    if (process.env.MC_E2E_EVIDENCE === "1") {
      const evidence = artifactsDir("guided-setup-phase-2");
      mkdirSync(evidence, { recursive: true });
      await page.mouse.move(1, 1);
      await conductor.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(evidence, "setup-provider-terminal.png"),
      });
      // eslint-disable-next-line no-console
      console.log("CAPTURED e2e/.artifacts/guided-setup-phase-2/setup-provider-terminal.png");
    }
  });
});
