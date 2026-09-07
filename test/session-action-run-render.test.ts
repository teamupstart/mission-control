import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SESSION_ACTION_BLOCK_CODES,
  SESSION_ACTION_WAIT_REASONS,
  sessionActionCompletionLabel,
} from "../src/shared/workflow.ts";
import type {
  SessionActionAttemptState,
  SessionActionWaitReason,
  WorkflowNodeAttempt,
  WorkflowRunDetail,
  WorkflowSubmission,
  WorkflowVersion,
} from "../src/shared/workflow.ts";
import { RunPipeline } from "../src/web/workflows/RunPipeline.tsx";
import { InspectorFooter } from "../src/web/workflows/pipeline-bits.tsx";
import {
  actionBlockSentence,
  actionWaitSentence,
  continuationSourceAttempt,
  nodeStatusesForSubmission,
  runRounds,
  evidenceChipLabel,
  roundEvidenceCountLabel,
  runRoundGroups,
  segmentProvenanceSentence,
  provenPullRequest,
  sessionActionProgress,
  sessionActionStateOf,
  sessionActionStatus,
} from "../src/web/workflows/run-model.ts";

/**
 * What is at stake: a session action is the first stage that produces no verdict, and every
 * run surface here already knew how to draw exactly two things - a reviewer and a check. The
 * failure this file exists to prevent is the quiet one: an action reusing a reviewer's chip
 * table and reading "Passed", which tells an operator the action judged the work when all it
 * did was finish a turn.
 *
 * The second half is evidence identity. A repair round now holds several submissions, and the
 * difference between "you owe a repair" and "the action captured new evidence for free" is
 * the whole reason the segment model exists.
 */

const SESSION = "s-node";
const ACTION = "a-node";
const REVIEWER = "p-node";
const END = "e-node";

const version = (policy: WorkflowVersion["completionPolicy"] = { kind: "none" }): WorkflowVersion => ({
  id: "v1",
  workflowId: "w1",
  version: 1,
  sourceDraftRevision: 1,
  graph: {
    nodes: [
      { id: SESSION, kind: "session", position: { x: 0, y: 0 } },
      {
        id: ACTION,
        kind: "session_action",
        position: { x: 200, y: 0 },
        action: {
          sourceSessionActionId: "act-1",
          sourceRevision: 3,
          name: "Tidy the workspace",
          description: "Remove the scratch files",
          promptMarkdown: "# Tidy\n\nRemove the scratch files.\n",
          requiredSkillId: null,
          completion: { kind: "session_turn" },
        },
      },
      {
        id: REVIEWER,
        kind: "persona",
        position: { x: 400, y: 0 },
        persona: {
          sourcePersonaId: "per-1",
          sourceRevision: 1,
          name: "Code Risk Reviewer",
          description: "",
          guidanceMarkdown: "# Judge\n",
          runner: null,
          model: null,
        },
      },
      { id: END, kind: "end", outcome: "Approved", position: { x: 600, y: 0 } },
    ],
    edges: [
      { id: "e1", source: SESSION, sourcePort: "submitted", target: ACTION, targetPort: "activate" },
      { id: "e2", source: ACTION, sourcePort: "complete", target: REVIEWER, targetPort: "activate" },
      { id: "e3", source: REVIEWER, sourcePort: "pass", target: END, targetPort: "terminal" },
      { id: "e4", source: REVIEWER, sourcePort: "fail", target: SESSION, targetPort: "return_for_changes" },
    ],
  },
  completionPolicy: policy,
  resumptionPolicy: "auto",
  evidenceReadinessPolicy: "off",
  bindingDefaults: { triggerMode: "manual", deliveryMode: "live", maxRepairRounds: 5 },
  publishedAt: 1,
});

const actionState = (patch: Partial<SessionActionAttemptState> = {}): SessionActionAttemptState => ({
  wait: "working",
  deliveryId: "d1",
  anchor: {
    deliveryId: "d1",
    sessionId: "sess",
    noteKey: "note",
    deliveredAt: 1_700_000_000_000,
    transcriptBytes: 42,
  },
  pickedUpAt: 1_700_000_001_000,
  settledAt: null,
  expectation: null,
  continuationSubmissionId: null,
  blocked: null,
  ...patch,
});

const submission = (patch: Partial<WorkflowSubmission>): WorkflowSubmission => ({
  id: "sub-0",
  runId: "run-1",
  round: 1,
  segment: 0,
  parentSubmissionId: null,
  continuationNodeId: null,
  continuationNodeAttemptId: null,
  mode: "full_workflow",
  status: "running",
  context: null,
  evidence: null,
  headSha: null,
  prHeadSha: null,
  createdAt: 1,
  ...patch,
} as WorkflowSubmission);

const attempt = (patch: Partial<WorkflowNodeAttempt>): WorkflowNodeAttempt => ({
  id: "att-1",
  runId: "run-1",
  submissionId: "sub-0",
  nodeId: ACTION,
  attempt: 1,
  state: "waiting",
  runner: null,
  model: null,
  verdict: null,
  persona: null,
  sessionAction: null,
  output: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  createdAt: 1,
  ...patch,
} as WorkflowNodeAttempt);

const detail = (patch: Partial<WorkflowRunDetail>): WorkflowRunDetail => ({
  summary: {} as WorkflowRunDetail["summary"],
  binding: null,
  version: version(),
  run: {} as WorkflowRunDetail["run"],
  contextState: "captured",
  submissions: [],
  attempts: [],
  receipts: [],
  deliveries: [],
  events: [],
  inspectorGate: null,
  ...patch,
} as WorkflowRunDetail);

test("every wait reason and every block code has a sentence, and none of them is a verdict", () => {
  // The exhaustiveness the `Record` types already force at compile time, restated as a run so
  // a build that widened one of the tuples cannot ship a blank sentence.
  for (const reason of SESSION_ACTION_WAIT_REASONS) {
    const sentence = actionWaitSentence(reason);
    assert.ok(sentence.length > 0, `${reason} has no sentence`);
    assert.doesNotMatch(sentence, /\bpassed\b|\bfailed\b|\bverdict\b|changes requested/i);
  }
  for (const code of SESSION_ACTION_BLOCK_CODES) {
    const sentence = actionBlockSentence(code);
    assert.ok(sentence.length > 0, `${code} has no sentence`);
    // A block is a DELIVERY or infrastructure problem. Wording it as a judgement would tell
    // an operator the session did the work badly when it may never have received the work.
    assert.doesNotMatch(sentence, /\bpassed\b|\bfailed review\b|\bverdict\b|changes requested/i);
  }
});

test("an action's chip reports a lifecycle, never an outcome", () => {
  // The wait wins over the attempt state: `waiting` alone says "the observer owns this" and
  // nothing about how far the turn has got.
  const labels = SESSION_ACTION_WAIT_REASONS.map((reason) =>
    sessionActionStatus("waiting", reason).label);
  assert.deepEqual(new Set(labels).size, labels.length, "each wait reads differently");
  for (const label of labels) {
    assert.doesNotMatch(label, /^Passed$|^Failed$|Changes requested/);
  }
  // The one moment worth pinning: an adapter that has decided is still not done, because the
  // downstream evidence does not exist yet.
  assert.deepEqual(
    sessionActionStatus("waiting", "capturing"),
    { tone: "running", label: "Capturing evidence" },
  );
  // A finished action is Complete, not Passed: it ran, and running is all it ever claims.
  assert.deepEqual(sessionActionStatus("completed"), { tone: "passed", label: "Complete" });
  assert.deepEqual(sessionActionStatus(undefined), { tone: "waiting", label: "Not started" });
  // A `waiting` attempt whose durable state this build cannot read is honest rather than
  // guessed at - the summary cannot reconstruct a transcript byte offset.
  assert.deepEqual(sessionActionStatus("waiting"), { tone: "waiting", label: "Waiting" });
  assert.deepEqual(sessionActionStatus("error"), { tone: "failed", label: "Could not run" });
});

test("a waiting action's durable state is parsed, and an unreadable one is absent not fatal", () => {
  const good = attempt({ output: actionState() as unknown as WorkflowNodeAttempt["output"] });
  assert.equal(sessionActionStateOf(good)?.wait, "working");
  // `output_json` may be written by a daemon older or newer than this browser, and the render
  // walks into `blocked.code`. An unreadable shape reads as absent, which every caller draws.
  assert.equal(sessionActionStateOf(attempt({ output: { wait: "nonsense" } })), null);
  assert.equal(sessionActionStateOf(attempt({ output: null })), null);
  assert.equal(sessionActionStateOf(attempt({ output: "a string" })), null);
});

test("progress reads BOTH durable shapes, so nothing loses its sentence", () => {
  // The runtime writes `output_json` twice and differently, and reading only the first shape
  // is what made a finished action print the bare word "completed" and a blocked one print
  // no reason at all. Both of those are the states an operator most needs explained.
  const waiting = sessionActionProgress(
    attempt({ output: actionState() as unknown as WorkflowNodeAttempt["output"] }),
  )!;
  assert.equal(waiting.wait, "working");
  assert.equal(waiting.complete, false);
  assert.equal(waiting.anchor?.deliveredAt, 1_700_000_000_000);

  // A BLOCK is `state: "error"` carrying the same record plus its code - the surfaces that
  // gated on `state === "waiting"` could never reach it.
  const blocked = sessionActionProgress(attempt({
    state: "error",
    output: actionState({
      wait: "awaiting_pickup",
      blocked: { code: "delivery_refused", detail: "the pane refused" },
    }) as unknown as WorkflowNodeAttempt["output"],
  }))!;
  assert.equal(blocked.blocked?.code, "delivery_refused");
  // The wait is dropped once it is blocked: it is no longer waiting for anything.
  assert.equal(blocked.wait, null);
  assert.equal(actionBlockSentence(blocked.blocked!.code), actionBlockSentence("delivery_refused"));

  // COMPLETION replaces the record entirely. The three timestamps the store deliberately
  // preserves are exactly what the card's "Sent … picked up … turn finished" line needs.
  const done = sessionActionProgress(attempt({
    state: "completed",
    output: {
      outcome: "complete",
      action: "Tidy the workspace",
      completion: "session_turn",
      continuationSubmissionId: "sub-1",
      anchor: actionState().anchor,
      pickedUpAt: 1_700_000_001_000,
      settledAt: 1_700_000_002_000,
    } as unknown as WorkflowNodeAttempt["output"],
  }))!;
  assert.equal(done.complete, true);
  assert.equal(done.wait, null);
  assert.equal(done.blocked, null);
  assert.equal(done.settledAt, 1_700_000_002_000);
  assert.equal(done.anchor?.noteKey, "note");

  // And an unreadable blob is still absent rather than fatal.
  assert.equal(sessionActionProgress(attempt({ output: { outcome: "nonsense" } })), null);
  assert.equal(sessionActionProgress(attempt({ output: null })), null);
});

const PROVEN = {
  kind: "pull_request",
  pullRequestKey: "owner/repo#7",
  pullRequestUrl: "https://github.com/owner/repo/pull/7",
  pullRequestNumber: 7,
  repositoryRoot: "/repo",
  branch: "feature/x",
  expectedHeadOid: "a".repeat(40),
  acceptedContentTreeOid: "c".repeat(40),
  observedAt: 1_700_000_003_000,
} as const;

test("what a pull request action PROVED survives its completion", () => {
  // The audit question a finished action is asked afterwards is "which pull request, at which
  // commit" - and until the expectation was carried past the waiting state, a completed action
  // could answer neither. It could say only that it completed.
  const waiting = sessionActionProgress(attempt({
    output: actionState({
      wait: "awaiting_pushed_head",
      expectation: PROVEN,
    }) as unknown as WorkflowNodeAttempt["output"],
  }))!;
  assert.equal(provenPullRequest(waiting)?.pullRequestNumber, 7);

  const done = sessionActionProgress(attempt({
    state: "completed",
    output: {
      outcome: "complete",
      action: "Pull Request",
      completion: "pull_request",
      continuationSubmissionId: "sub-1",
      anchor: actionState().anchor,
      pickedUpAt: 1_700_000_001_000,
      settledAt: 1_700_000_002_000,
      expectation: PROVEN,
    } as unknown as WorkflowNodeAttempt["output"],
  }))!;
  assert.equal(done.complete, true);
  const proven = provenPullRequest(done);
  assert.equal(proven?.pullRequestUrl, "https://github.com/owner/repo/pull/7");
  assert.equal(proven?.expectedHeadOid, "a".repeat(40));
  assert.equal(proven?.branch, "feature/x");
});

test("an action that proved no pull request offers no link to one", () => {
  // A `session_turn` action constrains nothing, and a row written by an older daemon recorded
  // nothing. Both must read as "there is no pull request here" rather than as a broken link.
  const turn = sessionActionProgress(attempt({
    output: actionState({ expectation: { kind: "none" } }) as unknown as WorkflowNodeAttempt["output"],
  }))!;
  assert.equal(provenPullRequest(turn), null);

  const legacy = sessionActionProgress(attempt({
    state: "completed",
    output: {
      outcome: "complete",
      anchor: null,
    } as unknown as WorkflowNodeAttempt["output"],
  }))!;
  assert.equal(legacy.complete, true);
  assert.equal(provenPullRequest(legacy), null);
  assert.equal(provenPullRequest(null), null);
});

test("the two pull request waits explain different work, and neither is a verdict", () => {
  // They exist as separate reasons because their remedies differ: one is about the session
  // never having produced a pull request, the other about a commit not having reached one. A
  // single "Verifying" chip left an operator unable to tell those apart.
  const missing = actionWaitSentence("awaiting_pull_request");
  const behind = actionWaitSentence("awaiting_pushed_head");
  assert.notEqual(missing, behind);
  assert.match(missing, /pull request/i);
  assert.match(behind, /commit/i);
  assert.notDeepEqual(
    sessionActionStatus("waiting", "awaiting_pull_request"),
    sessionActionStatus("waiting", "awaiting_pushed_head"),
  );
  // Both are still the RUNNING tone: neither is a gate a human has to clear.
  assert.equal(sessionActionStatus("waiting", "awaiting_pull_request").tone, "running");
  assert.equal(sessionActionStatus("waiting", "awaiting_pushed_head").tone, "running");
});

test("a stray pull request reads as attention, and never as the absence of one", () => {
  // The two states that separate "the turn produced nothing yet" from "the turn produced one
  // somewhere else". They are the pair an operator most needs told apart, so they must not
  // share a sentence or a chip with `awaiting_pull_request` - which is what collapsing them
  // into it did.
  const missing = actionWaitSentence("awaiting_pull_request");
  for (const reason of ["pull_request_wrong_repository", "pull_request_wrong_branch"] as const) {
    const sentence = actionWaitSentence(reason);
    assert.notEqual(sentence, missing);
    assert.match(sentence, /pull request/i);
    // Each names its own remedy, because the two mistakes are fixed differently.
    assert.match(sentence, /reset the run/i);
    // Attention rather than "the runtime is working", and still not a failure: nothing has
    // judged the work, and a later adoption can still resolve it.
    assert.equal(sessionActionStatus("waiting", reason).tone, "waiting");
    assert.doesNotMatch(sessionActionStatus("waiting", reason).label, /^Passed$|^Failed$/);
  }
  assert.match(actionWaitSentence("pull_request_wrong_repository"), /repositor/i);
  assert.match(actionWaitSentence("pull_request_wrong_branch"), /branch/i);
  assert.notDeepEqual(
    sessionActionStatus("waiting", "pull_request_wrong_repository"),
    sessionActionStatus("waiting", "pull_request_wrong_branch"),
  );
});

test("an unknown completion kind names itself instead of taking the panel down", () => {
  // The kinds are append-only and reach the browser unvalidated over SSE, so a daemon one
  // version ahead must not turn every row that names one into a TypeError.
  const label = sessionActionCompletionLabel({ kind: "webhook" } as never);
  assert.equal(label, "webhook");
});

test("a repair round holding several segments is labelled by evidence, never as a repair", () => {
  const parent = submission({ id: "sub-0", round: 1, segment: 0, status: "completed" });
  const child = submission({
    id: "sub-1",
    round: 1,
    segment: 1,
    parentSubmissionId: "sub-0",
    continuationNodeId: ACTION,
    continuationNodeAttemptId: "att-1",
  });
  const rounds = runRounds(
    detail({ submissions: [child, parent] }),
    (nodeId) => nodeId === ACTION ? "Tidy the workspace" : null,
  );

  // Execution order, two keys deep: a continuation reserves its child inside the same
  // transaction that closes the parent's attempt, so `createdAt` alone cannot order them.
  assert.deepEqual(rounds.map((round) => round.submissionId), ["sub-0", "sub-1"]);
  assert.deepEqual(rounds.map((round) => round.label), [
    "Round 1 · evidence 1",
    "Round 1 · evidence 2",
  ]);
  assert.deepEqual(rounds.map((round) => round.round), [1, 1], "one repair round, not two");
  assert.equal(rounds[1]!.continuedFrom, "Tidy the workspace");

  const sentence = segmentProvenanceSentence(rounds[1]!)!;
  assert.match(sentence, /captured after Tidy the workspace finished/);
  assert.match(sentence, /does not spend a repair round/);
  assert.match(sentence, /only the\s+stages after it run again/);
  // Segment zero is not a continuation and gets no sentence at all.
  assert.equal(segmentProvenanceSentence(rounds[0]!), null);
});

test("a verified terminal pull request segment is shipping completion, not evidence repair", () => {
  const published = version();
  published.graph = {
    nodes: published.graph.nodes
      .filter((node) => node.id !== REVIEWER)
      .map((node) => node.id === ACTION && node.kind === "session_action"
        ? { ...node, action: { ...node.action, completion: { kind: "pull_request" as const } } }
        : node),
    edges: [
      { id: "e1", source: SESSION, sourcePort: "submitted", target: ACTION, targetPort: "activate" },
      { id: "e2", source: ACTION, sourcePort: "complete", target: END, targetPort: "terminal" },
    ],
  };
  const parent = submission({ id: "sub-0", round: 1, segment: 0, status: "completed" });
  const child = submission({
    id: "sub-1",
    round: 1,
    segment: 1,
    parentSubmissionId: parent.id,
    continuationNodeId: ACTION,
    continuationNodeAttemptId: "att-1",
    refinementReason: "session_action",
    status: "completed",
  });
  const actionNode = published.graph.nodes.find((node) => node.id === ACTION);
  if (!actionNode || actionNode.kind !== "session_action") {
    throw new Error("expected the terminal pull request action node");
  }
  const completed = attempt({
    id: "att-1",
    submissionId: parent.id,
    state: "completed",
    sessionAction: actionNode.action,
    output: {
      outcome: "complete",
      action: "Pull Request",
      completion: "pull_request",
      continuationSubmissionId: child.id,
      anchor: actionState().anchor,
      pickedUpAt: 1_700_000_001_000,
      settledAt: 1_700_000_002_000,
      expectation: PROVEN,
    } as unknown as WorkflowNodeAttempt["output"],
  });
  const rounds = runRounds(detail({ version: published, submissions: [parent, child], attempts: [completed] }));
  const shipping = rounds[1]!;
  assert.equal(shipping.verifiedShipping, true);
  assert.equal(shipping.label, "Round 1 · verified shipping");
  assert.equal(evidenceChipLabel(shipping), "verified shipping");
  assert.equal(roundEvidenceCountLabel(runRoundGroups(rounds)[0]!), "review + shipping");
  assert.match(segmentProvenanceSentence(shipping) ?? "", /reached End without another evidence review/);
});

test("the action that authorized a segment is visible WITH that segment", () => {
  // Found by driving a real run: after a continuation the newest view drew the action that
  // produced the evidence being read as "Not started", because every surface is scoped to the
  // viewed submission and the action's attempt lives on the parent. Leaving it there is
  // right - upstream work must not be relabelled as having reviewed evidence it never saw -
  // so the fix is one deliberate cross-submission read of provenance the runtime wrote.
  const parent = submission({ id: "sub-0", round: 1, segment: 0, status: "completed" });
  const child = submission({
    id: "sub-1",
    round: 1,
    segment: 1,
    parentSubmissionId: "sub-0",
    continuationNodeId: ACTION,
    continuationNodeAttemptId: "att-1",
  });
  const done = attempt({ id: "att-1", submissionId: "sub-0", state: "completed" });
  const run = detail({ submissions: [parent, child], attempts: [done] });

  assert.equal(nodeStatusesForSubmission(run, "sub-1")[ACTION], "completed");
  assert.equal(continuationSourceAttempt(run, "sub-1")?.id, "att-1");
  // Segment zero has no source, and its own attempt is found the ordinary way.
  assert.equal(continuationSourceAttempt(run, "sub-0"), null);
  assert.equal(nodeStatusesForSubmission(run, "sub-0")[ACTION], "completed");

  // Both halves of the link are checked, so a corrupt row cannot pull an unrelated node in.
  const wrongNode = detail({
    submissions: [parent, { ...child, continuationNodeId: REVIEWER }],
    attempts: [done],
  });
  assert.equal(continuationSourceAttempt(wrongNode, "sub-1"), null);
  const wrongParent = detail({
    submissions: [parent, child],
    attempts: [{ ...done, submissionId: "somewhere-else" }],
  });
  assert.equal(continuationSourceAttempt(wrongParent, "sub-1"), null);

  // And a real attempt in the viewed segment always wins: the carried-over one only fills a
  // gap, so a re-run action in a later segment reports its own state.
  const rerun = detail({
    submissions: [parent, child],
    attempts: [done, attempt({ id: "att-2", submissionId: "sub-1", state: "waiting" })],
  });
  assert.equal(nodeStatusesForSubmission(rerun, "sub-1")[ACTION], "waiting");
});

test("an ordinary run says Round 1 and nothing about evidence", () => {
  // The suffix is spent only where a distinction is being drawn. Stamping "evidence 1" on
  // every run would cost the reader's attention for nothing.
  const rounds = runRounds(detail({ submissions: [submission({ id: "only", round: 1 })] }));
  assert.deepEqual(rounds.map((round) => round.label), ["Round 1"]);
  assert.equal(rounds[0]!.segment, 0);
  assert.equal(rounds[0]!.continuedFrom, null);
});

const runPipelineMarkup = (
  waits: Record<string, SessionActionWaitReason | null>,
  statuses: Record<string, string>,
  extra: Partial<Parameters<typeof RunPipeline>[0]> = {},
): string =>
  renderToStaticMarkup(createElement(RunPipeline, {
    version: version(),
    statuses,
    session: { tone: "running", label: "Under review" },
    end: { tone: "waiting", label: "Not reached" },
    metaFor: () => null,
    actionWaitFor: (nodeId) => waits[nodeId] ?? null,
    repair: null,
    ...extra,
  }));

test("the run pipeline draws an action's wait, and never routes it through an evaluator", () => {
  const html = runPipelineMarkup({ [ACTION]: "awaiting_pickup" }, {
    [ACTION]: "waiting",
    [REVIEWER]: "queued",
  });
  assert.match(html, /Tidy the workspace/);
  assert.match(html, /Session action/, "the badge separates it from the reviewer beside it");
  assert.match(html, />Sent</, "the chip is the wait, not the attempt state");
  // The reviewer downstream is untouched by any of this.
  assert.match(html, /Code Risk Reviewer/);
  assert.match(html, /Queued/);
  // The seam after an action is `complete`, and the stage says why that matters.
  assert.match(html, /complete/);
  assert.match(html, /later stages review new evidence/);
});

test("a completed action reads Complete, and the stage does not claim the wave passed", () => {
  const html = runPipelineMarkup({}, { [ACTION]: "completed" });
  assert.match(html, />Complete</);
  // The stage fold treats it as a satisfied member, which is right - but the MEMBER chip is
  // the thing an operator reads, and it must never be "Passed".
  assert.doesNotMatch(html, /Tidy the workspace<\/span>[\s\S]{0,200}?>Passed</);
});

test("a completed action does not advertise Review worklist detail it cannot own", () => {
  const html = runPipelineMarkup({}, { [ACTION]: "completed" }, {
    onOpenNode: () => undefined,
    onOpenStage: () => undefined,
  });
  assert.doesNotMatch(html, /Press Enter to load this stage/);
});

test("the Inspector footer follows End, is marked fixed, and vanishes without the policy", () => {
  const withGate = runPipelineMarkup({}, {}, {
    version: version({ kind: "inspector", onFindings: "restart_workflow", missingPrAction: "wait" }),
    inspectorStatus: { tone: "waiting", label: "Waiting for GitHub Inspector" },
    inspectorDetail: "GitHub Inspector has the pull request and has not finished reviewing it.",
  });
  // Ordering is the claim: End is graph success and Inspector claims it AFTERWARDS. A footer
  // above End would say the two happen the other way round.
  const endAt = withGate.indexOf("Terminal outcome");
  const footerAt = withGate.indexOf("GitHub Inspector, the fixed completion policy after End");
  assert.ok(endAt >= 0 && footerAt > endAt, "the footer follows the End card");
  assert.match(withGate, /Fixed/);
  assert.match(withGate, /workflow succeeded/, "the seam says what has to have happened");
  assert.match(withGate, /Waiting for GitHub Inspector/);
  assert.match(withGate, /has not finished reviewing it/);

  // Immutable: no drag handle, no focus stop, no delete, no connection.
  const footer = withGate.slice(footerAt - 400);
  assert.doesNotMatch(footer, /draggable="true"/);
  assert.doesNotMatch(footer, /data-focus-key/);
  assert.doesNotMatch(footer, /Delete|Remove/);

  // And the whole visibility contract: no policy, no footer.
  const none = runPipelineMarkup({}, {});
  assert.doesNotMatch(none, /the fixed completion policy after End/);
});

test("the footer is the projection, so it is unconditional at every call site", () => {
  // Rendered directly with a `none` policy: the component answers null rather than making
  // each of the four surfaces remember to ask first.
  assert.equal(
    renderToStaticMarkup(createElement(InspectorFooter, { policy: { kind: "none" } })),
    "",
  );
});
