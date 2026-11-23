import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join } from "node:path";
import { agentDisplayName, sessionDisplayNameInput } from "@shared/display-name.ts";
import { INBOX_FLAG } from "@shared/inbox.ts";
import type { PostReportBody } from "@shared/protocol.ts";
import {
  REPORT_LIMITS,
  reportDocumentKind,
  reportId,
  reportToRead,
  residentAuthorKey,
  sessionAuthorKey,
  type ReportAuthor,
  type ReportDocumentKind,
  type ReportItem,
  type ReportReadBy,
} from "@shared/reports.ts";
import { sessionWorkspaceRoot } from "@shared/session.ts";
import type { Session } from "@shared/types.ts";
import { STATE_DIR } from "./config.ts";
import { inTransaction, openDb } from "./db.ts";
import { featureEnabled, onFeatureFlagsChanged } from "./feature-flags/index.ts";
import type { Registry } from "./registry.ts";
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
 * `markRead` is the one place a report becomes read.
 */

/** A refused post or operator action, with the HTTP status the route answers. */
export class ReportRefusal extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 413) {
    super(message);
  }
}

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

/** Where a report's attached document is stored. Later phases read it from here. */
export function reportDocumentDir(id: string, stateDir: string = STATE_DIR): string {
  return join(stateDir, "reports", id);
}

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
  }

  stop(): void {
    this.stopFlags();
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
}
