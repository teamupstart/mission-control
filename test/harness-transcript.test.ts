import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, TranscriptMessage } from "../src/shared/types.ts";
// The browser-side fold, imported into a server-side test on purpose: the defect it pins lived
// in neither layer but in the shape passed between them, so an assertion inside either one
// would have kept passing.
import { transcriptRows } from "../src/web/lib/tools.ts";

// What is at stake: a harness that CANNOT read a session's conversation has to degrade
// exactly the way a harness that simply hasn't got a file yet does - the shape every
// reader downstream already handles - rather than answering with an empty window that
// reads as "this session has said nothing".
//
// That distinction is not cosmetic. Foreman's Tier 1 routes UP on `unavailable` and
// judges on an empty-but-present window; the queue's verifier anchors on a byte size and
// treats a missing one as infrastructure failure. A `messages: []` from a harness with no
// message reader would walk straight past both.
//
// So this pins the two ends of the transcript capability: that the registry forces a new
// harness to answer at all, and that answering `null` produces the identical `{unavailable:
// true}` / `{size: null}` the absent-file path has always produced.

const home = mkdtempSync(join(tmpdir(), "harness-transcript-"));
// Set before importing anything that resolves the state dir (routes.ts reaches the db).
process.env.HARNESS_HOME = join(home, "state");
// The codex spec walks this tree; point it somewhere hermetic before it is first read.
process.env.CODEX_HOME = join(home, "codex");

const { HARNESSES, harnessFor, sessionMessages } = await import("../src/server/harness/index.ts");
const { codexTranscript, joinCodexBatches, parseCodexMessages } = await import(
  "../src/server/harness/codex/transcript.ts"
);
const { buildApp } = await import("../src/server/routes.ts");
const { AGENT_TYPES } = await import("../src/shared/types.ts");
const { GOAL_UNSUPPORTED } = await import("../src/shared/goal.ts");
const { readGoalWindow } = await import("../src/server/goal/source.ts");
const { forgetInjections, recordInjection } = await import("../src/server/injections.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const session = (over: Partial<Session>): Session =>
  ({ id: "s1", agent: "claude", cwd: "/repo/app", startedAt: null, ...over }) as Session;

// ---- the registry ----

test("every agent has a harness, and each one knows its own id", () => {
  for (const agent of AGENT_TYPES) {
    const h = harnessFor(agent);
    assert.ok(h, `no harness for ${agent}`);
    assert.equal(h.id, agent, "a harness's id must match its key in HARNESSES");
  }
  assert.deepEqual(Object.keys(HARNESSES).sort(), [...AGENT_TYPES].sort());
});

test("both shipped harnesses read messages, and each names its own metadata source", () => {
  // Codex was the live case for `messages: null` - "a rollout carries model / effort /
  // token counts and no turns". That was a claim about the format and it was wrong: its
  // `event_msg` records carry `user_message` / `agent_message` verbatim. The capability
  // is still nullable, and the paths that null feeds are pinned by the fixtures below;
  // what changed is that no shipped harness declares it.
  //
  // `metaSource` is the axis that genuinely still differs, and it is why the two are not
  // the same reader: Claude's turns and its runtime figures come from one transcript,
  // Codex's from a rollout it locates by walking a dated directory tree.
  assert.ok(HARNESSES.codex.transcript?.messages, "Codex reads its rollout as messages");
  assert.equal(HARNESSES.codex.transcript?.metaSource, "codex-rollout");
  assert.ok(HARNESSES.claude.transcript?.messages, "Claude reads its transcript as messages");
  assert.equal(HARNESSES.claude.transcript?.metaSource, "transcript");
});

test("both harnesses hand the shared fold a run it can actually fold", () => {
  // The contract that broke, stated across the seam it broke at. `transcriptRows` is the only
  // fold in the app and by design it groups assistant turns that are TOOL-ONLY. Each reader
  // decides, on its own, whether the turns it emits can ever be that shape - and Codex's said
  // no: every command was appended to the preceding `agent_message`, so a stretch of work drew
  // one block per command while Claude's drew a single record. Neither reader's own tests could
  // see it, because nothing on either side of the boundary was wrong in isolation.
  //
  // Asserted on the ROW COUNT and not on the parse, because the row is what a person sees and
  // it is the number that was wrong: three commands, one record.
  const shape = (messages: TranscriptMessage[]) =>
    transcriptRows(messages).map((row) => (row.kind === "tools" ? `run:${row.tools.length}` : "turn"));

  const ts = new Date(1000).toISOString();
  const codexRun = parseCodexMessages([
    { type: "event_msg", timestamp: ts, payload: { type: "user_message", message: "ASK" } },
    { type: "event_msg", timestamp: ts, payload: { type: "agent_message", message: "on it" } },
    // Interleaved exactly as a rollout writes them: reasoning and output records between the
    // calls. They carry no turn, so they must not break the run into pieces.
    { type: "response_item", timestamp: ts, payload: { type: "reasoning", summary: [] } },
    { type: "custom_tool_call", timestamp: ts, payload: { call_id: "a", name: "exec", arguments: "ls" } },
    { type: "response_item", timestamp: ts, payload: { type: "custom_tool_call_output", call_id: "a", output: "x" } },
    { type: "response_item", timestamp: ts, payload: { type: "reasoning", summary: [] } },
    { type: "custom_tool_call", timestamp: ts, payload: { call_id: "b", name: "exec", arguments: "pwd" } },
    { type: "custom_tool_call", timestamp: ts, payload: { call_id: "c", name: "exec", arguments: "git status" } },
  ]);
  assert.deepEqual(shape(codexRun), ["turn", "turn", "run:3"]);

  // The same shape Claude's reader produces for the same work, which is the point: the fold is
  // agent-agnostic and now has nothing to be agnostic ABOUT.
  const claudeRun: TranscriptMessage[] = [
    { id: "u", role: "user", text: "ASK", tools: [], ts: 1000 },
    { id: "a", role: "assistant", text: "on it", tools: [], ts: 1000 },
    { id: "t1", role: "assistant", text: "", tools: [{ name: "Bash", input: '{"command":"ls"}' }], ts: 1000 },
    { id: "t2", role: "assistant", text: "", tools: [{ name: "Bash", input: '{"command":"pwd"}' }], ts: 1000 },
    { id: "t3", role: "assistant", text: "", tools: [{ name: "Bash", input: '{"command":"git status"}' }], ts: 1000 },
  ];
  assert.deepEqual(shape(claudeRun), shape(codexRun));
});

test("Codex projects an interrupted rollout turn as the same visible marker Claude writes", () => {
  const interruptedAt = "2026-08-18T15:14:57.635Z";
  const messages = parseCodexMessages([
    {
      type: "event_msg",
      timestamp: interruptedAt,
      payload: {
        type: "turn_aborted",
        turn_id: "turn-interrupted",
        reason: "interrupted",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-18T15:15:00.000Z",
      payload: {
        type: "turn_aborted",
        turn_id: "turn-failed-for-another-reason",
        reason: "replaced",
      },
    },
  ]);

  assert.deepEqual(messages, [
    {
      id: "interrupt:turn-interrupted",
      role: "user",
      text: "[Request interrupted by user]",
      tools: [],
      ts: Date.parse(interruptedAt),
    },
  ]);
});

test("a window seam rejoins one split run but never welds a run onto prose", () => {
  // `joinCodexBatches` has two jobs and only one of them is a merge. Both are asserted here
  // because the merge is the dangerous one: welding a run onto the prose above it is exactly how
  // the fold was defeated, and a window boundary is the one place that could still do it after
  // the parser stopped.
  const run = (id: string, names: string[]): TranscriptMessage => ({
    id: `tool:${id}`,
    role: "assistant",
    text: "",
    tools: names.map((name) => ({ name })),
    ts: 1000,
  });
  const prose: TranscriptMessage = { id: "p", role: "assistant", text: "on it", tools: [], ts: 1000 };

  // Seam INSIDE a run: the halves are one turn and are merged, so a windowed read reconstructs
  // what a whole-file parse produces.
  const inside = joinCodexBatches([run("a", ["exec"])], [run("b", ["exec", "exec"])]);
  assert.ok(inside, "a split run must join");
  assert.deepEqual(inside.later, [], "the trailing half is consumed...");
  assert.equal(inside.earlier.at(-1)?.tools.length, 3, "...into one turn of three commands");

  // Seam BETWEEN prose and a run: joined, so the window still widens back to the narration -
  // but the two stay separate turns, which is what keeps the run foldable.
  const across = joinCodexBatches([prose], [run("b", ["exec"])]);
  assert.ok(across, "the window must still reach back past the run to its narration");
  assert.deepEqual(across.earlier, [prose], "the prose is untouched...");
  assert.deepEqual(across.later.length, 1, "...and the run is still its own turn");
  assert.deepEqual(across.earlier.at(-1)?.tools, [], "no command was welded onto the prose");

  // A leading turn that is not a synthesized run means the window did not open mid-turn, so
  // there is nothing to repair and the scan stops.
  assert.equal(joinCodexBatches([prose], [prose]), null);
});

test("an agent that can never carry a goal is one whose harness reads no messages", () => {
  // Two files, one fact. `GOAL_UNSUPPORTED` is what a card says; the capability is why.
  // When a rollout message reader lands, both change in the same commit or this fails.
  for (const agent of AGENT_TYPES) {
    if (!GOAL_UNSUPPORTED[agent]) continue;
    assert.equal(
      harnessFor(agent).transcript?.messages ?? null,
      null,
      `${agent} claims goals are impossible while its harness can read its turns`,
    );
  }
});

// ---- degradation, through the real routes ----

const registry = {
  getSession: (id: string) => SESSIONS.get(id),
} as unknown as Parameters<typeof buildApp>[0];
const app = buildApp(registry, {} as never, {} as never, {} as never);
const HEADERS = { host: "127.0.0.1:7317" };
const SESSIONS = new Map<string, Session>();

/** A Claude session whose transcript file exists, and the same one with it missing. */
function seedClaudeTranscript(): { withFile: Session; withoutFile: Session } {
  const dir = join(home, "projects");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "real.jsonl");
  writeFileSync(
    path,
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-07-12T10:00:00.000Z",
      message: { role: "user", content: "fix the arrow keys" },
    }) + "\n",
  );
  return {
    withFile: session({ id: "claude-file", transcriptPath: path }),
    withoutFile: session({ id: "claude-nofile", transcriptPath: join(dir, "gone.jsonl") }),
  };
}

test("a messages-less harness degrades exactly like a missing file", async () => {
  const { withoutFile } = seedClaudeTranscript();
  const codex = session({ id: "codex-1", agent: "codex" });
  SESSIONS.set(withoutFile.id, withoutFile).set(codex.id, codex);

  const windows = await Promise.all(
    [withoutFile.id, codex.id].map(async (id) =>
      (await app.request(`/api/sessions/${id}/transcript`, { headers: HEADERS })).json(),
    ),
  );
  assert.deepEqual(windows[0], { messages: [], truncated: false, unavailable: true });
  assert.deepEqual(windows[1], windows[0], "the two absences must be indistinguishable");

  const sizes = await Promise.all(
    [withoutFile.id, codex.id].map(async (id) =>
      (await app.request(`/api/sessions/${id}/transcript/size`, { headers: HEADERS })).json(),
    ),
  );
  assert.deepEqual(sizes[0], { size: null });
  assert.deepEqual(sizes[1], sizes[0]);
});

test("a harness that CAN read messages still serves them through the capability", async () => {
  // The other half of the pin: proving degradation is easy if nothing works at all.
  const { withFile } = seedClaudeTranscript();
  SESSIONS.set(withFile.id, withFile);

  const w = (await (
    await app.request(`/api/sessions/${withFile.id}/transcript`, { headers: HEADERS })
  ).json()) as { messages: Array<{ text: string }>; unavailable?: boolean };
  assert.equal(w.unavailable, undefined);
  assert.deepEqual(
    w.messages.map((m) => m.text),
    ["fix the arrow keys"],
  );

  const { size } = (await (
    await app.request(`/api/sessions/${withFile.id}/transcript/size`, { headers: HEADERS })
  ).json()) as { size: number | null };
  assert.ok(size && size > 0, "a real file has a byte anchor to hand the queue");
});

test("scroll-back validates byte offsets and attributes injected turns", async () => {
  const { withFile } = seedClaudeTranscript();
  SESSIONS.set(withFile.id, withFile);
  recordInjection(withFile.id, "fix the arrow keys", "foreman");
  try {
    const invalid = await app.request(
      `/api/sessions/${withFile.id}/transcript?before=1.5`,
      { headers: HEADERS },
    );
    assert.equal(invalid.status, 400);

    const ordinary = (await (
      await app.request(`/api/sessions/${withFile.id}/transcript?turns=48`, { headers: HEADERS })
    ).json()) as { messages: Array<{ origin?: string }> };
    assert.equal(ordinary.messages[0]?.origin, undefined);

    const page = (await (
      await app.request(
        `/api/sessions/${withFile.id}/transcript?before=${statSync(withFile.transcriptPath!).size}`,
        { headers: HEADERS },
      )
    ).json()) as { messages: Array<{ origin?: string }> };
    assert.equal(page.messages[0]?.origin, "foreman");
  } finally {
    forgetInjections(withFile.id);
  }
});

test("the goal reader takes the same answer from the same capability", () => {
  const { withFile, withoutFile } = seedClaudeTranscript();
  assert.equal(readGoalWindow(session({ ...withoutFile })), null);
  assert.equal(readGoalWindow(session({ id: "c", agent: "codex" })), null);
  assert.equal(readGoalWindow(session({ ...withFile }))?.messages.length, 1);
});

test("sessionMessages checks the capability before it goes looking for a file", () => {
  // Order matters for more than tidiness: locating a Codex rollout is a dated directory
  // walk, and doing it to then discard the result is a filesystem sweep per request.
  //
  // `messages: null` on the spy rather than on a shipped harness: both read messages now,
  // and the guard is what a third harness with metadata and no turns lands on. Codex's
  // own `locate` is kept as the body so the walk being counted is the real one.
  let located = 0;
  const spy = {
    ...codexTranscript,
    messages: null,
    locate: (s: Session) => (located++, codexTranscript.locate(s)),
  };
  const restore = HARNESSES.codex.transcript;
  HARNESSES.codex.transcript = spy;
  try {
    assert.equal(sessionMessages(session({ id: "cx", agent: "codex" })), null);
    assert.equal(located, 0, "a harness with no message reader must not be asked to locate");
  } finally {
    HARNESSES.codex.transcript = restore;
  }
});

test("a harness that DOES read messages is asked to locate - the other half", () => {
  let located = 0;
  const spy = { ...codexTranscript, locate: (s: Session) => (located++, codexTranscript.locate(s)) };
  const restore = HARNESSES.codex.transcript;
  HARNESSES.codex.transcript = spy;
  try {
    sessionMessages(session({ id: "cx-live", agent: "codex", cwd: "/repo/app" }));
    assert.equal(located, 1, "the capability exists, so the file is looked for");
  } finally {
    HARNESSES.codex.transcript = restore;
  }
});

// ---- the codex path cache, which used to live in the poller ----

test("the rollout lookup caches per session and prunes what retain drops", () => {
  const day = join(home, "codex", "sessions", "2026", "07", "12");
  mkdirSync(day, { recursive: true });
  const rollout = join(day, "rollout-2026-07-12T10-00-00-aaa.jsonl");
  const meta = JSON.stringify({
    timestamp: "2026-07-12T10:00:00.000Z",
    type: "session_meta",
    payload: { id: "x", timestamp: "2026-07-12T10:00:00.000Z", cwd: "/repo/app" },
  });
  writeFileSync(rollout, meta + "\n");

  const s = session({ id: "cx-cache", agent: "codex", cwd: "/repo/app" });
  assert.equal(codexTranscript.locate(s), rollout);

  // Cached: the file is gone, and the answer is unchanged because the walk didn't re-run.
  rmSync(rollout);
  assert.equal(codexTranscript.locate(s), rollout);

  // The poller hands back the ids it still sees; a session that has gone away takes its
  // binding with it, which is the whole reason the cache can live inside the spec.
  codexTranscript.retain?.(new Set<string>());
  assert.equal(codexTranscript.locate(s), null);
});

test("a Codex clear cannot reuse the prior rollout cache binding", () => {
  const day = join(home, "codex", "sessions", "2026", "07", "13");
  mkdirSync(day, { recursive: true });
  const oldRollout = join(day, "rollout-2026-07-13T10-00-00-old.jsonl");
  const newRollout = join(day, "rollout-2026-07-13T10-05-00-new.jsonl");
  writeFileSync(oldRollout, `${JSON.stringify({
    timestamp: "2026-07-13T10:00:00.000Z",
    type: "session_meta",
    payload: { id: "before-clear", timestamp: "2026-07-13T10:00:00.000Z", cwd: "/repo/clear" },
  })}\n`);
  writeFileSync(newRollout, `${JSON.stringify({
    timestamp: "2026-07-13T10:05:00.000Z",
    type: "session_meta",
    payload: { id: "after-clear", timestamp: "2026-07-13T10:05:00.000Z", cwd: "/repo/clear" },
  })}\n`);

  const before = session({
    id: "cx-clear",
    agent: "codex",
    cwd: "/repo/clear",
    startedAt: Date.parse("2026-07-13T10:00:00.000Z"),
    agentSessionId: "before-clear",
  });
  assert.equal(codexTranscript.locate(before), oldRollout);

  const rebound = { ...before, agentSessionId: "after-clear", transcriptPath: oldRollout };
  assert.equal(codexTranscript.locate(rebound), null);
  assert.equal(codexTranscript.locate({ ...rebound, transcriptPath: null }), newRollout);
});

test("an unidentified Codex session cannot reuse a retained rollout path", () => {
  const day = join(home, "codex", "sessions", "2026", "07", "14");
  mkdirSync(day, { recursive: true });
  const rollout = join(day, "rollout-2026-07-14T10-00-00-unknown.jsonl");
  writeFileSync(rollout, `${JSON.stringify({
    timestamp: "2026-07-14T10:00:00.000Z",
    type: "session_meta",
    payload: { id: "other-session", timestamp: "2026-07-14T10:00:00.000Z", cwd: "/repo/other" },
  })}\n`);

  const unidentified = session({
    id: "cx-unidentified",
    agent: "codex",
    cwd: null,
    agentSessionId: null,
    transcriptPath: rollout,
  });
  assert.equal(codexTranscript.locate(unidentified), null);
});
