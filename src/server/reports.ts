import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join } from "node:path";
import { agentDisplayName, sessionDisplayNameInput } from "@shared/display-name.ts";
import { INBOX_FLAG } from "@shared/inbox.ts";
import { launchFailureOutcome } from "@shared/launch-failure.ts";
import type { PostReportBody } from "@shared/protocol.ts";
import {
  REPORT_LIMITS,
  replyRefusal,
  replyTarget,
  reportDocumentKind,
  reportId,
  reportReplyText,
  reportToRead,
  residentAuthorKey,
  sessionAuthorKey,
  type ReplyTarget,
  type ReportAuthor,
  type ReportDocumentKind,
  type ReportItem,
  type ReportReadBy,
} from "@shared/reports.ts";
import { sessionWorkspaceRoot } from "@shared/session.ts";
import type { PendingTurn, Session, Task } from "@shared/types.ts";
import { STATE_DIR } from "./config.ts";
import { getTask as getDurableTask, inTransaction, openDb } from "./db.ts";
import { featureEnabled, onFeatureFlagsChanged } from "./feature-flags/index.ts";
import type { ReportPagePublication, ReportPagePublicationResult } from "./archives/manager.ts";
import type { Registry } from "./registry.ts";
import { buildReportPage, reportDocumentDir } from "./report-document.ts";
import { readFileWithinCap, resolveSessionFilePath, SessionFileError } from "./session-files.ts";

/**
 * Agent reports: what an agent posts with `post_report` for the operator to read.
 *
 * The one owner of the `reports` table. A report is deliberately not a review: it never enters
 * `reviews`, so it raises no `pendingReviews`, holds no completion, counts toward no question
 * limit, closes on no merge, and Foreman (which reads reviews and registered evidence) never sees
 * it. It is also deliberately not session-scoped state: this manager does NOT subscribe to
 * `session_remove`, because a report outlives the session that posted it. Everything a report
 * needs to be drawn after its session is gone - the author's name, task, repository and resident
 * profile - is copied onto the row at post time.
 *
 * `markRead` is the one place a report becomes read. The one way back is a follow-up whose launch
 * failed with no session (`reconcileFollowUp`), so its Retry is offered again.
 */

/** A refused post or operator action, with the HTTP status the route answers. */
export class ReportRefusal extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 413) {
    super(message);
  }
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
}

const nullableNumber = (value: number | null): number | null => (value === null ? null : Number(value));

function fromRow(row: Row): ReportItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    repository: row.repository,
    author: { key: row.author_key, name: row.author_name, residentProfileId: row.author_resident_profile_id },
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
  };
}

function getRow(id: string): ReportItem | null {
  const row = openDb().prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

// Where a report's attached document is stored, beside the reader and the page builder that read
// it back.
export { reportDocumentDir };

/** A document read from the session's checkout, ready to be stored with its report. */
interface StagedDocument {
  name: string;
  kind: ReportDocumentKind;
  bytes: Buffer;
}

export interface ReportManagerOptions {
  /** The state home documents are copied under. Defaults to the daemon's. */
  stateDir?: string;
  now?: () => number;
}

export class ReportManager {
  private readonly stateDir: string;
  private readonly now: () => number;
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
  /** The publication in flight for each report, chained the same way. */
  private readonly publications = new Map<string, Promise<unknown>>();

  constructor(private readonly registry: Registry, options: ReportManagerOptions = {}) {
    this.stateDir = options.stateDir ?? STATE_DIR;
    this.now = options.now ?? Date.now;
    // Every report still waiting to be read is handed to the registry once, so the snapshot
    // carries it from the first connect after a restart.
    for (const report of this.listToRead()) this.registry.upsertReport(report);
    // The snapshot omits reports while the `inbox` flag is off, and the registry sends no report
    // event then. Turning the flag on resends what is waiting, so an open window fills its
    // Reports section and its to read figure without a reload.
    let wasOn = featureEnabled(INBOX_FLAG);
    this.stopFlags = onFeatureFlagsChanged(() => {
      const on = featureEnabled(INBOX_FLAG);
      if (on && !wasOn) for (const report of this.registry.reportsToRead()) this.registry.upsertReport(report);
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
  }

  get(id: string): ReportItem | null {
    return getRow(id);
  }

  /** Every report waiting to be read, oldest first. */
  listToRead(): ReportItem[] {
    return (openDb()
      .prepare("SELECT * FROM reports WHERE read_at IS NULL AND superseded_by IS NULL ORDER BY seq")
      .all() as unknown as Row[]).map(fromRow);
  }

  /** Every report a session posted, every version, read or not, oldest first. */
  listForSession(sessionId: string): ReportItem[] {
    return (openDb()
      .prepare("SELECT * FROM reports WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as unknown as Row[]).map(fromRow);
  }

  /** One author's reports that are still waiting to be read, which are the ones it may replace. */
  private openReportsBy(authorKey: string): ReportItem[] {
    return (openDb()
      .prepare("SELECT * FROM reports WHERE author_key = ? AND read_at IS NULL AND superseded_by IS NULL ORDER BY seq")
      .all(authorKey) as unknown as Row[]).map(fromRow);
  }

  /** Who a session is, as a report records it: a resident by its profile, anything else by itself. */
  authorFor(session: Session): ReportAuthor {
    const runs = this.registry.listResidentRuns();
    const run = session.task ? runs.find((candidate) => candidate.taskId === session.task!.id) : undefined;
    return {
      key: run ? residentAuthorKey(run.profileId) : sessionAuthorKey(session.id),
      name: agentDisplayName(sessionDisplayNameInput(session, runs)).name,
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
        const current = replaced ? getRow(replaced.id) : null;
        if (replaced && (!current || !reportToRead(current))) {
          throw new ReportRefusal(this.replaceRefusal(author, input.replaces!), 409);
        }
        const d = openDb();
        const placeholder = `pending:${randomUUID()}`;
        const inserted = d.prepare(
          `INSERT INTO reports (id, session_id, task_id, repository, author_key, author_name,
             author_resident_profile_id, title, body, url, document_name, document_kind, root_id,
             version, created_at, root_created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          placeholder, session.id, session.task?.id ?? null, session.repoRoot ?? null, author.key, author.name,
          author.residentProfileId, input.title, input.body, input.url ?? null, document?.name ?? null,
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
        return { created: getRow(id)!, superseded: replaced ? getRow(replaced.id) : null };
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
    return created;
  }

  /** The report `replaces` names, when this author may replace it. */
  private replaceable(author: ReportAuthor, id: string): ReportItem {
    const prior = getRow(id);
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
    try {
      const { bytes, exceeded } = await readFileWithinCap(handle, REPORT_LIMITS.documentBytes);
      if (exceeded) {
        throw new ReportRefusal(`${file} is larger than the ${REPORT_LIMITS.documentBytes / 1024 / 1024} MiB a report may attach`, 413);
      }
      return { name: basename(target), kind, bytes: Buffer.from(bytes) };
    } finally {
      await handle.close();
    }
  }

  /** Copy a document under its report's directory, through a rename so no half file is left. */
  private storeDocument(id: string, document: StagedDocument): void {
    const dir = reportDocumentDir(id, this.stateDir);
    mkdirSync(dir, { recursive: true });
    const temporary = join(dir, `.${document.name}.partial`);
    try {
      writeFileSync(temporary, document.bytes);
      renameSync(temporary, join(dir, document.name));
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Record the first time the operator opened a report. Later opens change nothing. */
  markOpened(id: string): ReportItem | null {
    const changed = openDb().prepare("UPDATE reports SET opened_at = ? WHERE id = ? AND opened_at IS NULL")
      .run(this.now(), id).changes > 0;
    const report = getRow(id);
    if (changed && report) this.registry.upsertReport(report);
    return report;
  }

  /**
   * The one way a report becomes read. Sets `readAt` and `readBy` once; a report already read
   * keeps the first time and the first way.
   */
  markRead(id: string, readBy: ReportReadBy): ReportItem | null {
    const changed = openDb().prepare("UPDATE reports SET read_at = ?, read_by = ? WHERE id = ? AND read_at IS NULL")
      .run(this.now(), readBy, id).changes > 0;
    const report = getRow(id);
    if (changed && report) this.registry.upsertReport(report);
    return report;
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
        const report = getRow(id);
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
      const report = getRow(id);
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
    const report = getRow(id);
    if (!report) throw new ReportRefusal("no such report", 404);
    // Only a report still waiting is answered: a reply to a replaced version would restate what
    // the agent has since corrected, and one to a read report would not say how it was cleared.
    if (report.supersededBy !== null) {
      throw new ReportRefusal(`This report was replaced by ${report.supersededBy}. Reply to that version instead.`, 409);
    }
    if (report.readAt !== null) throw new ReportRefusal("This report has already been read.", 409);
    const target = this.replyTargetFor(report);
    if (target.kind !== "live") throw new ReportRefusal(replyRefusal(target, report.author.name), 409);
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
      const settled = getRow(id);
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
    let report = getRow(id);
    if (!report) return refuse(404, "no such report", null);
    if (report.author.residentProfileId !== null) {
      return refuse(409, `${report.author.name} is a resident: launch it again from the Residents drawer and reply to it there.`, report);
    }
    // A task that was deleted or cancelled is normally forgotten the moment it happens, by the
    // task watcher (`forgetFollowUpTask`). This is the fallback for one it has not seen yet, and
    // it follows the removal rule: a report the follow-up already answered stays answered (it was
    // dispatched and may have done its work), so the call changes nothing and is refused; only a
    // report still waiting forgets the task, and its card goes back to the instructions box.
    if (report.followUpTaskId !== null && !port.exists(report.followUpTaskId)) {
      if (report.readBy === "follow-up") return refuse(409, "This report has already been read.", report);
      this.forgetFollowUpTask(report.followUpTaskId, "removed");
      report = getRow(id)!;
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
        return refuse(409, `${report.author.name} is still running: reply to it instead of starting a follow-up task.`, report);
      }
      if (target.kind === "unreachable") return refuse(409, replyRefusal(target, report.author.name), report);
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
        if (error instanceof ReportRefusal) return refuse(error.status === 404 ? 404 : 409, error.message, getRow(id));
        throw error;
      }
      if (!created.ok) return { ok: false, status: created.status, error: created.error, report: getRow(id), taskId: null };
      taskId = created.taskId;
      // Not published yet: `followUp` publishes the report once the dispatch has an outcome.
      report = getRow(id)!;
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
        return { ok: false, status: 409, error: dispatched.error, report: getRow(id), taskId };
      }
    }
    this.markRead(id, "follow-up");
    // The launch runs in the background and may already have failed, before the stamp above,
    // when the task event found nothing to reopen. Reconciled now from the task's record.
    const task = this.registry.getTask(taskId);
    if (task) this.reconcileFollowUp(task);
    return { ok: true, report: getRow(id) ?? report, taskId };
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
      const report = getRow(id);
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
  async reconcilePublishedArchives(
    exists: (key: string) => Promise<boolean>,
    keys?: readonly string[],
  ): Promise<string[]> {
    if (keys && keys.length === 0) return [];
    const rows = (keys
      ? openDb()
        .prepare(`SELECT id, published_archive_key AS archiveKey FROM reports WHERE published_archive_key IN (${keys.map(() => "?").join(", ")})`)
        .all(...keys)
      : openDb()
        .prepare("SELECT id, published_archive_key AS archiveKey FROM reports WHERE published_archive_key IS NOT NULL")
        .all()) as Array<{ id: string; archiveKey: string }>;
    const cleared: string[] = [];
    for (const { id, archiveKey } of rows) {
      const gone = await this.inPublicationQueue(id, async () => {
        if (getRow(id)?.publishedArchiveKey !== archiveKey) return false;
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
        const report = changed ? getRow(id) : null;
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
    const report = getRow(id);
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
    const published = await port.publish({
      reportId: report.id,
      reportCreatedAt: report.createdAt,
      title: report.title,
      page: built.page,
      session: { id: report.sessionId, name: report.author.name, taskId: report.taskId },
      repositoryLabel: report.repository ? basename(report.repository) : null,
    });
    if (!published.ok) return refuse(published.status, published.problems, getRow(id));
    openDb().prepare("UPDATE reports SET published_archive_key = ? WHERE id = ? AND published_archive_key IS NULL")
      .run(published.key, id);
    const stamped = getRow(id)!;
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
