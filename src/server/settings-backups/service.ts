import { randomBytes } from "node:crypto";
import type { CostConfig, SkillsConfig } from "@shared/protocol.ts";
import {
  dailySettingsBackupId,
  preRestoreSettingsBackupId,
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_FORMAT_VERSION,
  SETTINGS_BACKUP_LIMITS,
  SettingsRestorePreviewResultSchema,
  SettingsRestoreResultSchema,
  type SettingsBackupEnvelopeBodyV1,
  type SettingsRestorePreviewResult,
  type SettingsRestoreResult,
} from "@shared/settings-backups.ts";
import { getCostConfig, preflightCostReconcile, reconcileCostTelemetry } from "../cost.ts";
import type { Registry } from "../registry.ts";
import { publishSettingsStatus } from "../settings-status.ts";
import { preflightSkillsReconcile, reconcileSkills } from "../skills/config.ts";
import { personaView } from "../workflows/personas.ts";
import type { WorkflowStore } from "../workflows/store.ts";
import { SERVICE_VERSION } from "../version.ts";
import { captureSettingsCatalogs, settingsCatalogCounts } from "./catalogs.ts";
import {
  captureSettingsConfig,
  restoreSettingsConfigInTransaction,
} from "./config-registry.ts";
import { createSettingsBackupEnvelope } from "./format.ts";
import {
  preflightSettingsRestore,
  stageSettingsBackupSnapshot,
  type SettingsRestorePreflightDeps,
  type StagedSettingsBackup,
} from "./restore.ts";
import { SettingsBackupStore, type SettingsBackupRead } from "./store.ts";

export interface SettingsBackupErrorStatus {
  at: string;
  message: string;
}

interface RestoreRegistry extends Pick<
  Registry,
  | "replaceSettingsCatalogs"
  | "emitHarnessesConfigChanged"
  | "emitWorktreesChanged"
  | "emitSettingsStatus"
> {}

export interface SettingsRestoreRuntime {
  registry?: RestoreRegistry;
  preflightSkills?(config: SkillsConfig): readonly string[];
  preflightCost?(config: CostConfig): void;
  reconcileSkills?(): unknown;
  reconcileCost?(config: CostConfig): unknown;
  /** Focused rollback seams; production supplies neither. */
  afterConfigRestore?(): void;
  beforeCommit?(): void;
}

export function settingsBackupLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type StageResult =
  | { status: "ready"; staged: StagedSettingsBackup }
  | Exclude<SettingsRestorePreviewResult, { status: "ready" | "preflight_blocked" }>
  | { status: "stale_digest"; reason: string };

export class SettingsBackupService {
  private captureTail: Promise<void> = Promise.resolve();
  private backupError: SettingsBackupErrorStatus | null = null;
  private restoreInProgress = false;
  readonly store: SettingsBackupStore;
  private readonly runtime: SettingsRestoreRuntime;

  constructor(
    private readonly workflowStore: WorkflowStore,
    storeOrRuntime: SettingsBackupStore | SettingsRestoreRuntime = new SettingsBackupStore(),
    private readonly now: () => Date = () => new Date(),
    private readonly appVersion = SERVICE_VERSION,
    runtime: SettingsRestoreRuntime = {},
  ) {
    if (storeOrRuntime instanceof SettingsBackupStore) {
      this.store = storeOrRuntime;
      this.runtime = runtime;
    } else {
      this.store = new SettingsBackupStore();
      this.runtime = storeOrRuntime;
    }
  }

  get lastError(): SettingsBackupErrorStatus | null {
    return this.backupError;
  }

  private serialize<T>(operation: () => T): Promise<T> {
    const run = this.captureTail.then(operation, operation);
    this.captureTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async guarded<T>(operation: () => T): Promise<T> {
    try {
      const result = await this.serialize(operation);
      this.backupError = null;
      return result;
    } catch (error) {
      const message = this.reason(error);
      this.backupError = { at: this.now().toISOString(), message };
      throw error;
    }
  }

  private reason(error: unknown): string {
    return (error instanceof Error ? error.message : String(error))
      .slice(0, SETTINGS_BACKUP_LIMITS.errorCharacters);
  }

  private capture(
    kind: SettingsBackupEnvelopeBodyV1["kind"],
    id: string,
    localDate: string,
    createdAt: Date,
  ): SettingsBackupRead {
    const catalogs = captureSettingsCatalogs(this.workflowStore);
    const domains = [...captureSettingsConfig(), ...catalogs]
      .sort((left, right) => left.domain.localeCompare(right.domain));
    const body: SettingsBackupEnvelopeBodyV1 = {
      format: SETTINGS_BACKUP_FORMAT,
      formatVersion: SETTINGS_BACKUP_FORMAT_VERSION,
      id,
      kind,
      createdAt: createdAt.toISOString(),
      localDate,
      appVersion: this.appVersion,
      domains,
      counts: settingsCatalogCounts(catalogs),
    };
    return this.store.write(createSettingsBackupEnvelope(body));
  }

  ensureDailySnapshot(localDate = settingsBackupLocalDate(this.now())): Promise<SettingsBackupRead> {
    return this.guarded(() => {
      const id = dailySettingsBackupId(localDate);
      const existing = this.store.read(id);
      if (existing.status === "ready" || existing.status === "produced_by_newer_build") {
        return existing;
      }
      return this.capture("daily", id, localDate, this.now());
    });
  }

  /** Internal safety seam. There is deliberately no route or UI caller in Phase 2. */
  capturePreRestoreSnapshot(): Promise<SettingsBackupRead> {
    return this.guarded(() => this.captureSafetySnapshot());
  }

  private captureSafetySnapshot(): SettingsBackupRead {
    const createdAt = this.now();
    const id = preRestoreSettingsBackupId(createdAt, randomBytes(6).toString("hex"));
    return this.capture("pre_restore", id, settingsBackupLocalDate(createdAt), createdAt);
  }

  list(): ReturnType<SettingsBackupStore["list"]> {
    return this.store.list();
  }

  verify(id: string): SettingsBackupRead {
    return this.store.read(id);
  }

  private stage(id: string, expectedDigest?: string): StageResult {
    const read = this.store.read(id);
    if (read.status === "not_found") return { status: "not_found", reason: read.reason };
    if (read.status === "produced_by_newer_build") {
      return { status: "incompatible", reason: read.reason };
    }
    if (read.status === "corrupt") return { status: "incompatible", reason: read.reason };
    if (read.status !== "ready") return { status: "io_error", reason: read.reason };
    if (expectedDigest !== undefined && read.snapshot.digest !== expectedDigest) {
      return { status: "stale_digest", reason: "Snapshot changed after it was previewed" };
    }
    try {
      return { status: "ready", staged: stageSettingsBackupSnapshot(read.snapshot) };
    } catch (error) {
      return { status: "incompatible", reason: this.reason(error) };
    }
  }

  private preflightDeps(): SettingsRestorePreflightDeps {
    return {
      skills: this.runtime.preflightSkills ?? preflightSkillsReconcile,
      cost: this.runtime.preflightCost ?? (() => preflightCostReconcile()),
    };
  }

  /** Synchronous, redacted, digest-bearing advisory preview for Phase 3. */
  previewRestore(id: string): SettingsRestorePreviewResult {
    const stage = this.stage(id);
    if (stage.status !== "ready") {
      if (stage.status === "stale_digest") {
        return SettingsRestorePreviewResultSchema.parse({ status: "io_error", reason: stage.reason });
      }
      return SettingsRestorePreviewResultSchema.parse(stage);
    }
    const preview = preflightSettingsRestore(this.workflowStore, stage.staged, this.preflightDeps());
    return SettingsRestorePreviewResultSchema.parse({
      status: preview.blockers.length > 0 ? "preflight_blocked" : "ready",
      preview,
    });
  }

  /**
   * Restore as one serialized forward mutation. A second human restore is refused rather
   * than queued, while the daily capture loop still waits on the shared serializer.
   */
  async restore(id: string, expectedDigest: string): Promise<SettingsRestoreResult> {
    if (this.restoreInProgress) return { status: "in_progress" };
    this.restoreInProgress = true;
    try {
      return await this.guarded(() => this.restoreSerialized(id, expectedDigest));
    } catch (error) {
      return SettingsRestoreResultSchema.parse({
        status: "restore_failed",
        reason: this.reason(error),
      });
    } finally {
      this.restoreInProgress = false;
    }
  }

  private restoreSerialized(id: string, expectedDigest: string): SettingsRestoreResult {
    const stage = this.stage(id, expectedDigest);
    if (stage.status !== "ready") return SettingsRestoreResultSchema.parse(stage);
    const preview = preflightSettingsRestore(this.workflowStore, stage.staged, this.preflightDeps());
    if (preview.blockers.length > 0) {
      return SettingsRestoreResultSchema.parse({ status: "preflight_blocked", preview });
    }

    let safety: SettingsBackupRead;
    try {
      safety = this.captureSafetySnapshot();
    } catch (error) {
      return SettingsRestoreResultSchema.parse({ status: "io_error", reason: this.reason(error) });
    }
    if (safety.status !== "ready" || safety.snapshot.kind !== "pre_restore") {
      return SettingsRestoreResultSchema.parse({
        status: "io_error",
        reason: safety.status === "ready" ? "Safety snapshot kind was invalid" : safety.reason,
      });
    }
    const verifiedSafety = this.store.read(safety.snapshot.id);
    if (verifiedSafety.status !== "ready" || verifiedSafety.snapshot.digest !== safety.snapshot.digest) {
      return SettingsRestoreResultSchema.parse({
        status: "io_error",
        reason: verifiedSafety.status === "ready"
          ? "Safety snapshot changed during verification"
          : verifiedSafety.reason,
      });
    }

    try {
      this.workflowStore.transact((db) => {
        restoreSettingsConfigInTransaction(db, stage.staged.config);
        this.runtime.afterConfigRestore?.();
        this.workflowStore.restoreSettingsCatalogsInTransaction(stage.staged, this.now().getTime());
        this.runtime.beforeCommit?.();
      });
    } catch (error) {
      return SettingsRestoreResultSchema.parse({
        status: "restore_failed",
        reason: this.reason(error),
      });
    }

    const warnings = this.reconcileAfterCommit();
    return SettingsRestoreResultSchema.parse({
      status: "restored",
      snapshotId: stage.staged.snapshot.id,
      digest: stage.staged.snapshot.digest,
      restoredAt: this.now().toISOString(),
      safetySnapshotId: safety.snapshot.id,
      warnings,
    });
  }

  private reconcileAfterCommit(): string[] {
    const warnings: string[] = [];
    const attempt = (label: string, operation: () => unknown): void => {
      try {
        operation();
      } catch (error) {
        warnings.push(this.reason(`${label}: ${this.reason(error)}`));
      }
    };
    const registry = this.runtime.registry;
    if (registry) {
      attempt("Library catalog reconciliation failed", () => registry.replaceSettingsCatalogs({
        personas: this.workflowStore.personaCatalog().map((row) => personaView(row)),
        sessionActions: this.workflowStore.sessionActionCatalog(),
        workflowCommands: this.workflowStore.workflowCommandCatalog(),
        workflows: this.workflowStore.workflowCatalog().map((row) => this.workflowStore.summary(row)),
      }));
      attempt("Harness projection reconciliation failed", () => registry.emitHarnessesConfigChanged());
      attempt("Worktree projection reconciliation failed", () => registry.emitWorktreesChanged());
      attempt("Settings status reconciliation failed", () => publishSettingsStatus(registry));
    }
    attempt("Skills reconciliation failed", this.runtime.reconcileSkills ?? (() => reconcileSkills()));
    attempt(
      "Cost reconciliation failed",
      () => (this.runtime.reconcileCost ?? reconcileCostTelemetry)(getCostConfig()),
    );
    return warnings.slice(0, SETTINGS_BACKUP_LIMITS.previewItems);
  }
}
