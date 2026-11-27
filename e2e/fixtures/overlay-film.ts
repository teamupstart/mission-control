import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";

/**
 * Review evidence only: films the corner where the live transcript overlay draws, and turns a stretch
 * of it into a GIF whose every frame is captioned with its time from a known speech onset. Nothing here
 * runs unless `MC_E2E_EVIDENCE` is set, and the GIF needs `ffmpeg` on the PATH.
 */
export interface Frame { t: number; png: Buffer }

export function filmOverlay(page: Page): () => Promise<Frame[]> {
  const frames: Frame[] = [];
  let filming = true;
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  // The bottom-right corner card, where the overlay starts.
  const clip = { x: viewport.width / 2, y: viewport.height / 2, width: viewport.width / 2, height: viewport.height / 2 };
  const loop = (async () => {
    while (filming) {
      const started = Date.now();
      try {
        const png = await page.screenshot({ clip });
        // Date the frame halfway through the capture; it is accurate to a few tens of milliseconds.
        frames.push({ t: Math.round((started + Date.now()) / 2), png });
      } catch { /* the page is navigating; the next frame follows */ }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  })();
  return async () => { filming = false; await loop; return frames; };
}

/**
 * Writes `out` from the frames between `fromMs` and `toMs` after `onsetAt`, each captioned with `title` and its offset,
 * and beside it a single-frame `-sheet.gif` that stacks the frames that tell the story: just before speech, the last
 * one before the first useful preview, and one just after each change of the overlay's text (`changes`, ms from onset).
 */
export async function overlayGif(page: Page, frames: Frame[], options: {
  onsetAt: number; fromMs: number; toMs: number; title: string; out: string; firstUsefulMs: number | null;
  changes: { ms: number; text: string }[];
}): Promise<string[]> {
  const chosen = frames.filter(frame => frame.t - options.onsetAt >= options.fromMs && frame.t - options.onsetAt <= options.toMs);
  const work = mkdtempSync(join(tmpdir(), "overlay-gif-"));
  const captions: string[] = [];
  const captioner = await page.context().newPage();
  try {
    await captioner.setViewportSize({ width: 640, height: 420 });
    for (const [index, frame] of chosen.entries()) {
      const offset = frame.t - options.onsetAt;
      // The frame's own time, and when the page logged the first useful preview: the pixels show what was on screen.
      const useful = options.firstUsefulMs === null ? "no useful preview logged" : `first useful preview logged at +${options.firstUsefulMs} ms`;
      const caption = `${offset >= 0 ? "+" : ""}${offset} ms from speech onset · ${useful}`;
      captions.push(caption);
      await captioner.setContent(`<body style="margin:0;background:#111;color:#eee;font:14px system-ui">
        <div style="padding:8px 10px;font-weight:600">${options.title}</div>
        <div style="padding:0 10px 8px;font-family:ui-monospace,monospace">${caption}</div>
        <img style="display:block;width:640px" src="data:image/png;base64,${frame.png.toString("base64")}"></body>`);
      await captioner.screenshot({ path: join(work, `frame-${String(index).padStart(3, "0")}.png`) });
    }
    mkdirSync(join(options.out, ".."), { recursive: true });
    const offsets = chosen.map(frame => frame.t - options.onsetAt);
    const nearestAfter = (ms: number) => offsets.findIndex(offset => offset >= ms);
    const lastBefore = (ms: number) => offsets.findLastIndex(offset => offset < ms);
    const sheet = [...new Set([lastBefore(0), ...(options.firstUsefulMs === null ? [] : [lastBefore(options.firstUsefulMs)]),
      ...options.changes.filter(change => change.ms >= options.fromMs && change.ms <= options.toMs).map(change => nearestAfter(change.ms + 100))])]
      .filter(index => index >= 0).toSorted((a, b) => a - b).slice(0, 6);
    const inputs = sheet.flatMap(index => ["-i", join(work, `frame-${String(index).padStart(3, "0")}.png`)]);
    await promisify(execFile)("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex",
      `${sheet.length > 1 ? `vstack=inputs=${sheet.length},` : ""}split[a][b];[a]palettegen[p];[b][p]paletteuse`, "-frames:v", "1",
      options.out.replace(/\.gif$/u, "-sheet.gif")]);
    // Frames are about 150 ms apart; the caption on each gives its exact offset.
    await promisify(execFile)("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "6", "-i", join(work, "frame-%03d.png"),
      "-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse", options.out]);
    writeFileSync(options.out.replace(/\.gif$/u, ".txt"), captions.join("\n") + "\n");
    return captions;
  } finally {
    await captioner.close();
    rmSync(work, { recursive: true, force: true });
  }
}
