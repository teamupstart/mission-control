import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative } from "node:path";

// Reading a markdown doc OUT of a repo and INTO a model prompt, safely.
//
// Extracted from standards.ts because a second caller arrived (the Inspector's
// INSPECTOR.md) and the interesting part of this is not "read a file" - it is the
// ordering of the symlink check against the read, which is easy to get subtly wrong
// and impossible to notice when you have. One implementation, two callers.

/** True when `abs` is at or under `root` (defeats a `..` escape in a diff path). */
export function withinRoot(root: string, abs: string): boolean {
  const rel = relative(root, normalize(abs));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The resolved path, or the input when it can't be resolved (a root that's gone). */
export function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Read at most `n` bytes off the front of a file - never more than we'll use. */
export function readCapped(path: string, n: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export interface RepoDoc {
  /** Repo-relative path, so a caller can cite the file the repo knows it by. */
  path: string;
  text: string;
  /** True when the file was capped for size. */
  truncated: boolean;
}

/**
 * Read one doc out of a repo, or null when it isn't one we may read.
 *
 * The containment check runs on the REAL path, after symlinks are resolved, and that
 * ordering is the whole point: a path check is string work, while reading follows
 * links. A repo shipping `AGENTS.md` as a symlink to `~/.ssh/id_rsa` satisfies a
 * check on the literal path and is then read anyway - and the contents go straight
 * into a prompt, which is sent to the API.
 *
 * That matters more here than the same bug would elsewhere. These prompts run with
 * repo content as untrusted input; this would hand that content the user's full read
 * access through the daemon. The `..` guard shows the escape class was already
 * considered - the symlink just walked around it.
 *
 * `maxBytes` caps the READ, via `stat` and a bounded `readCapped`, rather than
 * capping a string that was already materialized. An enormous doc would otherwise be
 * allocated in full on every call, and one past ~512MB would throw
 * ERR_STRING_TOO_LONG - which the catch below would swallow as "no such doc",
 * silently dropping the file instead of truncating it.
 *
 * `root` is the path to report relative to; `realRoot` is what containment is judged
 * against. They differ whenever the repo's own path runs through a symlink, which is
 * not exotic: /tmp is one on macOS, and so is many a home directory or checkout.
 */
export function readRepoDoc(
  root: string,
  realRoot: string,
  abs: string,
  maxBytes: number,
): RepoDoc | null {
  try {
    // Resolve first: a link's own path tells us nothing about what we'd read.
    const real = realpathSync(abs);
    if (!withinRoot(realRoot, real)) return null;
    const stat = statSync(real);
    if (!stat.isFile()) return null;
    return {
      // Cite the path the repo asked for, not the link target.
      path: relative(root, abs) || abs,
      text: readCapped(real, Math.min(stat.size, maxBytes)),
      truncated: stat.size > maxBytes,
    };
  } catch {
    return null; // missing, unreadable, or a dangling link
  }
}
