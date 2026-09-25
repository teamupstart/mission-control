import { InProgressRow } from "./InProgressRow.tsx";

/**
 * The Display panel's picture of a working conversation, for the Working indicator items.
 *
 * Two small logs rather than one, because the two items answer different situations and a
 * single frame can only be in one of them. At the tail, the row is the log's last line and
 * reads the same whatever is checked - that frame is where the always-on clock is seen.
 * Scrolled back, the row's tail is below the fold: unchecked it is simply not there, which is
 * the whole problem the pin solves, and checked it holds the bottom edge. The reply box under
 * both takes the progress bar.
 *
 * The row is the REAL `InProgressRow`, the same way the card preview mounts the real
 * `SessionTile`, so the thing being configured cannot drift from its picture. The turns
 * around it are plain markup in the log's own classes: they are context, not the subject,
 * and the real turn component needs a live session's file handlers to render at all.
 *
 * The clock is frozen at a fixed instant (`now`) so the preview does not tick in Settings.
 */

/**
 * The preview's frozen instant, and a turn that started 2m 14s before it.
 *
 * The sample turns are one short line each on purpose. At 300px a longer one wraps by a
 * different amount in every font stack, and a clamped one leaks the top of its next line
 * into the bubble's padding.
 */
const NOW = 1_000_000;
const TURN_STARTED = NOW - 134_000;

const AGENT = "claude";
const ACTIVITY = "running Bash";

function PreviewTurn({ who, text }: { who: "You" | typeof AGENT; text: string }): React.JSX.Element {
  return (
    <div className={`turn turn-${who === "You" ? "user" : "assistant"}`}>
      <div className="turn-role">{who}</div>
      <div className="turn-text">{text}</div>
    </div>
  );
}

export function WorkingIndicatorPreview({
  pinned,
  progressBar,
}: {
  pinned: boolean;
  progressBar: boolean;
}): React.JSX.Element {
  const row = (
    <InProgressRow
      agentLabel={AGENT}
      activity={ACTIVITY}
      terminal={false}
      startedAt={TURN_STARTED}
      now={NOW}
      pinned={pinned}
    />
  );
  return (
    <div className="working-preview">
      <span className="working-preview-label">At the end of the conversation</span>
      <div className="transcript-log working-preview-log">
        <PreviewTurn who={AGENT} text="Reproducing it with one slot held." />
        {row}
      </div>

      <span className="working-preview-label">Scrolled back through it</span>
      <div className="transcript-log working-preview-log is-scrolled-back">
        <PreviewTurn who="You" text="Fix the flaky reaper test." />
        <PreviewTurn who={AGENT} text="Starting with the worktree pool." />
        <PreviewTurn who={AGENT} text="Reproducing it with one slot held." />
        {row}
      </div>

      <textarea
        className={progressBar ? "transcript-input has-progress-bar" : "transcript-input"}
        aria-label="Reply box"
        placeholder="Reply to this session…"
        rows={1}
        readOnly
        tabIndex={-1}
      />
    </div>
  );
}
