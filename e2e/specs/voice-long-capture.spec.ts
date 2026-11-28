import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";
import { captureCard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { beListener, say, startSpeech } from "../fixtures/voice.ts";
import { openVoiceTab } from "../fixtures/voice-settings.ts";

function pendingMessage(page: Page) {
  return page.getByRole("status").filter({ hasText: "To Steve" }).filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) });
}

async function expectOverflowRecovery(page: Page, daemon: DaemonHandle, screenshot: string) {
  const notice = page.getByRole("status").filter({ hasText: "Voice capture exceeded 60 seconds" });
  await expect(notice).toContainText("Repeat the message in shorter parts.", { timeout: 100_000 });
  await captureCard(notice, screenshot);
  await expect(pendingMessage(page)).toHaveCount(0);
  await openVoiceTab(page, "Recently heard", daemon.baseURL);
  const history = page.getByRole("region", { name: "Recently heard" });
  await expect(history.getByRole("row").filter({ hasText: "duration limit" })).toContainText("Repeat the message in shorter parts.");
  const { entries } = await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json();
  expect(entries).toEqual([
    expect.objectContaining({ outcome: "ignored", rule: "capture-limit", text: "" }),
    expect.objectContaining({ outcome: "cancelled", matchedName: "Steve", text: expect.stringMatching(/check the build/i) }),
  ]);
}

test("a listener overflow releases the pending addressed message and offers recovery", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  const listener = await beListener(daemon);
  try {
    await say(daemon, "Steve, check the build");
    await expect(pendingMessage(page)).toContainText("check the build");
    const speech = await startSpeech(daemon);
    expect(await (await speech.limit()).json()).toEqual({ accepted: true });
    await expectOverflowRecovery(page, daemon, "capture-limit");
    expect(withDaemonDb(daemon, db => db.prepare("SELECT * FROM session_spoken_turns").all())).toHaveLength(0);
  } finally { listener.stop(); }
});

for (const end of ["silence", "release", "overflow"]) test(end === "overflow"
  ? "native capture overflow cancels a pending addressed message without any session delivery"
  : `continuous native desktop audio reaches the addressed session once on ${end}`, async ({ dashboard: page, daemon }) => {
  const models = process.env.MISSION_LONG_VOICE_MODELS;
  test.skip(process.platform !== "darwin" || !models, "Requires installed macOS FluidAudio models");
  test.setTimeout(240_000);
  const words = readFileSync("test/fixtures/voice/long-message.txt", "utf8").trim();
  const wav = join(daemon.home, "long-message.wav");
  const execute = promisify(execFile);
  await execute("/usr/bin/say", ["-v", "Samantha", "-r", "115", "-o", wav, "--file-format=WAVE", "--data-format=LEI16@16000", words]);
  await setupCards(page, daemon, 15);
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { endOfSpeechMs: 3000, listeningMode: "always-on" } })).ok()).toBe(true);
  const session = await runningAgent(page, daemon, "Steve");
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.task!.callSign! }).first().click();
  const native = execute("swift", ["test", "-c", "release", "--package-path", "native/voice-listener", "--filter", "ContinuousSpeechTests.testContinuousDesktopCapture"], {
    env: { ...process.env, MISSION_LONG_VOICE_HELD: end === "release" ? "1" : "0", MISSION_LONG_VOICE_WAV: wav, MISSION_VOICE_MODEL_DIR: models, MISSION_VOICE_LISTENER_INSTANCE: "desktop-cpu",
      ...(end === "overflow" && { MISSION_LONG_VOICE_PENDING_WAV: resolve("test/fixtures/voice/steve-check-the-build.wav") }),
      MISSION_VOICE_DAEMON_URL: daemon.baseURL, MISSION_VOICE_TOKEN_FILE: join(daemon.home, "token") }, timeout: 150_000,
  });
  const card = pendingMessage(page);
  const finished = native.then(({ stdout }) => console.log(stdout));
  if (end === "overflow") {
    await Promise.all([finished, (async () => {
      await expect(card).toContainText(/check the build/i, { timeout: 90_000 });
      await expectOverflowRecovery(page, daemon, "native-overflow-recovery");
    })()]);
    expect(withDaemonDb(daemon, db => db.prepare("SELECT spoken_words FROM session_spoken_turns").all())).toEqual([]);
    return;
  }
  await Promise.all([finished, expect(card).toHaveCount(1, { timeout: 150_000 }).then(() => captureCard(card, "native-long-message-" + end))]);
  await expect(page.getByText(/Mock reply to: please open the blue folder/i).first()).toBeVisible({ timeout: 30_000 });
  const history = await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json();
  expect(history.entries).toEqual([expect.objectContaining({ matchedName: "Steve", outcome: "sent" })]);
  const receipts = withDaemonDb(daemon, db => db.prepare("SELECT spoken_words FROM session_spoken_turns").all());
  const normalize = (text: string) => text.toLowerCase().replaceAll(/[^a-z\s]/g, "").split(/\s+/).join(" ").trim();
  expect(receipts.map(row => normalize(String(row.spoken_words)))).toEqual([normalize(words.replace(/^Steve, /, ""))]);
  console.log(`${end}: one pending card, one session receipt, all ${words.split(/\s+/).length - 1} message words in order, SDK reply observed`);
});
