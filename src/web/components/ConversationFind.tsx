import { useEffect, useRef } from "react";
import type { FindHit, FindScope } from "../lib/find.ts";
import { FindBar } from "./FindBar.tsx";
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
  // Worded around the defect until this pill was fixed: it used to select on the role
  // alone, so "turns sent to the agent" was the honest description of what it returned -
  // Foreman's and the daemon's messages included. It now means what it says.
  { id: "user", label: "You", hint: "Match only the messages you typed" },
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
  // A wrapper over the shared bar, kept so the transcript's call site, its accessible name
  // and its existing specs are untouched by the extraction. The count is passed as a value
  // because the bar has none of its own - see `FindBar`.
  return (
    <FindBar
      label="Find in conversation"
      query={query}
      onQuery={onQuery}
      caseSensitive={caseSensitive}
      onCaseSensitive={onCaseSensitive}
      count={hits.length}
      index={index}
      onStep={onStep}
      onClose={onClose}
    />
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
