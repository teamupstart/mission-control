import type { LlmSpendReport } from "@shared/llm-spend.ts";

// The seam between "a headless run finished" and "the ledger knows about it".
//
// It exists because the two processes that make these runs cannot both write the ledger.
// The daemon is the sole database writer; the Foreman worker is a separate process that
// reaches the daemon over HTTP for everything it does, and this is not the exception. So
// the runner reports through a sink the PROCESS installs at startup, and neither runner
// nor call site knows which of the two it is running in:
//
//   daemon        -> writes `usage_ledger` directly (src/server/index.ts)
//   Foreman worker-> POSTs /api/usage/automation   (src/server/foreman/worker.ts)
//
// A module-level mutable rather than a parameter threaded through every call site, for the
// same reason `createLimiter` is per-caller and this is not: the transport is a property of
// the PROCESS, fixed once at boot, while a limiter is a property of a caller. Threading it
// would put a transport argument on all six roles' call paths to express something none of
// them gets to choose.

type Sink = (report: LlmSpendReport) => void;

/**
 * Drop the report and say so, once.
 *
 * The default matters: a process that spawns headless runs without installing a sink is
 * misconfigured, and silence there is exactly the failure this whole change exists to fix -
 * spend that happens and nobody can see. Warning once rather than per run keeps a busy
 * Foreman pass from filling the log with the same line 40 times, which is what would make
 * an operator start ignoring it.
 */
let warned = false;
const dropped: Sink = (report) => {
  if (warned) return;
  warned = true;
  console.warn(
    `[spend] no usage sink installed in this process; dropping ${report.role} usage. ` +
      `The daemon and the Foreman worker each install one at startup.`,
  );
};

let sink: Sink = dropped;

/**
 * Install this process's transport. Called once, at startup, before anything can run.
 *
 * Returns the previous sink so a test can restore it; production callers ignore that.
 */
export function setLlmSpendSink(next: Sink): Sink {
  const previous = sink;
  sink = next;
  warned = false;
  return previous;
}

/**
 * Hand a finished run's usage to whatever this process does with it.
 *
 * NEVER THROWS, and that is load-bearing rather than defensive habit. This is called on the
 * success path of a review that has already cost real money and produced a real verdict; a
 * sink that failed - a POST to a daemon mid-restart, a ledger write losing a race with a
 * migration - must not turn a completed review into a failed one. Accounting is downstream
 * of the work, so it fails downstream of the work.
 */
export function reportLlmSpend(report: LlmSpendReport): void {
  try {
    sink(report);
  } catch (err) {
    console.warn(`[spend] sink failed for ${report.role}:`, err);
  }
}

/**
 * Whether a report is worth recording at all.
 *
 * Two rejections, both deliberate. A run with no `runId` has no dedup identity, and a row
 * that cannot dedup is a row that double-counts the first time anything retries - losing it
 * is the cheaper mistake. A run that reports zero tokens across every tier and every model
 * spent nothing worth a row; that is the shape a provider returns when it failed before it
 * reached the model, and writing it would put a $0 row in the ledger for a call that never
 * happened.
 */
export function spendReportIsRecordable(report: LlmSpendReport): boolean {
  if (!report.runId) return false;
  return report.models.some(
    (m) => m.input > 0 || m.output > 0 || m.cacheRead > 0 || m.cacheWrite > 0,
  );
}
