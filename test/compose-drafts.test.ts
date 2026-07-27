import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clearDraft,
  dropMessageDrafts,
  dropSessionDrafts,
  readDraft,
  resetDrafts,
  writeDraft,
} from "../src/web/lib/drafts.ts";
import { WorkQueue } from "../src/web/components/WorkQueue.tsx";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import type { Session } from "../src/shared/types.ts";
import { mkSession } from "./helpers/session-fixture.ts";

// What a card is allowed to do to text you typed and haven't sent: nothing.
//
// The panels holding these boxes are mounted only while a card is expanded, and only
// one card expands at a time - so opening any other card unmounted the box you were
// typing in, and a filter that hid the card did the same. The text was never wrong;
// the component holding it stopped existing. These check the two halves of the fix
// that a mount can't: that the map keeps the right text under the right key, and that
// the boxes actually read it when they come back.

beforeEach(() => resetDrafts());

// The SHARED fixture, not a local partial. This file used to build its own with an
// `as Session` cast, which quietly let it omit fields the real type requires - and the
// moment the transcript grew a toolbar that reads `terminals`, every render here crashed
// on a session that had never been a complete one.

// ---- the map ----

test("a draft outlives the mount that wrote it", () => {
  // The whole bug in one line: the component is gone, the text is not.
  writeDraft("s1", "queue", "half a thought");
  assert.equal(readDraft("s1", "queue"), "half a thought");
});

test("a box never typed in reads as empty, not undefined", () => {
  // Hydration feeds this straight into a value/defaultValue; `undefined` there flips
  // a controlled input to uncontrolled and React warns for the life of the card.
  assert.equal(readDraft("nobody", "reply"), "");
});

test("drafts don't bleed across sessions or across boxes", () => {
  // One map for every box on the page, so the key is the only thing keeping a reply
  // meant for one agent out of the box pointed at another.
  writeDraft("s1", "reply", "for s1");
  writeDraft("s2", "reply", "for s2");
  writeDraft("s1", "queue", "s1's queue item");
  assert.equal(readDraft("s1", "reply"), "for s1");
  assert.equal(readDraft("s2", "reply"), "for s2");
  assert.equal(readDraft("s1", "queue"), "s1's queue item");
  assert.equal(readDraft("s2", "queue"), "");
});

test("a session id containing a colon still keys its own drafts", () => {
  // The key is `${id}:${kind}` and the reader splits on the LAST colon. Splitting on
  // the first would file every draft for such a session under a truncated id - and
  // silently hand it to whichever session that prefix happened to name.
  writeDraft("host:1234:abc", "reply", "mine");
  assert.equal(readDraft("host:1234:abc", "reply"), "mine");
});

test("emptying a box forgets the draft rather than remembering a blank", () => {
  writeDraft("s1", "queue", "typed");
  writeDraft("s1", "queue", "");
  // Not merely blank - gone, so a re-mount has nothing to restore.
  assert.equal(readDraft("s1", "queue"), "");
});

test("only a send forgets a draft - collapsing and cancelling do not", () => {
  // The rule the report asked for: it persists unless manually deleted. `clearDraft`
  // is called from exactly one place per box, the ok branch of a send.
  writeDraft("s1", "send", "about to go");
  clearDraft("s1", "send");
  assert.equal(readDraft("s1", "send"), "");
});

test("an evicted session's drafts are dropped, every other session's are untouched", () => {
  // Collection is keyed to `session_remove`, which names ONE id: a departed session's
  // drafts are the one thing no mount would ever collect, but a neighbour's text is
  // none of its business.
  writeDraft("gone", "reply", "orphan");
  writeDraft("gone", "queue", "orphan too");
  writeDraft("gone", "send", "orphan as well");
  writeDraft("alive", "reply", "keep me");
  dropSessionDrafts("gone");
  assert.equal(readDraft("gone", "reply"), "");
  assert.equal(readDraft("gone", "queue"), "");
  assert.equal(readDraft("gone", "send"), "");
  assert.equal(readDraft("alive", "reply"), "keep me");
});

test("dropping one session leaves a session whose id merely shares its prefix alone", () => {
  // Keys are `${id}:${kind}` and ids can contain colons, so a prefix match would take
  // "host:1234" to mean the whole of "host:1234:abc" - deleting a live card's draft.
  writeDraft("host:1234", "reply", "the evicted one");
  writeDraft("host:1234:abc", "reply", "a different, living session");
  dropSessionDrafts("host:1234");
  assert.equal(readDraft("host:1234", "reply"), "");
  assert.equal(readDraft("host:1234:abc", "reply"), "a different, living session");
});

test("dropping a session nobody typed into is a no-op, not a wipe", () => {
  // `session_remove` fires for every session that ever exits, and most carry no draft.
  writeDraft("s1", "reply", "keep me");
  dropSessionDrafts("never-typed-in");
  assert.equal(readDraft("s1", "reply"), "keep me");
});

// ---- reset forgets the message you were about to send ----

test("a reset drops the send and reply drafts - they were about the wiped task", () => {
  // A reset discards the branch and clears the agent's context, so a half-typed message
  // aimed at that task is stale, the same way the work queue is. This is the map half of
  // the fix; the reply box's remount key is the other half (an open box on screen).
  writeDraft("s1", "send", "half a message");
  writeDraft("s1", "reply", "half a reply");
  dropMessageDrafts("s1");
  assert.equal(readDraft("s1", "send"), "");
  assert.equal(readDraft("s1", "reply"), "");
});

test("a reset keeps the queue add-box draft - it composes new work, not a stale reply", () => {
  // The queue box drafts the NEXT thing to queue; the reset didn't discard that. Only the
  // send/reply boxes, which speak to the task the reset threw away, get forgotten.
  writeDraft("s1", "queue", "queue this next");
  dropMessageDrafts("s1");
  assert.equal(readDraft("s1", "queue"), "queue this next");
});

test("resetting one session leaves another session's message drafts alone", () => {
  // The reset names one session; a neighbour's unsent reply is none of its business.
  writeDraft("s1", "reply", "gets wiped");
  writeDraft("s2", "reply", "keep me");
  dropMessageDrafts("s1");
  assert.equal(readDraft("s1", "reply"), "");
  assert.equal(readDraft("s2", "reply"), "keep me");
});

test("after a reset the reply box re-hydrates empty, not to the wiped text", () => {
  // The remount (its key is the session's reset nonce) re-reads the draft; with the draft
  // dropped, static markup - which IS a remount - must carry no trace of the old reply.
  writeDraft("s1", "reply", "text from before the reset");
  dropMessageDrafts("s1");
  const html = renderToStaticMarkup(
    createElement(TranscriptPanel, { session: mkSession(), canSend: true }),
  );
  assert.ok(!html.includes("text from before the reset"), html);
});

// ---- the boxes, re-mounting ----

test("the work queue's add box comes back holding what you typed", () => {
  // Re-expanding a card mounts a brand-new WorkQueue. Static markup IS the remount:
  // if the draft isn't in this render, it wasn't hydrated.
  writeDraft("s1", "queue", "queue this while I look at another card");
  const html = renderToStaticMarkup(
    createElement(WorkQueue, {
      session: mkSession(),
      foremanMode: "dry-run",
      foremanEnabled: false,
      allowlisted: false,
    }),
  );
  assert.match(html, /queue this while I look at another card/);
});

test("the reply box comes back holding what you typed", () => {
  writeDraft("s1", "reply", "half-written reply");
  const html = renderToStaticMarkup(
    createElement(TranscriptPanel, { session: mkSession(), canSend: true }),
  );
  assert.match(html, /half-written reply/);
});

test("a fresh card's boxes are empty, not haunted by the last card's draft", () => {
  // The mirror of the hydration tests: keying is what makes hydration safe, and a
  // panel that rendered someone else's reply would be worse than losing your own.
  writeDraft("other", "reply", "NOT FOR THIS CARD");
  const html = renderToStaticMarkup(
    createElement(TranscriptPanel, { session: mkSession(), canSend: true }),
  );
  assert.ok(!html.includes("NOT FOR THIS CARD"), html);
});
