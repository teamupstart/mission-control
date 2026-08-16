import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineRepoStatus } from "@shared/pipeline.ts";
import { fetchPipelineRepos } from "../lib/api.ts";

// How often the rail re-reads the repositories it is grouping under. Matches the settings
// hooks' cadence rather than the pipeline watcher's, because this is chrome around a
// collection that arrives over the event stream: the runs are live already, and what this
// carries is the heading above them.
const POLL_MS = 4000;

/**
 * The repositories the daemon is reading, for the Pipelines rail's group headings.
 *
 * Polled rather than streamed, and that is the smaller of the two available mistakes. The
 * alternative is a third pipeline event kind and a third collection on the connect snapshot,
 * carried by every dashboard on every fleet, to say which of at most a handful of
 * repositories has a daemon alive - a wire cost every operator pays for a fact only this
 * surface reads. The route it polls spawns nothing: it is a config read and a map lookup.
 *
 * `refresh` is the one thing the cadence cannot do: an operator who just started or paused
 * the engine's daemon is entitled to see the chip move now rather than up to four seconds
 * later, and a control whose visible effect lags that far reads as one that did nothing. It
 * re-reads the same route rather than writing a guess into the state, so a verb that reported
 * success and did not take is still drawn as what the daemon actually sees.
 *
 * @param active Whether the Pipelines surface is on screen. Gating is the whole reason this
 * is a parameter rather than an unconditional effect: with the tab absent - which is every
 * fleet observing no repository - nothing here ever asks the daemon anything.
 */
export function usePipelineRepos(active: boolean): {
  repos: PipelineRepoStatus[] | null;
  refresh: () => void;
} {
  const [repos, setRepos] = useState<PipelineRepoStatus[] | null>(null);
  // Held in a ref so an unmounted surface's late answer cannot set state, for both the
  // interval and a refresh fired from a button that is about to go away with it.
  const alive = useRef(true);
  /**
   * Which read is the newest one asked for.
   *
   * The refresh below is fired the moment a verb returns, and the interval does not stop
   * while it runs - so a poll that left BEFORE the operator pressed Pause can answer after
   * the refresh does, carrying the state the engine was in a second ago. Applied in arrival
   * order, that redraws the chip as running and takes Resume off the row for four seconds,
   * on a daemon that is paused - which reads as the button having failed.
   *
   * So a read applies only while it is still the latest one asked for. `usePipelineRunDetail`
   * holds the same guard for the same reason: the answer to a question nobody is asking any
   * more is not an update.
   */
  const latest = useRef(0);

  const read = useCallback(async (): Promise<void> => {
    const mine = ++latest.current;
    const answer = await fetchPipelineRepos();
    // A failed read leaves the last answer standing rather than blanking the rail: one
    // dropped request is not evidence that an operator withdrew their consent.
    if (alive.current && answer && mine === latest.current) setRepos(answer.repos);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    void read();
    const id = setInterval(() => void read(), POLL_MS);
    return () => clearInterval(id);
  }, [active, read]);

  const refresh = useCallback(() => void read(), [read]);
  return { repos, refresh };
}
