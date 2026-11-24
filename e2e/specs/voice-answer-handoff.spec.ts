import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { captureCard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { say, voiceToken } from "../fixtures/voice.ts";

async function file(page: Page, daemon: DaemonHandle, cwd: string, title: string) {
  const filed = await page.request.post(daemon.baseURL + "/mcp/reviews", {
    headers: { "x-harness-token": voiceToken(daemon) }, data: { kind: "input", env: {}, cwd, title, body: title },
  });
  expect(filed.ok(), await filed.text()).toBe(true);
  return (await filed.json()).id as string;
}

test("a voice pick switches review sessions and focuses the selected question before a reply", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const steve = await runningAgent(page, daemon, "Steve");
  const will = await runningAgent(page, daemon, "Will");
  await file(page, daemon, steve.cwd, "Where does the build start?");
  await file(page, daemon, will.cwd, "Which suite?");
  const id = await file(page, daemon, will.cwd, "Which benchmark?");
  const modal = page.getByRole("dialog", { name: "Review request" });
  for (const [name, title] of [["Steve", "Where does the build start?"], ["Will", "Which benchmark?"]]) {
    await say(daemon, name + ", answer");
    await page.getByRole("status").getByRole("button", { name: title, exact: false }).click();
    await expectContentClearsBorder(modal);
    await expect(modal.locator(".review").filter({ has: page.getByRole("heading", { name: title }) })).toBeFocused();
  }
  await say(daemon, "reply, tomorrow");
  const selected = modal.locator(".review").filter({ hasText: "Which benchmark?" });
  await expect(selected.getByRole("textbox")).toHaveValue("tomorrow");
  await selected.getByRole("button", { name: "Submit now" }).click();
  await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/reviews/" + id)).json()).response).toBe("tomorrow");
});

test("a stalled card report cannot block a newer report after the question closes", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const steve = await runningAgent(page, daemon, "Steve");
  const id = await file(page, daemon, steve.cwd, "Which suite?");
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let openRequests = 0;
  const closed = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() &&
    !r.request().postDataJSON().cards.length && openRequests > 0);
  await page.route("**/api/voice/open-cards", async route => {
    if (route.request().postDataJSON().cards.length) {
      await route.fetch();
      openRequests++;
      received.resolve();
      await release.promise;
      return route.fulfill({ status: 200, json: { ok: true } }).catch(() => {});
    }
    await route.continue();
  });
  try {
    await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
    await received.promise;
    await expect.poll(() => openRequests, { timeout: 7000 }).toBeGreaterThan(1);
    await expectContentClearsBorder(page.getByRole("dialog", { name: "Attention inbox" }));
    await page.keyboard.press("Escape");
    await closed;
    await say(daemon, "reply, tomorrow");
    expect((await (await page.request.get(daemon.baseURL + "/api/reviews/" + id)).json()).status).toBe("pending");
    await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
    await expect(page.getByRole("dialog", { name: "Attention inbox" }).getByRole("textbox")).toBeEmpty();
    await expect(page.getByRole("button", { name: "Submit now" })).toHaveCount(0);
  } finally {
    release.resolve();
  }
});

test("a delayed report accepts a reply captured after the question appeared", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const steve = await runningAgent(page, daemon, "Steve");
  const id = await file(page, daemon, steve.cwd, "Which benchmark?");
  const beforeOpen = Date.now();
  const observed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() &&
    r.request().postDataJSON().cards.some((c: { id: string }) => c.id === id));
  await page.route("**/api/voice/open-cards", async route => {
    if (route.request().postDataJSON().cards.length) {
      observed.resolve();
      await release.promise;
    }
    await route.continue();
  });
  try {
    await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
    const inbox = page.getByRole("dialog", { name: "Attention inbox" });
    await expectContentClearsBorder(inbox);
    await observed.promise;
    const afterOpen = Date.now();
    await expect.poll(() => Date.now()).toBeGreaterThan(afterOpen + 15);
    release.resolve();
    await delivered;
    await say(daemon, "reply, too early", { capturedAt: beforeOpen });
    await expect(inbox.getByRole("textbox")).toBeEmpty();
    await say(daemon, "reply, tomorrow", { capturedAt: afterOpen });
    await expect(inbox.getByRole("textbox")).toHaveValue("tomorrow");
    await inbox.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    release.resolve();
  }
});

test("a prefilled picker choice is acknowledged and its answer appears in the companion", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const steve = await runningAgent(page, daemon, "Steve");
  const first = await file(page, daemon, steve.cwd, "When should the build start?");
  const second = await file(page, daemon, steve.cwd, "Which benchmark?");
  await say(daemon, "Steve, answer: tomorrow");
  const picker = page.getByRole("status").filter({ hasText: "Which question?" });
  const ack = page.waitForResponse(r => r.url().endsWith("/pick"));
  await picker.getByRole("button", { name: /When should the build start/ }).click();
  expect((await ack).status()).toBe(200);
  await expect(picker).toHaveCount(0);
  const companion = page.getByRole("status").filter({ hasText: "When should the build start?" });
  await expect(companion).toContainText("tomorrow");
  await companion.getByRole("button", { name: "Submit now" }).click();
  await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/reviews/" + first)).json()).response).toBe("tomorrow");
  expect((await (await page.request.get(daemon.baseURL + "/api/reviews/" + second)).json()).status).toBe("pending");
});

for (const slowAgain of [false, true]) {
  test(slowAgain ? "overlapping clock bounds visibly request a repeat before starting a countdown"
    : "a slow outbound clock sample does not discard speech after the card opens", async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon);
    const steve = await runningAgent(page, daemon, "Steve");
    const id = await file(page, daemon, steve.cwd, "Which benchmark?");
    const probe = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    let probes = 0;
    if (slowAgain) await page.route("**/api/voice/open-cards", async route => {
      // Delay both sources of certainty: the first card report and the time probes.
      if (route.request().headers()["x-voice-calibrating"]) await release.promise;
      await route.continue();
    });
    await page.route("**/api/voice/config", async route => {
      if (route.request().method() === "HEAD") {
        if (++probes === 1) {
          probe.resolve(Date.now());
          await release.promise;
        } else if (slowAgain) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
      await route.continue();
    });
    const delivered = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() && !r.request().headers()["x-voice-calibrating"] &&
      r.request().postDataJSON().cards.some((c: { id: string }) => c.id === id));
    try {
      await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
      const inbox = page.getByRole("dialog", { name: "Attention inbox" });
      await expectContentClearsBorder(inbox);
      const sent = await probe.promise;
      await expect.poll(() => Date.now(), { intervals: [15] }).toBeGreaterThan(sent + 300);
      release.resolve();
      await delivered;
      await say(daemon, "reply, tomorrow", { capturedAt: sent + 150 });
      if (slowAgain) {
        const notice = page.getByRole("status").filter({ hasText: "your answer again" });
        await expect(notice).toBeVisible();
        await expect(inbox.getByRole("textbox")).toBeEmpty();
        await expect(inbox.getByRole("button", { name: "Submit now" })).toHaveCount(0);
        await captureCard(notice, "voice-repeat-after-uncertain-clock-r17");
        await say(daemon, "reply, tomorrow");
      }
      await expect(inbox.getByRole("textbox")).toHaveValue("tomorrow");
      expect(probes).toBeGreaterThan(1);
    } finally {
      release.resolve();
    }
  });
}

test("manually reopening a review cannot replay a completed voice pick", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const steve = await runningAgent(page, daemon, "Steve");
  await file(page, daemon, steve.cwd, "Which compiler?");
  await file(page, daemon, steve.cwd, "Which benchmark?");
  const modal = page.getByRole("dialog", { name: "Review request" });
  const picked = modal.locator(".review").filter({ hasText: "Which benchmark?" });
  await say(daemon, "Steve, answer");
  await page.getByRole("status").getByRole("button", { name: /Which benchmark/ }).click();
  await expectContentClearsBorder(modal);
  await expect(picked).toBeFocused();
  await modal.getByRole("button", { name: /Close \(esc\)/ }).click();
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: /to review/ }).click();
  await expect(modal).toBeVisible();
  await expect(picked).not.toBeFocused();
  await say(daemon, "reply, yesterday");
  await expect(picked.getByRole("textbox")).toBeEmpty();
});

test("a reply cannot reach the old question while a new focus is calibrating", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const steve = await runningAgent(page, daemon, "Steve");
  const first = await file(page, daemon, steve.cwd, "First benchmark?");
  const second = await file(page, daemon, steve.cwd, "Second benchmark?");
  const release = Promise.withResolvers<void>();
  const probing = Promise.withResolvers<void>();
  let hold = false;
  await page.route("**/api/voice/config", async route => {
    if (route.request().method() === "HEAD") {
      if (!hold) return route.fulfill({ status: 503 });
      probing.resolve();
      await release.promise;
    }
    await route.continue();
  });
  try {
    await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
    const inbox = page.getByRole("dialog", { name: "Attention inbox" });
    await expectContentClearsBorder(inbox);
    const card = (id: string) => inbox.locator('[data-voice-question="' + id + '"]').getByRole("textbox");
    const focused = (id: string, calibrating: boolean) => page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() &&
      Boolean(r.request().headers()["x-voice-calibrating"]) === calibrating &&
      r.request().postDataJSON().cards.some((c: { id: string; focused: boolean }) => c.focused && c.id === id));
    const firstReport = focused(first, false);
    await card(first).focus();
    await firstReport;
    hold = true;
    const secondReport = focused(second, true);
    await card(second).focus();
    await Promise.all([probing.promise, secondReport]);
    // Capture strictly after the new focus is visible to the daemon, while the probe is held.
    const received = Date.now();
    await expect.poll(() => Date.now(), { intervals: [5] }).toBeGreaterThan(received + 5);
    const reply = say(daemon, "reply, tomorrow", { id: "reply-during-probe" });
    await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries
      .some((entry: { id: string }) => entry.id === "reply-during-probe"), { intervals: [10] }).toBe(true);
    await expect(card(first)).toBeEmpty();
    await expect(card(second)).toBeEmpty();
    release.resolve();
    await reply;
    await expect(card(first)).toBeEmpty();
    await expect(card(second)).toHaveValue("tomorrow");
  } finally {
    release.resolve();
  }
});

for (const [name, phrase] of [["reply", "reply, tomorrow"], ["named answer", "Steve, answer: tomorrow"]] as const) {
  test(`a ${name} transcript delivered before the new focus report waits for a live confirmation`, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon);
    const steve = await runningAgent(page, daemon, "Steve");
    const first = await file(page, daemon, steve.cwd, "First benchmark?");
    const second = await file(page, daemon, steve.cwd, "Second benchmark?");
    await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
    const inbox = page.getByRole("dialog", { name: "Attention inbox" });
    await expectContentClearsBorder(inbox);
    const field = (id: string) => inbox.locator('[data-voice-question="' + id + '"]').getByRole("textbox");
    const firstReport = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() &&
      !r.request().headers()["x-voice-calibrating"] && r.request().postDataJSON().cards.some((c: { id: string; focused: boolean }) => c.focused && c.id === first));
    await field(first).focus();
    await firstReport;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/api/voice/open-cards", async route => {
      held.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    try {
      await field(second).focus();
      await held.promise;
      const focusedAt = Date.now();
      await expect.poll(() => Date.now(), { intervals: [10] }).toBeGreaterThan(focusedAt + 30);
      const reply = say(daemon, phrase, { id: "before-focus-delivery" });
      await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries
        .some((entry: { id: string }) => entry.id === "before-focus-delivery"), { intervals: [10] }).toBe(true);
      await expect(field(first)).toBeEmpty();
      await expect(inbox.getByRole("button", { name: "Submit now" })).toHaveCount(0);
      release.resolve();
      await reply;
      await expect(field(second)).toHaveValue("tomorrow");
      await inbox.getByRole("button", { name: "Submit now" }).click();
      await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/reviews/" + second)).json()).response).toBe("tomorrow");
      expect((await (await page.request.get(daemon.baseURL + "/api/reviews/" + first)).json()).status).toBe("pending");
    } finally {
      release.resolve();
    }
  });
}

test("a focused multi-decision form blocks replies to its single-decision neighbor", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const steve = await runningAgent(page, daemon, "Steve");
  const neighbor = await file(page, daemon, steve.cwd, "When should the build start?");
  const title = "Choose both settings";
  const multi = await file(page, daemon, steve.cwd, title);
  // The current MCP schema permits one decision on input. Restore a persisted
  // multi-decision input through the normal boot path to exercise manual forms.
  await daemon.shutdown();
  withDaemonDb(daemon, db => db.prepare("UPDATE reviews SET decisions = ? WHERE id = ?").run(
    JSON.stringify(["Compiler", "Profiler"].map(question => ({ id: question, question, options: [{ id: "enabled", label: "Enable " + question }] }))), multi));
  await daemon.restart();
  await page.reload();
  await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expectContentClearsBorder(inbox);
  const manual = inbox.locator(".review").filter({ hasText: title });
  await manual.getByRole("radio").first().focus();
  await say(daemon, "reply, tomorrow");
  await expect(inbox.locator('[data-voice-question="' + neighbor + '"]').getByRole("textbox")).toBeEmpty();
  await expect(inbox.getByRole("button", { name: "Submit now" })).toHaveCount(0);
  expect((await (await page.request.get(daemon.baseURL + "/api/reviews/" + neighbor)).json()).status).toBe("pending");
});

test("choosing a question in an older picker keeps the newer dictated answer", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 30);
  const steve = await runningAgent(page, daemon, "Steve");
  const id = await file(page, daemon, steve.cwd, "Which database?");
  await file(page, daemon, steve.cwd, "Which cache?");
  await say(daemon, "Steve, answer: Postgres");
  const picker = page.getByRole("status").filter({ hasText: "Which question?" });
  await expect(picker).toBeVisible();
  await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expectContentClearsBorder(inbox);
  const field = inbox.locator('[data-voice-question="' + id + '"]').getByRole("textbox");
  await field.focus();
  await say(daemon, "reply, SQLite");
  await expect(field).toHaveValue("SQLite");
  await page.keyboard.press("Escape");
  await picker.getByRole("button", { name: /Which database/ }).click();
  await expect(picker).toHaveCount(0);
  const companion = page.getByRole("status").filter({ hasText: "Voice answer" });
  await expect(companion).toContainText("SQLite");
  await companion.getByRole("button", { name: "Submit now" }).click();
  await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/reviews/" + id)).json()).response).toBe("SQLite");
});

test("a companion identifies its destination and hands its calibrated countdown to the owning footer", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 30);
  const steve = await runningAgent(page, daemon, "Steve");
  const will = await runningAgent(page, daemon, "Will");
  const first = await file(page, daemon, steve.cwd, "When should the build start?");
  await file(page, daemon, will.cwd, "When should the tests start?");
  await page.clock.setFixedTime(new Date(Date.now() - 120_000));
  await say(daemon, "Steve, answer: tomorrow");
  await say(daemon, "Will, answer: tomorrow");
  const pending = page.getByRole("status").filter({ hasText: "Voice answer" });
  const build = pending.filter({ hasText: "Steve" });
  await expect(build).toContainText("When should the build start?");
  await expect(pending.filter({ hasText: "Will" })).toContainText("When should the tests start?");
  await captureCard(build, "companion-destination-round12");
  await expect(build.locator(".vc-seconds")).toHaveText(/^≤?(?:[1-9]|1\d|2[0-8])s$/);
  await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expectContentClearsBorder(inbox);
  const card = inbox.locator(".review").filter({ hasText: "When should the build start?" });
  const footer = card.getByRole("status");
  await expect(footer).toContainText(/submits in ≤?(?:[1-9]|1\d|2[0-8])s/);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/voice/cards/*/send-now*", async route => {
    held.resolve();
    await release.promise;
    await route.continue();
  }, { times: 1 });
  try {
    await footer.getByRole("button", { name: "Submit now" }).click();
    await held.promise;
    const foreground = await page.context().newPage();
    await foreground.goto(daemon.baseURL + "/#/fleet");
    const companion = foreground.getByRole("status").filter({ hasText: "When should the build start?" });
    await expect(companion.getByRole("button", { name: "Submit now" })).toBeEnabled();
    await expect(footer.getByRole("button", { name: "Submit now" })).toBeDisabled();
    await expect(footer.getByRole("button", { name: "Submit now" })).toHaveAccessibleDescription("Focus this question in this dashboard to submit here");
    await captureCard(footer, "inactive-question-footer-round12");
    const response = page.waitForResponse(r => r.url().includes("/send-now"));
    release.resolve();
    expect((await response).status()).toBe(409);
    expect((await (await page.request.get(daemon.baseURL + "/api/reviews/" + first)).json()).status).toBe("pending");
    await companion.getByRole("button", { name: "Cancel" }).click();
    await expect(footer).toHaveCount(0);
  } finally {
    release.resolve();
  }
});

for (const closing of [true, false]) {
test(closing ? "a footer submit that overtakes the card’s close report leaves the answer pending"
  : "a companion submit that overtakes the card’s open report leaves the answer pending", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 30);
  const steve = await runningAgent(page, daemon, "Steve");
  const id = await file(page, daemon, steve.cwd, "When should the build start?");
  const openInbox = () => page.locator("button.pulse-seg", { hasText: "to answer" }).click();
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const companion = page.getByRole("status").filter({ hasText: "Voice answer" });
  if (closing) {
    await openInbox();
    await expectContentClearsBorder(inbox);
  }
  await say(daemon, "Steve, answer: tomorrow");
  const submit = (closing ? inbox : companion).getByRole("button", { name: "Submit now" });
  await expect(submit).toBeEnabled();
  const clicked = Promise.withResolvers<void>();
  const transition = Promise.withResolvers<void>();
  const send = Promise.withResolvers<void>();
  const releaseReport = Promise.withResolvers<void>();
  await page.route("**/api/voice/cards/*/send-now*", async route => {
    clicked.resolve();
    await send.promise;
    await route.continue();
  });
  await page.route("**/api/voice/open-cards", async route => {
    if (Boolean(route.request().postDataJSON().cards.length) !== closing && !route.request().headers()["x-voice-confirm-focus"]) {
      transition.resolve();
      await releaseReport.promise;
    }
    await route.continue().catch(() => {});
  });
  try {
    await submit.click();
    await clicked.promise;
    if (closing) await page.keyboard.press("Escape");
    else {
      await openInbox();
      await expectContentClearsBorder(inbox);
    }
    await transition.promise;
    const rejected = page.waitForResponse(r => r.url().includes("/send-now"));
    send.resolve();
    expect((await rejected).status()).toBe(409);
    const owner = closing ? companion : inbox;
    if (closing) await expect(companion).toContainText("tomorrow");
    else await expect(inbox.getByRole("textbox")).toHaveValue("tomorrow");
    await owner.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await (await page.request.get(daemon.baseURL + "/api/reviews/" + id)).json()).status).toBe("pending");
  } finally {
    send.resolve();
    releaseReport.resolve();
  }
});
}

test("switching the same stream to the standalone surface withdraws the footer and restores the companion", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 30);
  const steve = await runningAgent(page, daemon, "Steve");
  const title = "Which benchmark should run first?";
  const id = await file(page, daemon, steve.cwd, title);
  const report = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() &&
    r.request().postDataJSON().cards.some((card: { id: string }) => card.id === id));
  await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
  const dashboardId = (await report).request().postDataJSON().windowId;
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expectContentClearsBorder(inbox);
  await say(daemon, "reply, tomorrow", { id: "surface-answer" });
  await expect(inbox.getByRole("button", { name: "Submit now" })).toBeEnabled();
  await page.evaluate(() => { location.hash = "/voice/popover"; });
  const companion = page.getByRole("status").filter({ hasText: title });
  await expect(companion.getByRole("button", { name: "Submit now" })).toBeEnabled({ timeout: 5000 });
  await expect(companion).toContainText("tomorrow");
  expect((await page.request.post(daemon.baseURL + "/api/voice/cards/surface-answer/send-now?windowId=" + dashboardId)).status()).toBe(409);
  await captureCard(companion, "dashboard-to-standalone-round13");
  await companion.getByRole("button", { name: "Cancel" }).click();
  expect((await (await page.request.get(daemon.baseURL + "/api/reviews/" + id)).json()).status).toBe("pending");

  await say(daemon, "Steve, answer");
  const picker = page.getByRole("status").filter({ hasText: "Which question?" });
  await picker.getByRole("button", { name: title, exact: false }).click();
  await expect(picker).toContainText("Focus a dashboard");
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await say(daemon, "Steve, answer: tonight");
  await companion.getByRole("button", { name: "Submit now" }).click();
  await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/reviews/" + id)).json()).response).toBe("tonight");
});

test("a responsive companion submits while a background dashboard cannot acknowledge the ownership check", async ({ dashboard: background, daemon }) => {
  await setupCards(background, daemon, 30);
  const steve = await runningAgent(background, daemon, "Steve");
  const id = await file(background, daemon, steve.cwd, "When should the build start?");
  const foreground = await background.context().newPage();
  const focused = foreground.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() && r.request().postDataJSON().focused);
  await foreground.goto(daemon.baseURL + "/#/fleet");
  await focused;
  const probed = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  await background.route("**/api/voice/open-cards*", async route => {
    if (route.request().headers()["x-voice-confirm-focus"]) {
      probed.resolve();
      await resume.promise;
    }
    await route.continue().catch(() => {});
  });
  try {
    await say(daemon, "Steve, answer: tonight");
    const companion = foreground.getByRole("status").filter({ hasText: "Voice answer" });
    const result = foreground.waitForResponse(r => r.url().includes("/send-now?source=card"));
    await companion.getByRole("button", { name: "Submit now" }).click();
    await probed.promise;
    expect((await result).status()).toBe(200);
    expect((await (await foreground.request.get(daemon.baseURL + "/api/reviews/" + id)).json()).response).toBe("tonight");
  } finally {
    resume.resolve();
    await foreground.close();
  }
});
