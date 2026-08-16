import {
  PIPELINE_PROVIDER_IDS,
  PIPELINE_SPEND_ROLES,
  PIPELINE_SPEND_WRITERS,
  activePipelineRepos,
  pipelineConsoleAllowed,
  pipelineGrantAllowed,
  pipelineRepoKey,
  pipelineRunKey,
  type PipelineAction,
  type PipelineActionResult,
  type PipelineConsole,
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
  recordPipelineUsage,
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
import type {
  PipelineConsoleTarget,
  PipelineControlTarget,
  PipelineFeatureUsage,
  PipelineReadOptions,
} from "./types.ts";

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
 * What was last written to the spend ledger for each feature, as one comparable string.
 *
 * Not a cache of the FIGURE - the ledger holds that, durably - but of the write, so a
 * repository of shipped features does not re-run one idempotent UPSERT per feature per tick
 * for ever. Process-local and safe to lose: an empty map costs one write per shipped feature
 * on the next pass, and every one of those writes lands on the row it would have replaced
 * with the same values.
 *
 * Bounded by the runs that still exist, through `forgetRunState`: a feature whose worktree
 * is gone has nothing left to suppress, and holding its fingerprint would make this map the
 * one thing in the daemon that grows with every feature a repository has ever shipped.
 */
const ledgered = new Map<string, string>();

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
  if (!isPipelineRepoConsented(provider, repoRoot)) return null;
  return PIPELINE_PROVIDERS[provider].readRunDetail(repoRoot, slug);
}

/**
 * Whether the operator consents to this repository being observed, right now.
 *
 * Read from the config on every call rather than cached, which is the whole point: every
 * caller is asking across an await or a timer, at the far side of a window in which the
 * answer can have changed. A snapshot taken when the work was scheduled is the bug this
 * predicate exists to stop, so there is deliberately nothing here to hold onto.
 */
function isPipelineRepoConsented(provider: PipelineProviderId, repoRoot: string): boolean {
  return activePipelineRepos(getPipelinesConfig()).some(
    (repo) => repo.provider === provider && repo.repoRoot === repoRoot,
  );
}

/**
 * Whether this operator has said Mission Control may act in this repository.
 *
 * The same consent that makes a repository READABLE is what makes it actable, and nothing
 * finer: enabling a repository is enabling the integration in it, and a second switch for
 * "observe but do not control" would be a control an operator has to find before the button
 * they can already see stops failing.
 *
 * Checked here rather than in the route for `readPipelineRunDetail`'s reason, which is
 * sharper for a verb than for a read: the repository path arrives off a request body, so
 * without this the loopback API would spawn an engine CLI with a `cwd` of anywhere on the
 * machine. Consent is what turns a path into one this daemon may run something in.
 */
function consented(provider: PipelineProviderId, repoRoot: string): boolean {
  return activePipelineRepos(getPipelinesConfig()).some(
    (repo) => repo.provider === provider && repo.repoRoot === repoRoot,
  );
}

/**
 * Whether the projection holds this run, for a verb that names one.
 *
 * A slug off a request body is a path component the provider will join onto a repository
 * root, so it is checked against the runs this daemon is actually projecting rather than
 * merely validated for shape. That makes `..` and every other traversal a 404 for the
 * reason it should be - no such run - without this file having to reason about paths at all.
 */
function projecting(provider: PipelineProviderId, repoRoot: string, slug: string): boolean {
  return projectedRun(provider, repoRoot, slug) !== null;
}

/** The projected run a verb names, or null when this daemon is not holding one. */
function projectedRun(
  provider: PipelineProviderId,
  repoRoot: string,
  slug: string,
): PipelineRun | null {
  const found = loadPipelineRuns().find(
    (row) =>
      row.run.provider === provider && row.run.repoRoot === repoRoot && row.run.slug === slug,
  );
  return found?.run ?? null;
}

/**
 * Why a control request cannot be served at all.
 *
 * `ok: false` rather than a nullable field, because that is the shape a caller has to be able
 * to narrow on: `parseBody` answers this way, and a discriminant a route can switch on beats
 * two fields that are only ever set in opposite pairs.
 */
export interface PipelineControlRefused {
  ok: false;
  status: 400 | 404 | 409;
  error: string;
}

/** The consent and identity checks both control routes share. */
function refuseControl(
  provider: PipelineProviderId,
  repoRoot: string,
  slug: string | null,
): PipelineControlRefused | null {
  // 404 rather than 403, and the same sentence for both: an unconsented repository and a
  // repository that does not exist must answer identically, or the loopback API answers
  // questions about the operator's filesystem for anything that can reach it. The same rule
  // `GET /api/pipelines/run` states.
  if (!consented(provider, repoRoot)) {
    return { ok: false, status: 404, error: "no such pipeline repository" };
  }
  if (slug !== null && !projecting(provider, repoRoot, slug)) {
    return { ok: false, status: 404, error: "no such pipeline run" };
  }
  return null;
}

/**
 * Ask the engine to do one thing, then re-read the repository so the answer is visible.
 *
 * The re-projection is the half that makes this feel like a control rather than a request.
 * Every verb changes something the projection reads FROM FILES - a park marker, the pause
 * marker, a grant, the pidfile - so a pass immediately afterwards turns the change into the
 * `pipeline_upsert` every open dashboard is already listening for. Without it the operator
 * presses Park and watches an unchanged row until the next tick, which reads as a button
 * that did nothing.
 *
 * It runs even when the verb FAILED, and that is deliberate rather than tidy: a verb that
 * reported no confirmation may still have done part of its work - conductor prints its park
 * success line before the counter reset that can throw - so the projection has to be re-read
 * to find out what is actually true, not told what we hoped.
 *
 * `refreshPipelineRepo` already suppresses an emit when nothing a human could see moved, so
 * a verb that changed nothing costs one pass and no frame.
 */
export async function runPipelineAction(
  sink: PipelineProjectionSink,
  action: PipelineAction,
  target: PipelineControlTarget & { provider: PipelineProviderId },
): Promise<{ ok: true; result: PipelineActionResult } | PipelineControlRefused> {
  const refused = refuseControl(target.provider, target.repoRoot, target.slug);
  if (refused) return refused;
  // The one verb whose ELIGIBILITY is a fact about the run rather than about the request, and
  // the daemon decides it rather than trusting the surface to have hidden the button. A grant
  // is a standing authorization for the engine to re-enter a DECIDE step unattended, so a
  // request for one on a run that never stopped at a gate is the gate's whole purpose spent in
  // advance - and "the browser would not have offered it" is not a check, it is a hope about
  // who is calling. Same posture as the `plan` refusal in the provider: stated on both sides.
  if (action === "grant") {
    const run = projectedRun(target.provider, target.repoRoot, target.slug ?? "");
    if (!pipelineGrantAllowed(run?.halt ?? null)) {
      return {
        ok: false,
        // The request is well-formed and the run exists; its STATE is what refuses this.
        status: 409,
        error: "a DECIDE grant answers a halt that asked for one, and this run has no such halt",
      };
    }
  }
  const result = await PIPELINE_PROVIDERS[target.provider].control(action, target);
  try {
    await refreshPipelineRepo(sink, target.provider, target.repoRoot);
  } catch (err) {
    // The verb's own answer is what the operator asked for and it is already in hand; a
    // failed re-read delays the row by one tick rather than losing the action.
    console.warn(`[pipelines] could not re-read ${target.repoRoot} after ${action}:`, err);
  }
  return { ok: true, result };
}

/**
 * What to run in a hosted terminal for one console, behind the same consent.
 *
 * Returns argv rather than opening anything, because WHERE it opens is the terminal layer's
 * question and the operator's: they pick the backend, and this module has no business
 * knowing that multiplexers and emulators are different shapes.
 */
export function pipelineConsoleLaunch(
  console_: PipelineConsole,
  target: PipelineConsoleTarget & { provider: PipelineProviderId },
): { ok: true; argv: string[]; cwd: string } | PipelineControlRefused {
  const refused = refuseControl(target.provider, target.repoRoot, target.slug);
  if (refused) return refused;
  // A run console is the answer to a particular halt, so its eligibility is a fact about
  // the projected run rather than about a well-formed request. The browser reads the same
  // table to decide whether to offer this control, but the loopback route is the authority
  // boundary: a hidden button cannot be the only thing stopping another caller opening a
  // terminal that breaks a seal and optionally clears its halt.
  if (target.slug !== null) {
    const run = projectedRun(target.provider, target.repoRoot, target.slug);
    if (!pipelineConsoleAllowed(console_, run?.halt ?? null)) {
      return {
        ok: false,
        status: 409,
        error: "the reseal ceremony answers a protected-artifact halt, and this run has no such halt",
      };
    }
  }
  const launch = PIPELINE_PROVIDERS[target.provider].consoleArgv(console_, target);
  // The provider's own refusal, carried out as a 400 rather than as an opened terminal that
  // prints one. It is a statement about the REQUEST - a reseal with no feature named - so it
  // belongs with the malformed body rather than with the missing repository above.
  if ("refused" in launch) return { ok: false, status: 400, error: launch.refused };
  return { ok: true, argv: launch.argv, cwd: launch.cwd };
}

/**
 * What to call the terminal a console opens in.
 *
 * A window title an operator can recognise among a dozen others, and - on a multiplexer
 * backend - a session name, which is why it is plain: the backend's own `NameRules` sanitize
 * it, and a name built from the two facts that tell two of these windows apart survives that
 * sanitization intact.
 */
export function pipelineConsoleName(
  provider: PipelineProviderId,
  console_: PipelineConsole,
  slug: string | null,
): string {
  return [provider, console_, slug].filter((part) => part !== null && part !== "").join(" ");
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
  /**
   * A pass put an engine's spend into the ledger; refresh the fleet's cost surfaces.
   *
   * The same call the headless-report route and the spend reporter make, and it belongs
   * here for the same reason: `recordPipelineUsage` writes a row that nothing on screen
   * is watching, so without this the spend chip carries the engine's figure only after
   * whatever unrelated event next recomputes - which for a fleet with no live session at
   * all is the idle sweep, minutes later. That is precisely the case this feature exists
   * for. It is `applyAutomationUsage` rather than the session sync because a pipeline's
   * note key is a ROLE, which no session can hold.
   */
  applyAutomationUsage(): void;
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
  ledgered.clear();
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
 * Put one finished feature's spend into the ledger, unless it is already the row there.
 *
 * The whole cost roll-in, and it is this small because the hard parts are decided elsewhere:
 * the provider reads the engine's own committed per-feature record rather than re-deriving
 * one, and `recordPipelineUsage` replaces the row rather than adding to it. So this is a
 * write nothing here has to make idempotent - it already is - guarded only against being
 * pointless.
 *
 * The guard compares the VALUES, not just the key, so an engine that rewrites a feature's
 * record after a repair is picked up on the next pass rather than held out by a cache.
 */
function recordFeatureSpend(
  provider: PipelineProviderId,
  featureKey: string,
  usage: PipelineFeatureUsage,
): boolean {
  const fingerprint = JSON.stringify(usage);
  if (ledgered.get(featureKey) === fingerprint) return false;
  try {
    recordPipelineUsage({
      role: PIPELINE_SPEND_ROLES[provider],
      writer: PIPELINE_SPEND_WRITERS[provider],
      featureKey,
      agent: provider,
      ts: usage.ts,
      costUsd: usage.costUsd,
      costKnown: usage.costKnown,
      input: usage.input,
      output: usage.output,
      reasoningOutput: usage.reasoningOutput,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    });
    ledgered.set(featureKey, fingerprint);
    return true;
  } catch (err) {
    // A ledger row is an accounting nicety beside a projection somebody is looking at, so a
    // failed write is logged and dropped rather than allowed to take the pass down with it.
    // Not marked as written, so the next pass tries again.
    console.warn(`[pipelines] could not record spend for ${featureKey}:`, err);
    return false;
  }
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
 * Drop every process-local trace of one run, at the moment the run itself is retired.
 *
 * One function rather than three deletes at each of the two retirement sites, because the
 * omission it prevents is the one that already happened: each of these maps is keyed by run
 * and each is bounded only by somebody remembering to prune it here. A daemon watching a
 * repository that ships and tears down worktrees all day retires runs continuously, so a map
 * that is only cleared on a full projection restore is a map that grows for the life of the
 * process - one entry per feature that ever existed, held to suppress an idempotent rewrite
 * no absent run can request.
 *
 * The projection and event rows are deleted by the caller. The spend row deliberately stays
 * in the retention-managed usage ledger; only the process-local suppression of its next
 * idempotent write goes away. Losing any state here costs at most one redundant read or one
 * idempotent write.
 */
function forgetRunState(provider: PipelineProviderId, repoRoot: string, slug: string): void {
  const key = pipelineRunKey(provider, repoRoot, slug);
  costTotals.delete(key);
  lastSweptAt.delete(key);
  ledgered.delete(key);
}

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
  // Consent is re-read after the read and before the first write, because the read is the
  // only await in this function and therefore the only place the operator can get a word in.
  // Everything below is durable and emitted - rows, ledger rows, a health line, an SSE upsert
  // - so a pass that started under consent and finished after it was withdrawn would put back
  // exactly what `forgetPipelineRepo` had just deleted, and the page would show a repository
  // the operator switched off.
  //
  // The third of three doors onto one window, and they close different halves: the drain
  // checks what it is about to START, `forgetPipelineRepo` clears what is QUEUED, and this
  // catches the pass that was already past both. A tick's pass is the case neither of the
  // others can see.
  if (!isPipelineRepoConsented(provider, repoRoot)) return;

  const seen = new Set<string>();
  let halted = 0;
  let spent = false;
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
    const accumulated =
      run.costTokens === null ? carried : (carried ?? 0) + run.costTokens;
    if (accumulated !== null) costTotals.set(key, accumulated);
    // The engine's own committed figure OUTRANKS the accumulation, once it has written one.
    // The accumulation is a running estimate assembled from a ledger read in pieces across
    // passes and daemon lifetimes; the record is the engine's arithmetic over the whole of
    // that ledger, done once, at the end. Preferring it is what makes a shipped feature's
    // token figure exact rather than approximately right, and it is the same figure the
    // spend ledger takes - so the run detail and the spend strip cannot disagree.
    const settled = reading.usage.get(run.slug);
    const total = settled
      ? settled.input + settled.output + settled.reasoningOutput + settled.cacheRead + settled.cacheWrite
      : accumulated;
    const projected: PipelineRun = { ...run, costTokens: total };
    // Durable first, then the notify - an SSE emission cannot be rolled back, and the
    // schedule catalog holds the same order for the same reason.
    const cursor = reading.cursors.get(run.slug);
    upsertPipelineRunRow({
      run: projected,
      eventsOffset: cursor?.offset ?? 0,
      eventsIdentity: cursor?.identity ?? "",
    });
    if (settled && recordFeatureSpend(provider, key, settled)) spent = true;
    sink.upsertPipelineRun(projected);
  }
  // Once per pass rather than once per feature: a repository that shipped four features
  // while the daemon was down would otherwise recompute the whole fleet's cost four times
  // over on the first sweep that reads them, for one figure.
  if (spent) sink.applyAutomationUsage();

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
      forgetRunState(provider, repoRoot, slug);
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
    forgetRunState(provider, repoRoot, slug);
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
