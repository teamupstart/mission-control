/**
 * Find over a document: the match model, with no conversation in it.
 *
 * Split out of `find.ts` when the Files workspace grew a find of its own. Everything
 * here was already pure and DOM-free, and it was already built on one invariant -
 * **every counted match is a match a person can see and jump to** - which is the reason
 * a second search model was not written beside it.
 *
 * The rule this module adds, and the one the Files surfaces rest on: **one matcher,
 * applied per surface to the string that surface renders.** The Editor shows source, so
 * its hits are offsets into the buffer. Markdown preview shows rendered text, so its hits
 * are the marks the rehype plugin actually produced. A markdown document genuinely
 * contains occurrences that render to nothing - a link destination in
 * `[label](matching-url)`, a reference definition, a fence info string - so a single
 * source-derived count would have offered the reader matches Preview cannot highlight or
 * step to. Hit keys are namespaced by surface for the same reason: a rendered key and a
 * source key must never be mistaken for one another.
 */

export interface FindOptions {
  caseSensitive: boolean;
}

/**
 * Compile a query.
 *
 * Literal, not a regular expression: this is a reading aid reached with the same
 * chord as the browser's find, and a user typing `foo(bar)` means those seven
 * characters. Returns null for an empty query so callers have one "nothing to
 * search for" answer rather than an empty-match regex that loops forever.
 */
export function buildMatcher(query: string, opts: FindOptions): RegExp | null {
  const q = query;
  if (!q) return null;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, opts.caseSensitive ? "g" : "gi");
}

/** Every occurrence in one string. Shared by the highlighter and the collector, so a
 *  highlighted span and a counted hit can never come from different rules. */
export function matchesIn(text: string, re: RegExp): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (!text) return out;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // A zero-length match cannot advance lastIndex on its own; without this the
    // loop never terminates.
    if (m[0] === "") {
      re.lastIndex += 1;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Narrow hits to the window `[from, to)` of the text they were collected over, in that
 * window's own coordinates.
 *
 * A hit straddling an edge is CLIPPED, not dropped. A tool chip is searched as one
 * string - "read prompt.ts" - but rendered as two spans, and a query spanning the space
 * between them ("read prompt") belongs to both. Dropping such a hit left the rail able
 * to navigate to a match that nothing on screen marked, which breaks the rule the whole
 * count rests on: every counted match is a visible one. The rendered-markdown marks reuse
 * the identical contract for a hit split by inline markup.
 *
 * Both halves keep the original hit's `key`, so the pair still reads as the one match it
 * is - the jump anchor resolves to the first of them.
 */
export function hitsInWindow<T extends { start: number; end: number }>(
  hits: readonly T[],
  from: number,
  to: number,
): T[] {
  const out: T[] = [];
  for (const h of hits) {
    const start = Math.max(h.start, from);
    const end = Math.min(h.end, to);
    // Not merely empty - a hit entirely on the far side of the window lands here too.
    if (start >= end) continue;
    out.push({ ...h, start: start - from, end: end - from });
  }
  return out;
}

/**
 * Step through a ring of hits, wrapping at both ends the way a browser's find does.
 * Returns the new index; -1 when there is nothing to step through.
 */
export function stepIndex(length: number, current: number, direction: 1 | -1): number {
  if (length <= 0) return -1;
  const next = current + direction;
  return ((next % length) + length) % length;
}

/** One piece of a string split around its matches, for rendering. */
export interface FindSegment {
  text: string;
  /** Absolute start offset in the source string, so a segment can be matched back to a hit. */
  start: number;
  isMatch: boolean;
}

/**
 * Split a string into rendered segments around its matches.
 *
 * The whole point of returning data rather than mutating the DOM: React owns these
 * nodes. The design exploration highlighted by walking text nodes and injecting
 * `<mark>` elements, which is fine for a static page and wrong here - a streamed
 * turn arriving re-renders the turn and destroys injected marks, and mutating
 * React-owned children can trip the reconciler outright.
 */
export function splitForHighlight(text: string, ranges: { start: number; end: number }[]): FindSegment[] {
  if (!ranges.length) return text ? [{ text, start: 0, isMatch: false }] : [];
  const out: FindSegment[] = [];
  let last = 0;
  for (const r of ranges) {
    if (r.start > last) out.push({ text: text.slice(last, r.start), start: last, isMatch: false });
    out.push({ text: text.slice(r.start, r.end), start: r.start, isMatch: true });
    last = r.end;
  }
  if (last < text.length) out.push({ text: text.slice(last), start: last, isMatch: false });
  return out;
}

/**
 * Which string a set of hits was taken over.
 *
 * Not decoration: it is baked into every key, so the ring, React's reconciliation and
 * the current-hit lookup cannot cross surfaces. `source` is a buffer's own bytes - what
 * the Editor shows, and what the opaque HTML preview can only be searched through today.
 * `rendered` is text a preview actually drew.
 */
export type DocumentFindSurface = "source" | "rendered";

/**
 * A find session over the selected document.
 *
 * Deliberately WITHOUT a hit list. Hits belong to whichever surface is on screen,
 * because the two surfaces search different strings - see this module's header. What
 * survives the Preview/Editor toggle is the query, the case flag, and (best effort, by
 * source line) the reader's place.
 */
export interface DocumentFindSession {
  query: string;
  caseSensitive: boolean;
  /** Index into the ACTIVE surface's hits, clamped by the caller as hits change. */
  index: number;
}

/** One occurrence in a document's text, addressed precisely enough to paint and to jump to. */
export interface DocumentHit {
  /** Stable for a given query, and namespaced by surface. */
  key: string;
  /** Offsets into the string these hits were taken over. */
  start: number;
  end: number;
  /** 1-based line of `start` in that same string. */
  line: number;
}

/** The width of the line break beginning at `at`, or 0 when none does. */
function breakLengthAt(text: string, at: number): number {
  const ch = text[at];
  if (ch === "\n") return 1;
  if (ch === "\r") return text[at + 1] === "\n" ? 2 : 1;
  return 0;
}

/**
 * The 1-based line an offset sits on.
 *
 * Every newline convention this app can open a file in, because the editor preserves
 * whichever one the file already used (`applyExactEditorChanges`) and a find that counted
 * `\r\n` as two breaks would report the wrong line to every jump built on it.
 */
export function hitLine(text: string, offset: number): number {
  const limit = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let at = 0; at < limit;) {
    const width = breakLengthAt(text, at);
    if (width === 0) {
      at += 1;
      continue;
    }
    // A break STRADDLING the offset has not been passed yet - an offset between the `\r`
    // and the `\n` is still on the line that break ends.
    if (at + width > limit) break;
    line += 1;
    at += width;
  }
  return line;
}

/**
 * Every occurrence in one document string, in document order.
 *
 * Given WHATEVER string the caller has - source for the Editor, rendered text for a
 * surface that has one - so the one matcher is applied per surface rather than once over
 * bytes only one surface shows.
 */
export function documentHits(
  text: string,
  query: string,
  opts: FindOptions,
  surface: DocumentFindSurface,
): DocumentHit[] {
  const re = buildMatcher(query, opts);
  if (!re) return [];
  const out: DocumentHit[] = [];
  // The line is carried along beside the matches rather than recounted per hit, so a long
  // file with many matches stays linear in its own length.
  let line = 1;
  let cursor = 0;
  for (const { start, end } of matchesIn(text, re)) {
    while (cursor < start) {
      const width = breakLengthAt(text, cursor);
      if (width === 0) {
        cursor += 1;
        continue;
      }
      if (cursor + width > start) break;
      line += 1;
      cursor += width;
    }
    out.push({ key: `${surface}:${start}`, start, end, line });
  }
  return out;
}

/**
 * Collapse hits that share a source line into one ring entry, in document order.
 *
 * For a surface that can only locate a match BY BLOCK - today the sandboxed HTML preview,
 * which this origin cannot read into - two occurrences on the same source line are two
 * things nothing can tell apart: the resolver is asked for a line, so both requests are
 * byte-identical and both answers are the same block. Offering them as two ring entries
 * promised the reader a step that could not happen, and could reveal the block of the other
 * occurrence, which is worse than coarse - it is wrong.
 *
 * So that surface's ring is over the LOCATIONS it can actually reach. The bar says "by
 * block" for exactly this reason. Phase 2's in-frame bridge reports its own character
 * positions and retires both the grouping and the note.
 *
 * Hits must arrive in document order, which `documentHits` guarantees, so a neighbour check
 * is enough and no set is needed.
 */
export function hitLinesByBlock(hits: readonly DocumentHit[]): number[] {
  const lines: number[] = [];
  for (const hit of hits) {
    if (lines[lines.length - 1] !== hit.line) lines.push(hit.line);
  }
  return lines;
}
