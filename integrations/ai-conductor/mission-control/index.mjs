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
//    about once.
//  - **The buffer is bounded.** A daemon that is not running must cost a bounded amount of
//    memory in a process that may run for days, so the buffer drops its oldest entries and
//    says so once.
//  - **A failed delivery is RETRIED, not discarded.** This is the one place the "best-effort
//    is safe because the tail backfills it" argument does not hold, so it is worth being
//    exact about where it stops. Conductor persists 44 of its 74 event kinds to
//    `events.jsonl`; `gate_verdict`, `loop_halt`, `halt_cleared`, `pipeline_closeout` and the
//    rest of the unpersisted set reach `daemon.log` as text and nowhere else. For those, this
//    plugin is the only durable record there is, and a batch dropped because the daemon was
//    restarting is gone for good. So a failed batch goes back to the front of the queue and
//    is retried with backoff; what is still bounded is the BUFFER, not the attempt.
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

/** How many times this process will complain about anything. */
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
 * The event kinds this build forwards, frozen at ai-conductor 8b51392d.
 *
 * Enumerated because conductor's bus has no wildcard: `.on()` takes one type. So this list
 * is what a copy of this directory knows about, for ever, and a conductor release that adds
 * a kind emits something no installed plugin asked for.
 *
 * That is a designed-for case and not a gap. The unsubscribed event still reaches
 * `events.jsonl`, and Mission Control's backfill sweep reads it - which is precisely why the
 * file tail is never switched off, only slowed down. Re-copying the directory after a
 * conductor upgrade is what shortens the delay for new kinds; nothing is lost until then.
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
  "build_review_stale_mirage_regrade",
  "build_stall",
  "checkpoint_reached",
  "ci_failed",
  "config_skip",
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
  "kickback",
  "loop_converged",
  "loop_halt",
  "mode_skip",
  "navigation_back",
  "operator_park_boundary",
  "parallel_completed",
  "parallel_failure",
  "parallel_started",
  "pipeline_closeout",
  "protected_artifact_rebaseline",
  "protected_artifact_rebaseline_refused",
  "protected_artifact_reseal",
  "protected_artifact_reseal_refused",
  "provider_attempt",
  "provider_fallback",
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
  "session_policy",
  "session_reset",
  "step_completed",
  "step_failed",
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
  const tokenNow = () => {
    if (token === null || token === "") token = options.token ?? readToken();
    return token;
  };

  /** Envelopes waiting to be sent. */
  let buffer = [];
  /** The producer's own ordering coordinate, per run. Never a key on the daemon's side. */
  const seqs = new Map();
  let timer = null;
  let emitter = null;
  let handlers = [];
  let warned = 0;
  let dropped = 0;
  let inFlight = null;
  let stopped = false;
  /** Consecutive failed deliveries, for the retry backoff. Reset by any success. */
  let failures = 0;

  /** Complain at most `MAX_WARNINGS` times, about anything, for the life of the process. */
  const warnOnce = (message) => {
    if (warned >= MAX_WARNINGS) return;
    warned += 1;
    log(`[mission-control] ${message} (further warnings suppressed)`);
  };

  const enqueue = (event) => {
    const run = pinned ?? resolveRun(env, cwd, event);
    if (!run) {
      warnOnce(
        "could not tell which conductor worktree these events belong to, so none are being " +
          "forwarded; set MISSION_CONTROL_WORKTREE, or MISSION_CONTROL_REPO. Mission " +
          "Control still reads the engine's files, so nothing is lost - only delayed",
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
   * This matters more than a retry usually would. Conductor persists 44 of its 74 event kinds
   * to `events.jsonl`; for the other 30 - gate verdicts, halts, closeouts - a delivery this
   * plugin gives up on is the only record that ever existed. The file tail cannot backfill
   * what was never written to a file.
   */
  const requeue = (batch) => {
    failures += 1;
    buffer = batch.concat(buffer);
    if (buffer.length > MAX_BUFFER) {
      dropped += buffer.length - MAX_BUFFER;
      buffer = buffer.slice(-MAX_BUFFER);
      warnOnce(
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
    const batch = buffer.slice(0, MAX_BATCH);
    // Held out of the buffer only while the request is open, so events arriving meanwhile
    // queue behind it and order is preserved. A failure puts it back; see `requeue`.
    buffer = buffer.slice(batch.length);
    const body = `${batch.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    inFlight = (async () => {
      try {
        const res = await fetchImpl(`${url}/ingest/conductor`, {
          method: "POST",
          headers: {
            "content-type": "application/x-ndjson",
            "x-harness-token": tokenNow(),
          },
          body,
        });
        if (res.ok) {
          failures = 0;
          return;
        }
        // 413 is the one refusal this batch can never survive: it is too large, and it will
        // be exactly as large next time. Requeueing it would put an undeliverable batch at
        // the head of the queue for ever and block every event behind it.
        if (res.status === 413) {
          dropped += batch.length;
          warnOnce(
            `Mission Control refused a ${batch.length}-event batch as too large (413); it has ` +
              `been dropped, and the file tail covers whatever it can`,
          );
          failures = 0;
          return;
        }
        // Everything else is worth retrying, 401 included: the token is re-read on each
        // attempt, so an operator fixing ~/.mission-control/token makes the NEXT attempt
        // succeed and the events that were buffered meanwhile still arrive.
        requeue(batch);
        // Named rather than generic, because the two failures an operator can actually fix
        // look nothing alike from here and the message is the only diagnosis they get.
        warnOnce(
          res.status === 401
            ? `Mission Control refused this plugin's token (401). Set MISSION_CONTROL_TOKEN, ` +
                `or check that ~/.mission-control/token is readable by the user conductor runs as`
            : `Mission Control answered ${res.status} at ${url}/ingest/conductor`,
        );
      } catch (err) {
        requeue(batch);
        warnOnce(
          `could not reach Mission Control at ${url} (${err instanceof Error ? err.message : String(err)}); ` +
            `these events are being retried. Most of them are also in the engine's own ` +
            `events.jsonl, but the daemon-scope ones are not written anywhere else`,
        );
      } finally {
        inFlight = null;
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
            warnOnce(`failed to buffer an event: ${err instanceof Error ? err.message : String(err)}`);
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
      // its last events to the ledger, and this is the one place in the file that is allowed
      // to take its time - it happens after the run, not on the bus.
      //
      // The in-flight request is awaited FIRST, because `flush()` hands back the open one
      // rather than starting a second - so a loop that did not settle it would measure a
      // buffer nothing had drained yet and give up on the remainder.
      if (inFlight) await inFlight;
      //
      // The `>= before` guard is what stops this being an infinite retry loop now that a
      // failed batch is put BACK: a flush that failed leaves the buffer exactly as long as
      // it found it, and that is the signal to give up rather than to try again. Shutdown is
      // the one moment retrying is wrong - there is no later flush to inherit the backlog.
      while (buffer.length > 0) {
        const before = buffer.length;
        await flush();
        if (buffer.length >= before) break;
      }
    },

    /** What this instance has seen. For the tests, and for a support question. */
    stats() {
      return { buffered: buffer.length, dropped, warnings: warned };
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
