import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page, Route } from "@playwright/test";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";
import { captureCard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { beListener, enableVoice, say } from "../fixtures/voice.ts";
import { openVoiceTab } from "../fixtures/voice-settings.ts";

const EXAMPLE = "Steve, check the build, bagel, Carol, give me a report on the status of some project";

function pending(page: Page, name: string) {
  return page.getByRole("status").filter({ hasText: "To " + name }).filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) });
}

async function voiceConfig(page: Page, daemon: DaemonHandle) {
  return (await (await page.request.get(daemon.baseURL + "/api/voice/config")).json()).config;
}

async function heard(page: Page, daemon: DaemonHandle): Promise<{ id: string; text: string; matchedName: string | null; rule: string }[]> {
  return (await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries;
}

test("the separator word is a Listening setting that persists, validates and is disabled in Push-to-talk", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/fleet");
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox", { name: "Search everything" }).fill("bagel");
  await page.getByRole("option", { name: /Separator word, setting/ }).click();
  const row = page.locator('[data-anchor="voice/separator"]');
  await expect(row).toHaveClass(/settings-flash/);
  const field = page.getByRole("textbox", { name: "Separator word" });
  await expect(field).toHaveValue("bagel");
  await expect(row).toContainText("Say it between two messages to send both without pausing.");
  await expect(row).toContainText("“Steve, check the build, bagel, Carol, report status.”");

  await field.fill("pineapple");
  await field.press("Enter");
  await expect.poll(async () => (await voiceConfig(page, daemon)).separatorWord).toBe("pineapple");
  await expect(row).toContainText("Steve, check the build, pineapple, Carol");
  await page.reload();
  await expect(field).toHaveValue("pineapple");

  // A command word or a phrase is refused where it was typed, and the saved word stays.
  await field.fill("cancel");
  await field.press("Enter");
  await expect(row.getByRole("alert")).toHaveText("“cancel” is already a voice command. Choose another word.");
  await expect(field).toHaveValue("pineapple");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await field.fill("two words");
  await field.press("Tab");
  await expect(row.getByRole("alert")).toHaveText("Use one word of letters, numbers, apostrophes or hyphens.");
  await captureCard(row, "separator-setting-invalid");
  // Escape abandons an edit; an empty field restores the default.
  await field.fill("waffle");
  await field.press("Escape");
  await expect(field).toHaveValue("pineapple");
  expect((await voiceConfig(page, daemon)).separatorWord).toBe("pineapple");
  await field.fill("");
  await field.press("Enter");
  await expect.poll(async () => (await voiceConfig(page, daemon)).separatorWord).toBe("bagel");
  await expect(row.getByRole("alert")).toHaveCount(0);
  await captureCard(row, "separator-setting-always-on");

  await page.getByRole("combobox", { name: "Listening mode" }).selectOption("push-to-talk");
  await expect(field).toBeDisabled();
  await expect(row).toContainText("Applies to Always-on listening. In Push-to-talk the word is ordinary speech.");
  await expect(row).not.toContainText("Say it between two messages");
  await captureCard(row, "separator-setting-push-to-talk");
});

test("a separator word the daemon refuses to save says so and keeps the saved word", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const row = page.locator('[data-anchor="voice/separator"]');
  const field = page.getByRole("textbox", { name: "Separator word" });
  await expect(field).toHaveValue("bagel");
  let refused = 0;
  await page.route("**/api/voice/config", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    refused++;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "save_failed" }) });
  });
  await field.fill("waffle");
  await field.press("Enter");
  await expect(row.getByRole("alert")).toHaveText("The separator word was not saved. Try again.");
  await expect(field, "the field returns to the word the daemon holds").toHaveValue("bagel");
  await expect(row).toContainText("Steve, check the build, bagel, Carol");
  expect(refused).toBe(1);
  expect((await voiceConfig(page, daemon)).separatorWord).toBe("bagel");
  await captureCard(row, "separator-setting-save-failed");

  await page.unroute("**/api/voice/config");
  await field.fill("waffle");
  await field.press("Enter");
  await expect.poll(async () => (await voiceConfig(page, daemon)).separatorWord).toBe("waffle");
  await expect(row.getByRole("alert")).toHaveCount(0);
  await expect(field).toHaveValue("waffle");
});

test("a refusal of an earlier separator save does not mark a newer saved word invalid", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const row = page.locator('[data-anchor="voice/separator"]');
  const field = page.getByRole("textbox", { name: "Separator word" });
  await expect(field).toHaveValue("bagel");
  const held = Promise.withResolvers<Route>();
  let puts = 0;
  await page.route("**/api/voice/config", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    if (++puts === 1) return held.resolve(route);
    return route.continue();
  });
  await field.fill("waffle");
  await field.press("Enter");
  const first = await held.promise;
  // A newer word is saved while the first request is still pending; then the first is refused.
  await field.fill("pancake");
  await field.press("Enter");
  await first.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "save_failed" }) });
  await expect.poll(async () => (await voiceConfig(page, daemon)).separatorWord).toBe("pancake");
  await expect(field).toHaveValue("pancake");
  await expect(row.getByRole("alert"), "the refusal belonged to the superseded edit").toHaveCount(0);
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
  expect(puts).toBe(2);
});

test("a refusal that arrives while a newer separator draft is being typed leaves that draft unmarked", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const row = page.locator('[data-anchor="voice/separator"]');
  const field = page.getByRole("textbox", { name: "Separator word" });
  await expect(field).toHaveValue("bagel");
  const held = Promise.withResolvers<Route>();
  await page.route("**/api/voice/config", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    return held.resolve(route);
  }, { times: 1 });
  await field.fill("waffle");
  await field.press("Enter");
  const first = await held.promise;
  // The operator starts a new draft, not yet saved, while the first save is pending.
  await field.fill("crumpet");
  await first.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "save_failed" }) });
  await expect(page.getByText("That change didn't stick: save_failed")).toBeVisible();
  await expect(row.getByRole("alert"), "the refusal belonged to the earlier save").toHaveCount(0);
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveValue("crumpet");
});

test("one Always-on capture with the separator shows two confirmations, each with its own Cancel", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  await runningAgent(page, daemon, "Carol");
  const listener = await beListener(daemon);
  try {
    expect(await (await say(daemon, EXAMPLE, { id: "two-messages" })).json()).toEqual({ accepted: true });
    const steve = pending(page, "Steve");
    const carol = pending(page, "Carol");
    await expect(steve).toContainText("check the build");
    await expect(carol).toContainText("give me a report on the status of some project");
    await expect(steve).not.toContainText(/bagel/i);
    await expect(carol).not.toContainText(/bagel/i);
    await captureCard(page, "separator-two-confirmations");

    await steve.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(steve).toHaveCount(0);
    await expect(carol).toHaveCount(1);
    await carol.getByRole("button", { name: "Send now" }).click();
    await expect(carol).toHaveCount(0);

    // A capture of only the separator routes nothing and says why.
    expect(await (await say(daemon, "Bagel.")).json()).toEqual({ accepted: true });
    await openVoiceTab(page, "Recently heard", daemon.baseURL);
    const history = page.getByRole("region", { name: "Recently heard" });
    await expect(history.getByRole("row").filter({ hasText: "separator word only" })).toContainText("Bagel.");
    await expect(history.getByRole("row").filter({ hasText: "Steve, check the build" })).toContainText("Cancelled");
    await expect(history.getByRole("row").filter({ hasText: "Carol, give me a report" })).toBeVisible();
    await captureCard(history, "separator-recently-heard");
  } finally { listener.stop(); }
});

test("turning Voice off ends a separated capture whose later message was waiting for a slot", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  await runningAgent(page, daemon, "Carol");
  const listener = await beListener(daemon);
  try {
    // 49 open confirmations leave one slot: Steve's message takes it and Carol's is refused.
    for (let i = 0; i < 49; i++) expect(await (await say(daemon, `Steve, task ${i}`)).json()).toEqual({ accepted: true });
    expect(await (await say(daemon, EXAMPLE, { id: "waiting" })).json()).toEqual({ accepted: false });
    await expect(pending(page, "Steve").filter({ hasText: "check the build" })).toHaveCount(1);
    await expect(pending(page, "Carol")).toHaveCount(0);

    // The operator turns Voice off, which clears every pending action, and back on.
    await page.goto(daemon.baseURL + "/#/settings/feature-flags");
    const toggle = page.getByRole("button", { name: /^Voice addressing:/ });
    await toggle.click();
    await expect(toggle).toHaveAccessibleName("Voice addressing: off");
    await expect(page.getByRole("status").filter({ hasText: "To Steve" })).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAccessibleName("Voice addressing: on");

    // Back on the dashboard, which confirms focus for routing, a retry of the same capture now
    // has free slots but opens none of its messages.
    await page.goto(daemon.baseURL + "/#/fleet");
    await expect(page.getByRole("button", { name: "Voice: listening. Mute" })).toBeVisible();
    expect(await (await say(daemon, EXAMPLE, { id: "waiting" })).json()).toEqual({ accepted: true });
    await expect(page.getByRole("status").filter({ hasText: /To (Steve|Carol)/ })).toHaveCount(0);
    expect((await heard(page, daemon)).some(entry => entry.id.startsWith("waiting:"))).toBe(false);
    // Fresh speech still separates normally after the clear.
    expect(await (await say(daemon, EXAMPLE)).json()).toEqual({ accepted: true });
    await expect(pending(page, "Carol")).toContainText("give me a report on the status of some project");
    await captureCard(page, "separator-cleared-capture");
  } finally { listener.stop(); }
});

const execute = promisify(execFile);

async function synthesize(daemon: DaemonHandle, name: string, words: string): Promise<string> {
  const wav = join(daemon.home, name + ".wav");
  await execute("/usr/bin/say", ["-v", "Samantha", "-o", wav, "--file-format=WAVE", "--data-format=LEI16@16000", words]);
  return wav;
}

/** The production Swift listener loop, fed synthesized speech at microphone callback pace. */
function nativeListener(daemon: DaemonHandle, models: string, wav: string, env: Record<string, string> = {}) {
  return execute("swift", ["test", "-c", "release", "--package-path", "native/voice-listener", "--filter", "ContinuousSpeechTests.testContinuousDesktopCapture"], {
    env: { ...process.env, MISSION_LONG_VOICE_NATURAL: "1", MISSION_LONG_VOICE_WAV: wav, MISSION_VOICE_MODEL_DIR: models,
      MISSION_VOICE_LISTENER_INSTANCE: "desktop-cpu", MISSION_VOICE_DAEMON_URL: daemon.baseURL,
      MISSION_VOICE_TOKEN_FILE: join(daemon.home, "token"), ...env }, timeout: 240_000,
  }).then(({ stdout }) => console.log(stdout));
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

for (const variant of [
  { label: "the default word", word: "bagel" },
  { label: "a custom word", word: "pineapple" },
]) test(`native Always-on speech with ${variant.label} and no pause around it`, async ({ dashboard: page, daemon }) => {
  const models = process.env.MISSION_LONG_VOICE_MODELS;
  test.skip(process.platform !== "darwin" || !models, "Requires installed macOS FluidAudio models");
  test.setTimeout(300_000);
  // No commas around the word: the synthesizer runs straight through it.
  const wav = await synthesize(daemon, "separator", `Steve, check the build ${variant.word} Carol, give me a report on the status of some project.`);
  await setupCards(page, daemon, 30);
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", {
    data: { endOfSpeechMs: 2000, listeningMode: "always-on", separatorWord: variant.word },
  })).ok()).toBe(true);
  await runningAgent(page, daemon, "Steve");
  await runningAgent(page, daemon, "Carol");
  const transcripts = await recordTranscripts(page);
  const native = nativeListener(daemon, models!, wav, { MISSION_LONG_VOICE_HELD: "0" });
  await Promise.all([native, expect(pending(page, "Steve")).toContainText(/check the build/i, { timeout: 200_000 })]);
  await expect(pending(page, "Carol")).toContainText(/report on the status of some project/i);
  await captureCard(page, "native-separator-" + variant.word);
  // The native listener's live partials still show the separator: splitting happens only at routing.
  const shown = await transcripts();
  const word = new RegExp(`\\b${variant.word}\\b`, "i");
  const partials = shown.filter(text => word.test(text) && !/project/i.test(text));
  expect(partials.length, JSON.stringify(shown)).toBeGreaterThan(0);
  expect(shown.some(text => word.test(text) && /project/i.test(text)), JSON.stringify(shown)).toBe(true);
  console.log(`${variant.word} live transcript: ${JSON.stringify(shown)}`);
  const entries = await heard(page, daemon);
  expect(entries).toHaveLength(2);
  for (const entry of entries) expect(entry.text).not.toMatch(word);
  // Both messages came from one microphone segment: the listener never saw a pause.
  const captures = new Set(entries.map(entry => entry.id.replace(/:\d+$/u, "")));
  expect(captures.size).toBe(1);
  expect(entries.map(entry => entry.id.match(/:(\d+)$/u)?.[1]).toSorted()).toEqual(["1", "2"]);
  console.log(`${variant.word}: one capture ${[...captures][0]} became ${entries.map(e => `${e.matchedName}: "${e.text}"`).join(" and ")}`);
});

test("native Always-on keeps whole words, sends no empty messages and keeps the separator in live partials", async ({ dashboard: page, daemon }) => {
  const models = process.env.MISSION_LONG_VOICE_MODELS;
  test.skip(process.platform !== "darwin" || !models, "Requires installed macOS FluidAudio models");
  test.setTimeout(300_000);
  // Three utterances, each ended by silence longer than the end-of-speech delay: a longer word that
  // contains the separator, the separator alone, and a message with the separator at both ends.
  const wav = await synthesize(daemon, "boundaries", "Steve, buy some bagels for the team. [[slnc 3500]] Bagel. [[slnc 3500]] " +
    "bagel Carol, check the build bagel");
  await setupCards(page, daemon, 30);
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", {
    data: { endOfSpeechMs: 2000, listeningMode: "always-on", separatorWord: "bagel" },
  })).ok()).toBe(true);
  await runningAgent(page, daemon, "Steve");
  await runningAgent(page, daemon, "Carol");
  const transcripts = await recordTranscripts(page);
  await nativeListener(daemon, models!, wav, { MISSION_LONG_VOICE_HELD: "0" });
  await expect.poll(async () => (await heard(page, daemon)).length, { timeout: 30_000 }).toBe(3);
  const captured = (await heard(page, daemon)).toReversed();
  console.log(`boundaries: ${captured.map(e => `${e.id} ${e.rule} ${e.matchedName}: "${e.text}"`).join(" | ")}`);
  const [whole, alone, ends] = captured;
  // Word boundary: "bagels" is an ordinary word, so the first capture routes whole.
  expect(whole).toMatchObject({ matchedName: "Steve", rule: "exact" });
  expect(whole!.text).toMatch(/\bbagels\b/i);
  expect(whole!.id).not.toContain(":");
  await expect(pending(page, "Steve")).toContainText(/buy some bagels for the team/i);
  // Empty segment: the separator alone opens nothing.
  expect(alone).toMatchObject({ rule: "separator-only", matchedName: null });
  expect(alone!.text).toMatch(/^bagel\W*$/i);
  // Separators at both ends leave one message and no empty ones.
  expect(ends).toMatchObject({ matchedName: "Carol" });
  expect(ends!.id).toMatch(/:1$/u);
  expect(ends!.text).not.toMatch(/\bbagel\b/i);
  await expect(pending(page, "Carol")).toContainText(/check the build/i);
  await expect(pending(page, "Carol")).not.toContainText(/bagel/i);
  await expect(page.getByRole("status").filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) })).toHaveCount(2);
  await captureCard(page, "native-separator-boundaries");
  // The live partials are what was said, including the separator the router removed.
  const shown = await transcripts();
  expect(shown.some(text => /\bbagels\b/i.test(text)), JSON.stringify(shown)).toBe(true);
  expect(shown.some(text => /\bbagel\b.*\bcarol\b/i.test(text)), JSON.stringify(shown)).toBe(true);
  console.log(`boundaries live transcript: ${JSON.stringify(shown)}`);
});

test("native Always-on applies a separator edit made while the microphone is listening", async ({ dashboard: page, daemon }) => {
  const models = process.env.MISSION_LONG_VOICE_MODELS;
  test.skip(process.platform !== "darwin" || !models, "Requires installed macOS FluidAudio models");
  test.setTimeout(300_000);
  const before = await synthesize(daemon, "before-edit", "Steve, check the build bagel Carol, run the tests.");
  // After the edit, "bagel" is an ordinary word, "pineapple" separates, and a lone "Pineapple" sends nothing.
  const after = await synthesize(daemon, "after-edit", "Steve, toast a bagel please pineapple Carol, give me a report on the status of some project. " +
    "[[slnc 3500]] Pineapple.");
  await setupCards(page, daemon, 30);
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", {
    data: { endOfSpeechMs: 2000, listeningMode: "always-on", separatorWord: "bagel" },
  })).ok()).toBe(true);
  await runningAgent(page, daemon, "Steve");
  await runningAgent(page, daemon, "Carol");
  const native = nativeListener(daemon, models!, before, { MISSION_LONG_VOICE_HELD: "0", MISSION_LONG_VOICE_SECOND_WAV: after,
    MISSION_LONG_VOICE_EDITED_SEPARATOR: "pineapple" });
  // Stop waiting if the listener ends before the edit; `await native` below reports its own failure.
  const early = native.then(() => { throw new Error("The native listener finished before the separator edit"); });
  early.catch(() => {});
  await Promise.race([early, expect.poll(async () => (await heard(page, daemon)).length, { timeout: 200_000 }).toBe(2)]);
  const first = (await heard(page, daemon)).toReversed();
  expect(first.map(entry => [entry.matchedName, entry.id.match(/:(\d+)$/u)?.[1]])).toEqual([["Steve", "1"], ["Carol", "2"]]);

  // The operator edits the word in Settings while the same microphone keeps listening.
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const field = page.getByRole("textbox", { name: "Separator word" });
  await field.fill("pineapple");
  await field.press("Enter");
  await expect.poll(async () => (await voiceConfig(page, daemon)).separatorWord).toBe("pineapple");
  await native;

  await expect.poll(async () => (await heard(page, daemon)).length, { timeout: 30_000 }).toBe(5);
  const entries = (await heard(page, daemon)).toReversed();
  console.log(`live edit: ${entries.map(e => `${e.id} ${e.rule} ${e.matchedName}: "${e.text}"`).join(" | ")}`);
  const [, , steve, carol, alone] = entries;
  const capture = (entry: typeof steve) => entry!.id.replace(/:\d+$/u, "");
  expect(steve).toMatchObject({ matchedName: "Steve" });
  expect(steve!.text).toMatch(/toast a bagel,? please\W*$/i);
  expect(carol).toMatchObject({ matchedName: "Carol" });
  expect(carol!.text).toMatch(/give me a report on the status of some project/i);
  expect(carol!.text).not.toMatch(/pineapple/i);
  expect(capture(steve)).toBe(capture(carol));
  expect(capture(steve)).not.toBe(capture(first[0]));
  expect(alone).toMatchObject({ rule: "separator-only", matchedName: null });
  expect(alone!.text).toMatch(/^pineapple\W*$/i);
  await page.goto(daemon.baseURL + "/#/fleet");
  await expect(pending(page, "Carol").filter({ hasText: /give me a report/i })).toHaveCount(1);
  await captureCard(page, "native-separator-live-edit");
});

test("native Push-to-talk ends each utterance on key release and keeps the separator as text", async ({ dashboard: page, daemon }) => {
  const models = process.env.MISSION_LONG_VOICE_MODELS;
  test.skip(process.platform !== "darwin" || !models, "Requires installed macOS FluidAudio models");
  test.setTimeout(300_000);
  const first = await synthesize(daemon, "first-hold", "Steve, check the build bagel then run the tests.");
  const second = await synthesize(daemon, "second-hold", "Carol, give me a report on the status of some project.");
  await setupCards(page, daemon, 30);
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", {
    data: { listeningMode: "push-to-talk", separatorWord: "bagel" },
  })).ok()).toBe(true);
  await runningAgent(page, daemon, "Steve");
  await runningAgent(page, daemon, "Carol");
  // Two presses of the registered shortcut: each release ends its utterance.
  await nativeListener(daemon, models!, first, { MISSION_LONG_VOICE_DEDICATED: "1", MISSION_LONG_VOICE_SECOND_WAV: second });
  await expect(pending(page, "Steve")).toContainText(/check the build,? bagel,? then run the tests/i);
  await expect(pending(page, "Carol")).toContainText(/report on the status of some project/i);
  await expect(pending(page, "Steve")).toHaveCount(1);
  await captureCard(page, "native-separator-push-to-talk");
  const entries = (await heard(page, daemon)).toReversed();
  expect(entries.map(entry => entry.matchedName)).toEqual(["Steve", "Carol"]);
  expect(entries[0]!.text).toMatch(/\bbagel\b/i);
  // Two holds, two captures: neither was split at the separator.
  expect(entries.every(entry => !entry.id.includes(":"))).toBe(true);
  expect(new Set(entries.map(entry => entry.id)).size).toBe(2);
  console.log(`push-to-talk: ${entries.map(e => `${e.id} ${e.matchedName}: "${e.text}"`).join(" | ")}`);
});
