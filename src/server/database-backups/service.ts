import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { DATABASE_BACKUPS_DIR } from "../config.ts";

export type DatabaseBackupKind = "scheduled" | "preMigration";

export interface DatabaseBackupRetention {
  scheduled: number;
  preMigration: number;
}

export const DATABASE_BACKUP_RETENTION: Readonly<DatabaseBackupRetention> = Object.freeze({
  scheduled: 24,
  preMigration: 10,
});

export interface DatabaseBackupRecord {
  kind: DatabaseBackupKind;
  filename: string;
  path: string;
  createdAt: string;
}

export interface DatabaseBackupValidation {
  integrity: "ok";
  pageCount: number;
  tableCount: number;
}

interface DatabaseBackupServiceOptions {
  root?: string;
  retention?: DatabaseBackupRetention;
  now?: () => Date;
  onlineBackup?: (source: DatabaseSync, destination: string) => Promise<void>;
}

const OWNED_BACKUP = /^(scheduled|pre-migration)-(\d{8}T\d{9}Z)-([a-f0-9]{32})\.sqlite3$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function filePrefix(kind: DatabaseBackupKind): "scheduled" | "pre-migration" {
  return kind === "scheduled" ? "scheduled" : "pre-migration";
}

function syncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

/**
 * Open a recovery candidate read-only and ask SQLite to validate every b-tree and page.
 * This function never opens the live database and never changes the candidate.
 */
export function validateDatabaseBackupForRestore(path: string): DatabaseBackupValidation {
  let candidate: DatabaseSync | undefined;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
      throw new TypeError("candidate is not a non-empty regular file");
    }
    candidate = new DatabaseSync(path, { readOnly: true });
    const rows = candidate.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      const detail = rows.map((row) => row.integrity_check).join("; ") || "no result";
      throw new Error(`integrity check failed: ${detail}`);
    }
    const pageCount = Number(
      (candidate.prepare("PRAGMA page_count").get() as { page_count: number }).page_count,
    );
    const tableCount = Number(
      (
        candidate
          .prepare(
            "SELECT count(*) AS count FROM sqlite_schema " +
              "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .get() as { count: number }
      ).count,
    );
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || !Number.isSafeInteger(tableCount)) {
      throw new Error("database metadata is invalid");
    }
    return { integrity: "ok", pageCount, tableCount };
  } catch (error) {
    throw new Error(`Candidate is not a valid SQLite database backup: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    try {
      candidate?.close();
    } catch {}
  }
}

/**
 * Owns full-database recovery points. Scheduled captures use SQLite's online backup API.
 * The synchronous pre-migration capture uses SQLite's VACUUM INTO snapshot operation because
 * openDb must finish its recovery boundary before any schema statement can run.
 */
export class DatabaseBackupService {
  readonly root: string;
  private readonly retention: DatabaseBackupRetention;
  private readonly now: () => Date;
  private readonly onlineBackup: (source: DatabaseSync, destination: string) => Promise<void>;
  private scheduledCapture: Promise<DatabaseBackupRecord> | null = null;

  constructor(
    private readonly source: DatabaseSync,
    options: DatabaseBackupServiceOptions = {},
  ) {
    this.root = options.root ?? DATABASE_BACKUPS_DIR;
    this.retention = options.retention ?? DATABASE_BACKUP_RETENTION;
    this.now = options.now ?? (() => new Date());
    this.onlineBackup = options.onlineBackup ?? (async (db, destination) => {
      await sqliteBackup(db, destination);
    });
    for (const [kind, count] of Object.entries(this.retention)) {
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new RangeError(`Database backup retention for ${kind} must be a positive integer`);
      }
    }
  }

  private ensureRoot(): void {
    const parent = dirname(this.root);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStat = lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new TypeError("Database backup parent must be a real directory");
    }
    chmodSync(parent, 0o700);

    if (!existsSync(this.root)) mkdirSync(this.root, { mode: 0o700 });
    const rootStat = lstatSync(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new TypeError("Database backup root must be a real directory");
    }
    chmodSync(this.root, 0o700);
  }

  private paths(kind: DatabaseBackupKind): DatabaseBackupRecord & { temporary: string } {
    this.ensureRoot();
    const createdAt = this.now().toISOString();
    const nonce = randomUUID().replaceAll("-", "");
    const filename = `${filePrefix(kind)}-${timestampForFilename(new Date(createdAt))}-${nonce}.sqlite3`;
    const path = join(this.root, filename);
    if (dirname(path) !== this.root || basename(path) !== filename || !OWNED_BACKUP.test(filename)) {
      throw new TypeError("Database backup path escaped its root");
    }
    return {
      kind,
      filename,
      path,
      createdAt,
      temporary: join(this.root, `.database-backup-${nonce}.tmp`),
    };
  }

  private publish(
    capture: DatabaseBackupRecord & { temporary: string },
  ): DatabaseBackupRecord {
    chmodSync(capture.temporary, 0o600);
    syncFile(capture.temporary);
    validateDatabaseBackupForRestore(capture.temporary);
    renameSync(capture.temporary, capture.path);
    syncFile(this.root);
    this.prune();
    const { temporary: _temporary, ...record } = capture;
    return record;
  }

  private prune(): void {
    const groups: Record<DatabaseBackupKind, string[]> = {
      scheduled: [],
      preMigration: [],
    };
    for (const filename of readdirSync(this.root)) {
      const match = OWNED_BACKUP.exec(filename);
      if (!match) continue;
      const path = join(this.root, filename);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      groups[match[1] === "scheduled" ? "scheduled" : "preMigration"].push(filename);
    }
    for (const kind of ["scheduled", "preMigration"] as const) {
      const expired = groups[kind]
        .sort((left, right) => right.localeCompare(left))
        .slice(this.retention[kind]);
      for (const filename of expired) safeUnlink(join(this.root, filename));
    }
    syncFile(this.root);
  }

  private async captureScheduledOnce(): Promise<DatabaseBackupRecord> {
    const capture = this.paths("scheduled");
    try {
      await this.onlineBackup(this.source, capture.temporary);
      return this.publish(capture);
    } catch (error) {
      safeUnlink(capture.temporary);
      throw new Error(`Scheduled database backup failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  captureScheduled(): Promise<DatabaseBackupRecord> {
    if (this.scheduledCapture) return this.scheduledCapture;
    const capture = this.captureScheduledOnce().finally(() => {
      if (this.scheduledCapture === capture) this.scheduledCapture = null;
    });
    this.scheduledCapture = capture;
    return capture;
  }

  capturePreMigration(): DatabaseBackupRecord {
    const capture = this.paths("preMigration");
    try {
      this.source.prepare("VACUUM INTO ?").run(capture.temporary);
      return this.publish(capture);
    } catch (error) {
      safeUnlink(capture.temporary);
      throw new Error(`Pre-migration database backup failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
}
