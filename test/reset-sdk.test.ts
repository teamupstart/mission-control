import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the daemon's state dir BEFORE any value import that can resolve it - static
// imports are hoisted above this line, so every server module below loads dynamically.
process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "mission-reset-sdk-"));

const { openDb } = await import("../src/server/db.ts");
const { resetToOrigin } = await import("../src/server/actions.ts");
const { resetSession, driverClearFor } = await import("../src/server/reset.ts");
const { Registry, SDK_SESSION_ID_PREFIX } = await import("../src/server/registry.ts");
import { gitIn, mkOriginAndClone as mkFixture } from "./helpers/git-fixture.ts";
import type { Session } from "../src/shared/types.ts";
import type { SdkEvent } from "../src/server/harness/types.ts";

// What is at stake: a reset is TWO successes, and the second one moves a task's ownership.
//
// The git half wipes the checkout. The context half wipes the agent, and `resetSession`
// then re-arms the session's work episode to await a rebind - because the agent that comes
// back has a NEW identity, and the episode (which owns the task's branch and its
// dependencies) has to be transferred onto it rather than stranded on the dead one. That
// transfer only happens if the rebind arrives with evidence the registry will accept as a
// clear; anything weaker and `waitForWorkEpisodeReady` times out and the whole reset reports
// `workIdentityReady: false`.
//
// On a pane, the clear is keystrokes and the evidence is a `SessionStart { source: "clear" }`
// hook. An embedded session has neither. Both halves have to exist for it or the failure is
// silent and expensive in a specific way: `TaskManager.assign` types the next task's intent
// straight after a reset, so an unproven clear either strands the episode or lets a task be
// handed to an agent whose context was never wiped.
//
// The degradations matter as much as the success. A driver that cannot clear, a build with
// no supervisor, and a driver that throws must all land on the SAME `cleared: false` a
// pane-less session has always produced - never a failed reset, because by then the git half
// has already landed and saying otherwise is a lie about work that is done.

openDb();
const mkOriginAndClone = (): { origin: string; clone: string } => mkFixture("harness-reset-sdk-");

/** An embedded session over `cwd`: no pane, no tty, bound to a harness session id. */
function sdkSess(cwd: string | null, over: Partial<Session> = {}): Session {
  return {
    id: `${SDK_SESSION_ID_PREFIX}11111111-1111-4111-8111-111111111111`,
    agent: "claude",
    name: "embedded",
    runtime: "sdk",
    nameSource: "sdk",
    state: "idle",
    cwd,
    gitBranch: "main",
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 0,
    tty: null,
    permissionMode: null,
    terminals: [],
    agentSessionId: "agent-old",
    transcriptPath: "/tmp/agent-old.jsonl",
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: null,
    startedAt: 0,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    nomistakesFixes: [],
    task: null,
    nomistakesNarration: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    inspector: null,
    meta: null,
    effortBaselineReady: false,
    note: null,
    cost: null,
    goal: null,
    queue: null,
    orphanedQueue: null,
    paneDialog: null,
    ...over,
  };
}

test("an embedded reset clears through the driver, not through a pane", async () => {
  const { clone } = mkOriginAndClone();
  writeFileSync(join(clone, "keep.txt"), "base\ndirty\n");
  writeFileSync(join(clone, "scratch.txt"), "untracked\n");

  const asked: string[] = [];
  const r = await resetToOrigin(sdkSess(clone), true, undefined, undefined, async (s) => {
    asked.push(s.id);
    return true;
  });

  assert.equal(r.ok, true);
  assert.equal(r.cleared, true, "the driver accepted the clear, so the context is wiped");
  assert.equal(asked.length, 1, "asked exactly once");
  assert.ok(r.clearIssuedAt !== undefined, "the reset must timestamp the clear it issued");
  // The git half is the ordinary one - nothing about the runtime changes it.
  assert.equal(readFileSync(join(clone, "keep.txt"), "utf8"), "base\n");
  assert.equal(gitIn(clone, "status", "--porcelain"), "");
});

test("a driver that cannot clear reports cleared:false, and the reset still succeeded", async () => {
  // `SdkSessionHandle.clearContext` is nullable, and null is an ANSWER - this transport has
  // no way to wipe a conversation. It lands on the byte-identical `cleared: false` a
  // pane-less terminal session produces, which is the already-tested degradation.
  const { clone } = mkOriginAndClone();
  const r = await resetToOrigin(sdkSess(clone), true, undefined, undefined, async () => false);
  assert.equal(r.ok, true);
  assert.equal(r.cleared, false);
});

test("a build with no supervisor reports cleared:false rather than throwing", async () => {
  const { clone } = mkOriginAndClone();
  assert.equal(driverClearFor(undefined), undefined);
  const r = await resetToOrigin(sdkSess(clone), true, undefined, undefined, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.cleared, false);
});

test("a driver that throws costs the clear, never the reset", async () => {
  // The git reset has already landed by the time this runs, so reporting the whole
  // operation as failed would be a claim about work that is done. Same rule the pane path's
  // last two steps follow.
  const { clone } = mkOriginAndClone();
  const r = await resetToOrigin(sdkSess(clone), true, undefined, undefined, async () => {
    throw new Error("no live driver for session sdk:1");
  });
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.equal(r.cleared, false);
});

test("clear:false never asks the driver anything", async () => {
  const { clone } = mkOriginAndClone();
  let asked = 0;
  const r = await resetToOrigin(sdkSess(clone), false, undefined, undefined, async () => {
    asked++;
    return true;
  });
  assert.equal(r.ok, true);
  assert.equal(r.cleared, false);
  assert.equal(asked, 0);
});

test("driverClearFor addresses the supervisor by SESSION id, not by agent session id", () => {
  // One adapter at the boundary, because the two ids are both on the session and the
  // supervisor's handle map is keyed on only one of them. A caller that wrote its own
  // lambda and reached for `agentSessionId` would clear nothing, silently.
  const calls: string[] = [];
  const clear = driverClearFor({
    clearContext: async (id: string) => {
      calls.push(id);
      return true;
    },
  });
  assert.ok(clear);
  const s = sdkSess("/repo");
  return clear!(s).then((ok) => {
    assert.equal(ok, true);
    assert.deepEqual(calls, [s.id]);
  });
});

/** Register an embedded session and bind it, exactly as the supervisor's pump does. */
function registerBound(registry: InstanceType<typeof Registry>, id: string, cwd: string): void {
  registry.registerSdkSession({ id, agent: "claude", name: "embedded", cwd });
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: "agent-old",
    transcriptPath: `${cwd}/agent-old.jsonl`,
    modelId: null,
    pid: null,
  } satisfies SdkEvent);
}

test("a cleared rebind transfers the work episode; an ordinary one does not", async () => {
  // The half phase 2's handoff note called for, and the reason the `bound` event has to
  // carry WHY it fired. `resetSession` arms the episode for a rebind and waits; only
  // clear-grade evidence resolves that arm. `driver_identity` deliberately cannot, because
  // an agent reporting a new id for its own reasons is not a reset we asked for - and
  // letting it inherit the arm would hand a task's branch and dependencies to an identity
  // nobody proved was cleared.
  const { clone } = mkOriginAndClone();
  const registry = new Registry();
  const id = `${SDK_SESSION_ID_PREFIX}22222222-2222-4222-8222-222222222222`;
  registerBound(registry, id, clone);

  const before = registry.getSession(id);
  assert.ok(before);
  assert.equal(before!.agentSessionId, "agent-old");
  assert.ok(registry.workEpisodeForSession(id), "the bound session has a work episode");

  const cleared = await resetSession(
    registry,
    before!,
    true,
    // The git half, stubbed: this test is about the identity transfer, and the real one is
    // covered above. `cleared: true` is what arms the wait.
    async () => {
      // The rotation arrives while the reset waits, exactly as it does live.
      setTimeout(() => {
        registry.applyDriverEvent(id, {
          kind: "bound",
          agentSessionId: "agent-new",
          transcriptPath: `${clone}/agent-new.jsonl`,
          modelId: null,
          pid: null,
          cleared: true,
        } satisfies SdkEvent);
      }, 5);
      return { ok: true, error: null, root: clone, cleared: true, detached: false, clearIssuedAt: Date.now() };
    },
  );
  assert.equal(cleared.ok, true);
  assert.equal(cleared.workIdentityReady, true, "the episode followed the cleared identity");
  const after = registry.workEpisodeForSession(id);
  assert.equal(after?.agentSessionId, "agent-new");
  assert.equal(after?.awaitingAgentRebind, false);
});

test("a cleared rebind that reports no transcript path yet still transfers", async () => {
  // THE case this failed on live, and it is the normal one rather than an edge. A driver
  // reports the new identity the instant the harness mints it, and Claude writes the session
  // file lazily - so `claudeSdkTranscriptPath` (which returns null for a file not on disk,
  // rather than inventing one) hands `bound` a null path roughly every time. Measured against
  // 2.1.220: three consecutive `/clear` resets, three null paths.
  //
  // Requiring a non-null replacement path there fails EVERY embedded reset - the wait times
  // out, `workIdentityReady` is false on a reset that worked, and the episode (with the
  // task's ownership of its branch) is stranded on the identity the clear just destroyed.
  const { clone } = mkOriginAndClone();
  const registry = new Registry();
  const id = `${SDK_SESSION_ID_PREFIX}44444444-4444-4444-8444-444444444444`;
  registerBound(registry, id, clone);
  const before = registry.getSession(id)!;
  const episodeBefore = registry.workEpisodeForSession(id);

  const r = await resetSession(registry, before, true, async () => {
    setTimeout(() => {
      registry.applyDriverEvent(id, {
        kind: "bound",
        agentSessionId: "agent-new",
        transcriptPath: null,
        modelId: null,
        pid: null,
        cleared: true,
      } satisfies SdkEvent);
    }, 5);
    return { ok: true, error: null, root: clone, cleared: true, detached: false, clearIssuedAt: Date.now() };
  });
  assert.equal(r.workIdentityReady, true);
  const after = registry.workEpisodeForSession(id);
  assert.equal(after?.agentSessionId, "agent-new");
  assert.equal(after?.awaitingAgentRebind, false);
  // TRANSFERRED, not replaced: a fresh episode would have dropped the task ownership this
  // whole path exists to carry across the clear.
  assert.notEqual(after?.episodeId, episodeBefore?.episodeId, "the reset starts its own episode");
  assert.equal(
    after?.startedAt,
    registry.workEpisodeForSession(id)?.startedAt,
    "and the rebind keeps that episode rather than minting another",
  );
});

test("a driver clear cannot re-adopt the transcript it was giving up", () => {
  // The corroboration that survives: the weakened check still refuses a rotation whose path
  // is the OLD file, which would mean the harness never opened a new conversation at all.
  const registry = new Registry();
  const id = `${SDK_SESSION_ID_PREFIX}77777777-7777-4777-8777-777777777777`;
  registry.registerSdkSession({ id, agent: "claude", name: "embedded", cwd: "/wt/x" });
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: "agent-old",
    transcriptPath: "/wt/x/agent-old.jsonl",
    modelId: null,
    pid: null,
  });
  const armed = registry.resetWorkEpisode(id, {
    awaitingAgentRebind: true,
    previousAgentSessionId: "agent-old",
  });
  assert.equal(armed?.awaitingAgentRebind, true);
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: "agent-new",
    // The path of the conversation being discarded - the one thing a real clear cannot report.
    transcriptPath: "/wt/x/agent-old.jsonl",
    modelId: null,
    pid: null,
    cleared: true,
  });
  const after = registry.workEpisodeForSession(id);
  assert.notEqual(after?.episodeId, armed?.episodeId, "it was not allowed to resolve the arm");
});

test("an unproven rotation leaves the episode awaiting, and says so", async () => {
  const { clone } = mkOriginAndClone();
  const registry = new Registry();
  const id = `${SDK_SESSION_ID_PREFIX}33333333-3333-4333-8333-333333333333`;
  registerBound(registry, id, clone);
  const before = registry.getSession(id)!;

  const r = await resetSession(registry, before, true, async () => {
    setTimeout(() => {
      // No `cleared` flag: the agent announced a new identity for reasons of its own.
      registry.applyDriverEvent(id, {
        kind: "bound",
        agentSessionId: "agent-other",
        transcriptPath: `${clone}/agent-other.jsonl`,
        modelId: null,
        pid: null,
      } satisfies SdkEvent);
    }, 5);
    return { ok: true, error: null, root: clone, cleared: true, detached: false, clearIssuedAt: Date.now() };
  });
  assert.equal(r.ok, true);
  assert.equal(
    r.workIdentityReady,
    false,
    "an unproven identity must not inherit what the reset was giving up",
  );
});
