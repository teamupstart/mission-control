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
  private readonly partials = new Map<number, { highestCounts: Map<string, number>; visible: boolean }>();

  constructor(readonly grant: string, readonly owner: string) {}

  get text(): string { return transcriptTail(this.committed + " " + this.interim); }

  hide() {
    this.expiresAt = 0;
    this.phase = undefined;
    this.committed = "";
    this.interim = "";
    this.interimOnset = -1;
    // Remember what was recognized even after the rolling display is cleared.
    for (const partial of this.partials.values()) partial.visible = false;
  }

  observe(sample: TranscriptSample, now: number) {
    if (sample.phase === "ready") {
      this.phase = "ready";
      return;
    }
    if (sample.onset <= this.finalizedThrough) return;
    if (sample.onset < this.latestOnset && !(sample.phase === "words" && sample.final)) return;
    this.latestOnset = Math.max(this.latestOnset, sample.onset);
    if (sample.phase === "audio") {
      this.phase = this.interimOnset === sample.onset ? "words" : "audio";
      return;
    }

    const words = recognizedWords(sample.text);
    if (!words.length) return;
    const partial = this.partials.get(sample.onset);
    const highestCounts = partial?.highestCounts ?? new Map<string, number>();
    // An older onset can finish decoding after its display window closed.
    // Retire it below without reviving its text or renewing the current window.
    const expiredEarlierOnset = sample.onset < this.latestOnset && partial?.visible === false;
    const fresh = !expiredEarlierOnset && recordWordCounts(words, highestCounts);
    const visible = fresh || partial?.visible === true;
    if (visible && sample.onset === this.latestOnset) this.phase = "words";
    if (fresh) this.expiresAt = now + VISIBLE_MS;
    if (fresh) this.phase ??= "words";
    if (sample.final) {
      this.finalizedThrough = sample.onset;
      for (const onset of this.partials.keys()) {
        if (onset <= sample.onset) this.partials.delete(onset);
      }
      if (visible) {
        this.committed = transcriptTail(this.committed + " " + sample.text);
      }
      if (this.interimOnset <= sample.onset) {
        this.interim = "";
        this.interimOnset = -1;
      }
    } else {
      if (fresh) this.partials.set(sample.onset, { highestCounts, visible });
      // Bound unfinished decodes if a listener never sends finals.
      if (this.partials.size > MAX_UNFINISHED_ONSETS) {
        this.finalizedThrough = this.partials.keys().next().value!;
        this.partials.delete(this.finalizedThrough);
      }
      if (visible) {
        this.interim = sample.text;
        this.interimOnset = sample.onset;
      }
    }
  }
}
