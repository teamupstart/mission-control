import { useCallback, useEffect, useRef, useState } from "react";
import type { ForemanConfig, ForemanConfigPatch } from "@shared/protocol.ts";
import type { ForemanStatus } from "@shared/types.ts";
import { api, fetchForemanConfig, fetchForemanStatus } from "./lib/api.ts";

// Foreman config + live status for the topbar control and the per-card notes.
// Config is edited rarely (a control-panel poll is plenty); status carries the
// derived queue depth + counts. Polled rather than streamed because it's coarse,
// low-frequency dashboard chrome - not worth another SSE channel.

const POLL_MS = 4000;

/**
 * Frame a rejection as one short sentence. The daemon answers a bad patch with
 * zod's raw multi-line JSON dump, which would render as a wall of braces in a
 * popover this size - so flatten and clamp it rather than trusting it to be prose.
 */
function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick - Foreman refused it.";
  return `That change didn't stick: ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`;
}

export interface ForemanState {
  config: ForemanConfig | null;
  status: ForemanStatus | null;
  update: (patch: ForemanConfigPatch) => Promise<void>;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

export function useForeman(): ForemanState {
  const [config, setConfigState] = useState<ForemanConfig | null>(null);
  const [status, setStatus] = useState<ForemanStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The config as last written, readable without making `update` depend on it (which
  // would rebuild the callback on every keystroke). This is what a revert restores.
  const configRef = useRef<ForemanConfig | null>(null);

  const setConfig = useCallback((c: ForemanConfig | null): void => {
    configRef.current = c;
    setConfigState(c);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const [c, s] = await Promise.all([fetchForemanConfig(), fetchForemanStatus()]);
      if (!alive) return;
      if (c) setConfig(c);
      if (s) setStatus(s);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setConfig]);

  /**
   * Apply a config change optimistically, and TAKE IT BACK if the server refuses.
   *
   * Without the revert a rejected patch leaves its value on screen with nothing to
   * explain it: the control reads one way, the daemon behaves another, and the only
   * thing that ever reconciles them is the next poll silently snapping the field
   * back. For a setting that governs when Foreman types into a live session, showing
   * a value that isn't in force is the whole ballgame.
   */
  const update = useCallback(
    async (patch: ForemanConfigPatch): Promise<void> => {
      const before = configRef.current;
      if (!before) return;
      setConfig({ ...before, ...patch });
      const res = await api.setForemanConfig(patch);
      if (!res.ok) {
        setConfig(before);
        setError(whyItFailed(res.error));
        return;
      }
      setError(null);
      const c = await fetchForemanConfig();
      if (c) setConfig(c);
    },
    [setConfig],
  );

  return { config, status, update, error };
}
