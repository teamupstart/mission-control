import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import { legacyStallFingerprint, type Stall } from "@shared/stall.ts";
import { fetchAwayStalls } from "./api.ts";

/** Matches useAwayMode's cadence, and the daemon's own poll - a faster read finds nothing new. */
const POLL_MS = 5000;

/** Shared empty array, so "no stalls" is one stable reference across renders. */
type ObservedStall = Stall & { legacy?: true };
const NONE: ObservedStall[] = [];

/** Bind an older daemon's response to the session episode observed when its poll started. */
export function captureStalls(stalls: Stall[], sessions: readonly Session[]): ObservedStall[] {
  if (!stalls.some(stall => !stall.fingerprint)) return stalls;
  const byId = new Map(sessions.map(session => [session.id, session]));
  return stalls.map(stall => stall.fingerprint ? stall : {
    ...stall, legacy: true, fingerprint: legacyStallFingerprint(stall, byId.get(stall.sessionId)),
  });
}

/** A session update can retire a cached stall. Only a fresh poll can report a new occurrence. */
export function currentStalls(stalls: ObservedStall[] | undefined, sessions: readonly Session[]): Stall[] | undefined {
  if (!stalls?.some(stall => stall.legacy)) return stalls;
  const byId = new Map(sessions.map(session => [session.id, session]));
  return stalls.filter(stall => {
    if (!stall.legacy) return true;
    const session = byId.get(stall.sessionId);
    return session && legacyStallFingerprint(stall, session) === stall.fingerprint;
  });
}

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
 *
 * `undefined` until the first read lands, and deliberately NOT an empty array: this
 * arrives on its own channel, so it can land either side of the SSE snapshot, and
 * "not read yet" has to stay distinguishable from "read, nothing stuck" or the
 * consumer cannot tell a stall that is news from one that was there all along (see
 * withKnownStalls).
 */
export function useStalls(sessions: readonly Session[]): Stall[] | undefined {
  const [stalls, setStalls] = useState<ObservedStall[] | undefined>(undefined);
  const currentSessions = useRef(sessions);
  currentSessions.current = sessions;
  const seen = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    let reading = false;
    const read = async (): Promise<void> => {
      if (reading) return;
      reading = true;
      const atStart = currentSessions.current;
      const response = await fetchAwayStalls().finally(() => { reading = false; });
      if (!alive || !response) return;
      const next = captureStalls(response, atStart);
      // `forMs` climbs every tick, so it is deliberately not part of the signature:
      // comparing on it would re-render on each poll for a stall nothing changed
      // about. The alert engine edge-triggers on (session, kind) anyway. The fingerprint is in
      // it because a Stuck row draws the facts, which can change while the sentence does not.
      const sig = next.map((s) => `${s.sessionId}:${s.kind}:${s.reason}:${s.fingerprint}`).join("|");
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

  return useMemo(() => currentStalls(stalls, sessions), [stalls, sessions]);
}
