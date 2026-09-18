import { createHash, randomUUID } from "node:crypto";

import { NO_MISTAKES_REVIEW_WORKFLOW_ID } from "@shared/builtin-workflow.ts";
import type {
  PersonaVerdict,
  PublishedWorkflowNode,
  SessionActionAttemptState,
  WorkflowJson,
  WorkflowRun,
} from "@shared/workflow.ts";

import { openDb } from "../db.ts";
import { BUILTIN_WORKFLOWS } from "./builtin-workflows.ts";
import { workflowJson, type WorkflowStore } from "./store.ts";

/**
 * Seed one finished, clearly-labelled demonstration run of the built-in No-Mistakes Review
 * directly into the store, so the Follow the review tour always has a real run to read.
 *
 * This exists for exactly one situation: a machine whose workflow history is empty. The tour
 * teaches by spotlighting a run's real surfaces - the stage strip, the Evidence pane, the
 * round scrubber, the Completion tab - and on a fresh install there is nothing to point at.
 * Running a real review to make one would spend eight reviewers' model calls on a walkthrough,
 * so this fabricates the record instead: every row is written through the store's own insert
 * paths, against the shipped version's real graph, and the run names itself "Tour demo" at
 * every surface that shows a session.
 *
 * What it deliberately does NOT fabricate: model calls (the cost ledger stays empty), evidence
 * images or artifacts (those need real bytes under the evidence store), a readiness verdict,
 * and an Inspector inspection ledger row (a fabricated open PR would put the real Inspector
 * worker to work on a pull request that does not exist). The gate state on the run is the one
 * clean-shaped record the Completion tab reads, keyed to a demo PR identity that no ledger
 * resolves.
 *
 * Two invariants this file must never break, both learned from the store's own guards:
 * every full-workflow submission carries a STRICTLY valid context snapshot (an invalid one
 * reads the whole run as corrupt and fails retention compaction hourly), and the run reaches
 * its terminal state exactly once, last (`setRunState` refuses updates after that).
 */

/** Deterministic ids, so a partially failed seed cannot pile up siblings across retries. */
const KEY = "tour-demo:workflows";
export const TOUR_DEMO_RUN_ID = `${KEY}:run`;
const BINDING_ID = `${KEY}:binding`;
const SUB_1 = `${KEY}:sub-1`;
const SUB_2 = `${KEY}:sub-2`;
const SESSION_NAME = "Tour demo";
const CHECKOUT = "/tour-demo/checkout";
const BRANCH = "tour-demo/operator-greeting";

const PR_NUMBER = 1;
const PR_KEY = `mission-control/tour-demo#${PR_NUMBER}`;
const PR_URL = `https://github.com/mission-control/tour-demo/pull/${PR_NUMBER}`;

const sha = (seed: string): string => createHash("sha256").update(seed).digest("hex").slice(0, 40);

const DEMO_DIFF = `diff --git a/src/greeting.ts b/src/greeting.ts
index 2f1a9c4..8b3d0e1 100644
--- a/src/greeting.ts
+++ b/src/greeting.ts
@@ -1,5 +1,9 @@
-export function greeting(): string {
-  return "Hello.";
+export function greeting(operator?: string): string {
+  if (!operator) return "Hello.";
+  return \`Hello, \${operator}.\`;
 }
diff --git a/test/greeting.test.ts b/test/greeting.test.ts
index 9c2e771..4d5f2aa 100644
--- a/test/greeting.test.ts
+++ b/test/greeting.test.ts
@@ -4,3 +4,8 @@ test("greets without a name", () => {
   assert.equal(greeting(), "Hello.");
 });
+
+test("greets the operator by name", () => {
+  assert.equal(greeting("Jordan"), "Hello, Jordan.");
+});
`;

const RAW_GOAL =
  "Tour demo: greet the operator by name in src/greeting.ts, with a focused test covering "
  + "the new branch. This run was seeded by the Follow the review tour so its record can be "
  + "read; no reviewer model calls were made.";

/** The strictly-valid context snapshot both submissions freeze. */
function demoContext(diffFingerprint: string) {
  return {
    primaryGoal: {
      rawPrompt: RAW_GOAL,
      refined: null,
      sourceNoteKey: KEY,
    },
    humanDecisions: [],
    constraints: [],
    acceptanceCriteria: [
      "greeting(operator) names the operator when one is given",
      "A focused test covers the named-operator branch",
    ],
    canonicalCriteria: [],
    priorPersonaFeedback: [],
    session: { agent: "claude", name: SESSION_NAME, cwd: CHECKOUT, branch: BRANCH },
    evidence: {
      headSha: sha("tour-demo-head"),
      contentTreeOid: null,
      diffFingerprint,
      diff: DEMO_DIFF,
      diffTruncated: false,
      workingTreeDirty: false,
      workingTreeStatus: [],
      workingTreeStatusTruncated: false,
      transcript: [
        { role: "user" as const, content: RAW_GOAL },
        {
          role: "assistant" as const,
          content:
            "Added the optional operator parameter to greeting() and a focused test for the "
            + "named branch. Both greeting tests pass.",
        },
      ],
      transcriptAnchor: null,
      transcriptTruncated: false,
      transcriptOmittedHeadBytes: 0,
      transcriptMiddleOmitted: false,
      standards: [],
      standardsTruncated: false,
      images: [],
      artifacts: [],
      stagedImageGeneration: 0,
      retention: { state: "full" as const },
    },
    // `fallback` is the honest reading: no compaction model call was made for this record.
    compaction: { status: "fallback" as const, runner: null, model: null, error: null },
  };
}

const passVerdict = (summary: string, reason: string): PersonaVerdict => ({
  verdict: "pass",
  summary,
  approvalDetails: { reason, evidence: [] },
  confidence: 0.9,
});

const PERSONA_SUMMARY =
  "Seeded demo verdict: the change matches the stated goal, the new branch is covered by a "
  + "focused test, and nothing blocks approval.";

/** Fabricate the whole record, or return the already-seeded run untouched. */
export function seedWorkflowsTourDemoRun(store: WorkflowStore, now = Date.now()): WorkflowRun {
  const db = openDb();
  const existing = store.getRun(TOUR_DEMO_RUN_ID);
  if (existing) return existing;

  const builtin = BUILTIN_WORKFLOWS.find(
    (workflow) => workflow.definition.id === NO_MISTAKES_REVIEW_WORKFLOW_ID,
  );
  const versionId = builtin?.definition.currentVersionId;
  const version = versionId ? store.getWorkflowVersionById(versionId) : null;
  if (!version) throw new Error("this build ships no published No-Mistakes Review to seed");

  // A plausible little timeline: captured ten minutes ago, finished two minutes ago.
  const t0 = now - 10 * 60_000;
  let clock = t0;
  const tick = (ms: number): number => (clock = Math.min(clock + ms, now - 2 * 60_000));

  // One transaction end to end: a half-seeded run would render as permanently stuck, so a
  // failure anywhere leaves no rows at all. Store calls nest their own transactions safely.
  if (db.isTransaction) return seedInTransaction();
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = seedInTransaction();
    db.exec("COMMIT");
    return run;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The seed failed first; surface that error rather than the rollback's.
    }
    throw error;
  }

  function seedInTransaction(): WorkflowRun {
    const graph = version!.graph;
    const passEdges = (nodeId: string, port: string) =>
      graph.edges.filter((edge) => edge.source === nodeId && edge.sourcePort === port);

    const binding = store.insertBinding({
      id: BINDING_ID,
      workflowVersionId: version!.id,
      noteKey: KEY,
      sessionId: `${KEY}:session`,
      sessionAgent: "claude",
      sessionName: SESSION_NAME,
      sessionCwd: CHECKOUT,
      sessionRepoRoot: CHECKOUT,
      triggerMode: "foreman_complete",
      deliveryMode: "preview",
      maxRepairRounds: version!.bindingDefaults.maxRepairRounds,
      now: t0,
    });

    store.createInitialSubmission(
      {
        id: TOUR_DEMO_RUN_ID,
        binding,
        triggerSource: "manual",
        triggerKey: `${KEY}:trigger-run`,
        intent: {
          rawGoal: RAW_GOAL,
          refinedGoal: null,
          sourceNoteKey: KEY,
          decisions: [],
          frozenAt: t0,
        },
        now: t0,
      },
      {
        id: SUB_1,
        triggerSource: "manual",
        triggerKey: `${KEY}:trigger-sub-1`,
        context: {},
        evidence: {},
        now: t0,
      },
    );

    const context1 = demoContext(`${KEY}:diff-1`);
    store.updateSubmissionCapture(
      SUB_1,
      {
        context: context1,
        evidence: context1.evidence,
        fingerprint: `${KEY}:fp-1`,
        status: "running",
      },
      tick(5_000),
    );
    store.setRunState(TOUR_DEMO_RUN_ID, "running", "persona_review", null, clock);

    /** One completed attempt plus its receipts, the way the engine records each node kind. */
    const attempt = (
      submissionId: string,
      node: PublishedWorkflowNode,
      finish: {
        verdict?: PersonaVerdict;
        output: WorkflowJson;
        port: string;
        receipt: (edgeTarget: string) => WorkflowJson;
        runner?: "claude" | "codex" | null;
        model?: string | null;
      },
    ): void => {
      const inserted = store.insertAttempt({
        id: randomUUID(),
        submissionId,
        nodeId: node.id,
        attempt: 1,
        state: "queued",
        persona: node.kind === "persona" ? node.persona : null,
        inputFingerprint: `${KEY}:fp:${node.id}`,
        now: clock,
      });
      store.claimAttempt(inserted.id, finish.runner ?? null, finish.model ?? null, tick(1_000));
      const receipts = passEdges(node.id, finish.port).map((edge) => ({
        edgeId: edge.id,
        payload: finish.receipt(edge.target),
      }));
      if (finish.verdict) {
        store.finishAttemptWithReceipts(
          inserted.id,
          { verdict: workflowJson(finish.verdict), output: finish.output, receipts },
          tick(20_000),
        );
      } else {
        store.finishAttempt(inserted.id, { state: "completed", output: finish.output }, clock);
        for (const receipt of receipts) {
          store.addReceipt(submissionId, receipt.edgeId, inserted.id, receipt.payload, clock);
        }
      }
    };

    // The graph's evaluators, in node order: session first, then checks, personas, and each
    // stage's join, exactly as the engine records a clean pass over every one of them.
    for (const node of graph.nodes) {
      if (node.kind === "session") {
        attempt(SUB_1, node, {
          output: { outcome: "submitted" },
          port: "submitted",
          receipt: () => ({ outcome: "submitted" }),
        });
      } else if (node.kind === "check") {
        const note =
          `Seeded demo run: the ${node.slot} Command was not executed, so this gate is `
          + "recorded as skipped.";
        const verdict = passVerdict(note, note);
        attempt(SUB_1, node, {
          verdict,
          output: {
            status: "skipped",
            slot: node.slot,
            command: null,
            exitCode: null,
            output: "",
            truncatedBytes: 0,
            note,
          },
          port: "pass",
          receipt: () => workflowJson({ outcome: "pass", persona: `${node.slot} Command`, verdict }),
        });
      } else if (node.kind === "persona") {
        const verdict = passVerdict(PERSONA_SUMMARY, PERSONA_SUMMARY);
        attempt(SUB_1, node, {
          verdict,
          output: { outcome: "pass", persona: node.persona.name, requestedChanges: [] },
          port: "pass",
          receipt: () => workflowJson({ outcome: "pass", persona: node.persona.name, verdict }),
          runner: node.persona.runner ?? "codex",
          model: node.persona.model ?? "gpt-5.6-terra",
        });
      } else if (node.kind === "all_pass") {
        attempt(SUB_1, node, {
          output: { outcome: "pass" },
          port: "pass",
          receipt: () => ({ outcome: "pass" }),
        });
      }
    }

    // The Pull Request action: waiting attempt, delivered packet, continuation segment, and
    // completion through the store's own continuation path, so the output carries the same
    // observed-expectation record a real shipped run holds.
    const actionNode = graph.nodes.find((node) => node.kind === "session_action");
    if (actionNode?.kind !== "session_action") {
      throw new Error("the published No-Mistakes graph carries no session action to seed");
    }
    const pickedUpAt = tick(5_000);
    const settledAt = tick(30_000);
    const actionState: SessionActionAttemptState = {
      wait: "awaiting_pull_request",
      deliveryId: null,
      anchor: null,
      pickedUpAt,
      settledAt,
      expectation: {
        kind: "pull_request",
        pullRequestKey: PR_KEY,
        pullRequestUrl: PR_URL,
        pullRequestNumber: PR_NUMBER,
        repositoryRoot: CHECKOUT,
        branch: BRANCH,
        expectedHeadOid: sha("tour-demo-pr-head"),
        acceptedContentTreeOid: null,
        observedAt: settledAt,
      },
      continuationSubmissionId: null,
      blocked: null,
    };
    const action = store.insertAttempt({
      id: `${KEY}:action`,
      submissionId: SUB_1,
      nodeId: actionNode.id,
      attempt: 1,
      state: "waiting",
      persona: null,
      sessionAction: actionNode.action,
      sessionActionState: actionState,
      inputFingerprint: `${KEY}:fp:${actionNode.id}`,
      now: clock,
    });
    store.setRunState(
      TOUR_DEMO_RUN_ID,
      "waiting_for_action",
      "session_action",
      { nodeId: actionNode.id, attemptId: action.id, action: actionNode.action.name },
      clock,
    );
    const packet = `Open the pull request for the demo greeting change on ${BRANCH}.`;
    const delivery = store.prepareDelivery({
      id: `${KEY}:delivery`,
      runId: TOUR_DEMO_RUN_ID,
      submissionId: SUB_1,
      kind: "session_action",
      nodeAttemptId: action.id,
      sessionId: `${KEY}:session`,
      noteKey: KEY,
      payload: packet,
      payloadSha256: createHash("sha256").update(packet).digest("hex"),
    }, clock);
    store.setDeliveryState(delivery.delivery.id, "delivered", null, clock);

    const reserved = store.reserveSessionActionContinuation({
      attemptId: action.id,
      submissionId: SUB_2,
      triggerKey: `${KEY}:trigger-sub-2`,
      now: tick(5_000),
    });
    if (!reserved.ok) {
      throw new Error(`the demo continuation could not be reserved: ${reserved.reason}`);
    }
    const context2 = demoContext(`${KEY}:diff-2`);
    store.updateSubmissionCapture(
      SUB_2,
      {
        context: context2,
        evidence: context2.evidence,
        fingerprint: `${KEY}:fp-2`,
        status: "running",
      },
      tick(5_000),
    );
    store.setRunState(TOUR_DEMO_RUN_ID, "running", "persona_review", null, clock);
    store.completeSessionActionContinuation({
      attemptId: action.id,
      submissionId: SUB_2,
      receipts: passEdges(actionNode.id, "complete").map((edge) => ({
        edgeId: edge.id,
        payload: { outcome: "complete" },
      })),
      now: tick(2_000),
    });

    const endNode = graph.nodes.find((node) => node.kind === "end");
    if (endNode?.kind !== "end") {
      throw new Error("the published No-Mistakes graph carries no End node to seed");
    }
    attempt(SUB_2, endNode, {
      output: { outcome: "pass", label: endNode.outcome },
      port: "terminal",
      receipt: () => ({ outcome: "pass" }),
    });
    store.appendEvent(
      TOUR_DEMO_RUN_ID,
      "workflow_end",
      { outcome: "pass", label: endNode.outcome },
      clock,
    );
    store.setSubmissionState(SUB_1, "completed", clock);
    store.setSubmissionState(SUB_2, "completed", clock);

    // Terminal last, in one call, carrying the clean gate the Completion tab reads. The demo
    // PR identity resolves to no Inspector ledger row on purpose: a fabricated open PR would
    // put the real Inspector worker to work on a pull request that does not exist.
    const gateHead = sha("tour-demo-pr-head");
    const run = store.setRunState(
      TOUR_DEMO_RUN_ID,
      "completed",
      "complete",
      {
        prKey: PR_KEY,
        prUrl: PR_URL,
        targetHeadSha: gateHead,
        failedHeadSha: null,
        enteredAt: clock,
        lastObservedAt: clock,
        observedHeadSha: gateHead,
        reviewPosture: "live",
        waitReason: null,
        findingFingerprints: [],
      },
      now - 2 * 60_000,
    );

    // Orphan the fabricated session identity so no chip, dialog, or "open session" affordance
    // ever points at a conversation that never existed. The durable session name stays.
    store.orphanBinding(BINDING_ID, "session_disappeared", now - 2 * 60_000);
    return run;
  }
}
