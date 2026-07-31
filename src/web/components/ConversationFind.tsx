import { useEffect, useRef } from "react";
import type { FindHit, FindScope } from "../lib/find.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Find in conversation - the bar, and the results rail bound to it.
 *
 * This is approach D from `docs/plans/conversation-search/mockups.html`: a floating
 * bar over the log (so opening find moves nothing the reader was looking at) plus a
 * rail of matches in context. The rail belongs to the FIND SESSION, not to the panel -
 * it appears with the bar and leaves with it - which is what keeps a conversation
 * nobody is searching from paying for a results list it does not have.
 *
 * The invariant to preserve: **the rail is visible exactly when find is open.** There
 * is deliberately no independent control over it, and it is never dropped to reclaim
 * space. Below a container width the rail RELOCATES under the log (see the
 * `@container` block in styles.css) rather than disappearing - two earlier iterations
 * offered a collapse toggle and a width-based removal, and both were rejected in
 * review for creating an open-find state with no visible rail.
 */

const SCOPES: { id: FindScope; label: string; hint: string }[] = [
  { id: "all", label: "All", hint: "Match anywhere in this conversation" },
  { id: "user", label: "You", hint: "Match only turns sent to the agent" },
  { id: "assistant", label: "Agent", hint: "Match only the agent's replies" },
  { id: "tool", label: "Tools", hint: "Match only tool calls - where the file paths are" },
];

/**
 * The bar and the rail are two exported components rather than one, because they do
 * not share a parent. The bar floats inside `.find-logwrap` so it can be positioned
 * against the LOG; the rail is a sibling of that wrapper so `.find-split` can give it
 * a column. Returning both from one component would have forced the rail into the
 * wrapper, where it renders above the conversation instead of beside it.
 *
 * They are still one unit to the reader, and TranscriptPanel mounts both on the same
 * `find != null` - which is the invariant in the block comment above.
 */
export function ConversationFindBar({
  query,
  onQuery,
  caseSensitive,
  onCaseSensitive,
  hits,
  index,
  onStep,
  onClose,
}: {
  query: string;
  onQuery: (q: string) => void;
  caseSensitive: boolean;
  onCaseSensitive: (on: boolean) => void;
  /** Already narrowed to the active scope, in document order. */
  hits: FindHit[];
  /** Index into `hits`, or -1. */
  index: number;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on open. Selecting the existing text means reopening find and typing
  // replaces the last query rather than appending to it, which is what every
  // browser's find does.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const count =
    query === ""
      ? ""
      : hits.length === 0
        ? "No results"
        : `${index + 1} / ${hits.length}`;

  return (
      <div className="find-bar">
        <span className="find-glass" aria-hidden>
          ⌕
        </span>
        <input
          ref={inputRef}
          className="find-input"
          type="text"
          role="searchbox"
          aria-label="Find in conversation"
          placeholder="Find in conversation"
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onStep(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              // Ours, and it stops here: App's Escape peels a layer off the grid, and
              // a find bar closing is already that layer. Without this, one press
              // closes find AND collapses the card behind it.
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <span className={`find-count${hits.length === 0 && query !== "" ? " none" : ""}`} role="status">
          {count}
        </span>
        <Tooltip label={caseSensitive ? "Matching case" : "Ignoring case"}>
          <button
            type="button"
            className={`find-btn find-toggle${caseSensitive ? " on" : ""}`}
            aria-pressed={caseSensitive}
            onClick={() => onCaseSensitive(!caseSensitive)}
          >
            Aa
          </button>
        </Tooltip>
        <span className="find-sep" />
        <Tooltip label="Previous match (Shift+Enter)">
          <button
            type="button"
            className="find-btn"
            disabled={hits.length === 0}
            aria-label="Previous match"
            onClick={() => onStep(-1)}
          >
            ‹
          </button>
        </Tooltip>
        <Tooltip label="Next match (Enter)">
          <button
            type="button"
            className="find-btn"
            disabled={hits.length === 0}
            aria-label="Next match"
            onClick={() => onStep(1)}
          >
            ›
          </button>
        </Tooltip>
        <Tooltip label="Close find (Esc)">
          <button type="button" className="find-btn" aria-label="Close find" onClick={onClose}>
            ✕
          </button>
        </Tooltip>
      </div>
  );
}

export function ConversationFindRail({
  query,
  scope,
  onScope,
  hits,
  index,
  onJump,
  loadedOnly,
  onLoadOlder,
}: {
  query: string;
  scope: FindScope;
  onScope: (s: FindScope) => void;
  /** Already narrowed to the active scope, in document order. */
  hits: FindHit[];
  /** Index into `hits`, or -1. */
  index: number;
  onJump: (i: number) => void;
  /**
   * Whether older turns exist that this search has NOT looked at. The transcript log
   * is windowed, so a count taken over what is loaded is not a count over the
   * conversation - saying "12" while forty more sit behind the scroll-back button is
   * a confidently wrong number, and this row is what stops the count implying it.
   */
  loadedOnly: boolean;
  onLoadOlder: () => void;
}): React.JSX.Element {
  const railRef = useRef<HTMLDivElement>(null);

  // Keep the rail's current row in view as the ring is stepped from the keyboard.
  useEffect(() => {
    railRef.current?.querySelector(".find-result.is-current")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
      <aside className="find-rail" aria-label="Search results">
        <div className="find-rail-head">
          Results <span className="find-count">{query === "" ? "" : hits.length}</span>
        </div>
        <div className="find-scopes">
          {SCOPES.map((s) => (
            <Tooltip key={s.id} label={s.hint}>
              <button
                type="button"
                className="find-scope"
                aria-pressed={scope === s.id}
                onClick={() => onScope(s.id)}
              >
                {s.label}
              </button>
            </Tooltip>
          ))}
        </div>
        <div className="find-results" ref={railRef}>
          {query === "" ? (
            <div className="find-rail-empty">Type to search this conversation.</div>
          ) : hits.length === 0 ? (
            <div className="find-rail-empty">
              Nothing matches <b>{query}</b>
              {scope === "all" ? "" : " in this scope"}.
            </div>
          ) : (
            hits.map((h, i) => (
              // The snippet is elided at both ends, so the tooltip is where the rest of
              // the line goes - it says which turn the jump lands on rather than
              // repeating the text already rendered in the row.
              <Tooltip key={h.key} label={`Jump to match ${i + 1} of ${hits.length}, from ${h.who}`}>
                <button
                  type="button"
                  className={`find-result r-${h.scope}${i === index ? " is-current" : ""}`}
                  // Keep the caret in the query box: clicking a result is navigation,
                  // not a reason to stop typing.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onJump(i)}
                >
                  <span className="find-result-who">{h.who}</span>
                  <span className="find-result-snip">
                    {h.pre}
                    <b>{h.hit}</b>
                    {h.post}
                  </span>
                </button>
              </Tooltip>
            ))
          )}
        </div>
        {loadedOnly && query !== "" && (
          <div className="find-beyond">
            <span>Searching loaded turns only.</span>
            <Tooltip label="Read further back in this session's transcript, then search it too">
              <button type="button" onClick={onLoadOlder}>
                Load older
              </button>
            </Tooltip>
          </div>
        )}
      </aside>
  );
}
