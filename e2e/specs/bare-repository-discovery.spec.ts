import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

test.use({ daemonEnv: { MC_E2E_USE_REPO_INDEX_DEFAULTS: "1" } });

test("deep bare and ordinary clones appear in Settings and can be added to Trust", async ({ dashboard, daemon }) => {
  const deep = join(daemon.workspace, ...Array.from({ length: 12 }, (_, i) => `level-${i}`));
  mkdirSync(deep, { recursive: true });
  const bare = join(deep, "bare-project.git");
  const ordinary = join(deep, "deep-project");
  execFileSync("git", ["clone", "--bare", "-q", daemon.repo, bare]);
  execFileSync("git", ["clone", "-q", daemon.repo, ordinary]);

  await dashboard.goto(`${daemon.baseURL}/#/settings/repositories`);
  await dashboard.getByRole("button", { name: "Rescan now" }).click();
  const root = dashboard.locator(".ri-row").filter({ has: dashboard.getByText("~/workspace", { exact: true }) });
  await expect(root).toContainText("4 repositories");
  await expect(dashboard.getByText("Found up to three levels down.", { exact: false })).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const dir = artifactsDir("bare-repository-discovery");
    mkdirSync(dir, { recursive: true });
    await dashboard.screenshot({ path: `${dir}repositories.png`, fullPage: true });
  }

  await dashboard.goto(`${daemon.baseURL}/#/settings/trust`);
  const input = dashboard.getByRole("combobox", { name: /search repos or type a path/i });
  for (const name of ["bare-project.git", "deep-project"]) {
    await input.fill(name);
    await dashboard.getByRole("option", { name: new RegExp(name.replaceAll(".", "\\.")) }).click();
    await dashboard.getByRole("button", { name: "Add" }).click();
    await expect(dashboard.locator(".trust-repo-path").filter({ hasText: name })).toBeVisible();
  }
  const staged = await fetch(`${daemon.baseURL}/api/ui/config`).then(r => r.json()) as { config: { trustStaged: string[] } };
  expect(staged.config.trustStaged).toEqual(expect.arrayContaining([bare, ordinary]));
  await dashboard.getByRole("button", { name: `Grant: Foreman sends live for ${bare}` }).click();
  await expect.poll(async () => {
    const config = await fetch(`${daemon.baseURL}/api/foreman/config`).then(r => r.json()) as { repoAllowlist: string[] };
    return config.repoAllowlist;
  }).toContain(bare);
  await dashboard.reload();
  await expect(dashboard.locator(".trust-repo-path").filter({ hasText: "bare-project.git" })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: `Revoke: Foreman sends live for ${bare}` })).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const dir = artifactsDir("bare-repository-discovery");
    mkdirSync(dir, { recursive: true });
    await dashboard.screenshot({ path: `${dir}trust.png`, fullPage: true });
  }
});
