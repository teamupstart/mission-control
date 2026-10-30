import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

async function capture(page: Page, panel: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const dir = artifactsDir("residents-skills-review");
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(dir, `${name}.png`), maskColor: "#29313d", mask: [
    panel.locator(".resident-source-list code, .resident-source-heading strong"),
    panel.getByLabel("Skill folder"), panel.getByRole("combobox", { name: "Source", exact: true }),
  ] });
}

test("a rescan cooldown tells the operator when to retry and clears after a successful retry", async ({ dashboard: page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/residents/skill-sources`);
  const panel = page.getByRole("region", { name: "Skill sources" });
  await expect(panel.getByRole("button", { name: "Rescan" })).toBeEnabled();
  // The route tests exercise the real clock boundary. A scripted refusal here keeps
  // the visible retry behavior independent of browser scheduling under CI contention.
  await page.route("**/api/residents/skills/rescan", route => route.fulfill({
    status: 429, contentType: "application/json", headers: { "Retry-After": "1" },
    body: JSON.stringify({ error: "Wait a second before rescanning skill sources again." }),
  }), { times: 1 });
  await panel.getByRole("button", { name: "Rescan" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Wait a second before rescanning skill sources again.");
  await capture(page, panel, "rescan-cooldown");
  await panel.getByRole("button", { name: "Rescan" }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Rescan" })).toBeEnabled();
});

test("invalid restored registrations leave global skills available and can be explicitly reset", async ({ dashboard: page, daemon }) => {
  const invalid = '{"directories":"invalid"}';
  withDaemonDb(daemon, db => db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)").run("residents.skillSources", invalid));
  const stored = () => withDaemonDb(daemon, db => (db.prepare("SELECT value FROM app_config WHERE key = ?").get("residents.skillSources") as { value: string }).value);
  await page.goto(`${daemon.baseURL}/#/residents/skill-sources`);
  const panel = page.getByRole("region", { name: "Skill sources" });
  await expect(panel.getByRole("alert")).toContainText("Stored skill-source settings are invalid");
  await expect(panel.getByRole("list", { name: "Indexed skills" }).getByRole("listitem").first()).toBeVisible();
  await expect(panel.getByLabel("Skill folder")).toBeDisabled();
  await panel.getByRole("button", { name: "Rescan" }).click();
  await expect(panel.getByRole("button", { name: "Rescan" })).toBeEnabled();
  expect(stored()).toBe(invalid);
  const reset = panel.getByRole("button", { name: "Reset source list" });
  await expect(reset).toHaveAccessibleDescription(/Replace invalid saved registrations/);
  await capture(page, panel, "configuration-recovery");
  await reset.click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(reset).toHaveCount(0);
  await expect(panel.getByLabel("Skill folder")).toBeEnabled();
  expect(stored()).toBe('{"directories":[]}');
  const root = join(daemon.home, "repaired-source");
  mkdirSync(join(root, "fixture"), { recursive: true });
  writeFileSync(join(root, "fixture/SKILL.md"), "---\nname: Repaired source skill\ndescription: fixture\n---\n");
  await panel.getByLabel("Skill folder").fill(root);
  await panel.getByRole("button", { name: "Add source" }).click();
  await expect(panel.getByRole("list", { name: "Indexed skills" }).getByText("Repaired source skill", { exact: true })).toBeVisible();
});

test("stale windows refresh without overwriting another window's source additions or removals", async ({ dashboard: first, daemon }) => {
  const second = await first.context().newPage();
  const a = join(daemon.home, "source-a");
  const b = join(daemon.home, "source-b");
  mkdirSync(a); mkdirSync(b);
  try {
    for (const page of [first, second]) {
      await page.goto(`${daemon.baseURL}/#/residents/skill-sources`);
      await expect(page.getByRole("button", { name: "Rescan" })).toBeEnabled();
    }
    const one = first.getByRole("region", { name: "Skill sources" });
    const two = second.getByRole("region", { name: "Skill sources" });
    await one.getByLabel("Skill folder").fill(a);
    await one.getByRole("button", { name: "Add source" }).click();
    await expect(one.getByRole("button", { name: `Remove source ${a}` })).toBeVisible();
    await two.getByLabel("Skill folder").fill(b);
    await two.getByRole("button", { name: "Add source" }).click();
    await expect(two.getByRole("alert")).toContainText("changed in another window");
    await expect(two.getByLabel("Skill folder")).toHaveValue(b);
    await expect(two.getByRole("button", { name: `Remove source ${a}` })).toBeVisible();
    await expect(two.getByRole("button", { name: `Remove source ${b}` })).toHaveCount(0);
    await capture(second, two, "stale-write");
    await two.getByRole("button", { name: "Add source" }).click();
    await expect(two.getByRole("button", { name: `Remove source ${b}` })).toBeVisible();

    await one.getByRole("button", { name: `Remove source ${a}` }).click();
    await expect(one.getByRole("alert")).toContainText("changed in another window");
    await expect(one.getByRole("button", { name: `Remove source ${a}` })).toBeVisible();
    await expect(one.getByRole("button", { name: `Remove source ${b}` })).toBeVisible();
    await one.getByRole("button", { name: `Remove source ${a}` }).click();
    await expect(one.getByRole("button", { name: `Remove source ${a}` })).toHaveCount(0);
    await expect(one.getByRole("button", { name: `Remove source ${b}` })).toBeVisible();
    const stored = await fetch(`${daemon.baseURL}/api/residents/skills`).then(r => r.json());
    expect(stored.config.directories.map((row: { path: string }) => row.path)).toEqual([b]);
  } finally { await second.close(); }
});

test("a bounded catalog explicitly reports omitted skills before displaying its first 200 matches", async ({ dashboard: page, daemon }) => {
  const root = join(daemon.home, "large-catalog");
  for (let i = 0; i < 270; i++) {
    const folder = join(root, `skill-${String(i).padStart(3, "0")}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), `---\nname: Large skill ${i}\ndescription: ${"x".repeat(16000)}\n---\n`);
  }
  await page.goto(`${daemon.baseURL}/#/residents/skill-sources`);
  const panel = page.getByRole("region", { name: "Skill sources" });
  await expect(panel.getByRole("button", { name: "Rescan" })).toBeEnabled();
  await panel.getByLabel("Skill folder").fill(root);
  await panel.getByRole("button", { name: "Add source" }).click();
  await expect(panel.getByRole("status").filter({ hasText: "4 MiB response limit" })).toBeVisible();
  await expect(panel.getByRole("list", { name: "Indexed skills" }).getByRole("listitem")).toHaveCount(200);
  const response = await fetch(`${daemon.baseURL}/api/residents/skills`);
  const body = await response.text();
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(JSON.parse(body).truncated).toBe(true);
  await capture(page, panel, "capacity");
});

test("discarding a dirty editor into skills or another profile clears the next navigation gate", async ({ dashboard: page, daemon }) => {
  const rail = page.getByRole("complementary", { name: "Resident profiles" });
  await page.goto(`${daemon.baseURL}/#/residents`);
  for (const name of ["First profile", "Second profile"]) {
    await rail.getByRole("button", { name: "New" }).click();
    const editor = page.getByRole("region", { name: "New resident profile" });
    await editor.getByLabel("Name").fill(name);
    await editor.getByRole("combobox", { name: "Persona" }).selectOption({ label: "Code Risk Reviewer · built-in" });
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("region", { name: `Resident profile ${name}` })).toBeVisible();
  }
  await page.getByLabel("Profile instructions").fill("Unsaved second profile");
  await rail.getByRole("button", { name: "Skill sources" }).click();
  const dialog = page.getByRole("dialog");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page.getByRole("region", { name: "Skill sources" })).toBeVisible();
  await rail.getByRole("button", { name: /First profile/ }).click();
  await expect(page.getByRole("region", { name: "Resident profile First profile" })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel("Profile instructions").fill("Unsaved first profile");
  await rail.getByRole("button", { name: /Second profile/ }).click();
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page.getByRole("region", { name: "Resident profile Second profile" })).toBeVisible();
  await rail.getByRole("button", { name: "Skill sources" }).click();
  await expect(page.getByRole("region", { name: "Skill sources" })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
