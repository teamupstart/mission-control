import { useCallback, useEffect, useState } from "react";
import type { AwayConfig } from "@shared/protocol.ts";
import { api, fetchAwayConfig } from "./api.ts";

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
} {
  const [away, setAwayState] = useState<AwayConfig | null>(null);

  useEffect(() => {
    let alive = true;
    const read = async (): Promise<void> => {
      const cfg = await fetchAwayConfig();
      if (alive && cfg) setAwayState(cfg);
    };
    void read();
    const id = setInterval(() => void read(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const setAway = useCallback(async (patch: Partial<AwayConfig>) => {
    // Optimistic, then reconciled: the server owns `awaySince`, so the response is
    // authoritative over whatever we guessed locally.
    setAwayState((cur) => (cur ? { ...cur, ...patch } : cur));
    const res = await api.setAwayConfig(patch);
    if (res.ok) {
      const cfg = await fetchAwayConfig();
      if (cfg) setAwayState(cfg);
    }
  }, []);

  return { away, setAway };
}
