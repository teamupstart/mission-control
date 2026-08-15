import type {
  PipelineDaemonState,
  PipelineProbe,
  PipelineProviderId,
  PipelineRun,
} from "@shared/pipeline.ts";

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
  /** Byte offset into each run's event ledger, keyed by slug. Resumes the next pass. */
  offsets: Map<string, number>;
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
  readRepo(repoRoot: string, offsets: Map<string, number>): Promise<PipelineRepoReading>;
}
