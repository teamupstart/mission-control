import { statSync } from "node:fs";
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
 * Null when the path is not a directory that can be read now.
 */
export function checkoutIdentity(path: string | null | undefined): TaskHibernationCheckout | null {
  if (!path) return null;
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isDirectory()) return null;
    return { path, dev: String(stat.dev), ino: String(stat.ino) };
  } catch {
    return null;
  }
}

/**
 * Why the conversation cannot be reopened in its saved checkout, or null when the directory at
 * its path is still the one it was hibernated in. Resume asks before it starts anything, so a
 * different checkout standing at the same path never receives the old task's conversation.
 */
export function checkoutMismatch(saved: TaskHibernationCheckout | null): string | null {
  if (!saved) return "Mission Control did not record which checkout it ran in, so it cannot verify where to reopen it";
  const now = checkoutIdentity(saved.path);
  if (!now) return `its checkout ${saved.path} no longer exists`;
  if (now.dev !== saved.dev || now.ino !== saved.ino) {
    return `the checkout at ${saved.path} is not the one it was hibernated in: that worktree was removed and another directory now stands at its path`;
  }
  return null;
}
