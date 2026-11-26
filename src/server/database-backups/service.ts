import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { open, unlink } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { publishDatabaseBackup, syncFile, type PublicationOptions } from "./publication.ts";
import { availableBackupBytes, databaseImageBytes, requireBackupSpace } from "./space.ts";
import { onlineDatabaseBackup } from "./online.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  backupRetentionLimits,
  DATABASE_BACKUP_FUTURE_TOLERANCE_MS,
  databaseBackupsConfigFrom,
  databaseBackupStatusFrom,
  DEFAULT_DATABASE_BACKUPS_CONFIG,
  planBackupRetention,
  type DatabaseBackupsConfig,
  type DatabaseBackupStatus,
  type RecordedDatabaseBackupKind,
} from "@shared/database-backups.ts";
import { DATABASE_BACKUPS_DIR } from "../config.ts";

export { scrubWriteOnlySecrets, WRITE_ONLY_SECRET_TABLES, validateDatabaseBackupForRestore, type DatabaseBackupValidation } from "./publication.ts";

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


/** The first wait after a failed scheduled capture; each further failure doubles it. */
export const DATABASE_BACKUP_BACKOFF_BASE_MS = 5 * 60 * 1_000;

/** A copy dated further than this past `now` is treated as written under a wrong clock. */
export { DATABASE_BACKUP_FUTURE_TOLERANCE_MS };

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
  /** Its file size. */
  bytes: number;
  /** What it occupies on disk, in allocated blocks. */
  diskBytes: number;
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
  /** What it occupies on disk, the basis a `du` measurement counts in. */
  diskBytes: number;
}

interface DatabaseBackupServiceOptions extends PublicationOptions {
  root?: string;
  /** Fixed counts. Without it, every prune reads the stored config through `source`. */
  retention?: DatabaseBackupRetention;
  now?: () => Date;
  onlineBackup?: (source: DatabaseSync, destination: string) => Promise<void>;
  removeFile?: (path: string) => void;
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

const OWNED_TEMPORARY = /^\.database-backup-[a-f0-9]{32}\.tmp(?:\.vacuum)?(?:-wal|-shm|-journal)?$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function ignoreMissingFile(error: unknown): void {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    ignoreMissingFile(error);
  }
}

function temporaryFiles(temporary: string): string[] {
  return [temporary, temporary + ".vacuum"].flatMap(path =>
    [path, ...SQLITE_SIDECARS.map(suffix => path + suffix)]);
}

function reportRemovalFailure(path: string, error: unknown): void {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
  console.warn(`[mission-control] database backup temporary ${basename(path)} was not removed: ${errorMessage(error)}`);
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
  private readonly publication: PublicationOptions;
  private readonly removeFile: (path: string) => void;
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
    this.publication = {
      selfContain: options.selfContain,
      validate: options.validate,
      availableBytes: options.availableBytes,
    };
    this.onlineBackup = options.onlineBackup ?? ((db, path) => onlineDatabaseBackup(db, path, options.availableBytes));
    this.removeFile = options.removeFile ?? safeUnlink;
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

  private checkCaptureSpace(): void {
    // Staging image, compacted output, and one image of scratch for SQLite journals
    // and index sorting. Size the live database through SQLite to include WAL pages.
    const available = this.publication.availableBytes ?? availableBackupBytes;
    requireBackupSpace(available(this.root), databaseImageBytes(this.source) * 3n, "snapshot");
  }

  private async publishOnline(temporary: string, destination: string): Promise<void> {
    // Injected step implementations run locally for fault tests. Production sends
    // only the two owned paths, never the live connection, across the worker boundary.
    if (this.publication.selfContain || this.publication.validate || this.publication.availableBytes) {
      publishDatabaseBackup(temporary, destination, this.publication);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL("./publication-worker.mjs", import.meta.url), {
        workerData: { temporary, destination }, execArgv: [],
      });
      let published = false;
      worker.once("message", message => { published = message === "published"; });
      worker.once("error", reject);
      worker.once("exit", code => {
        if (code === 0 && published) resolve();
        else reject(new Error(`Backup publication worker stopped before completion (code ${code})`));
      });
    });
  }

  /**
   * Remove temporary files and sidecars that an interrupted capture left in the backup root.
   * Call it once at startup, before the first capture: that is the only time no capture of
   * this daemon can be in flight. Published copies and unrelated files are never touched.
   * One entry that cannot be removed does not stop the sweep: `readdirSync` order is stable,
   * so stopping would strand every leftover after it on every start.
   */
  removeLeftoverTemporaries(): void {
    this.ensureRoot();
    const failures: string[] = [];
    for (const filename of readdirSync(this.root)) {
      if (!OWNED_TEMPORARY.test(filename)) continue;
      const path = join(this.root, filename);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        this.removeFile(path);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        failures.push(`${filename}: ${errorMessage(error)}`);
      }
    }
    syncFile(this.root);
    if (failures.length > 0) throw new Error(failures.join("; "));
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
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        ignoreMissingFile(error);
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      groups[KIND_BY_PREFIX.get(match[1]!)!].push({
        filename,
        at: copyTime(match[2]!),
        bytes: stat.size,
        diskBytes: stat.blocks * 512,
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
   * What the kept copies occupy on disk, in the same allocated-block basis a `du` walk counts,
   * so a change in them can be applied to a measured total. A copy's file size can be far larger
   * than its blocks (a sparse file), and that difference was never in the measurement.
   */
  keptDiskBytes(): number {
    try {
      const rootStat = lstatSync(this.root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return 0;
    } catch {
      return 0;
    }
    const groups = this.ownedCopies();
    return BACKUP_KINDS.reduce((total, kind) =>
      total + groups[kind].reduce((sum, copy) => sum + copy.diskBytes, 0), 0);
  }

  /**
   * Delete every copy the saved limits no longer keep (`planBackupRetention`: count, then
   * age, then size, never the minimum recovery set), with any SQLite sidecar beside it.
   * Runs after every capture; the daemon also calls it at startup and when the limits are
   * saved, so a lowered limit takes effect without waiting for the next capture.
   * A confirmed settings save supplies the filenames from its validated preview.
   */
  prune(confirmedRemovals?: readonly string[]): void {
    try {
      if (this.pruneCopies(confirmedRemovals)) syncFile(this.root);
    } finally {
      this.notifyChange();
    }
  }

  /** The limits a prune applies under `config`. Fixed counts replace only the counts. */
  private limitsFor(config: DatabaseBackupsConfig) {
    const limits = backupRetentionLimits(config);
    if (this.retention) {
      limits.counts.scheduled = this.retention.scheduled;
      limits.counts.preMigration = this.retention.preMigration;
    }
    return limits;
  }

  /**
   * The filenames a prune would delete right now if `config` were saved, oldest first. Read-only,
   * over the same listing, limits and clock the prune itself uses, so a save can refuse when the
   * copies changed after the operator was shown what it deletes.
   */
  plannedRemovals(config: DatabaseBackupsConfig): string[] {
    return planBackupRetention(this.keptCopies(), this.limitsFor(config), this.now().getTime())
      .remove.map((copy) => copy.filename);
  }

  private pruneCopies(confirmedRemovals?: readonly string[]): boolean {
    if (!existsSync(this.root)) return false;
    this.ensureRoot();
    const names = confirmedRemovals ?? this.plannedRemovals(storedDatabaseBackupsConfig(this.source));
    if (!names.every(filename => OWNED_BACKUP.test(filename))) {
      throw new TypeError("Database backup prune received an invalid filename");
    }
    for (const filename of names) {
      const path = join(this.root, filename);
      // Sidecars first so a failure leaves the listed copy available for retry.
      for (const suffix of SQLITE_SIDECARS) safeUnlink(path + suffix);
      safeUnlink(path);
    }
    return names.length > 0;
  }

  private async pruneAfterOnlinePublish(): Promise<void> {
    try {
      // Plan and unlink in one turn so a settings save cannot retain a copy
      // while an asynchronous deletion of that copy is still pending.
      if (!this.pruneCopies()) return;
      const directory = await open(this.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      this.warnPruneFailure(error);
    }
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
    // A scheduled capture queued now would run right after it whatever the manual capture's
    // outcome, skipping the backoff a failure records, so the next wake decides instead.
    if (this.pending.has("manual")) return false;
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
      // Both kinds share one capture path, so any success ends both streaks.
      for (const each of ["manual", "scheduled"] as const) {
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
    try {
      // Inside the try: a backup root that cannot be prepared is a failed attempt too, so it
      // backs off like any other failure.
      const { temporary, ...record } = this.paths(kind);
      try {
        this.checkCaptureSpace();
        await this.onlineBackup(this.source, temporary);
        await this.publishOnline(temporary, record.path);
      } finally {
        // Release scratch space before writing the durable outcome, also on ENOSPC.
        await Promise.all(temporaryFiles(temporary).map(path =>
          unlink(path).catch(error => reportRemovalFailure(path, error))));
      }
      this.record(() => this.recordSuccess(kind, this.now().getTime()));
      await this.pruneAfterOnlinePublish();
      return record;
    } catch (error) {
      const label = kind === "manual" ? "Manual" : "Scheduled";
      const failure = new Error(`${label} database backup failed: ${errorMessage(error)}`, {
        cause: error,
      });
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
    const { temporary, ...record } = this.paths("preMigration");
    try {
      this.checkCaptureSpace();
      this.source.prepare("VACUUM INTO ?").run(temporary);
      publishDatabaseBackup(temporary, record.path, this.publication);
    } catch (error) {
      throw new Error(`Pre-migration database backup failed: ${errorMessage(error)}`, {
        cause: error,
      });
    } finally {
      for (const path of temporaryFiles(temporary)) {
        try {
          unlinkSync(path);
        } catch (error) {
          reportRemovalFailure(path, error);
        }
      }
    }
    this.pruneAfterPublish();
    return record;
  }

  /**
   * Once a copy is published the capture has succeeded, so a prune failure only warns: it
   * leaves an extra copy for the next prune, and never fails the capture or blocks a migration.
   */
  private pruneAfterPublish(): void {
    try {
      if (this.pruneCopies()) syncFile(this.root);
    } catch (error) {
      this.warnPruneFailure(error);
    }
  }

  private warnPruneFailure(error: unknown): void {
    console.warn(`[mission-control] database backup prune failed after capture: ${errorMessage(error)}`);
  }
}
