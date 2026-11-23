import { useLayoutEffect, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import { blockerAge } from "../lib/blocker.ts";
import { RepoGroupCaret } from "./session-bits.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Every Blocked head takes its count and age from the helpers below, so a head can never count
 * or age the group differently from its neighbour on the other side of the drill-in morph.
 */

export function oldestBlockerAge(sessions: readonly Session[], now = Date.now()): string | null {
  let oldest = Number.POSITIVE_INFINITY;
  for (const s of sessions) {
    if (s.blocker && s.blocker.startedAt < oldest) oldest = s.blocker.startedAt;
  }
  return Number.isFinite(oldest) ? blockerAge(oldest, now) : null;
}

export function blockedSummary(sessions: readonly Session[], now = Date.now()): string {
  const n = sessions.length;
  const age = oldestBlockerAge(sessions, now);
  return `${n} blocked ${n === 1 ? "session" : "sessions"}${age ? `, oldest ${age}` : ""}`;
}

function OldestTag({ sessions, className }: { sessions: readonly Session[]; className: string }) {
  const age = oldestBlockerAge(sessions);
  return age ? <span className={className}>oldest {age}</span> : null;
}

export function BlockedLaneHead({ sessions }: { sessions: readonly Session[] }): React.JSX.Element {
  return (
    <header className="board-lane-head">
      <span className="board-swatch" aria-hidden />
      <h3>Blocked</h3>
      <OldestTag sessions={sessions} className="board-lane-oldest" />
      <Tooltip label={blockedSummary(sessions)}>
        <span className="board-col-n">{sessions.length}</span>
      </Tooltip>
    </header>
  );
}

/**
 * The lane is sized to its content between one card and 45% of the column, so it always shows
 * at least one whole card. CSS can state the 45% but not "one card", because a card's height is
 * whatever its items make it, so the floor is measured here - the head, the first card and the
 * body's padding - and handed to the stylesheet as `--blocked-lane-floor`, which the lane's
 * `max-height` takes the larger of. `alone` is the lane with no Needs you cards above it, which
 * then takes the whole column.
 */
export function BlockedLane({
  sessions,
  alone,
  rail,
  children,
}: {
  sessions: readonly Session[];
  alone: boolean;
  /** Drawn as the drill-in rail, whose rows replace the cards and so change the floor. */
  rail: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const [floor, setFloor] = useState<number | null>(null);
  const firstId = sessions[0]?.id ?? null;
  useLayoutEffect(() => {
    const lane = ref.current;
    const head = lane?.querySelector<HTMLElement>(".board-lane-head");
    const body = lane?.querySelector<HTMLElement>(".board-lane-body");
    const first = body?.firstElementChild as HTMLElement | null | undefined;
    if (!lane || !head || !body || !first) return;
    const measure = (): void => {
      const style = getComputedStyle(body);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const frame = lane.offsetHeight - lane.clientHeight;
      setFloor(Math.ceil(head.offsetHeight + first.offsetHeight + padding + frame));
    };
    measure();
    // A card grows when an item wraps or the column narrows. Static-markup tests never run
    // this effect, and a runtime without the observer keeps the first measurement.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(head);
    observer.observe(first);
    return () => observer.disconnect();
  }, [firstId, rail]);
  return (
    <section
      ref={ref}
      className={`board-lane board-lane-blocked${alone ? " is-alone" : ""}`}
      aria-label="Blocked"
      style={floor === null ? undefined : { "--blocked-lane-floor": `${floor}px` } as React.CSSProperties}
    >
      <BlockedLaneHead sessions={sessions} />
      <div className="board-col-body board-lane-body">{children}</div>
    </section>
  );
}

export function BlockedColumnAge({ sessions }: { sessions: readonly Session[] }): React.JSX.Element | null {
  return <OldestTag sessions={sessions} className="board-lane-oldest" />;
}

/**
 * Borrows the repository frame head's classes rather than a box of its own, so the red frame
 * reads as the same kind of structure as the repository frames beside it in Idle.
 */
export function BlockedFrameHead({
  sessions,
  expanded,
  onToggle,
}: {
  sessions: readonly Session[];
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const age = oldestBlockerAge(sessions);
  const summary = blockedSummary(sessions);
  return (
    <Tooltip label={summary}>
      <button
        type="button"
        className="board-cluster-head board-repo-head board-blocked-head"
        aria-label={`${expanded ? "Collapse" : "Expand"} Blocked - ${summary}`}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="bch-title">Blocked</span>
        <span className="bch-meta">
          {sessions.length}
          {age ? ` · oldest ${age}` : ""}
        </span>
        <RepoGroupCaret />
      </button>
    </Tooltip>
  );
}

export function BlockedRailHead({ sessions }: { sessions: readonly Session[] }): React.JSX.Element {
  return (
    <div className="rail-group tone-blocked">
      Blocked
      <OldestTag sessions={sessions} className="rail-blocked-oldest" />
      <Tooltip label={blockedSummary(sessions)}>
        <span className="rail-group-n">{sessions.length}</span>
      </Tooltip>
    </div>
  );
}
