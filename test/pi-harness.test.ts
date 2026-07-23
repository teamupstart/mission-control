// Phase 5 acceptance: the `pi` harness, added only against the `Harness` interface. What is
// at stake here is that the interface's capability-null design is REAL - that a third harness
// can declare what it has and honestly disable what it lacks, without a code change - and,
// specifically, that pi is the MIRROR of Codex on this axis (Codex: hooks non-null, messages
// null; pi: hooks null, messages non-null). The transcript parsing is pinned against a
// verbatim capture, `test/fixtures/pi-sessions.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";

import { harnessFor } from "../src/server/harness/index.ts";
import {
  locatePiTranscript,
  piProjectDir,
  piToMessage,
  piTranscript,
} from "../src/server/harness/pi/transcript.ts";
import {
  computePiRuntimeMeta,
  computePiSessionActivity,
  piContextWindowSize,
} from "../src/server/harness/pi/meta.ts";
import { GOAL_UNSUPPORTED } from "../src/shared/goal.ts";
import { COST_UNSUPPORTED } from "../src/shared/cost.ts";
import { PI_SESSION_LINES, PI_SESSION_JSONL } from "./fixtures/pi-sessions.ts";
import { preparePiLaunch } from "../src/server/harness/pi/launch.ts";

// ---- the capability shape: what pi declares vs what it disables ----

test("pi is the mirror of Codex - hooks null, but transcript reads back as messages", () => {
  const pi = harnessFor("pi");
  assert.equal(pi.hooks, null, "pi pushes nothing: its extensions are in-process, not a hook");
  assert.ok(pi.transcript, "pi records a readable transcript");
  assert.ok(
    pi.transcript?.messages,
    "and that transcript carries turns - the opposite corner from Codex's rollout",
  );
});

test("pi's unsupported capabilities are DECLARED null, not stubbed", () => {
  const pi = harnessFor("pi");
  // Genuinely absent, each with its own reason (see `todo/pi-harness.md`).
  assert.equal(pi.permissionModes, null, "pi's manual/auto/readonly don't fit PermissionMode");
  assert.equal(pi.mcp, null, "pi has no MCP client");
  assert.equal(pi.workQueue, null, "no hooks -> Foreman can't verify pickup/completion");
  // Present, and driving real behaviour.
  assert.equal(pi.clearContext?.command, "/new", "pi clears context in place with /new");
  assert.equal(pi.skills?.reloadCommand, "/reload", "bound pi sessions reload at idle");
  assert.equal(pi.skills?.reloadIdleSource, "transcript");
  assert.deepEqual(pi.skills?.homeDir, [".pi", "agent", "skills"], "pi's own skills dir");
  assert.equal(pi.control.kind, "keystroke", "a turn is typed into pi's pane");
  assert.equal(pi.control.kind === "keystroke" && pi.control.pastePlaceholder, null,
    "pi collapses no paste, so submit has no on-screen evidence");
});

test("pi's tui is null - measured, not assumed", () => {
  // pi's screen IS readable (its `/model` menu cursor `→` was captured live), but nothing is
  // wired to read off it: no permission-mode footer (Shift+Tab cycles thinking), and the
  // approval-dialog grammar is parked pending a login. The codebase spells "nothing to parse"
  // as tui:null - `harness-tui.test.ts` forbids a spec with both sub-capabilities null.
  assert.equal(harnessFor("pi").tui, null);
});

test("GOAL_UNSUPPORTED.pi and the messages capability are one fact", () => {
  // The same pairing `harness-transcript.test.ts` pins generically, asserted for pi directly:
  // a harness that reads turns can be given a goal.
  assert.equal(GOAL_UNSUPPORTED.pi, null);
  assert.ok(harnessFor("pi").transcript?.messages);
});

test("pi is not cost-unsupported - it reports cost in every turn", () => {
  assert.equal(COST_UNSUPPORTED.pi, null);
});

// ---- locate: pi's cwd -> project-dir encoding ----

test("the project-dir munge matches pi's own session-manager encoding", () => {
  // Verified against the real store on the spike machine.
  assert.ok(piProjectDir("/Users/jordanmance").endsWith("--Users-jordanmance--"));
  assert.ok(piProjectDir("/private/tmp").endsWith("--private-tmp--"));
  // Dots are NOT replaced (only `/ \ :`), unlike Claude's `[/.]` - a worktree keeps its dot.
  assert.ok(
    piProjectDir("/Users/me/.treehouse/ai-harness/9").endsWith("--Users-me-.treehouse-ai-harness-9--"),
  );
});

function locateSession(
  id: string,
  cwd: string,
  agentSessionId: string | null = null,
): Session {
  return { id, cwd, startedAt: null, agentSessionId, transcriptPath: null } as Session;
}

function writeSession(dir: string, id: string, createdAt: number, headerId = id): string {
  const path = join(dir, `${new Date(createdAt).toISOString()}_${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: headerId,
      timestamp: new Date(createdAt).toISOString(),
    })}\n`,
  );
  return path;
}

test("an agent session id binds the matching filename uuid immediately", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-locate-"));
  const cwd = "/repo";
  const dir = piProjectDir(cwd, root);
  mkdirSync(dir, { recursive: true });
  const firstId = "019f7d35-beb8-7ae4-8b33-049e4f65cacd";
  const secondId = "119f7d35-beb8-7ae4-8b33-049e4f65cacd";
  try {
    writeSession(dir, firstId, Date.parse("2026-07-20T10:00:00.000Z"));
    const secondPath = writeSession(
      dir,
      secondId,
      Date.parse("2026-07-20T11:00:00.000Z"),
      "different-header-id",
    );
    assert.equal(
      locatePiTranscript(locateSession("pi-exact", cwd, secondId), root),
      secondPath,
    );
  } finally {
    piTranscript.retain?.(new Set());
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparePiLaunch injects and reports one exact session id", () => {
  const prepared = preparePiLaunch();
  assert.deepEqual(prepared.args, ["--session-id", prepared.sessionId]);
  assert.match(
    prepared.sessionId,
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
  );
});

test("a hookless session declines transcript attribution", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-locate-"));
  const cwd = "/repo";
  const dir = piProjectDir(cwd, root);
  mkdirSync(dir, { recursive: true });
  const fileId = "019f7d35-beb8-7ae4-8b33-049e4f65cacd";
  try {
    writeSession(dir, fileId, Date.parse("2026-07-20T10:00:00.000Z"));
    const session = locateSession("pi-no-identity", cwd);
    assert.equal(locatePiTranscript(session, root), null);
  } finally {
    piTranscript.retain?.(new Set());
    rmSync(root, { recursive: true, force: true });
  }
});

test("a launch-identified session binds its transcript and reads runtime state", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-locate-"));
  const cwd = "/repo";
  const dir = piProjectDir(cwd, root);
  mkdirSync(dir, { recursive: true });
  const sessionId = "019f7d35-beb8-7ae4-8b33-049e4f65cacd";
  const path = join(dir, `2026-07-20T10:00:00.000Z_${sessionId}.jsonl`);
  writeFileSync(path, PI_SESSION_JSONL);
  try {
    const located = locatePiTranscript(locateSession("pi-dispatched", cwd, sessionId), root);
    assert.equal(located, path);
    const read = piTranscript.passiveRead?.(located!);
    assert.equal(read?.meta?.modelId, "gpt-5.5");
    assert.equal(read?.activity?.state, "working");
  } finally {
    piTranscript.retain?.(new Set());
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing exact match is retried rather than negatively cached", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-locate-"));
  const cwd = "/repo";
  const dir = piProjectDir(cwd, root);
  mkdirSync(dir, { recursive: true });
  const sessionId = "019f7d35-beb8-7ae4-8b33-049e4f65cacd";
  try {
    const session = locateSession("pi-delayed", cwd, sessionId);
    assert.equal(locatePiTranscript(session, root), null);
    const path = writeSession(dir, sessionId, Date.parse("2026-07-20T10:00:00.000Z"));
    assert.equal(locatePiTranscript(session, root), path);
  } finally {
    piTranscript.retain?.(new Set());
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newer session file invalidates an exact binding without replacing it", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-locate-"));
  const cwd = "/repo";
  const dir = piProjectDir(cwd, root);
  mkdirSync(dir, { recursive: true });
  const sessionId = "019f7d35-beb8-7ae4-8b33-049e4f65cacd";
  const newerId = "119f7d35-beb8-7ae4-8b33-049e4f65cacd";
  try {
    const session = locateSession("pi-context-change", cwd, sessionId);
    const path = writeSession(dir, sessionId, Date.parse("2026-07-20T10:00:00.000Z"));
    assert.equal(locatePiTranscript(session, root), path);
    writeSession(dir, newerId, Date.parse("2026-07-20T10:01:00.000Z"));
    assert.equal(locatePiTranscript(session, root), null);
  } finally {
    piTranscript.retain?.(new Set());
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- messages: parse the verbatim capture ----

test("text turns parse; thinking is dropped; the aborted turn falls out", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-transcript-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, PI_SESSION_JSONL);
  try {
    const win = piTranscript.messages!.window(path);
    // 5 renderable turns: exot(user), clarify(asst), exit(user), Goodbye(asst), exit(user).
    // The `session`/`model_change`/`thinking_level_change` records and the empty aborted turn
    // are all dropped.
    assert.equal(win.messages.length, 5, `expected 5 turns, got ${win.messages.length}`);
    assert.deepEqual(win.messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
    assert.equal(win.messages[0]!.text, "exot");
    // The assistant turn keeps its `text` part and drops its `thinking` part.
    assert.equal(win.messages[1]!.text, "Could you clarify what you'd like me to do?");
    assert.equal(win.messages[3]!.text, "Goodbye.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record that is not a message, or an empty turn, parses to null", () => {
  assert.equal(piToMessage(JSON.parse(PI_SESSION_LINES[0]!)), null, "the session header is not a turn");
  assert.equal(piToMessage(JSON.parse(PI_SESSION_LINES[1]!)), null, "a model_change is not a turn");
  assert.equal(piToMessage(JSON.parse(PI_SESSION_LINES[8]!)), null, "the aborted, empty turn drops");
  assert.equal(piToMessage("not json"), null);
  assert.equal(piToMessage(null), null);
});

// ---- passiveRead: runtime metadata and idle/working ----

test("runtime metadata comes off the newest PRICED turn, not the aborted one", () => {
  const meta = computePiRuntimeMeta([...PI_SESSION_LINES]);
  assert.ok(meta);
  assert.equal(meta?.modelId, "gpt-5.5");
  // The newest turn is aborted (usage zeroed) and is skipped; the previous turn's context is
  // input 228 + cacheRead 1024 = 1252, not 0.
  assert.equal(meta?.contextTokens, 1252);
  assert.equal(meta?.thinkingLevel, "medium");
  assert.equal(meta?.longContext, false);
});

test("pi model families use their real context windows", () => {
  assert.equal(piContextWindowSize("gpt-5.5"), 272_000);
  assert.equal(piContextWindowSize("openai/gpt-5.6-sol"), 272_000);
  assert.equal(piContextWindowSize("gpt-5.5-pro"), 1_050_000);
  assert.equal(piContextWindowSize("gpt-5.4-pro"), 1_050_000);
  assert.equal(piContextWindowSize("gpt-5-mini"), 400_000);
  assert.equal(piContextWindowSize("gpt-4.1-mini"), 1_047_576);
  assert.equal(piContextWindowSize("other"), 200_000);
});

test("a 250k gpt-5.5 turn reports against 272k, not the shared fallback tier", () => {
  const line = JSON.stringify({
    type: "message",
    timestamp: "2026-07-20T01:48:43.746Z",
    message: {
      role: "assistant",
      model: "gpt-5.5",
      content: [],
      usage: { input: 250_000, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
    },
  });
  const meta = computePiRuntimeMeta([line]);
  assert.equal(meta?.contextWindow, 272_000);
  assert.equal(meta?.contextPct, 92);
});

test("idle only on a clean stop; an aborted tail reads working", () => {
  // The full capture ends on an aborted turn - ambiguous, so it falls to `working`.
  const full = computePiSessionActivity([...PI_SESSION_LINES]);
  assert.equal(full?.state, "working");
  // The same session without that aborted tail ends on a clean `stop` - idle.
  const clean = computePiSessionActivity(PI_SESSION_LINES.slice(0, 7));
  assert.equal(clean?.state, "idle");
});
