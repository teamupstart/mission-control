import { useCallback, useEffect, useState } from "react";
import type { PersonaUpstreamState } from "@shared/workflow.ts";
import { fetchPersonaDrift } from "./personaApi.ts";

/**
 * Whether each imported Persona still matches the file it was imported from.
 *
 * Fetched when a surface that RENDERS badges becomes active, and then only when somebody asks -
 * no interval, no SSE channel. Both omissions are deliberate. Drift is a fact about a file on
 * the operator's own disk that changes when they update a plugin or pull a checkout, not while
 * they watch, and a poll would put one `stat` and one `sha256` per imported Persona on a timer
 * for a badge that is identical between edits. An SSE event would be worse: the daemon would
 * have to WATCH those files to send one, which is a filesystem watcher per imported Persona for
 * the same result.
 *
 * `active` is what makes "when the surface opens" true rather than merely intended. This hook is
 * owned by `App`, which mounts once per page load - so gating on mount alone meant fetching at
 * STARTUP and never again, and an operator who left the dashboard open, upgraded a plugin and
 * then opened the Library was shown the verdict from whenever the tab was first loaded. Keying
 * the effect on `active` re-asks on every arrival at the Library instead, and a dashboard that
 * never goes there reads no files at all.
 *
 * Between arrivals the badge is honest about being a snapshot: it says what the last check
 * found, and **Check upstream** is how an operator asks again without navigating. `refresh` is
 * also called after an import and after a re-import, the two moments the answer certainly
 * changed.
 *
 * A failed fetch leaves the previous map in place rather than clearing it. An empty map renders
 * no badges at all, which is indistinguishable from "everything is current" - so dropping the
 * map on a transient failure would quietly retract a warning that is still true.
 */
export interface PersonaDriftState {
  /** Persona id -> what the last check found. Absent means not imported, or not yet checked. */
  upstream: ReadonlyMap<string, PersonaUpstreamState>;
  refresh: () => void;
}

export function usePersonaDrift(active: boolean): PersonaDriftState {
  const [upstream, setUpstream] = useState<ReadonlyMap<string, PersonaUpstreamState>>(
    () => new Map(),
  );
  const [generation, setGeneration] = useState(0);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    // Not merely an optimization: this is what makes the fetch happen on ARRIVAL at a badge-
    // rendering surface rather than once per page load. `active` going false and true again is a
    // navigation away and back, and each arrival deserves a fresh answer about the disk.
    if (!active) return;
    let alive = true;
    void fetchPersonaDrift()
      .then((map) => {
        if (alive) setUpstream(map);
      })
      .catch(() => {
        // Nothing to say and nothing to retract: the surfaces keep whatever the last
        // successful check reported, and the operator can ask again.
      });
    return () => {
      alive = false;
    };
  }, [active, generation]);

  return { upstream, refresh };
}
