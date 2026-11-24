import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

function syncVoiceParents(directory: string, stateHome: string) {
  const home = resolve(stateHome);
  for (let parent = resolve(directory); ; parent = dirname(parent)) {
    const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (parent === home) break;
  }
}

/** Durably publish private daemon or supervisor state before acknowledging its transition. */
export function writeVoiceRecord(stateHome: string, path: string, value: unknown): boolean {
  const temp = path + "." + randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    syncVoiceParents(dirname(path), stateHome);
    return true;
  } catch {
    try { unlinkSync(temp); } catch { /* No staged file. */ }
    return false;
  }
}

export function removeVoiceRecord(stateHome: string, path: string) {
  try { unlinkSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || lstatSync(path, { throwIfNoEntry: false })) throw error;
  }
  if (lstatSync(dirname(path), { throwIfNoEntry: false })) syncVoiceParents(dirname(path), stateHome);
}
