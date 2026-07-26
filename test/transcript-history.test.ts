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
  seedTail,
} from "../src/web/lib/transcript-history.ts";

// What is at stake: whether scrolling back through a conversation is worth doing.
//
// The panel's stream re-states its bounded tail on every `init`, and `init` arrives far
// more often than "when you open a card" - the browser's EventSource reconnects on any
// transient drop, and the daemon restarts. Taking that frame as the whole conversation is
// what made a long session's history evaporate on a blip; it is also what would make
// scroll-back pointless, since the pages a reader worked for would vanish the same way.
//
// The rule these tests pin is that held pages survive an `init` only while they still
// ABUT it. Bytes are the only thing that can answer that: turn counts don't identify a
// position in a file, and ids can't either - a harness whose records carry none
// synthesizes them per parse batch, so the same turn read twice is two different ids.
// Which means the interesting cases are the boundary ones, and they are all here.

const msg = (id: string): TranscriptMessage => ({ id, role: "user", text: id, tools: [], ts: 0 });
const texts = (ms: TranscriptMessage[]): string[] => ms.map((m) => m.text);

beforeEach(() => resetHistories());

test("a reconnect that lands where we left off keeps the scroll-back", () => {
  // The ordinary case: a dropped connection, nothing appended while we were away.
  seedTail("s1", { messages: [msg("d"), msg("e")], start: 500, atStart: false });
  prependPage("s1", { start: 200, end: 500, messages: [msg("b"), msg("c")], atStart: false });
  prependPage("s1", { start: 0, end: 200, messages: [msg("a")], atStart: true });
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["a", "b", "c", "d", "e"]);

  seedTail("s1", { messages: [msg("d"), msg("e")], start: 500, atStart: false });
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
  seedTail("s1", { messages: [msg("c")], start: 300, atStart: false });
  prependPage("s1", { start: 100, end: 300, messages: [msg("b")], atStart: false });
  seedTail("s1", { messages: [msg("c")], start: 300, atStart: true });
  assert.equal(backAnchor(readHistory("s1")), 100, "there is still history above the held page");
});

test("a gap opened while disconnected drops the stale pages rather than faking adjacency", () => {
  // Turns were written between our newest page and the window the stream came back with.
  // Rendering across that would put two non-adjacent turns side by side and say nothing;
  // dropping is recoverable, because scrolling up re-reads the very span discarded.
  seedTail("s1", { messages: [msg("c")], start: 300, atStart: false });
  prependPage("s1", { start: 100, end: 300, messages: [msg("b")], atStart: false });

  seedTail("s1", { messages: [msg("z")], start: 900, atStart: false });
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["z"], "only the fresh window survives");
  assert.equal(backAnchor(readHistory("s1")), 900, "and it can be walked back from");
});

test("live turns extend the window without disturbing the pages above it", () => {
  seedTail("s1", { messages: [msg("b")], start: 200, atStart: false });
  prependPage("s1", { start: 0, end: 200, messages: [msg("a")], atStart: true });
  appendLive("s1", [msg("c"), msg("d")]);
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["a", "b", "c", "d"]);
});

test("a re-delivered turn is not appended twice", () => {
  seedTail("s1", { messages: [msg("a")], start: 0, atStart: true });
  appendLive("s1", [msg("b")]);
  appendLive("s1", [msg("b"), msg("c")]);
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["a", "b", "c"]);
});

test("a page that does not abut the held history is refused", () => {
  // Only reachable if the file was rewritten under a request already in flight. Splicing
  // it would invent an adjacency; re-anchoring to it would discard everything below.
  seedTail("s1", { messages: [msg("b")], start: 200, atStart: false });
  assert.equal(prependPage("s1", { start: 0, end: 150, messages: [msg("a")], atStart: true }), null);
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["b"], "the held history is untouched");
  assert.equal(backAnchor(readHistory("s1")), 200, "and the anchor has not moved");
});

test("a page holding no renderable turn still moves the anchor", () => {
  // A long stretch of pure tool output parses to nothing. Treating that as "nothing
  // older" would strand the reader mid-session; dropping the empty page instead would
  // leave the anchor put and ask the same question forever.
  seedTail("s1", { messages: [msg("b")], start: 400, atStart: false });
  prependPage("s1", { start: 100, end: 400, messages: [], atStart: false });
  assert.equal(backAnchor(readHistory("s1")), 100, "the scroll-back continues past the quiet stretch");
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["b"]);
});

test("history is per session and released when a session is evicted", () => {
  seedTail("s1", { messages: [msg("a")], start: 0, atStart: true });
  seedTail("s2", { messages: [msg("b")], start: 0, atStart: true });
  assert.deepEqual(texts(flattenHistory(readHistory("s1"))), ["a"]);
  dropHistory("s1");
  assert.equal(readHistory("s1"), null);
  assert.deepEqual(texts(flattenHistory(readHistory("s2"))), ["b"], "its neighbour is unaffected");
});

test("the map keeps a bounded number of sessions, evicting least-recently-seeded", () => {
  // A tab left open for days must not accumulate every session's transcript. Eviction is
  // only ever a re-fetch, so the bound can be small.
  for (let i = 0; i < 12; i++) seedTail(`s${i}`, { messages: [msg(`m${i}`)], start: 0, atStart: true });
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

test("an empty tail still renders the control that reaches older history", () => {
  seedTail("s1", { messages: [], start: 400, atStart: false });
  const html = renderToStaticMarkup(
    createElement(TranscriptPanel, { session: mkSession(), canSend: true }),
  );
  assert.match(html, /Load older messages/);
  assert.match(html, /Loading…/);
});
