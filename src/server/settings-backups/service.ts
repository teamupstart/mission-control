import { randomBytes } from "node:crypto";
import {
  dailySettingsBackupId,
  preRestoreSettingsBackupId,
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_FORMAT_VERSION,
  SETTINGS_BACKUP_LIMITS,
  type SettingsBackupEnvelopeBodyV1,
} from "@shared/settings-backups.ts";
import type { WorkflowStore } from "../workflows/store.ts";
import { SERVICE_VERSION } from "../version.ts";
import { captureSettingsCatalogs, settingsCatalogCounts } from "./catalogs.ts";
import { captureSettingsConfig } from "./config-registry.ts";
import { createSettingsBackupEnvelope } from "./format.ts";
import { SettingsBackupStore, type SettingsBackupRead } from "./store.ts";

export interface SettingsBackupErrorStatus {
  at: string;
  message: string;
}

export function settingsBackupLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class SettingsBackupService {
  private captureTail: Promise<void> = Promise.resolve();
  private backupError: SettingsBackupErrorStatus | null = null;

  constructor(
    private readonly workflowStore: WorkflowStore,
    readonly store = new SettingsBackupStore(),
    private readonly now: () => Date = () => new Date(),
    private readonly appVersion = SERVICE_VERSION,
  ) {}

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
      const message = (error instanceof Error ? error.message : String(error))
        .slice(0, SETTINGS_BACKUP_LIMITS.errorCharacters);
      this.backupError = { at: this.now().toISOString(), message };
      throw error;
    }
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

  /** Internal Phase 2 seam. Phase 1 deliberately exposes no route or UI caller. */
  capturePreRestoreSnapshot(): Promise<SettingsBackupRead> {
    return this.guarded(() => {
      const createdAt = this.now();
      const id = preRestoreSettingsBackupId(createdAt, randomBytes(6).toString("hex"));
      return this.capture("pre_restore", id, settingsBackupLocalDate(createdAt), createdAt);
    });
  }

  list(): ReturnType<SettingsBackupStore["list"]> {
    return this.store.list();
  }

  verify(id: string): SettingsBackupRead {
    return this.store.read(id);
  }
}
