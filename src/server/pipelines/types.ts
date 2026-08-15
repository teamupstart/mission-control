import type {
  PipelineDaemonState,
  PipelineProbe,
  PipelineProviderId,
  PipelineRun,
} from "@shared/pipeline.ts";

import type { PipelineEventInput } from "../db.ts";

// The server-side half of the pipeline provider axis: what a provider DOES, as against
// `@shared/pipeline.ts`, which says what one IS and what crosses the wire. The same split
// `HARNESSES` makes against `HARNESS_CAPABILITIES` and `TASK_SOURCES` makes against
// `TASK_SOURCE_KIND_INFO`.
//
// One rule binds every implementation, and it is the reason this module exists rather than
// the integration being a few functions in `routes.ts`: **nothing here writes a file the
// provider owns.** Provider state is lease- and CAS-guarded by the provider itself, and its
// CLI is the only sanctioned mutation path. In this phase there is no mutation at all -
// every method below is a read.

/** One pass over one repository: every run it holds, plus where each tail stopped. */
export interface PipelineRepoReading {
  runs: PipelineRun[];
  /**
   * Where to resume each run's event ledger next pass, keyed by slug - the byte offset and
   * the identity of the file it indexes, which travel together because an offset without
   * the file it belongs to is what lets a re-cut worktree be read from the middle.
   */
  cursors: Map<string, { offset: number; identity: string }>;
  /**
   * Slugs whose event ledger was REPLACED rather than appended to - a worktree torn down and
   * re-cut under the same slug, or a ledger rewritten - so this pass read one from byte zero.
   *
   * Carried rather than left inside the tail because the consequence is the CALLER's: a
   * running token total that kept accumulating across a replacement would add the new
   * ledger's spend to the old ledger's and report a cost the run never had. The tail can see
   * the replacement; only the thing holding the total can act on it.
   */
  restarted: Set<string>;
  /**
   * What each run's event ledger yielded THIS pass, keyed by slug, for the append-only
   * `pipeline_events` ledger.
   *
   * Provider-neutral rather than the provider's own record type, because the ledger is one
   * table shared by every provider - and because what it stores is the producer's record
   * verbatim, which is a shape no provider needs to describe to get right.
   *
   * A run whose ledger this pass DECLINED to read (see `shouldTail`) is absent rather than
   * present-and-empty. The two mean different things to a caller: nothing new, versus we
   * did not look.
   */
  events: Map<string, PipelineEventInput[]>;
  daemon: PipelineDaemonState;
  /**
   * A bounded sentence about why this pass saw less than it should have, or null.
   *
   * A pass NEVER throws and never returns a partial set silently: an unreadable repository
   * reports an empty run list AND a reason, which the panel prints. The two together are
   * what stop "the engine has nothing running" and "we could not look" from rendering as
   * the same page.
   */
  error: string | null;
}

/** What one pass may be told about how much work to do. */
export interface PipelineReadOptions {
  /**
   * Whether this pass should read one run's event ledger at all.
   *
   * The demotion contract, expressed as one predicate the CALLER owns. A provider has no way
   * to know whether a visualizer plugin is pushing this run's events - that is a fact about
   * Mission Control's ingest route, not about the engine - so the policy lives with the
   * watcher and the provider only obeys it.
   *
   * Absent means read everything, which is what every caller that has not thought about it
   * gets: the file tail is the primary reader and staying primary is its default.
   *
   * It governs the EVENT LEDGER only. State files - the step statuses, the halt marker, the
   * DONE marker, `.daemon/` - are read on every pass whatever this says. Those are the
   * source of truth, and no amount of pushed events makes reading them optional.
   */
  shouldTail?: (slug: string) => boolean;
}

/**
 * What a pipeline provider must be able to do.
 *
 * `Record<PipelineProviderId, PipelineProvider>` in `./index.ts` is the enforcement: an id
 * appended to the shared tuple does not compile until something can actually probe and
 * read it. The alternative - a lookup returning undefined - is a provider the Settings
 * panel offers, the config accepts, and the watcher skips in silence.
 */
export interface PipelineProvider {
  provider: PipelineProviderId;
  /**
   * The command whose mere PRESENCE on `PATH` means this engine is installed, after the
   * operator's env override.
   *
   * Separate from `probe()` because it answers a weaker question much more cheaply: the
   * Settings rail needs "should this row exist" synchronously, on every snapshot, for every
   * operator - and `onPath` walks `PATH` with `existsSync` where a probe spawns. What the
   * engine's version is and which repositories it manages are the panel's questions.
   */
  binForPresence(): string;
  /** Spawns. Called from the Settings route behind a cache, never from the watch loop. */
  probe(): Promise<PipelineProbe>;
  /**
   * Read every run in one repository, from the provider's files alone.
   *
   * Spawns nothing. That is what makes the watch loop cheap enough to run on a cadence,
   * and what makes an enabled repository cost nothing on a machine where the engine is
   * installed but not running.
   */
  readRepo(
    repoRoot: string,
    cursors: Map<string, { offset: number; identity: string }>,
    options?: PipelineReadOptions,
  ): Promise<PipelineRepoReading>;
}
