import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
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
    if (create) mkdirSync(parent, { recursive: true });
    try {
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("resident workspace must be an owned directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return false;
      throw error;
    }
  }
  return true;
}

export function createResidentWorkspace(runId: string, directory: string): void {
  ownedWorkspace(runId, directory, true);
}

export function removeResidentWorkspace(runId: string, directory: string): void {
  if (ownedWorkspace(runId, directory, false)) rmSync(directory, { recursive: true, force: true });
}
