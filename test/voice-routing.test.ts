import assert from "node:assert/strict";
import { test } from "node:test";
import { routeUtterance, VoiceUtteranceSchema, type VoiceCard, type VoiceUtterance } from "../src/shared/voice-routing.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";

function agent(name: string): SpokenName {
  return { name, key: "resident:" + name, kind: "resident", taskId: null, sessionId: null,
    role: "Review builds", colorId: null, agent: "claude", state: "not-running" };
}
const route = (text: string, names = ["Will", "Steve"], words: VoiceUtterance["words"] = [], unsureCards: VoiceCard[] = []) =>
  routeUtterance(VoiceUtteranceSchema.parse({ id: "one", capturedAt: 1, text, words, backend: "fluidaudio" }),
    { roster: names.map(agent), unsureCards });

test("the exact first word addresses Will with absent, adjacent, paused or overlapping timings", () => {
  for (const gap of [null, 0, 250, -80]) {
    for (const [text, body, nextWord] of [["Will you grab the door", "you grab the door", "you"], ["“wILL,”  Grab   the door!", "Grab   the door!", "Grab"]] as const) {
      const words = gap === null ? [] : [{ text: "Will", startMs: 0, endMs: 100 }, { text: nextWord, startMs: 100 + gap, endMs: 400 }];
      assert.deepEqual(route(text, undefined, words), { kind: "addressed", target: agent("Will"), match: "exact", text: body, pauseMs: gap });
    }
  }
});

test("a prefix and a later mention alone do not address an agent", () => {
  for (const name of ["Willow", "William"]) assert.equal(route("Will send it", [name]).kind, "ignored");
  assert.equal(route("Please ask Will").kind, "ignored");
});

test("phonetic variants and possessives address Steve, while an exact Steven wins", () => {
  for (const name of ["Steven", "Steve’s", "Stevie"]) {
    const decision = route(name + ", stop");
    assert.deepEqual(decision, { kind: "addressed", target: agent("Steve"), match: "phonetic", command: "stop", text: "stop", pauseMs: null });
  }
  assert.deepEqual(route("Steven review", ["Steve", "Steven"]), {
    kind: "addressed", target: agent("Steven"), match: "exact", text: "review", pauseMs: null,
  });
});

test("a unique exact first word keeps the target when the body mentions another agent", () => {
  assert.deepEqual(route("Will, ask Steve about the build"), {
    kind: "addressed", target: agent("Will"), match: "exact", text: "ask Steve about the build", pauseMs: null,
  });
});

test("two-word call signs and a subsequent agent name", () => {
  const decision = route("Release Captain, run tests", ["Release Captain"]);
  assert.equal(decision.kind, "addressed");
  if (decision.kind === "addressed") assert.equal(decision.text, "run tests");
  const second = route("Steven, ask Will to review");
  assert.equal(second.kind, "needs-model");
  if (second.kind === "needs-model") {
    assert.equal(second.reason, "second-name");
    assert.deepEqual(second.candidates.map((a) => a.name), ["Steve", "Will"]);
  }
});

test("a two-word call sign ends at the address comma for exact and phonetic matching", () => {
  for (const text of ["Release, Captain needs help", "Release,Captain needs help", "Release , Captain needs help"]) {
    assert.equal(route(text, ["Release Captain"]).kind, "ignored");
    assert.deepEqual(route(text, ["Release Captain", "Release"]), {
      kind: "addressed", target: agent("Release"), match: "exact", text: "Captain needs help", pauseMs: null,
    });
  }
  assert.equal(route("Steven, Captain needs help", ["Steve Captain"]).kind, "ignored");
  assert.equal(route("Steven Captain, run tests", ["Steve Captain"]).kind, "addressed");
});

test("later two-word roster mentions must be on the same side of a comma", () => {
  const roster = ["Steve", "Release Captain"];
  for (const body of ["ship the release, captain.", "ship the release,captain.", "ship the release , captain."]) {
    assert.deepEqual(route("Steven, " + body, roster), {
      kind: "addressed", target: agent("Steve"), match: "phonetic", text: body, pauseMs: null,
    });
  }
  const decision = route("Steven, ask Release Captain.", roster);
  assert.equal(decision.kind, "needs-model");
  if (decision.kind === "needs-model") assert.deepEqual(decision.candidates.map(({ name }) => name), roster);
});

test("the full phonetic call sign wins over a shorter phonetic match in either roster order", () => {
  const names = ["Steve", "Steve Captain"];
  for (const roster of [names, names.toReversed()]) {
    assert.deepEqual(route("Steven Captain, run tests", roster), {
      kind: "addressed", target: agent("Steve Captain"), match: "phonetic", text: "run tests", pauseMs: null,
    });
    assert.deepEqual(route("Steven, Captain needs help", roster), {
      kind: "addressed", target: agent("Steve"), match: "phonetic", text: "Captain needs help", pauseMs: null,
    });
    assert.deepEqual(route("Steven Captain, run tests", [...roster, "Steven"]), {
      kind: "addressed", target: agent("Steven"), match: "exact", text: "Captain, run tests", pauseMs: null,
    });
  }
});

test("weak spelling matches are ignored even when two names are equally close", () => {
  assert.deepEqual(route("Pat go", ["Cat"]), { kind: "ignored", reason: "near-miss", closest: "Cat" });
  for (const text of ["fill in the form", "till tomorrow"]) {
    assert.deepEqual(route(text, ["Will", "Bill"]), { kind: "ignored", reason: "near-miss" });
  }
  assert.deepEqual(route("Morning everyone"), { kind: "ignored", reason: "no-name" });
});

test("a bare cancel and a bare candidate name take precedence over addressing", () => {
  const unsure: VoiceCard = { id: "open", state: "unsure", parts: [], deadline: null, reason: "ambiguous-name", openQuestions: 0,
    candidates: [{ kind: "agent", id: "resident:Will", title: "Will", detail: "builds" }] };
  assert.deepEqual(route("Cancel!", ["Cancel"], [], [unsure]), { kind: "control", command: "cancel" });
  assert.deepEqual(route("Will.", undefined, [], [unsure]), { kind: "control", command: "pick", cardId: "open", candidateId: "resident:Will" });
  assert.equal(route("Will, ship it.", undefined, [], [unsure]).kind, "addressed");
});

test("punctuation around the address stays separate from the quoted message", () => {
  for (const [text, body] of [
    ['Will,"ship it"', '"ship it"'],
    ["Will,‘ship it’", "‘ship it’"],
    ["Will,' ship it '", "' ship it '"],
    ['"Will","ship it"', '"ship it"'],
    ['"Will"!,"ship it"', '"ship it"'],
    ['"Will,""ship it"', '"ship it"'],
    ["“Will,”  “ship   it!”", "“ship   it!”"],
    ["“Will,”, ???", "???"],
    ['「“Will,”」"ship it"', '"ship it"'],
  ] as const) {
    assert.deepEqual(route(text), { kind: "addressed", target: agent("Will"), match: "exact", text: body, pauseMs: null });
  }
});

test("Release wins the exact first word even when Release Captain is listed first", () => {
  assert.deepEqual(route("Release Captain, run tests", ["Release Captain", "Release"]), {
    kind: "addressed", target: agent("Release"), match: "exact", text: "Captain, run tests", pauseMs: null,
  });
});


test("a bare name without an unsure card has no message", () => {
  for (const text of ["Steve.", "Will?", "Steven,", "Release Captain"]) {
    assert.deepEqual(route(text, ["Steve", "Will", "Release Captain"]), { kind: "ignored", reason: "no-message" });
  }
});

test("a bare multiword call sign can pick a card but sends no message to its prefix", () => {
  const roster = ["Release", "Release Captain"];
  const unsure: VoiceCard = { id: "choice", state: "unsure", parts: [], deadline: null, reason: "ambiguous-name", openQuestions: 0,
    candidates: [{ kind: "agent", id: "captain", title: "Release Captain", detail: "" }] };
  for (const text of ["Release Captain", "“RELEASE   Captain?”"]) {
    assert.deepEqual(route(text, roster), { kind: "ignored", reason: "no-message" });
    assert.deepEqual(route(text, roster, [], [unsure]), {
      kind: "control", command: "pick", cardId: "choice", candidateId: "captain",
    });
  }
  assert.deepEqual(route("Release, Captain", roster), {
    kind: "addressed", target: agent("Release"), match: "exact", text: "Captain", pauseMs: null,
  });
});
