import { useEffect, useMemo, useState } from "react";
import type {
  SchedulePreviewInstant,
  SchedulePreviewResult,
  ScheduleMissedPolicy,
  ScheduleStandbySimulation,
} from "@shared/schedules.ts";
import { SCHEDULE_PREVIEW_MAX_COUNT } from "@shared/schedules.ts";
import { previewSchedule, type ScheduleDefinitionPayload } from "../../lib/api.ts";
import {
  formatInstant,
  formatInstantUtc,
  occurrenceStatusView,
  scheduleDefinitionFingerprint,
} from "../../lib/schedules.ts";
import { Tooltip } from "../Tooltip.tsx";

/**
 * The daemon-authored occurrence preview, and the standby simulation beside it.
 *
 * Every instant, offset, DST shift, collision and missed-run decision on this screen came
 * back from `POST /api/schedules/preview` - the SAME recurrence evaluator and missed
 * policy the scheduler runs. The browser only spells the epochs it is handed
 * (`Intl.DateTimeFormat`); it never enumerates a cadence, computes a DST offset, or decides
 * a missed instant itself. That is the whole point of previewing on the server: what the
 * operator reviews here is exactly what will happen, not a second model of it that can drift.
 *
 * Self-contained on purpose: it owns its base fetch (re-run whenever the definition
 * changes) and its standby fetch, so the editor can embed it and the detail's Preview
 * screen can mount it over a saved schedule with no shared state between them. Preview
 * writes nothing and mutates no catalog row.
 */

/** Parse a browser-local `datetime-local` value to epoch ms, or null when empty/invalid. */
function localInputToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function offsetLabel(instant: SchedulePreviewInstant): string {
  const sign = instant.offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(instant.offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

export function SchedulePreview({
  definition,
  excludeScheduleId,
  onResult,
  ready = true,
}: {
  definition: ScheduleDefinitionPayload;
  /** The schedule being edited, so a cadence never collides with its own saved self. */
  excludeScheduleId?: string;
  /** Reports each base result up so the editor can gate Save & enable on a fresh preview. */
  onResult?: (fingerprint: string, result: SchedulePreviewResult) => void;
  /**
   * Whether the definition is complete enough to preview. The editor passes false until
   * the required template fields exist, so a half-typed create form fires no doomed
   * request and never dumps a raw validation error where the occurrences will go.
   */
  ready?: boolean;
}): React.JSX.Element {
  const fingerprint = useMemo(() => scheduleDefinitionFingerprint(definition), [definition]);
  const [count, setCount] = useState(10);
  const [base, setBase] = useState<SchedulePreviewResult | null>(null);
  const [loading, setLoading] = useState(true);

  const [sleepValue, setSleepValue] = useState("");
  const [resumeValue, setResumeValue] = useState("");
  const [standby, setStandby] = useState<SchedulePreviewResult | null>(null);
  const [standbyBusy, setStandbyBusy] = useState(false);
  const [standbyError, setStandbyError] = useState<string | null>(null);

  // Re-run the base preview whenever the definition or requested count changes, debounced
  // so typing the intent does not fire a request per keystroke. A stale base is the exact
  // hazard the editor's Save & enable gate exists to rule out, so the fingerprint that
  // drives this is the same one the gate compares against. Gated on `ready`: an incomplete
  // definition previews nothing rather than dumping a validation error.
  useEffect(() => {
    if (!ready) {
      setBase(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void previewSchedule({ ...definition, count, excludeScheduleId }).then((result) => {
        if (!alive) return;
        setBase(result);
        setLoading(false);
        onResult?.(fingerprint, result);
      });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // onResult is intentionally excluded: it is a fresh closure each render and would
    // re-run the fetch forever. fingerprint already captures every definition input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, count, excludeScheduleId, ready]);

  // A definition edit invalidates a standby simulation just as it does the base preview.
  useEffect(() => {
    setStandby(null);
    setStandbyError(null);
  }, [fingerprint]);

  const runStandby = (): void => {
    const sleepStartedAt = localInputToEpoch(sleepValue);
    const resumedAt = localInputToEpoch(resumeValue);
    if (sleepStartedAt === null || resumedAt === null) {
      setStandbyError("Enter both a sleep time and a resume time.");
      return;
    }
    if (resumedAt <= sleepStartedAt) {
      setStandbyError("Resume must be after the sleep time.");
      return;
    }
    setStandbyError(null);
    setStandbyBusy(true);
    void previewSchedule({
      ...definition,
      count,
      excludeScheduleId,
      sleepStartedAt,
      resumedAt,
    }).then((result) => {
      setStandbyBusy(false);
      if (!result.ok) {
        setStandbyError(result.error.message);
        setStandby(null);
        return;
      }
      setStandby(result);
    });
  };

  const collisionsByInstant = useMemo(() => {
    const map = new Map<number, string[]>();
    if (base?.ok) {
      for (const collision of base.collisions) {
        for (const at of collision.at) {
          map.set(at, [...(map.get(at) ?? []), collision.name]);
        }
      }
    }
    return map;
  }, [base]);

  if (!ready) {
    return (
      <p className="rm-empty">Fill in the name, repository, title and intent to preview occurrences.</p>
    );
  }
  if (loading && !base) {
    return <p className="rm-empty">Enumerating occurrences…</p>;
  }
  if (!base) {
    return <p className="rm-empty">Preview unavailable.</p>;
  }
  if (!base.ok) {
    return (
      <div className="rm-error" role="alert">
        This cadence is not valid yet: {base.error.message}
      </div>
    );
  }

  return (
    <div className="rm-preview">
      <div className="rm-preview-toolbar">
        <span className="rm-eyebrow">Next occurrences · {definition.timezone}</span>
        <label className="rm-count">
          Show
          <Tooltip label="How many future occurrences to enumerate (10 to 50)">
            <select
              className="field-input rm-count-select"
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
              aria-label="How many occurrences to preview"
            >
              {[10, 20, 30, SCHEDULE_PREVIEW_MAX_COUNT].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Tooltip>
        </label>
      </div>

      <ol className="rm-occurrence-list">
        {base.instants.map((instant) => {
          const collisions = collisionsByInstant.get(instant.at);
          return (
            <li className="rm-occurrence" key={instant.at}>
              <time className="rm-occurrence-time">
                {formatInstant(instant.at, definition.timezone, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
              <span className={`rm-occurrence-node${instant.dstShift ? " is-dst" : ""}`} aria-hidden>
                ◇
              </span>
              <div className="rm-occurrence-main">
                <div className="rm-occurrence-meta">
                  <span className="rm-mono">{formatInstantUtc(instant.at)} UTC</span>
                  <span className="rm-dim">{offsetLabel(instant)}</span>
                  {instant.dstShift && (
                    <Tooltip label="The UTC offset changed here: a daylight-saving transition. The wall-clock time stays fixed; the UTC instant moves.">
                      <span className="rm-badge-inline rm-badge-attention">DST shift</span>
                    </Tooltip>
                  )}
                </div>
                {collisions && collisions.length > 0 && (
                  <p className="rm-occurrence-note rm-dim">
                    Also fires another enabled mission: {collisions.join(", ")} (advisory)
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <section className="rm-standby">
        <h4>Simulate standby</h4>
        <p className="rm-dim">
          No work runs while this laptop is asleep or powered off; overdue instants are
          accounted for when Mission Control resumes. This shows what the missed-run policy
          would do across a sleep window - the daemon decides each outcome, not the browser.
        </p>
        <div className="rm-standby-inputs">
          <label className="field">
            <span className="field-label">Slept from</span>
            <Tooltip label="When the machine went to sleep, in your local time">
              <input
                className="field-input"
                type="datetime-local"
                value={sleepValue}
                onChange={(event) => setSleepValue(event.target.value)}
              />
            </Tooltip>
          </label>
          <label className="field">
            <span className="field-label">Resumed at</span>
            <Tooltip label="When the machine woke and the daemon resumed">
              <input
                className="field-input"
                type="datetime-local"
                value={resumeValue}
                onChange={(event) => setResumeValue(event.target.value)}
              />
            </Tooltip>
          </label>
          <Tooltip label="Ask the daemon what the missed-run policy would do across this sleep window">
            <button className="btn" onClick={runStandby} disabled={standbyBusy}>
              {standbyBusy ? "Simulating…" : "Simulate"}
            </button>
          </Tooltip>
        </div>
        {standbyError && (
          <p className="rm-error" role="alert">
            {standbyError}
          </p>
        )}
        {standby?.ok && standby.standby && (
          <StandbyResult
            simulation={standby.standby}
            missedPolicy={definition.missedPolicy}
            timezone={definition.timezone}
          />
        )}
      </section>
    </div>
  );
}

function StandbyResult({
  simulation,
  missedPolicy,
  timezone,
}: {
  simulation: ScheduleStandbySimulation;
  missedPolicy: ScheduleMissedPolicy;
  timezone: string;
}): React.JSX.Element {
  const plan = simulation.plan;
  const createdCount = plan?.filter((d) => d.decisionKind === "create_task").length ?? 0;
  return (
    <div className="rm-standby-result">
      <div className="rm-standby-summary">
        <span>
          {simulation.missed.length} instant
          {simulation.missed.length === 1 ? "" : "s"} came due while asleep
        </span>
        <span className="rm-dim">·</span>
        <span>
          {createdCount} task{createdCount === 1 ? "" : "s"} would be filed under {missedPolicy}
        </span>
        {simulation.truncated && <span className="rm-badge-inline rm-badge-attention">capped</span>}
      </div>
      <ol className="rm-standby-rows">
        {plan?.map((decision) => (
          <li className="rm-standby-row" key={decision.at}>
            <span className="rm-mono">{formatInstant(decision.at, timezone)}</span>
            <span className={`rm-badge-inline rm-badge-${decisionTone(decision.decisionKind)}`}>
              {decisionLabel(decision.decisionKind)}
            </span>
            {decision.coveredBy != null && (
              <span className="rm-dim">covered by {formatInstant(decision.coveredBy, timezone)}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function decisionLabel(kind: string): string {
  const view = occurrenceStatusView(
    kind === "create_task"
      ? "created"
      : kind === "coalesced"
        ? "coalesced"
        : kind === "skipped_overlap"
          ? "skipped_overlap"
          : "skipped_policy",
  );
  return view.label;
}

function decisionTone(kind: string): "healthy" | "attention" | "paused" | "neutral" {
  return occurrenceStatusView(
    kind === "create_task"
      ? "created"
      : kind === "coalesced"
        ? "coalesced"
        : kind === "skipped_overlap"
          ? "skipped_overlap"
          : "skipped_policy",
  ).tone;
}
