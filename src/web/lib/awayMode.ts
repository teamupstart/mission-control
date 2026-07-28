import { useCallback, useEffect, useRef, useState } from "react";
import type { AwayConfig } from "@shared/protocol.ts";
import type { AwayBufferSummary, AwayDigest } from "@shared/away-buffer.ts";
import { api, fetchAwayBuffer, fetchAwayConfig, fetchAwayDigest } from "./api.ts";

/** How often to re-read away state, so a toggle from another window/tray lands here too. */
const POLL_MS = 5000;

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
      const buf = await fetchAwayBuffer();
      if (alive && buf) setBuffered(buf);
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
