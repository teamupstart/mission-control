import {
  PIPELINE_PROVIDER_IDS,
  activePipelineRepos,
  pipelineRepoKey,
  pipelineRunKey,
  type PipelineProbe,
  type PipelineProviderId,
  type PipelineRepoStatus,
  type PipelineRun,
} from "@shared/pipeline.ts";

import { envVar } from "../config.ts";
import { onPath } from "../util/exec.ts";
import {
  deletePipelineRunRow,
  deletePipelineRunsForRepo,
  loadPipelineRuns,
  pipelineEventOffsets,
  pipelineProjectedRepos,
  upsertPipelineRunRow,
} from "../db.ts";
import { unref } from "../util/timers.ts";
import { CONDUCTOR_PROVIDER } from "./conductor/index.ts";
import { getPipelinesConfig } from "./config.ts";
import type { PipelineProvider } from "./types.ts";

// The pipeline provider registry, and the loop that keeps the projection current.
//
// Two properties this module owes the rest of the daemon, and both are about what happens
// when nobody has enabled anything - which is the shipped configuration and, for almost
// every operator, the permanent one:
//
//  - With no consented repository, a tick reads the config blob and returns. No `stat`, no
//    subprocess, no SSE frame. That is the whole of "disabled is byte-identical to today".
//  - With one, a tick is a handful of small file reads per repository and an emit only
//    when something a human could see actually moved (`Registry.upsertPipelineRun` drops
//    the rest).
//
// The daemon is still the only SQLite writer: this loop runs in it, and the port bind is
// the mutex that makes exactly one of it.

/**
 * Every provider, keyed by id.
 *
 * `Record<PipelineProviderId, PipelineProvider>` is the enforcement: an id appended to the
 * shared tuple does not compile until something can probe and read it. A lookup that could
 * return undefined would be a provider the Settings panel offers, the config accepts, and
 * this loop skips in silence.
 */
export const PIPELINE_PROVIDERS: Record<PipelineProviderId, PipelineProvider> = {
  "ai-conductor": CONDUCTOR_PROVIDER,
};

/** How often the loop re-reads every consented repository's files. */
const TICK_MS = Math.max(1000, Number(envVar("PIPELINE_TICK_MS") ?? 5000));

/**
 * How many ticks apart the cheap "is an engine installed" check runs.
 *
 * Derived from `TICK_MS` so it stays about a minute however the tick is tuned, and floored
 * at 1 so a tick slower than a minute still checks every time rather than never.
 */
const PRESENCE_EVERY_TICKS = Math.max(1, Math.round(60_000 / TICK_MS));

/** How long a cached probe answers the Settings route before it is re-run. */
const PROBE_TTL_MS = Math.max(1000, Number(envVar("PIPELINE_PROBE_TTL_MS") ?? 30_000));

/**
 * Per-repository health, process-local and never persisted.
 *
 * Not in SQLite for `taskSourceStatuses`' reason and one more: every figure here is
 * re-derived by the next tick from files that are still on disk, so persisting it would
 * buy a marginally better first paint and a second schema to keep in step with the first.
 */
const statuses = new Map<string, PipelineRepoStatus>();

/** The last probe of each provider, so the Settings route does not spawn per poll. */
const probes = new Map<PipelineProviderId, PipelineProbe>();

/** Running token totals per run, so a quiet ledger does not retract a spend already read. */
const costTotals = new Map<string, number>();

/**
 * What the panel reads: one status per consented repository, in config order.
 *
 * Repositories with no pass yet report `lastReadAt: null` rather than zeroes, which is the
 * same distinction the Inspector panel's "unknown" state makes: nothing observed is not
 * the same claim as nothing there.
 */
export function pipelineRepoStatuses(): PipelineRepoStatus[] {
  const config = getPipelinesConfig();
  return config.repos.map(
    (repo) =>
      statuses.get(pipelineRepoKey(repo.provider, repo.repoRoot)) ?? {
        provider: repo.provider,
        repoRoot: repo.repoRoot,
        daemon: "unknown",
        runs: 0,
        halted: 0,
        lastReadAt: null,
        error: null,
      },
  );
}

/**
 * Whether this operator has anything to do with a pipeline engine.
 *
 * The one question that decides whether the Conductor category exists in the Settings rail,
 * and it is answered WITHOUT a subprocess: `onPath` walks `PATH` with `existsSync`, so this
 * is a handful of stats rather than the `fork` + `execve` a real probe costs. That is what
 * makes it affordable on a signal the rail needs synchronously, on every snapshot, for every
 * operator - including the overwhelming majority who will never install an engine.
 *
 * It deliberately asks a WEAKER question than `probePipelineProvider`. Whether the binary
 * exists is enough to decide that a row should be drawn; what version it is and which
 * repositories it manages are the panel's questions, and the panel is the thing that has
 * been opened on purpose.
 *
 * The `configured` half is not symmetry for its own sake. Without it, an operator who
 * enabled a repository and then uninstalled the engine would lose the row that holds the
 * only switch that can turn it off - consent in force with nothing on screen to withdraw it.
 */
export function pipelinesPresent(): boolean {
  const config = getPipelinesConfig();
  if (config.enabled || config.repos.length > 0) return true;
  return PIPELINE_PROVIDER_IDS.some((provider) =>
    onPath(PIPELINE_PROVIDERS[provider].binForPresence()),
  );
}

/** Probes already running, so a burst of polls cannot become a burst of subprocesses. */
const probesInFlight = new Map<PipelineProviderId, Promise<void>>();

/** Run one probe and hold its answer, at most one at a time per provider. */
function refreshProbe(provider: PipelineProviderId): Promise<void> {
  const running = probesInFlight.get(provider);
  if (running) return running;
  const attempt = PIPELINE_PROVIDERS[provider]
    .probe()
    .then((fresh) => {
      probes.set(provider, fresh);
    })
    .catch((err: unknown) => {
      // A probe that could not run leaves the held answer alone rather than replacing it
      // with a failure: the panel's job is to say what is installed, and one failed spawn
      // is not evidence that an engine was uninstalled.
      console.warn(`[pipelines] could not probe ${provider}:`, err);
    })
    .finally(() => {
      probesInFlight.delete(provider);
    });
  probesInFlight.set(provider, attempt);
  return attempt;
}

/**
 * What this daemon last found out about one provider, or null before it has looked.
 *
 * **An ordinary read never waits for a subprocess.** The Settings panel polls every four
 * seconds and it is reachable from any category, so a route that awaited a spawn would put
 * two `fork`+`execve` pairs on the path of a page that is mostly about other things - and
 * would do it whether or not this feature is enabled. So a stale or absent answer starts a
 * refresh in the BACKGROUND and returns what is held; the next poll picks the new one up,
 * and until then the panel draws its own honest "looking for the engine" state.
 *
 * `force` is the panel's "Check again" - an operator asking on purpose - and is the one
 * caller that waits, because the whole point of that button is a fresh answer now.
 *
 * Nothing else in the daemon calls either path. In particular the watch loop does not,
 * which is why an engine that is not installed costs an enabled repository nothing.
 */
export async function probePipelineProvider(
  provider: PipelineProviderId,
  { force = false }: { force?: boolean } = {},
): Promise<PipelineProbe | null> {
  const held = probes.get(provider) ?? null;
  if (force) {
    await refreshProbe(provider);
    return probes.get(provider) ?? held;
  }
  if (held && Date.now() - held.checkedAt < PROBE_TTL_MS) return held;
  void refreshProbe(provider);
  return held;
}

/**
 * Every provider's last answer. What the detection card renders from.
 *
 * Providers this daemon has not looked at yet are ABSENT rather than represented by a
 * placeholder: the panel distinguishes "no answer yet" from "not installed", and a
 * synthesised not-found would collapse the two into the wrong one.
 */
export async function probeAllPipelineProviders(
  opts: { force?: boolean } = {},
): Promise<PipelineProbe[]> {
  const answers = await Promise.all(
    PIPELINE_PROVIDER_IDS.map((provider) => probePipelineProvider(provider, opts)),
  );
  return answers.filter((probe): probe is PipelineProbe => probe !== null);
}

/**
 * What the loop needs of the registry: somewhere to put the projection.
 *
 * A narrow structural interface rather than the concrete `Registry`, for the reason
 * `SettingsStatusPublisher` states: the dependency runs the other way round everywhere
 * else in this file's neighbourhood, and importing `registry.ts` here would put its whole
 * module graph behind this one's load.
 */
export interface PipelineProjectionSink {
  initializePipelineRuns(runs: readonly PipelineRun[]): void;
  upsertPipelineRun(run: PipelineRun): void;
  removePipelineRun(provider: PipelineProviderId, repoRoot: string, slug: string): void;
}

/**
 * Seed the live catalog from the durable projection, dropping anything no longer consented.
 *
 * Runs before the daemon serves, so it emits nothing - a dashboard's first snapshot is
 * simply right. The pruning is the half that matters: consent can be withdrawn while the
 * daemon is down, and a row that outlived its consent would come back on the next boot as
 * an SSE frame about a repository the operator switched off.
 */
export function restorePipelineProjection(sink: PipelineProjectionSink): void {
  // Establishes this process's in-memory state from the durable rows rather than adding to
  // whatever was there. Nothing precedes it in a real daemon, so in production this clears
  // two empty maps - but saying it is what makes the function mean "this is the state now",
  // and what lets a test simulate a restart honestly instead of measuring carried-over state.
  statuses.clear();
  costTotals.clear();
  probes.clear();
  const consented = new Set(
    activePipelineRepos(getPipelinesConfig()).map((repo) => pipelineRepoKey(repo.provider, repo.repoRoot)),
  );
  for (const { provider, repoRoot } of pipelineProjectedRepos()) {
    if (consented.has(pipelineRepoKey(provider, repoRoot))) continue;
    deletePipelineRunsForRepo(provider, repoRoot);
  }
  const rows = loadPipelineRuns();
  for (const row of rows) {
    if (row.run.costTokens !== null) {
      costTotals.set(pipelineRunKey(row.run.provider, row.run.repoRoot, row.run.slug), row.run.costTokens);
    }
  }
  sink.initializePipelineRuns(rows.map((row) => row.run));
}

/**
 * One pass over one consented repository. Durable write first, then the emit.
 *
 * Exported so a test can drive exactly one pass. Reaching this through the loop's timer
 * instead would make every assertion about the projection a race against a cadence, which
 * is how a suite comes to be full of sleeps that are too short on CI.
 */
export async function refreshPipelineRepo(
  sink: PipelineProjectionSink,
  provider: PipelineProviderId,
  repoRoot: string,
): Promise<void> {
  const offsets = pipelineEventOffsets(provider, repoRoot);
  const reading = await PIPELINE_PROVIDERS[provider].readRepo(repoRoot, offsets);

  const seen = new Set<string>();
  let halted = 0;
  for (const run of reading.runs) {
    seen.add(run.slug);
    if (run.halt !== null) halted += 1;
    const key = pipelineRunKey(provider, repoRoot, run.slug);
    // The ledger is incremental, so a pass reports only what IT read. Carrying the running
    // total here rather than in the reader is what keeps a live run's spend from falling
    // back to null the moment its ledger goes quiet for one tick.
    const carried = costTotals.get(key) ?? null;
    const total =
      run.costTokens === null ? carried : (carried ?? 0) + run.costTokens;
    if (total !== null) costTotals.set(key, total);
    const projected: PipelineRun = { ...run, costTokens: total };
    // Durable first, then the notify - an SSE emission cannot be rolled back, and the
    // schedule catalog holds the same order for the same reason.
    upsertPipelineRunRow({ run: projected, eventsOffset: reading.offsets.get(run.slug) ?? 0 });
    sink.upsertPipelineRun(projected);
  }

  // Whatever the projection still holds for this repository and the engine no longer does:
  // a worktree that was torn down, or a slug that was renamed.
  //
  // ONLY on a pass that could see everything. A reading that reported a reason saw less than
  // it should have - an unlistable worktrees directory, or a repository past the per-pass cap
  // - and retiring on it would delete a whole projection over a transient `EACCES`, then put
  // it back on the next tick. "We could not look" is not "it is gone", which is the rule the
  // Inspector's poller holds about a `gh` that errored, applied to a directory.
  if (reading.error === null) {
    for (const slug of offsets.keys()) {
      if (seen.has(slug)) continue;
      deletePipelineRunRow(provider, repoRoot, slug);
      costTotals.delete(pipelineRunKey(provider, repoRoot, slug));
      sink.removePipelineRun(provider, repoRoot, slug);
    }
  }

  statuses.set(pipelineRepoKey(provider, repoRoot), {
    provider,
    repoRoot,
    daemon: reading.daemon,
    runs: reading.runs.length,
    halted,
    lastReadAt: Date.now(),
    error: reading.error,
  });
}

/**
 * Drop everything belonging to a repository whose consent has been withdrawn.
 *
 * Called from the config route as well as from the tick, so switching a repository off is
 * felt immediately rather than up to one tick later - an operator who withdraws consent
 * and watches the page should see it happen, not wonder whether it took.
 */
export function forgetPipelineRepo(
  sink: PipelineProjectionSink,
  provider: PipelineProviderId,
  repoRoot: string,
): void {
  for (const slug of deletePipelineRunsForRepo(provider, repoRoot)) {
    costTotals.delete(pipelineRunKey(provider, repoRoot, slug));
    sink.removePipelineRun(provider, repoRoot, slug);
  }
  statuses.delete(pipelineRepoKey(provider, repoRoot));
}

/**
 * Reconcile the projection against the config that is in force right now.
 *
 * The half of a config write that is not the write: a repository that just lost consent has
 * rows, a live catalog entry and a status line that all have to go. Idempotent, so the tick
 * calls it too and a change made by some other route is picked up without one.
 */
export function reconcilePipelineConsent(sink: PipelineProjectionSink): void {
  const consented = new Set(
    activePipelineRepos(getPipelinesConfig()).map((repo) => pipelineRepoKey(repo.provider, repo.repoRoot)),
  );
  for (const { provider, repoRoot } of pipelineProjectedRepos()) {
    if (consented.has(pipelineRepoKey(provider, repoRoot))) continue;
    forgetPipelineRepo(sink, provider, repoRoot);
  }
  // Collected before deleting rather than deleted in place: `forgetPipelineRepo` above
  // already removes the statuses it can reach, and this pass catches a repository that had
  // a health line but never any projected rows - so it must not also be mutating the map
  // it is walking.
  const stale: string[] = [];
  for (const key of statuses.keys()) {
    if (!consented.has(key)) stale.push(key);
  }
  for (const key of stale) statuses.delete(key);
}

/**
 * Keep the projection current.
 *
 * The canonical loop shape (`discovery/poller.ts`, `task-sources/sweeper.ts`): a
 * self-rescheduling `setTimeout` rather than `setInterval`, so ticks cannot overlap;
 * `unref()` so a pending tick never holds the process open; try/catch INSIDE the tick so
 * one unreadable repository cannot kill the loop; and a returned stop closure the daemon's
 * `shutdown()` calls.
 *
 * The config is re-read every tick rather than at construction, so consent takes effect
 * without a restart - the same discipline the sweeper holds.
 */
export function startPipelineWatcher(
  sink: PipelineProjectionSink,
  /**
   * Called when the presence answer moves, so the caller can push the settings status the
   * Settings rail reads. Passed in rather than reached for, exactly as the task-source
   * sweeper's `onSwept` is: this module touches neither the registry nor the rail.
   */
  onPresenceChanged?: () => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * How many ticks since presence was last checked, and the answer it gave.
   *
   * Checked on a SLOWER sub-cadence than the projection pass because it answers a question
   * that changes about once in an installation's life - an operator installing or removing
   * the engine - and the whole point of `pipelinesPresent` being stat-only is undone if it
   * runs at the cadence of a loop built for file changes. A minute is fast enough that
   * installing conductor makes the row appear while the operator is still looking for it,
   * and slow enough to be free.
   */
  let sinceCheck = Number.MAX_SAFE_INTEGER;
  let present: boolean | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      sinceCheck += 1;
      if (sinceCheck >= PRESENCE_EVERY_TICKS) {
        sinceCheck = 0;
        const now = pipelinesPresent();
        // Only on a CHANGE, and `null` on the first pass is not a change: the daemon's boot
        // snapshot already carries the right answer, so announcing it again would wake every
        // browser to tell it what it was handed a moment ago.
        if (present !== null && now !== present) onPresenceChanged?.();
        present = now;
      }
      const repos = activePipelineRepos(getPipelinesConfig());
      // The whole cost of this feature on a fleet that has enabled nothing: one KV read,
      // plus a handful of `existsSync` calls once a minute. Not even the consent
      // reconciliation runs, because with no projected repositories there is nothing for it
      // to find - and `pipelineProjectedRepos()` is a query.
      if (repos.length > 0 || statuses.size > 0) {
        reconcilePipelineConsent(sink);
        for (const repo of repos) {
          if (stopped) break;
          try {
            await refreshPipelineRepo(sink, repo.provider, repo.repoRoot);
          } catch (err) {
            console.error(`[pipelines] ${repo.provider} ${repo.repoRoot} pass failed:`, err);
          }
        }
      }
    } catch (err) {
      console.error("[pipelines] watch tick failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, TICK_MS));
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
