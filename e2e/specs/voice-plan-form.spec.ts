import { expect, test } from "../fixtures/test.ts";
import { captureCard, postCachePlan, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { say } from "../fixtures/voice.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { VOICE_CARDS_EARLIEST_HEADER, VOICE_CARDS_OBSERVED_HEADER } from "../../src/shared/voice-answers.ts";

test("a delayed voice fill preserves a newer manual choice and submits the other spoken choices", async ({ dashboard: page, daemon }) => {
  await page.setViewportSize({ width: 1500, height: 1500 });
  await page.addInitScript(() => {
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener("message", event => {
          if (!event.isTrusted || JSON.parse(event.data).type !== "voice_form_fill") return;
          event.stopImmediatePropagation();
          document.documentElement.dataset.fillBuffered = "true";
          window.addEventListener("release-plan-fill", () => this.dispatchEvent(new MessageEvent("message", { data: event.data })), { once: true });
        });
      }
    };
  });
  await page.reload();
  await setupCards(page, daemon, 1);
  const steve = await runningAgent(page, daemon, "Steve");
  const plan = await postCachePlan(daemon, steve);
  const reported = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() && r.request().headers()[VOICE_CARDS_OBSERVED_HEADER] !== undefined &&
    r.request().postDataJSON().cards.some((c: { id: string }) => c.id === plan));
  await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
  const headers = (await reported).request().headers();
  const dialog = page.getByRole("dialog", { name: "Attention inbox" });
  await expectContentClearsBorder(dialog);
  const card = dialog.locator(".review-plan-decisions");
  await card.getByRole("radio", { name: /No$/ }).check();
  // The fixture speaks instantly. Put the earlier click outside the measured clock uncertainty.
  const afterEarlierClick = performance.now() + Number(headers[VOICE_CARDS_OBSERVED_HEADER]) - Number(headers[VOICE_CARDS_EARLIEST_HEADER]) + 2;
  await expect.poll(() => performance.now()).toBeGreaterThan(afterEarlierClick);
  await say(daemon, "Steve, first one B, second one A, third one A");
  await expect(page.locator("html")).toHaveAttribute("data-fill-buffered", "true");
  await card.getByRole("radio", { name: /SQLite/ }).check();
  await page.evaluate(() => window.dispatchEvent(new Event("release-plan-fill")));
  await expect(card.locator(".pd-ord.is-voice")).toHaveText(["2nd", "3rd"]);
  await expect(card.getByRole("radio", { name: /SQLite/ })).toBeChecked();
  await page.mouse.move(0, 0);
  await captureCard(card, "manual-choice-after-capture");
  await say(daemon, "Steve, submit");
  await expect.poll(async () => {
    const review = await (await page.request.get(daemon.baseURL + "/api/reviews/" + plan)).json();
    return review.selections?.map((answer: { selected: string[] }) => answer.selected);
  }).toEqual([["a"], ["a"], ["a"]]);
});

test("ordinal badges mirror fills into the editable draft and only a complete, open form submits", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 1400 });
  await setupCards(page, daemon, 1);
  const steve = await runningAgent(page, daemon, "Steve");
  const reference = await page.context().newPage();
  await reference.goto(new URL("../../docs/plans/voice-addressing-for-agents/mockup-plan-decisions-by-voice.html", import.meta.url).href);
  const badgeRadius = await reference.locator("#a .pd-ord").first().evaluate(el => getComputedStyle(el).borderRadius);
  const letterWidth = await reference.locator("#a .pd-key").first().evaluate(el => getComputedStyle(el).width);
  const filledColor = await reference.locator("#a .pd-ord.is-voice").first().evaluate(el => getComputedStyle(el).backgroundColor);
  const missingColor = await reference.locator("#a .pd-ord.is-missing").evaluate(el => getComputedStyle(el).backgroundColor);
  await reference.close();
  await page.bringToFront();
  const read = async (id: string) => (await page.request.get(daemon.baseURL + "/api/reviews/" + id)).json();
  const dialog = page.getByRole("dialog", { name: "Attention inbox" });
  const open = async (id: string) => {
    const reported = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() && r.request().postDataJSON().cards.some((c: {id: string}) => c.id === id));
    await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
    await reported;
    await expectContentClearsBorder(dialog);
  };
  const id = await postCachePlan(daemon, steve);
  await open(id);
  const card = dialog.locator(".review-plan-decisions");
  await expect(card.locator(".pd-ord")).toHaveText(["1st", "2nd", "3rd"]);
  await expect(card.locator(".pd-ord").first()).toHaveCSS("border-radius", badgeRadius);
  await expect(card.locator(".pd-key").first()).toHaveCSS("width", letterWidth);
  await captureCard(card, "plan-rest");
  await say(daemon, "Steve, first one B, second one A");
  await expect(card.locator(".pd-ord.is-voice")).toHaveText(["1st", "2nd"]);
  await expect(card.locator(".pd-ord.is-voice").first()).toHaveCSS("background-color", filledColor);
  await expect(card.getByRole("radio", { name: /Postgres/ })).toBeChecked();
  await expect(card.getByRole("button", { name: "Submit", exact: true })).toBeDisabled();
  await captureCard(card, "plan-filled");
  await say(daemon, "Steve, submit");
  await expect(card.locator(".pd-ord.is-missing")).toHaveText("3rd");
  await expect(card.locator(".pd-ord.is-missing")).toHaveCSS("background-color", missingColor);
  await expect(card.getByRole("alert")).toContainText("third one");
  await captureCard(card, "plan-refused");
  await say(daemon, "reply, third one A");
  await expect(card.locator(".pd-ord.is-voice")).toHaveCount(3);
  await captureCard(card, "plan-ready");
  await card.getByRole("radio", { name: /SQLite/ }).click();
  await expect(card.locator(".pd-ord.is-voice")).toHaveCount(2);
  await say(daemon, "Steve, submit");
  await expect.poll(async () => (await read(id)).selections?.[0].selected).toEqual(["a"]);
  if (await dialog.isVisible()) await page.keyboard.press("Escape");
  const second = await postCachePlan(daemon, steve);
  await open(second);
  await say(daemon, "Steve, first one B, second one A, third one A");
  await expect(card.locator(".pd-ord.is-voice")).toHaveCount(3);
  const closed = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() && !r.request().postDataJSON().cards.length);
  await page.keyboard.press("Escape");
  await closed;
  await say(daemon, "Steve, first one A");
  const fillRefused = page.getByRole("status").filter({ hasText: "Open Steve's plan form and say your choice again" });
  await expect(fillRefused).toBeVisible();
  await captureCard(fillRefused, "closed-plan-fill-notice");
  await say(daemon, "Steve, submit");
  await expect(page.getByText("Open Steve's plan form to submit it")).toBeVisible();
  expect((await read(second)).status).toBe("pending");
  await open(second);
  await expect(card.getByRole("radio", { checked: true })).toHaveCount(3);
  await expect(card.getByRole("radio", { name: /Postgres/ })).toBeChecked();
});
