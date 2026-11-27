import { REPORT_READ_ALL_BATCH, reportToRead, type ReportItem } from "@shared/reports.ts";

/**
 * The dashboard's reports after one `report_upsert`. A report still waiting to be read is
 * stored or replaced; one that has been read or replaced by a later report leaves, because
 * nothing in the dashboard draws it any more. Keeping those would grow a long-open window's
 * state with every report ever read, and the attention fold would walk all of them on every
 * update. A session's full history, read and replaced reports included, is fetched from
 * `GET /api/sessions/:id/reports` when a surface needs it.
 *
 * Returns the same map when nothing changes, so an upsert for a report the window never held
 * and does not keep re-renders nothing.
 */
export function withReportUpserted(
  prev: ReadonlyMap<string, ReportItem>,
  report: ReportItem,
): ReadonlyMap<string, ReportItem> {
  if (reportToRead(report)) return new Map(prev).set(report.id, report);
  if (!prev.has(report.id)) return prev;
  const next = new Map(prev);
  next.delete(report.id);
  return next;
}

/**
 * Mark all read for every id the Reports section listed, in batches of at most
 * `REPORT_READ_ALL_BATCH`, one after another, so a section of any length is cleared by one press
 * while each request stays within the route's bound. Duplicate ids are sent once. Stops at the
 * first refused batch and resolves to why; the batches before it stay read, and their rows leave
 * as their `report_upsert` events arrive. Resolves to null once every batch was accepted.
 */
export async function markAllReportsRead(
  ids: readonly string[],
  send: (batch: string[]) => Promise<{ ok: boolean; error?: string }>,
): Promise<string | null> {
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += REPORT_READ_ALL_BATCH) {
    const result = await send(unique.slice(start, start + REPORT_READ_ALL_BATCH));
    if (!result.ok) return result.error ?? "Could not mark the reports read";
  }
  return null;
}
