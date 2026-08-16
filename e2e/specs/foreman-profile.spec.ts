import { mkdirSync, readFileSync } from "node:fs";
import type { Download, Page } from "@playwright/test";

import type { ForemanInstructionsView } from "../../src/shared/protocol.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("foreman-profile");
const EXACT = " \n# Operator judgment\n\n- Escalate **authority** changes.\n- Preserve tabs:\tvalue  \n";
const LOCAL_CONFLICT = "# Local conflict copy\n\nKeep every byte.  \n";
const REMOTE_CONFLICT = "# Changed elsewhere\n\nThis is the current saved document.\n";

async function instructions(daemon: DaemonHandle): Promise<ForemanInstructionsView> {
  const response = await fetch(`${daemon.baseURL}/api/foreman/instructions`);
  expect(response.ok, `reading Foreman instructions answered ${response.status}`).toBe(true);
  return (await response.json()) as ForemanInstructionsView;
}

async function putInstructions(
  daemon: DaemonHandle,
  update: { expectedEtag: string; text: string } | { expectedEtag: string; reset: true },
): Promise<ForemanInstructionsView> {
  const response = await fetch(`${daemon.baseURL}/api/foreman/instructions`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!response.ok) {
    throw new Error(`writing Foreman instructions answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as ForemanInstructionsView;
}

const hash = (page: Page): Promise<string> => page.evaluate(() => location.hash);
const profile = (page: Page) => page.locator("article.foreman-profile-editor");
const editor = (page: Page) => profile(page).locator(".cm-content");
const readout = (page: Page, name: string) =>
  profile(page).locator("span.lib-chip", { hasText: new RegExp(`^${name}`) });
const chip = (page: Page, name: string) =>
  profile(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });

async function replaceEditorText(page: Page, text: string): Promise<void> {
  const target = editor(page);
  await target.click();
  await page.keyboard.press("ControlOrMeta+a");
  if (text.length === 0) await page.keyboard.press("Backspace");
  else await page.keyboard.insertText(text);
}

async function openProfileMenu(page: Page): Promise<void> {
  await profile(page).getByRole("button", { name: "More Foreman profile actions" }).click();
  await expect(page.getByRole("menu", { name: "More Foreman profile actions" })).toBeVisible();
}

async function downloadedText(download: Download): Promise<string> {
  const path = await download.path();
  expect(path, "the local browser did not expose the completed download").not.toBeNull();
  return readFileSync(path!, "utf8");
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/foreman-profile/${name}.png`);
}

async function expectNoHorizontalPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth
    <= document.documentElement.clientWidth)).toBe(true);
}

test("Foreman's fixed System profile owns exact guidance and links every other setting home", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await dashboard.setViewportSize({ width: 1500, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/library`);

  const personaShelf = dashboard.getByRole("heading", { name: "Who does the reviewing?" })
    .locator("..");
  const systemCard = personaShelf.getByRole("button", { name: /Foreman/ });
  await expect(systemCard).toContainText("system");
  await expect(systemCard).toContainText("4 model roles");
  await systemCard.click();

  await expect.poll(() => hash(dashboard)).toBe("#/library/personas/foreman");
  await expect(profile(dashboard).getByRole("heading", { name: "Foreman" })).toBeVisible();
  await expect(profile(dashboard)).toContainText("System profile");
  await expect(profile(dashboard)).toContainText("Not available to workflows or ensembles");
  await expect(readout(dashboard, "source")).toContainText("Built-in default");
  await expect(editor(dashboard)).toBeVisible();
  for (const forbidden of ["Rename", "Duplicate", "Archive", "Delete", "Re-import"]) {
    await expect(profile(dashboard).getByRole("button", { name: forbidden, exact: true }))
      .toHaveCount(0);
  }
  await expect(profile(dashboard).getByLabel("Name", { exact: true })).toHaveCount(0);
  await expect(profile(dashboard).getByLabel("Description", { exact: true })).toHaveCount(0);

  await replaceEditorText(dashboard, EXACT);
  await profile(dashboard).getByRole("button", { name: "Preview", exact: true }).click();
  await expect(profile(dashboard).getByRole("heading", { name: "Operator judgment" }))
    .toBeVisible();
  await expect(profile(dashboard)).toContainText("Escalate authority changes.");
  await profile(dashboard).getByRole("button", { name: "Edit", exact: true }).click();
  await profile(dashboard).getByRole("button", { name: "Save", exact: true }).click();
  await expect(readout(dashboard, "source")).toContainText("Customized");
  await expect.poll(async () => (await instructions(daemon)).text).toBe(EXACT);

  // Copy and download both read the untouched local draft, including leading and trailing space.
  await openProfileMenu(dashboard);
  await dashboard.getByRole("menuitem", { name: "Copy Markdown" }).click();
  await expect(dashboard.getByRole("menuitem", { name: "Copied" })).toBeVisible();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe(EXACT);
  const downloadPromise = dashboard.waitForEvent("download");
  await dashboard.getByRole("menuitem", { name: "Download FOREMAN.md" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("FOREMAN.md");
  expect(await downloadedText(download)).toBe(EXACT);

  await dashboard.reload();
  await expect.poll(() => hash(dashboard)).toBe("#/library/personas/foreman");
  await expect(readout(dashboard, "source")).toContainText("Customized");
  expect((await instructions(daemon)).text).toBe(EXACT);

  // The authority chip opens the existing top-bar owner in place, then closes normally.
  await chip(dashboard, "authority").click();
  const owners = dashboard.getByRole("group", { name: "Foreman authority owners" });
  await owners.getByRole("button", { name: "Open top-bar Foreman control" }).click();
  await expect(dashboard.getByRole("dialog", { name: "Foreman settings" })).toBeVisible();
  await expect(owners).toHaveCount(0);
  await dashboard.keyboard.press("Escape");
  await expect(dashboard.getByRole("dialog", { name: "Foreman settings" })).toHaveCount(0);
  await expect.poll(() => hash(dashboard)).toBe("#/library/personas/foreman");

  // Provider/model facts navigate to the existing Models tab and exact provider owner.
  await chip(dashboard, "provider").click();
  await dashboard.getByRole("group", { name: "Foreman model summary" })
    .getByRole("button", { name: "Open Models settings" }).click();
  await expect.poll(() => hash(dashboard)).toBe("#/settings/foreman");
  await expect(dashboard.locator(".sc-controls").getByRole("tab", { name: "Models" }))
    .toHaveAttribute("aria-selected", "true");
  await expect(dashboard.locator('[data-anchor="foreman/provider"]')).toHaveClass(/settings-flash/);

  const guidanceCard = dashboard.getByRole("heading", { name: "Standing guidance" })
    .locator("..").locator("..");
  await expect(guidanceCard).toContainText("Customized", { timeout: 8_000 });
  await guidanceCard.getByRole("button", { name: "Open System profile" }).click();
  await expect.poll(() => hash(dashboard)).toBe("#/library/personas/foreman");

  await chip(dashboard, "authority").click();
  await dashboard.getByRole("group", { name: "Foreman authority owners" })
    .getByRole("button", { name: "Open Foreman posture" }).click();
  await expect.poll(() => hash(dashboard)).toBe("#/settings/foreman");
  await expect(dashboard.locator(".sc-controls").getByRole("tab", { name: "Posture" }))
    .toHaveAttribute("aria-selected", "true");
  await expect(dashboard.locator('[data-anchor="foreman/cheap-tier"]')).toHaveClass(/settings-flash/);
  await dashboard.getByRole("heading", { name: "Standing guidance" })
    .locator("..").locator("..")
    .getByRole("button", { name: "Open System profile" }).click();

  await chip(dashboard, "authority").click();
  await dashboard.getByRole("group", { name: "Foreman authority owners" })
    .getByRole("button", { name: "Open Trust" }).click();
  await expect.poll(() => hash(dashboard)).toBe("#/settings/trust");
  await expect(dashboard.locator('[data-anchor="trust/matrix"]')).toHaveClass(/settings-flash/);
  await expect(dashboard.getByRole("table", { name: "Repository trust grants" })).toBeVisible();
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/foreman`);
  await expect(readout(dashboard, "source")).toContainText("Customized");

  // A focus refresh never drops dirty bytes. Keep editing explicitly rebases the next Save.
  await replaceEditorText(dashboard, LOCAL_CONFLICT);
  const beforeConflict = await instructions(daemon);
  await putInstructions(daemon, {
    expectedEtag: beforeConflict.etag,
    text: REMOTE_CONFLICT,
  });
  await dashboard.evaluate(() => window.dispatchEvent(new Event("focus")));
  const conflict = profile(dashboard).getByRole("alert")
    .filter({ hasText: "Standing guidance changed" });
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText("Your local Markdown has not been changed");
  await conflict.getByRole("button", { name: "Keep editing" }).click();
  await profile(dashboard).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await instructions(daemon)).text).toBe(LOCAL_CONFLICT);

  // Reset is a distinct confirmed CAS operation. Making its base stale leaves the draft intact.
  await openProfileMenu(dashboard);
  await dashboard.getByRole("menuitem", { name: "Reset to built-in default" }).click();
  const resetDialog = dashboard.getByRole("dialog", { name: "Reset Foreman standing guidance" });
  await expect(resetDialog).toBeVisible();
  await expect(resetDialog).toContainText("Clearing and saving is different");
  await shoot(dashboard, "01-reset-confirmation-desktop-dark");
  const beforeStaleReset = await instructions(daemon);
  await putInstructions(daemon, {
    expectedEtag: beforeStaleReset.etag,
    text: REMOTE_CONFLICT,
  });
  await resetDialog.getByRole("button", { name: "Reset to built-in default" }).click();
  await expect(profile(dashboard).getByRole("alert")
    .filter({ hasText: "Standing guidance changed" }))
    .toBeVisible();
  await shoot(dashboard, "02-conflict-desktop-dark");

  // Copy remains available from the local draft while the saved document is conflicted.
  await openProfileMenu(dashboard);
  const conflictedMenu = dashboard.getByRole("menu", { name: "More Foreman profile actions" });
  await expect(conflictedMenu.getByRole("menuitem", { name: "Download FOREMAN.md" })).toBeEnabled();
  await conflictedMenu.getByRole("menuitem", { name: "Copy Markdown" }).click();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe(LOCAL_CONFLICT);
  await dashboard.keyboard.press("Escape");
  await profile(dashboard).getByRole("alert").getByRole("button", { name: "Reload latest" }).click();
  expect((await instructions(daemon)).text).toBe(REMOTE_CONFLICT);

  // Empty Save intentionally selects none; Reset restores the shipped document, not empty text.
  await replaceEditorText(dashboard, "");
  await profile(dashboard).getByRole("button", { name: "Save", exact: true }).click();
  await expect(readout(dashboard, "source")).toContainText("No standing guidance");
  await expect.poll(async () => (await instructions(daemon)).text).toBe("");

  await openProfileMenu(dashboard);
  await dashboard.getByRole("menuitem", { name: "Reset to built-in default" }).click();
  await dashboard.getByRole("dialog", { name: "Reset Foreman standing guidance" })
    .getByRole("button", { name: "Reset to built-in default" }).click();
  await expect(readout(dashboard, "source")).toContainText("Built-in default");
  const restored = await instructions(daemon);
  expect(restored.source).toBe("builtin");
  expect(restored.text).toBe(restored.defaultText);
  expect(restored.text.length).toBeGreaterThan(0);

  // The app currently ships a fixed dark palette. Both browser preferences are exercised so
  // native controls and media-dependent rendering remain stable at desktop and supported narrow.
  for (const colorScheme of ["dark", "light"] as const) {
    await dashboard.emulateMedia({ colorScheme });
    for (const [size, width, height] of [
      ["desktop", 1500, 900],
      ["narrow", 720, 1000],
    ] as const) {
      await dashboard.setViewportSize({ width, height });
      await expect(profile(dashboard)).toBeVisible();
      await expect(profile(dashboard).getByRole("button", { name: "Save", exact: true }))
        .toBeVisible();
      await expectNoHorizontalPageOverflow(dashboard);
      await shoot(dashboard, `03-final-${size}-${colorScheme}`);
    }
  }
});
