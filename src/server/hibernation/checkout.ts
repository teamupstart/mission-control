import { accessSync, constants, statSync } from "node:fs";
import type { TaskHibernationCheckout } from "@shared/hibernation.ts";

/**
 * The checkout a hibernated conversation ran in, as the filesystem identifies it: the
 * directory's device and inode, which survive the directory being moved away and back but not
 * it being removed and something else created at the same path. Strings, because an inode is a
 * 64-bit number a JavaScript number cannot always hold.
 *
 * That relies on the filesystem not handing a removed directory's inode number straight to the
 * next one. APFS, on the macOS Mission Control supports, does not reuse file ids that way.
 * Linux's ext4 can, so there a directory removed and recreated at once may read as the same.
 *
 * Null when the path is not a directory this process can read and enter now. A directory whose
 * identity can be read but whose contents cannot is not one an agent could be reopened in, so
 * Hibernate refuses it before stopping anything rather than strand the conversation.
 */
export function checkoutIdentity(path: string | null | undefined): TaskHibernationCheckout | null {
  const read = readCheckout(path);
  return "identity" in read ? read.identity : null;
}

/**
 * The checkout at `path`, or why there is none: `missing` only when the filesystem says nothing
 * is there (or not a directory), never for a permission or I/O failure, which leaves a checkout
 * that may well still exist - a parent that lost its search permission included.
 */
function readCheckout(path: string | null | undefined): { identity: TaskHibernationCheckout } | { missing: boolean } {
  if (!path) return { missing: true };
  let stat;
  try {
    stat = statSync(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { missing: code === "ENOENT" || code === "ENOTDIR" };
  }
  if (!stat.isDirectory()) return { missing: true };
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch {
    return { missing: false };
  }
  return { identity: { path, dev: String(stat.dev), ino: String(stat.ino) } };
}

/**
 * Why the conversation cannot be reopened in its saved checkout, or null when the directory at
 * its path is still the one it was hibernated in. Resume asks before it starts anything, so a
 * different checkout standing at the same path does not receive the old task's conversation -
 * as far as the filesystem's ids can tell them apart (see `checkoutIdentity`).
 */
export function checkoutMismatch(saved: TaskHibernationCheckout | null): string | null {
  if (!saved) return "Mission Control did not record which checkout it ran in, so it cannot verify where to reopen it";
  const read = readCheckout(saved.path);
  if (!("identity" in read)) {
    return read.missing
      ? `its checkout ${saved.path} no longer exists`
      : `its checkout ${saved.path} cannot be read by Mission Control`;
  }
  const now = read.identity;
  if (now.dev !== saved.dev || now.ino !== saved.ino) {
    return `the checkout at ${saved.path} is not the one it was hibernated in: that worktree was removed and another directory now stands at its path`;
  }
  return null;
}
