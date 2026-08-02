import { test } from "node:test";
import assert from "node:assert/strict";
import { VerdictSchema } from "../src/server/foreman/verdict.ts";
import { TriageReportSchema } from "../src/server/foreman/triage.ts";

// A textless `answer` must read as "no answer", not as a malformed reply.
//
// Measured, not hypothesized: the payload below is the verbatim reply a real Opus reviewer
// returned for a live session. The prompt shows the model the whole object shape, so a reviewer
// with nothing to send fills `answer` in anyway. `text: z.string().min(1)` rejected the entire
// verdict over it; `runStructured` retried; after three strikes the worker wrote
// `skipped (reviewer failed 3x)` and moved on - three Opus calls spent to discard a complete,
// correct judgment because one unused field was "". To the human, Foreman had simply gone quiet.

/** The exact reviewer reply that was being thrown away, trimmed only in prose length. */
const REAL_SKIP = {
  purpose: "This session implements the review byline.",
  classification: "other",
  action: "skip",
  answer: { text: "" },
  recommendation: "Nothing to answer right now - wait for the background run to return.",
  brief: "",
  confidence: 0.87,
};

test("a real reviewer's skip with an empty answer is accepted", () => {
  const r = VerdictSchema.safeParse(REAL_SKIP);
  assert.ok(r.success, "the verdict that used to cost three Opus calls and produce silence");
  if (!r.success) return;
  assert.equal(r.data.action, "skip");
  assert.equal(r.data.answer, undefined, "textless normalizes to absent, so `answer` present still means sendable");
  assert.equal(r.data.recommendation, REAL_SKIP.recommendation, "the judgment survives intact");
});

test("every textless spelling of `answer` reads as absent", () => {
  // Models spell "nothing to say" several ways; none of them is a broken reply.
  for (const answer of [{ text: "" }, { text: "   " }, {}, null]) {
    const r = VerdictSchema.safeParse({ ...REAL_SKIP, answer });
    assert.ok(r.success, `should accept answer=${JSON.stringify(answer)}`);
    if (r.success) assert.equal(r.data.answer, undefined);
  }
});

test("an escalate with an empty answer keeps its recommendation", () => {
  // The escalate path is the one that hands you a brief to act on, so dropping it to a parse
  // failure loses the most useful thing the reviewer produced.
  const r = VerdictSchema.safeParse({
    ...REAL_SKIP,
    action: "escalate",
    classification: "design-fork",
    brief: "## Which holder policy?",
    recommendation: "Option 1 - reap only mission-control leases.",
  });
  assert.ok(r.success);
  if (r.success) assert.equal(r.data.recommendation, "Option 1 - reap only mission-control leases.");
});

test("an ANSWER action with no text to send is still rejected", () => {
  // The invariant this normalization must not cost: `action: "answer"` reaches `v.answer!` in
  // planFromVerdict and gets typed into someone's terminal. An empty one has to fail and retry,
  // never send a blank line.
  for (const answer of [{ text: "" }, { text: "  " }, {}, null, undefined]) {
    const r = VerdictSchema.safeParse({ ...REAL_SKIP, action: "answer", answer });
    assert.ok(!r.success, `answer action must reject answer=${JSON.stringify(answer)}`);
  }
});

test("a real answer is untouched", () => {
  const r = VerdictSchema.safeParse({ ...REAL_SKIP, action: "answer", answer: { text: "Approve - go ahead." } });
  assert.ok(r.success);
  if (!r.success) return;
  assert.equal(r.data.answer?.text, "Approve - go ahead.");
  assert.equal(r.data.answer?.submit, true, "the submit default still applies");
});

test("an unreadable answer.text is NOT swallowed", () => {
  // A non-string text is a reply we genuinely can't read. Rewriting it to "no answer" would
  // turn a broken reviewer into a quiet skip; it must fail and retry like any other parse miss.
  assert.ok(!VerdictSchema.safeParse({ ...REAL_SKIP, answer: { text: 42 } }).success);
});

test("the Tier 1 report grew the same defect and gets the same cure", () => {
  // The router is handed the same shape by the same kind of model. Its failure was safe (a
  // route-up) but self-defeating: it spent the Opus call the cheap tier exists to avoid.
  const r = TriageReportSchema.safeParse({
    purpose: "p",
    bucket: "human-only",
    disposition: "escalate",
    answer: { text: "" },
    confidence: 0.9,
  });
  assert.ok(r.success, "a human-only bucketing must survive an empty answer field");
  if (r.success) assert.equal(r.data.answer, undefined);
});

test("a Tier 1 routine-access answer is still carried", () => {
  const r = TriageReportSchema.safeParse({
    purpose: "p",
    bucket: "routine-access",
    answer: { text: "Approve - go ahead." },
    confidence: 0.9,
  });
  assert.ok(r.success);
  if (r.success) assert.equal(r.data.answer?.text, "Approve - go ahead.");
});
