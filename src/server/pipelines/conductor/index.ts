import {
  PIPELINE_PROVIDER_INFO,
  type PipelineDaemonState,
  type PipelineRun,
} from "@shared/pipeline.ts";

import type { PipelineEventInput } from "../../db.ts";
import type { PipelineProvider, PipelineReadOptions, PipelineRepoReading } from "../types.ts";
import { normalizeConductorRun } from "./normalize.ts";
import { conductorBin, probeConductor } from "./probe.ts";
import {
  MAX_RUNS_PER_REPO,
  readConductState,
  readDaemon,
  readDone,
  readHalt,
  readWorktrees,
  type DaemonReading,
} from "./state.ts";
import { tailConductorEvents, tokensIn } from "./tail.ts";

// The ai-conductor provider: one probe, and one file-only pass over a repository.
//
// The pass spawns nothing. Every fact it reports comes from a `stat`, a `readdir` or a
// small `read`, which is what makes it cheap enough to run on a cadence and what makes an
// enabled repository free on a machine where the engine is installed but idle.

const INFO = PIPELINE_PROVIDER_INFO["ai-conductor"];

/**
 * What the engine's own background daemon is doing in this repository.
 *
 * `stopped` rather than `unknown` for a missing or dead pidfile: absence IS the answer here
 * (`readDaemon` has already discarded a pidfile whose process is gone), and it is the answer
 * an operator acts on - nothing is going to advance this repository until they start it.
 * `unknown` is reserved for a pass that could not read `.daemon/` at all.
 */
function daemonState(daemon: DaemonReading): PipelineDaemonState {
  if (daemon.paused) return "paused";
  return daemon.pid !== null ? "running" : "stopped";
}

/**
 * Read one repository's runs from ai-conductor's own files.
 *
 * `.daemon/` is read ONCE per pass rather than once per run: it lives at the repository
 * root, not inside each worktree, and its `parked/`, `grants/` and `processed/` directories
 * are indexed by slug across every feature. Reading it per run would be one `readdir` per
 * worktree per tick for a directory that cannot differ between them.
 *
 * Never throws. An unreadable repository reports no runs AND a reason, because "the engine
 * has nothing running here" and "we could not look" must not render as the same page.
 */
async function readConductorRepo(
  repoRoot: string,
  cursors: Map<string, { offset: number; identity: string }>,
  options?: PipelineReadOptions,
): Promise<PipelineRepoReading> {
  const now = Date.now();
  try {
    const daemon = readDaemon(repoRoot);
    const listing = readWorktrees(repoRoot, INFO.worktreesDir);
    // Could not look. Reported as an error with the offsets handed straight back, so the
    // caller retires nothing: an unlistable directory is not an empty one, and treating it
    // as empty would delete a repository's whole projection over a transient `EACCES`.
    if (listing === null) {
      return {
        runs: [],
        cursors,
        restarted: new Set(),
        events: new Map(),
        daemon: daemonState(daemon),
        error: `could not list ${INFO.worktreesDir}/ in this repository`,
      };
    }
    const runs: PipelineRun[] = [];
    const nextCursors = new Map<string, { offset: number; identity: string }>();
    const restarted = new Set<string>();
    const events = new Map<string, PipelineEventInput[]>();
    for (const worktree of listing.worktrees) {
      const state = readConductState(worktree.path);
      const held = cursors.get(worktree.slug);
      // The state files above are read unconditionally; only the ledger read is governed.
      // See `PipelineReadOptions.shouldTail` - a run whose events are arriving by push still
      // has its halt marker, its step statuses and its daemon markers read every pass,
      // because those are the source of truth and a push is not.
      const tail = (options?.shouldTail?.(worktree.slug) ?? true)
        ? tailConductorEvents(worktree.path, held?.offset ?? 0, held?.identity ?? null)
        : null;
      // A declined read carries the held cursor forward UNCHANGED. Writing a zero here
      // instead would make every relaxed tick re-read the whole ledger from the top the
      // moment the run stopped being live, which is the opposite of relaxing it.
      nextCursors.set(
        worktree.slug,
        tail
          ? { offset: tail.offset, identity: tail.identity }
          : (held ?? { offset: 0, identity: "" }),
      );
      if (tail?.restarted) restarted.add(worktree.slug);
      if (tail) {
        events.set(
          worktree.slug,
          tail.records.map((record) => ({
            kind: record.type,
            ts: record.ts,
            // The byte offset the record starts at: unique within a file and monotonic,
            // which is the whole of what a producer's sequence number owes. The engine
            // stamps none of its own.
            producerSeq: record.offset,
            body: record.body,
          })),
        );
      }
      runs.push(
        normalizeConductorRun({
          repoRoot,
          slug: worktree.slug,
          worktree: worktree.path,
          state,
          halt: readHalt(worktree.path),
          done: readDone(worktree.path),
          daemon,
          // Only what THIS pass tailed. The running total is carried forward by the
          // watcher, which is the thing that holds the previous projection - a reader
          // that summed only its own batch would report a live run's spend falling back
          // to null the moment its ledger went quiet.
          //
          // A pass that declined to read the ledger reports `null` for the same reason a
          // quiet ledger does: it learned nothing about this run's spend, which is not the
          // same claim as it having none. The watcher's carried total stands.
          costTokens: tail ? tokensIn(tail.records) : null,
          now,
        }),
      );
    }
    return {
      runs,
      cursors: nextCursors,
      restarted,
      events,
      daemon: daemonState(daemon),
      // Asked of the reader rather than inferred from the count: a repository sitting at
      // exactly the cap has lost nothing, and calling that an error would stop the caller
      // retiring stale runs there for good.
      error: listing.truncated
        ? `only the first ${MAX_RUNS_PER_REPO} worktrees in this repository are projected`
        : null,
    };
  } catch (err) {
    // Belt and braces. Every reader below is already total, so reaching this means
    // something structural - and a watcher that stopped projecting every other repository
    // over one of them would be a worse answer than a repository that says why.
    return {
      runs: [],
      cursors,
      restarted: new Set(),
      events: new Map(),
      daemon: "unknown",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Which slugs this repository is actually driving, for the ingest door.
 *
 * `readWorktrees` and nothing else, so this cannot drift from what `readConductorRepo`
 * counts as a run: same directory, same `.pipeline/` requirement, same cap. A truncated
 * listing is treated as "could not look", because the slug being asked about may be exactly
 * one of the entries the cap cut off, and answering "no" to it would refuse a real run's
 * events for as long as the repository stayed over the cap.
 */
function conductorRunSlugs(repoRoot: string): ReadonlySet<string> | null {
  const listing = readWorktrees(repoRoot, INFO.worktreesDir);
  if (listing === null || listing.truncated) return null;
  return new Set(listing.worktrees.map((worktree) => worktree.slug));
}

export const CONDUCTOR_PROVIDER: PipelineProvider = {
  provider: "ai-conductor",
  binForPresence: conductorBin,
  probe: probeConductor,
  readRepo: readConductorRepo,
  knownRunSlugs: conductorRunSlugs,
};
