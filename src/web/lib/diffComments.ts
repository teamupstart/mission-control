// What the Diff tab needs to know about line comments, with no React and no I/O.
//
// A comment made in the Diff tab is the same durable thread a comment made in the Files tab
// is: the same session, the same Files-relative path, the same working-tree line and quote,
// the same `editor` surface. The diff is only a second place to point from. So nothing here
// invents an anchor. It answers two questions the Files editor never has to ask, because the
// editor always holds the whole file and a diff holds only the hunks:
//
//   - which rows of the diff are lines of the current working-tree file, and
//   - why a changed file takes no comment at all.

import type { SessionFileDocument } from "@shared/types.ts";
import type { DiffFile, DiffFileTarget, DiffLine } from "./diff.ts";
import { isCommentableDocument } from "./fileComments.ts";

/**
 * Why this changed file cannot take a new line comment, or null when it can.
 *
 * Asked in the order a reader would want the answer. A commit diff comes first because it is
 * true of every file in it: its new side is that commit's tree, not the working tree a thread
 * anchors to, so a line number read off it names a line the Files tab may not have. A file
 * the Files tab cannot open comes next, because comments live where the Files tab does - the
 * resolver's own reason says which case it is.
 *
 * A document that has not arrived yet is NOT a reason. The Comment toggle stays usable while
 * the file loads, and the line numbers become clickable when there is text to check them
 * against - so switching files with the mode on does not flicker the control off and back.
 */
export function diffCommentBlockReason(input: {
  file: DiffFile;
  target: DiffFileTarget;
  commit: string | null | undefined;
  document: SessionFileDocument | null;
  documentError: string | null;
}): string | null {
  const { file, target, commit, document, documentError } = input;
  if (commit) {
    return "Comments anchor to the working tree, and this diff shows a single commit";
  }
  if (file.status === "deleted") {
    return "This file was deleted, so it has no lines left to comment on";
  }
  if (target.path === null) return target.reason ?? "The Files tab cannot open this file";
  if (file.binary) return "A binary file has no lines to comment on";
  if (documentError) return `This file could not be read for comments: ${documentError}`;
  if (document && !isCommentableDocument(document)) {
    return document.kind === "image"
      ? "An image has no lines to comment on"
      : "This file has no source to comment on";
  }
  return null;
}

/**
 * The working-tree line a diff row stands for, or null when the row cannot carry a comment.
 *
 * Only an added or context row exists in the working tree. A deleted row is text that is
 * gone, and a hunk header is git's, so neither has a line a thread could anchor to.
 *
 * And the row has to AGREE with the file as it reads now. The diff is a snapshot taken when
 * the tab loaded, and the agent may have edited the file since: anchoring by the diff's line
 * number alone would quote one line and file the thread against whatever now sits at that
 * number. Compared with trailing whitespace dropped, because a CRLF file's patch keeps the
 * `\r` that `sourceLines` splits off, and because `reanchor()` ignores it too.
 *
 * `lines` is null until the document arrives, which makes every row inert rather than
 * guessed at.
 */
export function diffRowSourceLine(
  line: DiffLine,
  lines: readonly string[] | null,
): number | null {
  if (!lines || line.newNo === null) return null;
  if (line.type !== "add" && line.type !== "ctx") return null;
  const current = lines[line.newNo - 1];
  if (current === undefined) return null;
  return current.trimEnd() === line.text.trimEnd() ? line.newNo : null;
}
