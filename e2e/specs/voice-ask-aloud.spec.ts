import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureSupervisorEnv } from "../../test/helpers/voice-supervisor.ts";
import { expect, test } from "../fixtures/test.ts";
import { captureCard, expectCardGeometry, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { beSpeaker, enableVoice, say, sendHello, voiceToken } from "../fixtures/voice.ts";

test.use({ daemonEnv: fixtureSupervisorEnv });

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
      expect(speaker.capturing).toBe(false);
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

test("a delayed player cannot start after Stop and confirms silence before recapture", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const speaker = await beSpeaker(daemon, { delayStart: true, ignoreStop: true });
  try {
    const opened = await page.request.post(daemon.baseURL + "/api/voice/speech/audition");
    expect(opened.ok()).toBe(true);
    const { id } = await opened.json();
    const stopped = await page.request.post(daemon.baseURL + "/api/voice/speech/stop", { data: { id } });
    expect(stopped.ok()).toBe(true);
    await expect.poll(async () => (await speaker.poll()).speak).toEqual({ id, stop: true });
    await expect(async () => expect(await speaker.start()).toBe(false)).toPass();
    expect(speaker.playing).toBe(false);
    expect((await speaker.poll()).capture).toBe(false);
    await page.goto(daemon.baseURL + "/#/settings/voice");
    const status = page.getByRole("status", { name: "Voice mode" });
    await expect(status).toContainText("the listener did not confirm that speech had stopped", { timeout: 10_000 });
    await expect(status).not.toContainText("no listener is running");
    await captureCard(status, "stop-unconfirmed");
    await speaker.end("stopped");
    expect((await speaker.poll()).capture).toBe(true);
  } finally { await speaker.exit(); }
});

test("an unrelated audition changes the unsure card hint until silence without adding asking controls", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  for (const name of ["Steve", "Will"]) await runningAgent(page, daemon, name);
  const speaker = await beSpeaker(daemon, { holdPlayback: true, ignoreStop: true });
  try {
    await speaker.say("Steven ask Will about the deployment");
    const card = page.getByRole("status").filter({ hasText: "Who is this for?" });
    const usual = "Say the name again, or click a row.";
    const paused = "Pick a row now, or speak once playback ends.";
    await expect(card).toContainText(usual);
    const response = await page.request.post(daemon.baseURL + "/api/voice/speech/audition");
    expect(response.ok()).toBe(true);
    await expect.poll(() => speaker.playing).toBe(true);
    await expect(card).toContainText(paused);
    await expect(card.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: /Will/ })).toBeEnabled();
    await captureCard(card, "unsure-during-audition");
    await page.request.post(daemon.baseURL + "/api/voice/speech/stop", { data: await response.json() });
    await expect.poll(async () => (await speaker.poll()).speak).toHaveProperty("stop", true);
    await expect(card).toContainText(paused);
    await speaker.end("stopped");
    await expect(card).toContainText(usual);
  } finally { await speaker.exit(); }
});

test("a fixture speaker retires its signed launch when another listener owns capture at setup", async ({ daemon }) => {
  await enableVoice(daemon);
  expect(await sendHello(daemon)).toBe(200);
  await expect(beSpeaker(daemon)).rejects.toThrow("Fixture listener hello was refused.");
  const launches = await readFile(join(daemon.home, "voice/supervised-instances.json"), "utf8");
  expect(JSON.parse(launches)).toEqual([]);
});

test("Ask aloud holds capture through playback and leaves the question picker silent", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const steve = await runningAgent(page, daemon, "Steve");
  await runningAgent(page, daemon, "Will");
  const titles = ["Which database?", "Which benchmark?"];
  for (const title of titles) {
    const filed = await page.request.post(daemon.baseURL + "/mcp/reviews", {
      headers: { "x-harness-token": voiceToken(daemon) }, data: { kind: "input", cwd: steve.cwd, title, body: title, env: {} },
    });
    expect(filed.ok()).toBe(true);
  }
  const speaker = await beSpeaker(daemon, { holdPlayback: true });
  try {
    expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { whenUnsure: "ask" } })).ok()).toBe(true);
    await speaker.say("Steven ask Will about the deployment");
    const asking = page.getByRole("status").filter({ hasText: "Asking aloud" });
    await expect(asking).toContainText("Steve or Will?");
    await expect.poll(() => speaker.playing).toBe(true);
    expect((await (await speaker.say("Steve my answer is tomorrow")).json()).accepted).toBe(false);
    await captureCard(asking, "ask-aloud-integrated");
    await speaker.end();
    await page.getByRole("status").filter({ hasText: "Who is this for?" }).getByRole("button", { name: "Cancel" }).click();
    await speaker.say("Steve my answer is tomorrow");
    const picker = page.getByRole("status").filter({ hasText: "Which question?" });
    await expect(picker.getByRole("button", { name: /Which benchmark/ })).toBeVisible();
    expect((await speaker.poll()).speak).toBeNull();
    await picker.getByRole("button", { name: /Which benchmark/ }).click();
    const answer = page.getByRole("status").filter({ hasText: "Voice answer for Steve" });
    await expect(answer).toContainText("Which benchmark?");
    await expect(answer.getByRole("button", { name: "Submit now" })).toHaveAccessibleDescription("Submit this answer before the countdown ends");
    await captureCard(answer, "answer-after-ask-aloud-integrated");
    await answer.getByRole("button", { name: "Cancel" }).click();
    await expect(answer.getByRole("button", { name: "Submit now" })).toHaveCount(0);
  } finally { await speaker.exit(); }
});
