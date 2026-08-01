/**
 * What is at stake: the automatic repair loop has every part it needs and, until this change,
 * had never run end to end for anybody.
 *
 * The cycle is: a Persona fails, the run parks in `waiting_for_session`, the packet is typed
 * into the pane, the session fixes the work, Foreman notices completion, and round N+1 re-runs
 * the graph FROM THE TOP. Three defaults kept it switched off and two dead ends killed it the
 * first time a session signalled completion without changing anything. No test asserted the
 * cycle - `workflow-delivery.test.ts` pinned the drain re-arm as `false`, and
 * `workflow-completion-http.test.ts` reached round two by clearing `wrapup_asked_at` with raw
 * SQL, which is the gap written down as a workaround.
 *
 * So this file contains NO raw SQL, deliberately and as a merge criterion. Every piece of state
 * it needs is produced by the code that produces it in production: the workflow is created and
 * published through `PersonaManager`/`WorkflowManager`, the queue and its items through
 * `QueueManager`, the goal through `Registry.upsertGoal`, and the completion claim through the
 * very `drainCompletionClaim`/`promptedCompletionClaim` builders the Foreman worker calls. A
 * test that has to hand-write a row to reach the next step is a test proving the step is
 * unreachable.
 *
 * `resumptionPolicy` is pinned to `manual` throughout. That is not avoidance: PR #327's
 * resumption observer is a SECOND, independent way to open round N+1, and leaving it armed
 * would let it win the race and hide whether the Foreman path works at all. The two are proved
 * separately - the observer in `workflow-resumption.test.ts`, the completion claim here.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { Session, SessionQueue } from "../src/shared/types.ts";
import type { InjectDeps, PromptWriteGuard } from "../src/server/actions.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "workflow-repair-cycle-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { setWorkflowConfig } = await import("../src/server/workflows/config.ts");
const { setForemanConfig } = await import("../src/server/foreman/config.ts");
const { getQueueRow } = await import("../src/server/db.ts");
const { drainCompletionClaim, promptedCompletionClaim } =
  await import("../src/server/foreman/workflow-claim.ts");

// Live delivery consent. `liveEnabled` is omitted rather than passed: it now defaults ON, and
// letting the schema supply it means this fixture breaks if that default is ever quietly
// reverted, instead of papering over the revert with an explicit `true`.
setWorkflowConfig({ repoAllowlist: ["/repo"] });
setForemanConfig({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });

/** Two reviewers, so "the graph re-runs from the top" is more than one attempt row. */
const PERSONA_NODES = ["quality", "safety"] as const;

function discovered(id: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: id,
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 5000 + id.length,
    tty: `tty-${id}`,
    terminals: [mkMuxHandle({ paneId: `%${id.length}` })],
    startedAt: 1,
  } as DiscoveredSession;
}

/** A reviewer that always fails, so every round really parks in `waiting_for_session`. */
const failingRunner: LlmRunner = {
  id: "claude",
  label: "fake",
  runInThread: null,
  sandbox: null,
  price: () => null,
  litter: null,
  killLiveRuns() {},
  async run() {
    return JSON.stringify({
      verdict: "fail",
      summary: "One issue",
      requestedChanges: [{
        title: "Rename the misleading helper",
        rationale: "The evidence requires it.",
        evidence: [{ kind: "diff", quote: "bad line" }],
      }],
      confidence: 1,
    });
  },
};

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5_000) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  registry: InstanceType<typeof Registry>;
  queues: InstanceType<typeof QueueManager>;
  store: InstanceType<typeof PersonaManager>["store"];
  manager: InstanceType<typeof WorkflowManager>;
  injected: string[];
  head: { sha: string };
  sessionId: string;
  noteKey: string;
  versionId: string;
  stop(): void;
}

/**
 * One daemon-shaped stack per test: real Registry, real store, real manager, real queues.
 *
 * `head.sha` is the single knob that means "the session changed something" - it feeds the
 * captured evidence, so moving it moves the fingerprint and NOT moving it is exactly the
 * unchanged-evidence case. That is the whole mechanism under test, so it is one variable
 * rather than several that have to be kept consistent by hand.
 */
async function harness(sessionId: string): Promise<Harness> {
  const registry = new Registry();
  registry.applyDiscovery([discovered(sessionId)]);
  const queues = new QueueManager(registry);
  const personas = new PersonaManager(registry);
  const store = personas.store;
  const injected: string[] = [];
  const head = { sha: "head-1" };
  const manager = new WorkflowManager(registry, store, {
    queueManager: queues,
    requireSkill: () => ({ ok: true, command: "/mission-pull-request" }),
    inject: (async (
      _session: Session,
      payload: string,
      _deps?: InjectDeps,
      beforeWrite?: PromptWriteGuard,
    ) => {
      const blocked = beforeWrite?.();
      if (blocked) return { ok: false, error: blocked, pasted: false, submitVerified: false };
      injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    }) as never,
    recordInjection: (() => {}) as never,
    readContextRaw: async (_registry, binding) => {
      const raw = {
        primaryGoal: { rawPrompt: "Ship the feature", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude" as const, name: sessionId, cwd: "/repo", branch: "feature" },
        evidence: {
          headSha: head.sha,
          diffFingerprint: `diff-${head.sha}`,
          diff: `patch at ${head.sha}`,
          diffTruncated: false,
          workingTreeDirty: false,
          workingTreeStatus: [],
          workingTreeStatusTruncated: false,
          transcript: [],
          transcriptAnchor: 1,
          transcriptTruncated: false,
          standards: [],
          standardsTruncated: false,
        },
      };
      return {
        raw,
        context: fallbackWorkflowContext(raw, null),
        boundary: {
          noteKey: binding.noteKey,
          sessionId: binding.sessionId!,
          headSha: head.sha,
          transcriptPath: null,
          transcriptSize: 0,
          repositoryFingerprint: `repo-${head.sha}`,
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, null),
    engine: {
      runnerFor: () => failingRunner,
      resolveExecution: () => ({
        runner: { id: "claude", source: "config", unknown: null },
        model: { id: "fake", source: "config" },
      }),
    },
  });

  // The workflow itself, through the real create/publish path rather than seeded rows: publish
  // validates the graph against the persona catalog, so a fixture that inserted versions
  // directly could pin a shape the product would refuse.
  const personaIds = PERSONA_NODES.map((name) => {
    const created = personas.create({
      name: `${name}-${sessionId}`,
      description: "",
      guidanceMarkdown: "# Review",
      runner: "claude",
      model: "fake",
    });
    assert.equal(created.ok, true, `persona ${name} was refused`);
    return created.ok ? created.persona.id : "";
  });
  const draft = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      ...PERSONA_NODES.map((name, index) => ({
        id: name,
        kind: "persona",
        personaId: personaIds[index]!,
        position: { x: 200, y: index * 120 },
      })),
      { id: "end", kind: "end", outcome: "Approved", position: { x: 420, y: 0 } },
    ],
    edges: [
      ...PERSONA_NODES.flatMap((name) => [
        { id: `a-${name}`, source: "session", sourcePort: "submitted", target: name, targetPort: "activate" },
        { id: `p-${name}`, source: name, sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: `f-${name}`, source: name, sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ]),
    ],
  };
  const created = manager.create({
    name: `Repair cycle ${sessionId}`,
    description: "",
    draft: draft as never,
    completionPolicy: { kind: "none" },
    // See the file header: the resumption observer is the OTHER way to open round N+1 and
    // would race this one.
    resumptionPolicy: "manual",
    bindingDefaults: {
      triggerMode: "foreman_complete",
      deliveryMode: "live",
      maxRepairRounds: 8,
    },
  });
  assert.equal(created.ok, true, "the workflow was refused");
  const workflowId = created.ok ? created.workflow.id : "";
  const published = manager.publish(workflowId, 1);
  assert.equal(published.ok, true, "publish was refused");
  const versionId = published.ok ? published.version.id : "";

  // Bind the conversation before the workflow binding exists, so the note key is stable and a
  // later idle report cannot read as a new conversation.
  registry.applyHook({
    agent: "claude",
    event: "PreToolUse",
    sessionId: `agent-${sessionId}`,
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: `%${sessionId.length}` },
    prCreated: false,
  });
  manager.start();
  const noteKey = `agent-${sessionId}`;
  return {
    registry,
    queues,
    store,
    manager,
    injected,
    head,
    sessionId,
    noteKey,
    versionId,
    stop: () => manager.stop(),
  };
}

/** Round 1: bind, submit, and let both reviewers fail so the run parks with a packet sent. */
async function parkedAfterRoundOne(h: Harness): Promise<{ runId: string; bindingId: string }> {
  const bound = h.manager.createBinding({
    workflowVersionId: h.versionId,
    sessionId: h.sessionId,
  });
  assert.equal(bound.ok, true, "the foreman_complete binding was refused");
  const bindingId = bound.ok ? bound.value.id : "";
  assert.equal(h.store.getBinding(bindingId)?.triggerMode, "foreman_complete");
  assert.equal(h.store.getBinding(bindingId)?.deliveryMode, "live");

  const submitted = await h.manager.submit(bindingId, { requestId: "round-1" });
  assert.equal(submitted.ok, true, "round 1 submission failed");
  const runId = submitted.ok ? submitted.value.run.id : "";
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session"
      && h.store.getRun(runId)?.currentPhase === "persona_feedback",
    "round 1 never parked in waiting_for_session/persona_feedback",
  );
  await waitFor(
    () => h.store.listDeliveries(runId).some((d) => d.state === "delivered"),
    "the repair packet never reached the pane",
  );
  return { runId, bindingId };
}

/** A drained work queue, built the way `SessionQueue.add` plus a verify would build one. */
function drainedQueue(h: Harness, intent: string): SessionQueue {
  const item = h.queues.add(h.sessionId, intent);
  assert.ok(item, "the work item was refused");
  const verified = h.queues.setState(item.id, { state: "verified" });
  assert.equal(verified.ok, true, "the work item could not be verified");
  const queue = h.queues.getByKey(h.noteKey);
  assert.ok(queue, "the queue must exist once an item has been added");
  return queue;
}

/** The guard columns, read through the same row accessor the Registry uses. */
function guard(noteKey: string): {
  wrapupAskedAt: number | null;
  wrapupAnswer: string | null;
  promptedGoal: string | null;
} {
  const row = getQueueRow(noteKey);
  return {
    wrapupAskedAt: row?.wrapupAskedAt ?? null,
    wrapupAnswer: row?.wrapupAnswer ?? null,
    promptedGoal: row?.promptedGoal ?? null,
  };
}

/** Every persona node that ran under one submission, by node id. */
function personaAttempts(h: Harness, submissionId: string): string[] {
  return h.store.listAttempts(submissionId)
    .filter((attempt) => (PERSONA_NODES as readonly string[]).includes(attempt.nodeId))
    .map((attempt) => attempt.nodeId)
    .sort();
}

test("a drained session repairs itself: packet, re-arm, claim, and the graph re-runs from the top", async () => {
  const h = await harness("drain-cycle");
  try {
    const { runId, bindingId } = await parkedAfterRoundOne(h);
    const roundOne = h.store.latestSubmission(runId)!;
    assert.deepEqual(
      personaAttempts(h, roundOne.id),
      ["quality", "safety"],
      "round 1 must have run both reviewers",
    );

    // The confirmed delivery re-armed the drain episode. Asserted through the guard columns
    // rather than the return value, because the guard is what Foreman actually reads next.
    const queue = drainedQueue(h, "finish the feature");
    assert.equal(guard(h.noteKey).wrapupAskedAt, null, "a drained queue starts armed");

    // The session did the repair.
    h.head.sha = "head-2";

    // Foreman claims completion with the exact proof its worker builds.
    const claim = drainCompletionClaim(queue, h.head.sha, 100);
    assert.equal(claim.completionKind, "drain");
    const claimed = await h.manager.claimCompletion(h.sessionId, claim);
    assert.equal(claimed.claimed, true, "the drain completion claim was refused");
    assert.equal(claimed.claimed && claimed.state, "resubmitted");

    // Round 2 exists. The claim having succeeded at all IS the proof it spent the guard:
    // `retireDrainGuard` matches only an armed row and `claimForemanCompletion` throws when it
    // changes nothing, so an unarmed episode could not have got this far. The guard columns are
    // deliberately not read here - round 2 delivers its own packet and re-arms them, so the
    // window in which they read "spent" is a race, and the re-arm is asserted below where it
    // has a stable answer.
    const roundTwo = h.store.latestSubmission(runId)!;
    assert.equal(roundTwo.round, 2);
    assert.notEqual(roundTwo.id, roundOne.id);
    assert.equal(
      h.store.listEvents(runId).filter((event) => event.kind === "workflow_completion_claimed").length,
      1,
      "the claim must be on the run's event log exactly once",
    );

    // "Start over" is literal: every reachable persona node gets a FRESH attempt under the new
    // submission id, not a continuation of round 1's.
    await waitFor(
      () => personaAttempts(h, roundTwo.id).length === PERSONA_NODES.length,
      "round 2 did not re-run every reviewer from the top",
    );
    assert.deepEqual(personaAttempts(h, roundTwo.id), ["quality", "safety"]);
    assert.deepEqual(
      personaAttempts(h, roundOne.id),
      ["quality", "safety"],
      "round 1's attempts must be untouched",
    );

    // And the loop closed: round 2 failed too, parked again, and typed a second packet.
    await waitFor(
      () => h.store.getRun(runId)?.status === "waiting_for_session"
        && h.store.listDeliveries(runId).filter((d) => d.state === "delivered").length === 2,
      "round 2 never parked and delivered its own packet",
    );
    assert.equal(h.injected.length, 2, "one packet per parked round, typed into the pane");
    assert.equal(h.store.getBinding(bindingId)?.state, "active");

    // The second confirmed delivery re-armed the drain episode again, which is what makes the
    // loop a loop rather than a single extra round.
    assert.equal(
      guard(h.noteKey).wrapupAskedAt,
      null,
      "round 2's delivery must re-arm the drain guard for the next claim",
    );
  } finally {
    h.stop();
  }
});

test("an item-less session repairs itself through the prompted episode", async () => {
  const h = await harness("prompted-cycle");
  try {
    // The case the drain re-arm structurally cannot serve: no work queue, so
    // `rearmDrainCompletionForDelivery`'s EXISTS clause is false and only the prompted half
    // can fire. Before `rearmPromptedCompletionForDelivery` existed, nothing did.
    const { runId } = await parkedAfterRoundOne(h);
    assert.equal(h.queues.getByKey(h.noteKey), null, "this fixture must have no work queue");

    const goal = "Ship the prompted feature";
    // Keyed by SESSION id - `upsertGoal` resolves the note key itself, exactly as the
    // `UserPromptSubmit` hook that normally writes this does.
    h.registry.upsertGoal(h.sessionId, {
      prompt: goal,
      text: goal,
      objective: goal,
      focus: goal,
      relationship: "initial",
      rationale: "Initial objective",
      objectiveVersion: 1,
      promptRevision: 1,
      resolvedPromptRevision: 1,
      pendingPrompts: [],
      source: "heuristic",
    }, 5);
    h.head.sha = "head-2";

    const claim = promptedCompletionClaim({
      noteKey: h.noteKey,
      intent: {
        objective: goal,
        objectiveVersion: 1,
        promptRevision: 1,
        episodeKey: "intent:1:1",
      },
      headSha: h.head.sha,
      transcriptAnchor: 100,
      summary: "complete",
    });
    const claimed = await h.manager.claimCompletion(h.sessionId, claim);
    assert.equal(claimed.claimed, true, "the prompted completion claim was refused");

    // The claim succeeding IS the proof it spent the prompted episode: `retirePromptedGuard`
    // returns false when the stored goal already matches, and `claimForemanCompletion` throws
    // on a guard it could not retire.
    const roundTwo = h.store.latestSubmission(runId)!;
    assert.equal(roundTwo.round, 2);

    // Round 2's confirmed packet put the episode back - and the event names WHICH half fired,
    // which is the whole point: drain declined (no items) and prompted covered it. Before
    // `rearmPromptedCompletionForDelivery` existed there was no second half to fall through to.
    await waitFor(
      () => h.store.listDeliveries(runId).filter((d) => d.state === "delivered").length === 2,
      "round 2 never delivered its packet",
    );
    const rearmed = h.store.listEvents(runId)
      .filter((event) => event.kind === "foreman_completion_rearmed");
    assert.equal(rearmed.length, 1, "exactly one episode, from exactly one confirmed delivery");
    assert.equal(
      (rearmed[0]!.payload as { completionKind?: string }).completionKind,
      "prompted",
      "an item-less session can only be re-armed through the prompted episode",
    );
    assert.equal(
      guard(h.noteKey).promptedGoal,
      null,
      "the prompted episode must be re-armed by the confirmed delivery",
    );
    assert.equal(h.queues.getByKey(h.noteKey)?.items.length ?? 0, 0, "no items were invented");
  } finally {
    h.stop();
  }
});

test("one confirmed delivery re-arms exactly one episode, never both", async () => {
  const h = await harness("one-episode");
  try {
    const { runId } = await parkedAfterRoundOne(h);

    // A session that has BOTH a drained queue and a spent prompted episode - the only shape in
    // which "exactly one" is a claim with teeth. Re-arming both would let one repair produce
    // two completion claims and therefore two rounds for one fix.
    const goal = "Ship it";
    h.registry.upsertGoal(h.sessionId, { prompt: goal, text: goal, source: "heuristic" }, 5);
    const queue = drainedQueue(h, "finish the feature");
    h.registry.setQueueWrapup(h.noteKey, { promptedGoal: goal });
    assert.equal(guard(h.noteKey).wrapupAskedAt, null, "the drain episode must start armed");
    assert.equal(guard(h.noteKey).promptedGoal, goal, "the prompted episode must start spent");

    h.head.sha = "head-2";
    const before = h.store.listDeliveries(runId).filter((d) => d.state === "delivered").length;
    const claimed = await h.manager.claimCompletion(
      h.sessionId,
      drainCompletionClaim(queue, h.head.sha, 100),
    );
    assert.equal(claimed.claimed, true, "the drain claim was refused");
    await waitFor(
      () => h.store.listDeliveries(runId).filter((d) => d.state === "delivered").length === before + 1,
      "round 2 never delivered its packet",
    );

    // Drain fired; prompted did not. Asserted BOTH ways, so a future change that re-armed the
    // pair would fail here rather than quietly doubling the rounds.
    const after = guard(h.noteKey);
    assert.equal(after.wrapupAskedAt, null, "the drain episode is the one that re-arms");
    assert.equal(after.promptedGoal, goal, "the prompted episode must be left exactly as it was");

    // One event, not two. Round 1's packet was delivered before this session had any wrap-up
    // state at all, so it re-armed nothing; round 2's had both episodes available and still
    // chose one. A build that re-armed the pair would record two events here for one delivery.
    const rearmed = h.store.listEvents(runId)
      .filter((event) => event.kind === "foreman_completion_rearmed");
    assert.equal(rearmed.length, 1, "one confirmed delivery re-arms one episode, no more");
    assert.equal(
      (rearmed[0]!.payload as { completionKind?: string }).completionKind,
      "drain",
      "the event must name the episode that actually re-armed",
    );
  } finally {
    h.stop();
  }
});

test("unchanged evidence nudges twice, then blocks, and a real change resets the count", async () => {
  const h = await harness("unchanged-cycle");
  try {
    const { runId } = await parkedAfterRoundOne(h);
    const goal = "Ship it";
    h.registry.upsertGoal(h.noteKey, { prompt: goal, text: goal, source: "heuristic" }, 5);

    /** Signal completion the way Foreman does, without touching `head.sha`. */
    const claimUnchanged = async (intent: string): Promise<void> => {
      const queue = drainedQueue(h, intent);
      const claimed = await h.manager.claimCompletion(
        h.sessionId,
        drainCompletionClaim(queue, h.head.sha, 100),
      );
      assert.equal(claimed.claimed, true, `the claim for ${intent} was refused`);
    };

    const nudges = () => h.store.listDeliveries(runId)
      .filter((d) => d.kind === "unchanged_evidence_nudge");

    // Refusal 1: the session signalled completion having changed nothing. The run parks rather
    // than blocking, and it is TOLD so - which is the whole fix. Before this, the guard was
    // already spent by the time capture refused and no later signal could ever arrive.
    await claimUnchanged("first pass");
    await waitFor(() => nudges().length === 1, "the first refusal never prepared a nudge");
    assert.equal(h.store.getRun(runId)?.status, "waiting_for_session");
    assert.equal(h.store.getRun(runId)?.currentPhase, "unchanged_evidence");
    await waitFor(
      () => nudges()[0]?.state === "delivered",
      "the first nudge never reached the pane",
    );
    const packet = nudges()[0]!.payload;
    assert.match(packet, /reported complete, but nothing changed/);
    assert.match(packet, /Nudge 1 of 2/);
    assert.match(packet, /Exactly two responses are acceptable/);
    assert.match(packet, /Rename the misleading helper/, "the nudge must name what was asked for");

    // And the nudge's own confirmed delivery re-armed the episode, so the NEXT claim is
    // legitimate rather than needing the guard cleared by hand.
    assert.equal(guard(h.noteKey).wrapupAskedAt, null, "the nudge must re-arm one episode");

    // Refusal 2 is still a nudge, NOT a block. The bound is "blocks when the count exceeds
    // two", and reading it as "stop after the second" silently shortens the loop by a round.
    await claimUnchanged("second pass");
    await waitFor(() => nudges().length === 2, "the second refusal must nudge, not block");
    assert.equal(h.store.getRun(runId)?.status, "waiting_for_session");
    assert.match(nudges()[1]!.payload, /Nudge 2 of 2/);

    // Refusal 3 blocks, visibly, for a human.
    await claimUnchanged("third pass");
    await waitFor(
      () => h.store.getRun(runId)?.currentPhase === "unchanged_evidence_exhausted",
      "the third refusal never blocked the run",
    );
    assert.equal(h.store.getRun(runId)?.status, "blocked");
    assert.equal(nudges().length, 2, "an exhausted run must not prepare a third packet");
    assert.equal(
      h.store.listEvents(runId)
        .filter((event) => event.kind === "unchanged_evidence_exhausted").length,
      1,
      "the block must be on the event log, not only in the phase",
    );
  } finally {
    h.stop();
  }
});

test("a changed fingerprint resets the unchanged-evidence count", async () => {
  const h = await harness("unchanged-reset");
  try {
    const { runId } = await parkedAfterRoundOne(h);
    const nudges = () => h.store.listDeliveries(runId)
      .filter((d) => d.kind === "unchanged_evidence_nudge");
    const claim = async (intent: string): Promise<void> => {
      const queue = drainedQueue(h, intent);
      const claimed = await h.manager.claimCompletion(
        h.sessionId,
        drainCompletionClaim(queue, h.head.sha, 100),
      );
      assert.equal(claimed.claimed, true, `the claim for ${intent} was refused`);
    };

    // Two refusals, so the run is one away from the bound.
    await claim("first pass");
    await waitFor(() => nudges().length === 1, "the first refusal never nudged");
    await waitFor(() => nudges()[0]?.state === "delivered", "the first nudge never landed");
    await claim("second pass");
    await waitFor(() => nudges().length === 2, "the second refusal never nudged");
    await waitFor(() => nudges()[1]?.state === "delivered", "the second nudge never landed");

    // Now the session actually changes something. That capture succeeds, which is the honest
    // reset: the counter is derived from refusals since the last `submission_captured`.
    h.head.sha = "head-2";
    await claim("real repair");
    await waitFor(
      () => h.store.getRun(runId)?.currentPhase === "persona_feedback",
      "the changed round never captured",
    );
    assert.equal(nudges().length, 2, "a captured round must not nudge");

    // A refusal AFTER the reset is refusal one again, not the third strike, so the run gets a
    // nudge rather than the block it would have hit had the counter carried over.
    await claim("regressed pass");
    await waitFor(() => nudges().length === 3, "the counter did not reset on a changed capture");
    assert.equal(h.store.getRun(runId)?.status, "waiting_for_session");
    assert.notEqual(h.store.getRun(runId)?.currentPhase, "unchanged_evidence_exhausted");
    assert.match(nudges()[2]!.payload, /Nudge 1 of 2/);
  } finally {
    h.stop();
  }
});
