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
