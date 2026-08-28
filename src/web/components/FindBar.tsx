import { useEffect, useRef } from "react";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The find bar - the app's one find chrome, wherever find is.
 *
 * Lifted out of `ConversationFind.tsx` when the Files workspace grew a find of its own, so
 * the two surfaces cannot drift into looking or behaving differently. The markup is the
 * conversation's, unchanged, which is why that panel's existing specs are untouched: only
 * the accessible name, the placeholder and an optional note are parameterized.
 *
 * **The count and the current position are SUPPLIED, never derived here.** The bar has no
 * hit array and must not grow one. Each surface searches the string it renders - source in
 * the Editor, rendered text in Markdown preview - so the number the bar shows can only come
 * from whichever surface is on screen. It is also what lets the sandboxed HTML preview
 * report its own count later without editing this component.
 */
export function FindBar({
  label,
  placeholder = label,
  note = null,
  query,
  onQuery,
  caseSensitive,
  onCaseSensitive,
  count,
  index,
  focusNonce = 0,
  onStep,
  onClose,
}: {
  /** The searchbox's accessible name, which is also a test's handle on this bar. */
  label: string;
  placeholder?: string;
  /**
   * A short caveat about what the count means, or null.
   *
   * The HTML preview's is the case this exists for: its matches are counted over source and
   * located by block, and saying so is the honest alternative to a number that quietly
   * includes matches the rendered page does not show.
   */
  note?: string | null;
  query: string;
  onQuery: (q: string) => void;
  caseSensitive: boolean;
  onCaseSensitive: (on: boolean) => void;
  /** How many matches the ACTIVE surface has. Supplied - see this component's header. */
  count: number;
  /** Index into that surface's matches, or -1. */
  index: number;
  /**
   * Bumped to focus and select the query again.
   *
   * A nonce rather than mount alone, because pressing the chord while find is already open
   * is a request to retype the query - which is what every browser's find does - and the bar
   * stays mounted across it.
   */
  focusNonce?: number;
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
  }, [focusNonce]);

  const readout =
    query === ""
      ? ""
      : count === 0
        ? "No results"
        : `${index + 1} / ${count}`;

  return (
    <div className={`find-bar${note ? " has-note" : ""}`}>
      <span className="find-glass" aria-hidden>
        ⌕
      </span>
      <input
        ref={inputRef}
        className="find-input"
        type="text"
        role="searchbox"
        aria-label={label}
        placeholder={placeholder}
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
      <span className={`find-count${count === 0 && query !== "" ? " none" : ""}`} role="status">
        {readout}
      </span>
      {note && (
        <Tooltip label={note}>
          <span className="find-note" role="note">
            {note}
          </span>
        </Tooltip>
      )}
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
          disabled={count === 0}
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
          disabled={count === 0}
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
