import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexTranscript } from "../src/server/harness/codex/transcript.ts";
import { claudeTranscript } from "../src/server/harness/claude/transcript.ts";
import type { TranscriptMessage } from "../src/shared/types.ts";

// What is at stake: the dashboard's conversation panel, and every reader that asks a
// harness "what has this session said".
//
// The windows in `transcript.ts` are byte arithmetic, and a byte window is only ever a
// PROXY for a turn count. How good a proxy it is belongs to the record shape: Claude's
// transcript spends ~98% of its bytes on records that ARE turns, a Codex rollout spends
// 99.7% of its bytes on tool output and reasoning. Tuned once against the first shape and
// reused for the second, a 512 KB tail carried SIX turns of a real twenty-eight turn
// session - and because a card open (and every EventSource reconnect, so every daemon
// restart) REPLACES the panel with that read, the operator watched most of a live
// conversation disappear from a file that still held all of it.
//
// So these fixtures are built the way a rollout actually is - a few hundred bytes of
// conversation buried in tens of kilobytes of tool output per turn - and every assertion
// here is about turns being COUNTED rather than bytes being budgeted.

const dir = mkdtempSync(join(tmpdir(), "mission-turn-budget-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Bytes of tool output written per turn, well past a turn's own few hundred. */
const TOOL_BYTES = 64 * 1024;

/**
 * A Codex rollout whose conversation is a rounding error on its size.
 *
 * One `session_meta` header, then per turn: a `user_message`, an `agent_message`, and a
 * `custom_tool_call` / `custom_tool_call_output` pair carrying the bulk. Returns the path
 * and the turn texts in order, so a test can assert on identity rather than on a count.
 */
function rolloutTurns(turns: number, from = 0): { lines: string[]; texts: string[] } {
  const lines: string[] = [];
  const texts: string[] = [];
  const filler = "x".repeat(TOOL_BYTES);
  for (let i = from; i < from + turns; i++) {
    const ask = `ASK ${i}`;
    const say = `SAY ${i}`;
    texts.push(ask, say);
    const ts = new Date(i * 1000).toISOString();
    lines.push(JSON.stringify({ type: "event_msg", timestamp: ts, payload: { type: "user_message", message: ask } }));
    lines.push(JSON.stringify({ type: "event_msg", timestamp: ts, payload: { type: "agent_message", message: say } }));
    lines.push(JSON.stringify({ type: "custom_tool_call", timestamp: ts, payload: { call_id: `c${i}`, name: "shell", arguments: "ls" } }));
    lines.push(JSON.stringify({ type: "response_item", timestamp: ts, payload: { type: "custom_tool_call_output", call_id: `c${i}`, output: filler } }));
  }
  return { lines, texts };
}

function writeRollout(name: string, turns: number): { path: string; texts: string[] } {
  const path = join(dir, name);
  const head = JSON.stringify({
    type: "session_meta",
    timestamp: new Date(0).toISOString(),
    payload: { cwd: "/repo", session_id: "s1", timestamp: new Date(0).toISOString() },
  });
  const { lines, texts } = rolloutTurns(turns);
  writeFileSync(path, `${[head, ...lines].join("\n")}\n`);
  return { path, texts };
}

const codex = codexTranscript.messages!;

/**
 * The turns that carry prose.
 *
 * A rollout turn parses to THREE messages, not two: the ask, the answer, and the run of
 * commands that answer led to. The run is a turn of its own precisely so the panel can fold it
 * into one record the way it folds Claude's - see `parseCodexMessages` - and it carries no text,
 * so the assertions below name what they mean rather than counting rows.
 *
 * That the run costs a slot in the turn budget is deliberate and shared: Claude's tool-only
 * turns have always cost one each, and a bound that skipped Codex's would be a bound on a
 * different thing per harness. Codex is the cheaper of the two here - consecutive calls
 * accumulate into ONE turn, so a stretch of eighteen commands spends one slot, not eighteen.
 */
const spoken = (messages: TranscriptMessage[]): string[] =>
  messages.filter((m) => m.text).map((m) => m.text);

/** How many of them are folded runs of commands. */
const runs = (messages: TranscriptMessage[]): number =>
  messages.filter((m) => !m.text && m.tools.length > 0).length;

test("a stream's initial view carries the conversation, not the last 512KB of tool output", () => {
  const { path, texts } = writeRollout("stream.jsonl", 24);
  // Comfortably past every byte window in transcript.ts, so the old arithmetic applied.
  assert.ok(statSync(path).size > 1024 * 1024, "fixture must exceed the byte windows to be a regression");

  const init = codex.initial(path);
  assert.deepEqual(spoken(init.messages), texts, "every turn in the file reaches the panel");
  assert.equal(runs(init.messages), 24, "and so does each turn's run of commands");
  assert.equal(init.pos, statSync(path).size, "the stream resumes at EOF, so no turn is replayed");
});

test("the opening ask survives a rollout whose head is nearly all tool output", () => {
  const { path, texts } = writeRollout("window.jsonl", 24);
  // Tail sized to hold the whole conversation - 200 is the ceiling the panel's own route
  // allows - because what this test is about is the BYTE windows, not the turn bound. A
  // rollout turn spends three slots (ask, answer, run), so a 48-turn tail would elide part of
  // this file and the elision, not the byte arithmetic, would be what the assertion measured.
  // The bound itself is the next test's subject.
  const w = codex.window(path, 12, 200);
  assert.equal(w.messages[0]?.text, texts[0], "the goal the human set is still the first turn");
  assert.deepEqual(spoken(w.messages), texts);
  assert.equal(w.truncated, false, "nothing was elided, so the reader must not be told it was");
});

test("a rollout longer than the turn budget is bounded, and reports its elision", () => {
  const { path, texts } = writeRollout("long.jsonl", 60); // 120 turns, past head+tail
  const w = codex.window(path, 12, 48);
  assert.equal(w.truncated, true);
  assert.equal(w.headCount, 12);
  assert.equal(w.messages.length, 60, "bounded by the turn counts asked for, not by bytes");
  assert.equal(w.messages[0]?.text, texts[0]);
  // The newest thing in this rollout is a run of commands, so the last MESSAGE carries no text.
  // What must still be reachable is the newest thing the agent said.
  assert.equal(spoken(w.messages).at(-1), texts.at(-1));
});

test("the grown head and tail never overlap, so synthesized ids stay unique", () => {
  // A rollout whose ids are all synthesized (no record carries one of its own), sized so
  // the tail has to grow well past its 384KB start. Head and tail are de-duped BY ID, and
  // a synthesized id is unique per parse BATCH - so two reads covering the same bytes
  // would each mint their own, and the same turn would render twice.
  const { path, texts } = writeRollout("overlap.jsonl", 30);
  // Whole-conversation tail, for the reason given above: an elided middle would hide the very
  // duplicate this test exists to catch.
  const w = codex.window(path, 12, 200);
  assert.equal(new Set(w.messages.map((m) => m.id)).size, w.messages.length, "duplicate ids");
  assert.deepEqual(spoken(w.messages), texts, "a turn rendered twice, or dropped");
  assert.equal(runs(w.messages), 30, "and every run came back exactly once too");
});

test("a work item's verify window reads its turns, not half a megabyte of one command", () => {
  const { path } = writeRollout("since.jsonl", 8);
  // The delivered item's anchor: EOF at the moment it was handed over, so an exact turn
  // boundary. The agent then does the work - eight more turns, each buried in tool
  // output. A verifier reading a byte-capped window here saw the tail of a single
  // command's stdout and concluded the session had done nothing.
  const offset = statSync(path).size;
  const more = rolloutTurns(8, 8);
  appendFileSync(path, `${more.lines.join("\n")}\n`);

  const s = codex.since(path, offset);
  assert.deepEqual(spoken(s.messages), more.texts, "the item's own turns, all of them");
  assert.equal(s.truncated, false);
  assert.equal(s.headCount, 0, "this window drops a prefix, never a middle");
});

test("a dense transcript still stops early - growth is a floor on turns, not a mandate to read", () => {
  // Claude's shape: every record is a turn, so the starting byte windows already hold far
  // more turns than were asked for and nothing grows. The guard is that this stays
  // BOUNDED - the fix must not turn every window into a whole-file read.
  const path = join(dir, "dense.jsonl");
  const lines: string[] = [];
  const filler = "y".repeat(1000);
  for (let i = 0; i < 900; i++) {
    lines.push(JSON.stringify({
      type: i % 2 === 0 ? "user" : "assistant",
      uuid: `u${i}`,
      timestamp: new Date(0).toISOString(),
      message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `${filler} ${i}` }] },
    }));
  }
  writeFileSync(path, lines.join("\n"));

  const w = claudeTranscript.messages!.window(path, 12, 48);
  assert.equal(w.messages.length, 60);
  assert.equal(w.truncated, true);
  assert.equal(w.headCount, 12);
  assert.equal(w.messages[0]?.text.endsWith(" 0"), true, "the opening turn");
  assert.equal(w.messages.at(-1)?.text.endsWith(" 899"), true, "the newest turn");
});
