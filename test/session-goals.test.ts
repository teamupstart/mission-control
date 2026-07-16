import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookIngest } from "../src/shared/protocol.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// Isolate the db in a throwaway home before config.ts resolves the state dir.
const home = mkdtempSync(join(tmpdir(), "fleet-goals-"));
process.env.HARNESS_HOME = home;
const { openDb, getSessionGoal, loadSessionGoals } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { foremanStatus } = await import("../src/server/foreman/config.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "n",
    nameSource: "process",
    cwd: "/wt/a",
    gitBranch: null,
    gitRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    wezterm: null,
    tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%1" },
    startedAt: 0,
    ...over,
  };
}

function evt(p: Partial<HookIngest> & Pick<HookIngest, "event">): HookIngest {
  return { sessionId: null, cwd: null, transcriptPath: null, env: {}, ...p };
}

/** A registry with one live, pane-matched session ready to take hooks. */
function withSession(id: string, pane: string) {
  const r = new Registry();
  r.applyDiscovery([
    mkDiscovered({ syntheticId: id, cwd: `/wt/${id}`, tmux: { session: "s", window: "w", windowIndex: 0, paneId: pane } }),
  ]);
  const s = r.snapshot().sessions.find((x) => x.id === id)!;
  return { r, s, env: { tmuxPane: pane } };
}

test("a prompt hook captures the full ask, not the 120-char ticker", () => {
  openDb();
  const { r, s, env } = withSession("g1", "%11");
  // Longer than the `activity` trim, which is exactly why the goal can't read that field:
  // `hookToState` cuts at 120 chars for the ticker and the whole text exists only here.
  const prompt = `refactor the registry so that ${"the note key is stable ".repeat(12)}`;
  assert.ok(prompt.length > 120);
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt }));
  assert.equal(r.getGoal(s.id)?.prompt, prompt.trim());
});

test("a background task reporting in never overwrites the captured ask", () => {
  // The common path: 200 of 396 real UserPromptSubmit events are task notifications. If
  // these landed, a goal would be replaced by machinery every time a task finished.
  const { r, s, env } = withSession("g2", "%12");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "fix the reset bug" }));
  r.applyHook(
    evt({
      event: "UserPromptSubmit",
      env,
      prompt: "<task-notification>\n<task-id>abc</task-id>\n<status>failed</status>\n</task-notification>",
    }),
  );
  assert.equal(r.getGoal(s.id)?.prompt, "fix the reset bug");
});

test("a goal survives a restart and re-attaches by agent session id", () => {
  const { r, s, env } = withSession("g3", "%13");
  r.applyHook(evt({ event: "UserPromptSubmit", env, sessionId: "agent-g3", prompt: "ship the goal feature" }));
  assert.ok(loadSessionGoals().some((g) => g.noteKey === "agent-g3"));
  assert.equal(getSessionGoal("agent-g3")?.prompt, "ship the goal feature");

  // A fresh Registry is what a daemon restart looks like.
  const r2 = new Registry();
  r2.applyDiscovery([mkDiscovered({ syntheticId: s.id, cwd: `/wt/g3` })]);
  r2.applyHook(evt({ event: "Stop", env: { tmuxPane: "%13" }, sessionId: "agent-g3" }));
  assert.equal(r2.getGoal(s.id)?.prompt, "ship the goal feature");
});

test("upsertGoal merges: capturing a new prompt keeps the sentence already derived", () => {
  const { r, s } = withSession("g4", "%14");
  r.upsertGoal(s.id, { text: "Ship the Goal feature.", source: "model", prompt: "old ask" });
  r.upsertGoal(s.id, { prompt: "a newer ask" });
  const g = r.getGoal(s.id);
  assert.equal(g?.prompt, "a newer ask");
  assert.equal(g?.text, "Ship the Goal feature.", "the sentence survives a prompt-only patch");
  assert.equal(g?.source, "model");
});

test("updatedAt tracks the sentence, not every write", () => {
  const { r, s } = withSession("g5", "%15");
  r.upsertGoal(s.id, { text: "Fix the flaky test.", source: "heuristic" }, 1000);
  // Re-deriving the SAME sentence is the common case - most follow-ups refine rather than
  // redefine - and must not read as a session changing course.
  r.upsertGoal(s.id, { text: "Fix the flaky test.", source: "model" }, 2000);
  assert.equal(r.getGoal(s.id)?.updatedAt, 1000, "an unchanged sentence moved the stamp");
  r.upsertGoal(s.id, { text: "Fix the OTHER flaky test." }, 3000);
  assert.equal(r.getGoal(s.id)?.updatedAt, 3000, "a changed sentence did not move the stamp");
});

test("a goal is denormalized onto its card, without the prompt behind it", () => {
  const { r, s } = withSession("g6", "%16");
  assert.equal(r.snapshot().sessions.find((x) => x.id === s.id)!.goal, null);
  r.upsertGoal(s.id, { text: "Ship it.", source: "model", prompt: "x".repeat(3000) });
  const card = r.snapshot().sessions.find((x) => x.id === s.id)!;
  assert.equal(card.goal?.text, "Ship it.");
  assert.equal(card.goal?.source, "model");
  // The prompt is the refiner's input, up to 4KB. It rides no snapshot.
  assert.equal(JSON.stringify(card.goal).includes("xxx"), false, "the prompt leaked onto the card");
});

test("a captured prompt alone is not yet a goal on the card", () => {
  // Phase 2 stores the raw material; the sentence comes later. A row with no sentence must
  // not render as an empty goal line.
  const { r, s, env } = withSession("g7", "%17");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "do the thing" }));
  assert.equal(r.getGoal(s.id)?.prompt, "do the thing", "the prompt was not captured");
  assert.equal(r.snapshot().sessions.find((x) => x.id === s.id)!.goal, null);
});

// `/clear` and `/compact` are decided behaviour: a clear wipes the goal, a compact must not
// touch it. Neither fires UserPromptSubmit (0 of 403 real events, though 198 transcripts hold
// a /clear) - Claude Code reports built-ins as lifecycle events instead. So the outcome rides
// entirely on whether the AGENT SESSION ID rotates, which is what these pin.

test("/clear wipes the goal", () => {
  const { r, s, env } = withSession("g9", "%19");
  r.applyHook(evt({ event: "UserPromptSubmit", env, sessionId: "agent-before", prompt: "the old ask" }));
  r.upsertGoal(s.id, { text: "The old goal.", source: "model" });
  assert.equal(
    r.snapshot().sessions.find((x) => x.id === s.id)!.goal?.text,
    "The old goal.",
    "precondition: the goal is on the card",
  );

  // A /clear ends the session and starts a fresh one carrying a NEW agent session id. That
  // rotates noteKeyFor, so the goal orphans with the note and queue - no wipe code, which is
  // exactly why this test exists: nothing in the goal path says "clear", and a change to
  // how ids rotate would silently resurrect a stale goal on a cleared card.
  r.applyHook(evt({ event: "SessionEnd", env, sessionId: "agent-before", reason: "clear" }));
  r.applyHook(evt({ event: "SessionStart", env, sessionId: "agent-after", source: "clear" }));
  assert.equal(r.snapshot().sessions.find((x) => x.id === s.id)!.goal, null, "the goal survived a /clear");
});

test("/compact leaves the goal alone", () => {
  const { r, s, env } = withSession("g10", "%20");
  r.applyHook(evt({ event: "UserPromptSubmit", env, sessionId: "agent-c", prompt: "the ask" }));
  r.upsertGoal(s.id, { text: "Ship the Goal feature.", source: "model" });

  // A compact fires PreCompact and then SessionStart(source=compact) - but with the SAME
  // session id, verified directly: this repo's own compacted session kept one transcript file
  // holding both the /compact and everything after it. Same id, same key, same goal.
  r.applyHook(evt({ event: "PreCompact", env, sessionId: "agent-c" }));
  r.applyHook(evt({ event: "SessionStart", env, sessionId: "agent-c", source: "compact" }));

  const card = r.snapshot().sessions.find((x) => x.id === s.id)!;
  assert.equal(card.goal?.text, "Ship the Goal feature.", "a /compact wiped the goal");
  assert.equal(r.getGoal(s.id)?.prompt, "the ask", "a /compact clobbered the refiner's input");
});

test("having a goal does not make a session look like a Foreman draft", () => {
  // The reason goals are their own row rather than columns on session_notes. Sharing it
  // would force a goal-only write to invent a `disposition` (defaulting to "pending" =
  // "Foreman drafted a reply it hasn't sent") and to bump the `updatedAt` that
  // foremanStatus reports as `lastActionAt` - so a fleet of goal-carrying sessions would
  // report N phantom drafts in ForemanBar and a Foreman that just acted on every keystroke.
  const { r, s, env } = withSession("g8", "%18");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "a real human ask" }));
  assert.equal(r.getGoal(s.id)?.prompt, "a real human ask", "precondition: the goal was stored");

  assert.equal(r.getNote(s.id), null, "a goal write fabricated a Foreman note");
  const status = foremanStatus(r);
  assert.equal(status.counts.pending, 0, "a goal write invented a pending draft");
  assert.equal(status.lastActionAt, null, "a goal write made Foreman claim it acted");
});
