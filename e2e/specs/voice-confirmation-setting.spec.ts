import { expect, test } from "../fixtures/test.ts";
import { enableVoice, say, voiceToken } from "../fixtures/voice.ts";
import { allowStreamDisconnect, captureCard, setupCards } from "../fixtures/voice-cards.ts";

test("three placement previews persist across reload, with a toast fallback and reserved card-only routes", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const choices = page.getByRole("group", { name: "Confirmation card" });
  await expect(choices.getByRole("radio")).toHaveCount(3);
  await expect(choices.getByText("Needs the desktop app")).toHaveCount(2);
  for (const placement of ["Corner toast", "Tray popover", "Floating pill"]) {
    const radio = choices.getByRole("radio", { name: new RegExp(placement) });
    await expect(radio).toHaveAccessibleDescription(`Save ${placement} as your preferred confirmation card placement`);
    await radio.click();
    await expect(radio).toBeEnabled();
    await expect(radio).toBeChecked();
    await page.reload();
    await expect(radio).toBeChecked();
  }
  await captureCard(choices, "placements");
  await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
    identity: { name: "Steve", description: "Builds and releases" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } });
  await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: true, seconds: 30 } } });
  await say(daemon, "Steve, check the build");
  await expect(page.getByRole("status").filter({ hasText: "To Steve" })).toBeVisible();
  await page.goto(daemon.baseURL + "/#/voice/pill");
  await expect(page.getByRole("status").filter({ hasText: "To Steve" })).toBeVisible();
  await expect(page.locator(".app")).toHaveCount(0);
  await page.goto(daemon.baseURL + "/#/voice/popover");
  await expect(page.locator(".voice-standalone")).toHaveCount(1);
  await expect(page.locator(".app")).toHaveCount(0);
});

for (const [placement, label] of [["pill", "Floating pill"], ["popover", "Tray popover"]] as const) {
  test(`the ${label} route switches at the displayed deadline while disconnected`, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon);
    await allowStreamDisconnect(page);
    expect((await page.request.put(daemon.baseURL + "/api/voice/confirmation", { data: { confirmation: placement } })).ok()).toBe(true);
    expect((await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
      identity: { name: "Steve", description: "Builds and releases" }, persona: { personaId: "builtin:code-risk-reviewer" },
    } } })).ok()).toBe(true);
    await page.goto("about:blank");
    await page.goto(daemon.baseURL + "/#/voice/" + placement);
    const card = page.getByRole("status");
    await say(daemon, "Steve, inspect the long window", { id: "long-window" });
    await expect(card).toContainText("inspect the long window");
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 500));
    expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: true, seconds: 3 } } })).ok()).toBe(true);
    await say(daemon, "Steve, inspect the short window");
    await expect(card).toContainText("inspect the short window");
    await page.evaluate(() => window.dispatchEvent(new Event("disconnect-fixture-stream")));
    // Advance only one countdown tick past the short deadline, before unrelated dashboard polling.
    await page.clock.setSystemTime(new Date(Date.now() + 5000));
    await page.clock.runFor(101);
    await expect(card).toContainText("inspect the long window", { timeout: 1500 });
    const cancelled = page.waitForResponse(response => response.url().endsWith("/cards/long-window/cancel"));
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await cancelled).ok()).toBe(true);
  });

  test(`the ${label} route immediately restores an older cancel window ahead of a newer outcome`, async ({ dashboard: page, daemon }) => {
    await enableVoice(daemon);
    expect((await page.request.put(daemon.baseURL + "/api/voice/confirmation", { data: { confirmation: placement } })).ok()).toBe(true);
    expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: true, seconds: 7 } } })).ok()).toBe(true);
    expect((await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
      identity: { name: "Steve", description: "Builds and releases" }, persona: { personaId: "builtin:code-risk-reviewer" },
    } } })).ok()).toBe(true);
    await page.goto(daemon.baseURL + "/#/voice/" + placement);
    const card = page.getByRole("status");
    await say(daemon, "Steve, inspect the older message", { id: "older" });
    await expect(card).toContainText("inspect the older message");
    await say(daemon, "Steve, inspect the newer message");
    await expect(card).toContainText("inspect the newer message");
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card).toContainText("inspect the older message", { timeout: 2000 });
    await page.mouse.move(640, 400);
    await captureCard(card, "priority-older-" + placement);
    const cancelled = page.waitForResponse(response => response.url().endsWith("/cards/older/cancel"));
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await cancelled).ok()).toBe(true);
    await expect(card).toContainText("Cancelled");
  });

  test(`a floating-window report keeps the ${label} preference actionable on the dashboard`, async ({ dashboard: page, daemon }) => {
    await enableVoice(daemon);
    await page.goto(daemon.baseURL + "/#/settings/voice");
    const choices = page.getByRole("group", { name: "Confirmation card" });
    const radio = choices.getByRole("radio", { name: new RegExp(label) });
    await radio.check();
    await expect(radio).toBeChecked();
    const resident = await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
      identity: { name: "Steve", description: "Builds and releases" }, persona: { personaId: "builtin:code-risk-reviewer" },
    } } });
    expect(resident.ok(), await resident.text()).toBe(true);
    expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: true, seconds: 30 } } })).ok()).toBe(true);
    await expect(choices.getByText("Needs the desktop app")).toHaveCount(2);
    const report = await page.request.post(daemon.baseURL + "/voice/shell-report", {
      headers: { "x-harness-token": voiceToken(daemon) }, data: { capabilities: { "floating-windows": { available: true } } },
    });
    expect(report.ok(), await report.text()).toBe(true);
    await expect(choices.getByText("Needs the desktop app")).toHaveCount(0);
    await choices.scrollIntoViewIfNeeded();
    await say(daemon, "Steve, check the build");
    const card = page.getByRole("status").filter({ hasText: "To Steve" });
    await expect(card).toContainText("check the build", { timeout: 7000 });
    await expect(card.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await expect(radio).toBeChecked();
    await expect(choices.getByText("Needs the desktop app")).toHaveCount(0);
    await captureCard(page, "desktop-fallback-" + placement);
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
    await expect(page).toHaveURL(daemon.baseURL + "/#/settings/voice");
  });
}

test("disabled voice links open Fleet and disabling voice closes an active standalone route", async ({ dashboard: page, daemon }) => {
  const fleet = page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Fleet" });
  for (const placement of ["pill", "popover"]) {
    const url = daemon.baseURL + "/#/voice/" + placement;
    await page.goto("about:blank");
    await page.goto(url);
    await expect(page).toHaveURL(daemon.baseURL + "/#/fleet");
    await expect(fleet).toBeVisible();
    await expect(page.locator(".voice-standalone")).toHaveCount(0);
    await enableVoice(daemon);
    await page.goto("about:blank");
    await page.goto(url);
    await expect(page.locator(".voice-standalone")).toHaveCount(1);
    const disabled = await page.request.put(daemon.baseURL + "/api/feature-flags", { data: { kind: "flag", id: "voice", enabled: false } });
    expect(disabled.ok(), await disabled.text()).toBe(true);
    await expect(page).toHaveURL(daemon.baseURL + "/#/fleet");
    await expect(fleet).toBeVisible();
    await expect(page.locator(".voice-standalone")).toHaveCount(0);
  }
  await captureCard(page, "disabled-route-fleet");
});
