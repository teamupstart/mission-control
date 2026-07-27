import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnsembleSummary } from "../src/shared/ensemble.ts";
import type { PaneDialog, ReviewItem, ServerEvent, Session, Task } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";

/**
 * What is at stake: the FLEET and the RUN agreeing about a blocked member.
 *
 * A member session waiting on the operator - a pending review, or a dialog on its pane - is the one
 * state where the two halves of this product used to contradict each other in plain sight: the
 * session card went red and said "needs you", while the run it belongs to still reported `running`
 * with no attention dot, sorted below finished work, and absent from the away digest. An operator
 * watching the run would never learn a question existed.
 *
 * Seven failures this pins, all of them silent:
 *
 *  1. The join lives nowhere that can see both halves. The store is DB-only and the registry is
 *     deliberately store-independent, so a needs-input count derived in either is 0 forever.
 *  2. It is derived from `Task.sessionId`, which is empty for a member the daemon rediscovered
 *     after a restart - zero blocked members for exactly the runs a restart left mid-flight.
 *  3. The derivation lands on the live path only, so the reconnect snapshot disagrees with the
 *     first event after it - right until you reload, or right only after you reload.
 *  4. No invalidation edge: a review is created, no ensemble row changes, nothing republishes.
 *  5. The republish feeds itself, or lands INSIDE the emit that triggered it - in which case the
 *     stale session reaches a browser last and the chip stays wrong until something else moves.
 *  6. The RUN's summary is refreshed but the MEMBER's own link is not, so the run row lights up
 *     over a card that still says the candidate is working.
 *  7. A member the run has finished with - retained, eliminated - drags the run's attention up with
 *     a question that is nobody's business any more, or is counted twice: once as blocked and once
 *     as ready.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-needs-input-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { EnsembleManager } = await import("../src/server/ensembles/manager.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

const request = {
  sourceKey: "manual:needs-input",
  sourceKind: "manual" as const,
  sourceId: null,
  title: "Try two approaches",
  intent: "Implement the feature",
  repoRoot: "/repo",
  strategyId: "best_of_n" as const,
  strategyConfig: { members: [{}, {}] },
};

/** The member's own worktree, which is what correlates its dispatched Task to its session. */
const MEMBER_CWD = "/ensemble-worktree";
/** The second candidate's, since every member is cut its own checkout from the pinned base. */
const SIBLING_CWD = "/ensemble-worktree-2";

function discovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "member-session",
    agent: "claude",
    name: "Candidate 1",
    nameSource: "process",
    cwd: MEMBER_CWD,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    terminals: [],
    startedAt: 0,
    ...over,
  };
}

const sibling = (over: Partial<DiscoveredSession> = {}): DiscoveredSession =>
  discovered({ syntheticId: "sibling-session", name: "Candidate 2", cwd: SIBLING_CWD, pid: 2, tty: "ttys2", ...over });

/**
 * The member's Task, with NO `sessionId`.
 *
 * Deliberately: a dispatched task correlates to its agent by worktree path, and that pointer is
 * empty on every session the daemon rediscovered from the process table after a restart. A
 * derivation that walked it would read zero blocked members here and be right only in the happy
 * case.
 */
const memberTask = (over: Partial<Task> = {}): Task =>
  baseTask({ id: "task-1", title: "Candidate 1", status: "running", worktreePath: MEMBER_CWD, ...over });

function review(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "review-1",
    sessionId: "unset",
    kind: "input",
    title: "Which cache should I invalidate?",
    body: "Both look plausible.",
    status: "pending",
    response: null,
    createdAt: 10,
    resolvedAt: null,
    ...over,
  };
}

const dialog: PaneDialog = {
  options: [
    { number: 1, label: "Yes" },
    { number: 2, label: "No" },
  ],
  highlighted: 1,
  prompt: "Run the migration?",
};

/**
 * Let the manager's deferred check run.
 *
 * It reacts to a session event on a microtask rather than inline, because emitting from inside an
 * emit delivers the correction to later subscribers BEFORE the event it corrects. One event-loop
 * turn drains that, plus the follow-up check the correction itself schedules.
 */
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * One run, one launched member bound to a live session, and the wiring the daemon has.
 *
 * The manager subscribes to the registry itself, so nothing here pokes it: every assertion below
 * drives a REAL registry event - a review arriving, a dialog appearing, a discovery tick - and
 * reads what came back out.
 */
function scene() {
  const registry = new Registry();
  const store = new EnsembleStore(db);
  const manager = new EnsembleManager(registry, store);
  const created = manager.create(request, 100);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("the fixture run must exist");
  const runId = created.run.id;
  const members = store.listMembers(runId);
  // Launched and bound to a Task, the way `reserveAttempt` leaves it.
  store.setMemberStatus(members[0]!.id, ["pending"], "active", { taskId: "task-1" });
  registry.upsertTask(memberTask());
  registry.applyDiscovery([discovered()]);
  const sessionId = registry.snapshot().sessions[0]!.id;
  // The engine republishes after every step it takes; do the same, so the baseline on the live
  // channel is the one a real launch would have left rather than the pre-launch draft.
  manager.publish(runId);

  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  return {
    registry,
    store,
    manager,
    runId,
    members,
    sessionId,
    events,
    stop() {
      unsubscribe();
      manager.stop();
    },
    /** Drive a review through the real registry path, then let the deferred check run. */
    async review(over: Partial<ReviewItem>): Promise<void> {
      registry.upsertReview(review({ sessionId, ...over }));
      await settled();
    },
    /** Drive one discovery sweep, then let the deferred check run. */
    async sweep(...sessions: DiscoveredSession[]): Promise<void> {
      registry.applyDiscovery(sessions.length === 0 ? [discovered()] : sessions);
      await settled();
    },
    /** The run as the live channel currently describes it - never a fresh store read. */
    live(): EnsembleSummary {
      const summary = registry.snapshot().ensembleSummaries.find((s) => s.id === runId);
      assert.ok(summary, "the run must be on the live channel");
      return summary;
    },
    /** What the member's own card carries, which is where its chip is drawn from. */
    card(): Session {
      const session = registry.getSession(sessionId);
      assert.ok(session, "the member session must exist");
      return session;
    },
    upserts(): EnsembleSummary[] {
      return events.flatMap((e) => (e.type === "ensemble_upsert" ? [e.ensemble] : []));
    },
    /**
     * Launch the roster's second member onto its own session, so the run has TWO cards.
     *
     * Needed by the swap case below: one blocked member becoming unblocked while the other becomes
     * blocked is the state where the run's own counts do not move, and it is the only thing left
     * holding the per-member cache honest.
     */
    launchSibling(): { taskId: string; sessionId: string } {
      store.setMemberStatus(members[1]!.id, ["pending"], "active", { taskId: "task-2" });
      registry.upsertTask(memberTask({ id: "task-2", title: "Candidate 2", worktreePath: SIBLING_CWD }));
      registry.applyDiscovery([discovered(), sibling()]);
      const found = registry.snapshot().sessions.find((session) => session.cwd === SIBLING_CWD);
      assert.ok(found, "the sibling member session must exist");
      manager.publish(runId);
      return { taskId: "task-2", sessionId: found.id };
    },
    /** The card of any session, by id - the sibling's included. */
    cardOf(id: string): Session {
      const session = registry.getSession(id);
      assert.ok(session, `session ${id} must exist`);
      return session;
    },
  };
}

test("a review on a member session republishes the run as needing attention, and takes it back", async () => {
  const s = scene();
  try {
    assert.equal(s.live().membersNeedingInput, 0);
    assert.equal(s.live().attention, false);
    assert.equal(s.card().task?.ensemble?.needsInput, false);

    // The edge. Creating a review touches no ensemble row at all - it reaches the registry through
    // `upsertReview`, which refreshes the session's pending count and emits a session event. That
    // is the ONLY signal the run gets, and it has to be enough.
    await s.review({});
    assert.equal(s.live().membersNeedingInput, 1);
    assert.equal(s.live().attention, true, "a member waiting on you is the run waiting on you");
    // Row state is untouched: the count is derived, so a restart re-derives it rather than
    // reloading a number that was only true when it was written.
    assert.equal(s.store.summary(s.runId)?.membersNeedingInput, 0);
    assert.equal(s.upserts().length, 1);

    // And back again. Resolving is the same edge in reverse.
    await s.review({ status: "answered", response: "the second one", resolvedAt: 20 });
    assert.equal(s.live().membersNeedingInput, 0);
    assert.equal(s.live().attention, false);
    assert.equal(s.card().task?.ensemble?.needsInput, false);
    assert.equal(s.upserts().length, 2);
  } finally {
    s.stop();
  }
});

test("the member's own link is fresh on the session edge, not one task event later", async () => {
  const s = scene();
  try {
    // The regression this pins: the run's summary republished while the MEMBER's chip stayed stale,
    // because the link map is otherwise rebuilt only when an ensemble ROW changes. A review is not
    // an ensemble row change, so nothing would have rebuilt it - and the operator would see a lit
    // run row over a card saying the candidate is working.
    await s.review({});

    // The projection the registry holds, read the way `taskSummaryFor` reads it.
    assert.equal(s.card().task?.ensemble?.needsInput, true);
    // And it was PUSHED, not merely available: the LAST word on that session carries it, which is
    // what makes a browser redraw without a poll. This is why the check is deferred out of the
    // emit - reacting inline puts the correction BEFORE the stale event for every subscriber that
    // registered after the manager, and a reducer keeping the last write would show it unblocked.
    const sessions = s.events.flatMap((e) =>
      e.type === "session_upsert" && e.session.id === s.sessionId ? [e.session] : [],
    );
    assert.ok(sessions.length >= 2, "the correcting session event has to exist");
    assert.equal(sessions.at(-1)?.task?.ensemble?.needsInput, true);
    // Ordering: the fresh link reaches the card BEFORE the run's summary goes out, so there is no
    // tick in which the two disagree the other way round.
    const kinds = s.events.map((e) => e.type);
    assert.ok(kinds.lastIndexOf("session_upsert") < kinds.indexOf("ensemble_upsert"));
  } finally {
    s.stop();
  }
});

test("a pane dialog counts as waiting on you, exactly like a review", async () => {
  const s = scene();
  try {
    // A driver-run member has no pane and a terminal one is read off its screen, but either way the
    // question lands on the SESSION - so the run must not hold two notions of "blocked".
    await s.sweep(discovered({ paneDialog: dialog }));
    assert.equal(s.live().membersNeedingInput, 1);
    assert.equal(s.live().attention, true);
    assert.equal(s.card().task?.ensemble?.needsInput, true);

    await s.sweep(discovered({ paneDialog: null }));
    assert.equal(s.live().membersNeedingInput, 0);
    assert.equal(s.live().attention, false);
    assert.equal(s.card().task?.ensemble?.needsInput, false);
  } finally {
    s.stop();
  }
});

test("the republish is edge-guarded, so the resync it causes cannot feed itself", async () => {
  const s = scene();
  try {
    await s.review({});
    assert.equal(s.upserts().length, 1);

    // A second session event that changes nothing DERIVED must emit nothing. Without the guard this
    // is not merely chatty: `publish` refreshes the projection, which resyncs every session's task
    // chip, which emits `session_upsert` - the event that triggered the publish. A second pending
    // review on the same session is the sharpest version, because the session genuinely changed
    // (`pendingReviews` 1 -> 2) and the derived answer did not.
    await s.review({ id: "review-2" });
    assert.equal(s.card().pendingReviews, 2);
    assert.equal(s.upserts().length, 1, "still blocked, still 1 - nothing new to say");

    // An ordinary discovery tick that renames the session: same guard, same silence.
    await s.sweep(discovered({ name: "Candidate one" }));
    assert.equal(s.card().name, "Candidate one");
    assert.equal(s.upserts().length, 1);

    // Answering ONE of the two leaves the member blocked, so still nothing.
    await s.review({ id: "review-2", status: "answered", resolvedAt: 30 });
    assert.equal(s.card().pendingReviews, 1);
    assert.equal(s.upserts().length, 1);

    // Answering the last one is a real change.
    await s.review({ status: "answered", resolvedAt: 40 });
    assert.equal(s.upserts().length, 2);
    assert.equal(s.live().membersNeedingInput, 0);
  } finally {
    s.stop();
  }
});

test("a blocked member counts once: blocked, never also ready", async () => {
  const s = scene();
  try {
    // The double-count `membersReady` exists to prevent. This member has SUBMITTED - it owns a
    // ready artifact - and is sitting on a question. It is one member.
    const attempt = s.store.insertAttempt({
      runId: s.runId,
      memberId: s.members[0]!.id,
      attempt: 1,
      taskId: "task-1",
      sessionId: null,
      agent: null,
      requestedModel: null,
      requestedEffort: null,
      baseSha: null,
      worktreePath: null,
      branch: null,
      status: "submitted",
    });
    s.store.recordArtifact({
      runId: s.runId,
      attemptId: attempt.id,
      kind: "commit",
      formatVersion: 1,
      attempt: 1,
      status: "ready",
      locator: {},
      digest: "d",
      metadata: {},
      operationKey: "op-1",
      readyAt: 1,
    });
    s.store.setMemberStatus(s.members[0]!.id, ["active"], "submitted");
    assert.deepEqual(pick(s.manager.publish(s.runId)), {
      readyArtifacts: 1,
      membersReady: 1,
      membersNeedingInput: 0,
      membersOut: 0,
      launchedMembers: 1,
    });

    await s.review({});
    assert.deepEqual(pick(s.live()), {
      // The ARTIFACT count is unchanged and means what it always did - a restore acts on it.
      readyArtifacts: 1,
      // The MEMBER moved. 1 ready / 0 blocked became 0 / 1, never 1 / 1: added together, a
      // rendering would draw two dots for one candidate and could exceed `maxMembers`.
      membersReady: 0,
      membersNeedingInput: 1,
      membersOut: 0,
      launchedMembers: 1,
    });
    assertDisjoint(s.live());

    await s.review({ status: "answered", resolvedAt: 20 });
    assert.deepEqual(pick(s.live()), {
      readyArtifacts: 1,
      membersReady: 1,
      membersNeedingInput: 0,
      membersOut: 0,
      launchedMembers: 1,
    });
    assertDisjoint(s.live());
  } finally {
    s.stop();
  }
});

test("a member the run has finished with does not drag its attention up", async () => {
  const s = scene();
  try {
    await s.review({});
    assert.equal(s.live().membersNeedingInput, 1);

    // `retained` is terminal-but-not-out: its work still counts, and its session's dialogs are no
    // longer this run's problem. The question is still open on the card, and the run is right to
    // stop reporting it - the operator answers it as a session, not as a candidate.
    s.store.setMemberStatus(s.members[0]!.id, ["active"], "retained");
    await s.sweep();
    assert.equal(s.card().pendingReviews, 1, "the operator still owes that session an answer");
    assert.equal(s.live().membersNeedingInput, 0);
    assert.equal(s.live().attention, false);
    assert.equal(s.card().task?.ensemble?.needsInput, false);
    assertDisjoint(s.live());
  } finally {
    s.stop();
  }
});

test("a link rebuild that pushed nothing does not count as published", async () => {
  const s = scene();
  const two = s.launchSibling();
  try {
    await s.review({});
    assert.equal(s.live().membersNeedingInput, 1);
    assert.equal(s.card().task?.ensemble?.needsInput, true);
    assert.equal(s.cardOf(two.sessionId).task?.ensemble?.needsInput, false);
    const published = s.upserts().length;

    // The question moves from one candidate to the other in a single tick, so the RUN's counts do
    // not move at all (1 blocked before, 1 blocked after) and the per-member cache is the only
    // thing that can still notice. Between the session events and the deferred check, an unrelated
    // member write fires `onTaskLinksChanged` - which rebuilds the link map and emits NOTHING.
    //
    // That rebuild must not be recorded as "published". Recorded, the deferred check compares the
    // fresh answer against a cache describing a push that never happened, concludes nothing moved,
    // and returns - leaving both cards carrying the previous tick's chip with no event coming to
    // correct them. The counts would have hidden it for any change that also moved a count; the
    // swap is the case where nothing else does.
    s.registry.upsertReview(review({ sessionId: s.sessionId, status: "answered", resolvedAt: 20 }));
    s.registry.upsertReview(review({ id: "review-sibling", sessionId: two.sessionId }));
    s.store.setMemberStatus(s.members[1]!.id, ["active"], "active", { resultLabel: "rank 1" });
    await settled();

    assert.equal(s.live().membersNeedingInput, 1, "still exactly one member blocked");
    assert.ok(s.upserts().length > published, "the swap is a real change and has to be announced");
    // Both cards, which is the whole point: the answered one has to stop saying it is waiting.
    assert.equal(s.card().task?.ensemble?.needsInput, false);
    assert.equal(s.cardOf(two.sessionId).task?.ensemble?.needsInput, true);
    // And the corrections were PUSHED, not merely computable on the next unrelated sweep.
    const pushed = new Map<string, boolean | undefined>();
    for (const event of s.events) {
      if (event.type === "session_upsert") {
        pushed.set(event.session.id, event.session.task?.ensemble?.needsInput);
      }
    }
    assert.equal(pushed.get(s.sessionId), false);
    assert.equal(pushed.get(two.sessionId), true);
  } finally {
    s.stop();
  }
});

test("the boot snapshot reports the same blocked member the live channel does", async () => {
  const s = scene();
  try {
    await s.review({});
    const streamed = s.live();
    assert.equal(streamed.membersNeedingInput, 1);
    s.stop();

    // A daemon starting against this state installs its catalog before serving SSE, so the boot
    // path is a DIFFERENT read (`listSummaries`) from the live one (`summary`). Decorated in one
    // and not the other, the dashboard is right until you reload it - or right only after.
    const booted = new EnsembleManager(s.registry, new EnsembleStore(db));
    try {
      const snapshot = s.registry.snapshot().ensembleSummaries.find((e) => e.id === s.runId);
      assert.deepEqual(snapshot, streamed);
      assert.equal(snapshot?.membersNeedingInput, 1);
      assert.equal(snapshot?.attention, true);
      // The HTTP list route reads the same decorated projection, so a browser that fetches instead
      // of streaming sees the same run.
      assert.deepEqual(booted.summaries().find((e) => e.id === s.runId), streamed);
      // And the member's chip is rebuilt from the registry the new manager was handed, not
      // resurrected from a cache the old one held.
      assert.equal(s.card().task?.ensemble?.needsInput, true);
    } finally {
      booted.stop();
    }
  } finally {
    s.stop();
  }
});

test("an unlaunched member and an unrelated session are both nobody's question", async () => {
  const s = scene();
  try {
    // The unlaunched sibling: a `pending` member holds no Task, so there is nothing to ask about.
    assert.equal(s.live().memberCount, 2);
    assert.equal(s.live().launchedMembers, 1);

    // A review on a session running ORDINARY work must not reach any run. This is the guard that
    // stops the whole fleet's questions landing on whichever ensemble happens to exist.
    s.registry.upsertTask(baseTask({ id: "task-plain", status: "running", worktreePath: "/elsewhere" }));
    await s.sweep(
      discovered(),
      discovered({ syntheticId: "plain-session", pid: 2, tty: "ttys2", cwd: "/elsewhere" }),
    );
    const plain = s.registry.snapshot().sessions.find((session) => session.cwd === "/elsewhere");
    assert.ok(plain);
    assert.equal(plain.task?.id, "task-plain");
    assert.equal(plain.task?.ensemble, null);

    const before = s.upserts().length;
    s.registry.upsertReview(review({ id: "review-plain", sessionId: plain.id }));
    await settled();
    assert.equal(s.live().membersNeedingInput, 0);
    assert.equal(s.live().attention, false);
    assert.equal(s.upserts().length, before, "an unrelated session's question publishes nothing");
  } finally {
    s.stop();
  }
});

/** The counts a progress rendering reads, together, so a failure diff shows what moved. */
function pick(summary: EnsembleSummary | null) {
  assert.ok(summary);
  return {
    readyArtifacts: summary.readyArtifacts,
    membersReady: summary.membersReady,
    membersNeedingInput: summary.membersNeedingInput,
    membersOut: summary.membersOut,
    launchedMembers: summary.launchedMembers,
  };
}

/**
 * The contract every later phase builds its dots on: no member counted twice, and "working" is a
 * non-negative remainder.
 */
function assertDisjoint(summary: EnsembleSummary): void {
  assert.ok(
    summary.membersOut + summary.membersNeedingInput + summary.membersReady <=
      summary.launchedMembers,
    `counted more members than were launched: ${JSON.stringify(summary)}`,
  );
}
