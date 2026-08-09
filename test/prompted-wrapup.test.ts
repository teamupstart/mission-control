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
    pendingReviews: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    note: null,
    cost: null,
    goal: { text: "Add retry handling.", source: "model", updatedAt: NOW },
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
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

test("THE RE-ARM: the same goal is decided once; a new prompt arms it again", () => {
  const done = mkQueue({ promptedGoal: "intent:1:1" });
  assert.equal(decide({ queue: done }).kind, "skip", "already handled this prompt");

  // The human types something else. Note the trigger re-arms on the PROMPT changing,
  // which is the only thing that moves when a person acts.
  const next = decide({
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
  assert.equal(next.kind, "check");
  assert.equal(next.kind === "check" && next.episodeKey, "intent:2:2");
  assert.equal(next.kind === "check" && next.objective, `${GOAL} and add metrics`);
});

test("the re-arm key is the intent revision, NOT the card's display sentence", () => {
  // Rewording the compact card text must not produce another completion episode. Only the
  // durable objective/prompt revision pair is allowed to re-arm it.
  const rewritten = mkSession({ goal: { text: "COMPLETELY DIFFERENT", source: "model", updatedAt: NOW } });
  assert.equal(
    decide({ session: rewritten, queue: mkQueue({ promptedGoal: "intent:1:1" }) }).kind,
    "skip",
    "the sentence moved but the prompt did not",
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
  assert.equal(t.gaveUp("s1", GOAL), false, "a fresh episode is armed");

  for (let n = 1; n < VERIFY_FAILURE_CAP; n++) {
    assert.equal(t.onFailure("s1", GOAL), n);
    assert.equal(t.gaveUp("s1", GOAL), false, `still retrying at ${n} strikes`);
  }
  assert.equal(t.onFailure("s1", GOAL), VERIFY_FAILURE_CAP);
  assert.equal(t.gaveUp("s1", GOAL), true, "at the cap Foreman gives up");
});

test("PromptedFailureTracker: a NEW human prompt re-arms a given-up episode", () => {
  // The whole re-arm contract. Strikes belong to an episode, not to a session: a human
  // who types something new is owed a fresh attempt, however badly the last one went.
  const t = new PromptedFailureTracker();
  for (let n = 0; n < VERIFY_FAILURE_CAP; n++) t.onFailure("s1", GOAL);
  assert.equal(t.gaveUp("s1", GOAL), true);

  assert.equal(t.gaveUp("s1", "something else entirely"), false, "a new goal is a new episode");
  assert.equal(t.strikes("s1", "something else entirely"), 0);
});

test("PromptedFailureTracker: only a RETIRE clears the strikes, not a mere verdict", () => {
  // This is the bug the cap exists to catch. A tick that verifies fine but fails to
  // stamp `promptedGoal` has made no progress: the episode is still armed, so the next
  // tick pays for the whole evidence gather and another `claude -p`. If a successful
  // verdict cleared the count, that loop would reset it every pass and never be bounded.
  const t = new PromptedFailureTracker();
  for (let n = 0; n < VERIFY_FAILURE_CAP; n++) {
    // Each pass: the verifier answers, then the retire stamp fails. Only the failure is
    // recorded, because only the retire is progress.
    t.onFailure("s1", GOAL);
  }
  assert.equal(t.gaveUp("s1", GOAL), true, "a persistently failing retire stamp IS bounded");

  t.onRetired("s1");
  assert.equal(t.strikes("s1", GOAL), 0, "retiring the episode is what forgets the strikes");
  assert.equal(t.gaveUp("s1", GOAL), false);
});

test("PromptedFailureTracker: strikes are per session", () => {
  const t = new PromptedFailureTracker();
  for (let n = 0; n < VERIFY_FAILURE_CAP; n++) t.onFailure("s1", GOAL);
  assert.equal(t.gaveUp("s1", GOAL), true);
  assert.equal(t.gaveUp("s2", GOAL), false, "one session's broken episode strands no other");
});
