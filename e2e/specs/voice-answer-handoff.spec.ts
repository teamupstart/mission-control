import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
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
