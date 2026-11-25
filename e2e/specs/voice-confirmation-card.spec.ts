import { forward } from "../fixtures/port-forward.ts";
import { expect, test } from "../fixtures/test.ts";
import { allowStreamDisconnect, captureCard, expectCardGeometry, readTranscriptWithKeyboard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { say } from "../fixtures/voice.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

test("countdown sends once, click and spoken cancel stop delivery, and disabling the window sends immediately", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 10);
  const steve = await runningAgent(page, daemon, "Steve");
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: steve.name }).first().click();
  const pending = page.getByRole("status").filter({ hasText: "To Steve" }).filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) });
  await say(daemon, "Steve, check the build");
  await expect(pending).toContainText("check the build");
  await expect(pending).toHaveCSS("width", "300px");
  await expect(pending.locator(".vc-seconds")).toHaveText(/\d+s/);
  await captureCard(page, "pending");
  await expectCardGeometry(pending, "confirmation-card", "#a .cc-card");
  const sent = page.getByRole("status").filter({ hasText: "Sent to Steve" });
  await expect(sent).toBeVisible({ timeout: 15_000 });
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
  const changed = await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: false } } });
  expect(changed.ok()).toBe(true);
  expect((await changed.json()).config.cancelWindow.enabled).toBe(false);
  const immediate = await say(daemon, "Steve, immediate delivery");
  expect((await immediate.json()).accepted).toBe(true);
  await expect(pending).toHaveCount(0);
  await expect(page.getByText(/Mock reply to: immediate delivery/).first()).toBeVisible();
  await expect(pending).toHaveCount(0);
  expect(withDaemonDb(daemon, db => db.prepare("SELECT spoken_words FROM session_spoken_turns ORDER BY rowid").all().map(r => r.spoken_words))).toEqual(["check the build", "immediate delivery"]);
});

test("the accessible countdown announces its initial duration without repeating the visual ticks", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 8);
  await runningAgent(page, daemon, "Steve");
  await say(daemon, "Steve, read the timer");
  const card = page.getByRole("status").filter({ hasText: "read the timer" });
  const seconds = card.locator(".vc-seconds");
  await expect(seconds).toBeVisible();
  const initial = await seconds.innerText();
  const announcement = await card.ariaSnapshot();
  expect(announcement).toMatch(/opened with (up to )?\d+ seconds? to cancel or send now/i);
  expect(announcement).not.toMatch(/\b\d+s\b/);
  await expect(seconds).not.toHaveText(initial);
  expect(await card.ariaSnapshot()).toBe(announcement);
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
});

test("a long transcript scrolls while the recipient and countdown controls stay in view", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  await page.setViewportSize({ width: 560, height: 420 });
  const words = "Review the changes to the build. ".repeat(64) + "Start with the final change.";
  await say(daemon, "Steve, " + words);
  const card = page.getByRole("status").filter({ hasText: "To Steve" });
  const recipient = card.getByText("To Steve", { exact: true });
  const seconds = card.locator(".vc-seconds");
  const cancel = card.getByRole("button", { name: "Cancel", exact: true });
  const send = card.getByRole("button", { name: "Send now" });
  const transcript = card.getByText(words, { exact: true });
  for (const control of [recipient, seconds, cancel, send]) await expect(control).toBeInViewport({ ratio: 1 });
  expect(await transcript.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await transcript.hover();
  await page.mouse.wheel(0, 40);
  await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.mouse.move(0, 0);
  await readTranscriptWithKeyboard(transcript, cancel, "Shift+Tab");
  for (const control of [recipient, seconds, cancel, send]) await expect(control).toBeInViewport({ ratio: 1 });
  await captureCard(card, "long-transcript-controls");
  await cancel.click();
  await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
});

test("a stalled card action reports the unconfirmed request and permits a retry", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 8);
  await runningAgent(page, daemon, "Steve");
  for (const [action, label, outcome] of [["cancel", "Cancel", "Cancelled"], ["send-now", "Send now", "Sent to Steve"]]) {
    const id = "stalled-" + action;
    await say(daemon, "Steve, check " + id, { id });
    const card = page.getByRole("status").filter({ hasText: id });
    const button = card.getByRole("button", { name: label, exact: true });
    await page.route("**/api/voice/cards/" + id + "/" + action, () => {}, { times: 1 });
    await button.click();
    await expect(button).toBeDisabled();
    await expect(card).toContainText(label + " was not confirmed", { timeout: 4000 });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByRole("status").filter({ hasText: outcome })).toBeVisible();
  }
  expect(withDaemonDb(daemon, db => db.prepare("SELECT spoken_words FROM session_spoken_turns ORDER BY rowid").all()
    .map(row => row.spoken_words))).toEqual(["check stalled-send-now"]);
});

test("an in-transit Cancel can reach the daemon after the retry control returns", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 8);
  await runningAgent(page, daemon, "Steve");
  const release = Promise.withResolvers<void>();
  await page.route("**/api/voice/cards/in-transit/cancel", async route => {
    await release.promise;
    await route.continue();
  });
  await say(daemon, "Steve, wait for my request", { id: "in-transit" });
  const card = page.getByRole("status").filter({ hasText: "wait for my request" });
  const cancel = card.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeVisible();
  await page.waitForTimeout(3900);
  await cancel.click();
  try {
    await expect(card).toContainText("Cancel was not confirmed", { timeout: 2700 });
    await expect(cancel).toBeEnabled();
  } finally {
    release.resolve();
  }
  await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible({ timeout: 3000 });
  expect(withDaemonDb(daemon, db => db.prepare("SELECT count(*) AS n FROM session_spoken_turns").get()?.n)).toBe(0);
});

test("an expired pending frame stays silent while a live cancel window chimes", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 3);
  expect((await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
    identity: { name: "Steve", description: "Reviews builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } })).ok()).toBe(true);
  const { config } = await (await page.request.get(daemon.baseURL + "/api/ui/config")).json();
  expect((await page.request.put(daemon.baseURL + "/api/ui/config", { data: { alerts: { ...config.alerts, sound: true } } })).ok()).toBe(true);
  await page.addInitScript(() => {
    Object.defineProperty(AudioContext.prototype, "state", { get: () => "running" });
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function(time) {
      if (this.frequency.value === 660) document.documentElement.dataset.infoChimes = String(Number(document.documentElement.dataset.infoChimes ?? 0) + 1);
      return start.call(this, time);
    };
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        let offsetUpper = 0;
        this.addEventListener("message", event => {
          if (!event.isTrusted) return;
          const frame = JSON.parse(event.data);
          if (frame.type === "snapshot") {
            offsetUpper = performance.now() - frame.voiceServerTime + 1;
            document.documentElement.dataset.chimeClockReady = "true";
          }
          if (frame.type !== "voice_card" || frame.card.id !== "late-chime") return;
          event.stopImmediatePropagation();
          if (frame.card.state === "pending" && frame.card.deadline) {
            document.documentElement.dataset.latestChimeDeadline = String(frame.card.deadline + offsetUpper);
            window.addEventListener("release-pending-chime", () => this.dispatchEvent(new MessageEvent("message", { data: event.data })), { once: true });
          }
          if (frame.card.state === "not-running") document.documentElement.dataset.staleOutcome = "received";
        });
      }
    };
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-chime-clock-ready", "true");
  await say(daemon, "Steve, deliver before the buffered frame", { id: "late-chime" });
  await expect(page.locator("html")).toHaveAttribute("data-stale-outcome", "received", { timeout: 8000 });
  await expect(page.locator("html")).toHaveAttribute("data-latest-chime-deadline", /^\d/, { timeout: 3000 });
  await page.waitForFunction(() => performance.now() > Number(document.documentElement.dataset.latestChimeDeadline) + 100, undefined, { timeout: 5000 });
  await page.evaluate(() => window.dispatchEvent(new Event("release-pending-chime")));
  const late = page.getByRole("status").filter({ hasText: "deliver before the buffered frame" });
  await expect(late).toContainText("Awaiting delivery confirmation");
  await expect(page.locator("html")).not.toHaveAttribute("data-info-chimes", /[1-9]/);
  await captureCard(late, "expired-frame-awaiting-without-chime");
  await say(daemon, "Steve, open a live cancel window");
  const live = page.getByRole("status").filter({ hasText: "open a live cancel window" });
  await expect(page.locator("html")).toHaveAttribute("data-info-chimes", "1");
  await live.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("a directly addressed stop reports the stop receipt without a message countdown", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  await say(daemon, "Steve, stop", { id: "direct-stop" });
  const receipt = page.getByRole("status").filter({ hasText: "Stop sent to Steve" });
  await expect(receipt).toBeVisible({ timeout: 3000 });
  await expect(receipt.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await captureCard(receipt, "direct-stop-receipt");
  await say(daemon, "Steve, stop after the build");
  const pending = page.getByRole("status").filter({ hasText: "stop after the build" });
  await pending.getByRole("button", { name: "Send now" }).click();
  await expect(page.getByRole("status").getByText("Sent to Steve", { exact: true })).toBeVisible();
});

test("a buffered frame caps desktop actions and disconnected card controls at one cancel window", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 4);
  await runningAgent(page, daemon, "Steve");
  const config = (await (await page.request.get(daemon.baseURL + "/api/ui/config")).json()).config;
  await page.request.put(daemon.baseURL + "/api/ui/config", { data: { alerts: { ...config.alerts, notifications: true, sound: false } } });
  await page.route("**/api/voice/config", route => route.fulfill({ status: 503 }));
  await page.addInitScript(() => {
    document.hasFocus = () => document.documentElement?.dataset.away !== "true";
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true, onOpenSettings: () => () => {},
      showVoiceCardNotice: ({ title, remainingMs }: { title: string; remainingMs: number }) => {
        document.documentElement.dataset.noticeTitle = title;
        document.documentElement.dataset.noticeBudget = String(remainingMs);
        return Promise.resolve(null);
      },
      dismissVoiceCardNotice() {},
    } });
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        window.addEventListener("disconnect-buffered-stream", () => this.close(), { once: true });
        this.addEventListener("message", event => {
          if (!event.isTrusted) return;
          const frame = JSON.parse(event.data);
          if (frame.type !== "snapshot" || !frame.voiceCards?.length) return;
          // Model a stale stream timestamp with a wide upper bound. The daemon's
          // actual card, cancel deadline and configured window are preserved.
          frame.voiceServerTime -= 2500;
          event.stopImmediatePropagation();
          setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })), 150);
        });
      }
    };
  });
  await say(daemon, "Steve, cap the notice");
  await page.reload();
  const card = page.getByRole("status").filter({ hasText: "cap the notice" });
  await expect(card).toContainText("≤4s");
  await page.evaluate(() => {
    document.documentElement.dataset.away = "true";
    window.dispatchEvent(new Event("blur"));
  });
  await expect(page.locator("html")).toHaveAttribute("data-notice-title", "To Steve · up to 4s to cancel", { timeout: 1000 });
  const budget = Number(await page.locator("html").getAttribute("data-notice-budget"));
  expect(budget).toBeGreaterThan(0);
  expect(budget).toBeLessThanOrEqual(4000);
  await page.evaluate(() => window.dispatchEvent(new Event("disconnect-buffered-stream")));
  await expect(card).toContainText("Awaiting delivery confirmation", { timeout: 4500 });
  await expect(card.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Send now" })).toHaveCount(0);
  await captureCard(card, "awaiting-buffered-receipt");
});

test("a desktop Cancel accepted before clock refinement is applied when its reply arrives", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 20);
  await runningAgent(page, daemon, "Steve");
  const config = (await (await page.request.get(daemon.baseURL + "/api/ui/config")).json()).config;
  await page.request.put(daemon.baseURL + "/api/ui/config", { data: { alerts: { ...config.alerts, notifications: true, sound: false } } });
  await say(daemon, "Steve, wait for the clock", { id: "notice-refined" });
  const calibrate = Promise.withResolvers<void>();
  await page.route("**/api/voice/config", async route => { await calibrate.promise; await route.continue(); });
  await page.addInitScript(() => {
    document.hasFocus = () => false;
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener("message", event => {
          if (!event.isTrusted || JSON.parse(event.data).type !== "snapshot") return;
          event.stopImmediatePropagation();
          setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: event.data })), 1000);
        });
      }
    };
    let firstId: string;
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true, onOpenSettings: () => () => {},
      showVoiceCardNotice: ({ id }: { id: string }) => {
        if (firstId) return Promise.resolve(null);
        firstId = id;
        document.documentElement.dataset.noticeAccepted = "cancel";
        return new Promise(resolve => window.addEventListener("release-native-reply", () => resolve("cancel"), { once: true }));
      },
      dismissVoiceCardNotice: (id: string) => {
        if (id === firstId) document.documentElement.dataset.noticeReplaced = "true";
      },
    } });
  });
  await page.reload();
  try {
    await expect(page.locator("html")).toHaveAttribute("data-notice-accepted", "cancel");
  } finally {
    calibrate.resolve();
  }
  await expect(page.locator("html")).toHaveAttribute("data-notice-replaced", "true");
  await page.evaluate(() => window.dispatchEvent(new Event("release-native-reply")));
  await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible({ timeout: 3000 });
  expect(withDaemonDb(daemon, db => db.prepare("SELECT count(*) AS n FROM session_spoken_turns").get()?.n)).toBe(0);
});

test("a lost Send now response cannot keep its delivered outcome busy", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  await page.route("**/api/voice/cards/lost-reply/send-now", async route => { await route.fetch(); });
  await say(daemon, "Steve, deliver once", { id: "lost-reply" });
  await page.getByRole("status").filter({ hasText: "deliver once" }).getByRole("button", { name: "Send now" }).click();
  const sent = page.getByRole("status").filter({ hasText: "Sent to Steve" });
  await expect(sent).toBeVisible();
  // Wait for the bounded request to fail. The daemon's confirmed outcome stays authoritative.
  await page.waitForTimeout(2500);
  await expect(sent).not.toContainText("was not confirmed");
  await expect(sent).toHaveCount(0, { timeout: 10000 });
});

for (const connection of ["first", "reconnected"] as const) {
  test(`a delayed ${connection} snapshot cannot extend the daemon cancel window`, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon, connection === "reconnected" ? 12 : 7);
    await runningAgent(page, daemon, "Steve");
    await page.addInitScript(connection => {
      window.EventSource = class extends EventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          let snapshots = 0;
          this.addEventListener("error", () => { document.documentElement.dataset.streamDropped = "true"; });
          this.addEventListener("message", event => {
            if (!event.isTrusted) return;
            const frame = JSON.parse(event.data);
            if (frame.type === "voice_card") event.stopImmediatePropagation();
            if (frame.type !== "snapshot") return;
            snapshots++;
            if (connection === "reconnected" && snapshots === 1) return;
            event.stopImmediatePropagation();
            setTimeout(() => {
              this.dispatchEvent(new MessageEvent("message", { data: event.data }));
              document.documentElement.dataset.releasedSnapshot = String(snapshots);
            }, 2200);
          });
        }
      };
    }, connection);
    const tunnel = connection === "reconnected" ? await forward(daemon.baseURL) : null;
    try {
      await say(daemon, "Steve, check the snapshot");
      const card = page.getByRole("status").filter({ hasText: "check the snapshot" });
      const cancel = card.getByRole("button", { name: "Cancel" });
      if (tunnel) {
        await page.goto(`http://127.0.0.1:${tunnel.port}/`);
        await expect(cancel).toBeVisible();
        tunnel.disconnect();
        await expect(page.locator("html")).toHaveAttribute("data-stream-dropped", "true");
      } else {
        await page.reload();
      }
      await expect(page.locator("html")).toHaveAttribute("data-released-snapshot", tunnel ? "2" : "1");
      await expect(cancel).toBeVisible();
      await expect.poll(() => withDaemonDb(daemon, db => db.prepare(
        "SELECT count(*) AS n FROM session_spoken_turns WHERE spoken_words = ?",
      ).get("check the snapshot")?.n), { timeout: 15_000, intervals: [50] }).toBe(1);
      await expect(cancel).toHaveCount(0, { timeout: 600 });
      await expect(card).toContainText("Awaiting delivery confirmation");
      if (tunnel) await captureCard(card, "native-reconnect-expired-window");
    } finally {
      await tunnel?.stop();
    }
  });
}

for (const probe of ["available", "unavailable"]) {
  test(`a delayed stream acceptance leaves the last seconds available to cancel with the clock probe ${probe}`, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon, 8);
    await runningAgent(page, daemon, "Steve");
    if (probe === "unavailable") await page.route("**/api/voice/config", route => route.fulfill({ status: 503, body: "Unavailable" }));
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/events", async route => {
      requested.resolve();
      await release.promise;
      await route.continue();
    });
    await page.addInitScript(() => {
      window.EventSource = class extends EventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          this.addEventListener("message", event => {
            const frame = JSON.parse(event.data);
            const card = frame.voiceCards?.find((card: { id: string }) => card.id === "slow-connect");
            if (card) document.documentElement.dataset.daemonDeadline = String(card.deadline);
          });
        }
      };
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await requested.promise;
    try {
      await page.waitForTimeout(3000);
      await say(daemon, "Steve, check the connection", { id: "slow-connect" });
    } finally {
      release.resolve();
    }
    const card = page.getByRole("status").filter({ hasText: "check the connection" });
    await expect(card).toBeVisible();
    if (probe === "unavailable") {
      await expect(card).toContainText(/≤\d+s/);
      await captureCard(card, "unconfirmed-clock-window");
    }
    await expect(page.locator("html")).toHaveAttribute("data-daemon-deadline", /^\d+$/);
    const deadline = Number(await page.locator("html").getAttribute("data-daemon-deadline"));
    await page.waitForTimeout(Math.max(0, deadline - Date.now() - 1500));
    await card.getByRole("button", { name: "Cancel" }).click({ timeout: 900 });
    await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
    expect(withDaemonDb(daemon, db => db.prepare("SELECT count(*) AS n FROM session_spoken_turns").get()?.n)).toBe(0);
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
      showVoiceCardNotice: ({ title, body, scope, remainingMs }: { title: string; body: string; scope: string; remainingMs: number }) => {
        if (declineFirst) {
          declineFirst = false;
          document.documentElement.dataset.fixtureBlurred = "false";
          window.dispatchEvent(new Event("focus"));
          document.documentElement.dataset.declinedNotice = "true";
          return Promise.resolve("window-focused");
        }
        document.title = title + " | " + body;
        document.documentElement.dataset.noticeScope = scope;
        document.documentElement.dataset.noticeRemaining = String(remainingMs);
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
    const open = new Set<{ tag: string }>();
    const reportOpen = () => {
      document.documentElement.dataset.openNotices = JSON.stringify([...open].map(note => note.tag));
    };
    Object.defineProperty(window, "Notification", { value: class {
      static permission = "granted";
      readonly tag: string;
      constructor(_title: string, options: NotificationOptions) {
        this.tag = options.tag!;
        open.add(this);
        reportOpen();
      }
      close() {
        open.delete(this);
        reportOpen();
      }
    } });
  });
  await page.reload();
  await runningAgent(page, daemon, "Steve");
  const notices = page.locator("html");
  await say(daemon, "Steve, drop this", { id: "early-close" });
  await expect(notices).toHaveAttribute("data-open-notices", JSON.stringify(["voice-early-close"]));
  await page.getByRole("status").filter({ hasText: "drop this" }).getByRole("button", { name: "Cancel" }).click();
  await expect(notices).toHaveAttribute("data-open-notices", "[]");
  await say(daemon, "Steve, deliver this", { id: "disconnected" });
  await expect(notices).toHaveAttribute("data-open-notices", JSON.stringify(["voice-disconnected"]));
  await page.evaluate(() => window.dispatchEvent(new Event("disconnect-fixture-stream")));
  await expect.poll(() => withDaemonDb(daemon, db => db.prepare("SELECT spoken_words FROM session_spoken_turns").all().map(r => r.spoken_words))).toEqual(["deliver this"]);
  await expect(notices).toHaveAttribute("data-open-notices", "[]", { timeout: 2000 });
  const card = page.getByRole("status").filter({ hasText: "deliver this" });
  await expect(card).toContainText("Awaiting delivery confirmation", { timeout: 2000 });
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card).not.toContainText("0s");
  await captureCard(card, "awaiting-delivery-confirmation");
});

test("a reconnect shows the delivery receipt missed during the cancel window", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  const tunnel = await forward(daemon.baseURL);
  const witness = await page.context().newPage();
  try {
    await witness.goto(daemon.baseURL);
    await page.addInitScript(() => {
      window.EventSource = class extends EventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          this.addEventListener("error", () => { document.documentElement.dataset.streamDropped = "true"; });
        }
      };
    });
    await page.goto(`http://127.0.0.1:${tunnel.port}/`);
    await say(daemon, "Steve, check the release", { id: "followup-reconnect" });
    await expect(page.getByRole("status").filter({ hasText: "To Steve" })).toContainText("Cancel");
    await expect(witness.getByRole("status").filter({ hasText: "To Steve" })).toContainText("Cancel");
    tunnel.pause();
    await expect(page.locator("html")).toHaveAttribute("data-stream-dropped", "true");
    // Clearing the history in another dashboard must still let this one see later receipts.
    expect((await page.request.delete(daemon.baseURL + "/api/voice/heard")).ok()).toBe(true);
    await witness.getByRole("button", { name: "Send now" }).click();
    await expect(witness.getByRole("status").filter({ hasText: "Sent to Steve" })).toBeVisible();
    const sent = page.getByRole("status").filter({ hasText: "Sent to Steve" });
    await expect(sent).toHaveCount(0);
    tunnel.resume();
    await expect(sent).toBeVisible({ timeout: 10000 });
    await captureCard(sent, "followup-reconnected-receipt");
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Pages" })).toBeVisible();
    await expect(sent).toHaveCount(0);
  } finally {
    await tunnel.stop();
    await witness.close();
  }
});
