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

test("Which failures count defaults to All checks, follows the CI toggle and persists Required", async ({
  dashboard,
  daemon,
}) => {
  // A fresh install: no Foreman config is seeded.
  await dashboard.setViewportSize({ width: 1500, height: 1100 });
  const readConfig = async () => {
    const response = await fetch(`${daemon.baseURL}/api/foreman/config`);
    expect(response.ok).toBe(true);
    return response.json();
  };
  expect(await readConfig()).toMatchObject({ trackCiFailures: true, ciStrictness: "all" });

  const openControls = async () => {
    await dashboard.getByRole("button", { name: /Foreman - the auto-responder/ }).click();
    const dialog = dashboard.getByRole("dialog", { name: "Foreman settings", exact: true });
    await expect(dialog).toBeVisible();
    return dialog.getByRole("group", { name: "Pull requests", exact: true });
  };
  let controls = await openControls();
  const picker = () => controls.getByRole("combobox", { name: "Which failures count", exact: true });
  const ci = () => controls.getByRole("checkbox", { name: "Keep sessions on track with CI", exact: true });
  await expect(picker()).toBeEnabled();
  await expect(picker()).toHaveValue("all");
  await expect(picker().locator("option:checked")).toHaveText("All checks");
  const pickerRow = controls.locator("label", {
    has: dashboard.getByRole("combobox", { name: "Which failures count", exact: true }),
  });
  await expect(pickerRow).toHaveAccessibleDescription(
    "Choose which failing checks Foreman sends back to a parked PR session, and which checks new workflow PR instructions ask it to follow",
  );
  await expect(controls.getByText(
    "Required checks: only checks GitHub marks required on the PR count, read through GitHub Inspector. "
      + "With none marked, or the Inspector off, every check counts.",
  )).toBeVisible();

  // Off with the CI toggle, and back on with it.
  await ci().uncheck();
  await expect.poll(readConfig).toMatchObject({ trackCiFailures: false });
  await expect(picker()).toBeDisabled();
  await ci().check();
  await expect.poll(readConfig).toMatchObject({ trackCiFailures: true });
  await expect(picker()).toBeEnabled();

  await picker().selectOption({ label: "Required checks" });
  await expect.poll(readConfig).toMatchObject({ ciStrictness: "required", trackCiFailures: true });
  await dashboard.reload();
  controls = await openControls();
  await expect(picker()).toHaveValue("required");
  await expect(picker().locator("option:checked")).toHaveText("Required checks");
  await expectContentClearsBorder(controls);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("foreman-pr-defaults");
    mkdirSync(dir, { recursive: true });
    await controls.screenshot({ path: `${dir}which-failures-count.png` });
  }
});
