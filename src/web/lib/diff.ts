// Pure unified-diff parsing for the DiffViewer. Kept React-free so it can be
// unit-tested directly. Turns a (possibly multi-file) `git diff` patch into
// per-file hunks with old/new line numbers and +/- classification.

import { workspaceFileTarget } from "./workspaceLinks.ts";

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
   * The href to hand `onOpenFile`, absolute so it survives the two viewers'
   * disagreement below. Null exactly when `reason` is set.
   */
  href: string | null;
  /** Why this file cannot be opened in the Files tab, or null when it can. */
  reason: string | null;
}

/**
 * Where a changed file lives for the Files tab, or why it cannot go there.
 *
 * The two readers do not measure paths from the same place, and neither is wrong.
 * Git emits toplevel-relative paths wherever it is invoked from, so the patch is
 * relative to `SessionDiff.repoRoot`; the Files browser runs `git ls-files` inside
 * the session's cwd and lists only that subtree, so its paths are relative to `cwd`
 * (`listSessionFiles`, `session-files.ts`). For the common session those are the same
 * directory. For a session opened in a SUBDIRECTORY of its repo they are not, and
 * handing the diff's path straight to the Files tab would quietly open the wrong file
 * on every path that also exists under cwd - `src/index.ts` in a monorepo package
 * being the easy way to hit it.
 *
 * So the path is rebased through the repo root and back down with the same
 * `workspaceFileTarget` every transcript link already uses. That resolver rejects
 * anything not under cwd, which is also the honest answer for a changed file the
 * Files tab genuinely cannot reach: the button says why instead of failing on click.
 *
 * Note the string comparison is literal - a cwd reached through a symlink whose repo
 * root git reports physically (/tmp vs /private/tmp) resolves to "outside", which
 * disables the button rather than opening the wrong file. Refusing is the safe side
 * of that trade.
 */
export function diffFileOpenTarget(
  file: DiffFile,
  repoRoot: string | null,
  cwd: string | null,
): DiffFileTarget {
  // A deleted file is gone from the checkout; there is no working-tree copy to read.
  if (file.status === "deleted") {
    return { href: null, reason: "This file was deleted, so there is nothing to open." };
  }
  if (!cwd) return { href: null, reason: "This session has no working directory." };
  // `repoRoot` is null only when the cwd is not a git repo, in which case there is no
  // patch to be reading in the first place - but the diff can outlive that fact.
  if (!repoRoot) return { href: null, reason: "The checkout root for this diff is unknown." };

  const href = `${repoRoot.replace(/\/+$/, "")}/${file.path}`;
  if (!workspaceFileTarget(href, cwd)) {
    return { href: null, reason: "This file is outside the session's checkout." };
  }
  return { href, reason: null };
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
