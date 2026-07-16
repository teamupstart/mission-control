import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clearDraft,
  pruneDrafts,
  readDraft,
  resetDrafts,
  writeDraft,
} from "../src/web/lib/drafts.ts";
import { WorkQueue } from "../src/web/components/WorkQueue.tsx";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import type { Session } from "../src/shared/types.ts";

// What a card is allowed to do to text you typed and haven't sent: nothing.
//
// The panels holding these boxes are mounted only while a card is expanded, and only
// one card expands at a time - so opening any other card unmounted the box you were
// typing in, and a filter that hid the card did the same. The text was never wrong;
// the component holding it stopped existing. These check the two halves of the fix
// that a mount can't: that the map keeps the right text under the right key, and that
// the boxes actually read it when they come back.

beforeEach(() => resetDrafts());

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    pid: 1,
    agent: "claude",
    name: "card",
    nameSource: "tmux",
    state: "idle",
    cwd: "/repo",
    startedAt: 0,
    lastActivity: null,
    instrumented: true,
    hooksSeen: true,
    activity: null,
    pendingReviews: 0,
    nomistakesFixes: [],
    ...over,
  } as Session;
}

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
  pruneDrafts(["host:1234:abc"]);
  assert.equal(readDraft("host:1234:abc", "reply"), "mine");
});

test("emptying a box forgets the draft rather than remembering a blank", () => {
  writeDraft("s1", "queue", "typed");
  writeDraft("s1", "queue", "");
  assert.equal(readDraft("s1", "queue"), "");
  // Not merely blank - gone, so a prune has nothing to collect and a re-mount has
  // nothing to restore.
  pruneDrafts(["s1"]);
  assert.equal(readDraft("s1", "queue"), "");
});

test("only a send forgets a draft - collapsing and cancelling do not", () => {
  // The rule the report asked for: it persists unless manually deleted. `clearDraft`
  // is called from exactly one place per box, the ok branch of a send.
  writeDraft("s1", "send", "about to go");
  clearDraft("s1", "send");
  assert.equal(readDraft("s1", "send"), "");
});

test("a prune drops a departed session's drafts and keeps every live one", () => {
  writeDraft("gone", "reply", "orphan");
  writeDraft("gone", "queue", "orphan too");
  writeDraft("alive", "reply", "keep me");
  pruneDrafts(["alive"]);
  assert.equal(readDraft("gone", "reply"), "");
  assert.equal(readDraft("gone", "queue"), "");
  assert.equal(readDraft("alive", "reply"), "keep me");
});

test("a prune against an empty list wipes the page - which is why App gates it", () => {
  // Not a wish, a warning. The pre-snapshot session list is empty and NOT
  // authoritative; pruning against it would delete every draft on screen. This pins
  // the behaviour that makes App's `hasSnapshot` guard load-bearing rather than
  // decorative, so removing that guard has to break a test.
  writeDraft("s1", "reply", "would be lost");
  pruneDrafts([]);
  assert.equal(readDraft("s1", "reply"), "");
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
    createElement(TranscriptPanel, { sessionId: "s1", agent: "claude", canSend: true }),
  );
  assert.match(html, /half-written reply/);
});

test("a fresh card's boxes are empty, not haunted by the last card's draft", () => {
  // The mirror of the hydration tests: keying is what makes hydration safe, and a
  // panel that rendered someone else's reply would be worse than losing your own.
  writeDraft("other", "reply", "NOT FOR THIS CARD");
  const html = renderToStaticMarkup(
    createElement(TranscriptPanel, { sessionId: "s1", agent: "claude", canSend: true }),
  );
  assert.ok(!html.includes("NOT FOR THIS CARD"), html);
});
