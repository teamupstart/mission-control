import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { captureCard, setupCards } from "../fixtures/voice-cards.ts";
import { say, voiceToken } from "../fixtures/voice.ts";

test.beforeEach(async ({ daemon, dashboard: page }) => {
  await setupCards(page, daemon);
  expect((await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
    identity: { name: "Steve", description: "Builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } })).ok()).toBe(true);
});

async function desktopWith(page: Page, daemon: DaemonHandle, capability: "floating-windows" | "tray") {
  await page.addInitScript(capability => {
    Object.assign(window, { missionDesktop: {
      isDesktop: true, onOpenSettings: () => () => {},
      ...(capability === "tray" && { onRecentlyHeard: (open: () => void) => {
        window.addEventListener("fixture:recently-heard", open);
        return () => window.removeEventListener("fixture:recently-heard", open);
      } }),
    } });
  }, capability);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  await page.reload();
  expect((await page.request.post(daemon.baseURL + "/voice/shell-report", {
    headers: { "x-harness-token": voiceToken(daemon) }, data: { capabilities: { [capability]: { available: true } } },
  })).ok()).toBe(true);
}

test("changing the saved placement moves the live card through the pill, popover and toast", async ({ daemon, dashboard: page }) => {
  await desktopWith(page, daemon, "floating-windows");
  const choices = page.getByRole("group", { name: "Confirmation card" });
  const open = page.waitForEvent("popup");
  await choices.getByRole("radio", { name: /Floating pill/ }).check();
  const pill = await open;
  await say(daemon, "Steve, check the build");
  await expect(pill.getByRole("status")).toContainText("check the build");
  await expect(page.locator(".voice-card")).toHaveCount(0);
  await expect(pill.getByRole("button", { name: "Cancel" })).toHaveAccessibleDescription("Cancel pending voice delivery");

  const move = page.waitForEvent("popup");
  await choices.getByRole("radio", { name: /Tray popover/ }).check();
  const popover = await move;
  await expect(popover).toHaveURL(daemon.baseURL + "/#/voice/popover");
  await expect(popover.getByRole("status")).toContainText("check the build");
  await expect(popover.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect.poll(() => pill.isClosed()).toBe(true);
  await expect(page.locator(".voice-card")).toHaveCount(0);

  await choices.getByRole("radio", { name: /Corner toast/ }).check();
  await expect(page.getByRole("status").filter({ hasText: "To Steve" })).toBeVisible();
  await expect.poll(() => popover.isClosed()).toBe(true);
});

test("a refused floating window keeps the dashboard toast and Cancel usable", async ({ daemon, dashboard: page }) => {
  await desktopWith(page, daemon, "floating-windows");
  await page.evaluate(() => {
    window.open = url => {
      document.documentElement.dataset.refusedPopup = String(url);
      return null;
    };
  });
  await page.getByRole("radio", { name: /Floating pill/ }).check();
  await expect(page.locator("html")).toHaveAttribute("data-refused-popup", "/#/voice/pill");
  await say(daemon, "Steve, check the build");
  const toast = page.locator(".voice-card-stack").getByRole("status");
  await expect(toast).toContainText("check the build");
  await toast.getByRole("button", { name: "Cancel" }).click();
  await expect(toast).toContainText("Cancelled");
});

test("tray history opens without floating-window support while the pending card stays in the toast", async ({ daemon, dashboard: page }) => {
  await desktopWith(page, daemon, "tray");
  await page.getByRole("radio", { name: /Tray popover/ }).check();
  const words = "check the release notes";
  expect((await say(daemon, "Steve, " + words)).ok).toBe(true);
  const toast = page.locator(".voice-card-stack").getByRole("status");
  await expect(toast).toContainText(words);

  const opening = page.waitForEvent("popup");
  await page.evaluate(() => window.dispatchEvent(new Event("fixture:recently-heard")));
  const popover = await opening;
  await expect(popover).toHaveURL(daemon.baseURL + "/#/voice/popover");
  const history = popover.getByRole("region", { name: "Recently heard" });
  await expect(history.getByRole("listitem")).toContainText("Steve, " + words);
  await expect(popover.locator(".voice-card")).toHaveCount(0);
  await expect(toast.getByRole("button", { name: "Cancel" })).toBeVisible();
  await captureCard(popover.locator(".voice-standalone"), "tray-only-history");
  await captureCard(toast, "tray-only-confirmation-toast");
  await popover.keyboard.press("Escape");
  await expect.poll(() => popover.isClosed()).toBe(true);
  await toast.getByRole("button", { name: "Cancel" }).click();
  await expect(toast).toContainText("Cancelled");
});
