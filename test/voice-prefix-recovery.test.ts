import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { HeardRow } from "../src/web/components/RecentlyHeard.tsx";
import { VoiceRouter } from "../src/server/voice/router.ts";
import { routeUtterance, VoiceUtteranceSchema, type HeardEntry, type VoiceCard, type VoiceRouteDecision, type VoiceUtterance } from "../src/shared/voice-routing.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import { FEATURE_FLAGS } from "../src/shared/feature-flag-registry.ts";
import { VOICE_PREFIX_RECOVERY_FLAG } from "../src/shared/voice.ts";
import {
  PREFIX_HOLDOUT_CASES, PREFIX_SCOUT_CASES, PREFIX_SCOUT_ROSTER, PREFIX_AUDIO_ROSTER, UNSAFE_SCORES, scorePrefixOutcome,
  type PrefixOutcome,
} from "./fixtures/voice-prefix-corpus.ts";

before(() => { ensureNativeStateLockAddon(); });

const agent = (name: string): SpokenName => ({ name, key: "task:" + name, kind: "session", taskId: name, sessionId: "s:" + name,
  role: "Builds", colorId: null, agent: "claude", state: "running" });
const scoutRoster = PREFIX_SCOUT_ROSTER.map(agent);
const utterance = (text: string, words: VoiceUtterance["words"] = []) =>
  VoiceUtteranceSchema.parse({ id: "one", capturedAt: 1, text, words, backend: "fluidaudio" });
const route = (text: string, prefixRecovery = true, roster = scoutRoster, words: VoiceUtterance["words"] = []) =>
  routeUtterance(utterance(text, words), { roster, prefixRecovery });

function outcome(decision: VoiceRouteDecision): PrefixOutcome {
  switch (decision.kind) {
    case "addressed": return `route:${decision.target.name}`;
    case "needs-model": return decision.reason === "second-name" ? `route:${decision.target.name}` : `ask:${decision.candidates.map(c => c.name).join("/")}`;
    case "suggest": return `ask:${decision.candidates.map(c => c.name).join("/")}`;
    case "control": return "control";
    case "ignored": return "drop";
  }
}

test("the preview flag is declared off by default and readable by sessions", () => {
  const flag = FEATURE_FLAGS.find(candidate => candidate.id === VOICE_PREFIX_RECOVERY_FLAG);
  assert.equal(flag?.stage, "preview");
  assert.match(flag!.description, /stray word comes before the call sign/);
});

test("on the scout's written corpus recovery adds no send nobody asked for, keeps every route that works today, and asks rather than guesses", () => {
  const scores: Record<string, string[]> = {};
  for (const item of PREFIX_SCOUT_CASES) {
    const off = outcome(route(item.text, false));
    const on = outcome(route(item.text));
    if (off !== "drop") assert.equal(on, off, `${item.id} changed a route that works today`);
    const score = scorePrefixOutcome(item.gold, on);
    (scores[score] ??= []).push(item.id);
  }
  // The baseline's own guess, unchanged: "Steve and Luna, check the build." goes to Steve today.
  assert.deepEqual(Object.entries(scores).filter(([score]) => UNSAFE_SCORES.has(score as never)), [["silent-guess", ["c08"]]]);
  // Of the 37 prefixed addresses: the scout's S6 routed 26; this routes 21 because a determiner or pronoun
  // prefix ("The Steve, ...") asks instead, a name with no punctuation after it is left alone, and so is a
  // recovered message with a comma in it ("Um, Steve, check the build, and Luna, run the tests.").
  const prefixed = PREFIX_SCOUT_CASES.filter(item => item.gold.startsWith("route:") && item.category !== "control").map(item => item.id);
  assert.equal(prefixed.length, 37);
  assert.equal(scores.routed!.filter(id => prefixed.includes(id)).length, 21);
  assert.equal(scores.asked!.filter(id => prefixed.includes(id)).length, 13);
  assert.deepEqual(scores.dropped, ["f10", "l09", "a04"]);
  // Every ordinary mention, "Uh Steve broke it again." included, is left without a card or a prompt.
  assert.equal(scores["needless-ask"], undefined);
});

test("the holdout's transcripts, as written, keep every route that works today and never send to the wrong agent or to nobody", () => {
  const roster = PREFIX_AUDIO_ROSTER.map(agent);
  for (const item of PREFIX_HOLDOUT_CASES) {
    // A spoken Cancel is scored against the card before it in the audio run.
    if (item.gold === "cancel") continue;
    const off = outcome(route(item.text, false, roster));
    const on = outcome(route(item.text, true, roster));
    if (off !== "drop") assert.equal(on, off, `${item.id} changed a route that works today`);
    assert.ok(!UNSAFE_SCORES.has(scorePrefixOutcome(item.gold, on)), `${item.id} ${item.text}: ${on}`);
  }
});

test("a known filler before a delimited exact name routes the rest and records what was skipped", () => {
  const steve = agent("Steve");
  assert.deepEqual(route("Um, Steve, check the build."), { kind: "addressed", target: steve, match: "exact", text: "check the build.", pauseMs: null, prefix: "Um, " });
  assert.deepEqual(route("Okay so Will, grab the logs."), { kind: "addressed", target: agent("Will"), match: "exact", text: "grab the logs.", pauseMs: null, prefix: "Okay so " });
  assert.deepEqual(route("Um Release Captain, tag the build."), { kind: "addressed", target: agent("Release Captain"), match: "exact", text: "tag the build.", pauseMs: null, prefix: "Um " });
  // An addressed Stop keeps its command.
  assert.deepEqual(route("Uh, Luna, stop."), { kind: "addressed", target: agent("Luna"), match: "exact", command: "stop", text: "stop.", pauseMs: null, prefix: "Uh, " });
  // A later name after a recovered address asks split or mention with the first target fixed, as it does without a prefix.
  const split = route("Um, Steve, ask Luna about the build.");
  assert.equal(split.kind, "needs-model");
  assert.ok(split.kind === "needs-model" && split.reason === "second-name" && split.target.name === "Steve" && split.prefix === "Um, ");
});

test("a question or message that opens with who, which or a determiner after a recovered name is still addressed to it", () => {
  assert.deepEqual(route("So, Steve, who is on call?"), { kind: "addressed", target: agent("Steve"), match: "exact", text: "who is on call?", pauseMs: null, prefix: "So, " });
  assert.equal(outcome(route("Um, Luna, which build broke?")), "route:Luna");
  // A message that opens with a determiner but has no set-off phrase is still the message.
  assert.equal(outcome(route("So, Steve, the build is red.")), "route:Steve");
  assert.equal(outcome(route("Okay, Atlas, our staging box needs a restart.")), "route:Atlas");
  // A compound command after a prefix is dropped too: "and" cannot be told from a list. Without the
  // prefix the opening rule still routes it.
  assert.equal(route("Okay, Steve, check the build and run the tests.").kind, "ignored");
  assert.equal(route("Um, Luna, pull main and rebase.").kind, "ignored");
  assert.equal(outcome(route("Steve, check the build and run the tests.")), "route:Steve");
  // A coordinating word only counts as a word: "android" and "order" are not "and" and "or".
  assert.equal(outcome(route("Um, Luna, rebuild the android order screen.")), "route:Luna");
  // A closing courtesy word is the only thing a recovered message may set off with a comma.
  assert.equal(outcome(route("Um, Carol, deploy to staging, please.", true, PREFIX_AUDIO_ROSTER.map(agent))), "route:Carol");
  // A command with a second clause is dropped after a prefix, as the price of never sending a described name.
  assert.equal(route("Okay, Steve, check the build, then run the tests.").kind, "ignored");
  assert.equal(route("Um, Steve, check the build, and Luna, run the tests.").kind, "ignored");
  // Without the prefix the opening rule still routes it, asking split or mention with Steve fixed.
  assert.equal(outcome(route("Steve, check the build, and Luna, run the tests.")), "route:Steve");
});

test("timed words are read after the skipped ones, so the pause after the name is still measured", () => {
  const words = [["Um,", 0, 200], ["Steve,", 500, 800], ["check", 1100, 1300], ["the", 1300, 1400], ["build.", 1400, 1700]]
    .map(([text, startMs, endMs]) => ({ text: text as string, startMs: startMs as number, endMs: endMs as number }));
  const decision = route("Um, Steve, check the build.", true, scoutRoster, words);
  assert.equal(decision.kind === "addressed" && decision.pauseMs, 300);
});

test("a word recovery cannot vouch for, a misheard name or a second name asks; it never routes", () => {
  const ask = (text: string) => {
    const decision = route(text);
    assert.equal(decision.kind, "suggest", text);
    return decision.kind === "suggest" ? [decision.candidates.map(c => c.name), decision.text, decision.prefix] : [];
  };
  assert.deepEqual(ask("Fish. Steve, check the build."), [["Steve"], "check the build.", "Fish. "]);
  assert.deepEqual(ask("Uh, Steven, check the build."), [["Steve"], "check the build.", "Uh, "]);
  assert.deepEqual(ask("Um, Wil, check the build."), [["Will"], "check the build.", "Um, "]);
  // "The Atlas, our deploy box, is down." is grammatical, so a determiner asks unless its own boundary cuts it off.
  assert.deepEqual(ask("The Steve, check the build."), [["Steve"], "check the build.", "The "]);
  assert.equal(route("The. Steve, check the build.").kind, "addressed");
  // Every name heard is offered, and the message is what follows them.
  assert.deepEqual(ask("Um, Steve and Luna, check the build."), [["Steve", "Luna"], "check the build.", "Um, "]);
  assert.deepEqual(ask("Hey, Luna, Steve, run the tests."), [["Luna", "Steve"], "run the tests.", "Hey, "]);
  assert.deepEqual(ask("Uh, Steve or Luna, check the build."), [["Steve", "Luna"], "check the build.", "Uh, "]);
  // A phrase set off by commas after the names is left alone, here as everywhere: nothing is offered or sent.
  assert.equal(route("Uh, Steve or Luna, whoever is free, check the build.").kind, "ignored");
  // Fillers with no boundary after the name ask only for an exact name: a recognized "Uh can zoom." is not Quinn.
  assert.equal(route("Uh can zoom.", true, PREFIX_AUDIO_ROSTER.map(agent)).kind, "ignored");
  assert.equal(route("Uh Stevie check the build").kind, "ignored");
  const stop = route("Wait, Luna, stop.");
  assert.ok(stop.kind === "suggest" && stop.command === "stop");
});

test("ordinary speech that mentions an agent stays unrouted", () => {
  for (const text of ["So Steve said the build is fine.", "Okay Steve's pull request is merged.", "I think Steve broke the build.",
    "Tell Steve, check the build.", "Um, I told Steve, check the build.", "And Will you grab the door?", "So will we ship today?",
    "Okay, Atlas is the deploy box.", "The Sage advice is to wait.", "Thanks, Steve.", "Um, Steve.", "Um, Noah, check the build.",
    "Uh, Release, tag the build.", "Uh, so Steve's branch is merged.", "Honestly, Steve broke it again.",
    // With no boundary after the name, an address cannot be told from a mention, so neither is asked about.
    "Uh Steve broke it again.", "Uh Steve check the build", "Hmm Luna and I talked about it.",
    // Two people talked about, or a message relayed to two: no card, no prompt.
    "Um, Steve and Luna said the build is fine.", "So Steve or Luna broke it.", "Tell Steve and Luna, check the build.",
    "Ask Steve and Luna, check the build.", "Um, told Steve and Luna, check the build.",
    // A relative clause closed by its own comma describes the agent; it is not a message for it.
    "So, Steve, who is on call, said the build is fine.", "Okay, Atlas, which we deploy to, is down.",
    "Fish. Steve, whose branch broke, is out today.", "Um, Steve and Luna, who own the build, said it is fine.",
    // So does a noun phrase set off by its own commas.
    "So, Steve, our build lead, said the release is ready.", "Okay, Atlas, the deploy box, is down again.",
    "Oh, Luna, my teammate, fixed it.", "Uh, Nova, a new agent, joined today.", "Um, Steve and Luna, our reviewers, signed off.",
    // And any other phrase set off by commas right after the name.
    "So, Steve, after checking the logs, said the build was fine.", "Okay, Atlas, as usual, went down overnight.",
    "Um, Luna, honestly, did great work.", "Fish. Steve, last week, broke the build.",
    // Followed by a joining word, or longer than any fixed limit: any comma after a recovered name is left alone.
    "Okay, Steve, our build lead, also approved it.", "So, Steve, our build lead, and Luna fixed it.",
    "So, Steve, the engineer who reviewed every deployment log from last night's failed release, said the build was fine.",
    // The name opening a list of people is talked about, not addressed.
    "Okay, Steve, my brother and I approved it.", "So, Steve, Luna and Nova approved it.", "So, Steve, Luna and Bob approved it.", "Um, Steve, Release Captain and I signed off.",
    "Okay, Steve, you and the team did great.", "So, Steve, Carol or the release bot will merge it.",
    // Whatever joins the list: a person off the roster, a lowercase word, a list that starts late.
    "Okay, Steve, my brother and Bob approved it.", "Okay, Steve, my brother and bob approved it.",
    "So, Steve, my older brother Tom and Bob approved it.", "Um, Luna, Ana & Bob signed off."]) {
    assert.equal(route(text).kind, "ignored", text);
  }
});

test("recovery looks past at most two words: a call sign after three known openers stays unrouted", () => {
  assert.equal(outcome(route("Okay so Will, grab the logs.")), "route:Will");
  for (const text of ["Um, okay, so, Steve, check the build.", "Okay so yeah Steve, check the build.", "Uh um er Luna, run the tests.",
    "Okay so well, cancel."]) {
    assert.deepEqual(route(text), { kind: "ignored", reason: "no-name" }, text);
  }
  // A filler that sounds like a name is not one: "well" is not Will, so nothing is asked.
  assert.equal(route("Okay, well, cancel that.").kind, "ignored");
  assert.equal(route("Um, well, check the build.").kind, "ignored");
  // Not even as a question: three words in, a delimited name is still not offered.
  assert.equal(route("Fish fish fish. Steve, check the build.").kind, "ignored");
});

test("Cancel after a known filler is the Cancel control; after an unknown word it is left alone", () => {
  assert.deepEqual(route("Uh, cancel."), { kind: "control", command: "cancel", prefix: "Uh, " });
  assert.deepEqual(route("Uh, cancel.", false), { kind: "ignored", reason: "no-name" });
  assert.equal(route("Fish, cancel.").kind, "ignored");
  assert.deepEqual(route("Cancel."), { kind: "control", command: "cancel" });
});

test("with the flag off every recovery case is dropped exactly as the opening rule drops it", () => {
  for (const text of ["Um, Steve, check the build.", "Fish. Steve, check the build.", "Um, Steve and Luna, check the build."]) {
    assert.deepEqual(route(text, false), { kind: "ignored", reason: "no-name" });
  }
  assert.deepEqual(route("Um, Wil, check the build.", false), { kind: "ignored", reason: "no-name" });
});

test("a call sign that is itself a filler or opener still wins as the opening name", () => {
  const roster = ["Right", "Steve"].map(agent);
  assert.deepEqual(route("Right, check the build.", true, roster), { kind: "addressed", target: agent("Right"), match: "exact", text: "check the build.", pauseMs: null });
  assert.equal(outcome(route("Um, Right, check the build.", true, roster)), "route:Right");
  // A roster name is never skipped over: two names heard together are both offered.
  assert.equal(outcome(route("The Right Steve, check it.", true, roster)), "ask:Right/Steve");
});

function routerWith(prefixRecovery: boolean) {
  const steve = agent("Steve"), luna = agent("Luna");
  const cards: VoiceCard[] = [];
  const delivered: [string, string][] = [];
  const router = new VoiceRouter(() => ({ backend: "fluidaudio", mode: "listening", roster: [steve, luna], prefixRecovery }),
    () => ({ enabled: true, seconds: 30 }), { deliver: async (target, text) => { delivered.push([target.name, text]); return "queued"; } },
    card => cards.push(card));
  let id = 0;
  const say = async (text: string) => {
    const key = String(++id);
    await router.accept({ id: key, text, capturedAt: Date.now(), backend: "fluidaudio", words: [] });
    return key;
  };
  return { router, cards, delivered, say, entry: (key: string) => router.heard.list().find(entry => entry.id === key)! };
}

test("the router opens a normal card for a recovered address and Uh, cancel withdraws it", async t => {
  const { router, cards, say, entry } = routerWith(true);
  t.after(() => router.reset());
  const id = await say("Um, Steve, check the build.");
  assert.deepEqual([cards.at(-1)?.state, cards.at(-1)?.parts[0]?.target?.name, cards.at(-1)?.parts[0]?.text], ["pending", "Steve", "check the build."]);
  assert.deepEqual([entry(id).rule, entry(id).matchedName, entry(id).prefix], ["recovered-prefix", "Steve", "Um, "]);
  const cancel = await say("Uh, cancel.");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], [id, "cancelled"]);
  assert.deepEqual([entry(cancel).outcome, entry(cancel).rule, entry(cancel).detail], ["control", "cancel", id]);
});

test("the router asks on an unsure card, sends nothing until a pick, then sends the message after the name", async t => {
  const { router, cards, delivered, say, entry } = routerWith(true);
  t.after(() => router.reset());
  const id = await say("Fish. Steve, check the build.");
  const card = cards.at(-1)!;
  assert.deepEqual([card.state, card.reason, card.prefix, card.candidates.map(c => c.title), card.parts[0]?.text],
    ["unsure", "suggested-prefix", "Fish. ", ["Steve"], "Fish. Steve, check the build."]);
  assert.deepEqual([entry(id).rule, entry(id).suggested, entry(id).outcome], ["suggested-prefix", ["Steve"], "unsure"]);
  assert.deepEqual(delivered, []);
  // Speaking the name picks the row, the same as for any unsure card.
  await say("Steve");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state, cards.at(-1)?.parts[0]?.text], [id, "pending", "check the build."]);
  await router.sendNow(id);
  assert.deepEqual(delivered, [["Steve", "check the build."]]);
});

test("with the flag off the router drops the prefixed address and records why", async t => {
  const { router, cards, say, entry } = routerWith(false);
  t.after(() => router.reset());
  const id = await say("Um, Steve, check the build.");
  assert.deepEqual(cards, []);
  assert.deepEqual([entry(id).rule, entry(id).outcome, entry(id).prefix], ["no-name", "ignored", undefined]);
});

test("Recently heard marks the name after the skipped words and lists what an ask offered", () => {
  const base: HeardEntry = { id: "a", time: 0, text: "Um, Steve, check the build.", outcome: "pending", rule: "recovered-prefix",
    matchedName: "Steve", prefix: "Um, ", pauseMs: null, detail: "" };
  const recovered = renderToStaticMarkup(createElement("table", null, createElement("tbody", null,
    createElement(HeardRow, { entry: base, roster: [agent("Steve")], now: 0 }))));
  assert.match(recovered, /Um, <mark>Steve<\/mark>, check the build\./);
  assert.match(recovered, /Steve<\/strong>, after “Um”/);
  assert.match(recovered, /name after a filler/);
  const asked = renderToStaticMarkup(createElement("table", null, createElement("tbody", null,
    createElement(HeardRow, { entry: { ...base, text: "Um, Steve and Luna, check the build.", rule: "suggested-prefix", matchedName: null, outcome: "unsure", suggested: ["Steve", "Luna"] },
      roster: [agent("Steve")], now: 0 }))));
  assert.match(asked, /Asked: Steve or Luna/);
  assert.match(asked, /possible name after another word/);
  assert.match(asked, /Um, <mark>Steve<\/mark> and Luna/);
  // A recovered Cancel matched no name, so nothing is marked.
  const cancel = renderToStaticMarkup(createElement("table", null, createElement("tbody", null,
    createElement(HeardRow, { entry: { ...base, text: "Uh, cancel.", rule: "cancel", matchedName: null, outcome: "control", prefix: "Uh, " },
      roster: [agent("Steve")], now: 0 }))));
  assert.match(cancel, /<td>Uh, cancel\.<\/td>/);
});

test("a suggestion counts against the active-card limit: at capacity it opens nothing and is not consumed, below it opens", async t => {
  const { router, cards, say, entry } = routerWith(true);
  t.after(() => router.reset());
  // Fifty pending cards fill the router.
  const pending: string[] = [];
  for (let i = 0; i < 50; i++) pending.push(await say("Steve, check build " + i));
  assert.equal(cards.filter(card => card.state === "pending").length, 50);
  const published = cards.length;
  const suggestion = { id: "at-capacity", text: "Fish. Steve, check the build.", capturedAt: Date.now(), backend: "fluidaudio" as const, words: [] };
  assert.equal(await router.accept(suggestion), false);
  assert.equal(cards.length, published, "no card opened at capacity");
  assert.equal(router.heard.list().some(heard => heard.id === "at-capacity"), false, "the capture is not recorded, so a retry can still route it");
  // One slot frees: the same capture, retried, opens its unsure card.
  assert.ok(router.cancel(pending[0]!));
  assert.equal(await router.accept(suggestion), true);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state, cards.at(-1)?.reason], ["at-capacity", "unsure", "suggested-prefix"]);
  assert.deepEqual(entry("at-capacity").suggested, ["Steve"]);
});
