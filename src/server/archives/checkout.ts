import { lstat, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { run } from "../util/exec.ts";
import { isInside } from "./paths.ts";
import type { ArchiveRepoSlot } from "./capture-store.ts";
import type { ResolvedRoot } from "./plan.ts";

/**
 * Checkout-side containment: turning a claimed relative path into a real file this daemon is
 * willing to read.
 *
 * The mirror of `paths.ts`, against the other root. That one resolves a manifest's claim
 * inside a bundle; this one resolves a plan's claim inside a checkout, with the same three
 * refusals for the same reasons. Kept apart from both the planner and the publisher because
 * every kind's planner needs it and none of them should be re-deriving what "inside the
 * checkout" means.
 */

/** How long one git question about a checkout may take before it is treated as unanswerable. */
const GIT_TIMEOUT_MS = 10_000;

export async function resolveRoots(repos: readonly ArchiveRepoSlot[]): Promise<ResolvedRoot[]> {
  const out: ResolvedRoot[] = [];
  for (const repo of repos) {
    const realRoot = repo.root ? await realpath(repo.root).catch(() => null) : null;
    out.push({ ...repo, realRoot });
  }
  return out;
}

export function primaryRoot(roots: readonly ResolvedRoot[]): ResolvedRoot | null {
  return roots.find((entry) => entry.primary) ?? roots[0] ?? null;
}

export type ResolvedCheckoutEntry =
  | { ok: true; path: string; info: Stats }
  | { ok: false; reason: string };

export type ResolvedCheckoutFile =
  | { ok: true; path: string; bytes: number; dev: number; ino: number }
  | { ok: false; reason: string };

/**
 * One checkout-relative entry, resolved to a real path inside a real root.
 *
 * The same three refusals `resolveArchiveFile` makes on the archive side, for the same
 * reasons, against a different root: the path must be relative and free of NUL and control
 * characters, the JOINED path must stay under the root, and the REALPATH must too - which is
 * the only check that sees a symlink swapped in after the plan was made. `lstat` rather than
 * `stat` throughout, because `stat` follows a link and would report its target's type.
 */
async function resolveCheckoutEntry(
  realRoot: string,
  relativePath: string,
): Promise<ResolvedCheckoutEntry> {
  if (relativePath === "" || path.isAbsolute(relativePath)) {
    return { ok: false, reason: "must be a path relative to the checkout" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(relativePath)) {
    return { ok: false, reason: "contains characters a path cannot carry" };
  }
  const joined = path.resolve(realRoot, relativePath);
  if (!isInside(realRoot, joined) || joined === realRoot) {
    return { ok: false, reason: "leaves the checkout" };
  }
  // Every component, not only the leaf: a symlinked DIRECTORY on the way down is how a
  // contained-looking path reads a file outside the checkout, and `lstat` on the leaf alone
  // would never see it.
  let walked = realRoot;
  for (const segment of path.relative(realRoot, joined).split(path.sep)) {
    walked = path.join(walked, segment);
    const info = await lstat(walked).catch(() => null);
    if (!info) return { ok: false, reason: "does not exist" };
    if (info.isSymbolicLink()) return { ok: false, reason: "resolves through a symbolic link" };
  }
  const info = await lstat(joined).catch(() => null);
  if (!info) return { ok: false, reason: "does not exist" };
  const real = await realpath(joined).catch(() => null);
  if (!real || !isInside(realRoot, real)) {
    return { ok: false, reason: "resolves outside the checkout" };
  }
  return { ok: true, path: real, info };
}

/** One checkout-relative path, resolved to a real regular file inside a real root. */
export async function resolveCheckoutFile(realRoot: string, relativePath: string): Promise<ResolvedCheckoutFile> {
  const entry = await resolveCheckoutEntry(realRoot, relativePath);
  if (!entry.ok) return entry;
  if (!entry.info.isFile()) return { ok: false, reason: "is not an ordinary file" };
  return {
    ok: true,
    path: entry.path,
    bytes: entry.info.size,
    dev: entry.info.dev,
    ino: entry.info.ino,
  };
}

/** A report-directory path, resolved without accepting a symlinked component. */
export async function resolveCheckoutDirectory(
  realRoot: string,
  relativePath: string,
): Promise<{ ok: true; path: string; dev: number; ino: number } | { ok: false; reason: string }> {
  const entry = await resolveCheckoutEntry(realRoot, relativePath);
  if (!entry.ok) return entry;
  if (!entry.info.isDirectory()) return { ok: false, reason: "is not a directory" };
  return { ok: true, path: entry.path, dev: entry.info.dev, ino: entry.info.ino };
}

/**
 * Whether git would exclude this path from the checkout.
 *
 * Two questions rather than one, because `check-ignore` consults only the exclude rules: a
 * file that is TRACKED but also matches an ignore pattern would be reported as ignored, and
 * refusing a committed report on that basis would be wrong. So an ignored-looking path gets a
 * second question - is it in the index? - and only a path that is both excluded and untracked
 * is refused.
 *
 * A directory that is not a git repository, or a machine with no git, answers "not ignored".
 * That is the permissive direction on purpose: the file is still contained, still an ordinary
 * file, and still explicitly named by the scout, and the alternative - refusing every capture
 * we cannot interrogate - would make a non-git checkout unarchivable.
 */
export async function isIgnored(realRoot: string, relativePath: string): Promise<boolean> {
  const excluded = await run("git", ["-C", realRoot, "check-ignore", "-q", "--", relativePath], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (excluded.code !== 0) return false;
  const tracked = await run("git", ["-C", realRoot, "ls-files", "--error-unmatch", "--", relativePath], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return tracked.code !== 0;
}

/** The commit a checkout is standing on right now, or the recorded fallback. Informational. */
export async function headOf(root: ResolvedRoot): Promise<string | null> {
  if (!root.realRoot) return root.head;
  const result = await run("git", ["-C", root.realRoot, "rev-parse", "HEAD"], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : root.head;
}
