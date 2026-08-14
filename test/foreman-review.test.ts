import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { dialogMarker, sha1Hex } from "../src/shared/session.ts";
import type { PaneDialog, ReviewItem, SessionNoteSummary } from "../src/shared/types.ts";
import { acquireSidecarLayout } from "../src/web/components/ForemanRecommendation.tsx";
import { PaneDialogPrompt } from "../src/web/components/PaneDialogPrompt.tsx";
import { ReviewCard } from "../src/web/components/ReviewModal.tsx";
import {
  foremanNoteCompanionsOpenAsk,
  foremanNoteForDialog,
  foremanNoteForReview,
  recommendedChoiceKeys,
} from "../src/web/lib/foreman-review.ts";

const DIALOG: PaneDialog = {
  source: "driver",
  requestId: "request-1",
  kind: "question",
  prompt: "Which database?",
  highlighted: 0,
  options: [
    { number: 1, label: "SQLite" },
    { number: 2, label: "Postgres" },
  ],
};

function note(marker: string): SessionNoteSummary {
  return {
    purpose: "Choose storage.",
    brief: "SQLite keeps this dependency-free.",
    recommendation: 'Choose "SQLite" for the smallest operational footprint.',
    disposition: "escalated",
    lastAction: "escalated for your decision",
    handledMarker: marker,
    updatedAt: 1,
  };
}

test("the shared dialog marker preserves the persisted server SHA-1 shape", () => {
  // This exact value was produced by Node createHash before the marker moved to shared.
  // Pinning it prevents a browser-safe implementation that agrees only with itself from
  // stranding notes already written by an older daemon.
  assert.equal(dialogMarker(DIALOG), "dialog:c912d46a1283");
});

test("the browser-safe SHA-1 agrees with node:crypto on the shapes that break padding", () => {
  // One pinned digest exercises exactly one input length. This marker is persisted, so a
  // padding or encoding bug would not fail loudly - it would strand every note whose dialog
  // happens to land on the wrong length. The block boundary (55/56/57 and 63/64/65 bytes)
  // is where a hand-rolled implementation goes wrong, and multi-byte input is where a
  // length counted in characters rather than bytes does.
  const cases = [
    "",
    "a",
    "abc",
    ...[54, 55, 56, 57, 63, 64, 65, 119, 120, 128].map((n) => "x".repeat(n)),
    "Which database? SQLite/Postgres",
    "café ☕ naïve — 日本語",
    "🙂".repeat(20),
  ];
  for (const input of cases) {
    assert.equal(
      sha1Hex(input),
      createHash("sha1").update(input).digest("hex"),
      `shared SHA-1 disagreed with node:crypto for a ${input.length}-character input`,
    );
  }
});

test("only the note for this exact dialog becomes optional review context", () => {
  const matching = note(dialogMarker(DIALOG));
  assert.equal(foremanNoteForDialog(DIALOG, matching), matching);
  assert.equal(foremanNoteForDialog(DIALOG, note("dialog:some-other-ask")), null);
  assert.equal(
    foremanNoteForDialog(DIALOG, { ...matching, disposition: "answered" }),
    null,
    "finished notes belong to history",
  );
});

test("a live review marker integrates while an unrelated escalation stays separate", () => {
  const review = { id: "review-1" };
  const matching = note("review:review-1");
  assert.equal(foremanNoteForReview(review, matching), matching);
  assert.equal(foremanNoteForReview(review, note("review:review-2")), null);
  assert.equal(
    foremanNoteCompanionsOpenAsk({
      dialog: null,
      note: matching,
      pendingReviewIds: new Set(["review-1"]),
    }),
    true,
  );
  assert.equal(
    foremanNoteCompanionsOpenAsk({
      dialog: DIALOG,
      note: note("state:awaiting_input:41"),
      pendingReviewIds: new Set(),
    }),
    false,
  );
});

test("Foreman's exact option label becomes a pick without preselecting it", () => {
  const choices = [
    { key: "one", label: "State fix + orphan backstop (Recommended)", number: 1 },
    { key: "two", label: "State fix only", number: 2 },
    { key: "three", label: "No, leave it alone", number: 3 },
  ];
  assert.deepEqual(
    [...recommendedChoiceKeys('Choose "State fix + orphan backstop" for the durable fix.', choices)],
    ["one"],
  );
  assert.deepEqual([...recommendedChoiceKeys("Choose option 2.", choices)], ["two"]);
  assert.deepEqual(
    [...recommendedChoiceKeys("Use the safer approach.", choices)],
    [],
    "semantic guesses never paint a false pick",
  );
});

test("a label buried inside a longer word is not Foreman naming that option", () => {
  // Short labels are ordinary, and a bare substring test marks them from pure spelling
  // coincidence: "Go" lives inside "ongoing", "No" inside "nothing", "Test" inside "testing".
  // The mark asserts Foreman CHOSE this option, so a coincidence must never paint one.
  const choices = [
    { key: "go", label: "Go", number: 1 },
    { key: "no", label: "No", number: 2 },
    { key: "test", label: "Test", number: 3 },
  ];
  assert.deepEqual(
    [...recommendedChoiceKeys("Work is ongoing, nothing is blocked, and testing continues.", choices)],
    [],
  );
  // The same short labels still match when the prose actually names one of them.
  assert.deepEqual([...recommendedChoiceKeys("Answer: No.", choices)], ["no"]);
  assert.deepEqual([...recommendedChoiceKeys('Choose "Go" and move on.', choices)], ["go"]);
});

test("the layout reservation survives one of two open sidecars closing", () => {
  // An ensemble draws a card per candidate, each with its own recommendation trigger, so two
  // sidecars can be mounted at once. The reservation is a single page-wide class, so an
  // uncounted removal on the first unmount would strip the column the second one still needs
  // and put it back over the review's Submit - the exact bug this disclosure was fixed for.
  const calls: string[] = [];
  const body = {
    classList: {
      add: (t: string) => calls.push(`add:${t}`),
      remove: (t: string) => calls.push(`remove:${t}`),
    },
  };

  const releaseFirst = acquireSidecarLayout(body);
  const releaseSecond = acquireSidecarLayout(body);
  releaseFirst();
  assert.deepEqual(
    calls,
    ["add:foreman-sidecar-open", "add:foreman-sidecar-open"],
    "the second sidecar is still open, so the reservation must still stand",
  );

  releaseSecond();
  assert.deepEqual(calls.at(-1), "remove:foreman-sidecar-open", "the last one out releases it");

  // A cleanup React has already run must not decrement again, or the NEXT sidecar to open
  // would start from a negative count and never release.
  releaseSecond();
  const reopen = acquireSidecarLayout(body);
  assert.deepEqual(calls.at(-1), "add:foreman-sidecar-open");
  reopen();
  assert.deepEqual(calls.at(-1), "remove:foreman-sidecar-open");
});

test("a label whose own edge is punctuation still matches beside a word", () => {
  // The boundary is asserted only where the label's edge is alphanumeric. Demanding one
  // beyond a leading "+" or a trailing ")" would reject the sentence that does name it.
  const choices = [
    { key: "add", label: "+ add a step", number: 1 },
    { key: "none", label: "(none)", number: 2 },
  ];
  assert.deepEqual([...recommendedChoiceKeys("Pick + add a step here.", choices)], ["add"]);
  assert.deepEqual([...recommendedChoiceKeys("Pick (none) for now.", choices)], ["none"]);
});

test("the pane form shows the pick at a glance but keeps the reasoning closed", () => {
  const html = renderToStaticMarkup(
    createElement(PaneDialogPrompt, {
      sessionId: "s1",
      dialog: DIALOG,
      note: note(dialogMarker(DIALOG)),
    }),
  );
  assert.match(html, /View Foreman recommendation/);
  // The chosen design splits these two. Which option Foreman named is cheap enough to read
  // without asking, so it is marked on the option itself.
  assert.match(html, /Foreman&#x27;s pick/);
  // The prose is what crowded the console out, so it stays behind the trigger, and there is
  // still no second path that could send an answer.
  assert.doesNotMatch(html, /Choose &quot;SQLite&quot; for the smallest operational footprint/);
  assert.doesNotMatch(html, /Approve &amp; send/);
});

test("a recommendation naming no offered option marks nothing", () => {
  const html = renderToStaticMarkup(
    createElement(PaneDialogPrompt, {
      sessionId: "s1",
      dialog: DIALOG,
      note: { ...note(dialogMarker(DIALOG)), recommendation: "Ask the operator to decide." },
    }),
  );
  // The disclosure is still offered, because the brief is worth reading. What must not happen
  // is a mark landing on an arbitrary option just because a note exists.
  assert.match(html, /View Foreman recommendation/);
  assert.doesNotMatch(html, /Foreman&#x27;s pick/);
});

test("the durable review form gets the same split disclosure", () => {
  const review: ReviewItem = {
    id: "review-1",
    sessionId: "s1",
    kind: "input",
    title: "Which database?",
    body: "Which database?",
    status: "pending",
    createdAt: 1,
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    selections: null,
    decisions: [
      {
        id: "database",
        question: "Which database?",
        options: [
          { id: "sqlite", label: "SQLite" },
          { id: "postgres", label: "Postgres" },
        ],
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(ReviewCard, { review, note: note("review:review-1") }),
  );
  assert.match(html, /View Foreman recommendation/);
  assert.match(html, /Foreman&#x27;s pick/);
  // Marked, but emphatically not answered: a checked radio here would be Foreman deciding.
  assert.doesNotMatch(html, /checked/);
  assert.doesNotMatch(html, /Approve &amp; send/);
});

