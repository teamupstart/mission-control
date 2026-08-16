import {
  PIPELINE_PROVIDER_IDS,
  activePipelineRepos,
  pipelineRepoKey,
  pipelineRunKey,
  type PipelineProbe,
  type PipelineProviderId,
  type PipelineRepoStatus,
  type PipelineRun,
  type PipelineRunDetail,
} from "@shared/pipeline.ts";

import { envVar } from "../config.ts";
import { onPath } from "../util/exec.ts";
import {
  appendPipelineEvents,
  deletePipelineEventsForRepo,
  deletePipelineEventsForRun,
  deletePipelineRunRow,
  deletePipelineRunsForRepo,
  loadPipelineRuns,
  pipelineEventCursors,
  pipelineEventSlugs,
  pipelineStoredRepos,
  upsertPipelineRunRow,
} from "../db.ts";
import { unref } from "../util/timers.ts";
import { getPipelinesConfig } from "./config.ts";
import {
  forgetPipelineIngest,
  isPipelineIngestLive,
  pipelineIngestState,
  resetPipelineIngest,
  type PipelineIngestTouch,
} from "./ingest.ts";
import { PIPELINE_PROVIDERS } from "./providers.ts";
import type { PipelineReadOptions } from "./types.ts";

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
 * How long a run whose events are being pushed may go without a full ledger read.
 *
 * The floor under demotion, and the reason demotion is safe to do at all. A pushed event is
 * an event this build's plugin knew to subscribe to; conductor's bus has no wildcard, so a
 * conductor release that adds an event kind emits something the installed plugin never asked
 * for. That event still reaches `events.jsonl`, and this sweep is what picks it up.
 *
 * So the tail is never actually switched off - it is switched from "every tick" to "every
 * minute", which is the difference between polling a file for changes and checking that
 * nothing was missed.
 */
const BACKFILL_SWEEP_MS = Math.max(1000, Number(envVar("PIPELINE_BACKFILL_MS") ?? 60_000));

/**
 * How long a burst of pushed events is allowed to coalesce into one pass.
 *
 * Small enough that a human watching the dashboard sees a step land immediately, and large
 * enough that a step boundary emitting six events in the same millisecond costs one pass
 * rather than six. Debouncing is what keeps ingest from being a way for a busy engine to
 * make the daemon read its files faster than the tick ever would.
 */
const INGEST_REFRESH_MS = Math.max(0, Number(envVar("PIPELINE_INGEST_REFRESH_MS") ?? 150));

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
  return config.repos.map((repo) => {
    const held = statuses.get(pipelineRepoKey(repo.provider, repo.repoRoot)) ?? {
      provider: repo.provider,
      repoRoot: repo.repoRoot,
      daemon: "unknown" as const,
      runs: 0,
      halted: 0,
      lastReadAt: null,
      error: null,
    };
    // Read HERE rather than stamped onto the status by the pass that wrote it, because it
    // decays with the clock: a repository whose plugin stopped pushing an hour ago has had
    // no pass since (nothing changed), and a value frozen at the last pass would still be
    // claiming `live`. Everything else on this line is a fact about a read that happened;
    // this one is a fact about now.
    return { ...held, ingest: pipelineIngestState(repo.provider, repo.repoRoot) };
  });
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

/**
 * How many repositories are actually being read right now.
 *
 * The weaker sibling of `pipelinesPresent`, and it decides a different thing: `present`
 * draws the Settings row for an operator who has an engine INSTALLED, while this draws the
 * Runs page's Pipelines tab for one who has consented to a repository. A tab offering to
 * show pipelines to somebody observing none would be a page with nothing behind it, and -
 * because the tab is what starts the surface's own reads - it would also be the thing that
 * makes "off costs nothing" stop being true.
 *
 * A number rather than a boolean because the tab's empty state says how many repositories
 * are being watched, and deriving that twice is how two surfaces come to disagree.
 */
export function pipelinesObserving(): number {
  return activePipelineRepos(getPipelinesConfig()).length;
}

/**
 * The health of the repositories being READ, for the Pipelines rail's group headers.
 *
 * Narrower than `pipelineRepoStatuses` on purpose. That one answers the Settings panel,
 * which lists every repository an operator has configured precisely so they can see the
 * ones that are switched off; this one answers a rail that groups runs, where a repository
 * nothing is reading has no runs to group and would draw an empty heading that no control
 * on the page can explain.
 */
export function activePipelineRepoStatuses(): PipelineRepoStatus[] {
  const active = new Set(
    activePipelineRepos(getPipelinesConfig()).map((repo) =>
      pipelineRepoKey(repo.provider, repo.repoRoot),
    ),
  );
  return pipelineRepoStatuses().filter((status) =>
    active.has(pipelineRepoKey(status.provider, status.repoRoot)),
  );
}

/**
 * One run's gate evidence, for the surface that has it open.
 *
 * Behind the SAME consent this module's watch loop is behind, and that is the whole reason
 * this wrapper exists rather than the route calling the provider directly: the argument is a
 * repository path off a URL, so without this check the route would read `.pipeline/` files
 * out of any directory on the machine for anyone who can reach the loopback API. Consent is
 * what makes a path readable here, exactly as it is what makes it projected.
 *
 * Null covers every "there is nothing to show" case - no such provider, a repository nobody
 * consented to, a slug that names no worktree - because a caller renders all three the same
 * way, as a link that has gone stale.
 */
export async function readPipelineRunDetail(
  provider: PipelineProviderId,
  repoRoot: string,
  slug: string,
): Promise<PipelineRunDetail | null> {
  const consented = activePipelineRepos(getPipelinesConfig()).some(
    (repo) => repo.provider === provider && repo.repoRoot === repoRoot,
  );
  if (!consented) return null;
  return PIPELINE_PROVIDERS[provider].readRunDetail(repoRoot, slug);
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
  lastSweptAt.clear();
  // Liveness is a claim about a plugin that is pushing to THIS process. Nothing has pushed
  // to a process that has just started, whatever the one before it saw.
  resetPipelineIngest();
  const consented = new Set(
    activePipelineRepos(getPipelinesConfig()).map((repo) => pipelineRepoKey(repo.provider, repo.repoRoot)),
  );
  for (const { provider, repoRoot } of pipelineStoredRepos()) {
    if (consented.has(pipelineRepoKey(provider, repoRoot))) continue;
    deletePipelineRunsForRepo(provider, repoRoot);
    deletePipelineEventsForRepo(provider, repoRoot);
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
export function refreshPipelineRepo(
  sink: PipelineProjectionSink,
  provider: PipelineProviderId,
  repoRoot: string,
  options: PipelinePassOptions = {},
): Promise<void> {
  // Serialized per repository, and that is a correctness requirement rather than a
  // politeness. A pass is read-then-write over a resume cursor: two overlapping passes both
  // read offset N, both tail from N, and both hand the watcher the same batch's token spend
  // to add to the running total. Before ingest there was exactly one caller and it could not
  // overlap itself (the tick is a self-rescheduling timeout); a pushed event is a second
  // entry point that can arrive at any moment, including in the middle of a tick.
  const key = pipelineRepoKey(provider, repoRoot);
  const chained = (passes.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => runPipelineRepoPass(sink, provider, repoRoot, options));
  const settled = chained.catch(() => {});
  passes.set(key, settled);
  void settled.then(() => {
    // Only if nothing queued behind this one, so the map holds at most one live chain per
    // repository and does not outlive the consent that created it.
    if (passes.get(key) === settled) passes.delete(key);
  });
  return chained;
}

/** What one pass may be told, beyond which repository it is reading. */
export interface PipelinePassOptions {
  /**
   * The instant this pass is reckoned to happen at. Defaults to now.
   *
   * The watcher's own clock, and the only reason it is injectable: both things this module
   * decides on a timer - whether a live run's backfill sweep has come due, and whether the
   * health line reads live or quiet - are measured in minutes, so a test that drove them by
   * waiting would be either slow or a race. Every production caller omits it.
   *
   * It does not reach the provider, which stamps its own clock on a run's age from the files
   * it just read. What is injectable here is when the WATCHER thinks it is.
   */
  now?: number;
}

/**
 * Passes in flight or queued, per repository. See `refreshPipelineRepo`.
 */
const passes = new Map<string, Promise<void>>();

/** When each run's ledger was last read in full, for the backfill sweep. */
const lastSweptAt = new Map<string, number>();

/**
 * Whether this pass should read one run's event ledger.
 *
 * Two ways to yes, and they are the demotion contract stated as code: no live ingest (the
 * tail is primary, which is every run on every machine today), or the sweep coming due - the
 * backstop for events the installed plugin never subscribed to. A run this process has never
 * swept takes the second one, so a pipeline that starts while its plugin is already pushing
 * still gets its ledger read in full, once.
 *
 * **A push is deliberately not a third way.** It is the obvious one to add and it defeats the
 * whole phase: the plugin flushes every 250ms, so "read the ledger of whatever was just
 * pushed" is "read it on every flush", which is a FASTER cadence than the tick this exists to
 * relax. It would also be redundant - a pushed event is in the ledger already, written by the
 * ingest route before this pass was scheduled, so the tail would be re-reading a file to find
 * what the daemon is holding. What a push buys is the state files being folded early, which
 * needs no help from here; see `schedulePipelineRefresh`.
 */
function tailPolicy(
  provider: PipelineProviderId,
  repoRoot: string,
  now: number,
): (slug: string) => boolean {
  return (slug) => {
    const key = pipelineRunKey(provider, repoRoot, slug);
    const decided = (yes: boolean): boolean => {
      if (yes) lastSweptAt.set(key, now);
      return yes;
    };
    if (!isPipelineIngestLive(provider, repoRoot, slug, now)) return decided(true);
    const swept = lastSweptAt.get(key);
    return decided(swept === undefined || now - swept >= BACKFILL_SWEEP_MS);
  };
}

async function runPipelineRepoPass(
  sink: PipelineProjectionSink,
  provider: PipelineProviderId,
  repoRoot: string,
  options: PipelinePassOptions,
): Promise<void> {
  const now = options.now ?? Date.now();
  const cursors = pipelineEventCursors(provider, repoRoot);
  const readOptions: PipelineReadOptions = {
    shouldTail: tailPolicy(provider, repoRoot, now),
  };
  const reading = await PIPELINE_PROVIDERS[provider].readRepo(repoRoot, cursors, readOptions);

  const seen = new Set<string>();
  let halted = 0;
  for (const run of reading.runs) {
    seen.add(run.slug);
    if (run.halt !== null) halted += 1;
    const key = pipelineRunKey(provider, repoRoot, run.slug);
    // The ledger is incremental, so a pass reports only what IT read. Carrying the running
    // total here rather than in the reader is what keeps a live run's spend from falling
    // back to null the moment its ledger goes quiet for one tick.
    //
    // Unless the ledger was REPLACED. A worktree torn down and re-cut under the same slug
    // gets a fresh ledger that this pass read from byte zero, so what it reports is already
    // the whole of the new run's spend - adding the old run's total to it would report a
    // cost that never happened, and would keep reporting it for as long as the row lived.
    //
    // DELETED rather than read past, and the difference is a real defect: a replacement
    // whose first pass carries no token-bearing record at all computes a null total, which
    // the write below skips - leaving the OLD total cached for the next ordinary append to
    // find and add to. Dropping it here means the stale value cannot outlive the pass that
    // learned it was stale.
    if (reading.restarted.has(run.slug)) costTotals.delete(key);
    // What this pass read of the run's own ledger, appended to the observation ledger.
    //
    // Deliberately NOT what the projection is built from - the fold above and below this
    // line reads the engine's files, exactly as it did before this table existed. The ledger
    // is a record of what was observed, and a pushed event that also lands here converges
    // onto the same row rather than adding a second one.
    //
    // A replaced ledger re-reads from byte zero and re-offers events already stored; every
    // one of them is recognised and ignored, so a re-cut worktree costs no duplicate rows.
    const observed = reading.events.get(run.slug);
    if (observed && observed.length > 0) {
      appendPipelineEvents(provider, repoRoot, run.slug, "tail", observed);
    }
    const carried = costTotals.get(key) ?? null;
    const total =
      run.costTokens === null ? carried : (carried ?? 0) + run.costTokens;
    if (total !== null) costTotals.set(key, total);
    const projected: PipelineRun = { ...run, costTokens: total };
    // Durable first, then the notify - an SSE emission cannot be rolled back, and the
    // schedule catalog holds the same order for the same reason.
    const cursor = reading.cursors.get(run.slug);
    upsertPipelineRunRow({
      run: projected,
      eventsOffset: cursor?.offset ?? 0,
      eventsIdentity: cursor?.identity ?? "",
    });
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
    // Cursors AND ledger slugs, because the two are not the same set and the difference is
    // exactly where rows would be stranded. A cursor exists only after a pass has read a
    // run's files; a PUSHED event is accepted the moment it arrives, for a run that was real
    // at the door. Tear that worktree down inside the refresh debounce - or before a pass
    // that errored, or one that hit the per-repo cap - and there is no cursor, so a loop over
    // cursors alone would never visit those rows again for the life of the database.
    for (const slug of new Set([...cursors.keys(), ...pipelineEventSlugs(provider, repoRoot)])) {
      if (seen.has(slug)) continue;
      deletePipelineRunRow(provider, repoRoot, slug);
      // The observed history goes with the run it describes. That pairing is the whole of
      // the ledger's retention policy: the table is bounded by the runs that still exist,
      // not by how long this daemon has been up.
      deletePipelineEventsForRun(provider, repoRoot, slug);
      costTotals.delete(pipelineRunKey(provider, repoRoot, slug));
      lastSweptAt.delete(pipelineRunKey(provider, repoRoot, slug));
      sink.removePipelineRun(provider, repoRoot, slug);
    }
  }

  statuses.set(pipelineRepoKey(provider, repoRoot), {
    provider,
    repoRoot,
    daemon: reading.daemon,
    runs: reading.runs.length,
    halted,
    lastReadAt: now,
    error: reading.error,
    ingest: pipelineIngestState(provider, repoRoot, now),
  });
}

/**
 * Repositories a push has touched, waiting to be read. One entry each, per pass.
 *
 * Repositories rather than runs, because a pass reads the whole repository's state files
 * anyway and the one per-run decision it makes - whether to read that run's event ledger -
 * belongs to `tailPolicy` and not to whoever was pushed about. Carrying the slugs here would
 * be carrying an answer nothing is allowed to ask.
 */
const pendingIngest = new Map<string, { provider: PipelineProviderId; repoRoot: string }>();

/** The debounce that turns a burst of pushed events into one pass. */
let ingestRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Read the runs a batch of pushed events named, without waiting for the next tick.
 *
 * The whole of what ingest buys, and it is worth being exact about what it is NOT. A pushed
 * event is not folded into the projection - `normalizeConductorRun` needs the state file,
 * the halt marker, the DONE marker and `.daemon/`, and a single bus record carries none of
 * them. Nor could an event-only fold be made to carry them without becoming a second,
 * divergent answer to what a run's state is, which is the one thing `src/server/pipelines/`
 * is built not to have.
 *
 * So a push means "fold this repository's state files now". The pass that follows is the
 * ordinary pass, over the same files, producing the same `PipelineRun` - it just happens a
 * tick early. That is why nothing downstream of it needs to know whether ingest is live, and
 * why an operator with no plugin installed loses nothing.
 *
 * And it asks for nothing else. In particular it does NOT ask for the pushed run's event
 * ledger to be read: those events are in the ledger already, put there by the route before
 * this was called, and a tail per accepted batch would peg the file read to the plugin's
 * 250ms flush - undoing, on exactly the runs it was meant for, the demotion this phase is.
 * `tailPolicy` owns that decision and a push does not overrule it.
 */
export function schedulePipelineRefresh(
  sink: PipelineProjectionSink,
  touched: readonly PipelineIngestTouch[],
): void {
  for (const { provider, repoRoot } of touched) {
    pendingIngest.set(pipelineRepoKey(provider, repoRoot), { provider, repoRoot });
  }
  if (pendingIngest.size === 0 || ingestRefreshTimer !== null) return;
  ingestRefreshTimer = unref(
    setTimeout(() => {
      ingestRefreshTimer = null;
      void drainPipelineRefreshes(sink);
    }, INGEST_REFRESH_MS),
  );
}

/**
 * Run every pending push-triggered pass now.
 *
 * Exported so a test can drive the ingest path to completion instead of racing a debounce -
 * the same reason `refreshPipelineRepo` is exported rather than reached through the tick.
 */
export async function drainPipelineRefreshes(sink: PipelineProjectionSink): Promise<void> {
  if (ingestRefreshTimer !== null) {
    clearTimeout(ingestRefreshTimer);
    ingestRefreshTimer = null;
  }
  const due = [...pendingIngest.values()];
  pendingIngest.clear();
  // Consent is re-read HERE, not trusted from when the push was accepted. This queue is a
  // debounce, so between the POST that filled it and the timer that drains it an operator
  // can have switched the repository off - and a pass is a durable write plus an emit, so
  // running one for a repository nobody consents to any more would re-create the very rows
  // `forgetPipelineRepo` just deleted. It clears this queue as well, which closes the window
  // from the other side; this is the check that also covers a pass already dequeued.
  const consented = new Set(
    activePipelineRepos(getPipelinesConfig()).map((repo) =>
      pipelineRepoKey(repo.provider, repo.repoRoot),
    ),
  );
  for (const { provider, repoRoot } of due) {
    if (!consented.has(pipelineRepoKey(provider, repoRoot))) continue;
    try {
      await refreshPipelineRepo(sink, provider, repoRoot);
    } catch (err) {
      // Same posture as the tick's own per-repository catch. A push is a notification, and
      // one repository that could not be read is not a reason to drop the others in the
      // batch - or to answer the plugin with a failure it is built to ignore anyway.
      console.error(`[pipelines] ${provider} ${repoRoot} ingest pass failed:`, err);
    }
  }
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
    lastSweptAt.delete(pipelineRunKey(provider, repoRoot, slug));
    sink.removePipelineRun(provider, repoRoot, slug);
  }
  // The observed history goes too, and it goes for the same reason the projection does: an
  // operator who withdraws consent is owed a daemon with nothing of that repository left in
  // it. A ledger surviving the consent that authorised writing it would be the one durable
  // thing this integration kept without permission.
  deletePipelineEventsForRepo(provider, repoRoot);
  forgetPipelineIngest(provider, repoRoot);
  statuses.delete(pipelineRepoKey(provider, repoRoot));
  // And the pass a push had already queued for it. Without this, withdrawing consent inside
  // the debounce window deletes the rows and then lets a pass scheduled 150ms ago write them
  // back - a repository the operator switched off, re-appearing on the page by itself. The
  // drain re-checks consent for the same reason from the other end; both are cheap and
  // neither alone closes the window.
  pendingIngest.delete(pipelineRepoKey(provider, repoRoot));
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
  for (const { provider, repoRoot } of pipelineStoredRepos()) {
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
      // reconciliation runs, because a fleet that has never consented to a repository has
      // nothing stored for it to find - and `pipelineStoredRepos()` is a query.
      //
      // Withdrawal does not rely on this tick reaching it. The config route reconciles on
      // the write, which is what makes a repository switched off between two ticks lose its
      // rows at the moment the operator switched it off rather than a minute later.
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
