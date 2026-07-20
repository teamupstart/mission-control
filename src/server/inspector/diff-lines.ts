// Which (path, line) pairs GitHub will actually accept an inline comment on.
//
// This exists because of how the reviews API fails. Posting a review with N inline
// comments is ONE call, and if a single comment names a line that isn't part of the
// diff, GitHub rejects the whole request with a 422 - every other finding in that round
// is lost with it. A model asked for a line number will eventually give a plausible
// wrong one, so this is not a rare path.
//
// Parsing the hunk headers ourselves is the cheap fix: findings that validate go inline,
// findings that don't get demoted into the review's body text, and the round lands.

/** The new-file line numbers that are commentable, per path. */
export type CommentableLines = Map<string, Set<number>>;

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff into the set of RIGHT-side lines per file.
 *
 * Added and context lines both count - GitHub accepts a comment on either, and a
 * reviewer often wants to point at unchanged code immediately around a change.
 * Removed lines do not: they don't exist in the new file, so they have no right-side
 * number to anchor to.
 *
 * Renames are read off the `+++` header rather than `diff --git`, so a comment lands
 * on the file's NEW path, which is the only one GitHub will accept.
 */
export function commentableLines(diff: string): CommentableLines {
  const out: CommentableLines = new Map();
  let path: string | null = null;
  let line = 0;
  let remaining = 0;

  // Drop the empty element a trailing newline leaves behind. It is not a line of the
  // diff, but an empty string is indistinguishable from an empty CONTEXT line (some
  // tools strip the leading space off those), so it would be counted as one - inventing
  // a line one past the end of the last hunk.
  //
  // That is not cosmetic. We cap the diff we send, so a truncated final hunk whose
  // header promises more lines than are present is an ORDINARY case here, and it is
  // exactly the case where the phantom line gets counted: a comment anchored to it is
  // the 422 that discards the whole review.
  const rows = diff.split("\n");
  if (rows.length && rows[rows.length - 1] === "") rows.pop();

  for (const raw of rows) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      // /dev/null is a deletion: the file has no new side to comment on.
      path = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (path && !out.has(path)) out.set(path, new Set());
      remaining = 0;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git ")) continue;

    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      // A header with no count means exactly one line ("@@ -1 +1 @@").
      remaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (!path || remaining <= 0) continue;

    // "\ No newline at end of file" annotates the previous line; it is not one.
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("-")) continue; // left side only - no new-file line number
    if (raw.startsWith("+") || raw.startsWith(" ") || raw === "") {
      out.get(path)!.add(line);
      line++;
      remaining--;
    }
  }
  return out;
}

/** Every path the diff touches - what a finding must name to be postable at all. */
export function changedPaths(diff: string): string[] {
  return [...commentableLines(diff).keys()];
}
