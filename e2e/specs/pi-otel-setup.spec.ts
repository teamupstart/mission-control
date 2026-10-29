import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

const SOURCE = "npm:@upstart/pi-router-otel@0.1.1-alpha.4";

test("Pi telemetry is an optional Setup add-on, checked without installing or executing it", async ({ page, daemon }) => {
  const installations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/setup/install")) {
      installations.push(request.url());
    }
  });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "agents");
  const row = setupRow(page, "dependency-pi-otel");
  await expect(row).toContainText("Pi OpenTelemetry extension");
  await expect(row).toContainText("optional");
  await expect(row).toContainText("Requires Upstart CodeArtifact access for install.");
  await expect(row).toContainText("never installs it automatically");
  await expect(row.getByRole("link", { name: "Install Pi telemetry (CodeArtifact)" }))
    .toHaveAttribute("href", /docs\/pi-telemetry\.md/);
  await expect(row.getByRole("button", { name: "Run in a terminal" })).toHaveCount(0);

  const capture = async (name: string) => {
    if (process.env.MC_E2E_EVIDENCE !== "1") return;
    const dir = artifactsDir("pi-otel-setup");
    mkdirSync(dir, { recursive: true });
    await row.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    await page.locator(".setup-panel").screenshot({ path: join(dir, name) });
  };
  await capture("optional-install.png");
  const checks = await (await page.request.get(`${daemon.baseURL}/api/setup/checks`)).json();
  expect(checks.banner.attentionRowIds).not.toContainEqual({ source: "dependency", id: "pi-otel" });

  const agentDir = join(daemon.home, "pi-agent");
  const packageDir = join(agentDir, "npm", "node_modules", "@upstart", "pi-router-otel");
  const extension = join(packageDir, "dist", "extensions", "otel", "src", "index.ts");
  mkdirSync(join(packageDir, "dist", "extensions", "otel", "src"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [SOURCE] }));
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: "@upstart/pi-router-otel", version: "0.1.1-alpha.4",
    pi: { extensions: ["./dist/extensions/otel/src/index.ts"] },
  }));
  writeFileSync(extension, "throw new Error('Setup must not execute this package');\n");
  await page.getByRole("button", { name: "Re-check", exact: true }).click();
  await expect(row.getByRole("img", { name: "Ready", exact: true })).toBeVisible();
  await expect(row).toContainText("0.1.1-alpha.4");
  await expect(row).toContainText("export health is not checked");
  await capture("installed.png");

  rmSync(extension);
  await page.getByRole("button", { name: "Re-check", exact: true }).click();
  await expect(row).toContainText("The registered package's OTel entry is missing");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@upstart/pi-router-otel@"] }));
  await page.getByRole("button", { name: "Re-check", exact: true }).click();
  await expect(row.getByRole("img", { name: "Unknown", exact: true })).toBeVisible();
  await expect(row).toContainText("empty version suffix");
  writeFileSync(join(agentDir, "settings.json"), '{"credential":"do-not-show-this-secret"');
  await page.getByRole("button", { name: "Re-check", exact: true }).click();
  await expect(row.getByRole("img", { name: "Unknown", exact: true })).toBeVisible();
  expect(await page.content()).not.toContain("do-not-show-this-secret");
  expect(installations).toEqual([]);
});
