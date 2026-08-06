import { useId, useLayoutEffect, useRef } from "react";
import type { TranscriptMessage } from "@shared/types.ts";
import { observedActivity } from "../lib/conversation-activity.ts";
import { ConversationTimestamp } from "./ConversationTimestamp.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Observed activity - the Conversation's secondary rail while find is closed.
 *
 * A scannable answer to "what actions has this agent attempted?", derived on every
 * render from the SAME `messages` array the transcript renders. There is deliberately
 * no second event cache: live updates, reconnects, and older pages all reach this rail
 * through the one transcript state path, so the rail can never disagree with the log
 * it sits beside.
 *
 * The language contract, inherited from `conversation-activity.ts`: a row says an
 * invocation record was observed at about a time - never that a tool is running,
 * finished, succeeded, failed, or took a duration. Nothing here may imply otherwise.
 *
 * Rail ownership: `TranscriptPanel` mounts this exactly when find is closed - find
 * takes the secondary column over while open and this returns when it closes. The two
 * are the same width, so the takeover never reflows the conversation being read.
 *
 * Narrow containers get a different economy. Find's rail may claim stacked height
 * because a person just asked for it; this rail is ambient, and permanently spending
 * 40% of a narrow card on it would squeeze the very transcript it annotates. So below
 * the breakpoint the section collapses to one disclosure row (`data-open` carries the
 * state for the stylesheet) and opens on request. At wide widths the toggle is hidden
 * and the list simply shows; the collapse costs a reader nothing they did not choose.
 */
export function ConversationActivity({
  messages,
  open,
  onToggle,
}: {
  messages: TranscriptMessage[];
  /** Narrow-container disclosure state. Wide layouts show the list regardless. */
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const headingId = useId();
  const listId = useId();
  const rows = observedActivity(messages);

  // Follow the newest invocation the way the log follows its tail: stick to the
  // bottom while the reader is there, stay put while they are reading history.
  // A layout effect so the correction lands before paint rather than as a jump.
  const bodyRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  return (
    <section className="activity-rail" aria-labelledby={headingId} data-open={open ? "true" : "false"}>
      <div className="activity-head">
        <h3 className="activity-title" id={headingId}>
          Observed activity
        </h3>
        {rows.length > 0 && <span className="activity-count">{rows.length}</span>}
      </div>
      {/* The narrow layout's disclosure. Rendered at every width and shown by the
          container query alone, because React cannot see the container's width - the
          stylesheet is the one thing here that knows which layout is in effect. */}
      <Tooltip
        label={
          open
            ? "Hide the observed tool calls"
            : "Show the tool calls observed in this conversation's loaded transcript"
        }
      >
        <button
          type="button"
          className="activity-toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={onToggle}
        >
          <span className="activity-toggle-name">Observed activity</span>
          {rows.length > 0 && <span className="activity-count">{rows.length}</span>}
          <span className="activity-caret" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        </button>
      </Tooltip>
      <div
        className="activity-body"
        id={listId}
        ref={bodyRef}
        onScroll={() => {
          const el = bodyRef.current;
          if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
      >
        {/* Observed-only, said on the surface itself rather than only in the docs: the
            rail's window is the loaded transcript, not a process list. */}
        <p className="activity-note">Tool calls observed in the loaded transcript.</p>
        {rows.length === 0 ? (
          <p className="activity-empty">No observed tool activity yet</p>
        ) : (
          <ol className="activity-list">
            {rows.map((row) => (
              <li key={row.key} className="activity-row">
                {/* The full target rides the tooltip (and its always-rendered
                    screen-reader copy), so a capped path or command is truncated
                    visually without truncating what the row can tell. */}
                <Tooltip label={row.title}>
                  <span className="activity-call">
                    <span className="activity-tool">{row.name}</span>
                    {row.detail && <span className="activity-target">{row.detail}</span>}
                  </span>
                </Tooltip>
                <ConversationTimestamp at={row.ts} className="activity-time" />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
