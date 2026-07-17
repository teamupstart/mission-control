import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A themed combobox for a repo path. Replaces the native <datalist>, whose
 * dropdown is browser-chrome and can't be styled to match the dark UI. Filters
 * the known repos as you type, with arrow/enter/click selection and a dropdown
 * that inherits the app's tokens.
 *
 * Shared: the dispatch form picks a base with it, and the Foreman settings panel
 * picks a repo to trust with it. Both want the same thing - "one of the repos I
 * know, or a path I type" - so it lives here rather than inside either caller.
 *
 * The dropdown is rendered in a body-level portal with fixed positioning, so it
 * escapes any scrollable ancestor: absolutely-positioned, it was clipped by the
 * settings pane's `overflow-y: auto` no matter its z-index.
 */

/** Gap in px between the input and the dropdown. */
const LIST_GAP = 4;
/** Tallest the dropdown ever gets, when the viewport has room for it. */
const LIST_MAX_HEIGHT = 220;
/** Breathing room kept between the dropdown and the viewport's bottom edge. */
const VIEWPORT_MARGIN = 8;

export function RepoCombobox({
  repos,
  value,
  onChange,
}: {
  repos: string[];
  value: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const q = value.trim().toLowerCase();
  const matches = q ? repos.filter((r) => r.toLowerCase().includes(q)) : repos;
  // Nothing to offer once the text already equals the only remaining match.
  const showList = open && matches.length > 0 && !(matches.length === 1 && matches[0] === value);

  // Track the input so the portaled list stays glued to it. The scroll listener
  // captures, so an ancestor pane scrolling - not just the window - repositions.
  useLayoutEffect(() => {
    if (!showList) return;
    function place(): void {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const top = r.bottom + LIST_GAP;
      // Fixed means the list can't be scrolled into view, so cap it to the room
      // below the input rather than letting it hang off the viewport's edge.
      const room = window.innerHeight - top - VIEWPORT_MARGIN;
      setPos({ top, left: r.left, width: r.width, maxHeight: Math.min(LIST_MAX_HEIGHT, room) });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [showList]);

  // Collapse when focus/click leaves the widget. The list is portaled outside
  // rootRef, so it has to count as "inside" or picking an option would close
  // the dropdown before the choice registered.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted row in range as the match list shrinks.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  // Keep the highlighted row visible while arrowing through a long repo list.
  useEffect(() => {
    if (!showList) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, showList]);

  function choose(r: string): void {
    onChange(r);
    setActive(0);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!showList) setOpen(true);
      else setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      if (!showList) return;
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (showList && matches[active]) {
        e.preventDefault();
        choose(matches[active]);
      }
    } else if (e.key === "Escape" && open) {
      // Close only the dropdown; keep the surrounding modal/popover open.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="combobox" ref={rootRef}>
      <input
        ref={inputRef}
        className="field-input mono"
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        placeholder="search repos or type a path…"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {showList &&
        pos &&
        createPortal(
          <ul
            className="combobox-list"
            role="listbox"
            ref={listRef}
            style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
          >
            {matches.map((r, i) => (
              <li
                key={r}
                role="option"
                aria-selected={i === active}
                className={`combobox-option${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  // Pick before the input's blur fires, so the click registers.
                  e.preventDefault();
                  choose(r);
                }}
              >
                {r}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
