import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MEMORY_INDEX_PATH, withMemoryPointer } from "@shared/memory.ts";
import { realpathOr, withinRoot } from "./util/repo-doc.ts";

// Finding a repository's committed agent memory on disk.
//
// The convention itself lives in `@shared/memory.ts`; this is the daemon's half - "does
// this checkout carry memory", asked of a worktree before a dispatch and of a repo root
// before a review.
//
// Containment is judged the same way `readRepoDoc` judges it, on the REAL path after
// links, for the same reason: `.agents/memory/MEMORY.md` is repo content, so a repo can
// ship it as a symlink to anywhere at all. Nothing here reads the file, so this is not
// the exfiltration case `readRepoDoc` guards - it is the honesty case. A pointer at a
// link that leaves the tree, or that dangles, is a pointer at something the repo does
// not assert, and the agent it is handed to would go read whatever is on the far end.

/**
 * True when `repoRoot` carries a readable memory index inside its own tree.
 *
 * A `stat` and a `realpath`, deliberately - the index is small but this runs on the
 * daemon's one synchronous handle at every dispatch, and existence is the whole question.
 */
export function hasRepoMemory(repoRoot: string | null): boolean {
  if (!repoRoot) return false;
  const root = resolve(repoRoot);
  const realRoot = realpathOr(root);
  try {
    const real = realpathSync(join(root, MEMORY_INDEX_PATH));
    if (!withinRoot(realRoot, real)) return false;
    return statSync(real).isFile();
  } catch {
    return false; // missing, unreadable, or a dangling link
  }
}

/**
 * The opening prompt for a session launched into `repoRoot`, pointed at its memory when
 * there is any - and returned untouched when there is not.
 *
 * Untouched matters: a repo with no memory would otherwise open every session by sending
 * it after a file that does not exist, which is a failed tool call and a paragraph of
 * confusion before turn one has begun.
 */
export function withRepoMemoryPointer(repoRoot: string | null, prompt: string): string {
  return hasRepoMemory(repoRoot) ? withMemoryPointer(prompt) : prompt;
}
