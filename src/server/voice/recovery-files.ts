import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { nativePlanFiles } from "../plans/native.ts";

export const retirementDirectory = (stateHome: string) => join(stateHome, "voice-retirements");

export function announcementName(instance: string) {
  return "announced-" + createHash("sha256").update(instance).digest("hex");
}

// The durable launch ID determines its scratch directory without trusting a stored path.
export const playerScratchDirectory = (stateHome: string, instance: string) =>
  join(retirementDirectory(stateHome), "scratch-" + announcementName(instance));

export async function removePlayerScratch(stateHome: string, instance: string) {
  const parent = lstatSync(retirementDirectory(stateHome), { throwIfNoEntry: false });
  if (!parent) return;
  if (!parent.isDirectory()) throw new Error("Invalid supervisor retirement directory.");
  await rm(playerScratchDirectory(stateHome, instance), { recursive: true, force: true });
}

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function withRecordParent<T>(home: string, path: string, create: boolean,
  action: (parent: number, name: string, directories: number[]) => T): T {
  const subpath = relative(home, path);
  const parts = subpath.split(sep);
  if (!subpath || isAbsolute(subpath) || parts.includes("..")) throw new Error("Invalid voice recovery path.");
  const name = parts.pop()!;
  if (create) mkdirSync(home, { recursive: true, mode: 0o700 });
  const native = nativePlanFiles();
  const directories = [openSync(home, directoryFlags)];
  try {
    for (const part of parts) {
      const parent = directories.at(-1)!;
      if (create) native.makePlanDirectory(parent, part);
      directories.push(native.openPlanEntry(parent, part, directoryFlags));
    }
    return action(directories.at(-1)!, name, directories);
  } finally {
    for (const fd of directories.reverse()) closeSync(fd);
  }
}

function syncVoiceParents(directories: number[]) {
  for (let i = directories.length - 1; i >= 0; i--) fsyncSync(directories[i]!);
}

export function readVoiceRecord(home: string, path: string) {
  return withRecordParent(home, path, false, (parent, name) => {
    const fd = nativePlanFiles().openPlanEntry(parent, name, constants.O_RDONLY);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Invalid voice recovery file.");
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  });
}

export function listVoiceRecords(home: string, directory: string) {
  return withRecordParent(home, directory, false, (parent, name) => {
    const native = nativePlanFiles();
    const fd = native.openPlanEntry(parent, name, directoryFlags);
    try { return native.readPlanDirectory(fd); } finally { closeSync(fd); }
  });
}

/** Durably publish private daemon or supervisor state before acknowledging its transition. */
export function writeVoiceRecord(stateHome: string, path: string, value: unknown): boolean {
  try {
    return withRecordParent(stateHome, path, true, (parent, name, directories) => {
      const native = nativePlanFiles();
      const temp = name + "." + randomUUID();
      const fd = native.openPlanEntry(parent, temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
        native.replaceFileEntry(parent, temp, name);
        syncVoiceParents(directories);
        return true;
      } finally { native.unlinkPlanEntry(parent, temp, false); }
    });
  } catch {
    return false;
  }
}

export function removeVoiceRecord(stateHome: string, path: string) {
  try {
    withRecordParent(stateHome, path, false, (parent, name, directories) => {
      nativePlanFiles().unlinkPlanEntry(parent, name, false);
      syncVoiceParents(directories);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
