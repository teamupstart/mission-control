import { envVar } from "../config.ts";
import { unref } from "../util/timers.ts";
import { detectAlerts, stuckAlert } from "@shared/alerts.ts";
import type { AlertScope } from "@shared/alerts.ts";
import { detectStalls } from "@shared/stall.ts";
import type { Stall } from "@shared/stall.ts";
import {
  closeBuffer,
  emptyBuffer,
  foldAlerts,
  mergeBuffers,
  refreshAlerts,
} from "@shared/away-buffer.ts";
import type { AwayBuffer } from "@shared/away-buffer.ts";
import { getAwayConfig, stallThresholds } from "./config.ts";
import type { Session, Task } from "@shared/types.ts";
import type { WorkflowRunRepeatOffender, WorkflowRunSummary } from "@shared/workflow.ts";
import type { EnsembleSummary } from "@shared/ensemble.ts";

// The away watcher: the daemon half of away mode. Diffs the registry snapshot on a
// timer, runs the stall rules against a real clock, and folds what happened into
// the away buffer so returning to the desk yields one digest instead of six tabs.
//
// A poller rather than an event listener, and that is forced rather than chosen: a
// stall is defined by the ABSENCE of events, and `sessionEqual` deliberately
// excludes `lastActivity` from the SSE change comparison so an unchanged-but-alive
// session doesn't emit every 1.5s. Nothing would ever wake a listener for the case
// this exists to catch.

/** How often to diff + re-run the stall rules. Cheap: a snapshot read and pure functions. */
const AWAY_POLL_MS = Number(envVar("AWAY_POLL_MS") ?? 5000);

/** Just the slice of the registry this needs - narrowed so tests can supply a fake. */
export interface AwaySource {
  snapshot(): {
    sessions: Session[];
    tasks: Task[];
    workflowRunSummaries?: WorkflowRunSummary[];
    ensembleSummaries?: EnsembleSummary[];
  };
}

/**
 * The daemon-computed signals that do not travel on the registry snapshot.
 *
 * Injected rather than read, because this module must not import the Workflow store: the
 * derivation walks submissions and attempts, which is exactly why it is detail-only and not a
 * field on `WorkflowRunSummary`. Optional so an embedder (and every existing test) still gets
 * a watcher, which simply emits no repeat alerts - the "not read yet" reading `AlertScope`
 * documents for `stalls`.
 */
export interface AwayDeps {
  workflowRepeatOffenders?: () => WorkflowRunRepeatOffender[];
}

export interface AwayWatcher {
  stop: () => void;
  /** Currently-stalled sessions, for the API and the report. */
  stalls: () => Stall[];
  /** What has accumulated since you left, or null when you are not away. */
  buffer: () => AwayBuffer | null;
  /**
   * The closed buffer from the away window you just ended, removed as it is read.
   *
   * Returning has to CLOSE the window and hold it, rather than discard it: the whole
   * promise is that you come back to a summary, and the read that renders that
   * summary necessarily happens after you are no longer away. Read-once so a refresh
   * doesn't re-announce a digest you have already seen.
   */
  takePending: () => AwayBuffer | null;
  /**
   * Close the open window right now, so the digest is ready the instant you return.
   *
   * Called by the route that flips away off, because the poll tick is up to
   * AWAY_POLL_MS behind: without this, the client's follow-up digest read would
   * usually beat the tick that closes the buffer and get nothing.
   */
  flush: () => void;
  /** Run one pass now. The poller calls this on its own timer; tests drive it directly. */
  tick: () => void;
}

export function startAwayWatcher(
  registry: AwaySource,
  now = () => Date.now(),
  deps: AwayDeps = {},
): AwayWatcher {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** The previous scope, to diff against. Null until the first tick seeds it. */
  let prev: AlertScope | null = null;
  let stalls: Stall[] = [];
  let buffer: AwayBuffer | null = null;
  /** A closed window waiting to be read as a digest. See takePending. */
  let pending: AwayBuffer | null = null;
  /** The `awaySince` the buffer was opened for, so a NEW away window starts fresh. */
  let bufferedSince: number | null = null;
  /** When each parked gate was first seen parked - the gate rule's only honest clock. */
  /** Close the open window into `pending`. Idempotent - a second call is a no-op. */
  const closeWindow = (): void => {
    if (buffer === null) return;
    // Merge rather than overwrite: leaving twice before any dashboard claimed the
    // first digest must not silently destroy it - `takePending` is read-once, so
    // there is nowhere else to recover it from.
    const closed = closeBuffer(buffer, now());
    pending = pending ? mergeBuffers(pending, closed) : closed;
    buffer = null;
    bufferedSince = null;
  };

  /** One pass: re-run the stall rules, reconcile the window, fold what changed. */
  const pass = (): void => {
    try {
      const cfg = getAwayConfig();
      const t = now();
      const snap = registry.snapshot();

      stalls = cfg.detectStalls
        ? detectStalls(snap.sessions, t, stallThresholds(cfg))
        : [];

      const scope: AlertScope = {
        sessions: snap.sessions,
        tasks: snap.tasks,
        stalls,
        workflowRuns: snap.workflowRunSummaries ?? [],
        ...(deps.workflowRepeatOffenders
          ? { workflowRepeatOffenders: deps.workflowRepeatOffenders() }
          : {}),
        ensembleSummaries: snap.ensembleSummaries ?? [],
      };

      // Open a buffer when you leave; on return, CLOSE it into `pending` rather than
      // dropping it, because the digest that renders it is necessarily read after you
      // are no longer away.
      let opened = false;
      if (cfg.away && cfg.awaySince != null) {
        if (buffer === null || bufferedSince !== cfg.awaySince) {
          buffer = emptyBuffer(cfg.awaySince);
          bufferedSince = cfg.awaySince;
          opened = true;
        }
      } else {
        closeWindow();
      }

      // What this pass diffs against.
      //
      // Normally the previous scope. On the pass that OPENS a window its stalls are
      // stripped first, so a session that wedged BEFORE you stood up is reported
      // too: it is already in the baseline, so a plain edge-trigger stays silent
      // about it - and it is precisely the session you most want to hear about.
      // Stripping only `stalls` leaves the session/task diff untouched, so history
      // still cannot flood the buffer.
      //
      // Null on the very first tick, where the scope stands in for itself: with no
      // baseline every live session would read as a brand-new transition and the
      // buffer would open full of history, while anything ALREADY stuck (a daemon
      // restarted mid-away) is still reported.
      const base = opened ? { ...(prev ?? scope), stalls: [] } : prev;
      if (base && buffer) {
        buffer = foldAlerts(buffer, detectAlerts(base, scope), t);
      }

      // Stalls are the one buffered thing that keeps getting WORSE after it is
      // announced, and the edge-trigger above deliberately announces each one only
      // once - so its line would otherwise still read "silent for 10m" an hour
      // later. Re-read the live stalls into what is already buffered: wording only,
      // no new alert, no second notification, no repeat count.
      if (buffer) {
        buffer = refreshAlerts(
          buffer,
          stalls.map((st) => stuckAlert(st, snap.sessions)),
        );
      }
      prev = scope;
    } catch (err) {
      console.error("[away] poll failed:", err);
    }
  };

  const tick = (): void => {
    if (stopped) return;
    pass();
    if (stopped) return;
    timer = unref(setTimeout(tick, AWAY_POLL_MS));
  };

  tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    stalls: () => stalls,
    buffer: () => buffer,
    takePending: () => {
      const p = pending;
      pending = null;
      return p;
    },
    flush: closeWindow,
    tick: pass,
  };
}
