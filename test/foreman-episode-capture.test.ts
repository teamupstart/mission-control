import { test } from "node:test";
import assert from "node:assert/strict";
import { episodeFromPlan, planFromVerdict } from "../src/server/foreman/verdict.ts";
import type { ReviewContext, Verdict } from "../src/server/foreman/verdict.ts";
import type { Pending } from "../src/server/foreman/pending.ts";

// What the record says about a decision, given everything the worker held at the
// moment it acted.
//
// This is the mapping that decides what survives an act that cannot be replayed: the
// pane is read once and dropped, and `classification` / `confidence` / `tier` /
// `answer.option` are returned by the model and stored nowhere else. Getting it wrong
// is not a rendering bug that can be fixed later - the data is simply gone.

const PANE =
  "Claude needs your permission to use AskUserQuestion\n\n" +
  "  Which database should the migration target?\n\n" +
  "❯ 1. Postgres\n  2. SQLite";

const MENU = {
  options: [
    { number: 1, label: "Postgres" },
    { number: 2, label: "SQLite" },
  ],
  highlighted: 1,
};

function terminalPending(over: Partial<Pending> = {}): Pending {
  return {
    situation: "terminal-pane",
    surface: "terminal",
    question: "Claude needs your permission to use AskUserQuestion",
    inputReviewId: null,
    canSend: true,
    marker: "await:1700",
    ...over,
  };
}

function ctxFor(p: Pending, menu: ReviewContext["menu"] = MENU): ReviewContext {
  return {
    sessionId: "s1",
    promptMarker: p.marker,
    inputReviewId: p.inputReviewId,
    canSend: p.canSend,
    gate: p.gate ?? null,
    menu,
  };
}

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    purpose: "Choosing the migration target.",
    classification: "design-fork",
    action: "escalate",
    brief: "Both are defensible.",
    recommendation: "SQLite.",
    confidence: 0.41,
    ...over,
  } as Verdict;
}

test("a terminal ask records the pane and the menu - the only copy of the question", () => {
  const pending = terminalPending();
  const ctx = ctxFor(pending);
  const v = verdict();
  const plan = planFromVerdict(v, ctx, false);
  const ep = episodeFromPlan({ pending, ctx, pane: PANE, verdict: v, tier: 2, plan });

  assert.equal(ep.pane, PANE, "the pane is the ask; nothing else holds it");
  assert.deepEqual(ep.menu, MENU);
  assert.equal(ep.marker, "await:1700");
  assert.equal(ep.situation, "terminal-pane");
  assert.equal(ep.surface, "terminal");
});

test("the verdict fields the note has never carried are all recorded", () => {
  const pending = terminalPending();
  const ctx = ctxFor(pending);
  const v = verdict();
  const plan = planFromVerdict(v, ctx, false);
  const ep = episodeFromPlan({ pending, ctx, pane: PANE, verdict: v, tier: 2, plan });

  assert.equal(ep.classification, "design-fork");
  assert.equal(ep.confidence, 0.41);
  assert.equal(ep.tier, 2);
  assert.equal(ep.brief, "Both are defensible.");
  assert.equal(ep.recommendation, "SQLite.");
});

test("an input review records its id and NO pane", () => {
  // The review's body is already durable in `reviews`. A second copy of the question
  // here could only drift from it, and a pane captured behind a review is a screen
  // that happens to be showing, not the ask.
  const pending = terminalPending({
    situation: "input-review",
    surface: "input-review",
    question: "Should I backfill the existing rows?",
    inputReviewId: "r-441",
    canSend: false,
    marker: "review:r-441",
  });
  const ctx = ctxFor(pending, null);
  const v = verdict();
  const plan = planFromVerdict(v, ctx, false);
  const ep = episodeFromPlan({ pending, ctx, pane: PANE, verdict: v, tier: 2, plan });

  assert.equal(ep.reviewId, "r-441");
  assert.equal(ep.pane, null, "a review's question is not a screen capture");
  assert.equal(ep.question, "Should I backfill the existing rows?");
});

test("an escalation records no send and no author", () => {
  const pending = terminalPending();
  const ctx = ctxFor(pending);
  const v = verdict();
  const plan = planFromVerdict(v, ctx, false);
  const ep = episodeFromPlan({ pending, ctx, pane: PANE, verdict: v, tier: 2, plan });

  assert.equal(ep.disposition, "escalated");
  assert.equal(ep.sentText, null);
  assert.equal(ep.sentBy, null, "nothing was sent, so nobody sent it");
  assert.equal(ep.sentOption, null);
});

test("a menu answer records the ROW's label as the sent text, not the rationale", () => {
  // A menu send types nothing: the label is the whole of what the child received, and
  // `answer.text` rides along only as the rationale for the note. Recording the
  // rationale as what was sent would put words in the child's mouth it never saw.
  const pending = terminalPending();
  const ctx = ctxFor(pending);
  const v = verdict({
    action: "answer",
    answer: { text: "SQLite keeps CI dependency-free.", submit: true, option: { number: 2, label: "SQLite" } },
  });
  const plan = planFromVerdict(v, ctx, true);
  const ep = episodeFromPlan({ pending, ctx, pane: PANE, verdict: v, tier: 2, plan });

  assert.equal(ep.disposition, "answered");
  assert.equal(ep.sentBy, "foreman");
  assert.equal(ep.sentText, "SQLite", "the row's label, which is what was delivered");
  assert.deepEqual(ep.sentOption, { number: 2, label: "SQLite" });
});

test("a prose answer records the text that was typed", () => {
  const pending = terminalPending();
  const ctx = ctxFor(pending, null); // no menu on screen
  const v = verdict({ action: "answer", answer: { text: "Use SQLite.", submit: true } });
  const plan = planFromVerdict(v, ctx, true);
  const ep = episodeFromPlan({ pending, ctx, pane: PANE, verdict: v, tier: 2, plan });

  assert.equal(ep.sentText, "Use SQLite.");
  assert.equal(ep.sentOption, null);
  assert.equal(ep.sentBy, "foreman");
});

test("a draft Foreman was not cleared to send records no author", () => {
  // dry-run / semi-auto / off-allowlist: the reply exists but never left the building,
  // so crediting Foreman with sending it would be a fabricated byline.
  const pending = terminalPending();
  const ctx = ctxFor(pending, null);
  const v = verdict({ action: "answer", answer: { text: "Use SQLite.", submit: true } });
  const plan = planFromVerdict(v, ctx, false); // not live
  const ep = episodeFromPlan({ pending, ctx, pane: PANE, verdict: v, tier: 2, plan });

  assert.equal(ep.disposition, "pending");
  assert.equal(ep.sentBy, null);
  assert.equal(ep.sentText, null);
  assert.equal(ep.recommendation, "Use SQLite.", "the draft itself is still kept");
});

test("a parked gate records the framed question, and no pane is lost to the surface", () => {
  const pending = terminalPending({
    situation: "gate-parked",
    question: "The no-mistakes run on main is parked at the \"review\" gate.",
    marker: "gate:r7:review:abc",
    gate: { runId: "r7", step: "review", findingIds: ["F-1"] },
  });
  const ctx = ctxFor(pending, null);
  const v = verdict();
  const plan = planFromVerdict(v, ctx, false);
  const ep = episodeFromPlan({ pending, ctx, pane: PANE, verdict: v, tier: 2, plan });

  assert.equal(ep.situation, "gate-parked");
  assert.equal(ep.surface, "terminal");
  assert.equal(ep.pane, PANE, "a gate is a terminal surface, so its screen is kept");
  assert.ok(ep.question.includes("parked"));
});

test("the tier that produced the verdict is recorded, cheap tier included", () => {
  const pending = terminalPending();
  const ctx = ctxFor(pending, null);
  const v = verdict({ action: "answer", answer: { text: "yes", submit: true }, classification: "access" });
  const plan = planFromVerdict(v, ctx, true);
  assert.equal(episodeFromPlan({ pending, ctx, pane: PANE, verdict: v, tier: 1, plan }).tier, 1);
  assert.equal(episodeFromPlan({ pending, ctx, pane: PANE, verdict: v, tier: 0, plan }).tier, 0);
});
