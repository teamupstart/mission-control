/**
 * What is at stake: comment mode is reached through a toolbar control and a chord, and
 * everything it draws is announced by an accessible name rather than by colour or position.
 * Those names are the whole interface for a screen reader, and three of them are also what
 * `e2e/specs/file-line-comments.spec.ts` selects by - so a rename that looks cosmetic
 * silently unhooks the browser spec as well.
 *
 * Four properties this pins that nothing else does:
 *
 * - **The control respects `extracted`.** `e2e/specs/file-default-view.spec.ts` asserts the
 *   extracted Files window contains ZERO `[aria-keyshortcuts]` elements, because its keys
 *   belong to the window it was extracted FROM. A third in-surface key is a third way to
 *   break that, and it is cheaper to catch here than in a browser.
 * - **`aria-pressed` reflects whether comment mode is actually live**, not merely requested.
 *   It is derived from the Editor being the surface on screen, which is what keeps the
 *   control from reading as lit over a Preview that ignores it.
 * - **An image disables the control with a reason** rather than hiding it. The reason is a
 *   `Tooltip`, never a native `title` - `tooltip-coverage.test.ts` forbids the second.
 * - **The thread and composer render from a model alone**, which is what lets phase 5 mount
 *   them under the preview surfaces instead of reimplementing them.
 *
 * `createElement` rather than JSX, because the runner's glob is `test/**\/*.test.ts` only.
 * `renderToStaticMarkup` runs render and not effects, so this says nothing about CodeMirror
 * - the marker, the block widget and the click that opens a composer are the browser spec's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  FileCommentThread,
  SessionFileDocument,
  SessionFileKind,
} from "../src/shared/types.ts";
import { FileWorkspace } from "../src/web/components/FileWorkspace.tsx";
import {
  FileCommentComposer,
  FileCommentThreadCard,
} from "../src/web/components/FileCommentThread.tsx";
import {
  anchorForLine,
  isCommentableDocument,
  markerLabel,
  markerTone,
  threadsForFile,
} from "../src/web/lib/fileComments.ts";
import {
  draftCreateRequest,
  draftBodyToWrite,
  draftKnownRow,
  draftThreadToDelete,
  type FileCommentComposerState,
} from "../src/web/lib/fileCommentDraft.ts";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";
import { hasTooltip } from "./helpers/markup.ts";
import { mkSession } from "./helpers/session-fixture.ts";

const SESSION = "s-comment";
const PATH = "docs/plans/x/plan.md";
const TEXT = "# Heading\n\nline two says something\n\n";

function document(over: Partial<SessionFileDocument> = {}): SessionFileDocument {
  return {
    path: PATH,
    kind: "markdown",
    editable: true,
    text: TEXT,
    size: TEXT.length,
    mtime: 0,
    language: "Markdown",
    revision: "rev-1",
    error: null,
    ...over,
  };
}

function controller(over: Partial<SessionFileDocument> = {}): SessionFilesController {
  const doc = document(over);
  const noop = (): void => {};
  return {
    sessions: {
      [SESSION]: {
        files: [{ path: PATH }],
        listState: "ready",
        listError: null,
        openError: null,
        selectedPath: PATH,
        // Source, so the Editor is the surface on screen and comment mode can be live.
        mode: "editor",
        buffers: {
          [PATH]: {
            document: doc,
            text: doc.text ?? "",
            savedText: doc.text ?? "",
            saveState: "saved",
            error: null,
            conflict: null,
          },
        },
      },
    },
    pathIndex: {},
    ensure: noop,
    refresh: noop,
    warmPaths: noop,
    probe: async () => true,
    select: noop,
    setMode: noop,
    edit: noop,
    flush: noop,
    retry: noop,
    reloadDisk: noop,
    overwriteDisk: noop,
    drop: noop,
  };
}

function thread(over: Partial<FileCommentThread> = {}): FileCommentThread {
  return {
    id: "t-1",
    shortId: "MC-a41f",
    sessionId: SESSION,
    path: PATH,
    startLine: 3,
    endLine: 3,
    quote: "line two says something",
    quoteHash: "hash",
    revision: "rev-1",
    surface: "editor",
    status: "queued",
    outdated: false,
    queueSeq: 1,
    deliveryId: null,
    sentAt: null,
    answeredAt: null,
    addressedAt: null,
    resolvedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: [{
      id: "m-1",
      threadId: "t-1",
      author: "human",
      sessionId: SESSION,
      body: "This contradicts the table below.",
      deliveredAt: null,
      readAt: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    }],
    messageCount: 1,
    ...over,
  };
}

function workspace(input: {
  extracted?: boolean;
  kind?: SessionFileKind;
  text?: string | null;
} = {}): string {
  return renderToStaticMarkup(
    createElement(FileWorkspace, {
      session: mkSession({ id: SESSION, name: "plan review" }),
      controller: controller({
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.text === undefined ? {} : { text: input.text }),
      }),
      fileCommentThreads: [],
      extracted: input.extracted ?? false,
    }),
  );
}

test("the toolbar offers a Comment control, off, with its in-surface key on its face", () => {
  const html = workspace();
  assert.match(
    html,
    /aria-label="Comment mode"[^>]*aria-keyshortcuts="m"[^>]*aria-pressed="false"/,
    "the Comment control must publish its key and its off state",
  );
  assert.ok(
    hasTooltip(html, "Comment on a line: click a line number to write one"),
    "the control has to say what it does",
  );
  assert.match(html, /<kbd class="kb-hint">m<\/kbd>/, "the keycap teaches the chord");
});

test("the extracted Files window carries no key for it, because the key is not its own", () => {
  // `e2e/specs/file-default-view.spec.ts` asserts ZERO `[aria-keyshortcuts]` in that window.
  const html = workspace({ extracted: true });
  assert.match(html, /aria-label="Comment mode"/, "the control is still there");
  assert.ok(!html.includes("aria-keyshortcuts"), "an extracted window claims no in-surface key");
  assert.ok(!html.includes("kb-hint"), "and prints no keycap for one");
});

test("an image disables the control with a reason instead of hiding it", () => {
  const html = workspace({ kind: "image", text: null });
  assert.match(html, /aria-label="Comment mode"[^>]*disabled/, "the control is present and dead");
  assert.ok(hasTooltip(html, "An image has no lines to comment on"), "and says why");
});

test("comment eligibility is its own predicate, and is not `previewable`", () => {
  // `previewable` includes `image` and is pinned by a literal source regex in
  // `test/console-arrow-scroll.test.ts`, so the two questions cannot share an answer.
  assert.equal(isCommentableDocument(document()), true, "markdown source takes comments");
  assert.equal(isCommentableDocument(document({ kind: "text" })), true, "so does plain source");
  assert.equal(
    isCommentableDocument(document({ kind: "image", text: null })),
    false,
    "an image is previewable and has no lines",
  );
  assert.equal(
    isCommentableDocument(document({ kind: "binary", text: null })),
    false,
    "a document with no text has nothing to anchor to",
  );
  assert.equal(
    isCommentableDocument(document({ kind: "text", editable: false })),
    true,
    "a file too large to edit still renders its lines, and they still take comments",
  );
});

test("a blank line anchors to the text below it rather than to nothing", () => {
  // `CreateFileCommentSchema` refuses a quote that normalizes to empty, and it is right to:
  // such a thread is born unanchorable and no edit repairs it.
  assert.deepEqual(anchorForLine(TEXT, 1), { startLine: 1, endLine: 1, quote: "# Heading" });
  assert.deepEqual(anchorForLine(TEXT, 2), {
    startLine: 2,
    endLine: 3,
    quote: "\nline two says something",
  });
  // Nothing below, so it reaches back instead.
  assert.deepEqual(anchorForLine(TEXT, 5), {
    startLine: 3,
    endLine: 5,
    quote: "line two says something\n\n",
  });
  assert.equal(anchorForLine("\n\n\n", 2), null, "a file of blank lines anchors nowhere");
  assert.equal(anchorForLine(TEXT, 99), null, "and neither does a line past the end");
});

test("a marker names its line and its state, and resolved threads hide behind the toggle", () => {
  assert.equal(
    markerLabel(3, [thread()]),
    "Comment MC-a41f on line 3, queued",
    "the marker's glyph says nothing; its name says everything",
  );
  assert.equal(
    markerLabel(3, [thread({ messageCount: 3 })]),
    "Comment MC-a41f on line 3, queued, 2 replies",
  );
  assert.equal(markerLabel(7, [thread(), thread({ id: "t-2" })]), "2 comments on line 7");
  assert.equal(markerLabel(3, [thread({ outdated: true })]).endsWith("moved"), true);
  assert.equal(markerTone([thread({ status: "resolved" })]), "is-resolved");

  const threads = [thread(), thread({ id: "t-2", status: "resolved", startLine: 9 })];
  assert.deepEqual(
    threadsForFile(threads, SESSION, PATH, false).map((t) => t.id),
    ["t-1"],
    "closing a thread is what stops it being drawn",
  );
  assert.deepEqual(
    threadsForFile(threads, SESSION, PATH, true).map((t) => t.id),
    ["t-1", "t-2"],
    "and the toggle is what brings it back",
  );
  assert.deepEqual(
    threadsForFile([thread({ status: "orphaned" })], SESSION, PATH, true),
    [],
    "an orphaned thread's session is gone, so nobody can act on it",
  );
  assert.deepEqual(
    threadsForFile(threads, "other-session", PATH, true),
    [],
    "threads belong to the session that wrote them",
  );
});

test("the composer names the line it is anchored to and quotes it back", () => {
  const html = renderToStaticMarkup(
    createElement(FileCommentComposer, {
      startLine: 3,
      endLine: 3,
      quote: "line two says something",
      value: "",
      busy: false,
      error: null,
      onChange: () => {},
      onSubmit: () => {},
      onCancel: () => {},
    }),
  );
  assert.match(html, /aria-label="New comment on line 3"/);
  assert.match(html, /aria-label="Comment on line 3"/, "the box itself is labelled too");
  assert.ok(html.includes("line two says something"), "the anchored text is shown back");
  // Nothing to submit yet, and the button says so rather than failing at the route.
  assert.match(html, /disabled[^>]*>Comment</);
  assert.ok(hasTooltip(html, "Add this comment to the review"));
  assert.ok(hasTooltip(html, "Discard this comment"));
});

test("a multi-line anchor reads as a range", () => {
  const html = renderToStaticMarkup(
    createElement(FileCommentComposer, {
      startLine: 2,
      endLine: 3,
      quote: "\nline two says something",
      value: "typed",
      busy: false,
      error: "the daemon said no",
      onChange: () => {},
      onSubmit: () => {},
      onCancel: () => {},
    }),
  );
  assert.match(html, /aria-label="New comment on lines 2-3"/);
  assert.match(html, /role="alert"[^>]*>the daemon said no</, "a refusal is visible");
});

test("an expanded thread shows what was said, offers a reply, and offers to close it", () => {
  const html = renderToStaticMarkup(
    createElement(FileCommentThreadCard, {
      thread: thread(),
      busy: false,
      error: null,
      onReply: () => {},
      onResolve: () => {},
      onReopen: () => {},
      onClose: () => {},
    }),
  );
  assert.match(html, /aria-label="Comment MC-a41f on line 3"/);
  assert.ok(html.includes("This contradicts the table below."), "the comment itself is drawn");
  assert.match(html, /aria-label="Reply to comment MC-a41f"/);
  assert.match(html, /aria-label="Collapse comment MC-a41f"/);
  assert.ok(html.includes(">Resolve<"), "a person can close the thread");
  assert.ok(!html.includes(">Reopen<"), "and is not offered both at once");
  assert.ok(hasTooltip(html, "Close this thread. Only a person closes a comment"));
});

test("a resolved thread offers to reopen, and an agent reply is attributed to the agent", () => {
  const settled = thread({
    status: "resolved",
    resolvedAt: 1_700_000_100_000,
    messageCount: 2,
    messages: [
      thread().messages[0]!,
      {
        id: "m-2",
        threadId: "t-1",
        author: "agent",
        sessionId: SESSION,
        body: "Fixed the table.",
        deliveredAt: null,
        readAt: null,
        createdAt: 1_700_000_050_000,
        updatedAt: 1_700_000_050_000,
      },
    ],
  });
  const html = renderToStaticMarkup(
    createElement(FileCommentThreadCard, {
      thread: settled,
      busy: false,
      error: null,
      onReply: () => {},
      onResolve: () => {},
      onReopen: () => {},
      onClose: () => {},
    }),
  );
  assert.ok(html.includes(">Reopen<"), "a closed thread can be put back in play");
  assert.ok(!html.includes(">Resolve<"));
  assert.match(html, /is-agent[\s\S]*?>Agent</, "an agent reply says whose it is");
  assert.ok(html.includes("resolved"), "the header states the thread's state");
});

test("a thread past the wire cap says it is showing a tail, rather than losing the rest", () => {
  const html = renderToStaticMarkup(
    createElement(FileCommentThreadCard, {
      thread: thread({ messageCount: 64 }),
      busy: false,
      error: null,
      onReply: () => {},
      onResolve: () => {},
      onReopen: () => {},
      onClose: () => {},
    }),
  );
  assert.ok(
    html.includes("Showing the most recent 1 of 64 messages."),
    "a reader counting replies must not conclude the earlier ones were lost",
  );
});

test("Escape closes the panel and does not reach App's global Escape", () => {
  /*
   * The same contract `topbar-popover-dismiss.test.ts` pins for the topbar menus, asserted
   * here rather than added to that file: its template reads a `function onKey` registered on
   * `window`, and this panel has no such handler by design. It is an inline block inside the
   * document - not an overlay, not a registered dialog - so it dismisses from the key event
   * on its own box.
   *
   * Both halves matter. Without the close, a panel opened by the mouse has no keyboard way
   * out. Without `stopPropagation`, the same press reaches App's Escape, which peels a layer
   * off the Console behind it - leaving the text box, handing the reader back to the rail -
   * so one press would both close the composer and navigate away from what it was about.
   */
  const source = readFileSync(
    fileURLToPath(new URL("../src/web/components/FileCommentThread.tsx", import.meta.url)),
    "utf8",
  );
  const handlers = [...source.matchAll(/if \(event\.key === "Escape"\) \{([\s\S]*?)\n {10}\}/g)]
    .map((match) => match[1] ?? "");
  assert.equal(handlers.length, 2, "both the composer and the thread's reply box handle Escape");
  for (const handler of handlers) {
    assert.match(handler, /event\.stopPropagation\(\)/, "Escape reaches App's global handler");
    assert.match(handler, /on(Cancel|Close)\(\)/, "Escape does not close the panel");
  }
});

/**
 * A composer mid-keystroke on `docs/a.md`, before its create request has been answered.
 *
 * The two tests below are the regressions for the two async races the draft lifecycle had.
 * They are unit tests on purpose: both bugs were about WHICH values a request is built from
 * and WHICH row a cancel resolves, and both of those are now pure functions of the composer,
 * so a case costs microseconds and states the rule exactly. The browser spec drives the same
 * two paths end to end, with a real delayed request.
 */
function composerState(over: Partial<FileCommentComposerState> = {}): FileCommentComposerState {
  return {
    instance: 7,
    sessionId: "session-a",
    path: "docs/a.md",
    revision: "rev-a",
    line: 3,
    startLine: 3,
    endLine: 3,
    quote: "line two says something",
    text: "this is wrong",
    threadId: null,
    messageId: null,
    busy: false,
    error: null,
    ...over,
  };
}

test("a pending draft is written against the file it was opened on, not the one now selected", () => {
  /*
   * The race: type the first character on file A, select file B before the 400ms debounce
   * fires. The workspace settles the draft on the way out, and the request goes with B's
   * path and A's line and quote - a comment filed against a file nobody wrote it about,
   * anchored to text that file does not contain. The same shape crosses SESSIONS, which is
   * worse, because a session's threads end with it.
   *
   * The fix is structural rather than careful: a composer carries its own target, and the
   * request is built from the composer alone. There is no argument here through which the
   * current selection could reach it, which is what makes the rule hold rather than the
   * caller remembering to honour it.
   */
  const composer = composerState();
  assert.deepEqual(draftCreateRequest(composer), {
    sessionId: "session-a",
    body: {
      path: "docs/a.md",
      startLine: 3,
      endLine: 3,
      quote: "line two says something",
      revision: "rev-a",
      surface: "editor",
      body: "this is wrong",
    },
  });

  // The body is trimmed, and a body that is only whitespace never becomes a request at all -
  // `CreateFileCommentSchema` would refuse it, so spending the round trip teaches nobody
  // anything.
  assert.equal(draftCreateRequest(composerState({ text: "  spaced  " }))?.body.body, "spaced");
  assert.equal(draftCreateRequest(composerState({ text: "   " })), null);
  assert.equal(draftCreateRequest(composerState({ text: "" })), null);
});

test("cancelling during the create request still deletes the row that request produced", () => {
  /*
   * The race: the debounce fires, `createFileComment` goes out, and Cancel is pressed before
   * it comes back. The composer never learned its `threadId`, so a cancel that read it at
   * click time deleted nothing - and the create landed behind it, leaving a durable draft and
   * a marker on the line for a comment the reader had just discarded.
   *
   * So the id is resolved when the cancel's turn on the request chain arrives, by which time
   * the create has necessarily finished and recorded what it made.
   */
  const composer = composerState();
  assert.equal(
    draftThreadToDelete(composer, { instance: 7, id: "thread-created-late", messageId: "message-created-late" }),
    "thread-created-late",
    "the row the in-flight create produced is the row to delete",
  );

  // The settled cases, unchanged: a reopened draft, or one whose create already returned.
  assert.equal(draftThreadToDelete(composerState({ threadId: "thread-known" }), null), "thread-known");
  assert.equal(draftThreadToDelete(composer, null), null, "nothing was ever created");

  /*
   * And the over-reach this must not become. Dismissing a draft on one line KEEPS its row -
   * that is what makes a draft durable - so a later composer's Cancel must not inherit it.
   * The instance is what separates "the thread I made" from "the last thread anyone made".
   */
  assert.equal(
    draftThreadToDelete(composerState({ instance: 8 }), { instance: 7, id: "someone-elses-draft", messageId: "someone-elses-message" }),
    null,
    "a later composer's cancel must not delete an earlier draft that was deliberately kept",
  );
});

test("a write queued behind an in-flight create edits that row rather than making a second", () => {
  /*
   * Rule 3. Switching files while the first keystroke's create is still in the air closes the
   * composer, so the patch that would have filled in its `threadId` reaches nothing - and the
   * settle-on-close write inherits a snapshot that still says null.
   *
   * Reading that null as "no row yet" created a SECOND thread: two durable drafts and two
   * markers on a line the reader commented on once. The chain's own record of what the create
   * returned is the answer, and it is the same record a cancel consults.
   */
  const dismissed = composerState({ threadId: null, messageId: null, text: "half a thought" });
  const known = draftKnownRow(dismissed, {
    instance: dismissed.instance,
    id: "thread-from-the-flight",
    messageId: "message-from-the-flight",
  });
  assert.deepEqual(
    known,
    { threadId: "thread-from-the-flight", messageId: "message-from-the-flight" },
    "the queued write must edit the row the create made, not create another",
  );

  // A composer that genuinely has no row still gets one. This is the first keystroke.
  assert.equal(draftKnownRow(composerState(), null), null);

  // And the same over-reach guard: another composer's row is not this composer's to edit.
  assert.equal(
    draftKnownRow(composerState({ instance: 8 }), {
      instance: 7,
      id: "someone-elses-draft",
      messageId: "someone-elses-message",
    }),
    null,
  );
});

test("one composer's saved body does not silence another composer's edit", () => {
  /*
   * Rule 4. The record of what the daemon already holds is an optimisation - an unchanged
   * body costs no request - and it used to be one bare string shared by every composer.
   *
   * So: draft A's create is in flight, the reader moves to another file and opens existing
   * draft B, and A's response lands and puts A's body in the shared slot. The reader now
   * types that same sentence into B. B's write sees its own new text sitting in the cache,
   * concludes nothing changed, and sends nothing - B's durable message keeps its old body
   * and the reader's edit is gone, with no error anywhere.
   *
   * The cache names its owner now, so it can only ever suppress a write to the message it
   * was actually written for.
   */
  const sameSentence = "The retry budget is thirty seconds.";
  const bee = composerState({
    instance: 12,
    threadId: "thread-b",
    messageId: "message-b",
    text: sameSentence,
  });
  const knownB = { threadId: "thread-b", messageId: "message-b" };

  assert.equal(
    draftBodyToWrite(bee, knownB, {
      messageId: "message-a",
      instance: 11,
      body: sameSentence,
    }),
    sameSentence,
    "another message's cached body must never suppress this message's edit",
  );

  // Its OWN cached body still does, which is the whole point of keeping one.
  assert.equal(
    draftBodyToWrite(bee, knownB, {
      messageId: "message-b",
      instance: 12,
      body: sameSentence,
    }),
    null,
    "an unchanged body should cost no request",
  );

  // And a real change to the same message is written.
  assert.equal(
    draftBodyToWrite(bee, knownB, { messageId: "message-b", instance: 12, body: "something else" }),
    sameSentence,
  );

  // Before a create has answered there is no message id to key on, so the composer is the
  // key - and it is enough, because only that composer's own write can be in flight.
  assert.equal(
    draftBodyToWrite(bee, knownB, { messageId: null, instance: 12, body: sameSentence }),
    null,
  );
  assert.equal(
    draftBodyToWrite(bee, knownB, { messageId: null, instance: 11, body: sameSentence }),
    sameSentence,
    "an earlier composer's unsettled body is not this one's",
  );

  // Nothing worth writing is still nothing worth writing.
  assert.equal(draftBodyToWrite(composerState({ text: "   " }), knownB, null), null);
});
