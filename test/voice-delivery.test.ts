import assert from "node:assert/strict";
import test from "node:test";
import { openQuestionsNote, spokenMessageText } from "../src/shared/voice-delivery.ts";
import { POST_REPORT_LINE, unseenReportsNote } from "../src/shared/reports.ts";

test("spoken payload preserves the words, then open questions, unseen reports and the report instruction", () => {
  const words = "check  the build!";
  const openQuestions = openQuestionsNote([{ id: "a", title: "Which build?" }, { id: "b", title: "When?" }]);
  const unseenReports = unseenReportsNote([{ id: "r", title: "Yesterday", readAt: null, supersededBy: null }]);
  assert.equal(spokenMessageText(words, { openQuestions, unseenReports }), [
    words, "Your open questions:\n- a: Which build?\n- b: When?\nWithdraw any question this message settles, with a reason.",
    "Your operator has not read your report r 'Yesterday' yet.", POST_REPORT_LINE,
  ].join("\n\n"));
  assert.equal(spokenMessageText(words, { openQuestions: openQuestionsNote([]), unseenReports: unseenReportsNote([]) }),
    words + "\n\n" + POST_REPORT_LINE);
});
