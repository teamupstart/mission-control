import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { beListener, enableVoice, listenerDirective } from "../fixtures/voice.ts";
import { captureCard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { filmOverlay, overlayGif, type Frame } from "../fixtures/overlay-film.ts";
import { humanRecording, synthesizedPlaylist, type PreviewWindow } from "../fixtures/voice-preview-fixtures.ts";

const FLAG = "voice-first-preview-hold";
const execute = promisify(execFile);

async function setFlag(daemon: DaemonHandle, id: string, enabled: boolean) {
  const response = await fetch(daemon.baseURL + "/api/feature-flags", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "flag", id, enabled }),
  });
  expect(response.ok).toBe(true);
}

test("the first-preview hold is an off-by-default preview that reaches the Always-on listener directive live", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const listener = await beListener(daemon);
  try {
    const before = await listenerDirective(daemon);
    expect(before.capture).toBe(true);
    expect(before).not.toHaveProperty("firstPreviewVoicedMs");

    await page.goto(daemon.baseURL + "/#/settings/feature-flags");
    await page.getByRole("textbox", { name: "Filter feature flags" }).fill("phantom");
    const toggle = page.getByRole("button", { name: /^Voice first-preview hold:/ });
    await expect(toggle).toHaveAccessibleName("Voice first-preview hold: off");
    await expect(page.getByText(/wait until a phrase holds 300 ms of voiced audio/)).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAccessibleName("Voice first-preview hold: on");
    await captureCard(page, "first-preview-hold-flag-on");
    // The open Always-on capture keeps its grant: the hold arrives as a live edit of the same microphone.
    await expect.poll(async () => (await listenerDirective(daemon)).firstPreviewVoicedMs).toBe(300);
    const on = await listenerDirective(daemon);
    expect(on.captureRevision).toBe(before.captureRevision);
    expect(on.separator).toBe(before.separator);
    expect(on.endOfSpeechMs).toBe(before.endOfSpeechMs);

    await toggle.click();
    await expect(toggle).toHaveAccessibleName("Voice first-preview hold: off");
    await expect.poll(async () => "firstPreviewVoicedMs" in await listenerDirective(daemon)).toBe(false);
    expect((await listenerDirective(daemon)).captureRevision).toBe(before.captureRevision);
  } finally { listener.stop(); }
});

interface Shown { t: number; text: string }
interface Heard { id: string; time: number; text: string; matchedName: string | null; rule: string; outcome: string }

/** Keep every text the live transcript overlay shows, with the wall-clock time it appeared. Only its words, not its phase label. */
async function recordOverlay(page: Page) {
  await page.evaluate(() => {
    const seen: { t: number; text: string }[] = [];
    (window as unknown as { overlayTimeline: typeof seen }).overlayTimeline = seen;
    new MutationObserver(() => {
      const text = document.querySelector('aside[aria-label="Live voice transcript"] .vt-text')?.textContent?.trim() ?? "";
      if (seen.at(-1)?.text !== text) seen.push({ t: Date.now(), text });
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => {
    const timeline = (window as unknown as { overlayTimeline: { t: number; text: string }[] }).overlayTimeline;
    return timeline.splice(0, timeline.length);
  });
}

async function heard(page: Page, daemon: DaemonHandle): Promise<Heard[]> {
  return (await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries;
}

const word = (text: string) => {
  const first = text.toLowerCase().match(/[a-z']+/u)?.[0] ?? "";
  return first === "ok" ? "okay" : first;
};

/** What one run put on screen, window by window, against what was in each window. */
function score(windows: PreviewWindow[], shown: Shown[], fedAt: number) {
  const changes = shown.map(entry => ({ ms: entry.t - fedAt, text: entry.text }));
  return windows.map(window => {
    const inside = changes.filter(change => change.ms >= window.startMs && change.ms < window.endMs);
    // Words left on screen from earlier are not this window's; only what it added counts.
    const prior = changes.filter(change => change.ms < window.startMs).at(-1);
    const baseline = prior && prior.ms > window.startMs - 5500 ? prior.text : "";
    const added = inside.map(change => ({ ms: change.ms, text: (baseline && change.text.startsWith(baseline)
      ? change.text.slice(baseline.length) : change.text).trim() })).filter(change => change.text);
    if (window.kind === "non-speech") {
      return { id: window.id, kind: window.kind, phantom: added.length > 0, shown: added.map(change => change.text) };
    }
    const expected = word(window.expected ?? "");
    const useful = added.find(change => word(change.text) === expected && change.ms >= window.onsetMs! - 100);
    const leading = added.filter(change => change !== useful && (!useful || change.ms < useful.ms) && word(change.text) !== expected);
    return { id: window.id, kind: window.kind, expected: window.expected, phantomLead: leading.length > 0,
      firstShownMs: added[0] ? added[0].ms - window.onsetMs! : null,
      firstUsefulMs: useful ? useful.ms - window.onsetMs! : null, shown: added.map(change => change.text) };
  });
}

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length ? sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2 : null;
};

function summarize(rows: ReturnType<typeof score>) {
  const speech = rows.filter(row => row.kind !== "non-speech") as Extract<(typeof rows)[number], { firstUsefulMs: unknown }>[];
  const latency = (kind?: string) => median(speech.filter(row => !kind || row.kind === kind).flatMap(row => row.firstUsefulMs ?? []));
  return {
    nonSpeechWindows: rows.length - speech.length,
    nonSpeechWindowsShowingWords: rows.filter(row => "phantom" in row && row.phantom).length,
    speechWindowsWithPhantomLead: speech.filter(row => row.phantomLead).length,
    speechWindowsWithUsefulPreview: speech.filter(row => row.firstUsefulMs !== null).length,
    speechWindows: speech.length,
    medianMsToFirstUsefulPreview: { all: latency(), oneWord: latency("one-word"), callSign: latency("call-sign"), cancel: latency("cancel") },
  };
}

/** The production Swift listener loop, fed the playlist at microphone callback pace into this daemon. */
async function nativeListener(daemon: DaemonHandle, models: string, wav: string): Promise<number> {
  const { stdout } = await execute("swift", ["test", "-c", "release", "--package-path", "native/voice-listener",
    "--filter", "ContinuousSpeechTests.testContinuousDesktopCapture"], {
    env: { ...process.env, MISSION_LONG_VOICE_NATURAL: "1", MISSION_LONG_VOICE_HELD: "0", MISSION_LONG_VOICE_WAV: wav,
      MISSION_VOICE_MODEL_DIR: models, MISSION_VOICE_LISTENER_INSTANCE: "desktop-cpu", MISSION_VOICE_DAEMON_URL: daemon.baseURL,
      MISSION_VOICE_TOKEN_FILE: join(daemon.home, "token") }, timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
  });
  const fedAt = Number(stdout.match(/feed started at Unix ms (\d+)/u)?.[1]);
  expect(fedAt, stdout).toBeGreaterThan(0);
  return fedAt;
}

interface Run { fedAt: number; shown: Shown[]; heard: Heard[]; frames: Frame[] }

/** Plays the playlist through the production listener with the flag off, then on, into one daemon with three call signs. */
async function offThenOn(page: Page, daemon: DaemonHandle, models: string, wav: string, cancelSeconds: number) {
  await setupCards(page, daemon, cancelSeconds);
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", {
    data: { endOfSpeechMs: 2000, listeningMode: "always-on", transcriptWords: 100, showTranscript: true },
  })).ok()).toBe(true);
  for (const name of ["Steve", "Carol", "Max"]) await runningAgent(page, daemon, name);
  await page.goto(daemon.baseURL + "/#/fleet");
  const overlay = await recordOverlay(page);
  const runs = {} as Record<"off" | "on", Run>;
  for (const variant of ["off", "on"] as const) {
    await setFlag(daemon, FLAG, variant === "on");
    if (variant === "on") {
      // The previous listener process has exited; let its hello lapse so the next one may take capture.
      await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/voice/mute")).json()).state.mode,
        { timeout: 60_000 }).toBe("unavailable");
    }
    const known = new Set((await heard(page, daemon)).map(entry => entry.id));
    overlay();
    const film = process.env.MC_E2E_EVIDENCE ? filmOverlay(page) : null;
    const fedAt = await nativeListener(daemon, models, wav);
    // Every confirmation's countdown ends, so each outcome is the delivered one.
    await expect.poll(async () => (await heard(page, daemon)).filter(entry => !known.has(entry.id) && entry.outcome === "pending").length,
      { timeout: 30_000 }).toBe(0);
    await page.waitForTimeout(1000);
    const frames = film ? await film() : [];
    runs[variant] = { fedAt, shown: await overlay(), heard: (await heard(page, daemon)).filter(entry => !known.has(entry.id)).toReversed(), frames };
  }
  return runs;
}

const routed = (entries: Heard[]) => entries.map(({ text, matchedName, rule, outcome }) => ({ text, matchedName, rule, outcome }));
const timeline = (run: Run) => run.shown.map(entry => ({ ms: entry.t - run.fedAt, text: entry.text }));

test("native Always-on with synthesized speech and noise: fewer non-speech previews, as many useful previews, the same finals and a working spoken Cancel",
  async ({ dashboard: page, daemon }) => {
    const models = process.env.MISSION_LONG_VOICE_MODELS;
    test.skip(process.platform !== "darwin" || !models, "Requires installed macOS FluidAudio models");
    test.setTimeout(1_200_000);
    const playlist = synthesizedPlaylist(daemon.home);
    const runs = await offThenOn(page, daemon, models!, playlist.wav, 4);
    const scored = (["off", "on"] as const).map(variant => {
      const rows = score(playlist.windows, runs[variant].shown, runs[variant].fedAt);
      const summary = summarize(rows);
      console.log(`synthesized flag ${variant}: ${JSON.stringify(summary)}`);
      return { rows, summary, heard: runs[variant].heard, timeline: timeline(runs[variant]) };
    });
    const [off, on] = scored as [(typeof scored)[number], (typeof scored)[number]];
    // Each repetition keeps its own report: the 800 ms preview loop lands at a different phase every run.
    // The report holds counts, timings and recognized text, never audio.
    const dir = artifactsDir("voice-preview-hold");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `synthesized-${Date.now()}.json`), JSON.stringify({ source: "synthesized", windows: playlist.windows, runs: { off, on } }, null, 1));

    // Final routing and delivery are the same with the hold on: same captures, same names, rules and outcomes.
    expect(routed(on.heard)).toEqual(routed(off.heard));
    expect(off.heard.some(entry => entry.matchedName === "Steve")).toBe(true);
    // The playlist ends with "Carol, run the tests." and, while its confirmation is pending, a spoken "Cancel.":
    // with the hold on as with it off, the Cancel is a control action and Carol's confirmation is cancelled.
    for (const [variant, run] of [["off", off], ["on", on]] as const) {
      const carol = run.heard.filter(entry => entry.matchedName === "Carol");
      expect(carol.map(entry => entry.outcome), `${variant}: Carol's confirmation`).toEqual(["cancelled"]);
      const spoken = run.heard.filter(entry => entry.rule === "cancel");
      expect(spoken.map(({ text, outcome }) => ({ text: word(text), outcome })), `${variant}: the spoken Cancel`)
        .toEqual([{ text: "cancel", outcome: "control" }]);
      expect(run.heard.at(-1), `${variant}: the Cancel came last, after Carol`).toBe(spoken[0]);
    }
    // Counted over the whole run: no more non-speech windows show words with the hold on, and as many
    // utterances reach a preview whose first word is the word spoken.
    expect(on.summary.nonSpeechWindowsShowingWords).toBeLessThanOrEqual(off.summary.nonSpeechWindowsShowingWords);
    expect(on.summary.speechWindowsWithUsefulPreview).toBe(off.summary.speechWindowsWithUsefulPreview);

    if (!process.env.MC_E2E_EVIDENCE) return;
    // Review evidence: the real overlay around a one-word reply and around a reply after typing, off and on.
    for (const id of ["okay", "typing-then-yes"]) {
      const window = playlist.windows.find(candidate => candidate.id === id)!;
      for (const [variant, run] of [["off", off], ["on", on]] as const) {
        const row = run.rows.find(candidate => candidate.id === id)!;
        await overlayGif(page, runs[variant].frames, {
          onsetAt: runs[variant].fedAt + window.onsetMs!, fromMs: window.startMs - window.onsetMs! - 400, toMs: 3000,
          firstUsefulMs: "firstUsefulMs" in row ? row.firstUsefulMs : null,
          title: `Live transcript overlay, flag ${variant}: "${window.expected}"${id === "typing-then-yes" ? " after 2.5 s of typing" : ""}`,
          out: join(dir, `overlay-${id}-flag-${variant}.gif`),
          changes: run.timeline.map(change => ({ ms: change.ms - window.onsetMs!, text: change.text })),
        });
      }
    }
  });

test("native Always-on with the operator's recorded speech: the hold leaves every final, route and outcome unchanged",
  async ({ dashboard: page, daemon }) => {
    const models = process.env.MISSION_LONG_VOICE_MODELS;
    test.skip(process.platform !== "darwin" || !models, "Requires installed macOS FluidAudio models");
    // An operator's recording, used with their consent and never committed: see docs/voice.md.
    const recording = process.env.MISSION_PREVIEW_HOLD_HUMAN_WAV;
    test.skip(!recording, "Set MISSION_PREVIEW_HOLD_HUMAN_WAV to a 16 kHz mono recording of the operator's own speech");
    test.setTimeout(1_200_000);
    const runs = await offThenOn(page, daemon, models!, humanRecording(daemon.home, recording!), 6);
    // The recording has no timed labels, so this test asserts only what does not depend on them. The raw overlay
    // timelines are kept for reading by hand.
    const dir = artifactsDir("voice-preview-hold");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `human-${Date.now()}.json`), JSON.stringify({ source: "human",
      runs: { off: { heard: runs.off.heard, timeline: timeline(runs.off) }, on: { heard: runs.on.heard, timeline: timeline(runs.on) } } }, null, 1));
    expect(runs.off.heard.length).toBeGreaterThan(0);
    expect(routed(runs.on.heard)).toEqual(routed(runs.off.heard));
  });
