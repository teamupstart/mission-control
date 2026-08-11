import { useMemo, useState } from "react";
import type { MissionSchedule } from "@shared/schedules.ts";
import {
  cadenceLabel,
  scheduleHealthLabel,
  scheduleHealthTone,
  scheduleMatchesFilter,
  scheduleMatchesQuery,
  shortRepo,
  sortSchedulesForCatalog,
  type ScheduleCatalogFilter,
} from "../../lib/schedules.ts";
import { Tooltip } from "../Tooltip.tsx";

/**
 * The catalog rail: search, filter, and a selectable list of the live missions.
 *
 * It reads `MissionState.schedules` and NEVER fetches - the catalog is SSE-owned, so an
 * upsert reorders these rows live and a remove drops one, with no poll. Health is the
 * server's word (`schedule.health`); this only paints the tone. Its empty / no-match /
 * disconnected / loading states are all derived from the props it is handed, so it renders
 * a sensible screen before the first snapshot arrives without going and asking for the list.
 *
 * It is a RAIL, not a table. It used to be a five-column grid holding a cadence, a next
 * instant and an execution mode, given more width than the detail beside it and truncating
 * every one of them mid-word; the detail owns those facts, so a row here carries only what
 * picks one mission out of a list. Execution mode is not per-row information at all in V1 -
 * every mission has the same one - so it appears only when it is UNREADABLE, which is the
 * case a row genuinely has to flag.
 */

const FILTERS: { id: ScheduleCatalogFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "healthy", label: "Healthy" },
  { id: "paused", label: "Paused" },
  { id: "attention", label: "Attention" },
];

export function ScheduleCatalog({
  schedules,
  selectedId,
  onSelect,
  connected,
  hasSnapshot,
}: {
  schedules: MissionSchedule[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  connected: boolean;
  hasSnapshot: boolean;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ScheduleCatalogFilter>("all");

  const visible = useMemo(
    () =>
      sortSchedulesForCatalog(
        schedules.filter(
          (schedule) =>
            scheduleMatchesFilter(schedule, filter) && scheduleMatchesQuery(schedule, query),
        ),
      ),
    [schedules, filter, query],
  );

  return (
    <div className="rm-catalog">
      <div className="rm-catalog-toolbar">
        <div className="rm-search">
          <span aria-hidden>⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, repo, agent, labels…"
            aria-label="Search recurring missions"
          />
        </div>
        <div className="rm-seg" role="tablist" aria-label="Filter by health">
          {FILTERS.map((entry) => (
            <Tooltip key={entry.id} label={`Show ${entry.label.toLowerCase()} missions`}>
              <button
                role="tab"
                aria-selected={filter === entry.id}
                className={filter === entry.id ? "is-active" : ""}
                onClick={() => setFilter(entry.id)}
              >
                {entry.label}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      {!connected && (
        <p className="rm-banner rm-banner-attention">
          Live connection lost - showing the last known catalog. It will refresh on reconnect.
        </p>
      )}

      {!hasSnapshot && schedules.length === 0 ? (
        <p className="rm-empty">Loading catalog…</p>
      ) : schedules.length === 0 ? (
        <p className="rm-empty">
          No recurring missions yet. Create one to file a task on a cadence.
        </p>
      ) : visible.length === 0 ? (
        <p className="rm-empty">No missions match this search or filter.</p>
      ) : (
        /* A real list of real list items. The row used to be `<button role="listitem">`,
           where the explicit role REPLACES the implicit button role - so assistive tech was
           told the catalog's primary control was a list item and never that it could be
           activated. The semantics now come from the elements themselves. */
        <ul className="rm-catalog-rows">
          {visible.map((schedule) => (
            <li key={schedule.id}>
              <ScheduleRow
                schedule={schedule}
                selected={schedule.id === selectedId}
                onSelect={() => onSelect(schedule.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScheduleRow({
  schedule,
  selected,
  onSelect,
}: {
  schedule: MissionSchedule;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <Tooltip
      label={
        schedule.template?.repoRoot
          ? `${schedule.template.repoRoot} - open ${schedule.name}`
          : `Open ${schedule.name}`
      }
    >
      <button
        className={`rm-row${selected ? " is-selected" : ""}`}
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
      >
        <span className="rm-row-icon" aria-hidden>
          ◷
        </span>
        <span className="rm-row-main">
          <strong className="rm-row-name">{schedule.name}</strong>
          {/* What picks this mission out of a list, and nothing else. The next instant is
              the first thing the spine beside it draws, and squeezing it in here only cost
              a mid-word truncation. */}
          <span className="rm-row-sub">
            {cadenceLabel(schedule.expression)} · {shortRepo(schedule.template?.repoRoot)}
          </span>
        </span>
        {/* Not wrapped in a Tooltip: this row IS a Tooltip trigger, and a nested one inside
            it would fire both bubbles off the same hover. The detail pane carries the
            explanation. */}
        {schedule.executionMode === null && <span className="rm-row-flag">unreadable</span>}
        {/* A bare dot, not a text-less pill: the pill's rounded chrome around a lone dot
            read as a toggle switch in a rail this narrow. The health WORD is the dot's
            accessible name, so nothing is lost to anyone reading it aloud. */}
        <span
          className={`rm-row-dot rm-dot-${scheduleHealthTone(schedule.health)}`}
          role="img"
          aria-label={scheduleHealthLabel(schedule.health)}
        />
      </button>
    </Tooltip>
  );
}
