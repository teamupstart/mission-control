import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * Herdr installed, its default server down - the resting state of any machine with the CLI
 * and no Herdr window open, and the state this suite reaches by simply not dispatching.
 *
 * `MISSION_POLL_MS` is short on purpose. Discovery sweeps every installed backend on that
 * tick, so a low value is what makes the daemon log assertion below mean something: dozens
 * of sweeps run against a stopped Herdr server before the first assertion is reached.
 */
test.use({ daemonEnv: { MC_E2E_HERDR: "1", MISSION_POLL_MS: "100" } });

const ROW = "dependency-herdr";

test("Setup reports a stopped Herdr server, starts it, and discovery never logs it", async ({
  page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "terminals");
  const herdr = setupRow(page, ROW);

  await expectRowStatus(page, ROW, "Needs setup");
  await expect(herdr).toContainText(
    "Herdr is installed but its default server is not running.",
  );
  // Not the install guide: Herdr IS installed, and installing it again repairs nothing.
  await expect(herdr.getByRole("link", { name: "Open Herdr installation guide" })).toHaveCount(0);
  // And no terminal picker, because nothing opens a window to pick or to watch.
  await expect(herdr.getByLabel("Terminal for Herdr")).toHaveCount(0);
  await expect(herdr.getByRole("button", { name: "Run in a terminal" })).toHaveCount(0);

  // The bug this row exists to replace: the adapter used to throw on exactly this state, and
  // the sweep caught it and printed a stack trace on every tick, forever.
  expect(daemon.readLog()).not.toContain("multiplexer herdr failed to enumerate");

  const started = page.waitForResponse((response) =>
    response.url().endsWith("/api/setup/service") && response.request().method() === "POST");
  await herdr.getByRole("button", { name: "Start the Herdr server" }).click();
  const response = await started;
  expect(response.request().postDataJSON()).toEqual({ service: "herdr-server" });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    service: "herdr-server",
    outcome: "started",
    label: "Herdr server",
    detail: "The Herdr server is running.",
  });

  // The panel re-reads the machine itself, so the row it repaired reports the new truth
  // rather than waiting for a Re-check the operator has already asked for.
  await expectRowStatus(page, ROW, "Ready");
  await expect(herdr).toContainText("server 0.8.2");
  expect(daemon.readLog()).not.toContain("multiplexer herdr failed to enumerate");

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("herdr-server-setup");
    mkdirSync(evidence, { recursive: true });
    await page.mouse.move(1, 1);
    await page.screenshot({ path: join(evidence, "herdr-row-started.png"), fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/herdr-server-setup/herdr-row-started.png");
  }
});

test("Setup keeps a refused start on screen with the daemon's own sentence", async ({
  page,
  daemon,
}) => {
  await page.route("**/api/setup/service", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ service: "herdr-server" });
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        service: "herdr-server",
        outcome: "refused",
        label: "Herdr server",
        detail: "Herdr server did not become ready. Start Herdr or restart its server, then try again.",
      }),
    });
  });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "terminals");
  const herdr = setupRow(page, ROW);

  await herdr.getByRole("button", { name: "Start the Herdr server" }).click();
  await expect(herdr.getByRole("status")).toContainText("Herdr server did not become ready.");
  await expect(herdr.getByRole("status")).toContainText(
    "Start it yourself in a terminal, then press Re-check.",
  );
  // A refusal repairs nothing, so the row keeps saying what is wrong and offering the start.
  await expectRowStatus(page, ROW, "Needs setup");
  await expect(herdr.getByRole("button", { name: "Start the Herdr server" })).toBeEnabled();

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("herdr-server-setup");
    mkdirSync(evidence, { recursive: true });
    await page.mouse.move(1, 1);
    await herdr.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, "herdr-row-refused.png") });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/herdr-server-setup/herdr-row-refused.png");
  }
});
