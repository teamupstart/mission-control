import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptMessage } from "../src/shared/types.ts";
import { observedActivity } from "../src/web/lib/conversation-activity.ts";
import { toolChip } from "../src/web/lib/tools.ts";

// The Observed activity projection: every loaded tool invocation, once, in transcript
// order, through the same display-safe chip the inline transcript uses. These are the
// rules the rail's honesty rests on, so they are pinned here rather than through a DOM.

function msg(over: Partial<TranscriptMessage> & { id: string }): TranscriptMessage {
  return { role: "assistant", text: "", tools: [], ts: 0, ...over };
}

test("includes tool calls attached to prose turns, not only tool-only turns", () => {
  // The main log's transcriptRows() folds tool-ONLY turns; a call riding a prose turn
  // stays inside its turn there. The rail must still see it - this is the case that
  // rules out deriving activity from the folded rows.
  const rows = observedActivity([
    msg({ id: "m1", text: "Let me look at the config first.", tools: [{ name: "Read", input: '{"file_path":"/repo/package.json"}' }], ts: 100 }),
    msg({ id: "m2", tools: [{ name: "Bash", input: '{"command":"ls -la"}' }], ts: 200 }),
  ]);
  assert.deepEqual(
    rows.map((r) => ({ name: r.name, detail: r.detail })),
    [
      { name: "read", detail: "package.json" },
      { name: "bash", detail: "ls" },
    ],
  );
});

test("flattens multiple calls in one message in tool-array order", () => {
  const rows = observedActivity([
    msg({
      id: "m1",
      tools: [
        { name: "Read", input: '{"file_path":"/a/first.ts"}' },
        { name: "Read", input: '{"file_path":"/a/second.ts"}' },
        { name: "Grep", input: '{"pattern":"observedActivity"}' },
      ],
      ts: 5,
    }),
  ]);
  assert.deepEqual(rows.map((r) => r.detail), ["first.ts", "second.ts", "observedActivity"]);
  assert.deepEqual(rows.map((r) => r.key), ["m1:0", "m1:1", "m1:2"]);
});

test("missing or unknown input degrades to the normalized tool name", () => {
  const rows = observedActivity([
    msg({ id: "m1", tools: [{ name: "Bash" }], ts: 1 }),
    msg({ id: "m2", tools: [{ name: "mcp__chrome-devtools__click", input: "not json at all" }], ts: 2 }),
  ]);
  assert.deepEqual(
    rows.map((r) => ({ name: r.name, detail: r.detail })),
    [
      { name: "bash", detail: null },
      { name: "chrome-devtools:click", detail: null },
    ],
  );
});

test("keeps transcript order and skips turns with no tools", () => {
  const rows = observedActivity([
    msg({ id: "m1", role: "user", text: "please check", ts: 1 }),
    msg({ id: "m2", tools: [{ name: "Glob", input: '{"pattern":"**/*.css"}' }], ts: 2 }),
    msg({ id: "m3", text: "found it", ts: 3 }),
    msg({ id: "m4", tools: [{ name: "Edit", input: '{"file_path":"/repo/src/web/styles.css"}' }], ts: 4 }),
  ]);
  assert.deepEqual(rows.map((r) => r.key), ["m2:0", "m4:0"]);
  assert.deepEqual(rows.map((r) => r.ts), [2, 4]);
});

test("projecting the same messages again yields identical rows, not duplicates", () => {
  // The rail derives from canonical transcript state on every render - there is no
  // second event cache to drift. Same input, same output, byte for byte.
  const messages = [
    msg({ id: "m1", text: "working", tools: [{ name: "Bash", input: '{"command":"npm test"}' }], ts: 10 }),
    msg({ id: "m2", tools: [{ name: "Write", input: '{"file_path":"/repo/notes.md"}' }], ts: 20 }),
  ];
  const first = observedActivity(messages);
  const second = observedActivity(messages);
  assert.equal(second.length, 2);
  assert.deepEqual(second, first);
});

test("older messages prepend ahead of current activity with their keys unchanged", () => {
  const older = msg({ id: "old1", tools: [{ name: "Read", input: '{"file_path":"/repo/OLD.md"}' }], ts: 1 });
  const current = msg({ id: "new1", tools: [{ name: "Bash", input: '{"command":"git status"}' }], ts: 100 });

  const before = observedActivity([current]);
  const after = observedActivity([older, current]);

  assert.deepEqual(after.map((r) => r.key), ["old1:0", "new1:0"]);
  // The rows the reader already had are byte-identical after the splice - a prepend
  // must not re-key or reorder what was on screen.
  assert.deepEqual(after.slice(1), before);
});

test("carries the message timestamp, including the explicit 0 for undated records", () => {
  const rows = observedActivity([
    msg({ id: "m1", tools: [{ name: "Bash", input: '{"command":"pwd"}' }], ts: 0 }),
    msg({ id: "m2", tools: [{ name: "Bash", input: '{"command":"whoami"}' }], ts: 1754500000000 }),
  ]);
  assert.deepEqual(rows.map((r) => r.ts), [0, 1754500000000]);
});

test("label and target agree with the inline transcript chip for the same call", () => {
  // One projection, two surfaces. If this ever fails, the rail and the chips have
  // grown separate normalization rules - the exact drift the shared helper prevents.
  const call = { name: "Bash", input: '{"command":"cd /repo && sqlite3 state.db .tables"}' };
  const [row] = observedActivity([msg({ id: "m1", tools: [call], ts: 1 })]);
  const chip = toolChip(call);
  assert.ok(row);
  assert.equal(row.name, chip.name);
  assert.equal(row.detail, chip.detail);
  assert.equal(row.title, chip.title);
});
