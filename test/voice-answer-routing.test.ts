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
  await act("keep-answer", "send-now?source=card");
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
  assert.equal((await act("closed-text", "send-now?source=card")).status, 200);
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
  for (const argument of ["zero", "0", "B"]) {
    await say("Steve, option " + argument, "missing-" + argument);
    assert.equal(cards.at(-1)?.detail, "No matching option.");
    assert.equal((await act("missing-" + argument, "send-now")).status, 409);
  }
  t.mock.timers.tick(1001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(queued("Steve"), []);
  assert.equal(registry.getReview(q.id)?.status, "pending");
  assert.deepEqual(answers(), []);
  assert.equal(cards.at(-1)?.detail, "No matching option.");
});

for (const [command, phrases] of [
  ["option B", ["Steve, option B", "Steve, option zero", "Steve, option 0", "reply, option B", "reply, second"]],
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

test("two recommended options leave an open question pending without starting a countdown", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const title = "Which database?";
  const q = reviews.create("sdk:Steve", "input", title, title, [{
    id: "q", question: title, allowOther: true, options: [
      { id: "sqlite", label: "SQLite", recommended: true },
      { id: "postgres", label: "Postgres", recommended: true },
    ],
  }]);
  await show([q.id]);
  await say("Steve, go with your recommendation");
  assert.deepEqual(answers(), []);
  assert.equal(cards.at(-1)?.detail, "No matching option.");
  assert.equal(cards.at(-1)?.deadline, null);

  t.mock.timers.tick(1001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(registry.getReview(q.id)?.status, "pending");
});

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
  assert.equal((await act("focused-reply", "send-now?windowId=second")).status, 200);
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

test("a closed question picker applies the chosen question's dictation rule", async () => {
  const choices = question();
  const free = reviews.create("sdk:Steve", "input", "What next?", "What next?");
  for (const [index, review] of [choices, free].entries()) {
    const id = "pick-text-" + index;
    await say("Steve, answer: something else", id);
    assert.equal((await act(id, "pick", { id: review.id })).status, 200);
    if (review === choices) {
      assert.equal(cards.at(-1)?.detail, "No matching option.");
      assert.deepEqual(answers(), []);
      assert.equal((await act(id, "send-now")).status, 409);
      assert.equal(registry.getReview(choices.id)?.status, "pending");
    } else {
      assert.equal(answers()[0]?.reviewId, free.id);
      assert.equal((await act(id, "send-now?source=card")).status, 200);
      assert.equal(registry.getReview(free.id)?.response, "something else");
    }
  }
});

test("the inline footer takes over the same countdown and retires stale companion submits", async () => {
  const q = question();
  const router = registry.voiceRouter!;
  await say("Steve, option A", "companion");
  const [answer] = answers();
  const visible = () => router.activeCards().some(card => card.id === "companion");
  assert.equal(visible(), true);
  for (const ids of [[q.id], [], [q.id]]) {
    await show(ids);
    assert.equal(visible(), !ids.length);
    assert.deepEqual(answers(), [{ ...answer, footerWindowId: ids.length ? "voice-question-test" : undefined }]);
    assert.equal(router.pendingVoiceActions.length, 1);
  }
  // The newer focused dashboard needs the companion even if the first one has not reported blur yet.
  router.openCards.connect("other-dashboard");
  await put("/api/voice/open-cards", { windowId: "other-dashboard", focused: true, cards: [] });
  assert.equal(visible(), true);
  await show([q.id]);
  assert.equal(visible(), false);
  assert.equal((await act("companion", "send-now?source=card")).status, 409);
  assert.equal(registry.getReview(q.id)?.status, "pending");
  assert.equal((await act("companion", "cancel")).status, 200);
  assert.deepEqual(answers(), []);
  await show([q.id]);
  await say("Steve, option A", "settled");
  reviews.resolve(q.id, "dismiss", null);
  await show([]);
  assert.equal(router.activeCards().some(card => card.id === "settled"), false);
});

test("a background or disconnected question keeps its countdown on the companion", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const q = question();
  const router = registry.voiceRouter!;
  const windowId = "question-dashboard";
  const disconnect = router.openCards.connect(windowId);
  const report = (focused: boolean) => put("/api/voice/open-cards", { windowId, focused,
    cards: [{ kind: "question", id: q.id, focused: true }] });
  assert.equal((await report(false)).status, 200);
  await say("Steve, answer: Postgres", "background-answer");
  const [answer] = answers();
  assert.equal(answer?.reviewId, q.id);
  const companion = () => router.activeCards().find(card => card.id === answer.id);
  assert.equal(companion()?.deadline, answer.deadline);

  t.mock.timers.tick(200);
  assert.equal((await report(true)).status, 200);
  assert.equal(companion(), undefined);
  disconnect();
  assert.equal(companion()?.deadline, answer.deadline);
  t.after(router.openCards.connect(windowId));
  assert.equal(companion(), undefined);
  assert.equal((await report(false)).status, 200);
  assert.equal(companion()?.deadline, answer.deadline);
  assert.deepEqual(answers(), [answer]);
  assert.equal(router.pendingVoiceActions.length, 1);
  assert.equal((await act(answer.id, "cancel")).status, 200);
  t.mock.timers.tick(1001);
  assert.equal(registry.getReview(q.id)?.status, "pending");
  assert.deepEqual(answers(), []);
});

test("delayed focus and blur reports cannot steal or clear the newer dashboard's reply target", async t => {
  const first = question();
  const second = question("Which cache?");
  const windows = registry.voiceRouter!.openCards;
  t.after(windows.connect("first"));
  t.after(windows.connect("second"));
  const report = async (windowId: string, id: string, focused: boolean, stamp: number) => {
    assert.equal((await put("/api/voice/open-cards", { windowId, focused, cards: [{ kind: "question", id, focused: true }] },
      { "x-voice-focus-at-us": String(stamp) })).status, 200);
  };
  await report("second", second.id, true, 30);
  await report("first", first.id, true, 10);
  await say("reply, option B");
  assert.deepEqual(answers().map(a => a.reviewId), [second.id]);
  await say("cancel");
  await report("first", first.id, false, 20);
  await say("reply, option B");
  assert.deepEqual(answers().map(a => a.reviewId), [second.id]);
  await say("cancel");
  await report("first", first.id, true, 40);
  await report("first", first.id, false, 20);
  await say("reply, option A");
  assert.deepEqual(answers().map(a => a.reviewId), [first.id]);
  await say("cancel");
  await report("second", second.id, true, 40);
  await say("reply, option B");
  assert.deepEqual(answers(), []);
  await report("first", first.id, false, 41);
  await say("reply, option B");
  assert.deepEqual(answers().map(a => a.reviewId), [second.id]);
});

test("an option mentioned in a sentence is a message, while an unavailable selector is a command", async () => {
  const q = question();
  for (const open of [false, true]) {
    await show(open ? [q.id] : []);
    const id = "sentence-" + open;
    await say("Steve, option B looks risky", id);
    assert.deepEqual(answers(), []);
    assert.equal((await act(id, "send-now")).status, 200);
    await say("Steve, option pricing", "pricing-" + open);
    assert.equal((await act("pricing-" + open, "send-now")).status, 200);
    await say("Steve, option 99");
    assert.equal(cards.at(-1)?.detail, "No matching option.");
    assert.deepEqual(answers(), []);
  }
  assert.deepEqual(queued("Steve"), ["option B looks risky", "option pricing", "option B looks risky", "option pricing"]);
  assert.equal(registry.getReview(q.id)?.status, "pending");
});

test("bare numeric answers prefer an exact label and explicit option numbers are positional", async () => {
  const q = reviews.create("sdk:Steve", "input", "How many?", "How many?", [
    { id: "count", question: "How many?", options: [{ id: "two", label: "2" }, { id: "four", label: "4" }] },
  ]);
  await say("Steve, answer: 2");
  assert.deepEqual(answers()[0]?.selections?.[0]?.selected, ["two"]);
  await say("cancel");
  await say("Steve, option 2", "position");
  assert.deepEqual(answers()[0]?.selections?.[0]?.selected, ["four"]);
  assert.equal((await act("position", "send-now?source=card")).status, 200);
  assert.deepEqual(registry.getReview(q.id)?.selections?.[0]?.selected, ["four"]);
});

test("multi-letter option commands use the displayed letters and never become messages or Other", async () => {
  const title = "Which choice?";
  const q = reviews.create("sdk:Steve", "input", title, title, [{ id: "q", question: title, allowOther: true,
    options: Array.from({ length: 53 }, (_, i) => ({ id: String(i + 1), label: "Choice " + (i + 1) })) }]);
  for (const label of ["BA", "ba", "b a"]) {
    await say("Steve, option " + label);
    assert.deepEqual(answers()[0]?.selections?.[0]?.selected, ["53"]);
    await say("cancel");
  }
  for (const open of [false, true]) {
    await show(open ? [q.id] : []);
    for (const label of ["BB", "ZZ", "AAA"]) {
      await say("Steve, option " + label);
      assert.equal(cards.at(-1)?.detail, "No matching option.", label);
      assert.deepEqual(answers(), []);
      assert.equal(registry.voiceRouter!.pendingVoiceActions.length, 0);
    }
  }
  assert.deepEqual(queued("Steve"), []);
  assert.equal(registry.getReview(q.id)?.status, "pending");
});

test("opening a question after speaking cannot authorize Other when the operator chooses it in the picker", async t => {
  const now = Date.now();
  const connected = performance.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(performance, "now", () => connected + (Date.now() - now));
  const q = question();
  const second = question("Which cache?");
  await say("Steve, answer: a different database", "closed-picker");
  assert.deepEqual(cards.at(-1)?.candidates.map(c => c.id), [q.id, second.id]);
  t.mock.timers.tick(100);
  await show([q.id]);
  t.mock.timers.tick(100);
  assert.equal((await act("closed-picker", "pick", { id: q.id })).status, 200);
  await registry.voiceRouter!.resolution("closed-picker");
  assert.equal(cards.at(-1)?.detail, "No matching option.");
  assert.deepEqual(answers(), []);
  assert.equal(registry.voiceRouter!.pendingVoiceActions.length, 0);
  assert.equal(registry.getReview(q.id)?.status, "pending");
});

test("a matcher failure leaves Other untouched and the question available to retry", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const q = question();
  await show([q.id]);
  const matcher = t.mock.method(model, "decide", () => { throw new Error("provider failed"); });
  for (const attempt of ["exception", "exhausted ladder"]) {
    if (attempt === "exhausted ladder") matcher.mock.mockImplementation(() =>
      ({ rung: "none" as const, answers: [{ choice: null, confidence: 0 }], detail: "job on claude timed out", failed: true }));
    await say("reply, the one that already runs");
    assert.match(cards.at(-1)?.detail ?? "", /try again/i);
    assert.deepEqual(answers(), []);
    assert.equal(registry.voiceRouter!.pendingVoiceActions.length, 0);
    t.mock.timers.tick(1001);
    assert.equal(registry.getReview(q.id)?.status, "pending");
  }
  await say("reply, Postgres");
  assert.deepEqual(answers()[0]?.selections?.[0]?.selected, ["postgres"]);
});

test("a standalone pick survives a missing dashboard and can open its question on a blurred dashboard", async t => {
  const q = question();
  const opened: string[][] = [];
  t.after(registry.subscribe(e => { if (e.type === "voice_open_question") opened.push([e.windowId, e.reviewId]); }));
  await say("Steve, answer", "choose");
  assert.equal((await act("choose", "pick", { id: q.id })).status, 200);
  assert.match(cards.at(-1)?.detail ?? "", /Focus a dashboard/);
  assert.deepEqual(registry.voiceRouter!.activeCards().find(c => c.id === "choose")?.candidates.map(c => c.id), [q.id]);
  t.after(registry.voiceRouter!.openCards.connect("dashboard"));
  await put("/api/voice/open-cards", { windowId: "dashboard", focused: false, cards: [] });
  assert.equal((await act("choose", "pick", { id: q.id })).status, 200);
  assert.deepEqual(opened, [["dashboard", q.id]]);
  assert.deepEqual(answers(), []);
});

test("spoken option numbers select their position or give a notice without sending a message", async () => {
  const question = "How many?";
  const q = reviews.create("sdk:Steve", "input", question, question, [{ id: "q", question, allowOther: true,
    options: Array.from({ length: 50 }, (_, i) => ({ id: String(i + 1), label: "Choice " + (i + 1) })) }]);
  for (const [phrase, expected] of [["eleven", "11"], ["seventeenth", "17"], ["twenty one", "21"], ["forty-ninth", "49"], ["fifty", "50"]]) {
    await say("Steve, option " + phrase);
    assert.deepEqual(answers()[0]?.selections?.[0]?.selected, [expected], phrase);
    await say("cancel");
  }
  for (const phrase of ["zeroth", "0th", "fifty first", "ninety-nine", "one hundred and eleven", "one thousand"]) {
    await say("Steve, option " + phrase);
    assert.deepEqual(answers(), []);
    assert.equal(cards.at(-1)?.detail, "No matching option.", phrase);
    assert.equal(registry.voiceRouter!.pendingVoiceActions.length, 0);
  }
  await say("Steve, option eleven seems risky", "message-about-eleven");
  await act("message-about-eleven", "send-now");
  assert.deepEqual(queued("Steve"), ["option eleven seems risky"]);
  assert.equal(registry.getReview(q.id)?.status, "pending");
});

test("only the dashboard currently showing the footer can send its inline answer", async t => {
  const q = question();
  const windows = registry.voiceRouter!.openCards;
  const report = (windowId: string, open: boolean) => put("/api/voice/open-cards", {
    windowId, focused: true, cards: open ? [{ kind: "question", id: q.id, focused: true }] : [],
  });
  t.after(windows.connect("first"));
  t.after(windows.connect("second"));
  await report("first", true);
  await say("Steve, option B", "owned");
  await report("second", false);
  assert.equal((await act("owned", "send-now?windowId=first")).status, 409);
  await report("second", true);
  assert.equal((await act("owned", "send-now?windowId=first")).status, 409);
  assert.equal((await act("owned", "send-now")).status, 409);
  assert.equal((await act("owned", "send-now?source=card")).status, 409);
  assert.equal(registry.getReview(q.id)?.status, "pending");
  assert.equal((await act("owned", "send-now?windowId=second")).status, 200);
  assert.equal(registry.getReview(q.id)?.status, "answered");
});

test("a queued footer submit rechecks both the live window and the exact pending action", async t => {
  const q = question();
  const windowId = "voice-question-test";
  await show([q.id]);
  const publish = registry.emitQuestionEvent.bind(registry);
  let sequence = 0;
  t.mock.method(registry, "emitQuestionEvent", (event: Parameters<typeof publish>[0]) => {
    if (event.type === "voice_confirm_focus") sequence = event.sequence;
    else publish(event);
  });
  const confirm = (focused: boolean) => put("/api/voice/open-cards", {
    windowId, focused, cards: [{ kind: "question", id: q.id, focused: true }],
  }, { "x-voice-confirm-focus": String(sequence) });
  await say("Steve, option B", "inline");
  const submit = () => registry.voiceRouter!.sendNow("inline", { companion: false, windowId });
  const blurred = submit();
  assert.ok(sequence > 0);
  await confirm(false);
  assert.equal(await blurred, false);
  assert.equal(answers()[0]?.id, "inline");
  await confirm(true);
  const delayed = submit();
  await say("no, A", "new-revision");
  await confirm(true);
  assert.equal(await delayed, false);
  assert.equal(answers()[0]?.id, "new-revision");
  assert.equal(registry.getReview(q.id)?.status, "pending");
});

test("a companion submit must hear from every live dashboard before resolving the pending answer", async t => {
  const q = question();
  const router = registry.voiceRouter!;
  await show([]);
  // The second browser already has its stream, but its first report is in flight.
  t.after(router.openCards.connect("other", true));
  t.after(router.openCards.connect("native-notifications"));
  const report = (windowId: string, focused: boolean, open: boolean, seq?: number) => put("/api/voice/open-cards", {
    windowId, focused, cards: open ? [{ kind: "question", id: q.id, focused }] : [],
  }, seq ? { "x-voice-confirm-focus": String(seq) } : {});
  await say("Steve, option B", "companion-click");
  const requests = new Map<string, number>();
  const publish = registry.emitQuestionEvent.bind(registry);
  t.mock.method(registry, "emitQuestionEvent", (event: Parameters<typeof publish>[0]) => {
    if (event.type === "voice_confirm_focus") requests.set(event.windowId, event.sequence);
    else publish(event);
  });
  const submit = () => router.sendNow("companion-click", { companion: true });
  const delayed = submit();
  assert.deepEqual([...requests.keys()].sort(), ["other", "voice-question-test"]);
  await report("voice-question-test", false, false, requests.get("voice-question-test"));
  await report("other", true, true, requests.get("other"));
  assert.equal(await delayed, false);
  assert.equal(answers()[0]?.footerWindowId, "other");
  await report("other", false, false);
  const corrected = submit();
  await say("no, A", "later-choice");
  await report("voice-question-test", false, false, requests.get("voice-question-test"));
  await report("other", false, false, requests.get("other"));
  assert.equal(await corrected, false);
  assert.equal(answers()[0]?.id, "later-choice");
  assert.equal(registry.getReview(q.id)?.status, "pending");
  const fresh = router.sendNow("later-choice", { companion: true });
  await report("voice-question-test", false, false, requests.get("voice-question-test"));
  await report("other", true, false, requests.get("other"));
  assert.equal(await fresh, true);
  assert.equal(registry.getReview(q.id)?.status, "answered");
});

test("a late report from a timed-out request cannot reinstate a closed card on the same focus transition", async t => {
  const q = question();
  const windowId = "late-report";
  t.after(registry.voiceRouter!.openCards.connect(windowId));
  const report = (ids: string[], revision: number) => put("/api/voice/open-cards", {
    windowId, focused: true, cards: ids.map(id => ({ kind: "question", id, focused: true })),
  }, { "x-voice-focus-at-us": "100", "x-voice-report-revision": String(revision) });
  assert.equal((await report([], 2)).status, 200);
  assert.equal((await report([q.id], 1)).status, 200);
  await say("reply, tomorrow");
  assert.deepEqual(answers(), []);
});

test("an unchanged report retry preserves a captured reply but a changed focus rejects it", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const first = question();
  const second = question("Which cache?");
  const router = registry.voiceRouter!;
  const windowId = "retry-focus";
  t.after(router.openCards.connect(windowId));
  const report = (ids: string[], focus: string, revision: number) => put("/api/voice/open-cards", {
    windowId, focused: true, cards: ids.map(id => ({ kind: "question", id, focused: id === focus })),
  }, { "x-voice-focus-at-us": "100", "x-voice-report-revision": String(revision) });
  const reply = (id: string, capturedAt: number) => router.accept({ id, capturedAt, backend: "fluidaudio", text: "reply, option B", words: [] });
  await report([first.id, second.id], second.id, 1);
  t.mock.timers.tick(10);
  await report([first.id, second.id], second.id, 2);
  await report([second.id, first.id], second.id, 3);
  await reply("before-retry", now + 5);
  assert.equal(answers()[0]?.reviewId, second.id);
  await say("cancel");
  t.mock.timers.tick(10);
  await report([second.id, first.id], first.id, 4);
  await reply("before-focus-change", now + 15);
  assert.deepEqual(answers(), []);
});

test("late and concurrent corrections keep the newest captured choice and its countdown", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const q = question();
  const correct = (choice: string, id: string, capturedAt: number) => registry.voiceRouter!.accept({
    id, capturedAt, backend: "fluidaudio", text: "no, " + choice, words: [],
  });
  await say("Steve, option A", "initial");
  t.mock.timers.tick(100);
  await correct("B", "newer", now + 50);
  const staged = answers()[0]!;
  t.mock.timers.tick(100);
  await correct("A", "late", now + 25);
  assert.deepEqual(answers(), [staged]);
  await Promise.all([correct("A", "next", now + 150), correct("B", "last", now + 175)]);
  assert.equal(answers()[0]?.id, "last");
  assert.equal(answers()[0]?.text, "Postgres");
  t.mock.timers.tick(1001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(registry.getReview(q.id)?.selections, [{ decisionId: "q", selected: ["postgres"], other: null }]);
});

test("a slow match cannot revive a cancelled newer answer or take a different question's slot", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const q = question();
  const other = question("Which cache?", "sdk:Will");
  const router = registry.voiceRouter!;
  let started!: () => void;
  let release!: () => void;
  const matching = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(model, "decide", async () => {
    started();
    await released;
    return { rung: "job", answers: [{ choice: "sqlite", confidence: 1 }], detail: "delayed choice" };
  });
  const slow = say("Steve, answer: the one already running", "slow");
  await matching;
  t.mock.timers.tick(10);
  await say("Will, option A", "will");
  await say("Steve, option B", "newer");
  assert.deepEqual(router.pendingVoiceActions.map(a => a.id), ["will", "newer"]);
  await say("cancel");
  release();
  await slow;
  assert.deepEqual(answers().map(a => a.reviewId), [other.id]);
  assert.deepEqual(router.pendingVoiceActions.map(a => a.id), ["will"]);
  await router.accept({ id: "late-transcript", capturedAt: now + 5, backend: "fluidaudio", text: "Steve, option A", words: [] });
  assert.deepEqual(answers().map(a => a.reviewId), [other.id]);
  t.mock.timers.tick(1001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(registry.getReview(q.id)?.status, "pending");
  assert.equal(registry.getReview(other.id)?.status, "answered");
});

test("a correction captured before the newest answer settled cannot switch the remaining question", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const first = question();
  const second = question("Which cache?", "sdk:Will");
  await say("Steve, option B", "older-answer");
  const [original] = answers();
  t.mock.timers.tick(100);
  await say("Will, option B", "newer-answer");
  t.mock.timers.tick(100);
  await act("newer-answer", "send-now?source=card");
  assert.equal(registry.getReview(second.id)?.status, "answered");
  const correct = (id: string, capturedAt: number) => registry.voiceRouter!.accept({
    id, text: "no, A", backend: "fluidaudio", capturedAt, words: [],
  });
  await correct("delayed-correction", now + 150);
  assert.deepEqual(answers(), [original]);
  assert.equal(registry.getReview(first.id)?.status, "pending");
  t.mock.timers.tick(50);
  await correct("after-submit", now + 225);
  assert.equal(answers()[0]?.text, "SQLite");
  assert.equal(answers()[0]?.reviewId, first.id);
});

test("choosing an old prefilled picker preserves the newer answer and its deadline", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const first = question();
  const second = question("Which cache?");
  await say("Steve, answer: Postgres", "old-picker");
  // Same millisecond captures still retain their original arrival order.
  await show([first.id]);
  await say("Steve, option A", "newer-choice");
  const [original] = answers();
  t.mock.timers.tick(100);
  assert.equal((await act("old-picker", "pick", { id: first.id })).status, 200);
  await registry.voiceRouter!.resolution("old-picker");
  assert.deepEqual(answers(), [original]);
  t.mock.timers.tick(901);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(registry.getReview(first.id)?.selections?.[0]?.selected, ["sqlite"]);
  assert.equal(registry.getReview(second.id)?.status, "pending");
});

test("a prefilled question pick is acknowledged while its match is pending", async t => {
  const q = question();
  question("Which cache?");
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const matcher = t.mock.method(model, "decide", async () => {
    await waiting;
    return { rung: "job", answers: [{ choice: "postgres", confidence: 1 }], detail: "matched" };
  });
  await say("Steve, answer: the existing service", "picker");
  const pick = act("picker", "pick", { id: q.id });
  try {
    const ack = await Promise.race([pick, new Promise<void>(resolve => setImmediate(resolve))]);
    assert.equal(matcher.mock.callCount(), 1);
    assert.equal(ack?.status, 200);
    assert.deepEqual(answers(), []);
    assert.equal((await act("picker", "pick", { id: q.id })).status, 409);
  } finally {
    release();
    await pick;
    await registry.voiceRouter!.resolution("picker");
  }
  assert.equal(answers()[0]?.reviewId, q.id);
  assert.equal(answers()[0]?.text, "Postgres");
  assert.equal(cards.at(-1)?.reason, "voice-answer");
});

test("speech intersecting the clock uncertainty requests a repeat and never starts a countdown", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  let monotonic = 100;
  t.mock.method(performance, "now", () => monotonic);
  const q = question();
  const router = registry.voiceRouter!;
  const windowId = "clock-interval";
  t.after(router.openCards.connect(windowId));
  monotonic += 200;
  t.mock.timers.tick(200);
  const report = await put("/api/voice/open-cards", { windowId, focused: true, cards: [{ kind: "question", id: q.id, focused: true }] },
    { "x-voice-cards-earliest-at-ms": "150", "x-voice-cards-observed-at-ms": "250" });
  assert.equal(report.status, 200);
  const reply = (id: string, elapsed: number) => router.accept({ id, capturedAt: now + elapsed, text: "reply, option B", backend: "fluidaudio", words: [] });
  await reply("before-open", 25);
  assert.equal(cards.length, 0);
  await reply("uncertain", 100);
  assert.match(cards.at(-1)?.detail ?? "", /your answer again/);
  assert.deepEqual(answers(), []);
  assert.equal(router.pendingVoiceActions.length, 0);
  await reply("after-open", 175);
  assert.equal(answers()[0]?.text, "Postgres");
});

test("a calibrating focus reserves its reply until confirmed and loses it on cancel or a different focus", async t => {
  const router = registry.voiceRouter!;
  const a = question();
  const b = question("Which cache?");
  const windowId = "provisional-focus";
  t.after(router.openCards.connect(windowId));
  let revision = 0;
  const report = (focus: string, observationId: string, calibrating = false) => put("/api/voice/open-cards", {
    windowId, focused: true, cards: [a, b].map(q => ({ id: q.id, kind: "question", focused: q.id === focus })),
  }, { "x-voice-focus-at-us": "100", "x-voice-report-revision": String(++revision), "x-voice-observation-id": observationId,
    ...(calibrating ? { "x-voice-calibrating": "1" } : { "x-voice-cards-observed-at-ms": "0" }) });
  await report(a.id, "1");
  for (const [i, action] of ["cancel", "focus", "confirm"].entries()) {
    const obs = String(2 + i * 2);
    await report(b.id, obs, true);
    const id = "calibrating-" + action;
    const reply = router.accept({ id, text: "reply, option B", backend: "fluidaudio", capturedAt: Date.now(), words: [] });
    assert.deepEqual(answers(), []);
    assert.ok(router.pendingVoiceActions.some(a => a.id === id));
    if (action === "cancel") await say("cancel");
    if (action === "focus") await report(a.id, String(Number(obs) + 1));
    else await report(b.id, obs);
    await reply;
    if (action === "confirm") assert.equal(answers()[0]?.reviewId, b.id);
    else assert.deepEqual(answers(), []);
    assert.equal(registry.getReview(a.id)?.status, "pending");
  }
});

test("an addressed agent retains its one open target when another agent has focus", async () => {
  const visible = question();
  question("Which cache?");
  const focused = question("Which platform?", "sdk:Will");
  await show([visible.id, focused.id], focused.id);
  await say("Steve, option B");
  assert.equal(answers()[0]?.reviewId, visible.id);
  await say("cancel");
  await say("reply, option A");
  assert.equal(answers()[0]?.reviewId, focused.id);
});

test("only a fresh confirmation from the requested live dashboard can arm a reply", async t => {
  const q = question();
  await show([q.id]);
  const router = registry.voiceRouter!;
  t.after(router.openCards.connect("background"));
  const requests: number[] = [];
  const publish = registry.emitQuestionEvent.bind(registry);
  t.mock.method(registry, "emitQuestionEvent", (event: Parameters<typeof publish>[0]) => {
    if (event.type === "voice_confirm_focus") requests.push(event.sequence);
    else publish(event);
  });
  const reply = (id: string) => router.accept({ id, text: "reply, option B", capturedAt: Date.now(), backend: "fluidaudio", words: [] });
  const report = (windowId: string, sequence: number) => put("/api/voice/open-cards", {
    windowId, focused: windowId !== "background", cards: [{ kind: "question", id: q.id, focused: true }],
  }, { "x-voice-confirm-focus": String(sequence) });
  const cancelled = reply("unconfirmed");
  await say("cancel");
  await cancelled;
  const pending = reply("next-reply");
  assert.equal(requests.length, 2);
  await report("voice-question-test", requests[0]!);
  await report("background", requests[1]!);
  assert.deepEqual(answers(), []);
  assert.equal(registry.getReview(q.id)?.status, "pending");
  await report("voice-question-test", requests[1]!);
  await pending;
  assert.equal(answers()[0]?.id, "next-reply");
});

test("exact option labels normalize trailing punctuation on both sides and still require uniqueness", async t => {
  const title = "Start the build?";
  const ask = t.mock.method(model, "decide", () => ({ rung: "none", answers: [{ choice: null, confidence: 0 }], detail: "" }));
  for (const duplicate of [false, true]) {
    const options = [{ id: "run", label: "Run now?" }, { id: "later", label: duplicate ? "Run now!" : "Wait." }];
    const q = reviews.create("sdk:Steve", "input", title, title, [{ id: "q", question: title, allowOther: true, options }]);
    await show([q.id]);
    await say("reply, RUN NOW!");
    if (duplicate) {
      assert.equal(ask.mock.callCount(), 1);
      assert.deepEqual(answers()[0]?.selections?.[0]?.selected, []);
    } else {
      assert.equal(ask.mock.callCount(), 0);
      assert.deepEqual(answers()[0]?.selections?.[0]?.selected, ["run"]);
      assert.equal(answers()[0]?.selections?.[0]?.other, null);
    }
    await say("cancel");
    reviews.resolve(q.id, "dismiss", null);
  }
});

test("named choice and Other dictation use the focus confirmed for that utterance", async t => {
  const now = Date.now();
  const connected = performance.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(performance, "now", () => connected + (Date.now() - now));
  const first = question();
  const second = question("Which cache?");
  await show([first.id, second.id], first.id);
  t.mock.timers.tick(10);
  let sequence = 0;
  const publish = registry.emitQuestionEvent.bind(registry);
  t.mock.method(registry, "emitQuestionEvent", (event: Parameters<typeof publish>[0]) => {
    if (event.type === "voice_confirm_focus") sequence = event.sequence;
    else publish(event);
  });
  const speak = (id: string, text: string) => registry.voiceRouter!.accept({ id, text, capturedAt: Date.now(), backend: "fluidaudio", words: [] });
  const confirm = (ids: string[], focused?: string) => put("/api/voice/open-cards", {
    windowId: "voice-question-test", focused: true, cards: ids.map(id => ({ kind: "question", id, focused: id === focused })),
  }, { "x-voice-confirm-focus": String(sequence), "x-voice-cards-observed-at-ms": "0" });
  const choice = speak("named-switch", "Steve, option B");
  assert.ok(sequence > 0);
  assert.deepEqual(answers(), []);
  await confirm([first.id, second.id], second.id);
  await choice;
  assert.equal(answers()[0]?.reviewId, second.id);
  assert.deepEqual(answers()[0]?.selections?.[0]?.selected, ["postgres"]);
  await say("cancel");
  reviews.resolve(first.id, "dismiss", null);
  const dictation = speak("named-closed", "Steve, answer: a different database");
  await confirm([]);
  await dictation;
  assert.deepEqual(answers(), []);
  assert.equal(cards.at(-1)?.detail, "No matching option.");
});
