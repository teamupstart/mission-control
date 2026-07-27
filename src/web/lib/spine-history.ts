import type { ScheduleOccurrence } from "@shared/schedules.ts";

export interface SpineHistorySlice {
  occurrences: ScheduleOccurrence[];
  nextCursor: number | null;
}

export interface SpineHistoryWindow {
  occurrences: ScheduleOccurrence[];
  olderCursor: number | null;
  olderDone: boolean;
  bridgeCursor: number | null;
  bridgeTargetAt: number | null;
  bridgeBefore: number | null;
}

export const EMPTY_SPINE_HISTORY: SpineHistoryWindow = {
  occurrences: [],
  olderCursor: null,
  olderDone: false,
  bridgeCursor: null,
  bridgeTargetAt: null,
  bridgeBefore: null,
};

export function mergeOccurrences(
  fresh: ScheduleOccurrence[],
  existing: ScheduleOccurrence[],
): ScheduleOccurrence[] {
  const freshIds = new Set(fresh.map((occurrence) => occurrence.id));
  return [...fresh, ...existing.filter((occurrence) => !freshIds.has(occurrence.id))];
}

export function createSpineHistoryWindow(
  newest: SpineHistorySlice,
  target?: SpineHistorySlice,
): SpineHistoryWindow {
  if (!target || target.occurrences.length === 0) {
    return {
      occurrences: newest.occurrences,
      olderCursor: newest.nextCursor,
      olderDone: newest.nextCursor === null,
      bridgeCursor: null,
      bridgeTargetAt: null,
      bridgeBefore: null,
    };
  }

  const targetIds = new Set(target.occurrences.map((occurrence) => occurrence.id));
  const targetAt = Math.max(...target.occurrences.map((occurrence) => occurrence.scheduledFor));
  const newestBefore =
    newest.occurrences.length > 0
      ? Math.min(...newest.occurrences.map((occurrence) => occurrence.scheduledFor))
      : null;
  const connected =
    newest.nextCursor === null ||
    newestBefore === null ||
    newestBefore <= targetAt ||
    newest.occurrences.some((occurrence) => targetIds.has(occurrence.id));

  return {
    occurrences: mergeOccurrences(newest.occurrences, target.occurrences),
    olderCursor: target.nextCursor,
    olderDone: target.nextCursor === null,
    bridgeCursor: connected ? null : newest.nextCursor,
    bridgeTargetAt: connected ? null : targetAt,
    bridgeBefore: connected ? null : newestBefore,
  };
}

export function createFetchedSpineHistoryWindow(
  newest: SpineHistorySlice,
  accumulated: SpineHistorySlice,
  separateTargetRange: boolean,
): SpineHistoryWindow {
  return separateTargetRange
    ? createSpineHistoryWindow(newest, accumulated)
    : createSpineHistoryWindow(accumulated);
}

export function appendSpineHistoryBridge(
  current: SpineHistoryWindow,
  page: SpineHistorySlice,
): SpineHistoryWindow {
  if (current.bridgeTargetAt === null) return current;
  const targetAt = current.bridgeTargetAt;
  const connected =
    page.nextCursor === null ||
    page.occurrences.some((occurrence) => occurrence.scheduledFor <= targetAt);
  const pageBefore =
    page.occurrences.length > 0
      ? Math.min(...page.occurrences.map((occurrence) => occurrence.scheduledFor))
      : current.bridgeBefore;
  return {
    ...current,
    occurrences: mergeOccurrences(page.occurrences, current.occurrences),
    bridgeCursor: connected ? null : page.nextCursor,
    bridgeTargetAt: connected ? null : targetAt,
    bridgeBefore:
      connected || pageBefore === null
        ? null
        : Math.min(current.bridgeBefore ?? pageBefore, pageBefore),
  };
}

export function appendOlderSpineHistory(
  current: SpineHistoryWindow,
  page: SpineHistorySlice,
): SpineHistoryWindow {
  return {
    ...current,
    occurrences: mergeOccurrences(page.occurrences, current.occurrences),
    olderCursor: page.nextCursor,
    olderDone: page.nextCursor === null,
  };
}
