import { mkdirSync } from "node:fs";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expect, test } from "../fixtures/test.ts";

test.use({ viewport: { width: 1280, height: 900 } });

test("GitHub Inspector starts enabled and live, and saves operator overrides", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);
  const enabled = dashboard.getByRole("checkbox", { name: "Run GitHub Inspector" });
  const live = dashboard.getByRole("radio", { name: "Live", exact: true });
  const dryRun = dashboard.getByRole("radio", { name: "Dry run", exact: true });

  await expect(enabled).toBeEnabled();
  await expect(enabled).toBeChecked();
  await expect(live).toBeChecked();
  await expect(dashboard.getByText("Live - posting review comments to GitHub")).toBeVisible();
  await expect(dashboard.getByText("GitHub Inspector may post reviews in no repositories yet.")).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("inspector-defaults");
    mkdirSync(dir, { recursive: true });
    await dashboard.screenshot({ path: `${dir}fresh-install.png`, animations: "disabled" });
  }

  await dryRun.press("Space");
  await expect(dashboard.getByText("Dry run - reviewing, publishing nothing")).toBeVisible();
  await enabled.press("Space");
  await expect(dashboard.getByText("Off - nothing is being reviewed")).toBeVisible();

  await daemon.shutdown();
  await daemon.restart();
  await dashboard.reload();
  await expect(enabled).toBeEnabled();
  await expect(enabled).not.toBeChecked();
  await expect(dryRun).toBeChecked();

  await dashboard.route("**/api/inspector/config", (route) => route.fulfill({ status: 503 }));
  await dashboard.reload();
  await expect(enabled).toBeDisabled();
  await expect(dryRun).toBeDisabled();
  await expect(dashboard.getByText("GitHub Inspector settings are unavailable until the daemon responds.")).toBeVisible();
});

test("an existing installation with no saved Inspector settings stays off and in Dry run", async ({
  dashboard,
  daemon,
}) => {
  // Match the prior release's persisted state after a launch that never saved Inspector settings.
  await daemon.shutdown();
  withDaemonDb(daemon, (db) => db.prepare("DELETE FROM app_config WHERE key = 'inspector'").run());
  await daemon.restart();

  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);
  const enabled = dashboard.getByRole("checkbox", { name: "Run GitHub Inspector" });
  const dryRun = dashboard.getByRole("radio", { name: "Dry run", exact: true });
  await expect(enabled).toBeEnabled();
  await expect(enabled).not.toBeChecked();
  await expect(dryRun).toBeChecked();
  await expect(dashboard.getByText("Off - nothing is being reviewed")).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE) {
    await expect(dashboard.getByRole("button", { name: /^Keep awake/ }).getByText("live", { exact: true })).toBeVisible();
    const dir = artifactsDir("inspector-defaults");
    mkdirSync(dir, { recursive: true });
    await dashboard.screenshot({ path: `${dir}existing-install.png`, animations: "disabled" });
  }
});
