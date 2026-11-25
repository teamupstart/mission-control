import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { test, expect } from "../fixtures/test.ts";
import { beListener, enableVoice, sendHello, transcriptSample } from "../fixtures/voice.ts";

test("live capture shows readiness, onset and rolling words in the saved overlay", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const overlay = page.getByRole("complementary", { name: "Live voice transcript" });
  const show = page.getByLabel("Show live transcript");
  const style = page.getByLabel("Transcript style");
  const corner = page.getByLabel("Corner card placement");
  const limit = page.getByLabel("Maximum transcript words");
  const capture = async (name: string) => {
    if (!process.env.MC_E2E_EVIDENCE) return;
    const dir = artifactsDir("live-transcript");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, name + ".png") });
  };
  await expect(show).toBeChecked();
  await expect(style).toHaveValue("card");
  await expect(corner).toHaveValue("bottom-right");
  await expect(limit).toHaveValue("20");
  await expect(overlay).toHaveCount(0);
  const listener = await beListener(daemon);
  try {
    const onset = 1;
    await expect(page.getByRole("button", { name: "Voice: listening. Mute" })).toBeVisible();
    await expect(overlay).toHaveCount(0);
    expect(await transcriptSample(daemon, { phase: "ready" })).toBe(true);
    await expect(overlay).toHaveText("Microphone ready");
    await capture("ready");
    expect(await transcriptSample(daemon, { phase: "audio", onset })).toBe(true);
    await expect(overlay).toHaveText("Audio detected");
    await capture("audio");
    const words = "a few ordinary words from the microphone before any name matches are already visible in this corner as the speaker continues talking".split(" ");
    const phrase = (n: number) => transcriptSample(daemon, { phase: "words", onset, text: words.slice(0, n).join(" ") });
    expect(await phrase(3)).toBe(true);
    await expect(overlay.locator("span")).toHaveText("a few ordinary");
    expect(await phrase(words.length)).toBe(true);
    await expect(overlay.locator("span")).toHaveText(words.slice(-20).join(" "));
    await expect(overlay.locator("strong")).toHaveText("Transcribing");
    const viewport = page.viewportSize()!;
    const right = (await overlay.boundingBox())!;
    expect(right.x + right.width).toBeCloseTo(viewport.width - 16);
    expect((await overlay.locator("span").boundingBox())!.height).toBeGreaterThan(32);
    await capture("right");
    await corner.selectOption("bottom-left");
    await expect.poll(async () => (await overlay.boundingBox())?.x).toBe(16);
    await capture("left");
    await limit.fill("7");
    await limit.press("Enter");
    await expect(overlay.locator("span")).toHaveText(words.slice(-7).join(" "));
    await style.selectOption("capsule");
    await expect.poll(async () => {
      const box = await overlay.boundingBox();
      return box && Math.round(box.x + box.width / 2);
    }).toBe(Math.round(viewport.width / 2));
    await capture("capsule");
    await show.uncheck();
    await expect(overlay).toHaveCount(0);
    await page.reload();
    await expect(show).not.toBeChecked();
    await expect(style).toHaveValue("capsule");
    await expect(limit).toHaveValue("7");
    await style.selectOption("card");
    await expect(corner).toHaveValue("bottom-left");
    await show.check();
    await expect.poll(() => phrase(3)).toBe(true);
    await expect(overlay).toBeVisible();
    await page.getByRole("button", { name: "Voice: listening. Mute" }).click();
    await expect(overlay).toHaveCount(0);
    expect(await phrase(3)).toBe(false);
    await capture("muted");
    await page.getByRole("button", { name: "Voice: muted. Unmute" }).click();
    listener.stop();
    await sendHello(daemon, { microphone: "denied" });
    await expect(page.getByRole("button", { name: "Voice: not listening. Open Setup" })).toBeVisible();
    await expect(overlay).toHaveCount(0);
    const disabled = await page.request.put(daemon.baseURL + "/api/feature-flags", {
      data: { kind: "flag", id: "voice", enabled: false },
    });
    expect(disabled.ok()).toBe(true);
    await expect(show).toHaveCount(0);
    await expect(overlay).toHaveCount(0);
    expect((await page.request.post(daemon.baseURL + "/voice/listener/transcript", {
      data: { phase: "ready" },
    })).status()).toBe(404);
  } finally { listener.stop(); }
});
