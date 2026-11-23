import type { ReplyTarget, ReportItem } from "../../src/shared/reports.ts";

/** A report waiting to be read, from a standard session, with every later-phase field unset. */
export function mkReport(over: Partial<ReportItem> & { id: string }): ReportItem {
  const sessionId = over.sessionId ?? "s1";
  return {
    sessionId,
    taskId: null,
    repository: null,
    author: { key: `session:${sessionId}`, name: "Fix the parser", residentProfileId: null },
    title: `Report ${over.id}`,
    body: "What I found.",
    url: null,
    document: null,
    rootId: over.id,
    version: 1,
    supersededBy: null,
    createdAt: 1,
    rootCreatedAt: over.createdAt ?? 1,
    openedAt: null,
    readAt: null,
    readBy: null,
    followUpTaskId: null,
    announcedAs: null,
    announcedAt: null,
    publishedArchiveKey: null,
    ...over,
  };
}

/**
 * Report controls for a rendered inbox, recording each call. `AttentionInbox` requires real
 * controls, so a render test passes these rather than an inert default.
 */
export function mkReportControls(openReportId: string | null = null, target: ReplyTarget = { kind: "live", sessionId: "s1" }) {
  const calls: {
    toggled: string[]; markedRead: string[]; replied: string[]; followedUp: string[];
    openedDocument: string[]; published: string[]; openedArchive: string[];
  } = { toggled: [], markedRead: [], replied: [], followedUp: [], openedDocument: [], published: [], openedArchive: [] };
  return {
    calls,
    controls: {
      openReportId,
      onToggle: (report: ReportItem) => { calls.toggled.push(report.id); },
      onMarkRead: async (report: ReportItem) => { calls.markedRead.push(report.id); return null; },
      targetFor: (_report: ReportItem): ReplyTarget => target,
      draftFor: (_report: ReportItem) => "",
      onDraft: (_report: ReportItem, _text: string) => undefined,
      onReply: async (report: ReportItem) => { calls.replied.push(report.id); return null; },
      onFollowUp: async (report: ReportItem) => { calls.followedUp.push(report.id); return null; },
      onOpenDocument: (report: ReportItem) => { calls.openedDocument.push(report.id); },
      onPublish: (report: ReportItem) => { calls.published.push(report.id); },
      publishStateFor: (_report: ReportItem) => ({ busy: false, refusal: null }),
      onOpenArchive: (report: ReportItem) => { calls.openedArchive.push(report.id); },
    },
  };
}

/** The props a rendered `ReportCard` needs beyond the report, with a live target by default. */
export function reportCardProps(target: ReplyTarget = { kind: "live", sessionId: "s1" }) {
  return {
    target,
    onToggle: () => undefined,
    onMarkRead: () => undefined,
    onReply: async () => null,
    onFollowUp: async () => null,
    draft: "",
    onDraft: () => undefined,
    onOpenDocument: () => undefined,
    onPublish: () => undefined,
    onOpenArchive: () => undefined,
  };
}
