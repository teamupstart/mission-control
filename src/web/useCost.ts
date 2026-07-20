import { useCallback, useEffect, useRef, useState } from "react";
import type { CostConfigPatch, CostTelemetryStatus } from "@shared/protocol.ts";
import { api, fetchCostConfig } from "./lib/api.ts";

// Cost telemetry config for the Cost settings panel and the topbar strip.
//
// Owned by App and passed down, unlike `useSkills`/`useHarnesses`: the strip reads the
// same `view` setting the panel edits, so a second copy would leave the strip showing the
// old choice after an edit - and poll twice for it. Same reasoning as `useForeman`.
//
// Polled rather than streamed for the same reason as Foreman's and Harnesses' configs:
// coarse, rarely-edited chrome, not worth another SSE channel. The poll also reconciles a
// second dashboard tab's edits, and is the only thing that notices the user hand-editing
// their own settings.json out from under the toggle.

const POLL_MS = 4000;

/**
 * Frame a rejection as one short sentence. A refused patch comes back either as zod's raw
 * multi-line JSON or as the settings-file error verbatim, and neither reads well in a
 * panel this size. Mirrors `useForeman`'s `whyItFailed`.
 */
function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick.";
  return `That change didn't stick: ${flat.length > 120 ? `${flat.slice(0, 119)}…` : flat}`;
}

export interface CostState {
  /** Config plus what is really in `~/.claude/settings.json`. Null in the pre-poll instant. */
  status: CostTelemetryStatus | null;
  update: (patch: CostConfigPatch) => Promise<void>;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

export function useCost(): CostState {
  const [status, setStatusState] = useState<CostTelemetryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The status as last read, readable without making `update` depend on it (which would
  // rebuild the callback on every poll). This is what a revert restores.
  const statusRef = useRef<CostTelemetryStatus | null>(null);

  const setStatus = useCallback((s: CostTelemetryStatus | null): void => {
    statusRef.current = s;
    setStatusState(s);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const s = await fetchCostConfig();
      if (alive && s) setStatus(s);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setStatus]);

  /**
   * Apply a change optimistically and TAKE IT BACK if the daemon refuses.
   *
   * The revert matters more here than in the sibling hooks, because the thing being
   * refused is a write to the user's own `~/.claude/settings.json`: a toggle left reading
   * "on" after a failed write would claim we had edited a file we hadn't touched. Only
   * `config` is echoed optimistically - `installed` is a fact about that file, and
   * guessing at it is exactly the lie the panel exists to avoid, so it waits for the
   * server's answer.
   */
  const update = useCallback(
    async (patch: CostConfigPatch): Promise<void> => {
      const before = statusRef.current;
      if (!before) return;
      setStatus({ ...before, config: { ...before.config, ...patch } });
      const res = await api.setCostConfig(patch);
      if (!res.ok) {
        setStatus(before);
        setError(whyItFailed(res.error));
        return;
      }
      setError(null);
      const s = await fetchCostConfig();
      if (s) setStatus(s);
    },
    [setStatus],
  );

  return { status, update, error };
}
