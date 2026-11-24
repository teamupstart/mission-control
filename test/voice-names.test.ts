// Spoken names (contract C of the voice plan): what a name sounds like and why it may be risky to
// address by voice. Validation warns and never blocks, so these pin which warnings a name draws,
// not whether it is accepted. Steve against Stevie and Steven is the plan's own case: a sound
// added or dropped is "sounds like", and so is a possessive.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  keysSoundAlike,
  namesSoundAlike,
  phoneticKey,
  SPOKEN_NAME_MAX,
  SPOKEN_NAME_METER_STEPS,
  SpokenNameSchema,
  spokenNameMeter,
  spokenNameWarningLabel,
  spokenNameWarningText,
  validateSpokenName,
  VOICE_CONTROL_WORDS,
} from "../src/shared/voice-names.ts";
import { VOICE_COMMON_WORDS } from "../src/shared/voice-common-words.ts";

const kinds = (name: string, roster: { name: string }[] = []) => validateSpokenName(name, roster).map((warning) => warning.kind);

test("Steve, Stevie and Steve's share a key, and Steven is one sound more", () => {
  assert.equal(phoneticKey("Steve"), "STF");
  assert.equal(phoneticKey("Stevie"), "STF");
  assert.equal(phoneticKey("steve's"), "STF", "case and a possessive do not change what a name sounds like");
  assert.equal(phoneticKey("Steve’s"), "STF", "nor does a curly apostrophe");
  assert.equal(phoneticKey("Steven"), "STFN");
  assert.ok(keysSoundAlike("STF", "STFN"));
  assert.ok(namesSoundAlike("Steve", "Steven"));
  assert.ok(namesSoundAlike("Steve", "Stevie"));
});

test("each of Stevie and Steven draws sounds-like against a roster holding Steve, naming him", () => {
  const roster = [{ name: "Steve" }, { name: "Carol" }];
  for (const name of ["Stevie", "Steven", "steve"]) {
    const warnings = validateSpokenName(name, roster);
    assert.deepEqual(warnings.find((warning) => warning.kind === "sounds-like"), { kind: "sounds-like", names: ["Steve"] }, name);
  }
  assert.deepEqual(kinds("Alice", roster), [], "a distinctive name draws nothing");
  assert.deepEqual(kinds("Stevie", []), [], "with nobody else on the roster nothing sounds like it");
});

test("a sounds-like warning names every agent it could be heard as, once each", () => {
  const warnings = validateSpokenName("Steven", [{ name: "Steve" }, { name: "Stevie" }, { name: "steve" }]);
  assert.deepEqual(warnings, [{ kind: "sounds-like", names: ["Steve", "Stevie"] }]);
  assert.equal(spokenNameWarningLabel(warnings[0]!), "Sounds like Steve or Stevie");
  assert.match(spokenNameWarningText(warnings[0]!, "Steven"), /heard as Steve or Stevie, which another agent answers to/);
});

test("sounds-like needs the same first sound, and a swapped sound only counts on longer keys", () => {
  assert.equal(keysSoundAlike("MKS", "RKS"), false, "rhymes start differently: Max and Rex");
  assert.equal(keysSoundAlike("STP", "STF"), false, "one swapped sound in three is too different: Stop and Steve");
  assert.equal(keysSoundAlike("MRTN", "MRFN"), true, "one swapped sound in four: Martin and Marvin");
  assert.equal(keysSoundAlike("AL", "ALF"), false, "a two-code key must match exactly");
  assert.equal(keysSoundAlike("P", "P"), true, "Bo and Po are the same key");
  assert.equal(keysSoundAlike("", ""), false, "a name with no letters sounds like nothing");
  assert.equal(namesSoundAlike("Max", "Rex"), false);
});

test("a name that starts the way another starts sounds like it, since speech is routed by its first word", () => {
  assert.equal(phoneticKey("Release Captain"), "RLS KPTN");
  assert.ok(namesSoundAlike("Release", "Release Captain"));
  assert.ok(namesSoundAlike("Captain Hook", "Captain Marvel"));
  assert.equal(namesSoundAlike("Release Captain", "Steve"), false);
});

test("common-word: a one-word everyday word, including a first name that is one", () => {
  assert.deepEqual(kinds("Will"), ["common-word", "short"], "Will is both");
  assert.deepEqual(kinds("Grace"), ["common-word"]);
  assert.deepEqual(kinds("Sage"), ["common-word", "short"]);
  assert.deepEqual(kinds("Carol"), [], "a word nobody starts a sentence with by accident is not on the list");
  assert.deepEqual(kinds("Atlas"), [], "the field's own example is distinctive");
  assert.deepEqual(kinds("Will Turner"), [], "a two-word name is not a word speech starts with");
  for (const word of VOICE_COMMON_WORDS) assert.match(word, /^[a-z]+$/, `${word} is one lowercase word`);
});

test("short: one syllable and four letters or fewer", () => {
  assert.deepEqual(kinds("Bo"), ["short"]);
  assert.deepEqual(kinds("Kai"), ["short"]);
  assert.deepEqual(kinds("Jade"), ["common-word", "short"], "a silent final e is no syllable");
  assert.deepEqual(kinds("Steve"), [], "five letters is not short, though it is one syllable");
  assert.deepEqual(kinds("Ada"), [], "two syllables is not short");
  assert.deepEqual(kinds("Otto"), []);
});

test("control-word: a name that is, or sounds like, a word voice listens for on its own", () => {
  assert.deepEqual([...VOICE_CONTROL_WORDS], ["cancel", "stop", "reply", "answer", "submit", "option", "no"]);
  for (const word of VOICE_CONTROL_WORDS) {
    const warning = validateSpokenName(word[0]!.toUpperCase() + word.slice(1))[0];
    assert.deepEqual(warning, { kind: "control-word", word }, word);
  }
  assert.deepEqual(validateSpokenName("Noah")[0], { kind: "control-word", word: "no" }, "Noah can be heard as no");
  assert.deepEqual(validateSpokenName("Reply Bot")[0], { kind: "control-word", word: "reply" }, "a first word that is a command");
  // Sounds like by the rule routing compares keys with (`keysSoundAlike`), not only the same key.
  assert.deepEqual(validateSpokenName("Stopper")[0], { kind: "control-word", word: "stop" }, "STPR is stop's STP and one sound more");
  assert.deepEqual(validateSpokenName("Summit")[0], { kind: "control-word", word: "submit" });
  assert.deepEqual(validateSpokenName("Steve"), [], "Stop and Steve still differ: one swapped sound in three");
  assert.equal(spokenNameWarningLabel({ kind: "control-word", word: "stop" }), "Voice command");
  assert.match(spokenNameWarningText({ kind: "control-word", word: "stop" }, "Stop"), /“stop” is a word voice listens for/);
});

test("a name with no letters a to z is still warned when another agent answers to the same name", () => {
  assert.deepEqual(validateSpokenName("サクラ", [{ name: "サクラ" }, { name: "Steve" }]), [{ kind: "sounds-like", names: ["サクラ"] }]);
  for (const name of ["!!!", "✨"]) assert.deepEqual(validateSpokenName(name), [{ kind: "symbols-only" }]);
  assert.deepEqual(validateSpokenName("١٢"), []);
  assert.deepEqual(validateSpokenName(" サクラ ", [{ name: "サクラ" }]), [{ kind: "sounds-like", names: ["サクラ"] }], "compared trimmed");
  assert.deepEqual(validateSpokenName("サクラ", [{ name: "ハナ" }]), [], "it has no key to sound like anything by");
  assert.deepEqual(validateSpokenName("   ", [{ name: "サクラ" }]), [], "a blank name still draws nothing");
});

test("warnings come riskiest first, and the meter loses a step for each", () => {
  const warnings = validateSpokenName("Stop", [{ name: "Stop" }]);
  assert.deepEqual(warnings.map((warning) => warning.kind), ["control-word", "sounds-like", "common-word", "short"]);
  assert.equal(SPOKEN_NAME_METER_STEPS, 4);
  assert.equal(spokenNameMeter(warnings), 0);
  assert.equal(spokenNameMeter(validateSpokenName("Will")), 2);
  assert.equal(spokenNameMeter(validateSpokenName("Alice")), 4);
  assert.deepEqual(validateSpokenName("   "), [], "a blank name has nothing to warn about");
});

test("every warning says the name can be kept", () => {
  for (const warning of [
    { kind: "control-word", word: "no" },
    { kind: "sounds-like", names: ["Steve"] },
    { kind: "common-word" },
    { kind: "short" },
  ] as const) {
    assert.match(spokenNameWarningText(warning, "Name"), /You can keep it/, warning.kind);
  }
  assert.match(spokenNameWarningText({ kind: "common-word" }, " Will "), /“Will you grab the door[?]”/);
});

test("a stored spoken name is trimmed, single-spaced, one line and at most 40 characters", () => {
  assert.equal(SpokenNameSchema.parse("  Atlas   Prime "), "Atlas Prime");
  assert.equal(SpokenNameSchema.parse("Atlas\nPrime"), "Atlas Prime", "a line break is whitespace, collapsed");
  assert.equal(SpokenNameSchema.safeParse("   ").success, false);
  assert.equal(SpokenNameSchema.safeParse("x".repeat(SPOKEN_NAME_MAX)).success, true);
  assert.equal(SpokenNameSchema.safeParse("x".repeat(SPOKEN_NAME_MAX + 1)).success, false);
});

test("a resident's reference name is optional, and clearing it saves it blank so the next revision does not bring it back", async () => {
  const { ResidentProfileRevisionSchema, preserveUnknownResidentSettings } = await import("../src/shared/residents.ts");
  const base = { identity: { name: "Release Captain" }, persona: { personaId: "p" } };
  const before = ResidentProfileRevisionSchema.parse(base);
  assert.equal("referenceName" in before.identity, false, "a revision saved before the field parses exactly as before");
  const named = ResidentProfileRevisionSchema.parse({ ...base, identity: { name: "Release Captain", referenceName: "  Sage " } });
  assert.equal(named.identity.referenceName, "Sage");
  const cleared = ResidentProfileRevisionSchema.parse({ ...base, identity: { name: "Release Captain", referenceName: "  " } });
  assert.equal(cleared.identity.referenceName, "", "blank is none");
  const saved = preserveUnknownResidentSettings(named, cleared) as typeof cleared;
  assert.equal(saved.identity.referenceName, "", "the blank is kept over the previous revision's name");
  const omitted = preserveUnknownResidentSettings(named, before) as typeof before;
  assert.equal(omitted.identity.referenceName, "Sage", "an omitted key is carried forward, which is why clearing writes it");
  assert.equal(ResidentProfileRevisionSchema.safeParse({ ...base, identity: { name: "R", referenceName: "x".repeat(41) } }).success, false);
});
