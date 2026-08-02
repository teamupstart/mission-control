// Pure unified-diff parsing for the DiffViewer. Kept React-free so it can be
// unit-tested directly. Turns a (possibly multi-file) `git diff` patch into
// per-file hunks with old/new line numbers and +/- classification.

export type DiffLineType = "add" | "del" | "ctx" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffFile {
  path: string;
  status: "added" | "deleted" | "renamed" | "modified";
  added: number;
  removed: number;
  binary: boolean;
  lines: DiffLine[];
}

/** A changed file's route into the Files tab, or the reason it has none. */
export interface DiffFileTarget {
  /**
   * The path to hand the Files workspace, relative to the session's cwd because that
   * is what the Files workspace is rooted at. Null exactly when `reason` is set.
   */
  path: string | null;
  /** Why this file cannot be opened in the Files tab, or null when it can. */
  reason: string | null;
}

/** Drop any trailing slashes so two directory paths concatenate predictably. */
function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * Where a changed file lives for the Files tab, or why it cannot go there.
 *
 * The two readers do not measure paths from the same place, and neither is wrong.
 * Git emits toplevel-relative paths wherever it is invoked from, so the patch is
 * relative to `SessionDiff.repoRoot` (`computeSessionDiff` runs `git diff` with no
 * pathspec, so the patch spans the whole repository). The Files browser runs
 * `git ls-files` inside the session's cwd and lists only that subtree, so its paths
 * are relative to `cwd` (`listSessionFiles`). For a session sitting at the repo root -
 * every dispatched session, since a worktree IS its root - those are the same
 * directory and every changed file resolves.
 *
 * They differ for a session opened in a SUBDIRECTORY, and there the difference is not
 * cosmetic. Handing the patch's path over as written makes the daemon resolve it
 * against cwd, so a changed root `src/index.ts` opens the package's own `src/index.ts`
 * instead: a real file, the wrong file, no error anywhere. Reaching the real one needs
 * `../../src/index.ts`, which the daemon refuses with 403 "path leaves the session
 * checkout" - the containment every session file read goes through. A file above cwd
 * therefore has no route into this session's Files tab at all, and saying so is the
 * only honest answer available.
 *
 * Both sides are physical paths, so the comparison below is sound rather than merely
 * conservative: git reports `--show-toplevel` resolved, `lsof -d cwd` reports the
 * kernel's resolved cwd for an adopted session, and a dispatched session's cwd is
 * `realpathSync`'d. A symlinked checkout does not produce a spurious refusal.
 *
 * Deliberately NOT `workspaceFileTarget`, which the transcript uses: that function
 * reads a trailing `:12` as a line number because a path in prose means it that way.
 * A path from `git diff` is exact, and a file genuinely named `notes:12` would be
 * routed to `notes` - enabled, and opening the wrong file.
 */
export function diffFileOpenTarget(
  file: DiffFile,
  repoRoot: string | null,
  cwd: string | null,
): DiffFileTarget {
  // A deleted file is gone from the checkout; there is no working-tree copy to read.
  if (file.status === "deleted") {
    return { path: null, reason: "This file was deleted, so there is nothing to open." };
  }
  if (!cwd) return { path: null, reason: "This session has no working directory." };
  // `repoRoot` is null only when the cwd is not a git repo, in which case there is no
  // patch to be reading in the first place - but the diff can outlive that fact.
  if (!repoRoot) return { path: null, reason: "The checkout root for this diff is unknown." };
  // Git does not emit these, and the daemon would refuse them; neither is a reason to
  // hand one to it.
  if (file.path.split("/").some((segment) => segment === ".." || segment === "")) {
    return { path: null, reason: "This file's path cannot be resolved in the checkout." };
  }

  const root = trimTrailingSlash(repoRoot);
  const base = trimTrailingSlash(cwd);
  const absolute = `${root}/${file.path}`;
  if (base !== root && !absolute.startsWith(`${base}/`)) {
    return { path: null, reason: "This file is outside the session's checkout." };
  }
  return { path: absolute.slice(base.length + 1), reason: null };
}

/** Strip a leading a/ or b/ prefix (git's default) and surrounding quotes. */
function stripPrefix(p: string): string {
  return p.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
}

/** Parse a unified diff into files with numbered lines. */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git")) {
      cur = { path: "", status: "modified", added: 0, removed: 0, binary: false, lines: [] };
      files.push(cur);
      const m = raw.match(/ b\/(.+)$/);
      if (m) cur.path = stripPrefix("b/" + m[1]);
      continue;
    }
    if (!cur) continue;

    if (raw.startsWith("new file mode")) cur.status = "added";
    else if (raw.startsWith("deleted file mode")) cur.status = "deleted";
    else if (raw.startsWith("rename ")) cur.status = "renamed";
    else if (raw.startsWith("Binary files")) cur.binary = true;
    else if (raw.startsWith("--- ")) {
      /* old-path header - the path is already taken from `diff --git` / +++ */
    } else if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") cur.path = stripPrefix(p);
    } else if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      cur.lines.push({ type: "hunk", text: raw, oldNo: null, newNo: null });
    } else if (raw.startsWith("+")) {
      cur.added++;
      cur.lines.push({ type: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      cur.removed++;
      cur.lines.push({ type: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (raw.startsWith(" ")) {
      cur.lines.push({ type: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
    // Other metadata lines (index, mode, "\ No newline") are dropped from the view.
  }
  return files;
}
