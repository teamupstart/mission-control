import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptMessage } from "../src/shared/types.ts";
import { claudeTranscript, toMessage } from "../src/server/harness/claude/transcript.ts";
import { codexTranscript, parseCodexMessages } from "../src/server/harness/codex/transcript.ts";
import { piMessages, piToMessage } from "../src/server/harness/pi/transcript.ts";
import type { TranscriptForwardPage } from "../src/server/harness/types.ts";

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

/** A pi transcript of the same shape - the third harness on the shared JSONL reader. */
function writePi(name: string, turns: number): { path: string; texts: string[] } {
  const path = join(dir, name);
  const lines: string[] = [];
  const texts: string[] = [];
  const filler = "x".repeat(TOOL_BYTES);
  for (let i = 0; i < turns; i++) {
    const ask = `ASK ${i}`;
    const say = `SAY ${i}`;
    texts.push(ask, say);
    const timestamp = new Date(i * 1000).toISOString();
    lines.push(
      JSON.stringify({ type: "message", id: `u${i}`, timestamp, message: { role: "user", content: ask } }),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        id: `a${i}`,
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text: say }] },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        id: `t${i}`,
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "tool_call", name: `tool-${i}`, arguments: { blob: filler } }],
        },
      }),
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return { path, texts };
}

/**
 * A rollout whose tool calls come in RUNS, with bulk between them.
 *
 * `writeCodex` puts one command in each turn, so no page boundary can ever fall inside a
 * run - which is exactly the case a forward page has to repair, because the whole-file
 * parse folds consecutive commands into ONE turn and a split would emit two.
 */
function writeCodexRuns(
  name: string,
  turns: number,
  toolsPerTurn: number,
): { path: string; texts: string[] } {
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
    for (let t = 0; t < toolsPerTurn; t++) {
      lines.push(
        JSON.stringify({
          type: "custom_tool_call",
          timestamp,
          payload: { call_id: `c${i}-${t}`, name: `tool-${i}-${t}`, arguments: JSON.stringify({ turn: i, step: t }) },
        }),
      );
      lines.push(
        JSON.stringify({
          type: "response_item",
          timestamp,
          payload: { type: "custom_tool_call_output", call_id: `c${i}-${t}`, output: filler },
        }),
      );
    }
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return { path, texts };
}

const claude = claudeTranscript.messages!;
const codex = codexTranscript.messages!;
const pi = piMessages;

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

function wholePi(path: string): TranscriptMessage[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line) return [];
      const message = piToMessage(JSON.parse(line));
      return message ? [message] : [];
    });
}

/**
 * Walk a whole session forward by chaining `after` from a byte anchor.
 *
 * `walkBack`'s mirror, and it exists to answer a different question. Scroll-back is
 * allowed to stop early - the reader simply sees less - so its walk is checked for
 * adjacency. A forward walk is what archive collection runs, so what it has to prove is
 * COMPLETENESS: chained pages must reconstruct the whole-file parse, or a prompt the
 * agent was given is silently absent from the record of what it was given.
 */
function walkForward(
  read: { after: (p: string, o: number, wantTurns?: number) => TranscriptForwardPage },
  path: string,
  from = 0,
  wantTurns?: number,
): { messages: TranscriptMessage[]; texts: string[]; pages: number } {
  let messages: TranscriptMessage[] = [];
  let anchor = from;
  let pages = 0;
  for (;;) {
    const page = read.after(path, anchor, wantTurns);
    assert.equal(page.start, anchor, "a page must begin exactly where the held history ends");
    assert.ok(page.end >= anchor, "a page may never hand back an anchor behind the one it was given");
    messages = [...messages, ...page.messages];
    pages++;
    if (page.atEnd) break;
    assert.ok(page.end > anchor, "an unfinished page must move the anchor or the walk never ends");
    anchor = page.end;
    assert.ok(pages < 400, "walk did not terminate");
  }
  return { messages, texts: spoken(messages), pages };
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

test("a boundary between an agent message and tool call keeps the run its own turn", () => {
  // A window that opens between the narration and the command it precedes must not merge them.
  // This used to assert the opposite - one turn carrying both - and that merge is what stopped
  // `transcriptRows` from ever folding a Codex run: the fold groups tool-ONLY turns, so a turn
  // carrying prose kept every command on its own line while Claude's collapsed into one record.
  //
  // What has to hold either way, and is the actual seam property, is the deepEqual below: a
  // windowed read agrees with a whole-file parse, so no command is dropped, duplicated, or
  // reattached to the wrong turn by the repair.
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
  assert.equal(init.messages.length, 2, "the narration and the run are two turns");
  assert.equal(init.messages[0]?.text, text, "the narration keeps its prose...");
  assert.deepEqual(init.messages[0]?.tools, [], "...and none of the commands");
  assert.equal(init.messages[1]?.text, "", "the run carries no prose, which is what lets it fold");
  assert.deepEqual(init.messages[1]?.tools, [{ name: "shell", input: "pwd" }]);

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

test("a page that parses to nothing still reaches back past its tool call to the narration", () => {
  // The seam repair walks BACKWARD from a page whose leading message is a tool-only assistant,
  // and it stops as soon as a batch will not join. The worry is what happens when the page
  // itself parses to nothing - a rollout's tool OUTPUT records carry no turn - because then
  // there is no leading message to join to, the walk stops on the `custom_tool_call` sitting
  // just above, and it looks as though the window can never reach the `agent_message` above
  // THAT.
  //
  // It reaches it, and this pins the reason: a batch that fails to join is DISCARDED
  // rather than emitted, so those records stay unread and the next page parses the tool
  // call and its narration together - one batch, correct grouping. The output record is
  // deliberately larger than the scan ceiling so growth cannot sidestep the case by simply
  // widening until it finds a turn.
  const path = join(dir, "empty-page-tool-seam.jsonl");
  const ts = new Date(0).toISOString();
  const records: unknown[] = [
    { type: "session_meta", timestamp: ts, payload: { cwd: "/repo", session_id: "s1", timestamp: ts } },
    { type: "event_msg", timestamp: ts, payload: { type: "user_message", message: "ASK" } },
    { type: "event_msg", timestamp: ts, payload: { type: "agent_message", message: "SAY" } },
    { type: "custom_tool_call", timestamp: ts, payload: { call_id: "c0", name: "shell", arguments: "ls" } },
    {
      type: "response_item",
      timestamp: ts,
      payload: { type: "custom_tool_call_output", call_id: "c0", output: "x".repeat(17 * 1024 * 1024) },
    },
  ];
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const init = codex.initial(path);
  assert.deepEqual(init.messages, [], "the opening window is pure tool output, so it renders nothing");
  assert.equal(init.atStart, false, "and it must not claim the session started here");

  const walk = walkBack(codex, path);
  assert.deepEqual(
    complete(walk.messages),
    complete(wholeCodex(path)),
    "the run lands directly after the turn it followed, exactly as a whole-file parse groups it",
  );
  assert.equal(walk.messages.length, 3, "ASK, the narration, and the run");
  assert.equal(walk.messages[1]?.text, "SAY");
  assert.deepEqual(walk.messages[2]?.tools, [{ name: "shell", input: "ls" }]);
  // The run is a turn of its own, which is the shape the fold needs - but it must sit BEHIND
  // its narration rather than leading the window, or a reader scrolled to here would meet a
  // stretch of commands with nothing saying what they were for. That is what the walk reaching
  // back past the tool call buys, and asserting the order is how it stays bought.
  assert.deepEqual(
    walk.messages.map((m) => (m.text ? "prose" : "run")),
    ["prose", "prose", "run"],
  );
});

// ---------------------------------------------------------------------------
// Forward paging (`after`)
//
// Scroll-back and archive collection want opposite guarantees out of the same
// machinery. A reader who cannot page further back sees less history, which is a
// disappointment; a collector that cannot page further forward writes a record of what an
// agent was told with turns missing from it, and nothing downstream can tell that record
// from a complete one. So the walks below assert reconstruction against a whole-file
// parse rather than adjacency alone, and they do it on all three harnesses, because all
// three reach this one reader.
// ---------------------------------------------------------------------------

test("paging forward from the top reaches every turn of a long Claude session", () => {
  const { path, texts } = writeClaude("forward-long.jsonl", 300);
  assert.ok(statSync(path).size > 8 * 1024 * 1024, "fixture must dwarf the byte windows");

  const walk = walkForward(claude, path);
  assert.ok(walk.pages > 1, "a session this long takes several pages to walk");
  assert.deepEqual(walk.texts, texts, "the walk reconstructs the conversation exactly");
  assert.deepEqual(complete(walk.messages), complete(wholeClaude(path)));
  assert.equal(new Set(walk.texts).size, walk.texts.length, "no turn appears twice");
});

test("paging forward through a rollout keeps runs whole across the page seam", () => {
  // The case `writeCodex` cannot produce: consecutive commands, with bulk between them, so
  // a page boundary lands INSIDE a run. A whole-file parse folds that run into one turn.
  // Without the trailing-edge repair the two halves arrive as two turns, which is the same
  // class of bug an overlap would be - a windowed read disagreeing with the file.
  //
  // The small turn budget is what makes the seam exist at all, and it is the point of the
  // case rather than a convenience: at the default budget `grow` widens until it holds 80
  // turns, which on a fixture this size is the whole file in one page - a walk that never
  // pages cannot demonstrate anything about a page boundary. Asserted below, so this stays
  // a seam test if the constants move.
  const { path, texts } = writeCodexRuns("forward-runs.jsonl", 60, 4);
  const walk = walkForward(codex, path, 0, 4);
  assert.ok(walk.pages > 4, "precondition: the budget must actually produce several seams");
  assert.deepEqual(walk.texts, texts, "every turn, once, in order");
  assert.deepEqual(
    complete(walk.messages),
    complete(wholeCodex(path)),
    "a forward walk agrees with a whole-file parse, runs included",
  );
});

test("paging forward reaches every turn of a long pi session", () => {
  const { path, texts } = writePi("forward-pi.jsonl", 200);
  const walk = walkForward(pi, path);
  assert.ok(walk.pages > 1, "a session this long takes several pages to walk");
  assert.deepEqual(walk.texts, texts, "every turn, once, in order");
  assert.deepEqual(complete(walk.messages), complete(wholePi(path)));
});

test("a forward page anchored mid-file reaches exactly the turns after it", () => {
  // The shape archive collection actually runs: the anchor is a byte offset recorded when
  // a task was delivered, and what must come back is everything after it and nothing
  // before it.
  const { path, texts } = writeClaude("forward-anchor.jsonl", 40);
  const first = claude.after(path, 0);
  assert.ok(first.messages.length > 0, "precondition: the first page carries turns");
  assert.equal(first.start, 0);

  const rest = walkForward(claude, path, first.end);
  assert.deepEqual(
    [...spoken(first.messages), ...rest.texts],
    texts,
    "the anchored remainder plus the first page is the whole conversation, with no seam",
  );
  for (const message of rest.messages) {
    assert.equal(
      first.messages.some((m) => m.id === message.id),
      false,
      `turn ${message.id} was served by both the first page and the walk after it`,
    );
  }
});

test("forward and backward walks of the same file agree", () => {
  // The strongest statement of the seam property available: two independent chained reads
  // over one file, from opposite ends, landing on the same conversation.
  const { path } = writeClaude("forward-both.jsonl", 120);
  const forward = walkForward(claude, path);
  const backward = walkBack(claude, path);
  assert.deepEqual(complete(forward.messages), complete(backward.messages));
});

test("a forward page over pure tool output is empty but still advances", () => {
  // The forward twin of the stranded-history case. A stretch of records that parse to no
  // turns must not read as the end of the conversation, or a collector stops at the first
  // long command and calls the rest of the session absent.
  const path = join(dir, "forward-oversized.jsonl");
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

  const walk = walkForward(claude, path);
  assert.deepEqual(walk.texts, ["EARLY", "RECENT"], "the record fatter than the ceiling is stepped over");
  assert.ok(walk.pages > 1, "and it took more than one page to step over it");
});

test("a trailing partial record is not a turn, and does not stall the walk", () => {
  // A writer caught mid-append. The bytes after the last newline are not a record yet, so
  // they must neither be parsed nor reported as more to read - a collector that trusted
  // `end === size` here would spin on a line that may never be completed.
  const path = join(dir, "forward-partial.jsonl");
  const done = JSON.stringify({
    type: "user",
    uuid: "done",
    timestamp: new Date(0).toISOString(),
    message: { role: "user", content: "DONE" },
  });
  writeFileSync(path, `${done}\n{"type":"user","uuid":"half"`);

  const page = claude.after(path, 0);
  assert.deepEqual(spoken(page.messages), ["DONE"], "only the complete record is a turn");
  assert.equal(page.atEnd, true, "the walk ends rather than offering the half-written line");
  assert.ok(page.end < statSync(path).size, "and the anchor stops at the last complete record");

  // The same anchor once the writer finishes: the partial line becomes a turn, and the
  // page that ended the walk did not consume the bytes it sat on.
  writeFileSync(path, `${done}\n${JSON.stringify({
    type: "user",
    uuid: "half",
    timestamp: new Date(1000).toISOString(),
    message: { role: "user", content: "LATER" },
  })}\n`);
  const resumed = claude.after(path, page.end);
  assert.deepEqual(spoken(resumed.messages), ["LATER"]);
  assert.equal(resumed.atEnd, true);
});

test("an anchor at or past EOF ends the walk instead of throwing", () => {
  const { path } = writeClaude("forward-eof.jsonl", 5);
  const size = statSync(path).size;
  assert.deepEqual(claude.after(path, size), { messages: [], start: size, end: size, atEnd: true });
  // Past EOF is a rotated or cleared file, and it is clamped rather than thrown, exactly
  // as `before` clamps an anchor above the file.
  const rotated = claude.after(path, size + 10_000);
  assert.deepEqual(rotated, { messages: [], start: size, end: size, atEnd: true });
});

test("a missing file answers an empty terminal page instead of throwing", () => {
  const page = claude.after(join(dir, "forward-nope.jsonl"), 4096);
  assert.deepEqual(page, { messages: [], start: 4096, end: 4096, atEnd: true });
});

test("a short session comes back in one page that says the walk is over", () => {
  const { path, texts } = writePi("forward-short.jsonl", 3);
  const page = pi.after(path, 0);
  assert.deepEqual(spoken(page.messages), texts);
  assert.equal(page.start, 0);
  assert.equal(page.atEnd, true, "so a collector stops after one read");
});
