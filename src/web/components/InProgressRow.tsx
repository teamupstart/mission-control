import { useEffect, useState } from "react";

import { duration } from "../lib/format.ts";
import { Tooltip } from "./Tooltip.tsx";

/** The wall clock, advancing once a second while `ticking` - and not at all otherwise. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}

/**
 * The turn currently arriving, at the tail of the log where it is arriving.
 *
 * This is the typing-indicator position and it is the honest one: the line describes work
 * that is happening after everything above it and before anything below, which is a claim
 * only the tail can make. Held above the pane - where it used to live - it was a fixed
 * band of chrome that said the same thing about a place the reader was not looking, and
 * cost the conversation 36px whether or not anything was running.
 *
 * Three deliberate shapes:
 *
 * - **One line, clipped.** Not a style preference. The log follows its tail only while the
 *   reader is within 48px of the bottom (`onScroll`), so a row that could wrap to two or
 *   three lines would appear under a bottom-pinned reader, push them past that threshold,
 *   and stop the pane following the conversation - the exact failure this row exists at
 *   the bottom to avoid. The full text rides the tooltip's always-rendered copy, so
 *   clipping costs nothing that cannot be read.
 * - **Not a turn.** No bubble, no timestamp, no find highlighting: those belong to rows
 *   that came out of a transcript and can be searched, quoted and scrolled back to. This
 *   one is a report about the present that the next real turn overwrites, so it is drawn
 *   as provisional - muted text, the working tone reserved for the marker.
 * - **Not announced.** No `role="status"`, on purpose. A busy agent rewrites this line
 *   every few seconds, and a live region here would read every one of them over the turns
 *   actually arriving in the same log. The text is in the document for anyone reading the
 *   log, and the tooltip's hidden copy says what it is.
 *
 * The terminal drawing gives the log a different rhythm - no flex gap, a 24px inset, and a
 * spine with a node per entry - so there the row takes `.pty-entry` and joins the stream.
 * Found in the browser: without it the row sat flush against the last entry and two dozen
 * pixels to the left of everything else, reading as a stray line from another component.
 * Taking the existing class rather than restating its four rules is also what keeps the
 * spine's `:last-child` treatment landing on the row that is actually last.
 *
 * Two additions since it moved here, both about reading it from anywhere in the pane:
 *
 * - **A clock, always.** How long the current turn has been running, counted from the prompt
 *   that started it (`currentTurnStartedAt`). A spinner only says something is happening; the
 *   clock says for how long, so a reader can judge at a glance whether a step has run longer
 *   than it should. It is part of the row rather than an option on it. It ticks in THIS
 *   component, so the second hand re-renders one line rather than the whole log, and it is
 *   right-aligned so the activity text keeps the width it clips against. No clock is drawn
 *   when the turn's prompt is not in the loaded page, rather than a smaller wrong number.
 * - **Pinned, when asked.** `workingPinned` (Display > Working indicator) makes the row sticky
 *   to the bottom of the log's scrollport. At the bottom of the log that changes nothing - it
 *   is still the last line. Scrolled back, it holds the bottom edge instead of leaving with
 *   the tail. It stays in the log rather than moving into chrome, so there is still exactly
 *   one row and one claim, and a queued turn - drawn after it - is never covered, because a
 *   row pinned by its own overflow has everything after it below the fold too.
 */
export function InProgressRow({
  agentLabel,
  activity,
  terminal,
  startedAt,
  pinned = false,
  now,
}: {
  agentLabel: string;
  activity: string;
  terminal: boolean;
  /** When the current turn began (`currentTurnStartedAt`), or null to draw no clock. */
  startedAt: number | null;
  /** Hold the bottom edge of the log while the reader scrolls back (`workingPinned`). */
  pinned?: boolean;
  /**
   * A fixed instant to measure the clock against, for the Display preview: a picture of the
   * row in Settings must not tick. Omitted, the row reads the wall clock every second.
   */
  now?: number;
}): React.JSX.Element {
  const live = useNow(startedAt !== null && now === undefined);
  const elapsed = startedAt === null ? null : duration((now ?? live) - startedAt);
  return (
    <Tooltip
      label={`What ${agentLabel} reports it is doing right now: ${activity}. A live report from the session, not a turn the transcript recorded - the next real turn replaces it. The clock counts from the prompt that started this turn.`}
    >
      <p
        className={`turn-progress${terminal ? " pty-entry" : ""}${pinned ? " is-pinned" : ""}`}
      >
        {/* The log's own byline class, so the row reads in the same rhythm as the turns
            above it. It does NOT take `.turn-assistant`, so the name stays dim rather than
            picking up the agent's accent: this line is provisional, and the accent is how
            the log marks what the agent actually said. */}
        <span className="turn-role turn-progress-who">{agentLabel}</span>
        <span className="turn-progress-glyph" aria-hidden>
          ⟳
        </span>
        <span className="turn-progress-text">{activity}</span>
        {elapsed !== null && <span className="turn-progress-clock">{elapsed}</span>}
      </p>
    </Tooltip>
  );
}
