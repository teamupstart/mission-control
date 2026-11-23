import type { ReportItem } from "@shared/reports.ts";
import type { AttentionFold } from "./attention.ts";

/**
 * Where a report opened from its notification is drawn: in its Reports row when the fold lists
 * it, or on its own in the inbox's "Opened from a notification" band when it does not.
 */
export type ReportPlacement = { where: "row" | "band"; report: ReportItem };

/**
 * What a click on a report notification opens, once the `inbox` flag is known to be on: a
 * placed report, or `fetch` when this window does not hold enough to answer and the daemon's
 * `GET /api/reports/:id` must resolve it.
 */
export type ReportToShow = ReportPlacement | { where: "fetch" };

/**
 * Which report a notification click opens, and where (`inbox` flag).
 *
 * **Which.** The notified report, unless it has been replaced: then the latest report of its
 * chain, reached by following `supersededBy`, because a replacing report takes the earlier one's
 * place and the inbox shows only the latest of a chain. The older version is never drawn.
 *
 * **Where.** Its row when the fold lists it, as a click on the row would open it. Otherwise on
 * its own above the sections. This asks only whether the fold lists the report, never why not,
 * so it covers every reason one is missing: reports unlisted by the setting, a report already
 * read, or one whose author was muted after the notification arrived.
 *
 * `reports` is every report this window holds, read and replaced ones included. When the
 * notified report, or any link of its chain, is not among them, the answer is `fetch`.
 */
export function reportToShow(
  reportId: string,
  reports: ReadonlyMap<string, ReportItem>,
  fold: AttentionFold,
): ReportToShow {
  const start = reports.get(reportId);
  const report = start ? latestHeld(start, reports) : undefined;
  if (!report || report.supersededBy !== null) return { where: "fetch" };
  return placeReport(report, fold);
}

/**
 * Follow `supersededBy` through the reports this window holds, as far as it holds them. Stops at
 * the latest of the chain, or at the last link it holds when a later one never reached it.
 * Bounded by the number held; the bound only guards a cycle no daemon writes.
 */
function latestHeld(report: ReportItem, reports: ReadonlyMap<string, ReportItem>): ReportItem {
  let current = report;
  for (let hops = 0; current.supersededBy !== null && hops <= reports.size; hops++) {
    const next = reports.get(current.supersededBy);
    if (!next) break;
    current = next;
  }
  return current;
}

/** Where one already-chosen report is drawn: see `reportToShow`. */
export function placeReport(report: ReportItem, fold: AttentionFold): ReportPlacement {
  const listed = fold.items.some((item) =>
    item.kind === "agent_reports" && item.reports.some((listedReport) => listedReport.id === report.id));
  return { where: listed ? "row" : "band", report };
}

/**
 * The report a `GET /api/reports/:id` answer opens: the latest of its chain when it was
 * replaced, else the report itself. This window's own copy wins when it holds one, since it has
 * heard every change since the fetch was answered - including a replacement that arrived while
 * the lookup was in flight, which is followed to the latest report the window holds.
 */
export function resolvedReport(
  answer: { report: ReportItem; latest: ReportItem | null },
  reports: ReadonlyMap<string, ReportItem>,
): ReportItem {
  const target = answer.latest ?? answer.report;
  return latestHeld(reports.get(target.id) ?? target, reports);
}
