import { dirname } from "node:path";
import { backup, type BackupProgressInfo, type DatabaseSync } from "node:sqlite";
import { availableBackupBytes, requireBackupSpace } from "./space.ts";

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
export async function onlineDatabaseBackup(
  source: DatabaseSync,
  destination: string,
  availableBytes = availableBackupBytes,
): Promise<void> {
  const wake = setInterval(() => {}, 10);
  try {
    const pageSize = Number(source.prepare("PRAGMA page_size").get()!.page_size);
    let checkedPages = -Infinity;
    let checkedTotal = 0;
    const root = dirname(destination);
    function progress({ totalPages, remainingPages }: BackupProgressInfo): void {
      const copied = totalPages - remainingPages;
      // Recheck on growth/restart and every 8 MiB while the destination fills.
      if (totalPages === checkedTotal && copied >= checkedPages &&
          (copied - checkedPages) * pageSize < 8 * 1024 * 1024) return;
      checkedPages = copied;
      checkedTotal = totalPages;
      requireBackupSpace(availableBytes(root),
        BigInt(remainingPages + 2 * totalPages) * BigInt(pageSize), "online copy");
    }
    await backup(source, destination, { progress });
  } finally {
    clearInterval(wake);
  }
}
