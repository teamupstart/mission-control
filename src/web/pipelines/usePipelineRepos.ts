import { useEffect, useState } from "react";
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
 * @param active Whether the Pipelines surface is on screen. Gating is the whole reason this
 * is a parameter rather than an unconditional effect: with the tab absent - which is every
 * fleet observing no repository - nothing here ever asks the daemon anything.
 */
export function usePipelineRepos(active: boolean): PipelineRepoStatus[] | null {
  const [repos, setRepos] = useState<PipelineRepoStatus[] | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = async (): Promise<void> => {
      const answer = await fetchPipelineRepos();
      // A failed read leaves the last answer standing rather than blanking the rail: one
      // dropped request is not evidence that an operator withdrew their consent.
      if (alive && answer) setRepos(answer.repos);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);

  return repos;
}
