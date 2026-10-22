import { mkdirSync } from "node:fs";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

const PREFERENCES = [
  { key: "keepShipTasksMoving", label: "Keep pre-PR ship tasks moving" },
  { key: "trackReviewFeedback", label: "Keep sessions on track with review comments" },
  { key: "trackCiFailures", label: "Keep sessions on track with CI" },
] as const;

test("all three pull-request controls default on and preserve independent saved opt-outs", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1500, height: 1100 });
  // Do not seed Foreman config: this must exercise a fresh installation's actual defaults.
  const readConfig = async () => {
    const response = await fetch(`${daemon.baseURL}/api/foreman/config`);
    expect(response.ok).toBe(true);
    return response.json();
  };
  const expected = Object.fromEntries(PREFERENCES.map(({ key }) => [key, true]));
  expect(await readConfig()).toMatchObject(expected);

  const openControls = async () => {
    await dashboard.getByRole("button", { name: /Foreman - the auto-responder/ }).click();
    const dialog = dashboard.getByRole("dialog", { name: "Foreman settings", exact: true });
    await expect(dialog).toBeVisible();
    return dialog.getByRole("group", { name: "Pull requests", exact: true });
  };
  let controls = await openControls();
  for (const { label } of PREFERENCES) {
    await expect(controls.getByRole("checkbox", { name: label, exact: true })).toBeChecked();
    await expect(controls.getByRole("checkbox", { name: label, exact: true })).toBeEnabled();
  }
  await expectContentClearsBorder(controls);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("foreman-pr-defaults");
    mkdirSync(dir, { recursive: true });
    await controls.screenshot({ path: `${dir}defaults-on.png` });
  }

  // Each checkbox must save only its own preference. Reload after every write so a local
  // optimistic checkmark cannot pass for persistence, and check the other two each time.
  for (const { key, label } of PREFERENCES) {
    await controls.getByRole("checkbox", { name: label, exact: true }).uncheck();
    expected[key] = false;
    await expect.poll(readConfig).toMatchObject(expected);
    await dashboard.reload();
    controls = await openControls();
    for (const preference of PREFERENCES) {
      await expect(controls.getByRole("checkbox", { name: preference.label, exact: true }))
        .toBeChecked({ checked: expected[preference.key] });
    }
  }

  if (process.env.MC_E2E_EVIDENCE) {
    await controls.screenshot({ path: `${artifactsDir("foreman-pr-defaults")}saved-off.png` });
  }
});
