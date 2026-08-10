import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative } from "node:path";
import { decodeUtf8Whole } from "./utf8.ts";

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

/**
 * Read at most `n` bytes off the front of a file - never more than we'll use.
 *
 * Decoded through `decodeUtf8Whole` rather than `toString("utf8")` because `n` can land
 * mid-character: a doc capped at its byte ceiling would otherwise end in U+FFFD, and
 * these go straight into a model prompt. Whole characters only, so the partial tail is
 * dropped instead of mangled - and it has to be judged on the BYTES, since decoding
 * first bakes the replacement character in where no later clip can remove it.
 */
export function readCapped(path: string, n: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return decodeUtf8Whole(buf.subarray(0, read));
  } finally {
    closeSync(fd);
  }
}

export interface RepoDoc {
  /** Repo-relative path, so a caller can cite the file the repo knows it by. */
  path: string;
  /**
   * The path this doc was actually read from, after links. IDENTITY, never citation.
   *
   * Two names for one file are one document, and only the resolved path can say so: a
   * repo whose CLAUDE.md is a symlink to its AGENTS.md - which is this one - satisfies
   * both entries of a caller's name list, and a de-duplication keyed on the REQUESTED
   * path emits the same bytes twice - a whole second copy of the doc in every Inspector
   * review and Foreman verify prompt. The waste is `min(fileSize, maxBytes)` per
   * duplicated doc, so it is not a fixed figure: it tracks whatever the root doc
   * currently weighs. It was 24,576 bytes per prompt when the defect was found;
   * `docs/agent-guides/inspector-prompt-bytes.md` holds the measurement and how to re-run it.
   *
   * Reported here rather than recomputed by the caller because the `realpathSync`
   * below has already paid for it, and - the load-bearing half - because a second
   * resolution in a caller is one this function's containment check never saw. The
   * caller would be keying on a path that may point clean out of the repo.
   *
   * Cite `path`. This one names wherever the links happen to land, which is not what
   * the repo knows the file by.
   */
  realPath: string;
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
      realPath: real,
      text: readCapped(real, Math.min(stat.size, maxBytes)),
      truncated: stat.size > maxBytes,
    };
  } catch {
    return null; // missing, unreadable, or a dangling link
  }
}
