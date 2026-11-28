import { useEffect, useState } from "react";
import { VOICE_FLAG } from "@shared/voice.ts";
import { useFeatureFlag } from "../useFeatureFlag.ts";
import { reportAuthorIdentity, type ReportAuthor, type ReportItem } from "@shared/reports.ts";
import { api } from "./api.ts";
import { historyRetryDelay } from "./timelineReviews.ts";

/** Historical cards can stay open across a flag change after their report leaves the inbox. */
export function useReportAuthorIdentity(author: ReportAuthor) {
  return reportAuthorIdentity(author, useFeatureFlag(VOICE_FLAG));
}

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
  /** Open Report: show its attached document's stored copy. Records the first open; never reads it. */
  onOpenDocument: (report: ReportItem) => void;
}

/**
 * One report's Publish as scout state, kept by the dashboard rather than the card so it survives
 * the card being collapsed or the inbox being closed while the request is in flight.
 */
export interface ReportPublishState {
  /** A publish request for this report is in flight. */
  busy: boolean;
  /** Why the last attempt published nothing, until the next attempt starts. */
  refusal: ReportPublishRefusal | null;
}

/** Why Publish as scout published nothing: the first reason, and every problem the archive named. */
export interface ReportPublishRefusal {
  error: string;
  problems: string[];
  /**
   * Mission Control itself failed (a 5xx, or no answer at all): a write or read failed, or it is
   * restarting. Nothing is wrong with the document, so the card must not say it was refused, and
   * the server's own reason is what it shows.
   */
  failed: boolean;
}

/**
 * Every report one session posted, every version, for its conversation (`inbox` flag).
 *
 * Two halves, like `useTimelineReviews`. The history route is the durable half: it has every
 * version, read or not. The live reports are the immediate half, but the event stream keeps only
 * reports still waiting to be read (`withReportUpserted` drops one once it is read or replaced),
 * so the live half alone can never show how a report was cleared. The history is therefore read
 * again whenever this session's live reports change (`liveReportsKey`): a report posted, read,
 * replied to, followed up or replaced changes that set, and the fresh read carries its new state.
 * Unioned by id with the live copy winning, because it is never older.
 *
 * `enabled` gates the fetch, never the hook, so the hook order is fixed whatever the flag says.
 */
export function useSessionReports(sessionId: string, live: readonly ReportItem[], enabled: boolean): ReportItem[] {
  const [stored, setStored] = useState<{ sessionId: string; reports: ReportItem[] } | null>(null);
  const liveKey = liveReportsKey(sessionId, live);
  useEffect(() => {
    let alive = true;
    // Only a different session clears what was read; a refetch for this one keeps the entries on
    // screen until the fresh read replaces them.
    setStored((current) => (current?.sessionId === sessionId ? current : null));
    if (!enabled) return;
    // A failed read keeps the entries already on screen and is retried, backing off, for a
    // bounded number of attempts (`historyRetryDelay`, the review history's own policy), so a
    // transient failure never leaves a cleared report reading "Waiting to be read".
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const load = (): void => {
      void api.sessionReports(sessionId).then((read) => {
        if (!alive) return;
        if (read.ok) {
          setStored({ sessionId, reports: read.value.reports });
          return;
        }
        const wait = read.definite ? null : historyRetryDelay(attempt++);
        if (wait === null) {
          console.warn(`[reports] could not read the report history of session ${sessionId}`);
          return;
        }
        retry = setTimeout(load, wait);
      });
    };
    load();
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
    };
  }, [sessionId, enabled, liveKey]);
  if (!enabled) return [];
  return sessionReportsFor(sessionId, stored?.sessionId === sessionId ? stored.reports : [], live);
}

/**
 * What this session's live reports are, as a string that changes whenever one arrives, changes,
 * or leaves the stream. A report leaving is how a read or replaced report shows up live at all.
 */
export function liveReportsKey(sessionId: string, live: readonly ReportItem[]): string {
  return live
    .filter((report) => report.sessionId === sessionId)
    .map((report) => `${report.id}:${report.readAt ?? ""}:${report.supersededBy ?? ""}:${report.followUpTaskId ?? ""}`)
    .sort()
    .join("|");
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
