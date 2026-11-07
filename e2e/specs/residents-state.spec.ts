import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

test("resident state reset skips confirmation during a preview and clears deleted text", async ({ dashboard: page, daemon }) => {
  const created = await page.request.post(`${daemon.baseURL}/api/residents/profiles`, { data: { settings: {
    identity: { name: "State preview guard" }, instructions: { markdown: "Watch for replies." },
  } } });
  expect(created.ok(), await created.text()).toBe(true);
  const profile = await created.json() as ResidentProfile;
  const stateUrl = `${daemon.baseURL}/api/residents/profiles/${profile.id}/state`;
  const response = await page.request.get(stateUrl);
  expect(response.ok()).toBe(true);
  const { directory } = await response.json() as { directory: string };
  const memory = join(directory, "MEMORY.md");
  writeFileSync(memory, "Handled reply 42.");
  await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
  const panel = page.getByRole("region", { name: "Durable resident state" });
  await panel.getByRole("button", { name: "View state" }).click();
  const file = panel.getByRole("button", { name: "MEMORY.md" });
  await expect(file).toBeVisible();

  let resetRequests = 0;
  await page.route(`${stateUrl}/reset`, async (route) => {
    resetRequests++;
    await route.continue();
  });
  let releasePreview!: () => void;
  const previewHeld = new Promise<void>((resolve) => { releasePreview = resolve; });
  await page.route(`${stateUrl}/file?*`, async (route) => {
    const preview = await route.fetch();
    await previewHeld;
    await route.fulfill({ response: preview });
  });
  await panel.getByRole("button", { name: "Reset state" }).click();
  const dialog = page.getByRole("dialog", { name: "Reset resident state" });
  await expectContentClearsBorder(dialog);
  await expect(dialog.getByRole("button", { name: "Delete saved state" })).toBeFocused();
  // The overlay leaves background controls keyboard-reachable. Start a preview after
  // opening confirmation, then confirm while the preview response is still pending.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(file).toBeFocused();
  await page.keyboard.press("Space");
  await expect(file).toBeDisabled();
  await dialog.getByRole("button", { name: "Delete saved state" }).click();
  await expect(dialog).toBeHidden();
  releasePreview();
  const preview = panel.getByRole("region", { name: "State file MEMORY.md" });
  await expect(preview).toContainText("Handled reply 42.");
  expect(resetRequests).toBe(0);
  expect(existsSync(memory)).toBe(true);

  // Confirmation works once the read settles, and its refresh cannot retain deleted text.
  await panel.getByRole("button", { name: "Reset state" }).click();
  await dialog.getByRole("button", { name: "Delete saved state" }).click();
  await expect(panel).toContainText("No saved state files.");
  await expect(panel.getByRole("button", { name: "Refresh state" })).toBeEnabled();
  await expect(preview).toHaveCount(0);
  expect(resetRequests).toBe(1);
  expect(existsSync(memory)).toBe(false);
  if (process.env.MC_E2E_EVIDENCE) {
    const evidence = artifactsDir("residents-state");
    mkdirSync(evidence, { recursive: true });
    await page.mouse.move(0, 0);
    await expect(page.locator(".tooltip")).toHaveCount(0);
    await panel.screenshot({ path: join(evidence, "reset-clears-preview.png") });
  }
});
