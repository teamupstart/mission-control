// Finding values in text and replacing them, for every redactor in shaping: the command
// transport's diagnostics, and a reply's own content. One implementation, so both get the same
// guarantees: every occurrence counts, overlapping copies included, and no part of an
// overlapping value survives.

/** Whether `char` is an ASCII letter or digit: the edge a short value's whole-token match needs. */
function alphanumeric(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char);
}

/**
 * Call `found` with every start offset of `value` in `text`, overlapping occurrences included: a
 * search that resumed after each match would step over a second copy that begins inside the
 * first. Nothing is collected, so a value matched at every offset of a large text costs no
 * allocation per match.
 *
 * Knuth-Morris-Pratt, so the scan is linear in the text and the value whatever they hold. A
 * search that restarted at each match, such as `indexOf` from the next offset, compares a long
 * value against the same characters again for every overlapping copy: a 100 KiB value of one
 * repeated character over a 256 KiB diagnostic is billions of comparisons on the event loop.
 * A whole-token match is the same scan with the characters on either side checked afterwards.
 */
export function forEachOccurrence(text: string, value: string, wholeToken: boolean, found: (start: number) => void): void {
  if (value.length === 0 || value.length > text.length) return;
  // fallback[i]: the length of the longest proper prefix of value[0..i] that is also its suffix.
  const fallback = new Int32Array(value.length);
  for (let i = 1, k = 0; i < value.length; i++) {
    while (k > 0 && value[i] !== value[k]) k = fallback[k - 1]!;
    if (value[i] === value[k]) k++;
    fallback[i] = k;
  }
  for (let i = 0, k = 0; i < text.length; i++) {
    while (k > 0 && text[i] !== value[k]) k = fallback[k - 1]!;
    if (text[i] === value[k]) k++;
    if (k === value.length) {
      const start = i - value.length + 1;
      if (!wholeToken || (!alphanumeric(text[start - 1]) && !alphanumeric(text[i + 1]))) found(start);
      k = fallback[k - 1]!;
    }
  }
}

/** A stretch of text, `[start, end)`, already known to spell a value, and the label it names. */
export interface RedactionSpan {
  start: number;
  end: number;
  label: string;
}

/** One value to remove, how it must stand to count, and the label its replacement names. */
export interface RedactionTarget {
  value: string;
  /** Matched only between non-alphanumerics, for a value too short to remove anywhere. */
  wholeToken: boolean;
  label: string;
}

/**
 * `text` with every occurrence of every target replaced. All matches are found in the original
 * text first, then overlapping or touching ones merge into one span, so two values that overlap
 * are removed over their combined extent and no fragment of either survives a later pass.
 * `render` writes the replacement from the labels of every target the span covers.
 *
 * Bounded however the targets repeat: targets that share a value are searched once, and each
 * match only bumps a counter in a typed array the length of the text, so no record is kept per
 * match and nothing is sorted. Labels are tracked as bits, one per distinct label.
 *
 * `dropBefore` discards unmatched text in front of that offset: a value whose start was cut off
 * by a bounded buffer lives there, as a piece no search can recognise. `maxLength` bounds the
 * result as it is built: nothing past it is ever appended, so many short matches replaced by
 * longer markers cannot grow the text beyond it.
 */
export function redactSpans(
  text: string,
  targets: readonly RedactionTarget[],
  render: (labels: readonly string[]) => string,
  dropBefore = 0,
  maxLength = Number.POSITIVE_INFINITY,
  /**
   * Spans a caller already found, `[start, end)` in `text`, merged in as matches are: no search
   * runs for them, so many distinct spellings cost no more than the scan that found them.
   */
  spans: readonly RedactionSpan[] = [],
): string {
  // One search per value. A value is whole-token only if every target naming it is.
  const byValue = new Map<string, { wholeToken: boolean; labels: Set<string> }>();
  for (const target of targets) {
    if (target.value.length === 0) continue;
    const entry = byValue.get(target.value);
    if (entry) { entry.wholeToken &&= target.wholeToken; entry.labels.add(target.label); }
    else byValue.set(target.value, { wholeToken: target.wholeToken, labels: new Set([target.label]) });
  }
  const labelList = [...new Set([...targets.map((target) => target.label), ...spans.map((span) => span.label)])];
  const labelBit = new Map(labelList.map((label, at) => [label, at]));
  // depth[i] > 0 inside a match. Labels as bit words per start offset, only when there is more
  // than one label to tell apart.
  const depth = new Int32Array(text.length + 1);
  const words = Math.ceil(labelList.length / 32);
  const marks = labelList.length > 1 ? new Uint32Array(text.length * words) : null;
  let matched = false;
  for (const [value, { wholeToken, labels }] of byValue) {
    const bits = [...labels].map((label) => labelBit.get(label)!);
    forEachOccurrence(text, value, wholeToken, (start) => {
      depth[start]! += 1;
      depth[start + value.length]! -= 1;
      if (marks) for (const bit of bits) marks[start * words + (bit >> 5)]! |= 1 << (bit & 31);
      matched = true;
    });
  }
  for (const span of spans) {
    if (span.end <= span.start || span.start < 0 || span.end > text.length) continue;
    depth[span.start]! += 1;
    depth[span.end]! -= 1;
    if (marks) { const bit = labelBit.get(span.label)!; marks[span.start * words + (bit >> 5)]! |= 1 << (bit & 31); }
    matched = true;
  }
  if (!matched && dropBefore <= 0) return text.length > maxLength ? text.slice(0, maxLength) : text;
  let out = "";
  let covered = 0;
  let runStart = 0;
  const spanBits = new Uint32Array(Math.max(1, words));
  const keep = (from: number, to: number) => {
    const at = Math.max(from, dropBefore);
    if (to > at) out += text.slice(at, to);
  };
  const emit = () => {
    if (!marks) { out += render(labelList); return; }
    const labels = labelList.filter((_, at) => (spanBits[at >> 5]! & (1 << (at & 31))) !== 0);
    out += render(labels);
    spanBits.fill(0);
  };
  for (let at = 0; at <= text.length && out.length < maxLength; at++) {
    const wasCovered = covered > 0;
    covered += depth[at]!;
    const isCovered = at < text.length && covered > 0;
    if (isCovered && marks) for (let w = 0; w < words; w++) spanBits[w]! |= marks[at * words + w]!;
    if (isCovered === wasCovered) continue;
    if (wasCovered) emit();
    else keep(runStart, at);
    runStart = at;
  }
  if (out.length < maxLength && covered <= 0 && runStart < text.length) keep(runStart, text.length);
  return out.length > maxLength ? out.slice(0, maxLength) : out;
}
