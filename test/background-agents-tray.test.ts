import { test } from "node:test";
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentEntry, SubagentSummary, TranscriptMessage } from "../src/shared/types.ts";
import { SUBAGENT_LIMIT } from "../src/shared/subagents.ts";
import {
  claudeSubagentLaunch,
  launchScanCostSoFar,
  resetLaunchIndexes,
  toMessage,
} from "../src/server/harness/claude/transcript.ts";
import {
  BackgroundAgentsTray,
  backgroundAgentsHeadline,
  type LaunchSearch,
} from "../src/web/components/BackgroundAgentsTray.tsx";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import { launchStep, type LaunchHistory } from "../src/web/lib/launch-lookup.ts";
import { transcriptRows, turnForToolUse } from "../src/web/lib/tools.ts";
import { resetHistories, seedTail } from "../src/web/lib/transcript-history.ts";
import { mkSession } from "./helpers/session-fixture.ts";

/**
 * Phase 2 of background sub-agent visibility: the conversation's Background agents tray and
 * its Jump to launch. The browser spec drives the tray a person uses; these pin the pieces a
 * browser cannot isolate - the launch id read off the transcript, the folded row that keeps
 * every turn it holds, the search's stopping rules, and the tray's exact markup.
 */

function agent(over: Partial<SubagentEntry> & { id: string }): SubagentEntry {
  return {
    type: "Explore",
    description: `Agent ${over.id}`,
    state: "running",
    startedAt: 1_000,
    endedAt: null,
    toolUses: null,
    tokens: null,
    lastTool: null,
    summary: null,
    launchTurnId: null,
    ...over,
  };
}

function msg(over: Partial<TranscriptMessage> & { id: string }): TranscriptMessage {
  return { role: "assistant", text: "", tools: [], ts: 0, ...over };
}

function tray(subagents: SubagentSummary | undefined, launches?: ReadonlyMap<string, LaunchSearch>): string {
  return renderToStaticMarkup(createElement(BackgroundAgentsTray, { session: { subagents }, launches }));
}

const SAMPLE: SubagentSummary = {
  agents: [
    agent({
      id: "a1",
      description: "Map every offset-pagination call site",
      toolUses: 18,
      lastTool: "Grep",
      launchTurnId: "toolu_a1",
    }),
    agent({ id: "a2", type: "general-purpose", description: "Convert billing report queries", toolUses: 6, lastTool: "Edit" }),
    agent({
      id: "a3",
      description: "Find contract tests for /ledger",
      state: "completed",
      endedAt: 66_000,
      toolUses: 9,
      launchTurnId: "toolu_a3",
    }),
  ],
  finishedFolded: 2,
};

// ---- the launch id, read off the transcript ----

test("a Claude tool_use keeps its block id, which is what the SDK names a launch by", () => {
  const message = toMessage({
    type: "assistant",
    uuid: "rec-1",
    timestamp: "2026-11-12T10:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_launch", name: "Agent", input: { description: "Map call sites" } }],
    },
  });
  assert.ok(message);
  assert.equal(message.tools[0]?.id, "toolu_launch");
  assert.equal(message.tools[0]?.name, "Agent");
});

test("a tool_use without an id reads exactly as before, with no id key at all", () => {
  const message = toMessage({
    type: "assistant",
    uuid: "rec-2",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
  });
  assert.deepEqual(message?.tools, [{ name: "Bash" }]);
});

test("turnForToolUse finds the turn that made a call, and nothing for a call no loaded turn made", () => {
  const messages = [
    msg({ id: "prose", text: "Launching", tools: [] }),
    msg({ id: "t1", tools: [{ name: "Read", id: "toolu_read" }] }),
    msg({ id: "t2", tools: [{ name: "Agent", id: "toolu_launch" }] }),
  ];
  assert.equal(turnForToolUse(messages, "toolu_launch"), "t2");
  assert.equal(turnForToolUse(messages, "toolu_elsewhere"), null);
});

// ---- every turn a folded row holds stays jumpable ----

test("a folded tool row lists every turn it holds, first one first", () => {
  const rows = transcriptRows([
    msg({ id: "prose", text: "Launching" }),
    msg({ id: "t1", tools: [{ name: "Read" }] }),
    msg({ id: "t2", tools: [{ name: "Agent", id: "toolu_a" }] }),
    msg({ id: "t3", tools: [{ name: "Agent", id: "toolu_b" }] }),
    msg({ id: "after", text: "Done" }),
  ]);
  const folded = rows[1];
  assert.equal(folded?.kind, "tools");
  if (folded?.kind !== "tools") return;
  assert.equal(folded.id, "t1", "the row keeps its first turn's id, so its key is stable");
  assert.deepEqual(folded.turnIds, ["t1", "t2", "t3"]);
  assert.deepEqual(folded.tools.map((t) => t.id), [undefined, "toolu_a", "toolu_b"]);
});

test("the panel tags a folded row with every turn it holds, and a launch inside it resolves to one of them", () => {
  resetHistories();
  const messages = [
    msg({ id: "u0", role: "user", text: "Launch the agents", ts: 1 }),
    msg({ id: "prose", text: "Launching", ts: 2 }),
    msg({ id: "t1", tools: [{ name: "Read", id: "toolu_read" }], ts: 3 }),
    msg({ id: "t2", tools: [{ name: "Agent", id: "toolu_a1" }], ts: 4 }),
    msg({ id: "t3", tools: [{ name: "Agent", id: "toolu_a3" }], ts: 5 }),
  ];
  seedTail("tray-1", { messages, start: 0, atStart: true, pos: 100 });
  const html = renderToStaticMarkup(
    createElement(TranscriptPanel, {
      session: mkSession({ id: "tray-1", state: "idle", subagents: SAMPLE }),
      canSend: true,
    }),
  );
  assert.match(html, /data-turn-ids="t1 t2 t3"/);
  // The launch named by the tray's first row is a turn with no element of its own.
  assert.equal(turnForToolUse(messages, "toolu_a1"), "t2");
});

// ---- the search's stopping rules ----

const HISTORY: LaunchHistory = { canLoadOlder: true, loadingOlder: false, failed: false, stalled: false };
/** The whole transcript is loaded: nothing older to page in. */
const AT_START: LaunchHistory = { ...HISTORY, canLoadOlder: false };
const LOADED = [msg({ id: "t2", tools: [{ name: "Agent", id: "toolu_a1" }] })];
const OLD = "toolu_old";

test("a loaded launch is found without paging", () => {
  assert.deepEqual(launchStep(LOADED, "toolu_a1", HISTORY), { kind: "found", turnId: "t2" });
  // Found wins even while a page is in flight or the start has been reached.
  assert.deepEqual(launchStep(LOADED, "toolu_a1", { ...HISTORY, loadingOlder: true, canLoadOlder: false }), {
    kind: "found",
    turnId: "t2",
  });
});

test("a launch outside the loaded window pages older turns in, one at a time", () => {
  assert.deepEqual(launchStep(LOADED, OLD, HISTORY), { kind: "load" });
  assert.deepEqual(launchStep(LOADED, OLD, { ...HISTORY, loadingOlder: true }), { kind: "wait" });
});

test("the search stops at the transcript's start, on a failed page, and when paging stops advancing", () => {
  assert.deepEqual(launchStep(LOADED, OLD, AT_START), { kind: "miss", reason: "missing" });
  assert.deepEqual(launchStep(LOADED, OLD, { ...HISTORY, failed: true }), { kind: "miss", reason: "error" });
  // A page that landed without adding turns would be asked for again forever.
  assert.deepEqual(launchStep(LOADED, OLD, { ...HISTORY, stalled: true }), { kind: "miss", reason: "error" });
  // A start reached on that same step is the start, not a stall.
  assert.deepEqual(launchStep(LOADED, OLD, { ...AT_START, stalled: true }), { kind: "miss", reason: "missing" });
});

test("no page count ends a search: a launch 60 pages back is reached, one page at a time", () => {
  // A history of 60 pages, the launch on the oldest - past the 40-page cap this once had. The
  // panel's part is played here: each "load" prepends the next older page, and the search sees
  // the paging state change as it would, until the launch arrives.
  const pages = Array.from({ length: 60 }, (_, p) => [msg({ id: `p${p}`, tools: [{ name: "Read", id: `toolu_read_${p}` }] })]);
  pages[0] = [msg({ id: "launch-turn", tools: [{ name: "Agent", id: "toolu_far" }] })];
  let next = pages.length - 1;
  let loaded = pages[next]!;
  let loads = 0;
  for (;;) {
    const step = launchStep(loaded, "toolu_far", { ...HISTORY, canLoadOlder: next > 0 });
    if (step.kind !== "load") {
      assert.deepEqual(step, { kind: "found", turnId: "launch-turn" });
      break;
    }
    loads += 1;
    next -= 1;
    loaded = [...pages[next]!, ...loaded];
  }
  assert.equal(loads, 59, "every older page was asked for, and none past the launch");
});

// ---- an agent whose source did not name the launching call: its call, read from the file ----

/** An assistant record making one Agent call. */
const agentCall = (uuid: string, toolUseId: string, description: string) => ({
  type: "assistant",
  uuid,
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description, prompt: "Do it", subagent_type: "Explore" } }],
  },
});

/** The user record Claude Code answers a backgrounded Agent call with, as the CLI writes it. */
const asyncLaunched = (toolUseId: string, agentId: string, structured = true) => ({
  type: "user",
  uuid: `result-${toolUseId}`,
  message: {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: toolUseId,
      content: [{
        type: "text",
        text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)\nThe agent is working in the background.`,
      }],
    }],
  },
  ...(structured ? { toolUseResult: { isAsync: true, status: "async_launched", agentId, description: "x" } } : {}),
});

/** A transcript file holding these records, one per line, in a fresh temp dir. */
function transcriptFile(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mission-launch-scan-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

test("the file records which call launched an agent: from the structured result, or the result text alone", async () => {
  const path = transcriptFile([
    agentCall("rec-1", "toolu_1", "Scan the ledger"),
    asyncLaunched("toolu_1", "agent-1"),
    agentCall("rec-2", "toolu_2", "Scan the ledger"),
    asyncLaunched("toolu_2", "agent-2", false),
  ]);
  assert.equal(await claudeSubagentLaunch(path, "agent-1"), "toolu_1");
  assert.equal(await claudeSubagentLaunch(path, "agent-2"), "toolu_2");
  // Neither result is drawn as a turn: the conversation still reads one turn per call.
  assert.equal(toMessage(asyncLaunched("toolu_1", "agent-1")), null);
});

test("an agent no call is recorded as launching is never given another, whatever it shares with it", async () => {
  // A finished agent folded out of the tray left its call and its result behind, with the
  // description the running agent shares. The running agent's own launch is not in the file.
  const path = transcriptFile([agentCall("folded", "toolu_folded", "Sweep the ledger"), asyncLaunched("toolu_folded", "agent-folded")]);
  assert.equal(await claudeSubagentLaunch(path, "agent-running"), null);
  assert.equal(await claudeSubagentLaunch(path, ""), null);
  assert.equal(await claudeSubagentLaunch(join(tmpdir(), "mission-no-such-transcript.jsonl"), "agent-running"), null);
});

test("a result that only mentions an agent id, or answers another tool, is not read as a launch", async () => {
  const path = transcriptFile([
    agentCall("rec", "toolu_cont", "Continue it"),
    {
      type: "user",
      uuid: "res-cont",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cont", content: "Sent to agentId: agent-9 (continuing)" }] },
    },
  ]);
  assert.equal(await claudeSubagentLaunch(path, "agent-9"), null);
});

/** A long transcript: a launch at the top, then `n` filler turns with multi-byte text. */
function longTranscript(n: number): string {
  const filler = Array.from({ length: n }, (_, i) => ({
    type: "assistant",
    uuid: `f${i}`,
    message: { role: "assistant", content: [{ type: "text", text: `filler ${i} ${"é".repeat(50)}` }] },
  }));
  return transcriptFile([agentCall("early", "toolu_early", "Early"), asyncLaunched("toolu_early", "agent-early"), ...filler]);
}

test("the scan never holds the event loop for the whole file: other work runs between its reads", async () => {
  resetLaunchIndexes();
  const path = longTranscript(400);
  let turns = 0;
  let spinning = true;
  const spin = (): void => {
    if (!spinning) return;
    turns += 1;
    setImmediate(spin);
  };
  setImmediate(spin);
  // Small reads, so the scan takes many steps; a synchronous scan would finish in zero turns.
  const found = await claudeSubagentLaunch(path, "agent-missing", 4096);
  spinning = false;
  assert.equal(found, null, "it read to the end to say so");
  assert.ok(turns > 5, `the event loop ran ${turns} times while the file was read`);
});

test("the scan reads across chunk edges, and finds a launch anywhere in a long file", async () => {
  resetLaunchIndexes();
  // Tiny reads, so every line and many multi-byte characters straddle a read edge.
  assert.equal(await claudeSubagentLaunch(longTranscript(400), "agent-early", 37), "toolu_early");
});

test("later lookups read only what was appended, and a line still being written waits for its end", async () => {
  resetLaunchIndexes();
  const path = transcriptFile([agentCall("one", "toolu_one", "One"), asyncLaunched("toolu_one", "agent-one")]);
  const first = statSync(path).size;
  assert.equal(await claudeSubagentLaunch(path, "agent-one"), "toolu_one");
  assert.deepEqual(launchScanCostSoFar(), { scans: 1, bytes: first }, "the first lookup reads the file once");

  // Nothing appended: a lookup for an id the file does not name reads nothing at all.
  assert.equal(await claudeSubagentLaunch(path, "agent-two"), null);
  assert.deepEqual(launchScanCostSoFar(), { scans: 1, bytes: first }, "a repeated miss costs no read");

  // A second launch is written after the file was indexed: half a line, then the rest.
  const call = `${JSON.stringify(agentCall("two", "toolu_two", "Two"))}\n`;
  const line = JSON.stringify(asyncLaunched("toolu_two", "agent-two"));
  appendFileSync(path, `${call}${line.slice(0, 40)}`);
  assert.equal(await claudeSubagentLaunch(path, "agent-two"), null, "an unfinished line is not indexed");
  const appended = Buffer.byteLength(`${call}${line.slice(0, 40)}`);
  assert.deepEqual(launchScanCostSoFar(), { scans: 2, bytes: first + appended }, "only the appended bytes were read");

  appendFileSync(path, `${line.slice(40)}\n`);
  assert.equal(await claudeSubagentLaunch(path, "agent-two"), "toolu_two", "the finished line is");
  // Resumed at the unfinished line: its first 40 bytes are read again, nothing before them.
  const resumed = Buffer.byteLength(line) + 1;
  assert.deepEqual(launchScanCostSoFar(), { scans: 3, bytes: first + appended + resumed });
  assert.equal(await claudeSubagentLaunch(path, "agent-one"), "toolu_one", "and what was read before is kept");
});

test("a transcript cleared or replaced under the same path is indexed again from its start", async () => {
  resetLaunchIndexes();
  const path = transcriptFile([agentCall("old", "toolu_old_call", "Old"), asyncLaunched("toolu_old_call", "agent-old")]);
  assert.equal(await claudeSubagentLaunch(path, "agent-old"), "toolu_old_call");
  // Shorter than what was indexed: the old index cannot describe it.
  writeFileSync(path, `${JSON.stringify(asyncLaunched("toolu_new", "agent-new"))}\n`);
  assert.equal(await claudeSubagentLaunch(path, "agent-old"), null);
  assert.equal(await claudeSubagentLaunch(path, "agent-new"), "toolu_new");
});

test("lookups that arrive together share one scan and each get their own answer", async () => {
  resetLaunchIndexes();
  const path = transcriptFile([
    agentCall("a", "toolu_a", "A"),
    asyncLaunched("toolu_a", "agent-a"),
    agentCall("b", "toolu_b", "B"),
    asyncLaunched("toolu_b", "agent-b"),
  ]);
  const [a, b, none] = await Promise.all([
    claudeSubagentLaunch(path, "agent-a", 16),
    claudeSubagentLaunch(path, "agent-b", 16),
    claudeSubagentLaunch(path, "agent-c", 16),
  ]);
  assert.deepEqual([a, b, none], ["toolu_a", "toolu_b", null]);
  // Three lookups, one scan, and the file read exactly once between them.
  assert.deepEqual(launchScanCostSoFar(), { scans: 1, bytes: statSync(path).size });
});

// ---- the tray's markup ----

test("a session without background agents draws no tray at all", () => {
  assert.equal(tray(undefined), "");
  assert.equal(tray({ agents: [], finishedFolded: 0 }), "");
});

test("the header counts running and listed-done agents, and a full running list reads as a floor", () => {
  assert.equal(backgroundAgentsHeadline({ subagents: SAMPLE }), "Background agents · 2 running · 1 done");
  assert.equal(
    backgroundAgentsHeadline({ subagents: { agents: [agent({ id: "x" })], finishedFolded: 0 } }),
    "Background agents · 1 running",
  );
  const full = Array.from({ length: SUBAGENT_LIMIT }, (_, i) => agent({ id: `r${i}` }));
  assert.equal(
    backgroundAgentsHeadline({ subagents: { agents: full, finishedFolded: 0 } }),
    `Background agents · ${SUBAGENT_LIMIT}+ running`,
  );
});

test("the tray lists each agent's state, type, description and detail, and folds finished ones into a count", () => {
  const html = tray(SAMPLE);
  assert.match(html, /<section class="bg-tray" aria-label="Background agents">/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /⑂/);
  assert.match(html, /<li class="bg-tray-row is-running">/);
  assert.match(html, /<li class="bg-tray-row is-completed">/);
  assert.match(html, /<span class="bg-tray-type">general-purpose<\/span>/);
  assert.match(html, /Map every offset-pagination call site/);
  assert.match(html, /18 tools · Grep/);
  assert.match(html, /<span class="bg-tray-end">done · <\/span>1m 05s · 9 tools/);
  assert.match(html, /<li class="bg-tray-row bg-tray-folded">2 finished<\/li>/);
});

test("a value the source did not report is left out, never drawn as a zero", () => {
  const html = tray({ agents: [agent({ id: "hook", type: "Explore", description: null })], finishedFolded: 0 });
  assert.doesNotMatch(html, /tools/);
  assert.doesNotMatch(html, /\b0\b tools/);
  assert.doesNotMatch(html, /bg-tray-desc/);
});

test("every agent has a Jump to launch link, whether or not its source named the launching call", () => {
  const html = tray(SAMPLE);
  // a1 and a3 name their launch; a2 does not, and is found by its own id against its call.
  assert.equal(html.match(/class="bg-tray-jump is-ready"/g)?.length, 3);
  assert.equal(html.match(/>Jump to launch</g)?.length, 3);
  const a2Row = html.split("<li").find((row) => row.includes("Convert billing report queries")) ?? "";
  assert.match(a2Row, />Jump to launch</);
});

test("a row's link says when its search is under way, and why one ended without a turn", () => {
  const html = tray(
    SAMPLE,
    new Map<string, LaunchSearch>([
      ["a1", "searching"],
      ["a2", "error"],
      ["a3", "missing"],
    ]),
  );
  assert.match(html, /class="bg-tray-jump is-searching" aria-busy="true"[^>]*>Finding launch…</);
  assert.match(html, /class="bg-tray-jump is-missing"[^>]*>Launch not in transcript</);
  assert.match(html, /No call in this conversation&#x27;s transcript is recorded as launching this agent/);
  assert.match(html, /click to look again/);
  assert.match(html, /class="bg-tray-jump is-error"[^>]*>Jump to launch</);
  assert.match(html, /click to try again/);
});

test("the panel mounts the tray between the conversation split and the composer, outside both", () => {
  resetHistories();
  seedTail("tray-2", { messages: [msg({ id: "u0", role: "user", text: "hi", ts: 1 })], start: 0, atStart: true, pos: 10 });
  const html = renderToStaticMarkup(
    createElement(TranscriptPanel, {
      session: mkSession({ id: "tray-2", state: "idle", subagents: SAMPLE }),
      canSend: true,
    }),
  );
  const split = html.indexOf('class="find-split"');
  const trayAt = html.indexOf('class="bg-tray"');
  const compose = html.indexOf('class="transcript-compose"');
  assert.ok(split >= 0 && trayAt > split && compose > trayAt, "split, then tray, then composer");
  // Not inside the composer: the tray closes before the composer opens.
  assert.ok(html.indexOf("</section>", trayAt) < compose);

  resetHistories();
  seedTail("tray-3", { messages: [msg({ id: "u0", role: "user", text: "hi", ts: 1 })], start: 0, atStart: true, pos: 10 });
  const plain = renderToStaticMarkup(
    createElement(TranscriptPanel, { session: mkSession({ id: "tray-3", state: "idle" }), canSend: true }),
  );
  assert.doesNotMatch(plain, /bg-tray/, "a session without agents renders as before");
});
