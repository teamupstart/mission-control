import assert from "node:assert/strict";
import test from "node:test";
import { openQuestionsNote, spokenMessageText } from "../src/shared/voice-delivery.ts";
import { unseenReportsNote } from "../src/shared/reports.ts";

test("spoken payload preserves the words, followed by applicable open questions and unseen reports", () => {
  const words = "check  the build!";
  const openQuestions = openQuestionsNote([{ id: "a", title: "Which build?" }, { id: "b", title: "When?" }]);
  const unseenReports = unseenReportsNote([{ id: "r", title: "Yesterday", readAt: null, supersededBy: null }]);
  assert.equal(spokenMessageText(words, { openQuestions, unseenReports }), [
    words, "Your open questions:\n- a: Which build?\n- b: When?\nWithdraw any question this message settles, with a reason.",
    "Your operator has not read your report r 'Yesterday' yet.",
  ].join("\n\n"));
  assert.equal(spokenMessageText(words, { openQuestions: openQuestionsNote([]), unseenReports: unseenReportsNote([]) }),
    words);
});

test("a report request spoken by the operator is delivered verbatim", () => {
  const words = "When you have finished this, post a report.";
  assert.equal(spokenMessageText(words, { openQuestions: null, unseenReports: null }), words);
});
