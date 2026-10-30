import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { rmdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STATE_DIR } from "../config.ts";

/** The run id comes from the daemon, never from a submitted path. */
export function residentWorkspaceDir(runId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("invalid resident run id");
  return join(realpathSync(STATE_DIR), "residents", "runs", runId, "workspace");
}

/** Refuse symlinked ownership boundaries, including on cleanup after a restart. */
function ownedWorkspace(runId: string, directory: string, create: boolean): boolean {
  if (directory !== residentWorkspaceDir(runId)) throw new Error("resident workspace ownership mismatch");
  let parent = realpathSync(STATE_DIR);
  for (const part of ["residents", "runs", runId, "workspace"]) {
    parent = join(parent, part);
    try {
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("resident workspace must be an owned directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return false;
      // Ancestors have already been checked. Never create recursively through an
      // unchecked component; an entry appearing since lstat must fail with EEXIST.
      mkdirSync(parent);
    }
  }
  return true;
}

export function createResidentWorkspace(runId: string, directory: string): void {
  ownedWorkspace(runId, directory, true);
}

export async function removeResidentWorkspace(runId: string, directory: string): Promise<void> {
  if (ownedWorkspace(runId, directory, false)) await rm(directory, { recursive: true, force: true });
  // Retry the parent even if an earlier attempt already removed the workspace. An
  // unexpected sibling keeps cleanup owed rather than being recursively discarded.
  try {
    await rmdir(dirname(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
