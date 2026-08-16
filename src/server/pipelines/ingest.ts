import { realpathSync } from "node:fs";

import {
  activePipelineRepos,
  pipelineRepoKey,
  pipelineRunKey,
  type PipelineIngestState,
  type PipelineProviderId,
} from "@shared/pipeline.ts";
import {
  ConductorIngestEnvelopeSchema,
  type ConductorIngestOutcome,
} from "@shared/protocol.ts";

import { envVar } from "../config.ts";
import { appendPipelineEvents, type PipelineEventInput } from "../db.ts";
import { getPipelinesConfig } from "./config.ts";
import { PIPELINE_PROVIDERS } from "./providers.ts";

// Pushed pipeline events: the ingest half of observation.
//
// Everything the file tail does, this does not do. The tail is the DURABLE reader - it
// resumes at a byte offset, it computes each run's token spend, and it is what makes the
// projection rebuildable from files at any moment. This module adds one thing to it: the
// engine can say that something happened, instead of Mission Control finding out on its next
// pass. That is a latency change and deliberately not an authority change.
//
// Three properties hold whatever arrives here, and each of them is a decision rather than a
// safeguard:
//
//  - **Consent is upstream of it.** A push naming a repository nobody switched on is counted
//    and dropped. Ingest is not a second door into observing somebody's checkout.
//  - **It can only address runs that exist.** A slug is not a name this route takes on the
//    producer's word; it has to be one the provider is actually driving. What is at stake is
//    retention rather than authenticity: the ledger is bounded by pairing its rows with the
//    runs a pass enumerates, so a row under a slug no pass can produce is a row nothing ever
//    retires, and posting those is free.
//  - **Nothing is derived from a pushed event.** The ledger stores it; the projection is
//    still folded from the engine's own files by `normalizeConductorRun`. So an event that
//    arrives twice, out of order, or in a shape this build has never seen costs a row and
//    changes no number. That is what lets the envelope be tolerant enough to survive a
//    conductor release nobody here has read.
//  - **It ships dormant.** ai-conductor does not start registered visualizer plugins yet
//    (the companion phase in that repository wires it), so on every machine today this
//    module's state is "never seen" and the tail carries observation exactly as it did
//    before. Nothing about the tail's correctness is conditional on that changing.

/**
 * How long after a push a worktree still counts as live.
 *
 * The one tunable that decides whether the tail demotes, so it is set from what the producer
 * does rather than from what feels responsive: conductor emits at step boundaries, and a long
 * step - a build, a test suite - can run for many minutes without a single event. A window
 * shorter than that would have every long step read as "the plugin stopped", flap the health
 * line, and put the tail back on its fast cadence for exactly the runs that need it least.
 *
 * Being wrong in the generous direction costs a slower tail read for one worktree, which the
 * backfill sweep bounds anyway. Being wrong in the strict direction costs nothing but noise -
 * which is why this is not a correctness parameter at all.
 */
const INGEST_LIVE_MS = Math.max(1000, Number(envVar("PIPELINE_INGEST_LIVE_MS") ?? 600_000));

/** How many lines one POST may carry. A batch past this is truncated, not refused. */
export const MAX_INGEST_LINES = 2000;

/** How many bytes one POST may carry, before it is refused with a 413. */
export const MAX_INGEST_BYTES = 4 * 1024 * 1024;

/**
 * When each run last had an event pushed for it, per repository then per slug.
 *
 * Nested rather than keyed by the composite run key, because withdrawing consent has to drop
 * a whole repository's liveness in one act - and reaching that through a prefix scan of a
 * flat map is the kind of thing that works until a repository is named as a prefix of
 * another one.
 *
 * Process-local and never persisted, for `statuses`' reason in `./index.ts` and one more:
 * this is a claim about what is happening NOW. A daemon that came up thirty seconds ago has
 * not been pushed anything, and restoring a "live" flag from before a restart would tell the
 * tail to stand down over evidence from a process that no longer exists.
 */
const lastIngestAt = new Map<string, Map<string, number>>();

/**
 * Repositories that have EVER had an event pushed, and when they last did.
 *
 * Kept separately from the per-run map rather than derived from it, because the two answer
 * different questions and one of them outlives its runs: a repository whose only pipeline
 * finished still installed the plugin, and the health line saying so is the difference
 * between "your plugin is not delivering" and "nothing has happened lately".
 */
const lastIngestAtRepo = new Map<string, number>();

/** Forget every liveness observation. The boot path calls it; so does a test. */
export function resetPipelineIngest(): void {
  lastIngestAt.clear();
  lastIngestAtRepo.clear();
}

/** Whether pushes are currently carrying this run, so its tail may relax. */
export function isPipelineIngestLive(
  provider: PipelineProviderId,
  repoRoot: string,
  slug: string,
  now = Date.now(),
): boolean {
  const seen = lastIngestAt.get(pipelineRepoKey(provider, repoRoot))?.get(slug);
  return seen !== undefined && now - seen < INGEST_LIVE_MS;
}

/**
 * How observation is arriving for one repository, for the Settings health line.
 *
 * Three states because three things are true at different times and an operator installing
 * the plugin needs to tell them apart: it has never delivered here, it is delivering, or it
 * delivered once and has gone quiet. The last one is the interesting one - it is what a
 * misconfigured token or a crashed engine looks like from this side, and collapsing it into
 * "never" would hide the fact that the install works at all.
 */
export function pipelineIngestState(
  provider: PipelineProviderId,
  repoRoot: string,
  now = Date.now(),
): PipelineIngestState {
  const seen = lastIngestAtRepo.get(pipelineRepoKey(provider, repoRoot));
  if (seen === undefined) return "never";
  return now - seen < INGEST_LIVE_MS ? "live" : "quiet";
}

/** Drop a repository's liveness - its consent was withdrawn. */
export function forgetPipelineIngest(provider: PipelineProviderId, repoRoot: string): void {
  const key = pipelineRepoKey(provider, repoRoot);
  lastIngestAtRepo.delete(key);
  lastIngestAt.delete(key);
}

/** One run a batch touched, so the caller can refresh exactly those. */
export interface PipelineIngestTouch {
  provider: PipelineProviderId;
  repoRoot: string;
  slug: string;
}

/** What one batch did, plus which runs it moved. */
export interface PipelineIngestResult {
  counts: ConductorIngestOutcome;
  touched: PipelineIngestTouch[];
}

/**
 * The consented repositories this daemon will accept a push for, indexed by resolved path.
 *
 * Resolved through symlinks on BOTH sides, because the two sides learned the path from
 * different places: Mission Control stored a git root it resolved itself, and the engine
 * knows the directory it was pointed at. On macOS `/tmp` alone is enough to make those two
 * spellings of one checkout, and a plain string compare would silently drop every event from
 * an installation that was working perfectly.
 *
 * A path that cannot be resolved is kept as written rather than dropped: an unreadable
 * consented root is a strange state, but refusing to match it would be a worse answer than
 * matching it exactly.
 */
function consentedByPath(): Map<string, { provider: PipelineProviderId; repoRoot: string }> {
  const out = new Map<string, { provider: PipelineProviderId; repoRoot: string }>();
  for (const repo of activePipelineRepos(getPipelinesConfig())) {
    out.set(resolved(repo.repoRoot), { provider: repo.provider, repoRoot: repo.repoRoot });
  }
  return out;
}

/** `realpath`, or the path as written when it cannot be resolved. Never throws. */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * How many malformed batches have been complained about, so a broken producer cannot fill
 * the log. One warning, then silence - the counts in the response body are the honest
 * channel, and they are per request rather than per process.
 */
let warnedMalformed = 0;

/** How many bounded warnings this process will print about malformed ingest. */
const MAX_MALFORMED_WARNINGS = 3;

/**
 * Take one NDJSON batch, store what is new, and say which runs moved.
 *
 * Line-oriented and line-tolerant: a batch is a stream of independent observations, so one
 * unparseable line is dropped and counted while every other line in the same POST lands.
 * Failing the whole batch would mean a single event this build cannot read costs an
 * operator every event that shared its flush - and the producer, whose posture is to swallow
 * transport failures, would never find out.
 */
export function ingestConductorEvents(body: string, now = Date.now()): PipelineIngestResult {
  const counts: ConductorIngestOutcome = {
    received: 0,
    stored: 0,
    duplicate: 0,
    malformed: 0,
    unconsented: 0,
  };
  const consented = consentedByPath();
  /**
   * Each consented repository's real run slugs, read at most once for the whole batch.
   *
   * Memoised because the alternative is a directory listing per LINE, and a batch is a
   * flush: one step boundary is several events for one run. Reading it once per POST also
   * makes a batch internally consistent, which a per-line read would not be.
   */
  const runSlugs = new Map<string, ReadonlySet<string> | null>();
  /** Whether this slug names a run the provider is actually driving. */
  const addressable = (
    provider: PipelineProviderId,
    repoRoot: string,
    slug: string,
  ): boolean => {
    const repoKey = pipelineRepoKey(provider, repoRoot);
    if (!runSlugs.has(repoKey)) {
      runSlugs.set(repoKey, PIPELINE_PROVIDERS[provider].knownRunSlugs(repoRoot));
    }
    // `null` is "could not look", and on a door that refuses. `?? false` is carrying that
    // decision, not defending against a missing key.
    return runSlugs.get(repoKey)?.has(slug) ?? false;
  };
  /** Envelopes grouped per run, in arrival order, so one run is one ledger transaction. */
  const byRun = new Map<
    string,
    { touch: PipelineIngestTouch; events: PipelineEventInput[] }
  >();

  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    counts.received += 1;
    // The cap is on RECORDS rather than on lines read, and it counts blank lines out, so a
    // pretty-printed batch is not silently halved. Past it, the rest of the batch is
    // dropped and counted as malformed - the producer is over its contract, and the file
    // tail is what makes that recoverable rather than lossy.
    if (counts.received > MAX_INGEST_LINES) {
      counts.malformed += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      counts.malformed += 1;
      continue;
    }
    const envelope = ConductorIngestEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      counts.malformed += 1;
      continue;
    }
    const match = consented.get(resolved(envelope.data.repo));
    if (!match) {
      counts.unconsented += 1;
      continue;
    }
    // Counted as malformed rather than given a state of its own. The envelope is well
    // formed and the repository is consented, so this is not `unconsented`; and from the
    // producer's side it is the same class of mistake as a bad line - it addressed something
    // that is not there. A separate counter would be a new field in a frozen wire contract,
    // bought for a case a correct plugin cannot reach.
    if (!addressable(match.provider, match.repoRoot, envelope.data.slug)) {
      counts.malformed += 1;
      continue;
    }
    const key = pipelineRunKey(match.provider, match.repoRoot, envelope.data.slug);
    let group = byRun.get(key);
    if (!group) {
      group = {
        touch: { provider: match.provider, repoRoot: match.repoRoot, slug: envelope.data.slug },
        events: [],
      };
      byRun.set(key, group);
    }
    const event = envelope.data.event;
    group.events.push({
      // `type`, not `kind` - the engine's own discriminant name. A record that carries none
      // is stored under `unknown` rather than refused: this build keeps no copy of the
      // engine's event union, so "a kind we do not know" is not a state it can be in.
      kind: typeof event.type === "string" ? event.type : null,
      ts: typeof event.ts === "string" ? event.ts : null,
      producerSeq: envelope.data.seq,
      body: event,
    });
  }

  for (const { touch, events } of byRun.values()) {
    const stored = appendPipelineEvents(
      touch.provider,
      touch.repoRoot,
      touch.slug,
      "ingest",
      events,
      now,
    );
    counts.stored += stored;
    counts.duplicate += events.length - stored;
    // Liveness is stamped for every ACCEPTED event, duplicates included. A plugin re-sending
    // a batch the tail already backfilled is still a plugin that is running and delivering,
    // and reading that as quiet would demote it for being redundant.
    const repoKey = pipelineRepoKey(touch.provider, touch.repoRoot);
    const perSlug = lastIngestAt.get(repoKey) ?? new Map<string, number>();
    perSlug.set(touch.slug, now);
    lastIngestAt.set(repoKey, perSlug);
    lastIngestAtRepo.set(repoKey, now);
  }

  if (counts.malformed > 0 && warnedMalformed < MAX_MALFORMED_WARNINGS) {
    warnedMalformed += 1;
    console.warn(
      `[pipelines] dropped ${counts.malformed} malformed ingest line(s); the file tail still` +
        ` covers those events` +
        (warnedMalformed === MAX_MALFORMED_WARNINGS ? " (further warnings suppressed)" : ""),
    );
  }

  return { counts, touched: [...byRun.values()].map((group) => group.touch) };
}
