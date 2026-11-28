import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { say } from "../fixtures/voice.ts";

test.use({ daemonEnv: { NODE_OPTIONS: "--import=" + new URL("../fixtures/voice-wall-clock-step.mjs", import.meta.url).href } });

test("a new card can still be cancelled after the daemon clock steps back on the same stream", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 30);
  await runningAgent(page, daemon, "Steve");
  async function cancel(words: string, capturedAt: number) {
    expect(await (await say(daemon, "Steve, " + words, { capturedAt })).json()).toEqual({ accepted: true });
    const card = page.getByRole("status").filter({ hasText: words });
    const ack = page.waitForResponse(res => res.url().endsWith("/cancel") && res.request().method() === "POST");
    await card.getByRole("button", { name: "Cancel", exact: true }).click({ timeout: 10_000 });
    expect((await ack).ok()).toBe(true);
    await expect(card.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Cancelled" }).last()).toBeVisible();
  }
  await cancel("establish the original clock", Date.now());
  writeFileSync(join(daemon.home, "step-voice-clock-back"), "");
  const response = await page.request.head(daemon.baseURL + "/api/voice/config");
  const shifted = Number(response.headers()["x-voice-server-time-ms"]);
  expect(Date.now() - shifted).toBeGreaterThanOrEqual(60_000);
  await cancel("verify clock recovery", shifted);
});
