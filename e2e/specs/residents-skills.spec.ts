import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

function skill(root: string, folder: string, name: string): void {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "SKILL.md"), `---\nname: ${name}\ndescription: >-\n  Resident fixture\n  with a folded description.\n---\nFrozen content.\n`);
}

test("skill sources add, rescan, filter, survive restart, and remove without deleting skills", async ({ dashboard: page, daemon }) => {
  const root = join(daemon.home, "registered-skills");
  skill(root, "first", "Resident fixture alpha");
  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("button", { name: "Skill sources" }).click();
  await expect(page).toHaveURL(/#\/residents\/skill-sources$/);
  const panel = page.getByRole("region", { name: "Skill sources" });
  await expect(panel.getByRole("button", { name: "Rescan" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Rescan" })).toHaveAccessibleDescription("Refresh the catalog from every skill source");
  await panel.getByRole("button", { name: "Rescan" }).hover();
  await expect(page.locator(".tooltip")).toHaveText("Refresh the catalog from every skill source");
  await panel.getByLabel("Skill folder").fill(root);
  await expect(panel.getByRole("button", { name: "Add source" })).toHaveAccessibleDescription("Register this folder and index its skills");
  await panel.getByRole("button", { name: "Add source" }).click();
  await expect(panel.getByLabel("Skill folder")).toHaveValue("");
  const list = panel.getByRole("list", { name: "Indexed skills" });
  await expect(panel.getByRole("combobox", { name: "Source", exact: true })).toHaveAccessibleDescription("Show skills from one source or all sources");
  await panel.getByRole("combobox", { name: "Source", exact: true }).selectOption({ label: root });
  await expect(list).toContainText("Resident fixture alpha");
  await expect(list).toContainText("Resident fixture with a folded description.");
  await panel.getByLabel("Skill folder").fill(root);
  await panel.getByRole("button", { name: "Add source" }).click();
  await expect(panel.getByRole("alert")).toContainText("same directory");
  await panel.getByLabel("Skill folder").fill("");

  skill(root, "second", "Resident fixture beta");
  await panel.getByRole("button", { name: "Rescan" }).click();
  await expect(list).toContainText("Resident fixture beta");
  await panel.getByLabel("Search skills").fill("alpha");
  await expect(list).toContainText("Resident fixture alpha");
  await expect(list).not.toContainText("Resident fixture beta");
  await panel.getByLabel("Search skills").fill("");
  await expect(panel).toContainText("Resident skill selection is unavailable");
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("residents-skills");
    mkdirSync(dir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator(".residents-workspace").evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: join(dir, "skill-sources.png") });
    await list.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(dir, "indexed-skills.png") });
  }
  await daemon.crash();
  await daemon.restart();
  await page.reload();
  await expect(list).toContainText("Resident fixture beta");
  await expect(panel.getByRole("button", { name: `Remove source ${root}` })).toHaveAccessibleDescription("Remove this source from the catalog without deleting its files");
  await panel.getByRole("button", { name: `Remove source ${root}` }).click();
  await expect(list).not.toContainText("Resident fixture alpha");
  expect(readFileSync(join(root, "first/SKILL.md"), "utf8")).toContain("Frozen content");

  const missing = join(daemon.home, "missing-skills");
  await panel.getByLabel("Skill folder").fill(missing);
  await panel.getByRole("button", { name: "Add source" }).click();
  const sourceRow = panel.getByRole("list", { name: "Registered skill sources" }).getByRole("listitem").filter({ has: page.getByRole("button", { name: `Remove source ${missing}` }) });
  await expect(sourceRow.locator("summary")).toHaveAccessibleDescription("Show or hide problems found while scanning this source");
  await sourceRow.locator("summary").click();
  await expect(sourceRow).toContainText("directory is missing");
});

test("opening skill sources respects the profile's dirty draft gate", async ({ dashboard: page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/residents/new`);
  await page.getByRole("region", { name: "New resident profile" }).getByLabel("Name").fill("Unsaved resident");
  await page.getByRole("button", { name: "Skill sources" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("resident profile");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Unsaved resident");
});

test("catalog includes independent mission-prefixed Claude skills and reports broad child links", async ({ dashboard: page, daemon }) => {
  skill(join(daemon.home, ".claude/skills"), "mission-independent", "Independent Claude skill");
  const root = join(daemon.home, "child-link-skills");
  skill(root, "valid", "Registered narrow skill");
  symlinkSync(daemon.home, join(root, "home-link"));
  await page.goto(`${daemon.baseURL}/#/residents/skill-sources`);
  const panel = page.getByRole("region", { name: "Skill sources" });
  await panel.getByRole("button", { name: "Rescan" }).click();
  await panel.getByRole("combobox", { name: "Source", exact: true }).selectOption("claude-global");
  const list = panel.getByRole("list", { name: "Indexed skills" });
  await expect(list).toContainText("Independent Claude skill");
  await panel.getByLabel("Skill folder").fill(root);
  await panel.getByRole("button", { name: "Add source" }).click();
  await expect(panel.getByLabel("Skill folder")).toHaveValue("");
  await panel.getByRole("combobox", { name: "Source", exact: true }).selectOption({ label: root });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("Registered narrow skill");
  const row = panel.getByRole("list", { name: "Registered skill sources" }).getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: `Remove source ${root}` }) });
  await row.locator("summary").click();
  await expect(row).toContainText("home-link: This directory resolves at or above your home.");
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("residents-skills/scanner-repair");
    mkdirSync(dir, { recursive: true });
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(dir, "blocked-child-link.png") });
    await panel.getByRole("combobox", { name: "Source", exact: true }).selectOption("claude-global");
    await expect(list).toContainText("Independent Claude skill");
    await list.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(dir, "independent-claude-skill.png") });
  }
});

test("skill list shows 200 matches and asks to narrow only above that limit", async ({ dashboard: page, daemon }) => {
  const root = join(daemon.home, "display-limit-skills");
  for (let i = 1; i <= 200; i++) {
    const number = String(i).padStart(3, "0");
    skill(root, `skill-${number}`, `Boundary skill ${number}`);
  }
  await page.goto(`${daemon.baseURL}/#/residents/skill-sources`);
  const panel = page.getByRole("region", { name: "Skill sources" });
  await expect(panel.getByRole("button", { name: "Rescan" })).toBeEnabled();
  await panel.getByLabel("Skill folder").fill(root);
  await panel.getByRole("button", { name: "Add source" }).click();
  await expect(panel.getByLabel("Skill folder")).toHaveValue("");
  await panel.getByRole("combobox", { name: "Source", exact: true }).selectOption({ label: root });
  const list = panel.getByRole("list", { name: "Indexed skills" });
  const lastShown = list.getByText("Boundary skill 200", { exact: true });
  const notice = panel.getByText("Showing the first 200 matches. Narrow the search to see more.", { exact: true });

  await expect(panel.getByRole("status")).toHaveText("200 matching skills");
  await expect(list.getByRole("listitem")).toHaveCount(200);
  await lastShown.scrollIntoViewIfNeeded();
  await expect(lastShown).toBeInViewport();
  await expect(notice).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("residents-skills/display-limit");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, "200-matches.png") });
  }

  skill(root, "skill-201", "Boundary skill 201");
  await panel.getByRole("button", { name: "Rescan" }).click();
  await expect(panel.getByRole("status")).toHaveText("201 matching skills");
  await expect(list.getByRole("listitem")).toHaveCount(200);
  await lastShown.scrollIntoViewIfNeeded();
  await expect(lastShown).toBeInViewport();
  await expect(list.getByText("Boundary skill 201", { exact: true })).toHaveCount(0);
  await expect(notice).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE) {
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifactsDir("residents-skills/display-limit"), "201-matches.png") });
  }

  // The omitted skill is indexed and becomes visible when the operator narrows the list.
  await panel.getByLabel("Search skills").fill("Boundary skill 201");
  await expect(panel.getByRole("status")).toHaveText("1 matching skills");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByText("Boundary skill 201", { exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
});
