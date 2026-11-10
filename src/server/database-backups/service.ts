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
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  databaseBackupsConfigFrom,
  databaseBackupStatusFrom,
  DEFAULT_DATABASE_BACKUPS_CONFIG,
  type DatabaseBackupsConfig,
  type DatabaseBackupStatus,
  type RecordedDatabaseBackupKind,
} from "@shared/database-backups.ts";
import { DATABASE_BACKUPS_DIR } from "../config.ts";

export type DatabaseBackupKind = "scheduled" | "preMigration" | "manual";

/** The configurable counts. A `manual` copy is not counted here: exactly one is always kept. */
export interface DatabaseBackupRetention {
  scheduled: number;
  preMigration: number;
}

export function databaseBackupRetention(config: DatabaseBackupsConfig): DatabaseBackupRetention {
  return { scheduled: config.scheduledCount, preMigration: config.preMigrationCount };
}

export const DATABASE_BACKUP_RETENTION: Readonly<DatabaseBackupRetention> = Object.freeze(
  databaseBackupRetention(DEFAULT_DATABASE_BACKUPS_CONFIG),
);

const MANUAL_BACKUP_RETENTION = 1;

/** The first wait after a failed scheduled capture; each further failure doubles it. */
export const DATABASE_BACKUP_BACKOFF_BASE_MS = 5 * 60 * 1_000;

/** A copy dated further than this past `now` is treated as written under a wrong clock. */
export const DATABASE_BACKUP_FUTURE_TOLERANCE_MS = 60 * 1_000;

const HOUR_MS = 60 * 60 * 1_000;

/** A stored failure message is bounded, so a pathological error cannot bloat the record. */
const FAILURE_MESSAGE_CHARACTERS = 1_000;

/**
 * How long a scheduled attempt waits after the last one, given the current failure streak:
 * `min(5 min x 2^(n-1), intervalHours)`, and no wait at all without a failure.
 */
export function scheduledBackupBackoffMs(
  consecutiveFailures: number,
  intervalHours: number,
): number {
  if (consecutiveFailures < 1) return 0;
  const doubled = DATABASE_BACKUP_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1);
  return Math.min(doubled, intervalHours * HOUR_MS);
}

function hasAppConfigTable(db: DatabaseSync): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'app_config'").get(),
  );
}

/** One raw `app_config` value, or `undefined` when the table, the row, or valid JSON is missing. */
function storedAppConfigValue(db: DatabaseSync, key: string): unknown {
  try {
    if (!hasAppConfigTable(db)) return undefined;
    const row = db.prepare("SELECT value FROM app_config WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stored backups config, read through the given handle rather than `getAppConfig`.
 *
 * `openDb` takes its pre-migration copy before any migration has run, when `app_config` may
 * not exist yet and the shared connection is not open, so this reads the raw row. A missing
 * table, a missing row, or a malformed value reads as the default and never throws.
 */
export function storedDatabaseBackupsConfig(db: DatabaseSync): DatabaseBackupsConfig {
  return databaseBackupsConfigFrom(storedAppConfigValue(db, APP_CONFIG_ENTRIES.backups.key));
}

/** The stored capture outcomes, read through the same handle as the config. */
export function storedDatabaseBackupStatus(db: DatabaseSync): DatabaseBackupStatus {
  return databaseBackupStatusFrom(storedAppConfigValue(db, APP_CONFIG_ENTRIES.backupsStatus.key));
}

/**
 * Persist the capture outcomes. A handle without `app_config` (a bare fixture database) keeps
 * no record; the daemon's database always has the table.
 */
function storeDatabaseBackupStatus(db: DatabaseSync, status: DatabaseBackupStatus): void {
  if (!hasAppConfigTable(db)) return;
  db.prepare(
    `INSERT INTO app_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(APP_CONFIG_ENTRIES.backupsStatus.key, JSON.stringify(status));
}

/** One published copy, as Settings > Storage lists it. */
export interface DatabaseBackupCopy {
  kind: DatabaseBackupKind;
  filename: string;
  /** The capture time its filename names, in epoch milliseconds. */
  at: number;
  bytes: number;
}

export interface DatabaseBackupRecord {
  kind: DatabaseBackupKind;
  filename: string;
  path: string;
  createdAt: string;
}

interface OwnedCopy {
  filename: string;
  /** The capture time its filename names, in epoch milliseconds. */
  at: number;
  bytes: number;
}

export interface DatabaseBackupValidation {
  integrity: "ok";
  pageCount: number;
  tableCount: number;
}

interface DatabaseBackupServiceOptions {
  root?: string;
  /** Fixed counts. Without it, every prune reads the stored config through `source`. */
  retention?: DatabaseBackupRetention;
  now?: () => Date;
  onlineBackup?: (source: DatabaseSync, destination: string) => Promise<void>;
}

/** The one place a kind meets its filename prefix; the regex and reverse lookup derive from it. */
const FILE_PREFIX: Record<DatabaseBackupKind, string> = {
  scheduled: "scheduled",
  preMigration: "pre-migration",
  manual: "manual",
};

const BACKUP_KINDS = Object.keys(FILE_PREFIX) as DatabaseBackupKind[];

const KIND_BY_PREFIX = new Map(BACKUP_KINDS.map((kind) => [FILE_PREFIX[kind], kind]));

const OWNED_BACKUP = new RegExp(
  `^(${Object.values(FILE_PREFIX).join("|")})-(\\d{8}T\\d{9}Z)-([a-f0-9]{32})\\.sqlite3$`,
);

/** The UTC instant a copy's filename stamp names, such as `20261027T120000000Z`. */
function copyTime(stamp: string): number {
  return Date.parse(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
      `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`,
  );
}

/** The files SQLite may leave beside a database, removed with the file they belong to. */
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"] as const;

/**
 * Tables whose values are write-only secrets (`src/server/db.ts`). Every recovery point is
 * scrubbed of them before it is published, so a backup never carries one: a restored database
 * shows those secrets as not set, and a run whose snapshot lost one refuses to start that server
 * rather than starting it without its credential.
 */
export const WRITE_ONLY_SECRET_TABLES = ["resident_mcp_secrets", "resident_run_mcp_secrets"] as const;

/**
 * Private definitions redacted in place, so their rows survive and only their content does not.
 * A global MCP server's whole definition - command and arguments included - is private, because
 * native configuration does not mark which parts are credentials; a restored run keeps the
 * server's name and refuses to start it.
 */
const PRIVATE_DEFINITION_REDACTIONS = [
  {
    table: "resident_run_mcp_servers",
    sql: `UPDATE resident_run_mcp_servers
          SET definition_json = json_set(definition_json, '$.transport', json('{"type":"redacted"}'))
          WHERE source = 'global'`,
  },
] as const;

/**
 * Delete every write-only secret, and redact every private definition, in a captured copy,
 * overwriting the freed pages.
 */
export function scrubWriteOnlySecrets(path: string): void {
  const copy = new DatabaseSync(path);
  try {
    const present = new Set(
      (copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    const tables = WRITE_ONLY_SECRET_TABLES.filter((table) => present.has(table));
    const redactions = PRIVATE_DEFINITION_REDACTIONS.filter((redaction) => present.has(redaction.table));
    if (tables.length === 0 && redactions.length === 0) return;
    // `secure_delete` zeroes the deleted cells and the old row images an update replaces;
    // VACUUM then rebuilds the file without the freed pages, so nothing survives in free space.
    copy.exec("PRAGMA secure_delete = ON");
    for (const table of tables) copy.exec(`DELETE FROM ${table}`);
    for (const redaction of redactions) copy.exec(redaction.sql);
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
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
  private readonly retention: DatabaseBackupRetention | undefined;
  private readonly now: () => Date;
  private readonly onlineBackup: (source: DatabaseSync, destination: string) => Promise<void>;
  private readonly pending = new Map<RecordedDatabaseBackupKind, Promise<DatabaseBackupRecord>>();
  private queueTail: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private readonly changeListeners = new Set<() => void>();

  constructor(
    private readonly source: DatabaseSync,
    options: DatabaseBackupServiceOptions = {},
  ) {
    this.root = options.root ?? DATABASE_BACKUPS_DIR;
    this.retention = options.retention;
    this.now = options.now ?? (() => new Date());
    this.onlineBackup = options.onlineBackup ?? (async (db, destination) => {
      await sqliteBackup(db, destination);
    });
    for (const [kind, count] of Object.entries(this.retention ?? {})) {
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
    const filename = `${FILE_PREFIX[kind]}-${timestampForFilename(new Date(createdAt))}-${nonce}.sqlite3`;
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

  /**
   * Call `listener` whenever what this service reports may have moved: after every online
   * capture settles, whatever its outcome, and after every prune requested from outside a
   * capture. A listener that throws is reported and never turns a capture around.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        console.warn(`[mission-control] database backup change listener failed: ${errorMessage(error)}`);
      }
    }
  }

  private publish(
    capture: DatabaseBackupRecord & { temporary: string },
  ): DatabaseBackupRecord {
    chmodSync(capture.temporary, 0o600);
    scrubWriteOnlySecrets(capture.temporary);
    syncFile(capture.temporary);
    validateDatabaseBackupForRestore(capture.temporary);
    renameSync(capture.temporary, capture.path);
    syncFile(this.root);
    this.pruneCopies();
    const { temporary: _temporary, ...record } = capture;
    return record;
  }

  private ownedCopies(): Record<DatabaseBackupKind, OwnedCopy[]> {
    const groups: Record<DatabaseBackupKind, OwnedCopy[]> = {
      scheduled: [],
      preMigration: [],
      manual: [],
    };
    for (const filename of readdirSync(this.root)) {
      const match = OWNED_BACKUP.exec(filename);
      if (!match) continue;
      const path = join(this.root, filename);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      groups[KIND_BY_PREFIX.get(match[1]!)!].push({
        filename,
        at: copyTime(match[2]!),
        bytes: stat.size,
      });
    }
    return groups;
  }

  /**
   * Every published copy, newest first, with its size. Read-only: a missing root, or one that
   * is not a real directory, lists nothing rather than being created or refused.
   */
  keptCopies(): DatabaseBackupCopy[] {
    try {
      const rootStat = lstatSync(this.root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
    } catch {
      return [];
    }
    const groups = this.ownedCopies();
    return BACKUP_KINDS.flatMap((kind) => groups[kind].map((copy) => ({ kind, ...copy })))
      .sort((left, right) => right.at - left.at || right.filename.localeCompare(left.filename));
  }

  /**
   * Delete every copy above its kind's count, newest kept, with any SQLite sidecar beside it.
   * Runs after every capture; the daemon also calls it at startup and when the counts are
   * saved, so a lowered count takes effect without waiting for the next capture.
   */
  prune(): void {
    try {
      this.pruneCopies();
    } finally {
      this.notifyChange();
    }
  }

  private pruneCopies(): void {
    if (!existsSync(this.root)) return;
    // Startup and save prune outside a capture, so they refuse a symlinked root the same way.
    this.ensureRoot();
    const retention = this.retention ?? databaseBackupRetention(
      storedDatabaseBackupsConfig(this.source),
    );
    const keep: Record<DatabaseBackupKind, number> = {
      ...retention,
      manual: MANUAL_BACKUP_RETENTION,
    };
    const groups = this.ownedCopies();
    // Newest first, except that a copy dated in the future, left by a clock that moved
    // backward, sorts as the oldest: it is the first one expired once newer copies exist.
    const horizon = this.now().getTime() + DATABASE_BACKUP_FUTURE_TOLERANCE_MS;
    const rank = (copy: OwnedCopy) => (copy.at > horizon ? -Infinity : copy.at);
    for (const kind of BACKUP_KINDS) {
      const expired = groups[kind]
        .sort((left, right) => rank(right) - rank(left) || right.filename.localeCompare(left.filename))
        .slice(keep[kind])
        .map((copy) => copy.filename);
      for (const filename of expired) {
        const path = join(this.root, filename);
        safeUnlink(path);
        for (const suffix of SQLITE_SIDECARS) safeUnlink(`${path}${suffix}`);
      }
    }
    syncFile(this.root);
  }

  /** What the scheduled and manual captures last did, as persisted. */
  status(): DatabaseBackupStatus {
    return storedDatabaseBackupStatus(this.source);
  }

  private updateStatus(change: (status: DatabaseBackupStatus) => void): void {
    const status = this.status();
    change(status);
    storeDatabaseBackupStatus(this.source, status);
  }

  /**
   * Whether the backup loop should take a scheduled copy now. It is due when the newest
   * `scheduled-*` copy is at least `intervalHours` old by wall clock, so restarts, sleep and a
   * changed interval all take effect at the next wake. A copy dated more than a minute in the
   * future is ignored, so a clock that moved backward makes a capture due rather than stalling
   * it. After `n` consecutive failures the attempt also waits
   * `min(5 min x 2^(n-1), intervalHours)` from the last attempt, read from the persisted
   * record so a restart keeps the wait.
   *
   * A last attempt dated in the future counts as now, and is stored as now: compared afresh at
   * every wake, "now" would keep moving and the wait would never end.
   */
  scheduledDue(): boolean {
    const now = this.now().getTime();
    const { intervalHours } = storedDatabaseBackupsConfig(this.source);
    const { consecutiveFailures, lastAttemptAt } = this.status().scheduled;
    if (lastAttemptAt !== null && lastAttemptAt > now) {
      this.record(() => this.recordAttempt("scheduled", now));
      if (consecutiveFailures > 0) return false;
    } else if (lastAttemptAt !== null) {
      if (now - lastAttemptAt < scheduledBackupBackoffMs(consecutiveFailures, intervalHours)) {
        return false;
      }
    }
    if (!existsSync(this.root)) return true;
    try {
      this.ensureRoot();
    } catch {
      // A root that cannot be prepared is due, so the capture fails on it and records that
      // failure on the scheduled kind, backing off like any other, instead of every wake
      // warning while the persisted status says nothing is wrong.
      return true;
    }
    const horizon = now + DATABASE_BACKUP_FUTURE_TOLERANCE_MS;
    const newest = Math.max(
      -Infinity,
      ...this.ownedCopies().scheduled.map((copy) => copy.at).filter((at) => at <= horizon),
    );
    return now - newest >= intervalHours * HOUR_MS;
  }

  private recordAttempt(kind: RecordedDatabaseBackupKind, at: number): void {
    this.updateStatus((status) => {
      status[kind].lastAttemptAt = at;
    });
  }

  private recordSuccess(kind: RecordedDatabaseBackupKind, at: number): void {
    this.updateStatus((status) => {
      // A manual success proves the capture path works, so it also ends the scheduled streak.
      const cleared = kind === "manual" ? (["manual", "scheduled"] as const) : [kind];
      for (const each of cleared) {
        Object.assign(status[each], { consecutiveFailures: 0, failingSince: null, lastFailure: null });
      }
      status[kind].lastSuccessAt = at;
    });
  }

  private recordFailure(kind: RecordedDatabaseBackupKind, at: number, error: unknown): void {
    this.updateStatus((status) => {
      const own = status[kind];
      own.consecutiveFailures += 1;
      own.failingSince ??= at;
      own.lastFailure = {
        at,
        kind,
        message: errorMessage(error).slice(0, FAILURE_MESSAGE_CHARACTERS),
      };
      // A manual failure feeds only the scheduled backoff, so it never reports a scheduled
      // failure that did not happen.
      if (kind === "manual") {
        status.scheduled.consecutiveFailures += 1;
        status.scheduled.lastAttemptAt = at;
      }
    });
  }

  /** A status write failure is reported but never turns the capture's own outcome around. */
  private record(update: () => void): void {
    try {
      update();
    } catch (error) {
      console.warn(`[mission-control] database backup status was not saved: ${errorMessage(error)}`);
    }
  }

  private async captureOnline(kind: RecordedDatabaseBackupKind): Promise<DatabaseBackupRecord> {
    const attemptedAt = this.now().getTime();
    this.record(() => this.recordAttempt(kind, attemptedAt));
    let temporary: string | undefined;
    try {
      // Inside the try: a backup root that cannot be prepared is a failed attempt too, so it
      // backs off like any other failure.
      const capture = this.paths(kind);
      temporary = capture.temporary;
      await this.onlineBackup(this.source, capture.temporary);
      const record = this.publish(capture);
      this.record(() => this.recordSuccess(kind, this.now().getTime()));
      return record;
    } catch (error) {
      const label = kind === "manual" ? "Manual" : "Scheduled";
      const failure = new Error(`${label} database backup failed: ${errorMessage(error)}`, {
        cause: error,
      });
      if (temporary) safeUnlink(temporary);
      this.record(() => this.recordFailure(kind, attemptedAt, error));
      throw failure;
    } finally {
      this.notifyChange();
    }
  }

  /**
   * One online capture at a time. A request for a kind already running or queued joins it; a
   * request for the other kind queues behind the last capture, so the two never write at once.
   */
  private captureSingleFlight(kind: RecordedDatabaseBackupKind): Promise<DatabaseBackupRecord> {
    const joined = this.pending.get(kind);
    if (joined) return joined;
    if (this.stopping) return Promise.reject(new Error("Database backups are stopping"));
    const previous = this.queueTail.then(() => undefined, () => undefined);
    const capture = (async () => {
      await previous;
      return this.captureOnline(kind);
    })().finally(() => {
      if (this.pending.get(kind) === capture) this.pending.delete(kind);
    });
    this.pending.set(kind, capture);
    this.queueTail = capture;
    return capture;
  }

  captureScheduled(): Promise<DatabaseBackupRecord> {
    return this.captureSingleFlight("scheduled");
  }

  /**
   * Refuse new captures and wait for the one in flight and any queued behind it. A Back up now
   * runs inside an HTTP request, which shutdown only bounds, so without this SQLite could close
   * under a capture before it published or recorded its outcome.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.queueTail.then(() => undefined, () => undefined);
  }

  /**
   * Back up now. Never gated by the scheduled backoff, and never restarts the hourly interval:
   * the scheduled due check measures only from `scheduled-*` copies.
   */
  captureManual(): Promise<DatabaseBackupRecord> {
    return this.captureSingleFlight("manual");
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
