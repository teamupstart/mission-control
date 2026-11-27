import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { agentDisplayName, sessionDisplayNameInput, withCurrentReferenceNames } from "@shared/display-name.ts";
import { INBOX_FLAG } from "@shared/inbox.ts";
import { VOICE_FLAG } from "@shared/voice.ts";
import { launchFailureOutcome } from "@shared/launch-failure.ts";
import type { PostReportBody } from "@shared/protocol.ts";
import {
  REPORT_ANNOUNCE_GRACE_MS,
  REPORT_LIMITS,
  replyRefusal,
  replyTarget,
  reportAuthorName,
  reportAuthorLabel,
  reportDocumentKind,
  reportId,
  reportReplyText,
  reportToRead,
  residentAuthorKey,
  sessionAuthorKey,
  type ReplyTarget,
  type ReportAnnouncement,
  type ReportAuthor,
  type ReportDocumentKind,
  type ReportItem,
  type ReportMute,
  type ReportReadBy,
} from "@shared/reports.ts";
import { reportBucket, sessionWorkspaceRoot } from "@shared/session.ts";
import type { PendingTurn, ServerEvent, Session, Task } from "@shared/types.ts";
import { STATE_DIR } from "./config.ts";
import { getTask as getDurableTask, inTransaction, openDb } from "./db.ts";
import { featureEnabled, onFeatureFlagsChanged } from "./feature-flags/index.ts";
import { resolveCheckoutFile } from "./archives/checkout.ts";
import type { ReportPagePublication, ReportPagePublicationResult } from "./archives/manager.ts";
import type { Registry } from "./registry.ts";
import {
  buildReportPage,
  linkedCompanionPaths,
  readStoredReportCompanions,
  REPORT_COMPANIONS_DIR,
  reportDocumentDir,
  type ReportCompanion,
} from "./report-document.ts";
import { readFileWithinCap, resolveSessionFilePath, SessionFileError } from "./session-files.ts";
import { unref } from "./util/timers.ts";

/**
 * Agent reports: what an agent posts with `post_report` for the operator to read.
 *
 * The one owner of the `reports` table. A report is deliberately not a review: it never enters
 * `reviews`, so it raises no `pendingReviews`, holds no completion, counts toward no question
 * limit, closes on no merge, and Foreman (which reads reviews and registered evidence) never sees
 * it. It is also deliberately not session-scoped state: a session leaving never removes or
 * clears a report, because a report outlives the session that posted it. Everything a report
 * needs to be drawn after its session is gone - the author's name, task, repository and resident
 * profile - is copied onto the row at post time.
 *
 * `markRead` is the one place a report becomes read. The one way back is a follow-up whose launch
 * failed with no session (`reconcileFollowUp`), so its Retry is offered again. `announce` is the
 * one place a report is stamped `back` or `working`, and the stamp is why this manager watches
 * session events: a post always happens mid-turn, so whether the agent then stopped is only known
 * afterwards.
 */

/** A refused post or operator action, with the HTTP status the route answers. */
export class ReportRefusal extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 413) {
    super(message);
  }
}

/** Why a post was refused: a linked file exists in the checkout but could not be read. */
function unreadableCompanion(path: string, error: NodeJS.ErrnoException): ReportRefusal {
  return new ReportRefusal(
    `${path}, which the document links to, could not be read (${error.code ?? error.message}); nothing was posted. Post again once it is readable, or remove the link.`,
    409,
  );
}

/** What a reply hands the outbox: one operator message for one session. */
export type SubmitOperatorTurn = (sessionId: string, text: string) => { ok: boolean; error?: string; pendingTurn?: PendingTurn };

/**
 * How a follow-up reaches the task manager, so this owner of the `reports` table never writes
 * the `tasks` table itself. The routes build it over the same task creation and dispatch the
 * Dispatch form uses.
 */
export interface FollowUpTaskPort {
  /**
   * File the follow-up as a backlog task in `report.repository`, and call `record` with its id
   * inside the transaction that writes the task row, so the task never exists without the report
   * naming it. A throw from `record` rolls the task back.
   */
  create(
    report: ReportItem,
    words: string,
    record: (taskId: string) => void,
  ): Promise<{ ok: true; taskId: string } | { ok: false; status: 400 | 404 | 409 | 503; error: string }>;
  /**
   * Whether the task can still be this report's follow-up: it exists and was not cancelled. A
   * cancelled task is never launched by a dispatch, so it is forgotten like a deleted one.
   */
  exists(taskId: string): boolean;
  /**
   * Dispatch the task. The task manager starts the launch in the background, so the task row may
   * still read `backlog` after this resolves; a task already dispatched is answered `ok` and not
   * launched again.
   */
  dispatch(taskId: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

/** What a follow-up came to. A failed dispatch still names the task it created. */
export type FollowUpOutcome =
  | { ok: true; report: ReportItem; taskId: string }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string; report: ReportItem | null; taskId: string | null };

/**
 * How Publish as scout reaches the archive, so this owner of the `reports` table never writes the
 * archive library itself. The routes build it over `ArchiveManager.publishReportPage`.
 */
export interface ReportPublisherPort {
  publish(input: ReportPagePublication): Promise<ReportPagePublicationResult>;
  /**
   * Whether the archive a report recorded is still in the library. Presence only: a bundle that
   * is there but no longer verifies keeps the report's key rather than being taken for gone.
   */
  exists(key: string): Promise<boolean>;
}

/** What Publish as scout came to. A refused page names every problem the checker found. */
export type PublishOutcome =
  | { ok: true; report: ReportItem; archiveKey: string; replayed: boolean }
  | { ok: false; status: 404 | 409 | 422 | 500 | 503; error: string; problems: string[]; report: ReportItem | null };

interface Row {
  seq: number;
  id: string;
  session_id: string;
  task_id: string | null;
  repository: string | null;
  author_key: string;
  author_name: string;
  author_spoken_name: string | null;
  author_is_reference_name: number;
  author_resident_profile_id: string | null;
  title: string;
  body: string;
  url: string | null;
  document_name: string | null;
  document_kind: string | null;
  root_id: string;
  version: number;
  superseded_by: string | null;
  created_at: number;
  root_created_at: number;
  opened_at: number | null;
  read_at: number | null;
  read_by: string | null;
  follow_up_task_id: string | null;
  announced_as: string | null;
  announced_at: number | null;
  published_archive_key: string | null;
  counted_in_digest_at: number | null;
}

/** How many published reports the startup archive check reads per page. */
const PUBLISHED_REPORT_PAGE = 200;

const nullableNumber = (value: number | null): number | null => (value === null ? null : Number(value));

function fromRow(row: Row): ReportItem {
  const author: ReportAuthor = { key: row.author_key, name: row.author_name, residentProfileId: row.author_resident_profile_id };
  if (row.author_spoken_name) {
    author.labels = { fallback: row.author_name, spoken: row.author_spoken_name };
    if (row.author_is_reference_name) author.referenceNameActive = featureEnabled(VOICE_FLAG);
    author.name = reportAuthorName(author, featureEnabled(VOICE_FLAG));
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    repository: row.repository,
    author,
    title: row.title,
    body: row.body,
    url: row.url,
    document: row.document_name && row.document_kind
      ? { name: row.document_name, kind: row.document_kind as ReportDocumentKind }
      : null,
    rootId: row.root_id,
    version: Number(row.version),
    supersededBy: row.superseded_by,
    createdAt: Number(row.created_at),
    rootCreatedAt: Number(row.root_created_at),
    openedAt: nullableNumber(row.opened_at),
    readAt: nullableNumber(row.read_at),
    readBy: row.read_by as ReportReadBy | null,
    followUpTaskId: row.follow_up_task_id,
    announcedAs: row.announced_as as ReportItem["announcedAs"],
    announcedAt: nullableNumber(row.announced_at),
    publishedArchiveKey: row.published_archive_key,
    countedInDigestAt: nullableNumber(row.counted_in_digest_at),
  };
}

function readRow(id: string): Row | undefined {
  return openDb().prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row | undefined;
}

// Where a report's attached document is stored, beside the reader and the page builder that read
// it back.
export { reportDocumentDir };

/** A document read from the session's checkout, ready to be stored with its report. */
interface StagedDocument {
  name: string;
  kind: ReportDocumentKind;
  bytes: Buffer;
  /** The files the document links to inside its own directory, read when it was attached. */
  companions: ReportCompanion[];
}

/** The timer the announce grace period runs on, injectable so a test can own the clock. */
export interface ReportTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: ReportTimers = {
  set: (fn, ms) => unref(setTimeout(fn, ms)),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * A report waiting for its announce stamp. `working` is what the session was last seen doing:
 * `true` once it has been seen working; `false` when what it was seen doing says nothing (an
 * unconfirmed idle state, as an uninstrumented session always reads); and `null` when its state
 * is to be read at the next sighting - a report found unstamped at startup, whose session has not
 * been seen yet, or one posted while the session was in a state that does say something but not
 * working (confirmed idle, or blocked on you).
 */
interface AnnounceWatch {
  sessionId: string;
  working: boolean | null;
  timer: unknown;
  /**
   * The report's grace period has ended while its session had still not been seen since a
   * restart. The session's first sighting then decides the wording at once.
   */
  deadlinePassed: boolean;
  /**
   * The wording already decided, while its stamp waits to be written again after a failed write.
   * Later sightings and the grace period no longer change it: only the retry stamps it.
   */
  stamping: ReportAnnouncement | null;
  /** How many times writing that stamp has failed. */
  failedWrites: number;
}

/**
 * How long a stamp whose write failed waits before it is written again: 5 s after the first
 * failure, doubling each time up to a minute, so a briefly busy database costs seconds.
 */
const REPORT_STAMP_RETRY_MS = 5_000;
const REPORT_STAMP_RETRY_MAX_MS = 60_000;
/**
 * Failed writes after which a stamp is given up, about two minutes after the first. A failure
 * that lasts that long (a read-only state dir, a full disk) is not a busy database, and the report
 * goes unannounced, as one does when the daemon stops past its deadline: it is still in the
 * inbox, waiting to be read.
 */
const REPORT_STAMP_MAX_FAILED_WRITES = 6;

const isWorking = (session: Session): boolean => reportBucket(session) === "working";

/**
 * Whether a session's state says nothing about stopping: unconfirmed and idle, as an
 * uninstrumented session always reads. Blocked on you (a menu, an open question) is evidence of
 * stopping whatever the hooks say, and a confirmed state is evidence either way.
 */
const saysNothing = (session: Session): boolean => !session.stateConfirmed && reportBucket(session) === "idle";

/** How a watch starts from what its session is seen doing: see `AnnounceWatch.working`. */
const watchStart = (session: Session): boolean | null =>
  isWorking(session) ? true : saysNothing(session) ? false : null;

export interface ReportManagerOptions {
  /** The state home documents are copied under. Defaults to the daemon's. */
  stateDir?: string;
  now?: () => number;
  timers?: ReportTimers;
  /**
   * Called with each linked companion's resolved path after its containment check and before it
   * is opened. A test seam for the window a symlink swap would race; the daemon passes none.
   */
  beforeCompanionOpen?: (path: string) => Promise<void> | void;
  /** Called with the checkout root after the document was read, before companions are collected. A test seam. */
  beforeCompanionCapture?: (root: string) => Promise<void> | void;
}

export class ReportManager {
  private readonly stateDir: string;
  private readonly beforeCompanionOpen?: (path: string) => Promise<void> | void;
  private readonly beforeCompanionCapture?: (root: string) => Promise<void> | void;
  private readonly now: () => number;
  private readonly timers: ReportTimers;
  private readonly stopFlags: () => void;
  private readonly stopTasks: () => void;
  /**
   * The launch-failure record (its `at`) each follow-up task already carried when this process
   * dispatched it, which is an earlier attempt's and never reopens a report. Cleared once the
   * task no longer carries a record. Lost on restart, when every open record counts, which is
   * right: a task still showing a failure after a restart never got its session.
   */
  private readonly staleFailures = new Map<string, number>();
  /** The follow-up in flight for each report, so two calls for one report run one after the other. */
  private readonly followUps = new Map<string, Promise<FollowUpOutcome>>();
  private readonly stopEvents: () => void;
  /** Reports waiting for their announce stamp, by id. Bounded by posts in the last grace period. */
  private readonly watches = new Map<string, AnnounceWatch>();
  /**
   * Digest marks not written to the table yet: report id to when a closed Away window's digest
   * counted it. The digest waits in the Away watcher's memory until a dashboard claims it, so its
   * marks wait here beside it and reach the table only once it is claimed (`digestClaimed`). Every
   * report this manager reads carries them (`item`), so each window is told at once. A daemon
   * restart before the claim loses the digest and this manager, and the marks go with them: a
   * report no digest will ever show is not kept quiet as if one had.
   */
  private readonly unclaimedDigestMarks = new Map<string, number>();
  /** The publication in flight for each report, chained the same way. */
  private readonly publications = new Map<string, Promise<unknown>>();

  constructor(private readonly registry: Registry, options: ReportManagerOptions = {}) {
    this.stateDir = options.stateDir ?? STATE_DIR;
    this.beforeCompanionOpen = options.beforeCompanionOpen;
    this.beforeCompanionCapture = options.beforeCompanionCapture;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? REAL_TIMERS;
    this.stopEvents = registry.subscribe((event) => this.observe(event));
    // Muted authors are handed to the registry before any report, so the first snapshot after a
    // restart never lists a muted author's reports.
    this.registry.setReportMutes(this.listMutes());
    // Every report still waiting to be read is handed to the registry once, so the snapshot
    // carries it from the first connect after a restart. One the daemon stopped before stamping
    // is stamped from its session's state: sessions are re-adopted after startup, so that state
    // is read when the session is first seen, or when the grace period ends. The grace period
    // keeps its original deadline, 20 seconds after the post: a restart neither extends it nor
    // restarts it.
    //
    // Only a report whose deadline passed at most one more grace period ago is recovered: that
    // is a post the restart interrupted. Anything older stays unstamped and silent - every report
    // posted before stamping existed has no stamp, and stamping a backlog of them on the first
    // start would raise one notification per report long after anyone needed it.
    for (const report of this.listToRead()) {
      this.registry.upsertReport(report);
      const deadline = report.createdAt + REPORT_ANNOUNCE_GRACE_MS;
      if (report.announcedAs === null && deadline + REPORT_ANNOUNCE_GRACE_MS >= this.now()) {
        this.watch(report.id, report.sessionId, null, Math.max(0, deadline - this.now()));
      }
    }
    // The snapshot omits reports while the `inbox` flag is off, and the registry sends no report
    // event then. Turning the flag on resends what is waiting, so an open window fills its
    // Reports section and its to read figure without a reload.
    let wasOn = featureEnabled(INBOX_FLAG);
    let voiceWasOn = featureEnabled(VOICE_FLAG);
    this.stopFlags = onFeatureFlagsChanged(() => {
      const on = featureEnabled(INBOX_FLAG);
      const voiceOn = featureEnabled(VOICE_FLAG);
      const resend = on && !wasOn;
      if (resend || voiceWasOn !== voiceOn) {
        this.registry.setReportMutes(this.listMutes());
        for (const report of this.registry.reportsToRead()) {
          const name = reportAuthorName(report.author, voiceOn);
          const hasReference = report.author.referenceNameActive !== undefined;
          if (name !== report.author.name || (hasReference && voiceOn !== report.author.referenceNameActive)) {
            const author = { ...report.author, name };
            if (hasReference) author.referenceNameActive = voiceOn;
            this.registry.upsertReport({ ...report, author });
          } else if (resend) this.registry.upsertReport(report);
        }
      }
      voiceWasOn = voiceOn;
      wasOn = on;
    });
    // A follow-up's report follows its task: cleared once the task has started, however it was
    // started, and back in to read when its launch failed with no session. Watched here, and
    // checked once now for anything that changed while the daemon was down.
    this.stopTasks = this.registry.subscribe((event) => {
      if (event.type === "task_upsert") this.reconcileFollowUp(event.task);
      else if (event.type === "task_remove") this.forgetFollowUpTask(event.id, "removed");
    });
    for (const row of openDb()
      .prepare("SELECT DISTINCT follow_up_task_id FROM reports WHERE follow_up_task_id IS NOT NULL AND (read_at IS NULL OR read_by = 'follow-up')")
      .all() as Array<{ follow_up_task_id: string }>) {
      const task = this.registry.getTask(row.follow_up_task_id) ?? getDurableTask(row.follow_up_task_id);
      // Deleted while the daemon was down: treated now as `task_remove` would have been.
      if (task) this.reconcileFollowUp(task);
      else this.forgetFollowUpTask(row.follow_up_task_id, "removed");
    }
  }

  /** The state home this manager stores documents under, which the document route reads from. */
  get documentStateDir(): string {
    return this.stateDir;
  }

  stop(): void {
    this.stopFlags();
    this.stopTasks();
    this.stopEvents();
    for (const watch of this.watches.values()) this.timers.clear(watch.timer);
    this.watches.clear();
  }

  /** A stored report as every reader sees it: with its digest mark, claimed or not yet. */
  private item(row: Row): ReportItem {
    const report = fromRow(row);
    const unclaimed = this.unclaimedDigestMarks.get(report.id);
    return report.countedInDigestAt === null && unclaimed !== undefined
      ? { ...report, countedInDigestAt: unclaimed }
      : report;
  }

  private getRow(id: string): ReportItem | null {
    const row = readRow(id);
    return row ? this.item(row) : null;
  }

  /**
   * A closed window's return digest has counted these reports. Each is marked and every window is
   * told, so no window raises a notification for it afterwards, whenever and however its stamp
   * reaches that window. That includes a report stamped while you were away: a window that missed
   * the stamp's event, because its stream was down, first sees it stamped in a reconnect snapshot,
   * and the mark is what keeps that snapshot quiet. The first count's time is kept.
   *
   * Held in memory until the digest is claimed (`digestClaimed`), because the digest itself is:
   * written now, a restart before the claim would lose the digest and keep the mark, so the report
   * would be announced by neither.
   */
  countedInDigest(ids: readonly string[]): void {
    const at = this.now();
    for (const id of ids) {
      if (this.unclaimedDigestMarks.has(id)) continue;
      const before = this.getRow(id);
      if (!before || before.countedInDigestAt !== null) continue;
      this.unclaimedDigestMarks.set(id, at);
      this.registry.upsertReport({ ...before, countedInDigestAt: at });
    }
  }

  /**
   * A dashboard has claimed the digest: its marks are written to the table, with the time each was
   * counted, so they now outlive a daemon restart (a window that reloads, reconnects or outlives
   * the restart stays quiet when a stamp still pending lands). Nothing a window sees changes.
   */
  digestClaimed(): void {
    if (this.unclaimedDigestMarks.size === 0) return;
    const mark = openDb().prepare(
      "UPDATE reports SET counted_in_digest_at = ? WHERE id = ? AND counted_in_digest_at IS NULL",
    );
    for (const [id, at] of this.unclaimedDigestMarks) mark.run(at, id);
    this.unclaimedDigestMarks.clear();
  }

  /** Wait for a report's session to stop, or for the grace period to end, then stamp it. */
  private watch(id: string, sessionId: string, working: boolean | null, delayMs = REPORT_ANNOUNCE_GRACE_MS): void {
    const timer = this.timers.set(() => this.graceEnded(id), delayMs);
    this.watches.set(id, { sessionId, working, timer, deadlinePassed: false, stamping: null, failedWrites: 0 });
  }

  /**
   * A session change, read against every report still waiting for its stamp. Leaving working is
   * what "back" means, so a report is stamped `back` only once its session was seen working and
   * then not, or once the session is gone. A session never seen working (an uninstrumented one)
   * gives no such evidence, and its report is announced as still working when the grace ends.
   */
  private observe(event: ServerEvent): void {
    if (this.watches.size === 0) return;
    if (event.type === "session_remove") {
      for (const [id, watch] of this.watches) {
        if (watch.sessionId === event.id && watch.stamping === null) this.announce(id, "back");
      }
      return;
    }
    if (event.type !== "session_upsert") return;
    const working = isWorking(event.session);
    for (const [id, watch] of this.watches) {
      if (watch.sessionId !== event.session.id || watch.stamping !== null) continue;
      // Found at startup and first seen idle with an unconfirmed state (uninstrumented, or
      // re-adopted before a hook confirmed it): that says nothing about stopping, so it is the
      // same no-evidence case as a post whose session was never seen working. A session blocked
      // on you (a visible menu, an open question) has stopped whatever its hooks say, and reads
      // as back below.
      if (watch.working === null && saysNothing(event.session)) {
        if (watch.deadlinePassed) this.announce(id, "working");
        else watch.working = false;
        continue;
      }
      // Unknown (found at startup) reads the state as it is now; otherwise only a change from
      // working counts. A post that said nothing (unconfirmed idle) reads as stopped as soon
      // as the session says so: blocked on you, or a hook confirming the turn ended. First seen
      // working after the deadline already passed, it kept going through the grace period.
      if (!working && (watch.working !== false || !saysNothing(event.session))) this.announce(id, "back");
      else if (working && watch.working === null && watch.deadlinePassed) this.announce(id, "working");
      else if (working) watch.working = true;
    }
  }

  private graceEnded(id: string): void {
    const watch = this.watches.get(id);
    if (!watch) return;
    if (watch.stamping !== null) {
      this.announce(id, watch.stamping);
      return;
    }
    const session = this.registry.getSession(watch.sessionId);
    // Found at startup, and its session not re-adopted yet: absence says nothing so soon after a
    // restart. Its first sighting decides the wording, and a session still unseen one grace
    // period later is taken to be gone.
    if (!session && watch.working === null && !watch.deadlinePassed) {
      watch.deadlinePassed = true;
      watch.timer = this.timers.set(() => this.graceEnded(id), REPORT_ANNOUNCE_GRACE_MS);
      return;
    }
    const gone = !session || session.state === "exited";
    // A report found at startup is stamped from the state its session has now; one watched since
    // its post kept going through the whole grace period.
    if (gone) this.announce(id, "back");
    // An unconfirmed state is no evidence the session stopped.
    else if (watch.working === null) {
      this.announce(id, isWorking(session) || saysNothing(session) ? "working" : "back");
    }
    else this.announce(id, "working");
  }

  /**
   * Stamp how a report is announced, once, and tell every window: the stamp is what raises the
   * report's notification. A report read or replaced before its stamp is left unstamped, since
   * there is nothing left to announce.
   *
   * Called from the registry's event loop and from timers, so it never throws. A failed write (a
   * busy database) keeps the watch, with its wording decided, and writes the same stamp again
   * shortly, backing off: dropping it at once would leave the report never announced. A write
   * still failing after `REPORT_STAMP_MAX_FAILED_WRITES` attempts is given up with one last log.
   */
  private announce(id: string, as: ReportAnnouncement): void {
    const watch = this.watches.get(id);
    let changed: boolean;
    try {
      changed = openDb().prepare(
        `UPDATE reports SET announced_as = ?, announced_at = ?
         WHERE id = ? AND announced_as IS NULL AND read_at IS NULL AND superseded_by IS NULL`,
      ).run(as, this.now(), id).changes > 0;
    } catch (err) {
      if (!watch) {
        console.error(`[reports] stamping ${id} failed:`, err);
        return;
      }
      this.timers.clear(watch.timer);
      watch.failedWrites += 1;
      if (watch.failedWrites >= REPORT_STAMP_MAX_FAILED_WRITES) {
        this.watches.delete(id);
        console.error(`[reports] stamping ${id} failed ${watch.failedWrites} times; giving up, so it will not notify:`, err);
        return;
      }
      console.error(`[reports] stamping ${id} failed; trying again:`, err);
      watch.stamping = as;
      const delay = Math.min(REPORT_STAMP_RETRY_MS * 2 ** (watch.failedWrites - 1), REPORT_STAMP_RETRY_MAX_MS);
      watch.timer = this.timers.set(() => this.graceEnded(id), delay);
      return;
    }
    if (watch) this.timers.clear(watch.timer);
    this.watches.delete(id);
    if (!changed) return;
    // Stamped: a failed read now costs only this event, and a window's next snapshot carries it.
    try {
      const report = this.getRow(id);
      if (report) this.registry.upsertReport(report);
    } catch (err) {
      console.error(`[reports] reading ${id} after its stamp failed:`, err);
    }
  }

  get(id: string): ReportItem | null {
    return this.getRow(id);
  }

  /**
   * A report, and the latest report of its chain when it has been replaced, so a notification
   * raised for an earlier version can open the one that took its place. Null for an unknown id.
   */
  resolve(id: string): { report: ReportItem; latest: ReportItem | null } | null {
    const report = this.getRow(id);
    if (!report) return null;
    if (report.supersededBy === null) return { report, latest: null };
    const row = openDb()
      .prepare("SELECT * FROM reports WHERE root_id = ? AND superseded_by IS NULL ORDER BY seq DESC LIMIT 1")
      .get(report.rootId) as Row | undefined;
    return { report, latest: row ? this.item(row) : null };
  }

  /** Every report waiting to be read, oldest first. */
  listToRead(): ReportItem[] {
    return (openDb()
      .prepare("SELECT * FROM reports WHERE read_at IS NULL AND superseded_by IS NULL ORDER BY seq")
      .all() as unknown as Row[]).map((row) => this.item(row));
  }

  /** Every report a session posted, every version, read or not, oldest first. */
  listForSession(sessionId: string): ReportItem[] {
    return (openDb()
      .prepare("SELECT * FROM reports WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as unknown as Row[]).map((row) => this.item(row));
  }

  /** One author's reports that are still waiting to be read, which are the ones it may replace. */
  openReportsBy(authorKey: string): ReportItem[] {
    return (openDb()
      .prepare("SELECT * FROM reports WHERE author_key = ? AND read_at IS NULL AND superseded_by IS NULL ORDER BY seq")
      .all(authorKey) as unknown as Row[]).map((row) => this.item(row));
  }

  /** Who a session is, as a report records it: a resident by its profile, anything else by itself. */
  authorFor(session: Session): ReportAuthor {
    const runs = this.registry.listResidentRuns();
    const run = session.task ? runs.find((candidate) => candidate.taskId === session.task!.id) : undefined;
    const names = withCurrentReferenceNames(runs, this.registry.listResidentProfiles());
    const fallback = agentDisplayName(sessionDisplayNameInput(session, names)).name;
    const display = agentDisplayName(sessionDisplayNameInput(session, names, true));
    const spoken = display.name;
    const reference = display.source === "reference-name";
    return {
      ...(spoken !== fallback || reference ? { labels: { spoken, fallback } } : {}),
      ...(reference && { referenceNameActive: featureEnabled(VOICE_FLAG) }),
      key: run ? residentAuthorKey(run.profileId) : sessionAuthorKey(session.id),
      // A call sign or reference name names the author only while voice is on.
      name: featureEnabled(VOICE_FLAG) ? spoken : fallback,
      residentProfileId: run?.profileId ?? null,
    };
  }

  /**
   * Store a report from `session` and tell every window. Refuses a `replaces` that is not one of
   * this author's own reports still waiting to be read, naming the ones it could have meant, and a
   * document that is not an `.html` or `.md` file inside the session's checkout within the cap.
   */
  async post(session: Session, input: PostReportBody): Promise<ReportItem> {
    const author = this.authorFor(session);
    const replaced = input.replaces ? this.replaceable(author, input.replaces) : null;
    const document = input.file ? await this.stageDocument(session, input.file) : null;
    const now = this.now();
    // The directory a document was copied into during the transaction, if any. The copy lands
    // before the transaction commits, so a commit that then fails, or anything thrown after the
    // copy, would otherwise leave a document under an id no row will ever name.
    let storedDir: string | null = null;
    let result: { created: ReportItem; superseded: ReportItem | null };
    try {
      result = inTransaction(() => {
        // Re-checked inside the transaction: a Mark read or another replacement that landed while
        // the document was being read must not leave two latest reports in one chain.
        const current = replaced ? this.getRow(replaced.id) : null;
        if (replaced && (!current || !reportToRead(current))) {
          throw new ReportRefusal(this.replaceRefusal(author, input.replaces!), 409);
        }
        const d = openDb();
        const placeholder = `pending:${randomUUID()}`;
        const inserted = d.prepare(
          `INSERT INTO reports (id, session_id, task_id, repository, author_key, author_name, author_spoken_name,
             author_is_reference_name, author_resident_profile_id, title, body, url, document_name, document_kind, root_id,
             version, created_at, root_created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          placeholder, session.id, session.task?.id ?? null, session.repoRoot ?? null, author.key, author.labels?.fallback ?? author.name,
          author.labels?.spoken ?? null, Number(author.referenceNameActive !== undefined), author.residentProfileId, input.title, input.body, input.url ?? null, document?.name ?? null,
          document?.kind ?? null, replaced?.rootId ?? placeholder, replaced ? replaced.version + 1 : 1, now,
          replaced?.rootCreatedAt ?? now,
        );
        const id = reportId(Number(inserted.lastInsertRowid));
        d.prepare("UPDATE reports SET id = ?, root_id = CASE WHEN root_id = ? THEN ? ELSE root_id END WHERE seq = ?")
          .run(id, placeholder, id, Number(inserted.lastInsertRowid));
        if (replaced) d.prepare("UPDATE reports SET superseded_by = ? WHERE id = ?").run(id, replaced.id);
        // Written last inside the transaction, so a failed write rolls the row back with it.
        if (document) {
          this.storeDocument(id, document);
          storedDir = reportDocumentDir(id, this.stateDir);
        }
        return { created: this.getRow(id)!, superseded: replaced ? this.getRow(replaced.id) : null };
      });
    } catch (error) {
      // The row was rolled back (`inTransaction` rolls back on a throw from the callback and on
      // a failed COMMIT alike), so the copy is now a document no row names: remove it.
      if (storedDir) rmSync(storedDir, { recursive: true, force: true });
      throw error;
    }
    const { created, superseded } = result;
    if (superseded) this.registry.upsertReport(superseded);
    this.registry.upsertReport(created);
    const live = this.registry.getSession(session.id) ?? session;
    // Posted mid-turn, so the state now is either working, no evidence, or one that says the
    // session has stopped (confirmed idle, or blocked on you), read the same way a restart reads it.
    this.watch(created.id, session.id, watchStart(live));
    return created;
  }

  /** The report `replaces` names, when this author may replace it. */
  private replaceable(author: ReportAuthor, id: string): ReportItem {
    const prior = this.getRow(id);
    if (!prior || prior.author.key !== author.key || !reportToRead(prior)) {
      throw new ReportRefusal(this.replaceRefusal(author, id), 409);
    }
    return prior;
  }

  /**
   * Why `replaces` was refused, with every report the agent could have meant, so a resident that
   * lost the id can retry with the right one.
   */
  private replaceRefusal(author: ReportAuthor, id: string): string {
    const open = this.openReportsBy(author.key);
    const why = `${id} is not one of your reports waiting to be read, so it cannot be replaced.`;
    if (open.length === 0) return `${why} You have none; post without replaces.`;
    const listed = open.map((report) => `${report.id} "${report.title}"`).join(", ");
    return `${why} Your reports waiting to be read: ${listed}. Pass one of those ids, or post without replaces.`;
  }

  /** Read the attached document from inside the session's checkout, under the size cap. */
  private async stageDocument(session: Session, file: string): Promise<StagedDocument> {
    const kind = reportDocumentKind(file);
    if (!kind) throw new ReportRefusal(`${file} is not an .html or .md file`, 400);
    const root = sessionWorkspaceRoot(session);
    if (!root) throw new ReportRefusal("this session has no checkout to attach a file from", 400);
    let target: string;
    try {
      // The Files viewer's containment check: relative, inside the checkout through symlinks,
      // and a regular file.
      target = await resolveSessionFilePath(root, file);
    } catch (error) {
      if (error instanceof SessionFileError) {
        throw new ReportRefusal(`${file}: ${error.message}`, error.status === 403 ? 403 : error.status === 404 ? 404 : 400);
      }
      throw error;
    }
    const handle = await open(target, constants.O_RDONLY);
    let bytes: Buffer;
    try {
      const read = await readFileWithinCap(handle, REPORT_LIMITS.documentBytes);
      if (read.exceeded) {
        throw new ReportRefusal(`${file} is larger than the ${REPORT_LIMITS.documentBytes / 1024 / 1024} MiB a report may attach`, 413);
      }
      bytes = Buffer.from(read.bytes);
    } finally {
      await handle.close();
    }
    return { name: basename(target), kind, bytes, companions: await this.stageCompanions(root, file, kind, bytes) };
  }

  /**
   * Read the files the document links to inside its own directory, so Publish as scout can
   * archive them with the page after the checkout is gone. Never refuses the report: a linked
   * file that is missing, outside the checkout, not a regular file or past the bounds is left
   * out, and the published page lists it as missing instead.
   */
  private async stageCompanions(root: string, file: string, kind: ReportDocumentKind, bytes: Buffer): Promise<ReportCompanion[]> {
    await this.beforeCompanionCapture?.(root);
    // A checkout that is gone has no companions. One that cannot be resolved for another reason
    // (permissions, I/O) refuses the post, so its linked files are not silently left out.
    const realRoot = await realpath(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw new ReportRefusal(
        `the checkout could not be read to collect the files the document links to (${error.code ?? error.message}); nothing was posted. Post again once it is readable.`,
        409,
      );
    });
    if (!realRoot) return [];
    const directory = posix.dirname(file);
    const companions: ReportCompanion[] = [];
    let total = 0;
    for (const path of linkedCompanionPaths(kind, bytes).slice(0, REPORT_LIMITS.companionLookups)) {
      if (companions.length >= REPORT_LIMITS.companionFiles) break;
      // The scout capture's containment rule: every component is checked with `lstat` and none
      // may be a symlink, and the file's identity is recorded here, before the open.
      const relative = posix.join(directory, path);
      // The containment check says only that the path was refused. A file that is absent, or
      // that the check refused for its shape (a symlink, not a regular file), is left out. One
      // that exists but cannot even be examined (permissions, I/O) refuses the post with its
      // cause, so the report can be posted again once it is readable, rather than being stored
      // without data that was there.
      const leaveOut = async (): Promise<void> => {
        await lstat(join(realRoot, ...relative.split("/"))).catch((error: NodeJS.ErrnoException) => {
          if (["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(error.code ?? "")) return null;
          throw unreadableCompanion(path, error);
        });
      };
      const resolved = await resolveCheckoutFile(realRoot, relative);
      if (!resolved.ok) {
        await leaveOut();
        continue;
      }
      await this.beforeCompanionOpen?.(resolved.path);
      // `O_NOFOLLOW` refuses a symlink swapped into the final component after that check. A
      // directory on the way swapped for a symlink is still followed by `open`, so the handle's
      // identity must be the one resolved above: a file reached through a swapped parent is a
      // different file, and is left out rather than read.
      // `O_NONBLOCK` so a named pipe swapped in after the check cannot hold the open waiting for
      // a writer; the regular-file check below rejects it.
      const handle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        .catch((error: NodeJS.ErrnoException) => {
          // Gone, or swapped for a symlink or a socket, since the check: left out, as a missing
          // file is. Any other failure is the file being unreadable, which refuses the post.
          if (["ENOENT", "ENOTDIR", "ELOOP", "ENXIO"].includes(error.code ?? "")) return null;
          throw unreadableCompanion(path, error);
        });
      if (!handle) continue;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.dev !== resolved.dev || info.ino !== resolved.ino) continue;
        // The identity alone does not prove where the handle was reached from: a directory moved
        // out of the checkout and replaced by a symlink to its new place still holds the same
        // file. So containment is checked again now that the file is open, before any byte is
        // read. Every component must still be a real directory inside the checkout, and the path
        // must still name the file the handle holds.
        const again = await resolveCheckoutFile(realRoot, relative);
        if (!again.ok) {
          await leaveOut();
          continue;
        }
        if (again.dev !== info.dev || again.ino !== info.ino) continue;
        if (info.size > REPORT_LIMITS.companionBytes - total) continue;
        const read = await readFileWithinCap(handle, info.size);
        if (read.exceeded) continue;
        total += read.bytes.byteLength;
        companions.push({ path, bytes: Buffer.from(read.bytes) });
      } finally {
        await handle.close();
      }
    }
    return companions;
  }

  /** Copy a document under its report's directory, through a rename so no half file is left. */
  private storeDocument(id: string, document: StagedDocument): void {
    const dir = reportDocumentDir(id, this.stateDir);
    mkdirSync(dir, { recursive: true });
    const temporary = join(dir, `.${document.name}.partial`);
    try {
      writeFileSync(temporary, document.bytes);
      renameSync(temporary, join(dir, document.name));
      if (document.companions.length > 0) {
        // Staged under a dot name and renamed into place whole: a reader that finds the
        // directory finds every companion in it.
        const staging = join(dir, `.${REPORT_COMPANIONS_DIR}.partial`);
        for (const companion of document.companions) {
          const path = join(staging, ...companion.path.split("/"));
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, companion.bytes);
        }
        renameSync(staging, join(dir, REPORT_COMPANIONS_DIR));
      }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Record the first time the operator opened a report. Later opens change nothing. */
  markOpened(id: string): ReportItem | null {
    const changed = openDb().prepare("UPDATE reports SET opened_at = ? WHERE id = ? AND opened_at IS NULL")
      .run(this.now(), id).changes > 0;
    const report = this.getRow(id);
    if (changed && report) this.registry.upsertReport(report);
    return report;
  }

  /**
   * The one way a single report becomes read. Sets `readAt` and `readBy` once; a report already
   * read keeps the first time and the first way. `markAllRead` writes the same two columns, under
   * the same guard, for a whole batch at once.
   */
  markRead(id: string, readBy: ReportReadBy): ReportItem | null {
    const changed = openDb().prepare("UPDATE reports SET read_at = ?, read_by = ? WHERE id = ? AND read_at IS NULL")
      .run(this.now(), readBy, id).changes > 0;
    const report = this.getRow(id);
    if (changed && report) this.registry.upsertReport(report);
    return report;
  }

  /**
   * Mark all read for exactly these ids, which are the reports the Reports section listed when it
   * was pressed, as `mark-all`. A report not named stays unread, however recently it arrived.
   * Answers the reports this call took out of to read; an unknown id, or one already read, changes
   * nothing.
   *
   * One batch is one transaction, and nothing is announced until it commits: a write that fails
   * partway rolls the whole batch back, so a refused request leaves every report it named unread
   * and no window was told otherwise. Every report in a batch is read at the same moment.
   */
  markAllRead(ids: readonly string[]): ReportItem[] {
    const at = this.now();
    const clearedIds = inTransaction(() => {
      const mark = openDb().prepare(
        "UPDATE reports SET read_at = ?, read_by = 'mark-all' WHERE id = ? AND read_at IS NULL",
      );
      return [...new Set(ids)].filter((id) => mark.run(at, id).changes > 0);
    });
    const cleared: ReportItem[] = [];
    for (const id of clearedIds) {
      const report = this.getRow(id);
      if (!report) continue;
      cleared.push(report);
      this.registry.upsertReport(report);
    }
    return cleared;
  }

  /** Muted report authors, oldest mute first. */
  listMutes(): ReportMute[] {
    const voice = featureEnabled(VOICE_FLAG);
    return (openDb()
      .prepare("SELECT author_key, author_name, author_spoken_name, author_is_reference_name, muted_at FROM report_mutes ORDER BY muted_at, author_key")
      .all() as Array<{ author_key: string; author_name: string; author_spoken_name: string | null; author_is_reference_name: number; muted_at: number }>)
      .map((row) => ({
        authorKey: row.author_key,
        authorName: voice ? row.author_spoken_name ?? row.author_name : row.author_name,
        ...(voice && row.author_is_reference_name ? { isReferenceName: true as const } : {}),
        mutedAt: Number(row.muted_at),
      }));
  }

  /**
   * Mute an author's reports, from now on. Named by the name its latest report stored, so
   * Settings can list it after its session is gone. Null when no report carries that author key:
   * a mute is offered on a report card, so there is always one. Muting twice keeps the first
   * mute's time. Never touches `reports`: nothing is marked read, and posting is never refused.
   */
  mute(authorKey: string): ReportMute | null {
    const latest = openDb()
      .prepare("SELECT author_name, author_spoken_name, author_is_reference_name FROM reports WHERE author_key = ? ORDER BY seq DESC LIMIT 1")
      .get(authorKey) as { author_name: string; author_spoken_name: string | null; author_is_reference_name: number } | undefined;
    if (!latest) return null;
    openDb()
      .prepare("INSERT INTO report_mutes (author_key, author_name, author_spoken_name, author_is_reference_name, muted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(author_key) DO NOTHING")
      .run(authorKey, latest.author_name, latest.author_spoken_name, latest.author_is_reference_name, this.now());
    const mutes = this.listMutes();
    this.registry.setReportMutes(mutes);
    return mutes.find((mute) => mute.authorKey === authorKey) ?? null;
  }

  /**
   * Unmute an author. Its reports still waiting to be read are listed and counted again, since
   * a mute never marked them read. False when the author was not muted.
   */
  unmute(authorKey: string): boolean {
    const removed = openDb().prepare("DELETE FROM report_mutes WHERE author_key = ?").run(authorKey).changes > 0;
    if (removed) this.registry.setReportMutes(this.listMutes());
    return removed;
  }

  /**
   * Keep a follow-up's report in step with its task.
   *
   * - **Started** (a session, or dispatching, running, done or hibernated, with no open launch
   *   failure): the report is cleared as `follow-up`, however the task was started. One held by
   *   Pause all and started later from the Backlog leaves to read the moment it starts, not only
   *   when someone presses Retry.
   * - **Failed with no session surviving it** (`not-started` or `returned`; a `kept` failure left
   *   an agent that may be working): the report goes back to to read, still naming its task, so
   *   the card offers Retry, which dispatches that same task.
   *
   * Decided by the task's own record, never by comparing times, so a failure in the same
   * millisecond as the clearing counts. The one record that does not count is the one the task
   * already carried when this process dispatched it (`staleFailures`): a retried task keeps its
   * old record until its relaunch clears it, and that old failure is not this attempt's. A
   * failure that lands before the report is stamped is caught when `runFollowUp` reconciles
   * right after stamping, so no order of the two leaves a cleared report with no session.
   */
  private reconcileFollowUp(task: Task): void {
    // Cancelled: it will never run, so it is no longer anyone's follow-up.
    if (task.status === "cancelled") {
      this.forgetFollowUpTask(task.id, "cancelled");
      return;
    }
    const outcome = launchFailureOutcome(task);
    if (outcome === "not-started" || outcome === "returned") {
      if (this.staleFailures.has(task.id) && this.staleFailures.get(task.id) === task.launchFailure!.at) return;
      const rows = openDb()
        .prepare("SELECT id FROM reports WHERE follow_up_task_id = ? AND read_by = 'follow-up'")
        .all(task.id) as Array<{ id: string }>;
      for (const { id } of rows) {
        const reopened = openDb()
          .prepare("UPDATE reports SET read_at = NULL, read_by = NULL WHERE id = ? AND read_by = 'follow-up'")
          .run(id).changes > 0;
        const report = this.getRow(id);
        if (reopened && report) this.registry.upsertReport(report);
      }
      return;
    }
    // Relaunched or settled: whatever it carried before is no longer a record to ignore.
    if (!task.launchFailure) this.staleFailures.delete(task.id);
    if (!followUpStarted(task)) return;
    const waiting = openDb()
      .prepare("SELECT id FROM reports WHERE follow_up_task_id = ? AND read_at IS NULL")
      .all(task.id) as Array<{ id: string }>;
    for (const { id } of waiting) this.markRead(id, "follow-up");
  }

  /**
   * A follow-up task that no longer answers its report: every report naming it forgets it, so it
   * waits in to read and its card offers the instructions box for a new follow-up. Driven by the
   * task itself, since a read report has no inbox card through which the follow-up route could
   * notice.
   *
   * - `cancelled`: it will never run, so it answers nothing, and a `follow-up` clearing it gave is
   *   dropped too.
   * - `removed` (`task_remove`, or gone from the store at startup): a removal says nothing about
   *   what the task did. A report it cleared was dispatched, and one that ran and was later
   *   deleted or pruned did its work, so that clearing stands and the report is left alone. Only a
   *   report still waiting (a held or failed follow-up that never started) forgets the task.
   *   Removing a running task normally follows cancelling it, which reopened the report already.
   */
  private forgetFollowUpTask(taskId: string, why: "cancelled" | "removed"): void {
    const rows = openDb()
      .prepare(why === "cancelled"
        ? "SELECT id FROM reports WHERE follow_up_task_id = ?"
        : "SELECT id FROM reports WHERE follow_up_task_id = ? AND read_at IS NULL")
      .all(taskId) as Array<{ id: string }>;
    for (const { id } of rows) {
      const changed = openDb().prepare(
        `UPDATE reports SET follow_up_task_id = NULL,
           read_at = CASE WHEN read_by = 'follow-up' THEN NULL ELSE read_at END,
           read_by = CASE WHEN read_by = 'follow-up' THEN NULL ELSE read_by END
         WHERE id = ? AND follow_up_task_id = ?`,
      ).run(id, taskId).changes > 0;
      const report = this.getRow(id);
      if (changed && report) this.registry.upsertReport(report);
    }
  }

  /** Where a reply to `report` goes now: the same rule the card draws from. */
  replyTargetFor(report: ReportItem): ReplyTarget {
    return replyTarget(report, this.registry.liveSessions(), this.registry.listResidentRuns());
  }

  /**
   * Deliver the operator's reply as an ordinary operator message that names and restates the
   * report, and mark the report read once the outbox has accepted it. A busy session queues it
   * and the report is read all the same; a session that cannot take it refuses, and the report
   * stays unread.
   */
  reply(id: string, words: string, submit: SubmitOperatorTurn): { report: ReportItem; sessionId: string; pendingTurn: PendingTurn | null } {
    const report = this.getRow(id);
    if (!report) throw new ReportRefusal("no such report", 404);
    // Only a report still waiting is answered: a reply to a replaced version would restate what
    // the agent has since corrected, and one to a read report would not say how it was cleared.
    if (report.supersededBy !== null) {
      throw new ReportRefusal(`This report was replaced by ${report.supersededBy}. Reply to that version instead.`, 409);
    }
    if (report.readAt !== null) throw new ReportRefusal("This report has already been read.", 409);
    const target = this.replyTargetFor(report);
    if (target.kind !== "live") throw new ReportRefusal(replyRefusal(target, reportAuthorLabel(report.author)), 409);
    const sent = submit(target.sessionId, reportReplyText(report, words, this.now()));
    if (!sent.ok) throw new ReportRefusal(sent.error ?? "the message could not be queued", 409);
    return { report: this.markRead(id, "reply") ?? report, sessionId: target.sessionId, pendingTurn: sent.pendingTurn ?? null };
  }

  /**
   * Start a follow-up task for a report whose agent is gone: a new session in the report's
   * repository, never the old one resumed. Refused while the agent can still take a reply. Two recorded steps. The task is created once and its
   * id stored on the report with the task row; then it is dispatched, and only a dispatch that
   * succeeds marks the report read. A failed dispatch leaves the report unread and naming its
   * task, so calling again dispatches that same task rather than creating a second.
   */
  followUp(id: string, words: string, port: FollowUpTaskPort): Promise<FollowUpOutcome> {
    const previous = this.followUps.get(id) ?? Promise.resolve(null);
    const run = previous.catch(() => null).then(() => this.runFollowUp(id, words, port)).finally(() => {
      // Every window learns the outcome once, when the run settles: read on a dispatched
      // follow-up, or naming its task (the card's Retry) after a refused or failed dispatch. Not
      // before: a report naming a task and still unread reads as "created but not started", so
      // publishing it while the dispatch is still in flight would flash that on success.
      const settled = this.getRow(id);
      if (settled) this.registry.upsertReport(settled);
    });
    this.followUps.set(id, run);
    void run.finally(() => {
      if (this.followUps.get(id) === run) this.followUps.delete(id);
    }).catch(() => undefined);
    return run;
  }

  private async runFollowUp(id: string, words: string, port: FollowUpTaskPort): Promise<FollowUpOutcome> {
    const refuse = (status: 404 | 409, error: string, report: ReportItem | null): FollowUpOutcome =>
      ({ ok: false, status, error, report, taskId: report?.followUpTaskId ?? null });
    let report = this.getRow(id);
    if (!report) return refuse(404, "no such report", null);
    if (report.author.residentProfileId !== null) {
      return refuse(409, `${reportAuthorLabel(report.author)} is a resident: launch it again from the Residents drawer and reply to it there.`, report);
    }
    // A task that was deleted or cancelled is normally forgotten the moment it happens, by the
    // task watcher (`forgetFollowUpTask`). This is the fallback for one it has not seen yet, and
    // it follows the removal rule: a report the follow-up already answered stays answered (it was
    // dispatched and may have done its work), so the call changes nothing and is refused; only a
    // report still waiting forgets the task, and its card goes back to the instructions box.
    if (report.followUpTaskId !== null && !port.exists(report.followUpTaskId)) {
      if (report.readBy === "follow-up") return refuse(409, "This report has already been read.", report);
      this.forgetFollowUpTask(report.followUpTaskId, "removed");
      report = this.getRow(id)!;
      if (!words.trim()) {
        return refuse(409, "The follow-up task was deleted or cancelled. Write what the follow-up should do and start a new one.", report);
      }
    }
    let taskId = report.followUpTaskId;
    if (taskId === null) {
      // The reply route's line: a new follow-up answers only a report still waiting. A replaced
      // version would restate what the agent has since corrected, and a report already cleared
      // would keep its first clearing while a task ran for it. (Relaunching a recorded task, the
      // other branch, is unaffected.)
      if (report.supersededBy !== null) {
        return refuse(409, `This report was replaced by ${report.supersededBy}. Follow up that version instead.`, report);
      }
      if (report.readAt !== null) return refuse(409, "This report has already been read.", report);
      // A follow-up stands in for a reply only when the session has ended. One that can still
      // take a message is answered with a reply, and one that is still running but cannot take
      // one is not replaced by a second session beside it.
      const target = this.replyTargetFor(report);
      if (target.kind === "live") {
        return refuse(409, `${reportAuthorLabel(report.author)} is still running: reply to it instead of starting a follow-up task.`, report);
      }
      if (target.kind === "unreachable") return refuse(409, replyRefusal(target, reportAuthorLabel(report.author)), report);
      if (!report.repository) {
        return refuse(409, "This report recorded no repository, so a follow-up task cannot be started from it.", report);
      }
      // A follow-up task is only ever filed with the operator's instructions. That keeps every
      // wordless call (Retry, a double press after the card went back to its box) from filing a
      // task that would start on the report alone: wordless, this route only relaunches.
      if (!words.trim()) {
        return refuse(409, "Write what the follow-up task should do, then start it.", report);
      }
      let created: Awaited<ReturnType<FollowUpTaskPort["create"]>>;
      try {
        created = await port.create(report, words, (newTaskId) => {
          const stamped = openDb()
            .prepare("UPDATE reports SET follow_up_task_id = ? WHERE id = ? AND follow_up_task_id IS NULL")
            .run(newTaskId, id).changes > 0;
          if (!stamped) throw new ReportRefusal("a follow-up task was already started for this report", 409);
        });
      } catch (error) {
        if (error instanceof ReportRefusal) return refuse(error.status === 404 ? 404 : 409, error.message, this.getRow(id));
        throw error;
      }
      if (!created.ok) return { ok: false, status: created.status, error: created.error, report: this.getRow(id), taskId: null };
      taskId = created.taskId;
      // Not published yet: `followUp` publishes the report once the dispatch has an outcome.
      report = this.getRow(id)!;
    }
    // A follow-up whose dispatch succeeded marked the report read with "follow-up" in the same
    // step, so that stamp, not the task row (which the launch updates later), says it was sent.
    if (report.readBy !== "follow-up") {
      // The record the task carries now, if any, belongs to an earlier attempt: remembered so it
      // is never taken for this attempt's failure.
      const before = this.registry.getTask(taskId)?.launchFailure;
      if (before) this.staleFailures.set(taskId, before.at);
      else this.staleFailures.delete(taskId);
      const dispatched = await port.dispatch(taskId);
      if (!dispatched.ok) {
        return { ok: false, status: 409, error: dispatched.error, report: this.getRow(id), taskId };
      }
    }
    this.markRead(id, "follow-up");
    // The launch runs in the background and may already have failed, before the stamp above,
    // when the task event found nothing to reopen. Reconciled now from the task's record.
    const task = this.registry.getTask(taskId);
    if (task) this.reconcileFollowUp(task);
    return { ok: true, report: this.getRow(id) ?? report, taskId };
  }

  /**
   * Clear `key` from every report published under it, unconditionally, and tell every window.
   * Only for a caller already inside that report's publication queue that has just found the
   * archive gone (`runPublish`); anything else uses `reconcilePublishedArchives`, which re-checks
   * inside the queue so it cannot undo a publish that landed meanwhile.
   */
  private forgetArchive(key: string): void {
    const rows = openDb().prepare("SELECT id FROM reports WHERE published_archive_key = ?").all(key) as Array<{ id: string }>;
    if (rows.length === 0) return;
    openDb().prepare("UPDATE reports SET published_archive_key = NULL WHERE published_archive_key = ?").run(key);
    for (const { id } of rows) {
      const report = this.getRow(id);
      if (report) this.registry.upsertReport(report);
    }
  }

  /**
   * Publish as scout: archive the report's stored document as a scout archive, because the
   * operator pressed the control. The page is built from the stored copy alone (`buildReportPage`),
   * never from a checkout and never from the request. Idempotent: a report already published
   * answers with its archive and publishes nothing, and two presses run one after the other.
   * Publishing never marks a report read and never records that it was opened.
   */
  publish(id: string, port: ReportPublisherPort): Promise<PublishOutcome> {
    return this.inPublicationQueue(id, () => this.runPublish(id, port));
  }

  /**
   * One report's publication work, one step at a time: a publish and a reconciliation of the same
   * report never interleave, so a reconciliation cannot clear a key a publish has just written.
   */
  private inPublicationQueue<T>(id: string, step: () => Promise<T>): Promise<T> {
    const previous = this.publications.get(id) ?? Promise.resolve(null);
    const run = previous.catch(() => null).then(step);
    this.publications.set(id, run);
    void run.finally(() => {
      if (this.publications.get(id) === run) this.publications.delete(id);
    }).catch(() => undefined);
    return run;
  }

  /**
   * Clear recorded archive keys whose archive is gone, so those cards offer Publish as scout
   * again. Resolves to the ids whose key was cleared.
   *
   * With no `keys`, every published report is checked: the daemon does this once at startup, which
   * heals a delete interrupted between removing the bundle and clearing the key. With `keys`, only reports recorded under those keys are checked: the daemon
   * passes exactly the keys an archive reconciliation pass pruned, so the work after a library
   * change follows the archives that disappeared, never the number of published reports.
   *
   * Each report is re-checked inside its publication queue, so a publish that lands meanwhile wins.
   */
  /**
   * The published reports a reconciliation checks: those recorded under `keys`, or with no keys
   * every published report, read in bounded keyset pages so startup never loads them all at once.
   */
  private *publishedReports(keys?: readonly string[]): Generator<{ id: string; archiveKey: string }> {
    if (keys) {
      yield* openDb()
        .prepare(`SELECT id, published_archive_key AS archiveKey FROM reports WHERE published_archive_key IN (${keys.map(() => "?").join(", ")})`)
        .all(...keys) as Array<{ id: string; archiveKey: string }>;
      return;
    }
    let after = 0;
    for (;;) {
      const page = openDb()
        .prepare(`SELECT seq, id, published_archive_key AS archiveKey FROM reports
          WHERE published_archive_key IS NOT NULL AND seq > ? ORDER BY seq LIMIT ?`)
        .all(after, PUBLISHED_REPORT_PAGE) as Array<{ seq: number; id: string; archiveKey: string }>;
      for (const row of page) yield { id: row.id, archiveKey: row.archiveKey };
      if (page.length < PUBLISHED_REPORT_PAGE) return;
      after = Number(page[page.length - 1]!.seq);
    }
  }

  async reconcilePublishedArchives(
    exists: (key: string) => Promise<boolean>,
    keys?: readonly string[],
  ): Promise<string[]> {
    if (keys && keys.length === 0) return [];
    const cleared: string[] = [];
    for (const { id, archiveKey } of this.publishedReports(keys)) {
      const gone = await this.inPublicationQueue(id, async () => {
        if (this.getRow(id)?.publishedArchiveKey !== archiveKey) return false;
        // A check that fails (the library unreadable right now) is not an absence: that key is
        // left alone and the next check decides.
        let present: boolean;
        try {
          present = await exists(archiveKey);
        } catch (error) {
          console.warn(`[reports] could not check archive ${archiveKey} for ${id}; its key is kept:`, error);
          return false;
        }
        if (present) return false;
        const changed = openDb()
          .prepare("UPDATE reports SET published_archive_key = NULL WHERE id = ? AND published_archive_key = ?")
          .run(id, archiveKey).changes > 0;
        const report = changed ? this.getRow(id) : null;
        if (report) this.registry.upsertReport(report);
        return changed;
      });
      if (gone) cleared.push(id);
    }
    return cleared;
  }

  private async runPublish(id: string, port: ReportPublisherPort): Promise<PublishOutcome> {
    const refuse = (status: Exclude<PublishOutcome, { ok: true }>["status"], problems: string[], report: ReportItem | null): PublishOutcome =>
      ({ ok: false, status, error: problems[0] ?? "the report could not be published", problems, report });
    const report = this.getRow(id);
    if (!report) return refuse(404, ["no such report"], null);
    if (!report.document) return refuse(409, ["This report has no attached document, so there is nothing to publish."], report);
    if (report.publishedArchiveKey) {
      let present: boolean;
      try {
        present = await port.exists(report.publishedArchiveKey);
      } catch (error) {
        // Cannot tell whether the archive is there: keep the key and say so, never republish.
        const why = error instanceof Error ? error.message : String(error);
        return refuse(500, [`could not check whether archive ${report.publishedArchiveKey} is still in the library: ${why}`], report);
      }
      if (present) {
        return { ok: true, report, archiveKey: report.publishedArchiveKey, replayed: true };
      }
      // The archive it recorded is gone (deleted from disk, or by a route this manager did not
      // hear about). The operator pressed Publish, so publish it again rather than answering
      // with a key that leads nowhere.
      this.forgetArchive(report.publishedArchiveKey);
    }
    const built = await buildReportPage(report, this.stateDir);
    if (!built.ok) return refuse(built.status, built.problems, report);
    let companions: ReportCompanion[];
    try {
      companions = await readStoredReportCompanions(report, built.page, this.stateDir);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return refuse(500, [`could not read the files stored with this report: ${why}`], report);
    }
    const published = await port.publish({
      reportId: report.id,
      reportCreatedAt: report.createdAt,
      title: report.title,
      page: built.page,
      companions,
      documentName: report.document.name,
      session: { id: report.sessionId, name: report.author.name, taskId: report.taskId },
      repositoryLabel: report.repository ? basename(report.repository) : null,
    });
    if (!published.ok) return refuse(published.status, published.problems, this.getRow(id));
    openDb().prepare("UPDATE reports SET published_archive_key = ? WHERE id = ? AND published_archive_key IS NULL")
      .run(published.key, id);
    const stamped = this.getRow(id)!;
    this.registry.upsertReport(stamped);
    return { ok: true, report: stamped, archiveKey: stamped.publishedArchiveKey ?? published.key, replayed: published.replayed };
  }
}

/** Whether a follow-up's task has started: it has a session, or it has left the backlog to run. */
function followUpStarted(task: Task): boolean {
  if (task.sessionId) return true;
  switch (task.status) {
    case "dispatching":
    case "running":
    case "done":
    case "hibernated":
      return true;
    case "backlog":
    case "cancelled":
    case "failed":
      return false;
  }
}
