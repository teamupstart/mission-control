import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Tooltip } from "./Tooltip.tsx";

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
 *
 * It is exactly as wide as its input, and that is a constraint on CALLERS rather than
 * a limitation here. Repo paths share a long leading prefix - every one under a
 * workspace root begins with the same 28 characters - so a field too narrow for its
 * longest path ellipsizes precisely the component that tells two repos apart, in every
 * row at once. Sizing the list to its content instead was tried and reverted: it fixed
 * a narrow settings row by making the list overhang the dispatch modal's right edge,
 * which this component cannot know the bounds of. Give the field room in its own
 * layout (`.wf-settings-check-add` is the worked example) rather than letting the menu
 * escape it.
 *
 * The three optional props are what a settings ROW needs and a modal field does
 * not, and each is a fact the caller alone knows: which sentence the empty box
 * should say, whether the row it sits in is mid-write, and the id an `sr-only`
 * `<label htmlFor>` names - a label outside the widget cannot reach the input by
 * containment the way the dispatch form's wrapping `<label>` does.
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
  id,
  placeholder = "search repos or type a path…",
  disabled = false,
}: {
  repos: string[];
  value: string;
  onChange: (v: string) => void;
  /** Set when an `sr-only <label htmlFor>` outside the widget names this input. */
  id?: string;
  placeholder?: string;
  /** A row mid-write. The list closes with the input rather than floating over a dead field. */
  disabled?: boolean;
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
  // Nothing to offer once the text already equals the only remaining match. `disabled` is
  // read here too, but only to cover the single render before the effect below lands: it
  // stops a live dropdown being painted over a field that has just stopped taking input.
  // Suppressing the render is NOT what keeps it shut - see that effect.
  const showList =
    open && !disabled && matches.length > 0 && !(matches.length === 1 && matches[0] === value);

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

  // A row that goes busy CLOSES the list, rather than merely stopping it being drawn.
  // Hiding it on `disabled` alone leaves `open` true underneath, so the dropdown comes
  // back by itself the moment the row is enabled again - over a field nobody touched.
  //
  // The click-away closer above does not cover this, and the settings row is the case
  // that proves it: its submit button can be reached by the KEYBOARD, and an activation
  // that way dispatches click with no mousedown, so nothing tells this widget the pointer
  // ever left. Measured before this effect existed: type a repo, activate Add command
  // without a pointer, and when the write lands the list reappears with all 202 options -
  // full width, because a successful add clears the field and an empty field matches
  // every repo.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

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
        id={id}
        className="field-input mono"
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        placeholder={placeholder}
        disabled={disabled}
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
              <Tooltip key={r} label={r}>
                <li
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
              </Tooltip>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
