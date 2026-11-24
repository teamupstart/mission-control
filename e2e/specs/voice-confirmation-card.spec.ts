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

test("an unfocused desktop repeats the words and applies Cancel or Send now to the same card", async ({ dashboard: page, daemon }) => {
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
      showVoiceCardNotice: ({ title, body, scope }: { title: string; body: string; scope: string }) => {
        document.title = title + " | " + body;
        document.documentElement.dataset.noticeScope = scope;
        return new Promise(resolve => window.addEventListener("fixture-native-action", event => resolve((event as CustomEvent).detail), { once: true }));
      },
      dismissVoiceCardNotice() {},
    } });
  });
  await page.reload();
  await runningAgent(page, daemon, "Steve");
  for (const choice of ["cancel", "send-now"]) {
    const id = "native-" + choice;
    const words = "inspect " + id;
    await say(daemon, "Steve, " + words, { id });
    await expect(page).toHaveTitle(new RegExp("To Steve · sending in \\d+s \\| " + words));
    const action = page.waitForResponse(response => response.url().endsWith("/cards/" + id + "/" + choice));
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent("fixture-native-action", { detail })), choice);
    expect((await action).ok()).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: choice === "cancel" ? "Cancelled" : "Sent to Steve" })).toBeVisible();
  }
  await runningAgent(page, daemon, "Will");
  await say(daemon, "Steve, inspect the build, and Will, stop", { id: "native-split" });
  await page.getByRole("status").filter({ hasText: "Who is this for?" }).getByRole("button", { name: /Will/ }).click();
  await expect(page).toHaveTitle(/To Steve · sending in \d+s \| inspect the build Stop requested for Will separately\./, { timeout: 3000 });
  await expect(page.locator("html")).toHaveAttribute("data-notice-scope", "remaining");
  const pendingSplit = page.getByRole("status").filter({ hasText: "Two messages" });
  await expect(pendingSplit).toContainText("stop sent");
  await captureCard(pendingSplit, "pending-split-stop-sent");
  const cancelled = page.waitForResponse(response => response.url().endsWith("/cards/native-split/cancel"));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-native-action", { detail: "cancel" })));
  expect((await cancelled).ok()).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Steve · Cancelled" })).toContainText("Stop sent to Will");
  expect(withDaemonDb(daemon, db => db.prepare("SELECT spoken_words FROM session_spoken_turns").all().map(r => r.spoken_words))).toEqual(["inspect native-send-now"]);
});

test("a browser notice closes at the deadline even if the stream disconnects", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 5);
  const config = (await (await page.request.get(daemon.baseURL + "/api/ui/config")).json()).config;
  expect((await page.request.put(daemon.baseURL + "/api/ui/config", { data: {
    alerts: { ...config.alerts, notifications: true, sound: false },
  } })).ok()).toBe(true);
  await page.addInitScript(() => {
    document.hasFocus = () => false;
    const closed: string[] = [];
    Object.defineProperty(window, "Notification", { value: class {
      static permission = "granted";
      constructor(_title: string, readonly options: NotificationOptions) {
        document.documentElement.dataset.openNotice = options.tag;
      }
      close() {
        closed.push(this.options.tag!);
        document.documentElement.dataset.closedNotices = closed.join(",");
      }
    } });
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        window.addEventListener("disconnect-fixture-stream", () => this.close(), { once: true });
      }
    };
  });
  await page.reload();
  await runningAgent(page, daemon, "Steve");
  const notices = page.locator("html");
  await say(daemon, "Steve, drop this", { id: "early-close" });
  await expect(notices).toHaveAttribute("data-open-notice", "voice-early-close");
  await page.getByRole("status").filter({ hasText: "drop this" }).getByRole("button", { name: "Cancel" }).click();
  await expect(notices).toHaveAttribute("data-closed-notices", "voice-early-close");
  await say(daemon, "Steve, deliver this", { id: "disconnected" });
  await expect(notices).toHaveAttribute("data-open-notice", "voice-disconnected");
  await page.evaluate(() => window.dispatchEvent(new Event("disconnect-fixture-stream")));
  await expect.poll(() => withDaemonDb(daemon, db => db.prepare("SELECT spoken_words FROM session_spoken_turns").all().map(r => r.spoken_words))).toEqual(["deliver this"]);
  await expect(notices).toHaveAttribute("data-closed-notices", "voice-early-close,voice-disconnected", { timeout: 2000 });
  const card = page.getByRole("status").filter({ hasText: "deliver this" });
  await expect(card).toContainText("Awaiting delivery confirmation", { timeout: 2000 });
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card).not.toContainText("0s");
  await captureCard(card, "awaiting-delivery-confirmation");
});
