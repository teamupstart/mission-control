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
 * Price a report and write it. Returns what was recorded, or null when nothing was.
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
export function recordSpendReport(report: LlmSpendReport): LlmSpendReport | null {
  if (!spendReportIsRecordable(report)) return null;
  if (!isLlmRunnerId(report.runner)) {
    console.warn(`[spend] dropping ${report.role} usage from unknown runner ${report.runner}`);
    return null;
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
  return report;
}
