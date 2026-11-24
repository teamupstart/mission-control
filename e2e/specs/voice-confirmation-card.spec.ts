import { expect, test } from "../fixtures/test.ts";
import { allowStreamDisconnect, captureCard, expectCardGeometry, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
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
    if (method === "click") {
      const cancel = pending.getByRole("button", { name: "Cancel", exact: true });
      await cancel.focus();
      await page.keyboard.press("Tab");
      await expect(pending.getByRole("button", { name: "Send now" })).toBeFocused({ timeout: 1000 });
      await page.keyboard.press("Shift+Tab");
      await expect(cancel).toBeFocused();
      await cancel.press("Enter");
    }
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

for (const connection of ["first", "reconnected"] as const) {
  test(`a delayed ${connection} snapshot cannot extend the daemon cancel window`, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon, 7);
    await runningAgent(page, daemon, "Steve");
    await say(daemon, "Steve, check the snapshot");
    await page.addInitScript(connection => {
      const Native = window.EventSource;
      window.EventSource = class extends Native {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          this.addEventListener("message", event => {
            if (!event.isTrusted) return;
            const frame = JSON.parse(event.data);
            if (frame.type === "voice_card") event.stopImmediatePropagation();
            if (frame.type !== "snapshot") return;
            if (connection === "first") event.stopImmediatePropagation();
            // Buffer the daemon's exact snapshot. For a reconnect, replay it after
            // the dashboard already knows this card's original cancel window.
            setTimeout(() => {
              this.dispatchEvent(new MessageEvent("message", { data: event.data }));
              document.documentElement.dataset.snapshotReleased = "true";
            }, 2200);
          });
        }
      };
    }, connection);
    await page.reload();
    const card = page.getByRole("status").filter({ hasText: "check the snapshot" });
    await expect(page.locator("html")).toHaveAttribute("data-snapshot-released", "true");
    await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect.poll(() => withDaemonDb(daemon, db => db.prepare(
      "SELECT count(*) AS n FROM session_spoken_turns WHERE spoken_words = ?",
    ).get("check the snapshot")?.n), { timeout: 8000, intervals: [50] }).toBe(1);
    await expect(card.getByRole("button", { name: "Cancel" })).toHaveCount(0, { timeout: 600 });
    await expect(card).toContainText("Awaiting delivery confirmation");
  });
}

test("leaving a focused dashboard during the countdown shows the desktop notice and applies its action", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const config = (await (await page.request.get(daemon.baseURL + "/api/ui/config")).json()).config;
  expect((await page.request.put(daemon.baseURL + "/api/ui/config", { data: {
    alerts: { ...config.alerts, notifications: true, sound: false },
  } })).ok()).toBe(true);
  await page.addInitScript(() => {
    document.hasFocus = () => document.documentElement?.dataset.fixtureBlurred !== "true";
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    let declineFirst = true;
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true,
      onOpenSettings: () => () => {},
      showVoiceCardNotice: ({ title, body, scope, deadline }: { title: string; body: string; scope: string; deadline: number }) => {
        if (declineFirst) {
          declineFirst = false;
          document.documentElement.dataset.fixtureBlurred = "false";
          window.dispatchEvent(new Event("focus"));
          document.documentElement.dataset.declinedNotice = "true";
          return Promise.resolve("window-focused");
        }
        document.title = title + " | " + body;
        document.documentElement.dataset.noticeScope = scope;
        document.documentElement.dataset.noticeRemaining = String(deadline - Date.now());
        document.documentElement.dataset.noticeCount = String(Number(document.documentElement.dataset.noticeCount ?? 0) + 1);
        return new Promise(resolve => window.addEventListener("fixture-native-action", event => resolve((event as CustomEvent).detail), { once: true }));
      },
      dismissVoiceCardNotice() {},
    } });
  });
  await page.clock.install({ time: new Date(Date.now() + 60_000) });
  await page.reload();
  await runningAgent(page, daemon, "Steve");
  for (const choice of ["cancel", "send-now"]) {
    const id = "native-" + choice;
    const words = "inspect " + id;
    await say(daemon, "Steve, " + words, { id });
    if (choice === "cancel") {
      await expect(page.getByRole("status").filter({ hasText: words })).toBeVisible();
      await expect(page.locator("html")).not.toHaveAttribute("data-notice-count", /.+/);
      await page.clock.fastForward(4000);
      await page.evaluate(() => {
        document.documentElement.dataset.fixtureBlurred = "true";
        window.dispatchEvent(new Event("blur"));
      });
      await expect(page.locator("html")).toHaveAttribute("data-declined-notice", "true");
      await expect(page.locator("html")).not.toHaveAttribute("data-notice-count", /.+/);
      await page.evaluate(() => {
        document.documentElement.dataset.fixtureBlurred = "true";
        window.dispatchEvent(new Event("blur"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect(page.locator("html")).toHaveAttribute("data-notice-count", "1", { timeout: 3000 });
      expect(Number((await page.title()).match(/sending in (\d+)s/)?.[1])).toBeLessThanOrEqual(26);
      const remaining = Number(await page.locator("html").getAttribute("data-notice-remaining"));
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(26000);
    }
    await expect(page).toHaveTitle(new RegExp("To Steve · sending in \\d+s \\| " + words));
    const action = page.waitForResponse(response => response.url().endsWith("/cards/" + id + "/" + choice));
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent("fixture-native-action", { detail })), choice);
    expect((await action).ok()).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: choice === "cancel" ? "Cancelled" : "Sent to Steve" })).toBeVisible();
  }
  await say(daemon, "Steve, keep this pending", { id: "native-retry" });
  await expect(page).toHaveTitle(/To Steve · sending in \d+s \| keep this pending/);
  await page.route("**/cards/native-retry/cancel", route => route.fulfill({
    status: 503, json: { error: "The daemon could not confirm the request" },
  }), { times: 1 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-native-action", { detail: "cancel" })));
  const retry = page.getByRole("status").filter({ hasText: "keep this pending" });
  await expect(retry).toContainText("Desktop Cancel was not confirmed", { timeout: 3000 });
  await expect(retry).toContainText("The daemon could not confirm the request");
  await captureCard(retry, "native-cancel-unconfirmed");
  const retried = page.waitForResponse(response => response.url().endsWith("/cards/native-retry/cancel"));
  await retry.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await retried).ok()).toBe(true);
  await expect(retry).toHaveCount(0);
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
  await allowStreamDisconnect(page);
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
