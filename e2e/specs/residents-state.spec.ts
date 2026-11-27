import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

async function profileWithState(request: APIRequestContext, baseURL: string, name: string) {
  const created = await request.post(`${baseURL}/api/residents/profiles`, { data: { settings: {
    identity: { name }, instructions: { markdown: "Watch for replies." },
  } } });
  expect(created.ok(), await created.text()).toBe(true);
  const profile = await created.json() as ResidentProfile;
  const stateUrl = `${baseURL}/api/residents/profiles/${profile.id}/state`;
  const response = await request.get(stateUrl);
  expect(response.ok()).toBe(true);
  const { directory } = await response.json() as { directory: string };
  return { profile, stateUrl, directory };
}

async function capture(page: import("@playwright/test").Page, name: string, target?: import("@playwright/test").Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const evidence = artifactsDir("residents-state");
  mkdirSync(evidence, { recursive: true });
  // A closed overlay hands focus back to its opener, whose focus tooltip would cover the shot.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0);
  await (target ?? page).screenshot({ path: join(evidence, `${name}.png`) });
}

test("View state opens the profile's state files in a viewer with a rendered preview", async ({ dashboard: page, daemon }) => {
  const { profile, directory } = await profileWithState(page.request, daemon.baseURL, "State viewer");
  writeFileSync(join(directory, "MEMORY.md"), "# Ledger\n\n- Handled reply 42.\n\n#### Watermarks\n\nLast seen 1700000000.\n");
  writeFileSync(join(directory, "watermark.txt"), "last-seen: 1700000000");
  await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
  const panel = page.getByRole("region", { name: "Durable resident state" });
  await panel.getByRole("button", { name: "View state", exact: true }).click();

  // The viewer opens over the editor rather than unfolding below the fold of its last card.
  const viewer = page.getByRole("dialog", { name: "Durable state: State viewer" });
  await expect(viewer).toBeVisible();
  await expectContentClearsBorder(viewer);
  await expect(viewer).toContainText(directory);
  const files = viewer.getByRole("navigation", { name: "State files" });
  await expect(files.getByRole("button")).toHaveText(["MEMORY.md", "watermark.txt"]);

  // Auto-memory opens first and reads as Markdown, not raw source.
  await expect(files.getByRole("button", { name: "MEMORY.md" })).toHaveAttribute("aria-current", "true");
  const memory = viewer.getByRole("region", { name: "State file MEMORY.md" });
  await expect(memory.getByRole("heading", { name: "Ledger" })).toBeVisible();
  await expect(memory.getByRole("listitem")).toHaveText("Handled reply 42.");
  await expect(memory).not.toContainText("# Ledger");
  // The viewer sits outside the editor, so the editor's card heading style never reaches the note.
  await expect(memory.getByRole("heading", { name: "Watermarks" })).not.toHaveCSS("text-transform", "uppercase");
  // The directory band reaches both borders of the panel, as a bleed band should.
  const [band, shell] = await Promise.all([viewer.locator(".resident-state-viewer-path").boundingBox(), viewer.boundingBox()]);
  expect(Math.abs(band!.x - shell!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(band!.x + band!.width - (shell!.x + shell!.width))).toBeLessThanOrEqual(1);
  await capture(page, "viewer-markdown", viewer);

  // Any other file is shown verbatim.
  await files.getByRole("button", { name: "watermark.txt" }).click();
  const watermark = viewer.getByRole("region", { name: "State file watermark.txt" });
  await expect(watermark.locator("pre")).toHaveText("last-seen: 1700000000");
  await expect(files.getByRole("button", { name: "watermark.txt" })).toHaveAttribute("aria-current", "true");

  // Refresh picks up files written since, and keeps the file being read.
  writeFileSync(join(directory, "ledger.md"), "Ledger entry");
  await viewer.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(files.getByRole("button")).toHaveText(["ledger.md", "MEMORY.md", "watermark.txt"]);
  await expect(watermark.locator("pre")).toHaveText("last-seen: 1700000000");

  // When the file being read is gone, Refresh opens the auto-memory index instead, and nothing
  // of the deleted file stays on screen.
  rmSync(join(directory, "watermark.txt"));
  await viewer.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(files.getByRole("button")).toHaveText(["ledger.md", "MEMORY.md"]);
  await expect(files.getByRole("button", { name: "MEMORY.md" })).toHaveAttribute("aria-current", "true");
  await expect(memory.getByRole("heading", { name: "Ledger" })).toBeVisible();
  await expect(watermark).toHaveCount(0);
  await expect(viewer).not.toContainText("last-seen: 1700000000");

  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(panel.getByRole("button", { name: "View state", exact: true })).toBeVisible();
});

test("a state list that cannot be read says why inside the viewer", async ({ dashboard: page, daemon }) => {
  const { profile, stateUrl } = await profileWithState(page.request, daemon.baseURL, "State failure");
  await page.route(stateUrl, (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "State list unavailable" }),
  }));
  await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
  const panel = page.getByRole("region", { name: "Durable resident state" });
  await panel.getByRole("button", { name: "View state", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "Durable state: State failure" });
  await expect(viewer.getByRole("alert")).toHaveText("State list unavailable");

  await page.unroute(stateUrl);
  await viewer.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(viewer.getByRole("alert")).toHaveCount(0);
  await expect(viewer).toContainText("No saved state files.");
});

test("a state file that cannot be read says why in its preview, and reading it again recovers", async ({ dashboard: page, daemon }) => {
  const { profile, stateUrl, directory } = await profileWithState(page.request, daemon.baseURL, "Preview failure");
  writeFileSync(join(directory, "MEMORY.md"), "Handled reply 42.");
  let refused = 0;
  await page.route(`${stateUrl}/file?*`, async (route) => {
    refused++;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "State preview is limited to 256 KiB" }) });
  });
  await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
  const panel = page.getByRole("region", { name: "Durable resident state" });
  await panel.getByRole("button", { name: "View state", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "Durable state: Preview failure" });
  const preview = viewer.getByRole("region", { name: "State file MEMORY.md" });

  // The refusal is shown where the file would be, not swallowed and not left loading.
  await expect(preview.getByRole("alert")).toHaveText("State preview is limited to 256 KiB");
  await expect(preview.getByRole("status")).toHaveCount(0);
  await expect(preview).not.toContainText("Handled reply 42.");
  expect(refused).toBe(1);
  // The file list stays usable, so the operator can try again.
  const file = viewer.getByRole("navigation", { name: "State files" }).getByRole("button", { name: "MEMORY.md" });
  await expect(file).toBeEnabled();
  await capture(page, "preview-refused", viewer);

  await page.unroute(`${stateUrl}/file?*`);
  await file.click();
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await expect(preview).toContainText("Handled reply 42.");
});

test("a reset confirmed while the viewer is open reloads it with the cleared state", async ({ dashboard: page, daemon }) => {
  const { profile, directory } = await profileWithState(page.request, daemon.baseURL, "Reset behind viewer");
  const memory = join(directory, "MEMORY.md");
  writeFileSync(memory, "Handled reply 42.");
  await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
  const panel = page.getByRole("region", { name: "Durable resident state" });
  await panel.getByRole("button", { name: "View state", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "Durable state: Reset behind viewer" });
  await expect(viewer.getByRole("region", { name: "State file MEMORY.md" })).toContainText("Handled reply 42.");

  // Reach Reset state behind the open viewer from the keyboard, then confirm it.
  const reset = panel.getByRole("button", { name: "Reset state", exact: true });
  await reset.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Reset resident state" });
  await dialog.getByRole("button", { name: "Delete saved state" }).click();
  await expect(dialog).toBeHidden();

  // The viewer shows the cleared state rather than waiting on a listing nothing fetches.
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText("No saved state files.");
  await expect(viewer.getByRole("status")).toHaveCount(0);
  await expect(viewer).not.toContainText("Handled reply 42.");
  await expect(panel.getByRole("status")).toHaveText("Saved state cleared.");
  expect(existsSync(memory)).toBe(false);
  await capture(page, "reset-behind-open-viewer", viewer);
});

for (const resetFails of [false, true]) {
  test(`resident state reset waits for a pending read and ${resetFails ? "reports a refusal" : "clears the files"}`, async ({ dashboard: page, daemon }) => {
    const { profile, stateUrl, directory } = await profileWithState(page.request, daemon.baseURL, "State preview guard");
    const memory = join(directory, "MEMORY.md");
    writeFileSync(memory, "Handled reply 42.");
    await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
    const panel = page.getByRole("region", { name: "Durable resident state" });
    const reset = panel.getByRole("button", { name: "Reset state", exact: true });

    let releasePreview!: () => void;
    const previewHeld = new Promise<void>((resolve) => { releasePreview = resolve; });
    let previewRequested!: () => void;
    const previewStarted = new Promise<void>((resolve) => { previewRequested = resolve; });
    await page.route(`${stateUrl}/file?*`, async (route) => {
      previewRequested();
      const preview = await route.fetch();
      await previewHeld;
      await route.fulfill({ response: preview });
    });
    let resetRequests = 0;
    await page.route(`${stateUrl}/reset`, async (route) => {
      resetRequests++;
      if (resetFails) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Complete and close this resident's runs first" }) });
      } else {
        await route.continue();
      }
    });

    // Close the viewer while its first preview is still being read: reset stays unavailable
    // until that read settles, so it cannot race a read of the files it deletes.
    await panel.getByRole("button", { name: "View state", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "Durable state: State preview guard" });
    await previewStarted;
    await expect(viewer.getByRole("status")).toHaveText("Loading MEMORY.md…");
    await viewer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(viewer).toBeHidden();
    await expect(reset).toBeDisabled();
    releasePreview();
    await expect(reset).toBeEnabled();
    expect(resetRequests).toBe(0);

    await reset.click();
    const dialog = page.getByRole("dialog", { name: "Reset resident state" });
    await expectContentClearsBorder(dialog);
    await dialog.getByRole("button", { name: "Delete saved state" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => resetRequests).toBe(1);

    if (resetFails) {
      await expect(panel.getByRole("alert")).toHaveText("Complete and close this resident's runs first");
      expect(existsSync(memory)).toBe(true);
      await capture(page, "reset-refused", panel);
      return;
    }
    await expect(panel.getByRole("status")).toHaveText("Saved state cleared.");
    expect(existsSync(memory)).toBe(false);
    await panel.getByRole("button", { name: "View state", exact: true }).click();
    await expect(viewer).toContainText("No saved state files.");
    await expect(viewer.getByRole("region", { name: /^State file/ })).toHaveCount(0);
    await expectContentClearsBorder(viewer);
    await capture(page, "reset-cleared-viewer", viewer);
  });
}
