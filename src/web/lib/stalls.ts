import { useEffect, useRef, useState } from "react";
import type { Stall } from "@shared/stall.ts";
import { fetchAwayStalls } from "./api.ts";

/** Matches useAwayMode's cadence, and the daemon's own poll - a faster read finds nothing new. */
const POLL_MS = 5000;

/** Shared empty array, so "no stalls" is one stable reference across renders. */
const NONE: Stall[] = [];

/**
 * The daemon's currently-stuck sessions, polled into the client.
 *
 * This is what gives the `stuck` alert a delivery path. Detection is server-side by
 * necessity (a stall is elapsed silence, which `sessionEqual` keeps out of the SSE
 * change comparison), but the browser is the only thing that can raise a desktop
 * notification - so the signal has to come back the other way for a stuck session to
 * interrupt you rather than wait for the return digest.
 *
 * Polled rather than pushed for the same reason useAwayMode is: an SSE event would
 * mean touching the registry's event plumbing and the ServerEvent protocol for data
 * the daemon only recomputes on its own 5s tick.
 *
 * The reference is held stable while the stalls are unchanged - the common case by
 * far - so a poll that finds nothing new doesn't re-render the dashboard.
 */
export function useStalls(): Stall[] {
  const [stalls, setStalls] = useState<Stall[]>(NONE);
  const seen = useRef("");

  useEffect(() => {
    let alive = true;
    const read = async (): Promise<void> => {
      const next = await fetchAwayStalls();
      if (!alive || !next) return;
      // `forMs` climbs every tick, so it is deliberately not part of the signature:
      // comparing on it would re-render on each poll for a stall nothing changed
      // about. The alert engine edge-triggers on (session, kind) anyway.
      const sig = next.map((s) => `${s.sessionId}:${s.kind}:${s.reason}`).join("|");
      if (sig === seen.current) return;
      seen.current = sig;
      setStalls(next.length > 0 ? next : NONE);
    };
    void read();
    const id = setInterval(() => void read(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return stalls;
}
