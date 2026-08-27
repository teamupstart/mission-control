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
