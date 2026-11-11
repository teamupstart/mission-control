import { databaseBackupStatusFrom, type DatabaseBackupStatus } from "@shared/database-backups.ts";
import {
  backupFailedProblems,
  STORAGE_PROBLEM_KINDS,
  type StorageBackupCopy,
  type StorageHealth,
} from "@shared/storage-health.ts";

interface StorageHealthDeps {
  backups: {
    status(): DatabaseBackupStatus;
    keptCopies(): StorageBackupCopy[];
  };
  /** Called with each recomputed aggregate that differs from the last one published. */
  publish(health: StorageHealth): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KIND_ORDER = new Map(STORAGE_PROBLEM_KINDS.map((kind, index) => [kind, index]));

/**
 * The one storage aggregate behind Settings > Storage. It recomputes after every capture and
 * prune, and publishes only when the result changed, so a quiet machine wakes no browser.
 */
export class StorageHealthService {
  private last: { health: StorageHealth; serialized: string } | null = null;

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
    const problems = backupFailedProblems(status);
    problems.sort((left, right) =>
      KIND_ORDER.get(left.kind)! - KIND_ORDER.get(right.kind)! || left.id.localeCompare(right.id));

    const health: StorageHealth = {
      backups: {
        status,
        copies,
        totalBytes: copies.reduce((total, copy) => total + copy.bytes, 0),
      },
      problems,
    };
    const serialized = JSON.stringify(health);
    if (serialized !== this.last?.serialized) {
      this.last = { health, serialized };
      this.deps.publish(health);
    }
    return health;
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
