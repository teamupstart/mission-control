/**
 * What is at stake: a run has to stay watchable, and it has to stay watchable in NAMES.
 *
 * The runs monitor was rebuilt around the pipeline its author drew. Two things can go
 * wrong in a rebuild like that and neither throws: an affordance the old reader exposed
 * quietly disappears (there is no other way to resolve an uncertain delivery, or to restart
 * an Inspector-only repair), or a node id leaks back into the markup and the surface is the
 * UUID wall it replaced. So this file pins the whole affordance inventory against the
 * fixtures that enable each one, and scans every rendering for the graph's own identities.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type {
  PersonaSnapshot,
  WorkflowBinding,
  WorkflowNodeAttempt,
  WorkflowJson,
  WorkflowRunDetail,
  WorkflowSubmission,
  WorkflowVersion,
} from "../src/shared/workflow.ts";
import { RunPipeline } from "../src/web/workflows/RunPipeline.tsx";
import { PersonaDirectiveEditor } from "../src/web/workflows/PersonaDirectiveEditor.tsx";
import { WorkflowRunView, WorkflowRunsEmpty } from "../src/web/workflows/WorkflowRuns.tsx";
import {
  inspectorOnlySkipStatus,
  workflowRunLoadError,
} from "../src/web/workflows/run-model.ts";
import { WorkflowApiError } from "../src/web/workflows/workflowApi.ts";
import { workflowBindingSelection } from "../src/web/workflows/WorkflowBindingDialog.tsx";
import type { Session } from "../src/shared/types.ts";
import { hasTooltip, tooltipLabels } from "./helpers/markup.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

/**
 * Graph identities are real UUIDs on purpose: the leak this file guards against is a node
 * or edge id reaching the screen, and an id spelled "persona" would render harmlessly and
 * prove nothing. Every other durable id in the fixture is a short word, so the scan below
 * can tell "the graph leaked" from "the run id is in an export link", which it is meant
 * to be.
 */
const NODE = {
  session: "8a1f0b4e-1111-4000-8000-000000000001",
  quality: "8a1f0b4e-1111-4000-8000-000000000002",
  security: "8a1f0b4e-1111-4000-8000-000000000003",
  join: "8a1f0b4e-1111-4000-8000-000000000004",
  docs: "8a1f0b4e-1111-4000-8000-000000000005",
  end: "8a1f0b4e-1111-4000-8000-000000000006",
};
const EDGE = {
  submitQuality: "8a1f0b4e-2222-4000-8000-000000000001",
  submitSecurity: "8a1f0b4e-2222-4000-8000-000000000002",
  qualityPass: "8a1f0b4e-2222-4000-8000-000000000003",
  qualityFail: "8a1f0b4e-2222-4000-8000-000000000004",
  securityPass: "8a1f0b4e-2222-4000-8000-000000000005",
  securityFail: "8a1f0b4e-2222-4000-8000-000000000006",
  joinFail: "8a1f0b4e-2222-4000-8000-000000000007",
  joinPass: "8a1f0b4e-2222-4000-8000-000000000008",
  docsFail: "8a1f0b4e-2222-4000-8000-000000000009",
  docsPass: "8a1f0b4e-2222-4000-8000-00000000000b",
};

const snapshot = (id: string, name: string): PersonaSnapshot => ({
  sourcePersonaId: id,
  sourceRevision: 3,
  name,
  description: "",
  guidanceMarkdown: "Review",
  runner: null,
  model: null,
});

/** Session -> (Quality and Security, all-pass) -> Documentation -> End. Stage-expressible. */
const version: WorkflowVersion = {
  id: "version",
  workflowId: "workflow",
  version: 2,
  sourceDraftRevision: 4,
  graph: {
    nodes: [
      { id: NODE.session, kind: "session", position: { x: 60, y: 60 } },
      {
        id: NODE.quality,
        kind: "persona",
        position: { x: 340, y: 60 },
        persona: snapshot("p-quality", "Quality reviewer"),
      },
      {
        id: NODE.security,
        kind: "persona",
        position: { x: 340, y: 230 },
        persona: snapshot("p-security", "Security reviewer"),
      },
      { id: NODE.join, kind: "all_pass", position: { x: 620, y: 145 } },
      {
        id: NODE.docs,
        kind: "persona",
        position: { x: 900, y: 60 },
        persona: snapshot("p-docs", "Documentation steward"),
      },
      { id: NODE.end, kind: "end", outcome: "Approved", position: { x: 1180, y: 60 } },
    ],
    edges: [
      { id: EDGE.submitQuality, source: NODE.session, sourcePort: "submitted", target: NODE.quality, targetPort: "activate" },
      { id: EDGE.submitSecurity, source: NODE.session, sourcePort: "submitted", target: NODE.security, targetPort: "activate" },
      { id: EDGE.qualityPass, source: NODE.quality, sourcePort: "pass", target: NODE.join, targetPort: "result" },
      { id: EDGE.qualityFail, source: NODE.quality, sourcePort: "fail", target: NODE.join, targetPort: "result" },
      { id: EDGE.securityPass, source: NODE.security, sourcePort: "pass", target: NODE.join, targetPort: "result" },
      { id: EDGE.securityFail, source: NODE.security, sourcePort: "fail", target: NODE.join, targetPort: "result" },
      { id: EDGE.joinFail, source: NODE.join, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
      { id: EDGE.joinPass, source: NODE.join, sourcePort: "pass", target: NODE.docs, targetPort: "activate" },
      { id: EDGE.docsFail, source: NODE.docs, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
      { id: EDGE.docsPass, source: NODE.docs, sourcePort: "pass", target: NODE.end, targetPort: "terminal" },
    ],
  },
  completionPolicy: { kind: "none" },
  resumptionPolicy: "manual",
  bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
  publishedAt: 1,
};

const binding: WorkflowBinding = {
  id: "binding",
  workflowVersionId: "version",
  noteKey: "note",
  sessionId: "session",
  sessionAgent: "claude",
  sessionName: "harness/runs-monitor",
  sessionCwd: "/repo",
  sessionRepoRoot: "/repo",
  triggerMode: "manual",
  deliveryMode: "preview",
  state: "active",
  maxRepairRounds: 5,
  createdAt: 1,
  updatedAt: 1,
};

const capturedContext = {
  primaryGoal: { rawPrompt: "RAW GOAL", refined: "Refined goal", sourceNoteKey: "note" },
  humanDecisions: [{
    decision: "Keep compatibility",
    rationale: "Customers rely on it",
    source: { kind: "review", id: "review" },
  }],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "abcdef0123456789",
    diffFingerprint: "diff",
    diff: "PATCH",
    diffTruncated: true,
    workingTreeDirty: true,
    workingTreeStatus: [" M file.ts"],
    workingTreeStatusTruncated: true,
    transcript: [],
    transcriptAnchor: 1,
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
  },
  compaction: { status: "fallback", runner: "claude", model: "cheap", error: "timeout" },
};

const submission = (
  id: string,
  round: number,
  overrides: Partial<WorkflowSubmission> = {},
): WorkflowSubmission => ({
  id,
  runId: "run",
  round,
  segment: 0,
  parentSubmissionId: null,
  continuationNodeId: null,
  continuationNodeAttemptId: null,
  mode: "full_workflow",
  triggerSource: "manual",
  triggerKey: `manual:binding:${id}`,
  evidenceFingerprint: `fingerprint-${round}`,
  context: capturedContext,
  evidence: {},
  prHeadSha: null,
  status: "completed",
  createdAt: round,
  updatedAt: round,
  completedAt: round,
  ...overrides,
});

const attempt = (
  id: string,
  submissionId: string,
  nodeId: string,
  persona: PersonaSnapshot,
  overrides: Partial<WorkflowNodeAttempt> = {},
): WorkflowNodeAttempt => ({
  id,
  submissionId,
  nodeId,
  attempt: 1,
  state: "completed",
  persona,
  sessionAction: null,
  runner: "claude",
  model: "reviewer",
  verdict: null,
  output: null,
  retryAt: null,
  inputFingerprint: "input",
  error: null,
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1000,
  finishedAt: 9000,
  ...overrides,
});

const failVerdict = {
  verdict: "fail",
  summary: "One issue remains",
  requestedChanges: [{
    title: "Fix the race",
    rationale: "Restart can duplicate work",
    evidence: [{ kind: "diff", quote: "changed line", path: "src/engine.ts", line: 42 }],
    path: "src/engine.ts",
    line: 42,
  }],
  confidence: 0.9,
};

const passVerdict = {
  verdict: "pass",
  summary: "No risk found",
  approvalDetails: {
    reason: "Every path is guarded",
    evidence: [{ kind: "diff", quote: "guard added", path: "src/gate.ts", line: 7 }],
  },
  requestedChanges: [],
  confidence: 0.8,
};

/**
 * A live run: round 1 asked for changes, round 2 is reviewing. That pair is what the round
 * scrubber exists for, and it is the shape every "is this scoped to the viewed round?"
 * assertion below needs.
 */
function runningDetail(): WorkflowRunDetail {
  const first = submission("submission-1", 1, {
    status: "waiting_for_session",
    completedAt: null,
  });
  const second = submission("submission-2", 2, { status: "running", completedAt: null });
  return {
    summary: {
      id: "run",
      bindingId: "binding",
      workflowId: "workflow",
      workflowName: "Release review",
      workflowVersion: 2,
      sessionId: "session",
      noteKey: "note",
      status: "running",
      phase: "persona_review",
      round: 2,
      maxRepairRounds: 5,
      activePersonaNames: ["Quality reviewer"],
      failedPersonaCount: 1,
      bypassedPersonaReview: false,
      gate: "none",
      gatePrNumber: null,
      gateHeadShort: null,
      reviewPosture: null,
      updatedAt: 10,
    },
    binding,
    version,
    run: {
      id: "run",
      bindingId: "binding",
      workflowVersionId: "version",
      status: "running",
      currentPhase: "persona_review",
      maxRepairRounds: 5,
      triggerSource: "manual",
      triggerKey: "manual:binding:req",
      inspectorPrKey: null,
      inspectorHeadSha: null,
      gateState: { outcome: "fail", requestedChanges: ["packet"] },
      startedAt: 1,
      updatedAt: 10,
      completedAt: null,
    },
    contextState: "captured",
    submissions: [first, second],
    attempts: [
      attempt("attempt-1", first.id, NODE.quality, snapshot("p-quality", "Quality reviewer"), {
        verdict: failVerdict,
      }),
      attempt("attempt-2", first.id, NODE.security, snapshot("p-security", "Security reviewer"), {
        verdict: passVerdict,
      }),
      attempt("attempt-3", second.id, NODE.quality, snapshot("p-quality", "Quality reviewer"), {
        state: "running",
        finishedAt: null,
      }),
      attempt("attempt-4", second.id, NODE.security, snapshot("p-security", "Security reviewer"), {
        state: "queued",
        startedAt: null,
        finishedAt: null,
      }),
    ],
    receipts: [{
      id: 1,
      submissionId: first.id,
      edgeId: EDGE.qualityFail,
      sourceAttemptId: "attempt-1",
      payload: { outcome: "fail", persona: "Quality reviewer" },
      createdAt: 2,
    }],
    deliveries: [],
    events: [
      { id: 1, runId: "run", timestamp: 1, kind: "run_created", payload: { triggerSource: "manual" } },
      {
        id: 2,
        runId: "run",
        timestamp: 2,
        kind: "persona_verdict",
        payload: {
          nodeId: NODE.quality,
          persona: "Quality reviewer",
          verdict: "fail",
          submissionId: first.id,
        },
      },
      {
        id: 3,
        runId: "run",
        timestamp: 3,
        kind: "submission_created",
        payload: { submissionId: second.id, round: 2 },
      },
    ],
    llmCalls: [{
      id: "call",
      runId: "run",
      submissionId: first.id,
      nodeAttemptId: "attempt-1",
      purpose: "persona_review",
      runner: "claude",
      model: "reviewer",
      attempt: 1,
      state: "succeeded",
      startedAt: 1000,
      finishedAt: 9000,
      durationMs: 8000,
      inputBytes: 12,
      outputBytes: 34,
      costUsd: 0.25,
      errorCode: null,
    }],
    llmCallCount: 1,
    nextLlmCallAfter: null,
    inspectorGate: null,
  } as WorkflowRunDetail;
}

const render = (
  detail: WorkflowRunDetail,
  props: Record<string, unknown> = {},
): string => renderToStaticMarkup(createElement(WorkflowRunView, {
  detail,
  onCancel: async () => {},
  ...props,
}));

/**
 * The run header alone - the identity block and both action rows.
 *
 * Scoped, because "the header offers this control" and "the page renders this control" are
 * different claims and the whole point of the audit disclosure is that it is NOT in the
 * header. Asserting on the full markup would let a control slide back into the action row
 * as long as the string appeared somewhere.
 */
const headerOf = (html: string): string => {
  const end = html.indexOf("</header>");
  assert.notEqual(end, -1, "the run view rendered no header");
  return html.slice(0, end);
};

/** Every identity the published graph carries. None of them may reach the screen. */
const GRAPH_IDS = [...Object.values(NODE), ...Object.values(EDGE)];

function assertNoGraphIds(html: string): void {
  for (const id of GRAPH_IDS) {
    assert.doesNotMatch(html, new RegExp(id), `the graph identity ${id} reached the markup`);
  }
  // Belt and braces: nothing UUID-SHAPED at all. Every other durable id in these fixtures is
  // a word, so this catches an id arriving by a route the list above does not know about.
  assert.doesNotMatch(html, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
}

test("a live run is drawn on its authored pipeline, in persona and stage names", () => {
  const html = render(runningDetail());
  // The strip, from the same leaves the editor draws: two termini, a parallel stage with its
  // all-pass gate, and a single-reviewer stage named after its own Persona.
  assert.match(html, /wf-pipeline-strip/);
  assert.match(html, /Stage 1/);
  assert.match(html, /2 reviewers · all must pass/);
  assert.match(html, /Documentation steward/);
  assert.match(html, /Quality reviewer/);
  assert.match(html, /Security reviewer/);
  assert.match(html, /all pass/);
  assert.match(html, /Approved/);
  // Per-reviewer live status on the authored shape - the headline of the phase.
  assert.match(html, /Reviewing/);
  assert.match(html, /Queued/);
  assert.match(html, /Not started/);
  assertNoGraphIds(html);
});

test("a check row and its stage use deterministic status vocabulary", () => {
  const checkVersion: WorkflowVersion = {
    ...version,
    id: "check-version",
    graph: {
      nodes: [
        { id: "check-session", kind: "session", position: { x: 0, y: 0 } },
        { id: "check-typecheck", kind: "check", slot: "typecheck", position: { x: 200, y: 0 } },
        { id: "check-end", kind: "end", outcome: "Approved", position: { x: 400, y: 0 } },
      ],
      edges: [
        {
          id: "check-submit",
          source: "check-session",
          sourcePort: "submitted",
          target: "check-typecheck",
          targetPort: "activate",
        },
        {
          id: "check-pass",
          source: "check-typecheck",
          sourcePort: "pass",
          target: "check-end",
          targetPort: "terminal",
        },
        {
          id: "check-fail",
          source: "check-typecheck",
          sourcePort: "fail",
          target: "check-session",
          targetPort: "return_for_changes",
        },
      ],
    },
  };
  const pipeline = (status: string): string => renderToStaticMarkup(createElement(RunPipeline, {
    version: checkVersion,
    statuses: { "check-typecheck": status },
    session: { tone: "running", label: "Under review" },
    end: { tone: "waiting", label: "Not reached" },
    metaFor: () => null,
    repair: null,
  }));

  const running = pipeline("running");
  assert.match(running, /Running/);
  assert.doesNotMatch(running, /Reviewing/);

  const errored = pipeline("error");
  assert.match(errored, /Check failed to run/);
  assert.doesNotMatch(errored, /Provider error/);
});

test("the round scrubber defaults to the latest round and scopes what it says", () => {
  const detail = runningDetail();
  const latest = render(detail);
  assert.match(latest, /Round 1/);
  assert.match(latest, /Round 2/);
  // Round 1 is marked as the round that asked for changes even though its submission is
  // merely `waiting_for_session` - a healthy repair loop, and exactly the round an operator
  // is looking for.
  assert.match(latest, /Changes requested/);
  // Latest round selected by default, so round 1's verdict text is not on screen.
  assert.doesNotMatch(latest, /Fix the race/);
  assert.doesNotMatch(latest, /Viewing an earlier round/);

  const earlier = render(detail, { roundId: "submission-1" });
  assert.match(earlier, /Fix the race/);
  assert.match(earlier, /Restart can duplicate work/);
  assert.match(earlier, /changed line/);
  assert.match(earlier, /No risk found/);
  assert.match(earlier, /Every path is guarded/);
  assert.match(earlier, /claude · reviewer/);
  assert.match(earlier, /Viewing an earlier round/);
  // The join packet is that round's receipts, named as its stage rather than as a node id.
  assert.match(earlier, /1 of 2 reviewers reported/);
  assertNoGraphIds(earlier);
});

test("the timeline is phrased in names, not payload JSON", () => {
  const html = render(runningDetail(), { roundId: "submission-1" });
  assert.match(html, /Run-level events/);
  assert.match(html, /Persona verdict/);
  assert.match(html, /Quality reviewer/);
  assert.match(html, /verdict fail/);
  // The old reader printed `JSON.stringify(event.payload)`, which is where most of the ids
  // on this surface came from.
  assert.doesNotMatch(html, /nodeId/);
  assertNoGraphIds(html);
});

test("a waiting run offers ONE primary move, the context controls, and cancel", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    summary: { ...base.summary, status: "waiting_for_session" },
    run: { ...base.run, status: "waiting_for_session" },
  });
  const header = headerOf(html);
  assert.match(header, /class="btn btn-primary"[^>]*>Preview fresh evidence</);
  // Exactly one primary, always. The row this replaced offered five controls of equal weight,
  // and `Preview unchanged` was one of them - a co-equal twin that only ever answers a refusal
  // which has not happened yet on a plainly waiting run.
  assert.equal((header.match(/btn-primary/g) ?? []).length, 1);
  assert.doesNotMatch(header, /Preview unchanged/);
  assert.match(header, /Copy feedback/);
  assert.match(header, /Cancel run/);
  // Nothing to explain: the move IS the explanation.
  assert.doesNotMatch(header, /wf-run-why/);
  // The four controls that answer nothing a person reading a run asked are gone from the
  // whole page under these names: three moved into the audit disclosure at its foot, and
  // Open version was absorbed by the version badge, which is now the link itself.
  for (const label of ["Copy run id", "Export run", "Export version", "Open version"]) {
    assert.doesNotMatch(html, new RegExp(label), `${label} is still rendered`);
  }
  assert.match(html, /Workflow-owned model calls/);
  assert.match(html, /harness\/runs-monitor/);
  // The captured evidence sections, with the compaction fallback named.
  assert.match(html, /RAW GOAL/);
  assert.match(html, /Keep compatibility/);
  assert.match(html, /Deterministic fallback/);
  assert.match(html, /Compaction fallback: timeout/);
  assert.match(html, /Diff<\/dt><dd>truncated/);
  assert.match(html, /status truncated/);
  assert.match(html, /Join and gate packet/);
  assertNoGraphIds(html);
});

/**
 * The audit trio, in the one place it belongs.
 *
 * The run id has no filter on this page to be pasted into and the route already carries it;
 * neither export has an importer anywhere in the product, by deliberate design. All three are
 * bug-report material, so they sit behind a disclosure beside the Timeline rather than
 * competing with Cancel run - and the disclosure says who they are for in its own summary.
 */
test("the run id and both JSON records sit in a collapsed disclosure below the timeline", () => {
  const html = render(runningDetail());
  const details = html.slice(html.indexOf("<details class=\"wf-run-audit\""));

  // Collapsed: no `open` attribute, so the rows cost a reader nothing until asked for.
  assert.match(html, /<details class="wf-run-audit">/);
  assert.doesNotMatch(html, /<details class="wf-run-audit" open/);
  assert.match(details, /Audit and bug reports/);
  // Below the Timeline, and out of the header entirely.
  assert.ok(
    html.indexOf("wf-run-timeline") < html.indexOf("wf-run-audit"),
    "the audit disclosure must come after the timeline",
  );
  assert.doesNotMatch(headerOf(html), /wf-run-audit/);

  // Three rows: the id itself, the run's history, the version it was pinned to.
  assert.match(details, /<dt>Run id<\/dt><dd class="wf-run-audit-id">run<\/dd>/);
  assert.match(details, /<dt>Run history<\/dt>/);
  assert.match(details, /Every retained event, verdict, delivery and model call/);
  assert.match(details, /<dt>Workflow v2<\/dt>/);
  assert.match(details, /The immutable published definition this run was pinned to/);

  // The filenames are the server's own `Content-Disposition` names, pinned by
  // test/workflows-http.test.ts. A file must not be named two ways.
  assert.match(details, /href="\/api\/workflow-runs\/run\/export" download="workflow-run-run\.json"/);
  assert.match(
    details,
    /href="\/api\/workflows\/workflow\/versions\/2\/export" download="workflow-version-2\.json"/,
  );

  // Both downloads read "Download JSON" on screen, so each carries the name that tells a
  // screen reader - and a role-based spec - which record it fetches.
  assert.match(details, /aria-label="Download the run history as JSON"/);
  assert.match(details, /aria-label="Download workflow version 2 as JSON"/);
  assert.ok(hasTooltip(html, "Copy this durable workflow run id"));
});

test("a missing version leaves the audit row disabled rather than dropping it", () => {
  const base = runningDetail();
  const html = render({ ...base, version: null } as WorkflowRunDetail);
  const details = html.slice(html.indexOf("<details class=\"wf-run-audit\""));

  // The row is what says this run HAS a pinned version, so a corrupt definition is a fault
  // to see rather than a row to hide - and there is no href to offer.
  assert.match(details, /<dt>Workflow v2<\/dt>/);
  assert.match(details, /<button class="btn btn-ghost" aria-label="Download workflow version 2 as JSON"[^>]*disabled/);
  assert.doesNotMatch(details, /workflow-version-2\.json/);
  assert.ok(hasTooltip(html, "The immutable published version is missing or corrupt"));
  // The run's own history is unaffected by a missing definition.
  assert.match(details, /download="workflow-run-run\.json"/);
});

/**
 * The badge absorbed `Open version`.
 *
 * It already displayed the version, so a separate button for the same fact was a control the
 * action row spent on navigation. Making the badge the link puts the affordance on the
 * information, and the accessible name says where it goes - `v2` alone would not.
 */
test("the version badge is the composer link, and names the version it opens", () => {
  const html = render(runningDetail());
  const header = headerOf(html);
  assert.match(
    header,
    /<button class="wf-run-version" aria-label="Open workflow version 2 in the composer"/,
  );
  assert.ok(hasTooltip(html, "Open workflow version 2 in the composer"));
  assert.doesNotMatch(header, /<span class="wf-run-version">/);
});

test("a run whose version is missing cannot navigate to a composer that has nothing to show", () => {
  const base = runningDetail();
  const html = render({ ...base, version: null } as WorkflowRunDetail);
  assert.match(
    headerOf(html),
    /<button class="wf-run-version" aria-label="Open workflow version 2 in the composer"[^>]*disabled/,
  );
  assert.ok(hasTooltip(html, "The immutable published version is missing or corrupt"));
});

/**
 * A blocked run used to reach this header with nothing but Cancel run.
 *
 * `check_cleanup_unresolved` blocks on a pooled worktree that could not be handed back, and
 * the lease reclamation pass hands it back later - so by the time an operator is reading, the
 * fault is routinely gone. The server accepts a resubmission for it; the header offered none,
 * which made a recoverable run look terminal.
 */
test("a run blocked on a cleared check cleanup still offers the resubmission", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    summary: { ...base.summary, status: "blocked" },
    run: { ...base.run, status: "blocked", currentPhase: "check_cleanup_unresolved" },
  });
  assert.match(headerOf(html), /class="btn btn-primary"[^>]*>Preview fresh evidence</);
  // The invitation names resuming, not a new round: the stalled round is what continues.
  assert.ok(tooltipLabels(html).some((label) => label.includes("resume this run where it stalled")));
  assert.match(html, /Cancel run/);
  assertNoGraphIds(html);
});

/**
 * The state the whole redesign was reported from: nine controls, two of them useful.
 *
 * The refusals still mirror the server's, so nothing here promises a call that would 409. What
 * changed is what a refusal PRODUCES. It used to disable two buttons and hide the reason in
 * their tooltip, which left the one honest move - Cancel run - last and furthest right. Now the
 * reason is a sentence in the page and the submissions are simply absent, because a control that
 * cannot run is not an explanation.
 */
test("a blocked run whose binding was orphaned says why in prose, with no dead submissions", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    binding: { ...base.binding, state: "orphaned", sessionId: null },
    summary: { ...base.summary, status: "blocked" },
    run: { ...base.run, status: "blocked", currentPhase: "session_disappeared" },
  });
  const header = headerOf(html);
  assert.match(
    header,
    /<p class="wf-run-why"><b>The session this run was reviewing is gone,<\/b> so it cannot take another round\./,
  );
  // And it names what IS available, which is the one thing the old tooltip never did.
  assert.match(header, /Cancelling clears it from your queue/);
  assert.doesNotMatch(header, /btn-primary/);
  assert.doesNotMatch(header, /Preview fresh evidence/);
  assert.doesNotMatch(header, /Preview unchanged/);
  assert.doesNotMatch(header, /<button[^>]*disabled=""[^>]*>Preview/);
  assert.match(header, /Cancel run/);
  assertNoGraphIds(html);
});

/** A run past its configured rounds is refused by the server, so the header must not offer it. */
test("a blocked run out of repair rounds says so and names where the budget lives", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    summary: { ...base.summary, status: "blocked", round: 6, maxRepairRounds: 5 },
    run: { ...base.run, status: "blocked", currentPhase: "round_limit" },
  });
  const header = headerOf(html);
  assert.match(header, /<b>This run has used every repair round its binding allows,<\/b>/);
  assert.match(header, /A larger repair budget is a change to the binding/);
  assert.doesNotMatch(header, /btn-primary/);
  assertNoGraphIds(html);
});

/**
 * A decision has no primary, and saying so is the point.
 *
 * An uncertain delivery has two mutually exclusive resolutions and choosing between them needs
 * the operator's eyes on the session's pane. So the header does not hoist a fake primary; it
 * names the section that owns the choice, which is the same closing move `runRemedy` makes for
 * the triage row.
 */
test("a run blocked on a delivery decision points at the section that owns it", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    summary: { ...base.summary, status: "blocked" },
    run: { ...base.run, status: "blocked", currentPhase: "delivery_uncertain" },
  });
  const header = headerOf(html);
  assert.match(header, /<b>A repair packet may or may not have reached the session\.<\/b>/);
  assert.match(header, /Confirm or discard it in Deliveries below/);
  assert.doesNotMatch(header, /btn-primary/);
  assert.match(header, /Cancel run/);
});

/**
 * The POST-only invariant, guarded where it would be broken.
 *
 * `inspector_disabled` is the state that tempts a "Turn Inspector on" primary. Inspector
 * settings open through a callback prop, so a POST descriptor could not express one - and the
 * gate section below already renders the button. If somebody reintroduces it as a primary, this
 * fails.
 */
test("an Inspector-disabled block has no primary and names the gate section instead", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    summary: { ...base.summary, status: "blocked" },
    run: { ...base.run, status: "blocked", currentPhase: "inspector_disabled" },
  });
  const header = headerOf(html);
  assert.match(header, /<b>Inspector is switched off, so the gate cannot be evaluated\.<\/b>/);
  assert.match(header, /Turn it back on from Open Inspector settings, in Inspector final gate below/);
  assert.doesNotMatch(header, /btn-primary/);
  assert.doesNotMatch(header, /Turn Inspector on/);
});

/** A moving run is explained by the strip below it, not by a paragraph telling you to wait. */
test("a running run offers no primary and no sentence", () => {
  const header = headerOf(render(runningDetail()));
  assert.doesNotMatch(header, /btn-primary/);
  assert.doesNotMatch(header, /wf-run-why/);
});

/**
 * A finished run was the page's dead end: six controls and not one of them ran anything.
 *
 * Cancel run is correctly absent here - there is nothing left to stop - which is exactly what
 * left a completed run with no run-affecting control at all. The primary is the one thing a
 * finished run can still do, and it is the only one on this page keyed by the binding.
 */
function terminalDetail(): WorkflowRunDetail {
  const base = runningDetail();
  return {
    ...base,
    summary: { ...base.summary, status: "completed" },
    run: { ...base.run, status: "completed", currentPhase: "completed", completedAt: 12 },
  };
}

test("a finished run offers the rerun as its one primary, with no cancel to stop", () => {
  const header = headerOf(render(terminalDetail()));
  // The fixture binds a preview, so the label is the preview branch - a bound preview must never
  // invite an operator to a live submission.
  assert.match(header, /class="btn btn-primary"[^>]*>Preview this review again</);
  assert.equal((header.match(/btn-primary/g) ?? []).length, 1);
  assert.match(header, /Copy feedback/);
  // Nothing to cancel, and nothing to explain: the move IS the explanation.
  assert.doesNotMatch(header, /Cancel run/);
  assert.doesNotMatch(header, /wf-run-why/);
  assert.ok(
    tooltipLabels(render(terminalDetail()))
      .some((label) => label.includes("Capture fresh evidence from the session")),
    "the rerun must say what it captures",
  );
});

/** The binding is what starts another run, so a finished run without one says what would. */
test("a finished run whose binding was orphaned explains itself instead", () => {
  const base = terminalDetail();
  const header = headerOf(render({
    ...base,
    binding: { ...base.binding, state: "orphaned", sessionId: null },
  }));
  assert.match(
    header,
    /<p class="wf-run-why"><b>The session this review ran against is gone,<\/b> so it cannot be run again from here\./,
  );
  assert.doesNotMatch(header, /btn-primary/);
  assert.doesNotMatch(header, /review again/);
});

test("a live delivery keeps every recovery control and says what each state means", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    binding: { ...base.binding, deliveryMode: "live" },
    deliveries: [
      {
        id: "delivery-uncertain",
        runId: "run",
        submissionId: "submission-1",
        kind: "persona_feedback",
        sessionId: "session",
        noteKey: "note",
        payload: "EXACT REPAIR PACKET",
        payloadSha256: "a".repeat(64),
        state: "uncertain",
        error: "outcome_unknown",
        createdAt: 2,
        updatedAt: 3,
        deliveredAt: null,
      },
      {
        id: "delivery-refused",
        runId: "run",
        submissionId: "submission-1",
        kind: "persona_feedback",
        sessionId: "session",
        noteKey: "note",
        payload: "",
        payloadSha256: "b".repeat(64),
        state: "refused",
        error: "pane_blocked",
        createdAt: 2,
        updatedAt: 3,
        deliveredAt: null,
        payloadPrunedAt: 5,
      },
    ],
    events: [...base.events, {
      id: 9,
      runId: "run",
      timestamp: 9,
      kind: "workflow_completion_claimed",
      payload: {
        completionKind: "drain",
        marker: "1234567890abcdef",
        summary: "Foreman proved the queue complete.",
        state: "resubmitted",
      },
    }],
  } as WorkflowRunDetail);
  assert.match(html, /EXACT REPAIR PACKET/);
  assert.match(html, /Mark delivered/);
  assert.match(html, /Discard and send new round/);
  assert.match(html, /Retry refused delivery/);
  // The state is a sentence and the durable code survives beside it, never instead of it.
  assert.match(html, /Delivery uncertain/);
  assert.match(html, /may have landed/);
  assert.match(html, /outcome_unknown/);
  assert.match(html, /pane could not take the write/);
  assert.match(html, /Payload pruned/);
  assert.match(html, /drain completion/);
  assert.match(html, /Foreman proved the queue complete/);
  assertNoGraphIds(html);
});

test("an orphaned binding refuses the send-side recoveries instead of failing at the daemon", () => {
  // Both carry `expectedSessionId` / `expectedNoteKey`, which a binding with no session
  // cannot supply - the route refuses every such call. Offering them anyway is how the retry
  // became a button that silently did nothing and the discard a button that answered with a
  // raw schema dump. Marking a packet delivered needs no session and stays offered.
  const base = runningDetail();
  const deliveries = [
    {
      id: "delivery-uncertain",
      runId: "run",
      submissionId: "submission-1",
      kind: "persona_feedback" as const,
      sessionId: "session",
      noteKey: "note",
      payload: "PACKET",
      payloadSha256: "a".repeat(64),
      state: "uncertain" as const,
      error: null,
      createdAt: 2,
      updatedAt: 3,
      deliveredAt: null,
    },
    {
      id: "delivery-refused",
      runId: "run",
      submissionId: "submission-1",
      kind: "persona_feedback" as const,
      sessionId: "session",
      noteKey: "note",
      payload: "PACKET",
      payloadSha256: "b".repeat(64),
      state: "refused" as const,
      error: null,
      createdAt: 2,
      updatedAt: 3,
      deliveredAt: null,
    },
  ];
  const orphaned = render({
    ...base,
    binding: { ...base.binding, sessionId: null },
    deliveries,
  } as WorkflowRunDetail);
  assert.match(orphaned, /<button[^>]*disabled[^>]*>Retry refused delivery/);
  assert.match(orphaned, /<button[^>]*disabled[^>]*>Discard and send new round/);
  assert.doesNotMatch(orphaned, /<button[^>]*disabled[^>]*>Mark delivered/);
  assert.match(orphaned, /The bound session is gone/);

  const bound = render({ ...base, deliveries } as WorkflowRunDetail);
  assert.doesNotMatch(bound, /<button[^>]*disabled[^>]*>Retry refused delivery/);
  assert.doesNotMatch(bound, /<button[^>]*disabled[^>]*>Discard and send new round/);
});

/**
 * A packet's card has to say what KIND of packet it is, in words.
 *
 * The header used to render `delivery.kind.replaceAll("_", " ")`, which was survivable while
 * every kind read as a review and stopped being survivable the moment one of them was the
 * loop's own refusal: `unchanged evidence nudge` sat in the same slot as `persona feedback`
 * with nothing distinguishing a review from a complaint that no review had happened.
 */
test("each delivery card names its packet kind in words rather than as a machine string", () => {
  const base = runningDetail();
  const packet = (id: string, kind: WorkflowRunDetail["deliveries"][number]["kind"]) => ({
    id,
    runId: "run",
    submissionId: "submission-1",
    kind,
    sessionId: "session",
    noteKey: "note",
    payload: "PACKET",
    payloadSha256: "c".repeat(64),
    state: "delivered" as const,
    error: null,
    createdAt: 2,
    updatedAt: 3,
    deliveredAt: 3,
  });
  const html = render({
    ...base,
    deliveries: [
      packet("d-persona", "persona_feedback"),
      packet("d-nudge", "unchanged_evidence_nudge"),
    ],
  } as WorkflowRunDetail);
  assert.match(html, /<span>Review feedback<\/span>/);
  assert.match(html, /<span>Nothing changed<\/span>/);
  assert.doesNotMatch(html, /unchanged evidence nudge/, "no raw machine string reaches a reader");
});

test("the strip's meta line follows the retry, not the attempt that failed", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    attempts: [
      ...base.attempts,
      attempt("attempt-5", "submission-2", NODE.quality, snapshot("p-quality", "Quality reviewer"), {
        attempt: 2,
        state: "running",
        runner: "codex",
        model: "gpt-reviewer",
        finishedAt: null,
      }),
    ],
  } as WorkflowRunDetail);
  // Attempt 1 ran on claude/reviewer and errored; the retry resolved a different provider.
  // The chip is the retry's, so the line beneath it has to be too - asserted on that row
  // rather than on the page, because Security ran once and still reads claude · reviewer.
  const metaOf = (name: string): string | undefined =>
    new RegExp(`${name}</span><span class="wf-pipeline-reviewer-meta">([^<]*)`).exec(html)?.[1];
  assert.equal(metaOf("Quality reviewer"), "codex · gpt-reviewer");
  assert.equal(metaOf("Security reviewer"), "claude · reviewer");
});

test("the header's session link is disabled with the binding, not with a cached summary", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    // An orphaned binding: the summary still carries the id it had.
    binding: { ...base.binding, sessionId: null },
  } as WorkflowRunDetail);
  assert.match(html, /<button class="wf-run-session" disabled/);
  assert.match(html, /The bound session is no longer available/);
  assert.match(render(base), /<button class="wf-run-session"[^>]*>harness\/runs-monitor/);
});

test("the Inspector gate keeps its state, findings, actions, and bypass audit", () => {
  const base = runningDetail();
  const state = {
    prKey: "owner/repo#91",
    prUrl: "https://github.com/owner/repo/pull/91",
    targetHeadSha: "newhead0123456789",
    failedHeadSha: "oldhead0123456789",
    enteredAt: 8,
    lastObservedAt: 9,
    observedHeadSha: "newhead0123456789",
    reviewPosture: "live" as const,
    waitReason: "findings" as const,
    findingFingerprints: ["finding"],
  };
  const inspectorOnly = submission("submission-3", 3, {
    mode: "inspector_only",
    context: {
      bypassReason: "Published Inspector-only findings policy",
      failedHeadSha: "oldhead0123456789",
      newHeadSha: "newhead0123456789",
      priorFindingFingerprints: ["finding"],
    },
    evidence: { prHeadSha: "newhead0123456789" },
    prHeadSha: "newhead0123456789",
  });
  const prior = {
    ...base.submissions[1]!,
    status: "completed" as const,
    completedAt: 8,
  };
  const html = render({
    ...base,
    summary: {
      ...base.summary,
      status: "waiting_for_new_head",
      round: 3,
      bypassedPersonaReview: true,
      gate: "findings",
      gatePrNumber: 91,
      gateHeadShort: "newhead",
      reviewPosture: "live",
    },
    version: {
      ...version,
      completionPolicy: {
        kind: "inspector",
        onFindings: "inspector_only",
        missingPrAction: "offer_prepare_pr",
      },
    },
    run: { ...base.run, status: "waiting_for_new_head", currentPhase: "inspector_findings" },
    submissions: [base.submissions[0]!, prior, inspectorOnly],
    attempts: [
      ...base.attempts.filter((attempt) => attempt.submissionId !== prior.id),
      attempt("prior-quality", prior.id, NODE.quality, snapshot("p-quality", "Quality reviewer"), {
        verdict: passVerdict,
      }),
      attempt("prior-security", prior.id, NODE.security, snapshot("p-security", "Security reviewer"), {
        verdict: passVerdict,
      }),
      attempt("prior-docs", prior.id, NODE.docs, snapshot("p-docs", "Documentation steward"), {
        verdict: passVerdict,
      }),
    ],
    inspectorGate: {
      state,
      inspector: { enabled: true, mode: "live", posture: "live" },
      inspection: {
        key: state.prKey,
        url: state.prUrl,
        owner: "owner",
        repo: "repo",
        number: 91,
        repoRoot: "/repo",
        cwd: "/repo",
        sessionId: "session",
        source: "legacy",
        state: "open",
        headSha: "newhead0123456789",
        reviewPosture: "live",
        round: 3,
        lastReviewedAt: 9,
        lastError: "waiting on retry",
        failCount: 1,
        lastFailKind: "persistent",
        nextAttemptAt: 11,
        lastAttemptSha: "newhead0123456789",
        mergedAt: null,
        mergeBlock: "workflow-gate-pending",
        adoptedAt: 2,
        updatedAt: 9,
        openFindings: 1,
        postedOpenFindings: 1,
        resolvedFindings: 0,
      },
      findings: [{
        id: "finding",
        prKey: state.prKey,
        fingerprint: "finding",
        path: "src/gate.ts",
        line: 42,
        title: "Preserve provenance",
        body: null,
        severity: "major",
        round: 3,
        status: "open",
        replies: 0,
        answeredCommentId: null,
        createdAt: 9,
        updatedAt: 9,
      }],
    },
  } as WorkflowRunDetail);
  assert.match(html, /Inspector final gate/);
  assert.match(html, /Inspector left findings that have to be resolved/);
  assert.match(html, /#91/);
  assert.match(html, /legacy import/);
  assert.match(html, /Target head/);
  assert.match(html, /Observed head/);
  assert.match(html, /Reviewed head/);
  assert.match(html, /inspector only/);
  assert.match(html, /offer prepare pr/);
  assert.match(html, /Preserve provenance/);
  assert.match(html, /Legacy finding: detail was not persisted/);
  assert.match(html, /Persona review bypassed for Inspector repair/);
  assert.match(html, /moved from oldhead01234 to newhead01234/);
  // The gate's recheck IS this run's next move, so it is the header's primary and wears the
  // imperative a reader can act on rather than the route's own name.
  assert.match(headerOf(html), /class="btn btn-primary"[^>]*>Check again</);
  assert.match(html, /Restart full workflow/);
  assert.match(html, /Open Inspector settings/);
  // This gate has an adopted pull request, so Open PR is present, enabled, and a real link.
  assert.match(headerOf(html), /<a class="btn btn-ghost" href="https:\/\/github.com\/owner\/repo\/pull\/91"/);
  assert.match(html, /Open PR/);
  assert.match(html, /This Inspector repair round ran no Personas/);
  assert.match(html, /wf-pipeline-status workflow-passed wf-status-explained/);
  assert.ok(tooltipLabels(html).includes(inspectorOnlySkipStatus().tooltip!));
  assertNoGraphIds(html);
});

test("scrubbing to an earlier round never withdraws a live recovery action", () => {
  // The reader's rule: what a ROUND says is scoped to the round, what the RUN offers is not.
  // With the live submission an Inspector-only repair and the run waiting on Inspector rather
  // than on a new head, reading round 1 used to remove Restart full workflow entirely - the
  // only way to abandon the active repair, gone because of a view choice.
  const base = runningDetail();
  const inspectorOnly = submission("submission-3", 3, {
    mode: "inspector_only",
    context: { failedHeadSha: "oldhead0123456789", newHeadSha: "newhead0123456789" },
    prHeadSha: "newhead0123456789",
  });
  const gated = {
    ...base,
    summary: { ...base.summary, status: "waiting_for_inspector", round: 3, gate: "waiting_inspector" },
    run: { ...base.run, status: "waiting_for_inspector", currentPhase: "inspector_gate" },
    submissions: [...base.submissions, inspectorOnly],
    inspectorGate: {
      state: {
        prKey: "owner/repo#91",
        prUrl: null,
        targetHeadSha: "newhead0123456789",
        failedHeadSha: "oldhead0123456789",
        enteredAt: 8,
        lastObservedAt: 9,
        observedHeadSha: "newhead0123456789",
        reviewPosture: "live",
        waitReason: "review_pending",
        findingFingerprints: [],
      },
      inspector: { enabled: true, mode: "live", posture: "live" },
      inspection: null,
      findings: [],
    },
  } as WorkflowRunDetail;
  assert.match(render(gated), /Restart full workflow/);
  const earlier = render(gated, { roundId: "submission-1" });
  assert.match(earlier, /Restart full workflow/);
  // The round-scoped statements still follow the scrubber: round 1 ran Personas, so it carries
  // no bypass notice, and round 3 does.
  assert.doesNotMatch(earlier, /Persona review bypassed/);
  assert.match(render(gated, { roundId: "submission-3" }), /Persona review bypassed/);
});

test("the PR handoff and the provider retry are each the primary only in their own state", () => {
  const base = runningDetail();
  const waitingForPr = render({
    ...base,
    summary: { ...base.summary, status: "waiting_for_pr", gate: "waiting_pr" },
    version: {
      ...version,
      completionPolicy: {
        kind: "inspector",
        onFindings: "restart_workflow",
        missingPrAction: "offer_prepare_pr",
      },
    },
    run: { ...base.run, status: "waiting_for_pr", currentPhase: "inspector_gate" },
    inspectorGate: {
      state: {
        prKey: null,
        prUrl: null,
        targetHeadSha: "head",
        failedHeadSha: null,
        enteredAt: 8,
        lastObservedAt: null,
        observedHeadSha: null,
        reviewPosture: null,
        waitReason: "missing_pr",
        findingFingerprints: [],
      },
      inspector: { enabled: true, mode: "live", posture: null },
      inspection: null,
      findings: [],
    },
  } as WorkflowRunDetail);
  assert.match(headerOf(waitingForPr), /class="btn btn-primary"[^>]*>Ask the session to open a PR</);
  assert.match(waitingForPr, /No pull request has been opened/);
  assert.doesNotMatch(waitingForPr, /Retry the failed call/);
  /*
   * The case a policy-only gate would get wrong, and the reason the condition is the URL.
   *
   * This run's completion policy IS `inspector`, so a policy check would keep `Open PR` here -
   * on a run parked in `waiting_for_pr` precisely BECAUSE no pull request is adopted yet, which
   * makes it the most common destination-less button of the lot. Absent, not disabled.
   */
  assert.doesNotMatch(headerOf(waitingForPr), /Open PR/);
  assert.doesNotMatch(waitingForPr, /This run has no adopted pull request/);

  const blocked = render({
    ...base,
    summary: { ...base.summary, status: "blocked" },
    run: { ...base.run, status: "blocked", currentPhase: "infrastructure_error" },
    attempts: base.attempts.map((item) => item.id === "attempt-3"
      ? { ...item, state: "error" as const, error: "provider_timeout" }
      : item),
  } as WorkflowRunDetail);
  // Retry outranks the resubmission here: the exhausted call is resumable inside the round the
  // run already paid for, where a fresh resubmission would open a new one.
  assert.match(headerOf(blocked), /class="btn btn-primary"[^>]*>Retry the failed call</);
  assert.doesNotMatch(headerOf(blocked), /Preview fresh evidence/);
  assert.match(blocked, /Provider timeout\./);
  assert.match(blocked, /provider_timeout/);
  assert.doesNotMatch(blocked, /Ask the session to open a PR/);
  // No gate at all on this fixture, so no PR to open. Absent rather than disabled.
  assert.doesNotMatch(headerOf(blocked), /Open PR/);
});

test("a version this build cannot express as stages still renders on the canvas", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    version: {
      ...version,
      graph: {
        // Two End nodes: legal in the graph model, not a pipeline. The fallback is what keeps
        // a hand-built workflow's run watchable at all.
        nodes: [
          ...version.graph.nodes,
          {
            id: "8a1f0b4e-3333-4000-8000-000000000001",
            kind: "end",
            outcome: "Rejected",
            position: { x: 1180, y: 300 },
          },
        ],
        edges: version.graph.edges,
      },
    },
  } as WorkflowRunDetail);
  assert.match(html, /drawn freehand rather than as stages/);
  assert.match(html, /workflow-canvas/);
  assert.doesNotMatch(html, /wf-pipeline-strip/);
});

test("a missing immutable version blocks the strip without hiding the run", () => {
  const base = runningDetail();
  const html = render({ ...base, version: null } as WorkflowRunDetail);
  assert.match(html, /The immutable workflow version is missing or corrupt/);
  // The rest of the page is still there, including the run's own audit record - the run
  // history does not depend on the definition being readable.
  assert.match(html, /download="workflow-run-run\.json"/);
  assert.match(html, /Round 1/);
});

test("run detail renders not-captured and corrupt context states safely", () => {
  const base = runningDetail();
  const notCaptured = render({
    ...base,
    contextState: "not_captured",
    submissions: [{ ...base.submissions[0]!, context: {}, status: "cancelled" }],
  } as WorkflowRunDetail);
  assert.match(notCaptured, /Intent and evidence not captured/);
  assert.doesNotMatch(notCaptured, /Captured intent and evidence<\/h4>/);

  const corrupt = render({
    ...base,
    contextState: "corrupt",
    submissions: [{ ...base.submissions[0]!, context: { compaction: {} } }],
  } as WorkflowRunDetail);
  assert.match(corrupt, /Captured intent and evidence are corrupt/);
  assert.match(corrupt, /restore it from backup/);
});

test("a round whose captured context this build cannot read says so instead of throwing", () => {
  // `contextState` is the run's verdict - the newest full submission's kind - so a scrubbed
  // round can be unreadable while it still says "captured". Rendering that round used to cast
  // a three-key object into a snapshot and then read `humanDecisions.length` off it, which
  // takes the whole Runs view down rather than showing a state the surface already draws.
  const base = runningDetail();
  const detail = {
    ...base,
    submissions: [
      { ...base.submissions[0]!, context: { primaryGoal: {}, evidence: {}, compaction: {} } },
      base.submissions[1]!,
    ],
  } as WorkflowRunDetail;
  const earlier = render(detail, { roundId: "submission-1" });
  // The apostrophe reaches the markup escaped, so the assertion starts after it.
  assert.match(earlier, /s captured context is not readable by this build/);
  assert.doesNotMatch(earlier, /Original goal/);
  // The round is otherwise intact: its verdicts and the run's own actions are still there.
  assert.match(earlier, /Fix the race/);
  assert.match(headerOf(earlier), /Copy feedback/);
  // And a readable round is unaffected.
  assert.doesNotMatch(
    render(base, { roundId: "submission-1" }),
    /not readable by this build/,
  );
});

test("paging controls appear exactly when the daemon says there is more", () => {
  const base = runningDetail();
  const paged = render({
    ...base,
    eventCount: 400,
    nextEventAfter: 3,
    nextLlmCallAfter: "cursor",
  } as WorkflowRunDetail);
  assert.match(paged, /Load more events/);
  assert.match(paged, /Load more model calls/);
  // An unpaged run must not offer a page that does not exist.
  assert.doesNotMatch(render(base), /Load more events/);
});

test("external provenance deep-links an ensemble source to its re-homed route", () => {
  const html = render({
    ...runningDetail(),
    externalSource: { kind: "ensemble" as const, sourceId: "ens-42", createdAt: 5 },
  } as WorkflowRunDetail);
  assert.match(html, /Started by Ensemble/);
  assert.match(html, /<a [^>]*href="#\/ensembles\/ens-42"/);
  // A manually started run carries no provenance line at all rather than an empty one.
  assert.doesNotMatch(render(runningDetail()), /Started by/);
});

test("the empty state offers the binding dialog instead of describing it", () => {
  const withCta = renderToStaticMarkup(createElement(WorkflowRunsEmpty, {
    onBindWorkflow: () => {},
  }));
  assert.match(withCta, /No workflow runs yet/);
  assert.match(withCta, /Bind to a session/);
  // The old copy was an instruction with nothing to click.
  assert.doesNotMatch(withCta, /then submit a manual Preview/);
  // App owns the dialog, so a host that cannot open one renders no dead button.
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(WorkflowRunsEmpty, {})),
    /Bind to a session/,
  );
});

test("run detail distinguishes malformed durable data from expired history", () => {
  const corrupt = workflowRunLoadError(new WorkflowApiError(
    "workflow run data is malformed",
    500,
    { code: "workflow_run_corrupt" },
  ));
  const expired = workflowRunLoadError(new WorkflowApiError(
    "no such workflow run",
    404,
    { code: "workflow_run_not_found" },
  ));
  assert.match(corrupt, /malformed durable data/);
  assert.match(corrupt, /restore it from backup/);
  assert.match(expired, /no longer retained/);
  assert.notEqual(corrupt, expired);
});

test("binding selection reuses only the requested immutable version", () => {
  // The dialog the empty state's call to action opens: it must never adopt a binding that
  // points at a different published version.
  const session = {
    id: "session",
    state: "idle",
    agent: "claude",
    cwd: "/repo",
    repoRoot: "/repo",
  } as Session;
  const active = {
    id: "binding",
    workflowVersionId: "version-one",
    state: "active",
    sessionId: "session",
  } as WorkflowBinding;

  assert.equal(
    workflowBindingSelection([active], session, "version-one").existing?.id,
    "binding",
  );
  const mismatch = workflowBindingSelection([active], session, "version-two");
  assert.equal(mismatch.existing, undefined);
  assert.equal(mismatch.conflict?.id, "binding");

  const pausedOther = {
    ...active,
    id: "paused-other",
    workflowVersionId: "version-two",
    state: "paused",
    sessionId: null,
    sessionAgent: "claude",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
  } as WorkflowBinding;
  const pausedExact = {
    ...pausedOther,
    id: "paused-exact",
    workflowVersionId: "version-one",
  } as WorkflowBinding;
  assert.equal(
    workflowBindingSelection([pausedOther, pausedExact], session, "version-one").existing?.id,
    "paused-exact",
  );
  assert.equal(
    workflowBindingSelection([pausedExact, active], session, "version-two").conflict?.id,
    "binding",
  );
  assert.deepEqual(
    workflowBindingSelection([pausedOther], session, "version-one"),
    { existing: undefined, conflict: undefined },
  );

  // An empty selection is NO OPINION, not a conflict. Every comparison here is against
  // `versionId`, and `active.workflowVersionId === ""` is false for any real binding - so
  // clearing the select on a bound session reported that binding as a conflict and told the
  // operator to archive it before "selecting another version". They had selected nothing.
  assert.deepEqual(
    workflowBindingSelection([active], session, ""),
    { existing: undefined, conflict: undefined },
  );
  assert.deepEqual(
    workflowBindingSelection([pausedExact, active], session, ""),
    { existing: undefined, conflict: undefined },
  );
});

// ---- Check attempts ----
//
// A check carries a synthetic verdict so the Join, the repair packet and the engine need no
// special case. That is exactly why the READER needs one: drawn as a Persona verdict, an
// exit-code gate renders under "Missing persona" with a meta line offering "cost unavailable"
// about a subprocess, and the exit code - the one fact a reader wants first - appears
// nowhere. All of that renders cleanly and is simply wrong.

const CHECK_NODE = "8a1f0b4e-1111-4000-8000-00000000000c";

/** The same running run, with one check attempt in its latest round. */
function detailWithCheck(output: WorkflowJson): WorkflowRunDetail {
  const detail = runningDetail();
  const latest = detail.submissions[detail.submissions.length - 1]!;
  return {
    ...detail,
    attempts: [
      ...detail.attempts,
      attempt("attempt-check", latest.id, CHECK_NODE, snapshot("unused", "unused"), {
        // A check attempt records no Persona, runner or model - it is not a model call.
        persona: null,
        runner: null,
        model: null,
        output,
        verdict: {
          verdict: "pass",
          summary: "`npm test` passed.",
          approvalDetails: { reason: "`npm test` passed.", evidence: [] },
          confidence: 1,
        },
      }),
    ],
  } as WorkflowRunDetail;
}

test("a check attempt renders its slot, exit code and bounded output, not a Persona card", () => {
  const html = render(detailWithCheck({
    status: "failed",
    slot: "typecheck",
    command: ["npm", "run", "typecheck"],
    exitCode: 2,
    output: "src/thing.ts(4,1): error TS2345",
    truncatedBytes: 1_200,
    note: "`npm run typecheck` exited 2.",
  }));
  assert.match(html, /Check · typecheck/);
  assert.match(html, /exit 2/);
  assert.match(html, /error TS2345/);
  assert.match(html, /npm run typecheck/);
  // The omitted count is STATED, so nobody reads a bounded log as the whole one.
  assert.match(html, /Earlier 1200 bytes of output were omitted\./);
  // And none of the Persona card's vocabulary, which would be a lie about this attempt.
  assert.doesNotMatch(html, /Missing persona/);
  assert.doesNotMatch(html, /cost unavailable/);
  assertNoGraphIds(html);
});

test("the three passing check statuses each say something different about why", () => {
  const base = {
    slot: "test" as const,
    command: null,
    exitCode: null,
    output: "",
    truncatedBytes: 0,
  };
  const skipped = render(detailWithCheck({
    ...base,
    status: "skipped",
    note: "No test command is configured for this repository, so this gate was skipped.",
  }));
  assert.match(skipped, /Skipped/);
  assert.match(skipped, /No command is configured for this slot here/);
  assert.match(skipped, /no command configured/);

  const unavailable = render(detailWithCheck({
    ...base,
    status: "unavailable",
    note: "Workflow checks are switched off, so no command was run.",
  }));
  assert.match(unavailable, /Not run/);
  assert.match(unavailable, /switched off/);

  const passed = render(detailWithCheck({
    status: "passed",
    slot: "test",
    command: ["npm", "test"],
    exitCode: 0,
    output: "",
    truncatedBytes: 0,
    note: "`npm test` passed.",
  }));
  assert.match(passed, /Passed/);
  assert.match(passed, /ran in this repository and exited zero/);
});

test("a disabled reviewer renders red and keeps disable in its actions menu", () => {
  const detail = runningDetail();
  detail.run.disabledNodeIds = [NODE.security];
  const html = render(detail, { onToggleNodesDisabled: () => {} });
  // The row carries the red treatment and its own mark, and the chip states the claim.
  assert.match(html, /is-disabled/);
  assert.match(html, /⊘/);
  assert.match(html, />Disabled</);
  // The row's primary click is reserved for Persona feedback. Disable remains explicit in
  // the trailing menu, where it cannot be confused with opening the feedback editor.
  assert.match(html, /Actions for Security reviewer/);
  assert.match(html, /Enable for this run/);
  assert.match(html, /Disable for this run/);
  // The disabled member's red chip must not fold its stage to Failed: with its sibling
  // still reviewing, the stage reads Running - the toggle changed one member, not the gate.
  assert.doesNotMatch(html, />Failed</);
  // Node ids stay out of the markup even though the toggle addresses nodes.
  assertNoGraphIds(html);
});

test("an outcome the viewed round already reached keeps its real chip under the red row", () => {
  // Quality is disabled AFTER it already failed round 1 and while round 2 is reviewing it.
  // The disable is a promise about work that has not happened yet, so neither round's
  // recorded truth may repaint: the row goes red (the control's state), the chips do not.
  const detail = runningDetail();
  detail.run.disabledNodeIds = [NODE.quality];

  // Latest round: the review is LIVE, so the chip stays "Reviewing", never "Disabled".
  const latest = render(detail, { onToggleNodesDisabled: () => {} });
  assert.match(latest, /is-disabled/);
  assert.match(latest, /⊘/);
  assert.match(latest, /Enable for this run/);
  assert.match(latest, /Reviewing/);
  assert.doesNotMatch(latest, />Disabled</);

  // Round 1: the recorded failure stands - chip "Changes requested", stage folds Failed -
  // which is exactly what the round scrubber promises about history.
  const earlier = render(detail, {
    onToggleNodesDisabled: () => {},
    roundId: "submission-1",
  });
  assert.match(earlier, /is-disabled/);
  assert.match(earlier, /Changes requested/);
  assert.match(earlier, />Failed</);
  assert.doesNotMatch(earlier, />Disabled</);
});

test("without a toggle handler the disabled set still renders, read-only", () => {
  const detail = runningDetail();
  detail.run.disabledNodeIds = [NODE.security];
  const html = render(detail);
  assert.match(html, /is-disabled/);
  assert.match(html, />Disabled</);
  assert.doesNotMatch(html, /wf-pipeline-toggle/);
});

test("a finished run withholds the toggle even when the host supplies one", () => {
  const detail = runningDetail();
  detail.run = { ...detail.run, status: "completed", disabledNodeIds: [NODE.security] };
  const html = render(detail, { onToggleNodesDisabled: () => {} });
  assert.match(html, /is-disabled/);
  assert.doesNotMatch(html, /wf-pipeline-toggle/);
});

test("active Persona feedback marks only its target and opens from the row", () => {
  const detail = runningDetail();
  detail.run.personaDirectives = [{
    nodeId: NODE.security,
    feedback: "Treat missing rollback proof as blocking.",
    revision: 2,
    createdAt: 4,
    updatedAt: 8,
  }];
  const html = render(detail, {
    onSetPersonaDirective: () => {},
    onRemovePersonaDirective: () => {},
    onToggleNodesDisabled: () => {},
  });

  assert.equal((html.match(/Critical feedback active/g) ?? []).length, 1);
  assert.match(html, /has-directive/);
  assert.match(html, /Edit critical feedback for Security reviewer/);
  assert.match(html, /Add critical feedback for Quality reviewer/);
  assert.match(html, /Edit critical feedback/);
  assert.match(html, /Disable for this run/);
  assertNoGraphIds(html);
});

test("Persona feedback click targets require both mutation handlers", () => {
  const detail = runningDetail();
  const setOnly = render(detail, { onSetPersonaDirective: () => {} });
  const removeOnly = render(detail, { onRemovePersonaDirective: () => {} });

  assert.doesNotMatch(setOnly, /Add critical feedback for/);
  assert.doesNotMatch(removeOnly, /Add critical feedback for/);
});

test("Persona feedback byte count matches the trimmed text Save persists", () => {
  const html = renderToStaticMarkup(withOverlayHost(createElement(PersonaDirectiveEditor, {
    workflowName: "Review",
    runId: "12345678-0000-4000-8000-000000000000",
    round: 2,
    personaName: "Security reviewer",
    directive: {
      nodeId: NODE.security,
      feedback: "  🚀  ",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    pendingFor: () => false,
    error: null,
    onSave: () => {},
    onRemove: () => {},
    onClose: () => {},
  })));

  assert.match(html, /4 \/ 8,000 UTF-8 bytes/);
});

/** An attempt on a node that holds no opinion: Session, an all-pass join, End. */
const structural = (id: string, submissionId: string, nodeId: string): WorkflowNodeAttempt =>
  attempt(id, submissionId, nodeId, snapshot("unused", "unused"), {
    persona: null,
    runner: null,
    model: null,
    output: { outcome: "submitted" },
  });

test("the Session, join and End attempts are not drawn as reviewer verdicts", () => {
  // The engine writes a `completed` attempt for each of the three structural nodes - the Session
  // when evidence is captured, the join when it aggregates, the End when the run terminates.
  // Listed beside the reviewers they read as verdicts nobody gave, and their real state is
  // already on the strip above. Round 2's reviewers have no verdict YET, which is the case that
  // makes this a node-kind question rather than a "has a verdict" one: they must stay.
  const detail = runningDetail();
  const viewed = detail.submissions[1]!.id;
  detail.attempts = [
    ...detail.attempts,
    structural("attempt-session", viewed, NODE.session),
    structural("attempt-join", viewed, NODE.join),
    structural("attempt-end", viewed, NODE.end),
  ];
  const html = render(detail);
  const cards = html.match(/wf-run-card wf-run-attempt/g) ?? [];
  assert.equal(cards.length, 2, "only the two verdict-less REVIEWERS may render as attempt cards");
  assert.match(html, /Quality reviewer/);
  assert.match(html, /Security reviewer/);
  // The three structural attempts each carried this, which is the string that gave a demo run
  // three cards saying nothing.
  assert.doesNotMatch(html, /completed · attempt 1/);
  assertNoGraphIds(html);
});

test("a structural attempt that is not quietly complete is still shown", () => {
  // The filter hides noise, not evidence. A join or Session attempt in any other state is
  // something nobody expects, so hiding it would be the worst possible time to be tidy.
  const detail = runningDetail();
  const viewed = detail.submissions[1]!.id;
  detail.attempts = [
    ...detail.attempts,
    { ...structural("attempt-join", viewed, NODE.join), state: "error", error: "join wedged" },
  ];
  const html = render(detail);
  assert.match(html, /join wedged/);
});

test("a workflow with no reviewer in it says so instead of promising one", () => {
  // A Session-to-End graph used to fill this section with its own two structural attempts, so
  // "no reviewer yet" was never read. Now that they are gone, the sentence has to be true of a
  // graph that will never have one.
  const detail = runningDetail();
  const bare = { id: "bare-session", kind: "session" as const, position: { x: 0, y: 0 } };
  const end = { id: "bare-end", kind: "end" as const, outcome: "Complete", position: { x: 280, y: 0 } };
  detail.version = {
    ...version,
    id: "bare-version",
    graph: {
      nodes: [bare, end],
      edges: [{
        id: "bare-edge",
        source: bare.id,
        sourcePort: "submitted",
        target: end.id,
        targetPort: "terminal",
      }],
    },
  };
  const viewed = detail.submissions[1]!.id;
  detail.attempts = [
    structural("attempt-session", viewed, bare.id),
    structural("attempt-end", viewed, end.id),
  ];
  const html = render(detail);
  assert.match(html, /This workflow has no reviewers/);
  assert.doesNotMatch(html, /wf-run-attempt/);
});
