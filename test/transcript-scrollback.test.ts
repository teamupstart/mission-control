import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptMessage } from "../src/shared/types.ts";
import { claudeTranscript, toMessage } from "../src/server/harness/claude/transcript.ts";
import { codexTranscript, parseCodexMessages } from "../src/server/harness/codex/transcript.ts";

// What is at stake: whether the operator can read a conversation they can see the agent
// having.
//
// Every read in `transcript.ts` used to be a tail or a forward walk, so the oldest turn
// the dashboard could display was whatever `initial` happened to reach - eighty turns,
// and nothing could ask for the eighty-first. Measured against this machine's own
// transcripts that hid 78% of a 369-turn session, and half of every conversation turn on
// the disk. The turns were never lost; nothing could request them.
//
// `before` is that request, and the properties worth pinning are about the SEAM between
// pages rather than about any one read. A page that starts a byte late drops a turn into
// a gap nobody can see. A page that starts a byte early renders one twice - and for a
// harness whose records carry no id, de-duplication cannot save it, because those ids are
// synthesized per parse batch and two reads never agree on them. So the assertions below
// are chained walks compared against the whole conversation, not spot checks on one page.

const dir = mkdtempSync(join(tmpdir(), "mission-scrollback-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Bytes of tool output per turn, so the fixture is mostly not conversation. */
const TOOL_BYTES = 32 * 1024;

/** A Claude transcript of `turns` user/assistant pairs, each dragging a fat tool record. */
function writeClaude(name: string, turns: number): { path: string; texts: string[] } {
  const path = join(dir, name);
  const lines: string[] = [];
  const texts: string[] = [];
  const filler = "x".repeat(TOOL_BYTES);
  for (let i = 0; i < turns; i++) {
    const ask = `ASK ${i}`;
    const say = `SAY ${i}`;
    texts.push(ask, say);
    const timestamp = new Date(i * 1000).toISOString();
    lines.push(JSON.stringify({ type: "user", uuid: `u${i}`, timestamp, message: { role: "user", content: ask } }));
    lines.push(
      JSON.stringify({
        type: "assistant",
        uuid: `a${i}`,
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text: say }] },
      }),
    );
    // A tool result carrying the bulk: dropped from the rendered conversation, but it is
    // what makes a byte window a bad proxy for a turn count.
    lines.push(
      JSON.stringify({
        type: "user",
        uuid: `t${i}`,
        timestamp,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: filler }] },
      }),
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return { path, texts };
}

/** A Codex rollout of the same shape - the harness whose synthesized ids cannot de-dupe. */
function writeCodex(name: string, turns: number): { path: string; texts: string[] } {
  const path = join(dir, name);
  const lines: string[] = [];
  const texts: string[] = [];
  const filler = "x".repeat(TOOL_BYTES);
  lines.push(
    JSON.stringify({
      type: "session_meta",
      timestamp: new Date(0).toISOString(),
      payload: { cwd: "/repo", session_id: "s1", timestamp: new Date(0).toISOString() },
    }),
  );
  for (let i = 0; i < turns; i++) {
    const ask = `ASK ${i}`;
    const say = `SAY ${i}`;
    texts.push(ask, say);
    const timestamp = new Date(i * 1000).toISOString();
    lines.push(JSON.stringify({ type: "event_msg", timestamp, payload: { type: "user_message", message: ask } }));
    lines.push(JSON.stringify({ type: "event_msg", timestamp, payload: { type: "agent_message", message: say } }));
    lines.push(
      JSON.stringify({
        type: "custom_tool_call",
        timestamp,
        payload: { call_id: `c${i}`, name: `tool-${i}`, arguments: JSON.stringify({ turn: i }) },
      }),
    );
    lines.push(
      JSON.stringify({ type: "response_item", timestamp, payload: { type: "custom_tool_call_output", call_id: `c${i}`, output: filler } }),
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return { path, texts };
}

const claude = claudeTranscript.messages!;
const codex = codexTranscript.messages!;

/** Only the turns that carry prose, so a boundary's synthetic tool-only row doesn't count. */
const spoken = (messages: TranscriptMessage[]): string[] =>
  messages.filter((m) => m.text).map((m) => m.text);

const complete = (messages: TranscriptMessage[]) =>
  messages.map((message) => ({
    role: message.role,
    text: message.text,
    tools: message.tools.map((tool) => ({ name: tool.name, input: tool.input })),
  }));

function wholeClaude(path: string): TranscriptMessage[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line) return [];
      const message = toMessage(JSON.parse(line));
      return message ? [message] : [];
    });
}

function wholeCodex(path: string): TranscriptMessage[] {
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return parseCodexMessages(records);
}

/**
 * Walk a whole session by chaining `before` from the stream's opening window.
 *
 * This is exactly what the panel does as the reader scrolls up, so it is the thing worth
 * testing: any per-page error compounds into the transcript the operator actually sees.
 */
function walkBack(
  read: { initial: (p: string) => { messages: TranscriptMessage[]; start: number; atStart: boolean } ;
          before: (p: string, o: number) => { messages: TranscriptMessage[]; start: number; end: number; atStart: boolean } },
  path: string,
): { messages: TranscriptMessage[]; texts: string[]; pages: number } {
  const init = read.initial(path);
  let messages = init.messages;
  let anchor = init.start;
  let atStart = init.atStart;
  let pages = 0;
  while (!atStart && anchor > 0) {
    const page = read.before(path, anchor);
    assert.equal(page.end, anchor, "a page must end exactly where the held history begins");
    assert.ok(page.start < anchor, "a page must move the anchor or the scroll-back never ends");
    messages = [...page.messages, ...messages];
    anchor = page.start;
    atStart = page.atStart;
    pages++;
    assert.ok(pages < 200, "walk did not terminate");
  }
  return { messages, texts: spoken(messages), pages };
}

test("scrolling back reaches every turn of a session far longer than one window", () => {
  // 300 turns, ~10MB: past INIT_LIMIT's 80 by enough that the tail is a small minority,
  // which is the shape that produced the report.
  const { path, texts } = writeClaude("long.jsonl", 300);
  assert.ok(statSync(path).size > 8 * 1024 * 1024, "fixture must dwarf the byte windows");

  const init = claude.initial(path);
  assert.ok(
    spoken(init.messages).length < texts.length,
    "precondition: the opening window must NOT already hold the whole conversation",
  );
  assert.equal(init.atStart, false, "and it must say that there is more above it");

  const walk = walkBack(claude, path);
  assert.ok(walk.pages > 1, "a session this long takes several pages to walk");
  assert.deepEqual(walk.texts, texts, "the walk reconstructs the conversation exactly");
  assert.deepEqual(complete(walk.messages), complete(wholeClaude(path)));
});

test("pages abut, so no turn is dropped into a gap or rendered twice", () => {
  const { path, texts } = writeClaude("seam.jsonl", 200);
  const walk = walkBack(claude, path);
  // Both halves of the seam property, stated as the failures they would be rather than
  // as a length: a duplicate is what an overlapping read produces, a gap what a read that
  // started late produces.
  assert.equal(new Set(walk.texts).size, walk.texts.length, "no turn appears twice");
  assert.deepEqual(walk.texts, texts, "and none is missing");
  assert.deepEqual(complete(walk.messages), complete(wholeClaude(path)));
});

test("a rollout walks back correctly even though its synthesized ids cannot de-dupe", () => {
  // Codex is the harness the seam has to be right for: most rollout records carry no id,
  // so theirs is minted per parse batch and two reads of the same bytes disagree about
  // it. De-duplication cannot rescue an overlap here - only exact adjacency can.
  const { path, texts } = writeCodex("rollout.jsonl", 200);
  const walk = walkBack(codex, path);
  assert.deepEqual(walk.texts, texts, "every turn, once, in order");
  assert.deepEqual(complete(walk.messages), complete(wholeCodex(path)));
});

test("a boundary between an agent message and tool call keeps one assistant turn", () => {
  const path = join(dir, "tool-seam.jsonl");
  const text = "A".repeat(600 * 1024);
  const records = [
    {
      type: "session_meta",
      timestamp: new Date(0).toISOString(),
      payload: { cwd: "/repo", session_id: "s1" },
    },
    {
      type: "event_msg",
      timestamp: new Date(1000).toISOString(),
      payload: { type: "agent_message", message: text },
    },
    {
      type: "custom_tool_call",
      timestamp: new Date(1000).toISOString(),
      payload: { call_id: "seam-tool", name: "shell", arguments: "pwd" },
    },
  ];
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const init = codex.initial(path);
  assert.deepEqual(complete(init.messages), complete(parseCodexMessages(records)));
  assert.equal(init.messages.length, 1);
  assert.deepEqual(init.messages[0]?.tools, [{ name: "shell", input: "pwd" }]);

  const window = codex.window(path, 12, 48);
  assert.deepEqual(complete(window.messages), complete(parseCodexMessages(records)));
});

test("the first page reports atStart, so the panel stops offering to load more", () => {
  const { path } = writeClaude("stop.jsonl", 120);
  const walk = walkBack(claude, path);
  // walkBack only exits when a page says atStart, so reaching here proves it terminates
  // on the file's own beginning rather than on the loop guard.
  assert.ok(walk.pages >= 1);
  const first = claude.before(path, 0);
  assert.deepEqual(first, { messages: [], start: 0, end: 0, atStart: true });
});

test("a short session comes back whole, with nothing older to ask for", () => {
  const { path, texts } = writeClaude("short.jsonl", 3);
  const init = claude.initial(path);
  assert.deepEqual(spoken(init.messages), texts);
  assert.equal(init.start, 0, "the window reaches the top of the file");
  assert.equal(init.atStart, true, "so the panel shows no scroll-back affordance at all");
});

test("initial reports the offset its own first turn begins at", () => {
  // The anchor has to name the first RETURNED turn. Trimming the result to a turn count
  // without moving `start` would leave it pointing at turns that were cut, and the next
  // page back would re-read - and re-render - every one of them.
  const { path } = writeClaude("anchor.jsonl", 150);
  const init = claude.initial(path);
  const page = claude.before(path, init.start);
  const overlap = new Set(page.messages.map((m) => m.id));
  for (const m of init.messages) {
    assert.equal(overlap.has(m.id), false, `turn ${m.id} was served by both the window and the page above it`);
  }
});

test("an anchor past EOF is clamped rather than throwing", () => {
  // What a cleared or rotated file looks like to a scroll-back request already in flight.
  const { path } = writeClaude("rotated.jsonl", 5);
  const size = statSync(path).size;
  const page = claude.before(path, size + 10_000);
  assert.ok(page.end <= size, "the range is clamped to what the file actually holds");
  assert.equal(page.atStart, true, "and the scroll-back ends cleanly instead of looping");
});

test("a missing file answers empty instead of throwing at the reader", () => {
  const page = claude.before(join(dir, "nope.jsonl"), 4096);
  assert.deepEqual(page, { messages: [], start: 0, end: 0, atStart: true });
});

test("a record larger than the scan ceiling cannot strand older history", () => {
  const path = join(dir, "oversized.jsonl");
  const early = JSON.stringify({
    type: "user",
    uuid: "early",
    timestamp: new Date(0).toISOString(),
    message: { role: "user", content: "EARLY" },
  });
  const oversized = JSON.stringify({
    type: "user",
    uuid: "oversized",
    timestamp: new Date(1000).toISOString(),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "huge", content: "x".repeat(17 * 1024 * 1024) }],
    },
  });
  const recent = JSON.stringify({
    type: "assistant",
    uuid: "recent",
    timestamp: new Date(2000).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "RECENT" }] },
  });
  writeFileSync(path, `${early}\n${oversized}\n${recent}\n`);

  const init = claude.initial(path);
  assert.deepEqual(spoken(init.messages), ["RECENT"]);
  const skipped = claude.before(path, init.start);
  assert.deepEqual(skipped.messages, []);
  assert.ok(skipped.start < skipped.end);
  assert.equal(skipped.atStart, false);
  const oldest = claude.before(path, skipped.start);
  assert.deepEqual(spoken(oldest.messages), ["EARLY"]);
  assert.equal(oldest.atStart, true);
});
