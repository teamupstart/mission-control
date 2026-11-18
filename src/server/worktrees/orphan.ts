import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * How a native slot that its repository's `git worktree list` does not name can be told
 * apart from one Git merely failed to describe.
 *
 * - `absent`: nothing is at the slot path at all. Only the row is left.
 * - `unregistered`: a directory is there, but it is no Git worktree any more. It has no `.git`
 *   link, or its `.git` file names an administrative directory that does not exist. That is
 *   what a re-clone or a moved main checkout leaves behind: every slot's link now resolves into
 *   a repository that never registered it, and no Git command run there can say whether its
 *   files are clean, committed or pushed.
 *
 * Neither is ever returned for a slot that Git still links somewhere, an embedded repository
 * of its own, a symbolic link at the slot or in any parent component, or a read that failed.
 * Those stay unproven, and whatever they block stays blocked.
 */
export type SlotOrphanEvidence = "absent" | "unregistered";

/** A `.git` link file is one short line. Anything larger is not one, and proves nothing. */
const LINK_FILE_MAX_BYTES = 4_096;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * The nearest existing ancestor of a missing path is a real directory that resolves to exactly
 * itself, so no component on the way to the missing path is a symbolic link. A dangling link
 * is found by `lstat` itself and refused.
 */
async function physicalAncestor(path: string): Promise<boolean> {
  let current = dirname(resolve(path));
  for (;;) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      return (await realpath(current)) === current;
    } catch (error) {
      if (!missing(error)) return false;
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

async function readLinkFile(path: string): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(LINK_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LINK_FILE_MAX_BYTES) return null;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Read-only. The caller has already proven the slot path is the exact native path of a pool
 * whose marker matches, and that a `git worktree list` which answered does not name it; this
 * only decides whether what is left on disk is provably not a worktree at all.
 */
export async function observeSlotOrphan(slotPath: string): Promise<SlotOrphanEvidence | null> {
  try {
    const slot = await lstat(slotPath);
    if (slot.isSymbolicLink() || !slot.isDirectory()) return null;
    // A symbolic link in any parent component would make every read below describe a
    // directory outside the pool. Only a path that resolves to exactly itself is the slot.
    if ((await realpath(slotPath)) !== resolve(slotPath)) return null;
  } catch (error) {
    if (!missing(error)) return null;
    // A missing path proves the slot is gone only if the place it would be is the pool's own.
    // Beneath a symbolic link in a parent component, ENOENT describes somewhere else.
    return (await physicalAncestor(slotPath)) ? "absent" : null;
  }
  const linkPath = join(slotPath, ".git");
  let link: Awaited<ReturnType<typeof lstat>>;
  try {
    link = await lstat(linkPath);
  } catch (error) {
    return missing(error) ? "unregistered" : null;
  }
  // A `.git` directory is a repository of its own, and a link is somebody else's choice.
  if (!link.isFile()) return null;
  let text: string | null;
  try {
    text = await readLinkFile(linkPath);
  } catch {
    return null;
  }
  const match = text?.match(/^gitdir: (.+?)\r?\n?$/);
  if (!match) return null;
  const target = isAbsolute(match[1]!) ? match[1]! : resolve(slotPath, match[1]!);
  try {
    await lstat(target);
    // It links to an administrative directory that exists. Whose it is, and what it says,
    // is a question for Git, which has just declined to list it here.
    return null;
  } catch (error) {
    return missing(error) ? "unregistered" : null;
  }
}
