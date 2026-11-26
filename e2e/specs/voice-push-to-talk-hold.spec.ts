import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expect, test } from "../fixtures/test.ts";
import { captureCard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { openVoiceTab } from "../fixtures/voice-settings.ts";

const execute = promisify(execFile);

// A pause longer than the saved end-of-speech delay, and the separator word, both inside one hold.
const FIRST_HOLD = "Steve, check the build. [[slnc 3500]] Then, bagel, run the tests and report back.";
const SECOND_HOLD = "Carol, give me a report on the status of some project.";
const SAVED_DELAY_MS = 1000;

type HeardEntry = { id: string; text: string; matchedName: string | null; outcome: string; rule: string };

function pending(page: Page, name: string) {
  return page.getByRole("status").filter({ hasText: "To " + name }).filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) });
}

function pendingCards(page: Page) {
  return page.getByRole("status").filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) });
}

async function heard(page: Page, daemon: DaemonHandle): Promise<HeardEntry[]> {
  return (await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries;
}

function receipts(daemon: DaemonHandle): { note_key: string; spoken_words: string }[] {
  return withDaemonDb(daemon, db => db.prepare("SELECT note_key, spoken_words FROM session_spoken_turns ORDER BY rowid").all()) as
    { note_key: string; spoken_words: string }[];
}

async function synthesize(daemon: DaemonHandle, name: string, words: string): Promise<string> {
  const wav = join(daemon.home, name + ".wav");
  await execute("/usr/bin/say", ["-v", "Samantha", "-o", wav, "--file-format=WAVE", "--data-format=LEI16@16000", words]);
  return wav;
}

/** The production Swift listener loop, fed synthesized speech at microphone callback pace. */
function nativeListener(daemon: DaemonHandle, models: string, wav: string, env: Record<string, string>) {
  return execute("swift", ["test", "-c", "release", "--package-path", "native/voice-listener", "--filter", "ContinuousSpeechTests.testContinuousDesktopCapture"], {
    env: { ...process.env, MISSION_LONG_VOICE_NATURAL: "1", MISSION_LONG_VOICE_WAV: wav, MISSION_VOICE_MODEL_DIR: models,
      MISSION_VOICE_LISTENER_INSTANCE: "desktop-cpu", MISSION_VOICE_DAEMON_URL: daemon.baseURL,
      MISSION_VOICE_TOKEN_FILE: join(daemon.home, "token"), ...env }, timeout: 240_000,
  }).then(({ stdout }) => console.log(stdout), (error: { stdout?: string; stderr?: string }) => {
    // The XCTest failure is in the harness's own output, not in the command error.
    console.log(error.stdout, error.stderr);
    throw error;
  });
}

/** Keep every text the live transcript overlay shows, so a spec can read the partials afterwards. */
async function recordTranscripts(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { voiceTranscripts: string[] }).voiceTranscripts = seen;
    new MutationObserver(() => {
      const text = document.querySelector('aside[aria-label="Live voice transcript"]')?.textContent?.trim();
      if (text && seen.at(-1) !== text) seen.push(text);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { voiceTranscripts: string[] }).voiceTranscripts);
}

type Hold = { heldMs: number; samples: number; heardAtPress: number; cardsAtPress: number; receiptsAtPress: number };

/**
 * Samples the daemon's voice mode, Recently heard, the pending cards and the session receipts
 * every 100 ms. While a key is held, any new entry, card or delivery is a submission before
 * release, which the spec reports with the time into the hold at which it was seen.
 *
 * The counters take several requests to read, so the mode is read before and after them. Only a
 * sample with the key down at both reads proves the counters were taken during the hold. A sample
 * that straddles a press or a release proves nothing either way: it is skipped and ends the hold
 * being tracked. A release and the next press cannot both fall between two samples, because the
 * native harness plays 900 ms of trailing audio after key-up and waits for recognition first.
 */
function watchHolds(page: Page, daemon: DaemonHandle) {
  const holds: Hold[] = [];
  const early: string[] = [];
  let running = true;
  let failure: unknown;
  const loop = (async () => {
    let since: number | undefined;
    // A failed spec tears the daemon down while this loop may still be sampling; it then just ends.
    try {
      const held = async () => (await (await page.request.get(daemon.baseURL + "/api/voice/mute")).json()).state.mode === "push-to-talk";
      while (running) {
        const before = await held();
        const entries = (await heard(page, daemon)).length;
        const cards = await pendingCards(page).count();
        const delivered = receipts(daemon).length;
        const after = await held();
        if (before !== after) {
          // A press or release happened during this sample: the next held sample starts a new hold.
          since = undefined;
          await sleep(100);
          continue;
        }
        if (after) {
          if (since === undefined) {
            since = Date.now();
            holds.push({ heldMs: 0, samples: 0, heardAtPress: entries, cardsAtPress: cards, receiptsAtPress: delivered });
          }
          const hold = holds.at(-1)!;
          hold.samples++;
          hold.heldMs = Date.now() - since;
          if (entries > hold.heardAtPress || cards > hold.cardsAtPress || delivered > hold.receiptsAtPress) {
            early.push(`hold ${holds.length} at ${hold.heldMs} ms: ${entries} heard, ${cards} cards, ${delivered} receipts`);
          }
        } else since = undefined;
        await sleep(100);
      }
    } catch (error) { failure = error; }
  })();
  return async () => {
    running = false;
    await loop;
    if (failure) throw failure;
    return { holds, early };
  };
}

test("native Push-to-talk keeps a long pause and the separator in one message sent only on release", async ({ dashboard: page, daemon }) => {
  const models = process.env.MISSION_LONG_VOICE_MODELS;
  test.skip(process.platform !== "darwin" || !models, "Requires installed macOS FluidAudio models");
  test.setTimeout(300_000);
  const first = await synthesize(daemon, "paused-hold", FIRST_HOLD);
  const second = await synthesize(daemon, "second-hold", SECOND_HOLD);
  await setupCards(page, daemon, 30);
  // The Always-on delay is shorter than the pause, and the separator is the default word.
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", {
    data: { listeningMode: "always-on", endOfSpeechMs: SAVED_DELAY_MS, separatorWord: "bagel" },
  })).ok()).toBe(true);
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { listeningMode: "push-to-talk" } })).ok()).toBe(true);
  const steve = await runningAgent(page, daemon, "Steve");
  const carol = await runningAgent(page, daemon, "Carol");
  const transcripts = await recordTranscripts(page);
  const stopWatching = watchHolds(page, daemon);

  // Two presses of the registered shortcut, each released after its clip.
  const native = nativeListener(daemon, models!, first, { MISSION_LONG_VOICE_DEDICATED: "1", MISSION_LONG_VOICE_SECOND_WAV: second });
  // One hold, one message: the words before and after the pause, in order, with the separator as text.
  const message = pending(page, "Steve");
  await Promise.all([native, expect(message).toContainText(/check the build\W+then\W+bagel\W+run the tests and report back/i, { timeout: 200_000 })
    .then(() => captureCard(page, "push-to-talk-paused-hold"))]);
  await expect(pending(page, "Carol")).toContainText(/report on the status of some project/i);
  const { holds, early } = await stopWatching();
  console.log(`holds: ${JSON.stringify(holds)}`);
  expect(early, "nothing reaches Recently heard, a card or a session while the key is held").toEqual([]);
  expect(holds).toHaveLength(2);
  // The first hold lasted through its 3.5-second pause, longer than the saved delay, without a submission.
  expect(holds[0]!.heldMs).toBeGreaterThan(3500 + SAVED_DELAY_MS);
  await expect(message).toHaveCount(1);
  const entries = (await heard(page, daemon)).toReversed();
  console.log(`push-to-talk: ${entries.map(e => `${e.id} ${e.matchedName}: "${e.text}"`).join(" | ")}`);
  expect(entries.map(entry => entry.matchedName)).toEqual(["Steve", "Carol"]);
  expect(entries[0]!.text).toMatch(/^Steve, check the build\W+then\W+bagel\W+run the tests and report back\W*$/i);
  // Neither hold was split, at the pause or at the separator.
  expect(entries.every(entry => !entry.id.includes(":"))).toBe(true);

  // The live transcript kept the words from before the pause while the key was still held.
  const shown = await transcripts();
  console.log(`push-to-talk live transcript: ${JSON.stringify(shown)}`);
  expect(shown.some(text => /check the build/i.test(text) && /run the tests/i.test(text)), JSON.stringify(shown)).toBe(true);

  // Normal session delivery when each countdown ends: each hold reaches its own agent, once.
  await expect(pendingCards(page)).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => receipts(daemon).length, { timeout: 30_000 }).toBe(2);
  const delivered = receipts(daemon);
  console.log(`receipts: ${JSON.stringify(delivered)}`);
  const words = (text: string) => text.toLowerCase().replaceAll(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean).join(" ");
  expect(delivered.map(row => [row.note_key, words(row.spoken_words)])).toEqual([
    [steve.agentSessionId, "check the build then bagel run the tests and report back"],
    [carol.agentSessionId, "give me a report on the status of some project"],
  ]);
  expect((await heard(page, daemon)).map(entry => entry.outcome)).toEqual(["sent", "sent"]);

  // The Always-on settings keep their saved values and say why they do not apply.
  await openVoiceTab(page, "Listening", daemon.baseURL);
  const delay = page.getByRole("combobox", { name: "End-of-speech delay" });
  await expect(delay).toBeDisabled();
  await expect(delay).toHaveValue(String(SAVED_DELAY_MS));
  await expect(page.locator('[data-anchor="voice/end-of-speech"]')).toContainText("Applies to Always-on listening. Push-to-talk ends on key release.");
  const separator = page.getByRole("textbox", { name: "Separator word" });
  await expect(separator).toBeDisabled();
  await expect(separator).toHaveValue("bagel");
  await expect(page.locator('[data-anchor="voice/separator"]')).toContainText("Applies to Always-on listening. In Push-to-talk the word is ordinary speech.");
  await captureCard(page.getByRole("group", { name: "Ending a message" }), "push-to-talk-always-on-settings");
});

test("native Always-on still ends a message at the saved delay and splits at the separator", async ({ dashboard: page, daemon }) => {
  const models = process.env.MISSION_LONG_VOICE_MODELS;
  test.skip(process.platform !== "darwin" || !models, "Requires installed macOS FluidAudio models");
  test.setTimeout(300_000);
  // The pause ends the first capture; the separator splits the second one.
  const wav = await synthesize(daemon, "always-on", "Steve, check the build. [[slnc 3500]] Carol, run the tests bagel Steve, report back.");
  await setupCards(page, daemon, 30);
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", {
    data: { listeningMode: "always-on", endOfSpeechMs: SAVED_DELAY_MS, separatorWord: "bagel" },
  })).ok()).toBe(true);
  await runningAgent(page, daemon, "Steve");
  await runningAgent(page, daemon, "Carol");
  await nativeListener(daemon, models!, wav, { MISSION_LONG_VOICE_HELD: "0" });
  await expect.poll(async () => (await heard(page, daemon)).length, { timeout: 30_000 }).toBe(3);
  const entries = (await heard(page, daemon)).toReversed();
  console.log(`always-on: ${entries.map(e => `${e.id} ${e.matchedName}: "${e.text}"`).join(" | ")}`);
  const capture = (entry: HeardEntry) => entry.id.replace(/:\d+$/u, "");
  const [build, tests, report] = entries;
  expect(build).toMatchObject({ matchedName: "Steve" });
  expect(build!.text).toMatch(/check the build/i);
  expect(build!.id).not.toContain(":");
  expect(tests).toMatchObject({ matchedName: "Carol" });
  expect(tests!.text).toMatch(/run the tests/i);
  expect(report).toMatchObject({ matchedName: "Steve" });
  expect(report!.text).toMatch(/report back/i);
  expect([tests!.id.match(/:(\d+)$/u)?.[1], report!.id.match(/:(\d+)$/u)?.[1]]).toEqual(["1", "2"]);
  expect(capture(tests!)).toBe(capture(report!));
  expect(capture(build!)).not.toBe(capture(tests!));
  for (const entry of entries) expect(entry.text).not.toMatch(/\bbagel\b/i);
  await expect(pendingCards(page)).toHaveCount(3);
  await captureCard(page, "always-on-delay-and-separator");
});
