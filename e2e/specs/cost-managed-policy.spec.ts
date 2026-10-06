import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * Settings > Cost on a machine whose managed Claude Code policy sends metrics elsewhere.
 *
 * A managed policy outranks the `env` block the Cost switch writes, so a policy that names
 * its own metrics endpoint wins and every session Mission Control merely discovered reports to
 * that host instead. The panel used to wait a week and then blame "a managed policy [that]
 * disables telemetry". It now names the host as soon as the switch is on.
 *
 * The policy is `managed-settings.json` under a fixture root, never a plist, so this runs on
 * Linux CI where `plutil` does not exist - and never the real `/Library` policy of the Mac that
 * runs the suite.
 */

const EVIDENCE = artifactsDir("cost-managed-policy");

const policyRoot = mkdtempSync(join(tmpdir(), "mission-e2e-managed-policy-"));
const policyDir = join(policyRoot, "Library", "Application Support", "ClaudeCode");
mkdirSync(policyDir, { recursive: true });
writeFileSync(
  join(policyDir, "managed-settings.json"),
  JSON.stringify({
    env: {
      // Userinfo, a port, a path and a query, none of which may reach the browser.
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
        "https://svc:s3cret@otel.example.com:4318/v1/metrics?tenant=t-123",
      // A key that is none of Mission Control's business, and must never be read out.
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer s3cret",
    },
  }),
);
test.afterAll(() => rmSync(policyRoot, { recursive: true, force: true }));

test.use({ daemonEnv: { MISSION_MANAGED_SETTINGS_ROOT: policyRoot } });

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page
    .locator("section.settings-section")
    .first()
    .screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/cost-managed-policy/${name}.png`);
}

test("Cost settings names the host a managed policy sends metrics to", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/cost`);
  const toggle = dashboard.getByLabel("Export Claude Code usage telemetry to Mission Control", {
    exact: true,
  });
  await expect(toggle).toBeEnabled();

  // With Cost off, the policy is not this panel's business yet.
  await expect(dashboard.getByText(/managed Claude Code policy/)).toHaveCount(0);

  await toggle.check();
  await expect(toggle).toBeChecked();

  // No organization manages a fixture daemon, so it is "Your organization's". Named at once:
  // no week of silence has passed, and none needs to.
  const warning = dashboard.getByText(
    /Your organization's managed Claude Code policy sends metrics to/,
  );
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText(
    "Your organization's managed Claude Code policy sends metrics to otel.example.com, so the " +
      "estimate covers only sessions Mission Control runs. Sessions you started yourself in a " +
      "terminal are not counted.",
    { useInnerText: true },
  );
  await expect(warning.locator("code")).toHaveText("otel.example.com");

  // The generic warnings, which would guess at the cause or promise that new sessions will
  // report, are not shown beside it.
  await expect(dashboard.getByText(/disables telemetry/)).toHaveCount(0);
  await expect(dashboard.getByText(/No Claude telemetry has reported yet/)).toHaveCount(0);

  // Only the host crosses the wire: no scheme, port, path, query, credential or other env key.
  const status = (await (
    await dashboard.request.get(`${daemon.baseURL}/api/cost/config`)
  ).json()) as { managedRedirect: unknown };
  expect(status.managedRedirect).toEqual({
    kind: "redirect",
    host: "otel.example.com",
    source: "managed-settings",
    organizationLabel: null,
  });
  const body = JSON.stringify(status);
  for (const secret of ["s3cret", "svc", "4318", "tenant", "Authorization", policyRoot]) {
    expect(body).not.toContain(secret);
  }

  await shoot(dashboard, "cost-managed-redirect");

  // Switching Cost off again takes the warning with it.
  await toggle.uncheck();
  await expect(warning).toHaveCount(0);
});

// A policy that turns Claude Code's metrics off rather than sending them elsewhere. Its own
// fixture root, because `daemonEnv` is read once, when each test's daemon starts.
const disabledRoot = mkdtempSync(join(tmpdir(), "mission-e2e-managed-policy-off-"));
const disabledDir = join(disabledRoot, "Library", "Application Support", "ClaudeCode");
mkdirSync(disabledDir, { recursive: true });
writeFileSync(
  join(disabledDir, "managed-settings.json"),
  JSON.stringify({
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: "0",
      // Named, but turned off: a disabled policy names no host, whatever endpoint it carries.
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://otel.example.com",
    },
  }),
);
test.afterAll(() => rmSync(disabledRoot, { recursive: true, force: true }));

test.describe("a managed policy that turns metrics off", () => {
  test.use({ daemonEnv: { MISSION_MANAGED_SETTINGS_ROOT: disabledRoot } });

  test("Cost settings says the policy turns metrics off, and names no host", async ({
    dashboard,
    daemon,
  }) => {
    await dashboard.goto(`${daemon.baseURL}/#/settings/cost`);
    const toggle = dashboard.getByLabel("Export Claude Code usage telemetry to Mission Control", {
      exact: true,
    });
    await expect(toggle).toBeEnabled();
    await expect(dashboard.getByText(/managed Claude Code policy/)).toHaveCount(0);

    await toggle.check();
    await expect(toggle).toBeChecked();

    const warning = dashboard.getByText(
      /Your organization's managed Claude Code policy turns Claude Code's metrics off/,
    );
    await expect(warning).toBeVisible();
    await expect(warning).toHaveText(
      "Your organization's managed Claude Code policy turns Claude Code's metrics off, so the " +
        "estimate covers only sessions Mission Control runs.",
      { useInnerText: true },
    );
    // Not the redirect sentence, and no host anywhere on the panel.
    await expect(dashboard.getByText(/sends metrics to/)).toHaveCount(0);
    await expect(dashboard.getByText(/otel\.example\.com/)).toHaveCount(0);
    await expect(dashboard.getByText(/disables telemetry/)).toHaveCount(0);

    const status = (await (
      await dashboard.request.get(`${daemon.baseURL}/api/cost/config`)
    ).json()) as { managedRedirect: unknown };
    expect(status.managedRedirect).toEqual({
      kind: "disabled",
      host: null,
      source: "managed-settings",
      organizationLabel: null,
    });

    await shoot(dashboard, "cost-managed-disabled");

    await toggle.uncheck();
    await expect(warning).toHaveCount(0);
  });
});
