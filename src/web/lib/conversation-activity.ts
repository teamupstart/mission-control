import type { TranscriptMessage } from "@shared/types.ts";
import { toolChip } from "./tools.ts";

// The Observed activity rail's row model. Pure and browser-safe, so the flattening
// rules - every loaded invocation, once, in transcript order - can be table-tested
// against real message shapes instead of through a DOM.
//
// This is deliberately NOT derived from `transcriptRows()`: that fold exists for the
// main log and drops nothing, but it groups tool-ONLY turns - a tool call attached to
// a prose turn stays inside its turn. The rail's contract is every invocation, so it
// walks the messages themselves.
//
// Honesty constraint, stated once here because every consumer inherits it: a row means
// "this invocation record was observed in the loaded transcript at about this time".
// The normalized transcript proves nothing else - not that the tool ran, finished,
// succeeded, failed, or how long it took - so the model carries no field that could
// say so.

/** One observed tool invocation, ready to render. */
export interface ActivityRow {
  /**
   * Presentation key, `<message id>:<tool index>`. Message ids are the transcript's
   * own stable uuids and the index is the call's position in its turn, so the key
   * survives rerenders, reconnects, and older pages prepending - the same projection
   * over the same messages always yields the same keys, which is what "no second
   * event cache" relies on for stability.
   */
  key: string;
  /** The carrying message's timestamp - epoch ms, 0 when the record had none. */
  ts: number;
  /** Normalized tool label, e.g. "bash", "read", "chrome-devtools:click". */
  name: string;
  /** Compact display-safe target ("ls", "styles.css"), null when input carried none. */
  detail: string | null;
  /** The uncapped source of `detail` for the tooltip - never more than `toolChip` shows. */
  title: string;
}

/**
 * Flatten every loaded tool invocation into rail rows, in canonical transcript order:
 * message order, then tool-array order within a turn. Reuses `toolChip()` so the rail
 * and the inline transcript chips cannot disagree about a call's label or target, and
 * missing or unparseable input degrades to the tool name the same way a chip does.
 */
export function observedActivity(messages: TranscriptMessage[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const m of messages) {
    m.tools.forEach((tool, i) => {
      const chip = toolChip(tool);
      rows.push({ key: `${m.id}:${i}`, ts: m.ts, name: chip.name, detail: chip.detail, title: chip.title });
    });
  }
  return rows;
}
