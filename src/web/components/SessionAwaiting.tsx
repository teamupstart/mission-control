import { useState } from "react";
import type { Session, SessionAwaiting, SessionAwaitingWakeSource } from "@shared/types.ts";
import { SESSION_AWAITING_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { api } from "../lib/api.ts";
import { awaitingTitle, readAwaiting, type AwaitingReading } from "../lib/awaiting.ts";
import { blockerHref } from "../lib/blocker.ts";
import { useFeatureFlag } from "../useFeatureFlag.ts";
import { useNow } from "../useNow.ts";
import { Markdown } from "./Markdown.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A session idle on purpose while a background process finishes (`Session.awaiting`), drawn as
 * a deadline track: a bar that fills from when the session declared the wait to when it said
 * the process would be done, so a quiet card reads as early in a healthy wait, close to its
 * deadline, or past it.
 *
 * Grey while it waits and amber once overdue. Never red: a wait is not a blocker, nobody is
 * asked to do anything, and it must not read as an alarm. Every surface here renders nothing
 * while the `session-awaiting` preview is off.
 *
 * The clock ticks every 15 seconds while a track is on screen. That is fine enough for a bar
 * measured in minutes and coarse enough that a column of awaiting cards costs nothing.
 */

const TICK_MS = 15_000;

/** The awaiting surfaces' shared clock, and whether the preview lets them draw at all. */
function useAwaiting(awaiting: SessionAwaiting | null): { shown: boolean; now: number } {
  const enabled = useFeatureFlag(SESSION_AWAITING_FLAG_ID);
  const shown = enabled && awaiting != null;
  return { shown, now: useNow(shown, TICK_MS) };
}

function Hourglass({ size = 11 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="awaiting-glyph" width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 1.75h8M4 14.25h8M5 1.75v2.1c0 1.6 3 2.7 3 4.15 0-1.45 3-2.55 3-4.15v-2.1M5 14.25v-2.1C5 10.55 8 9.45 8 8c0 1.45 3 2.55 3 4.15v2.1" />
    </svg>
  );
}

/** The wake source's glyph, beside its words wherever the wake source is named. */
function WakeGlyph({ source }: { source: SessionAwaitingWakeSource }): React.JSX.Element {
  const paths: Record<SessionAwaitingWakeSource, React.JSX.Element> = {
    command: <><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="M4.75 6.25 6.75 8l-2 1.75M8.5 10h3" /></>,
    monitor: <path d="M1.5 8.5h2.75L6 4.25l3 7.5 1.75-3.25h3.75" />,
    wakeup: <><circle cx="8" cy="9" r="5.25" /><path d="M8 6.5V9l1.75 1.25M3 2.75 4.75 1.5M13 2.75 11.25 1.5" /></>,
    other: <circle cx="8" cy="8" r="2.5" />,
  };
  return (
    <svg className="awaiting-glyph" width="11" height="11" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[source]}
    </svg>
  );
}

/**
 * The bar itself. While waiting it fills toward the deadline tick at its right end; overdue, the
 * declared window is full and the time past the deadline grows as a hatched overrun after the
 * tick, so a dead watcher is visible before any alert fires.
 */
function AwaitingTrack({ reading, marker = false }: { reading: AwaitingReading; marker?: boolean }): React.JSX.Element {
  const due = reading.overdue ? 1 - reading.overrun : 1;
  return (
    <span
      className={`awaiting-track${reading.overdue ? " is-late" : ""}`}
      role="progressbar"
      aria-label={reading.overdue ? "Past its deadline" : "Time until its deadline"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(reading.progress * 100)}
      aria-valuetext={reading.remaining}
    >
      <span className="awaiting-track-fill" style={{ width: `${(reading.overdue ? due : reading.progress) * 100}%` }} />
      {reading.overdue && <span className="awaiting-track-over" style={{ left: `${due * 100}%` }} />}
      <span className="awaiting-track-tick" style={{ left: `${due * 100}%` }} />
      {marker && (
        <span className="awaiting-track-now" style={{ left: `${(reading.overdue ? 1 : reading.progress) * 100}%` }} />
      )}
    </span>
  );
}

/** The card's wait: what, the due time, and the track with its two ends labelled. */
export function AwaitingTileTrack({ session }: { session: Session }): React.JSX.Element | null {
  const awaiting = session.awaiting ?? null;
  const { shown, now } = useAwaiting(awaiting);
  if (!shown || !awaiting) return null;
  const r = readAwaiting(awaiting, now);
  return (
    <Tooltip label={awaitingTitle(awaiting, now)}>
      <span className={`tile-awaiting${r.overdue ? " is-late" : ""}`}>
        <span className="tile-awaiting-line">
          <Hourglass />
          <span className="tile-awaiting-what">
            {r.overdue ? "Overdue" : "Awaiting"} <b>{awaiting.what}</b>
          </span>
          <span className="tile-awaiting-due">{r.overdue ? r.remaining : `due ${r.due}`}</span>
        </span>
        <AwaitingTrack reading={r} />
        <span className="tile-awaiting-scale">
          <span>since {r.since}</span>
          <span>{r.overdue ? `was due ${r.due}` : r.remaining}</span>
        </span>
      </span>
    </Tooltip>
  );
}

/** A rail row's wait: a short track and the minutes left, or how late it is. */
export function AwaitingRailMark({ session }: { session: Session }): React.JSX.Element | null {
  const awaiting = session.awaiting ?? null;
  const { shown, now } = useAwaiting(awaiting);
  if (!shown || !awaiting) return null;
  const r = readAwaiting(awaiting, now);
  return (
    <Tooltip label={awaitingTitle(awaiting, now)}>
      <span className={`rail-awaiting${r.overdue ? " is-late" : ""}`}>
        <AwaitingTrack reading={r} />
        <span className="rail-awaiting-n">{r.overdue ? "overdue" : r.remaining.replace(" left", "")}</span>
      </span>
    </Tooltip>
  );
}

/**
 * The Conversation tab's band for a session awaiting a background process: what it waits for,
 * what wakes it, how long it has been waiting, the track with declared, now and due marked, and
 * Clear.
 *
 * Above the transcript where the blocker band sits, because a session never has both: a blocker
 * replaces a wait. Clear ends the hold so idle automation can pick the session up again; it
 * sends nothing to the session.
 */
export function SessionAwaitingBand({ session }: { session: Session }): React.JSX.Element | null {
  const awaiting = session.awaiting ?? null;
  const { shown, now } = useAwaiting(awaiting);
  if (!shown || !awaiting) return null;
  // Keyed by the wait, so one wait's error or busy state never shows on the next.
  return <AwaitingBand key={awaiting.id} sessionId={session.id} awaiting={awaiting} now={now} />;
}

function AwaitingBand({ sessionId, awaiting, now }: { sessionId: string; awaiting: SessionAwaiting; now: number }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = readAwaiting(awaiting, now);
  const href = blockerHref(awaiting.referenceUrl);

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.clearAwaiting(sessionId, awaiting.id);
      if (!res.ok) setError(res.error ?? "Mission Control refused the change");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mission Control could not be reached");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`awaiting-band${r.overdue ? " is-late" : ""}`} aria-label="Session awaiting">
      <div className="awaiting-band-top">
        <Hourglass size={12} />
        <span className="awaiting-band-flag">{r.overdue ? "Overdue" : "Awaiting"}</span>
        <span className="awaiting-band-what">{awaiting.what}</span>
        <span className="awaiting-band-wake">
          <WakeGlyph source={awaiting.wakeSource} /> {r.wakePhrase}
        </span>
        <span className="awaiting-band-spacer" />
        {/* How long it has been waiting, beside the controls as the blocker band's age is. */}
        <Tooltip label={`Waiting since ${r.since}`}>
          <span className="awaiting-band-age">waiting {r.age}</span>
        </Tooltip>
        {href && (
          <Tooltip label={`Open ${href}`}>
            <a className="awaiting-band-link" href={href} target="_blank" rel="noreferrer">Open ↗</a>
          </Tooltip>
        )}
        <Tooltip label={r.overdue
          ? "End the wait. The session reads as idle, and the stuck-session alerts already apply"
          : "End the hold now, so idle automation can pick this session up again. Nothing is sent to the session"}
        >
          <button type="button" className={r.overdue ? "btn" : "btn btn-ghost"} disabled={busy} onClick={() => void clear()}>
            Clear
          </button>
        </Tooltip>
      </div>
      <AwaitingTrack reading={r} marker />
      <div className="awaiting-band-scale">
        <span>declared {r.since}</span>
        <span>{r.overdue ? `was due ${r.due} · ${r.remaining}` : `due ${r.due} · ${r.remaining}`}</span>
      </div>
      {r.overdue && (
        <p className="awaiting-band-note">
          Past its deadline, so idle automation and the stuck-session alerts apply to this session again.
        </p>
      )}
      {awaiting.details && (
        <details className="awaiting-band-details">
          <Tooltip label="Show or hide the session's notes on this wait">
            <summary>Details</summary>
          </Tooltip>
          <Markdown>{awaiting.details}</Markdown>
        </details>
      )}
      {error && <p className="awaiting-band-error" role="alert">{error}</p>}
    </section>
  );
}
