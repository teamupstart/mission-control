import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

// The Mission Control visualizer for ai-conductor.
//
// It runs inside somebody else's process, on somebody else's release train, with no
// supervision - so every decision in this file is made from the same premise: **the engine
// must not be able to tell this is here.** Not slower, not noisier, not more fragile. It
// forwards events to a local daemon that already knows how to read conductor's files
// without it, so there is never a reason to take a risk with the run to deliver one.
//
// Concretely, and each of these is a rule rather than a preference:
//
//  - **Handlers are synchronous and O(1).** `ConductorEventEmitter.emit()` AWAITS anything a
//    handler returns, so a handler that did I/O would put this plugin's network latency on
//    the engine's own critical path. Every handler here appends to an array and returns.
//  - **Nothing throws.** The emitter swallows handler errors, so a throw would be invisible
//    here and free elsewhere - which is worse than useless. Failures are counted and warned
//    about once EACH KIND: one budget across every category would let the first triviality
//    that went wrong silence the refused token that came after it.
//  - **The buffer is bounded.** A daemon that is not running must cost a bounded amount of
//    memory in a process that may run for days, so the buffer drops its oldest entries and
//    says so once.
//  - **A failed delivery is RETRIED, not discarded.** This is the one place the "best-effort
//    is safe because the tail backfills it" argument does not hold, so it is worth being
//    exact about where it stops. Conductor persists 76 of its 104 event kinds to
//    `events.jsonl`; `build_review_reduced_coverage_accepted`, `gate_verdict`,
//    `halt_cleared`, `pipeline_closeout` and the rest of the unpersisted set have no file-tail
//    recovery path. For those, this plugin is the only Mission Control record there is, and a
//    batch dropped because the daemon was restarting is gone for good. So a failed batch goes
//    back to the front of the queue and is retried with backoff; what is still bounded is the
//    BUFFER, not the attempt.
//  - **Except at shutdown, which is where that stops.** `stop()` runs its drain under a
//    deadline, and a deadline that expires has nowhere to put the batch: conductor is
//    exiting, this plugin writes nothing to disk, and there is no next attempt. Those events
//    are lost, and for the unpersisted kinds they are lost outright. That boundary is bought
//    knowingly - the alternative is holding the engine's exit open on a daemon that may never
//    answer - and it is stated in the README rather than left for a reader to find here.
//
// For everything the engine does write down, delivery remains best-effort in the way that
// argument does cover: an event this never delivers - because the buffer ceiling dropped it,
// because a conductor release added a kind nobody here subscribed to - is picked up by
// Mission Control's independent tail of `.pipeline/events.jsonl`. What that buys is LATENCY,
// not coverage.

/** Where the daemon listens, unless told otherwise. */
const DEFAULT_URL = "http://127.0.0.1:7317";

/** How long a batch waits for company before it is sent. */
const FLUSH_MS = 250;

/** How many events one POST carries. Mission Control refuses a batch past 2000 lines. */
const MAX_BATCH = 500;

/**
 * How many events may wait for a daemon that is not answering.
 *
 * A ceiling rather than a policy: conductor's daemon runs for days, and an operator who
 * stopped Mission Control should not find the engine's memory growing because of it. The
 * OLDEST are dropped, because the newest are the ones still worth having - the tail will
 * backfill everything either way.
 */
const MAX_BUFFER = 5000;

/** How many times this process will complain about each KIND of failure. See `warnOnce`. */
const MAX_WARNINGS = 1;

/**
 * The longest a retry will wait after repeated failures.
 *
 * A failed delivery is retried rather than discarded, so the interval has to back off or a
 * daemon that is down becomes four POSTs a second for the life of the run - inside the
 * engine's process, on its event loop. Thirty seconds is short enough that a daemon coming
 * back is noticed promptly and long enough to be free when it does not.
 */
const MAX_RETRY_MS = 30_000;

/**
 * The longest `stop()` will spend trying to deliver before it gives up and returns.
 *
 * A daemon that accepts the connection and then never answers leaves `fetch` pending for
 * ever, and `stop()` is called on conductor's shutdown path - so an unbounded await here is
 * this plugin holding the ENGINE open, which is the one thing it is not allowed to do.
 *
 * What expiry costs is worth being exact about, because it is the plugin's only real loss.
 * The in-flight request is aborted and its batch is requeued, which inside the deadline means
 * another attempt - and past the deadline means nothing at all. `stop()` returns to a
 * conductor that is exiting, and a buffer this process never wrote down dies with it. For
 * everything conductor persists the file tail still has it; for the 28 kinds it does not, the
 * events are gone. Two seconds is the price of the engine's exit not being ours to hold.
 */
const SHUTDOWN_MS = 2_000;

/**
 * How long the shutdown drain waits after an attempt that changed nothing.
 *
 * The drain is bounded by `SHUTDOWN_MS` and by nothing else, so an attempt that made no
 * progress must not END it - a daemon being restarted refuses instantly, and giving up on the
 * first refusal spends none of a budget that was allocated precisely for this. It must not
 * spin on it either: a refused connection returns in microseconds, so an immediate retry is
 * thousands of attempts and a busy core on the engine's exit path.
 *
 * So: pause, and grow the pause each time, which fits several honest attempts into two seconds
 * while leaving the loop cheap. Deliberately much shorter than `MAX_RETRY_MS`, because that
 * backoff is tuned for a plugin that may retry for hours and this one has two seconds in total.
 */
const SHUTDOWN_RETRY_MS = 50;

/**
 * The event kinds this build forwards, frozen at ai-conductor 0.104.0 (`1631544a`).
 *
 * Enumerated because conductor's bus has no wildcard: `.on()` takes one type. So this list
 * is what a copy of this directory knows about, for ever, and a conductor release that adds
 * a kind emits something no installed plugin asked for.
 *
 * For a kind conductor PERSISTS that is a designed-for case and not a gap: the unsubscribed
 * event still reaches `events.jsonl`, and Mission Control's backfill sweep reads it - which is
 * precisely why the file tail is never switched off, only slowed down. For a new kind it does
 * not persist, nothing observes it at all until this list is regenerated, because there is no
 * file for the sweep to find it in. Re-copying the directory after a conductor upgrade is what
 * closes both windows, and only the second one is a loss.
 */
export const FORWARDED_EVENT_TYPES = Object.freeze([
  "acceptance_red",
  "attribution_divergence",
  "auto_heal",
  "auto_park",
  "auto_park_contradiction",
  "build_member_evidence_recomputed",
  "build_member_evidence_reused",
  "build_no_progress",
  "build_progress",
  "build_review_base",
  "build_review_cache_hit",
  "build_review_disposition_accepted",
  "build_review_disposition_refused",
  "build_review_disposition_version_invalidated",
  "build_review_mechanical_allowance_exhausted",
  "build_review_outer_verdict",
  "build_review_reduced_coverage_accepted",
  "build_review_repair_context",
  "build_review_rubric_infrastructure_failure",
  "build_review_rubric_prompt",
  "build_review_rubric_result",
  "build_review_rubric_skipped",
  "build_review_rubric_started",
  "build_review_stale_aggregate",
  "build_review_stale_mirage_regrade",
  "build_stall",
  "checkpoint_reached",
  "ci_failed",
  "config_deprecated_key",
  "config_skip",
  "contained_live_checkout_drift",
  "containment_check_unresolved",
  "credentials_park",
  "credentials_park_progress",
  "dashboard_refresh",
  "deprecated_step",
  "feature_complete",
  "feature_usage_total",
  "finish_publication_blocked",
  "finish_publication_disposition",
  "finish_publication_transition",
  "gate_blocked",
  "gate_verdict",
  "group_member_step",
  "halt_cleared",
  "halt_marker_write_failed",
  "halt_record_push_failed",
  "halt_record_write_failed",
  "halt_record_written",
  "kickback",
  "loop_converged",
  "loop_halt",
  "mode_skip",
  "navigation_back",
  "operator_park_boundary",
  "operator_rewind",
  "over_scope_decision",
  "parallel_completed",
  "parallel_failure",
  "parallel_started",
  "pipeline_closeout",
  "plan_growth",
  "protected_artifact_rebaseline",
  "protected_artifact_rebaseline_refused",
  "protected_artifact_reseal",
  "protected_artifact_reseal_refused",
  "provider_attempt",
  "provider_fallback",
  "provider_stream_progress",
  "rate_limit",
  "rebase_changed",
  "rebase_citation_residue",
  "rebase_conflict_halt",
  "rebase_gate_invalidated",
  "rebase_gate_preserved",
  "rebase_gate_reverified",
  "rebase_mergeable_skip",
  "rebase_noop",
  "rebase_resolution_attempt",
  "rebase_resolution_exhausted",
  "rebase_resolution_failed",
  "rebase_resolution_succeeded",
  "recovery_needed",
  "remediation_sealed_artifact_redirect",
  "renderer_error",
  "retry_decision",
  "scratch_cleanup_failed",
  "scratch_cleanup_reclaimed",
  "scratch_cleanup_retained",
  "self_host_containment_verdict",
  "session_policy",
  "session_reset",
  "step_completed",
  "step_failed",
  "step_refused",
  "step_retry",
  "step_started",
  "test_suite_verification",
  "tier_skip",
  "unattributed_dispatch",
  "unattributed_progress",
  "verdict_freshness",
  "when_skip",
  "zero_work_product",
]);

/** The directory conductor keeps a repository's feature worktrees in. */
const WORKTREES_DIR = ".worktrees";

/**
 * The daemon's shared secret, read from its own state directory.
 *
 * Read from disk rather than required as configuration, because on the usual setup - one
 * machine, one operator, conductor and Mission Control both running as them - there is
 * nothing to copy and therefore nothing to copy wrongly, and no secret anywhere near a file
 * that could be committed. `MISSION_CONTROL_TOKEN` is for the cases where that premise does
 * not hold: another user, another machine, a container.
 *
 * The directory names are the daemon's own resolution order, oldest name last, so a
 * long-lived installation that predates a rename is still found.
 */
function readToken() {
  const explicit = process.env.MISSION_CONTROL_TOKEN;
  if (explicit) return explicit.trim();
  for (const dir of [".mission-control", ".fleet", ".harness"]) {
    try {
      const token = readFileSync(join(homedir(), dir, "token"), "utf8").trim();
      if (token) return token;
    } catch {
      // Not there, or not readable by this user. Try the next name.
    }
  }
  return "";
}

/**
 * Which run an event belongs to, resolved from the process rather than from the event.
 *
 * The awkward part of this contract, and it is conductor's shape rather than an oversight:
 * `VisualizerPlugin.start(emitter)` is handed an emitter and nothing else, and a
 * `ConductorEvent` carries no repository, worktree or feature on it. The built-in OTel
 * visualizer sidesteps this by being constructed inline in `index.ts` with the run's
 * identity in hand - a discovered plugin, started generically, has no such constructor call.
 *
 * So identity is resolved in this order, most explicit first:
 *
 *  1. `MISSION_CONTROL_WORKTREE` - pins one run. What a per-feature wiring should set.
 *  2. A `.worktrees/<slug>` ancestor of the working directory - true whenever conductor was
 *     started inside the worktree it is driving, which is the interactive shape.
 *  3. `MISSION_CONTROL_REPO` plus a slug the event itself names. Several event kinds carry
 *     `slug`, `featureSlug` or `feature`; those are addressable in a daemon that drives many
 *     features at once, and the rest are not.
 *
 * When none of them answers, the plugin forwards NOTHING and says so once. An envelope with
 * a guessed repository would be worse than silence: Mission Control drops events for
 * repositories nobody consented to, so a wrong guess is not a security hole - it is just a
 * plugin that appears installed and delivers nothing, with no way to tell why.
 *
 * See `createMissionControlVisualizer` for the seam that removes the guessing entirely.
 */
export function resolveRun(env, cwd, event) {
  const pinned = env.MISSION_CONTROL_WORKTREE;
  if (pinned) return fromWorktree(pinned);

  const walked = worktreeAbove(cwd);
  if (walked) return walked;

  const repo = env.MISSION_CONTROL_REPO;
  const slug = slugOf(event);
  if (repo && slug) {
    return { repo, worktree: join(repo, WORKTREES_DIR, slug), slug };
  }
  return null;
}

/** The feature a slug-carrying event names, or null. Three spellings, all conductor's. */
function slugOf(event) {
  if (!event || typeof event !== "object") return null;
  for (const key of ["slug", "featureSlug", "feature"]) {
    const value = event[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/** Split `<repo>/.worktrees/<slug>` into its parts, or null if that is not its shape. */
function fromWorktree(worktree) {
  const slug = basename(worktree);
  const parent = dirname(worktree);
  if (slug === "" || basename(parent) !== WORKTREES_DIR) return null;
  return { repo: dirname(parent), worktree, slug };
}

/** The nearest `.worktrees/<slug>` at or above `cwd`, or null. */
function worktreeAbove(cwd) {
  let at = cwd;
  for (;;) {
    const found = fromWorktree(at);
    if (found) return found;
    const up = dirname(at);
    // `dirname` of a filesystem root is itself, which is the only termination there is.
    if (up === at || !at.includes(sep)) return null;
    at = up;
  }
}

/**
 * Build a visualizer.
 *
 * Exported alongside the default instance because the default one has to GUESS which run an
 * event belongs to (see `resolveRun`), and a wiring that knows should not have to. A
 * conductor entrypoint that starts a visualizer per feature-scoped bus already holds the
 * worktree path - `startFeatureEventPersistence` is handed it - and passing it here removes
 * the guess:
 *
 *     import { createMissionControlVisualizer } from '.../mission-control/index.mjs';
 *     const v = createMissionControlVisualizer({ worktree: worktree.path });
 *     v.start(featureEvents);
 *
 * `fetchImpl` and `now` are injected for the tests, which run in Mission Control's own suite
 * against a stub emitter - so the batching and the failure posture are asserted rather than
 * asserted-about.
 */
export function createMissionControlVisualizer(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.warn ?? ((message) => console.warn(message));
  const url = (options.url ?? env.MISSION_CONTROL_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  const pinned = options.worktree ? fromWorktree(options.worktree) : null;

  /**
   * The token, read on first use rather than at construction.
   *
   * The default instance is constructed when conductor IMPORTS this file, which on a fresh
   * machine can be before Mission Control has ever run and therefore before it has minted a
   * token. Reading eagerly would cache the empty string for the life of the process and turn
   * a temporary absence into a permanent 401.
   */
  let token = options.token ?? null;
  /**
   * Whether a delivery has contradicted the cached token, so the next attempt reads it again.
   *
   * The absent-at-startup case above is only half of it. A token that WAS right can stop
   * being right: conductor's process outlives a Mission Control restart, and a daemon that
   * comes up on a fresh state directory - a restored machine, a cleared `~/.mission-control`,
   * an operator rotating the secret - mints a new one. Nothing tells this plugin, and the
   * retry loop is built to survive exactly that kind of outage, so without re-reading it
   * would retry a request that cannot succeed until the buffer ceiling started dropping
   * events. The events inside that buffer include the kinds conductor never writes to a file,
   * which is the one loss nothing else can make good.
   */
  let stale = false;
  const tokenNow = () => {
    // An explicitly supplied token is the caller's to manage, and never re-read: a wiring
    // that passed one has a source for it that this file knows nothing about.
    if (options.token) return options.token;
    if (token === null || token === "" || stale) {
      token = readToken();
      stale = false;
    }
    return token;
  };

  /** Envelopes waiting to be sent. */
  let buffer = [];
  /** The producer's own ordering coordinate, per run. Never a key on the daemon's side. */
  const seqs = new Map();
  let timer = null;
  let emitter = null;
  let handlers = [];
  /** How many warnings each KIND of failure has spent. See `warnOnce`. */
  const warned = new Map();
  let dropped = 0;
  let inFlight = null;
  /** Aborts the open request, so a hung daemon cannot hold conductor's shutdown. */
  let inFlightAbort = null;
  let stopped = false;
  /** Consecutive failed deliveries, for the retry backoff. Reset by any success. */
  let failures = 0;
  /**
   * How many events this instance currently puts in one POST.
   *
   * Starts at `MAX_BATCH` and halves whenever the daemon answers 413, so a run whose
   * events are unusually large converges on a size that fits instead of losing them.
   * Restored on the next success: the oversize is a property of those events, not of
   * the connection, so it must not slow delivery for the rest of the run.
   */
  let sendLimit = MAX_BATCH;

  /** A promise that settles after `ms`, without keeping conductor's loop alive for it. */
  const sleep = (ms) =>
    new Promise((resolve) => {
      const handle = setTimeout(resolve, ms);
      if (typeof handle?.unref === "function") handle.unref();
    });

  /**
   * Await `promise`, but for no longer than `ms`, aborting the open request if it expires.
   *
   * The abort is what makes the deadline real: without it the socket stays open and the
   * pending `fetch` keeps a handle on conductor's loop even after `stop()` has returned. The
   * aborted request rejects, which lands in `flush`'s catch and requeues its batch, so the
   * retry policy still owns those events.
   */
  const settleWithin = async (promise, ms) => {
    // Absorbed ONCE, up front, and everything below waits on the absorbed copy. `stop()` is
    // conductor's shutdown path: a rejection escaping this function fails the engine's exit,
    // and it would do so precisely when the bounded path was needed. The rejection that could
    // do it is the one this function causes - the abort below - so it must not be possible to
    // reach a `race` or a `return` with the raw promise still unhandled. An already-expired
    // budget is the case that makes this concrete: the abort fires before the race is even
    // entered, and the rejection can win it.
    const settled = promise.catch(() => {});
    if (ms <= 0) {
      inFlightAbort?.abort?.();
      await settled;
      return;
    }
    let expired = false;
    await Promise.race([
      settled,
      sleep(ms).then(() => {
        expired = true;
      }),
    ]);
    if (!expired) return;
    inFlightAbort?.abort?.();
    // Let the abort propagate through the catch that requeues, so the batch is not left
    // owned by a request nobody is waiting for.
    await settled;
  };

  /**
   * Complain at most `MAX_WARNINGS` times about each KIND of thing that can go wrong.
   *
   * Per kind rather than per instance, and the difference is the whole value of the budget.
   * One counter across every category means the first thing that ever goes wrong spends it:
   * a working directory outside a worktree at startup, or one dropped-buffer warning during
   * a burst, and the operator has now been told everything this plugin will ever tell them -
   * including, later, that their token is being refused on every retry. Those are not the
   * same news, and a budget that cannot tell them apart is a budget that silences the
   * important one on the strength of the trivial one.
   *
   * Still one line per kind, for the reason the cap exists at all: this runs inside somebody
   * else's process, and a plugin that can narrate a failing daemon into their log for hours
   * is a plugin that has made itself the problem. The kinds are enumerated at the call sites
   * and there are six of them, so the ceiling is six lines for the life of the process.
   */
  const warnOnce = (kind, message) => {
    const spent = warned.get(kind) ?? 0;
    if (spent >= MAX_WARNINGS) return;
    warned.set(kind, spent + 1);
    log(`[mission-control] ${message} (further ${kind} warnings suppressed)`);
  };

  const enqueue = (event) => {
    const run = pinned ?? resolveRun(env, cwd, event);
    if (!run) {
      warnOnce(
        "identity",
        "could not tell which conductor worktree these events belong to, so none are being " +
          "forwarded; set MISSION_CONTROL_WORKTREE, or MISSION_CONTROL_REPO. Mission " +
          "Control still reads the engine's files, so everything conductor writes down is " +
          "delayed rather than lost - but the kinds it does not write down are not observed " +
          "at all until this is set",
      );
      return;
    }
    const seq = (seqs.get(run.worktree) ?? 0) + 1;
    seqs.set(run.worktree, seq);
    buffer.push({
      repo: run.repo,
      worktree: run.worktree,
      slug: run.slug,
      seq,
      event,
    });
    if (buffer.length > MAX_BUFFER) {
      // Oldest first. The newest events are the ones still worth having, and the file tail
      // backfills the rest whatever this drops.
      dropped += buffer.length - MAX_BUFFER;
      buffer = buffer.slice(-MAX_BUFFER);
      warnOnce(
        "buffer",
        `dropped ${dropped} buffered event(s) - is the Mission Control daemon running at ${url}?`,
      );
    }
    schedule();
  };

  const schedule = () => {
    if (timer !== null || stopped) return;
    // Backoff applies only after a failed delivery. Without it a daemon that is down turns
    // this into four POSTs a second, for the life of the run, from inside the engine's
    // process - and the events are being retried precisely because nothing is listening.
    const delay = failures === 0 ? FLUSH_MS : Math.min(FLUSH_MS * 2 ** failures, MAX_RETRY_MS);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
    // Never a reason for this plugin to keep conductor's process alive one millisecond
    // longer than the run needs. A pending flush is not work anybody is waiting for.
    if (typeof timer?.unref === "function") timer.unref();
  };

  /**
   * Put a failed batch back at the FRONT of the queue, and count the failure.
   *
   * At the front because these events are older than anything that arrived while the request
   * was open, and the daemon stamps arrival order. Re-capped immediately afterwards, so
   * retrying cannot be a way for the buffer to grow past its ceiling - a daemon that stays
   * down still costs a bounded amount of memory, it just spends it on the oldest events
   * instead of discarding them at the door.
   *
   * This matters more than a retry usually would. Conductor persists 76 of its 104 event
   * kinds to `events.jsonl`; for the other 28 - reduced-coverage acceptances, gate verdicts,
   * halt clears, closeouts - a delivery this plugin gives up on has no file-tail recovery.
   */
  const requeue = (batch) => {
    failures += 1;
    buffer = batch.concat(buffer);
    if (buffer.length > MAX_BUFFER) {
      dropped += buffer.length - MAX_BUFFER;
      // Trimmed from the TAIL here, where `enqueue` trims from the head, and the asymmetry
      // is the whole point rather than an inconsistency. `enqueue` drops the oldest because
      // the newest events are the ones still worth having. On this path the oldest events
      // ARE the batch just put back - so the same rule would let a delivery failure destroy
      // exactly the events that failed to deliver, which is the loss this function exists to
      // prevent. A batch is at most 500 and the ceiling is 5000, so what is dropped is
      // always queued events and never the batch itself.
      buffer = buffer.slice(0, MAX_BUFFER);
      warnOnce(
        "buffer",
        `dropped ${dropped} buffered event(s) - is the Mission Control daemon running at ${url}?`,
      );
    }
  };

  /**
   * Send what is buffered, at most one request at a time.
   *
   * Serialized because the daemon assigns each event an ordinal as it arrives, and two
   * overlapping POSTs would interleave one run's history for no gain - there is exactly one
   * consumer and it is on the loopback interface.
   */
  const flush = async () => {
    if (inFlight) return inFlight;
    if (buffer.length === 0) return;
    const batch = buffer.slice(0, sendLimit);
    // Held out of the buffer only while the request is open, so events arriving meanwhile
    // queue behind it and order is preserved. A failure puts it back; see `requeue`.
    buffer = buffer.slice(batch.length);
    const body = `${batch.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    // A handle on this request, so `stop()` can end one the daemon never answers. Guarded
    // because this file runs under whatever runtime conductor was started with.
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    inFlightAbort = controller;
    inFlight = (async () => {
      try {
        const res = await fetchImpl(`${url}/ingest/conductor`, {
          method: "POST",
          headers: {
            "content-type": "application/x-ndjson",
            "x-harness-token": tokenNow(),
          },
          body,
          signal: controller?.signal,
        });
        if (res.ok) {
          failures = 0;
          sendLimit = MAX_BATCH;
          return;
        }
        // Too large. The events are kept and the BATCH is made smaller - retrying the same
        // bytes unchanged would park an undeliverable request at the head of the queue for
        // ever, and discarding them would lose the unpersisted kinds outright. Halving the
        // send size converges in at most log2(MAX_BATCH) attempts, and `sendLimit` is
        // restored on the next success so one oversized burst does not slow delivery for the
        // rest of the run.
        if (res.status === 413) {
          if (batch.length > 1) {
            sendLimit = Math.max(1, Math.floor(batch.length / 2));
            requeue(batch);
            warnOnce(
              "oversize",
              `Mission Control refused a ${batch.length}-event batch as too large (413); ` +
                `retrying in smaller batches`,
            );
            return;
          }
          // A single event over the daemon's 4 MB ceiling. No batch size can carry it, so
          // this is the one case where an event is genuinely undeliverable - counted and
          // named rather than retried for ever at the head of the queue.
          dropped += 1;
          warnOnce(
            "oversize",
            `Mission Control refused a single ${body.length}-byte event as too large (413); ` +
              `it cannot be delivered at any batch size and has been dropped`,
          );
          failures = 0;
          return;
        }
        // A 401 is the one refusal a DIFFERENT token can fix, so the cached one is dropped
        // here and the next attempt reads it from disk again. Without this the retry is a
        // loop over a request that cannot succeed - the events survive the failure and then
        // die of the buffer ceiling instead, which for the unpersisted kinds is the same
        // outcome as discarding them at the door.
        if (res.status === 401) stale = true;
        // Everything else is worth retrying too: a daemon that is down, restarting, or
        // answering 5xx says nothing about the token, and the events that were buffered
        // meanwhile still arrive when it comes back.
        requeue(batch);
        // Named rather than generic, because the two failures an operator can actually fix
        // look nothing alike from here and the message is the only diagnosis they get.
        warnOnce(
          res.status === 401 ? "token" : "refused",
          res.status === 401
            ? `Mission Control refused this plugin's token (401). Set MISSION_CONTROL_TOKEN, ` +
                `or check that ~/.mission-control/token is readable by the user conductor runs as`
            : `Mission Control answered ${res.status} at ${url}/ingest/conductor`,
        );
      } catch (err) {
        requeue(batch);
        warnOnce(
          "transport",
          `could not reach Mission Control at ${url} (${err instanceof Error ? err.message : String(err)}); ` +
            `these events are being retried. Most of them are also in the engine's own ` +
            `events.jsonl, but the daemon-scope ones are not written anywhere else`,
        );
      } finally {
        inFlight = null;
        inFlightAbort = null;
      }
    })();
    await inFlight;
    // Whatever arrived while that request was open. Bounded by the buffer ceiling, so this
    // cannot recurse without end.
    if (buffer.length > 0 && !stopped) schedule();
  };

  return {
    name: "mission-control",

    /**
     * Subscribe, per event type, because the bus has no wildcard.
     *
     * Every handler is the same closure so `stop()` can take them all off again - a
     * visualizer that stayed subscribed after being stopped would keep a dead run's events
     * flowing into a buffer nobody flushes.
     */
    start(bus) {
      if (emitter) return;
      stopped = false;
      emitter = bus;
      handlers = FORWARDED_EVENT_TYPES.map((type) => {
        /** Synchronous and O(1): `emit()` awaits handlers, so this must never do I/O. */
        const handler = (event) => {
          try {
            enqueue(event);
          } catch (err) {
            // Belt and braces. The emitter swallows handler errors, so a throw here would be
            // invisible - which makes catching it the only way to find out.
            warnOnce(
              "handler",
              `failed to buffer an event: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        };
        bus.on(type, handler);
        return { type, handler };
      });
    },

    /** Detach and deliver what is left. Awaited by conductor's shutdown, per the contract. */
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      for (const { type, handler } of handlers) emitter?.off?.(type, handler);
      handlers = [];
      emitter = null;
      // Drain rather than send once: a run that ended with more than one batch pending owes
      // its last events to the ledger. But every await below is conductor's shutdown waiting
      // on this plugin, so the whole drain runs under one deadline - a daemon that accepts a
      // connection and never answers must cost the engine two seconds, not for ever.
      //
      // An expired wait aborts the open request, which rejects into the same catch a refused
      // connection uses, which requeues the batch - so nothing is thrown away to meet the
      // deadline. It is still where delivery ends: this returns into a conductor that is
      // exiting, `stopped` has already closed the retry schedule, and nothing here writes to
      // disk, so a buffer that is not empty when this returns is a buffer that is lost. The
      // file tail covers everything conductor persists; the 28 kinds it does not persist are
      // the ones this costs, and the README says so in those words.
      //
      // The in-flight request is settled FIRST, because `flush()` hands back the open one
      // rather than starting a second - so a loop that did not settle it would measure a
      // buffer nothing had drained yet and give up on the remainder.
      const deadline = Date.now() + SHUTDOWN_MS;
      const remaining = () => deadline - Date.now();
      if (inFlight) await settleWithin(inFlight, remaining());
      // The DEADLINE ends this loop, and nothing else does. An attempt that changed nothing -
      // neither the backlog nor the strategy for sending it - is a reason to wait before
      // trying again, not a reason to stop: the commonest way to get one is a daemon being
      // restarted, which refuses instantly and is back within a second, well inside a budget
      // that exists for exactly this. Treating that first refusal as terminal threw away
      // events while holding two unspent seconds, and for the 28 kinds conductor does not
      // persist there is nothing to recover them from.
      //
      // The pause is what keeps the retry honest rather than hot: a refused connection returns
      // in microseconds, so retrying immediately would be thousands of attempts and a busy
      // core on the engine's exit path. It grows with each fruitless attempt, and is clamped
      // to what is left so the wait itself cannot outlive the deadline.
      let idle = 0;
      while (buffer.length > 0 && remaining() > 0) {
        const before = buffer.length;
        const limitBefore = sendLimit;
        // Each attempt under the same deadline, not just the first: a hung daemon can hang
        // every request, so bounding only the one that was already open would move the
        // unbounded wait one line down rather than remove it.
        await settleWithin(flush(), remaining());
        // Progress, of either kind. A failed batch is put back, so buffer length alone would
        // call a 413 no progress and abandon events the very next (smaller) attempt would
        // have delivered; `sendLimit` is what makes that attempt different.
        if (buffer.length < before || sendLimit !== limitBefore) {
          idle = 0;
          continue;
        }
        idle += 1;
        const wait = Math.min(SHUTDOWN_RETRY_MS * idle, remaining());
        if (wait <= 0) break;
        await sleep(wait);
      }
    },

    /**
     * What this instance has seen. For the tests, and for a support question.
     *
     * `warnings` is the total number of lines printed, summed across the kinds - the answer
     * to "how much of somebody else's log has this plugin spent", which is the question the
     * budget exists for. The per-kind split is an implementation detail of which line gets
     * printed, not something a caller has any use for.
     */
    stats() {
      let warnings = 0;
      for (const spent of warned.values()) warnings += spent;
      return { buffered: buffer.length, dropped, warnings };
    },
  };
}

/**
 * The instance conductor's plugin registry loads.
 *
 * A default export, because `plugin-loader.ts` reads `mod.default || mod`. Constructed at
 * import time and inert until something calls `start()` - which, until the visualizer
 * lifecycle wiring lands in ai-conductor, nothing does. Installing this today is a no-op by
 * design.
 */
export default createMissionControlVisualizer();
