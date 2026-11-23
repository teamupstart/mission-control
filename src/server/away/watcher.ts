import { envVar } from "../config.ts";
import { unref } from "../util/timers.ts";
import { detectAlerts, stuckAlert } from "@shared/alerts.ts";
import type { AlertScope } from "@shared/alerts.ts";
import { detectStalls, NO_UNPUSHED } from "@shared/stall.ts";
import type { Stall } from "@shared/stall.ts";
import type { UnpushedObserver } from "./unpushed-observer.ts";
import {
  closeBuffer,
  emptyBuffer,
  foldAlerts,
  mergeBuffers,
  reconcileReports,
  refreshAlerts,
} from "@shared/away-buffer.ts";
import type { AwayBuffer } from "@shared/away-buffer.ts";
import { getAwayConfig, stallThresholds } from "./config.ts";
import type { ReviewItem, Session, Task } from "@shared/types.ts";
import type { WorkflowRunRepeatOffender, WorkflowRunSummary } from "@shared/workflow.ts";
import type { EnsembleSummary } from "@shared/ensemble.ts";
import type { PipelineCommission, PipelineRun } from "@shared/pipeline.ts";
import type { ResidentRunSummary } from "@shared/residents.ts";
import { mutedAuthorKeys, type ReportItem, type ReportMute } from "@shared/reports.ts";
import { INBOX_FLAG } from "@shared/inbox.ts";
import { featureEnabled } from "../feature-flags/index.ts";

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
    reviews?: ReviewItem[];
    workflowRunSummaries?: WorkflowRunSummary[];
    ensembleSummaries?: EnsembleSummary[];
    pipelineCommissions?: PipelineCommission[];
    pipelineRuns?: PipelineRun[];
    /** Live resident runs, which name a resident's alerts while the `inbox` flag is on. */
    residentRuns?: ResidentRunSummary[];
    /** Agent reports waiting to be read, present while the `inbox` flag is on. */
    reports?: ReportItem[];
    /** Muted report authors, present while the `inbox` flag is on. Their reports are not counted. */
    reportMutes?: ReportMute[];
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
  /**
   * Commits the parked runs' checkouts have never pushed, so a parked-run stall can name the
   * missing step instead of only naming the wait.
   *
   * Injected for the reason above it is: resolving a run to its checkout means reading the
   * binding, and this module must not import the Workflow store. It is also the only way the
   * git read can be kept OFF this tick - `observe` starts reads and returns, `snapshot` reads
   * what already came back - which matters because `pass()` is synchronous and a hung git must
   * never be able to stop stall detection for the rest of the fleet.
   *
   * Optional, and its absence is not a special case anywhere: an embedder that wires no
   * observer, and every existing test, gets an empty map, which `unpushedClause` already
   * renders as no claim at all.
   */
  unpushedObserver?: UnpushedObserver;
  /**
   * Told, as a window closes, every report waiting to be read that its digest counted, so none
   * raises a notification afterwards in any window (see `ReportItem.countedInDigestAt`).
   */
  reportsCountedInDigest?: (ids: string[]) => void;
  /**
   * Told when a dashboard claims the digest, so the marks `reportsCountedInDigest` set are kept
   * from then on. Until then they live and die with the digest, which is only in memory.
   */
  reportsDigestClaimed?: () => void;
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

/** The reports waiting to be read whose authors are not muted: what the digest may count. */
function listedReports(snap: Pick<ReturnType<AwaySource["snapshot"]>, "reports" | "reportMutes">): ReportItem[] {
  const muted = mutedAuthorKeys(snap.reportMutes);
  return (snap.reports ?? []).filter((report) => !muted.has(report.author.key));
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
  /**
   * The reports waiting to be read right now, or null while the `inbox` flag is off. Read fresh
   * rather than from the last tick, because closing the window is not on the tick.
   */
  const waitingReports = (): ReportItem[] | null =>
    featureEnabled(INBOX_FLAG) ? listedReports(registry.snapshot()) : null;

  /** When each parked gate was first seen parked - the gate rule's only honest clock. */
  /** Close the open window into `pending`. Idempotent - a second call is a no-op. */
  const closeWindow = (): void => {
    if (buffer === null) return;
    // Merge rather than overwrite: leaving twice before any dashboard claimed the
    // first digest must not silently destroy it - `takePending` is read-once, so
    // there is nowhere else to recover it from.
    const at = now();
    const closed = closeBuffer(buffer, at);
    // The digest's reports are the reports waiting as you return, including one whose
    // announcement has not landed yet and excluding one you read while away: see
    // `reconcileReports`. Reports posted during this window join it before the merge, against
    // this window's own start, so a report posted at the desk between it and an unclaimed earlier
    // window is never counted as away activity. The merge is then pruned, without adding, so the
    // earlier window is brought up to date too.
    const waiting = waitingReports();
    // With the flag off no report may be named or counted: the digest loses its report events,
    // keeps every other event, and nothing is marked counted.
    const closedWithReports = reconcileReports(closed, waiting ?? [], at, true);
    pending = reconcileReports(pending ? mergeBuffers(pending, closedWithReports) : closedWithReports, waiting ?? [], at, false);
    // Closed before anything else can fail: a window left open after being merged into `pending`
    // would be merged again on the next close, doubling every count in the digest.
    buffer = null;
    bufferedSince = null;
    if (waiting && deps.reportsCountedInDigest) {
      const counted = new Set(pending.events.filter((e) => e.kind === "report").map((e) => e.key));
      const ids = waiting.filter((r) => counted.has(`report:${r.id}`)).map((r) => r.id);
      // A failed write (a busy database) loses only the marks, so a counted report may notify
      // once more; it must not stop the window closing or the return that closes it.
      try {
        if (ids.length > 0) deps.reportsCountedInDigest(ids);
      } catch (err) {
        console.error("[away] marking reports counted in the digest failed:", err);
      }
    }
  };

  /** One pass: re-run the stall rules, reconcile the window, fold what changed. */
  const pass = (): void => {
    try {
      const cfg = getAwayConfig();
      const t = now();
      const snap = registry.snapshot();

      // Read ONCE and share. The stall rules and the alert scope must reason about the same
      // runs: a stall saying a run is parked, beside a scope that never saw it, is the
      // daemon disagreeing with itself about one snapshot.
      const workflowRuns = snap.workflowRunSummaries ?? [];

      // Start any git read that is due and take what has already landed. Both halves are
      // synchronous; the reads themselves happen between ticks. On the very first tick the
      // snapshot is empty, which is why the observation may only ever ADD a clause to a
      // sentence that already stands on its own.
      //
      // Inside the `detectStalls` check rather than beside it: an operator who turned stall
      // detection off has asked for no stall sentences, and the only consumer of this read is
      // the sentence. Observing anyway would spend a git subprocess a minute, for ever, on an
      // answer with nowhere to go.
      if (cfg.detectStalls) {
        deps.unpushedObserver?.observe(workflowRuns);
        const unpushed = deps.unpushedObserver?.snapshot() ?? NO_UNPUSHED;
        stalls = detectStalls(snap.sessions, workflowRuns, unpushed, t, stallThresholds(cfg));
      } else {
        stalls = [];
      }

      const scope: AlertScope = {
        sessions: snap.sessions,
        tasks: snap.tasks,
        reviews: snap.reviews,
        stalls,
        workflowRuns,
        ...(deps.workflowRepeatOffenders
          ? { workflowRepeatOffenders: deps.workflowRepeatOffenders() }
          : {}),
        ensembleSummaries: snap.ensembleSummaries ?? [],
        pipelineCommissions: snap.pipelineCommissions,
        pipelineRuns: snap.pipelineRuns,
        // Read each pass, like the browser's gate, so a toggle names the next alert alike on
        // both sides without a restart.
        //
        // Reports ride the same gate: while away a report's alert is buffered rather than
        // delivered, and the digest names who posted. `takenAt` lets a report posted and stamped
        // between two reads still count as news (see `AlertScope.takenAt`).
        //
        // A muted author's reports are left out of this scope, so they are never buffered and the
        // digest never counts them; one buffered before the mute leaves at the next reconcile.
        ...(featureEnabled(INBOX_FLAG) ? { names: snap.residentRuns ?? [], reports: listedReports(snap) } : {}),
        takenAt: t,
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
          stalls.map((st) => stuckAlert(st, snap.sessions, scope.names)),
        );
        // Reports read or replaced since they were buffered leave it, so the Away card's
        // preview does not count them. Unannounced ones join only when the window closes.
        // With the flag off there are none, so the preview stops counting any.
        buffer = reconcileReports(buffer, scope.reports ? [...scope.reports] : [], t, false);
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
      // A failed write loses only the marks, so a counted report may notify once more after a
      // restart; the digest is still handed over.
      if (p) {
        try {
          deps.reportsDigestClaimed?.();
        } catch (err) {
          console.error("[away] keeping the digest's report marks failed:", err);
        }
      }
      return p;
    },
    flush: closeWindow,
    tick: pass,
  };
}
