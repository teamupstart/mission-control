import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookIngest } from "../src/shared/protocol.ts";
import type { SessionGoal } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { GOAL_MAX_CHARS } from "../src/shared/goal.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// Isolate the db in a throwaway home before config.ts resolves the state dir.
const home = mkdtempSync(join(tmpdir(), "mission-goals-"));
process.env.HARNESS_HOME = home;
const { openDb, getSessionGoal, loadSessionGoals, upsertSessionGoal, pruneSessionGoals } = await import("../src/server/db.ts");
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
    repoRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
    startedAt: 0,
    ...over,
  };
}

function evt(p: Partial<HookIngest> & Pick<HookIngest, "event">): HookIngest {
  return { agent: "claude", sessionId: null, cwd: null, transcriptPath: null, env: {}, ...p };
}

function persistedGoal(noteKey: string, text: string, prompt: string, updatedAt: number): SessionGoal {
  return {
    noteKey,
    text,
    source: "model",
    objective: prompt,
    prompt,
    focus: prompt,
    relationship: "initial",
    rationale: "fixture",
    objectiveVersion: 1,
    promptRevision: 1,
    resolvedPromptRevision: 1,
    pendingPrompts: [],
    updatedAt,
  };
}

/** A registry with one live, pane-matched session ready to take hooks. */
function withSession(id: string, pane: string) {
  const r = new Registry();
  r.applyDiscovery([
    mkDiscovered({ syntheticId: id, cwd: `/wt/${id}`, terminals: [mkMuxHandle({ paneId: pane })] }),
  ]);
  const s = r.snapshot().sessions.find((x) => x.id === id)!;
  return { r, s, env: { tmuxPane: pane } };
}

test("a prompt hook captures the full ask, not the 120-char ticker", () => {
  openDb();
  const { r, s, env } = withSession("g1", "%11");
  // Longer than the `activity` trim, which is exactly why the goal can't read that field:
  // the hook spec's `toState` cuts at 120 chars for the ticker; the whole text is only here.
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

test("every rapid pending instruction survives a restart in capture order", () => {
  const { r, s, env } = withSession("g15", "%25");
  r.applyHook(
    evt({
      event: "UserPromptSubmit",
      env,
      sessionId: "agent-rapid",
      prompt: "ship durable goal reconciliation",
    }),
  );
  r.upsertGoal(s.id, {
    objective: "Ship durable goal reconciliation",
    text: "Ship durable goal reconciliation",
    source: "model",
    relationship: "initial",
    objectiveVersion: 1,
    resolvedPromptRevision: 1,
    pendingPrompts: [],
  });
  for (const prompt of [
    "also show the effective objective in the drawer",
    "then add the focused regression test",
  ]) {
    r.applyHook(
      evt({ event: "UserPromptSubmit", env, sessionId: "agent-rapid", prompt }),
    );
  }

  const r2 = new Registry();
  r2.applyDiscovery([mkDiscovered({ syntheticId: s.id, cwd: "/wt/g15" })]);
  r2.applyHook(evt({ event: "Stop", env, sessionId: "agent-rapid" }));
  assert.deepEqual(r2.getGoal(s.id)?.pendingPrompts, [
    { revision: 2, prompt: "also show the effective objective in the drawer" },
    { revision: 3, prompt: "then add the focused regression test" },
  ]);
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

test("a prompt puts a goal on the card immediately, with no model involved", () => {
  // Tier 1. The card is never blank waiting on a model: the human's own words go up at once,
  // and `source: "heuristic"` is what tells the refiner to come back and improve them.
  const { r, s, env } = withSession("g7", "%17");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "fix the worktree cleanup on Reset" }));
  const card = r.snapshot().sessions.find((x) => x.id === s.id)!;
  assert.equal(card.goal?.text, "fix the worktree cleanup on Reset");
  assert.equal(card.goal?.source, "heuristic");
});

test("a later instruction becomes focus without replacing the durable objective", () => {
  const { r, s, env } = withSession("g14", "%24");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "build objective-aware Foreman completion" }));
  r.upsertGoal(s.id, {
    text: "Build objective-aware Foreman completion",
    objective: "Build objective-aware Foreman completion",
    focus: "Build objective-aware Foreman completion",
    relationship: "initial",
    rationale: "This is the first instruction.",
    source: "model",
    resolvedPromptRevision: 1,
    pendingPrompts: [],
  });

  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "first add the drawer regression test" }));
  const stored = r.getGoal(s.id)!;
  const card = r.snapshot().sessions.find((x) => x.id === s.id)!.goal!;

  assert.equal(stored.objective, "Build objective-aware Foreman completion");
  assert.equal(stored.text, "Build objective-aware Foreman completion");
  assert.equal(stored.prompt, "first add the drawer regression test");
  assert.equal(stored.relationship, null, "the relationship is unknown until reconciliation");
  assert.equal(stored.promptRevision, 2);
  assert.equal(stored.resolvedPromptRevision, 1);
  assert.deepEqual(stored.pendingPrompts, [
    { revision: 2, prompt: "first add the drawer regression test" },
  ]);
  assert.equal(card.text, "Build objective-aware Foreman completion");
  assert.equal(card.promptRevision, 2);
  assert.equal(card.resolvedPromptRevision, 1);
});

test("a long prompt is shortened to one line for the card", () => {
  // Prompts run to a 5,515-char p90. Unbounded, one card would push the rest off screen.
  const { r, s, env } = withSession("g11", "%21");
  const long = `refactor the registry so that ${"the note key stays stable across a restart ".repeat(20)}`;
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: long }));
  const card = r.snapshot().sessions.find((x) => x.id === s.id)!;
  assert.ok(card.goal!.text!.length <= GOAL_MAX_CHARS, `goal was ${card.goal!.text!.length} chars`);
  assert.ok(card.goal!.text!.startsWith("refactor the registry"), "lost the front of the ask");
  assert.ok(card.goal!.text!.endsWith("…"), "truncation is not marked");
  // The refiner still gets the whole thing - the card's bound is a display concern.
  assert.ok(r.getGoal(s.id)!.prompt!.length > GOAL_MAX_CHARS, "the stored prompt was truncated too");
});

test("a goal row carrying only a prompt reports no goal", () => {
  // The refiner writes {text, source} and the hook writes {prompt}; a row that somehow has
  // only the latter must render nothing rather than an empty line.
  const { r, s } = withSession("g12", "%22");
  r.upsertGoal(s.id, { prompt: "raw material only" });
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
  // foremanStatus reports as `lastActionAt` - so a dashboard of goal-carrying sessions would
  // report N phantom drafts in ForemanBar and a Foreman that just acted on every keystroke.
  const { r, s, env } = withSession("g8", "%18");
  r.applyHook(evt({ event: "UserPromptSubmit", env, prompt: "a real human ask" }));
  assert.equal(r.getGoal(s.id)?.prompt, "a real human ask", "precondition: the goal was stored");

  assert.equal(r.getNote(s.id), null, "a goal write fabricated a Foreman note");
  const status = foremanStatus(r);
  assert.equal(status.counts.pending, 0, "a goal write invented a pending draft");
  assert.equal(status.lastActionAt, null, "a goal write made Foreman claim it acted");
});

test("the prune drops orphaned goals and only orphaned goals", () => {
  // Every /clear rotates noteKeyFor and strands a row for good, and the table is read
  // wholesale into memory at boot - so without a sweep the daemon's start cost grows with
  // every /clear ever typed. Both conditions matter: age alone would blank a live card.
  const { r, s, env } = withSession("g13", "%23");
  r.applyHook(evt({ event: "UserPromptSubmit", env, sessionId: "agent-live", prompt: "the live ask" }));
  assert.equal(r.getGoal(s.id)?.prompt, "the live ask", "precondition: the live goal was stored");

  // Explicit low timestamps, and a cutoff below what every other test in this file writes:
  // they share one db, so a sweep with a realistic cutoff would reach their rows too and the
  // count below would be measuring its neighbours.
  const CUTOFF = 2000;
  // The /clear leftovers: keys no session carries any more.
  upsertSessionGoal(persistedGoal("orphan-old", "an abandoned goal", "old", 1000));
  upsertSessionGoal(persistedGoal("orphan-recent", "a recent goal", "recent", 9000));
  // The live session's own row, aged past the cutoff: a card open longer than the retention.
  // Written through the registry, not straight at the table, so the Map and the row agree -
  // which is what makes the getGoal assertion below mean anything.
  r.upsertGoal(s.id, { text: "the live goal", source: "model" }, 1500);

  assert.equal(r.pruneGoals(CUTOFF), 1, "the prune took something other than the one orphan");
  assert.equal(getSessionGoal("orphan-old"), undefined, "a stale orphan survived");
  assert.ok(getSessionGoal("orphan-recent"), "a recent orphan was dropped before its retention ran out");
  assert.ok(getSessionGoal("agent-live"), "a live session's goal was deleted out from under its card");
  assert.equal(r.getGoal(s.id)?.text, "the live goal", "the live card lost its goal to the sweep");
});

test("the prune clears the registry's in-memory goals too, not just the table", () => {
  // The table is only half the accumulation: `goals` is a Map that a table-only sweep would
  // leave growing for the daemon's whole life - and `upsertGoal` reads it before the db, so
  // a stale entry would outlive the row and quietly rewrite it.
  //
  // A band below the test above, for the same shared-db reason: one db, so a wider cutoff
  // would reach the neighbours' rows and the count would be measuring them.
  upsertSessionGoal(persistedGoal("orphan-mem", "stranded", "p", 100));

  // A fresh Registry loads every row into the Map, which is what a restart does - and the
  // discovery comes FIRST, because the sweep refuses to judge a key until the sessions is known.
  const r2 = new Registry();
  r2.applyDiscovery([mkDiscovered({ syntheticId: "g14", cwd: "/wt/g14", terminals: [mkMuxHandle({ paneId: "%24" })] })]);
  assert.ok(loadSessionGoals().some((g) => g.noteKey === "orphan-mem"), "precondition: the row is on disk");
  assert.equal(r2.pruneGoals(200), 1, "the sweep reached past its own orphan");
  assert.ok(!loadSessionGoals().some((g) => g.noteKey === "orphan-mem"), "the row survived the sweep");

  // The Map is private, so read it the way the daemon would: a session that adopts the swept
  // key must see no goal. A table-only sweep answers "stranded" here, from memory alone.
  r2.applyHook(evt({ event: "Stop", env: { tmuxPane: "%24" }, sessionId: "orphan-mem" }));
  assert.equal(r2.getGoal("g14"), null, "the swept goal outlived its row in memory");
});

test("a sweep before the first discovery deletes nothing", () => {
  // The boot race, and the reason the sweep is gated on `sessionsObserved`. The constructor
  // loads the whole goal table while `sessions` is still empty, and the refiner ticks
  // synchronously while the poller's first sweep is still awaiting I/O - so an ungated sweep
  // reads "no session holds this key" off a map nobody has filled in yet and deletes every
  // goal past the window, live sessions included. A parked session never rebuilds one: only a
  // new prompt does, and a parked session is parked.
  //
  // A band above every other cutoff in this file so no neighbour's sweep can reach this row.
  upsertSessionGoal(persistedGoal("boot-orphan", "old but unjudged", "p", 500_000));

  const r2 = new Registry();
  assert.equal(r2.sessionsObserved(), false, "precondition: no sweep has happened yet");
  assert.equal(r2.pruneGoals(600_000), 0, "the boot sweep judged keys before the sessions was known");
  assert.ok(getSessionGoal("boot-orphan"), "a goal was deleted before a single session was discovered");

  // And once the sessions ARE known, the same row is fair game - the guard delays the sweep, it
  // does not disable it. Asserted on the key rather than a count: this cutoff is above every
  // band in the file, so it reaches the rows the tests above left behind too.
  r2.applyDiscovery([mkDiscovered({ syntheticId: "g15", cwd: "/wt/g15", terminals: [mkMuxHandle({ paneId: "%25" })] })]);
  r2.pruneGoals(600_000);
  assert.equal(getSessionGoal("boot-orphan"), undefined, "the sweep never ran even after discovery");
});

test("an empty live-key set means liveness unknown, not nothing is live", () => {
  // Defense in depth beneath pruneGoals' guard: the helper is one await away from an empty
  // set at every callsite, so it must refuse rather than read the absence of keys as a fact.
  // A caller that forgets the guard should get a no-op, not a table wipe.
  upsertSessionGoal(persistedGoal("db-orphan", "old", "p", 10));

  assert.equal(pruneSessionGoals([], 20), 0, "an empty live set was read as 'nothing is live'");
  assert.ok(getSessionGoal("db-orphan"), "a row was deleted with no liveness information at all");

  // A real set still prunes: the refusal is about the empty case, not the helper.
  assert.equal(pruneSessionGoals(["some-other-session"], 20), 1, "a real live set stopped pruning");
  assert.equal(getSessionGoal("db-orphan"), undefined);
});
