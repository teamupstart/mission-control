import { useMemo, useState } from "react";
import type { MissionSchedule } from "@shared/schedules.ts";
import {
  cadenceLabel,
  formatInstant,
  scheduleHealthTone,
  scheduleMatchesFilter,
  scheduleMatchesQuery,
  shortRepo,
  sortSchedulesForCatalog,
  type ScheduleCatalogFilter,
} from "../../lib/schedules.ts";
import { Tooltip } from "../Tooltip.tsx";

/**
 * The left half of the catalog: search, filter, and a selectable list of the live
 * schedules.
 *
 * It reads `MissionState.schedules` and NEVER fetches - the catalog is SSE-owned, so an
 * upsert reorders these rows live and a remove drops one, with no poll. Health is the
 * server's word (`schedule.health`); this only paints the tone. Its empty / no-match /
 * disconnected / loading states are all derived from the props it is handed, so it renders
 * a sensible screen before the first snapshot arrives without going and asking for the list.
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
            aria-label="Search schedules"
          />
        </div>
        <div className="rm-seg" role="tablist" aria-label="Filter by health">
          {FILTERS.map((entry) => (
            <Tooltip key={entry.id} label={`Show ${entry.label.toLowerCase()} schedules`}>
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

      <div className="rm-catalog-rows" role="list">
        {!hasSnapshot && schedules.length === 0 ? (
          <p className="rm-empty">Loading catalog…</p>
        ) : schedules.length === 0 ? (
          <p className="rm-empty">
            No recurring missions yet. Create one to file a task on a cadence.
          </p>
        ) : visible.length === 0 ? (
          <p className="rm-empty">No schedules match this search or filter.</p>
        ) : (
          visible.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              selected={schedule.id === selectedId}
              onSelect={() => onSelect(schedule.id)}
            />
          ))
        )}
      </div>
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
  const last = schedule.lastOccurrence;
  return (
    <Tooltip label={`Open ${schedule.name}`}>
    <button
      role="listitem"
      className={`rm-row${selected ? " is-selected" : ""}`}
      onClick={onSelect}
      aria-current={selected}
    >
      <span className="rm-row-icon" aria-hidden>
        ◷
      </span>
      <span className="rm-row-main">
        <strong className="rm-row-name">{schedule.name}</strong>
        <span className="rm-row-sub">
          {shortRepo(schedule.template?.repoRoot)} · {schedule.template?.agent ?? "-"}
        </span>
      </span>
      <span className="rm-row-cadence">
        <span>{cadenceLabel(schedule.expression)}</span>
        <span className="rm-dim rm-tiny">{schedule.timezone}</span>
      </span>
      <span className="rm-row-next">
        {schedule.nextRunAt != null ? (
          formatInstant(schedule.nextRunAt, schedule.timezone)
        ) : (
          <span className="rm-dim">{schedule.enabled ? "no next run" : "paused"}</span>
        )}
        {last?.status != null && (
          <span className="rm-dim rm-tiny">last: {last.status}</span>
        )}
      </span>
      <span className={`rm-pill rm-pill-${scheduleHealthTone(schedule.health)}`}>
        {schedule.health}
      </span>
    </button>
    </Tooltip>
  );
}
