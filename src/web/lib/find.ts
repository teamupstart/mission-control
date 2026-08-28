import type { ToolCall, TranscriptMessage, TurnOrigin } from "@shared/types.ts";
import type { ConversationRow } from "./episodes.ts";
import { buildMatcher, matchesIn, type FindOptions } from "./documentFind.ts";
import { toolChip, toolLineTarget } from "./tools.ts";

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

/*
 * The generic half of this model now lives in `documentFind.ts`, because the Files
 * workspace searches documents with the same matcher and the same ring. It is re-exported
 * from here so the transcript's imports - and this module's own unit test - keep naming
 * one place for "the find model", while the pieces that know what a conversation is stay
 * below.
 */
export type { FindOptions, FindSegment } from "./documentFind.ts";
export {
  buildMatcher,
  hitsInWindow,
  matchesIn,
  splitForHighlight,
  stepIndex,
} from "./documentFind.ts";

/**
 * Who said the thing that matched. The rail filters on this.
 *
 * `user` is the HUMAN's own turns, not every turn wearing the `user` role - see
 * `turnAuthor`. The turns a machine typed are `injected`, which no pill selects: they
 * are reachable under `all`, and separating them is what stops the "You" pill returning
 * rows whose own byline says foreman.
 */
export type FindScope = "all" | "user" | "assistant" | "tool" | "injected";

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

/** Who a turn belongs to, once. Every other authorship answer here is derived from it. */
export type TurnAuthor = "operator" | "agent" | TurnOrigin;

/**
 * Who typed a turn - the ONE rule, expressed once.
 *
 * `role` cannot answer this and never could: Foreman delivering work, the daemon
 * broadcasting `/reload-skills`, and workflow repair delivery all land as `user` turns
 * byte-identical to a person's, so anything keying on the role alone reads those back as
 * the human and makes the log claim they asked for work they never asked for. `origin` is
 * the only field that separates them, which is why the byline, the find scope and the
 * rail's "Yours" tab all come through here rather than each re-deciding it.
 *
 * "operator" rather than "user" deliberately: the word `user` is already spent on the
 * ROLE, and the whole defect this guards against is the two being treated as synonyms.
 *
 * Note what this CANNOT know: attribution is recorded in memory at the moment of delivery
 * (`server/injections.ts`), so a turn the daemon has forgotten - anything delivered before
 * a restart - answers "operator" here. That is the honest answer rather than a wrong one:
 * it is what the byline says too, so the rail is never more wrong than the transcript it
 * indexes, and never differently wrong.
 */
export function turnAuthor(m: TranscriptMessage): TurnAuthor {
  if (m.role === "assistant") return "agent";
  return m.origin ?? "operator";
}

/** What to call a machine-typed turn's author, on a byline or a rail row. */
export function originLabel(origin: TurnOrigin): string {
  return ORIGIN_LABEL[origin];
}

/**
 * The byline a turn wears, and the ONE place that rule lives - the transcript's
 * `Turn` reads it from here too. A turn the human did not type says who did:
 * much of the "user" side of a supervised session is Foreman delivering work, and
 * reading those back as "you" makes the log claim the human asked for things they
 * never asked for.
 */
export function turnWho(m: TranscriptMessage, agentLabel: string): string {
  const author = turnAuthor(m);
  if (author === "agent") return agentLabel;
  return author === "operator" ? "you" : ORIGIN_LABEL[author];
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
 * The same, for a tool call drawn as a LINE in the terminal rendering's opened record.
 *
 * A second function rather than a wider `toolSearchText`, because the two renderings put
 * different text on screen and the invariant this module rests on is that the searched
 * string is the rendered one. A line shows the literal input where a chip shows the capped
 * summary, so searching a line has to reach `status --short` - which is plainly on screen
 * there - while searching a chat chip must NOT, because in the chat log that text lives
 * only in a hover tooltip and a hit inside it could be neither seen nor jumped to.
 *
 * Which of the two a row is searched with is the caller's to say (`collectHits`'s
 * `toolText`), because only the panel knows which rendering is on screen.
 */
export function toolLineText(t: ToolCall): string {
  const chip = toolChip(t);
  const target = toolLineTarget(t);
  return target ? `${chip.name} ${target}` : chip.name;
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
  /**
   * How to read a tool call as text, defaulting to the chat chip's projection.
   *
   * A parameter because the two conversation renderings put different text on screen for
   * the same call, and this module's whole contract is that the searched string is the
   * rendered one. The panel passes `toolLineText` while the terminal rendering is up. It
   * is a function rather than a mode flag so `find.ts` never has to learn what a view is.
   */
  toolText: (t: ToolCall) => string = toolSearchText,
): FindHit[] {
  const re = buildMatcher(query, opts);
  if (!re) return [];
  const hits: FindHit[] = [];

  for (const row of rows) {
    if (row.kind === "episode" || row.kind === "review") continue;

    if (row.kind === "turn") {
      const who = turnWho(row.message, agentLabel);
      // Both of these read the SAME authorship rule, which is the point. They used to
      // disagree: `who` came from `turnWho` (which reads origin) while the scope came
      // from the role alone on the very next line, so one hit could carry
      // `who: "foreman"` and `scope: "user"` at once and the "You" pill returned rows
      // whose own byline said foreman.
      const author = turnAuthor(row.message);
      const scope: Exclude<FindScope, "all"> =
        author === "agent" ? "assistant" : author === "operator" ? "user" : "injected";
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
        const text = toolText(tool);
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
      const text = toolText(tool);
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
