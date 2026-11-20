// Finding values in text and replacing them, for every redactor in shaping: the command
// transport's diagnostics, and a reply's own content. One implementation, so both get the same
// guarantees: every occurrence counts, overlapping copies included, and no part of an
// overlapping value survives.

/** Whether `char` is an ASCII letter or digit: the edge a short value's whole-token match needs. */
function alphanumeric(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char);
}

/**
 * Every start offset of `value` in `text`, overlapping occurrences included: a search that
 * resumed after each match would step over a second copy that begins inside the first.
 *
 * Knuth-Morris-Pratt, so the scan is linear in the text and the value whatever they hold. A
 * search that restarted at each match, such as `indexOf` from the next offset, compares a long
 * value against the same characters again for every overlapping copy: a 100 KiB value of one
 * repeated character over a 256 KiB diagnostic is billions of comparisons on the event loop.
 * A whole-token match is the same scan with the characters on either side checked afterwards.
 */
export function occurrences(text: string, value: string, wholeToken: boolean): number[] {
  const starts: number[] = [];
  if (value.length === 0 || value.length > text.length) return starts;
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
      if (!wholeToken || (!alphanumeric(text[start - 1]) && !alphanumeric(text[i + 1]))) starts.push(start);
      k = fallback[k - 1]!;
    }
  }
  return starts;
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
 * `dropBefore` discards unmatched text in front of that offset: a value whose start was cut off
 * by a bounded buffer lives there, as a piece no search can recognise.
 */
export function redactSpans(
  text: string,
  targets: readonly RedactionTarget[],
  render: (labels: readonly string[]) => string,
  dropBefore = 0,
): string {
  const spans: Array<{ start: number; end: number; label: string }> = [];
  for (const target of targets) {
    for (const start of occurrences(text, target.value, target.wholeToken)) {
      spans.push({ start, end: start + target.value.length, label: target.label });
    }
  }
  if (spans.length === 0 && dropBefore <= 0) return text;
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  const keep = (from: number, to: number) => {
    const at = Math.max(from, dropBefore);
    if (to > at) out += text.slice(at, to);
  };
  for (let i = 0; i < spans.length;) {
    const start = spans[i]!.start;
    let end = spans[i]!.end;
    const labels = new Set<string>();
    while (i < spans.length && spans[i]!.start <= end) {
      end = Math.max(end, spans[i]!.end);
      labels.add(spans[i]!.label);
      i++;
    }
    keep(cursor, start);
    out += render([...labels]);
    cursor = end;
  }
  keep(cursor, text.length);
  return out;
}
