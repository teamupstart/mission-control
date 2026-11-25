import { expect, test } from "../fixtures/test.ts";
import { captureCard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { say } from "../fixtures/voice.ts";

for (const placement of ["pill", "popover"] as const) {
  test(`${placement} renders the selected confirmation design and cancels the pending message`, async ({ daemon, dashboard: page }) => {
    await setupCards(page, daemon);
    await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
      identity: { name: "Steve", description: "Builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
    } } });
    await page.goto(daemon.baseURL + "/#/voice/" + placement);
    const words = "check the build and report back";
    await say(daemon, "Steve, " + words);
    const card = page.getByRole("status").filter({ hasText: words });
    await expect(card.getByRole("button", { name: "Send now" })).toHaveText(/\d+/);
    const mock = await page.context().newPage();
    await mock.goto(new URL("../../docs/plans/voice-addressing-for-agents/mockup-confirmation-card.html", import.meta.url).href);
    const design = mock.locator(placement === "pill" ? "#b .cc-hud" : "#c .cc-card").first();
    for (const property of ["border-radius", "padding", "gap"]) {
      await expect(card).toHaveCSS(property, await design.evaluate((el, key) => getComputedStyle(el).getPropertyValue(key), property));
    }
    await mock.close();
    await captureCard(page.locator(".voice-standalone"), "floating-" + placement);
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("status")).toContainText("Cancelled");
  });
}

test("an unsure browser card opens the Recently heard table in Voice settings", async ({ daemon, dashboard: page }) => {
  await setupCards(page, daemon);
  for (const name of ["Steve", "Will"]) await runningAgent(page, daemon, name);
  await say(daemon, "Steven ask Will about the deployment");
  await page.getByRole("button", { name: "Recently heard" }).click();
  await expect(page).toHaveURL(daemon.baseURL + "/#/settings/voice");
  await expect(page.getByRole("table", { name: "Recently heard utterances" })).toContainText("Steven ask Will about the deployment");
});

for (const surface of ["pill", "popover"] as const) {
  test(`${surface} shows the delivered design with open questions`, async ({ daemon, dashboard: page }) => {
    await setupCards(page, daemon);
    await runningAgent(page, daemon, "Steve");
    // The mock-up has two open questions after delivery. Supply that count on
    // the real receipt without blocking the fixture agent on an input request.
    await page.addInitScript(() => {
      window.EventSource = class extends EventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          this.addEventListener("message", event => {
            if (!event.isTrusted) return;
            const frame = JSON.parse(event.data);
            if (frame.type !== "voice_card" || frame.card.state !== "sent") return;
            event.stopImmediatePropagation();
            frame.card.openQuestions = 2;
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
          });
        }
      };
    });
    await page.goto("about:blank");
    await page.goto(daemon.baseURL + "/#/voice/" + surface);
    const words = "check the build and report back with the release notes, test results and details for every package in this release";
    await say(daemon, "Steve, " + words);
    const card = page.getByRole("status");
    if (surface === "pill") {
      await expect(card).toHaveAccessibleName("To Steve: " + words);
      expect(await card.locator(".vc-pill-message").evaluate(el => el.clientWidth < el.scrollWidth)).toBe(true);
    }
    await card.getByRole("button", { name: "Send now" }).click();
    await expect(card).toContainText("Sent to Steve");
    await expect(card).toContainText("2 open questions");
    await expect(card).toContainText("Steve, answer");
    await page.mouse.move(0, 400);
    await captureCard(page.locator(".voice-standalone"), "delivered-" + surface);
  });
}
