import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";
import catalog from "../../config/enterprise-packages.json" with { type: "json" };

test("Setup reads recommended packages per harness and picks up a replacement catalog on Re-check", async ({ page, daemon }) => {
  const installRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/setup/install")) installRequests.push(request.url());
  });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "agents");
  const pi = setupRow(page, "dependency-pi-cli");
  await expect(pi).toBeVisible();
  await expect(pi.getByRole("region", { name: "Recommended packages" })).toHaveCount(0);
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  await page.getByRole("button", { name: /^Enterprise package recommendations:/ }).click();
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "agents");
  const item = catalog.packages[0]!;
  const row = pi.getByRole("article", { name: item.label });
  await expect(row.getByText(item.source, { exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: /Installation guide/ })).toHaveAttribute("href", item.guide);
  await expect(row.getByText("Missing", { exact: true })).toBeVisible();
  const agentDir = join(daemon.home, "pi-agent");
  const [name, version] = item.source.slice(4).split(/@(?=[^@]+$)/);
  const pkg = join(agentDir, "npm", "node_modules", name!);
  const entry = join(pkg, item.piExtension.entry);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [item.source] }));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version, pi: { extensions: [item.piExtension.entry] } }));
  writeFileSync(entry, "throw new Error('Setup executed the package')");
  const recheck = page.getByRole("button", { name: "Re-check", exact: true });
  await recheck.click();
  await expect(row.getByText("Ready", { exact: true })).toBeVisible();

  const path = join(daemon.home, "enterprise-packages.json");
  writeFileSync(path, JSON.stringify({ packages: [{
    harness: "codex", label: "Team tools", source: "team-tools", guide: "https://example.org/guide", description: "Shared team tools.",
  }] }));
  await recheck.click();
  await expect(row).toHaveCount(0);
  const custom = setupRow(page, "dependency-codex-cli").getByRole("article", { name: "Team tools" });
  await expect(custom.getByRole("link")).toHaveAttribute("href", "https://example.org/guide");
  await expect(custom.getByText("Ready", { exact: true })).toHaveCount(0);
  writeFileSync(path, "{");
  await recheck.click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid JSON" })).toBeVisible();
  await expect(custom).toHaveCount(0);
  await expect(row).toHaveCount(0);
  writeFileSync(path, '{"packages":[]}');
  await recheck.click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid JSON" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Recommended packages" })).toHaveCount(0);
  expect(installRequests).toEqual([]);
});
