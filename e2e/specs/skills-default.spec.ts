import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { HARNESS_CAPABILITIES } from "../../src/shared/harness-capabilities.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

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

for (const masterEnabled of [true, false]) {
  test(`the Mockups upgrade enables its row once with master ${masterEnabled ? "on" : "off"} and keeps later opt-outs`, async ({
    dashboard,
    daemon,
  }) => {
    // Seed a pre-rollout installation while the daemon is stopped. All migration,
    // link reconciliation, browser edits and later restarts use production paths.
    const disable = await fetch(`${daemon.baseURL}/api/skills/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: { mockups: false } }),
    });
    expect(disable.ok).toBe(true);
    const mockupLinks = Object.values(HARNESS_CAPABILITIES).flatMap(({ skills }) =>
      skills ? [join(daemon.home, skills.isolatedDirName, "mission-mockups")] : []);
    for (const path of mockupLinks) expect(existsSync(path)).toBe(false);
    await daemon.shutdown();
    withDaemonDb(daemon, (db) => {
      db.prepare("UPDATE app_config SET value = ? WHERE key = 'skills'").run(JSON.stringify({
        enabled: masterEnabled,
        skills: { mockups: false, retro: false, "html-plans": true },
        generation: 0,
        generationAt: 0,
      }));
      db.exec("PRAGMA user_version = 22;");
    });
    await daemon.restart();
    await dashboard.goto(`${daemon.baseURL}/#/settings/skills`);
    await dashboard.reload();
    const master = dashboard.getByRole("checkbox", { name: "Enable Mission Control skills" });
    const mockups = dashboard.getByRole("checkbox", { name: /^Enable \/mockups in every/ });
    const retro = dashboard.getByRole("checkbox", { name: /^Enable \/retro in every/ });
    await expect(master).toBeChecked({ checked: masterEnabled });
    await expect(mockups).toBeChecked();
    await expect(retro).not.toBeChecked();
    for (const path of mockupLinks) expect(existsSync(path)).toBe(masterEnabled);
    if (!masterEnabled) await expect(mockups).toBeDisabled();

    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(EVIDENCE, { recursive: true });
      await dashboard.setViewportSize({ width: 1440, height: 1100 });
      await dashboard.screenshot({ path: `${EVIDENCE}mockups-upgraded-master-${masterEnabled}.png`, fullPage: true });
    }

    if (!masterEnabled) await master.check();
    await mockups.uncheck();
    await expect.poll(async () => {
      const view = await (await fetch(`${daemon.baseURL}/api/skills`)).json();
      return view.skills.find((skill: { id: string }) => skill.id === "mockups")?.enabled;
    }).toBe(false);
    if (!masterEnabled) {
      await master.uncheck();
      await expect.poll(async () => (await (await fetch(`${daemon.baseURL}/api/skills`)).json()).enabled).toBe(false);
    }

    for (let restart = 0; restart < 2; restart++) {
      await daemon.shutdown();
      await daemon.restart();
      await dashboard.reload();
      await expect(master).toBeChecked({ checked: masterEnabled });
      await expect(mockups).not.toBeChecked();
      await expect(retro).not.toBeChecked();
      for (const path of mockupLinks) expect(existsSync(path)).toBe(false);
    }
    if (process.env.MC_E2E_EVIDENCE) {
      await dashboard.screenshot({ path: `${EVIDENCE}mockups-opted-out-master-${masterEnabled}.png`, fullPage: true });
    }
  });
}
