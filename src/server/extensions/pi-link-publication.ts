import { lstatSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { exchangePaths, publishSymlinkNoReplace, renameNoReplace } from "../symlink-publication.ts";

/** The intent owner supplies compensation for a completed write that loses provenance. */
export type ExtensionIntentCommit = () => void | (() => void);
export interface ExtensionLinkIdentity { entry: Stats; target: string }

function matchesLink(path: string, expected: ExtensionLinkIdentity): boolean {
  try {
    const current = lstatSync(path, { throwIfNoEntry: false });
    return !!current?.isSymbolicLink() && current.dev === expected.entry.dev && current.ino === expected.entry.ino
      && readlinkSync(path) === expected.target;
  } catch { return false; }
}

export function commitExtensionIntent(path: string, expected: ExtensionLinkIdentity, commit?: ExtensionIntentCommit): void {
  const verify = () => {
    if (!matchesLink(path, expected)) throw new Error("Pi extension entry changed during publication");
  };
  verify();
  const rollback = commit?.();
  try { verify(); }
  catch (error) { rollback?.(); throw error; }
}

/** An exchange retains the displaced entry until intent and provenance commit. Rollback
 * never overwrites a public path: unexpected entries are restored exclusively, or
 * retained in the reported private directory if another writer blocks restoration. */
export function publishExtensionLink(path: string, target: string, previous: ExtensionLinkIdentity | undefined, commit?: ExtensionIntentCommit): void {
  const stage = mkdtempSync(join(dirname(path), ".mission-extension-"));
  const staged = join(stage, "candidate");
  const recovery = new Set<string>();
  let displaced = false;
  let published: ExtensionLinkIdentity | undefined;
  const restore = (from: string) => {
    recovery.add(from);
    renameNoReplace(from, path);
    recovery.delete(from);
  };
  const withdraw = () => {
    if (!published || !matchesLink(path, published)) return false;
    const captured = join(stage, "withdrawn");
    try { renameNoReplace(path, captured); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    recovery.add(captured);
    if (!matchesLink(captured, published)) { restore(captured); return false; }
    recovery.delete(captured); // Only this attempt's verified inode may be discarded.
    return true;
  };
  try {
    // Pin the inode privately until commit and rollback finish, including after exchange.
    const anchor = join(stage, "anchor");
    symlinkSync(target, anchor, "file");
    const identity = { entry: lstatSync(anchor), target };
    publishSymlinkNoReplace(anchor, staged);
    if (previous) {
      if (!matchesLink(path, previous)) throw new Error("Pi extension entry changed during publication");
      exchangePaths(staged, path);
      displaced = true;
      published = identity;
      recovery.add(staged);
      if (!matchesLink(staged, previous)) throw new Error("Pi extension entry changed during publication");
    } else {
      publishSymlinkNoReplace(staged, path);
      published = identity;
    }
    commitExtensionIntent(path, identity, commit);
    recovery.delete(staged); // Only a committed replacement may discard the previous link.
  } catch (error) {
    try {
      const removed = withdraw();
      if (displaced && (removed || recovery.has(staged))) restore(staged);
    } catch (rollbackError) {
      // Retain a known previous link too when withdrawal/restoration fails, so recovery
      // does not depend on recreating it from a log or on the original checkout.
      recovery.add(staged);
      throw new Error(`Pi publication rollback failed; recovery entries retained at ${stage}`, { cause: rollbackError });
    }
    throw error;
  } finally {
    if (recovery.size === 0) rmSync(stage, { recursive: true, force: true });
  }
}
