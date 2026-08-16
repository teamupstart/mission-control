import { useEffect, useRef, useState } from "react";
import {
  pipelineRunKey,
  type PipelineProviderId,
  type PipelineRunDetail,
} from "@shared/pipeline.ts";
import { fetchPipelineRunDetail } from "../lib/api.ts";

/**
 * One selected pipeline run's gate evidence, fetched on demand.
 *
 * The same split `useWorkflowRunDetail` makes, for the same reason and one more. Compact run
 * summaries ride the event stream; the evidence behind the run somebody has OPEN is fetched
 * by the surface that draws it. Here the budget is pinned rather than merely preferred -
 * `test/pipeline-sse.test.ts` measures one `PipelineRun` against 2kB and names this fetch as
 * the answer to growth - because the projection is a collection that rides every reconnect
 * for every run on the fleet.
 *
 * `updatedAt` is the projection's own refresh signal, exactly as the workflow hook uses the
 * run summary's: when the daemon reports the run moved, the evidence is re-read. Nothing
 * polls on a timer, so a run nobody is watching costs nothing and a run that is not moving
 * is not read twice.
 *
 * The run's identity arrives as three scalars rather than as the `PipelineRun` it comes off,
 * because the projection rebuilds that object on every frame of the event stream: an effect
 * depending on the object would re-read the engine's files on every frame, and one depending
 * on a hand-built key of its fields would need a lint suppression to say so.
 */
export type PipelineRunDetailState =
  | { state: "loading" }
  /**
   * The evidence could not be read: the run is gone, its repository is no longer observed,
   * OR the daemon did not answer. `fetchJson` is total and returns null for all three, so
   * this state deliberately does not claim to know which - and it is recoverable rather than
   * terminal, because the next projection frame for this run re-runs the read.
   */
  | { state: "missing" }
  | { state: "ready"; detail: PipelineRunDetail };

const LOADING: PipelineRunDetailState = { state: "loading" };

interface StoredDetailState {
  key: string;
  value: PipelineRunDetailState;
}

/**
 * Everything the fetch depends on, as one comparable value.
 *
 * The run's three parts go through `pipelineRunKey` rather than being joined here, because a
 * plain join is ambiguous: `("/repo/foo", "1-fix")` and `("/repo/foo1", "-fix")` concatenate
 * to one string, and this key is what decides whether stored evidence belongs to the run on
 * screen. A collision would draw one run's gate verdicts under another's name.
 *
 * `updatedAt` is appended after that key rather than folded into it - it is the refresh
 * signal, not part of the run's identity - and it cannot reintroduce the ambiguity because it
 * is a number, so no slug can end where a timestamp begins.
 */
function detailKey(
  provider: PipelineProviderId | null,
  repoRoot: string | null,
  slug: string | null,
  updatedAt: number,
): string {
  if (!provider || !repoRoot || !slug) return "";
  return `${pipelineRunKey(provider, repoRoot, slug)}@${updatedAt}`;
}

export function usePipelineRunDetail(
  provider: PipelineProviderId | null,
  repoRoot: string | null,
  slug: string | null,
  updatedAt: number,
): PipelineRunDetailState {
  const generation = useRef(0);
  const [stored, setStored] = useState<StoredDetailState | null>(null);
  const key = detailKey(provider, repoRoot, slug, updatedAt);

  useEffect(() => {
    const current = ++generation.current;
    if (!provider || !repoRoot || !slug) return;
    setStored({ key, value: LOADING });
    void fetchPipelineRunDetail(provider, repoRoot, slug).then((detail) => {
      // The guard is what stops a slow answer for the run somebody just left being drawn
      // under the run that replaced it - the rail is one click per row, and the engine's
      // files sit on a disk that can be busy.
      if (generation.current !== current) return;
      setStored({ key, value: detail ? { state: "ready", detail } : { state: "missing" } });
    });
    return () => {
      if (generation.current === current) generation.current++;
    };
  }, [provider, repoRoot, slug, key]);

  if (!key || stored === null || stored.key !== key) return LOADING;
  return stored.value;
}
