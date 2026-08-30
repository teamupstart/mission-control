import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { upgradeDatabaseToCurrentSchema } from "../db.ts";
import {
  validateDatabaseBackupForRestore,
  type DatabaseBackupValidation,
} from "./service.ts";

export interface DatabaseRestoreVerification extends DatabaseBackupValidation {
  currentBuildIntegrity: "ok";
  currentBuildTableCount: number;
}
/**
 * Prove that a backup is internally sound and can traverse this build's exact forward
 * migration path. All writes land in a disposable copy. The candidate and live database
 * are opened read-only or not at all, and no successful or failed check promotes the copy.
 */
export async function verifyDatabaseBackupForRestore(
  candidatePath: string,
): Promise<DatabaseRestoreVerification> {
  const original = validateDatabaseBackupForRestore(candidatePath);
  const stagingRoot = mkdtempSync(join(tmpdir(), "mission-database-restore-verify-"));
  const stagedPath = join(stagingRoot, "harness.db");
  let candidate: DatabaseSync | undefined;
  let staged: DatabaseSync | undefined;
  try {
    candidate = new DatabaseSync(candidatePath, { readOnly: true });
    await sqliteBackup(candidate, stagedPath);
    candidate.close();
    candidate = undefined;

    staged = new DatabaseSync(stagedPath);
    upgradeDatabaseToCurrentSchema(staged);
    staged.close();
    staged = undefined;

    const current = validateDatabaseBackupForRestore(stagedPath);
    return {
      ...original,
      currentBuildIntegrity: current.integrity,
      currentBuildTableCount: current.tableCount,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Restore verification failed without changing the candidate or live database: ${reason}`,
      { cause: error },
    );
  } finally {
    try {
      candidate?.close();
    } catch {}
    try {
      staged?.close();
    } catch {}
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}
