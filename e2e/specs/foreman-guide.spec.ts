import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

// The same guide must be reachable from each operating surface, without changing
// Foreman's authority, and its link must reach the actual editable document.
const EVIDENCE = artifactsDir("foreman-guide");
const guide = (page: Page) => page.getByRole("dialog", { name: "About Foreman", exact: true });
const profileLink = (dialog: Locator) => dialog.getByRole("link", { name: "Edit Foreman prompt in Library" });

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function expectGuide(page: Page): Promise<void> {
  const dialog = guide(page);
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  for (const heading of [
    "How it works on your behalf",
    "What context it has",
    "You choose how much it can do",
    "Make its judgment fit your priorities",
  ]) {
    await expect(dialog.getByRole("heading", { name: heading })).toBeAttached();
  }
  await expect(dialog).toContainText("Each evaluation starts fresh");
  await expect(dialog).toContainText("Risky or destructive requests");
  await expect(dialog).toContainText("cannot grant extra permissions or turn off safety checks");
  await expect(profileLink(dialog)).toHaveAttribute("href", "#/library/personas/foreman");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(profileLink(dialog)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await expectContentClearsBorder(dialog);
  await expect(dialog.getByRole("button", { name: "Close", exact: true }))
    .toHaveAccessibleDescription("Close the Foreman guide (Escape)");
  await expect(profileLink(dialog)).toHaveAccessibleDescription("Open Foreman's standing prompt in Library");
  await dialog.getByRole("button", { name: "Close", exact: true }).hover();
  await expect(page.locator(".tooltip").filter({ hasText: "Close the Foreman guide (Escape)" })).toBeVisible();
  await profileLink(dialog).hover();
  await expect(page.locator(".tooltip").filter({ hasText: "Open Foreman's standing prompt in Library" })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0);
}

async function expectWheelScrolling(page: Page, restoreTop: boolean): Promise<void> {
  const dialog = guide(page);
  const body = dialog.locator(".foreman-guide-body");
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  const link = profileLink(dialog);
  const closeBefore = await close.boundingBox();
  const linkBefore = await link.boundingBox();
  const initial = await body.evaluate((element) => ({
    top: element.scrollTop, height: element.clientHeight, content: element.scrollHeight,
  }));
  expect(initial.top).toBe(0);
  expect(initial.content).toBeGreaterThan(initial.height);
  await body.hover();
  await page.mouse.wheel(0, 10_000);
  await expect.poll(() => body.evaluate((element) =>
    element.scrollTop > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
  )).toBe(true);
  await expect(dialog.getByRole("heading", { name: "Make its judgment fit your priorities" })).toBeInViewport();
  await expect(close).toBeInViewport();
  await expect(link).toBeInViewport();
  expect(await close.boundingBox(), "Close remains fixed while the guide body scrolls").toEqual(closeBefore);
  expect(await link.boundingBox(), "the Library link remains fixed while the guide body scrolls").toEqual(linkBefore);
  console.log(`Foreman guide wheel scroll ${JSON.stringify(page.viewportSize())}: ${JSON.stringify(initial)} -> scrollTop=${await body.evaluate((element) => element.scrollTop)}; Close and Library link stayed visible and stationary.`);
  if (restoreTop) {
    await page.mouse.wheel(0, -10_000);
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(dialog.locator(".foreman-guide-intro")).toBeInViewport();
  }
}

for (const surface of ["dropdown", "settings"] as const) {
  test(`Foreman guide opens from ${surface}, dismisses accessibly, and links to the editable prompt`, async ({ dashboard, daemon }) => {
    await dashboard.setViewportSize({ width: 1440, height: 1000 });
    // The guide remains available even when Foreman is switched off.
    const disabled = await fetch(`${daemon.baseURL}/api/foreman/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.ok).toBe(true);
    await dashboard.reload();
    if (surface === "settings") {
      await dashboard.goto(`${daemon.baseURL}/#/settings/foreman`);
    } else {
      await dashboard.getByRole("button", { name: /Foreman - the auto-responder/ }).click();
    }
    const source = surface === "dropdown"
      ? dashboard.getByRole("dialog", { name: "Foreman settings", exact: true })
      : dashboard.locator(".sc-section");
    const info = source.getByRole("button", { name: "About Foreman", exact: true });
    await expect(info).toBeEnabled();
    if (surface === "dropdown") {
      const enable = source.getByRole("checkbox", { name: "Enable Foreman", exact: true });
      const checkboxBounds = await enable.boundingBox();
      const infoBounds = await info.boundingBox();
      expect(checkboxBounds).not.toBeNull();
      expect(infoBounds).not.toBeNull();
      expect(Math.abs(checkboxBounds!.y + checkboxBounds!.height / 2 - infoBounds!.y - infoBounds!.height / 2),
        "the info icon sits on the Enable Foreman checkbox row").toBeLessThan(2);
      expect(infoBounds!.x).toBeGreaterThan(checkboxBounds!.x + checkboxBounds!.width);
      await expect(info.locator("svg")).toBeVisible();
      await expect(enable).not.toBeChecked();
    }
    await capture(dashboard, `${surface}-info-button`);
    await info.click();
    await expectGuide(dashboard);
    await expectWheelScrolling(dashboard, true);
    await capture(dashboard, `${surface}-guide-desktop`);
    await dashboard.keyboard.press("Escape");
    await expect(guide(dashboard)).toHaveCount(0);
    await expect(info).toBeFocused();
    await expect(source).toBeVisible();

    await info.press("Enter");
    await guide(dashboard).getByRole("button", { name: "Close", exact: true }).click();
    await expect(info).toBeFocused();
    await info.click();
    await dashboard.mouse.click(5, 5);
    await expect(guide(dashboard)).toHaveCount(0);
    await expect(info).toBeFocused();

    await info.click();
    await dashboard.setViewportSize({ width: 720, height: 640 });
    const dialog = guide(dashboard);
    await expectContentClearsBorder(dialog);
    await expectWheelScrolling(dashboard, false);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640);
    await expect(profileLink(dialog)).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
    await capture(dashboard, `${surface}-guide-narrow`);
    await profileLink(dialog).click();
    await expect(guide(dashboard)).toHaveCount(0);
    await expect(dashboard.getByRole("dialog", { name: "Foreman settings", exact: true })).toHaveCount(0);
    await expect(dashboard).toHaveURL(/#\/library\/personas\/foreman$/);
    const profile = dashboard.locator("article.foreman-profile-editor");
    await expect(profile.getByRole("heading", { name: "Foreman", exact: true })).toBeVisible();
    await expect(profile.locator(".cm-content")).toBeVisible();
    await profile.locator(".cm-content").click();
    await dashboard.keyboard.press("ControlOrMeta+a");
    await dashboard.keyboard.insertText("Ask me before changing the scope of a task.");
    await profile.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => {
      const response = await fetch(`${daemon.baseURL}/api/foreman/instructions`);
      return (await response.json() as { text: string }).text;
    }).toBe("Ask me before changing the scope of a task.");
    await capture(dashboard, `${surface}-editable-profile`);
    const config = await (await fetch(`${daemon.baseURL}/api/foreman/config`)).json() as { enabled: boolean };
    expect(config.enabled, "reading the guide and editing guidance must not enable Foreman").toBe(false);
  });
}

test("session Foreman pane keeps its place when the guide closes and links to the same profile", async ({ dashboard, daemon }) => {
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dispatch = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dispatch.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dispatch.getByPlaceholder("What should this agent do?").fill("Explain a short function");
  await dispatch.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dispatch.getByRole("button", { name: "Dispatch now", exact: true }).click();
  await expect(dispatch).toBeHidden();
  const layout = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(layout.ok).toBe(true);
  await dashboard.reload();
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.getByRole("button", { name: "Foreman intent", exact: true }).click();
  const drawer = dashboard.locator(".foreman-drawer");
  const info = drawer.getByRole("button", { name: "About Foreman", exact: true });
  await capture(dashboard, "session-info-button");
  await info.click();
  await expectGuide(dashboard);
  // A live session update can re-register the app's keyboard listener after the
  // guide's listener. Escape must still belong only to the guide in that order.
  const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as { id: string }[];
  expect(sessions).toHaveLength(1);
  const renamed = await fetch(`${daemon.baseURL}/api/sessions/${sessions[0]!.id}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Updated while reading Foreman guide" }),
  });
  expect(renamed.ok).toBe(true);
  await expect(dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row"))
    .toContainText("Updated while reading Foreman guide");
  await capture(dashboard, "session-guide");
  // Neither the drawer nor the selected conversation should receive this Escape.
  await dashboard.keyboard.press("Escape");
  await expect(guide(dashboard)).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(info).toBeFocused();
  await capture(dashboard, "session-guide-dismissed");
  await info.click();
  await profileLink(guide(dashboard)).click();
  await expect(dashboard).toHaveURL(/#\/library\/personas\/foreman$/);
  await expect(dashboard.locator("article.foreman-profile-editor .cm-content")).toBeVisible();
});
