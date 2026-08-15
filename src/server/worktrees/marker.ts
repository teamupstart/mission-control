import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const WORKTREE_POOL_MARKER = ".mission-control-worktree-pool";
export const WORKTREE_POOL_MARKER_VERSION = 1;

export interface WorktreePoolMarker {
  schemaVersion: typeof WORKTREE_POOL_MARKER_VERSION;
  poolId: string;
}

function parseMarker(raw: string): WorktreePoolMarker | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return value.schemaVersion === WORKTREE_POOL_MARKER_VERSION &&
      typeof value.poolId === "string" && value.poolId.length > 0 && value.poolId.length <= 128
      ? { schemaVersion: WORKTREE_POOL_MARKER_VERSION, poolId: value.poolId }
      : null;
  } catch {
    return null;
  }
}

/** Read and validate the provider-neutral marker at one exact pool root. */
export async function readWorktreePoolMarker(poolPath: string): Promise<WorktreePoolMarker | null> {
  try {
    return parseMarker(await readFile(join(poolPath, WORKTREE_POOL_MARKER), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Create the pool marker before any slot can be exposed, or verify the marker already
 * belongs to the same durable pool. The exclusive create makes two daemon instances race
 * safely: the loser reads and verifies the winner's bytes.
 */
export async function ensureWorktreePoolMarker(poolPath: string, poolId: string): Promise<void> {
  await mkdir(poolPath, { recursive: true });
  const [stat, physical] = await Promise.all([lstat(poolPath), realpath(poolPath)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || physical !== resolve(poolPath)) {
    throw new Error(`native worktree pool root ${poolPath} is not an exact physical directory`);
  }
  const markerPath = join(poolPath, WORKTREE_POOL_MARKER);
  const marker: WorktreePoolMarker = { schemaVersion: WORKTREE_POOL_MARKER_VERSION, poolId };
  try {
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const existing = await readWorktreePoolMarker(poolPath);
    if (existing?.poolId === poolId) return;
    throw new Error(
      `native worktree pool marker at ${markerPath} is missing, unreadable, or belongs to another pool`,
      { cause: error },
    );
  }
}

/**
 * Discover whether an absolute checkout-local path sits below a native pool marker without
 * opening SQLite or consulting MISSION_HOME. This is the seam Phase 3's hook installer uses.
 */
export async function findWorktreePoolMarker(
  subjectPath: string,
): Promise<{ poolPath: string; marker: WorktreePoolMarker } | null> {
  let current = resolve(subjectPath);
  try {
    await access(current, constants.F_OK);
  } catch {
    current = dirname(current);
  }
  for (let depth = 0; depth < 64; depth++) {
    const marker = await readWorktreePoolMarker(current);
    if (marker) return { poolPath: current, marker };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
