import assert from "node:assert/strict";
import test from "node:test";
import { asyncInputReceipt, filedPlanReceipt } from "../src/shared/async-input.ts";
import { act, cards, home, pending, post, reviews, registry, say, token } from "./helpers/voice-http.ts";
import { loadReview, MESSAGE_ANSWER_TURN_PREFIX } from "../src/server/db.ts";

const sessionId = "sdk:Will";
for (const kind of ["input", "plan-decisions"] as const) {
  test(`a voice-filed ${kind} releases the call, replays its receipt and can be listed and withdrawn`, async () => {
    const row = reviews.create(sessionId, kind, "Which build?", "Choose a build", null, { snoozable: kind === "input" });
    const call = reviews.wait(row.id, 5000, undefined, true);
    assert.ok(reviews.convertToFiled(row.id));
    const receipt = kind === "input" ? asyncInputReceipt(row) : filedPlanReceipt(row);
    assert.deepEqual((await call)?.converted, { receipt });
    const replay = await reviews.wait(row.id, 500, undefined, true);
    assert.deepEqual(replay?.converted, { receipt });
    assert.equal(loadReview(row.id)?.waitMode, "message");
    assert.equal(registry.getSession(sessionId)?.pendingReviews, kind === "plan-decisions" ? 1 : 0);
    const caller = { env: {}, sessionId, cwd: home };
    const list = await post("/mcp/questions/list", caller, token);
    assert.ok((await list.json()).questions.some((q: { id: string }) => q.id === row.id));
    const withdrawn = await post(`/mcp/questions/${row.id}/withdraw`, { ...caller, reason: "Settled by speech" }, token);
    assert.equal((await withdrawn.json()).status, "withdrawn");
  });
}

test("conversion needs unanimous live poll capability and loses to an answer", async () => {
  const row = reviews.create(sessionId, "input", "Ship?", "Ship?", null, { snoozable: true });
  const abort = new AbortController();
  const capable = reviews.wait(row.id, 1000, abort.signal, true);
  const old = reviews.wait(row.id, 1000);
  assert.equal(reviews.convertToFiled(row.id), false);
  abort.abort();
  assert.equal((await capable)?.converted, undefined);
  assert.equal(reviews.convertToFiled(row.id), false);
  assert.equal(loadReview(row.id)?.filedByVoiceAt, undefined);
  const second = reviews.wait(row.id, 1000, undefined, true);
  reviews.resolve(row.id, "answer", "Yes");
  assert.equal(reviews.convertToFiled(row.id), false);
  for (const result of await Promise.all([old, second])) assert.equal(result?.response, "Yes");
  assert.equal(loadReview(row.id)?.waitMode, undefined);
});

test("an expired capability cannot file a later poll, and a confirmation cannot become a question", async () => {
  const ask = reviews.create(sessionId, "input", "Which branch?", "Choose a branch", null, { snoozable: true });
  const expired = new AbortController();
  const wait = reviews.wait(ask.id, 1000, expired.signal, true);
  expired.abort();
  await wait;
  assert.equal(reviews.convertToFiled(ask.id), false);
  const legacy = reviews.wait(ask.id, 1000);
  assert.equal(reviews.convertToFiled(ask.id), false);
  reviews.resolve(ask.id, "answer", "main");
  assert.equal((await legacy)?.response, "main");

  const confirmation = reviews.create(sessionId, "input", "Publish?", "Confirm", null);
  const call = reviews.wait(confirmation.id, 1000, undefined, true);
  assert.equal(reviews.convertToFiled(confirmation.id), false);
  reviews.resolve(confirmation.id, "dismiss", null);
  assert.equal((await call)?.status, "dismissed");
});

test("answering a voice-converted question queues one filed answer while the call keeps its receipt", async () => {
  const target = "sdk:Bill";
  reviews.startContinuationRecovery((review, text, kind) =>
    pending.submitReviewContinuation(review.id, review.sessionId, text, kind).ok,
  );
  const ask = reviews.create(target, "input", "Which branch?", "Choose the release branch.", null, { snoozable: true });
  const call = reviews.wait(ask.id, 5000, undefined, true);
  await say("Bill, check the build", "file-before-answer");
  await act("file-before-answer", "send-now");
  const released = await call;
  assert.deepEqual(released?.converted, { receipt: asyncInputReceipt(ask) });

  const resolved = await post(`/api/reviews/${ask.id}/resolve`, { action: "answer", response: "Use release-15." });
  assert.equal(resolved.status, 200);
  const turns = registry.getSession(target)!.pendingTurns;
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.spokenWords, "check the build");
  assert.equal(turns[1]!.id, MESSAGE_ANSWER_TURN_PREFIX + ask.id);
  assert.equal(turns[1]!.state, "queued");
  assert.match(turns[1]!.text, /Use release-15\./);
  assert.equal(released?.response, null);
  assert.deepEqual(released.converted, { receipt: asyncInputReceipt(ask) });
});

for (const asyncCapable of [false, true]) {
  test(`a legacy duplicate call response holds speech before its first poll (asyncCapable=${asyncCapable})`, async () => {
    const title = asyncCapable ? "Which release branch?" : "Which release tag?";
    const row = reviews.create(sessionId, "input", title, title, null, { snoozable: true });
    const capable = reviews.wait(row.id, 5000, undefined, true);
    const duplicate = await post("/mcp/reviews", {
      env: {}, sessionId, cwd: home, kind: "input", title, body: title, snoozable: true,
      ...(asyncCapable && { asyncCapable }),
    }, token);
    assert.deepEqual(await duplicate.json(), { id: row.id, sessionId, wait: "call" });

    const utterance = "between-response-and-poll-" + asyncCapable;
    await say("Will, check the build", utterance);
    await act(utterance, "send-now");
    assert.equal(cards.at(-1)?.state, "held");
    assert.equal(loadReview(row.id)?.waitMode, undefined);
    assert.equal(registry.getSession(sessionId)?.pendingTurns.at(-1)?.state, "queued");

    const legacy = reviews.wait(row.id, 5000);
    reviews.resolve(row.id, "answer", "release-15");
    for (const result of await Promise.all([capable, legacy])) {
      assert.equal(result?.converted, undefined);
      assert.equal(result?.response, "release-15");
    }
  });
}
