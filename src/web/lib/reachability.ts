// Can anything actually reach you right now? One answer, derived in one place.
//
// This is the only question the alert popover exists to answer, and it is a
// COMPOSITION of three states that live in three different places: two per-machine
// delivery preferences in localStorage, and away mode, which is server state. Keeping
// the derivation pure and out of the component is what lets the "nothing can reach
// you" case be tested without a DOM, because that case is the one that matters and the
// one a render test would be least likely to stumble into.
//
// The ordering below is the load-bearing part. `muted` is decided BEFORE `away`, so
// away mode can never dress itself up as a delivery path: with both channels off there
// is no way to interrupt you for a blocker, and away mode does not add one - it can
// only hand you a digest when you get back. Reverse these two branches and the card
// starts promising that blockers get through on a machine that is silent.

/**
 * Which of the three states the panel is in.
 *
 * `muted` outranks `away` deliberately - see the module note.
 */
export type ReachTone = "ok" | "away" | "muted";

export interface Reachability {
  tone: ReachTone;
  /** The short state, for the card's heading line. */
  title: string;
  /** What that means, in one sentence. */
  sentence: string;
}

export interface ReachInput {
  /** Desktop notifications on AND permitted by the browser - the effective state. */
  desktop: boolean;
  sound: boolean;
  away: boolean;
  /** How long you have been away, or null when you are not (or it hasn't loaded). */
  awayMs: number | null;
  /** Distinct things waiting in the open away window. */
  buffered: number;
}

/**
 * "25m" / "1h 04m" - elapsed away time.
 *
 * Zero-padded minutes past the hour so the figure doesn't change width as it ticks,
 * which is what stops the card's meta strip jittering while you watch it.
 */
export function elapsed(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** How the live channels read in a sentence: "desktop and sound", "desktop", or "". */
function channelList(desktop: boolean, sound: boolean): string {
  return [desktop && "desktop", sound && "sound"].filter(Boolean).join(" and ");
}

export function reachability({
  desktop,
  sound,
  away,
  awayMs,
  buffered,
}: ReachInput): Reachability {
  const channels = channelList(desktop, sound);

  // First, and never below the away branch. With no channel live, nothing reaches you
  // in either state - the only difference away mode makes is that you get a digest.
  if (!channels) {
    return {
      tone: "muted",
      title: "Nothing can reach you",
      sentence: away
        ? "Both channels are off - you'll only get the digest when you return."
        : "Both channels are off - the dashboard is the only signal.",
    };
  }

  if (away) {
    // The count is omitted rather than printed as "(0 waiting)": a parenthetical zero
    // reads as a broken counter, where saying nothing reads as the quiet it describes.
    const waiting = buffered > 0 ? ` (${buffered} waiting)` : "";
    return {
      tone: "away",
      title: awayMs === null ? "Away" : `Away ${elapsed(awayMs)}`,
      sentence: `Blockers interrupt via ${channels}; everything else waits in the digest${waiting}.`,
    };
  }

  return {
    tone: "ok",
    title: "You're reachable",
    sentence: `Everything reaches you via ${channels} as it happens.`,
  };
}
