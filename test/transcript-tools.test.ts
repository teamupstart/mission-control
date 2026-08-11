import { test } from "node:test";
import assert from "node:assert/strict";
import { commandName, toolChip, toolLineTarget, transcriptRows } from "../src/web/lib/tools.ts";
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

// Codex's shell tool. Its input is not a JSON object with a `command` field - it is a freeform
// script, and the command sits inside a `tools.exec_command({ ... })` call within it. Every one
// of these calls used to chip and line as the bare word `exec` with no command anywhere, which
// made a folded run of them - "codex executed 18 commands" - open onto eighteen useless rows.
test("codex's exec chips the command out of the script that wraps it", () => {
  const chip = toolChip({
    name: "exec",
    input: 'const r = await tools.exec_command({"cmd":"rg PersonaDirective src test","workdir":"/repo"});',
  });
  assert.deepEqual(chip, { name: "exec", detail: "rg", title: "rg PersonaDirective src test" });
});

test("codex's exec is read from an object literal, not just from JSON", () => {
  // The shape a real rollout carries most often: a JS object literal, so the key is UNQUOTED.
  // Requiring the quoted form left about a tenth of all calls bare for no reason a reader could
  // see - two calls written the same way by the same agent, one named and one not.
  const chip = toolChip({
    name: "exec",
    input: 'const r = await tools.exec_command({\n  cmd: "git status --short",\n  workdir: "/repo",\n});',
  });
  assert.deepEqual(chip, { name: "exec", detail: "git", title: "git status --short" });
});

test("a codex command cut off by the input cap is still named", () => {
  const chip = toolChip({ name: "exec", input: 'const r = await tools.exec_command({ cmd: "npm run build && npm run sm…' });
  assert.equal(chip.detail, "npm");
  assert.ok(chip.title.endsWith("…"), chip.title);
});

test("a codex call that is not a command line stays honestly bare", () => {
  // `apply_patch` rides the same `exec` tool, and its payload is a patch rather than a command.
  // There is no command to name, so the chip says the tool's name and stops - inventing one out
  // of the diff body would put a line in the record that was never run.
  const patch: ToolCall = {
    name: "exec",
    input: 'const patch = "*** Begin Patch\\n*** Update File: src/server/db.ts\\n@@\\n-const a = 1\\n";',
  };
  assert.deepEqual(toolChip(patch), { name: "exec", detail: null, title: "exec" });
  // And the record's LINE omits it rather than printing `exec exec`, which is the rule that
  // already governed a nameless Bash call.
  assert.equal(toolLineTarget(patch), null);
});

test("relaxing the key quoting for shell tools does not leak into the others", () => {
  // The unquoted-key match is opt-in per key set, and this is why: `name` and `query` are
  // generic keys, and a tool whose VALUE happens to contain `name: "..."` must not be chipped
  // after its own argument text.
  const chip = toolChip({
    name: "mcp__notes__append",
    input: '{"body":"add a field name: \\"owner\\" to the row"}',
  });
  assert.equal(chip.detail, null, "no key matched, so nothing is claimed");
});

test("path tools chip the basename, keeping the full path on hover", () => {
  const path = "/Users/j/repo/test/review-workflow.test.ts";
  // Real Edit input order: file_path is not first, so extraction must go by key.
  const chip = toolChip(call("Edit", { replace_all: false, file_path: path, old_string: "a" }));
  assert.deepEqual(chip, { name: "edit", detail: "review-workflow.test.ts", title: path });
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
    input: '{"command":"cd /repo\\ngit commit -m \\"document the workflow behavior and preserve th…',
  });
  assert.equal(chip.detail, "git");
  assert.ok(chip.title.startsWith("cd /repo\ngit commit"));
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

// ---- the folded run's span ----
//
// The terminal rendering prints `· 1m 04s` after a folded run, and this is the only
// elapsed number the transcript can honestly produce: `ToolCall` carries a name and a
// capped input and nothing else, so there is no per-call duration anywhere to read. What
// these pin is that the number means the span between two RECORDED turn timestamps, and
// that it never becomes something a presentation would have to guard against.

test("a folded run's span runs from its first turn to its last", () => {
  const rows = transcriptRows([
    msg({ ts: 1000, tools: [call("Bash", { command: "ls" })] }),
    msg({ ts: 2800, tools: [call("Bash", { command: "wc -l x" })] }),
    msg({ ts: 4200, tools: [call("Bash", { command: "curl -s u" })] }),
  ]);
  const folded = rows[0];
  assert.equal(folded?.kind, "tools");
  assert.equal(folded.ts, 1000, "the run starts where its first turn did");
  assert.equal(folded.endTs, 4200);
});

test("a run of one ends where it starts, so the presentation has no span to print", () => {
  const rows = transcriptRows([msg({ ts: 1000, tools: [call("Bash", { command: "ls" })] })]);
  const folded = rows[0];
  assert.equal(folded?.kind, "tools");
  assert.equal(folded.endTs, folded.ts, "a single turn invented a span");
});

test("an undated turn joining a dated run cannot drag the span backwards", () => {
  // `ts` is 0 when a record carried no timestamp, and 0 is "unknown" rather than 1970.
  // Taking it as the end would make `endTs - ts` negative, and a negative span is not a
  // shorter run - it is a number with no meaning.
  const rows = transcriptRows([
    msg({ ts: 5000, tools: [call("Bash", { command: "ls" })] }),
    msg({ ts: 0, tools: [call("Bash", { command: "pwd" })] }),
  ]);
  const folded = rows[0];
  assert.equal(folded?.kind, "tools");
  assert.equal(folded.endTs, 5000);
});
