import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InjectError,
  applyQueueAction,
  queueSendStillValid,
  observe,
} from "../src/server/foreman/queue-apply.ts";
import type { QueueActions } from "../src/server/foreman/queue-apply.ts";
import { SEND_ATTEMPT_CAP } from "../src/server/foreman/queue-machine.ts";
import type { QueueConfig } from "../src/server/foreman/queue-machine.ts";
import { foremanAutomationAuthorized } from "../src/server/harness/index.ts";
import { workQueueBlockedReason } from "../src/shared/harness-capabilities.ts";
import type { ForemanConfig } from "../src/shared/protocol.ts";
import type { Session, SessionQueue, WorkItem } from "../src/shared/types.ts";

// What is at stake: the work queue's whole failure vocabulary was written against a pane,
// and every word of it is about UNCERTAINTY that an embedded session does not have.
//
// A pane delivery is a non-atomic paste-then-Enter, so "the send failed" and "nothing
// landed" are different claims - hence `mayHaveLanded`, whose default is "it might have",
// whose consequence is a terminal escalation ("Foreman couldn't tell whether this reached
// the pane"), and which is correct there because absence of evidence is not evidence. And a
// pane can refuse a write because a HUMAN is in copy-mode, which must not spend the item's
// finite delivery budget - hence `paneBlocked` and its 30s park.
//
// `send()` resolves only when the harness accepted the turn. So both of those arms are
// unreachable for a driver-run session, and unreachable is the load-bearing word: if either
// were reachable, an embedded queue would sit in a limbo state no evidence could ever
// resolve, or park for ever on a condition that cannot occur. What must happen instead is
// the plain, bounded thing - a failure spends one rationed attempt and re-queues, and the
// cap escalates - which is what these pin.
//
// The guard is the other half. Its pane-identity check compares a RAW pane id because a
// recreated pane can reuse one; an embedded session is addressed by its session id through a
// handle the supervisor owns, so it has no such id and the check must be scoped rather than
// left to compare null against null and read as load-bearing.

const NOW = 1_000_000;
const CFG: QueueConfig = {
  maxFixAttempts: 3,
  maxFixRounds: 10,
  settleMs: 10_000,
  pickupTimeoutMs: 45_000,
  wrapupTriggers: ["drain"],
  wrapup: "ask",
  skipScoutWrapup: true,
  skipReviewArtifactWrapup: true,
};

const LIVE_CFG: ForemanConfig = {
  enabled: true,
  mode: "live",
  repoAllowlist: ["/repo"],
  autoApproveAccess: true,
  wrapupTriggers: ["drain"],
  wrapup: "ask",
  trackReviewFeedback: true,
  trackCiFailures: true,
  triage: "off",
  maxFixAttempts: 3,
  maxFixRounds: 10,
  skipScoutWrapup: true,
  skipReviewArtifactWrapup: true,
  autoBacklog: false,
  backlogRespectOpenPrs: true,
  backlogDefaultModel: { claude: null, codex: null, pi: null },
  maxSessions: 3,
};

/** An embedded session: no terminals, no tty, and instrumented by construction. */
function mkSdkSession(over: Partial<Session> = {}): Session {
  return {
    id: "sdk:11111111-1111-4111-8111-111111111111",
    agent: "claude",
    name: "embedded work",
    runtime: "sdk",
    // The implicit grant an SDK runtime resolves to - no stored row behind it.
    foremanInvite: "sdk",
    nameSource: "sdk",
    state: "idle",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 0,
    tty: null,
    permissionMode: null,
    terminals: [],
    agentSessionId: "agent-1",
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: "idle",
    startedAt: 0,
    firstSeen: 0,
    lastSeen: NOW,
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
    goal: null,
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    pipeline: null,
    paneDialog: null,
    ...over,
  };
}

function mkItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "i1",
    noteKey: "agent-1",
    seq: 0,
    intent: "add the retry",
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
    ...over,
  };
}

interface Fake extends QueueActions {
  injected: string[];
  states: Array<{ itemId: string; patch: Record<string, unknown> }>;
  sentMarks: Array<{ baseSha: string | null; transcriptAnchor: number | null }>;
}

function mkFake(over: { session?: Session; items?: WorkItem[]; injectFailure?: unknown } = {}): Fake {
  const session = over.session ?? mkSdkSession();
  const items = over.items ?? [mkItem()];
  const fake: Fake = {
    injected: [],
    states: [],
    sentMarks: [],
    sessions: async () => [session],
    getConfig: async () => LIVE_CFG,
    queue: async (): Promise<SessionQueue> => ({
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
      items,
    }),
    setItemState: async (_s, itemId, patch) => void fake.states.push({ itemId, patch }),
    inject: async (_s, text) => {
      if (over.injectFailure !== undefined) throw over.injectFailure;
      fake.injected.push(text);
    },
    markSent: async (_s, _i, baseSha, transcriptAnchor) =>
      void fake.sentMarks.push({ baseSha, transcriptAnchor }),
    recoverItem: async () => {},
    markWrapupAsked: async () => {},
    setWrapupAnswer: async () => {},
    captureScope: async () => ({ baseSha: "abc123", transcriptAnchor: 4096 }),
    holdsLease: () => true,
  };
  return fake;
}

/**
 * What the daemon's `/inject` reports when a driver delivery fails: `pasted: false`, which
 * the client turns into positive evidence that nothing was written (`sdk/deliver.ts` states
 * this contract once so `/send` and `/inject` cannot drift), and never `paneBlocked`.
 */
const DRIVER_FAILURE = new InjectError("inject sdk:1 -> 500: no live driver", false, false);

test("an embedded session is authorized for automation, and its queue is not blocked", () => {
  const s = mkSdkSession();
  assert.equal(foremanAutomationAuthorized(s), true);
  assert.equal(workQueueBlockedReason(s), null);
  // The two halves must agree: this one decides whether the panel offers an add box, the
  // other whether the daemon will drive what the box produced.
  assert.equal(
    foremanAutomationAuthorized(s),
    workQueueBlockedReason(s) === null,
    "the panel and the daemon must not disagree about who can hold a queue",
  );
});

test("an embedded session needs no hook sighting to be driven", () => {
  // `hooksSeen` is a question about a hook script on this machine. The driver IS the
  // instrumentation here, so an arm that kept asking it would refuse the very sessions whose
  // lifecycle we can see most clearly - and would refuse phase 6's pi outright, since pi
  // declares no hooks at all.
  const s = mkSdkSession({ hooksSeen: false });
  assert.equal(foremanAutomationAuthorized(s), true);
  assert.equal(workQueueBlockedReason(s), null);
  // A TERMINAL session whose harness installs its hooks per LAUNCH is still refused until it
  // has reported one, in both halves. (Claude's are installed machine-wide, so it is not the
  // counter-example: `hooks.scope === "machine"` answers before `hooksSeen` is consulted.)
  const launchScoped = mkSdkSession({ agent: "codex", runtime: "terminal", hooksSeen: false });
  assert.equal(foremanAutomationAuthorized(launchScoped), false);
  assert.ok(workQueueBlockedReason(launchScoped));
});

test("a driver send delivers once and stamps the verification anchor unchanged", async () => {
  const session = mkSdkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item] });
  const out = await applyQueueAction(
    fake,
    session,
    { kind: "send", item, payload: "do it", round: 0 },
    CFG,
    NOW,
  );
  assert.equal(out.kind, "sent");
  assert.deepEqual(fake.injected, ["do it"]);
  // The scope capture is what `transcript.since` reads the item's turns from, and it is the
  // same on both runtimes - an embedded session writes the same session file.
  assert.deepEqual(fake.sentMarks, [{ baseSha: "abc123", transcriptAnchor: 4096 }]);
  assert.equal(fake.states[0]?.patch.state, "sending", "sending is written before delivery");
});

test("a failed driver send spends one attempt and re-queues - no limbo", async () => {
  const session = mkSdkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item], injectFailure: DRIVER_FAILURE });
  const out = await applyQueueAction(
    fake,
    session,
    { kind: "send", item, payload: "do it", round: 0 },
    CFG,
    NOW,
  );
  assert.equal(out.kind, "aborted");
  assert.match(out.kind === "aborted" ? out.why : "", /send failed/);
  // NOT escalated: `mayHaveLanded` is the pane's uncertainty and it cannot arise here.
  const patches = fake.states.map((s) => s.patch.state);
  assert.deepEqual(patches, ["sending", "queued"]);
  assert.equal(fake.states[0]?.patch.sendAttempts, 1, "the attempt is spent, not refunded");
  assert.equal(fake.sentMarks.length, 0);
});

test("a driver send that keeps failing escalates at the cap rather than retrying for ever", async () => {
  const session = mkSdkSession();
  const item = mkItem({ sendAttempts: SEND_ATTEMPT_CAP - 1 });
  const fake = mkFake({ session, items: [item], injectFailure: DRIVER_FAILURE });
  const out = await applyQueueAction(
    fake,
    session,
    { kind: "send", item, payload: "do it", round: 0 },
    CFG,
    NOW,
  );
  assert.equal(out.kind, "aborted");
  const last = fake.states.at(-1);
  assert.equal(last?.patch.state, "escalated");
  assert.match(String(last?.patch.escalationReason), /could not deliver this item/);
  // And specifically NOT the pane's "couldn't tell whether this reached the pane" - the
  // whole point is that here we can tell.
  assert.doesNotMatch(String(last?.patch.escalationReason), /couldn't tell/);
});

test("nothing parks an embedded item behind a pane mode", async () => {
  // `paneBlocked` means a person is reading their own scroll-back. There is no pane and no
  // person, so a failure reported that way would be a 30s park on a condition that can never
  // clear - and the daemon never reports it, which this pins from the failure's own shape.
  assert.equal(DRIVER_FAILURE.paneBlocked, false);
  assert.equal(DRIVER_FAILURE.mayHaveLanded, false);
  const session = mkSdkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item], injectFailure: DRIVER_FAILURE });
  await applyQueueAction(fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, NOW);
  // Immediately retryable: the item is `queued`, not held behind a backoff.
  const second = mkFake({ session, items: [mkItem()] });
  const out = await applyQueueAction(
    second,
    session,
    { kind: "send", item: mkItem(), payload: "do it", round: 0 },
    CFG,
    NOW,
  );
  assert.equal(out.kind, "sent", "a re-decided item is sent on the next tick, not parked");
});

test("the guard does not invent a pane identity for a session that has none", async () => {
  // `paneKeyOf` answers null for every embedded session, so the recreated-pane check has
  // nothing to compare. It must pass, and it must pass because the check is SCOPED - not
  // because null happens to equal null.
  const session = mkSdkSession();
  const item = mkItem();
  const obs = observe(session, item);
  assert.equal(obs.paneKey, null);
  const fake = mkFake({ session, items: [item] });
  const guard = await queueSendStillValid(fake, obs, CFG, NOW);
  assert.equal(guard.ok, true, guard.ok ? "" : guard.why);
});

test("every other guard still applies to an embedded session", async () => {
  const session = mkSdkSession();
  const item = mkItem();
  const obs = observe(session, item);

  // The strongest one: the agent did something since we looked.
  const moved = mkFake({ session: mkSdkSession({ lastActivity: NOW - 10 }), items: [item] });
  const a = await queueSendStillValid(moved, obs, CFG, NOW);
  assert.equal(a.ok, false);
  assert.match(a.ok ? "" : a.why, /did something since we looked/);

  // Not settled.
  const busy = mkFake({ session: mkSdkSession({ state: "working" }), items: [item] });
  const b = await queueSendStillValid(busy, observe(mkSdkSession({ state: "working" }), item), CFG, NOW);
  assert.equal(b.ok, false);
  assert.match(b.ok ? "" : b.why, /no longer settled/);

  // The session is gone.
  const gone = mkFake({ session: mkSdkSession({ state: "exited" }), items: [item] });
  const c = await queueSendStillValid(gone, obs, CFG, NOW);
  assert.equal(c.ok, false);
  assert.match(c.ok ? "" : c.why, /the session is gone/);
});
