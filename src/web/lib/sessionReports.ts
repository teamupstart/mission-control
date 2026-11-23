import { useEffect, useState } from "react";
import type { ReportItem } from "@shared/reports.ts";
import { api } from "./api.ts";

/**
 * What a conversation entry for a report needs from the dashboard: which report is open on
 * screen (App's `openReportId`, the same one the inbox reads, so there is one answer to "which
 * report is open"), and the two things an entry does.
 */
export interface ReportEntryControls {
  openReportId: string | null;
  /** Open this report, or close it when it is the open one. Records the first open. */
  onToggle: (report: ReportItem) => void;
  /** Mark it read. Resolves to why the daemon refused, or null. */
  onMarkRead: (report: ReportItem) => Promise<string | null>;
}

/**
 * Every report one session posted, every version, for its conversation (`inbox` flag).
 *
 * Two halves, like `useTimelineReviews`: the history route is the durable half (read reports and
 * replaced versions are not in the snapshot), and the live reports from the event stream are the
 * immediate half, so a report posted, read or replaced while the conversation is open changes its
 * entry at once. Unioned by id with the live copy winning, because it is never older.
 *
 * `enabled` gates the fetch, never the hook, so the hook order is fixed whatever the flag says.
 */
export function useSessionReports(sessionId: string, live: readonly ReportItem[], enabled: boolean): ReportItem[] {
  const [stored, setStored] = useState<{ sessionId: string; reports: ReportItem[] } | null>(null);
  useEffect(() => {
    let alive = true;
    setStored(null);
    if (!enabled) return;
    void api.sessionReports(sessionId).then((read) => {
      if (alive && read.ok) setStored({ sessionId, reports: read.value.reports });
    });
    return () => {
      alive = false;
    };
  }, [sessionId, enabled]);
  if (!enabled) return [];
  return sessionReportsFor(sessionId, stored?.sessionId === sessionId ? stored.reports : [], live);
}

/**
 * The union, filtered to one session and oldest first. Both sources are filtered, because the
 * fetched half can still hold the previous session's rows for the one render after a switch.
 */
export function sessionReportsFor(
  sessionId: string,
  stored: readonly ReportItem[],
  live: readonly ReportItem[],
): ReportItem[] {
  const byId = new Map<string, ReportItem>();
  for (const report of stored) if (report.sessionId === sessionId) byId.set(report.id, report);
  for (const report of live) if (report.sessionId === sessionId) byId.set(report.id, report);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, undefined, { numeric: true }));
}
