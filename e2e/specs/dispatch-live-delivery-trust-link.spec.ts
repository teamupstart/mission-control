import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("dispatch-live-delivery-trust-link");

const INTENT = "Rename the flexbox helper and update its callers.";

/** Review evidence, captured only when a run explicitly asks for it. */
async function shoot(page: Page, surface: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await surface.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/dispatch-live-delivery-trust-link/${name}.png`);
}

/**
 * Turn the machine-wide half of Live delivery's authorization off.
 *
 * Read-modify-write over the route's own body, because `PUT /api/workflows/config` takes the
 * whole legacy config object: a hand-built body would pin every other field to whatever this
 * spec happened to believe the defaults were.
 */
async function disableLiveDelivery(daemon: DaemonHandle): Promise<void> {
  const read = await fetch(`${daemon.baseURL}/api/workflows/config`);
  if (!read.ok) throw new Error(`reading the workflow config answered ${read.status}`);
  const config = (await read.json()) as Record<string, unknown>;
  const written = await fetch(`${daemon.baseURL}/api/workflows/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...config, liveEnabled: false }),
  });
  if (!written.ok) {
    throw new Error(
      `disabling Live delivery answered ${written.status}: ${await written.text()}`,
    );
  }
}

/**
 * Fill the form and press the primary, leaving the After work selector ALONE.
 *
 * That selector is the whole precondition: the daemon's configured default is the built-in
 * review, whose published version delivers Live, and every other dispatch spec pins it to
 * None precisely to avoid the refusal these cases are about.
 */
async function dispatchWithTheDefaultWorkflow(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its list over the form. Close it before reaching the fields below.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(INTENT);

  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  return dialog;
}

/**
 * What is at stake: a refusal with nowhere to go.
 *
 * A fresh install ships Live delivery's machine-wide switch ON and its repository allowlist
 * EMPTY, so the very first dispatch that keeps the default Workflow is refused - and the
 * sentence used to name "an allowlisted repository" without saying that allowlists are
 * granted in Settings, Trust, on a matrix three navigations away. This pins the door: the
 * refusal carries a control, the control closes the form, and it lands on the Trust matrix
 * with the draft still waiting behind it.
 */
test("a Live-delivery refusal offers the Trust matrix as a control", async ({
  dashboard,
  daemon,
}) => {
  const dialog = await dispatchWithTheDefaultWorkflow(dashboard, daemon);

  await expect(dialog).toContainText(
    "This workflow uses Live delivery, which is not granted for this repository",
  );
  const door = dialog.getByRole("button", { name: "Grant it in Trust" });
  await expect(door).toBeVisible();
  await shoot(dashboard, dialog, "refusal-with-door");

  await door.click();

  // The form goes first: the destination is a full page, and a modal left standing over the
  // screen the operator was just sent to is not an offer.
  await expect(dialog).toBeHidden();
  await expect.poll(() => dashboard.evaluate(() => location.hash)).toBe("#/settings/trust");
  await expect(dashboard.locator('[data-anchor="trust/matrix"]')).toHaveClass(/settings-flash/);
  await expect(dashboard.getByRole("table", { name: "Repository trust grants" })).toBeVisible();

  // The draft survived the close, so the operator can grant and come straight back to the
  // launch they typed rather than typing it again.
  await dashboard.evaluate(() => { location.hash = "#/fleet"; });
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder("What should this agent do?")).toHaveValue(INTENT);
});

/**
 * The OTHER half, which is a different screen and therefore a different door.
 *
 * Live delivery is authorized by a machine-wide switch and a per-repository grant, and they
 * are answered in two different places: the switch in Settings, Workflows, and the grant on
 * the Trust matrix. Sending an operator whose switch is off to Trust would have them make a
 * grant that still delivers nothing, so this case exists to prove the refusal picks the half
 * that is actually missing - the copy, the control, and where it lands.
 */
test("a machine with Live delivery switched off offers the Workflows switch instead", async ({
  dashboard,
  daemon,
}) => {
  await disableLiveDelivery(daemon);

  const dialog = await dispatchWithTheDefaultWorkflow(dashboard, daemon);

  await expect(dialog).toContainText(
    "This workflow uses Live delivery, which is switched off for this machine",
  );
  // Not the Trust door. The two refusals are mutually exclusive, and offering the wrong one
  // is the failure this whole change exists to prevent.
  await expect(dialog.getByRole("button", { name: "Grant it in Trust" })).toHaveCount(0);
  const door = dialog.getByRole("button", { name: "Turn on Live delivery" });
  await expect(door).toBeVisible();
  await shoot(dashboard, dialog, "machine-switch-refusal-with-door");

  // The hover copy is an INSTRUCTION, not a reading of the switch. Phrased as a state
  // ("where Live delivery is switched on") it contradicted the sentence directly above it,
  // which is telling the operator the switch is off.
  await door.focus();
  await expect(
    dashboard.locator(".tooltip")
      .getByText("Open Settings, Workflows, and turn Live delivery on", { exact: true }),
  ).toBeVisible();
  await door.blur();

  await door.click();

  await expect(dialog).toBeHidden();
  await expect.poll(() => dashboard.evaluate(() => location.hash)).toBe("#/settings/workflows");
  await expect(
    dashboard.locator('[data-anchor="workflows/live-delivery"]'),
  ).toHaveClass(/settings-flash/);
  // The card it landed on is the one that carries the switch, and the switch reads OFF -
  // which is the state the refusal just described.
  const machineSwitch = dashboard.getByRole("checkbox", {
    name: "Enable Live workflow delivery",
  });
  await expect(machineSwitch).toBeVisible();
  await expect(machineSwitch).not.toBeChecked();
});
