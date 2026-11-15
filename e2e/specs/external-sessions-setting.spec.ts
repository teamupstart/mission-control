import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { openSetupFamily } from "../fixtures/setup-panel.ts";

/**
 * Settings > Setup > Terminals: **Show sessions started outside Mission Control**.
 *
 * The e2e daemon runs with discovery off (`MISSION_POLL_MS=0`) and fakes every agent, so it
 * cannot start a real session outside Mission Control. What the setting DOES to discovery is
 * covered by `test/discovery-admission.test.ts`, through the real poller with an injected
 * process table. This spec covers what a person sees and what survives a reload: the switch
 * starts off on a fresh state home, the warning is always on screen, and each change is
 * stored by the daemon rather than only drawn by the panel.
 */

const WARNING =
  "Off by default. When on, Mission Control also shows Claude, Codex, and Pi sessions you " +
  "started yourself in a terminal. This works poorly on some setups: cards can show the wrong " +
  "state, name, or pane, and sending to them can fail. Sessions Mission Control starts are " +
  "always shown.";

test("the outside-sessions switch starts off, warns, and keeps each change across a reload", async ({
  page,
  daemon,
}) => {
  const open = async (): Promise<void> => {
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page, "terminals");
  };
  const toggle = () =>
    page.getByRole("checkbox", { name: "Show sessions started outside Mission Control" });
  const stored = async (): Promise<boolean> => {
    const res = await page.request.get(`${daemon.baseURL}/api/terminals/config`);
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { externalSessions: boolean }).externalSessions;
  };

  await open();
  await expect(toggle()).toBeEnabled();
  await expect(toggle()).not.toBeChecked();
  await expect(page.getByText(WARNING, { exact: true })).toBeVisible();
  // Announced with the control, so the warning is read before anyone turns it on. Contained
  // rather than equal: the shared Tooltip appends its own hover description after it.
  await expect(toggle()).toHaveAccessibleDescription(new RegExp(WARNING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(await stored()).toBe(false);

  await toggle().check();
  await expect(toggle()).toBeChecked();
  await expect.poll(stored).toBe(true);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("external-sessions-setting");
    mkdirSync(evidence, { recursive: true });
    await page.locator(".setup-external-sessions").screenshot({ path: join(evidence, "terminals-switch-on.png") });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/external-sessions-setting/terminals-switch-on.png");
  }

  await page.reload();
  await openSetupFamily(page, "terminals");
  await expect(toggle()).toBeChecked();
  // Still shown while it is on: the warning is about what turning it on means.
  await expect(page.getByText(WARNING, { exact: true })).toBeVisible();

  await toggle().uncheck();
  await expect(toggle()).not.toBeChecked();
  await expect.poll(stored).toBe(false);

  await page.reload();
  await openSetupFamily(page, "terminals");
  await expect(toggle()).not.toBeChecked();

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("external-sessions-setting");
    await page.locator(".setup-external-sessions").screenshot({ path: join(evidence, "terminals-switch-off.png") });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/external-sessions-setting/terminals-switch-off.png");
  }
});
