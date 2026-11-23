import { closeSync, constants, openSync, realpathSync, fstatSync, readSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config.ts";
import { nativePlanFiles } from "../plans/native.ts";

/** Stable identity, never a profile name or a submitted filesystem path. */
export function residentStateDir(profileId: string): string {
  if (typeof profileId !== "string" || !/^[a-zA-Z0-9:-]+$/.test(profileId)) throw new Error("invalid resident profile id");
  return join(realpathSync(STATE_DIR), "residents", "profiles", profileId, "state");
}

/** Open each component without following links, retaining the descriptors through cleanup. */
function ownedState(profileId: string, directory: string, create: boolean) {
  if (directory !== residentStateDir(profileId)) throw new Error("resident state ownership mismatch");
  const native = nativePlanFiles();
  const state = realpathSync(STATE_DIR).split("/").filter(Boolean);
  const parts = [...state, "residents", "profiles", profileId, "state"];
  const handles = [openSync("/", constants.O_RDONLY | constants.O_DIRECTORY)];
  const close = () => { for (const fd of handles.reverse()) closeSync(fd); };
  let profile: number | null = null;
  let exists = false;
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
      if (index === state.length + 2) profile = child;
      if (index === state.length + 3) exists = true;
    }
    return { profile, exists, close };
  } catch (error) {
    close();
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error("resident state must be an owned directory", { cause: error });
    }
    throw error;
  }
}

export function ensureResidentState(profileId: string): string {
  const directory = residentStateDir(profileId);
  ownedState(profileId, directory, true).close();
  return directory;
}

export async function removeResidentState(profileId: string, directory: string): Promise<void> {
  const owned = ownedState(profileId, directory, false);
  try {
    const native = nativePlanFiles();
    if (owned.exists) await native.removePlanDirectory(owned.profile!, "state");
  } finally {
    owned.close();
  }
}

/** Read through held no-follow descriptors, including the final file. */
export function readResidentStateFile(profileId: string, path: string): string {
  const parts = path.split("/");
  if (!path || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) throw new Error("Invalid state file path");
  const owned = ownedState(profileId, residentStateDir(profileId), false);
  const handles: number[] = [];
  try {
    if (!owned.exists) throw new Error("State directory is missing");
    let parent = nativePlanFiles().openPlanEntry(owned.profile!, "state", constants.O_RDONLY | constants.O_DIRECTORY);
    handles.push(parent);
    for (const part of parts.slice(0, -1)) {
      parent = nativePlanFiles().openPlanEntry(parent, part, constants.O_RDONLY | constants.O_DIRECTORY);
      handles.push(parent);
    }
    const fd = nativePlanFiles().openPlanEntry(parent, parts.at(-1)!, constants.O_RDONLY | constants.O_NONBLOCK);
    handles.push(fd);
    if (!fstatSync(fd).isFile()) throw new Error("Not a regular state file");
    const bytes = Buffer.alloc(256 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length === bytes.length) throw new Error("State preview is limited to 256 KiB");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    for (const fd of handles.reverse()) closeSync(fd);
    owned.close();
  }
}
