import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { captureCard, setupCards } from "../fixtures/voice-cards.ts";
import { beListener, say, transcriptSample } from "../fixtures/voice.ts";

const SEPARATED = "Steve, check the build, bagel, Carol, give me a report on the status of some project";

const windows = [
  { name: "wide", width: 1440, height: 900 },
  { name: "narrow", width: 560, height: 760 },
  { name: "short", width: 900, height: 460 },
  { name: "shorter", width: 900, height: 380 },
] as const;

/**
 * Keep the live transcript on screen. The overlay hides five seconds after the last new word
 * occurrence, so each sample says "again" once more than the one before.
 */
function keepSpeaking(daemon: Parameters<typeof transcriptSample>[0]) {
  let turn = 0;
  const send = () => transcriptSample(daemon, { phase: "words", onset: 1,
    text: "Will, run the release checklist" + " again".repeat(turn++) });
  let timer: ReturnType<typeof setInterval> | undefined;
  // A refused refresh is reported; the overlay assertions then fail on the missing transcript.
  const resume = () => {
    timer = setInterval(() => void send().then(accepted => {
      if (!accepted) console.warn("live transcript sample was not accepted");
    }, (error: unknown) => console.error("live transcript sample failed", error)), 700);
  };
  resume();
  // Paused, the words and the transcript's size hold still for up to five seconds.
  return { first: send(), stop: () => clearInterval(timer), pause: () => clearInterval(timer), resume };
}

const pendingCards = (page: Page) => page.getByRole("status").filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) });

/** Rectangles where the transcript covers a toast card's visible part. */
function collisions(page: Page) {
  return page.evaluate(() => {
    const transcript = document.querySelector('aside[aria-label="Live voice transcript"]')!.getBoundingClientRect();
    const stack = document.querySelector(".voice-card-stack")!.getBoundingClientRect();
    return [...document.querySelectorAll(".voice-card-stack .voice-card")].map(card => card.getBoundingClientRect()).flatMap(card => {
      const top = Math.max(card.top, stack.top, transcript.top);
      const bottom = Math.min(card.bottom, stack.bottom, transcript.bottom);
      const left = Math.max(card.left, transcript.left);
      const right = Math.min(card.right, transcript.right);
      return bottom > top && right > left ? [{ top, bottom, left, right }] : [];
    });
  });
}

async function expectApart(page: Page, cards: number) {
  const transcript = transcriptOf(page);
  await expect(transcript).toBeVisible();
  await expect(transcript).toBeInViewport({ ratio: 1 });
  await expect(pendingCards(page)).toHaveCount(cards);
  await expect.poll(() => collisions(page)).toEqual([]);
  // Every countdown and control is reachable, and a click lands on the card rather than the transcript.
  for (const card of await pendingCards(page).all()) {
    for (const control of [card.getByRole("button", { name: "Cancel", exact: true }), card.getByRole("button", { name: /^Send/ })]) {
      // Scroll the way a person would, to the middle of the stack. Edge alignment can leave a
      // sub-pixel sliver outside a scrolled column-reverse stack.
      await control.evaluate(element => element.scrollIntoView({ block: "center" }));
      await expect(control).toBeInViewport({ ratio: 1 });
      const box = (await control.boundingBox())!;
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.textContent,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe(await control.textContent());
    }
    await expect(card.getByText(/^≤?\d+s$/)).toBeVisible();
  }
  await expect.poll(() => collisions(page)).toEqual([]);
}

for (const placement of [
  { style: "card", corner: "bottom-right" },
  { style: "card", corner: "bottom-left" },
  { style: "capsule", corner: "bottom-right" },
] as const) {
  const label = placement.style === "capsule" ? "capsule" : placement.corner + " card";
  test(`the live transcript ${label} and the corner toast stay apart in every window size`, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon);
    expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: {
      listeningMode: "always-on", separatorWord: "bagel", transcriptStyle: placement.style, transcriptCorner: placement.corner,
    } })).ok()).toBe(true);
    for (const name of ["Steve", "Carol", "Will"]) {
      expect((await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
        identity: { name, description: "Builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
      } } })).ok()).toBe(true);
    }
    await page.goto(daemon.baseURL + "/#/fleet");
    const listener = await beListener(daemon);
    const speaking = keepSpeaking(daemon);
    try {
      await speaking.first;
      const transcript = transcriptOf(page);
      await expect(transcript).toContainText("release checklist");
      await expect(transcript).toHaveClass(new RegExp(`vt-${placement.style}`));
      // Two confirmations open while the transcript is already on screen.
      await say(daemon, SEPARATED, { id: "two-messages" });
      await expectApart(page, 2);
      // A third opens beneath the transcript's corner.
      await say(daemon, "Will, inspect the release notes", { id: "third" });
      for (const size of windows) {
        await page.setViewportSize(size);
        await expectApart(page, 3);
        if (size.name === "wide" && placement.corner === "bottom-left" && placement.style === "card") {
          // Nothing shares the bottom edge here, so the transcript keeps its own place.
          await expect(transcript).toHaveCSS("bottom", "48px");
        }
        await page.mouse.move(size.width / 2, 120);
        await captureCard(page, `transcript-${placement.style}-${placement.corner}-${size.name}`);
      }
      await page.setViewportSize(windows[0]);
      if (placement.corner === "bottom-left" && placement.style === "card") {
        // Moving the card into the toast's corner keeps its size, and it still rises clear of the cards.
        // New words would resize it, so they pause: only the corner change can move it.
        speaking.pause();
        await expect(transcript).toHaveCSS("bottom", "48px");
        expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { transcriptCorner: "bottom-right" } })).ok()).toBe(true);
        await expect(transcript).toHaveClass(/vt-bottom-right/);
        await expect.poll(() => collisions(page), { timeout: 2000 }).toEqual([]);
        await expect(transcript).not.toHaveCSS("bottom", "48px");
        speaking.resume();
        await expectApart(page, 3);
      }
      // Cancelling a card lets the transcript settle back toward its corner, still clear of the rest.
      const before = await transcript.boundingBox();
      await pendingCards(page).filter({ hasText: "inspect the release notes" }).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(pendingCards(page)).toHaveCount(2);
      await expectApart(page, 2);
      if (placement.corner === "bottom-right" && placement.style === "card") {
        await expect.poll(async () => (await transcript.boundingBox())!.y).toBeGreaterThanOrEqual(before!.y);
      }
    } finally {
      speaking.stop();
      listener.stop();
    }
    // Without a transcript the toast stack keeps its full height and its corner.
    await expect(transcriptOf(page)).toHaveCount(0, { timeout: 8000 });
    await expect(page.locator(".voice-card-stack")).not.toHaveAttribute("style", /--voice-stack-max/);
  });
}

function transcriptOf(page: Page) {
  return page.getByRole("complementary", { name: "Live voice transcript" });
}
