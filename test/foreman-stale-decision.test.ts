import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planFromVerdict, planLeavesAMark, VerdictSchema } from "../src/server/foreman/verdict.ts";
import { noteAwaitsYou } from "../src/shared/foreman.ts";
import type { ReviewContext } from "../src/server/foreman/verdict.ts";

// What is at stake: Foreman pinning a decision on a human minutes after the question it
// answers has closed.
//
// A review blocks on a fresh `claude -p` for up to four minutes. `pendingStillLive` exists to
// re-read the world before acting on a plan that old - but it was only ever consulted for a
// SEND, on the reasoning that "reads are cheap, so we only guard the send path". That treats a
// note as free to write. It is not: an escalation or a draft pins "needs your decision" in the
// dashboard until someone clicks it away. Measured on the reported session, seven such notes
// were written and none was ever resolved; the one the operator screenshotted sat on a session
// that was working, with no prompt in its terminal, offering an Approve that would have typed
// a paragraph into a running agent.
//
// `planLeavesAMark` is that rule, and it is the thing that must not quietly narrow back to
// sends - hence the source assertion at the bottom, which is the only thing standing between
// this fix and a one-token regression.

const CTX: ReviewContext = {
  sessionId: "s1",
  promptMarker: "dialog:abc123",
  inputReviewId: null,
  canSend: true,
  menu: null,
};

function verdict(over: Record<string, unknown> = {}) {
  return VerdictSchema.parse({
    purpose: "The child is asking which linter to set up.",
    classification: "implementation",
    action: "answer",
    answer: { text: "Use biome." },
    ...over,
  });
}

test("a live send is guarded, as it always was", () => {
  const plan = planFromVerdict(verdict(), CTX, true);
  assert.ok(plan.send, "precondition: this verdict sends");
  assert.equal(planLeavesAMark(plan), true);
});

test("an escalation is guarded - it spends a human's attention", () => {
  const plan = planFromVerdict(
    verdict({ action: "escalate", recommendation: "Use biome.", answer: undefined }),
    CTX,
    true,
  );
  assert.equal(plan.note.disposition, "escalated");
  assert.equal(plan.send, null, "nothing is delivered, which is exactly why this was unguarded");
  assert.equal(planLeavesAMark(plan), true);
});

test("an escalation with NO reply channel is guarded too", () => {
  // The shape from the report: Foreman wrote an answer and had nowhere to put it. It sends
  // nothing, so the old `if (plan.send)` skipped the re-check entirely - and this is the
  // disposition most likely to be stale, because it is raised on the asks that take longest
  // to classify.
  const plan = planFromVerdict(verdict(), { ...CTX, canSend: false }, true);
  assert.equal(plan.note.lastAction, "escalated (no reply channel)");
  assert.equal(planLeavesAMark(plan), true);
});

test("a dry-run draft is guarded - it pins an Approve button", () => {
  const plan = planFromVerdict(verdict(), CTX, false);
  assert.equal(plan.note.disposition, "pending");
  assert.equal(plan.send, null);
  assert.equal(planLeavesAMark(plan), true);
});

test("a skip is NOT guarded, so the cheap case stays cheap", () => {
  // The reason this is a predicate rather than an unconditional re-read: a skipped note pins
  // nothing in any surface, the episode log records it either way, and a session Foreman has
  // nothing to say about must not cost two extra HTTP reads on every sweep.
  const plan = planFromVerdict(verdict({ action: "skip", answer: undefined }), CTX, true);
  assert.equal(plan.note.disposition, "skipped");
  assert.equal(planLeavesAMark(plan), false);
});

test("the guarded set is exactly the pinned set", () => {
  // The two halves of the fix agree by construction, not by coincidence: the dispositions the
  // server re-confirms before writing are the dispositions the dashboard pins. A disposition
  // in one set and not the other is a decision nobody decided to ask for, or one the human is
  // shown and the server never checked.
  for (const disposition of ["answered", "pending", "escalated", "skipped"] as const) {
    assert.equal(
      planLeavesAMark({ note: { disposition }, send: null }),
      noteAwaitsYou(disposition),
      `${disposition} must be guarded exactly when it is pinned`,
    );
  }
});

test("a note with no disposition at all is treated as a skip, not as a pin", () => {
  // `SetNote.disposition` is optional. Reading absent as "pins something" would buy two HTTP
  // reads on every purpose-only patch; reading it as a skip matches what `upsertNote` does
  // with it, which is to leave whatever was already there.
  assert.equal(planLeavesAMark({ note: {}, send: null }), false);
});

test("the worker still routes every marking plan through the freshness re-check", () => {
  // A source assertion, in the spirit of `harness-hooks.test.ts` and `agent-accent.test.ts`:
  // the regression this fix reverses is one token wide. Narrowing the guard back to
  // `if (plan.send)` compiles, typechecks, passes every other test in this file, and silently
  // restores stale escalations - because the predicate above would simply stop being called.
  const src = readFileSync(new URL("../src/server/foreman/worker.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /if \(planLeavesAMark\(plan\)\) \{\n\s+if \(!\(await pendingStillLive\(/,
    "the re-check must be gated on planLeavesAMark, not on plan.send",
  );
});
