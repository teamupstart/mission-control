import type { TranscriptMessage } from "@shared/types.ts";
import { originLabel, turnAuthor } from "./find.ts";

// The "Yours" rail's row model - an INDEX of the operator's own messages, not a filter
// over the log. Pure and browser-safe, so the one rule that matters here (what counts as
// something the human said) can be table-tested against real message shapes.
//
// The rule is not this module's to invent: it comes from `turnAuthor` in `find.ts`,
// which is the single place authorship is decided. Grouping by ROLE instead is the
// defect this rail exists to avoid - Foreman, workflow repair and the daemon's own
// broadcasts all arrive as `user` turns, and a rail keyed on the role would list them
// back to the operator as their own words under a tab literally called "Yours".
//
// Nothing is hidden anywhere: the transcript beside this rail still renders every turn,
// including the injected ones. The rail only decides what to INDEX, and it says out loud
// which rows were not the operator's.

/** One message in the rail, ready to render. */
export interface YoursRow {
  /** The transcript message's own stable uuid - also the jump target in the log. */
  id: string;
  /** epoch ms, 0 when the record carried no timestamp. */
  ts: number;
  /** The message text. Clamped by CSS at render, never truncated here. */
  text: string;
  /**
   * Who typed it, when it was not the operator: "foreman", "mission control",
   * "workflow". Null for the operator's own messages, which is what the rail's two
   * groups are keyed on - a row can never be dimmed and unlabelled at once.
   */
  who: string | null;
}

/** The rail's two groups, in the order they are drawn. */
export interface YoursIndex {
  /** What the operator typed, in transcript order. */
  yours: YoursRow[];
  /**
   * What was typed on their behalf, in transcript order, drawn dimmed BELOW `yours`.
   *
   * Listed rather than dropped: the operator can see what was said for them without it
   * reading as theirs, which is the whole difference between an index and a filter. A
   * dropped row would leave them believing a conversation they never had was empty.
   */
  injected: YoursRow[];
}

/**
 * Split the loaded transcript into the operator's messages and the ones typed for them.
 *
 * Text-bearing turns only. A turn that is nothing but tool calls has no message to index
 * and belongs to the Activity tab beside this one; the operator's own turns always carry
 * text, so this costs the "Yours" group nothing.
 */
export function yourMessages(messages: TranscriptMessage[]): YoursIndex {
  const yours: YoursRow[] = [];
  const injected: YoursRow[] = [];
  for (const m of messages) {
    if (!m.text) continue;
    const author = turnAuthor(m);
    // The agent's replies are the 95% this rail exists to index a path THROUGH. They are
    // in the transcript, untouched; they are simply not what either group is about.
    if (author === "agent") continue;
    if (author === "operator") {
      yours.push({ id: m.id, ts: m.ts, text: m.text, who: null });
      continue;
    }
    // Narrowed to `TurnOrigin` by the two checks above rather than asserted, so a fourth
    // origin added to the union fails to compile here instead of rendering as null.
    injected.push({ id: m.id, ts: m.ts, text: m.text, who: originLabel(author) });
  }
  return { yours, injected };
}
