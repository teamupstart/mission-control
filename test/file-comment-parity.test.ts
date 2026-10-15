/**
 * The Files tab and the Diff tab show comments through the same pieces.
 *
 * Pinned here: the per-file summary both file lists mark a file with, the rule that decides
 * which changed files have comments to show, and the shared toolbar's names and refusals. That
 * a click on any of them reaches a thread - a pinned header, the Comments index, a thread on a
 * line the diff does not show - is `e2e/specs/diff-comment-parity.spec.ts`.
 *
 * `createElement` rather than JSX, because the runner's glob is `test/**\/*.test.ts` only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileCommentMessage, FileCommentThread } from "../src/shared/types.ts";
import { parsePatch, type DiffFile } from "../src/web/lib/diff.ts";
import { diffFileCommentPath } from "../src/web/lib/diffComments.ts";
import {
  fileCommentSummaries,
  fileCommentSummaryLabel,
  fileCommentSummaryTone,
} from "../src/web/lib/fileComments.ts";
import { FileCommentBadge } from "../src/web/components/FileCommentBadge.tsx";
import { FileCommentControls } from "../src/web/components/FileCommentControls.tsx";
import { hasTooltip } from "./helpers/markup.ts";

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

const agentReply = (over: Partial<FileCommentMessage> = {}): FileCommentMessage =>
  message({ id: "m2", author: "agent", body: "Made it a constant.", ...over });

test("each commented file is summarized once, as the Comments index counts it", () => {
  const summaries = fileCommentSummaries([
    thread(),
    thread({ id: "t2", status: "answered", messages: [message(), agentReply()] }),
    thread({ id: "t3", status: "resolved", messages: [message(), agentReply()] }),
    thread({ id: "t4", path: "README.md", status: "draft" }),
    // Neither of these is on the reader's list: another session's thread, and one whose
    // session is gone.
    thread({ id: "t5", sessionId: "s2" }),
    thread({ id: "t6", path: "gone.ts", status: "orphaned" }),
  ], "s1");

  assert.deepEqual(summaries.get("src/retry.ts"), { total: 3, open: 2, unread: 1 });
  assert.deepEqual(summaries.get("README.md"), { total: 1, open: 1, unread: 0 });
  assert.equal(summaries.has("gone.ts"), false, "an orphaned thread marks nothing");
  assert.equal(summaries.size, 2);
});

test("a read reply, and a reply on a closed thread, stop asking for attention", () => {
  const read = fileCommentSummaries(
    [thread({ status: "answered", messages: [message(), agentReply({ readAt: 5 })] })],
    "s1",
  ).get("src/retry.ts")!;
  assert.equal(read.unread, 0);
  assert.equal(fileCommentSummaryTone(read), "is-open");

  const closed = fileCommentSummaries(
    [thread({ status: "resolved", messages: [message(), agentReply()] })],
    "s1",
  ).get("src/retry.ts")!;
  assert.deepEqual(closed, { total: 1, open: 0, unread: 0 });
  assert.equal(fileCommentSummaryTone(closed), "is-resolved");
});

test("the marker says in words what its colour says", () => {
  assert.equal(fileCommentSummaryLabel({ total: 1, open: 1, unread: 0 }), "1 comment");
  assert.equal(fileCommentSummaryLabel({ total: 3, open: 3, unread: 0 }), "3 comments");
  assert.equal(fileCommentSummaryLabel({ total: 3, open: 2, unread: 0 }), "3 comments, 2 open");
  assert.equal(fileCommentSummaryLabel({ total: 1, open: 0, unread: 0 }), "1 comment, resolved");
  assert.equal(fileCommentSummaryLabel({ total: 2, open: 0, unread: 0 }), "2 comments, all resolved");
  assert.equal(fileCommentSummaryLabel({ total: 2, open: 2, unread: 1 }), "2 comments, 1 unread reply");
  assert.equal(fileCommentSummaryLabel({ total: 2, open: 2, unread: 3 }), "2 comments, 3 unread replies");
  assert.equal(fileCommentSummaryTone({ total: 2, open: 2, unread: 1 }), "is-unread");
});

test("the badge is a named image inside its row, and a file with nothing carries none", () => {
  const html = renderToStaticMarkup(
    createElement(FileCommentBadge, { summary: { total: 2, open: 2, unread: 1 } }),
  );
  assert.match(
    html,
    /^<span class="file-comment-badge is-unread" role="img" aria-label="2 comments, 1 unread reply"><svg [^>]*aria-hidden="true"[^>]*>.*<\/svg>2<\/span>$/,
  );
  assert.equal(renderToStaticMarkup(createElement(FileCommentBadge, { summary: undefined })), "");
});

const PATCH = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1 +1 @@",
  "-const budget = 10;",
  "+const budget = 30;",
].join("\n");

function file(over: Partial<DiffFile> = {}): DiffFile {
  return { ...parsePatch(PATCH)[0]!, ...over };
}

test("only a working-tree diff's text files show comments, at their Files path", () => {
  const target = { path: "retry.ts", reason: null };
  // The Files path, not the repo path: a session rooted in `src/` reads the file as `retry.ts`.
  assert.equal(diffFileCommentPath(file(), target, null), "retry.ts");
  assert.equal(diffFileCommentPath(file(), target, undefined), "retry.ts");
  assert.equal(diffFileCommentPath(file(), target, "abc123"), null, "a commit is not the working tree");
  assert.equal(diffFileCommentPath(file({ binary: true }), target, null), null, "a binary has no lines");
  assert.equal(
    diffFileCommentPath(file({ status: "deleted" }), { path: null, reason: "deleted" }, null),
    null,
    "a file with no Files route has nowhere a thread was written",
  );
});

const NO_REVIEW = {
  queue: [],
  review: null,
  outstanding: null,
  showQueue: false,
  onToggleQueue: () => {},
};

function controls(over: Partial<Parameters<typeof FileCommentControls>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(FileCommentControls, {
      mode: {
        active: false,
        blockReason: null,
        label: "Comment on a line: click a line number",
        shortcut: true,
        onToggle: () => {},
      },
      index: { count: 2, expanded: false, onToggle: () => {} },
      review: NO_REVIEW,
      resolved: { count: 1, shown: false, onToggle: () => {} },
      ...over,
    }),
  );
}

test("the shared toolbar names its controls the same way in both tabs", () => {
  const html = controls();
  assert.match(html, /aria-label="Comment mode" aria-keyshortcuts="m" aria-pressed="false" aria-disabled="false"/);
  assert.match(html, /aria-label="Comments" aria-expanded="false"[^>]*>Comments \(2\)</);
  assert.ok(hasTooltip(html, "Show every comment on this file, including resolved threads"));
  assert.doesNotMatch(html, /Review queue/, "no review, no Review control");
  assert.doesNotMatch(html, /Show resolved comments/, "Resolved belongs to comment mode");

  const open = controls({
    mode: {
      active: true,
      blockReason: null,
      label: "Comment on a line: click a line number",
      shortcut: true,
      onToggle: () => {},
    },
    index: { count: 2, expanded: true, onToggle: () => {} },
    review: { ...NO_REVIEW, queue: [thread()] },
  });
  assert.match(open, /aria-label="Comments" aria-expanded="true"[^>]*>Comments \(2\)</);
  assert.ok(hasTooltip(open, "Hide every comment on this file"));
  assert.match(open, /aria-label="Review queue" aria-pressed="false"[^>]*>Review \(1\)</);
  assert.match(open, /aria-label="Show resolved comments"/);
});

test("a control that cannot act says why and stays focusable", () => {
  const reason = "Comments anchor to the working tree, and this diff shows a single commit";
  const html = controls({
    mode: {
      active: false,
      blockReason: reason,
      label: "Comment on a line: click a line number",
      shortcut: true,
      onToggle: () => {},
    },
    index: { count: 0, expanded: false, blockReason: reason, onToggle: () => {} },
  });
  assert.match(html, /aria-label="Comment mode" aria-pressed="false" aria-disabled="true"/);
  assert.match(html, /aria-label="Comments" aria-expanded="false" aria-disabled="true"/);
  assert.doesNotMatch(html, /\sdisabled=""/, "never `disabled`, which would hide the reason");
  assert.doesNotMatch(html, /kb-hint|aria-keyshortcuts/, "and claims no key it cannot answer");
  assert.ok(hasTooltip(html, reason));
});

test("read-only evidence keeps the Comments index and drops Comment mode", () => {
  const html = controls({ mode: null });
  assert.doesNotMatch(html, /aria-label="Comment mode"/);
  assert.match(html, /aria-label="Comments"[^>]*>Comments \(2\)</);
});
