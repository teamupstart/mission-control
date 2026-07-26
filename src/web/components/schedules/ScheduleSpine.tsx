import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MissionSchedule,
  ScheduleOccurrence,
  SchedulePreviewResult,
} from "@shared/schedules.ts";
import {
  SCHEDULE_HISTORY_DEFAULT_LIMIT,
  SCHEDULE_PREVIEW_DEFAULT_COUNT,
  SCHEDULE_PREVIEW_MAX_COUNT,
  scheduleIsRunnable,
} from "@shared/schedules.ts";
import {
  fetchScheduleHistory,
  previewSchedule,
  type ScheduleDefinitionPayload,
} from "../../lib/api.ts";
import {
  delayIsLate,
  formatAuditInstantUtc,
  formatCountdown,
  formatDelay,
  formatInstant,
  formatSpan,
  occurrenceStatusView,
  shortTaskId,
  triggerKindLabel,
} from "../../lib/schedules.ts";
import { buildSpineRows } from "../../lib/spine.ts";
import { Tooltip } from "../Tooltip.tsx";

/**
 * One continuous time axis for a recurring mission: what has happened, where nothing did,
 * and what is coming - in that order, downward, on a single rail.
 *
 * It replaced a detail pane that printed the next instant five different ways and two
 * separate screens (Preview, Run history) that each answered half a question about the
 * schedule the operator had just been looking at. Both halves are composed here from the
 * reads that already existed - the paged history GET and the preview POST - so nothing new
 * is asked of the daemon and neither half is recomputed in the browser.
 *
 * **The gap is the point.** Mission Control runs on a laptop that sleeps, so it promises
 * durable catch-up and explicitly NOT wall-clock execution. That is the one structural fact
 * that makes this feature different from cron, and it used to be a paragraph of body text
 * below the fold. Here it is drawn: where an instant sat unclaimed, the rail breaks.
 *
 * Every claim a gap makes is a persisted one. The window is `scheduledFor -> claimedAt` off
 * the occurrence row, and the instants shown inside it are the ones the ledger itself says
 * were folded in (`coveredById`) - never a guess about what the daemon was doing. The
 * headline says how long those occurrences waited, and the standing policy sentence beside
 * it is the product's guarantee, not a diagnosis of this particular gap.
 *
 * A PAUSED or unreadable mission gets no future half at all. Enumerating instants a
 * schedule will not act on would be the one lie this surface exists to remove.
 */

/**
 * How many upcoming instants the spine opens with, and how many each Show more adds.
 * The preview route's own floor - asking for fewer is a validation error, not a smaller
 * answer - so the constant is imported rather than picked.
 */
const FUTURE_PAGE = SCHEDULE_PREVIEW_DEFAULT_COUNT;
/** Redraw the countdowns and the NOW marker on this cadence. Display only - no read. */
const CLOCK_MS = 30_000;

/** Build the preview definition from a saved schedule's active revision. */
function definitionFor(schedule: MissionSchedule | null): ScheduleDefinitionPayload | null {
  if (!schedule?.template || !schedule.overlapPolicy || !schedule.missedPolicy) return null;
  return {
    name: schedule.name,
    expression: schedule.expression,
    timezone: schedule.timezone,
    overlapPolicy: schedule.overlapPolicy,
    missedPolicy: schedule.missedPolicy,
    template: schedule.template,
  };
}

function dayPart(at: number, timezone: string | null): string {
  return formatInstant(at, timezone, { weekday: "short", month: "short", day: "numeric" });
}

function timePart(at: number, timezone: string | null): string {
  return formatInstant(at, timezone, { hour: "numeric", minute: "2-digit" });
}

function mergeOccurrences(
  fresh: ScheduleOccurrence[],
  existing: ScheduleOccurrence[],
): ScheduleOccurrence[] {
  const freshIds = new Set(fresh.map((occurrence) => occurrence.id));
  return [...fresh, ...existing.filter((occurrence) => !freshIds.has(occurrence.id))];
}

export function ScheduleSpine({
  scheduleId,
  schedule,
  fallbackName,
  initialOccurrenceId,
  initialScheduledFor,
  onOpenTask,
  resolveTaskLink,
}: {
  scheduleId: string;
  /**
   * The live catalog row, when there is one. Null on the deep-link route, where the
   * schedule may be archived and out of the catalog entirely - the history page carries
   * its own copy for exactly that case, and that copy is what names and zones this view.
   */
  schedule: MissionSchedule | null;
  fallbackName?: string | null;
  initialOccurrenceId?: string | null;
  /**
   * The deep-linked occurrence's instant. Occurrence identity is `(schedule, scheduled_for)`,
   * so seeding the cursor just past it lands the target on the FIRST page - an O(1) deep
   * link however old the run is. Absent, we fall back to bounded paging.
   */
  initialScheduledFor?: number | null;
  onOpenTask?: (taskId: string) => void;
  resolveTaskLink?: (taskId: string) => { openable: boolean; blockedReason: string | null };
}): React.JSX.Element {
  const [pageSchedule, setPageSchedule] = useState<MissionSchedule | null>(null);
  const [rows, setRows] = useState<ScheduleOccurrence[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialOccurrenceId ?? null);

  const [futureCount, setFutureCount] = useState(FUTURE_PAGE);
  const [preview, setPreview] = useState<SchedulePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [now, setNow] = useState(() => Date.now());

  // A display clock, not a read: nothing is fetched on this tick. It exists so a countdown
  // and the NOW marker do not silently freeze at whatever the last data change left behind.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  // Every history fetch stamps this; a response whose stamp is stale (the schedule changed
  // under it) is dropped rather than merged into the wrong schedule's list.
  const requestRef = useRef(0);
  const deepLinkRef = useRef<HTMLLIElement>(null);

  // First page on mount / schedule change. Resetting here is what makes a schedule switch
  // discard the previous schedule's rows rather than appending across them.
  useEffect(() => {
    const stamp = ++requestRef.current;
    setPageSchedule(null);
    setRows([]);
    setCursor(null);
    setDone(false);
    setLoading(true);
    setError(null);
    setOpenId(initialOccurrenceId ?? null);
    void (async () => {
      let before: number | null =
        initialOccurrenceId && initialScheduledFor != null ? initialScheduledFor + 1 : null;
      let accumulated: ScheduleOccurrence[] = [];
      let firstPage = true;

      for (;;) {
        const page = await fetchScheduleHistory(scheduleId, {
          before,
          limit: SCHEDULE_HISTORY_DEFAULT_LIMIT,
        });
        if (stamp !== requestRef.current) return;
        if (!page) {
          setLoading(false);
          setError(
            firstPage
              ? "History is unavailable for this mission."
              : "Could not load the requested occurrence.",
          );
          return;
        }
        firstPage = false;

        setError(null);
        const seen = new Set(accumulated.map((occurrence) => occurrence.id));
        accumulated = [
          ...accumulated,
          ...page.occurrences.filter((occurrence) => !seen.has(occurrence.id)),
        ];
        setPageSchedule(page.schedule);
        setRows((current) => mergeOccurrences(accumulated, current));
        setCursor(page.nextCursor);
        setDone(page.nextCursor === null);

        if (
          !initialOccurrenceId ||
          accumulated.some((occurrence) => occurrence.id === initialOccurrenceId) ||
          page.nextCursor === null
        ) {
          if (initialOccurrenceId) setOpenId(initialOccurrenceId);
          setLoading(false);
          return;
        }
        before = page.nextCursor;
      }
    })();
    // initialOccurrenceId only seeds the opened audit; it must not re-fetch the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleId]);

  const lastOccurrenceId = schedule?.lastOccurrence?.id ?? null;
  const lastOccurrenceRef = useRef(lastOccurrenceId);
  useEffect(() => {
    const previous = lastOccurrenceRef.current;
    lastOccurrenceRef.current = lastOccurrenceId;
    if (lastOccurrenceId === null || previous === lastOccurrenceId) return;
    const stamp = requestRef.current;
    void fetchScheduleHistory(scheduleId, {
      before: null,
      limit: SCHEDULE_HISTORY_DEFAULT_LIMIT,
    }).then((page) => {
      if (stamp !== requestRef.current || !page) return;
      setPageSchedule(page.schedule);
      setRows((current) => mergeOccurrences(page.occurrences, current));
    });
  }, [lastOccurrenceId, scheduleId]);

  const shown = schedule ?? pageSchedule;
  const timezone = shown?.timezone ?? null;
  const definition = useMemo(() => definitionFor(shown), [shown]);
  // A paused, archived or unreadable mission has no future to draw. Enumerating instants it
  // will never act on is exactly the lie this surface exists to remove.
  const futureReason =
    shown == null
      ? "Loading this mission."
      : shown.archivedAt != null
        ? "This mission is archived. Nothing further is scheduled."
        : !scheduleIsRunnable(shown)
          ? "Written by a newer build - this build cannot enumerate what comes next."
          : !shown.enabled
            ? "Paused. No further occurrence is scheduled until it is resumed."
            : definition == null
              ? "Its stored configuration cannot be read by this build."
              : null;

  useEffect(() => {
    if (!definition || futureReason !== null) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreviewLoading(true);
    void previewSchedule({ ...definition, count: futureCount, excludeScheduleId: scheduleId }).then(
      (result) => {
        if (!alive) return;
        setPreview(result);
        setPreviewLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [definition, futureCount, futureReason, scheduleId]);

  useEffect(() => {
    if (initialOccurrenceId && deepLinkRef.current) {
      deepLinkRef.current.scrollIntoView({ block: "center" });
    }
  }, [initialOccurrenceId, loading]);

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

  const collisionsByInstant = useMemo(() => {
    const map = new Map<number, string[]>();
    if (preview?.ok) {
      for (const collision of preview.collisions) {
        for (const at of collision.at) map.set(at, [...(map.get(at) ?? []), collision.name]);
      }
    }
    return map;
  }, [preview]);

  const spine = useMemo(
    () =>
      buildSpineRows({
        occurrences: rows,
        now,
        instants: preview?.ok ? preview.instants : [],
        stopReason: futureReason,
        collisionsByInstant,
      }),
    [rows, now, preview, futureReason, collisionsByInstant],
  );

  const futureShown = spine.filter((row) => row.kind === "future").length;
  const canShowMore =
    futureReason === null && preview?.ok === true && futureCount < SCHEDULE_PREVIEW_MAX_COUNT;

  return (
    <div className="rm-spine">
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

      <div className="rm-spine-cap">
        {shown && (
          <span className="rm-dim rm-tiny">
            Historical instants use the mission&apos;s current time zone:{" "}
            <span className="rm-mono">{shown.timezone}</span>
          </span>
        )}
      </div>

      <div className="rm-spine-cap">
        {loading && rows.length === 0 ? (
          <span className="rm-dim rm-tiny">Loading history…</span>
        ) : done && rows.length > 0 ? (
          <span className="rm-dim rm-tiny">Start of this mission's history</span>
        ) : rows.length === 0 ? (
          <span className="rm-dim rm-tiny">No occurrence has been recorded yet</span>
        ) : (
          <Tooltip label="Fetch the next page of older occurrences">
            <button className="btn rm-sp-more" onClick={loadOlder} disabled={loading}>
              {loading ? "Loading…" : "↑ Load older"}
            </button>
          </Tooltip>
        )}
      </div>

      <ol className="rm-spine-rows">
        {spine.map((row) => {
          if (row.kind === "gap") {
            return <GapRow key={row.key} row={row} timezone={timezone} />;
          }
          if (row.kind === "now") {
            return (
              <li className="rm-sp-now" key={row.key}>
                <span className="rm-sp-when">now</span>
                <span className="rm-sp-now-bar" />
                <span className="rm-sp-now-time">{timePart(row.at, timezone)}</span>
              </li>
            );
          }
          if (row.kind === "stop") {
            return (
              <li className="rm-sp-row rm-sp-stop" key={row.key}>
                <span className="rm-sp-when" />
                <span className="rm-sp-axis rm-sp-axis-stop">
                  <span className="rm-sp-node rm-sp-node-stop" aria-hidden />
                </span>
                <span className="rm-sp-what">
                  <span className="rm-sp-line rm-dim">{row.reason}</span>
                </span>
              </li>
            );
          }
          if (row.kind === "future") {
            return (
              <FutureRow
                key={row.key}
                at={row.at}
                dstShift={row.dstShift}
                collisions={row.collisions}
                timezone={timezone}
                now={now}
                isNext={spine.find((r) => r.kind === "future")?.key === row.key}
              />
            );
          }
          return (
            <PastRow
              key={row.key}
              ref={row.occurrence.id === initialOccurrenceId ? deepLinkRef : undefined}
              occurrence={row.occurrence}
              timezone={timezone}
              open={row.occurrence.id === openId}
              onToggle={() =>
                setOpenId((prev) => (prev === row.occurrence.id ? null : row.occurrence.id))
              }
              onOpenTask={onOpenTask}
              resolveTaskLink={resolveTaskLink}
            />
          );
        })}
      </ol>

      <div className="rm-spine-cap">
        {previewLoading && futureShown === 0 && futureReason === null ? (
          <span className="rm-dim rm-tiny">Enumerating occurrences…</span>
        ) : preview && !preview.ok ? (
          <span className="rm-error rm-inline-error" role="alert">
            This cadence cannot be enumerated: {preview.error.message}
          </span>
        ) : canShowMore ? (
          <Tooltip label="Ask the daemon to enumerate further ahead">
            <button
              className="btn rm-sp-more"
              onClick={() =>
                setFutureCount((prev) => Math.min(SCHEDULE_PREVIEW_MAX_COUNT, prev + 10))
              }
              disabled={previewLoading}
            >
              {previewLoading ? "Enumerating…" : "Show more upcoming ↓"}
            </button>
          </Tooltip>
        ) : null}
      </div>

      {!schedule && pageSchedule?.archivedAt != null && (
        <p className="rm-dim rm-tiny rm-spine-foot">
          This mission is archived. Its history is kept; {fallbackName ?? pageSchedule.name} no
          longer appears in the catalog.
        </p>
      )}
    </div>
  );
}

function GapRow({
  row,
  timezone,
}: {
  row: {
    from: number;
    to: number;
    waiting: ScheduleOccurrence[];
    missed: ScheduleOccurrence[];
  };
  timezone: string | null;
}): React.JSX.Element {
  const count = row.waiting.length + row.missed.length;
  return (
    <li className="rm-sp-row rm-sp-gap">
      <span className="rm-sp-when">
        <b>{dayPart(row.from, timezone)}</b>
        {timePart(row.from, timezone)}
      </span>
      <span className="rm-sp-axis rm-sp-axis-gap">
        <span className="rm-sp-moon" aria-hidden>
          ☾
        </span>
      </span>
      <span className="rm-sp-what">
        <span className="rm-sp-line rm-sp-gap-line">
          {count === 1
            ? `This occurrence waited ${formatSpan(row.to - row.from)} to be claimed`
            : `${count} due instants waited up to ${formatSpan(row.to - row.from)} to be accounted for`}
        </span>
        <span className="rm-sp-note">
          Came due {timePart(row.from, timezone)}, claimed {timePart(row.to, timezone)}{" "}
          {dayPart(row.to, timezone)}. No work runs while this laptop is asleep or powered off;
          overdue instants are accounted for exactly once when Mission Control resumes.
        </span>
        {row.missed.length > 0 && (
          <ul className="rm-sp-missed">
            {row.missed.map((entry) => {
              const view = occurrenceStatusView(entry.status);
              return (
                <li key={entry.id}>
                  <span className="rm-mono">{timePart(entry.scheduledFor, timezone)}</span>{" "}
                  <span className="rm-dim">{dayPart(entry.scheduledFor, timezone)}</span>{" "}
                  <span className={`rm-badge-inline rm-badge-${view.tone}`}>{view.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </span>
    </li>
  );
}

function FutureRow({
  at,
  dstShift,
  collisions,
  timezone,
  now,
  isNext,
}: {
  at: number;
  dstShift: boolean;
  collisions: string[];
  timezone: string | null;
  now: number;
  isNext: boolean;
}): React.JSX.Element {
  const countdown = isNext ? formatCountdown(at, now) : null;
  return (
    <li className={`rm-sp-row${isNext ? " is-next" : ""}`}>
      <span className="rm-sp-when">
        <b>{dayPart(at, timezone)}</b>
        {timePart(at, timezone)}
      </span>
      <span className="rm-sp-axis">
        <span className={`rm-sp-node rm-sp-node-future${isNext ? " is-next" : ""}`} aria-hidden />
      </span>
      <span className="rm-sp-what">
        {/* Only the NEXT instant speaks, and after it only a rung with something of its own
            to say. The rest are a ladder of dates in the gutter, and that ladder IS the
            cadence - a countdown repeated on every rung turns the rhythm into ten lines of
            near-identical text saying what the gutter already said. */}
        <span className={`rm-sp-line${isNext ? "" : " rm-sp-line-quiet"}`}>
          {/* The machine-readable instant rides the element that already names it, so the
              exact UTC value stays in the document without a fifth restatement on screen. */}
          <time className={isNext ? "rm-sp-next" : "rm-dim"} dateTime={formatAuditInstantUtc(at)}>
            {isNext ? `Next · ${countdown ?? "due now"}` : ""}
          </time>
          {dstShift && (
            <Tooltip label="The UTC offset changes here: a daylight-saving transition. The wall-clock time stays fixed; the UTC instant moves.">
              <span className="rm-badge-inline rm-badge-attention">DST shift</span>
            </Tooltip>
          )}
        </span>
        {isNext && (
          <span className="rm-sp-note">
            Will file a backlog task. Foreman dispatches it only once the existing live-mode,
            allowlist, dependency and capacity checks pass.
          </span>
        )}
        {collisions.length > 0 && (
          <span className="rm-sp-note">
            Also fires another enabled mission: {collisions.join(", ")} (advisory)
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * A past occurrence. The node carries the outcome; its full audit - every field the ledger
 * persisted, and no invented one - expands underneath rather than in a second pane.
 */
function PastRow({
  ref,
  occurrence,
  timezone,
  open,
  onToggle,
  onOpenTask,
  resolveTaskLink,
}: {
  ref?: React.Ref<HTMLLIElement>;
  occurrence: ScheduleOccurrence;
  timezone: string | null;
  open: boolean;
  onToggle: () => void;
  onOpenTask?: (taskId: string) => void;
  resolveTaskLink?: (taskId: string) => { openable: boolean; blockedReason: string | null };
}): React.JSX.Element {
  const view = occurrenceStatusView(occurrence.status);
  const late = delayIsLate(occurrence.delayMs);
  return (
    <li className={`rm-sp-row${open ? " is-open" : ""}`} ref={ref}>
      <span className="rm-sp-when">
        <b>{dayPart(occurrence.scheduledFor, timezone)}</b>
        {timePart(occurrence.scheduledFor, timezone)}
      </span>
      <span className="rm-sp-axis">
        <span className={`rm-sp-node rm-sp-node-${view.tone}`} aria-hidden />
      </span>
      <span className="rm-sp-what">
        <span className="rm-sp-line">
          <Tooltip label={`Show what the ledger recorded for this ${view.label.toLowerCase()} run`}>
            <button
              type="button"
              className="rm-sp-toggle"
              aria-expanded={open}
              onClick={onToggle}
            >
              {occurrence.status === "created" ? "Filed a backlog task" : view.label}
            </button>
          </Tooltip>
          <span className={`rm-badge-inline${late ? " rm-badge-attention" : ""}`}>
            {formatDelay(occurrence.delayMs)}
          </span>
          {occurrence.triggerKind === "manual" && (
            <span className="rm-badge-inline rm-badge-neutral">Run now</span>
          )}
        </span>
        <span className="rm-sp-note">
          {occurrence.taskId ? (
            <>
              Task{" "}
              <TaskLink
                taskId={occurrence.taskId}
                onOpenTask={onOpenTask}
                resolveTaskLink={resolveTaskLink}
              />
            </>
          ) : (
            "No task was created."
          )}
          {occurrence.error ? <span className="rm-late"> · {occurrence.error}</span> : null}
        </span>
        {open && (
          <OccurrenceAudit
            occurrence={occurrence}
            timezone={timezone}
            onOpenTask={onOpenTask}
            resolveTaskLink={resolveTaskLink}
          />
        )}
      </span>
    </li>
  );
}

/**
 * A generated task's link: clickable when it leads to a live surface, and a plain,
 * non-clickable id with an explanation when it does not - a finished task's retained result
 * is the audit itself, so the link is disabled rather than a dead click.
 */
function TaskLink({
  taskId,
  onOpenTask,
  resolveTaskLink,
}: {
  taskId: string | null;
  onOpenTask?: (taskId: string) => void;
  resolveTaskLink?: (taskId: string) => { openable: boolean; blockedReason: string | null };
}): React.JSX.Element {
  if (!taskId) return <span className="rm-dim">-</span>;
  const link = resolveTaskLink?.(taskId) ?? { openable: true, blockedReason: null };
  if (onOpenTask && link.openable) {
    return (
      <Tooltip label="Open the task this occurrence filed">
        <button className="rm-link" onClick={() => onOpenTask(taskId)}>
          {shortTaskId(taskId)}
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={link.blockedReason ?? "This task is no longer available to open."}>
      <span className="rm-mono rm-task-inert">{shortTaskId(taskId)}</span>
    </Tooltip>
  );
}

function AuditInstant({
  at,
  timezone,
}: {
  at: number;
  timezone: string | null;
}): React.JSX.Element {
  // The operator's own zone leads; UTC is the audit line beneath it. The reverse - which is
  // how this read before - put the only spelling a human reasons in at the bottom of the
  // text ramp behind an ISO string.
  return (
    <>
      <div>{formatInstant(at, timezone, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}</div>
      <div className="rm-dim rm-tiny rm-mono">{formatAuditInstantUtc(at)}</div>
    </>
  );
}

function OccurrenceAudit({
  occurrence,
  timezone,
  onOpenTask,
  resolveTaskLink,
}: {
  occurrence: ScheduleOccurrence;
  timezone: string | null;
  onOpenTask?: (taskId: string) => void;
  resolveTaskLink?: (taskId: string) => { openable: boolean; blockedReason: string | null };
}): React.JSX.Element {
  return (
    <div className="rm-sp-audit">
      <dl className="rm-kv">
        <dt>Scheduled for</dt>
        <dd>
          <AuditInstant at={occurrence.scheduledFor} timezone={timezone} />
        </dd>
        <dt>Trigger</dt>
        <dd>{triggerKindLabel(occurrence.triggerKind)}</dd>
        <dt>Claimed at</dt>
        <dd>
          <AuditInstant at={occurrence.claimedAt} timezone={timezone} />
        </dd>
        <dt>Delay</dt>
        <dd className={delayIsLate(occurrence.delayMs) ? "rm-late" : ""}>
          {formatDelay(occurrence.delayMs)}
        </dd>
        {occurrence.finishedAt != null && (
          <>
            <dt>Finished at</dt>
            <dd>
              <AuditInstant at={occurrence.finishedAt} timezone={timezone} />
            </dd>
          </>
        )}
        <dt>Revision</dt>
        <dd>rev {occurrence.scheduleRevision}</dd>
        <dt>Generated task</dt>
        <dd>
          {occurrence.taskId ? (
            <TaskLink
              taskId={occurrence.taskId}
              onOpenTask={onOpenTask}
              resolveTaskLink={resolveTaskLink}
            />
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
        <dt>Occurrence</dt>
        <dd className="rm-mono rm-tiny">{occurrence.id} · immutable</dd>
      </dl>
      <p className="rm-dim rm-tiny">
        The occurrence key is unique per instant, so a second scheduler tick that finds it
        already claimed does no work - no duplicate task can be created.
      </p>
    </div>
  );
}
