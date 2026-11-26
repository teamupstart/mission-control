import { transcriptTail, type TranscriptSample } from "@shared/voice.ts";

const VISIBLE_MS = 5000;
const MAX_UNFINISHED_ONSETS = 100;

function recognizedWords(text: string): string[] {
  return text.normalize("NFC").toLowerCase().replace(/\p{P}+/gu, "").match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

// A decoder may reorder or retract words. Remember the highest count heard for
// each word at this onset, so only a new occurrence refreshes the display.
function recordWordCounts(words: readonly string[], highestCounts: Map<string, number>): boolean {
  const counts = new Map<string, number>();
  let fresh = false;
  for (const word of words) {
    const count = (counts.get(word) ?? 0) + 1;
    counts.set(word, count);
    if (count > (highestCounts.get(word) ?? 0)) {
      highestCounts.set(word, count);
      fresh = true;
    }
  }
  return fresh;
}

export class TranscriptPreview {
  expiresAt = 0;
  phase?: TranscriptSample["phase"];
  private committed = "";
  private interim = "";
  private interimOnset = -1;
  private latestOnset = -1;
  private finalizedThrough = -1;
  // A final decode can arrive after audio or partials for the next onset.
  private readonly onsets = new Map<number, { highestCounts: Map<string, number>; visible: boolean; freshUntil: number }>();

  constructor(readonly grant: string, readonly owner: string) {}

  get text(): string { return transcriptTail(this.committed + " " + this.interim); }

  hide() {
    this.expiresAt = 0;
    this.phase = undefined;
    this.committed = "";
    this.interim = "";
    this.interimOnset = -1;
    // Remember what was recognized even after the rolling display is cleared.
    for (const partial of this.onsets.values()) partial.visible = false;
  }

  observe(sample: TranscriptSample, now: number) {
    if (this.expiresAt && now >= this.expiresAt) this.hide();
    if (sample.phase === "ready") {
      this.phase = "ready";
      return;
    }
    if (sample.onset <= this.finalizedThrough) return;
    if (sample.onset < this.latestOnset && !(sample.phase === "words" && sample.final)) return;
    const superseded = sample.onset < this.latestOnset;
    let onset = this.onsets.get(sample.onset);
    if (!superseded && !onset) {
      // Audio opens a short window for a final-only decode, once per onset.
      onset = { highestCounts: new Map(), visible: false, freshUntil: now + VISIBLE_MS };
      this.onsets.set(sample.onset, onset);
      if (this.onsets.size > MAX_UNFINISHED_ONSETS) {
        this.finalizedThrough = this.onsets.keys().next().value!;
        this.onsets.delete(this.finalizedThrough);
      }
    }
    this.latestOnset = Math.max(this.latestOnset, sample.onset);
    if (sample.phase === "audio") {
      this.phase = this.interimOnset === sample.onset ? "words" : "audio";
      return;
    }

    const words = recognizedWords(sample.text);
    if (sample.final) {
      this.finalizedThrough = sample.onset;
      for (const id of this.onsets.keys()) {
        if (id <= sample.onset) this.onsets.delete(id);
      }
      // Retire even an expired final without letting it change the display.
      if (!onset || now >= onset.freshUntil) return;
      if (this.interimOnset === sample.onset || (words.length > 0 && this.interimOnset < sample.onset)) {
        this.interim = "";
        this.interimOnset = -1;
      }
    }
    if (!words.length || !onset) return;
    const fresh = recordWordCounts(words, onset.highestCounts);
    if (fresh) {
      onset.visible = true;
      onset.freshUntil = now + VISIBLE_MS;
      this.expiresAt = onset.freshUntil;
      this.phase ??= "words";
    }
    const visible = onset.visible;
    if (visible && sample.onset === this.latestOnset) this.phase = "words";
    if (sample.final) {
      if (visible) this.committed = transcriptTail(this.committed + " " + sample.text);
    } else if (visible) {
      this.interim = sample.text;
      this.interimOnset = sample.onset;
    }
  }
}
