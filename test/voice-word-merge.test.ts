import assert from "node:assert/strict";
import test from "node:test";
import { rosterHotwords, tokenWords } from "../src/voice-listener/words.ts";

test("SentencePiece boundaries, continuations and punctuation retain token timing in milliseconds", () => {
  assert.deepEqual(tokenWords({ text: "Steve, check", tokens: ["▁St", "eve", ",", "▁", "check"],
    timestamps: [0, 0.08, 0.16, 0.20, 0.24], durations: [0.08, 0.08, 0, 0.04, 0.16] }), [
    { text: "Steve,", startMs: 0, endMs: 160 }, { text: "check", startMs: 240, endMs: 400 },
  ]);
});

test("hotwords encode only complete roster names, including multiword names", () => {
  assert.equal(rosterHotwords(["Steve", "Sea Star", "Unknown"], new Set(["▁s", "teve", "▁sea", "▁star"])),
    "▁s teve/▁sea ▁star");
});

test("malformed token timing discards even previously assembled words, while zero duration is valid", () => {
  const result = { text: "one two", tokens: ["▁one", "▁two"], timestamps: [0, 0.25], durations: [0.1, 0] };
  assert.deepEqual(tokenWords(result), [
    { text: "one", startMs: 0, endMs: 100 }, { text: "two", startMs: 250, endMs: 250 },
  ]);
  for (const field of ["timestamps", "durations"] as const) {
    const first = result[field][0]!;
    for (const timing of [[first], [first, -0.1], [first, NaN], [first, Infinity]]) {
      assert.deepEqual(tokenWords({ ...result, [field]: timing }), [], field + ": " + timing);
    }
  }
});
