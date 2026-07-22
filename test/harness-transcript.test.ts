import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";

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
const { codexTranscript } = await import("../src/server/harness/codex/transcript.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { AGENT_TYPES } = await import("../src/shared/types.ts");
const { GOAL_UNSUPPORTED } = await import("../src/shared/goal.ts");
const { readGoalWindow } = await import("../src/server/goal/source.ts");

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
