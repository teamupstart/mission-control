import { useCallback, useEffect, useRef, useState } from "react";
import type { AwayConfig } from "@shared/protocol.ts";
import type { AwayBufferSummary, AwayDigest } from "@shared/away-buffer.ts";
import { api, fetchAwayBuffer, fetchAwayConfig, fetchAwayDigest } from "./api.ts";

/** How often to re-read away state, so a toggle from another window/tray lands here too. */
const POLL_MS = 5000;

/**
 * Whether a buffer response that has just landed still describes the window we are in.
 *
 * A buffer read is two round trips behind a moving target: the config read that decided
 * to ask, then the buffer read itself, with a human able to flip away mode in between.
 * Two independent things can therefore have gone stale, and BOTH have to be checked
 * because neither catches the other's case.
 *
 * `epoch` catches a local toggle DURING the read. Comparing against `cfg` alone cannot:
 * `cfg` was read in the same pass, so a response describing the window `cfg` names still
 * agrees with it, even though that window has since ended. That is the race that shows a
 * previous window's count - the optimistic `away: true` written on the way back in still
 * carries the OLD `awaySince` until the server answers, so the panel's own window check
 * accepts the stale summary too.
 *
 * `cfg` catches the window moving with no local toggle at all - another dashboard window
 * or a tray toggle - which bumps no epoch here.
 *
 * Note it is compared against the CONFIG WE FETCHED, never against the optimistic React
 * state, so an unconfirmed guess can never be what makes a summary look current.
 */
export function bufferReadIsCurrent({
  buf,
  cfg,
  epochAtStart,
  epochNow,
}: {
  buf: AwayBufferSummary;
  cfg: AwayConfig;
  /** The toggle generation when this read was issued. */
  epochAtStart: number;
  /** The toggle generation now that it has landed. */
  epochNow: number;
}): boolean {
  if (epochAtStart !== epochNow) return false;
  // Not away, or away with no stamp to match: nothing can be current for a window that
  // is not open. `awaySince` is null exactly when `away` is false, but both are checked
  // rather than inferred, because a null on each side must not read as a match.
  if (!cfg.away || cfg.awaySince === null || buf.since === null) return false;
  return buf.since === cfg.awaySince;
}

/**
 * Away mode's durable state, read from the daemon rather than localStorage.
 *
 * Polled rather than pushed: away state changes when a human flips it, which is
 * rare, and adding an SSE event for it would mean touching the registry's event
 * plumbing for a single boolean. A 5s poll of one tiny row costs nothing and keeps
 * two dashboard windows (and, later, a tray toggle) in agreement.
 *
 * `null` until the first read lands - callers should treat that as "not away yet"
 * rather than guessing, so a slow daemon can't silently buffer alerts nobody sees.
 */
export function useAwayMode(): {
  away: AwayConfig | null;
  setAway: (patch: Partial<AwayConfig>) => Promise<void>;
  /** The digest for the window you just ended, until dismissed. */
  digest: AwayDigest | null;
  dismissDigest: () => void;
  /**
   * What is piling up in the window still open, for the away card. Null when you are
   * not away, which is also when nothing asks for it.
   */
  buffered: AwayBufferSummary | null;
} {
  const [away, setAwayState] = useState<AwayConfig | null>(null);
  const [digest, setDigest] = useState<AwayDigest | null>(null);
  const [buffered, setBuffered] = useState<AwayBufferSummary | null>(null);
  /** The last `away` we saw, to spot the transition back. */
  const wasAway = useRef(false);
  /**
   * Bumped every time away mode is flipped from here, so a buffer read issued before the
   * flip cannot commit after it. See `bufferReadIsCurrent`.
   */
  const awayEpoch = useRef(0);

  /**
   * Claim the digest when away goes true -> false.
   *
   * Driven off the observed transition rather than off the toggle handler, so a
   * return triggered from another dashboard window (or later, a tray toggle) still
   * surfaces the digest here. The daemon drops it as it hands it over, so whichever
   * window asks first is the one that shows it - exactly once, never twice.
   */
  const claimIfReturned = useCallback((cfg: AwayConfig) => {
    const returned = wasAway.current && !cfg.away;
    wasAway.current = cfg.away;
    if (!returned) return;
    void fetchAwayDigest().then((d) => {
      if (d && !d.empty) setDigest(d);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    const read = async (): Promise<void> => {
      const cfg = await fetchAwayConfig();
      if (!alive || !cfg) return;
      setAwayState(cfg);
      claimIfReturned(cfg);
      // Only asked for while the window is open, which is the only time it says
      // anything: the buffer is null at the desk, so a read then costs a request to be
      // told what `cfg.away` already said. Cleared on return rather than left stale, or
      // the card would keep quoting a count for a window that has since been digested.
      if (!cfg.away) {
        setBuffered(null);
        return;
      }
      const epochAtStart = awayEpoch.current;
      const buf = await fetchAwayBuffer();
      if (!alive || !buf) return;
      // Dropped rather than shown late: a response that no longer describes the window
      // we are in would render a previous window's count and preview lines as if they
      // belonged to this one.
      if (!bufferReadIsCurrent({ buf, cfg, epochAtStart, epochNow: awayEpoch.current })) return;
      setBuffered(buf);
    };
    void read();
    const id = setInterval(() => void read(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [claimIfReturned]);

  const setAway = useCallback(
    async (patch: Partial<AwayConfig>) => {
      // Optimistic, then reconciled: the server owns `awaySince`, so the response is
      // authoritative over whatever we guessed locally.
      setAwayState((cur) => (cur ? { ...cur, ...patch } : cur));
      // The optimistic state above keeps the OLD `awaySince` until the server answers, so
      // a summary from the window just ended would still look current to the panel's own
      // check. Bumping the epoch retires every read already in flight; clearing drops what
      // has already landed.
      if (patch.away !== undefined) {
        awayEpoch.current += 1;
        setBuffered(null);
      }
      const res = await api.setAwayConfig(patch);
      if (!res.ok) return;
      const cfg = await fetchAwayConfig();
      if (!cfg) return;
      setAwayState(cfg);
      claimIfReturned(cfg);
    },
    [claimIfReturned],
  );

  const dismissDigest = useCallback(() => setDigest(null), []);

  return { away, setAway, digest, dismissDigest, buffered };
}
