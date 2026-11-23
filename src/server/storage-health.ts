import { databaseBackupStatusFrom, type DatabaseBackupStatus } from "@shared/database-backups.ts";
import {
  backupFailedProblems,
  STORAGE_PROBLEM_KINDS,
  storageAlertConditions,
  storageAlertProblems,
  type StorageBackupCopy,
  type StorageHealth,
  type StorageUsage,
  type StorageVolume,
} from "@shared/storage-health.ts";
import {
  DEFAULT_STORAGE_LIMITS_CONFIG,
  storageAlertStateFrom,
  type StorageAlertState,
  type StorageLimitsConfig,
} from "@shared/storage-limits.ts";

interface StorageHealthDeps {
  backups: {
    status(): DatabaseBackupStatus;
    keptCopies(): StorageBackupCopy[];
    /**
     * The kept copies' allocated bytes, the basis the walk measured in. Absent: their file sizes,
     * which match it only for copies that are not sparse.
     */
    keptDiskBytes?(): number;
  };
  /** The state directory's last measurement and its volume. Absent: nothing measured. */
  usage?: {
    usage(): StorageUsage;
    volume(): StorageVolume | null;
  };
  /** The saved limits. Absent: the shipped defaults. */
  limits?: () => StorageLimitsConfig;
  /** Where each warning's occurrence start is kept across restarts. Absent: memory only. */
  alerts?: {
    read(): StorageAlertState;
    write(state: StorageAlertState): void;
  };
  now?: () => number;
  /** Called with each recomputed aggregate that differs from the last one published. */
  publish(health: StorageHealth): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KIND_ORDER = new Map(STORAGE_PROBLEM_KINDS.map((kind, index) => [kind, index]));

const UNMEASURED: StorageUsage = {
  root: "",
  measuredAt: null,
  durationMs: null,
  measuring: false,
  error: null,
  totalBytes: null,
  categories: [],
  pools: [],
};

/**
 * The backups category moved by however much the kept copies changed since the last walk, so
 * saving a lower backup limit shows in the totals at once. Only the change is applied: the walk
 * also measured what is not a kept copy (a capture's temporary file, a sidecar), and replacing
 * the category with the kept copies alone would drop those bytes from the total and from the
 * limit warning. The total moves by the same difference, which keeps the categories adding up.
 */
function withLiveBackups(usage: StorageUsage, rawDelta: number): StorageUsage {
  if (usage.totalBytes === null || rawDelta === 0) return usage;
  const measured = usage.categories.find((category) => category.id === "backups")?.bytes ?? 0;
  // Never take away more than the category held: anything past that belongs to other
  // categories, and removing it would understate the total and could clear a real warning.
  const delta = Math.max(rawDelta, -measured);
  return {
    ...usage,
    totalBytes: Math.max(0, usage.totalBytes + delta),
    categories: usage.categories.map((category) => category.id === "backups"
      ? { ...category, bytes: measured + delta }
      : category),
  };
}

/**
 * The one storage aggregate behind Settings > Storage. It recomputes after every capture and
 * prune, measurement and volume check, and limits save, and publishes only when the result
 * changed, so a quiet machine wakes no browser.
 */
export class StorageHealthService {
  private last: { health: StorageHealth; serialized: string } | null = null;
  /**
   * Each warning's current occurrence. Read from `deps.alerts` once, then held here as the source
   * of truth: the persisted copy only carries it across a restart. A write can fail exactly when
   * this matters most, on a full disk, and reading the older row back would start the standing
   * warning again under a new id, re-showing a dismissed banner and repeating the notification.
   */
  private alertState: StorageAlertState | null = null;
  /** The last write of `alertState` failed, so it is written again on the next recompute. */
  private alertsUnsaved = false;
  /**
   * The kept copies' on-disk bytes when this service first saw the current walk: the baseline a
   * change in them is measured from, in the walk's own allocated-block basis.
   */
  private backupBaseline: { measuredAt: number; keptBytes: number } | null = null;

  constructor(private readonly deps: StorageHealthDeps) {}

  /** The last published aggregate, computing one if none has been yet. */
  current(): StorageHealth {
    return this.last?.health ?? this.recompute();
  }

  recompute(): StorageHealth {
    const status = this.attempt(
      "backup status", () => this.deps.backups.status(), databaseBackupStatusFrom(undefined),
    );
    const copies = this.attempt("kept copies", () => this.deps.backups.keptCopies(), []);
    const backupBytes = copies.reduce((total, copy) => total + copy.bytes, 0);
    const limits = this.attempt("storage limits", () => this.deps.limits?.() ?? DEFAULT_STORAGE_LIMITS_CONFIG, DEFAULT_STORAGE_LIMITS_CONFIG);
    const measuredUsage = this.attempt("storage usage", () => this.deps.usage?.usage() ?? UNMEASURED, UNMEASURED);
    const backupDiskBytes = this.attempt(
      "backup disk bytes", () => this.deps.backups.keptDiskBytes?.() ?? backupBytes, backupBytes,
    );
    if (measuredUsage.measuredAt !== null && this.backupBaseline?.measuredAt !== measuredUsage.measuredAt) {
      this.backupBaseline = { measuredAt: measuredUsage.measuredAt, keptBytes: backupDiskBytes };
    }
    const usage = withLiveBackups(
      measuredUsage,
      this.backupBaseline && measuredUsage.measuredAt !== null ? backupDiskBytes - this.backupBaseline.keptBytes : 0,
    );
    const volume = this.attempt("storage volume", () => this.deps.usage?.volume() ?? null, null);
    const alerts = this.advanceAlerts(storageAlertConditions({ limits, totalBytes: usage.totalBytes, volume }));

    const problems = [
      ...backupFailedProblems(status),
      ...storageAlertProblems({ limits, totalBytes: usage.totalBytes, volume, alerts }),
    ];
    problems.sort((left, right) =>
      KIND_ORDER.get(left.kind)! - KIND_ORDER.get(right.kind)! || left.id.localeCompare(right.id));

    const health: StorageHealth = {
      backups: { status, copies, totalBytes: backupBytes },
      usage,
      volume,
      limits: { ...limits },
      problems,
    };
    const serialized = JSON.stringify(health);
    if (serialized !== this.last?.serialized) {
      this.last = { health, serialized };
      this.deps.publish(health);
    }
    return health;
  }

  /**
   * Start an occurrence when its condition begins and end it when the condition clears. A
   * condition with no reading to judge (nothing measured yet) neither starts nor ends one.
   */
  private advanceAlerts(conditions: { lowFreeSpace: boolean | null; storageLimit: boolean | null }): StorageAlertState {
    const current = this.alertState ??= this.attempt(
      "storage alerts", () => this.deps.alerts?.read() ?? storageAlertStateFrom(undefined), storageAlertStateFrom(undefined),
    );
    const now = this.deps.now?.() ?? Date.now();
    const since = (holds: boolean | null, started: number | null): number | null =>
      holds === null ? started : holds ? started ?? now : null;
    const next: StorageAlertState = {
      lowFreeSpaceSince: since(conditions.lowFreeSpace, current.lowFreeSpaceSince),
      storageLimitSince: since(conditions.storageLimit, current.storageLimitSince),
    };
    const changed = next.lowFreeSpaceSince !== current.lowFreeSpaceSince || next.storageLimitSince !== current.storageLimitSince;
    this.alertState = next;
    if (changed || this.alertsUnsaved) {
      try {
        this.deps.alerts?.write(next);
        this.alertsUnsaved = false;
      } catch (error) {
        this.alertsUnsaved = true;
        console.warn(`[mission-control] storage health could not save storage alerts, will retry: ${errorMessage(error)}`);
      }
    }
    return next;
  }

  /** One input that fails is reported and left out; the rest of the aggregate still lands. */
  private attempt<T>(what: string, read: () => T, fallback: T): T {
    try {
      return read();
    } catch (error) {
      console.warn(`[mission-control] storage health could not read ${what}: ${errorMessage(error)}`);
      return fallback;
    }
  }
}
