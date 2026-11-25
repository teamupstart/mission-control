// Agent reports (`inbox` preview flag): what an agent posts with `post_report` so the operator
// can read it, said once for the daemon, the MCP child and the dashboard.
//
// Browser-safe: no `node:` import may reach this module.
//
// A report is NOT a question. It never enters `reviews`, never raises `pendingReviews`, never
// holds a completion, never counts toward the open-question limit, and Foreman never reads it.
// It lives in its own table (`reports`) and outlives the session that posted it.

import { quotedReferenceName } from "./voice-names.ts";
import { canMessage, type Messageable } from "./pane.ts";
import { isShippingTaskKind } from "./task.ts";
import type { ResidentRunSummary } from "./residents.ts";
import type { Session, TaskKind } from "./types.ts";

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

/** The operator's Mark read action, also available for a sole unread report without a drawn card. */
export function markReportRead<T>(id: string, post: (path: string) => T): T {
  return post(`/api/reports/${encodeURIComponent(id)}/read`);
}

/** What kind of document a report may attach. */
export const REPORT_DOCUMENT_KINDS = ["html", "markdown"] as const;
export type ReportDocumentKind = (typeof REPORT_DOCUMENT_KINDS)[number];

/**
 * How a report was announced: `back` when its session stopped within the grace period after
 * posting, `working` when the grace period ended with it still going. Stamped once by the daemon.
 */
export const REPORT_ANNOUNCEMENTS = ["back", "working"] as const;
export type ReportAnnouncement = (typeof REPORT_ANNOUNCEMENTS)[number];

/**
 * How long after a post the daemon waits to see the session stop before announcing the report as
 * still working. A post always happens mid-turn, so "back" can trail the post by up to this.
 */
export const REPORT_ANNOUNCE_GRACE_MS = 20_000;

/**
 * Who posted a report, as it was known at post time, so the report can be named after its
 * session is gone. `key` is `resident:<profileId>` for a resident, so every run of one resident
 * is one author, and `session:<sessionId>` for anything else.
 */
export interface ReportAuthor {
  /** The raw voice-on and voice-off names at post time. Older rows have just name. */
  labels?: { spoken: string; fallback: string };
  /** Present when the spoken label is a reference name. True while that label is active. */
  referenceNameActive?: boolean;
  key: string;
  name: string;
  residentProfileId: string | null;
}

export function reportAuthorName(author: ReportAuthor, voice: boolean): string {
  return author.labels ? (voice ? author.labels.spoken : author.labels.fallback) : author.name;
}

export function reportAuthorLabel(author: ReportAuthor, voice?: boolean): string {
  const name = voice === undefined ? author.name : reportAuthorName(author, voice);
  const reference = author.referenceNameActive !== undefined && (voice ?? author.referenceNameActive);
  return reference ? quotedReferenceName(name) : name;
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
  /**
   * When a return digest counted this report, or null. The digest already told the operator about
   * it, so it raises no notification in any window afterwards: not when a stamp still pending
   * lands, and not when a window that missed its stamp reconnects, reloads, or outlives a daemon
   * restart. Held by the daemon in memory until a dashboard claims the digest, and stored from
   * then on: a restart before the claim loses the digest, so it loses the mark too.
   */
  countedInDigestAt: number | null;
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
 * When to post a report, as shipped: the part of the tool's description the operator may edit in
 * Settings > Reports (`reports.guidance`), and what Reset to default puts back.
 */
export const DEFAULT_REPORT_GUIDANCE =
  "Post a report when your operator asked you for one, or when you have finished something they " +
  "must read in order to act: a diagnosis, the result of an investigation, a summary of work to " +
  "review.";

/**
 * The fixed half of the when-to-report paragraph, which no edit replaces: progress belongs on
 * `report_status`, and anything urgent or anything the operator must decide is a question.
 */
export const REPORT_GUIDANCE_RULES =
  "Do not post progress here; use report_status for that. Anything urgent, or anything " +
  "that needs the operator's decision, is a question: use request_input instead.";

/**
 * The most report ids one `POST /api/reports/read-all` carries. Mark all read sends the ids the
 * Reports section lists in batches of this size, so a section of any length is cleared while
 * each request stays bounded.
 */
export const REPORT_READ_ALL_BATCH = 1000;

/** The longest report guidance the operator may save. */
export const REPORT_GUIDANCE_LIMIT = 2000;

/**
 * The guidance in force: the operator's own text, or the default while none is saved. Blank
 * text counts as none, so a cleared box never leaves the tool with nothing to say.
 */
export function effectiveReportGuidance(stored: string | null | undefined): string {
  const text = stored?.trim();
  return text ? text : DEFAULT_REPORT_GUIDANCE;
}

/** The when-to-report paragraph `post_report`'s description carries, for a stored guidance. */
export function postReportGuidance(stored: string | null | undefined): string {
  return `${effectiveReportGuidance(stored)} ${REPORT_GUIDANCE_RULES}`;
}

/** The paragraph with the default guidance: what the tool says when the daemon does not answer. */
export const REPORT_GUIDANCE = postReportGuidance(null);

/**
 * One muted author (`report_mutes`). A muted agent can still post; from the moment of the mute
 * its reports raise no notification, are left out of the inbox list, the to read figure and the
 * Away digest, and stay in its conversation. A mute never marks a report read, so unmuting brings
 * back every report still waiting.
 */
export interface ReportMute {
  /** The author key the reports carry: `resident:<profileId>` or `session:<sessionId>`. */
  authorKey: string;
  /** The author's display name when it was muted, so Settings can name it after it is gone. */
  authorName: string;
  isReferenceName?: true;
  mutedAt: number;
}

/** The muted author keys, for the fold, the notifier and the Away watcher to test against. */
export function mutedAuthorKeys(mutes: readonly Pick<ReportMute, "authorKey">[] | undefined): ReadonlySet<string> {
  return new Set((mutes ?? []).map((mute) => mute.authorKey));
}

/** The tool result: the report's id, and that nothing waits on a reply. */
export function reportReceipt(report: Pick<ReportItem, "id" | "version">): string {
  const replaced = report.version > 1 ? " It replaces your earlier report in the operator's inbox." : "";
  return (
    `Report ${report.id} posted to your operator's inbox.${replaced} Do not wait for a reply: ` +
    "carry on with your work, or end your turn if you are done. If you need to correct or update " +
    `it, post again with replaces: "${report.id}".`
  );
}

// ---- replying to a report, and following one up (Phase 3) ----

/** How long ago a report was posted, as the reply names it: "just now", "12 minutes ago". */
export function reportAgeText(createdAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The message a reply delivers: a line naming the report it answers, the report restated, then
 * the operator's words. Self-contained, as an async answer is, so the agent needs no memory of
 * the report to act on the reply.
 */
export function reportReplyText(
  report: Pick<ReportItem, "id" | "title" | "body" | "createdAt">,
  words: string,
  now: number,
): string {
  return [
    `Reply to your report '${report.title}' (${report.id}), posted ${reportAgeText(report.createdAt, now)}.`,
    "",
    "Your report:",
    report.title,
    "",
    report.body.trim(),
    "",
    "Your operator's reply:",
    words.trim(),
  ].join("\n");
}

/**
 * A note naming an agent's reports its operator has not read yet, or null when there are none.
 * Only reports still waiting to be read count: a read or replaced one has been dealt with.
 */
export function unseenReportsNote(
  reports: readonly Pick<ReportItem, "id" | "title" | "readAt" | "supersededBy">[],
): string | null {
  const unseen = reports.filter(reportToRead);
  if (unseen.length === 0) return null;
  const listed = unseen.map((report) => `${report.id} '${report.title}'`).join(", ");
  return unseen.length === 1
    ? `Your operator has not read your report ${listed} yet.`
    : `Your operator has not read ${unseen.length} of your reports yet: ${listed}.`;
}

/**
 * Which report "{name}, mark read" means: the report open on screen when it is that author's,
 * else the author's only report waiting to be read, else none (two or more, and none open).
 */
export function resolveMarkReadTarget<R extends Pick<ReportItem, "id" | "author" | "readAt" | "supersededBy">>(
  authorKey: string,
  reports: readonly R[],
  openReportId: string | null,
): R | null {
  const mine = reports.filter((report) => report.author.key === authorKey && reportToRead(report));
  const open = openReportId === null ? undefined : mine.find((report) => report.id === openReportId);
  if (open) return open;
  return mine.length === 1 ? mine[0]! : null;
}

/**
 * Where a reply to a report can go, which decides what its card offers:
 *
 * - `live`: a session that can take a message, the poster itself or, for a resident, the run
 *   of that resident that is running now. The card draws a reply box.
 * - `unreachable`: a standard session that has not ended but cannot take a message now (no pane
 *   to write to, or driven by a pipeline engine). It is still running, so a follow-up would start a
 *   second session beside it: the card says so and offers neither a reply nor a follow-up.
 * - `resident-not-running`: a resident with no session that can take a message. The card says so
 *   and says to launch it from the Residents drawer, as text: there is no control for it here.
 * - `gone`: a standard session that has ended (exited, or no longer present). The card offers
 *   Start a follow-up task, which
 *   dispatches a new session in the report's repository. A completed session is never resumed.
 * - `gone-no-repository`: the same, for a report that stored no repository, so no follow-up can
 *   be started from the card.
 */
export type ReplyTarget =
  | { kind: "live"; sessionId: string }
  | { kind: "unreachable"; sessionId: string }
  | { kind: "resident-not-running" }
  | { kind: "gone" }
  | { kind: "gone-no-repository" };

/** The session fields `replyTarget` reads. */
export type ReplyTargetSession = Messageable & Pick<Session, "id" | "state"> & { task?: { id: string } | null };

/** Whether a session can take a reply now: present, not exited, and able to receive a message. */
function takesReply(session: ReplyTargetSession): boolean {
  return session.state !== "exited" && canMessage(session);
}

export function replyTarget(
  report: Pick<ReportItem, "sessionId" | "repository" | "author">,
  sessions: readonly ReplyTargetSession[],
  residentRuns: readonly Pick<ResidentRunSummary, "profileId" | "taskId">[],
): ReplyTarget {
  const own = sessions.find((session) => session.id === report.sessionId);
  if (own && takesReply(own)) return { kind: "live", sessionId: own.id };
  const profileId = report.author.residentProfileId;
  if (profileId !== null) {
    // A resident is one author across its runs, so a reply reaches whichever run is up now.
    for (const run of residentRuns) {
      if (run.profileId !== profileId) continue;
      const current = sessions.find((session) => session.task?.id === run.taskId);
      if (current && takesReply(current)) return { kind: "live", sessionId: current.id };
    }
    return { kind: "resident-not-running" };
  }
  // Ended means exited or gone from the fleet, never merely unable to take a message: a session
  // that is still running is not replaced by a follow-up.
  if (own && own.state !== "exited") return { kind: "unreachable", sessionId: own.id };
  return report.repository ? { kind: "gone" } : { kind: "gone-no-repository" };
}

/** Why a reply cannot be delivered, for a target that is not live. */
export function replyRefusal(target: Exclude<ReplyTarget, { kind: "live" }>, name: string): string {
  switch (target.kind) {
    case "unreachable":
      return `${name}'s session is still running but cannot take a message from here, so it can neither be replied to nor followed up.`;
    case "resident-not-running":
      return `${name} isn't running. Launch it again from the Residents drawer to reply.`;
    case "gone":
      return "That session has ended and is never resumed. Start a follow-up task instead.";
    case "gone-no-repository":
      return "That session has ended, and the report recorded no repository to start a follow-up task in.";
  }
}

/**
 * The kind a follow-up task is filed as: the report's own task's kind when it is a shipping kind
 * (`isShippingTaskKind`), otherwise ship. A plan or pipeline task needs inputs a report does not
 * carry, a chat cannot be filed to the backlog to be dispatched as a second step, and a resident
 * is launched only from its profile.
 */
export function followUpKind(kind: TaskKind | undefined): TaskKind {
  return kind && isShippingTaskKind(kind) ? kind : "ship";
}

/** The title of a follow-up task. */
export function followUpTitle(report: Pick<ReportItem, "title">): string {
  const title = `Follow up: ${report.title}`;
  return title.length > REPORT_LIMITS.title ? `${title.slice(0, REPORT_LIMITS.title - 1)}…` : title;
}

/**
 * A follow-up task's intent: the operator's words, then the report as context. The session that
 * posted the report has ended, so the new session reads everything it needs here. The words are
 * never empty: a follow-up task is only filed with the operator's instructions.
 */
export function followUpIntent(
  report: Pick<ReportItem, "id" | "title" | "body" | "url" | "document" | "author">,
  words: string,
): string {
  const lines = [
    words.trim(),
    "",
    `This follows up a report (${report.id}) that ${report.author.name} posted before its session ended. ` +
      "That session is not resumed; this is a new task, and the report below is its context.",
    "",
    `Report: ${report.title}`,
    "",
    report.body.trim(),
  ];
  if (report.url) lines.push("", `Link: ${report.url}`);
  if (report.document) lines.push("", `Attached document: ${report.document.name}`);
  return lines.join("\n");
}

/**
 * Where a report stands, as its conversation entry says it: waiting to be read, replaced by a
 * later version, or how the operator cleared it.
 */
export function reportEntryStatus(report: Pick<ReportItem, "readBy" | "readAt" | "supersededBy">): string {
  if (report.readAt !== null) {
    switch (report.readBy) {
      case "reply":
        return "Replied to";
      case "follow-up":
        return "Followed up in a new task";
      case "mark-all":
        return "Read, with Mark all read";
      case "mark-read":
      case null:
        return "Read";
    }
  }
  if (report.supersededBy !== null) return "Replaced by a later version";
  return "Waiting to be read";
}
