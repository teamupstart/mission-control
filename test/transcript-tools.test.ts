import { test } from "node:test";
import assert from "node:assert/strict";
import { commandName, toolChip, transcriptRows } from "../src/web/lib/tools.ts";
import type { ToolCall, TranscriptMessage } from "../src/shared/types.ts";

// The expanded card's tool-call presentation. The inputs below are real shapes lifted
// from ~/.claude/projects transcripts (key order and all - `Edit` really does put
// `replace_all` before `file_path`), because every one of these is a heuristic and the
// only thing that makes a heuristic honest is checking it against what actually arrives.

function call(name: string, input?: unknown): ToolCall {
  return input === undefined ? { name } : { name, input: JSON.stringify(input) };
}

let n = 0;
function msg(over: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return { id: `m${++n}`, role: "assistant", text: "", tools: [], ts: 0, ...over };
}

// ---- commandName ----

const COMMANDS: Array<[string, string | null]> = [
  ["ls", "ls"],
  ["ls -la /tmp", "ls"],
  ["npm test 2>&1 | tail -22", "npm"],
  // The wrapper isn't the story; what it runs is.
  ["npx tsx --test test/x.test.ts", "tsx"],
  ["sudo /usr/bin/git push", "git"],
  ["FOO=bar deploy.sh", "deploy.sh"],
  // Scaffolding is skipped - "cd" and a header "echo" are never why a call was made.
  ['cd /repo && sqlite3 -header state.sqlite "select 1"', "sqlite3"],
  ["export PATH=/x:$PATH; make build", "make"],
  ['echo "=== status ===" && git log --oneline', "git"],
  ["cd /repo\necho '=== tests ==='\nnpm test", "npm"],
  ["# check the daemon\nps aux | grep node", "ps"],
  // A separator INSIDE quotes is an argument's text, not structure. Splitting on it
  // named the fragment after it - `b"`, `world"`, `test"` - and it bit hardest on the
  // quoted `echo` header this whole heuristic is tuned around.
  ['echo "a|b" | wc -l', "wc"],
  ['echo "hello; world"', "echo"],
  ['echo "phase 1: build && test"', "echo"],
  ['cd /x; echo "phase 1: build && test"', "cd"],
  ["grep -c 'a;b' f.txt | wc -l", "grep"],
  // An unterminated quote is the truncated-input case (TOOL_INPUT_CAP): it swallows the
  // rest of the line rather than splitting inside it, and still names the command.
  ['git commit -m "wip; more to come', "git"],
  // ...but scaffolding still beats naming nothing at all.
  ["echo hello", "echo"],
  ["cd /repo", "cd"],
  ["mkdir -p .tmp && cat > .tmp/f <<'EOF'\nbody\nEOF", "mkdir"],
  ["curl -s https://example.com | jq '.data'", "curl"],
  // An assignment that swallows its segment leaves nothing to name there.
  ['f=$(ls -t *.jsonl | head -1); grep -c x "$f"', "grep"],
  ["   ", null],
];

test("commandName finds the command a shell line is about", () => {
  for (const [command, want] of COMMANDS) {
    assert.equal(commandName(command), want, command);
  }
});

// ---- toolChip ----

test("bash chips the command, not the tool name", () => {
  const chip = toolChip(call("Bash", { command: "ls -la", description: "List files" }));
  assert.deepEqual(chip, { name: "bash", detail: "ls", title: "ls -la" });
});

test("path tools chip the basename, keeping the full path on hover", () => {
  const path = "/Users/j/repo/test/nomistakes.test.ts";
  // Real Edit input order: file_path is not first, so extraction must go by key.
  const chip = toolChip(call("Edit", { replace_all: false, file_path: path, old_string: "a" }));
  assert.deepEqual(chip, { name: "edit", detail: "nomistakes.test.ts", title: path });
});

test("known tools chip their most telling field", () => {
  assert.equal(toolChip(call("Grep", { pattern: "tool_use", output_mode: "content" })).detail, "tool_use");
  assert.equal(toolChip(call("Task", { description: "Find flaky tests" })).detail, "Find flaky tests");
  assert.equal(toolChip(call("WebSearch", { query: "hono sse" })).detail, "hono sse");
});

test("an unknown tool falls back to a generic field, and MCP names read as server:tool", () => {
  const chip = toolChip(call("mcp__chrome-devtools__navigate_page", { url: "https://example.com" }));
  assert.deepEqual(chip, {
    name: "chrome-devtools:navigate_page",
    detail: "https://example.com",
    title: "https://example.com",
  });
});

test("a call with no usable input still chips its name", () => {
  assert.deepEqual(toolChip(call("TodoWrite")), { name: "todowrite", detail: null, title: "TodoWrite" });
  // The cap fell before the key, so there's genuinely nothing to say.
  assert.deepEqual(toolChip({ name: "Bash", input: '{"description":"run it","comm…' }), {
    name: "bash",
    detail: null,
    title: "Bash",
  });
});

test("a truncated input still yields the field that precedes the cut", () => {
  const chip = toolChip({ name: "Write", input: '{"file_path":"/a/b/c.ts","content":"export const x…' });
  assert.deepEqual(chip, { name: "write", detail: "c.ts", title: "/a/b/c.ts" });
});

// The calls that outrun TOOL_INPUT_CAP are the heredocs and long `--instructions`
// flags - the ones most worth naming. Measured on real transcripts, requiring a
// closing quote left 88 bash chips bare; reading the head of a cut value fixed all of
// them. The title says it's cut rather than pretending the command ended there.
test("a command cut off mid-value is still named, and its title admits the cut", () => {
  const chip = toolChip({
    name: "Bash",
    input: '{"command":"cd /repo\\nno-mistakes axi respond --action fix --findings a,b,c --instructions \\"th…',
  });
  assert.equal(chip.detail, "no-mistakes");
  assert.ok(chip.title.startsWith("cd /repo\nno-mistakes axi respond"));
  assert.ok(chip.title.endsWith("…"), chip.title);
});

test("a value cut mid-escape doesn't take the chip down with it", () => {
  // The cap can land between a backslash and the character it escapes.
  const chip = toolChip({ name: "Bash", input: '{"command":"git commit -m \\"fix: the thing\\\\…' });
  assert.equal(chip.detail, "git");
});

test("a long detail is capped for the chip but never for the title", () => {
  const command = `grep -rn "${"x".repeat(80)}" src`;
  const chip = toolChip(call("Bash", { command }));
  assert.equal(chip.name, "bash");
  assert.equal(chip.detail, "grep");
  assert.equal(chip.title, command);

  const pattern = "y".repeat(90);
  const long = toolChip(call("Grep", { pattern }));
  assert.ok(long.detail && long.detail.length <= 40, long.detail ?? "");
  assert.ok(long.detail?.endsWith("…"));
  assert.equal(long.title, pattern);
});

// ---- transcriptRows ----

test("consecutive tool-only turns fold into one row", () => {
  const rows = transcriptRows([
    msg({ role: "user", text: "do the thing" }),
    msg({ text: "I'll start by looking around.", tools: [call("Bash", { command: "ls" })] }),
    msg({ tools: [call("Bash", { command: "wc -l x" })] }),
    msg({ tools: [call("Bash", { command: "curl -s u" })] }),
    msg({ text: "Found it." }),
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ["turn", "turn", "tools", "turn"]);
  const folded = rows[2];
  assert.equal(folded?.kind, "tools");
  // The turn carrying prose keeps its own chips; only the bare runs merge.
  assert.deepEqual(folded.tools.map((t) => toolChip(t).detail), ["wc", "curl"]);
});

test("a folded row keeps the first turn's id, so a growing run holds its React key", () => {
  const a = msg({ tools: [call("Bash", { command: "ls" })] });
  const b = msg({ tools: [call("Bash", { command: "pwd" })] });
  assert.equal(transcriptRows([a])[0]?.id, a.id);
  assert.equal(transcriptRows([a, b])[0]?.id, a.id);
});

test("prose turns are never folded away", () => {
  const rows = transcriptRows([
    msg({ text: "one" }),
    msg({ text: "two", tools: [call("Bash", { command: "ls" })] }),
    msg({ role: "user", text: "three" }),
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ["turn", "turn", "turn"]);
});

test("a run split by prose stays split", () => {
  const rows = transcriptRows([
    msg({ tools: [call("Bash", { command: "ls" })] }),
    msg({ text: "Now the tests." }),
    msg({ tools: [call("Bash", { command: "npm test" })] }),
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ["tools", "turn", "tools"]);
});
