import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { ForemanEpisode } from "../src/shared/types.ts";
import { ForemanEpisodeCard } from "../src/web/components/ForemanEpisodeCard.tsx";

// The Resolution block: who settled the episode, and with what words.
//
// An episode still waiting on a human has no `resolvedBy`, so the "who" line has
// nothing to name but `lastAction` - which is also the only thing the trailing line
// has to show once nothing was sent. Printing both is the same string twice, on every
// escalated episode, i.e. exactly the ones a reader opens the drawer to look at.

function ep(over: Partial<ForemanEpisode> = {}): ForemanEpisode {
  return {
    id: 1,
    noteKey: "k",
    sessionId: "s",
    marker: "m",
    situation: "terminal-pane",
    surface: "terminal",
    question: "",
    pane: null,
    menu: null,
    reviewId: null,
    purpose: null,
    brief: null,
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
    createdAt: 1,
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

test("an escalated episode states what happened once, not twice", () => {
  const html = renderToStaticMarkup(
    React.createElement(ForemanEpisodeCard, {
      episode: ep({ disposition: "escalated", lastAction: "escalated for your decision" }),
      detail: true,
    }),
  );
  assert.equal(occurrences(html, "escalated for your decision"), 1, html);
});

test("a resolved episode still shows the words that were sent", () => {
  // The fix must not cost the trailing line where it is carrying something the "who"
  // line does not already say - here `resolvedBy` names the author, so `lastAction` is
  // the only record of what reached the child.
  const html = renderToStaticMarkup(
    React.createElement(ForemanEpisodeCard, {
      episode: ep({
        disposition: "answered",
        resolvedBy: "you",
        lastAction: "approved by you",
      }),
      detail: true,
    }),
  );
  assert.ok(html.includes("You approved"), html);
  assert.equal(occurrences(html, "approved by you"), 1, html);
});

test("a sent reply is shown in place of the bare action line", () => {
  const html = renderToStaticMarkup(
    React.createElement(ForemanEpisodeCard, {
      episode: ep({
        disposition: "answered",
        resolvedBy: "foreman",
        lastAction: "answered by Foreman",
        sentText: "Yes, run it during the maintenance window.",
      }),
      detail: true,
    }),
  );
  assert.ok(html.includes("Foreman answered"), html);
  assert.ok(html.includes("Yes, run it during the maintenance window."), html);
  assert.equal(occurrences(html, "answered by Foreman"), 0, html);
});

test("the episode records pane delivery capability without exposing its internal terminal token", () => {
  const html = renderToStaticMarkup(
    React.createElement(ForemanEpisodeCard, { episode: ep({ question: "Can I continue?" }), detail: true }),
  );
  assert.ok(html.includes("pane available"), html);
  assert.ok(!html.includes("terminal-pane"), html);
});
