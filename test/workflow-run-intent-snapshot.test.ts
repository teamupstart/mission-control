/**
 * What is at stake: a review that judges a submission against Mission Control's own words.
 *
 * The session Goal is a live field, and the harness prompt hook reports every prompt typed
 * into the pane back to it - including the repair packets a workflow types there itself. On
 * the run this phase was written for, that channel replaced the human's request with the
 * review's previous complaint, and the acceptance criteria were then distilled from the
 * complaint. Eight repair rounds against a budget of seven, six of eight failing verdicts
 * caused by the plumbing rather than by the code.
 *
 * The fix is a freeze, not a filter: a run copies the ask when it is created and reviews
 * against that copy for its whole life. These tests pin the three halves of that - what is
 * frozen, that nothing later moves it, and that the criteria distilled from it are compacted
 * exactly once - plus the compatibility path a run created before the freeze existed keeps.
 */
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEW_LIMITS, REVIEW_TRUNCATION_MARKER } from "../src/shared/review.ts";
import { clampPrompt } from "../src/server/util/prompt-text.ts";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { Session } from "../src/shared/types.ts";
import type { InjectDeps, PromptWriteGuard } from "../src/server/actions.ts";
import type { WorkflowBinding } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-run-intent-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const {
  compactWorkflowContext,
  fallbackWorkflowContext,
  readWorkflowContextRaw,
  readWorkflowIntentSnapshot,
  workflowIntentFingerprint,
} = await import("../src/server/workflows/context.ts");
const { buildPersonaPrompt } = await import("../src/server/workflows/prompt.ts");
const { freezeWorkflowRunIntent, workflowRunIntentFingerprint } =
  await import("../src/server/workflows/intent-fingerprint.ts");
const { WorkflowContextSnapshotSchema, WorkflowRunIntentSnapshotSchema } = await import("../src/shared/protocol.ts");
const { setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
const { openDb } = await import("../src/server/db.ts");
const { normalizePersonaName, normalizeWorkflowName } = await import("../src/shared/workflow.ts");

const repositoryRoot = process.cwd();
setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [repositoryRoot] });

/** The human's actual request, and the packet that overwrote it on the observed run. */
const HUMAN_ASK = "Make the diff link stop showing a busy spinner after the diff loads";
const REPAIR_PACKET = [
  "# Evidence preflight needs repair",
  "",
  "Declare and link an author-controlled coverage claim for each material acceptance",
  "criterion, then submit again.",
].join("\n");

function discovered(id: string, transcriptPath?: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: id,
    nameSource: "process",
    cwd: repositoryRoot,
    gitBranch: "feature",
    gitRoot: repositoryRoot,
    repoRoot: repositoryRoot,
    pid: 9100 + id.length,
    tty: `ttys-${id}`,
    terminals: [],
    startedAt: 1,
    ...(transcriptPath ? { transcriptPath } : {}),
  } as DiscoveredSession;
}

function bindingFor(registry: InstanceType<typeof Registry>, id: string): {
  session: Session;
  binding: WorkflowBinding;
} {
  const session = registry.getSession(id)!;
  return {
    session,
    binding: {
      id: `${id}-binding`,
      sessionId: session.id,
      noteKey: noteKeyFor(session),
    } as WorkflowBinding,
  };
}

test("a run reviews the ask it froze, and no later prompt can reach it", async () => {
  const transcriptPath = join(home, "frozen-intent.jsonl");
  const humanTurn = {
    type: "user",
    uuid: "human-scope",
    timestamp: "2026-09-08T10:00:00.000Z",
    message: { role: "user", content: "Keep the existing keyboard shortcut working" },
  };
  writeFileSync(transcriptPath, `${JSON.stringify(humanTurn)}\n`);

  const registry = new Registry();
  registry.applyDiscovery([discovered("frozen-intent-session", transcriptPath)]);
  const { session, binding } = bindingFor(registry, "frozen-intent-session");
  registry.captureAcceptedPrompt(session.id, HUMAN_ASK, binding.noteKey);

  const frozen = readWorkflowIntentSnapshot(registry, binding);
  assert.ok(frozen, "a bound live conversation must produce a snapshot");
  assert.equal(frozen.rawGoal, HUMAN_ASK);
  assert.deepEqual(
    frozen.decisions.map((decision) => decision.decision),
    ["Keep the existing keyboard shortcut working"],
  );

  // Everything the failure chain did, in order: the workflow types a packet into the pane,
  // the prompt hook reports it, and the Goal becomes the packet. A later human turn lands in
  // the transcript too, which used to arrive as one more "human decision" behind the review.
  registry.captureAcceptedPrompt(session.id, REPAIR_PACKET, binding.noteKey);
  writeFileSync(transcriptPath, [
    `${JSON.stringify(humanTurn)}\n`,
    `${JSON.stringify({
      type: "user",
      uuid: "packet-echo",
      timestamp: "2026-09-08T10:05:00.000Z",
      message: { role: "user", content: REPAIR_PACKET },
    })}\n`,
  ].join(""));

  const captured = await readWorkflowContextRaw(registry, binding, [], [], frozen);
  assert.equal(captured.raw.primaryGoal.rawPrompt, HUMAN_ASK);
  assert.deepEqual(
    captured.raw.humanDecisions.map((decision) => decision.decision),
    ["Keep the existing keyboard shortcut working"],
  );
  assert.equal(
    workflowIntentFingerprint(captured.raw),
    frozen.fingerprint,
    "the captured intent must hash to the frozen identity",
  );

  // The transcript is still a LIVE read, and deliberately so: a Persona sees what happened,
  // labelled as what it is. Only the intent the review is judged against is frozen.
  assert.equal(
    captured.raw.evidence.transcript.some((message) => message.content.includes("preflight")),
    true,
    "the packet must still be visible as transcript context",
  );

  // Snapshot-less legacy runs keep the prior live-prompt contract, even when the
  // durable objective differs. Only a newly frozen run opts into objective-based intent.
  const live = await readWorkflowContextRaw(registry, binding);
  assert.deepEqual(live.raw.primaryGoal, {
    rawPrompt: REPAIR_PACKET,
    refined: registry.getGoal(session.id)!.text,
    sourceNoteKey: binding.noteKey,
  });
  const newlyFrozen = readWorkflowIntentSnapshot(registry, binding);
  assert.equal(newlyFrozen?.rawGoal, HUMAN_ASK);
  assert.equal(newlyFrozen?.openingAsk, HUMAN_ASK);
  assert.equal(
    live.raw.humanDecisions.some((decision) => decision.decision.includes("preflight")),
    true,
  );
  assert.notEqual(workflowIntentFingerprint(live.raw), frozen.fingerprint);
});

test("an unreachable conversation freezes nothing rather than freezing a blank", () => {
  const registry = new Registry();
  registry.applyDiscovery([discovered("unbound-intent-session")]);
  const { binding } = bindingFor(registry, "unbound-intent-session");
  assert.equal(
    readWorkflowIntentSnapshot(registry, { ...binding, sessionId: "not-a-session" }),
    null,
  );
  assert.equal(
    readWorkflowIntentSnapshot(registry, { ...binding, noteKey: "a-different-conversation" }),
    null,
  );
});

const failingRunner: LlmRunner = {
  id: "claude",
  label: "fake",
  runInThread: null,
  structuredOutput: null,
  sandbox: null,
  price: () => null,
  litter: null,
  killLiveRuns() {},
  async run() {
    return JSON.stringify({
      verdict: "fail",
      summary: "Not yet",
      requestedChanges: [{
        title: "Show the rendered result",
        rationale: "The spinner is still visible in the diff.",
        evidence: [{ kind: "diff", quote: "patch" }],
      }],
      confidence: 1,
    });
  },
};

/**
 * A run whose Persona always fails, so an operator Resubmit opens a real repair ROUND.
 *
 * Rounds are the case the preflight suite cannot reach: its segments share a parent, while a
 * round starts the graph again from Session. Criteria drifted 4, 3, 6, 5, 5, 5, 5, 7, 2
 * ACROSS ROUNDS on the observed run, so this is the shape the once-per-run contract has to
 * hold for.
 */
async function repairHarness(
  t: TestContext,
  id: string,
  compactContext: (
    raw: Parameters<typeof compactWorkflowContext>[0],
  ) => Promise<Awaited<ReturnType<typeof compactWorkflowContext>>>,
  /** Awaited inside the context read, so a test can hold one capture open mid-flight. */
  beforeReadContext?: () => Promise<void>,
) {
  const registry = new Registry();
  registry.applyDiscovery([discovered(id)]);
  const store = new WorkflowStore();
  const personaId = `intent-persona-${id}`;
  const workflowId = `intent-workflow-${id}`;
  store.insertPersona({
    id: personaId,
    name: `Intent ${id}`,
    normalizedName: normalizePersonaName(`Intent ${id}`),
    description: "",
    guidanceMarkdown: "Review.",
    runner: "claude",
    model: "fake",
    createdAt: 1,
    updatedAt: 1,
  });
  const created = store.insertWorkflow({
    id: workflowId,
    name: `Intent workflow ${id}`,
    normalizedName: normalizeWorkflowName(`Intent workflow ${id}`),
    description: "",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "persona", kind: "persona", personaId, position: { x: 200, y: 0 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "start", source: "session", sourcePort: "submitted", target: "persona", targetPort: "activate" },
        { id: "pass", source: "persona", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "repair", source: "persona", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
    completionPolicy: { kind: "none" },
    resumptionPolicy: "manual",
    evidenceReadinessPolicy: "off",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(created.ok, true);
  const published = store.publishWorkflow(workflowId, 1, `intent-version-${id}`, 2);
  assert.equal(published.ok, true);
  if (!published.ok) throw new Error("workflow did not publish");

  const goal = { prompt: HUMAN_ASK };
  /** Flipped by a test to stand in for a binding whose conversation cannot be read. */
  const intentAvailable = { value: true };
  const manager = new WorkflowManager(registry, store, {
    inject: (async (
      _session: Session,
      _payload: string,
      _deps?: InjectDeps,
      beforeWrite?: PromptWriteGuard,
    ) => {
      const blocked = beforeWrite?.();
      if (blocked) return { ok: false, error: blocked, pasted: false, submitVerified: false };
      return { ok: true, pasted: true, submitVerified: true };
    }) as never,
    recordInjection: (() => {}) as never,
    // The freeze reads the live Goal exactly once, at run creation. `goal.prompt` is mutated
    // between rounds below to stand in for the prompt hook overwriting it.
    readIntentSnapshot: (_registry, binding, _anchors, now = Date.now()) =>
      intentAvailable.value
        ? freezeWorkflowRunIntent({
            rawGoal: goal.prompt,
            refinedGoal: null,
            sourceNoteKey: binding.noteKey,
            decisions: [],
            frozenAt: now,
          })
        : null,
    readContextRaw: async (_registry, binding, _feedback, _anchors, frozenIntent) => {
      await beforeReadContext?.();
      const raw = {
        // What capture does on the real path: the frozen ask where there is one, the live
        // Goal where there is not.
        primaryGoal: {
          rawPrompt: frozenIntent?.rawGoal ?? goal.prompt,
          refined: null,
          sourceNoteKey: binding.noteKey,
        },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude" as const, name: id, cwd: repositoryRoot, branch: "feature" },
        evidence: {
          headSha: `head-${rounds.n}`,
          diffFingerprint: `diff-${rounds.n}`,
          diff: `patch ${rounds.n}`,
          diffTruncated: false,
          workingTreeDirty: false,
          workingTreeStatus: [],
          workingTreeStatusTruncated: false,
          transcript: [],
          transcriptAnchor: rounds.n,
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
          headSha: `head-${rounds.n}`,
          transcriptPath: null,
          transcriptSize: 0,
          repositoryFingerprint: `repo-${rounds.n}`,
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext,
    engine: {
      runnerFor: () => failingRunner,
      resolveExecution: () => ({
        runner: { id: "claude", source: "config", unknown: null },
        model: { id: "fake", source: "config" },
      }),
    },
  });
  /** Bumped by the caller so each round captures genuinely different work. */
  const rounds = { n: 1 };
  manager.start();
  t.after(() => manager.stop());
  const binding = manager.createBinding({ workflowVersionId: published.version.id, sessionId: id });
  assert.equal(binding.ok, true);
  if (!binding.ok) throw new Error("binding was refused");
  return { registry, store, manager, binding: binding.value, goal, rounds, intentAvailable };
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5_000) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const criteriaFor = (texts: string[]) => ({
  constraints: [],
  acceptanceCriteria: texts,
  canonicalCriteria: texts.map((text) => ({
    text,
    material: true,
    suggestedProofClass: "visual" as const,
  })),
});

test("criteria are compacted once per run and survive every repair round", async (t) => {
  let compactions = 0;
  const h = await repairHarness(t, "round-stable-intent", async (raw) => {
    compactions += 1;
    return compactWorkflowContext(raw, {
      runner: "claude",
      model: "fake",
      // The compactor answers from the goal it is given, which is what made drift visible in
      // production: a criteria set distilled from the packet reads like the packet.
      execute: async () => ({
        kind: "ok",
        value: criteriaFor([`Satisfies: ${raw.primaryGoal.rawPrompt}`]),
      }),
      reconcile: async () => ({ kind: "ok", value: { criterionMappings: [] } }),
    });
  });

  const submitted = await h.manager.submit(h.binding.id, { requestId: "round-1" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session",
    "the failing persona never parked the run for repair",
  );
  assert.equal(compactions, 1);
  const frozen = h.store.getRun(runId)?.criteria ?? null;
  assert.ok(frozen, "the first compaction froze the run's criteria");
  assert.deepEqual(frozen.acceptanceCriteria, [`Satisfies: ${HUMAN_ASK}`]);
  assert.equal(h.store.getRun(runId)?.intent?.rawGoal, HUMAN_ASK);

  // Four repair rounds, with the Goal replaced by a packet before each one - the shape of the
  // observed run, where seven of eight decisions and the goal itself were Mission Control's.
  for (let round = 2; round <= 5; round++) {
    h.goal.prompt = `${REPAIR_PACKET}\n\nRound ${round}`;
    h.rounds.n = round;
    const repaired = await h.manager.resubmit(runId, { requestId: `round-${round}` });
    assert.equal(repaired.ok, true, `round ${round} was refused`);
    await waitFor(
      () => h.store.latestSubmission(runId)?.round === round
        && h.store.getRun(runId)?.status === "waiting_for_session",
      `round ${round} never parked for repair`,
    );
  }

  const submissions = h.store.listSubmissions(runId);
  assert.equal(submissions.length, 5);
  assert.equal(compactions, 1, "every round after the first reused the run's criteria");
  const contexts = submissions.map((row) => WorkflowContextSnapshotSchema.parse(row.context));
  assert.deepEqual(
    new Set(contexts.map((context) => JSON.stringify(context.canonicalCriteria))),
    new Set([JSON.stringify(frozen.canonicalCriteria)]),
    "the criteria a submission is judged by must be identical in every round",
  );
  assert.deepEqual(
    new Set(contexts.map((context) => context.intentFingerprint)),
    new Set([h.store.getRun(runId)!.intent!.fingerprint]),
    "every round carries the run's one intent identity",
  );
  for (const context of contexts) {
    assert.equal(context.primaryGoal.rawPrompt, HUMAN_ASK);
    assert.equal(
      context.acceptanceCriteria.some((criterion) => criterion.includes("preflight")),
      false,
      "no repair packet may appear in the criteria a Persona reviews against",
    );
  }
  assert.deepEqual(h.store.getRun(runId)?.criteria, frozen, "reuse never rewrites the run");
});

test("a failed first compaction freezes nothing and the next round retries it", async (t) => {
  let compactions = 0;
  const h = await repairHarness(t, "retry-intent", async (raw) => {
    compactions += 1;
    if (compactions === 1) return fallbackWorkflowContext(raw, "provider unavailable");
    return compactWorkflowContext(raw, {
      runner: "claude",
      model: "fake",
      execute: async () => ({ kind: "ok", value: criteriaFor(["Diff link settles"]) }),
      reconcile: async () => ({ kind: "ok", value: { criterionMappings: [] } }),
    });
  });

  const submitted = await h.manager.submit(h.binding.id, { requestId: "retry-1" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session",
    "the failing persona never parked the run for repair",
  );
  assert.equal(compactions, 1);
  assert.equal(
    h.store.getRun(runId)?.criteria ?? null,
    null,
    "a fallback compaction is a record of a failure, not the run's criteria",
  );

  h.rounds.n = 2;
  const repaired = await h.manager.resubmit(runId, { requestId: "retry-2" });
  assert.equal(repaired.ok, true);
  await waitFor(
    () => h.store.latestSubmission(runId)?.round === 2
      && h.store.getRun(runId)?.status === "waiting_for_session",
    "round 2 never parked for repair",
  );
  assert.equal(compactions, 2, "the failed compaction retried on the next round");
  const frozen = h.store.getRun(runId)?.criteria ?? null;
  assert.ok(frozen, "the recovered compaction froze the run's criteria");
  assert.deepEqual(frozen.acceptanceCriteria, ["Diff link settles"]);
  assert.equal(frozen.compactedFromSubmissionId, h.store.latestSubmission(runId)!.id);

  h.rounds.n = 3;
  const third = await h.manager.resubmit(runId, { requestId: "retry-3" });
  assert.equal(third.ok, true);
  await waitFor(
    () => h.store.latestSubmission(runId)?.round === 3
      && h.store.getRun(runId)?.status === "waiting_for_session",
    "round 3 never parked for repair",
  );
  assert.equal(compactions, 2, "the recovered criteria are reused, not recompacted");
});

/**
 * Two captures of one run, overlapping, spending exactly one compaction between them.
 *
 * The run-level reuse decision is made AFTER the capture read, which shells out to git and
 * can take seconds. A capture that decided from the run row it resolved BEFORE that read
 * would see a null criteria column that another capture has since filled, and buy a second
 * canonical compaction for a run that already had one.
 *
 * Round 1 falls back so the column is genuinely still null when round 2 resolves its run row.
 * The hold then stands exactly in the window: round 2 is inside its context read while the
 * criteria are frozen underneath it, which is what a concurrent winner does.
 */
test("a capture that started before the run's criteria were frozen still reuses them", async (t) => {
  let compactions = 0;
  let releaseHold: (() => void) | null = null;
  let held: Promise<void> | null = null;
  const h = await repairHarness(
    t,
    "stale-read-intent",
    async (raw) => {
      compactions += 1;
      if (compactions === 1) return fallbackWorkflowContext(raw, "provider unavailable");
      return compactWorkflowContext(raw, {
        runner: "claude",
        model: "fake",
        execute: async () => ({ kind: "ok", value: criteriaFor(["A second compaction"]) }),
        reconcile: async () => ({ kind: "ok", value: { criterionMappings: [] } }),
      });
    },
    () => held ?? Promise.resolve(),
  );

  const submitted = await h.manager.submit(h.binding.id, { requestId: "stale-1" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session",
    "the failing persona never parked the run for repair",
  );
  assert.equal(compactions, 1);
  assert.equal(h.store.getRun(runId)?.criteria ?? null, null, "round 1 froze nothing");

  // Round 2 enters capture and is held inside its context read. Its view of the run - taken
  // before the hold - says this run has no criteria. That view is about to go stale.
  held = new Promise<void>((resolve) => { releaseHold = resolve; });
  h.rounds.n = 2;
  const repairing = h.manager.resubmit(runId, { requestId: "stale-2" });
  await waitFor(
    () => h.store.latestSubmission(runId)?.round === 2 && releaseHold !== null,
    "round 2 never reached its context read",
  );
  // The concurrent winner, through the store's own write-once door.
  const raced = h.store.freezeRunCriteria(runId, {
    intentFingerprint: h.store.getRun(runId)!.intent!.fingerprint,
    constraints: [],
    acceptanceCriteria: ["The winning capture's criteria"],
    canonicalCriteria: [{
      id: "criterion-1-raced",
      text: "The winning capture's criteria",
      material: true,
      suggestedProofClass: null,
    }],
    compaction: {
      status: "model",
      runner: "claude",
      model: "fake",
      error: null,
      reusedFromSubmissionId: null,
    },
    compactedFromSubmissionId: h.store.listSubmissions(runId)[0]!.id,
    compactedAt: 20,
  });
  assert.ok(raced, "the racing writer froze the run's criteria");
  releaseHold!();
  held = null;
  const repaired = await repairing;
  assert.equal(repaired.ok, true);
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session",
    "round 2 never parked for repair",
  );

  assert.equal(compactions, 1, "the held capture must reuse the run's criteria, not recompact");
  assert.deepEqual(h.store.getRun(runId)?.criteria, raced, "reuse never rewrites the run");
  const second = WorkflowContextSnapshotSchema.parse(
    h.store.submissionForRepairRound(runId, 2)!.context,
  );
  assert.deepEqual(
    second.acceptanceCriteria,
    ["The winning capture's criteria"],
    "round 2 is judged by the criteria the run holds, not by a second set of its own",
  );
});

/**
 * A damaged frozen basis is refused, not quietly downgraded to the live Goal.
 *
 * `intent` being null used to mean three different things - a genuine pre-migration run, a
 * run whose conversation could not be read, and a row whose payload will not parse - and the
 * live-read path is correct for exactly one of them. Taking it for the other two would hand a
 * review back to the mutable Goal through a corrupted row instead of a hook, which is the same
 * failure by another route.
 */
test("a run whose frozen basis cannot be read is blocked, not reverted to the live Goal", async (t) => {
  let compactions = 0;
  const h = await repairHarness(t, "unreadable-intent", async (raw) => {
    compactions += 1;
    return compactWorkflowContext(raw, {
      runner: "claude",
      model: "fake",
      execute: async () => ({ kind: "ok", value: criteriaFor(["Diff link settles"]) }),
      reconcile: async () => ({ kind: "ok", value: { criterionMappings: [] } }),
    });
  });
  const submitted = await h.manager.submit(h.binding.id, { requestId: "unreadable-1" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session",
    "the failing persona never parked the run for repair",
  );
  assert.equal(h.store.getRun(runId)?.intentState, "frozen");

  openDb().prepare("UPDATE workflow_runs SET intent_json = ? WHERE id = ?")
    .run('{"rawGoal":"but the rest of this shape is wrong"}', runId);
  // The run survives the damage as a readable, diagnosable row. Reporting it as `unreadable`
  // rather than throwing is what keeps it visible: every other JSON column on this row throws
  // through `parseNullableJson`, which `getRun` catches by returning null - so one bad byte
  // would otherwise erase the run from every listing an operator has.
  const damaged = h.store.getRun(runId);
  assert.ok(damaged, "a damaged snapshot must not erase the run");
  assert.equal(damaged.intentState, "unreadable");
  assert.equal(damaged.intent, null);

  h.rounds.n = 2;
  const repaired = await h.manager.resubmit(runId, { requestId: "unreadable-2" });
  assert.equal(repaired.ok, false);
  if (repaired.ok) return;
  assert.equal(compactions, 1, "a run with no trustworthy basis must not compact a new one");
  const blocked = h.store.getRun(runId);
  assert.equal(blocked?.status, "blocked");
  assert.equal(blocked?.currentPhase, "capture_error");
  assert.equal(
    h.store.listEvents(runId).some((event) => event.kind === "run_intent_unreadable"),
    true,
    "the refusal is durable and nameable, not just a returned error",
  );
});

test("a binding with no live conversation cannot create a run at all", async (t) => {
  const h = await repairHarness(t, "no-conversation-intent", async (raw) =>
    compactWorkflowContext(raw, {
      runner: "claude",
      model: "fake",
      execute: async () => ({ kind: "ok", value: criteriaFor(["Diff link settles"]) }),
      reconcile: async () => ({ kind: "ok", value: { criterionMappings: [] } }),
    }));
  // The one condition under which the freeze has no answer. A run created here would carry no
  // snapshot and would then be indistinguishable from a pre-migration run - a NEW run silently
  // entitled to the live-read path. Refusing keeps `never_frozen` meaning only what it says.
  h.intentAvailable.value = false;
  const submitted = await h.manager.submit(h.binding.id, { requestId: "no-conversation" });
  assert.equal(submitted.ok, false);
  if (submitted.ok) return;
  assert.equal(submitted.reason, "incompatible_session");
  // Scoped to this binding: the suite shares one database, so a global count would be reading
  // every other test's runs.
  assert.equal(
    h.store.latestRunForBinding(h.binding.id),
    null,
    "no run may exist without an ask to review against",
  );
});

/**
 * A run created before the snapshot existed, driven end to end on the path it was created for.
 *
 * The other tests here all prove what a FROZEN run does. This one proves the freeze did not
 * quietly take the old path away: a row with no snapshot is what every run in an upgrading
 * installation looks like, and its reviews have to keep working exactly as they did - live
 * intent read per submission, criteria compacted per submission, nothing frozen onto the run.
 *
 * `intent_json` is nulled directly because that IS a pre-migration row, and because the
 * manager now refuses to create one: production cannot mint a snapshot-less run, so the only
 * honest way to obtain one is the way an upgrade produces it.
 */
test("a pre-migration run keeps reading intent live and compacting per submission", async (t) => {
  let compactions = 0;
  const goals: string[] = [];
  const h = await repairHarness(t, "pre-migration-intent", async (raw) => {
    compactions += 1;
    goals.push(raw.primaryGoal.rawPrompt);
    return compactWorkflowContext(raw, {
      runner: "claude",
      model: "fake",
      execute: async () => ({
        kind: "ok",
        value: criteriaFor([`Satisfies: ${raw.primaryGoal.rawPrompt}`]),
      }),
      reconcile: async () => ({ kind: "ok", value: { criterionMappings: [] } }),
    });
  });

  const submitted = await h.manager.submit(h.binding.id, { requestId: "legacy-1" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session",
    "the failing persona never parked the run for repair",
  );

  // Demote the run to what an upgrading installation's in-flight runs actually are.
  openDb().prepare(
    "UPDATE workflow_runs SET intent_json = NULL, run_criteria_json = NULL WHERE id = ?",
  ).run(runId);
  const legacy = h.store.getRun(runId);
  assert.equal(legacy?.intentState, "never_frozen");
  assert.equal(legacy?.intent, null);
  assert.equal(legacy?.criteria, null);
  assert.equal(compactions, 1);

  // The live Goal moves, which for a legacy run is the whole point: it has no frozen ask, so
  // the review is judged against whatever the Goal says now. That is the OLD behaviour, and a
  // pre-migration run is entitled to keep it rather than be silently switched mid-flight.
  h.goal.prompt = "A later objective this legacy run should read";
  h.rounds.n = 2;
  const repaired = await h.manager.resubmit(runId, { requestId: "legacy-2" });
  assert.equal(repaired.ok, true);
  await waitFor(
    () => h.store.latestSubmission(runId)?.round === 2
      && h.store.getRun(runId)?.status === "waiting_for_session",
    "round 2 never parked for repair",
  );

  assert.equal(compactions, 2, "a run with no frozen intent still compacts per submission");
  assert.equal(goals[1], "A later objective this legacy run should read");
  assert.equal(
    h.store.getRun(runId)?.criteria ?? null,
    null,
    "a legacy run freezes no run-level criteria",
  );
  assert.equal(h.store.getRun(runId)?.intentState, "never_frozen");
  const second = WorkflowContextSnapshotSchema.parse(
    h.store.submissionForRepairRound(runId, 2)!.context,
  );
  assert.equal(second.primaryGoal.rawPrompt, "A later objective this legacy run should read");
  assert.deepEqual(
    second.acceptanceCriteria,
    ["Satisfies: A later objective this legacy run should read"],
    "the legacy path recompacts from the goal it read this submission",
  );
});

/**
 * A row with criteria but no ask is corruption, and capture must refuse it.
 *
 * The pre-migration test above demotes a row by nulling `intent_json` ALONE, which is what an
 * upgrade genuinely leaves and which correctly takes the live-read path. This one nulls the
 * ask while leaving criteria behind - a shape no upgrade produces, reachable from a partial
 * restore or two rows mixed together. Reading it as legacy would hand a corrupted run to the
 * mutable Goal, which is precisely the substitution the freeze exists to prevent.
 */
test("a run with criteria but no frozen ask is blocked, not treated as pre-migration", async (t) => {
  let compactions = 0;
  const h = await repairHarness(t, "mixed-row-intent", async (raw) => {
    compactions += 1;
    return compactWorkflowContext(raw, {
      runner: "claude",
      model: "fake",
      execute: async () => ({ kind: "ok", value: criteriaFor(["Diff link settles"]) }),
      reconcile: async () => ({ kind: "ok", value: { criterionMappings: [] } }),
    });
  });
  const submitted = await h.manager.submit(h.binding.id, { requestId: "mixed-1" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session",
    "the failing persona never parked the run for repair",
  );
  assert.ok(h.store.getRun(runId)?.criteria, "round 1 froze the run's criteria");

  // The ask alone goes missing. The criteria it produced stay behind.
  openDb().prepare("UPDATE workflow_runs SET intent_json = NULL WHERE id = ?").run(runId);
  const mixed = h.store.getRun(runId);
  assert.ok(mixed, "a mixed row must not erase the run");
  assert.equal(mixed.intentState, "unreadable", "this is not the pre-migration shape");
  assert.equal(mixed.criteria, null);

  h.goal.prompt = "A later objective a corrupted run must never be judged against";
  h.rounds.n = 2;
  const repaired = await h.manager.resubmit(runId, { requestId: "mixed-2" });
  assert.equal(repaired.ok, false, "capture must refuse rather than read the live Goal");
  assert.equal(compactions, 1, "a corrupted run must not compact against the live Goal");
  const blocked = h.store.getRun(runId);
  assert.equal(blocked?.status, "blocked");
  assert.equal(blocked?.currentPhase, "capture_error");
  assert.equal(
    h.store.listEvents(runId).some((event) => event.kind === "run_intent_unreadable"),
    true,
  );
  // The decisive assertion: nothing was reviewed against the goal that replaced the ask.
  const contexts = h.store.listSubmissions(runId)
    .map((row) => WorkflowContextSnapshotSchema.safeParse(row.context))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
  assert.equal(
    contexts.some((context) => context.primaryGoal.rawPrompt.includes("A later objective")),
    false,
    "no submission may carry the live Goal a corrupted run fell back to",
  );
});

test("run criteria freeze once, and a second writer adopts the first", () => {
  const store = new WorkflowStore();
  const now = 10;
  const intent = {
    rawGoal: HUMAN_ASK,
    openingAsk: "Please fix the spinner",
    intentSource: {
      objectiveVersion: 2, promptRevision: 3, resolvedPromptRevision: 3, relationship: "steer" as const,
    },
    refinedGoal: null,
    sourceNoteKey: "note",
    decisions: [],
    frozenAt: now,
  };
  // What the store will derive. A caller cannot supply an identity any more, so a test that
  // needs to name one computes it exactly as the store does rather than inventing it.
  const frozenFingerprint = workflowRunIntentFingerprint(intent);
  const binding = store.insertBinding({
    id: "intent-binding",
    workflowVersionId: "intent-version",
    noteKey: "intent-note",
    sessionId: "intent-session",
    sessionAgent: "claude",
    sessionName: "intent",
    sessionCwd: repositoryRoot,
    sessionRepoRoot: repositoryRoot,
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 3,
    now,
  });
  const created = store.createInitialSubmission(
    {
      id: "intent-run",
      binding,
      triggerSource: "manual",
      triggerKey: "intent-trigger",
      now,
      intent,
    },
    {
      id: "intent-submission",
      triggerSource: "manual",
      triggerKey: "intent-trigger",
      context: {},
      evidence: {},
      now,
    },
  );
  assert.deepEqual(created.run.intent, { ...intent, fingerprint: frozenFingerprint });
  assert.equal(created.run.criteria ?? null, null);

  const first = {
    intentFingerprint: frozenFingerprint,
    constraints: [],
    acceptanceCriteria: ["The first writer's criteria"],
    canonicalCriteria: [],
    compaction: {
      status: "model" as const,
      runner: "claude" as const,
      model: "fake",
      error: null,
      reusedFromSubmissionId: null,
    },
    compactedFromSubmissionId: "intent-submission",
    compactedAt: now,
  };
  assert.deepEqual(store.freezeRunCriteria("intent-run", first), first);
  // A second capture of the same run must adopt what is already in play rather than review
  // against a set nobody else can see. The answer is what the ROW holds, not what was offered.
  assert.deepEqual(
    store.freezeRunCriteria("intent-run", {
      ...first,
      acceptanceCriteria: ["A second, later set"],
      compactedFromSubmissionId: "another-submission",
    }),
    first,
  );
  assert.deepEqual(store.getRun("intent-run")?.criteria, first);

  // A fallback is a record that compaction FAILED. Freezing one would give the run an empty
  // canonical criteria set that every later submission dutifully reuses - the same standstill
  // as drifting criteria, reached from the other direction. The durable type does not admit
  // one, and the store refuses it at its own boundary so a caller that bypasses
  // `workflowRunCriteriaFrom` cannot reintroduce the state.
  assert.throws(
    () => store.freezeRunCriteria("intent-run", {
      ...first,
      compaction: { ...first.compaction, status: "fallback" as unknown as "model" },
    }),
    /invalid_literal/,
    "a fallback compaction must never become durable run criteria",
  );
  assert.deepEqual(store.getRun("intent-run")?.criteria, first, "the refusal wrote nothing");

  // Criteria distilled from a different ask are refused BEFORE the write. Catching this only
  // on read would be a poor second best: the column is write-once, so a bad write could never
  // be repaired through this path and the run would stay unreadable for good.
  const otherRun = store.createInitialSubmission(
    {
      id: "foreign-criteria-run",
      binding,
      intent,
      triggerSource: "manual",
      triggerKey: "foreign-criteria-trigger",
      now,
    },
    {
      id: "foreign-criteria-submission",
      triggerSource: "manual",
      triggerKey: "foreign-criteria-trigger",
      context: {},
      evidence: {},
      now,
    },
  );
  assert.equal(otherRun.run.intentState, "frozen");
  assert.throws(
    () => store.freezeRunCriteria("foreign-criteria-run", {
      ...first,
      intentFingerprint: "d".repeat(64),
      compactedFromSubmissionId: "foreign-criteria-submission",
    }),
    /different intent/,
    "criteria from another ask must not reach the write-once column",
  );
  assert.equal(
    store.getRun("foreign-criteria-run")?.criteria ?? null,
    null,
    "the refused write left the run repairable rather than permanently unreadable",
  );
  assert.equal(store.getRun("foreign-criteria-run")?.intentState, "frozen");

  // Schema-valid and too large to read back is the same trap by another route: both columns
  // are write-once, so a payload the read path refuses would block its run for good with
  // nothing able to repair it. 200 decisions at 16,000 characters each is 6.4M against a 2M
  // ceiling, so the schema alone genuinely permits it.
  const oversized = {
    rawGoal: HUMAN_ASK,
    refinedGoal: null,
    sourceNoteKey: "note",
    decisions: Array.from({ length: 200 }, (_unused, index) => ({
      decision: "d".repeat(16_000),
      rationale: `${index}`.padEnd(16_000, "r"),
      source: { kind: "transcript" as const, id: `oversized-${index}` },
    })),
    frozenAt: now,
  };
  assert.throws(
    () => store.createInitialSubmission(
      {
        id: "oversized-run",
        binding,
        intent: oversized,
        triggerSource: "manual",
        triggerKey: "oversized-trigger",
        now,
      },
      {
        id: "oversized-submission",
        triggerSource: "manual",
        triggerKey: "oversized-trigger",
        context: {},
        evidence: {},
        now,
      },
    ),
    /the read path can load back/,
    "a snapshot the read path could not load back must be refused at the write",
  );
  assert.equal(store.getRun("oversized-run"), null, "the refused run was never created");
});

/**
 * Creation always produces a run with a frozen ask. There is no other spelling.
 *
 * `intent` is required on both run-creating store inputs and takes a real snapshot, so no
 * caller - present or future, production or fixture - can create a run that reads the mutable
 * live Goal for its lifetime. That was the last way a NEW run could end up indistinguishable
 * from historical data: an optional field and an explicit "no ask" marker both ended at the
 * same SQL NULL as a genuine pre-migration row.
 *
 * The legacy shape stays reachable, because the pre-migration path must keep working, but only
 * by DEMOTING a row - see the pre-migration test above, which nulls `intent_json` exactly as a
 * daemon upgrade leaves it.
 */
test("every created run carries a frozen ask, whatever the caller", () => {
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: "always-frozen-binding",
    workflowVersionId: "always-frozen-version",
    noteKey: "always-frozen-note",
    sessionId: "always-frozen-session",
    sessionAgent: "claude",
    sessionName: "frozen",
    sessionCwd: repositoryRoot,
    sessionRepoRoot: repositoryRoot,
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 3,
    now: 30,
  });
  const created = store.createInitialSubmission(
    {
      id: "always-frozen-run",
      binding,
      intent: FIXTURE_RUN_INTENT,
      triggerSource: "manual",
      triggerKey: "always-frozen-trigger",
      now: 30,
    },
    {
      id: "always-frozen-submission",
      triggerSource: "manual",
      triggerKey: "always-frozen-trigger",
      context: {},
      evidence: {},
      now: 30,
    },
  );
  // The fields the caller supplied, plus an identity the caller did NOT supply and could not
  // have got wrong. The fingerprint is derived at the store boundary from exactly these
  // fields, so a snapshot whose identity disagrees with its own ask is not constructible.
  assert.deepEqual(created.run.intent, {
    ...FIXTURE_RUN_INTENT,
    fingerprint: workflowRunIntentFingerprint(FIXTURE_RUN_INTENT),
  });
  assert.equal(created.run.intentState, "frozen");
  assert.equal(created.run.criteria, null);

  // And checked again on the way out, because deriving on write says nothing about a row an
  // older build wrote from a caller-supplied fingerprint, or one a partial write left behind.
  openDb().prepare("UPDATE workflow_runs SET intent_json = ? WHERE id = ?").run(
    JSON.stringify({ ...FIXTURE_RUN_INTENT, fingerprint: "c".repeat(64) }),
    "always-frozen-run",
  );
  const lying = store.getRun("always-frozen-run");
  assert.ok(lying, "a mismatched fingerprint must not erase the run");
  assert.equal(lying.intentState, "unreadable");
  assert.equal(lying.intent, null, "an ask whose identity is a lie is never handed back");

  openDb().prepare("UPDATE workflow_runs SET intent_json = ? WHERE id = ?").run(
    JSON.stringify(freezeWorkflowRunIntent(FIXTURE_RUN_INTENT)),
    "always-frozen-run",
  );
  assert.equal(store.getRun("always-frozen-run")?.intentState, "frozen");

  // Criteria distilled from OTHER intent are not a value to recompute, they are evidence the
  // row is wrong. Both stored halves parse here; only their relationship is broken, which is
  // why the check has to live where both are read.
  const foreign = {
    intentFingerprint: "b".repeat(64),
    constraints: [],
    acceptanceCriteria: ["Criteria from somebody else's ask"],
    canonicalCriteria: [],
    compaction: {
      status: "model" as const,
      runner: "claude" as const,
      model: "fake",
      error: null,
      reusedFromSubmissionId: null,
    },
    compactedFromSubmissionId: "always-frozen-submission",
    compactedAt: 31,
  };
  openDb().prepare("UPDATE workflow_runs SET run_criteria_json = ? WHERE id = ?")
    .run(JSON.stringify(foreign), "always-frozen-run");
  const mismatched = store.getRun("always-frozen-run");
  assert.ok(mismatched, "a mismatched criteria row must not erase the run");
  assert.equal(mismatched.intentState, "unreadable");
  assert.equal(mismatched.criteria, null, "criteria from another ask are never handed back");
  assert.deepEqual(
    mismatched.intent,
    { ...FIXTURE_RUN_INTENT, fingerprint: workflowRunIntentFingerprint(FIXTURE_RUN_INTENT) },
    "the ask itself is still readable",
  );
});


test("steering freezes the durable objective and preserves opening provenance across amendments and replacement", async () => {
  const registry = new Registry();
  registry.applyDiscovery([discovered("objective-contract")]);
  const { session, binding } = bindingFor(registry, "objective-contract");
  registry.captureAcceptedPrompt(session.id, HUMAN_ASK, binding.noteKey);
  const amended = `${HUMAN_ASK}. Keep the keyboard shortcut working.`;
  registry.captureAcceptedPrompt(session.id, "Keep the keyboard shortcut working", binding.noteKey);
  registry.upsertGoal(session.id, {
    objective: amended, text: amended, objectiveVersion: 2,
    resolvedPromptRevision: 2, relationship: "amend", pendingPrompts: [],
  });
  registry.captureAcceptedPrompt(session.id, "create pr", binding.noteKey);
  registry.upsertGoal(session.id, { relationship: "steer", resolvedPromptRevision: 3, pendingPrompts: [] });
  const frozen = readWorkflowIntentSnapshot(registry, binding)!;
  assert.equal(frozen.rawGoal, amended);
  assert.equal(frozen.openingAsk, HUMAN_ASK);
  assert.deepEqual(frozen.intentSource, {
    objectiveVersion: 2, promptRevision: 3, resolvedPromptRevision: 3, relationship: "steer",
  });
  const captured = await readWorkflowContextRaw(registry, binding, [], [], frozen);
  assert.equal(captured.raw.primaryGoal.openingAsk, HUMAN_ASK);
  assert.deepEqual(captured.raw.primaryGoal.intentSource, frozen.intentSource);
  let compactionInput = "";
  const compacted = await compactWorkflowContext(captured.raw, {
    runner: "claude", model: "fake",
    execute: async (request) => {
      compactionInput = request;
      return { kind: "ok", value: criteriaFor([amended]) };
    },
    reconcile: async () => ({ kind: "ok", value: { criterionMappings: [] } }),
  });
  assert.ok(compactionInput.includes(amended));
  assert.ok(!compactionInput.includes("create pr"));
  assert.equal(compacted.primaryGoal.openingAsk, HUMAN_ASK);
  const persona = {
    sourcePersonaId: "reviewer", sourceRevision: 1, name: "Reviewer", description: "",
    guidanceMarkdown: "Review the contract", runner: null, model: null,
  };
  const prompt = buildPersonaPrompt(persona, compacted);
  assert.match(prompt, /# Original human intent\nReview contract/);
  assert.ok(prompt.includes(amended));
  assert.ok(prompt.includes("Opening request this contract was derived from"));
  assert.match(prompt, /Captured objective version 2; prompt revision 3; resolved revision 3; relationship steer/);
  const sameOpening = buildPersonaPrompt(persona, {
    ...compacted, primaryGoal: { ...compacted.primaryGoal, openingAsk: amended },
  });
  const intentSection = sameOpening.split("# Original human intent")[1]!.split("# Published Persona guidance")[0]!;
  assert.ok(!intentSection.includes("Opening request this contract was derived from"));
  registry.captureAcceptedPrompt(session.id, "Replace the spinner with a static link", binding.noteKey);
  registry.upsertGoal(session.id, {
    objective: "Replace the spinner with a static link", text: "Static link",
    objectiveVersion: 3, resolvedPromptRevision: 4, relationship: "replace", pendingPrompts: [],
  });
  assert.equal(readWorkflowIntentSnapshot(registry, binding)?.openingAsk, HUMAN_ASK);
  assert.equal(frozen.rawGoal, amended, "a later replacement never rewrites frozen intent");
});

test("Persona intent reports an unresolved relationship for a captured pending instruction", async () => {
  const registry = new Registry();
  registry.applyDiscovery([discovered("unresolved-intent-source")]);
  const { session, binding } = bindingFor(registry, "unresolved-intent-source");
  registry.captureAcceptedPrompt(session.id, HUMAN_ASK, binding.noteKey);
  registry.upsertGoal(session.id, {
    relationship: "initial", resolvedPromptRevision: 1, pendingPrompts: [],
  });
  registry.captureAcceptedPrompt(session.id, "continue", binding.noteKey);

  const frozen = readWorkflowIntentSnapshot(registry, binding)!;
  assert.deepEqual(frozen.intentSource, {
    objectiveVersion: 1, promptRevision: 2, resolvedPromptRevision: 1, relationship: null,
  });
  const captured = await readWorkflowContextRaw(registry, binding, [], [], frozen);
  const prompt = buildPersonaPrompt({
    sourcePersonaId: "reviewer", sourceRevision: 1, name: "Reviewer", description: "",
    guidanceMarkdown: "Review the contract", runner: null, model: null,
  }, fallbackWorkflowContext(captured.raw, null));
  // Inspect only intent: the live diff also contains these test assertions.
  const intentSection = prompt.split("# Original human intent")[1]!.split("# Published Persona guidance")[0]!;
  assert.ok(intentSection.includes(HUMAN_ASK));
  assert.match(intentSection, /Captured objective version 1; prompt revision 2; resolved revision 1; relationship unresolved\./);
  assert.doesNotMatch(intentSection, /relationship (?:null|undefined|initial|steer)/);
});

test("a session without an objective falls back to its prompt without inventing provenance", () => {
  const registry = new Registry();
  registry.applyDiscovery([discovered("no-objective")]);
  const { session, binding } = bindingFor(registry, "no-objective");
  registry.upsertGoal(session.id, { prompt: HUMAN_ASK });
  const frozen = readWorkflowIntentSnapshot(registry, binding)!;
  assert.equal(frozen.rawGoal, HUMAN_ASK);
  assert.equal(frozen.openingAsk, null);
  assert.equal(frozen.intentSource, null);
});

test("the opening request stays verbatim through capture while Persona input stays bounded", async () => {
  const registry = new Registry();
  registry.applyDiscovery([discovered("long-opening")]);
  const { session, binding } = bindingFor(registry, "long-opening");
  const prompt = "\n  Opening\n" + "long request 🦊\t".repeat(20_000) + "\nFinal requirement  \n";
  assert.ok(prompt.length > REVIEW_LIMITS.section);
  const captured = registry.captureAcceptedPrompt(session.id, prompt, binding.noteKey)!;
  assert.equal(captured.openingPrompt?.length, prompt.length, "capture must retain the entire request");
  assert.equal(captured.openingPrompt, prompt);
  const frozen = WorkflowRunIntentSnapshotSchema.parse(readWorkflowIntentSnapshot(registry, binding));
  assert.equal(frozen.openingAsk, prompt);
  assert.equal(frozen.rawGoal, clampPrompt(prompt.trim()), "the objective keeps its existing bound");
  const read = await readWorkflowContextRaw(registry, binding, [], [], frozen);
  const context = WorkflowContextSnapshotSchema.parse(fallbackWorkflowContext(read.raw, null));
  assert.equal(context.primaryGoal.openingAsk, prompt);
  const personaPrompt = buildPersonaPrompt({
    sourcePersonaId: "reviewer", sourceRevision: 1, name: "Reviewer", description: "",
    guidanceMarkdown: "Review the contract", runner: null, model: null,
  }, context);
  const openingSection = personaPrompt.split(
    "Opening request this contract was derived from (as recorded by the Goal pipeline):\n",
  )[1]!.split("\nCaptured objective version")[0];
  assert.equal(openingSection, `${prompt.slice(0, REVIEW_LIMITS.section)}\n${REVIEW_TRUNCATION_MARKER}`);
  assert.equal(context.primaryGoal.openingAsk, prompt, "bounding the Persona never mutates stored context");
});

test("opening provenance does not change the fingerprint or legacy frozen rows", () => {
  const old = freezeWorkflowRunIntent(FIXTURE_RUN_INTENT);
  const augmented = { ...old, openingAsk: HUMAN_ASK, intentSource: {
    objectiveVersion: 2, promptRevision: 4, resolvedPromptRevision: 3, relationship: "amend" as const,
  } };
  assert.equal(workflowRunIntentFingerprint(augmented), old.fingerprint);
  assert.deepEqual(WorkflowRunIntentSnapshotSchema.parse(old), old);
  assert.deepEqual(WorkflowRunIntentSnapshotSchema.parse(augmented), augmented);
});

test("steering freezes by resolved revision, reaches Personas, and stays out of decisions and compaction", async () => {
  const instruction = "skip the E2E for now, the harness is broken";
  const transcriptPath = join(home, "steering-context.jsonl");
  writeFileSync(transcriptPath, JSON.stringify({ type: "user", uuid: "steering-turn", timestamp: new Date().toISOString(),
    message: { role: "user", content: instruction } }) + "\n");
  const registry = new Registry();
  registry.applyDiscovery([discovered("steering-capture", transcriptPath)]);
  const { session, binding } = bindingFor(registry, "steering-capture");
  registry.captureAcceptedPrompt(session.id, HUMAN_ASK, binding.noteKey);
  registry.upsertGoal(session.id, { relationship: "initial", resolvedPromptRevision: 1, pendingPrompts: [] });
  registry.captureAcceptedPrompt(session.id, instruction, binding.noteKey);
  registry.resolveGoal(session.id, { relationship: "steer", resolvedPromptRevision: 2, pendingPrompts: [],
    rationale: "The harness is temporarily unavailable" }, instruction, 100);
  registry.captureAcceptedPrompt(session.id, "do the smaller one first", binding.noteKey);
  const snapshot = readWorkflowIntentSnapshot(registry, binding)!;
  assert.equal(snapshot.steeringResolvedRevision, 2);
  assert.deepEqual(snapshot.steering?.map((note) => note.instruction), [instruction]);
  assert.ok(!snapshot.decisions.some((decision) => decision.decision.includes(instruction)));
  assert.equal(snapshot.fingerprint, workflowRunIntentFingerprint({ ...snapshot, steering: undefined } as typeof snapshot));
  assert.deepEqual(WorkflowRunIntentSnapshotSchema.parse(snapshot).steering, snapshot.steering);
  registry.resolveGoal(session.id, { relationship: "steer", resolvedPromptRevision: 3, pendingPrompts: [] }, "do the smaller one first", 100);
  const capture = await readWorkflowContextRaw(registry, binding, [], [], snapshot);
  assert.deepEqual(capture.raw.steering, snapshot.steering);
  assert.equal(capture.raw.steeringResolvedRevision, 2);
  assert.equal(readWorkflowIntentSnapshot(registry, binding)!.steering!.length, 2);
  let compactionPrompt = "";
  const context = await compactWorkflowContext(capture.raw, {
    execute: async (prompt) => { compactionPrompt = prompt; return { kind: "ok", value: criteriaFor([HUMAN_ASK]) }; },
    reconcile: async () => ({ kind: "ok", value: { criterionMappings: [] } }),
  });
  assert.ok(!compactionPrompt.includes(instruction));
  assert.deepEqual(context.steering, snapshot.steering);
  const persona = { sourcePersonaId: "steering-persona", sourceRevision: 1, name: "Reviewer", description: "",
    guidanceMarkdown: "Review the contract", runner: null, model: null };
  const prompt = buildPersonaPrompt(persona, context);
  const steeringIndex = prompt.indexOf("# Human steering context");
  assert.ok(steeringIndex > prompt.indexOf("Acceptance criteria:"));
  assert.ok(steeringIndex < prompt.indexOf("# Published Persona guidance"));
  const section = prompt.slice(steeringIndex, prompt.indexOf("# Published Persona guidance"));
  assert.ok(section.includes(instruction));
  assert.match(section, /do not add, remove or narrow acceptance criteria/);
  assert.match(section, /legitimately skipped or deferred/);
  assert.match(section, /Frozen through resolved prompt revision 2/);
  assert.ok(!buildPersonaPrompt(persona, { ...context, steering: [] }).split("# Published Persona guidance")[0]!.includes("# Human steering context"));
});

test("steering is bounded by count, UTF-8 bytes and the snapshot's remaining serialized budget", async () => {
  const { withWorkflowSteering } = await import("../src/server/workflows/context.ts");
  const { WORKFLOW_EXECUTION_LIMITS, WORKFLOW_STEERING_LIMITS } = await import("../src/shared/workflow.ts");
  const registry = new Registry();
  registry.applyDiscovery([discovered("bounded-steering")]);
  const { session, binding } = bindingFor(registry, "bounded-steering");
  registry.captureAcceptedPrompt(session.id, HUMAN_ASK, binding.noteKey);
  registry.upsertGoal(session.id, { relationship: "initial", resolvedPromptRevision: 1, pendingPrompts: [] });
  for (let i = 0; i < 60; i++) {
    const instruction = `Method ${i}`;
    registry.captureAcceptedPrompt(session.id, instruction, binding.noteKey);
    registry.resolveGoal(session.id, { relationship: "steer", resolvedPromptRevision: i + 2, pendingPrompts: [] }, instruction, 100);
  }
  const snapshot = readWorkflowIntentSnapshot(registry, binding)!;
  assert.equal(snapshot.steering!.length, WORKFLOW_STEERING_LIMITS.count);
  assert.equal(snapshot.steering![0]!.revision, 12);
  const instruction = "界".repeat(4_000);
  for (let i = 62; i < 70; i++) {
    registry.captureAcceptedPrompt(session.id, instruction, binding.noteKey);
    registry.resolveGoal(session.id, { relationship: "steer", resolvedPromptRevision: registry.getGoal(session.id)!.promptRevision,
      pendingPrompts: [] }, instruction, 100);
  }
  const bounded = readWorkflowIntentSnapshot(registry, binding)!;
  assert.ok(bounded.steering!.length < 50);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.steering)) <= WORKFLOW_STEERING_LIMITS.bytes);
  const base = freezeWorkflowRunIntent({ ...FIXTURE_RUN_INTENT, openingAsk: "", steering: [], steeringResolvedRevision: 61 });
  const remaining = WORKFLOW_EXECUTION_LIMITS.contextJsonBytes - Buffer.byteLength(JSON.stringify(base));
  const full = { ...base, openingAsk: "a".repeat(remaining) };
  const dropped = withWorkflowSteering(full, snapshot.steering!, 61);
  assert.deepEqual(dropped.steering, []);
  assert.equal(Buffer.byteLength(JSON.stringify(dropped)), WORKFLOW_EXECUTION_LIMITS.contextJsonBytes);
  assert.doesNotThrow(() => WorkflowRunIntentSnapshotSchema.parse(dropped));
  const store = new WorkflowStore();
  const storedBinding = store.insertBinding({ id: "budget-binding", workflowVersionId: "budget-version",
    noteKey: binding.noteKey, sessionId: session.id, sessionAgent: "claude", sessionName: "Budget",
    sessionCwd: repositoryRoot, sessionRepoRoot: repositoryRoot, triggerMode: "manual", deliveryMode: "preview",
    maxRepairRounds: 3, now: 100 });
  const created = store.createInitialSubmission({ id: "budget-run", binding: storedBinding,
    triggerSource: "manual", triggerKey: "budget-trigger", now: 100, intent: dropped },
  { id: "budget-submission", triggerSource: "manual", triggerKey: "budget-trigger", context: {}, evidence: {}, now: 100 });
  assert.deepEqual(created.run.intent?.steering, []);
  assert.equal(store.getRun("budget-run")?.intentState, "frozen");
  // The additive metadata itself also yields when the pre-feature snapshot has no room.
  const { steering: _notes, steeringResolvedRevision: _revision, ...oldShape } = full;
  oldShape.openingAsk += "a".repeat(WORKFLOW_EXECUTION_LIMITS.contextJsonBytes - Buffer.byteLength(JSON.stringify(oldShape)));
  assert.deepEqual(withWorkflowSteering(oldShape, snapshot.steering!, 61), oldShape);
});
