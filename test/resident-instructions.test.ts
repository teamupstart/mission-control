import assert from "node:assert/strict";
import test from "node:test";
import {
  ProposeResidentInstructionChangesSchema,
  RESIDENT_INSTRUCTION_DECISION_ID,
  applyResidentInstructionChanges,
  locateResidentInstructionChanges,
  residentInstructionOutcomeText,
  residentInstructionQuestion,
} from "../src/shared/resident-instructions.ts";
import { REQUEST_INPUT_DECISION_ID, requestInputReview } from "../src/shared/request-input.ts";

// The pure half of a resident editing its own standing instructions: which proposals are
// well-formed, how a selected subset applies, and what the operator is shown.

const TEXT = "Check the backlog every hour.\nNever merge on Fridays.\nReport in one line.";

const change = (over: { find?: string; replace: string; title?: string }) => ({
  index: 0,
  title: over.title ?? "change",
  ...over,
});

test("a passage that occurs once locates; a missing or repeated one is refused with the reason", () => {
  const located = locateResidentInstructionChanges(TEXT, [change({ find: "every hour", replace: "every 30 minutes" })]);
  assert.ok(located.ok);
  assert.deepEqual(located.located[0]?.range, { start: TEXT.indexOf("every hour"), end: TEXT.indexOf("every hour") + "every hour".length });

  const missing = locateResidentInstructionChanges(TEXT, [change({ find: "every day", replace: "x" })]);
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.problem : "", /does not occur/);

  const repeated = locateResidentInstructionChanges("a. a.", [change({ find: "a.", replace: "b." })]);
  assert.equal(repeated.ok, false);
  assert.match(!repeated.ok ? repeated.problem : "", /more than once/);
});

test("two changes that edit overlapping passages are refused, so any subset still applies", () => {
  const overlapping = locateResidentInstructionChanges(TEXT, [
    { index: 0, title: "a", find: "backlog every hour", replace: "queue every hour" },
    { index: 1, title: "b", find: "every hour.\nNever", replace: "hourly.\nNever" },
  ]);
  assert.equal(overlapping.ok, false);
  assert.match(!overlapping.ok ? overlapping.problem : "", /changes 1 and 2 edit overlapping passages/);
});

test("any selected subset applies against the original text: replace, remove, then appends in order", () => {
  const changes = [
    { index: 0, title: "cadence", find: "every hour", replace: "every 30 minutes" },
    { index: 1, title: "fridays", find: "Never merge on Fridays.\n", replace: "" },
    { index: 2, title: "append one", replace: "Escalate blocked work to the operator." },
    { index: 3, title: "append two", replace: "  Keep a ledger in RESIDENT_STATE_DIR.  " },
  ];
  const located = locateResidentInstructionChanges(TEXT, changes);
  assert.ok(located.ok);
  const all = applyResidentInstructionChanges(TEXT, located.located);
  assert.equal(all, [
    "Check the backlog every 30 minutes.",
    "Report in one line.",
    "",
    "Escalate blocked work to the operator.",
    "",
    "Keep a ledger in RESIDENT_STATE_DIR.",
  ].join("\n"));

  // Only the second and fourth: the earlier range is still where it was found.
  const subset = applyResidentInstructionChanges(TEXT, located.located.filter((entry) => entry.index === 1 || entry.index === 3));
  assert.equal(subset, "Check the backlog every hour.\nReport in one line.\n\nKeep a ledger in RESIDENT_STATE_DIR.");
  // An append onto empty instructions is the text itself.
  assert.equal(applyResidentInstructionChanges("", [{ index: 0, range: null, replace: "Be brief." }]), "Be brief.");
});

test("the schema refuses an empty append, a no-op replace and more than eight changes, and accepts eight", () => {
  const base = { target: "profile", title: "t" };
  assert.equal(ProposeResidentInstructionChangesSchema.safeParse({ changes: [{ ...base, replace: "  " }] }).success, false);
  assert.equal(ProposeResidentInstructionChangesSchema.safeParse({ changes: [{ ...base, find: "x", replace: "x" }] }).success, false);
  // Eight is the limit, inclusive: eight valid changes are accepted, nine are refused.
  assert.equal(ProposeResidentInstructionChangesSchema.safeParse({ changes: Array.from({ length: 8 }, () => ({ ...base, replace: "y" })) }).success, true);
  assert.equal(ProposeResidentInstructionChangesSchema.safeParse({ changes: Array.from({ length: 9 }, () => ({ ...base, replace: "y" })) }).success, false);
  assert.equal(ProposeResidentInstructionChangesSchema.safeParse({ changes: [{ ...base, find: "x", replace: "" }] }).success, true);
  assert.equal(ProposeResidentInstructionChangesSchema.safeParse({ changes: [{ ...base, target: "run", replace: "y" }] }).success, false);
});

test("the proposal is a request_input question that shows every passage in full, as written", () => {
  const ask = residentInstructionQuestion({
    profileName: "Queue watcher",
    profileRevision: 4,
    personaName: "Watcher",
    summary: "From today's steering.",
    changes: [
      { target: "profile", title: "Cadence", rationale: "You asked for half-hourly checks.", find: "every hour", replace: "every 30 minutes" },
      { target: "persona", title: "Code spans", rationale: "", replace: "Quote commands as ```sh blocks.\nNever paraphrase them." },
      { target: "profile", title: "Drop Fridays", rationale: "", find: "Never merge on Fridays.", replace: "" },
    ],
  });
  assert.equal(ask.question, [
    "Which of these changes to Queue watcher's standing instructions should Mission Control apply?",
    "",
    "From today's steering.",
    "",
    "Mission Control writes only the changes you select: profile changes become the next revision of Queue watcher (now revision 4), and Persona changes become the next revision of Watcher, which every profile and task that uses it picks up at its next launch. A running resident keeps its current instructions until you choose Restart on new profile.",
    "",
    "1. Cadence",
    "Where: Profile instructions",
    "Why: You asked for half-hourly checks.",
    "Replace:",
    "    every hour",
    "With:",
    "    every 30 minutes",
    "",
    "2. Code spans",
    "Where: Persona guidance (Watcher)",
    "Append:",
    "    Quote commands as ```sh blocks.",
    "    Never paraphrase them.",
    "",
    "3. Drop Fridays",
    "Where: Profile instructions",
    "Remove:",
    "    Never merge on Fridays.",
  ].join("\n"));
  assert.deepEqual(ask.options, [
    { label: "1. Cadence", detail: "Profile instructions" },
    { label: "2. Code spans", detail: "Persona guidance (Watcher)" },
    { label: "3. Drop Fridays", detail: "Profile instructions" },
  ]);
  assert.equal(ask.multiSelect, true);
  assert.equal(ask.allowOther, true);
});

test("the question becomes exactly the review the request_input tool would open for it", () => {
  const ask = residentInstructionQuestion({
    profileName: "Queue watcher",
    profileRevision: 1,
    personaName: null,
    summary: "",
    changes: [{ target: "profile", title: "Cadence", rationale: "", find: "a", replace: "b" }],
  });
  const review = requestInputReview(ask);
  assert.equal(review.kind, "input");
  assert.equal(review.body, ask.question);
  assert.equal(review.title, "Which of these changes to Queue watcher's standing…");
  assert.equal(RESIDENT_INSTRUCTION_DECISION_ID, REQUEST_INPUT_DECISION_ID);
  assert.deepEqual(review.decisions, [{
    id: REQUEST_INPUT_DECISION_ID,
    question: ask.question,
    options: [{ label: "1. Cadence", detail: "Profile instructions", id: "o0" }],
    multiSelect: true,
    allowOther: true,
  }]);
});

test("the tool's answer names what landed, what did not and what the operator wrote", () => {
  const text = residentInstructionOutcomeText({
    reviewId: "r",
    status: "applied",
    message: "Applied 1 change.",
    applied: [{ index: 0, title: "Cadence", target: "profile" }],
    skipped: [{ index: 1, title: "Tone", target: "persona" }],
    profileRevision: 5,
    personaRevision: null,
    feedback: "Keep the Persona as it is.",
  });
  assert.equal(text, [
    "outcome=applied",
    "Applied 1 change.",
    "Applied: 1. Cadence",
    "Not applied: 2. Tone",
    "The operator also wrote: Keep the Persona as it is.",
  ].join("\n"));
});

test("the shared request_input builder files the question then its context, exactly as the tool always has", () => {
  const withContext = requestInputReview({
    question: "Ship the nightly migration?",
    context: "  Staging was clean; production is three times larger.  ",
    options: [{ label: "Ship it", detail: "Done tonight, larger blast radius" }, { label: "Hold it" }],
  });
  assert.equal(withContext.title, "Ship the nightly migration?");
  assert.equal(withContext.body, "Ship the nightly migration?\n\nStaging was clean; production is three times larger.");
  assert.equal(withContext.decisions?.[0]?.question, "Ship the nightly migration?");
  // Without context the body is the question alone, the shape a resident's proposal is filed with.
  assert.equal(requestInputReview({ question: "Ship it?" }).body, "Ship it?");
  assert.equal(requestInputReview({ question: "Ship it?", context: "   " }).body, "Ship it?");
});
