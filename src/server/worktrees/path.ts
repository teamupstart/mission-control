import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Canonicalize an existing checkout path, while keeping missing legacy paths comparable. */
export function canonicalWorktreePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
