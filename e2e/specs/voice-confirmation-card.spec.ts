import { expect, test } from "../fixtures/test.ts";
import { captureCard, expectCardGeometry, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { say } from "../fixtures/voice.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

test("countdown sends once, click and spoken cancel stop delivery, and disabling the window sends immediately", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 4);
  const steve = await runningAgent(page, daemon, "Steve");
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: steve.name }).first().click();
  const pending = page.getByRole("status").filter({ hasText: "To Steve" }).filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) });
  await say(daemon, "Steve, check the build");
  await expect(pending).toContainText("check the build");
  await expect(pending).toHaveCSS("width", "300px");
  await expect(pending).toContainText("3s");
  await captureCard(page, "pending");
  await expectCardGeometry(pending, "confirmation-card", "#a .cc-card");
  const sent = page.getByRole("status").filter({ hasText: "Sent to Steve" });
  await expect(sent).toBeVisible();
  await captureCard(sent, "sent");
  await expect(page.getByText(/Mock reply to: check the build/).first()).toBeVisible();
  for (const method of ["click", "speech"]) {
    await say(daemon, "Steve, cancelled by " + method);
    await expect(pending).toBeVisible();
    if (method === "click") await pending.getByRole("button", { name: "Cancel", exact: true }).click();
    else await say(daemon, "cancel");
    await expect(pending).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Cancelled" }).last()).toBeVisible();
  }
  await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: false } } });
  await say(daemon, "Steve, immediate delivery");
  await expect(page.getByText(/Mock reply to: immediate delivery/).first()).toBeVisible();
  await expect(pending).toHaveCount(0);
  expect(withDaemonDb(daemon, db => db.prepare("SELECT spoken_words FROM session_spoken_turns ORDER BY rowid").all().map(r => r.spoken_words))).toEqual(["check the build", "immediate delivery"]);
});

test("an unfocused desktop repeats the pending words and its Cancel action stops the same card", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const config = (await (await page.request.get(daemon.baseURL + "/api/ui/config")).json()).config;
  expect((await page.request.put(daemon.baseURL + "/api/ui/config", { data: {
    alerts: { ...config.alerts, notifications: true, sound: false },
  } })).ok()).toBe(true);
  await page.addInitScript(() => {
    document.hasFocus = () => false;
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true,
      onOpenSettings: () => () => {},
      showVoiceCardNotice: ({ title, body }: { title: string; body: string }) => {
        document.title = title + " | " + body;
        return new Promise(resolve => window.addEventListener("fixture-native-cancel", () => resolve("cancel"), { once: true }));
      },
      dismissVoiceCardNotice() {},
    } });
  });
  await page.reload();
  await runningAgent(page, daemon, "Steve");
  await say(daemon, "Steve, inspect CI", { id: "native-notice" });
  await expect(page).toHaveTitle(/To Steve · sending in \d+s \| inspect CI/);
  const action = page.waitForResponse(response => response.url().endsWith("/cards/native-notice/cancel"));
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-native-cancel")));
  expect((await action).ok()).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
});
