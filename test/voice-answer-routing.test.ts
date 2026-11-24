import assert from "node:assert/strict";
import test from "node:test";
import { act, cards, model, queued, registry, say, reviews } from "./helpers/voice-http.ts";
import { optionLetter } from "../src/shared/voice-answers.ts";
import { answers, put, question, show } from "./helpers/voice-question.ts";

test("only an addressed open card, reply, or explicit answer can fill a question", async t => {
  const q = question();
  await say("Steve, check the build", "message");
  assert.deepEqual(answers(), []);
  await act("message", "send-now");
  assert.deepEqual(queued("Steve"), ["check the build"]);
  await show([q.id]);
  for (const text of ["Postgres", "option B", "Will, option B"]) {
    await say(text);
    assert.deepEqual(answers(), []);
  }
  for (const text of ["Steve, answer: Postgres", "reply, second", "Steve, option two", "Steve, go with your recommendation"]) {
    await say(text);
    assert.deepEqual(answers()[0]?.selections?.[0]?.selected, ["postgres"]);
    await say("cancel");
  }
  await show([]);
  await say("Steve, answer: Postgres");
  assert.equal(answers()[0]?.reviewId, q.id);
  await say("cancel");
  await say("Steve, answer: something else");
  assert.deepEqual(answers(), []);
  assert.equal(cards.at(-1)?.reason, "question-notice");
  assert.equal(cards.at(-1)?.deadline, null);
  await show([q.id]);
  const ask = t.mock.method(model, "decide", () => ({ rung: "none", detail: "", answers: [{ choice: "postgres", confidence: 1 }] }));
  await say("reply, the one that already runs");
  assert.equal(ask.mock.calls[0]?.arguments[0]?.[0]?.kind, "option");
  assert.deepEqual(answers()[0]?.selections?.[0]?.selected, ["postgres"]);
});

test("multiple questions require a focus or an explicit pick, bare answer opens the chosen review", async () => {
  const first = question();
  const second = question("Which cache?");
  await show([first.id, second.id], second.id);
  await say("Steve, answer: SQLite");
  assert.equal(answers()[0]?.reviewId, second.id);
  await say("cancel");
  await show([]);
  await say("Steve, answer: Postgres", "pick");
  assert.deepEqual(answers(), []);
  assert.deepEqual(cards.at(-1)?.candidates.map(c => [c.kind, c.id]), [["question", first.id], ["question", second.id]]);
  await say("the second");
  assert.equal(answers()[0]?.reviewId, second.id);
  assert.deepEqual(answers()[0]?.selections?.[0]?.selected, ["postgres"]);
  await say("cancel");
  await say("Steve, option A", "drop-pick");
  await say("cancel");
  assert.equal((await act("drop-pick", "pick", { id: first.id })).status, 409);
  const opened: string[] = [];
  const unsub = registry.subscribe(e => { if (e.type === "voice_open_question") opened.push(e.reviewId); });
  try {
    await say("Steve, answer", "open");
    await act("open", "pick", { id: second.id });
    assert.deepEqual(opened, [second.id]);
    assert.deepEqual(answers(), []);
    reviews.resolve(second.id, "dismiss", null);
    await say("Steve, answer", "one");
    assert.deepEqual(cards.at(-1)?.candidates.map(c => c.id), [first.id]);
    reviews.resolve(first.id, "dismiss", null);
    await say("first one");
    assert.match(cards.at(-1)!.detail!, /already settled/);
    await say("Steve, answer");
    assert.equal(cards.at(-1)?.detail, "Steve has no open questions");
    await say("Steve, option B");
    assert.equal(cards.at(-1)?.detail, "Steve has no open questions");
  } finally { unsub(); }
});

test("answer and companion share a cancel slot, correction keeps its place even under another agent's message", async () => {
  const q = question();
  await say("Steve, option B", "answer");
  assert.equal(registry.voiceRouter!.pendingVoiceActions.length, 1);
  await say("Will, check it", "newer");
  await say("no, A");
  assert.equal(answers()[0]?.text, "SQLite");
  await say("cancel");
  assert.equal(cards.at(-1)?.id, "newer");
  await say("cancel");
  assert.deepEqual(answers(), []);
  assert.equal((await act("answer", "send-now")).status, 409);
  await say("Will, keep this", "older");
  await say("Steve, option A");
  await say("cancel");
  await act("older", "send-now");
  assert.deepEqual(queued("Will"), ["keep this"]);
  assert.equal(registry.getReview(q.id)?.status, "pending");
  await say("Steve, option B", "keep-answer");
  await say("Will, drop this");
  await say("cancel");
  await act("keep-answer", "send-now");
  assert.equal(registry.getReview(q.id)?.status, "answered");
});

test("speech captured before the card opened and ordinary instructions about answering stay messages", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const q = question();
  await say("Steve, answer the email");
  assert.deepEqual(answers(), []);
  t.mock.timers.tick(100);
  await show([q.id]);
  await registry.voiceRouter!.accept({ text: "Steve, use Postgres", capturedAt: now, backend: "fluidaudio", id: "delayed", words: [] });
  assert.deepEqual(answers(), []);
  assert.equal(cards.at(-1)?.parts[0]?.text, "use Postgres");
});

test("a closed free-text question accepts an explicit answer through its countdown companion", async () => {
  const q = reviews.create("sdk:Steve", "input", "Which database?", "Which database?");
  await say("Steve, answer: Postgres", "closed-text");
  assert.equal(answers()[0]?.reviewId, q.id);
  assert.equal(answers()[0]?.text, "Postgres");
  assert.equal(cards.at(-1)?.reason, "voice-answer");
  assert.equal(registry.getReview(q.id)?.status, "pending");
  assert.equal((await act("closed-text", "send-now")).status, 200);
  assert.equal(registry.getReview(q.id)?.response, "Postgres");
  assert.deepEqual(queued("Steve"), []);
});

test("explicit answers without an eligible question show a notice and cannot send a message", async () => {
  question("Will's question", "sdk:Will");
  for (const phrase of ["answer: Postgres", "option B", "go with your recommendation"]) {
    await say("Steve, " + phrase, "no-question-" + phrase.length);
    assert.equal(cards.at(-1)?.reason, "question-notice");
    assert.equal(cards.at(-1)?.detail, "Steve has no open questions");
    assert.equal((await act(cards.at(-1)!.id, "send-now")).status, 409);
  }
  assert.deepEqual(answers(), []);
  assert.deepEqual(queued("Steve"), []);
});

test("a missing option on a closed question cannot send a message at the deadline", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const q = reviews.create("sdk:Steve", "input", "Which cache?", "Which cache?", [
    { id: "q", question: "Which cache?", options: [{ id: "sqlite", label: "SQLite" }] },
  ]);
  await say("Steve, option B", "missing-option");
  t.mock.timers.tick(1001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(queued("Steve"), []);
  assert.equal(registry.getReview(q.id)?.status, "pending");
  assert.deepEqual(answers(), []);
  assert.equal(cards.at(-1)?.detail, "No matching option.");
  assert.equal((await act("missing-option", "send-now")).status, 409);
});

for (const [command, phrases] of [
  ["option B", ["Steve, option B", "reply, option B", "reply, second"]],
  ["go with your recommendation", ["Steve, go with your recommendation", "reply, go with your recommendation"]],
] as const) {
  test(`an unavailable “${command}” cannot submit Other on an open question`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const q = reviews.create("sdk:Steve", "input", "Which cache?", "Which cache?", [
      { id: "q", question: "Which cache?", allowOther: true, options: [{ id: "sqlite", label: "SQLite" }] },
    ]);
    await show([q.id]);
    const matcher = t.mock.method(model, "decide");
    for (const phrase of phrases) {
      await say(phrase);
      assert.deepEqual(answers(), [], phrase);
      assert.equal(cards.at(-1)?.detail, "No matching option.");
      assert.equal(cards.at(-1)?.deadline, null);
    }
    assert.equal(matcher.mock.callCount(), 0);
    t.mock.timers.tick(1001);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(registry.getReview(q.id)?.status, "pending");
    assert.deepEqual(queued("Steve"), []);

    await say("reply, wait for benchmarks");
    assert.deepEqual(answers()[0]?.selections, [{ decisionId: "q", selected: [], other: "wait for benchmarks" }]);
  });
}

test("a choice command picked for a free-text question cannot become dictation", async () => {
  const free = reviews.create("sdk:Steve", "input", "What next?", "What next?");
  await say("Steve, option B");
  assert.equal(cards.at(-1)?.detail, "No matching option.");
  question();
  await say("Steve, go with your recommendation", "pick-free");
  await act("pick-free", "pick", { id: free.id });
  assert.equal(cards.at(-1)?.detail, "No matching option.");
  assert.deepEqual(answers(), []);
  await show([free.id]);
  await say("Steve, answer: option B");
  assert.equal(answers()[0]?.text, "option B");
});

test("option letters continue from Z to AA and AB", () => {
  assert.deepEqual([25, 26, 27].map(optionLetter), ["Z", "AA", "AB"]);
});

test("a blurred dashboard loses the reply target and its background reports cannot reclaim it", async t => {
  const first = question("Which database?");
  const second = question("Which cache?");
  const windows = registry.voiceRouter!.openCards;
  t.after(windows.connect("first"));
  t.after(windows.connect("second"));
  async function report(windowId: string, id: string, focused: boolean) {
    const response = await put("/api/voice/open-cards", { windowId, focused, cards: [{ kind: "question", id, focused: true }] });
    assert.equal(response.status, 200);
  }

  await report("first", first.id, true);
  await say("reply, option A");
  assert.deepEqual(answers().map(a => a.reviewId), [first.id]);
  await say("cancel");

  await report("first", first.id, false);
  await say("reply, option B");
  assert.deepEqual(answers(), []);
  assert.equal(registry.getReview(first.id)?.status, "pending");

  await report("second", second.id, true);
  await report("first", first.id, false);
  await say("reply, option B", "focused-reply");
  assert.deepEqual(answers().map(a => a.reviewId), [second.id]);
  assert.equal((await act("focused-reply", "send-now")).status, 200);
  assert.equal(registry.getReview(second.id)?.status, "answered");
  assert.equal(registry.getReview(first.id)?.status, "pending");
});

test("ordinary addressed speech bypasses answer matching and delivers a message while the question stays open", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const q = question();
  await show([q.id]);
  const matcher = t.mock.method(model, "decide");
  await say("Steve, check the build", "ordinary-message");
  assert.equal(matcher.mock.callCount(), 0);
  assert.deepEqual(answers(), []);
  t.mock.timers.tick(1001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(queued("Steve"), ["check the build"]);
  assert.equal(registry.getReview(q.id)?.status, "pending");
});
