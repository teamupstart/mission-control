import {
  fileCommentSummaryLabel,
  fileCommentSummaryTone,
  type FileCommentSummary,
} from "../lib/fileComments.ts";

/**
 * The mark a file list puts beside a file that carries comments: the Files tab's list of the
 * checkout and the Diff tab's list of changed files, one component for both.
 *
 * Its count is the file's Comments button count, and its colour says whether anything there
 * waits on the reader - an unread answer from the agent first, then an open thread, and dimmed
 * once every thread is closed. A named image rather than bare text, so it joins the row's
 * accessible name ("README.md 2 comments, 1 unread reply") and says in words what its colour
 * says to everyone who can see it. It sits inside the row's own button, so it is not a control.
 */
export function FileCommentBadge({
  summary,
}: {
  summary: FileCommentSummary | undefined;
}): React.JSX.Element | null {
  // `fileCommentSummaries` keys only files it counted a thread on, so no entry means no thread.
  if (!summary) return null;
  return (
    <span
      className={`file-comment-badge ${fileCommentSummaryTone(summary)}`}
      role="img"
      aria-label={fileCommentSummaryLabel(summary)}
    >
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
        <path
          d="M3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 3v-3h-.5A1.5 1.5 0 0 1 2 9.5v-6A1.5 1.5 0 0 1 3.5 2z"
          fill="currentColor"
        />
      </svg>
      {summary.total}
    </span>
  );
}
