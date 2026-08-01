import { recordAutomationUsage } from "./db.ts";
import { LLM_RUNNERS } from "./llm/index.ts";
import { spendReportIsRecordable } from "./llm/spend.ts";
import { isLlmRunnerId } from "@shared/llm.ts";
import type { AutomationUsageRow } from "./db.ts";
import type { LlmSpendReport } from "@shared/llm-spend.ts";

// Where a headless run's usage becomes a ledger row.
//
// The DAEMON side of the seam, and the only side that touches SQLite. Both reporters end up
// here: the daemon's own Inspector runs call it directly, and the Foreman worker's runs
// arrive over `/api/usage/automation` and are handed to the same function. One writer, so
// the two cannot price or dedupe differently - the worker being a separate process is a
// deployment fact, not a reason for a second implementation.
//
// Deliberately NOT in `llm/spend.ts`: that module is imported by the runners, which run in
// the Foreman worker too, and importing this file there would pull `db.ts` - and
// `node:sqlite` with it - into a process that is forbidden from opening the database.

/**
 * What happened to a report, in the three ways that matter to whoever sent it.
 *
 * `empty` and `unsupported` both mean "no ledger row", and telling them apart is the whole
 * point of this type. A report carrying no tokens is genuinely nothing to store, and
 * acknowledging it is correct - the sender should forget it rather than retry it forever.
 * A report this build cannot value is the opposite: the run happened, the tokens are spent,
 * and this daemon simply cannot record it, so the sender must KEEP it. A single nullable
 * return could not express that difference, and the route acknowledged both.
 */
export type SpendRecordOutcome =
  | { kind: "recorded" }
  | { kind: "empty" }
  | { kind: "unsupported"; reason: string };

/**
 * Price a report and write it. Says which of the three outcomes occurred.
 *
 * Pricing happens HERE rather than in the runner that observed the run, because the worker
 * must not be the one deciding what its own work cost: it would be a second place the
 * price snapshot is applied, and the two would drift the day one process was restarted and
 * the other was not. The worker reports tokens; the daemon values them.
 *
 * A runner id this build does not have is dropped rather than recorded unpriced. It means
 * the report came from a newer or older peer, and inventing a row for a provider whose
 * rates we cannot even look up would put a $0 automation row in the strip.
 */
export function recordSpendReport(report: LlmSpendReport): SpendRecordOutcome {
  // "Nothing to record" and "cannot record" are different answers and must not share one,
  // because the caller turns them into different HTTP statuses and the worker turns THOSE
  // into keep-or-discard. Collapsing them to a bare null is what let an unrecordable report
  // be acknowledged as if it had landed.
  if (!spendReportIsRecordable(report)) return { kind: "empty" };
  if (!isLlmRunnerId(report.runner)) {
    console.warn(`[spend] cannot record ${report.role} usage from unknown runner ${report.runner}`);
    return { kind: "unsupported", reason: `unknown runner: ${report.runner}` };
  }
  const runner = LLM_RUNNERS[report.runner];
  const models: AutomationUsageRow[] = report.models.map((m) => {
    const price = runner.price(m);
    return {
      modelId: m.modelId,
      input: m.input,
      output: m.output,
      reasoningOutput: m.reasoningOutput,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      costUsd: price?.costUsd ?? null,
      basis: price?.basis ?? "unpriced",
      pricingVersion: price?.pricingVersion ?? "",
    };
  });
  recordAutomationUsage({
    role: report.role,
    agent: report.runner,
    runId: report.runId,
    ts: report.ts,
    models,
  });
  return { kind: "recorded" };
}
