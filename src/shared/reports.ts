// Agent reports (`inbox` preview flag): what an agent posts with `post_report` so the operator
// can read it, said once for the daemon, the MCP child and the dashboard.
//
// Browser-safe: no `node:` import may reach this module.
//
// A report is NOT a question. It never enters `reviews`, never raises `pendingReviews`, never
// holds a completion, never counts toward the open-question limit, and Foreman never reads it.
// It lives in its own table (`reports`) and outlives the session that posted it.

/** Bounds on what one report may carry. */
export const REPORT_LIMITS = {
  /** One line: the inbox row's heading and, in a later phase, the notification text. */
  title: 200,
  /**
   * Markdown. The report contract's own number, not borrowed from the question limit: a change
   * to how much context a question may carry must not silently change what a report may say.
   */
  body: 4000,
  url: 2000,
  /** A checkout-relative path to the attached document. */
  path: 1024,
  /** The attached document, copied into the state home when the report is posted. */
  documentBytes: 2 * 1024 * 1024,
} as const;

/** How a report left to read. Null while it is unread. */
export const REPORT_READ_BY = ["mark-read", "reply", "follow-up", "mark-all"] as const;
export type ReportReadBy = (typeof REPORT_READ_BY)[number];

/** What kind of document a report may attach. */
export const REPORT_DOCUMENT_KINDS = ["html", "markdown"] as const;
export type ReportDocumentKind = (typeof REPORT_DOCUMENT_KINDS)[number];

/** How a report was announced once its session settled or kept working. Written by a later phase. */
export const REPORT_ANNOUNCEMENTS = ["back", "working"] as const;
export type ReportAnnouncement = (typeof REPORT_ANNOUNCEMENTS)[number];

/**
 * Who posted a report, as it was known at post time, so the report can be named after its
 * session is gone. `key` is `resident:<profileId>` for a resident, so every run of one resident
 * is one author, and `session:<sessionId>` for anything else.
 */
export interface ReportAuthor {
  key: string;
  name: string;
  residentProfileId: string | null;
}

export interface ReportItem {
  /** `r-<n>`: short enough for an agent to repeat back in `replaces`. */
  id: string;
  sessionId: string;
  taskId: string | null;
  /** The posting session's repository root at post time, or null when it had none. */
  repository: string | null;
  author: ReportAuthor;
  title: string;
  /** Markdown. */
  body: string;
  url: string | null;
  /** The stored copy under `<state home>/reports/<id>/<name>`, or null when none was attached. */
  document: { name: string; kind: ReportDocumentKind } | null;
  /** The first report of this chain: its own id unless it replaced another. */
  rootId: string;
  /** 1 for a first report; each replacement adds one. */
  version: number;
  /** The report that replaced this one, or null while it is the latest of its chain. */
  supersededBy: string | null;
  createdAt: number;
  /** When the chain's first report was posted, which is the place in the queue a chain keeps. */
  rootCreatedAt: number;
  /** When the operator first opened it. Recorded, never shown as a count. */
  openedAt: number | null;
  readAt: number | null;
  readBy: ReportReadBy | null;
  /** The task a follow-up started from this report (a later phase writes it). */
  followUpTaskId: string | null;
  announcedAs: ReportAnnouncement | null;
  announcedAt: number | null;
  /** The scout archive key it was published under (a later phase writes it). */
  publishedArchiveKey: string | null;
}

export const REPORT_ID_PATTERN = /^r-[1-9][0-9]*$/;

/** The public id of the `n`th report. */
export function reportId(n: number): string {
  return `r-${n}`;
}

/** The number in a report id, or null when it is not one. */
export function reportNumber(id: string): number | null {
  return REPORT_ID_PATTERN.test(id) ? Number(id.slice(2)) : null;
}

export function residentAuthorKey(profileId: string): string {
  return `resident:${profileId}`;
}

export function sessionAuthorKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * Whether a report is waiting to be read: not read, and not replaced by a later one. The
 * inbox lists exactly these and the to read figure counts exactly these.
 */
export function reportToRead(report: Pick<ReportItem, "readAt" | "supersededBy">): boolean {
  return report.readAt === null && report.supersededBy === null;
}

/**
 * The kind of document a checkout path names, or null when a report cannot attach it. Exactly
 * `.html` and `.md`, in any case: the two extensions the tool promises, and the two a later
 * reader and Publish as scout are built for. `.htm` and `.markdown` are refused rather than
 * quietly widening that contract.
 */
export function reportDocumentKind(path: string): ReportDocumentKind | null {
  if (/\.html$/i.test(path)) return "html";
  if (/\.md$/i.test(path)) return "markdown";
  return null;
}

/** "updated 3 times", or null for a report that replaced nothing. */
export function reportUpdatedNote(version: number): string | null {
  const times = version - 1;
  return times > 0 ? `updated ${times} time${times === 1 ? "" : "s"}` : null;
}

/**
 * When to post a report: the paragraph the tool's description carries. Progress belongs on
 * `report_status`, and anything urgent or anything the operator must decide is a question.
 */
export const REPORT_GUIDANCE =
  "Post a report when your operator asked you for one, or when you have finished something they " +
  "must read in order to act: a diagnosis, the result of an investigation, a summary of work to " +
  "review. Do not post progress here; use report_status for that. Anything urgent, or anything " +
  "that needs the operator's decision, is a question: use request_input instead.";

/** The tool result: the report's id, and that nothing waits on a reply. */
export function reportReceipt(report: Pick<ReportItem, "id" | "version">): string {
  const replaced = report.version > 1 ? " It replaces your earlier report in the operator's inbox." : "";
  return (
    `Report ${report.id} posted to your operator's inbox.${replaced} Do not wait for a reply: ` +
    "carry on with your work, or end your turn if you are done. If you need to correct or update " +
    `it, post again with replaces: "${report.id}".`
  );
}
