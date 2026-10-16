// The comment controls a file's toolbar carries, in the Files tab and the Diff tab alike.
//
// One component for both, so a reader and a screen reader meet the same buttons, with the
// same names, in the same order, wherever a file is on screen: Comment (what a click on a line
// does), Comments (every thread on this file), Review (what happens to what you have already
// written) and Resolved (whether closed threads are drawn). Each surface supplies only what it
// alone knows - why this file takes no comment, and whether `m` is its key.
//
// `aria-disabled` rather than `disabled` when a control cannot act. The reason differs by file
// - an image, a single commit, a deleted file - and a disabled button cannot be focused, so its
// tooltip, which is where that reason lives, would be unreachable from the keyboard.
//
// The classes are the Files tab's own and are deliberately NOT written as descendants of
// `.file-toolbar`: the Persona, session-action and Foreman profile editors reuse that class
// for toolbars that have no comments at all.

import type { FileCommentReviewState } from "../lib/fileCommentReview.ts";
import { useKeybindingHints } from "../lib/keybindings.ts";
import { Tooltip } from "./Tooltip.tsx";

export interface FileCommentModeControl {
  active: boolean;
  /** Why a click on it does nothing for this file, or null when it works. */
  blockReason: string | null;
  /** What it does when it works. */
  label: string;
  /** Whether `m` reaches it here. An extracted Files window claims no in-surface key. */
  shortcut: boolean;
  onToggle: () => void;
}

export interface FileCommentIndexControl {
  /** Every thread on the file, closed ones included - the Comments index's own length. */
  count: number;
  expanded: boolean;
  /** Why this file has no comments to list, or null when it does. */
  blockReason?: string | null;
  onToggle: () => void;
}

export interface FileCommentResolvedControl {
  count: number;
  shown: boolean;
  onToggle: () => void;
}

export function FileCommentControls({
  mode,
  index,
  review,
  resolved,
}: {
  /** Null on read-only evidence: its threads stay readable, and nothing opens a composer. */
  mode: FileCommentModeControl | null;
  index: FileCommentIndexControl;
  review: Pick<FileCommentReviewState, "queue" | "review" | "outstanding" | "showQueue" | "onToggleQueue">;
  resolved: FileCommentResolvedControl;
}): React.JSX.Element {
  const [showKeybindingHints] = useKeybindingHints();
  const modeBlocked = mode !== null && mode.blockReason !== null;
  const modeShortcut = mode !== null && !modeBlocked && mode.shortcut;
  const indexBlockReason = index.blockReason ?? null;
  const { queue, outstanding, showQueue } = review;
  return (
    <div className="file-comment-controls">
      {mode && (
        <Tooltip label={mode.blockReason ?? mode.label}>
          <button
            type="button"
            className={`file-comment-toggle${mode.active ? " on" : ""}`}
            aria-label="Comment mode"
            aria-keyshortcuts={modeShortcut ? "m" : undefined}
            aria-pressed={mode.active}
            aria-disabled={modeBlocked}
            onClick={() => {
              if (!modeBlocked) mode.onToggle();
            }}
          >
            Comment
            {modeShortcut && showKeybindingHints && <kbd className="kb-hint">m</kbd>}
          </button>
        </Tooltip>
      )}
      <Tooltip
        label={indexBlockReason ?? (index.expanded
          ? "Hide every comment on this file"
          : "Show every comment on this file, including resolved threads")}
      >
        <button
          type="button"
          className={`file-comment-toggle${index.expanded ? " on" : ""}`}
          aria-label="Comments"
          aria-expanded={index.expanded}
          aria-disabled={indexBlockReason !== null || undefined}
          onClick={() => {
            if (indexBlockReason === null) index.onToggle();
          }}
        >
          Comments ({index.count})
        </button>
      </Tooltip>
      {/*
        The review's own control, beside the mode toggle rather than inside it: comment mode is
        "what a click on a line does", and this is "what happens to what you have already
        written". It is drawn whenever the session HAS a review to look at, not only in comment
        mode - a review drains while you read another file, and a control that vanished when you
        left the file you were commenting on would be the one control you cannot find when it
        pauses.
      */}
      {(queue.length > 0 || review.review !== null) && (
        <Tooltip
          label={showQueue
            ? "Hide the review queue"
            : outstanding
            ? `A comment is out with the agent, ${queue.length - 1} waiting. Show the review queue`
            : `Show the ${queue.length} comment${queue.length === 1 ? "" : "s"} in this session's review`}
        >
          <button
            type="button"
            className={`file-comment-toggle${showQueue ? " on" : ""}`}
            aria-label="Review queue"
            aria-pressed={showQueue}
            onClick={review.onToggleQueue}
          >
            {/*
              The panel does not open itself when a comment goes, so this is where a comment
              out with the agent shows. Decorative: the queue's own status line is the
              announced account, and the accessible name stays the control's.
            */}
            {outstanding && <span className="file-review-live" aria-hidden="true" />}
            Review ({queue.length})
          </button>
        </Tooltip>
      )}
      {mode?.active && resolved.count > 0 && (
        <Tooltip
          label={resolved.shown
            ? "Stop drawing closed threads on this file"
            : `Also show the ${resolved.count} closed thread${resolved.count === 1 ? "" : "s"} on this file`}
        >
          <button
            type="button"
            className={`file-comment-toggle${resolved.shown ? " on" : ""}`}
            aria-label="Show resolved comments"
            aria-pressed={resolved.shown}
            onClick={resolved.onToggle}
          >
            Resolved
          </button>
        </Tooltip>
      )}
    </div>
  );
}
