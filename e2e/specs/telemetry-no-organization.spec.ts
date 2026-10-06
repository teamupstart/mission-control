import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("telemetry-no-organization");

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/telemetry-no-organization/${name}.png`);
}

/**
 * Settings > Telemetry on a machine no organization manages - every machine the suite runs
 * on, and every machine outside Upstart.
 *
 * The other half of the managed-lane contract: recognition adds a view-only panel for the one
 * organization it matches, and changes nothing anywhere else. No organization's name appears,
 * and every control the earlier phases shipped is still there and still editable.
 */
test("an unmanaged machine shows no organization and keeps every telemetry control editable", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  const panel = dashboard
    .locator("section.settings-section")
    .filter({ hasText: "Collect telemetry on this machine" });
  await expect(panel).toBeVisible();

  const status = (await (
    await dashboard.request.get(`${daemon.baseURL}/api/telemetry/config`)
  ).json()) as { organization?: unknown };
  expect(status.organization ?? null).toBeNull();

  await expect(panel.getByText(/Upstart/)).toHaveCount(0);
  await expect(panel.getByText(/Managed by/)).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /Check again whether .* manages this Mac/ }),
  ).toHaveCount(0);

  // Every control is present and editable, including the temporality and shape selects.
  for (const label of [
    "Collect Mission Control telemetry on this machine",
    "Export telemetry to your own backend",
    "Telemetry export endpoint",
    "Telemetry credential header name",
    "Telemetry export credential",
    "Metric temporality for your own backend",
    "Export shape for your own backend",
    "Product analytics endpoint",
    "Metric temporality for product analytics",
    "Export shape for product analytics",
  ]) {
    await expect(panel.getByLabel(label, { exact: true })).toBeEnabled();
  }
  await expect(panel.getByRole("button", { name: "Save destination" }).first()).toBeEnabled();
  await shoot(dashboard, "01-unmanaged-editable");
  // Settings scrolls inside its own pane, so the product destination needs its own frame.
  await panel.locator('[data-anchor="telemetry/product"]').scrollIntoViewIfNeeded();
  await shoot(dashboard, "02-unmanaged-product-editable");

  // And the daemon accepts the write a person makes from here.
  const saved = await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
    data: { enabled: true },
  });
  expect(saved.status()).toBe(200);
  await expect(
    dashboard.getByLabel("Collect Mission Control telemetry on this machine"),
  ).toBeChecked();
});
