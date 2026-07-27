import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptMessage } from "../src/shared/types.ts";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import { mkSession } from "./helpers/session-fixture.ts";
import {
  appendLive,
  backAnchor,
  dropHistory,
  flattenHistory,
  prependPage,
  readHistory,
  resetHistories,
  resumeAnchor,
  resumeTail,
  seedTail,
} from "../src/web/lib/transcript-history.ts";

// What is at stake: whether scrolling back through a conversation is worth doing.
//
// A reconnect arrives far more often than "when you open a card" - any transient drop and
// every daemon restart - and an `init` window is anchored at the CURRENT end of the file.
// So re-seeding on reconnect cost the reader every page they had scrolled back to as soon
// as the agent wrote one more turn, which on a working session is immediately. Pages the
// reader had to wait for, thrown away by a blip that hid nothing.
//
// Two rules carry that, and both are pinned below. A reconnect RESUMES from the offset the
// reader reached, so the anchor never moves and nothing is discarded. Re-seeding is what
// happens when the server refuses to resume - the file was cleared, or more was written
// than a reconnect can honestly claim to have missed - and there a held page survives only
// if it still ABUTS the new window.
//
// Bytes are the only currency that can answer either question: turn counts do not identify
// a position in a file, and ids cannot either - a harness whose records carry none
// synthesizes them per parse batch, so the same turn read twice is two different ids, and
// no amount of de-duplication rescues a replay. The interesting cases are all boundaries.

const msg = (id: string): TranscriptMessage => ({ id, role: "user", text: id, tools: [], ts: 0 });
const texts = (ms: TranscriptMessage[]): string[] => ms.map((m) => m.text);

beforeEach(() => resetHistories());

test("a reconnect that lands where we left off keeps the scroll-back", () => {
  // The ordinary case: a dropped connection, nothing appended while we were away.
  seedTail("s1", { messages: [msg("d"), msg("e")], start: 500, atStart: false, pos: 900 });
  prependPage("s1", { start: 200, end: 500, messages: [msg("b"), msg("c")], atStart: false });
  prependPage("s1", { start: 0, end: 200, messages: [msg("a")], atStart: true });
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["a", "b", "c", "d", "e"]);

  seedTail("s1", { messages: [msg("d"), msg("e")], start: 500, atStart: false, pos: 900 });
  assert.deepEqual(
    texts(flattenHistory(readHistory("s1"))),
    ["a", "b", "c", "d", "e"],
    "the pages above the stream's window are still there",
  );
  assert.equal(backAnchor(readHistory("s1")), null, "and the history still knows it is complete");
});

test("the stream's atStart does not overrule pages the reader scrolled back to", () => {
  // `init.atStart` describes the STREAM's window, not the oldest page held. Taking it
  // literally when pages survive above it would claim the session begins at a turn the
  // reader has already scrolled past, and hide the control that reaches the rest.
  seedTail("s1", { messages: [msg("c")], start: 300, atStart: false, pos: 600 });
  prependPage("s1", { start: 100, end: 300, messages: [msg("b")], atStart: false });
  seedTail("s1", { messages: [msg("c")], start: 300, atStart: true, pos: 600 });
  assert.equal(backAnchor(readHistory("s1")), 100, "there is still history above the held page");
});

test("a gap opened while disconnected drops the stale pages rather than faking adjacency", () => {
  // Turns were written between our newest page and the window the stream came back with.
  // Rendering across that would put two non-adjacent turns side by side and say nothing;
  // dropping is recoverable, because scrolling up re-reads the very span discarded.
  seedTail("s1", { messages: [msg("c")], start: 300, atStart: false, pos: 600 });
  prependPage("s1", { start: 100, end: 300, messages: [msg("b")], atStart: false });

  seedTail("s1", { messages: [msg("z")], start: 900, atStart: false, pos: 1200 });
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["z"], "only the fresh window survives");
  assert.equal(backAnchor(readHistory("s1")), 900, "and it can be walked back from");
});

test("live turns extend the window without disturbing the pages above it", () => {
  seedTail("s1", { messages: [msg("b")], start: 200, atStart: false, pos: 400 });
  prependPage("s1", { start: 0, end: 200, messages: [msg("a")], atStart: true });
  appendLive("s1", [msg("c"), msg("d")]);
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["a", "b", "c", "d"]);
});

test("a re-delivered turn is not appended twice", () => {
  seedTail("s1", { messages: [msg("a")], start: 0, atStart: true, pos: 100 });
  appendLive("s1", [msg("b")]);
  appendLive("s1", [msg("b"), msg("c")]);
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["a", "b", "c"]);
});

test("a page that does not abut the held history is refused", () => {
  // Only reachable if the file was rewritten under a request already in flight. Splicing
  // it would invent an adjacency; re-anchoring to it would discard everything below.
  seedTail("s1", { messages: [msg("b")], start: 200, atStart: false, pos: 400 });
  assert.equal(prependPage("s1", { start: 0, end: 150, messages: [msg("a")], atStart: true }), null);
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["b"], "the held history is untouched");
  assert.equal(backAnchor(readHistory("s1")), 200, "and the anchor has not moved");
});

test("a page holding no renderable turn still moves the anchor", () => {
  // A long stretch of pure tool output parses to nothing. Treating that as "nothing
  // older" would strand the reader mid-session; dropping the empty page instead would
  // leave the anchor put and ask the same question forever.
  seedTail("s1", { messages: [msg("b")], start: 400, atStart: false, pos: 700 });
  prependPage("s1", { start: 100, end: 400, messages: [], atStart: false });
  assert.equal(backAnchor(readHistory("s1")), 100, "the scroll-back continues past the quiet stretch");
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["b"]);
});

test("history is per session and released when a session is evicted", () => {
  seedTail("s1", { messages: [msg("a")], start: 0, atStart: true, pos: 100 });
  seedTail("s2", { messages: [msg("b")], start: 0, atStart: true, pos: 100 });
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["a"]);
  dropHistory("s1");
  assert.equal(readHistory("s1"), null);
  assert.deepEqual(texts(flattenHistory(readHistory("s2"))), ["b"], "its neighbour is unaffected");
});

test("the map keeps a bounded number of sessions, evicting least-recently-seeded", () => {
  // A tab left open for days must not accumulate every session's transcript. Eviction is
  // only ever a re-fetch, so the bound can be small.
  for (let i = 0; i < 12; i++) seedTail(`s${i}`, { messages: [msg(`m${i}`)], start: 0, atStart: true, pos: 100 });
  assert.equal(readHistory("s0"), null, "the oldest was collected");
  assert.deepEqual(texts(flattenHistory(readHistory("s11"))), ["m11"], "the newest is held");
});

test("an unseeded session accumulates nothing", () => {
  // The panel falls back to its own merge when the map has no entry, so these must be
  // safe no-ops rather than throws.
  assert.equal(readHistory("ghost"), null);
  assert.equal(appendLive("ghost", [msg("a")]), null);
  assert.equal(prependPage("ghost", { start: 0, end: 10, messages: [], atStart: true }), null);
  assert.deepEqual(flattenHistory(null), []);
  assert.equal(backAnchor(null), null);
});

test("a reconnect resumes from where the reader got to, keeping every page", () => {
  // The case that made scroll-back not worth doing. A reconnect used to re-seed from a
  // fresh window, and that window is anchored at the CURRENT end of the file - so a single
  // turn written during the blip slid the anchor forward and dropped every page the reader
  // had scrolled back to. On a session that is actively working, that is every reconnect.
  seedTail("s1", { messages: [msg("d")], start: 500, atStart: false, pos: 800 });
  prependPage("s1", { start: 200, end: 500, messages: [msg("b"), msg("c")], atStart: false });
  prependPage("s1", { start: 0, end: 200, messages: [msg("a")], atStart: true });

  assert.equal(resumeAnchor("s1"), 800, "the reconnect asks the stream to continue from here");
  const next = resumeTail("s1", { messages: [msg("e")], pos: 950 });
  assert.deepEqual(
    texts(flattenHistory(next)),
    ["a", "b", "c", "d", "e"],
    "the missed turn lands on the end and the scroll-back is untouched",
  );
  assert.equal(next?.tailStart, 500, "the paging anchor did not move");
  assert.equal(resumeAnchor("s1"), 950, "and the next reconnect continues from the new end");
  assert.equal(backAnchor(readHistory("s1")), null, "the history still knows it is complete");
});

test("a resume that carries nothing still advances the anchor", () => {
  // Nothing was written during the drop, but the bytes up to `pos` are read either way.
  // Leaving the anchor behind would make the next reconnect re-request a range we hold,
  // and a rollout's synthesized ids cannot de-duplicate the replay.
  seedTail("s1", { messages: [msg("a")], start: 0, atStart: true, pos: 100 });
  const next = resumeTail("s1", { messages: [], pos: 180 });
  assert.deepEqual(texts(flattenHistory(next)), ["a"]);
  assert.equal(resumeAnchor("s1"), 180);
});

test("a resume for a session with no held history reports that it cannot continue", () => {
  // A reset or an eviction can drop the cache while a reconnect is in flight. Returning
  // null is what tells the panel to fall back rather than inventing a history to extend.
  assert.equal(resumeTail("ghost", { messages: [msg("a")], pos: 10 }), null);
  assert.equal(resumeAnchor("ghost"), null, "and there is no offset to ask the stream for");
});

test("live appends carry the anchor forward so a later reconnect resumes correctly", () => {
  seedTail("s1", { messages: [msg("a")], start: 0, atStart: true, pos: 100 });
  appendLive("s1", [msg("b")], 240);
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["a", "b"]);
  assert.equal(resumeAnchor("s1"), 240, "a reconnect now continues past the streamed turn");
});

test("an empty tail still renders the control that reaches older history", () => {
  seedTail("s1", { messages: [], start: 400, atStart: false, pos: 400 });
  const html = renderToStaticMarkup(
    createElement(TranscriptPanel, { session: mkSession(), canSend: true }),
  );
  assert.match(html, /Load older messages/);
  assert.match(html, /Loading…/);
});
