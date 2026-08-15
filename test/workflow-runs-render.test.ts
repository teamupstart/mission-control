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
import { readFileSync } from "node:fs";
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
import type { ChangeWorklistRow } from "../src/web/workflows/run-model.ts";
import type { WorklistItem, WorklistSegment } from "../src/web/workflows/WorkflowRuns.tsx";
import {
  WorkflowRunView,
  WorkflowRunsEmpty,
  followSelection,
} from "../src/web/workflows/WorkflowRuns.tsx";
import {
  carriedStatus,
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
  repoRoot: "",
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
  assert.match(errored, /Command failed to run/);
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
  // Round 1's PASS is not on screen at round 2, because Security has not re-reported: the
  // Passed segment is built from this round's attempts and there are none with a verdict.
  assert.doesNotMatch(latest, /No risk found/);
  assert.doesNotMatch(latest, /Every path is guarded/);
  assert.match(latest, /Passed 0/);
  assert.doesNotMatch(latest, /Viewing an earlier round/);
  /*
   * The change round 1 asked for IS still on screen at round 2, and that is the whole point of
   * the worklist rather than a leak in the scoping.
   *
   * Quality has not re-reported either, so nothing has said the change is fixed - which is
   * exactly the state the old section rendered as an empty list. The row names the round that
   * raised it so the carry is legible rather than looking like a fresh objection.
   */
  assert.match(latest, /Fix the race/);
  assert.match(latest, /Quality reviewer · round 1/);
  assert.match(latest, /Blocking 1/);

  const earlier = render(detail, { roundId: "submission-1" });
  assert.match(earlier, /Fix the race/);
  assert.match(earlier, /Restart can duplicate work/);
  assert.match(earlier, /changed line/);
  assert.match(earlier, /claude · reviewer/);
  // The pass costs a count and nothing else until somebody asks for it. This is the 1,984
  // characters of approval rationale the redesign was measured against.
  assert.match(earlier, /Passed 1/);
  assert.doesNotMatch(earlier, /No risk found/);
  assert.doesNotMatch(earlier, /Every path is guarded/);
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

/*
 * Run detail's `Cancel run` is the RETIRE half of the two controls that clear a spent gate,
 * and the Merge queue names it in as many words - "open the run to grant more rounds or
 * retire it". Retiring releases the Shipping veto the run holds over a pull request, so its
 * confirmation has to say so, exactly as the drawer's `Dismiss` does.
 *
 * Asserted on the SOURCE rather than the markup because the confirmation body is built in an
 * onClick handler, which `renderToStaticMarkup` never runs - the browser spec drives the
 * dialog itself. What this pins is the thing a render test can pin and a spec cannot: that
 * the two surfaces go through one derivation instead of spelling the sentence twice, which
 * is how they would come to disagree about whether stopping a run touches a pull request.
 */
test("run detail's cancel takes its gate sentence from the shared derivation", () => {
  const source = readFileSync(
    new URL("../src/web/workflows/WorkflowRuns.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /cancelGateSentence\(cancelReleasesGate\(/);
  assert.match(source, /confirmHint: cancelGateHint\(cancelReleasesGate\(/);
  assert.doesNotMatch(
    source,
    /lifts the merge block/,
    "run detail spells its own copy of the drawer's sentence",
  );
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

/*
 * A run past its rounds is the one stop that never clears itself, and its pull request
 * cannot merge until somebody acts, so the header owes the operator a button rather than a
 * paragraph. It used to render the paragraph - and the paragraph named the binding, which
 * is the one place a fix cannot reach this run from.
 */
test("a blocked run out of repair rounds offers the grant in the header", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    summary: { ...base.summary, status: "blocked", round: 6, maxRepairRounds: 5 },
    run: { ...base.run, status: "blocked", currentPhase: "round_limit" },
  });
  const header = headerOf(html);
  assert.match(header, /btn-primary/, "the one stop that needs an operator has no primary");
  assert.match(header, /Grant \d+ more rounds/);
  assert.doesNotMatch(header, /A larger repair budget is a change to the binding/);
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
  /*
   * The worklist answers for the Inspector round rather than going blank on it.
   *
   * Round 1's objection was confirmed by round 2's pass, so nothing is blocking and nothing
   * reported in round 3 - and the rail opens on the segment that has something in it rather
   * than on two empty panes. "This Inspector repair round ran no Personas" is scoped to
   * `Passed`, where it is true; it was never true of the agenda, which is exactly why it may
   * not describe the whole section.
   */
  assert.match(html, /Blocking 0/);
  assert.match(html, /Archive 1/);
  assert.match(html, /Resolved in round 2/);
  // A stage this round did not run reads NEUTRAL, never green: the chip speaks for the round
  // on screen, where nothing executed. The pass it is carrying is claimed by the provenance
  // line instead, which names the round that earned it and links straight to the proof.
  assert.match(html, /wf-pipeline-status workflow-stopped wf-status-explained/);
  assert.match(html, /Not re-run/);
  assert.ok(tooltipLabels(html).includes(carriedStatus("Round 2").tooltip!));
  assert.match(html, /Passed in Round 2\. Show that round\./);
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
/**
 * A run whose viewed round holds ONE check and nothing else.
 *
 * The Persona attempts are dropped rather than kept beside it, because the worklist shows one
 * item in full at a time and the assertions below are about what a check's own card says. With
 * round 1's objection still in the fixture the rail would open on that change instead, and
 * these tests would be pinning the selection rule rather than the check vocabulary - which
 * `workflow-run-blocker-worklist.spec.ts` and the selection tests below already do.
 */
function detailWithCheck(output: WorkflowJson): WorkflowRunDetail {
  const detail = runningDetail();
  const latest = detail.submissions[detail.submissions.length - 1]!;
  return {
    ...detail,
    attempts: [
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
  assert.match(html, /Command · typecheck/);
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
  assert.match(skipped, /No Command is configured for this slot on this machine/);
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
  // Round 1's verdicts are dropped so the rail opens on `Passed`, which is where a reviewer
  // that has not reported is listed. Nothing about the structural filter depends on them.
  detail.attempts = [
    ...detail.attempts.filter((item) => item.submissionId === viewed),
    structural("attempt-session", viewed, NODE.session),
    structural("attempt-join", viewed, NODE.join),
    structural("attempt-end", viewed, NODE.end),
  ];
  const html = render(detail);
  const rows = html.match(/wf-run-worklist-row is-attempt/g) ?? [];
  assert.equal(rows.length, 2, "only the two verdict-less REVIEWERS may reach the worklist");
  assert.match(html, /No verdict in this round yet/);
  assert.match(html, /Quality reviewer/);
  assert.match(html, /Security reviewer/);
  // Selected, and shown in full - the card the old section rendered for every one of them at
  // once still exists, for the one a reader asked about.
  assert.equal((html.match(/wf-run-card wf-run-attempt/g) ?? []).length, 1);
  // The three structural attempts each carried this, which is the string that gave a demo run
  // three cards saying nothing.
  assert.doesNotMatch(html, /completed · attempt 1/);
  // And a reviewer that has not reported is not counted as one that passed.
  assert.match(html, /Passed 0/);
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

/*
 * ---- the Blocker Worklist ----
 *
 * What is at stake here is the opposite of the file above it. Those tests guard against an
 * affordance disappearing; these guard against the wall coming back. The section this replaced
 * rendered every reviewer's whole card whether it had anything to say or not - measured at
 * 11,445 characters to convey about 480 on a live ten-round run - and the two things that made
 * it useless are both assertable from markup: a pass cost as much as a failure, and a change
 * raised in round 1 and still open in round 10 looked exactly like one raised a minute ago.
 *
 * The stalemate pair mirrors `test/workflow-ladder-repeat.test.ts`, sentence for sentence,
 * because both surfaces render one fact and it has to be worded one way on each.
 */

/**
 * A run over the Quality reviewer alone, one round per entry.
 *
 * `"fail"` raises the same change again, `"pass"` confirms it, and `"none"` is a round that has
 * opened without that reviewer reporting in it - the partial-round case, which is the one the
 * resolution rule is most easily got wrong on.
 */
function qualityRounds(...verdicts: ("fail" | "pass" | "none")[]): WorkflowRunDetail {
  const base = runningDetail();
  const submissions: WorkflowSubmission[] = [];
  const attempts: WorkflowNodeAttempt[] = [];
  verdicts.forEach((outcome, index) => {
    const round = index + 1;
    submissions.push(submission(`submission-${round}`, round, {
      status: "waiting_for_session",
      completedAt: null,
    }));
    if (outcome === "none") return;
    attempts.push(attempt(
      `attempt-${round}`,
      `submission-${round}`,
      NODE.quality,
      snapshot("p-quality", "Quality reviewer"),
      { verdict: outcome === "pass" ? passVerdict : failVerdict },
    ));
  });
  return {
    ...base,
    summary: { ...base.summary, round: submissions.at(-1)!.round },
    submissions,
    attempts,
    receipts: [],
  } as WorkflowRunDetail;
}

test("the worklist leads with what the run is asking for, and a pass costs a count", () => {
  const html = render(runningDetail(), { roundId: "submission-1" });
  // The agenda, selected and shown in full: the ask, the file, the round, the rationale.
  assert.match(html, /Blocking 1/);
  assert.match(html, /Fix the race/);
  assert.match(html, /What the reviewer wants/);
  assert.match(html, /Restart can duplicate work/);
  assert.match(html, /src\/engine\.ts:42/);
  assert.match(html, /Cited evidence/);
  // And the pass beside it is one number. Its summary, its approval rationale and its evidence
  // list - 1,984 characters of them on the measured run - are one click away and not on screen.
  assert.match(html, /Passed 1/);
  assert.doesNotMatch(html, /Approval rationale/);
  assert.doesNotMatch(html, /No risk found/);
  assertNoGraphIds(html);
});

test("a change carried across rounds names the round that raised it and how many did", () => {
  const html = render(qualityRounds("fail", "fail", "fail"));
  assert.match(html, /Blocking 1/, "three rounds of one grievance is one row, not three");
  assert.match(html, /Quality reviewer · round 1/);
  const facts = html.slice(html.indexOf("First raised"));
  assert.match(facts, /First raised<\/dt><dd>Round 1/);
  assert.match(facts, /Rounds open<\/dt><dd>3/);
  assertNoGraphIds(html);
});

test("the worklist reports each reviewer that has failed consecutive rounds", () => {
  const html = render(qualityRounds("fail", "fail", "fail"));
  assert.match(html, /wf-run-worklist-stalemate/);
  // The ladder's own sentence, unchanged, so one fact is worded one way on both surfaces.
  assert.match(html, /Quality reviewer has failed 3 rounds running\./);
});

test("one failing round is not a stalemate, and an earlier round is not told the future", () => {
  assert.doesNotMatch(render(qualityRounds("fail")), /rounds running/);
  // Scrubbed back to round 1 of a three-round run, the card must not report round 3's streak:
  // `detail.repeatOffenders` is latest-anchored and cannot be re-scoped, which is why the rail
  // renders the windowed `runStalemates` instead.
  const earlier = render(qualityRounds("fail", "fail", "fail"), { roundId: "submission-1" });
  assert.doesNotMatch(earlier, /rounds running/);
  assert.match(render(qualityRounds("fail", "fail", "fail"), { roundId: "submission-2" }),
    /Quality reviewer has failed 2 rounds running\./);
});

test("a resolved change moves to Archive naming the round its own reviewer confirmed in", () => {
  // Round 1 asked, round 2 passed, round 3 has opened and nobody has reported in it. Nothing is
  // blocking and nothing has passed IN THIS ROUND, so the rail opens on the segment that has
  // something in it rather than on two empty panes.
  const html = render(qualityRounds("fail", "pass", "none"));
  assert.match(html, /Blocking 0/);
  assert.match(html, /Archive 1/);
  assert.match(html, /wf-run-worklist-row is-change is-resolved/);
  assert.match(html, /Resolved in round 2/);
  assert.match(html, /Resolved in<\/dt><dd>Round 2/);
});

test("a reviewer that has not re-run leaves its change blocking, never resolved", () => {
  // The partial-round rule: round 2 exists and Quality has not reported in it. Nothing has said
  // the change is fixed, so it stays on the agenda rather than reading as done because time
  // passed.
  const html = render(qualityRounds("fail", "none"));
  assert.match(html, /Blocking 1/);
  assert.match(html, /Archive 0/);
  assert.doesNotMatch(html, /Resolved in round/);
});

test("a failing check is a blocker and keeps its exit code and output tail", () => {
  const html = render(detailWithCheck({
    status: "failed",
    slot: "test",
    command: ["npm", "test"],
    exitCode: 3,
    output: "1 failing",
    truncatedBytes: 0,
    note: "`npm test` exited 3.",
  }));
  assert.match(html, /Blocking 1/);
  assert.match(html, /Passed 0/);
  assert.match(html, /wf-run-worklist-row is-check/);
  assert.match(html, /exit 3/);
  assert.match(html, /1 failing/);
  // And the run does not present as having nothing outstanding.
  assert.doesNotMatch(html, /nothing outstanding/);
});

test("a check that never ran stays a degraded pass rather than a blocker", () => {
  const html = render(detailWithCheck({
    status: "skipped",
    slot: "test",
    command: null,
    exitCode: null,
    output: "",
    truncatedBytes: 0,
    note: "No test command is configured for this repository, so this gate was skipped.",
  }));
  assert.match(html, /Blocking 0/);
  assert.match(html, /Passed 1/);
  // The amber chip travels with it. Drawn green it would tell an operator the suite passed.
  assert.match(html, /workflow-waiting">Skipped/);
});

/**
 * The left accent and the chip beside it are one claim, so they are read from one value.
 *
 * Keyed on the row's KIND, which is how this shipped for a round, a fixed colour per kind says
 * things the kind cannot know: every Command red including the skipped one sitting in `Passed`,
 * every reviewer verdict green including the failing one that reaches `Blocking` through the
 * unparseable-verdict path, every verdict-less reviewer red including one that has simply not
 * reported. The chip was right in all three cases, which is what made it two marks on one row
 * disagreeing rather than a uniform mistake.
 *
 * Asserted as a SLICE of the row's own opening tag rather than as a substring of the page: the
 * tone class has to be on the element that carries the border, and `assert.match` over the whole
 * markup would be satisfied by it appearing on any row at all.
 */
function rowTagFor(html: string, kind: string): string {
  const at = html.indexOf(`wf-run-worklist-row is-${kind}`);
  assert.notEqual(at, -1, `no ${kind} row rendered`);
  const opens = html.lastIndexOf("<button", at);
  return html.slice(opens, html.indexOf(">", at) + 1);
}

test("a row's left accent is its own tone, never a colour fixed by its kind", () => {
  // A Command that never ran is a DEGRADED pass. Red would say the suite failed.
  const skipped = render(detailWithCheck({
    status: "skipped",
    slot: "test",
    command: null,
    exitCode: null,
    output: "",
    truncatedBytes: 0,
    note: "No test command is configured for this repository, so this gate was skipped.",
  }));
  assert.match(rowTagFor(skipped, "check"), /is-tone-waiting/);
  assert.doesNotMatch(rowTagFor(skipped, "check"), /is-tone-failed/);

  // And one that ran and exited non-zero is the blocker it says it is.
  const failed = render(detailWithCheck({
    status: "failed",
    slot: "test",
    command: ["npm", "test"],
    exitCode: 1,
    output: "1 failing",
    truncatedBytes: 0,
    note: "`npm test` exited 1.",
  }));
  assert.match(rowTagFor(failed, "check"), /is-tone-failed/);

  // A fail verdict the strict schema could not read still reaches `Blocking`, and must not wear
  // the green a passing reviewer does.
  const base = runningDetail();
  const unreadable = render({
    ...base,
    attempts: base.attempts.map((item) => item.id === "attempt-1"
      ? {
          ...item,
          verdict: {
            ...failVerdict,
            requestedChanges: [{ title: "No evidence attached", rationale: "why", evidence: [] }],
          },
        }
      : item),
  } as WorkflowRunDetail, { roundId: "submission-1" });
  assert.match(rowTagFor(unreadable, "verdict"), /is-tone-failed/);
  // The three change states keep the colours the plan argued for, now through the same route.
  const round1 = render(runningDetail(), { roundId: "submission-1" });
  assert.match(rowTagFor(round1, "change is-open"), /is-tone-failed/);
  const settled = render(qualityRounds("fail", "pass", "none"));
  assert.match(rowTagFor(settled, "change is-resolved"), /is-tone-passed/);

  // A reviewer that has not reported has not failed anything either.
  const pending = qualityRounds("none");
  pending.attempts = [attempt(
    "attempt-pending",
    "submission-1",
    NODE.quality,
    snapshot("p-quality", "Quality reviewer"),
    { state: "queued", verdict: null, startedAt: null, finishedAt: null },
  )];
  assert.match(rowTagFor(render(pending), "attempt"), /is-tone-waiting/);
  assert.doesNotMatch(rowTagFor(render(pending), "attempt"), /is-tone-failed/);

  // And one that errored has, so it keeps the blocker's colour.
  const errored = qualityRounds("none");
  errored.attempts = [attempt(
    "attempt-errored",
    "submission-1",
    NODE.quality,
    snapshot("p-quality", "Quality reviewer"),
    { state: "error", verdict: null, error: "provider_timeout" },
  )];
  assert.match(rowTagFor(render(errored), "attempt"), /is-tone-failed/);

  /*
   * The third blocking attempt state, and the one the other two do not cover: a reply the
   * verdict parser rejected. `stalledReviewer` files it in `Blocking` beside the errors, and
   * `completed` is the same durable string a passing attempt carries before its verdict is
   * read - so this row is the one place a chip could claim an outcome nobody reached.
   *
   * It does not. `reviewerStatus("completed")` is amber and says "No verdict", which is the
   * honest reading, and deliberately NOT the red an exhausted provider error wears: nothing
   * failed here, a reply arrived that could not be understood. Pinned because the distinction
   * is invisible from the attempt state alone and easy to flatten later.
   */
  const unparseable = qualityRounds("none");
  unparseable.attempts = [attempt(
    "attempt-unparseable",
    "submission-1",
    NODE.quality,
    snapshot("p-quality", "Quality reviewer"),
    { state: "completed", verdict: null },
  )];
  const rejected = render(unparseable);
  assert.match(rejected, /Blocking 1/);
  assert.match(rowTagFor(rejected, "attempt"), /is-tone-waiting/);
  assert.doesNotMatch(rowTagFor(rejected, "attempt"), /is-tone-passed/);
  assert.match(rejected, />No verdict</);
});

test("an unreadable second objection is shown even when its reviewer has an open change", () => {
  /*
   * The round-scoped half of the unparseable-verdict fallback.
   *
   * Keyed on the node alone, the dedupe also matched a row CARRIED FORWARD from an earlier
   * round: Quality's round-1 objection is still open because Quality never passed, so its
   * round-2 reply - which the strict schema rejects and the display cast accepts - was excluded
   * as already represented. It is not represented. The model cannot read that verdict either,
   * so the round-1 row keeps saying `round 1`, and the page showed a stale objection with no
   * sign the reviewer had answered again.
   */
  const base = runningDetail();
  const first = base.attempts.find((item) => item.id === "attempt-1")!;
  const second = base.attempts.find((item) => item.id === "attempt-3")!;
  const html = render({
    ...base,
    attempts: [
      first,
      {
        ...second,
        state: "completed" as const,
        verdict: {
          ...failVerdict,
          summary: "The reviewer answered again",
          // Empty evidence: legal to the loose display cast, refused by `PersonaVerdictSchema`.
          requestedChanges: [{ title: "Second look", rationale: "no evidence attached", evidence: [] }],
        },
      },
    ],
  } as WorkflowRunDetail);

  assert.match(html, /Blocking 2/);
  // Round 1's objection, still carried and still saying which round raised it.
  assert.match(html, /Fix the race/);
  assert.match(html, /Quality reviewer · round 1/);
  // And round 2's reply, kept rather than swallowed, wearing the blocker's tone.
  assert.match(html, /The reviewer answered again/);
  assert.match(rowTagFor(html, "verdict"), /is-tone-failed/);
  assertNoGraphIds(html);
});

/**
 * One node, one row - however many attempts a round took to get there.
 *
 * A retry does not replace the row it retries. `engine.ts` marks the failed row `error` and
 * INSERTS a successor at `attempt + 1` in the same submission, so both survive, and a surface
 * that classifies every row puts one reviewer in two segments at once: the dead attempt under
 * `Blocking`, its own successor under `Passed`. Reading only the newest attempt per node is the
 * rule the pipeline strip above already follows, and for the same reason - it is the only one
 * whose state is current.
 */
function retriedQualityDetail(
  first: Partial<WorkflowNodeAttempt>,
  second: Partial<WorkflowNodeAttempt>,
): WorkflowRunDetail {
  const base = runningDetail();
  const round = base.submissions[1]!.id;
  const persona = snapshot("p-quality", "Quality reviewer");
  return {
    ...base,
    attempts: [
      attempt("attempt-try-1", round, NODE.quality, persona, {
        attempt: 1,
        verdict: null,
        ...first,
      }),
      attempt("attempt-try-2", round, NODE.quality, persona, {
        attempt: 2,
        verdict: null,
        ...second,
      }),
    ],
  } as WorkflowRunDetail;
}

test("a reviewer that errored and passed on retry is a pass, not a pass AND a blocker", () => {
  const html = render(retriedQualityDetail(
    { state: "error", error: "provider_timeout" },
    { state: "completed", verdict: passVerdict },
  ));
  // The superseded attempt does not out-vote its own retry.
  assert.match(html, /Blocking 0/);
  assert.match(html, /Passed 1/);
  // And the dead attempt's card is not on the page at all - the strip above carries node state.
  assert.doesNotMatch(html, /provider_timeout/);
  assert.doesNotMatch(html, /wf-run-worklist-row is-attempt/);
  assertNoGraphIds(html);
});

test("a reviewer waiting on its own retry is pending, not a blocker", () => {
  // The engine inserts the successor `retry_wait` WITH an error string, so a rule that tested
  // for one would file every node that is about to try again under the heading for the ones
  // that cannot.
  const html = render(retriedQualityDetail(
    { state: "error", error: "provider_timeout" },
    { state: "retry_wait", error: "Retry scheduled after infrastructure failure: provider_timeout" },
  ));
  assert.match(html, /Blocking 0/);
  assert.match(html, /Passed 0/);
  // Its reason still reaches the reader, under the chip that says it is coming back.
  assert.match(html, /No verdict in this round yet/);
  assert.match(html, />Retrying</);
  assert.match(html, /Retry scheduled after infrastructure failure/);
});

test("a reviewer whose retries are exhausted is still a blocker", () => {
  // The other side of the same rule: once the engine stops scheduling successors, the newest
  // attempt IS the errored one, and nothing else on this page says why the run stopped.
  const html = render(retriedQualityDetail(
    { state: "error", error: "provider_timeout" },
    { state: "error", error: "provider_timeout" },
  ));
  assert.match(html, /Blocking 1/);
  assert.match(html, /wf-run-worklist-row is-attempt/);
  assert.match(html, /Provider timeout\./);
  assert.match(html, /provider_timeout/);
});

/**
 * A worklist row's key is its ID SPACE, never its kind.
 *
 * Asserted on the SOURCE rather than the markup because a React key never reaches the DOM, and
 * the failure it guards is a live-state one no single render can show: an attempt keeps its id
 * for its whole lifecycle - `store.ts` writes the verdict with `UPDATE workflow_node_attempts
 * ... WHERE id = ?`, and only a retry inserts a new row - so a reviewer is kind `attempt` while
 * it reports nothing and kind `verdict` the moment it does, and a Command is `attempt` until its
 * outcome lands and `check` after. Keyed by kind, `selectedKey` stopped resolving at exactly
 * that moment and selection snapped to the head of the list, losing the row a reader was
 * watching resolve.
 *
 * What this pins is the thing a render test cannot: that both keys come from one builder each,
 * so a future kind cannot quietly reintroduce a per-kind prefix.
 */
test("worklist keys are built from the id space, never from the row's kind", () => {
  const source = readFileSync(
    new URL("../src/web/workflows/WorkflowRuns.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const attemptKey = \(attempt: WorkflowNodeAttempt\): string =>/);
  assert.match(source, /const changeKey = \(row: ChangeWorklistRow\): string =>/);
  // Every item is keyed through one of the two, and nothing builds a key inline.
  const built = source.match(/key: (attemptKey\(attempt\)|changeKey\(row\))/g) ?? [];
  assert.equal(built.length, 8, "every worklist item is keyed through a shared builder");
  assert.doesNotMatch(
    source,
    /key: `(verdict|check|attempt|change):\$\{/,
    "a key that encodes the kind loses the selection when a row changes kind under the reader",
  );
});

test("a change citing no file says so rather than drawing an empty slot", () => {
  const base = runningDetail();
  const pathless = {
    ...failVerdict,
    requestedChanges: [{
      title: "Attach the completed test output",
      rationale: "The reply cites no run.",
      evidence: [{ kind: "goal", quote: "the task asked for the transcript" }],
    }],
  };
  const html = render({
    ...base,
    attempts: base.attempts.map((item) => item.id === "attempt-1"
      ? { ...item, verdict: pathless }
      : item),
  } as WorkflowRunDetail, { roundId: "submission-1" });
  assert.match(html, /Attach the completed test output/);
  assert.match(html, /No file cited/);
  // No file means no file to open, so the control is absent rather than dead.
  assert.doesNotMatch(html, /Open file/);
});

test("a change's mutating actions are offered live and withheld once the run is over", () => {
  const live = render(runningDetail(), {
    roundId: "submission-1",
    onCopyChange: () => {},
    onOpenFile: () => {},
    onSetPersonaDirective: () => {},
    onRemovePersonaDirective: () => {},
    onToggleNodesDisabled: () => {},
  });
  assert.match(live, /Copy this change/);
  assert.match(live, /Open file/);
  assert.match(live, /Give this reviewer feedback/);
  assert.match(live, /Disable Quality reviewer/);

  const base = runningDetail();
  const finished = render({
    ...base,
    summary: { ...base.summary, status: "completed" },
    run: { ...base.run, status: "completed" },
  } as WorkflowRunDetail, {
    roundId: "submission-1",
    onCopyChange: () => {},
    onOpenFile: () => {},
    onSetPersonaDirective: () => {},
    onRemovePersonaDirective: () => {},
    onToggleNodesDisabled: () => {},
  });
  // Withheld rather than disabled: a finished run can no longer be affected, and a button that
  // could never become enabled is a worse answer than no button.
  assert.doesNotMatch(finished, /Give this reviewer feedback/);
  assert.doesNotMatch(finished, /Disable Quality reviewer/);
  // The two that only read stay.
  assert.match(finished, /Copy this change/);
  assert.match(finished, /Open file/);
});

test("every empty arm the old verdict list had still has its sentence", () => {
  // An Inspector repair round with nothing outstanding: no reviewer ran, and the segment that
  // is about reviewers says so.
  const bypassed = qualityRounds("pass", "none");
  bypassed.submissions = bypassed.submissions.map((entry) =>
    entry.round === 2 ? { ...entry, mode: "inspector_only" as const } : entry);
  const html = render(bypassed);
  assert.match(html, /This Inspector repair round ran no Personas/);
  assert.doesNotMatch(html, /No reviewer has been activated/);

  // A round whose reviewers simply have not started. "Not yet" is a promise this arm can keep.
  const notStarted = qualityRounds("none");
  assert.match(render(notStarted), /No reviewer has been activated in this round yet/);

  // And a graph that will never produce one, which is a different empty entirely.
  const bare = { id: "bare-session", kind: "session" as const, position: { x: 0, y: 0 } };
  const end = { id: "bare-end", kind: "end" as const, outcome: "Complete", position: { x: 280, y: 0 } };
  assert.match(render({
    ...notStarted,
    version: {
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
    },
  } as WorkflowRunDetail), /This workflow has no reviewers/);
});

test("a host with no clipboard or Files surface draws neither control", () => {
  const html = render(runningDetail(), { roundId: "submission-1" });
  assert.doesNotMatch(html, /Copy this change/);
  assert.doesNotMatch(html, /Open file/);
  assert.match(html, /Fix the race/);
});

/*
 * ---- selection continuity when a reviewer reports ----
 *
 * A row's key is its id space, which holds a selection through a reviewer's PASS: the attempt is
 * `attempt:<id>` before and after. A FAIL is the case that key alone cannot carry. The attempt
 * stops being an item at all - a parseable fail verdict is represented by the changes it raised,
 * not by itself - so the row moves into the change id space AND into another segment, and no key
 * rewrite can bridge that, because the successor genuinely is a different thing.
 *
 * `followSelection` is the thread between them: the attempt survives in `detail.attempts` with
 * its node, and the changes it raised carry that node too. Tested directly because the transition
 * needs a live re-render with different data, which `renderToStaticMarkup` cannot produce and a
 * browser can only produce by racing a reviewer.
 */
const REVIEWER_NODE = NODE.quality;

function pendingAttempt(id: string): WorkflowNodeAttempt {
  return attempt(id, "submission-1", REVIEWER_NODE, snapshot("p-quality", "Quality reviewer"), {
    state: "queued",
    verdict: null,
  });
}

/** A `change` item carrying only the two fields the follow reads: its key and its reviewer. */
function changeItem(key: string, nodeId: string): WorklistItem {
  const row = { key, nodeId, title: key } as Partial<ChangeWorklistRow> as ChangeWorklistRow;
  return { kind: "change", key: `change:${key}`, row };
}

const emptySegments = (): Record<WorklistSegment, WorklistItem[]> =>
  ({ blocking: [], passed: [], archive: [] });

test("a selected reviewer that reports a failing verdict is followed to the change it raised", () => {
  const waiting = pendingAttempt("attempt-slow");
  const segments = emptySegments();
  // What the round looks like a moment later: the attempt is gone from the rail, and the change
  // it raised stands in `Blocking` while the reader is still looking at `Passed`.
  segments.blocking = [
    changeItem("other-node\n\nsomething else", "another-node"),
    changeItem(`${REVIEWER_NODE}\n\nattach the test output`, REVIEWER_NODE),
  ];

  const followed = followSelection("attempt:attempt-slow", [waiting], segments);
  assert.equal(followed?.segment, "blocking", "the rail goes where the reviewer's result landed");
  assert.equal(followed?.item.key, `change:${REVIEWER_NODE}\n\nattach the test output`);
});

test("a selection that still resolves somewhere is never dragged back to it", () => {
  // The caller only asks when the key resolves NOWHERE, and this pins the other half of that
  // rule: a reviewer with rows in two segments is followed to the first, not to whichever the
  // reader happens to be standing in - the guard against overruling a reader who moved segments
  // lives at the call site, and this function is what it would otherwise fight.
  const waiting = pendingAttempt("attempt-slow");
  const segments = emptySegments();
  segments.passed = [changeItem(`${REVIEWER_NODE}\n\nlater`, REVIEWER_NODE)];
  segments.blocking = [changeItem(`${REVIEWER_NODE}\n\nfirst`, REVIEWER_NODE)];
  assert.equal(followSelection("attempt:attempt-slow", [waiting], segments)?.segment, "blocking");
});

test("following gives up rather than guessing", () => {
  const waiting = pendingAttempt("attempt-slow");
  const segments = emptySegments();
  segments.blocking = [changeItem("someone-else\n\nnot yours", "someone-else")];

  // A change key is not an attempt key, so a change that vanished is not chased into a reviewer.
  assert.equal(followSelection("change:whatever", [waiting], segments), null);
  // An attempt that is no longer in the run at all - a round the reader scrubbed away from.
  assert.equal(followSelection("attempt:gone", [waiting], segments), null);
  // And a reviewer whose result is nowhere on this round leaves the fallback to the caller.
  assert.equal(followSelection("attempt:attempt-slow", [waiting], segments), null);
});

test("a change citing an EMPTY path is treated as citing none, everywhere", () => {
  /*
   * `WorkflowRequestedChangeSchema.path` is `.optional()` with no `.min(1)`, so `path: ""` is a
   * legal verdict, and `change.path ?? null` keeps it - `??` coalesces null and undefined, not
   * the empty string. Read directly, the row and the copy text called it absent while the detail
   * pane drew an `Open file` button with nothing in its tooltip, which revealed an empty path in
   * the Files tab.
   */
  const base = runningDetail();
  const empty = {
    ...failVerdict,
    requestedChanges: [{
      title: "Attach the completed test output",
      rationale: "The reply cites no run.",
      path: "",
      evidence: [{ kind: "goal", quote: "the task asked for the transcript" }],
    }],
  };
  const html = render({
    ...base,
    attempts: base.attempts.map((item) => item.id === "attempt-1"
      ? { ...item, verdict: empty }
      : item),
  } as WorkflowRunDetail, {
    roundId: "submission-1",
    onOpenFile: () => {},
    onCopyChange: () => {},
  });

  assert.match(html, /Attach the completed test output/);
  assert.match(html, /No file cited/);
  // The control that would have opened it, and the tooltip that would have named nothing.
  assert.doesNotMatch(html, /Open file/);
  assert.doesNotMatch(html, /Open  in the bound session/);
});
