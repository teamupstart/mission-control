import {
  PIPELINE_PROVIDER_INFO,
  type PipelineDaemonState,
  type PipelineRun,
} from "@shared/pipeline.ts";

import type { PipelineProvider, PipelineRepoReading } from "../types.ts";
import { normalizeConductorRun } from "./normalize.ts";
import { probeConductor } from "./probe.ts";
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
  offsets: Map<string, number>,
): Promise<PipelineRepoReading> {
  const now = Date.now();
  try {
    const daemon = readDaemon(repoRoot);
    const worktrees = readWorktrees(repoRoot, INFO.worktreesDir);
    // Could not look. Reported as an error with the offsets handed straight back, so the
    // caller retires nothing: an unlistable directory is not an empty one, and treating it
    // as empty would delete a repository's whole projection over a transient `EACCES`.
    if (worktrees === null) {
      return {
        runs: [],
        offsets,
        daemon: daemonState(daemon),
        error: `could not list ${INFO.worktreesDir}/ in this repository`,
      };
    }
    const runs: PipelineRun[] = [];
    const nextOffsets = new Map<string, number>();
    for (const worktree of worktrees) {
      const state = readConductState(worktree.path);
      const tail = tailConductorEvents(worktree.path, offsets.get(worktree.slug) ?? 0);
      nextOffsets.set(worktree.slug, tail.offset);
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
          costTokens: tokensIn(tail.records),
          now,
        }),
      );
    }
    return {
      runs,
      offsets: nextOffsets,
      daemon: daemonState(daemon),
      error:
        worktrees.length >= MAX_RUNS_PER_REPO
          ? `only the first ${MAX_RUNS_PER_REPO} worktrees in this repository are projected`
          : null,
    };
  } catch (err) {
    // Belt and braces. Every reader below is already total, so reaching this means
    // something structural - and a watcher that stopped projecting every other repository
    // over one of them would be a worse answer than a repository that says why.
    return {
      runs: [],
      offsets,
      daemon: "unknown",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const CONDUCTOR_PROVIDER: PipelineProvider = {
  provider: "ai-conductor",
  probe: probeConductor,
  readRepo: readConductorRepo,
};
