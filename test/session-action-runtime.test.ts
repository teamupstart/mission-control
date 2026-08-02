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
import type {
  SessionActionAdoptedPullRequest,
} from "../src/server/workflows/session-action-adapters.ts";
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
  /**
   * Give every action the `pull_request` completion instead of `session_turn`.
   *
   * The harness's mutable `adopted` list is then what decides whether the proof succeeds, so a
   * test states "there is an open pull request on this branch at this commit" rather than
   * arranging one on GitHub.
   */
  pullRequest?: boolean;
  deliveryMode?: "preview" | "live";
  /** A reviewer AFTER the last action, so downstream activation is observable. */
  downstream?: boolean;
  verdict?: () => "pass" | "fail";
  /**
   * Wire both actions off Session directly rather than in a chain, so they become ready in
   * the same submission. Only the raw draft API can author this; a linear pipeline cannot.
   */
  parallelActions?: boolean;
  /** Make the pane positively reject the write, the way a guard or a busy pane does. */
  refuseInject?: boolean;
  requireSkill?: (session: Session, id: string) => { ok: true; command: string } | { ok: false; message: string };
}

async function harness(sessionId: string, options: HarnessOptions = {}) {
  const actionSpecs = options.actions
    ?? (options.parallelActions
      ? [
          { id: "first", prompt: "# First\n\nDo the first thing.\n" },
          { id: "second", prompt: "# Second\n\nDo the second thing.\n" },
        ]
      : [{ id: "act", prompt: "# Tidy\n\nRun the tidy pass.\n" }]);
  const registry = new Registry();
  registry.applyDiscovery([discovered(sessionId)]);
  const personas = new PersonaManager(registry);
  const store = personas.store;
  const actionsManager = new SessionActionManager(registry, store);
  const injected: string[] = [];
  const head = { sha: "head-1" };
  /**
   * The repository and the adoption ledger, as facts a test states rather than arranges.
   *
   * `full()` is the harness's whole answer to the short-versus-full head problem the runtime
   * has to solve for real: evidence capture records an abbreviation and GitHub reports a
   * 40-character object id, so the fixture keeps the two spellings of one commit distinct and
   * `resolveCommit` maps between them exactly as `resolveCapturedCommit` does against git.
   */
  const full = (sha: string): string =>
    ([...sha].map((char) => char.charCodeAt(0).toString(16)).join("") + "0".repeat(40)).slice(0, 40);
  const repository = { root: "/repo", branch: "feature" as string | null };
  /**
   * The commit evidence capture records, when it must differ from the one the PROOF read.
   *
   * Null means "the same commit", which is the ordinary case. Setting it is how a test
   * reproduces the race the whole re-check path exists for: the adapter proves the pull
   * request at one commit and the checkout has moved by the time the capture reads it, which
   * on a real machine is an agent that pushed and then kept working.
   */
  const captureHead: { sha: string | null } = { sha: null };
  const adopted: SessionActionAdoptedPullRequest[] = [];
  let verdictChoice: () => "pass" | "fail" = options.verdict ?? (() => "pass");
  const manager = new WorkflowManager(registry, store, {
    readRepositoryHead: async () => ({
      repositoryId: repository.root,
      root: repository.root,
      branch: repository.branch,
      headOid: full(head.sha),
    }),
    adoptedPullRequests: () => adopted,
    resolveCommit: async (_root, headSha) => full(headSha),
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
      // `pasted: false` is a POSITIVE refusal: the write was attempted and the pane rejected
      // it, so nothing landed. That is a different answer from an uncertain write, and the
      // runtime treats the two differently.
      if (options.refuseInject) {
        return { ok: false, error: "pane_blocked", pasted: false, paneBlocked: true, submitVerified: false };
      }
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
          headSha: captureHead.sha ?? head.sha,
          diffFingerprint: `diff-${captureHead.sha ?? head.sha}`,
          diff: `patch at ${captureHead.sha ?? head.sha}`,
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
          headSha: captureHead.sha ?? head.sha,
          transcriptPath: null,
          transcriptSize: 0,
          repositoryFingerprint: `repo-${captureHead.sha ?? head.sha}`,
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
      completion: { kind: options.pullRequest ? "pull_request" : "session_turn" },
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
  const edges: unknown[] = [
    { id: "e-start", source: "session", sourcePort: "submitted", target: "upstream", targetPort: "activate" },
    { id: "f-upstream", source: "upstream", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ];
  if (options.parallelActions) {
    // One `pass` fans out to BOTH actions, so both become ready off the same receipt.
    for (const entry of chain) {
      edges.push({
        id: `e-fan-${entry.node}`,
        source: "upstream",
        sourcePort: "pass",
        target: entry.node,
        targetPort: "activate",
      });
      edges.push({
        id: `e-${entry.node}`,
        source: entry.node,
        sourcePort: "complete",
        target: "end",
        targetPort: "terminal",
      });
    }
  } else {
    const sequence = ["upstream", ...chain.map((entry) => entry.node)];
    if (options.downstream) sequence.push("downstream");
    for (let index = 0; index < sequence.length; index += 1) {
      const from = sequence[index]!;
      const to = sequence[index + 1] ?? "end";
      const port = from === "upstream" || from === "downstream" ? "pass" : "complete";
      const targetPort = to === "end" ? "terminal" : "activate";
      edges.push({ id: `e-${from}`, source: from, sourcePort: port, target: to, targetPort });
      if (port === "pass" && from !== "upstream") {
        edges.push({
          id: `f-${from}`,
          source: from,
          sourcePort: "fail",
          target: "session",
          targetPort: "return_for_changes",
        });
      }
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

  /** State that an open pull request for this branch now sits at the given captured head. */
  const adoptPr = (
    patch: Partial<SessionActionAdoptedPullRequest> & { atHead?: string } = {},
  ): void => {
    const { atHead, ...rest } = patch;
    adopted.push({
      key: "owner/repo#7",
      url: "https://github.com/owner/repo/pull/7",
      number: 7,
      repositoryRoot: "/repo",
      branch: "feature",
      observedHeadOid: full(atHead ?? head.sha),
      observedState: "OPEN",
      observedAt: 1,
      // Attributable to the bound session and adopted after any packet this file delivers, so
      // a test that moves the row off-branch reproduces the stray case rather than the
      // unattributable one.
      sessionId,
      adoptedAt: Number.MAX_SAFE_INTEGER,
      ...rest,
    });
  };

  return {
    registry,
    store,
    manager,
    injected,
    head,
    captureHead,
    full,
    repository,
    adopted,
    adoptPr,
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

/**
 * The action attempt's id, whatever state it has since reached.
 *
 * `waitingAttempt` answers only while it is still waiting, and the assertions that matter most
 * are about what it holds AFTERWARDS - the completed output's proven expectation, the block
 * code - so the id has to be findable by node rather than by state.
 */
function waitingActionAttemptId(h: Harness, runId: string): string {
  const attempts = h.store.listSubmissions(runId)
    .flatMap((submission) => h.store.listAttempts(submission.id))
    .filter((attempt) => attempt.sessionAction !== null);
  assert.ok(attempts.length > 0, "no session action attempt exists on this run");
  return attempts[0]!.id;
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
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.injected.length, 1, "an uncertain packet was retyped automatically");
    assert.equal(h.store.getDelivery(delivery.id)?.state, "uncertain");

    // The action BLOCKS rather than waiting forever behind a generic delivery diagnostic.
    // An action's contract is that its exact instruction ran once, so the runtime refuses to
    // guess in either direction about a write it cannot confirm.
    const attempt = h.store.listSubmissions(runId)
      .flatMap((submission) => h.store.listAttempts(submission.id))
      .find((item) => item.nodeId === "act")!;
    assert.equal(attempt.state, "error");
    assert.match(attempt.error ?? "", /delivery_uncertain/);
    assert.equal(h.store.getRun(runId)?.currentPhase, "session_action_blocked");
    // And no turn is credited to it either: a completed turn afterwards cannot complete an
    // action whose instruction may never have arrived.
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.listSubmissions(runId).length, 1);
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("marking an uncertain packet delivered reopens the action and lets it finish", async () => {
  const h = await harness("uncertain-resolved", { downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const delivery = h.store.listDeliveries(runId)
      .find((item) => item.kind === "session_action")!;
    h.store.setDeliveryState(delivery.id, "uncertain", "daemon_restart_after_send_claim");
    await h.manager.sweepSessionActions(SETTLED());
    const attemptId = h.store.listSubmissions(runId)
      .flatMap((submission) => h.store.listAttempts(submission.id))
      .find((item) => item.nodeId === "act")!.id;
    assert.equal(h.store.getAttempt(attemptId)?.state, "error");

    // The operator answers the one question the runtime would not guess at. Without this the
    // block would be terminal, and "it landed" would be an answer nothing could act on.
    const resolved = await h.manager.resolveDelivery(delivery.id, {
      resolution: "mark_delivered",
      requestId: "resolve-1",
    });
    assert.equal(resolved.ok, true, `resolve was refused: ${JSON.stringify(resolved)}`);
    assert.equal(h.store.getAttempt(attemptId)?.state, "waiting");
    assert.equal(h.store.getRun(runId)?.status, "waiting_for_action");
    // Anchored at the resolution, with no transcript offset claimed - none was ever measured.
    const state = h.store.sessionActionState(h.store.getAttempt(attemptId)!)!;
    assert.equal(state.anchor?.transcriptBytes, null);
    assert.equal(state.blocked, null);

    // And the action now completes on the ordinary turn boundary.
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "the reopened action never captured its continuation segment",
    );
    assert.equal(h.store.getAttempt(attemptId)?.state, "completed");
    assert.equal(h.injected.length, 1, "reopening retyped the packet");
  } finally {
    await h.stop();
  }
});

test("a refused packet blocks the action, and no restart quietly prepares another", async () => {
  // A GENUINE refusal: the write is attempted and the pane positively rejects it, so nothing
  // landed. That is the state the observer used to sit behind forever.
  const h = await harness("refused", { refuseInject: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((item) => item.state === "refused"),
      "the rejecting pane did not refuse the packet",
    );
    const delivery = h.store.listDeliveries(runId)
      .find((item) => item.kind === "session_action")!;
    assert.equal(delivery.state, "refused");
    assert.deepEqual(h.injected, [], "a refused packet must never reach the pane");

    await h.manager.sweepSessionActions(SETTLED());
    const attempt = h.store.listSubmissions(runId)
      .flatMap((submission) => h.store.listAttempts(submission.id))
      .find((item) => item.nodeId === "act")!;
    // Blocked with the action's OWN code, not left waiting behind a generic delivery state.
    assert.equal(attempt.state, "error");
    assert.match(attempt.error ?? "", /delivery_refused/);
    assert.equal(h.store.getRun(runId)?.status, "blocked");
    assert.equal(h.store.getRun(runId)?.currentPhase, "session_action_blocked");

    // A restart must not prepare a replacement: that would retry, on every daemon start, a
    // write the operator never re-authorized.
    await h.manager.stop();
    h.manager.start();
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.store.listDeliveriesForAttempt(attempt.id).length, 1);
    assert.deepEqual(h.injected, []);
  } finally {
    await h.stop();
  }
});

test("two actions ready at once are refused, never silently deferred", async () => {
  // A branching graph, which a linear pipeline cannot author but the raw draft API can. The
  // dangerous behaviour is running one and holding the other: the continuation seeds the
  // child with only the completed action's routes, so the held sibling's activating receipt
  // stays behind in the parent and it is never delivered at all.
  const h = await harness("parallel", { parallelActions: true });
  try {
    const bound = h.manager.createBinding({
      workflowVersionId: h.versionId,
      sessionId: h.sessionId,
    });
    assert.equal(bound.ok, true);
    const bindingId = bound.ok ? bound.value.id : "";
    const submitted = await h.manager.submit(bindingId, { requestId: "parallel" });
    assert.equal(submitted.ok, true);
    const runId = submitted.ok ? submitted.value.run.id : "";
    await waitFor(
      () => h.store.getRun(runId)?.currentPhase === "session_action_parallel_unsupported",
      "two concurrently ready actions were not refused",
    );
    assert.equal(h.store.getRun(runId)?.status, "failed");
    // Nothing was typed, and neither action was half-started.
    assert.deepEqual(h.injected, []);
    const submission = h.store.latestSubmission(runId)!;
    assert.deepEqual(
      h.store.listAttempts(submission.id).filter((item) => item.state === "waiting"),
      [],
    );
    // The diagnostic names both nodes, so a human can see which pair to chain.
    const failure = h.store.listEvents(runId).find((event) => event.kind === "workflow_failed")!;
    const payload = failure.payload as { error?: string };
    assert.match(payload.error ?? "", /first/);
    assert.match(payload.error ?? "", /second/);
  } finally {
    await h.stop();
  }
});

test("a child captured but interrupted before its receipt is sealed, not re-captured", async () => {
  const h = await harness("seal", { downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const attempt = waitingAttempt(h, runId)!;

    // Reserve and capture the child WITHOUT sealing it - the exact window where a daemon
    // stopped between "the evidence is durable" and "the receipt is written". Re-capturing
    // is impossible from here: the capture guard wants the run and submission both
    // `capturing`, and neither is any more.
    const reserved = h.store.reserveSessionActionContinuation({
      attemptId: attempt.id,
      submissionId: "sealed-child",
      triggerKey: `session_action:${attempt.id}:interrupted`,
      now: Date.now(),
    });
    assert.equal(reserved.ok, true);
    const parent = h.store.getSubmission(attempt.submissionId)!;
    h.store.updateSubmissionCapture("sealed-child", {
      context: parent.context,
      evidence: parent.evidence,
      fingerprint: "sealed-fingerprint",
      status: "running",
    }, Date.now());
    // And the engine's own recovery blocks the run, exactly as it would on restart.
    h.store.setRunState(runId, "blocked", "capture_interrupted", { error: "interrupted" });

    await h.manager.stop();
    h.manager.start();
    await waitFor(
      () => h.store.getAttempt(attempt.id)?.state === "completed",
      "the captured child was never sealed, so the run stayed stuck on a waiting attempt",
    );

    // Sealed through the recovery path specifically, not re-captured through the ordinary
    // one - which the capture guard would have refused anyway, leaving the run stuck.
    assert.equal(
      h.store.listEvents(runId).some((event) => event.kind === "session_action_continuation_resealed"),
      true,
    );
    // No SECOND child, one receipt, and the graph moved on from the reserved segment.
    assert.equal(h.store.listSubmissions(runId).length, 2);
    assert.equal(
      h.store.listReceipts("sealed-child").filter((receipt) => receipt.edgeId === "e-act").length,
      1,
    );
    await waitFor(
      () => h.store.listAttempts("sealed-child").some((item) => item.nodeId === "downstream"),
      "the downstream reviewer never activated on the resealed child",
    );
    assert.equal(h.injected.length, 1, "the packet was retyped while resealing");
  } finally {
    await h.stop();
  }
});

// ---- the pull request completion, driven through the real runtime ---------------------------
//
// The adapter's own decisions are unit-tested in `session-action-pull-request-adapter.test.ts`.
// What these prove is the WIRING: that the manager reads the repository and the ledger at the
// right moment, that a decision reaches the continuation, that the captured commit is held to
// the one the pull request was proven at, and that none of it sends or completes twice.

test("a pull request action waits after its turn until a matching pull request is adopted", async () => {
  const h = await harness("pr-wait", { pullRequest: true, downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );

    // The turn runs and settles, and the session has pushed a new commit - but nothing has
    // adopted a pull request. A `session_turn` action would be finished here.
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(waitingAttempt(h, runId)?.state, "waiting");
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pull_request");
    assert.equal(h.store.listSubmissions(runId).length, 1, "a segment was captured with no proof");

    // A pull request appears on the branch, but the poller last saw it at the OLD commit.
    h.adoptPr({ atHead: "head-1" });
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pushed_head");
    assert.equal(h.store.listSubmissions(runId).length, 1);

    // The push lands and the next poll sees it. Only now does the graph advance.
    h.adopted[0]!.observedHeadOid = h.full("head-2");
    await h.manager.sweepSessionActions(SETTLED());
        await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "a proven pull request never captured a continuation segment",
    );
    const child = h.store.listSubmissions(runId)[1]!;
    assert.equal(child.segment, 1);
    await waitFor(
      () => h.store.listAttempts(child.id).some((item) => item.nodeId === "downstream"),
      "the downstream reviewer never activated on the child evidence",
    );

    // One packet, whatever the wait cost. Waiting for a pull request must never retype.
    assert.equal(h.injected.length, 1);

    // And what was proven is on the completed attempt, which is the only durable record of it.
    const done = h.store.getAttempt(waitingActionAttemptId(h, runId))!;
    assert.equal(done.state, "completed");
    const output = done.output as { expectation?: { kind: string; expectedHeadOid?: string; pullRequestUrl?: string } };
    assert.equal(output.expectation?.kind, "pull_request");
    assert.equal(output.expectation?.expectedHeadOid, h.full("head-2"));
    assert.equal(output.expectation?.pullRequestUrl, "https://github.com/owner/repo/pull/7");
  } finally {
    await h.stop();
  }
});

test("a pull request on another branch never satisfies the action, and says which mistake it was", async () => {
  const h = await harness("pr-wrong", { pullRequest: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    h.runActionTurn();

    // Same commit, wrong branch - a stacked branch, or one that was never switched.
    h.adoptPr({ branch: "some-other-branch" });
    for (let tick = 0; tick < 3; tick += 1) await h.manager.sweepSessionActions(SETTLED());
    // Reported as its own state and NOT as `awaiting_pull_request`: an operator watching for a
    // pull request that has already been opened somewhere else is the failure this separates.
    assert.equal(h.store.runSummary(runId)?.actionWait, "pull_request_wrong_branch");
    assert.equal(h.store.listSubmissions(runId).length, 1);
    assert.equal(h.injected.length, 1);

    // Same commit and branch, another checkout entirely: the larger mistake wins.
    h.adoptPr({ key: "owner/other#1", number: 1, repositoryRoot: "/elsewhere" });
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.runSummary(runId)?.actionWait, "pull_request_wrong_repository");

    // A WAIT throughout, never a block: the turn may still open the right pull request, and
    // when it does the run advances without anything being retyped.
    assert.equal(waitingAttempt(h, runId)?.state, "waiting");
    h.adoptPr();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "the right pull request never rescued a run that had reported a stray one",
    );
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("a closed pull request at the reviewed commit blocks the run without spending a round", async () => {
  const h = await harness("pr-closed", { pullRequest: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    h.runActionTurn();
    h.adoptPr({ observedState: "CLOSED" });
    await h.manager.sweepSessionActions(SETTLED());

    const attempt = h.store.getAttempt(waitingActionAttemptId(h, runId))!;
    assert.equal(attempt.state, "error");
    assert.equal(attempt.verdict, null, "a block must never become a verdict");
    assert.equal(h.store.getRun(runId)?.status, "blocked");
    // The round is untouched: an action's block never spends repair budget, and nothing was
    // sent back to Session as a requested change.
    assert.equal(h.store.runSummary(runId)?.round, 1);
    assert.equal(h.store.listSubmissions(runId).length, 1);
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("a head that moves between the proof and the capture converges on the captured commit", async () => {
  const h = await harness("pr-head-moved", { pullRequest: true, downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );

    // The adapter proves the pull request at `head-2`, and the checkout moves to `head-3`
    // before the capture reads it - the ordinary shape of an agent that pushed and then kept
    // working. The captured child therefore holds `head-3`, which the expectation refuses.
    h.head.sha = "head-2";
    h.runActionTurn();
    h.adoptPr({ atHead: "head-2" });
    // The PROOF still reads `head-2` and matches, and the CAPTURE records `head-3`.
    h.captureHead.sha = "head-3";
    await h.manager.sweepSessionActions(SETTLED());

    // A child was reserved and captured, and the attempt is back to waiting rather than sealed
    // on evidence the pull request does not contain.
    assert.equal(waitingAttempt(h, runId)?.state, "waiting");
    assert.equal(h.store.listSubmissions(runId).length, 2, "the reservation was not reused");
    assert.equal(
      h.store.listEvents(runId).some((event) => event.kind === "session_action_expectation_unmet"),
      true,
    );
    assert.deepEqual(h.store.listReceipts(h.store.listSubmissions(runId)[1]!.id), []);

    // Re-deciding against the CAPTURED head is what converges: the checkout has moved on, so
    // the question is now "has the pull request caught up with what we captured", and a push
    // answers it. Deciding against the live head instead would chase a moving target forever -
    // and `head-4` below is exactly that moving target, present so this cannot pass by
    // accidentally agreeing with the live head.
    h.head.sha = "head-4";
    h.adopted[0]!.observedHeadOid = h.full("head-3");
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.getAttempt(waitingActionAttemptId(h, runId))?.state === "completed",
      "the action never sealed against the head its child had captured",
    );

    // Still exactly one child segment, one packet, and one receipt.
    assert.equal(h.store.listSubmissions(runId).length, 2);
    assert.equal(h.injected.length, 1);
    const child = h.store.listSubmissions(runId)[1]!;
    assert.equal(
      h.store.listReceipts(child.id).filter((receipt) => receipt.edgeId === "e-act").length,
      1,
    );
    const output = h.store.getAttempt(waitingActionAttemptId(h, runId))!.output as {
      expectation?: { expectedHeadOid?: string };
    };
    assert.equal(output.expectation?.expectedHeadOid, h.full("head-3"));
  } finally {
    await h.stop();
  }
});

test("a restart while waiting for a pull request neither retypes nor completes", async () => {
  const h = await harness("pr-restart", { pullRequest: true, downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pull_request");

    await h.manager.stop();
    h.manager.start();
    // Recovery must not prepare a second packet for an action whose only problem is that its
    // proof has not arrived: the delivery landed, and the wait is the runtime working.
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.injected.length, 1, "the packet was retyped across a restart");
    assert.equal(waitingAttempt(h, runId)?.state, "waiting");
    assert.equal(h.store.listSubmissions(runId).length, 1);

    // And the proof still lands afterwards, so the wait was a wait and not a wedge.
    h.adoptPr({ atHead: "head-2" });
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "the run never recovered once its pull request appeared",
    );
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("a pull request already open at the reviewed commit completes without a second one", async () => {
  const h = await harness("pr-existing", { pullRequest: true });
  try {
    // Adopted BEFORE the run even starts, which is the shape of a branch that already had a
    // pull request open. The action still runs its turn - the description may need updating -
    // but it must not demand that a second pull request be opened.
    const runId = await runToAction(h);
    h.adoptPr();
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "an already-matching pull request never satisfied the action",
    );
    assert.equal(h.adopted.length, 1, "the fixture adopted a second pull request");
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});
