import { join } from "node:path";

import {
  PIPELINE_PROVIDER_INFO,
  sortByPipelineStep,
  type PipelineConsole,
  type PipelineDaemonState,
  type PipelineRun,
  type PipelineRunDetail,
  type PipelineRunLink,
} from "@shared/pipeline.ts";

import type { PipelineEventInput } from "../../db.ts";
import type {
  PipelineConsoleTarget,
  PipelineFeatureUsage,
  PipelineProvider,
  PipelineReadOptions,
  PipelineRepoReading,
} from "../types.ts";
import { conductorConsoleArgv, runConductorControl } from "./control.ts";
import { normalizeConductorRun } from "./normalize.ts";
import { conductorBin, probeConductor } from "./probe.ts";
import { registerConductorRepo } from "./register.ts";
import {
  conductorInstallerCandidates,
  conductorInstallerRuntime,
  conductorInstallerTerminalArgv,
} from "./installer.ts";
import { resolveBinPath } from "../../util/exec.ts";
import {
  MAX_RUNS_PER_REPO,
  readConductState,
  readDaemon,
  readDone,
  readGateVerdicts,
  readHalt,
  readShippedCost,
  readWorktrees,
  type DaemonReading,
  type ShippedCostReading,
} from "./state.ts";
import { ledgerReplaced, tailConductorEvents, tokensIn } from "./tail.ts";

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
 * One feature's committed cost record, in the shape the ledger takes.
 *
 * `costKnown` is the only judgement here and it is a strict one, in three parts: the record
 * has to CARRY a price at all, the engine has to have metered every dispatch, and it has to
 * have priced every one it metered. A missing `cost_usd` line and either count above zero are
 * the same situation from the ledger's point of view - the dollar figure on hand is not this
 * feature's cost - and the ledger's standing rule, held by every other writer, is that such a
 * figure is stored as unpriced rather than presented as a total.
 *
 * A record whose engine could price nothing at all still contributes its TOKENS, which is
 * the case a Codex-backed feature is in: tokens are counted, dollars are not, and the strip
 * says "unpriced" beside a real token figure rather than dropping the feature entirely. The
 * zero that travels with `costKnown: false` is a placeholder the ledger never reads as money.
 */
function usageFrom(cost: ShippedCostReading): PipelineFeatureUsage {
  return {
    input: cost.input,
    output: cost.output,
    // The engine's record has no reasoning tier of its own: its rollup folds the four tiers
    // it tracks and reasoning output is not one of them. Zero here is the honest reading of
    // a field the source does not carry, not a claim that no reasoning tokens were spent.
    reasoningOutput: 0,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    costUsd: cost.costUsd ?? 0,
    costKnown: cost.costUsd !== null && cost.unmetered === 0 && cost.costUnmetered === 0,
    ts: cost.writtenAt,
  };
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
        usage: new Map(),
        restarted: new Set(),
        events: new Map(),
        daemon: daemonState(daemon),
        error: `could not list ${INFO.worktreesDir}/ in this repository`,
      };
    }
    const runs: PipelineRun[] = [];
    const nextCursors = new Map<string, { offset: number; identity: string }>();
    const usage = new Map<string, PipelineFeatureUsage>();
    const restarted = new Set<string>();
    const events = new Map<string, PipelineEventInput[]>();
    for (const worktree of listing.worktrees) {
      const state = readConductState(worktree.path);
      const done = readDone(worktree.path);
      const held = cursors.get(worktree.slug);
      // The state files above are read unconditionally; only the ledger read is governed.
      // See `PipelineReadOptions.shouldTail` - a run whose events are arriving by push still
      // has its halt marker, its step statuses and its daemon markers read every pass,
      // because those are the source of truth and a push is not.
      //
      // A REPLACED ledger overrules the demotion, and that is not a hedge. Both the restart
      // flag and this pass's own token spend are produced by the read; decline it on a
      // worktree that was torn down and re-cut under the same slug, and the watcher never
      // learns to drop the old run's carried total, so the new run is displayed with the
      // spend of the one it replaced - for up to a whole backfill interval, on the runs that
      // are live enough to have been demoted in the first place. `ledgerReplaced` is a single
      // `stat` and answers exactly that case.
      const wanted = options?.shouldTail?.(worktree.slug) ?? true;
      const tail =
        wanted || ledgerReplaced(worktree.path, held?.identity ?? null)
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
      // Only looked for once a feature has finished, which is the only time the engine has
      // written one - so the ordinary pass over a repository of running features opens no
      // extra file at all. `prUrl` is in the test because the record is committed on the
      // feature branch just before the pull request opens, so it can exist while the state
      // file still says the run is going. Read whether or not this pass tailed the ledger: a
      // run demoted because its events are being pushed still has to have its cost noticed
      // when the engine writes it, and this is one `stat` on a finished run.
      const cost =
        done || state.complete || state.prUrl !== null
          ? readShippedCost(worktree.path, worktree.slug)
          : null;
      if (cost !== null) usage.set(worktree.slug, usageFrom(cost));
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
          done,
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
      usage,
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
      usage: new Map(),
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
 * counts as a run: same directory, same `.pipeline/` requirement, same cap.
 *
 * A TRUNCATED listing still answers, with the runs it did see. Returning null there - "could
 * not look" - was the earlier judgement and it was wrong in the direction that costs events:
 * a repository over the cap would have had every push refused, including pushes for the runs
 * this build is actively projecting, because some OTHER slug might have been cut off. The
 * slugs beyond the cap are still refused, and that is the correct half of the old reasoning:
 * a run no pass enumerates is a run no retirement walks, so a row under its slug would be a
 * row nothing ever retires.
 *
 * Only an unreadable directory is "could not look", and only that refuses everything.
 */
function conductorRunSlugs(repoRoot: string): ReadonlySet<string> | null {
  const listing = readWorktrees(repoRoot, INFO.worktreesDir);
  if (listing === null) return null;
  return new Set(listing.worktrees.map((worktree) => worktree.slug));
}

/**
 * One run's gate evidence, read fresh.
 *
 * The worktree is found by LISTING the repository rather than by joining the slug onto a
 * path, and that is a boundary decision rather than a style one: the slug reaching this
 * function came off a URL, and `..` joined onto a repository root is a directory traversal.
 * `readWorktrees` returns only real feature worktrees under `.worktrees/` - a slug that is
 * not one of them names nothing, and null is exactly what a stale deep link deserves.
 *
 * Sorted into the engine's own step order so the detail view can zip verdicts against the
 * strip without sorting them a second time, with unknown gate names carried at the end under
 * the same tolerance rule the strip uses.
 */
async function readConductorRunDetail(
  repoRoot: string,
  slug: string,
): Promise<PipelineRunDetail | null> {
  try {
    const listing = readWorktrees(repoRoot, INFO.worktreesDir);
    const worktree = listing?.worktrees.find((entry) => entry.slug === slug);
    if (!worktree) return null;
    return {
      provider: "ai-conductor",
      repoRoot,
      slug,
      gates: sortByPipelineStep(
        "ai-conductor",
        readGateVerdicts(worktree.path).map((verdict) => ({
          // Named rather than spread, so a field the reader gains stays a decision about
          // what crosses the wire instead of arriving on it unnoticed.
          step: verdict.step,
          satisfied: verdict.satisfied,
          reason: verdict.reason,
          checkedAt: verdict.checkedAt,
          kickbackFrom: verdict.kickbackFrom,
          skipped: verdict.skipped,
        })),
        (verdict) => verdict.step,
      ),
      readAt: Date.now(),
    };
  } catch {
    // Same posture as the pass above: total. A detail read that threw would put a stack
    // trace where a run's evidence goes, over a file another program rewrites underneath us.
    return null;
  }
}

/**
 * What to run in a hosted terminal for one console.
 *
 * Both refusals here are Mission Control's, not relayed ones, and both are here rather than
 * in the schema because the schema cannot see the run. A reseal names artifacts inside a
 * FEATURE'S WORKTREE: a console asked for without a feature has nothing to name, and a path
 * that leaves that worktree is naming somebody else's artifact. The engine would refuse the
 * first of those itself - `unknown feature worktree` - but a terminal that opens purely to
 * print that is worse than a button that explains itself, and it would not refuse the second
 * at all, because from its point of view an operator typed it.
 *
 * `conductorConsoleArgv` is told where the worktree IS rather than deriving it, which keeps
 * this file the only place that knows the engine's `.worktrees/<slug>` layout.
 */
function conductorConsole(
  console_: PipelineConsole,
  target: PipelineConsoleTarget,
): { argv: string[]; cwd: string } | { refused: string } {
  if (console_ === "reseal" && target.slug === null) {
    return { refused: "a reseal names the feature whose artifacts moved" };
  }
  const worktree = join(target.repoRoot, INFO.worktreesDir, target.slug ?? "");
  const composed = conductorConsoleArgv(console_, target, worktree);
  if ("refused" in composed) return composed;
  return {
    argv: composed.argv,
    // The MAIN checkout, for both. `daemon connect` resolves the repository itself, but
    // `reseal` joins `.worktrees/<slug>` onto its own working directory with no git
    // resolution - so run from anywhere else it looks for a worktree inside a worktree and
    // refuses a feature that is plainly there.
    cwd: target.repoRoot,
  };
}

/** The exact terminal argv for conductor's idea intake, with the nesting guard scrubbed. */
export function conductorEngineerArgv(bin: string, intent: string): string[] {
  return ["/usr/bin/env", "-u", "CLAUDECODE", bin, "engineer", "--idea", intent];
}

/**
 * Conductor's canonical idea key, copied from its Engineer plan/worktree contract.
 *
 * Keep this provider-owned and fixture-pinned. The plan stem becomes the daemon run slug,
 * so changing this independently of ai-conductor would prebind tasks to runs that can never
 * appear. ASCII is intentional: characters outside `[a-z0-9]` are separators in the
 * provider implementation rather than letters retained through Unicode normalization.
 */
export function conductorIdeaSlug(intent: string): string {
  return intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/** The run Engineer will create from this idea, before any provider state exists for it. */
function conductorTaskIdentity(
  intent: string,
  repoRoot: string,
): PipelineRunLink | { refused: string } {
  const slug = conductorIdeaSlug(intent);
  if (slug === "") {
    return { refused: "conductor cannot derive a run slug from this task intent" };
  }
  return { provider: "ai-conductor", repoRoot, slug };
}

/** Resolve conductor before opening a terminal that would otherwise exit immediately. */
async function conductorTask(
  intent: string,
  repoRoot: string,
): Promise<{ argv: string[]; cwd: string } | { refused: string }> {
  const configured = conductorBin();
  const bin = await resolveBinPath(configured);
  if (!bin) return { refused: `${configured} is not on this daemon's PATH` };
  return { argv: conductorEngineerArgv(bin, intent), cwd: repoRoot };
}

export const CONDUCTOR_PROVIDER: PipelineProvider = {
  provider: "ai-conductor",
  binForPresence: conductorBin,
  probe: probeConductor,
  registerRepo: registerConductorRepo,
  installer: {
    runtime: conductorInstallerRuntime,
    candidates: conductorInstallerCandidates,
    terminalArgv: conductorInstallerTerminalArgv,
  },
  readRepo: readConductorRepo,
  knownRunSlugs: conductorRunSlugs,
  readRunDetail: readConductorRunDetail,
  control: runConductorControl,
  consoleArgv: conductorConsole,
  taskIdentity: conductorTaskIdentity,
  taskArgv: conductorTask,
};
