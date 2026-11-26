import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { VoiceRouter } from "../src/server/voice/router.ts";
import type { VoiceQuestions } from "../src/server/voice/questions.ts";
import { applyVoiceConfigPatch, VOICE_CONFIG_DEFAULTS, VoiceConfigPatchSchema, VoiceConfigSchema, type VoiceMode } from "../src/shared/voice.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import { VoiceUtteranceSchema, type VoiceCard, type VoiceUtterance } from "../src/shared/voice-routing.ts";
import { separatorWordProblem, splitAtSeparator, VOICE_SEPARATOR_DEFAULT } from "../src/shared/voice-separator.ts";

before(() => { ensureNativeStateLockAddon(); });

const timed = (text: string) => text.split(/\s+/u).map((word, i) => ({ text: word, startMs: 100 * i, endMs: 100 * i + 90 }));
const texts = (parts: ReturnType<typeof splitAtSeparator>) => parts?.map(part => part.text) ?? null;
const EXAMPLE = "Steve, check the build, bagel, Carol, give me a report on the status of some project";

test("the default separator is bagel and the example splits into two messages without the word", () => {
  assert.equal(VOICE_CONFIG_DEFAULTS.separatorWord, VOICE_SEPARATOR_DEFAULT);
  assert.equal(VOICE_SEPARATOR_DEFAULT, "bagel");
  const parts = splitAtSeparator(EXAMPLE, timed(EXAMPLE), "bagel");
  assert.deepEqual(texts(parts), ["Steve, check the build", "Carol, give me a report on the status of some project"]);
  // Timings follow the same cut, and the second message is dated from its first word.
  assert.deepEqual(parts?.[0]?.words.map(word => word.text), ["Steve,", "check", "the", "build,"]);
  assert.deepEqual(parts?.[1]?.words.map(word => word.text).slice(0, 2), ["Carol,", "give"]);
  assert.equal(parts?.[1]?.offsetMs, 500);
});

test("a custom word separates and the default then stays ordinary text", () => {
  const spoken = "Steve check the build pineapple Carol report status";
  assert.deepEqual(texts(splitAtSeparator(spoken, [], "Pineapple")), ["Steve check the build", "Carol report status"]);
  assert.equal(splitAtSeparator(EXAMPLE, [], "pineapple"), null);
});

test("the separator matches only a standalone word, in any case, with sentence marks", () => {
  for (const spoken of ["Steve, order bagels", "Steve, the bagel's warm", "Steve, visit bagelry", "Steve, bagel-shop", "Steve, say \"bagel\""]) {
    assert.equal(splitAtSeparator(spoken, timed(spoken), "bagel"), null, spoken);
  }
  assert.deepEqual(texts(splitAtSeparator("Steve, check the build. Bagel. Carol, report.", [], "bagel")),
    ["Steve, check the build.", "Carol, report."]);
  assert.deepEqual(texts(splitAtSeparator("Steve check the build BAGEL! Carol report", [], "bagel")),
    ["Steve check the build", "Carol report"]);
});

test("separators at the ends or side by side leave no empty message", () => {
  assert.deepEqual(splitAtSeparator("Bagel.", timed("Bagel."), "bagel"), []);
  assert.deepEqual(splitAtSeparator("bagel, bagel", [], "bagel"), []);
  assert.deepEqual(texts(splitAtSeparator("bagel Steve, check the build bagel", [], "bagel")), ["Steve, check the build"]);
  assert.deepEqual(texts(splitAtSeparator("Steve, check the build, bagel, bagel, Carol, report", [], "bagel")),
    ["Steve, check the build", "Carol, report"]);
  assert.deepEqual(texts(splitAtSeparator("Steve, check the build, bagel, ... Carol, report", [], "bagel")),
    ["Steve, check the build", "Carol, report"]);
});

test("a leading call sign spelled like the separator is kept for addressing", () => {
  assert.equal(splitAtSeparator("Bagel, check the build", timed("Bagel, check the build"), "bagel", { leadingAddress: true }), null);
  const parts = splitAtSeparator("Bagel, go, bagel, Carol, stay", timed("Bagel, go, bagel, Carol, stay"), "bagel", { leadingAddress: true });
  assert.deepEqual(texts(parts), ["Bagel, go", "Carol, stay"]);
  assert.deepEqual(parts?.map(part => part.words.map(word => word.text)), [["Bagel,", "go,"], ["Carol,", "stay"]]);
});

test("a timing group that does not spell its part's words leaves only that part unmeasured", () => {
  // The decoder timed "bagel" but dropped the call sign after it.
  const words = timed("Steve, go, bagel, give me a report").map((word, i) => i === 3 ? { ...word } : word);
  const spoken = "Steve, go, bagel, Carol, give me a report";
  const parts = splitAtSeparator(spoken, words, "bagel");
  assert.deepEqual(texts(parts), ["Steve, go", "Carol, give me a report"]);
  assert.deepEqual(parts?.map(part => [part.words.map(word => word.text), part.offsetMs]), [[["Steve,", "go,"], 0], [[], null]]);
});

test("timings that disagree with the text leave the parts unmeasured", () => {
  const parts = splitAtSeparator("Steve, go, bagel, Carol, stay", timed("Steve go Carol stay"), "bagel");
  assert.deepEqual(texts(parts), ["Steve, go", "Carol, stay"]);
  assert.deepEqual(parts?.map(part => [part.words.length, part.offsetMs]), [[0, null], [0, null]]);
});

test("the setting accepts one word and refuses phrases, punctuation and voice commands", () => {
  assert.equal(separatorWordProblem("pineapple"), null);
  assert.equal(separatorWordProblem("o'clock"), null);
  assert.equal(separatorWordProblem("next-one"), null);
  assert.match(separatorWordProblem("two words") ?? "", /one word/);
  assert.match(separatorWordProblem("bagel!") ?? "", /one word/);
  assert.match(separatorWordProblem("") ?? "", /one word/);
  assert.equal(separatorWordProblem("x".repeat(32)), null);
  assert.equal(VoiceConfigPatchSchema.safeParse({ separatorWord: "x".repeat(32) }).success, true);
  assert.match(separatorWordProblem("x".repeat(33)) ?? "", /32 characters/);
  assert.equal(VoiceConfigPatchSchema.safeParse({ separatorWord: "x".repeat(33) }).success, false);
  for (const command of ["cancel", "Stop", "reply", "submit"]) assert.match(separatorWordProblem(command) ?? "", /already a voice command/);
  assert.equal(VoiceConfigPatchSchema.safeParse({ separatorWord: " pineapple " }).data?.separatorWord, "pineapple");
  assert.equal(VoiceConfigPatchSchema.safeParse({ separatorWord: "cancel" }).success, false);
  assert.equal(applyVoiceConfigPatch(VOICE_CONFIG_DEFAULTS, { separatorWord: "pineapple" }).separatorWord, "pineapple");
  // A stored value an older or newer build cannot use reads as the default instead of failing the config.
  assert.equal(VoiceConfigSchema.parse({ separatorWord: "cancel" }).separatorWord, "bagel");
  assert.equal(VoiceConfigSchema.parse({}).separatorWord, "bagel");
});

// ---- the router ----

const agent = (name: string): SpokenName => ({ key: `task:${name.toLowerCase()}`, name, kind: "session", sessionId: name.toLowerCase(),
  taskId: name.toLowerCase(), role: "", colorId: null, agent: "codex", state: "running" });

function harness(t: { after(fn: () => void): void }, options: { mode?: VoiceMode; separatorWord?: string | null; roster?: SpokenName[]; questions?: VoiceQuestions } = {}) {
  const cards = new Map<string, VoiceCard>();
  const delivered: { name: string; text: string }[] = [];
  let hostNow = 1_000_000;
  const state = { mode: options.mode ?? "listening", separatorWord: options.separatorWord === undefined ? "bagel" : options.separatorWord,
    roster: options.roster ?? [agent("Steve"), agent("Carol")] };
  const router = new VoiceRouter(() => ({ backend: "fluidaudio", mode: state.mode, roster: state.roster, separatorWord: state.separatorWord }),
    () => ({ enabled: true, seconds: 30 }), {
      deliver: async (target, text) => { delivered.push({ name: target.name, text }); return "queued"; },
    }, card => cards.set(card.id, card), undefined, () => hostNow, options.questions);
  t.after(() => router.reset());
  let sequence = 0;
  const say = (text: string, extra: Partial<VoiceUtterance> = {}, timing: Parameters<VoiceRouter["accept"]>[1] = { startHostUs: hostNow, speechStartHostUs: hostNow }) => {
    hostNow += 10_000;
    return router.accept({ id: `capture-${++sequence}`, text, capturedAt: Date.now(), backend: "fluidaudio", words: timed(text), ...extra }, timing);
  };
  return { router, cards, delivered, say, state, pending: () => [...cards.values()].filter(card => card.state === "pending") };
}

test("Always-on: one capture with the separator opens two addressed cards, each with its own Cancel", async t => {
  const { router, cards, delivered, say, pending } = harness(t);
  assert.equal(await say(EXAMPLE), true);
  const open = pending();
  assert.deepEqual(open.map(card => [card.parts[0]?.target?.name, card.parts[0]?.text]), [
    ["Steve", "check the build"],
    ["Carol", "give me a report on the status of some project"],
  ]);
  assert.deepEqual(router.heard.list().map(entry => [entry.text, entry.matchedName, entry.outcome]).reverse(), [
    ["Steve, check the build", "Steve", "pending"],
    ["Carol, give me a report on the status of some project", "Carol", "pending"],
  ]);
  // Cancel either message alone. The other still delivers.
  assert.equal(router.cancel(open[0]!.id), true);
  assert.equal(await router.sendNow(open[1]!.id), true);
  assert.deepEqual(delivered.map(({ name, text }) => [name, text]), [["Carol", "give me a report on the status of some project"]]);
  assert.equal(cards.get(open[0]!.id)?.state, "cancelled");
});

test("a spoken Cancel after the separator cancels the message just opened", async t => {
  const { say, pending, cards } = harness(t);
  await say("Steve, check the build, bagel, cancel");
  assert.equal(pending().length, 0);
  assert.deepEqual([...cards.values()].map(card => [card.parts[0]?.target?.name, card.state]), [["Steve", "cancelled"]]);
});

test("a capture of only the separator opens nothing and says why in Recently heard", async t => {
  const { router, say, cards } = harness(t);
  assert.equal(await say("Bagel."), true);
  assert.equal(cards.size, 0);
  assert.deepEqual(router.heard.list().map(entry => [entry.text, entry.rule, entry.outcome]), [["Bagel.", "separator-only", "ignored"]]);
});

test("a retried capture does not open its messages twice", async t => {
  const { router, pending } = harness(t);
  const utterance: VoiceUtterance = { id: "retry", text: EXAMPLE, capturedAt: Date.now(), backend: "fluidaudio", words: timed(EXAMPLE) };
  assert.equal(await router.accept(utterance), true);
  assert.equal(await router.accept(utterance), true);
  assert.equal(pending().length, 2);
});

test("a capture whose second message is refused routes only that message on retry", async t => {
  const { router, pending, cards } = harness(t);
  // Fill the router to one slot below capacity, so only the first separated message fits.
  for (let i = 0; i < 49; i++) {
    assert.equal(await router.accept({ id: `filler-${i}`, text: `Steve, task ${i}`, capturedAt: Date.now(), backend: "fluidaudio", words: [] }), true);
  }
  const utterance: VoiceUtterance = { id: "split", text: EXAMPLE, capturedAt: Date.now(), backend: "fluidaudio", words: timed(EXAMPLE) };
  const routed = () => pending().filter(card => card.id.startsWith("split:")).map(card => [card.id, card.parts[0]?.target?.name, card.parts[0]?.text]);
  assert.equal(await router.accept(utterance), false);
  assert.deepEqual(routed(), [["split:1", "Steve", "check the build"]]);
  assert.deepEqual(router.heard.list().filter(entry => entry.id.startsWith("split")).map(entry => entry.id), ["split:1"]);
  // Still full: the retry is refused again and the first message is not opened twice.
  assert.equal(await router.accept(utterance), false);
  assert.deepEqual(routed(), [["split:1", "Steve", "check the build"]]);
  // A slot opens. The retry routes only the refused message.
  assert.equal(router.cancel("filler-0"), true);
  assert.equal(await router.accept(utterance), true);
  assert.deepEqual(routed(), [
    ["split:1", "Steve", "check the build"],
    ["split:2", "Carol", "give me a report on the status of some project"],
  ]);
  // Once every part is routed the capture is settled, and a further retry changes nothing.
  const published = cards.size;
  assert.equal(await router.accept(utterance), true);
  assert.equal(cards.size, published);
  assert.deepEqual(router.heard.list().filter(entry => entry.id.startsWith("split")).map(entry => entry.id).toSorted(), ["split:1", "split:2"]);
});

async function fill(router: VoiceRouter, count: number) {
  for (let i = 0; i < count; i++) {
    assert.equal(await router.accept({ id: `filler-${i}`, text: `Steve, task ${i}`, capturedAt: Date.now(), backend: "fluidaudio", words: [] }), true);
  }
}

test("part IDs cannot collide with a listener capture ID", async t => {
  // A listener may name a capture "clip~1"; the parts of capture "clip" are "clip:1" and "clip:2".
  assert.equal(VoiceUtteranceSchema.safeParse({ id: "clip:1", text: "x", capturedAt: 1, backend: "fluidaudio" }).success, false);
  const { router, pending } = harness(t);
  assert.equal(await router.accept({ id: "clip~1", text: "Steve, run the tests", capturedAt: Date.now(), backend: "fluidaudio", words: [] }), true);
  assert.equal(await router.accept({ id: "clip", text: EXAMPLE, capturedAt: Date.now(), backend: "fluidaudio", words: timed(EXAMPLE) }), true);
  assert.deepEqual(pending().map(card => [card.id, card.parts[0]?.text]), [
    ["clip~1", "run the tests"],
    ["clip:1", "check the build"],
    ["clip:2", "give me a report on the status of some project"],
  ]);
});

test("a Cancel after a refused part waits for it and then cancels it, not the message before", async t => {
  const { router, pending, cards } = harness(t);
  await fill(router, 49);
  const utterance: VoiceUtterance = { id: "bound", text: "Steve, check the build, bagel, Carol, run the tests, bagel, cancel",
    capturedAt: Date.now(), backend: "fluidaudio", words: [] };
  assert.equal(await router.accept(utterance), false);
  // Carol's message was refused, so the Cancel after it was not spoken yet as far as routing goes.
  assert.deepEqual(pending().filter(card => card.id.startsWith("bound:")).map(card => [card.id, card.parts[0]?.text]), [["bound:1", "check the build"]]);
  assert.equal(router.heard.list().some(entry => entry.id === "bound:3"), false);
  assert.equal(router.cancel("filler-0"), true);
  assert.equal(await router.accept(utterance), true);
  assert.equal(cards.get("bound:1")?.state, "pending");
  assert.equal(cards.get("bound:2")?.state, "cancelled");
  assert.deepEqual(router.heard.list().find(entry => entry.id === "bound:3")?.detail, "bound:2");
});

test("a retry routes the original parts against the original sessions after a separator edit and a takeover", async t => {
  const { router, pending, cards, state } = harness(t);
  await fill(router, 49);
  const spoken = "Steve, check the build, bagel, Carol, order pineapple";
  const utterance: VoiceUtterance = { id: "kept", text: spoken, capturedAt: Date.now(), backend: "fluidaudio", words: timed(spoken) };
  assert.equal(await router.accept(utterance), false);
  // Before the retry, the separator becomes the word inside Carol's message and another session takes over Carol.
  state.separatorWord = "pineapple";
  state.roster = [agent("Steve"), { ...agent("Carol"), sessionId: "carol-replacement" }];
  assert.equal(router.cancel("filler-0"), true);
  assert.equal(await router.accept(utterance), true);
  const carol = pending().find(card => card.id === "kept:2");
  assert.deepEqual([carol?.parts[0]?.text, carol?.parts[0]?.target?.sessionId], ["order pineapple", "carol"]);
  // Delivery refuses the destination the replacement session now holds.
  assert.equal(await router.sendNow("kept:2"), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cards.get("kept:2")?.state, "not-running");
});

const ONE_NAME = "Steve, check the build, bagel, then report status";

test("Push-to-talk keeps the separator as ordinary text in one message", async t => {
  for (const timing of [{ mode: "push-to-talk" as const, held: false }, { mode: "waiting-for-key" as const, held: true }]) {
    const { router, say, pending } = harness(t, { mode: timing.mode });
    assert.equal(await say(ONE_NAME, {}, { heldBeforeRelease: timing.held }), true);
    assert.deepEqual(pending().map(card => [card.parts[0]?.target?.name, card.parts[0]?.text]), [
      ["Steve", "check the build, bagel, then report status"],
    ], timing.mode);
    assert.deepEqual(router.heard.list().map(entry => entry.text), [ONE_NAME]);
  }
  // The same words in Always-on end Steve's message at the separator.
  const { router, say, pending } = harness(t);
  await say(ONE_NAME);
  assert.deepEqual(pending().map(card => card.parts[0]?.text), ["check the build"]);
  assert.deepEqual(router.heard.list().map(entry => [entry.text, entry.rule]), [["then report status", "no-name"], ["Steve, check the build", "exact"]]);
});

test("a call sign that equals the separator addresses its agent only as the first word, and a missing setting splits nothing", async t => {
  const named = harness(t, { roster: [agent("Steve"), agent("Bagel"), agent("Carol")] });
  await named.say("Bagel, check the build");
  assert.deepEqual(named.pending().map(card => [card.parts[0]?.target?.name, card.parts[0]?.text]), [["Bagel", "check the build"]]);
  // An agent named Bagel does not stop the word separating two other messages.
  await named.say(EXAMPLE);
  assert.deepEqual(named.pending().slice(1).map(card => [card.parts[0]?.target?.name, card.parts[0]?.text]), [
    ["Steve", "check the build"],
    ["Carol", "give me a report on the status of some project"],
  ]);
  await named.say("Bagel, run the tests, bagel, Carol, deploy");
  assert.deepEqual(named.pending().slice(3).map(card => [card.parts[0]?.target?.name, card.parts[0]?.text]), [
    ["Bagel", "run the tests"],
    ["Carol", "deploy"],
  ]);
  const off = harness(t, { separatorWord: null });
  await off.say(ONE_NAME);
  assert.deepEqual(off.pending().map(card => card.parts[0]?.text), ["check the build, bagel, then report status"]);
});

test("dictation into a focused field keeps the separator as typed text", async t => {
  const dictated: string[] = [];
  const questions = { dictate: (_window: string, _target: string, text: string) => { dictated.push(text); } } as unknown as VoiceQuestions;
  const { say, cards } = harness(t, { questions });
  assert.equal(await say(EXAMPLE, {}, { dictation: { windowId: "w", target: crypto.randomUUID() } }), true);
  assert.deepEqual(dictated, [EXAMPLE]);
  assert.equal(cards.size, 0);
});
