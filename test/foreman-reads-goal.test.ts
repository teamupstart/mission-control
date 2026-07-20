import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt } from "../src/server/foreman/prompt.ts";
import { buildTriagePrompt } from "../src/server/foreman/triage-prompt.ts";
import type { ReviewInput } from "../src/server/foreman/prompt.ts";

// Foreman used to derive "what this session is for" itself, in every reply, at the one moment
// it ever looks at a session: when that session is STUCK. That is the whole reason its Purpose
// was never a status line - it was written once, at a bad moment, and never refreshed.
//
// Now the daemon owns that sentence and refreshes it on every prompt, so Foreman is HANDED it
// and `purpose` shrinks to the decision context it always actually was. These pin both halves.

function mkInput(over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    session: {
      name: "goal-feature",
      cwd: "/wt/goal",
      gitBranch: "harness/goal",
      state: "awaiting_input",
      activity: "Claude needs your permission",
      goal: "Fix the flaky worktree cleanup on Reset",
    },
    surface: "terminal",
    question: "Can I run `rm -rf node_modules` and reinstall?",
    transcript: [{ id: "1", role: "user", text: "the tests are flaky", tools: [], ts: 1 }],
    truncated: false,
    // No standing instructions - these cases are about the goal.
    instructions: "",
    ...over,
  };
}

test("the reviewer is handed the session's goal", () => {
  const p = buildReviewPrompt(mkInput());
  assert.match(p, /goal \(what this session is trying to solve\): Fix the flaky worktree cleanup on Reset/);
});

test("the router is handed the session's goal", () => {
  const p = buildTriagePrompt(mkInput());
  assert.match(p, /goal \(what this session is trying to solve\): Fix the flaky worktree cleanup on Reset/);
});

test("neither prompt asks the model to restate what the session is for", () => {
  // The old instruction - "1-2 sentences on what this session is for + the key recent context"
  // - is what made Purpose a second, staler copy of the Goal, on a card that now shows both.
  for (const p of [buildReviewPrompt(mkInput()), buildTriagePrompt(mkInput())]) {
    assert.doesNotMatch(p, /sentences on what this session is for/);
    assert.match(p, /do NOT restate it/);
  }
});

test("a session with no goal yet says so rather than leaving a blank field", () => {
  // A blank after "goal:" reads as "the goal is nothing"; the reviewer should know the
  // difference between an unknown goal and an empty one - it still has the transcript.
  const p = buildReviewPrompt(mkInput({ session: { ...mkInput().session, goal: null } }));
  assert.match(p, /goal \(what this session is trying to solve\): \(not known yet\)/);
});
