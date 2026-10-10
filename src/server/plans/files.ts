import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync, fsyncSync, rmSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PLAN_CONTENT_LIMITS } from "@shared/managed-plans.ts";

export class PlanStoreError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 409) { super(message); }
}
export const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Every existing component is checked, including the leaf, before each operation. */
export function safePath(root: string, relative: string, createParents = false): string {
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
      if (!stat && createParents) mkdirSync(current, { mode: 0o700 });
      else if (stat && !stat.isDirectory()) throw new PlanStoreError("A plan parent is not a directory");
    } else if (stat && !stat.isFile()) throw new PlanStoreError("A plan output is not an ordinary file");
  }
  return current;
}

export function readSafe(root: string, relative: string, limit: number = PLAN_CONTENT_LIMITS.fileBytes): Buffer | null {
  const target = safePath(root, relative);
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new PlanStoreError("Plan file is not regular or exceeds its size limit");
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new PlanStoreError("Plan file exceeds its size limit");
    return bytes;
  } finally { closeSync(fd); }
}

/** No asynchronous gap between rechecking the parent/baseline and rename. */
export function replaceSafe(root: string, relative: string, bytes: Buffer, expected: string | null): void {
  const target = safePath(root, relative, true);
  const current = readSafe(root, relative);
  if ((current ? digest(current) : null) !== expected) throw new PlanStoreError(`Operator edit conflicts with ${relative}; restore the expected bytes before retrying`);
  const temporary = `${relative}.${randomUUID()}.tmp`;
  const staged = safePath(root, temporary);
  const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    safePath(root, relative);
    const latest = readSafe(root, relative);
    if ((latest ? digest(latest) : null) !== expected) throw new PlanStoreError(`Operator edit conflicts with ${relative}`);
    renameSync(staged, target);
  } finally { rmSync(staged, { force: true }); }
}
