/**
 * What is at stake: a SessionAction is the first graph node that WRITES to the operator's
 * session, and the first one whose completion produces new evidence instead of a verdict.
 * Three ways to get it wrong are all silent:
 *
 *  - completing on the session's pre-delivery idle, which is the normal state at the instant
 *    the packet is typed, so the action would "finish" before anybody read it;
 *  - reusing the parent submission, which would make upstream and downstream attempts claim
 *    they reviewed the same evidence when the action turn changed it;
 *  - opening a repair round instead of a segment, which restarts the graph at Session and
 *    spends budget an action never earned.
 *
 * Every test here drives the real Registry, store, engine and manager. There is no raw SQL and
 * no hand-written row: a test that has to fabricate state is a test proving the state is
 * unreachable in production.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { Session } from "../src/shared/types.ts";
import type { InjectDeps, PromptWriteGuard } from "../src/server/actions.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "session-action-runtime-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { SessionActionManager } = await import("../src/server/workflows/session-actions.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { setWorkflowConfig } = await import("../src/server/workflows/config.ts");

setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });

/** Far past every `lastActivity` this file writes, so `settledIdle` is satisfied. */
const SETTLED = () => Date.now() + 600_000;

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
    pid: 6000 + id.length,
    tty: `tty-${id}`,
    terminals: [mkMuxHandle({ paneId: `%${id.length}` })],
    startedAt: 1,
  } as DiscoveredSession;
}

/** A reviewer whose verdict this file chooses, so downstream failure is drivable. */
function runner(verdict: () => "pass" | "fail"): LlmRunner {
  return {
    id: "claude",
    label: "fake",
    runInThread: null,
    sandbox: null,
    price: () => null,
    litter: null,
    killLiveRuns() {},
    async run() {
      return verdict() === "pass"
        ? JSON.stringify({
            verdict: "pass",
            summary: "Looks right.",
            approvalDetails: { reason: "The evidence supports it.", evidence: [] },
            confidence: 1,
          })
        : JSON.stringify({
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
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5_000) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface HarnessOptions {
  /** Actions in pipeline order, each a `session_turn` action unless it names a skill. */
  actions?: Array<{ id: string; prompt: string; skillId?: string | null }>;
  deliveryMode?: "preview" | "live";
  /** A reviewer AFTER the last action, so downstream activation is observable. */
  downstream?: boolean;
  verdict?: () => "pass" | "fail";
  requireSkill?: (session: Session, id: string) => { ok: true; command: string } | { ok: false; message: string };
}

async function harness(sessionId: string, options: HarnessOptions = {}) {
  const actionSpecs = options.actions ?? [{ id: "act", prompt: "# Tidy\n\nRun the tidy pass.\n" }];
  const registry = new Registry();
  registry.applyDiscovery([discovered(sessionId)]);
  const personas = new PersonaManager(registry);
  const store = personas.store;
  const actionsManager = new SessionActionManager(registry, store);
  const injected: string[] = [];
  const head = { sha: "head-1" };
  let verdictChoice: () => "pass" | "fail" = options.verdict ?? (() => "pass");
  const manager = new WorkflowManager(registry, store, {
    requireSkill: options.requireSkill
      ?? (() => ({ ok: true, command: "/mission-pull-request" })),
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
        primaryGoal: { rawPrompt: "Ship it", refined: null, sourceNoteKey: binding.noteKey },
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
      runnerFor: () => runner(() => verdictChoice()),
      resolveExecution: () => ({
        runner: { id: "claude", source: "config", unknown: null },
        model: { id: "fake", source: "config" },
      }),
    },
  });

  const upstream = personas.create({
    name: `upstream-${sessionId}`,
    description: "",
    guidanceMarkdown: "# Review",
    runner: "claude",
    model: "fake",
  });
  assert.equal(upstream.ok, true);
  const upstreamId = upstream.ok ? upstream.persona.id : "";
  let downstreamId = "";
  if (options.downstream) {
    const created = personas.create({
      name: `downstream-${sessionId}`,
      description: "",
      guidanceMarkdown: "# Review",
      runner: "claude",
      model: "fake",
    });
    assert.equal(created.ok, true);
    downstreamId = created.ok ? created.persona.id : "";
  }
  const actionIds = actionSpecs.map((spec) => {
    const created = actionsManager.create({
      name: `${spec.id}-${sessionId}`,
      description: "",
      promptMarkdown: spec.prompt,
      requiredSkillId: spec.skillId ?? null,
      completion: { kind: "session_turn" },
    });
    assert.equal(created.ok, true, `session action ${spec.id} was refused`);
    return created.ok ? created.action.id : "";
  });

  // Session -> upstream persona -> action(s) in order -> [downstream persona] -> End.
  const chain = [
    ...actionSpecs.map((spec, index) => ({ node: spec.id, actionId: actionIds[index]! })),
  ];
  const nodes: unknown[] = [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "upstream", kind: "persona", personaId: upstreamId, position: { x: 150, y: 0 } },
    ...chain.map((entry, index) => ({
      id: entry.node,
      kind: "session_action",
      sessionActionId: entry.actionId,
      position: { x: 300 + index * 150, y: 0 },
    })),
    ...(options.downstream
      ? [{ id: "downstream", kind: "persona", personaId: downstreamId, position: { x: 700, y: 0 } }]
      : []),
    { id: "end", kind: "end", outcome: "Approved", position: { x: 900, y: 0 } },
  ];
  const sequence = ["upstream", ...chain.map((entry) => entry.node)];
  if (options.downstream) sequence.push("downstream");
  const edges: unknown[] = [
    { id: "e-start", source: "session", sourcePort: "submitted", target: "upstream", targetPort: "activate" },
  ];
  for (let index = 0; index < sequence.length; index += 1) {
    const from = sequence[index]!;
    const to = sequence[index + 1] ?? "end";
    const port = from === "upstream" || from === "downstream" ? "pass" : "complete";
    const targetPort = to === "end" ? "terminal" : "activate";
    edges.push({ id: `e-${from}`, source: from, sourcePort: port, target: to, targetPort });
    if (port === "pass") {
      edges.push({
        id: `f-${from}`,
        source: from,
        sourcePort: "fail",
        target: "session",
        targetPort: "return_for_changes",
      });
    }
  }

  const created = manager.create({
    name: `Action runtime ${sessionId}`,
    description: "",
    draft: { nodes, edges } as never,
    completionPolicy: { kind: "none" },
    // The resumption observer is the OTHER way a parked round reopens and would race the
    // assertions below about which path produced round two.
    resumptionPolicy: "manual",
    bindingDefaults: {
      triggerMode: "manual",
      deliveryMode: options.deliveryMode ?? "live",
      maxRepairRounds: 8,
    },
  });
  assert.equal(created.ok, true, "the workflow was refused");
  const workflowId = created.ok ? created.workflow.id : "";
  const published = manager.publish(workflowId, 1);
  assert.equal(published.ok, true, `publish was refused: ${JSON.stringify(published)}`);
  const versionId = published.ok ? published.version.id : "";

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

  const reportIdle = (): void => {
    registry.applyHook({
      agent: "claude",
      event: "Stop",
      sessionId: `agent-${sessionId}`,
      cwd: "/repo",
      transcriptPath: null,
      env: { tmuxPane: `%${sessionId.length}` },
      prCreated: false,
    });
    assert.equal(registry.getSession(sessionId)?.state, "idle", "the Stop hook did not land");
  };

  /** The session picking the packet up, exactly as its own tool-use hook would report it. */
  const reportWorking = (): void => {
    registry.applyHook({
      agent: "claude",
      event: "PreToolUse",
      sessionId: `agent-${sessionId}`,
      cwd: "/repo",
      transcriptPath: null,
      env: { tmuxPane: `%${sessionId.length}` },
      prCreated: false,
    });
    assert.equal(registry.getSession(sessionId)?.state, "working", "the PreToolUse hook did not land");
  };

  /** One complete action turn: the session reads the packet, works, and settles. */
  const runActionTurn = (): void => {
    reportWorking();
    reportIdle();
  };

  return {
    registry,
    store,
    manager,
    injected,
    head,
    sessionId,
    versionId,
    reportIdle,
    reportWorking,
    runActionTurn,
    setVerdict: (next: () => "pass" | "fail") => { verdictChoice = next; },
    stop: () => manager.stop(),
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Bind, submit, and wait for the first action to be waiting with its packet prepared. */
async function runToAction(h: Harness): Promise<string> {
  const bound = h.manager.createBinding({
    workflowVersionId: h.versionId,
    sessionId: h.sessionId,
  });
  assert.equal(bound.ok, true, "the binding was refused");
  const bindingId = bound.ok ? bound.value.id : "";
  const submitted = await h.manager.submit(bindingId, { requestId: `submit-${h.sessionId}` });
  assert.equal(submitted.ok, true, "the submission failed");
  const runId = submitted.ok ? submitted.value.run.id : "";
  await waitFor(
    () => h.store.listSubmissions(runId)
      .some((submission) => h.store.listAttempts(submission.id)
        .some((attempt) => attempt.state === "waiting")),
    "no session action attempt ever reached the waiting state",
  );
  return runId;
}

function waitingAttempt(h: Harness, runId: string) {
  const attempts = h.store.listSubmissions(runId)
    .flatMap((submission) => h.store.listAttempts(submission.id))
    .filter((attempt) => attempt.state === "waiting");
  return attempts[0] ?? null;
}

test("an action activates as one waiting attempt, with no evaluator work and no receipt", async () => {
  const h = await harness("activation");
  try {
    const runId = await runToAction(h);
    const submission = h.store.latestSubmission(runId)!;
    const attempt = h.store.listAttempts(submission.id).find((item) => item.nodeId === "act");
    assert.ok(attempt, "the action node produced no attempt");
    assert.equal(attempt.state, "waiting");
    // Not a Persona: no snapshot, no runner, no model, no verdict, ever.
    assert.equal(attempt.persona, null);
    assert.equal(attempt.runner, null);
    assert.equal(attempt.model, null);
    assert.equal(attempt.verdict, null);
    // The frozen snapshot is on the attempt, so history and recovery never re-resolve the
    // live library entity.
    assert.equal(attempt.sessionAction?.promptMarkdown, "# Tidy\n\nRun the tidy pass.\n");
    assert.equal(attempt.sessionAction?.completion.kind, "session_turn");
    // Nothing downstream is authorized until the action turn finishes.
    assert.deepEqual(
      h.store.listReceipts(submission.id).filter((receipt) => receipt.edgeId === "e-act"),
      [],
    );
    // A waiting attempt occupies no model execution slot.
    assert.deepEqual(h.store.listRunnableAttempts(Date.now()), []);
  } finally {
    await h.stop();
  }
});

test("Live delivers the exact snapshot prompt once and parks in waiting_for_action", async () => {
  const h = await harness("live-delivery");
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const delivery = h.store.listDeliveries(runId).find((item) => item.kind === "session_action");
    assert.ok(delivery, "no session_action delivery was written");
    const attempt = waitingAttempt(h, runId)!;
    // Durably linked to the attempt that owns it, which is what keeps two action nodes in one
    // submission from being deduplicated into a single packet.
    assert.equal(delivery.nodeAttemptId, attempt.id);
    assert.equal(h.injected.length, 1);
    // The exact authored Markdown, verbatim, after a small envelope.
    assert.match(h.injected[0]!, /Mission Control session action: act-live-delivery/);
    assert.ok(h.injected[0]!.endsWith("# Tidy\n\nRun the tidy pass.\n"));
    assert.equal(h.store.getRun(runId)?.status, "waiting_for_action");
    assert.equal(h.store.getRun(runId)?.currentPhase, "session_action");
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pickup");
  } finally {
    await h.stop();
  }
});

test("Preview prepares the packet and never types it, and never completes on its own", async () => {
  const h = await harness("preview", { deliveryMode: "preview" });
  try {
    const runId = await runToAction(h);
    const delivery = h.store.listDeliveries(runId).find((item) => item.kind === "session_action");
    assert.ok(delivery, "Preview must still prepare the packet so the operator can read it");
    assert.equal(delivery.state, "prepared");
    assert.deepEqual(h.injected, [], "Preview typed into the pane");
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_send");

    // A settled, idle session is the ordinary state of a Preview target. Sweeping repeatedly
    // must not invent a completion from activity nobody attributed to this packet.
    h.reportIdle();
    for (let tick = 0; tick < 3; tick += 1) await h.manager.sweepSessionActions(SETTLED());
    assert.equal(waitingAttempt(h, runId)?.state, "waiting");
    assert.equal(h.store.listSubmissions(runId).length, 1);
    assert.deepEqual(h.injected, []);
  } finally {
    await h.stop();
  }
});

test("a settled idle BEFORE pickup never completes the action", async () => {
  const h = await harness("stale-idle");
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    // The session goes idle with NO activity after the send anchor - which is exactly what a
    // stale idle event, a resubscribed observer, or a restart looks like.
    h.reportIdle();
    const session = h.registry.getSession(h.sessionId)!;
    assert.ok(session.state === "idle", "the fixture must present an idle session");

    // `SETTLED()` is far past the settle window, so the ONLY thing standing between this and
    // a completion is the missing pickup proof.
    for (let tick = 0; tick < 3; tick += 1) await h.manager.sweepSessionActions(SETTLED());
    assert.equal(waitingAttempt(h, runId)?.state, "waiting");
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pickup");
    assert.equal(h.store.listSubmissions(runId).length, 1, "a segment was captured with no pickup");
  } finally {
    await h.stop();
  }
});

test("pickup then settled idle captures a child segment and activates only downstream", async () => {
  const h = await harness("continuation", { downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const parent = h.store.latestSubmission(runId)!;
    const attempt = waitingAttempt(h, runId)!;
    assert.equal(parent.segment, 0);

    // The session works, then settles: activity strictly after the send anchor is the pickup
    // proof, and only then does a settled idle mean the turn finished.
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "the completed action never captured a continuation segment",
    );

    const submissions = h.store.listSubmissions(runId);
    const child = submissions[1]!;
    // A SEGMENT, not a repair round: the budget is untouched.
    assert.equal(child.round, parent.round);
    assert.equal(child.segment, 1);
    assert.equal(child.parentSubmissionId, parent.id);
    assert.equal(child.continuationNodeId, "act");
    assert.equal(child.continuationNodeAttemptId, attempt.id);
    assert.equal(h.store.runSummary(runId)?.round, parent.round);
    assert.equal(h.store.runSummary(runId)?.segment, 1);

    // The action attempt completed exactly once, in the PARENT submission.
    const finished = h.store.getAttempt(attempt.id)!;
    assert.equal(finished.state, "completed");
    assert.equal(finished.submissionId, parent.id);

    // Only the action's own `complete` route is seeded into the child, and the child does NOT
    // re-submit from Session - the upstream reviewer must not run again on this evidence.
    const seeded = h.store.listReceipts(child.id).find((receipt) => receipt.edgeId === "e-act");
    assert.ok(seeded, "the action's complete route was never seeded into the child");
    assert.equal(seeded.sourceAttemptId, attempt.id, "cross-submission provenance is lost");
    // Session's own `submitted` route is NOT re-seeded: a continuation resumes the action's
    // downstream path, it does not restart the graph.
    assert.equal(
      h.store.listReceipts(child.id).some((receipt) => receipt.edgeId === "e-start"),
      false,
    );
    await waitFor(
      () => h.store.listAttempts(child.id).some((item) => item.nodeId === "downstream"),
      "the downstream reviewer never activated on the child evidence",
    );
    assert.deepEqual(
      h.store.listAttempts(child.id).map((item) => item.nodeId).sort(),
      ["downstream", "end"],
    );
    // The upstream reviewer stays tied to the PARENT evidence and is never re-run.
    assert.equal(
      h.store.listAttempts(parent.id).filter((item) => item.nodeId === "upstream").length,
      1,
    );
    // Fresh evidence: the child captured the head the action turn produced.
    assert.match(JSON.stringify(child.evidence), /head-2/);
  } finally {
    await h.stop();
  }
});

test("an unchanged checkout is a legitimate action outcome, not the repair loop's refusal", async () => {
  const h = await harness("unchanged", { downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    // `head.sha` is deliberately NOT moved: an action may change only remote or conversation
    // state, so an unchanged checkout must not produce the unchanged-evidence nudge a
    // repair round would.
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "an unchanged checkout blocked the continuation",
    );
    const events = h.store.listEvents(runId).map((event) => event.kind);
    assert.equal(events.includes("resubmit_refused_unchanged"), false);
    assert.equal(
      h.store.listDeliveries(runId).some((item) => item.kind === "unchanged_evidence_nudge"),
      false,
    );
  } finally {
    await h.stop();
  }
});

test("two actions run in order in one repair round and spend no repair budget", async () => {
  const h = await harness("two-actions", {
    actions: [
      { id: "first", prompt: "# First\n\nDo the first thing.\n" },
      { id: "second", prompt: "# Second\n\nDo the second thing.\n" },
    ],
  });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the first action packet never reached the pane",
    );
    // Exactly ONE packet is live: the bound session has one turn.
    assert.equal(h.injected.length, 1);
    assert.match(h.injected[0]!, /Do the first thing/);

    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(() => h.injected.length === 2, "the second action never ran");
    assert.match(h.injected[1]!, /Do the second thing/);

    h.head.sha = "head-3";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 3,
      "the second action never captured its own segment",
    );
    const submissions = h.store.listSubmissions(runId);
    assert.deepEqual(submissions.map((item) => [item.round, item.segment]), [[1, 0], [1, 1], [1, 2]]);
    // The repair budget saw none of it.
    assert.equal(h.store.runSummary(runId)?.round, 1);
    assert.equal(
      h.store.listEvents(runId).some((event) => event.kind === "resumption_started"),
      false,
    );
  } finally {
    await h.stop();
  }
});

test("a downstream failure after a continuation starts round two at segment zero", async () => {
  const h = await harness("repair-after", { downstream: true, verdict: () => "pass" });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    // The downstream reviewer fails on the CHILD evidence.
    h.setVerdict(() => "fail");
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.getRun(runId)?.status === "waiting_for_session",
      "the downstream failure never parked the run",
    );
    const child = h.store.listSubmissions(runId).at(-1)!;
    assert.equal(child.segment, 1);

    // Repair is round + 1 at segment ZERO, and it restarts from Session.
    h.head.sha = "head-3";
    const resubmitted = await h.manager.resubmit(runId, { requestId: "repair", resubmitUnchanged: false });
    assert.equal(resubmitted.ok, true, `resubmit was refused: ${JSON.stringify(resubmitted)}`);
    const repair = h.store.listSubmissions(runId).at(-1)!;
    assert.equal(repair.round, child.round + 1);
    assert.equal(repair.segment, 0);
    assert.equal(repair.parentSubmissionId, null);
    assert.equal(repair.continuationNodeAttemptId, null);
    await waitFor(
      () => h.store.listAttempts(repair.id).some((item) => item.nodeId === "upstream"),
      "the repair round did not restart the graph at Session",
    );
  } finally {
    await h.stop();
  }
});

test("cancelling a run closes the waiting attempt and its live packet", async () => {
  const h = await harness("cancel");
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const attempt = waitingAttempt(h, runId)!;
    const cancelled = h.manager.cancel(runId, "cancel-request");
    assert.equal(cancelled.ok, true);
    assert.equal(h.store.getAttempt(attempt.id)?.state, "cancelled");

    // A cancelled run leaves nothing an observer would pick back up.
    h.reportIdle();
    for (let tick = 0; tick < 3; tick += 1) await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.listSubmissions(runId).length, 1);
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("an unavailable required skill blocks the action instead of typing anything", async () => {
  const h = await harness("skill-missing", {
    actions: [{ id: "act", prompt: "# Needs a skill\n", skillId: "pull-request" }],
    requireSkill: () => ({ ok: false, message: "Enable Skills and the pull-request skill first." }),
  });
  try {
    const bound = h.manager.createBinding({
      workflowVersionId: h.versionId,
      sessionId: h.sessionId,
    });
    assert.equal(bound.ok, true);
    const bindingId = bound.ok ? bound.value.id : "";
    const submitted = await h.manager.submit(bindingId, { requestId: "skill-missing" });
    assert.equal(submitted.ok, true);
    const runId = submitted.ok ? submitted.value.run.id : "";
    await waitFor(
      () => h.store.getRun(runId)?.currentPhase === "session_action_blocked",
      "an unavailable required skill did not block the action",
    );
    assert.equal(h.store.getRun(runId)?.status, "blocked");
    assert.deepEqual(h.injected, [], "a packet was typed despite the missing skill");
    // A block is a RUN state and never a graph outcome: no repair packet, no round spent.
    assert.equal(h.store.runSummary(runId)?.round, 1);
    assert.equal(
      h.store.listDeliveries(runId).some((item) => item.kind === "persona_feedback"),
      false,
    );
  } finally {
    await h.stop();
  }
});

test("a session that exits before its turn is observed blocks rather than completing", async () => {
  const h = await harness("session-lost");
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    h.registry.applyDiscovery([]);
    await waitFor(
      () => h.registry.getSession(h.sessionId)?.state === "exited"
        || h.registry.getSession(h.sessionId) === undefined,
      "the session never left the fleet",
    );
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.listSubmissions(runId).length, 1, "a lost session completed an action");
  } finally {
    await h.stop();
  }
});

test("a restart mid-flight never sends, completes, or captures twice", async () => {
  const h = await harness("restart", { downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    assert.equal(h.injected.length, 1);
    const attempt = waitingAttempt(h, runId)!;

    // Restart with the packet SENT and the turn not yet observed: recovery must not prepare
    // a second packet or type the same instruction again.
    await h.manager.stop();
    h.manager.start();
    // Recovery schedules its work as tasks, so drain the loop before asserting that it
    // scheduled nothing - otherwise the assertion would pass on timing rather than on rule.
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.injected.length, 1, "recovery re-typed a packet the session already had");
    assert.equal(h.store.listDeliveriesForAttempt(attempt.id).length, 1);
    assert.equal(waitingAttempt(h, runId)?.id, attempt.id);

    // Now the turn happens, and the continuation is captured.
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "the completed action never captured a continuation segment",
    );

    // Restart AFTER the child segment exists: no second segment, no second receipt, and the
    // attempt stays completed exactly once.
    await h.manager.stop();
    h.manager.start();
    for (let tick = 0; tick < 3; tick += 1) await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.listSubmissions(runId).length, 2);
    assert.equal(h.store.getAttempt(attempt.id)?.state, "completed");
    const child = h.store.listSubmissions(runId)[1]!;
    assert.equal(
      h.store.listReceipts(child.id).filter((receipt) => receipt.edgeId === "e-act").length,
      1,
    );
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("an uncertain write parks the action and is never automatically resent", async () => {
  const h = await harness("uncertain");
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const delivery = h.store.listDeliveries(runId)
      .find((item) => item.kind === "session_action")!;
    // A daemon that stopped with the row in `sending` cannot know whether the paste landed,
    // so the packet becomes uncertain - the state a human resolves.
    h.store.setDeliveryState(delivery.id, "uncertain", "daemon_restart_after_send_claim");

    await h.manager.stop();
    h.manager.start();
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    for (let tick = 0; tick < 3; tick += 1) await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.injected.length, 1, "an uncertain packet was retyped automatically");
    assert.equal(h.store.getDelivery(delivery.id)?.state, "uncertain");
    // And no turn is credited to it: an uncertain write is not proof the session read
    // anything, so even a completed turn afterwards cannot complete the action.
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.listSubmissions(runId).length, 1);
  } finally {
    await h.stop();
  }
});
