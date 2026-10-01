import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: a comment left `queued` from before sending started delivery on its own
// must be sent when the daemon starts - and only once the first COMPLETED discovery sweep has
// run, because before that a live session can still be missing from the map. The state
// machine's own tests call `adoptQueued` directly; this drives the path the daemon actually
// takes: a durable staged comment, a registry that hydrates it, the startup registration, and
// the sweep that fires it.

const home = mkdtempSync(join(tmpdir(), "mission-file-comment-startup-delivery-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");
const { FileCommentWalkthrough } = await import("../src/server/file-comment-walkthrough.ts");
const { adoptQueuedOnFirstSweep } = await import("../src/server/file-comment-walkthrough-port.ts");
const {
  beginFileCommentDelivery,
  createFileCommentThread,
  loadFileCommentReview,
  loadFileCommentThread,
  loadFileCommentThreadWithFullHistory,
  loadFileCommentThreadsForSession,
  queueFileCommentThread,
  setFileCommentReviewState,
} = await import("../src/server/db.ts");
type Session = import("../src/shared/types.ts").Session;

const QUOTE = "The retry budget is thirty seconds.";

function stage(id: string, sessionId: string): void {
  createFileCommentThread({
    id,
    messageId: `${id}-m`,
    sessionId,
    path: "docs/spec.md",
    startLine: 3,
    endLine: 3,
    quote: QUOTE,
    quoteHash: `hash-${id}`,
    revision: "r1",
    surface: "editor",
    body: "This number disagrees with the table.",
    now: 1_000,
  });
  queueFileCommentThread(id, 1_001);
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("a comment staged before the upgrade is sent after the first completed discovery sweep", async () => {
  // Written by the previous build: queued, in a review nobody started. And one a person held
  // with Pause, which must stay held.
  stage("staged", "s-staged");
  stage("held", "s-held");
  setFileCommentReviewState("s-held", "paused", null, 1_002);

  // The registry hydrates the thread table at construction, as it does at daemon start.
  const registry = new Registry();
  const submitted: { sessionId: string; text: string }[] = [];
  const walkthrough = new FileCommentWalkthrough({
    now: () => Date.now(),
    replyTool: () => Promise.resolve(null),
    session: (sessionId) =>
      ({ id: sessionId, runtime: "sdk", state: "idle", terminals: [], lastActivity: 0, firstSeen: 0, pendingTurns: [] }) as unknown as Session,
    review: (sessionId) => loadFileCommentReview(sessionId),
    setReviewState: (sessionId, state, pauseReason) =>
      setFileCommentReviewState(sessionId, state, pauseReason, Date.now()),
    threads: (sessionId) => loadFileCommentThreadsForSession(sessionId),
    threadWithHistory: (id) => loadFileCommentThreadWithFullHistory(id),
    readFile: () => Promise.resolve({ text: `# The spec\n\n${QUOTE}\n`, revision: "r1" }),
    updateAnchor: () => null,
    beginDelivery: (id, deliveryId) => beginFileCommentDelivery(id, deliveryId, Date.now()),
    markDelivered: () => null,
    markUnanswered: () => null,
    returnToQueue: () => null,
    requeueAtTail: () => null,
    submit: (sessionId, text) => {
      submitted.push({ sessionId, text });
      return { ok: true, turnId: `turn-${submitted.length}`, error: null };
    },
    pendingTurn: () => null,
    agentTurnsSince: () => [],
    appendAgentReply: () => null,
  });

  try {
    // The daemon's startup registration.
    adoptQueuedOnFirstSweep(registry, walkthrough);
    await settle();
    assert.equal(submitted.length, 0, "nothing is sent before discovery has completed a sweep");

    // The first completed sweep - what the poller reports even with nothing discovered.
    registry.applyDiscovery([]);
    await settle();

    assert.equal(submitted.length, 1, "exactly one turn: one comment outstanding, ever");
    assert.equal(submitted[0]!.sessionId, "s-staged");
    assert.match(submitted[0]!.text, /^Review comment 1; nothing else is queued yet\./);
    assert.equal(loadFileCommentThread("staged")!.status, "sending");
    assert.equal(loadFileCommentReview("s-staged").state, "running");

    // A person's Pause is not something a restart overrides.
    assert.equal(loadFileCommentThread("held")!.status, "queued");
    assert.equal(loadFileCommentReview("s-held").state, "paused");
  } finally {
    walkthrough.stop();
  }
});
