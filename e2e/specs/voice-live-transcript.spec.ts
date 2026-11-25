import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { test, expect } from "../fixtures/test.ts";
import { beListener, enableVoice, sendHello, transcriptSample } from "../fixtures/voice.ts";

test("live capture shows readiness, onset and rolling words in the saved overlay", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const overlay = page.getByRole("complementary", { name: "Live voice transcript" });
  const status = page.getByRole("status", { name: "Voice feedback" });
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
  await style.hover();
  await expect(page.locator(".tooltip").filter({ hasText: "Choose a wrapping corner card or a bottom-center capsule" })).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(overlay).toHaveCount(0);
  const listener = await beListener(daemon);
  try {
    const onset = 1;
    await expect(page.getByRole("button", { name: "Voice: listening. Mute" })).toBeVisible();
    await expect(overlay).toHaveCount(0);
    await expect(status).toBeEmpty();
    expect(await transcriptSample(daemon, { phase: "ready" })).toBe(true);
    await expect(overlay).toHaveText("Microphone ready");
    await expect(status).toHaveText("Microphone ready");
    await capture("ready");
    expect(await transcriptSample(daemon, { phase: "audio", onset })).toBe(true);
    await expect(overlay).toHaveText("Audio detected");
    await expect(status).toHaveText("Audio detected");
    await capture("audio");
    const words = "a few ordinary words from the microphone before any name matches are already visible in this corner as the speaker continues talking".split(" ");
    const phrase = (n: number) => transcriptSample(daemon, { phase: "words", onset, text: words.slice(0, n).join(" ") });
    expect(await phrase(3)).toBe(true);
    await expect(overlay.locator("span")).toHaveText("a few ordinary");
    await expect(status).toHaveText("Transcribing");
    expect(await phrase(words.length)).toBe(true);
    await expect(overlay.locator("span")).toHaveText(words.slice(-20).join(" "));
    await expect(overlay.locator("strong")).toHaveText("Transcribing");
    await expect(status).toHaveText("Transcribing");
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
    await expect.poll(() => phrase(4)).toBe(true);
    await expect(overlay.locator("span")).toHaveText("a few ordinary words");
    listener.stop();
    await sendHello(daemon, { microphone: "denied" });
    await expect(page.getByRole("button", { name: "Voice: not listening. Open Setup" })).toBeVisible();
    await expect(overlay).toHaveCount(0);
    await expect(status).toBeEmpty();
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

test("all 100 long words remain readable in a short window with the status in view", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const limit = page.getByLabel("Maximum transcript words");
  await limit.fill("100");
  await limit.press("Enter");
  const listener = await beListener(daemon);
  try {
    await page.setViewportSize({ width: 800, height: 360 });
    const words = Array.from({ length: 100 }, (_, i) => "acknowledgement" + (i + 1)).join(" ");
    expect(await transcriptSample(daemon, { phase: "words", onset: 1, text: words })).toBe(true);
    const overlay = page.getByRole("complementary", { name: "Live voice transcript" });
    const body = overlay.locator("span");
    await expect(body).toHaveText(words);
    const box = (await overlay.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(16);
    expect(box.y + box.height).toBeLessThanOrEqual(360);
    await expect(overlay.locator("strong")).toBeInViewport({ ratio: 1 });
    expect(await body.evaluate(el => el.scrollHeight)).toBeGreaterThan((await body.boundingBox())!.height);
    await body.click();
    await page.keyboard.press("End");
    await expect.poll(() => body.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
    await expect(overlay.locator("strong")).toBeInViewport({ ratio: 1 });
    if (process.env.MC_E2E_EVIDENCE) {
      const dir = artifactsDir("live-transcript");
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, "short-window.png") });
    }
  } finally { listener.stop(); }
});

test("live transcript controls use the same typography as the other settings rows", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const group = page.getByRole("group", { name: "Live transcript" });
  const font = (el: Element) => {
    const css = getComputedStyle(el);
    return { family: css.fontFamily, size: css.fontSize, weight: css.fontWeight };
  };
  const reference = await page.getByText("Listening mode", { exact: true }).evaluate(font);
  for (const name of ["Show live transcript", "Transcript style", "Maximum transcript words", "Corner card placement"]) {
    expect(await group.getByText(name, { exact: true }).first().evaluate(font), name).toEqual(reference);
  }
  const selectFont = await page.getByLabel("Listening mode", { exact: true }).evaluate(font);
  expect(await group.getByLabel("Transcript style").evaluate(font)).toEqual(selectFont);
  expect(await group.getByLabel("Corner card placement").evaluate(font)).toEqual(selectFont);
  const numberFont = await group.getByLabel("Maximum transcript words").evaluate(font);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("live-transcript");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, "settings-typography.png") });
  }
  await page.goto(daemon.baseURL + "/#/settings/worktrees");
  expect(numberFont).toEqual(await page.getByRole("spinbutton", { name: "Retention window (days)" }).evaluate(font));
});
