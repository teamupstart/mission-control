import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { resetSessionViews, writeSessionView } from "../src/web/lib/conversation-view.ts";
import { resetHistories, seedTail } from "../src/web/lib/transcript-history.ts";
import { mkSession } from "./helpers/session-fixture.ts";
import { tooltipLabels } from "./helpers/markup.ts";

const AT = Date.parse("2026-07-31T13:42:07.000Z");

beforeEach(() => resetHistories());

test("a conversation timestamp shows the clock alone, and hides no part of the instant", () => {
  // The row is the time only - the date it drops is the field that repeats down the log.
  assert.equal(formatConversationTimestamp(AT, "en-US", "America/New_York"), "9:42 AM");
  assert.doesNotMatch(formatConversationTimestamp(AT, "en-US", "America/New_York"), /Jul|31/);
  // Nothing is lost: the hover and accessible form still carry the whole date.
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
  // This test inspects Chat's bylines and chips, so name that rendering instead of
  // inheriting the application's default.
  writeSessionView("s1", "chat");
  let html: string;
  try {
    html = renderToStaticMarkup(
      createElement(TranscriptPanel, { session: mkSession({ id: "s1" }), canSend: true }),
    );
  } finally {
    resetSessionViews();
  }

  assert.equal((html.match(/class="conversation-time turn-time"/g) ?? []).length, 2);
  assert.match(html, /dateTime="2026-07-31T13:42:07.000Z"/);
  assert.match(html, /dateTime="2026-07-31T13:42:08.000Z"/);
  // The fold keeps its FIRST turn's time in the log. The :09 instant still exists in the
  // markup - the Observed activity rail dates every invocation individually - but no turn
  // row may carry it.
  assert.doesNotMatch(html, /class="conversation-time turn-time" dateTime="2026-07-31T13:42:09.000Z"/);
  assert.match(html, /class="conversation-time activity-time" dateTime="2026-07-31T13:42:09.000Z"/);

  // Prose keeps its time inside the byline, where `margin-left: auto` carries it to the
  // right edge of the label's own line - the row below it is untouched and full width.
  assert.match(html, /<div class="turn-role">you<time class="conversation-time turn-time"/);
  // A folded run lays label and chips along one line, so its byline cannot reach the row's
  // right edge; the time is a sibling of both. Asserted by the label div closing on itself.
  assert.match(html, /turn-toolrun"><div class="turn-role">claude executed<\/div>/);
  assert.match(html, /<\/div><time class="conversation-time turn-time" dateTime="[^"]+:08/);
});

test("the byline clock is pinned to the row's right edge, and takes no width from the turn", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
  const rule = /\.turn \.turn-time\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(rule, "no .turn .turn-time rule");
  // `margin-left: auto` is the whole mechanism: the time stays a flex item of the line it
  // shares with the speaker, so the turn's text still runs the full width beneath it. A
  // float or a grid column here would indent every message in the log.
  assert.match(rule!, /margin-left:\s*auto/);
  assert.match(rule!, /flex:\s*none/);
  // The separator existed to part the label from the time. Against the right edge there is
  // nothing to part, and a lone "·" out there reads as a bullet with a missing line.
  assert.doesNotMatch(css, /\.turn(-role)? \.turn-time::before/);
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
    triageReason: null,
    skipReason: null,
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
