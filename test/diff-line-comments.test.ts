/**
 * Line comments from the Diff tab.
 *
 * A comment written on a diff row is the Files tab's comment - same path, same working-tree
 * line, same quote, same thread - so what is pinned here is the part a diff has to decide that
 * an editor never does: which rows are lines of the current file, why a file takes no comment,
 * and that the rendered table names its controls the way the Files tab names its own. The
 * click becoming a durable row and a marker in both tabs is `e2e/specs/diff-line-comments.spec.ts`.
 *
 * `createElement` rather than JSX, because the runner's glob is `test/**\/*.test.ts` only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  FileCommentMessage,
  FileCommentThread,
  SessionFileDocument,
} from "../src/shared/types.ts";
import type { DiffFile, DiffLine } from "../src/web/lib/diff.ts";
import { parsePatch } from "../src/web/lib/diff.ts";
import { diffCommentBlockReason, diffRowSourceLine } from "../src/web/lib/diffComments.ts";
import {
  isReadOnlyWorkspace,
  reanchorThreadsForDisplay,
  sourceLines,
} from "../src/web/lib/fileComments.ts";
import {
  DiffCommentControls,
  DiffLines,
  type DiffFileComments,
} from "../src/web/components/DiffLineComments.tsx";

function message(over: Partial<FileCommentMessage> = {}): FileCommentMessage {
  return {
    id: "m1",
    threadId: "t1",
    author: "human",
    sessionId: "s1",
    body: "Why is this thirty?",
    deliveredAt: null,
    readAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function thread(over: Partial<FileCommentThread> = {}): FileCommentThread {
  return {
    id: "t1",
    shortId: "MC-0001",
    sessionId: "s1",
    path: "src/retry.ts",
    startLine: 2,
    endLine: 2,
    quote: "const budget = 30;",
    quoteHash: "hash",
    revision: null,
    surface: "editor",
    htmlBlockPath: null,
    htmlBlockQuote: null,
    status: "queued",
    outdated: false,
    queueSeq: 1,
    deliveryId: null,
    sentAt: null,
    answeredAt: null,
    addressedAt: null,
    resolvedAt: null,
    createdAt: 1,
    updatedAt: 1,
    messages: [message()],
    messageCount: 1,
    ...over,
  };
}

function document(over: Partial<SessionFileDocument> = {}): SessionFileDocument {
  return {
    path: "src/retry.ts",
    kind: "text",
    editable: true,
    text: "import { x } from \"y\";\nconst budget = 30;\nexport default budget;\n",
    size: 64,
    mtime: 1,
    language: "typescript",
    revision: "rev-1",
    error: null,
    ...over,
  };
}

/** The working tree after the change: line 2 was rewritten, line 3 is unchanged context. */
const PATCH = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1,3 +1,3 @@",
  " import { x } from \"y\";",
  "-const budget = 10;",
  "+const budget = 30;",
  " export default budget;",
].join("\n");

function rows(): DiffLine[] {
  return parsePatch(PATCH)[0]!.lines;
}

function file(over: Partial<DiffFile> = {}): DiffFile {
  return { ...parsePatch(PATCH)[0]!, ...over };
}

test("only added and context rows are lines of the working tree", () => {
  const lines = sourceLines(document().text!);
  const [hunk, ctx, del, add, tail] = rows();
  assert.equal(diffRowSourceLine(hunk!, lines), null, "a hunk header is git's, not the file's");
  assert.equal(diffRowSourceLine(ctx!, lines), 1);
  assert.equal(diffRowSourceLine(del!, lines), null, "a deleted line is no longer in the file");
  assert.equal(diffRowSourceLine(add!, lines), 2);
  assert.equal(diffRowSourceLine(tail!, lines), 3);
});

test("a row that no longer agrees with the file takes no comment", () => {
  // The agent rewrote line 2 again after the diff loaded. Anchoring by the diff's number alone
  // would quote `30` and file the thread against whatever line 2 says now.
  const moved = sourceLines("import { x } from \"y\";\nconst budget = 45;\nexport default budget;\n");
  const add = rows()[3]!;
  assert.equal(diffRowSourceLine(add, moved), null);
  // And nothing is guessed before the document arrives.
  assert.equal(diffRowSourceLine(add, null), null);
});

test("a CRLF file's rows still match their lines", () => {
  // `git diff` keeps the `\r` on each line of a CRLF file; `sourceLines` splits it off.
  const crlf = sourceLines("import { x } from \"y\";\r\nconst budget = 30;\r\n");
  const add: DiffLine = { type: "add", text: "const budget = 30;\r", oldNo: null, newNo: 2 };
  assert.equal(diffRowSourceLine(add, crlf), 2);
});

test("every file says why it takes no comment, and loading is not a reason", () => {
  const target = { path: "src/retry.ts", reason: null };
  const ok = { file: file(), target, commit: null, document: document(), documentError: null };
  assert.equal(diffCommentBlockReason(ok), null);
  assert.equal(
    diffCommentBlockReason({ ...ok, document: null }),
    null,
    "the toggle stays usable while the file is read, so switching files does not flicker it",
  );
  assert.match(diffCommentBlockReason({ ...ok, commit: "abc123" }) ?? "", /single commit/);
  assert.match(
    diffCommentBlockReason({
      ...ok,
      file: file({ status: "deleted" }),
      target: { path: null, reason: "This file was deleted, so there is nothing to open." },
    }) ?? "",
    /deleted, so it has no lines left to comment on/,
  );
  const outside = "This file is outside the session's working directory, so the Files tab cannot open it.";
  assert.equal(diffCommentBlockReason({ ...ok, target: { path: null, reason: outside } }), outside);
  assert.match(diffCommentBlockReason({ ...ok, file: file({ binary: true }) }) ?? "", /binary/i);
  assert.match(diffCommentBlockReason({ ...ok, documentError: "HTTP 413" }) ?? "", /HTTP 413/);
  assert.match(
    diffCommentBlockReason({ ...ok, document: document({ kind: "oversized", text: null }) }) ?? "",
    /no source to comment on/,
  );
});

test("a thread is drawn where its quote sits now, in both tabs", () => {
  // Two lines were inserted above the quote after the comment was answered.
  const now = "// a\n// b\nimport { x } from \"y\";\nconst budget = 30;\n";
  const [moved] = reanchorThreadsForDisplay([thread()], now, "rev-2");
  assert.equal(moved!.startLine, 4);
  assert.equal(moved!.outdated, false);

  const [gone] = reanchorThreadsForDisplay([thread()], "nothing like it\n", "rev-3");
  assert.equal(gone!.outdated, true);

  const same = thread({ revision: "rev-1" });
  const [kept] = reanchorThreadsForDisplay([same], "anything", "rev-1");
  assert.equal(kept, same, "an unchanged revision keeps the same object, so memos hold");
});

test("pinned provider evidence is read-only for comments", () => {
  assert.equal(isReadOnlyWorkspace({ workspace: null }), false);
  assert.equal(
    isReadOnlyWorkspace({
      workspace: { authority: "provider", capabilities: { write: false } },
    } as never),
    true,
  );
  assert.equal(
    isReadOnlyWorkspace({
      workspace: { authority: "provider", capabilities: { write: true } },
    } as never),
    false,
  );
});

function model(over: Partial<DiffFileComments> = {}): DiffFileComments {
  const lines = sourceLines(document().text!);
  const threads = new Map([[2, [thread()]]]);
  return {
    active: true,
    blockReason: null,
    readOnly: false,
    onToggleMode: () => {},
    resolvedCount: 0,
    showResolved: false,
    onToggleResolved: () => {},
    sourceLine: (line) => diffRowSourceLine(line, lines),
    threadsOn: (line) => threads.get(line) ?? [],
    onLineSelect: () => {},
    onMarkerSelect: () => {},
    panelLine: null,
    panel: null,
    notice: null,
    onDismissNotice: () => {},
    ...over,
  };
}

test("in comment mode every working-tree line number is a named button, and no deleted one is", () => {
  const html = renderToStaticMarkup(createElement(DiffLines, { lines: rows(), comments: model() }));
  assert.match(html, /aria-label="Comment on line 1"/);
  assert.match(html, /aria-label="Comment on line 2"/);
  assert.match(html, /aria-label="Comment on line 3"/);
  // Three buttons for three working-tree rows: the hunk header and the deleted row have none.
  assert.equal(html.match(/class="dl-num-comment"/g)?.length, 3);
  // The marker is the Files editor's, named for its line and state.
  assert.match(html, /class="cm-file-comment-marker is-queued" aria-label="Comment MC-0001 on line 2, queued"/);
});

test("outside comment mode the numbers are text, and markers are still drawn", () => {
  const html = renderToStaticMarkup(
    createElement(DiffLines, { lines: rows(), comments: model({ active: false }) }),
  );
  assert.doesNotMatch(html, /dl-num-comment/);
  assert.match(html, /aria-label="Comment MC-0001 on line 2, queued"/);
});

test("the open panel is a full-width row directly under its line", () => {
  const html = renderToStaticMarkup(
    createElement(DiffLines, {
      lines: rows(),
      comments: model({
        panelLine: 2,
        panel: createElement("section", { "aria-label": "the panel" }),
      }),
    }),
  );
  const added = html.indexOf("const budget = 30;");
  const panel = html.indexOf('class="dl-comment-row"');
  const next = html.indexOf("export default budget;");
  assert.ok(added >= 0 && panel > added && next > panel, "the panel sits between line 2 and line 3");
  assert.match(html, /<td colSpan="4"><div class="diff-comment-host"><section aria-label="the panel">/i);
});

test("a diff with no comment model renders exactly as before", () => {
  const html = renderToStaticMarkup(createElement(DiffLines, { lines: rows(), comments: null }));
  assert.doesNotMatch(html, /dl-num-comment|cm-file-comment-marker|dl-comment-row/);
  assert.match(html, /<td class="dl-num">2<\/td>/);
});

test("a read-only session keeps Resolved, and only Resolved, while the file has closed threads", () => {
  const render = (over: Partial<DiffFileComments>) =>
    renderToStaticMarkup(createElement(DiffCommentControls, { comments: model(over) }));
  // Closed threads stay readable evidence, and with no comment mode this toggle is the only way
  // to bring one back on screen.
  const readOnly = render({ readOnly: true, active: false, resolvedCount: 1 });
  assert.match(readOnly, /aria-label="Show resolved comments"/);
  assert.doesNotMatch(readOnly, /aria-label="Comment mode"/);
  assert.equal(render({ readOnly: true, active: false, resolvedCount: 0 }), "");
  // A writable session keeps the Files toolbar's rule: Resolved is a comment-mode control.
  const writable = render({ active: false, resolvedCount: 1 });
  assert.match(writable, /aria-label="Comment mode"/);
  assert.doesNotMatch(writable, /Show resolved comments/);
  assert.match(render({ active: true, resolvedCount: 1 }), /aria-label="Show resolved comments"/);
});
