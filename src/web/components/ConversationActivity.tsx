import { useId, useLayoutEffect, useRef } from "react";
import type { TranscriptMessage } from "@shared/types.ts";
import { observedActivity } from "../lib/conversation-activity.ts";
import { yourMessages } from "../lib/conversation-yours.ts";
import { ConversationTimestamp } from "./ConversationTimestamp.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The Conversation's secondary rail while find is closed, under two tabs.
 *
 * **Activity** answers "what actions has this agent attempted?". **Yours** answers "what
 * did I actually ask for?" - an INDEX of the operator's own messages, where clicking a
 * row jumps the log to that turn and marks it.
 *
 * Both are derived on every render from the SAME `messages` array the transcript
 * renders. There is deliberately no second event cache: live updates, reconnects, and
 * older pages all reach this rail through the one transcript state path, so the rail can
 * never disagree with the log it sits beside.
 *
 * Yours is an index, not a filter, and that is the whole design. Nothing is hidden from
 * the transcript - the 95% of a session that is not the operator's is still there, still
 * in order, still readable around whichever message they jumped to. A filter would have
 * thrown away the gap between two of their messages, which is where the meaning is.
 *
 * The authorship rule is NOT re-decided here. `conversation-yours.ts` reads `turnAuthor`,
 * the one place that answers who typed a turn, because grouping by ROLE is exactly the
 * defect this tab would otherwise ship: Foreman, workflow repair and the daemon's own
 * broadcasts all arrive as `user` turns, and listing those under a tab called "Yours"
 * would tell the operator they asked for work they never asked for. They are listed, but
 * dimmed, below, and captioned - see the note at the foot of the tab.
 *
 * The language contract, inherited from `conversation-activity.ts`: an Activity row says
 * an invocation record was observed at about a time - never that a tool is running,
 * finished, succeeded, failed, or took a duration. Nothing here may imply otherwise.
 *
 * Rail ownership: `TranscriptPanel` mounts this exactly when find is closed - find takes
 * the secondary column over while open and this returns when it closes. The two are the
 * same width, so the takeover never reflows the conversation being read.
 *
 * Narrow containers get a different economy. Find's rail may claim stacked height
 * because a person just asked for it; this rail is ambient, and permanently spending
 * 40% of a narrow card on it would squeeze the very transcript it annotates. So below
 * the breakpoint the section collapses to one disclosure row (`data-open` carries the
 * state for the stylesheet) and opens on request. At wide widths the toggle is hidden
 * and the list simply shows; the collapse costs a reader nothing they did not choose.
 */

/** Which tab the rail is showing. Held by `TranscriptPanel` so find cannot reset it. */
export type ActivityTab = "activity" | "yours";

export function ConversationActivity({
  messages,
  open,
  onToggle,
  tab,
  onTab,
  selectedTurnId,
  onSelectTurn,
}: {
  messages: TranscriptMessage[];
  /** Narrow-container disclosure state. Wide layouts show the list regardless. */
  open: boolean;
  onToggle: () => void;
  tab: ActivityTab;
  onTab: (tab: ActivityTab) => void;
  /** The turn the log is currently marking, so the rail can show which row owns it. */
  selectedTurnId: string | null;
  onSelectTurn: (id: string) => void;
}): React.JSX.Element {
  const listId = useId();
  const activityTabId = useId();
  const yoursTabId = useId();
  const rows = observedActivity(messages);
  const { yours, injected } = yourMessages(messages);
  const yoursTab = tab === "yours";

  // The count means the same thing on both tabs: how many rows the tab is about. On
  // Yours that is the operator's own messages ONLY - the dimmed rows below them are
  // context, and counting them would restate the exact conflation the tab avoids.
  const count = yoursTab ? yours.length : rows.length;

  // Follow the newest row the way the log follows its tail: hold the resting place while
  // the reader is there, stay put while they are reading history. A layout effect so the
  // correction lands before paint rather than as a jump. `open` is a dependency because
  // the narrow disclosure mounts its list hidden: the scroll can only land once the body
  // has a height, which is the moment the reader opens it - and what they asked to see is
  // the latest. `tab` too, because switching tabs swaps the whole list under the scroller.
  //
  // "The bottom" is the wrong target on Yours, though, and visibly so: the dimmed rows
  // are BELOW the operator's own, so following the true bottom opens a tab called Yours
  // on a screenful of messages that are not theirs. It follows the last of their own
  // instead, and lands on the true bottom only when there is nothing dimmed to sit past.
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastOwnRef = useRef<HTMLLIElement>(null);
  /** Whether the list is sitting where it would sit if nobody had scrolled it. */
  const atRest = useRef(true);
  /** Which tab the scroller was last positioned for. */
  const shownTab = useRef(tab);

  /**
   * How far the scroller is from where it belongs, in pixels, signed.
   *
   * The resting place is NOT always the scroller's end, which is the whole subtlety here:
   * on Yours it is the last of the operator's own rows, because the dimmed ones sit past
   * it. Measuring "has the reader scrolled away?" against the literal bottom instead was
   * a self-inflicted wound - anchoring short of the end fires a scroll event that reports
   * the view as away from the bottom, so the rail would decide the reader had left, and
   * every later message would arrive without the list following it.
   *
   * Measured off `getBoundingClientRect` rather than `offsetTop`, which answers to
   * whichever ancestor happens to be positioned.
   */
  function restOffset(el: HTMLDivElement): number {
    const anchor = yoursTab && injected.length > 0 ? lastOwnRef.current : null;
    if (!anchor) return el.scrollHeight - el.scrollTop - el.clientHeight;
    return anchor.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
  }

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // Choosing a tab is a fresh look at a different list, so it starts where that list
    // means to start rather than wherever the other one had been left. Without this the
    // reader scrolls up on Activity, switches to Yours, and lands mid-list on a tab whose
    // entire job is to show them their latest message.
    if (shownTab.current !== tab) {
      shownTab.current = tab;
      atRest.current = true;
    }
    if (!atRest.current) return;
    const offset = restOffset(el);
    // Sub-pixel differences are not a scroll anyone asked for.
    if (Math.abs(offset) >= 1) el.scrollTop += offset;
  }, [rows.length, yours.length, injected.length, open, tab, yoursTab]);

  /** One message row. A button, because clicking it moves the log. */
  function messageRow(row: (typeof yours)[number], last = false): React.JSX.Element {
    const selected = selectedTurnId === row.id;
    return (
      <li key={row.id} ref={last ? lastOwnRef : undefined}>
        <Tooltip label={row.who ? `Jump to this ${row.who} message` : "Jump to this message"}>
          <button
            type="button"
            className={`yours-row${row.who ? " is-injected" : ""}${selected ? " is-selected" : ""}`}
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelectTurn(row.id)}
          >
            <span className="yours-meta">
              <ConversationTimestamp at={row.ts} className="yours-time" />
              {/* Said on the row itself, not only in the note below: a dimmed row is a
                  colour, and colour alone must not be what separates "you said this"
                  from "this was said for you". */}
              {row.who && <span className="yours-who">{row.who}</span>}
            </span>
            <span className="yours-text">{row.text}</span>
          </button>
        </Tooltip>
      </li>
    );
  }

  return (
    <section
      className="activity-rail"
      // Named for what the column IS, and the name does not move when the tab does: a
      // landmark called "Activity" tells a reader arriving from the landmark list
      // nothing about where they are, and one that renamed itself under them would be
      // worse. Which list is up is the tablist's job to say, and it does.
      aria-label="Conversation rail"
      data-open={open ? "true" : "false"}
      data-tab={tab}
    >
      <div className="activity-head">
        <div className="activity-tabs" role="tablist" aria-label="Rail view">
          <Tooltip label="Tool calls observed in this conversation">
            <button
              type="button"
              role="tab"
              id={activityTabId}
              className="activity-tab"
              aria-selected={!yoursTab}
              aria-controls={listId}
              onClick={() => onTab("activity")}
            >
              Activity
            </button>
          </Tooltip>
          <Tooltip label="The messages you sent in this conversation">
            <button
              type="button"
              role="tab"
              id={yoursTabId}
              className="activity-tab"
              aria-selected={yoursTab}
              aria-controls={listId}
              onClick={() => onTab("yours")}
            >
              Yours
            </button>
          </Tooltip>
        </div>
        {count > 0 && <span className="activity-count">{count}</span>}
        {/* The narrow layout's disclosure, and a member of the head rather than a row of
            its own. Rendered at every width and shown by the container query alone,
            because React cannot see the container's width - the stylesheet is the one
            thing here that knows which layout is in effect.

            In the head because the alternative costs a whole row: a separate disclosure
            row plus a tab row spends two of the four the rail gets at this width, and
            states the same count twice while doing it. Sharing the row means the narrow
            layout gives up no more transcript height than it did before the tabs existed,
            and the tabs stay reachable even while the list is shut. */}
        <Tooltip
          label={
            open
              ? `Hide ${yoursTab ? "your messages" : "the observed tool calls"}`
              : yoursTab
                ? "Show the messages you sent in this conversation"
                : "Show the tool calls observed in this conversation's loaded transcript"
          }
        >
          <button
            type="button"
            className="activity-toggle"
            // The name is carried here because the caret is the only thing drawn: there
            // is no visible label for it to have to agree with.
            aria-label={yoursTab ? "Your messages" : "Observed activity"}
            aria-expanded={open}
            aria-controls={listId}
            onClick={onToggle}
          >
            <span className="activity-caret" aria-hidden>
              {open ? "▾" : "▸"}
            </span>
          </button>
        </Tooltip>
      </div>
      <div
        className="activity-body"
        id={listId}
        role="tabpanel"
        aria-labelledby={yoursTab ? yoursTabId : activityTabId}
        ref={bodyRef}
        onScroll={() => {
          const el = bodyRef.current;
          // Against the resting place, not the scroller's end - see `restOffset`. Reading
          // it the other way meant the rail's own correction looked like the reader
          // walking away from the tail.
          if (el) atRest.current = Math.abs(restOffset(el)) < 32;
        }}
      >
        {yoursTab ? (
          yours.length === 0 && injected.length === 0 ? (
            <p className="activity-empty">No messages from you yet</p>
          ) : (
            <ol className="yours-list">
              {yours.map((row, i) => messageRow(row, i === yours.length - 1))}
              {injected.map((row) => messageRow(row))}
            </ol>
          )
        ) : (
          <>
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
          </>
        )}
      </div>
      {/* Why the dimmed rows are there at all, said on the surface rather than only in
          the docs - and pinned at the foot rather than left inside the scroller, because
          a caption that explains the rows has to still be there while you read them.
          Rendered only when there is something to explain. */}
      {yoursTab && injected.length > 0 && (
        <p className="activity-foot">
          Foreman, Mission Control and workflow turns are listed dimmed, below yours, so you can see
          what was said on your behalf without it reading as yours.
        </p>
      )}
    </section>
  );
}
