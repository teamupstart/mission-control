import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ForemanEpisode, TranscriptMessage } from "../src/shared/types.ts";
import { ConversationTimestamp } from "../src/web/components/ConversationTimestamp.tsx";
import { ForemanEpisodeCard } from "../src/web/components/ForemanEpisodeCard.tsx";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import {
  formatConversationTimestamp,
  formatConversationTimestampLong,
} from "../src/web/lib/format.ts";
import { resetHistories, seedTail } from "../src/web/lib/transcript-history.ts";
import { mkSession } from "./helpers/session-fixture.ts";
import { tooltipLabels } from "./helpers/markup.ts";

const AT = Date.parse("2026-07-31T13:42:07.000Z");

beforeEach(() => resetHistories());

test("conversation timestamps follow an explicit locale and timezone", () => {
  assert.equal(
    formatConversationTimestamp(AT, "en-US", "America/New_York"),
    "Jul 31, 9:42 AM",
  );
  const long = formatConversationTimestampLong(AT, "en-US", "America/New_York");
  assert.match(long, /Friday, July 31, 2026/);
  assert.match(long, /9:42:07 AM/);
  assert.match(long, /EDT/);
});

test("a dated turn renders a semantic instant and an unknown time renders nothing", () => {
  const html = renderToStaticMarkup(createElement(ConversationTimestamp, { at: AT }));
  assert.match(html, /<time class="conversation-time"/);
  assert.match(html, /dateTime="2026-07-31T13:42:07.000Z"/);
  assert.match(html, /aria-describedby="[^"]+"/);
  assert.deepEqual(tooltipLabels(html), [formatConversationTimestampLong(AT)]);
  assert.equal(renderToStaticMarkup(createElement(ConversationTimestamp, { at: 0 })), "");
  assert.equal(renderToStaticMarkup(createElement(ConversationTimestamp, { at: Number.NaN })), "");
});

test("the conversation dates prose and a folded tool run from its first turn", () => {
  const messages: TranscriptMessage[] = [
    { id: "u1", role: "user", text: "Check it", tools: [], ts: AT },
    { id: "t1", role: "assistant", text: "", tools: [{ name: "Bash" }], ts: AT + 1_000 },
    { id: "t2", role: "assistant", text: "", tools: [{ name: "Read" }], ts: AT + 2_000 },
    { id: "u2", role: "user", text: "Undated", tools: [], ts: 0 },
  ];
  seedTail("s1", { messages, start: 0, atStart: true, pos: 100 });
  const html = renderToStaticMarkup(
    createElement(TranscriptPanel, { session: mkSession({ id: "s1" }), canSend: true }),
  );

  assert.equal((html.match(/class="conversation-time turn-time"/g) ?? []).length, 2);
  assert.match(html, /dateTime="2026-07-31T13:42:07.000Z"/);
  assert.match(html, /dateTime="2026-07-31T13:42:08.000Z"/);
  assert.doesNotMatch(html, /dateTime="2026-07-31T13:42:09.000Z"/);
});

function episode(createdAt: number): ForemanEpisode {
  return {
    id: 1,
    noteKey: "note",
    sessionId: "s1",
    marker: "await:1",
    situation: "terminal-pane",
    surface: "terminal",
    question: "Proceed?",
    pane: null,
    menu: null,
    reviewId: null,
    purpose: null,
    brief: "A decision",
    recommendation: null,
    classification: null,
    confidence: null,
    tier: null,
    cheapAction: null,
    divergence: null,
    disposition: "escalated",
    lastAction: null,
    sentText: null,
    sentOption: null,
    sentBy: null,
    createdAt,
    resolvedAt: null,
    resolvedBy: null,
  };
}

test("Foreman uses absolute time only in its conversation rendering", () => {
  const absolute = renderToStaticMarkup(
    createElement(ForemanEpisodeCard, { episode: episode(AT), absoluteTime: true }),
  );
  assert.match(absolute, /class="conversation-time fe-time dim"/);
  assert.match(absolute, /dateTime="2026-07-31T13:42:07.000Z"/);

  const drawer = renderToStaticMarkup(createElement(ForemanEpisodeCard, { episode: episode(AT) }));
  assert.doesNotMatch(drawer, /<time/);
  assert.match(drawer, /class="fe-time dim"/);
});
