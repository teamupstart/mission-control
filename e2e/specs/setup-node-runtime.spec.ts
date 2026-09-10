import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base } from "../fixtures/test.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";
import { recordsIn } from "../fixtures/records.ts";
import { shellCommand } from "../../src/server/terminal/shell.ts";
import { setupInstallerShell } from "../../src/server/setup/install.ts";

const test = base.extend<{ selectedNode: { path: string; version(value: string): Promise<void> } }>({
  selectedNode: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), "mission-setup-node-"));
    const path = join(dir, "node");
    const version = async (value: string) => {
      await writeFile(path, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(value)});\n`, { mode: 0o755 });
    };
    await version("22.0.0");
    try { await use({ path, version }); }
    finally { await rm(dir, { recursive: true, force: true }); }
  },
  daemonEnv: async ({ selectedNode }, use) => {
    await use({ MISSION_NODE_BIN: selectedNode.path });
  },
});

test("Setup detects old, missing and invalid Node and runs the repair through the chosen terminal", async ({ page, daemon, selectedNode }) => {
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "runtime");
  const row = setupRow(page, "dependency-node-runtime");
  await expect(row).toContainText("Node.js 22.0.0 is too old");
  await expect(row).toContainText("requires Node.js 24 or newer");
  await expect(row).toContainText("restart Mission Control");
  await expect(row).toContainText("brew install node");
  const capture = async (name: string) => {
    if (process.env.MC_E2E_EVIDENCE !== "1") return;
    const dir = "e2e/.artifacts/setup-node-runtime";
    await mkdir(dir, { recursive: true });
    await expect(page.getByRole("button", { name: "Re-check", exact: true })).toBeVisible();
    await page.mouse.move(1, 1);
    await page.screenshot({ path: join(dir, name), fullPage: true });
  };
  await capture("incompatible.png");
  await row.getByLabel("Terminal for Node.js").selectOption("cmux");
  const request = page.waitForRequest(r => r.url().endsWith("/api/setup/install") && r.method() === "POST");
  await row.getByRole("button", { name: "Run in a terminal" }).click();
  expect((await request).postDataJSON()).toEqual({ id: "node-runtime", backend: "cmux" });
  await expect(row.getByRole("status")).toContainText("When the installer finishes, press Re-check.");
  const launches = () => recordsIn<{ argv: string[] }>(daemon.recordDir, f => f.startsWith("cmux-"));
  await expect.poll(() => launches().length).toBe(1);
  const argv = launches()[0]!.argv;
  expect(argv[argv.indexOf("--command") + 1]).toBe(shellCommand(["/bin/sh", "-c", setupInstallerShell(["brew", "install", "node"])]));
  // Opening a terminal is not evidence of a repaired installation.
  await page.getByRole("button", { name: "Re-check", exact: true }).click();
  await expect(row).toContainText("Node.js 22.0.0 is too old");
  await rm(selectedNode.path);
  await page.getByRole("button", { name: "Re-check", exact: true }).click();
  await expect(row).toContainText("Node.js could not be found");
  await selectedNode.version("not-a-version");
  await page.getByRole("button", { name: "Re-check", exact: true }).click();
  await expect(row).toContainText("could not verify the selected Node.js version");
  await selectedNode.version("24.0.0");
  await page.getByRole("button", { name: "Re-check", exact: true }).click();
  await expect(row.getByRole("img", { name: "Ready", exact: true })).toBeVisible();
  await expect(row).toContainText("Node.js 24.0.0");
  await expect(row.getByRole("button", { name: "Run in a terminal" })).toHaveCount(0);
  await capture("ready.png");
});
