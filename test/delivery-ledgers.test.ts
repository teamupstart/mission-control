import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTranscript } from "./helpers/fake-transcript.ts";

// The delivery ledgers share one claim space only if every ledger is registered before any of
// them binds. This file deliberately imports the delegated-turn module alone - never
// `review-deliveries.ts` - and still finds a review delivery's turn claimed.

const home = mkdtempSync(join(tmpdir(), "mission-delivery-ledgers-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { insertReviewDelivery } = await import("../src/server/db.ts");
const { delegatedTurnSources, reserveDelegatedTurn } = await import("../src/server/delegated-turns.ts");
const { forgetDeliveryBindingState } = await import("../src/server/delivery-binding.ts");

test("a delegated-turn caller that never imported review-deliveries still sees review rows in the claim space", () => {
  const t = fakeTranscript(); const k = "conversation"; const now = Date.now();
  const text = "[mission-control:answer review=1b0c9f4e-2a8d-4a43-9d3e-0f6c2b7e5a10]\n\nUse eslint";
  // A controller delegates these words first, so its walk starts before both turns below.
  reserveDelegatedTurn(t.conversation(k), text, { id: "sdk:controller", name: "Controller" }, now);
  // A review delivery of the same words lands first and the daemon has it bound to that turn.
  const turn = t.append("review-turn", text, now + 1);
  insertReviewDelivery({
    id: "review-row", noteKey: k, fingerprint: "unused-by-this-check", envelope: "answer",
    reviewIds: ["1b0c9f4e-2a8d-4a43-9d3e-0f6c2b7e5a10"], deliveredAt: now, transcriptOffset: 0, contested: false,
    confirmedAt: now, messageId: turn.id, messageTs: turn.ts, echoOwed: false, echoTurnGeneration: 1,
    echoEligibleAt: null, steerEcho: null,
  });
  // The daemon restarts: every ledger's cache is rebuilt from its table.
  forgetDeliveryBindingState();
  // Then the controller's own turn.
  const delegatedTurn = t.append("delegated-turn", text, now + 3);
  const { sources } = delegatedTurnSources(t.conversation(k), [turn, delegatedTurn]);
  assert.equal(sources.has("review-turn"), false, "the review's turn is never taken for the delegated one");
  assert.equal(sources.get("delegated-turn")?.id, "sdk:controller");
});
