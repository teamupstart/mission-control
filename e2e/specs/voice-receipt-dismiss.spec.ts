import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { captureCard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { say } from "../fixtures/voice.ts";

/** Deliver at once, so each utterance settles straight into a Sent receipt. */
async function immediateDelivery(page: Page, daemon: DaemonHandle) {
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: false } } })).ok()).toBe(true);
}

const receipt = (page: Page, name: string) => page.getByRole("status").filter({ hasText: "Sent to " + name });

test("clicking a stacked Sent receipt dismisses only that card and the rest keep their own timers", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  for (const name of ["Steve", "Will"]) await runningAgent(page, daemon, name);
  await immediateDelivery(page, daemon);

  await say(daemon, "Steve, check the build");
  const steve = receipt(page, "Steve");
  await expect(steve).toBeVisible();
  const steveArrived = Date.now();
  await page.waitForTimeout(2500);
  await say(daemon, "Will, run the release checklist");
  const will = receipt(page, "Will");
  await expect(will).toBeVisible();
  await expect(page.locator(".voice-card")).toHaveCount(2);
  await page.mouse.move(0, 0);
  await captureCard(page.locator(".voice-card-stack"), "dismiss-stack-before");

  // The newest receipt sits at the bottom of the corner stack. Steve's moves into its place.
  const dismiss = will.getByRole("button", { name: "Dismiss: Sent to Will" });
  await expect(dismiss).toHaveAccessibleDescription("Dismiss this confirmation");
  const willBox = (await will.boundingBox())!;
  const steveBox = (await steve.boundingBox())!;
  expect(steveBox.y).toBeLessThan(willBox.y);
  await will.click({ position: { x: 24, y: willBox.height / 2 } });
  await expect(will).toHaveCount(0);
  await expect(steve).toBeVisible();
  await expect.poll(async () => Math.round((await steve.boundingBox())!.y + (await steve.boundingBox())!.height))
    .toBe(Math.round(willBox.y + willBox.height));
  await page.mouse.move(0, 0);
  await captureCard(page.locator(".voice-card-stack"), "dismiss-stack-after");

  // Steve's eight-second reading interval started when it arrived, not when Will left.
  const restartedExpiry = Date.now() + 8000;
  await expect(steve).toHaveCount(0, { timeout: Math.max(1, steveArrived + 9500 - Date.now()) });
  expect(Date.now()).toBeLessThan(restartedExpiry);
});

test("the Dismiss button closes a receipt from the keyboard with Return or Space", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  await immediateDelivery(page, daemon);
  for (const key of ["Enter", " "]) {
    await say(daemon, "Steve, check the build");
    const card = receipt(page, "Steve");
    const dismiss = card.getByRole("button", { name: "Dismiss: Sent to Steve" });
    await page.locator("body").focus();
    // The receipt is reachable in the ordinary Tab order.
    for (let i = 0; i < 400 && !(await dismiss.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(dismiss).toBeFocused();
    // A focused receipt is in use, so it outlasts its reading interval until the key press.
    await page.waitForTimeout(8500);
    await expect(card).toBeVisible();
    await page.keyboard.press(key === " " ? "Space" : key);
    await expect(card).toHaveCount(0);
  }
});

test("a pending countdown and a cancelled card ignore a body click and offer no Dismiss", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  const words = "check the build and report back";
  await say(daemon, "Steve, " + words);
  const card = page.getByRole("status").filter({ hasText: words });
  await expect(card.getByRole("button", { name: "Send now" })).toBeVisible();
  await expect(card.getByRole("button", { name: /^Dismiss/ })).toHaveCount(0);
  await card.getByText(words).click();
  await expect(card.getByRole("button", { name: "Send now" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await card.getByRole("button", { name: "Cancel" }).click();
  const cancelled = page.getByRole("status").filter({ hasText: "Cancelled" });
  await expect(cancelled).toBeVisible();
  await expect(cancelled.getByRole("button", { name: /^Dismiss/ })).toHaveCount(0);
  await cancelled.click();
  await expect(cancelled).toBeVisible();
});

for (const surface of ["pill", "popover"] as const) {
  test(`the ${surface} dismisses the clicked Sent receipt and shows the next one`, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon);
    for (const name of ["Steve", "Will"]) await runningAgent(page, daemon, name);
    await page.goto(daemon.baseURL + "/#/voice/" + surface);
    // A countdown, then Send now, reaches the receipt through the surface's own controls.
    await say(daemon, "Steve, check the build");
    const pending = page.getByRole("status").filter({ hasText: "check the build" });
    await pending.getByRole("button", { name: "Send now" }).click();
    const steve = receipt(page, "Steve");
    await expect(steve).toBeVisible();
    await immediateDelivery(page, daemon);
    await say(daemon, "Will, run the release checklist");
    const will = receipt(page, "Will");
    await expect(will).toBeVisible();
    // The surface shows the newest receipt and a selector for the other one.
    await expect(steve).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Voice message" })).toBeVisible();
    await page.mouse.move(0, 400);
    await captureCard(page.locator(".voice-standalone"), "dismiss-" + surface + "-before");
    await will.click();
    await expect(will).toHaveCount(0);
    await expect(steve).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Voice message" })).toHaveCount(0);
    await page.mouse.move(0, 400);
    await captureCard(page.locator(".voice-standalone"), "dismiss-" + surface + "-after");
    await steve.getByRole("button", { name: "Dismiss: Sent to Steve" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveCount(0);
  });
}
