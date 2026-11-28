import { mkdirSync } from "node:fs";
import type { Locator } from "@playwright/test";
import { fixtureSupervisorEnv } from "../../test/helpers/voice-supervisor.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test as base } from "../fixtures/test.ts";
import { beSpeaker, enableVoice, startModelServer, type ModelServer } from "../fixtures/voice.ts";
import { openVoiceTab } from "../fixtures/voice-settings.ts";

const test = base.extend<{ models: ModelServer }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
  models: async ({}, use) => {
    const models = await startModelServer();
    try { await use(models); } finally { await models.close(); }
  },
  daemonEnv: async ({ models }, use) => {
    await use({ ...fixtureSupervisorEnv, ...models.env,
      MISSION_VOICE_SPEECH_MODEL_MANIFEST: models.env.MISSION_VOICE_MODEL_MANIFEST!,
      NODE_OPTIONS: "--import=" + new URL("../fixtures/voice-picker-synth.mjs", import.meta.url).href });
  },
});

async function capture(group: Locator, name: string) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const dir = artifactsDir("voice-picker");
  mkdirSync(dir, { recursive: true });
  await group.screenshot({ path: dir + name + ".png" });
}

test("selecting F4 starts the shared download and preserves the choice across cancel, failure and retry", async ({ dashboard: page, daemon, models }) => {
  await enableVoice(daemon);
  const speaker = await beSpeaker(daemon, { holdPlayback: true });
  try {
    await openVoiceTab(page, "Spoken replies", daemon.baseURL);
    const group = page.getByRole("region", { name: "Spoken replies" });
    const select = group.getByLabel("Voice", { exact: true });
    const status = group.getByRole("status");
    const saved = async () => (await (await page.request.get(daemon.baseURL + "/api/voice/config")).json()).config.speech.voice;
    await expect(select.locator("option:checked")).toHaveText("Automatic: Fixture");
    await expect(group.locator("optgroup[label=\"This Mac's voices\"]").locator("option")).toHaveText("Fixture (Enhanced)");
    await expect(group.locator('optgroup[label="Mission Control voices"]').locator("option")).toHaveText(["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"]);
    await expect(group.getByRole("link", { name: "What it restricts" })).toHaveAttribute("href", /supertonic-3\/blob\/main\/LICENSE$/);
    await expect(group).toContainText("OpenRAIL-M");
    expect(models.requests).toHaveLength(0);
    await capture(group, "automatic");
    models.serve(models.largeFile, "hold");
    await select.selectOption({ label: "F4" });
    await expect.poll(saved).toEqual({ engine: "neural", id: "supertonic-3/F4" });
    await expect(group.getByRole("progressbar")).toBeVisible();
    await expect(select.locator("option:checked")).toHaveText("F4, not available");
    await expect(group.getByRole("button", { name: "Play sample" })).toBeDisabled();
    await capture(group, "downloading");
    await group.getByRole("button", { name: "Cancel" }).click();
    await expect(group.getByRole("button", { name: /^Download/ })).toBeVisible();
    await page.reload();
    await openVoiceTab(page, "Spoken replies");
    await expect(select.locator("option:checked")).toHaveText("F4, not available");
    await expect(status).toContainText("Download the Mission Control voices");
    await capture(group, "f4-after-cancel");
    models.release();
    models.serve(models.largeFile, "corrupt");
    await group.getByRole("button", { name: /^Download/ }).click();
    await expect(group.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(status).toContainText("Retry");
    await expect(select.locator("option:checked")).toHaveText("F4, not available");
    await capture(group, "retry");
    models.serve(models.largeFile, "ok");
    await group.getByRole("button", { name: "Retry" }).click();
    await expect(status).toHaveText("Mission Control voice F4 will speak.");
    await expect(select.locator("option:checked")).toHaveText("F4");
    await expect(group.getByRole("button", { name: "Play sample" })).toBeEnabled();
    await capture(group, "f4-after-retry");
  } finally { await speaker.exit(); }
});

test("an uninterrupted download makes the chosen voice ready without another click", async ({ dashboard: page, daemon, models }) => {
  await enableVoice(daemon);
  const speaker = await beSpeaker(daemon);
  try {
    await openVoiceTab(page, "Spoken replies", daemon.baseURL);
    const group = page.getByRole("region", { name: "Spoken replies" });
    models.serve(models.largeFile, "hold");
    await group.getByRole("link", { name: "What it restricts" }).focus();
    await expect(page.locator(".tooltip").filter({ hasText: "Read the model licence and its use restrictions" })).toBeVisible();
    await capture(group, "licence-tooltip");
    await group.getByRole("combobox").selectOption({ label: "F4" });
    await expect(group.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "49");
    models.release();
    await expect(group.getByRole("status")).toHaveText("Mission Control voice F4 will speak.");
    await expect(group.getByRole("combobox").locator("option:checked")).toHaveText("F4");
    await expect(group.getByRole("button", { name: /^Download/ })).toHaveCount(0);
  } finally { await speaker.exit(); }
});

test("Automatic downloads only on request and the listener plays Willow when Automatic would choose Fixture", async ({ dashboard: page, daemon, models }) => {
  await enableVoice(daemon);
  await openVoiceTab(page, "Spoken replies", daemon.baseURL);
  const group = page.getByRole("region", { name: "Spoken replies" });
  const select = group.getByRole("combobox", { name: "Voice", exact: true });
  const play = group.getByRole("button", { name: "Play sample" });
  await expect(play).toBeDisabled();
  await expect(play).toHaveAccessibleDescription(/No listener is running/);
  const speaker = await beSpeaker(daemon, { holdPlayback: true, systemVoices: [
    { id: "fixture", name: "Fixture", language: "en-US", quality: "enhanced" },
    { id: "willow", name: "Willow", language: "en-US", quality: "default" },
  ] });
  try {
    await expect(select.locator("option:checked")).toHaveText("Automatic: Fixture");
    await select.selectOption({ label: "Willow (Standard)" });
    for (const stop of [false, true]) {
      await play.click();
      await expect.poll(() => speaker.playing).toBe(true);
      await expect(group.getByRole("button", { name: "Stop" })).toBeVisible();
      expect(await speaker.poll()).toMatchObject({ capture: false, speak: { kind: "system", voiceId: "willow" } });
      if (stop) await group.getByRole("button", { name: "Stop" }).click();
      else {
        await capture(group, "speaking");
        await speaker.end();
      }
      await expect(play).toBeEnabled();
    }
    await select.selectOption("");
    await expect(select.locator("option:checked")).toHaveText("Automatic: Fixture");
    expect(models.requests).toHaveLength(0);
    await group.getByRole("button", { name: /^Download/ }).click();
    await expect(select.locator("option:checked")).toHaveText("Automatic: Mission Control voice F4");
    await expect(group.getByRole("status")).toHaveText("Mission Control voice F4 will speak.");
    await capture(group, "ready");
  } finally { await speaker.exit(); }
});

test("a Linux player omits the Mac group and keeps a restored missing system voice silent", async ({ dashboard: page, daemon, models }) => {
  await enableVoice(daemon);
  const speaker = await beSpeaker(daemon, { systemVoices: [] });
  try {
    await openVoiceTab(page, "Spoken replies", daemon.baseURL);
    const group = page.getByRole("region", { name: "Spoken replies" });
    await expect(group.getByRole("status")).toContainText("No voice is ready.");
    expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { speech: { voice: { engine: "system", id: "Ava" } } } })).ok()).toBe(true);
    await page.reload();
    await openVoiceTab(page, "Spoken replies");
    await expect(group.getByRole("combobox").locator("option:checked")).toHaveText("Ava, not available");
    await expect(group.locator("optgroup[label=\"This Mac's voices\"]")).toHaveCount(0);
    await expect(group.getByRole("status")).toContainText("System Settings > Accessibility > Read & Speak");
    await expect(group.getByRole("button", { name: "Play sample" })).toBeDisabled();
    expect(models.requests).toHaveLength(0);
    await capture(group, "missing-system");
  } finally { await speaker.exit(); }
});

test("a listener without playback keeps questions on screen even with F4 downloaded", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const speaker = await beSpeaker(daemon, { audio: false, systemVoices: [] });
  try {
    await openVoiceTab(page, "Spoken replies", daemon.baseURL);
    const group = page.getByRole("region", { name: "Spoken replies" });
    const play = group.getByRole("button", { name: "Play sample" });
    const picker = group.getByRole("combobox");
    await picker.selectOption({ label: "F4" });
    await expect(picker.locator("option:checked")).toHaveText("F4");
    await expect(group.getByText("Mission Control voices are not downloaded.")).toHaveCount(0);
    await expect(play).toBeDisabled();
    await expect(play).toHaveAccessibleDescription(/This listener cannot play speech. Questions appear on screen/);
    await openVoiceTab(page, "Names & routing");
    await expect(page.getByRole("radio", { name: "Ask aloud" })).toBeDisabled();
    await openVoiceTab(page, "Spoken replies");
    await expect(group.locator("optgroup[label=\"This Mac's voices\"]")).toHaveCount(0);
    expect((await speaker.poll()).speak).toBeNull();
    await capture(group, "shipping-fallback");
  } finally { await speaker.exit(); }
});

test("Speak replies aloud stops a playing sample, keeps samples off until turned back on, and is saved", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const speaker = await beSpeaker(daemon, { holdPlayback: true });
  try {
    await openVoiceTab(page, "Spoken replies", daemon.baseURL);
    const group = page.getByRole("region", { name: "Spoken replies" });
    const toggle = group.getByRole("checkbox", { name: "Speak replies aloud" });
    const play = group.getByRole("button", { name: "Play sample" });
    const status = group.getByRole("status");
    const saved = async () => (await (await page.request.get(daemon.baseURL + "/api/voice/config")).json()).config.speech.playback;
    await expect(toggle).toBeChecked();
    await expect(status).toHaveText("Fixture will speak.");
    await play.click();
    await expect.poll(() => speaker.playing).toBe(true);
    await expect(group.getByRole("button", { name: "Stop" })).toBeVisible();

    await toggle.uncheck();
    await expect.poll(saved).toBe(false);
    await expect.poll(() => speaker.playing, { message: "turning spoken replies off stops the playing sample" }).toBe(false);
    await expect(play).toBeDisabled();
    await expect(status).toHaveText("Spoken replies are off. Questions appear on screen. Turn on Speak replies aloud to hear them.");
    await expect(play).toHaveAccessibleDescription(/Spoken replies are off/);
    await expect(group.getByRole("combobox"), "the voice can still be chosen while spoken replies are off").toBeEnabled();
    await expect(group.getByRole("combobox").locator("option:checked")).toHaveText("Automatic: Fixture");
    await capture(group, "spoken-replies-off");

    await page.reload();
    await openVoiceTab(page, "Spoken replies");
    await expect(toggle, "the switch reads back the saved value").not.toBeChecked();
    await toggle.check();
    await expect.poll(saved).toBe(true);
    await expect(status).toHaveText("Fixture will speak.");
    await expect(play).toBeEnabled();
    await capture(group, "spoken-replies-on");
  } finally { await speaker.exit(); }
});

test("Play sample sends the selected ready F4 audition to the listener as audio", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const speaker = await beSpeaker(daemon, { holdPlayback: true });
  try {
    await openVoiceTab(page, "Spoken replies", daemon.baseURL);
    const group = page.getByRole("region", { name: "Spoken replies" });
    const select = group.getByRole("combobox");
    const play = group.getByRole("button", { name: "Play sample" });
    await select.selectOption({ label: "Fixture (Enhanced)" });
    await group.getByRole("button", { name: /^Download/ }).click();
    await expect(select.locator('option[value=""]')).toHaveText("Automatic: Mission Control voice F4");
    await select.selectOption({ label: "F4" });
    await expect(group.getByRole("status")).toHaveText("Mission Control voice F4 will speak.");

    const audition = page.waitForResponse(response => response.url().endsWith("/api/voice/speech/audition") && response.request().method() === "POST");
    await play.click();
    const response = await audition;
    expect(response.ok()).toBe(true);
    const { id } = await response.json();
    // Only an F4 synthesis request yields the fixture WAV. The listener fetches
    // it from this job's audio route before acknowledging playback.
    await expect.poll(() => speaker.playing).toBe(true);
    expect(await speaker.poll()).toMatchObject({ capture: false, speak: { id, kind: "audio" } });
    await expect(group.getByRole("button", { name: "Stop" })).toBeVisible();
    await capture(group, "f4-audition");
    await speaker.end();
    await expect(play).toBeEnabled();
  } finally { await speaker.exit(); }
});

test("a refused voice save restores the standard Mac voice; a refused download keeps the saved F4", async ({ dashboard: page, daemon, models }) => {
  await enableVoice(daemon);
  const speaker = await beSpeaker(daemon, { systemVoices: [
    { id: "samantha", name: "Samantha", language: "en-US", quality: "default" },
  ] });
  try {
    await openVoiceTab(page, "Spoken replies", daemon.baseURL);
    const group = page.getByRole("region", { name: "Spoken replies" });
    const select = group.getByRole("combobox");
    const saved = async () => (await (await page.request.get(daemon.baseURL + "/api/voice/config")).json()).config.speech.voice;
    await select.selectOption({ label: "Samantha (Standard)" });
    await expect.poll(saved).toEqual({ engine: "system", id: "samantha" });
    const downloadRequests: string[] = [];
    await page.route("**/api/voice/speech/model/download", route => {
      downloadRequests.push(route.request().method());
      return route.fulfill({ status: 409, json: { error: "model_unavailable", reason: "The model download is unavailable." } });
    });
    await page.route("**/api/voice/config", route => route.request().method() === "PUT"
      ? route.fulfill({ status: 503, json: { error: "Voice save refused" } }) : route.continue());
    await select.selectOption({ label: "F4" });
    await expect(page.getByText("That change didn't stick: Voice save refused", { exact: true })).toBeVisible();
    await expect(select.locator("option:checked")).toHaveText("Samantha (Standard)");
    expect(await saved()).toEqual({ engine: "system", id: "samantha" });
    expect(downloadRequests).toEqual([]);
    await capture(group, "standard-voice");

    await page.unroute("**/api/voice/config");
    await select.selectOption({ label: "F4" });
    await expect(group.getByRole("alert")).toHaveText("The model download is unavailable.");
    await expect(select.locator("option:checked")).toHaveText("F4, not available");
    expect(await saved()).toEqual({ engine: "neural", id: "supertonic-3/F4" });
    expect(downloadRequests).toEqual(["POST"]);
    expect(models.requests).toHaveLength(0);
    await expect(group.getByRole("button", { name: /^Download/ })).toBeEnabled();
    await capture(group, "download-refused");
  } finally { await speaker.exit(); }
});

test("a refused audition leaves Play sample available; a refused stop keeps the sample playing", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const speaker = await beSpeaker(daemon, { holdPlayback: true });
  try {
    await openVoiceTab(page, "Spoken replies", daemon.baseURL);
    const group = page.getByRole("region", { name: "Spoken replies" });
    const play = group.getByRole("button", { name: "Play sample" });
    const stop = group.getByRole("button", { name: "Stop" });
    await page.route("**/api/voice/speech/audition", route => route.fulfill({ status: 409,
      json: { error: "speech_busy", reason: "Speech is busy. Try again after playback ends." } }), { times: 1 });
    await play.click();
    await expect(group.getByRole("alert")).toHaveText("Speech is busy. Try again after playback ends.");
    await expect(play).toBeEnabled();
    expect((await speaker.poll()).speak).toBeNull();

    await play.click();
    await expect.poll(() => speaker.playing).toBe(true);
    await page.route("**/api/voice/speech/stop", route => route.fulfill({ status: 503, json: { error: "Stop refused" } }), { times: 1 });
    await stop.click();
    await expect(group.getByRole("alert")).toHaveText("Stop refused");
    await expect(stop).toBeEnabled();
    expect(speaker.playing).toBe(true);
    await capture(group, "stop-refused");
    await stop.click();
    await expect(play).toBeEnabled();
    await expect(group.getByRole("alert")).toHaveCount(0);
    expect(speaker.playing).toBe(false);
  } finally { await speaker.exit(); }
});

test("Stop interrupts a playing sample while the audition response is stalled", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const speaker = await beSpeaker(daemon, { holdPlayback: true });
  try {
    await openVoiceTab(page, "Spoken replies", daemon.baseURL);
    const group = page.getByRole("region", { name: "Spoken replies" });
    const accepted = Promise.withResolvers<string>();
    await page.route("**/api/voice/speech/audition", async route => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      accepted.resolve((await response.json()).id);
      // The daemon has accepted the audition, but the dashboard never receives its reply.
    }, { times: 1 });
    await group.getByRole("button", { name: "Play sample" }).click();
    const id = await accepted.promise;
    await expect.poll(() => speaker.playing).toBe(true);
    const stop = group.getByRole("button", { name: "Stop" });
    await expect(stop).toBeEnabled({ timeout: 1500 });
    await expect(group.getByRole("combobox")).toBeDisabled();
    await capture(group, "stop-pending-audition");
    const stopped = page.waitForRequest(request => request.url().endsWith("/api/voice/speech/stop"));
    await stop.click();
    expect((await stopped).postDataJSON()).toEqual({ id });
    await expect.poll(() => speaker.playing).toBe(false);
    await expect(group.getByRole("button", { name: "Play sample" })).toBeEnabled();
    await expect(group.getByRole("alert")).toHaveCount(0);
  } finally { await speaker.exit(); }
});

test("a stalled download request releases the picker and can be retried", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const speaker = await beSpeaker(daemon);
  try {
    await openVoiceTab(page, "Spoken replies", daemon.baseURL);
    const group = page.getByRole("region", { name: "Spoken replies" });
    const download = group.getByRole("button", { name: /^Download/ });
    await page.route("**/api/voice/speech/model/download", () => {}, { times: 1 });
    await download.click();
    await expect(group.getByRole("combobox")).toBeDisabled();
    await expect(download).toBeEnabled({ timeout: 9000 });
    await expect(group.getByRole("alert")).toBeVisible();
    await download.click();
    await expect(group.getByRole("status")).toHaveText("Mission Control voice F4 will speak.");
  } finally { await speaker.exit(); }
});

test("a refused cancellation keeps the F4 download in progress and allows Cancel again", async ({ dashboard: page, daemon, models }) => {
  await enableVoice(daemon);
  models.serve(models.largeFile, "hold");
  await openVoiceTab(page, "Spoken replies", daemon.baseURL);
  const group = page.getByRole("region", { name: "Spoken replies" });
  const progress = group.getByRole("progressbar");
  const cancel = group.getByRole("button", { name: "Cancel" });
  await group.getByRole("combobox").selectOption({ label: "F4" });
  await expect(progress).toHaveAttribute("aria-valuenow", "49");

  await page.route("**/api/voice/speech/model/download", route => {
    expect(route.request().method()).toBe("DELETE");
    return route.fulfill({ status: 503, json: { error: "Cancellation refused" } });
  }, { times: 1 });
  await cancel.click();
  await expect(group.getByRole("alert")).toHaveText("Cancellation refused");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuenow", "49");
  await expect(group.getByRole("combobox").locator("option:checked")).toHaveText("F4, not available");
  await expect(cancel).toBeEnabled();
  await capture(group, "cancel-refused");

  await cancel.click();
  await expect(group.getByRole("button", { name: /^Download/ })).toBeEnabled();
  await expect(progress).toHaveCount(0);
  await expect(group.getByRole("alert")).toHaveCount(0);
});

test("an audition that fails during playback reports the failure and can play again", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const speaker = await beSpeaker(daemon, { holdPlayback: true });
  try {
    await openVoiceTab(page, "Spoken replies", daemon.baseURL);
    const group = page.getByRole("region", { name: "Spoken replies" });
    const play = group.getByRole("button", { name: "Play sample" });
    await play.click();
    await expect.poll(() => speaker.playing).toBe(true);
    await expect(group.getByRole("button", { name: "Stop" })).toBeVisible();

    await speaker.end("failed");
    await expect(group.getByRole("alert")).toHaveText("The sample did not finish. Check the listener and try again.");
    await expect(play).toBeEnabled();
    await capture(group, "audition-failed");

    await play.click();
    await expect.poll(() => speaker.playing).toBe(true);
    await expect(group.getByRole("alert")).toHaveCount(0);
    await speaker.end();
    await expect(play).toBeEnabled();
    await expect(group.getByRole("alert")).toHaveCount(0);
  } finally { await speaker.exit(); }
});
