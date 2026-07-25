import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MissionSchedule,
  ScheduleOccurrence,
} from "@shared/schedules.ts";
import { SCHEDULE_HISTORY_DEFAULT_LIMIT } from "@shared/schedules.ts";
import { fetchScheduleHistory } from "../../lib/api.ts";
import {
  formatAuditInstantUtc,
  formatDelay,
  formatInstant,
  delayIsLate,
  occurrenceStatusView,
  shortTaskId,
  triggerKindLabel,
} from "../../lib/schedules.ts";
import { Tooltip } from "../Tooltip.tsx";

const DEEP_LINK_PAGE_LIMIT = 40;

/**
 * A schedule's occurrence history, paged on demand and never polled.
 *
 * On-demand is the whole contract: the live catalog is SSE-owned, but history is
 * page-oriented and read only when it is opened, so this fetches a page when it mounts (or
 * the schedule changes) and one more each time the operator asks for older rows - no
 * interval, no effect poller, no global collection. A request id guards against a stale
 * page landing after the operator has switched schedules, and rows are de-duplicated by id
 * so a "Load older" that overlaps the last cursor never doubles a row.
 *
 * The page carries its schedule INCLUDING an archived one, which is what lets a generated
 * task deep-link here after the schedule has left the catalog. The audit detail shows only
 * facts the ledger actually persisted - it never invents an "SSE emitted at" timestamp the
 * database does not hold.
 */
export function ScheduleHistory({
  scheduleId,
  fallbackName,
  initialOccurrenceId,
  onOpenTask,
}: {
  scheduleId: string;
  /** A name to show while the first page (which carries the real schedule) is loading. */
  fallbackName?: string | null;
  initialOccurrenceId?: string | null;
  /** Open a generated backlog/finished task from a history row. */
  onOpenTask?: (taskId: string) => void;
}): React.JSX.Element {
  const [schedule, setSchedule] = useState<MissionSchedule | null>(null);
  const [rows, setRows] = useState<ScheduleOccurrence[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialOccurrenceId ?? null);

  // Every fetch stamps this; a response whose stamp is stale (the schedule changed under
  // it) is dropped rather than merged into the wrong schedule's list.
  const requestRef = useRef(0);

  // First page on mount / schedule change. Resetting here is what makes a schedule switch
  // discard the previous schedule's accumulated rows rather than appending across them.
  useEffect(() => {
    const stamp = ++requestRef.current;
    setSchedule(null);
    setRows([]);
    setCursor(null);
    setDone(false);
    setLoading(true);
    setError(null);
    setSelectedId(initialOccurrenceId ?? null);
    void (async () => {
      let before: number | null = null;
      let accumulated: ScheduleOccurrence[] = [];
      const pageLimit = initialOccurrenceId ? DEEP_LINK_PAGE_LIMIT : 1;

      for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
        const page = await fetchScheduleHistory(scheduleId, {
          before,
          limit: SCHEDULE_HISTORY_DEFAULT_LIMIT,
        });
        if (stamp !== requestRef.current) return;
        if (!page) {
          setLoading(false);
          setError(
            pageIndex === 0
              ? "History is unavailable for this schedule."
              : "Could not load the requested occurrence.",
          );
          return;
        }

        setError(null);
        const seen = new Set(accumulated.map((occurrence) => occurrence.id));
        accumulated = [
          ...accumulated,
          ...page.occurrences.filter((occurrence) => !seen.has(occurrence.id)),
        ];
        setSchedule(page.schedule);
        setRows(accumulated);
        setCursor(page.nextCursor);
        setDone(page.nextCursor === null);

        if (
          !initialOccurrenceId ||
          accumulated.some((occurrence) => occurrence.id === initialOccurrenceId) ||
          page.nextCursor === null
        ) {
          if (initialOccurrenceId) setSelectedId(initialOccurrenceId);
          setLoading(false);
          return;
        }
        before = page.nextCursor;
      }

      setLoading(false);
      setError("Could not load the requested occurrence.");
    })();
    // initialOccurrenceId only seeds the selection; it must not re-fetch the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleId]);

  function loadOlder(): void {
    if (done || loading || cursor === null) return;
    const stamp = requestRef.current;
    setError(null);
    setLoading(true);
    void fetchScheduleHistory(scheduleId, {
      before: cursor,
      limit: SCHEDULE_HISTORY_DEFAULT_LIMIT,
    }).then((page) => {
      if (stamp !== requestRef.current) return;
      setLoading(false);
      if (!page) {
        setError("Could not load older occurrences.");
        return;
      }
      setError(null);
      setRows((prev) => {
        const seen = new Set(prev.map((o) => o.id));
        return [...prev, ...page.occurrences.filter((o) => !seen.has(o.id))];
      });
      setCursor(page.nextCursor);
      setDone(page.nextCursor === null);
    });
  }

  const selected = useMemo(
    () => rows.find((o) => o.id === selectedId) ?? null,
    [rows, selectedId],
  );

  const displayName = schedule?.name ?? fallbackName ?? "Schedule";

  return (
    <div className="rm-history">
      <section className="rm-history-list">
        <div className="rm-panel-head">
          <h3>{displayName} · run history</h3>
          {schedule?.archivedAt != null && (
            <span className="rm-badge-inline rm-badge-neutral">archived</span>
          )}
        </div>
        {error && (
          <p className="rm-error" role="alert">
            {error}
            <br />
            <span className="rm-mono rm-tiny">
              Schedule {scheduleId}
              {initialOccurrenceId ? ` · occurrence ${initialOccurrenceId}` : ""}
            </span>
          </p>
        )}
        {rows.length === 0 && !loading && !error && (
          <p className="rm-empty">No occurrences recorded yet.</p>
        )}
        {rows.length > 0 && (
          <div className="rm-table-wrap">
            <table className="rm-table">
              <thead>
                <tr>
                  <th>Scheduled for</th>
                  <th>Trigger</th>
                  <th>Outcome</th>
                  <th>Timing</th>
                  <th>Task</th>
                  <th>Rev</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((occ) => {
                  const status = occurrenceStatusView(occ.status);
                  return (
                    <tr
                      key={occ.id}
                      className={occ.id === selectedId ? "is-selected" : ""}
                      onClick={() => setSelectedId(occ.id)}
                      onKeyDown={(event) => {
                        if (
                          event.currentTarget === event.target &&
                          (event.key === "Enter" || event.key === " ")
                        ) {
                          event.preventDefault();
                          setSelectedId(occ.id);
                        }
                      }}
                      tabIndex={0}
                      aria-label={`${formatAuditInstantUtc(occ.scheduledFor)}, ${status.label}`}
                    >
                      <td className="rm-mono">
                        <HistoryInstant
                          at={occ.scheduledFor}
                          timezone={schedule?.timezone ?? null}
                        />
                      </td>
                      <td>{triggerKindLabel(occ.triggerKind)}</td>
                      <td>
                        <span className={`rm-badge-inline rm-badge-${status.tone}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className={delayIsLate(occ.delayMs) ? "rm-late" : ""}>
                        {formatDelay(occ.delayMs)}
                      </td>
                      <td>
                        {occ.taskId ? (
                          onOpenTask ? (
                            <Tooltip label="Open the backlog/finished task this occurrence filed">
                              <button
                                className="rm-link"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onOpenTask(occ.taskId!);
                                }}
                              >
                                {shortTaskId(occ.taskId)}
                              </button>
                            </Tooltip>
                          ) : (
                            <span className="rm-mono">{shortTaskId(occ.taskId)}</span>
                          )
                        ) : (
                          <span className="rm-dim">-</span>
                        )}
                      </td>
                      <td className="rm-dim">rev {occ.scheduleRevision}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!done && rows.length > 0 && (
          <Tooltip label="Fetch the next page of older occurrences">
            <button className="btn rm-load-older" onClick={loadOlder} disabled={loading}>
              {loading ? "Loading…" : "Load older"}
            </button>
          </Tooltip>
        )}
        {loading && rows.length === 0 && <p className="rm-empty">Loading history…</p>}
      </section>

      <aside className="rm-history-detail">
        {selected ? (
          <OccurrenceDetail
            occurrence={selected}
            timezone={schedule?.timezone ?? null}
            onOpenTask={onOpenTask}
          />
        ) : (
          <p className="rm-empty">Select an occurrence to see its audit.</p>
        )}
      </aside>
    </div>
  );
}

function HistoryInstant({
  at,
  timezone,
}: {
  at: number;
  timezone: string | null;
}): React.JSX.Element {
  return (
    <>
      <div>{formatAuditInstantUtc(at)}</div>
      {timezone && (
        <div className="rm-dim rm-tiny">
          Current zone ({timezone}): {formatInstant(at, timezone)}
        </div>
      )}
    </>
  );
}

function OccurrenceDetail({
  occurrence,
  timezone,
  onOpenTask,
}: {
  occurrence: ScheduleOccurrence;
  timezone: string | null;
  onOpenTask?: (taskId: string) => void;
}): React.JSX.Element {
  const status = occurrenceStatusView(occurrence.status);
  return (
    <div className="rm-occurrence-detail">
      <div className="rm-panel-head">
        <div>
          <h3>{formatAuditInstantUtc(occurrence.scheduledFor)}</h3>
          <span className="rm-tiny rm-dim rm-mono">{occurrence.id} · immutable</span>
        </div>
        <span className={`rm-badge-inline rm-badge-${status.tone}`}>{status.label}</span>
      </div>
      <dl className="rm-kv">
        <dt>Scheduled for</dt>
        <dd className="rm-mono">
          <HistoryInstant at={occurrence.scheduledFor} timezone={timezone} />
        </dd>
        <dt>Trigger</dt>
        <dd>{triggerKindLabel(occurrence.triggerKind)}</dd>
        <dt>Claimed at</dt>
        <dd className="rm-mono">
          <HistoryInstant at={occurrence.claimedAt} timezone={timezone} />
        </dd>
        <dt>Delay</dt>
        <dd className={delayIsLate(occurrence.delayMs) ? "rm-late" : ""}>
          {formatDelay(occurrence.delayMs)}
        </dd>
        {occurrence.finishedAt != null && (
          <>
            <dt>Finished at</dt>
            <dd className="rm-mono">
              <HistoryInstant at={occurrence.finishedAt} timezone={timezone} />
            </dd>
          </>
        )}
        <dt>Revision</dt>
        <dd>rev {occurrence.scheduleRevision}</dd>
        <dt>Generated task</dt>
        <dd>
          {occurrence.taskId ? (
            onOpenTask ? (
              <Tooltip label="Open the task this occurrence filed">
                <button className="rm-link" onClick={() => onOpenTask(occurrence.taskId!)}>
                  {shortTaskId(occurrence.taskId)}
                </button>
              </Tooltip>
            ) : (
              <span className="rm-mono">{shortTaskId(occurrence.taskId)}</span>
            )
          ) : (
            "no task created"
          )}
        </dd>
        {occurrence.coveredById && (
          <>
            <dt>Covered by</dt>
            <dd className="rm-mono">{occurrence.coveredById}</dd>
          </>
        )}
        {occurrence.blockingTaskId && (
          <>
            <dt>Blocked by</dt>
            <dd className="rm-mono">{occurrence.blockingTaskId}</dd>
          </>
        )}
        {occurrence.error && (
          <>
            <dt>Error</dt>
            <dd className="rm-late">{occurrence.error}</dd>
          </>
        )}
      </dl>
      <p className="rm-dim rm-tiny">
        The occurrence key is unique per instant, so a second scheduler tick that finds it
        already claimed does no work - no duplicate task can be created. Catalog and backlog
        updates for this run were delivered over the existing live connection.
      </p>
    </div>
  );
}
