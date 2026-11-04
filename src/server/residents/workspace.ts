import { closeSync, constants, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config.ts";
import { nativePlanFiles } from "../plans/native.ts";

/** The run id comes from the daemon, never from a submitted path. */
export function residentWorkspaceDir(runId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("invalid resident run id");
  return join(realpathSync(STATE_DIR), "residents", "runs", runId, "workspace");
}

/** Open each component without following links, retaining the descriptors through cleanup. */
function ownedWorkspace(runId: string, directory: string, create: boolean) {
  if (directory !== residentWorkspaceDir(runId)) throw new Error("resident workspace ownership mismatch");
  const native = nativePlanFiles();
  const state = realpathSync(STATE_DIR).split("/").filter(Boolean);
  const parts = [...state, "residents", "runs", runId, "workspace"];
  const handles = [openSync("/", constants.O_RDONLY | constants.O_DIRECTORY)];
  const close = () => { for (const fd of handles.reverse()) closeSync(fd); };
  let runs: number | null = null;
  let run: number | null = null;
  let workspace = false;
  try {
    for (const [index, name] of parts.entries()) {
      const parent = handles.at(-1)!;
      let child: number;
      try { child = native.openPlanEntry(parent, name, constants.O_RDONLY | constants.O_DIRECTORY); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!create) break;
        if (index < state.length) throw error;
        native.makePlanDirectory(parent, name);
        child = native.openPlanEntry(parent, name, constants.O_RDONLY | constants.O_DIRECTORY);
      }
      handles.push(child);
      if (index === state.length + 1) runs = child;
      if (index === state.length + 2) run = child;
      if (index === state.length + 3) workspace = true;
    }
    return { runs, run, workspace, close };
  } catch (error) {
    close();
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error("resident workspace must be an owned directory", { cause: error });
    }
    throw error;
  }
}

export function createResidentWorkspace(runId: string, directory: string): void {
  ownedWorkspace(runId, directory, true).close();
}

export async function removeResidentWorkspace(runId: string, directory: string): Promise<void> {
  const owned = ownedWorkspace(runId, directory, false);
  try {
    const native = nativePlanFiles();
    if (owned.workspace) await native.removePlanDirectory(owned.run!, "workspace");
    // Retry the parent even if an earlier attempt already removed the workspace. An
    // unexpected sibling or swapped entry keeps cleanup owed, without following its path.
    if (owned.run !== null) native.unlinkPlanEntry(owned.runs!, runId, true);
  } finally {
    owned.close();
  }
}
