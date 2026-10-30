import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

test.use({ daemonEnv: { MC_E2E_USE_REPO_INDEX_DEFAULTS: "1" } });

test("deep bare and ordinary clones appear in Settings and can be added to Trust", async ({ dashboard, daemon }) => {
  const deep = join(daemon.workspace, ...Array.from({ length: 12 }, (_, i) => `level-${i}`));
  mkdirSync(deep, { recursive: true });
  const bare = join(deep, "bare-project.git");
  const ordinary = join(deep, "deep-project");
  const invalidBare = join(deep, "unknown-container", ".git");
  execFileSync("git", ["clone", "--bare", "-q", daemon.repo, bare]);
  execFileSync("git", ["clone", "-q", daemon.repo, ordinary]);
  execFileSync("git", ["clone", "--bare", "-q", daemon.repo, invalidBare]);
  writeFileSync(join(invalidBare, "config"), "[core]\n bare = invalid\n");

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
  const search = dashboard.getByRole("searchbox", { name: "Search repositories to add" });
  await search.fill("unknown-container");
  await expect(dashboard.getByRole("checkbox", { name: /unknown-container/ })).toHaveCount(0);
  // Both clones picked across two searches and added in one batch.
  for (const path of [bare, ordinary]) {
    await search.fill(path.split("/").pop()!);
    await dashboard.getByRole("checkbox", { name: `Select ${path}` }).check();
  }
  await dashboard.getByRole("button", { name: "Add 2 repositories" }).click();
  for (const name of ["bare-project.git", "deep-project"]) {
    await expect(dashboard.locator(".trust-repo-path").filter({ hasText: name })).toBeVisible();
  }
  // An add grants the defaults, so both owners land in Foreman's own allowlist.
  await expect.poll(async () => {
    const config = await fetch(`${daemon.baseURL}/api/foreman/config`).then(r => r.json()) as { repoAllowlist: string[] };
    return config.repoAllowlist;
  }).toEqual(expect.arrayContaining([bare, ordinary]));
  await dashboard.reload();
  await expect(dashboard.locator(".trust-repo-path").filter({ hasText: "bare-project.git" })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: `Revoke: Foreman sends live for ${bare}` })).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const dir = artifactsDir("bare-repository-discovery");
    mkdirSync(dir, { recursive: true });
    await dashboard.screenshot({ path: `${dir}trust.png`, fullPage: true });
  }
});
