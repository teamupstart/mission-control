import { useEffect, useMemo, useRef, useState } from "react";
import type { FileCommentThread } from "@shared/types.ts";
import { threadStateLabel } from "../lib/fileComments.ts";
import { Tooltip } from "./Tooltip.tsx";

const ROW_HEIGHT = 86;
const ROW_PITCH = 88;
const WINDOW_OVERSCAN = 4;
const INITIAL_VIEWPORT_HEIGHT = 640;

export function fileCommentRailWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
): { start: number; end: number } {
  const visibleStart = Math.floor(Math.max(0, scrollTop) / ROW_PITCH);
  const visibleEnd = Math.ceil((Math.max(0, scrollTop) + viewportHeight) / ROW_PITCH);
  return {
    start: Math.max(0, visibleStart - WINDOW_OVERSCAN),
    end: Math.min(total, Math.max(visibleEnd + WINDOW_OVERSCAN, WINDOW_OVERSCAN * 2)),
  };
}

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
  const listRef = useRef<HTMLOListElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: INITIAL_VIEWPORT_HEIGHT });
  const window = fileCommentRailWindow(threads.length, viewport.scrollTop, viewport.height);
  const visibleThreads = useMemo(
    () => threads.slice(window.start, window.end),
    [threads, window.start, window.end],
  );

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      setViewport((current) => {
        const height = list.clientHeight || INITIAL_VIEWPORT_HEIGHT;
        const scrollTop = list.scrollTop;
        return current.height === height && current.scrollTop === scrollTop
          ? current
          : { height, scrollTop };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const index = threads.findIndex((thread) => thread.id === selectedId);
    const list = listRef.current;
    if (!list || index < 0 || (index >= window.start && index < window.end)) return;
    list.scrollTop = index * ROW_PITCH;
    setViewport({ scrollTop: list.scrollTop, height: list.clientHeight || INITIAL_VIEWPORT_HEIGHT });
  }, [selectedId, threads, window.end, window.start]);

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
        <ol
          ref={listRef}
          className="file-comment-rail-list"
          onScroll={(event) => {
            const list = event.currentTarget;
            setViewport({
              scrollTop: list.scrollTop,
              height: list.clientHeight || INITIAL_VIEWPORT_HEIGHT,
            });
          }}
        >
          <li
            className="file-comment-rail-spacer"
            aria-hidden="true"
            style={{ height: `${threads.length * ROW_PITCH}px` }}
          />
          {visibleThreads.map((thread, offset) => {
            const index = window.start + offset;
            const selected = selectedId === thread.id;
            const text = rowText(thread);
            return (
              <li
                key={thread.id}
                className="file-comment-rail-item"
                aria-posinset={index + 1}
                aria-setsize={threads.length}
                style={{
                  height: `${ROW_HEIGHT}px`,
                  transform: `translateY(${index * ROW_PITCH}px)`,
                }}
              >
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
