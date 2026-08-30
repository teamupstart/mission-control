import { resolve } from "node:path";
import { verifyDatabaseBackupForRestore } from "../src/server/database-backups/restore.ts";

const candidate = process.argv[2];
if (!candidate) {
  console.error("Usage: npm run verify:database-backup -- /path/to/backup.sqlite3");
  process.exitCode = 2;
} else {
  try {
    const result = await verifyDatabaseBackupForRestore(resolve(candidate));
    console.log(
      `Backup is a valid restore candidate for this build: ` +
        `${result.pageCount} pages, ${result.tableCount} source tables, ` +
        `${result.currentBuildTableCount} tables after disposable forward migration.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
