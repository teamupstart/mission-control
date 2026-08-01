import type { ToolCall, TranscriptMessage, TurnOrigin } from "@shared/types.ts";
import type { ConversationRow } from "./episodes.ts";
import { toolChip } from "./tools.ts";

/**
 * Find-in-conversation: the match model.
 *
 * Pure, and deliberately separate from the components that draw it. The design
 * exploration behind this feature (`docs/plans/conversation-search/mockups.html`)
 * settled on one shape - a floating bar with a results rail bound to it - by
 * building four presentations over ONE model, which is the property this module
 * exists to keep. A second presentation (the overview ruler that mockup C shows)
 * is a consumer of `FindHit[]`, not a second search.
 *
 * The other reason it is pure: highlighting is the part that is easy to get
 * subtly wrong, and a model that can be tested without a DOM is the only way to
 * pin "the count equals the number of highlights" as a fact rather than a hope.
 */

export interface FindOptions {
  caseSensitive: boolean;
}

/** Who said the thing that matched. The rail filters on this. */
export type FindScope = "all" | "user" | "assistant" | "tool";

/** One occurrence, addressed precisely enough to highlight and to jump to. */
export interface FindHit {
  /** Stable across re-renders for the same query, so React keys and the current-hit
   *  ring survive a streamed turn arriving. */
  key: string;
  /** The conversation row this lives in. */
  rowId: string;
  /** Which tool chip inside that row, or null when it is the turn's own text. */
  toolIndex: number | null;
  /** Offsets into the field's text. */
  start: number;
  end: number;
  scope: Exclude<FindScope, "all">;
  /** Byline for the rail row. */
  who: string;
  /** Rail snippet, already split so the renderer does no slicing. */
  pre: string;
  hit: string;
  post: string;
}

/** How much context each side of a rail snippet carries. */
const SNIPPET_PAD = 46;

const ORIGIN_LABEL: Record<TurnOrigin, string> = {
  foreman: "foreman",
  harness: "mission control",
  workflow: "workflow",
};

/**
 * The byline a turn wears, and the ONE place that rule lives - the transcript's
 * `Turn` reads it from here too. A turn the human did not type says who did:
 * much of the "user" side of a supervised session is Foreman delivering work, and
 * reading those back as "you" makes the log claim the human asked for things they
 * never asked for.
 */
export function turnWho(m: TranscriptMessage, agentLabel: string): string {
  if (m.role === "assistant") return agentLabel;
  return m.origin ? ORIGIN_LABEL[m.origin] : "you";
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

function snippet(text: string, start: number, end: number): Pick<FindHit, "pre" | "hit" | "post"> {
  const a = Math.max(0, start - SNIPPET_PAD);
  const b = Math.min(text.length, end + SNIPPET_PAD);
  return {
    pre: (a > 0 ? "…" : "") + text.slice(a, start),
    hit: text.slice(start, end),
    post: text.slice(end, b) + (b < text.length ? "…" : ""),
  };
}

/** The text of a tool chip that a search can see: what it ran, and on what. */
export function toolSearchText(t: ToolCall): string {
  const chip = toolChip(t);
  return chip.detail ? `${chip.name} ${chip.detail}` : chip.name;
}

/**
 * Narrow hits to the window `[from, to)` of the text they were collected over, in that
 * window's own coordinates.
 *
 * A hit straddling an edge is CLIPPED, not dropped. A tool chip is searched as one
 * string - "read prompt.ts" - but rendered as two spans, and a query spanning the space
 * between them ("read prompt") belongs to both. Dropping such a hit left the rail able
 * to navigate to a match that nothing on screen marked, which breaks the rule the whole
 * count rests on: every counted match is a visible one.
 *
 * Both halves keep the original hit's `key`, so the pair still reads as the one match it
 * is - the jump anchor resolves to the first of them.
 */
export function hitsInWindow(hits: FindHit[], from: number, to: number): FindHit[] {
  const out: FindHit[] = [];
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
 * Walk the rendered conversation and collect every occurrence, in document order.
 *
 * Episodes and review answers are skipped: they are cards rather than transcript turns,
 * they are not part of the conversation the agent had, and they carry their own
 * structure that a flat offset could not address. A review answer in particular is a
 * question, its options, and a selection among them - there is no single string whose
 * offsets a hit could name, and highlighting the flattened response would light up text
 * that is not the text on screen.
 *
 * Role BYLINES are not searched either. They are chrome, not conversation - without
 * that exclusion, `you` matches the label above every message the human ever sent,
 * which is both useless and the largest match count in the log.
 */
export function collectHits(
  rows: ConversationRow[],
  query: string,
  opts: FindOptions,
  agentLabel: string,
): FindHit[] {
  const re = buildMatcher(query, opts);
  if (!re) return [];
  const hits: FindHit[] = [];

  for (const row of rows) {
    if (row.kind === "episode" || row.kind === "review") continue;

    if (row.kind === "turn") {
      const who = turnWho(row.message, agentLabel);
      const scope: Exclude<FindScope, "all"> = row.message.role === "assistant" ? "assistant" : "user";
      for (const { start, end } of matchesIn(row.message.text, re)) {
        hits.push({
          key: `${row.id}:t:${start}`,
          rowId: row.id,
          toolIndex: null,
          start,
          end,
          scope,
          who,
          ...snippet(row.message.text, start, end),
        });
      }
      // A turn can carry tool calls of its own as well as text.
      row.message.tools.forEach((tool, i) => {
        const text = toolSearchText(tool);
        for (const { start, end } of matchesIn(text, re)) {
          hits.push({
            key: `${row.id}:x${i}:${start}`,
            rowId: row.id,
            toolIndex: i,
            start,
            end,
            scope: "tool",
            who: `${who} ran`,
            ...snippet(text, start, end),
          });
        }
      });
      continue;
    }

    row.tools.forEach((tool, i) => {
      const text = toolSearchText(tool);
      for (const { start, end } of matchesIn(text, re)) {
        hits.push({
          key: `${row.id}:x${i}:${start}`,
          rowId: row.id,
          toolIndex: i,
          start,
          end,
          scope: "tool",
          who: `${agentLabel} ran`,
          ...snippet(text, start, end),
        });
      }
    });
  }

  return hits;
}

/** The hits a scope selects. `all` is the identity, not a special case at the call site. */
export function hitsInScope(hits: FindHit[], scope: FindScope): FindHit[] {
  return scope === "all" ? hits : hits.filter((h) => h.scope === scope);
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
