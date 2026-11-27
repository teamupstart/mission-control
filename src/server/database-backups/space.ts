import { statfsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export function availableBackupBytes(root: string): bigint {
  const stat = statfsSync(root, { bigint: true });
  return stat.bavail * stat.bsize;
}

export function databaseImageBytes(source: DatabaseSync): bigint {
  const pages = source.prepare("PRAGMA page_count").get()!;
  const size = source.prepare("PRAGMA page_size").get()!;
  return BigInt(Number(pages.page_count)) * BigInt(Number(size.page_size));
}

export function requireBackupSpace(available: bigint, remaining: bigint, stage: string): void {
  // Even a tiny database needs room for headers, directory entries and journal sectors.
  const needed = remaining + 65536n;
  if (available < needed) {
    throw new Error(`Insufficient backup workspace for ${stage}: need ${needed} bytes, ${available} available`);
  }
}
