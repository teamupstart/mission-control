import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AUTOPILOT_FACETS,
  AUTOPILOT_FACET_LABELS,
  DEP_FACETS,
  DEP_FACET_LABELS,
  EMPTY_BACKLOG_FILTER,
  backlogFacetCount,
  backlogFilterActive,
  searchHighlights,
  toggleFacet,
  type BacklogAutopilotFacet,
  type BacklogDepFacet,
  type BacklogFacetCounts,
  type BacklogFilter,
} from "../lib/backlog-filter.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Search and filter controls for the backlog, drawn by the Board's Backlog column and the
 * Line's Backlog drawer. The filtering rules themselves live in `lib/backlog-filter.ts`;
 * this file is only the controls a person uses to set them.
 *
 * Three pieces, because the two hosts put them in different places:
 *
 *  - `BacklogFilterButtons` - a search toggle and a Filter menu, for the host's header, so
 *    the header keeps its height when nothing is filtered.
 *  - `BacklogFilterStrip` - the search field and one removable chip per active filter, shown
 *    under the header only while there is something to show. A filter that is on is always
 *    visible here, so a half-empty column never reads as a half-empty backlog.
 *  - `BacklogFilterEmpty` - what a host says when its filter hides everything.
 */

export interface BacklogFilterState {
  filter: BacklogFilter;
  setFilter: (next: BacklogFilter) => void;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  active: boolean;
  clear: () => void;
}

/**
 * One host's filter. Held in component state, so it lasts while the column or drawer is on
 * screen and resets on reload: a filter is a way of looking, not a setting.
 */
export function useBacklogFilter(): BacklogFilterState {
  const [filter, setFilter] = useState<BacklogFilter>(EMPTY_BACKLOG_FILTER);
  const [searchOpen, setSearchOpen] = useState(false);
  return {
    filter,
    setFilter,
    searchOpen,
    setSearchOpen,
    active: backlogFilterActive(filter),
    clear: () => {
      setFilter(EMPTY_BACKLOG_FILTER);
      setSearchOpen(false);
    },
  };
}

/** The menu's width, which its placement needs before it has rendered. */
const MENU_WIDTH = 236;
const MENU_MARGIN = 8;

/** The field shows while it is open or while it still holds a search, which is still filtering. */
function searchFieldShown(state: BacklogFilterState): boolean {
  return state.searchOpen || state.filter.query !== "";
}

/** "3 of 23" while a filter hides something, otherwise the plain total. */
export function backlogShownCount(shown: number, total: number, active: boolean): string {
  return active ? `${shown} of ${total}` : String(total);
}

export function BacklogFilterButtons({
  state,
  counts,
}: {
  state: BacklogFilterState;
  counts: BacklogFacetCounts;
}): React.JSX.Element {
  const { filter, setFilter, setSearchOpen } = state;
  const [open, setOpen] = useState(false);
  const searchShown = searchFieldShown(state);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const checked = backlogFacetCount(filter);

  // Fixed to the viewport and portalled to the body: both hosts clip their own overflow, and
  // the Line drawer is only three rows tall, so a menu positioned inside either would be cut.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      // Right-aligned to the button where it fits, otherwise left-aligned, and always inside
      // the window: the Board column's button can sit at the window's left edge.
      const preferred = r.right - MENU_WIDTH >= MENU_MARGIN ? r.right - MENU_WIDTH : r.left;
      const left = Math.min(Math.max(MENU_MARGIN, preferred), window.innerWidth - MENU_WIDTH - MENU_MARGIN);
      setAt({ top: r.bottom + 6, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Escape closes the menu and only the menu, taken in the capture phase for the reason
  // OpenInMenu gives: the board's drill-in and the Line drawer also listen for it.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!pop.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && at) pop.current?.querySelector<HTMLButtonElement>("[role='menuitemcheckbox']")?.focus();
  }, [open, at]);

  const row = <T extends string>(
    value: T,
    label: string,
    selected: readonly T[],
    toggle: (value: T) => void,
  ): React.JSX.Element => {
    const on = selected.includes(value);
    return (
      <Tooltip key={value} label={on ? `Stop showing only "${label}" tasks` : `Show only "${label}" tasks`}>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={on}
          className={`bl-filter-row${on ? " is-on" : ""}`}
          onClick={() => toggle(value)}
        >
          <span className="bl-filter-box" aria-hidden />
          <span className="bl-filter-label">{label}</span>
          <span className="bl-filter-count">{counts[value as keyof BacklogFacetCounts]}</span>
        </button>
      </Tooltip>
    );
  };

  return (
    <span className="bl-filter-btns" onDoubleClick={(e) => e.stopPropagation()}>
      <Tooltip
        label={
          !searchShown
            ? "Search the backlog by title, intent, label or repository"
            : filter.query
              ? "Clear and hide the backlog search"
              : "Hide the backlog search"
        }
      >
        <button
          type="button"
          className={`bl-filter-btn${searchShown ? " is-on" : ""}`}
          aria-label="Search the backlog"
          aria-pressed={searchShown}
          onClick={() => {
            // Hiding the field clears it too: a search left filtering behind a closed field
            // would hide cards with nothing on screen saying why.
            if (searchShown) {
              setFilter({ ...filter, query: "" });
              setSearchOpen(false);
            } else {
              setSearchOpen(true);
            }
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip label="Show only tasks that are ready or blocked, or that autopilot may or may not start">
        <button
          ref={trigger}
          type="button"
          className={`bl-filter-btn${checked > 0 ? " is-on" : ""}`}
          aria-label={checked > 0 ? `Filter the backlog, ${checked} active` : "Filter the backlog"}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          Filter{checked > 0 && <span className="bl-filter-badge">{checked}</span>}
        </button>
      </Tooltip>
      {open &&
        at &&
        createPortal(
          <div
            ref={pop}
            className="bl-filter-pop"
            role="menu"
            aria-label="Backlog filters"
            style={{ top: at.top, left: at.left, width: MENU_WIDTH }}
          >
            <div role="group" aria-label="Dependencies">
              <p className="bl-filter-head" aria-hidden>Dependencies</p>
              {DEP_FACETS.map((v) =>
                row<BacklogDepFacet>(v, DEP_FACET_LABELS[v], filter.deps, (value) =>
                  setFilter({ ...filter, deps: toggleFacet(filter.deps, value, DEP_FACETS) }),
                ),
              )}
            </div>
            <div role="group" aria-label="Autopilot">
              <p className="bl-filter-head" aria-hidden>Autopilot</p>
              {AUTOPILOT_FACETS.map((v) =>
                row<BacklogAutopilotFacet>(v, AUTOPILOT_FACET_LABELS[v], filter.autopilot, (value) =>
                  setFilter({ ...filter, autopilot: toggleFacet(filter.autopilot, value, AUTOPILOT_FACETS) }),
                ),
              )}
            </div>
            {checked > 0 && (
              <Tooltip label="Uncheck every filter and keep the search">
                <button
                  type="button"
                  role="menuitem"
                  className="bl-filter-reset"
                  onClick={() => setFilter({ ...filter, deps: [], autopilot: [] })}
                >
                  Clear filters
                </button>
              </Tooltip>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}

export function BacklogFilterStrip({ state }: { state: BacklogFilterState }): React.JSX.Element | null {
  const { filter, setFilter, searchOpen, setSearchOpen } = state;
  const input = useRef<HTMLInputElement>(null);
  const showSearch = searchFieldShown(state);
  const chips = [
    ...filter.deps.map((v) => ({
      label: DEP_FACET_LABELS[v],
      remove: () => setFilter({ ...filter, deps: filter.deps.filter((d) => d !== v) }),
    })),
    ...filter.autopilot.map((v) => ({
      label: AUTOPILOT_FACET_LABELS[v],
      remove: () => setFilter({ ...filter, autopilot: filter.autopilot.filter((a) => a !== v) }),
    })),
  ];

  // Focus on the click that opened it, not on every render that keeps it open.
  useEffect(() => {
    if (searchOpen) input.current?.focus();
  }, [searchOpen]);

  if (!showSearch && chips.length === 0) return null;
  return (
    <div className="bl-filter-strip">
      {showSearch && (
        <span className="bl-filter-search">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            ref={input}
            type="text"
            aria-label="Search backlog tasks"
            placeholder="Title, intent, label or repo"
            value={filter.query}
            onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // Stopped here so Escape in the field clears the search and nothing else.
              e.preventDefault();
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              setFilter({ ...filter, query: "" });
              setSearchOpen(false);
            }}
          />
          <Tooltip label="Clear the search">
            <button
              type="button"
              className="bl-filter-x"
              aria-label="Clear the backlog search"
              onClick={() => {
                setFilter({ ...filter, query: "" });
                setSearchOpen(false);
              }}
            >
              ✕
            </button>
          </Tooltip>
        </span>
      )}
      {chips.length > 0 && (
        <span className="bl-filter-chips">
          {chips.map((chip) => (
            <Tooltip key={chip.label} label={`Stop filtering to "${chip.label}"`}>
              <button
                type="button"
                className="bl-filter-chip"
                aria-label={`Remove filter: ${chip.label}`}
                onClick={chip.remove}
              >
                {chip.label} <span aria-hidden>✕</span>
              </button>
            </Tooltip>
          ))}
        </span>
      )}
    </div>
  );
}

/** Said when a filter hides tasks, so the hidden ones are never mistaken for gone ones. */
export function BacklogFilterEmpty({
  hidden,
  shown,
  onClear,
  className = "",
}: {
  hidden: number;
  shown: number;
  onClear: () => void;
  className?: string;
}): React.JSX.Element | null {
  if (hidden === 0) return null;
  return (
    <p className={`bl-filter-hidden ${className}`.trim()} role="status">
      {shown === 0 ? "No backlog tasks match. " : ""}
      {hidden} {hidden === 1 ? "task" : "tasks"} hidden by search and filters.{" "}
      <Tooltip label="Clear the search and every filter, and show the whole backlog">
        <button type="button" className="bl-filter-clear" onClick={onClear}>
          Clear
        </button>
      </Tooltip>
    </p>
  );
}

/** A title with the search words marked. */
export function HighlightedTitle({ text, query }: { text: string; query: string }): React.JSX.Element {
  const runs = searchHighlights(text, query);
  if (runs.length === 1 && !runs[0]?.hit) return <>{text}</>;
  return (
    <>
      {runs.map((run, i) => (run.hit ? <mark key={i} className="bl-hit">{run.text}</mark> : run.text))}
    </>
  );
}
