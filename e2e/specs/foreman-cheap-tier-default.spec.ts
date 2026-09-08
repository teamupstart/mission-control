import { expect, test } from "../fixtures/test.ts";

/**
 * Which cheap-tier posture a fresh install actually runs, read where an operator reads it.
 *
 * The default moved from `shadow` to `on`. `shadow` was only ever the evidence-gathering
 * posture - two concurrent model calls per decision, one of which cannot act - and shipping
 * it meant every install that never opened this panel paid twice per decision to measure
 * something nobody looked at.
 *
 * A default is exactly the kind of change that passes its unit tests while shipping wrong,
 * because the schema, the settings panel's own in-flight fallback, and the daemon that
 * enforces it are three separate statements of the same fact. `foreman-triage.test.ts` pins
 * the schema and `foreman-settings-render.test.ts` pins the markup, but only a browser
 * against a real daemon and a real empty database can show that the posture on screen is the
 * one the server would act on. So the first assertion is deliberately made on an install
 * that has never written a Foreman setting.
 *
 * The second half exists because "On is selected" alone is also what a hardcoded readout
 * looks like. Choosing Shadow and reloading proves the control writes and the page reflects
 * storage - which retroactively proves the On it opened on was an unanswered default rather
 * than a stuck render.
 */
test("a new installation runs the cheap tier On, and can still be moved to Shadow", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/foreman`);

  const tier = dashboard.getByRole("group", { name: "Cheap tier" });
  await expect(tier.getByRole("radio", { name: "On" })).toBeChecked();
  await expect(tier.getByRole("radio", { name: "Shadow" })).not.toBeChecked();
  await expect(tier.getByRole("radio", { name: "Off" })).not.toBeChecked();
  // The hint under the control is what a person actually reads to learn what they are on.
  await expect(tier.getByText("On - cheap tier answers the easy ones.")).toBeVisible();
  // Advice to promote to On has no place under On.
  await expect(tier.getByText(/Promote it to/)).toHaveCount(0);

  await tier.getByRole("radio", { name: "Shadow" }).check();
  await expect(tier.getByText(/Promote it to/)).toBeVisible();

  await dashboard.reload();
  const afterReload = dashboard.getByRole("group", { name: "Cheap tier" });
  await expect(afterReload.getByRole("radio", { name: "Shadow" })).toBeChecked();
  await expect(afterReload.getByRole("radio", { name: "On" })).not.toBeChecked();
});
