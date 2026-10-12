import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync, fsyncSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { nativePlanFiles } from "./native.ts";
import { PLAN_CONTENT_LIMITS } from "@shared/managed-plans.ts";

export class PlanStoreError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 409) { super(message); }
}
export const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Every existing component is checked, including the leaf, before each operation. */
export function safePath(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split("/").some((s) => !s || s === "." || s === "..") || relative.includes("\\")) throw new PlanStoreError("Invalid plan path", 400);
  const base = realpathSync(root);
  if (base !== path.resolve(root) || lstatSync(root).isSymbolicLink()) throw new PlanStoreError("Plan root identity changed");
  let current = base;
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (stat?.isSymbolicLink()) throw new PlanStoreError("A plan path resolves through a symbolic link");
    if (i < parts.length - 1) {
      if (stat && !stat.isDirectory()) throw new PlanStoreError("A plan parent is not a directory");
    } else if (stat && !stat.isFile()) throw new PlanStoreError("A plan output is not an ordinary file");
  }
  return current;
}

/** Walk from the filesystem root one component per openat; no path-based mutation. */
function openParent(root: string, relative: string, create: boolean): number {
  safePath(root, relative);
  const native = nativePlanFiles();
  let parent = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const rootParts = path.resolve(root).split("/").filter(Boolean);
    const parts = [...rootParts, ...relative.split("/").slice(0, -1)];
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      let child: number;
      try { child = native.openPlanEntry(parent, name, constants.O_RDONLY | constants.O_DIRECTORY); }
      catch (error) {
        if (!create || i < rootParts.length || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        native.makePlanDirectory(parent, name);
        child = native.openPlanEntry(parent, name, constants.O_RDONLY | constants.O_DIRECTORY);
      }
      closeSync(parent);
      parent = child;
    }
    return parent;
  } catch (error) {
    closeSync(parent);
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new PlanStoreError("A plan path resolves through a symbolic link or non-directory");
    throw error;
  }
}

function readAt(parent: number, name: string, limit: number): Buffer | null {
  let fd: number;
  try { fd = nativePlanFiles().openPlanEntry(parent, name, constants.O_RDONLY); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new PlanStoreError("Plan file is not regular or exceeds its size limit");
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new PlanStoreError("Plan file exceeds its size limit");
    return bytes;
  } finally { closeSync(fd); }
}

export function readSafe(root: string, relative: string, limit: number = PLAN_CONTENT_LIMITS.fileBytes): Buffer | null {
  let parent: number;
  try { parent = openParent(root, relative, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try { return readAt(parent, path.basename(relative), limit); }
  finally { closeSync(parent); }
}

/** The temporary, baseline reads, rename, and cleanup all use the same held parent. */
export function replaceSafe(root: string, relative: string, bytes: Buffer, expected: string | null, beforeRename?: () => void): void {
  const parent = openParent(root, relative, true);
  const native = nativePlanFiles();
  const name = path.basename(relative);
  const temporary = `${name}.${randomUUID()}.tmp`;
  let staged = false;
  try {
    const current = readAt(parent, name, PLAN_CONTENT_LIMITS.fileBytes);
    if ((current ? digest(current) : null) !== expected) throw new PlanStoreError(`Operator edit conflicts with ${relative}; restore the expected bytes before retrying`);
    const fd = native.openPlanEntry(parent, temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    staged = true;
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    const latest = readAt(parent, name, PLAN_CONTENT_LIMITS.fileBytes);
    if ((latest ? digest(latest) : null) !== expected) throw new PlanStoreError(`Operator edit conflicts with ${relative}`);
    beforeRename?.();
    native.renamePlanEntry(parent, temporary, name);
  } finally {
    try { if (staged) native.unlinkPlanEntry(parent, temporary); }
    finally { closeSync(parent); }
  }
}
