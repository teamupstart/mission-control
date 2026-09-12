import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { ForemanEpisode } from "../src/shared/types.ts";
import { ForemanEpisodeCard } from "../src/web/components/ForemanEpisodeCard.tsx";
import { shipRecoveryBrief } from "../src/server/foreman/ship-shepherd.ts";

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
    triageReason: null,
    skipReason: null,
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

test("a ship recovery episode exposes its operator-facing audit category", () => {
  const html = renderToStaticMarkup(
    React.createElement(ForemanEpisodeCard, {
      episode: ep({
        situation: "ship-recovery",
        question: "Keep managed ship task moving before its first pull request.",
      }),
      detail: true,
    }),
  );
  assert.ok(html.includes("pre-PR ship recovery"), html);
});

/**
 * The recovery card, composed by the worker's own brief builder rather than by hand.
 *
 * Composing it here is the point: the duplicate the operator reported was not a rendering
 * bug but the body and the Resolution carrying one paragraph each, and an episode written
 * by a literal in this file could only ever prove what the literal said. Read together
 * with `foreman-ship-shepherd.test.ts`, this closes the loop from the rule to the card.
 */
const RECOVERY_INSTRUCTION = "Address only these implementation, documentation, test, or evidence gaps.";

test("a delivered recovery prints its instruction once, under Resolution", () => {
  const html = renderToStaticMarkup(
    React.createElement(ForemanEpisodeCard, {
      episode: ep({
        situation: "ship-recovery",
        disposition: "answered",
        resolvedBy: "foreman",
        sentBy: "foreman",
        purpose: "Pre-PR ship recovery: held completion gaps, attempt 1/3, delivered.",
        brief: shipRecoveryBrief({
          detail: RECOVERY_INSTRUCTION,
          decisionSummary: null,
          quietMinutes: 0,
          delivery: "delivered",
          next: "next attempt after 40 minutes",
          sentText: RECOVERY_INSTRUCTION,
        }),
        sentText: RECOVERY_INSTRUCTION,
      }),
      detail: true,
    }),
  );
  assert.equal(occurrences(html, RECOVERY_INSTRUCTION), 1, html);
  assert.ok(html.includes("Quiet age: 0 minutes."), html);
});

test("a recovery that reached nobody still prints its instruction, and still only once", () => {
  const html = renderToStaticMarkup(
    React.createElement(ForemanEpisodeCard, {
      episode: ep({
        situation: "ship-recovery",
        disposition: "skipped",
        resolvedBy: "foreman",
        purpose: "Pre-PR ship recovery: held completion gaps, attempt 1/3, confirmed undelivered.",
        brief: shipRecoveryBrief({
          detail: RECOVERY_INSTRUCTION,
          decisionSummary: null,
          quietMinutes: 41,
          delivery: "confirmed undelivered",
          next: "same attempt ready to retry",
          sentText: null,
        }),
        lastAction: "Pre-PR recovery confirmed undelivered",
        sentText: null,
      }),
      detail: true,
    }),
  );
  assert.equal(occurrences(html, RECOVERY_INSTRUCTION), 1, html);
});
