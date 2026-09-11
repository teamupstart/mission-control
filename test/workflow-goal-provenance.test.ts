import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKFLOW_GOAL_OBJECTIVE_FLOOR,
  classifyWorkflowGoalProvenance,
} from "../src/server/workflows/goal-provenance.ts";
import { decideShipShepherd } from "../src/server/foreman/ship-shepherd.ts";
import { buildPayload } from "../src/server/foreman/review-followup.ts";
import {
  renderEvidenceReadinessPacket,
  renderWorkflowFeedback,
} from "../src/server/workflows/feedback.ts";
import { RESTART_CONTINUATION_PROMPT } from "../src/server/sdk/supervisor.ts";
import { WRAPUP_PR } from "../src/shared/queue.ts";
import { WorkflowRunIntentProvenanceSchema } from "../src/shared/protocol.ts";
import type {
  PromptedCompletionDecision,
  Session,
  SessionQueue,
} from "../src/shared/types.ts";
import type {
  WorkflowContextSnapshot,
  WorkflowEvidenceReadinessResult,
  WorkflowRun,
  WorkflowSubmission,
  WorkflowVersion,
} from "../src/shared/workflow.ts";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

/*
 * What is at stake: this classifier is the instrument the rest of the goal-contract work is
 * measured with, and an instrument nobody checks is worse than no instrument. The defect
 * behind this work - a workflow run judged against `continue` or against its own repair
 * packet - was a query anybody could have run for months, and 10 of 25 measured runs were
 * text Mission Control typed itself. These are the assertions that would have caught it.
 *
 * Two separate jobs here, and they are deliberately not the same test:
 *
 *  1. ANTI-DRIFT. The classifier holds its OWN append-only copies of the daemon's payload
 *     prose, because a frozen ask outlives the build that captured it and a signature that
 *     tracked a live constant would forget every retired spelling. A copy nothing checks
 *     drifts, so the first half of this file runs the REAL composers and asserts their real
 *     output classifies as `automation`. Reword a payload without appending its old spelling
 *     and this is what goes red.
 *
 *  2. THE CONTRACT. Precedence, the reason, and which combinations of signals are reachable
 *     at all. A classifier whose answer depends on which check ran first reports differently
 *     on the same input from build to build, so the order is pinned rather than left to
 *     implementation order. `automation` and `implausible` cannot co-occur today, so there is
 *     no three-signal case; that is asserted over the payload set rather than asserted in a
 *     comment, because a comment is what let this file once claim a case it did not have.
 */

const NOW = 10_000_000;
const NOTE_KEY = "agent-1";

/** Classify an ask with no goal provenance beside it, which is the common shape here. */
const classify = (rawGoal: string, now = NOW) =>
  classifyWorkflowGoalProvenance({ rawGoal, intentSource: null, now });

// ---------------------------------------------------------------------------------------
// The five payload shapes, produced by the code that composes them.
// ---------------------------------------------------------------------------------------

function shipSession(over: Partial<Session> = {}): Session {
  return mkSession({
    state: "idle",
    cwd: "/repo",
    repoRoot: "/repo",
    hooksSeen: true,
    lastActivity: NOW - 21 * 60_000,
    task: mkTaskSummary({ id: "task-1", kind: "ship", status: "running" }),
    workCycle: {
      logicalKey: NOTE_KEY,
      generation: 1,
      active: false,
      completedAt: NOW - 21 * 60_000,
      updatedAt: NOW - 21 * 60_000,
    },
    pendingTurns: [],
    ...over,
  });
}

function shipQueue(over: Partial<SessionQueue> = {}): SessionQueue {
  return {
    noteKey: NOTE_KEY,
    cwd: "/repo",
    branch: "feature",
    wrapupAskedAt: null,
    wrapupAnswer: null,
    promptedGoal: null,
    promptedEvidence: null,
    promptedActivityAt: null,
    promptedLegacyCutoverGeneration: null,
    promptedConsumedGeneration: 1,
    promptedDirectHandoff: null,
    promptedDecision: null,
    promptedRecovery: null,
    updatedAt: NOW,
    items: [],
    ...over,
  };
}

function shipInput(over: Partial<Parameters<typeof decideShipShepherd>[0]> = {}) {
  return {
    session: shipSession(),
    queue: shipQueue(),
    episodeKey: "intent:1:1",
    humanOwnsSession: false,
    workflowOwnsSession: false,
    hasTaskOwnedOpenPr: false,
    diffHasChanges: false,
    featureEnabled: true,
    mayActLive: true,
    recoveryMinutes: 20,
    now: NOW,
    ...over,
  };
}

function shipDecision(
  outcome: PromptedCompletionDecision["outcome"],
  generation = 1,
): PromptedCompletionDecision {
  return {
    logicalKey: NOTE_KEY,
    generation,
    episodeKey: "intent:1:1",
    outcome,
    summary: outcome === "held" ? "A focused test is still missing." : "",
    gaps: outcome === "held"
      ? [{ id: "test-gap", path: "test/widget.test.ts", detail: "Cover the retry branch." }]
      : [],
    ...(outcome === "held" ? { heldRound: generation } : {}),
    decidedAt: NOW - 25 * 60_000,
  };
}

/** The payload one shepherd decision would have typed, or a hard failure if it typed none. */
function shipPayload(over: Partial<Parameters<typeof decideShipShepherd>[0]>): string {
  const decided = decideShipShepherd(shipInput(over));
  assert.equal(decided.kind, "recover", "the fixture should reach a recovery decision");
  const payload = decided.kind === "recover" ? decided.payload : null;
  assert.ok(payload, "the fixture should reach a STRUCTURAL recovery, which types a payload");
  return payload;
}

/**
 * The minimum a repair packet needs to render its opening line.
 *
 * Cast rather than fully built: the renderer reads `run.id`, `version.version`, the graph's
 * nodes and the submission's context, and a faithful hundred-line `WorkflowRun` here would
 * say nothing this file is about.
 */
const repairContext: WorkflowContextSnapshot = {
  primaryGoal: { rawPrompt: "Make the pipeline strip scrollable", refined: null, sourceNoteKey: "note" },
  humanDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "abc",
    diffFingerprint: "fingerprint",
    diff: "",
    diffTruncated: false,
    workingTreeDirty: false,
    workingTreeStatus: [],
    workingTreeStatusTruncated: false,
    transcript: [],
    transcriptAnchor: 12,
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
};

const emptyReadiness: WorkflowEvidenceReadinessResult = {
  evaluatorVersion: "criterion_mapped_v1",
  status: "gaps",
  criteria: [
    {
      criterionId: "criterion-1",
      criterion: "The strip scrolls",
      material: true,
      matchedClientCriterionId: null,
      authorProofClass: null,
      suggestedProofClass: null,
      links: [],
      gaps: ["missing_deliverable_or_rendered_output"],
      warnings: [],
    },
  ],
  gapCodes: ["missing_deliverable_or_rendered_output"],
  warningCodes: [],
  unavailableReason: null,
};

/**
 * Every payload shape the daemon composes, built by the code that composes it.
 *
 * Shared by the classification test below and by the overlap test's reachability check, which
 * has to reason about the same set rather than a second list that could drift from it.
 */
function automationPayloads(): Array<{ label: string; text: string }> {
  return [
    {
      label: "ship shepherd: a completion-review gap packet",
      text: shipPayload({
        queue: shipQueue({ promptedDecision: shipDecision("held") }),
        diffHasChanges: true,
      }),
    },
    {
      label: "ship shepherd: an idle ship task with an empty checkout",
      text: shipPayload({}),
    },
    {
      label: "ship shepherd: a Straight-to-PR handoff with no pull request",
      text: shipPayload({
        session: shipSession({
          workCycle: {
            logicalKey: NOTE_KEY,
            generation: 2,
            active: false,
            completedAt: NOW - 21 * 60_000,
            updatedAt: NOW - 21 * 60_000,
          },
        }),
        queue: shipQueue({
          promptedConsumedGeneration: 1,
          promptedDecision: shipDecision("direct_handoff", 1),
        }),
      }),
    },
    {
      label: "review follow-up: an unanswered Inspector review",
      text: buildPayload(
        {
          prKey: "owner/repo#7",
          url: "https://github.com/owner/repo/pull/7",
          number: 7,
          repoRoot: null,
          inspector: null,
          checks: null,
        },
        // `Feedback` is module-private, and the payload it selects is the same shape either
        // way: this asks for the CI half, which every follow-up nudge can carry.
        { findings: false, ciFailing: true } as Parameters<typeof buildPayload>[1],
      ),
    },
    {
      label: "workflow: a repair packet",
      text: renderWorkflowFeedback({
        workflowName: "No Mistakes",
        version: {
          version: 3,
          graph: { nodes: [], edges: [] },
        } as unknown as WorkflowVersion,
        run: { id: "run-1" } as unknown as WorkflowRun,
        submission: {
          round: 2,
          evidenceFingerprint: "fingerprint",
          context: repairContext,
        } as unknown as WorkflowSubmission,
        attempts: [],
      }).payload,
    },
    {
      label: "workflow: an evidence-preflight packet",
      text: renderEvidenceReadinessPacket({
        workflowName: "No Mistakes",
        workflowVersion: 3,
        runId: "run-1",
        repository: "owner/repo",
        round: 2,
        segment: 0,
        readiness: emptyReadiness,
        workflowEvidence: true,
      }).payload,
    },
    { label: "sdk: a restart continuation", text: RESTART_CONTINUATION_PROMPT },
    { label: "foreman: the wrap-up instruction", text: WRAPUP_PR },
  ];
}

test("every payload Mission Control types itself classifies as automation", () => {
  for (const { label, text } of automationPayloads()) {
    const verdict = classify(text);
    assert.equal(verdict.verdict, "automation", `${label} must classify as automation`);
    assert.ok(
      verdict.signals.includes("automation"),
      `${label} must report the automation signal it matched`,
    );
    assert.match(verdict.reason, /Mission Control types itself/, `${label} must say why`);
  }
});

/**
 * The false positive an over-broad signature bought, and the shape that removes it.
 *
 * The follow-through packet is the one payload with no fixed opening - it names its pull
 * request first - and the first signature for it matched the floating substring
 * " needs follow-through: ". That phrase is also ordinary English, so a human writing "This
 * task needs follow-through: finish the tests" had their run recorded and displayed as
 * machine-authored. A verdict an operator reads has to be wrong rarely enough to be worth
 * reading, so the signature is now the anchored SHAPE of the packet's opening.
 *
 * These are human sentences that must stay `objective`. Each one contains the phrase.
 */
test("a human sentence that merely contains the daemon's words is not automation", () => {
  const humanAsks = [
    "This task needs follow-through: finish the tests and update the docs before shipping.",
    "The migration needs follow-through: three call sites still read the old column.",
    "Everything here needs follow-through: pick up wherever the last session stopped.",
    // The packet's own ref spelling, in the middle of a human sentence rather than opening it.
    "Check whether PR #7 needs follow-through: I think its CI went red overnight.",
  ];
  for (const ask of humanAsks) {
    const verdict = classify(ask);
    assert.equal(verdict.verdict, "objective", `"${ask}" must not read as machine-authored`);
    assert.deepEqual(verdict.signals, []);
  }

  // Both refs the composer can produce still match, so narrowing the signature did not cost it
  // the payload it is for. `buildPayload` has exactly these two spellings and no others.
  for (const pr of [
    { prKey: "owner/repo#7", url: "u", number: 7, repoRoot: null, inspector: null, checks: null },
    { prKey: "owner/repo", url: "u", number: null, repoRoot: null, inspector: null, checks: null },
  ]) {
    const payload = buildPayload(pr, { findings: false, ciFailing: true } as Parameters<typeof buildPayload>[1]);
    assert.equal(classify(payload).verdict, "automation", `${payload.slice(0, 40)} must match`);
  }

  // And the structure is required, not just the opening words: the packet's numbered step list
  // is what tells its first line apart from a person who happens to start a sentence that way.
  assert.equal(
    classify("PR #7 needs follow-through: I will get to it tomorrow, once the release is out.")
      .verdict,
    "objective",
  );
});

/**
 * A frozen ask is stored through `clampPrompt`, which keeps the head and elides the middle.
 * Every signature but one is anchored at the opening for exactly this reason, and a repair
 * packet is routinely longer than the 4,000-character cap - so a signature that only matched
 * the unclamped text would pass the test above and never fire in production.
 */
test("a clamped automated payload is still recognised", () => {
  const packet = renderWorkflowFeedback({
    workflowName: "No Mistakes",
    version: { version: 3, graph: { nodes: [], edges: [] } } as unknown as WorkflowVersion,
    run: { id: "run-1" } as unknown as WorkflowRun,
    submission: {
      round: 2,
      evidenceFingerprint: "fingerprint",
      context: repairContext,
    } as unknown as WorkflowSubmission,
    attempts: [],
  }).payload;
  const clamped = `${packet.slice(0, 3_000)} […] ${packet.slice(-1_000)}`;
  assert.equal(classify(clamped).verdict, "automation");
});

// ---------------------------------------------------------------------------------------
// The contract: the floor, the revision check, precedence, and the reason.
// ---------------------------------------------------------------------------------------

test("a real objective trips nothing, whatever else is true of the session", () => {
  const objective = classifyWorkflowGoalProvenance({
    rawGoal: "Make the workflow run review the session's durable objective rather than its"
      + " latest prompt, and show which ask it froze.",
    intentSource: {
      objectiveVersion: 2,
      promptRevision: 3,
      resolvedPromptRevision: 3,
      relationship: "steer",
    },
    now: NOW,
  });
  assert.deepEqual(
    { verdict: objective.verdict, signals: objective.signals },
    { verdict: "objective", signals: [] },
  );
  assert.equal(objective.classifiedAt, NOW);
  assert.match(objective.reason, /durable objective/);
});

test("steering that never was a contract reads as implausible, and a terse real ask does not", () => {
  for (const steering of ["continue", "create pr", "you still working?", "go on"]) {
    const verdict = classify(steering);
    assert.equal(verdict.verdict, "implausible", `${steering} must classify as implausible`);
    assert.deepEqual(verdict.signals, ["implausible"]);
    assert.match(verdict.reason, new RegExp(`${steering.length} character`));
  }

  // Exactly at the floor, and a complete ask: a subject and a state of doneness. The floor is
  // inclusive of this, so a check tightened by one character fails here rather than silently
  // starting to flag real work.
  const terse = "Fix the flaky login test";
  assert.equal(terse.length, WORKFLOW_GOAL_OBJECTIVE_FLOOR);
  assert.equal(classify(terse).verdict, "objective");

  // Whitespace does not buy an instruction its way over the floor.
  assert.equal(classify("      continue\n\n   ").verdict, "implausible");
});

test("an ask frozen ahead of the refiner reads as unreconciled", () => {
  const source = {
    objectiveVersion: 2,
    promptRevision: 4,
    resolvedPromptRevision: 3,
    relationship: null,
  };
  const verdict = classifyWorkflowGoalProvenance({
    rawGoal: "Give the pipeline strip a visible scrollbar on every platform",
    intentSource: source,
    now: NOW,
  });
  assert.equal(verdict.verdict, "unreconciled");
  assert.deepEqual(verdict.signals, ["unreconciled"]);
  assert.match(verdict.reason, /revision 4 while the goal refiner had reconciled only up to revision 3/);

  // The state EVERY session is in on its first turn, and the false positive that would have
  // put a badge on every freshly dispatched run: the opening ask becomes the objective without
  // the refiner's help, so revision 1 above a resolved revision of 0 is nothing to report.
  assert.equal(
    classifyWorkflowGoalProvenance({
      rawGoal: "Give the pipeline strip a visible scrollbar on every platform",
      intentSource: {
        objectiveVersion: 1,
        promptRevision: 1,
        resolvedPromptRevision: 0,
        relationship: null,
      },
      now: NOW,
    }).verdict,
    "objective",
  );

  // A SECOND instruction accepted before the refiner has classified anything is the real
  // thing: the objective is still the opening ask, and revision 2 may be about to replace it.
  assert.equal(
    classifyWorkflowGoalProvenance({
      rawGoal: "Give the pipeline strip a visible scrollbar on every platform",
      intentSource: {
        objectiveVersion: 1,
        promptRevision: 2,
        resolvedPromptRevision: 0,
        relationship: null,
      },
      now: NOW,
    }).verdict,
    "unreconciled",
  );

  // Reconciled is reconciled, whatever the refiner decided the newest instruction MEANT. An
  // `unclear` classification is a resolved revision; it is a different complaint from this one
  // and belongs to the goal pipeline rather than to this instrument.
  assert.equal(
    classifyWorkflowGoalProvenance({
      rawGoal: "Give the pipeline strip a visible scrollbar on every platform",
      intentSource: { ...source, promptRevision: 3, relationship: "unclear" },
      now: NOW,
    }).verdict,
    "objective",
  );

  // A snapshot with no provenance beside it cannot answer this question, and does not guess.
  assert.equal(
    classifyWorkflowGoalProvenance({
      rawGoal: "Give the pipeline strip a visible scrollbar on every platform",
      intentSource: null,
      now: NOW,
    }).verdict,
    "objective",
  );
});

/**
 * The checks overlap, so precedence is part of the contract rather than a consequence of the
 * order they happen to run in. `automation` wins because it is the actionable fact: text this
 * daemon typed is never a completion contract, whatever else is true of it.
 */
test("overlapping checks resolve by precedence and report every match", () => {
  // Automation AND implausible: a wrap-up payload short enough to be under the floor is not
  // reachable, so this uses the shortest signature there is - the readiness packet's heading.
  const shortAutomated = "# Evidence preflight needs repair";
  assert.ok(shortAutomated.length > WORKFLOW_GOAL_OBJECTIVE_FLOOR);
  const both = classifyWorkflowGoalProvenance({
    rawGoal: "# Evidence preflight needs repair".slice(0, 20),
    intentSource: null,
    now: NOW,
  });
  assert.equal(both.verdict, "implausible", "a truncated heading is no longer that payload");

  // A genuine two-signal overlap: the daemon's own prose, frozen at an unreconciled revision.
  const automatedAndUnreconciled = classifyWorkflowGoalProvenance({
    rawGoal: RESTART_CONTINUATION_PROMPT,
    intentSource: {
      objectiveVersion: 1,
      promptRevision: 5,
      resolvedPromptRevision: 2,
      relationship: null,
    },
    now: NOW,
  });
  assert.equal(automatedAndUnreconciled.verdict, "automation");
  assert.deepEqual(automatedAndUnreconciled.signals, ["automation", "unreconciled"]);
  assert.match(automatedAndUnreconciled.reason, /Mission Control types itself/);
  assert.match(automatedAndUnreconciled.reason, /revision 5/);

  // The same two signals reached through a RETIRED spelling, which is the append-only rule
  // doing its job: this wrap-up wording is one the daemon no longer sends, and a frozen ask
  // outlives the build that sent it.
  const retired = classifyWorkflowGoalProvenance({
    rawGoal: "Please commit this work, push the branch, and open a PR.",
    intentSource: {
      objectiveVersion: 1,
      promptRevision: 9,
      resolvedPromptRevision: 8,
      relationship: null,
    },
    now: NOW,
  });
  assert.equal(retired.verdict, "automation", "a retired wrap-up spelling stays recognised");
  assert.deepEqual(retired.signals, ["automation", "unreconciled"]);

  /*
   * There is no three-signal case, and that is a property of the payloads rather than of this
   * test: `automation` and `implausible` cannot co-occur, because nothing the daemon types is
   * shorter than a completion contract needs to be.
   *
   * Asserted rather than asserted-in-prose. An earlier version of this test claimed to build
   * "all three at once" and then asserted two, which is exactly the drift a comment cannot
   * catch. If a short payload is ever appended to the signature list, this fails and says what
   * to do about it.
   */
  for (const { label, text } of automationPayloads()) {
    assert.ok(
      text.trim().length >= WORKFLOW_GOAL_OBJECTIVE_FLOOR,
      `${label} is under the implausibility floor, so automation+implausible is now reachable`
        + " and this test owes a three-signal case",
    );
  }

  // Precedence never reorders: the verdict is always the first signal reported.
  for (const verdict of [both, automatedAndUnreconciled, retired]) {
    assert.equal(verdict.verdict, verdict.signals[0] ?? "objective");
  }
});

/**
 * The persisted contract, checked where it is persisted.
 *
 * `signals` is documented as every matched check in precedence order and `verdict` as the
 * first of them, so the two say one fact twice and the schema is what stops a row saying it
 * two different ways. Checking only `verdict === signals[0]` left the rest representable: a
 * row carrying `["unreconciled", "automation"]` validated and published itself as
 * authoritative provenance, leaving every later reader to guess whether the list or its order
 * was the lie.
 *
 * The classifier cannot produce any of these - it appends in precedence order by construction
 * - which is exactly why the schema is the right place for the rule. The payloads a boundary
 * has to refuse are the ones no correct writer emits.
 */
test("the persisted verdict and its signals cannot contradict each other", () => {
  const row = (verdict: string, signals: string[]) => ({
    verdict, signals, reason: "a reason", classifiedAt: 1,
  });

  // Every shape the classifier really emits parses.
  for (const [verdict, signals] of [
    ["objective", []],
    ["automation", ["automation"]],
    ["implausible", ["implausible"]],
    ["unreconciled", ["unreconciled"]],
    ["automation", ["automation", "implausible"]],
    ["automation", ["automation", "unreconciled"]],
    ["implausible", ["implausible", "unreconciled"]],
    ["automation", ["automation", "implausible", "unreconciled"]],
  ] as Array<[string, string[]]>) {
    assert.equal(
      WorkflowRunIntentProvenanceSchema.safeParse(row(verdict, signals)).success,
      true,
      `${verdict} over [${signals.join(", ")}] is a shape the classifier emits`,
    );
  }

  // Out of precedence order. The list and the verdict agree on membership and disagree on
  // which one is the answer, which is the contradiction the reader cannot resolve.
  assert.equal(
    WorkflowRunIntentProvenanceSchema.safeParse(row("unreconciled", ["unreconciled", "automation"]))
      .success,
    false,
  );
  assert.equal(
    WorkflowRunIntentProvenanceSchema.safeParse(row("implausible", ["implausible", "automation"]))
      .success,
    false,
  );
  // A repeat is caught by the same rule, because position must strictly increase.
  assert.equal(
    WorkflowRunIntentProvenanceSchema.safeParse(row("automation", ["automation", "automation"]))
      .success,
    false,
  );
  // Empty exactly for `objective`, from both directions.
  assert.equal(WorkflowRunIntentProvenanceSchema.safeParse(row("automation", [])).success, false);
  assert.equal(
    WorkflowRunIntentProvenanceSchema.safeParse(row("objective", ["automation"])).success,
    false,
  );
  // And `objective` is never a member of the list it heads.
  assert.equal(
    WorkflowRunIntentProvenanceSchema.safeParse(row("objective", ["objective"])).success,
    false,
  );

  // The message names the field a reader has to fix, not just that something is wrong.
  const failure = WorkflowRunIntentProvenanceSchema.safeParse(
    row("unreconciled", ["unreconciled", "automation"]),
  );
  assert.equal(failure.success, false);
  assert.match(
    failure.success ? "" : failure.error.message,
    /signals must be unique and in precedence order/,
  );
});

/**
 * The classifier's output is always a shape the schema accepts, for every reachable input.
 *
 * The rule above is only worth having if the one writer in the daemon cannot trip it. Rather
 * than assert that by reading the code, this runs every combination of the three checks that
 * can co-occur and parses each result.
 */
test("every verdict the classifier can produce satisfies the persisted contract", () => {
  const asks = [
    "Give the pipeline strip a visible scrollbar on every platform",
    "create pr",
    RESTART_CONTINUATION_PROMPT,
    // Automation and implausible cannot co-occur - no payload is under the floor - so the
    // reachable overlaps are automation+unreconciled and implausible+unreconciled.
    "# Evidence preflight needs repair\n\nDeclare coverage.",
  ];
  const sources = [
    null,
    { objectiveVersion: 1, promptRevision: 1, resolvedPromptRevision: 0, relationship: null },
    { objectiveVersion: 1, promptRevision: 3, resolvedPromptRevision: 1, relationship: null },
    { objectiveVersion: 2, promptRevision: 4, resolvedPromptRevision: 4, relationship: "steer" as const },
  ];
  for (const rawGoal of asks) {
    for (const intentSource of sources) {
      const provenance = classifyWorkflowGoalProvenance({ rawGoal, intentSource, now: NOW });
      const parsed = WorkflowRunIntentProvenanceSchema.safeParse(provenance);
      assert.equal(
        parsed.success,
        true,
        `${provenance.verdict} over [${provenance.signals.join(", ")}] must persist`,
      );
    }
  }
});
