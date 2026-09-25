import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("skills-default");

test("a fresh installation shows every shipped skill on and keeps operator opt-outs", async ({
  dashboard,
  daemon,
}) => {
  const response = await fetch(`${daemon.baseURL}/api/skills`);
  expect(response.ok).toBe(true);
  const view = await response.json() as {
    enabled: boolean;
    skills: Array<{ id: string; name: string; enabled: boolean }>;
    problems: string[];
  };
  expect(view.skills.length).toBeGreaterThan(0);

  await dashboard.goto(`${daemon.baseURL}/#/settings/skills`);
  const master = dashboard.getByRole("checkbox", { name: "Enable Mission Control skills" });
  const row = dashboard.getByRole("checkbox", { name: new RegExp(`^Enable /${view.skills[0]!.name} in every`) });
  await expect(master).toBeVisible();
  await expect(row).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.setViewportSize({ width: 1440, height: 900 });
    await dashboard.screenshot({ path: `${EVIDENCE}fresh-defaults.png` });
  }

  // This is the regression boundary: the same browser assertion fails against the
  // pre-change build, where the master and catalog rows start unchecked.
  await expect(master).toBeChecked();
  for (const skill of view.skills) {
    await expect(dashboard.getByRole("checkbox", { name: new RegExp(`^Enable /${skill.name} in every`) })).toBeChecked();
  }
  expect(view.enabled).toBe(true);
  expect(view.skills.every((skill) => skill.enabled)).toBe(true);
  expect(view.problems).toEqual([]);
  await expect(dashboard.getByText("Shipped skills start enabled on a new installation.", { exact: false })).toBeVisible();

  await row.uncheck();
  await expect.poll(async () => {
    const current = await (await fetch(`${daemon.baseURL}/api/skills`)).json() as typeof view;
    return current.skills.find((skill) => skill.id === view.skills[0]!.id)?.enabled;
  }).toBe(false);
  await dashboard.reload();
  await expect(master).toBeChecked();
  await expect(row).not.toBeChecked();
  await master.uncheck();
  await expect.poll(async () => {
    const current = await (await fetch(`${daemon.baseURL}/api/skills`)).json() as typeof view;
    return current.enabled;
  }).toBe(false);
  await dashboard.reload();
  await expect(master).not.toBeChecked();
  await expect(row).not.toBeChecked();
});
