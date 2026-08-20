import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PromptedFailureTracker,
  decidePromptedWrapup,
  planPromptedWrapup,
} from "../src/server/foreman/prompted-wrapup.ts";
import type { PromptedConfig, PromptedInput } from "../src/server/foreman/prompted-wrapup.ts";
import { VERIFY_FAILURE_CAP, tickTargets } from "../src/server/foreman/queue-machine.ts";
import type { QueueVerdict } from "../src/server/foreman/queue-machine.ts";
import { isWrapupPayload, WRAPUP_PR } from "../src/shared/queue.ts";
import { PromptedWrapupSchema } from "../src/shared/protocol.ts";
import type { ReportBucket } from "../src/shared/session.ts";
import type {
  GapSeverity,
  Session,
  SessionGoal,
  SessionQueue,
  SessionQueueSummary,
  WorkItem,
} from "../src/shared/types.ts";
import { mkMuxHandle, mkTaskSummary } from "./helpers/session-fixture.ts";

// The `prompted` wrap-up trigger. Same discipline as queue-machine.test.ts: the
// decision is pure with `now` injected, so the whole policy is a table.
//
// The stakes here are higher than the drain trigger's, which is why the table is
// long. This trigger fires at sessions Foreman was never asked to manage, on a
// signal ("the agent stopped") that is ambiguous by construction, and what it types
// PUSHES. Every gate below is a case where firing would be wrong in a way a human
// would have to clean up afterwards.

const NOW = 1_000_000;
const GOAL = "add retry handling to the uploader";

function mkIntent(over: Partial<SessionGoal> = {}): SessionGoal {
  return {
    noteKey: "agent-1",
    text: "Add retry handling.",
    source: "model",
    objective: GOAL,
    prompt: GOAL,
    focus: "Add retry handling",
    relationship: "initial",
    rationale: "This is the first substantive instruction.",
    objectiveVersion: 1,
    promptRevision: 1,
    resolvedPromptRevision: 1,
    pendingPrompts: [],
    updatedAt: NOW,
    ...over,
  };
}

const CFG: PromptedConfig = {
  triggers: ["prompted"],
  wrapup: "ask",
  settleMs: 10_000,
  skipScoutWrapup: true,
  skipReviewArtifactWrapup: true,
};

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "work",
    runtime: "terminal",
    // A dispatched worktree session, as participate-always semantics modeled it.
    foremanInvite: "dispatch",
    nameSource: "tmux",
    state: "idle",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 1,
    tty: "ttys001",
    permissionMode: null,
    terminals: [mkMuxHandle({ session: "work", windowName: "w", windowIndex: 0, paneId: "%1" })],
    agentSessionId: "agent-1",
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: "idle",
    startedAt: 0,
    firstSeen: 0,
    lastSeen: NOW,
    // Settled well past settleMs by default, so a test opts INTO un-settled.
    lastActivity: NOW - 60_000,
    workCycle: {
      logicalKey: "agent-1",
      generation: 1,
      active: false,
      completedAt: NOW - 60_000,
      updatedAt: NOW - 60_000,
    },
    pendingReviews: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    pendingEffort: null,
    note: null,
    cost: null,
    goal: { text: "Add retry handling.", source: "model", updatedAt: NOW },
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    pipeline: null,
    paneDialog: null,
    ...over,
  };
}

function mkQueue(over: Partial<SessionQueue> = {}): SessionQueue {
  return {
    noteKey: "agent-1",
    cwd: "/repo",
    branch: "feature",
    wrapupAskedAt: null,
    wrapupAnswer: null,
    promptedGoal: null,
    promptedEvidence: null,
    promptedActivityAt: null,
    promptedLegacyCutoverGeneration: null,
    promptedConsumedGeneration: null,
    promptedDirectHandoff: null,
    updatedAt: 0,
    items: [],
    ...over,
  };
}

function mkItem(): WorkItem {
  return {
    id: "item-1",
    noteKey: "agent-1",
    seq: 0,
    intent: "queued work",
    state: "queued",
    round: 0,
    baseSha: null,
    transcriptAnchor: null,
    gaps: [],
    sendAttempts: 0,
    verifyFailures: 0,
    escalationReason: null,
    lastVerdict: null,
    approvedAt: null,
    proposedPayload: null,
    recoveredAt: null,
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
    sentAt: null,
    completedAt: null,
  };
}

function decide(over: Partial<PromptedInput> = {}) {
  return decidePromptedWrapup({
    session: mkSession(),
    bucket: "idle" as ReportBucket,
    queue: null,
    intent: mkIntent(),
    cfg: CFG,
    now: NOW,
    ...over,
  });
}

/** A clean, complete verdict - what "the work is done" looks like. */
function mkVerdict(over: Partial<QueueVerdict> = {}): QueueVerdict {
  return { complete: true, summary: "done", gaps: [], resolved: [], confidence: 0.9, ...over };
}

function mkGap(severity: GapSeverity) {
  return { id: "g1", severity, kind: "untested" as const, path: "a.ts", detail: "no test", fix: "add one" };
}

// ---- step 1: is this session even a candidate? ----

test("a settled, instrumented, goal-carrying session with no queue is a candidate", () => {
  const r = decide();
  assert.equal(r.kind, "check");
  assert.equal(r.kind === "check" && r.objective, GOAL);
});

test("a prompted scout episode retires without verification or automatic shipping", () => {
  const r = decide({ session: mkSession({ task: mkTaskSummary({ kind: "scout" }) }) });
  assert.equal(r.kind, "retire");
  assert.match(r.kind === "retire" ? r.why : "", /scout/);
});

test("a prompted chat retires before verification unless it selected a Workflow", () => {
  const chat = decide({
    session: mkSession({ task: mkTaskSummary({ kind: "chat", workflowId: null }) }),
    cfg: { ...CFG, skipScoutWrapup: false, skipReviewArtifactWrapup: false },
  });
  assert.equal(chat.kind, "retire");
  assert.match(chat.kind === "retire" ? chat.why : "", /chat/);

  const withWorkflow = decide({
    session: mkSession({
      task: mkTaskSummary({ kind: "chat", workflowId: "workflow-review" }),
    }),
  });
  assert.equal(withWorkflow.kind, "check");
});

test("a prompted mockup output retires without a Workflow or PR action", () => {
  const objective = "Explore the navigation layout.\n\nOutput: mockups";
  const r = decide({ intent: mkIntent({ objective }) });
  assert.equal(r.kind, "retire");
  assert.match(r.kind === "retire" ? r.why : "", /review artifact/);
});

test("disabled completion safeguards let prompted work reach verification", () => {
  const scout = decide({
    session: mkSession({ task: mkTaskSummary({ kind: "scout" }) }),
    cfg: { ...CFG, skipScoutWrapup: false },
  });
  assert.equal(scout.kind, "check");

  const mockups = decide({
    intent: mkIntent({ objective: "Output: mockups" }),
    cfg: { ...CFG, skipReviewArtifactWrapup: false },
  });
  assert.equal(mockups.kind, "check");
});

test("a prompted implementation may still use mockups as context", () => {
  const objective = "Use the mockups to deliver the production-ready implementation.";
  const r = decide({ intent: mkIntent({ objective }) });
  assert.equal(r.kind, "check");
});

test("the trigger being off is decided FIRST, before anything that could write", () => {
  // An unarmed trigger must reach no other branch. This is the switch a human flips to
  // make Foreman stop touching their sessions, so it has to be absolute rather than one
  // vote among the gates below.
  const r = decide({ cfg: { ...CFG, triggers: ["drain"] } });
  assert.equal(r.kind, "skip");
  assert.match(r.kind === "skip" ? r.why : "", /off/);
});

test("an empty trigger list arms nothing - it is a choice, not an unset value", () => {
  assert.equal(decide({ cfg: { ...CFG, triggers: [] } }).kind, "skip");
});

test("a checkout with queue ITEMS belongs to the drain trigger, even with both armed", () => {
  // The overlap rule. Two triggers firing on one branch is two shipping actions
  // racing, and the mark-before-type ordering cannot prevent it: the two guards are
  // different fields, so neither retires the other.
  const r = decide({
    cfg: { ...CFG, triggers: ["drain", "prompted"] },
    queue: mkQueue({ items: [mkItem()] }),
  });
  assert.equal(r.kind, "skip");
  assert.match(r.kind === "skip" ? r.why : "", /drain trigger owns it/);
});

test("an ITEMLESS queue row does NOT disarm the trigger", () => {
  // The row exists as soon as anything touches wrap-up state - including this trigger
  // itself, via ensureQueue. Gating on the row rather than on its items would let the
  // first fire permanently disarm every subsequent one.
  assert.equal(decide({ queue: mkQueue() }).kind, "check");
});

test("a session that needs a human is stopped, not finished", () => {
  // An agent waiting on an answer looks idle. Sending a shipping instruction would answer
  // its question with an unrelated instruction.
  assert.equal(decide({ bucket: "needs-you" as ReportBucket }).kind, "skip");
  assert.equal(decide({ session: mkSession({ state: "awaiting_input" }) }).kind, "skip");
});

test("a session with no hooks has no completion signal to trust", () => {
  assert.equal(decide({ session: mkSession({ hooksSeen: false }) }).kind, "skip");
});

test("a STALE overlay skips outright here - it does not degrade to an ask", () => {
  // This is where the prompted trigger is deliberately stricter than the drain one. On
  // drain there is a real event (the last item went terminal), so a stale overlay still
  // leaves something true to tell the human and step 5 degrades to `ask-wrapup`. Here
  // the freshness IS the event: with no recent signal there is no evidence the agent
  // ever stopped, and a card asking "ship this?" about a possibly-mid-turn session is a
  // question nobody can answer correctly.
  const r = decide({ session: mkSession({ instrumented: false }) });
  assert.equal(r.kind, "skip");
  assert.match(r.kind === "skip" ? r.why : "", /no recent signal/);
});

test("a session that has not settled is still working", () => {
  assert.equal(decide({ session: mkSession({ lastActivity: NOW - 1000 }) }).kind, "skip");
  // ...and exactly at the boundary it has.
  assert.equal(decide({ session: mkSession({ lastActivity: NOW - 10_000 }) }).kind, "check");
});

test("a session with no pane is skipped silently - there is nothing to escalate", () => {
  assert.equal(decide({ session: mkSession({ terminals: [] }) }).kind, "skip");
});

test("an exited session is skipped while a supported Codex session is checked", () => {
  assert.equal(decide({ session: mkSession({ state: "exited" }) }).kind, "skip");
  assert.equal(decide({ session: mkSession({ agent: "codex" }) }).kind, "check");
});

test("no captured goal means nothing to verify the work AGAINST", () => {
  assert.equal(decide({ intent: null }).kind, "skip");
  assert.equal(decide({ intent: mkIntent({ objective: "   " }) }).kind, "skip");
});

test("an unresolved or unclear instruction pauses automatic completion", () => {
  assert.equal(
    decide({ intent: mkIntent({ promptRevision: 2, resolvedPromptRevision: 1, relationship: null }) }).kind,
    "skip",
  );
  assert.equal(decide({ intent: mkIntent({ relationship: "unclear" }) }).kind, "skip");
});

// ---- the two guards that make this trigger terminate ----

test("THE LOOP GUARD: a goal that is Foreman's own wrap-up never re-fires", () => {
  const r = decide({ intent: mkIntent({ prompt: WRAPUP_PR }) });
  assert.equal(r.kind, "skip");
  assert.match(r.kind === "skip" ? r.why : "", /Foreman's own wrap-up/);
  // Whitespace must not smuggle it past - the pane echo is not byte-exact.
  assert.equal(decide({ intent: mkIntent({ prompt: `  ${WRAPUP_PR}  ` }) }).kind, "skip");
});

test("THE LOOP GUARD holds for wrap-up text we no longer send", () => {
  // The goal was captured on the operator's machine BEFORE the upgrade that reworded
  // this payload, and is read back after it. Recognise only the current spelling and
  // that session's goal stops being Foreman's own voice: the trigger re-arms and opens
  // a second PR for work it already shipped. `RETIRED_WRAPUP_PAYLOADS` is append-only
  // for this reason, and this is the test that notices when someone deletes from it.
  const retired = [
    "Please commit this work, push the branch, and open a PR.",
    "Please commit this work, push the branch, and open a PR. Then merge the default branch into" +
      " yours and resolve any conflicts, and follow the PR's CI to completion - fix whatever fails" +
      " and push again until every check passes and the PR has no merge conflicts.",
  ];
  for (const payload of retired) {
    assert.notEqual(payload, WRAPUP_PR, "reword a fixture only by ADDING to the retired list");
    assert.ok(isWrapupPayload(payload));
    assert.equal(decide({ intent: mkIntent({ prompt: payload }) }).kind, "skip");
  }
});

test("the direct shipping payload is one line", () => {
  // `sendText` submits on every embedded newline, so wrapping either of these to keep
  // it under a column limit types half an instruction and then sends it. The PR payload
  // is the long one and therefore the one that will tempt someone.
  //
  assert.ok(!/[\r\n]/.test(WRAPUP_PR));
});

test("THE RE-ARM: consumption is per completed work cycle, not per intent revision", () => {
  const done = mkQueue({ promptedConsumedGeneration: 1 });
  assert.equal(decide({ queue: done }).kind, "skip", "already handled this work cycle");

  const revisedIntentOnly = decide({
    queue: done,
    intent: mkIntent({
      prompt: "now add metrics",
      focus: "Add metrics",
      relationship: "amend",
      objective: `${GOAL} and add metrics`,
      objectiveVersion: 2,
      promptRevision: 2,
      resolvedPromptRevision: 2,
    }),
  });
  assert.equal(revisedIntentOnly.kind, "skip", "intent alone cannot manufacture a new turn");

  const laterCycle = decide({
    queue: done,
    session: mkSession({
      workCycle: {
        logicalKey: "agent-1",
        generation: 2,
        active: false,
        completedAt: NOW - 10_000,
        updatedAt: NOW - 10_000,
      },
    }),
  });
  assert.equal(laterCycle.kind, "check");
  assert.equal(laterCycle.kind === "check" && laterCycle.generation, 2);
  assert.equal(laterCycle.kind === "check" && laterCycle.episodeKey, "intent:1:1");
});

test("THE DIRECT-SHIPPING LATCH: a handed-off intent episode never ships twice", () => {
  // The reported loop, as a table. Foreman verified episode `intent:1:1`, consumed
  // generation 1 and typed the direct PR instruction. That instruction makes the agent
  // commit, push, open a PR and follow CI, and its settled Stop completes generation 2
  // under the human's UNCHANGED intent - so every generation-keyed guard is legitimately
  // re-armed at this point, and the trigger fired again.
  const shipped = mkQueue({
    promptedConsumedGeneration: 1,
    promptedDirectHandoff: { kind: "direct-ship", episodeKey: "intent:1:1", generation: 1 },
  });
  const afterShipping = mkSession({
    workCycle: {
      logicalKey: "agent-1",
      generation: 2,
      active: false,
      completedAt: NOW - 10_000,
      updatedAt: NOW - 10_000,
    },
  });

  // Without the latch this is a `check` - see THE RE-ARM above, which asserts exactly
  // that on the same two fixtures minus the handoff. That behaviour is CORRECT and is
  // deliberately preserved: it is what lets a background task notification or an
  // item-less Workflow repair packet complete a later generation. The latch is narrower
  // than "reject every later generation" on purpose.
  const again = decide({ queue: shipped, session: afterShipping });
  assert.equal(again.kind, "skip", "the shipping response re-armed the direct handoff");

  // A skip, not a retire: the later generation is not the stale thing here, the episode
  // is. Retiring would spend a generation the trigger has no business spending, and
  // costs a write per settled turn for as long as the human stays on this objective.
  assert.equal(again.kind === "skip" && again.why.includes("direct shipping"), true);

  // The SDK Goal is still the human's, which is the whole reason the exact-payload guard
  // could not see this. Asserted here so a change to goal capture that starts storing
  // Foreman's payload does not quietly make this test pass for the other reason.
  assert.equal(isWrapupPayload(mkIntent().prompt ?? ""), false);

  // A later accepted human prompt advances promptRevision, which advances the episode
  // key - and that alone re-arms completion, with nothing clearing the stored handoff.
  const nextEpisode = decide({
    queue: shipped,
    session: afterShipping,
    intent: mkIntent({
      prompt: "now add metrics",
      focus: "Add metrics",
      relationship: "amend",
      objective: `${GOAL} and add metrics`,
      objectiveVersion: 2,
      promptRevision: 2,
      resolvedPromptRevision: 2,
    }),
  });
  assert.equal(nextEpisode.kind, "check", "a new human episode must re-arm completion");
  assert.equal(nextEpisode.kind === "check" && nextEpisode.episodeKey, "intent:2:2");

  // A latch left by an EARLIER episode is inert against the current one, which is what
  // makes preserving it across later consumptions safe rather than sticky.
  const stale = mkQueue({
    promptedConsumedGeneration: 1,
    promptedDirectHandoff: { kind: "direct-ship", episodeKey: "intent:1:1", generation: 1 },
  });
  const currentEpisode = decide({
    queue: stale,
    session: afterShipping,
    intent: mkIntent({
      objectiveVersion: 3,
      promptRevision: 4,
      resolvedPromptRevision: 4,
    }),
  });
  assert.equal(currentEpisode.kind, "check");

  // And no latch at all - an upgraded row, or a session Foreman only ever asked about -
  // leaves the trigger exactly as it was before this guard existed.
  assert.equal(
    decide({ queue: mkQueue({ promptedConsumedGeneration: 1 }), session: afterShipping }).kind,
    "check",
    "an unlatched queue must stay eligible on a later generation",
  );
});

test("the prompted consume wire contract constrains the handoff it can authorize", () => {
  const base = {
    logicalKey: "agent-1",
    generation: 1,
    expectedIntent: {
      objective: GOAL,
      objectiveVersion: 1,
      promptRevision: 1,
      episodeKey: "intent:1:1",
    },
  };

  // Absent means "consume only". Every existing caller - the ask, the hold, the retire,
  // the Workflow claim - sends nothing new and must keep meaning exactly what it meant.
  const plain = PromptedWrapupSchema.safeParse(base);
  assert.equal(plain.success, true);
  assert.equal(plain.success && plain.data.directHandoff, null);

  const shipping = PromptedWrapupSchema.safeParse({ ...base, directHandoff: "direct-ship" });
  assert.equal(shipping.success && shipping.data.directHandoff, "direct-ship");

  // A constrained kind, not a free string: an unrecognised handoff would reach the durable
  // column and read back as a latch nobody can explain.
  assert.equal(PromptedWrapupSchema.safeParse({ ...base, directHandoff: "ship-it" }).success, false);

  // Raising the Ship it? card and handing off to direct shipping are opposite answers to
  // the same question. Accepting both would stamp a handoff for an instruction the human
  // was simultaneously being asked to approve.
  assert.equal(
    PromptedWrapupSchema.safeParse({ ...base, ask: true, directHandoff: "direct-ship" }).success,
    false,
  );
});

test("missing, active, or mismatched work-cycle state fails closed", () => {
  assert.equal(decide({ session: mkSession({ workCycle: undefined }) }).kind, "skip");
  assert.equal(
    decide({
      session: mkSession({ workCycle: { logicalKey: "agent-1", generation: 1, active: true, completedAt: NOW - 20_000, updatedAt: NOW } }),
    }).kind,
    "skip",
  );
  assert.equal(
    decide({
      session: mkSession({ workCycle: { logicalKey: "other", generation: 1, active: false, completedAt: NOW - 20_000, updatedAt: NOW } }),
    }).kind,
    "skip",
  );
});

test("legacy intent and evidence fields are not an active fallback trigger", () => {
  assert.equal(
    decide({
      queue: mkQueue({
        promptedGoal: "intent:1:1",
        promptedEvidence: null,
        promptedActivityAt: null,
        promptedConsumedGeneration: null,
        promptedDirectHandoff: null,
      }),
    }).kind,
    "check",
  );
});

test("an ambiguous legacy cutover blocks only its recorded work-cycle generation", () => {
  const retired = mkQueue({
    promptedGoal: "intent:1:1",
    promptedLegacyCutoverGeneration: 1,
  });
  assert.equal(decide({ queue: retired }).kind, "skip");

  const next = decide({
    queue: retired,
    session: mkSession({
      workCycle: {
        logicalKey: "agent-1",
        generation: 2,
        active: false,
        completedAt: NOW - 10_000,
        updatedAt: NOW - 10_000,
      },
    }),
  });
  assert.equal(next.kind, "check");
  assert.equal(next.kind === "check" && next.generation, 2);
});

test("the card's display sentence cannot re-arm a consumed work cycle", () => {
  // Rewording compact presentation state must not produce another completion opportunity.
  // Only a later completed lifecycle generation can do that.
  const rewritten = mkSession({ goal: { text: "COMPLETELY DIFFERENT", source: "model", updatedAt: NOW } });
  assert.equal(
    decide({ session: rewritten, queue: mkQueue({ promptedConsumedGeneration: 1 }) }).kind,
    "skip",
    "the sentence moved but the work cycle did not",
  );
});

// ---- step 3: what a verdict means ----

test("an incomplete verdict holds - this trigger never sends a fix round", () => {
  // The queue answers "incomplete" by typing the gaps back at the agent, because it
  // commissioned that work. This trigger commissioned nothing: it is a bystander to a
  // conversation between a human and their agent, so its only honest move is to stay
  // out of the way.
  const p = planPromptedWrapup(GOAL, mkVerdict({ complete: false, summary: "half done" }), CFG, true);
  assert.equal(p.kind, "hold");
  assert.match(p.kind === "hold" ? p.why : "", /half done/);
});

test("complete-but-blocking is a self-contradictory verdict, and it declines", () => {
  const p = planPromptedWrapup(GOAL, mkVerdict({ gaps: [mkGap("blocking")] }), CFG, true);
  assert.equal(p.kind, "hold");
});

test("an ADVISORY gap never blocks the ship - same rule the queue follows", () => {
  const p = planPromptedWrapup(GOAL, mkVerdict({ gaps: [mkGap("advisory")] }), CFG, true);
  assert.equal(p.kind, "ask-wrapup");
});

test("Ask shows the card; direct PR mode carries its payload", () => {
  assert.equal(planPromptedWrapup(GOAL, mkVerdict(), CFG, true).kind, "ask-wrapup");

  const pr = planPromptedWrapup(GOAL, mkVerdict(), { ...CFG, wrapup: "pr" }, true);
  assert.equal(pr.kind === "auto-wrapup" && pr.payload, WRAPUP_PR);
});

test("dry-run degrades to the ask and NEVER types - the instruction pushes", () => {
  const p = planPromptedWrapup(GOAL, mkVerdict(), { ...CFG, wrapup: "pr" }, false);
  assert.equal(p.kind, "ask-wrapup");
});

// ---- the selector ----

test("tickTargets selects a prompted candidate that has no queue at all", () => {
  // Without this the whole feature is unreachable: a session with no queue was never a
  // target, so the machine above would never be asked about one.
  const s = mkSession({ id: "prompted" });
  assert.deepEqual(tickTargets([s], ["prompted"]).map((t) => t.id), ["prompted"]);
  assert.deepEqual(tickTargets([s], ["drain"]), [], "not selected when the trigger is off");
  assert.deepEqual(tickTargets([s], []), []);
});

test("the selector skips sessions the machine would certainly reject", () => {
  const q = (over: Partial<SessionQueueSummary>): SessionQueueSummary => ({
    openCount: 0,
    totalCount: 0,
    inFlightState: null,
    inFlightIntent: null,
    round: 0,
    blockingGaps: 0,
    verifiedCount: 0,
    escalatedCount: 0,
    drained: false,
    wrapupAskedAt: null,
    wrapupAnswered: false,
    updatedAt: 0,
    ...over,
  });
  const cases: Array<[string, Session]> = [
    ["working", mkSession({ state: "working" })],
    ["no hooks", mkSession({ hooksSeen: false })],
    ["stale overlay", mkSession({ instrumented: false })],
    ["no goal yet", mkSession({ goal: null })],
    // A DRAINED queue is still the drain trigger's - `totalCount`, not `openCount`.
    ["a drained queue", mkSession({ queue: q({ totalCount: 2, drained: true }) })],
  ];
  for (const [why, s] of cases) {
    assert.deepEqual(tickTargets([s], ["prompted"]), [], why);
  }
});

test("a needs-you session is selected ONCE, by the needs-you half", () => {
  // Both halves can claim the same session; the target list must not contain it twice
  // or one pass would review it, then wrap it up, from the same stale snapshot.
  const s = mkSession({ id: "dup", pendingReviews: 1, state: "awaiting_input" });
  const ids = tickTargets([s], ["prompted"]).map((t) => t.id);
  assert.deepEqual(ids, ["dup"]);
});

// ---- the failure cap ----
//
// The two ways a tick can spend real work and leave the episode exactly where it found
// it: the verifier failed, or the retire stamp failed. Both keep the episode ARMED, so
// both repeat forever without a bound - and the second is the expensive one, because it
// happens AFTER the evidence gather and the `claude -p`.

test("PromptedFailureTracker: strikes accumulate and the cap ends the episode", () => {
  const t = new PromptedFailureTracker();
  assert.equal(t.gaveUp("agent-1", 1), false, "a fresh generation is armed");

  for (let n = 1; n < VERIFY_FAILURE_CAP; n++) {
    assert.equal(t.onFailure("agent-1", 1), n);
    assert.equal(t.gaveUp("agent-1", 1), false, `still retrying at ${n} strikes`);
  }
  assert.equal(t.onFailure("agent-1", 1), VERIFY_FAILURE_CAP);
  assert.equal(t.gaveUp("agent-1", 1), true, "at the cap Foreman gives up");
});

test("PromptedFailureTracker: a later generation gets a fresh bounded counter", () => {
  const t = new PromptedFailureTracker();
  for (let n = 0; n < VERIFY_FAILURE_CAP; n++) t.onFailure("agent-1", 1);
  assert.equal(t.gaveUp("agent-1", 1), true);

  assert.equal(t.gaveUp("agent-1", 2), false, "a new work cycle is a new retry unit");
  assert.equal(t.strikes("agent-1", 2), 0);
});

test("PromptedFailureTracker: only a RETIRE clears the strikes, not a mere verdict", () => {
  // This is the bug the cap exists to catch. A tick that verifies fine but fails to
  // consume the generation has made no progress: the cycle is still armed, so the next
  // tick pays for the whole evidence gather and another `claude -p`. If a successful
  // verdict cleared the count, that loop would reset it every pass and never be bounded.
  const t = new PromptedFailureTracker();
  for (let n = 0; n < VERIFY_FAILURE_CAP; n++) {
    // Each pass: the verifier answers, then the retire stamp fails. Only the failure is
    // recorded, because only the retire is progress.
    t.onFailure("agent-1", 1);
  }
  assert.equal(t.gaveUp("agent-1", 1), true, "a persistently failing consume write IS bounded");

  t.onConsumed("agent-1");
  assert.equal(t.strikes("agent-1", 1), 0, "consuming the generation forgets the strikes");
  assert.equal(t.gaveUp("agent-1", 1), false);
});

test("PromptedFailureTracker: strikes are per logical session", () => {
  const t = new PromptedFailureTracker();
  for (let n = 0; n < VERIFY_FAILURE_CAP; n++) t.onFailure("agent-1", 1);
  assert.equal(t.gaveUp("agent-1", 1), true);
  assert.equal(t.gaveUp("agent-2", 1), false, "one session's broken cycle strands no other");
});
