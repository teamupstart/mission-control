import type {
  PipelineDaemonState,
  PipelineProbe,
  PipelineProviderId,
  PipelineRun,
  PipelineRunDetail,
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
  /**
   * The slugs this provider is actually driving in `repoRoot`, or null when it could not
   * look.
   *
   * This is what makes a PUSHED event addressable. The tail can only ever report runs it
   * found on disk, but ingest is told which run an event belongs to, and a slug that names
   * no run is not merely useless: the ledger is retired by pairing rows with the runs a pass
   * enumerates, so a row under a slug no pass will ever produce is a row nothing retires.
   * Accepting one would trade this table's bounded retention for whatever a token holder
   * cared to post.
   *
   * Same definition of "a run" as `readRepo`, deliberately - one source of truth, so the key
   * space ingest may write into is exactly the key space retirement walks. A provider that
   * answered a looser question here would reopen the hole in a way no test of `readRepo`
   * could see.
   *
   * NULL IS NOT AN EMPTY SET, and the caller's response differs from `readRepo`'s. There,
   * "could not look" must not retire a projection. Here, on a door, it refuses: an
   * unreadable directory cannot license a durable write, and the file tail still backfills
   * whatever was turned away.
   *
   * A provider that saw only PART of the truth still answers with the part it saw, rather
   * than with null. The two are different claims and only one of them is "I cannot look at
   * this repository": a listing cut short by a cap knows perfectly well that the runs in it
   * exist, and refusing their events because some other run might have been cut off spends
   * the events of every run to protect the retention of one.
   */
  knownRunSlugs(repoRoot: string): ReadonlySet<string> | null;
  /**
   * Read the gate evidence for ONE run, for the surface that has it open.
   *
   * Separate from `readRepo` rather than folded into the projection because of what the
   * projection is: a collection that rides every reconnect for every run on the fleet.
   * `test/pipeline-sse.test.ts` pins one run under 2kB and names this as the answer to
   * growth - detail is fetched by the one surface that draws it, so a fleet where nobody
   * has a pipeline open pays nothing for the fact that verdicts exist.
   *
   * Null means "no such run here", which a caller renders as a stale link rather than as an
   * error. Spawns nothing, writes nothing, and never throws: it reads the same files
   * `readRepo` does.
   */
  readRunDetail(repoRoot: string, slug: string): Promise<PipelineRunDetail | null>;
}
