import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptWindow } from "../src/server/transcript.ts";

const dir = mkdtempSync(join(tmpdir(), "fleet-window-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** One JSONL transcript record for a user/assistant text turn. */
function turn(role: "user" | "assistant", text: string, i: number): string {
  return JSON.stringify({
    type: role,
    uuid: `${role}-${i}`,
    timestamp: new Date(0).toISOString(),
    message: { role, content: [{ type: "text", text }] },
  });
}

test("a small transcript is returned whole, not truncated", () => {
  const path = join(dir, "small.jsonl");
  writeFileSync(
    path,
    [turn("user", "the goal", 0), turn("assistant", "on it", 1), turn("user", "thanks", 2)].join("\n"),
  );
  const w = readTranscriptWindow(path);
  assert.equal(w.truncated, false);
  assert.equal(w.messages.length, 3);
  assert.equal(w.messages[0]?.text, "the goal");
  assert.equal(w.messages.at(-1)?.text, "thanks");
});

test("a large transcript returns the opening goal + recent tail, marked truncated", () => {
  const path = join(dir, "big.jsonl");
  const lines: string[] = [turn("user", "THE ORIGINAL GOAL", 0)];
  // Pad past the head+tail byte windows (~512KB) so the middle is elided.
  const filler = "x".repeat(1000);
  for (let i = 1; i <= 900; i++) lines.push(turn("assistant", `${filler} step ${i}`, i));
  lines.push(turn("assistant", "THE FINAL TURN", 901));
  writeFileSync(path, lines.join("\n"));

  const w = readTranscriptWindow(path, 12, 48);
  assert.equal(w.truncated, true);
  // The opening goal is always present (head window)...
  assert.equal(w.messages[0]?.text, "THE ORIGINAL GOAL");
  // ...and so is the most recent turn (tail window).
  assert.equal(w.messages.at(-1)?.text, "THE FINAL TURN");
  // Bounded: head (<=12) + tail (<=48), nowhere near all 902 turns.
  assert.ok(w.messages.length <= 60, `expected a bounded window, got ${w.messages.length}`);
});

test("a missing file yields an empty, non-truncated window", () => {
  const w = readTranscriptWindow(join(dir, "nope.jsonl"));
  assert.deepEqual(w, { messages: [], truncated: false });
});
