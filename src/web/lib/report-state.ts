import { reportToRead, type ReportItem } from "@shared/reports.ts";

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
