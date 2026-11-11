import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Settings > Worktrees: the claim editor's seed fields. Seed paths and exclusions save with the
// rest of the claim through the settings route, a refusal lands beside the seed field that
// holds the glob, a saved seed comes back into a fresh page, and blank fields save a claim that
// never seeds. Nothing is dispatched, so no agent runs; every agent binary stays faked anyway.

const EVIDENCE = artifactsDir("settings-worktree-seed");

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-worktree-seed/${name}.png`);
}

async function openEditor(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await page.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = page.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  return pool.getByRole("group", { name: "Dependency claim, run on every task lease" });
}

interface StoredClaim {
  steps: Array<{ argv: string[] }>;
  seed?: { paths: string[]; exclude: string[] };
}

async function storedClaim(page: Page, daemon: DaemonHandle): Promise<StoredClaim | null> {
  const response = await page.request.get(`${daemon.baseURL}/api/worktrees/config`);
  const body = await response.json() as { config: { repositories: Record<string, { claim?: StoredClaim }> } };
  return Object.values(body.config.repositories).find((repo) => repo.claim)?.claim ?? null;
}

async function save(page: Page, editor: Locator): Promise<number> {
  const answered = page.waitForResponse((response) =>
    response.url().endsWith("/api/worktrees/config") && response.request().method() === "PUT");
  await editor.getByRole("button", { name: "Save claim" }).click();
  return (await answered).status();
}

test("the claim editor saves seed paths and exclusions, and refuses a bad glob beside its seed field", async ({
  dashboard,
  daemon,
}) => {
  // A manual lease creates the pool; with no claim yet it is answered at once.
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "creates the pool" },
  });
  expect(acquired.status()).toBe(201);

  const editor = await openEditor(dashboard, daemon);
  const seedPaths = editor.getByLabel("Seed paths, one repository-relative glob per line");
  const seedExclude = editor.getByLabel("Seed exclusions, one repository-relative glob per line");
  await expect(seedPaths).toHaveValue("");
  await expect(seedExclude).toHaveValue("");
  await expect(editor.getByText(
    "A cold slot (new, never claimed, failed or interrupted) clones these ignored paths copy-on-write from an idle sibling before its steps run. A slot whose last claim succeeded seeds only when it is stale and a sibling matches its commit exactly.",
    { exact: false },
  )).toBeVisible();

  await editor.getByRole("button", { name: "Add step" }).click();
  await editor.getByLabel("Step 1 command, one argument per line").fill("yarn\ninstall\n--immutable");
  await editor.getByLabel("Fingerprint paths, one repository-relative glob per line").fill("README.md");

  // `**` cannot be a seed path, and an exclusion must be repository-relative. Each refusal
  // lands beside the seed field that holds the glob, and nothing is saved.
  await seedPaths.fill("node_modules\n**/node_modules");
  await seedExclude.fill("/abs/.cache");
  expect(await save(dashboard, editor)).toBe(400);
  await expect(seedPaths).toHaveAttribute("aria-invalid", "true");
  await expect(seedPaths).toHaveAccessibleDescription(
    "**/node_modules: a seed path cannot use **; name each directory level, with * for one level",
  );
  await expect(seedExclude).toHaveAttribute("aria-invalid", "true");
  await expect(seedExclude).toHaveAccessibleDescription(/^\/abs\/\.cache: a seed exclusion is a repository-relative glob/);
  await expect(editor.getByRole("alert")).toHaveText("The claim was not saved. Fix the fields marked above.");
  expect(await storedClaim(dashboard, daemon)).toBeNull();
  await shoot(dashboard, editor, "01-seed-fields-refused-inline");

  // Exclusions alone are refused beside the seed paths, never silently dropped.
  await seedPaths.fill("");
  await seedExclude.fill("**/node_modules/.cache");
  expect(await save(dashboard, editor)).toBe(400);
  await expect(seedPaths).toHaveAttribute("aria-invalid", "true");
  await expect(seedExclude).not.toHaveAttribute("aria-invalid", "true");

  // The corrected seed saves with the rest of the claim.
  await seedPaths.fill("node_modules\napps/*/node_modules\n.yarn/install-state.gz");
  expect(await save(dashboard, editor)).toBe(200);
  await expect(editor.getByRole("status")).toHaveText("Claim saved.");
  await expect(seedPaths).not.toHaveAttribute("aria-invalid", "true");
  expect((await storedClaim(dashboard, daemon))?.seed).toEqual({
    paths: ["node_modules", "apps/*/node_modules", ".yarn/install-state.gz"],
    exclude: ["**/node_modules/.cache"],
  });

  // A fresh page reads the saved seed back into the fields.
  await dashboard.reload();
  const reopened = await openEditor(dashboard, daemon);
  await expect(reopened.getByLabel("Seed paths, one repository-relative glob per line"))
    .toHaveValue("node_modules\napps/*/node_modules\n.yarn/install-state.gz");
  await expect(reopened.getByLabel("Seed exclusions, one repository-relative glob per line"))
    .toHaveValue("**/node_modules/.cache");
  await shoot(dashboard, reopened, "02-seed-fields-saved");

  // Blank seed fields save a claim that never seeds, and keep its steps.
  await reopened.getByLabel("Seed paths, one repository-relative glob per line").fill("");
  await reopened.getByLabel("Seed exclusions, one repository-relative glob per line").fill("");
  expect(await save(dashboard, reopened)).toBe(200);
  await expect(reopened.getByRole("status")).toHaveText("Claim saved.");
  const unseeded = await storedClaim(dashboard, daemon);
  expect(unseeded?.seed).toBeUndefined();
  expect(unseeded?.steps).toEqual([{ argv: ["yarn", "install", "--immutable"], env: [] }]);
});
