import type {
  PipelineAction,
  PipelineActionResult,
  PipelineConsole,
  PipelineDaemonState,
  PipelineProbe,
  PipelineProviderId,
  PipelineRun,
  PipelineRunDetail,
} from "@shared/pipeline.ts";

// The server-side half of the pipeline provider axis: what a provider DOES, as against
// `@shared/pipeline.ts`, which says what one IS and what crosses the wire. The same split
// `HARNESSES` makes against `HARNESS_CAPABILITIES` and `TASK_SOURCES` makes against
// `TASK_SOURCE_KIND_INFO`.
//
// One rule binds every implementation, and it is the reason this module exists rather than
// the integration being a few functions in `routes.ts`: **nothing here writes a file the
// provider owns.** Provider state is lease- and CAS-guarded by the provider itself, and its
// CLI is the only sanctioned mutation path.
//
// That rule survives this module gaining the ability to CHANGE something, which is what
// `control` below is. A verb spawns the provider's own CLI and reads what it printed; the
// park marker, the grant record and the pause marker that result are written by the provider,
// in response, exactly as they are when a person types the same thing. So the reads below are
// still reads of one program's state rather than of a state two programs are both writing -
// which matters because that state is CAS-guarded, and a second writer racing the provider's
// atomic renames corrupts a feature rather than losing an edit.

/** What one feature cost, as the PROVIDER recorded it. */
export interface PipelineFeatureUsage {
  input: number;
  output: number;
  reasoningOutput: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /**
   * Every dispatch behind `costUsd` carried a price.
   *
   * False makes the ledger store the figure as unpriced rather than as a total, which is the
   * rule every other writer holds: a sum over the priced rows of a partly-unpriced run reads
   * as the run's cost and is not.
   */
  costKnown: boolean;
  /** When the provider recorded it, in epoch ms. The ledger row's `ts`. */
  ts: number;
}

/** One pass over one repository: every run it holds, plus where each tail stopped. */
export interface PipelineRepoReading {
  runs: PipelineRun[];
  /**
   * What each finished feature cost, keyed by slug, for the runs that have a record.
   *
   * Sparse on purpose and in two directions. A run still in flight has no entry, because the
   * provider writes this figure when a feature ships; and a provider with nothing to say
   * about cost contributes an empty map rather than zeroes, because "not recorded" and "cost
   * nothing" are different claims and only one of them is ever true here.
   */
  usage: Map<string, PipelineFeatureUsage>;
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
  readRepo(
    repoRoot: string,
    cursors: Map<string, { offset: number; identity: string }>,
  ): Promise<PipelineRepoReading>;
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
  /**
   * Ask the provider to do one thing, through its own CLI, and report what it said.
   *
   * The one method that is not a read, and it is still not a write: it SPAWNS. Every
   * implementation owes two properties that the caller cannot check for it.
   *
   * **It validates by parsing output, never by exit code alone.** ai-conductor prints a
   * usage guide and exits 0 for a malformed invocation of several verbs, and rejects a
   * malformed one of several others before the verb runs at all - so a zero means a process
   * started and stopped, and nothing more. A provider whose CLI is better behaved still
   * validates its output, because the cost of being wrong is a dashboard reporting that it
   * paused an engine that is still dispatching.
   *
   * **It never throws.** A caller is drawing a control surface and needs a sentence for
   * every outcome, including a binary that is not installed.
   */
  control(action: PipelineAction, target: PipelineControlTarget): Promise<PipelineActionResult>;
  /**
   * What to run in a hosted terminal for one console, or a sentence refusing it.
   *
   * Separate from `control` because neither console is a request with an answer: one
   * attaches to a running daemon for as long as somebody watches it, and the other performs
   * a ceremony the provider refuses to perform without a terminal at all. There is no output
   * to validate, because the person reading it is the point.
   *
   * Returns argv only. Where that argv RUNS - which multiplexer or emulator, under what
   * name - is the terminal layer's decision and the operator's, not a provider's.
   */
  consoleArgv(
    console: PipelineConsole,
    target: PipelineConsoleTarget,
  ): { argv: string[]; cwd: string } | { refused: string };
}

/** What a control verb acts on. `slug` is null for a repository-scoped verb. */
export interface PipelineControlTarget {
  /**
   * The repository root, as the operator consented to it.
   *
   * Always the MAIN checkout rather than a feature worktree, because a provider's verbs may
   * resolve neither for themselves: ai-conductor's grant and reseal join their paths onto
   * the process's own working directory with no git resolution, so one run from inside a
   * worktree writes a file that authorizes nothing and reports success.
   */
  repoRoot: string;
  slug: string | null;
  step: string | null;
  /** The operator's own justification, for a verb that records one. Never invented here. */
  reason: string | null;
}

/** What a console attaches to, plus the ceremony's own arguments when it has any. */
export interface PipelineConsoleTarget extends PipelineControlTarget {
  paths: readonly string[];
  clearHalt: boolean;
}
