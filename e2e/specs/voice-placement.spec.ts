import type { Page } from "@playwright/test";
import { fixtureSupervisorEnv } from "../../test/helpers/voice-supervisor.ts";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { captureCard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { beSpeaker, say, voiceToken } from "../fixtures/voice.ts";

test.beforeEach(async ({ daemon, dashboard: page }) => {
  await setupCards(page, daemon);
  expect((await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
    identity: { name: "Steve", description: "Builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } })).ok()).toBe(true);
});

async function desktopWith(page: Page, daemon: DaemonHandle, capability: "floating-windows" | "tray" | "both") {
  await page.addInitScript(capability => {
    Object.assign(window, { missionDesktop: {
      isDesktop: true, onOpenSettings: () => () => {},
      ...(capability !== "floating-windows" && { onRecentlyHeard: (open: () => void) => {
        window.addEventListener("fixture:recently-heard", open);
        return () => window.removeEventListener("fixture:recently-heard", open);
      } }),
    } });
  }, capability);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  await page.reload();
  expect((await page.request.post(daemon.baseURL + "/voice/shell-report", {
    headers: { "x-harness-token": voiceToken(daemon) }, data: { capabilities: capability === "both"
      ? { tray: { available: true }, "floating-windows": { available: true } } : { [capability]: { available: true } } },
  })).ok()).toBe(true);
}

test.describe("floating Ask aloud", () => {
  test.use({ daemonEnv: fixtureSupervisorEnv });

  test("the pill can stop the spoken question and open its Recently heard history", async ({ daemon, dashboard: page }) => {
    await desktopWith(page, daemon, "both");
    await runningAgent(page, daemon, "Will");
    const speaker = await beSpeaker(daemon, { holdPlayback: true, ignoreStop: true });
    try {
      await page.getByRole("radio", { name: "Ask aloud" }).check();
      const opening = page.waitForEvent("popup");
      await page.getByRole("radio", { name: /Floating pill/ }).check();
      const pill = await opening;
      const words = "Steven ask Will about the deployment";
      await speaker.say(words);
      const card = pill.getByRole("status");
      await expect(card).toContainText("Asking aloud");
      await expect(card.getByRole("button", { name: /Will/ })).toBeEnabled();
      await expect(page.locator(".voice-card")).toHaveCount(0);
      await expect.poll(() => speaker.playing).toBe(true);
      await captureCard(card, "floating-ask-aloud");
      await card.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(card).toContainText("Who is this for?");
      await expect(card).toContainText("Pick a row now, or speak once playback ends.");
      expect((await speaker.poll()).capture).toBe(false);
      await speaker.end("stopped");
      await expect(card).toContainText("Say the name again");
      expect((await speaker.poll()).capture).toBe(true);

      const historyOpening = page.waitForEvent("popup");
      await card.getByRole("button", { name: "Recently heard" }).click();
      const history = await historyOpening;
      await expect(history.getByRole("region", { name: "Recently heard" })).toContainText(words);
    } finally { await speaker.exit(); }
  });
});

test("moving a selected confirmation keeps its pending Cancel and the other message separate", async ({ daemon, dashboard: page }) => {
  await desktopWith(page, daemon, "floating-windows");
  const opening = page.waitForEvent("popup");
  await page.getByRole("radio", { name: /Floating pill/ }).check();
  const pill = await opening;
  for (const id of ["older", "newer"]) {
    await say(daemon, "Steve, inspect the " + id + " build", { id });
    await expect(pill.getByRole("status")).toContainText(id);
  }
  await pill.getByRole("combobox", { name: "Voice message" }).selectOption("older");
  const response = Promise.withResolvers<void>();
  await page.route("**/cards/older/cancel", async route => {
    await response.promise;
    await route.fulfill({ status: 503, json: { ok: false, error: "Try this cancellation again." } });
  }, { times: 1 });
  const move = page.waitForEvent("popup");
  let popover: Page;
  try {
    await pill.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(pill.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.getByRole("radio", { name: /Tray popover/ }).check();
    popover = await move;
    await expect(popover.getByRole("combobox", { name: "Voice message" })).toHaveValue("older", { timeout: 3000 });
    await expect(popover.getByRole("status")).toContainText("inspect the older build");
    // A slow move can reach the normal two-second retry prompt before the new window paints.
    await expect.poll(async () => await popover.getByRole("button", { name: "Cancel", exact: true }).isDisabled()
      || await popover.getByText(/Still waiting for the daemon/).isVisible()).toBe(true);
  } finally { response.resolve(); }
  await expect(popover.getByRole("status")).toContainText("Try this cancellation again.");
  const cancelled = page.waitForResponse(r => r.url().endsWith("/cards/older/cancel"));
  await popover.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await cancelled).ok()).toBe(true);
  await expect(popover.getByRole("status")).toContainText("inspect the newer build");
});

test("reloading the floating pill restores the pending confirmation and its Cancel action", async ({ daemon, dashboard: page }) => {
  await desktopWith(page, daemon, "floating-windows");
  const opening = page.waitForEvent("popup");
  await page.getByRole("radio", { name: /Floating pill/ }).check();
  const pill = await opening;
  await say(daemon, "Steve, check the build");
  const card = pill.getByRole("status");
  await expect(card).toContainText("check the build");

  await pill.reload();
  await expect(card).toContainText("check the build");
  await expect(page.locator(".voice-card")).toHaveCount(0);
  await captureCard(card, "reloaded-confirmation");
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card).toContainText("Cancelled");
});

test("a closed selected popover reopens for a tray request and for the next confirmation", async ({ daemon, dashboard: page }) => {
  await desktopWith(page, daemon, "both");
  const opening = page.waitForEvent("popup");
  await page.getByRole("radio", { name: /Tray popover/ }).check();
  const first = await opening;
  await say(daemon, "Steve, check the first build");
  await expect(first.getByRole("status")).toContainText("check the first build");
  await first.close();
  await expect(page.locator(".voice-card-stack")).toContainText("check the first build");
  const trayRequest = () => page.evaluate(() => window.dispatchEvent(new Event("fixture:recently-heard")));
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = page.waitForEvent("popup", { timeout: 7000 });
    await trayRequest();
    const history = await reopened;
    await expect(history.getByRole("region", { name: "Recently heard" })).toContainText("check the first build");
    await history.close();
    await expect(page.locator(".voice-card-stack")).toContainText("check the first build");
  }
  const next = page.waitForEvent("popup", { timeout: 7000 });
  await say(daemon, "Steve, check the next build");
  const confirmation = await next;
  await expect(confirmation.getByRole("status")).toContainText("check the next build");
  await expect(confirmation.getByRole("region", { name: "Recently heard" })).toHaveCount(0);
  await expect(page.locator(".voice-card")).toHaveCount(0);
});

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
  // Escape closes this history-only window on keydown, sometimes before Playwright can send keyup.
  expect(popover.isClosed()).toBe(false);
  await popover.keyboard.press("Escape").catch(error => {
    if (!popover.isClosed() || !String(error).includes("Target page, context or browser has been closed")) throw error;
  });
  await expect.poll(() => popover.isClosed()).toBe(true);
  await toast.getByRole("button", { name: "Cancel" }).click();
  await expect(toast).toContainText("Cancelled");
});
