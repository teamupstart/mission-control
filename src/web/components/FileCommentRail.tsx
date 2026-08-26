import type { FileCommentThread } from "@shared/types.ts";
import { threadStateLabel } from "../lib/fileComments.ts";
import { Tooltip } from "./Tooltip.tsx";

function lineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function rowText(thread: FileCommentThread): string {
  return thread.messages.at(-1)?.body ?? thread.quote;
}

/**
 * A file's complete comment index.
 *
 * This is intentionally not the review queue. The queue is an outbox and omits comments
 * once they have been sent or resolved; this rail is navigation and therefore includes
 * every actionable thread on the selected file, resolved threads included. The workspace
 * owns the jump because only it knows whether Preview or Editor is currently on screen.
 */
export function FileCommentRail({
  path,
  threads,
  selectedId,
  onOpen,
  onClose,
}: {
  path: string;
  threads: readonly FileCommentThread[];
  selectedId: string | null;
  onOpen: (thread: FileCommentThread) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <aside className="file-comment-rail" aria-label={`Comments on ${path}`}>
      <header className="file-comment-rail-head">
        <div>
          <h3>Comments</h3>
          <p>{threads.length === 0 ? "No threads on this file" : `${threads.length} total`}</p>
        </div>
        <Tooltip label="Close the comments list">
          <button className="icon-btn" aria-label="Close comments" onClick={onClose}>✕</button>
        </Tooltip>
      </header>

      {threads.length === 0 ? (
        <p className="file-comment-rail-empty">Comments on this file will appear here.</p>
      ) : (
        <ol className="file-comment-rail-list">
          {threads.map((thread) => {
            const selected = selectedId === thread.id;
            const text = rowText(thread);
            return (
              <li key={thread.id}>
                <Tooltip label={`Open ${thread.shortId} at ${lineRange(thread.startLine, thread.endLine)}`}>
                  <button
                    type="button"
                    className={`file-comment-rail-row${selected ? " is-selected" : ""}`}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onOpen(thread)}
                  >
                    <span className="file-comment-rail-meta">
                      <span className="file-comment-id mono">{thread.shortId}</span>
                      <span className="file-comment-line">
                        {lineRange(thread.startLine, thread.endLine)}
                      </span>
                      <span className={`file-comment-state is-${thread.status}`}>
                        {threadStateLabel(thread)}
                      </span>
                    </span>
                    <span className="file-comment-rail-text">{text}</span>
                    <span className="file-comment-rail-count">
                      {thread.messageCount} {thread.messageCount === 1 ? "message" : "messages"}
                    </span>
                  </button>
                </Tooltip>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
