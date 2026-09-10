/**
 * The whole failure chain, end to end, in one test.
 *
 * Every other test in this change proves one link: the route reserves authorship, the prompt
 * hook refuses to capture a delivery it recognises, the supervisor claims before it sends. None
 * of them shows the OUTCOME the operator actually reported, which is what a repair packet says
 * a few minutes later. This does:
 *
 *   1. the human states the goal, and it becomes the session Goal;
 *   2. Foreman delivers a completion-review packet and records that it did;
 *   3. the agent echoes that packet back through its prompt hook;
 *   4. a workflow run is created and freezes the ask it will review against;
 *   5. the review fails and Mission Control renders the repair packet.
 *
 * Then it reads the one line the operator read: "Original user goal:". Before this change that
 * line was Foreman's own complaint, distilled into acceptance criteria and handed back to the
 * agent as the thing to satisfy. Measured when the defect was found, 7 of the 19 workflow runs
 * on that machine had frozen machine-authored text as `rawGoal` - three a completion-review
 * packet, two a repair packet, which itself contains the string "Original user goal:" and so
 * nested each round inside the next.
 *
 * The freeze alone could not fix it. `test/workflow-run-intent-snapshot.test.ts` pins that a run
 * reviews the ask it copied at creation and that no later packet can move it - true, and not
 * enough, because Foreman's completion review lands BEFORE the run exists. The freeze then
 * faithfully preserves the wrong thing. Step 3 is where that is decided, which is why this test
 * runs the hook rather than seeding the Goal directly.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-goal-continuity-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { recordInjection, forgetInjections } = await import("../src/server/injections.ts");
const { fallbackWorkflowContext, readWorkflowContextRaw, readWorkflowIntentSnapshot } =
  await import("../src/server/workflows/context.ts");
const { renderWorkflowFeedback } = await import("../src/server/workflows/feedback.ts");
const { setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
const { mkMuxHandle } = await import("./helpers/session-fixture.ts");

type DiscoveredSession = import("../src/server/discovery/correlate.ts").DiscoveredSession;
type HookIngest = import("../src/shared/protocol.ts").HookIngest;
type WorkflowBinding = import("../src/shared/workflow.ts").WorkflowBinding;
type WorkflowJson = import("../src/shared/workflow.ts").WorkflowJson;
type WorkflowNodeAttempt = import("../src/shared/workflow.ts").WorkflowNodeAttempt;
type WorkflowRun = import("../src/shared/workflow.ts").WorkflowRun;
type WorkflowSubmission = import("../src/shared/workflow.ts").WorkflowSubmission;
type WorkflowVersion = import("../src/shared/workflow.ts").WorkflowVersion;

const repositoryRoot = process.cwd();
setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [repositoryRoot] });

/** What the operator actually asked for, on the session this defect was found on. */
const HUMAN_GOAL = "Task source write-back - Phase 2: Jira annotate and resolve";

/** Foreman's completion-review packet, in the shape `ship-shepherd.ts` builds it. */
const FOREMAN_PACKET = [
  "Foreman's completion review found blocking work that still belongs in this implementation turn:",
  "",
  "1. e2e/specs/conductor-loops.spec.ts: The full end-to-end run failed this spec, while its",
  "   isolated rerun passed.",
  "",
  "Address only these implementation, documentation, test, or evidence gaps. Do not commit,",
  "push, create a pull request, merge, or expand repository scope.",
].join("\n");

const PANE = "%930";

function session(registry: InstanceType<typeof Registry>, id: string) {
  registry.applyDiscovery([{
    syntheticId: id,
    agent: "claude",
    name: id,
    nameSource: "process",
    cwd: repositoryRoot,
    gitBranch: "feature",
    gitRoot: repositoryRoot,
    repoRoot: repositoryRoot,
    pid: 9301,
    tty: "ttys-continuity",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: PANE })],
    startedAt: 1,
  } as DiscoveredSession]);
  return registry.getSession(id)!;
}

function submitPrompt(registry: InstanceType<typeof Registry>, prompt: string): void {
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: null,
    cwd: null,
    transcriptPath: null,
    env: { tmuxPane: PANE },
    prompt,
  } as HookIngest);
}

/** The smallest graph that renders a failing verdict, and the run and submission around it. */
function reviewFixtures(context: unknown) {
  const version: WorkflowVersion = {
    id: "version",
    workflowId: "workflow",
    version: 15,
    sourceDraftRevision: 1,
    graph: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        {
          id: "reviewer",
          kind: "persona",
          position: { x: 0, y: 0 },
          persona: {
            sourcePersonaId: "reviewer",
            sourceRevision: 1,
            name: "Code Risk Reviewer",
            description: "",
            guidanceMarkdown: "Review.",
            runner: null,
            model: null,
          },
        },
      ],
      edges: [],
    },
    completionPolicy: { kind: "none" },
    resumptionPolicy: "manual",
    evidenceReadinessPolicy: "off",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    publishedAt: 1,
  };
  const run: WorkflowRun = {
    id: "run",
    bindingId: "binding",
    workflowVersionId: "version",
    status: "waiting_for_session",
    currentPhase: "persona_feedback",
    maxRepairRounds: 5,
    triggerSource: "foreman",
    triggerKey: "foreman:key",
    inspectorPrKey: null,
    inspectorHeadSha: null,
    gateState: null,
    startedAt: 1,
    updatedAt: 1,
    completedAt: null,
  };
  const submission: WorkflowSubmission = {
    id: "submission",
    runId: run.id,
    round: 1,
    mode: "full_workflow",
    triggerSource: "foreman",
    triggerKey: "foreman:key",
    evidenceFingerprint: "1234567890abcdefmore",
    context: context as WorkflowJson,
    evidence: {} as WorkflowJson,
    segment: 0,
    parentSubmissionId: null,
    continuationNodeId: null,
    continuationNodeAttemptId: null,
    prHeadSha: null,
    status: "waiting_for_session",
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  };
  const attempts: WorkflowNodeAttempt[] = [{
    id: "attempt-reviewer",
    submissionId: submission.id,
    nodeId: "reviewer",
    attempt: 1,
    state: "completed",
    persona: (version.graph.nodes[1] as { persona: unknown }).persona as never,
    sessionAction: null,
    runner: "claude",
    model: "review",
    verdict: {
      verdict: "fail",
      summary: "The write-back is not covered.",
      requestedChanges: [{
        title: "Cover the Jira transition",
        rationale: "No test drives it.",
        evidence: [{ kind: "diff", quote: "patch" }],
      }],
      confidence: 1,
    },
    output: null,
    retryAt: null,
    inputFingerprint: "reviewer",
    error: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    finishedAt: 1,
  }];
  return { version, run, submission, attempts };
}

test("a Foreman packet cannot reach the repair packet's Original user goal", async () => {
  forgetInjections();
  const registry = new Registry();
  const s = session(registry, "goal-continuity-session");
  const binding = {
    id: "goal-continuity-binding",
    sessionId: s.id,
    noteKey: noteKeyFor(s),
  } as WorkflowBinding;

  // 1. The human states the goal.
  submitPrompt(registry, HUMAN_GOAL);
  assert.equal(registry.getGoal(s.id)?.prompt, HUMAN_GOAL, "precondition: the ask is the Goal");

  // 2 and 3. Foreman's completion review holds the turn, delivers its packet, and the agent
  // reports that packet back through its own prompt hook. This is the step that decided the
  // outcome, and it happens BEFORE any run exists - which is why freezing alone could not
  // save it.
  recordInjection(s.id, FOREMAN_PACKET, "foreman");
  submitPrompt(registry, FOREMAN_PACKET);

  // The packet never reached the Goal at all, which is what this change is for. Asserted
  // beside the frozen ask rather than instead of it: since #990 the freeze prefers the durable
  // OBJECTIVE, which an arriving packet cannot move once one exists, so the end-to-end
  // assertion below would now hold even with this guard removed. This line is the one that
  // fails without it, and the prompt and focus it covers are what drive the session card,
  // Foreman's completion verification and the intent reconciler.
  assert.equal(registry.getGoal(s.id)?.prompt, HUMAN_GOAL, "the packet never reached the Goal");
  assert.equal(registry.getGoal(s.id)?.focus, HUMAN_GOAL, "nor the focus the card shows");

  // 4. The session settles again and the workflow run freezes the ask it will review against.
  const frozen = readWorkflowIntentSnapshot(registry, binding);
  assert.ok(frozen, "a bound live conversation must freeze an ask");
  assert.equal(frozen.rawGoal, HUMAN_GOAL, "the run must freeze the human's ask, not the packet");

  const captured = await readWorkflowContextRaw(registry, binding, [], [], frozen);
  assert.equal(captured.raw.primaryGoal.rawPrompt, HUMAN_GOAL);

  // 5. The review fails, and Mission Control renders the packet the agent reads next.
  const context = fallbackWorkflowContext(captured.raw, null);
  const { version, run, submission, attempts } = reviewFixtures(context);
  const rendered = renderWorkflowFeedback({
    workflowName: "No-Mistakes Review",
    version,
    run,
    submission,
    attempts,
  });

  // The line the operator read, and the whole point of the change.
  assert.match(
    rendered.payload,
    new RegExp(`Original user goal:\\n${HUMAN_GOAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    "the repair packet must quote the human's goal",
  );
  assert.equal(
    rendered.payload.includes("Foreman's completion review found blocking work"),
    false,
    "and must not quote Foreman's complaint back as the ask",
  );

  // The recursion this closes: a packet captured as the goal is a packet whose own
  // "Original user goal:" heading ends up nested inside the next round's.
  assert.equal(
    rendered.payload.split("Original user goal:").length - 1,
    1,
    "exactly one goal heading, not one per round survived",
  );
});

test("without the authorship record the packet still takes the session Goal", async () => {
  // The control, and the reason the assertions above mean something: everything is identical
  // except that Foreman's delivery is not written down, which is the state the daemon was in
  // for the restart continuation and the state any future sender that forgets to reserve will
  // be in.
  //
  // What it can still show changed while this branch was open. #990 now freezes the durable
  // OBJECTIVE as the review contract rather than the latest prompt, so the frozen ask survives
  // an unrecorded packet on its own - a second line of defence this test is glad to find. The
  // contamination it guards is therefore asserted where it still happens, at the source: the
  // session Goal's prompt and focus, which drive the card, Foreman's completion verification
  // and the intent reconciler, and which are what the freeze falls back to for any run whose
  // conversation has no objective yet.
  forgetInjections();
  const registry = new Registry();
  const s = session(registry, "goal-continuity-control");

  submitPrompt(registry, HUMAN_GOAL);
  assert.equal(registry.getGoal(s.id)?.prompt, HUMAN_GOAL, "precondition: the ask is the Goal");

  submitPrompt(registry, FOREMAN_PACKET); // delivered, but never recorded

  const goal = registry.getGoal(s.id);
  assert.equal(
    goal?.prompt?.startsWith("Foreman's completion review"),
    true,
    "an unrecorded packet still takes the Goal's prompt",
  );
  assert.equal(
    goal?.focus?.startsWith("Foreman's completion review"),
    true,
    "and the focus the session card shows",
  );
  // The durable objective is what #990 freezes, and it is only intact because the packet
  // arrived after one was already established. It is not a substitute for refusing the packet:
  // a conversation with no objective yet has nothing else to fall back to.
  assert.equal(goal?.objective, HUMAN_GOAL, "the durable objective is the surviving copy");
});
