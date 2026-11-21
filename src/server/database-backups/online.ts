import { backup, type DatabaseSync } from "node:sqlite";

/**
 * Keep native backup completions moving even when the rest of the process is idle.
 * Node 26.7.0's BackupJob::AfterThreadPoolWork resolves without a callback scope:
 * the copy can be complete while its promise reactions wait for unrelated JS activity.
 * https://github.com/nodejs/node/blob/v26.7.0/src/node_sqlite.cc#L500-L554
 *
 * A small, referenced timer supplies that callback only while the backup is pending.
 * Do not unref it: a quiet caller must still finish. Do not race a timeout against the
 * backup either: SQLite could still be using the source/destination during cleanup.
 */
export async function onlineDatabaseBackup(source: DatabaseSync, destination: string): Promise<void> {
  const wake = setInterval(() => {}, 10);
  try {
    await backup(source, destination);
  } finally {
    clearInterval(wake);
  }
}
