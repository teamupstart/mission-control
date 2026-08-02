import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyVerdict,
  planFromVerdict,
  VerdictSchema,
  type ForemanActions,
  type ReviewContext,
  type Verdict,
} from "../src/server/foreman/verdict.ts";
import type { PaneDialog } from "../src/shared/types.ts";

// What is at stake: a multi-question ask is the one thing Foreman could never answer, and
// the reason was always a PANE limitation rather than a reviewer one. Pressing a row of a
// terminal form only ticks a box - nothing reaches the agent until its Submit tab is
// confirmed - so `menuMismatch` declined the whole class outright and every one of them
// became an escalation. A driver hands over every question at once and takes them back
// answered together, so the refusal has to stop being inherited.
//
// What must NOT happen while lifting it, in three directions:
//
//  - A PARTIAL form must never be submitted. It puts answers the operator never gave under
//    their name, on a question the agent will act on. The pane path refuses a half-filled
//    form for exactly this reason, and arithmetic over the request is a stronger check than
//    the banner it reads off a screen - so it must actually be run, not assumed.
//  - The submission that is VALIDATED must be the submission that is SENT. Checking an
//    answer and then re-deriving what to deliver from the raw verdict is how a well-formed
//    answer to one question is delivered to another.
//  - The pane's refusal must stay exactly where it was. A terminal multi-select is still
//    unanswerable, and a `form` volunteered against one must not become a send.
//
// The reviewer's grammar and the wire's part company on purpose (see `resolveFormAnswers`):
// the model writes a value per question and the code decides whether that value is a chosen
// option or the reviewer's own words, because a model asked to declare which would be
// answering a question about its own answer.

const FORM: PaneDialog = {
  options: [],
  highlighted: 0,
  prompt: "How should the cache be keyed?",
  multiSelect: true,
  source: "driver",
  requestId: "req-1",
  kind: "question",
  questions: [
    {
      question: "Which key?",
      options: [
        { number: 1, label: "By URL" },
        { number: 2, label: "By body hash" },
      ],
    },
    {
      question: "Evict how?",
      options: [
        { number: 1, label: "LRU" },
        { number: 2, label: "TTL" },
      ],
      multiSelect: true,
    },
  ],
};

/** The same shape a pane parse produces for a multi-select - no source, no request id. */
const PANE_FORM: PaneDialog = {
  options: [
    { number: 1, label: "By URL", checked: false },
    { number: 2, label: "By body hash", checked: false },
  ],
  highlighted: 1,
  prompt: "How should the cache be keyed?",
  multiSelect: true,
};

function ctx(over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    sessionId: "sdk:1",
    promptMarker: "dialog:abc",
    inputReviewId: null,
    canSend: true,
    ...over,
  };
}

function verdict(answers: Record<string, string | string[]>): Verdict {
  return {
    purpose: "Deciding the cache key and eviction policy.",
    classification: "implementation",
    action: "answer",
    answer: { text: "Hash the body so identical requests share an entry.", submit: true, form: { answers } },
    confidence: 0.9,
  };
}

test("the verdict schema accepts a form, and both value shapes in it", () => {
  const parsed = VerdictSchema.safeParse({
    purpose: "p",
    classification: "implementation",
    action: "answer",
    answer: {
      text: "rationale",
      form: { answers: { "Which key?": "By URL", "Evict how?": ["LRU", "TTL"] } },
    },
  });
  assert.ok(parsed.success, "a one-value answer and a many-value answer are both legal");
  assert.deepEqual(parsed.data.answer?.form?.answers, {
    "Which key?": "By URL",
    "Evict how?": ["LRU", "TTL"],
  });
});

test("a complete form is planned as one submission, not as a row press", () => {
  const c = ctx({ menu: FORM });
  const plan = planFromVerdict(verdict({ "Which key?": "By body hash", "Evict how?": ["LRU"] }), c, true);
  assert.equal(plan.note.disposition, "answered");
  assert.equal(plan.send?.channel, "send");
  assert.equal(plan.send?.option, undefined, "a form is not answered by pressing a row");
  assert.deepEqual(plan.send?.form, [
    { question: "Which key?", labels: ["By body hash"] },
    { question: "Evict how?", labels: ["LRU"] },
  ]);
  // The rationale is recorded, never delivered - the same split a menu answer makes.
  assert.equal(plan.send?.text, "Hash the body so identical requests share an entry.");
  assert.match(plan.note.lastAction ?? "", /2-question form/);
});

test("a value that is not one of the offered options is the reviewer's own words", () => {
  // Prose IS deliverable on this runtime, and that is the whole difference the policy states.
  // Sending it as a LABEL would be refused by the daemon ("no longer an option"), so a
  // free-text answer would read to the operator as a form that broke rather than one Foreman
  // answered in words.
  const c = ctx({ menu: FORM });
  const plan = planFromVerdict(
    verdict({ "Which key?": "By a normalized URL plus the Accept header", "Evict how?": ["TTL"] }),
    c,
    true,
  );
  assert.deepEqual(plan.send?.form?.[0], {
    question: "Which key?",
    labels: [],
    text: "By a normalized URL plus the Accept header",
  });
});

test("a form missing a question is escalated, never half-submitted", () => {
  const c = ctx({ menu: FORM });
  const plan = planFromVerdict(verdict({ "Which key?": "By URL" }), c, true);
  assert.equal(plan.send, null, "nothing may be delivered");
  assert.equal(plan.note.disposition, "escalated");
  assert.match(plan.note.lastAction ?? "", /Evict how\?" was not answered/);
  // The reviewer's judgment still reaches the human who CAN fill the form in.
  assert.equal(plan.note.recommendation, "Hash the body so identical requests share an entry.");
});

test("a form answering a question the request does not have is escalated, not trimmed", () => {
  // Silently dropping the stray entry would turn a reviewer that answered the WRONG form
  // into one that submitted a partial answer to the right one.
  const c = ctx({ menu: FORM });
  const plan = planFromVerdict(
    verdict({ "Which key?": "By URL", "Evict how?": ["LRU"], "Compress?": "Yes" }),
    c,
    true,
  );
  assert.equal(plan.send, null);
  assert.match(plan.note.lastAction ?? "", /no longer asks "Compress\?"/);
});

test("a label the question no longer offers is escalated", () => {
  const c = ctx({ menu: FORM });
  const plan = planFromVerdict(
    verdict({ "Which key?": ["By ETag"], "Evict how?": ["LRU"] }),
    c,
    true,
  );
  assert.equal(plan.send, null);
  assert.match(plan.note.lastAction ?? "", /"By ETag" is no longer an option/);
});

test("several answers to a single-answer question are escalated", () => {
  const c = ctx({ menu: FORM });
  const plan = planFromVerdict(
    verdict({ "Which key?": ["By URL", "By body hash"], "Evict how?": ["LRU"] }),
    c,
    true,
  );
  assert.equal(plan.send, null);
  assert.match(plan.note.lastAction ?? "", /takes one answer, not 2/);
});

test("a driver form the reviewer answered with no form at all is escalated, and says which", () => {
  const c = ctx({ menu: FORM });
  const bare: Verdict = {
    purpose: "p",
    classification: "implementation",
    action: "answer",
    answer: { text: "Use the body hash.", submit: true },
  };
  const plan = planFromVerdict(bare, c, true);
  assert.equal(plan.send, null);
  // The sentence must describe the ASK, not a pane this session does not have.
  assert.match(plan.note.lastAction ?? "", /form of several questions/);
  assert.doesNotMatch(plan.note.lastAction ?? "", /pane/);
});

test("a PANE multi-select is still refused outright, form or no form", () => {
  // The limitation being lifted is the driver's, and lifting it here would type answers at a
  // screen that has no way to receive them.
  const c = ctx({ menu: PANE_FORM });
  const withForm = planFromVerdict(verdict({ "Which key?": "By URL" }), c, true);
  assert.equal(withForm.send, null);
  assert.match(withForm.note.lastAction ?? "", /the pane is showing a multi-select form/);
});

test("a form is delivered through submit-options, and only a delivered one stamps the note", async () => {
  const calls: string[] = [];
  const submitted: unknown[] = [];
  const actions: ForemanActions = {
    putNote: async () => (calls.push("putNote"), {}),
    sendText: async () => (calls.push("sendText"), {}),
    selectOption: async () => (calls.push("selectOption"), {}),
    submitForm: async (_id, answers) => (calls.push("submitForm"), submitted.push(answers), {}),
    resolveReview: async () => (calls.push("resolveReview"), {}),
  };
  const c = ctx({ menu: FORM });
  const plan = planFromVerdict(verdict({ "Which key?": "By URL", "Evict how?": ["TTL"] }), c, true);
  await applyVerdict(actions, c, plan);
  assert.deepEqual(calls, ["submitForm", "putNote"], "deliver first, stamp second");
  assert.deepEqual(submitted, [
    [
      { question: "Which key?", labels: ["By URL"] },
      { question: "Evict how?", labels: ["TTL"] },
    ],
  ]);
});

test("a refused submission leaves the session unanswered and retryable", async () => {
  // The daemon 409s when the live request no longer matches, and a refusal means nothing was
  // delivered - so no `answered` note may be stamped, or the worker's idempotency check
  // would never look at this ask again.
  const notes: unknown[] = [];
  const actions: ForemanActions = {
    putNote: async (_id, patch) => (notes.push(patch), {}),
    sendText: async () => ({}),
    selectOption: async () => ({}),
    submitForm: async () => {
      throw new Error("this form no longer asks that");
    },
    resolveReview: async () => ({}),
  };
  const c = ctx({ menu: FORM });
  const plan = planFromVerdict(verdict({ "Which key?": "By URL", "Evict how?": ["TTL"] }), c, true);
  await assert.rejects(applyVerdict(actions, c, plan), /no longer asks/);
  assert.deepEqual(notes, [
    { purpose: "Deciding the cache key and eviction policy.", disposition: "skipped" },
  ]);
});

test("a form is never sent to an input review's channel", () => {
  // `pickChannel` routes an unblocking `input` review over the API, where there is no request
  // to submit against. An answer carrying a form there is prose and nothing else.
  const c = ctx({ menu: FORM, inputReviewId: "rev-1" });
  const plan = planFromVerdict(verdict({ "Which key?": "By URL", "Evict how?": ["TTL"] }), c, true);
  assert.equal(plan.send?.channel, "review");
  assert.equal(plan.send?.form, undefined);
});

test("a dry-run form drafts and delivers nothing", () => {
  const c = ctx({ menu: FORM });
  const plan = planFromVerdict(verdict({ "Which key?": "By URL", "Evict how?": ["TTL"] }), c, false);
  assert.equal(plan.send, null);
  assert.equal(plan.note.disposition, "pending");
});
