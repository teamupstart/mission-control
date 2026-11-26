import { chmodSync, closeSync, constants, fsyncSync, lstatSync, openSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { availableBackupBytes, requireBackupSpace } from "./space.ts";

export interface DatabaseBackupValidation {
  integrity: "ok";
  pageCount: number;
  tableCount: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function syncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * An online backup copies the source's WAL journal mode, and a read-only validation of a WAL
 * file cannot clean up its WAL index. Switching the copy to rollback mode before validation
 * makes every published copy one self-contained file that opens without creating sidecars.
 */
function useRollbackJournal(temporary: string): void {
  const copy = new DatabaseSync(temporary);
  try {
    const row = copy.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string };
    if (row.journal_mode !== "delete") {
      throw new Error(`journal mode stayed ${row.journal_mode}`);
    }
  } finally {
    copy.close();
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
  redactAndRebuild(path, copy => copy.exec("VACUUM"));
}

function redactAndRebuild(path: string, rebuild: (copy: DatabaseSync) => void): void {
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
    rebuild(copy);
  } finally {
    copy.close();
  }
}

export interface PublicationOptions {
  selfContain?: (temporary: string) => void;
  validate?: (temporary: string) => DatabaseBackupValidation;
  availableBytes?: (root: string) => bigint;
}

/** Synchronous at startup. Online captures run this same boundary in a short-lived worker. */
export function publishDatabaseBackup(temporary: string, destination: string, options: PublicationOptions = {}): void {
  const root = dirname(temporary);
  const free = options.availableBytes ?? availableBackupBytes;
  let candidate = temporary;
  let stage = "staging file check";
  try {
    const stat = lstatSync(temporary);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("candidate must be a privately owned regular file");
    }
    stage = "journal conversion";
    (options.selfContain ?? useRollbackJournal)(temporary);
    chmodSync(temporary, 0o600);
    stage = "secret redaction";
    requireBackupSpace(free(root), lstatSync(temporary, { bigint: true }).size * 2n, stage);
    redactAndRebuild(temporary, copy => {
      stage = "VACUUM INTO";
      requireBackupSpace(free(root), lstatSync(temporary, { bigint: true }).size * 2n, stage);
      // Write the compacted image beside the staging file. An in-place VACUUM also
      // journals the full original while copying the rebuilt image back over it.
      candidate = temporary + ".vacuum";
      closeSync(openSync(candidate, "wx", 0o600));
      copy.prepare("VACUUM INTO ?").run(candidate);
    });
    stage = "file sync";
    syncFile(candidate);
    stage = "validation";
    (options.validate ?? validateDatabaseBackupForRestore)(candidate);
    stage = "rename";
    renameSync(candidate, destination);
    stage = "directory sync";
    syncFile(root);
  } catch (error) {
    throw new Error(`Backup ${stage} failed: ${errorMessage(error)}`, { cause: error });
  }
}
