import { useCallback, useEffect, useRef, useState } from "react";
import type { ForemanConfig, ForemanConfigPatch } from "@shared/protocol.ts";
import type { BacklogPlan, ForemanEpisode, ForemanStatus } from "@shared/types.ts";
import {
  api,
  fetchBacklogPlan,
  fetchForemanConfig,
  fetchForemanEpisodes,
  fetchForemanStatus,
} from "./lib/api.ts";

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
  /**
   * Foreman's reading of the backlog, or null when it has never made one (or the read
   * failed - see `fetchBacklogPlan`). Carried here rather than fetched by the Backlog
   * column so it rides the poll this hook already runs, and so App stays the single
   * owner of everything the layouts draw.
   */
  backlogPlan: BacklogPlan | null;
  /**
   * Every decision Foreman has faced across the fleet, newest first - the settings
   * panel's ledger.
   *
   * Rides this hook's existing tick rather than a timer of its own, which is what keeps
   * the panel's strip, its health card and its rows one consistent reading: three fetches
   * on three schedules would let a tile disagree with the rows under it for a few seconds
   * at a time, on a screen whose whole claim is that the number and the list are the same
   * question.
   *
   * `[]` before the first answer, not null: the panel distinguishes "nothing yet" from
   * "the daemon has not answered" through `config`, which is the same signal every other
   * control on it already reads.
   */
  episodes: ForemanEpisode[];
  /**
   * Apply a patch, resolving to whether the daemon accepted it. Callers that only edit a
   * field ignore the boolean (`void update(...)`); a caller that must chain a SECOND write
   * on this one succeeding - Trust retiring a staged repo once its first grant lands - waits
   * for it, so a rejected write never leaves the two stores disagreeing.
   */
  update: (patch: ForemanConfigPatch) => Promise<boolean>;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

export function useForeman(): ForemanState {
  const [config, setConfigState] = useState<ForemanConfig | null>(null);
  const [status, setStatus] = useState<ForemanStatus | null>(null);
  const [backlogPlan, setBacklogPlan] = useState<BacklogPlan | null>(null);
  const [episodes, setEpisodes] = useState<ForemanEpisode[]>([]);
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
      const [c, s, p, e] = await Promise.all([
        fetchForemanConfig(),
        fetchForemanStatus(),
        fetchBacklogPlan(),
        fetchForemanEpisodes(),
      ]);
      if (!alive) return;
      if (c) setConfig(c);
      if (s) setStatus(s);
      // Held on a failed read, like the config and status above and unlike the plan
      // below: an empty ledger is a claim ("Foreman has decided nothing"), and blanking a
      // table of fifty rows because one poll missed would say that falsely once every
      // time the daemon is busy. The rows are append-only, so a stale copy is merely old,
      // never wrong.
      if (e) setEpisodes(e);
      // Written unconditionally, unlike the two above: null is a MEANING here ("Foreman
      // has no reading of the backlog"), not merely a failed read, and a plan that stuck
      // on screen after the backlog was cleared would keep blaming a dependency that no
      // longer exists. The cost of a transient failure is one poll of an unannotated
      // column, which is the pre-autopilot rendering.
      setBacklogPlan(p);
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
    async (patch: ForemanConfigPatch): Promise<boolean> => {
      const before = configRef.current;
      if (!before) return false;
      // `backlogDefaultModel` is a per-harness map. Preserve the other harness's
      // selection while the server-side merge is in flight, matching setForemanConfig.
      setConfig({
        ...before,
        ...patch,
        backlogDefaultModel: {
          ...before.backlogDefaultModel,
          ...(patch.backlogDefaultModel ?? {}),
        },
      });
      const res = await api.setForemanConfig(patch);
      if (!res.ok) {
        setConfig(before);
        setError(whyItFailed(res.error));
        return false;
      }
      setError(null);
      const c = await fetchForemanConfig();
      if (c) setConfig(c);
      return true;
    },
    [setConfig],
  );

  return { config, status, backlogPlan, episodes, update, error };
}
