import { useEffect, useRef, useState } from "react";

/**
 * A themed combobox for a repo path. Replaces the native <datalist>, whose
 * dropdown is browser-chrome and can't be styled to match the dark UI. Filters
 * the known repos as you type, with arrow/enter/click selection and a dropdown
 * that inherits the app's tokens.
 *
 * Shared: the dispatch form picks a base with it, and the Foreman settings panel
 * picks a repo to trust with it. Both want the same thing - "one of the repos I
 * know, or a path I type" - so it lives here rather than inside either caller.
 */
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
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const q = value.trim().toLowerCase();
  const matches = q ? repos.filter((r) => r.toLowerCase().includes(q)) : repos;
  // Nothing to offer once the text already equals the only remaining match.
  const showList = open && matches.length > 0 && !(matches.length === 1 && matches[0] === value);

  // Collapse when focus/click leaves the widget.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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
      {showList && (
        <ul className="combobox-list" role="listbox" ref={listRef}>
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
        </ul>
      )}
    </div>
  );
}
