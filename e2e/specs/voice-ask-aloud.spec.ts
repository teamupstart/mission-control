import { expect, test } from "../fixtures/test.ts";
import { captureCard, expectCardGeometry, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { beSpeaker, say } from "../fixtures/voice.ts";

test("Ask aloud follows the player, and Stop and the time limit wait for silence", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await setupCards(page, daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const ask = page.getByRole("radio", { name: "Ask aloud" });
  await expect(page.getByRole("radiogroup", { name: "When routing is unsure" }).getByRole("radio").first()).toHaveAccessibleName("Ask aloud");
  await expect(ask).toBeDisabled();
  await expect(ask).toHaveAccessibleDescription("No listener is running.");
  await expect(page.locator('[data-anchor="voice/when-unsure"]')).toContainText("No listener is running.");
  await captureCard(page.locator('[data-anchor="voice/when-unsure"]'), "ask-disabled");
  for (const name of ["Steve", "Will"]) await runningAgent(page, daemon, name);
  const speaker = await beSpeaker(daemon, { holdPlayback: true, ignoreStop: true });
  try {
    await ask.check();
    await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/voice/config")).json()).config.whenUnsure).toBe("ask");
    const asking = page.getByRole("status").filter({ hasText: "Asking aloud" });
    const unsure = page.getByRole("status").filter({ hasText: "Who is this for?" });
    const heldHint = "Pick a row now, or speak once playback ends.";
    for (const completion of ["finish", "stop", "limit"]) {
      await speaker.say("Steven ask Will about the deployment");
      await expect(asking).toBeVisible();
      await expect.poll(() => speaker.playing).toBe(true);
      await expect(asking).toContainText("Steve or Will?");
      await expect(asking).toContainText(heldHint);
      if (completion === "finish") {
        await expectCardGeometry(asking, "routing-exceptions", "#b .rx-col:has(.rx-ask) .is-unsure");
        await page.mouse.move(0, 0);
        await expectCardGeometry(asking.locator(".vc-ask"), "routing-exceptions", "#b .rx-ask");
        await captureCard(asking, "asking-aloud");
        await speaker.end();
      } else {
        if (completion === "stop") await asking.getByRole("button", { name: "Stop", exact: true }).click();
        await expect(asking).toHaveCount(0, { timeout: 15_000 });
        await expect(unsure).toContainText(heldHint);
        expect(speaker.playing).toBe(true);
        expect((await speaker.poll()).capture).toBe(false);
        await speaker.say("Steve ignore the player " + completion);
        await expect(page.getByRole("row").filter({ hasText: "ignore the player " + completion })).toContainText("Heard while speaking");
        await speaker.end("stopped");
      }
      await expect(asking).toHaveCount(0);
      await expect(unsure).toContainText("Say the name again, or click a row.");
      if (completion === "stop") await captureCard(page.getByRole("status").filter({ hasText: "Who is this for?" }), "asking-stopped");
      expect((await speaker.poll()).capture).toBe(true);
      await page.getByRole("status").filter({ hasText: "Who is this for?" }).getByRole("button", { name: "Cancel" }).click();
    }
    await speaker.say("Steven ask Will about the deployment");
    await expect.poll(() => speaker.playing).toBe(true);
    await asking.getByRole("button", { name: /Will/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Two messages" })).toBeVisible();
    expect((await speaker.poll()).capture).toBe(false);
    await speaker.end("stopped");
    await speaker.say("Steve route after playback");
    await expect(page.getByRole("status").filter({ hasText: "route after playback" }).getByRole("button", { name: "Send now" })).toBeVisible();
  } finally { await speaker.exit(); }
});

test("a saved Ask aloud choice with a capture-only listener shows the usual candidate rows", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  for (const name of ["Steve", "Will"]) await runningAgent(page, daemon, name);
  await page.request.put(daemon.baseURL + "/api/voice/config", { data: { whenUnsure: "ask" } });
  await say(daemon, "Steven ask Will about the deployment");
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const ask = page.getByRole("radio", { name: "Ask aloud" });
  await expect(ask).toBeChecked();
  await expect(ask).toBeDisabled();
  await expect(ask).toHaveAccessibleDescription("This listener cannot play speech.");
  const card = page.getByRole("status").filter({ hasText: "Who is this for?" });
  await expect(card.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: /Will/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Two messages" })).toBeVisible();
});
