import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

test.use({ daemonEnv: { MC_E2E_CONDUCTOR_STARTS_MISSING: "1" } });

test("Setup recovers when its inspection request is rejected", async ({ page, daemon }) => {
  await page.route("**/api/setup/checks", (route) => route.abort("connectionrefused"));
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  await expect(page.getByText("Mission Control could not inspect this machine's setup.")).toBeVisible();
  const recheck = page.getByRole("button", { name: "Re-check" });
  await expect(recheck).toBeEnabled();
});

test("Setup clears stale results when a re-check is rejected", async ({ page, daemon }) => {
  let rejectChecks = false;
  await page.route("**/api/setup/checks", (route) => {
    if (rejectChecks) return route.abort("connectionrefused");
    return route.continue();
  });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  const claude = page.locator('[data-anchor="setup/dependency-claude-cli"]');
  await expect(claude).toContainText("Ready");

  rejectChecks = true;
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByText("Mission Control could not inspect this machine's setup.")).toBeVisible();
  await expect(claude).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Re-check" })).toBeEnabled();
});

test("Setup explains the machine and re-checks without executing a remedy", async ({ page, daemon }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  const scope = page.locator(".settings-panel-head .settings-scope");
  await expect(scope).toHaveText("Reads ~/");
  await scope.hover();
  await expect(page.locator(".tooltip")).toHaveText(
    "Inspects tools and configuration in your home directory without changing them.",
  );

  const claude = page.locator('[data-anchor="setup/dependency-claude-cli"]');
  await expect(claude).toContainText("Claude Code");
  await expect(claude).toContainText("Ready");
  await expect(claude).toContainText(daemon.home);

  const conductor = page.locator('[data-anchor="setup/dependency-ai-conductor"]');
  await expect(conductor).toContainText("Missing");
  await expect(conductor.getByRole("link", { name: "Open Conductor settings" })).toBeVisible();

  const wezterm = page.locator('[data-anchor="setup/dependency-wezterm"]');
  await expect(wezterm).toContainText("Missing");
  await expect(wezterm.getByRole("button", { name: "Copy" })).toBeVisible();

  daemon.installFakeConductor();
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(conductor).toContainText("Ready");
  await expect(conductor).toContainText("installed-conductor/bin/conduct-ts");

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("guided-setup");
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/setup-panel.png`, fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/guided-setup/setup-panel.png");
  }
});

test.describe("login-shell binaries", () => {
  test.use({
    daemonEnv: {
      MC_E2E_CONDUCTOR_STARTS_MISSING: "1",
      MC_E2E_PI_LOGIN_SHELL_ONLY: "1",
    },
  });

  test("Setup recognizes Pi installed by a login-shell version manager", async ({ page, daemon }) => {
    await page.goto(`${daemon.baseURL}/#/settings/setup`);

    const pi = page.locator('[data-anchor="setup/dependency-pi-cli"]');
    await expect(pi).toContainText("Pi");
    await expect(pi).toContainText("Ready");
    await expect(pi).toContainText("login-bin/pi");
    await expect(pi.getByText("Missing", { exact: true })).not.toBeVisible();

    if (process.env.MC_E2E_EVIDENCE === "1") {
      const evidence = artifactsDir("pi-login-shell-setup");
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/pi-ready.png`, fullPage: true });
      // eslint-disable-next-line no-console
      console.log("CAPTURED e2e/.artifacts/pi-login-shell-setup/pi-ready.png");
    }
  });
});
