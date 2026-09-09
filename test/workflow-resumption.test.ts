/**
 * What is at stake: a repair round that nobody picks up is a workflow that silently stops.
 *
 * The daemon parks a run in `waiting_for_session` in three places - a Persona failed
 * (`workflows/engine.ts`), a PR handoff was delivered (`preparePr`), or Inspector found
 * something under `restart_workflow` (`handleInspectorFindings`) - and in all three it TYPES a
 * repair packet into the agent's pane. Before this feature the packet ended by asking the model
 * to "signal completion normally", and `claimCompletion` threw that signal away for every
 * binding whose trigger mode is not `foreman_complete`. The agent repaired, reported, and the
 * run waited forever for a human to click Resubmit.
 *
 * Foreman could never be the general answer, which is why the observer exists at all: a
 * `foreman_complete` binding needs Foreman enabled, measured `hooks` + `workQueue` capability,
 * and a `foreman_queues` row with items to retire. A session bound by hand, with no work queue,
 * has none of that - and it is covered below.
 *
 * Every assertion here is the INVERSE of the stall this replaced: where a `manual` version
 * still waits (and must), that is asserted too.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { InspectorComment, InspectorPr, Session } from "../src/shared/types.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { InjectDeps, PromptWriteGuard } from "../src/server/actions.ts";
import type {
  WorkflowBindingDefaults,
  WorkflowCompletionPolicy,
  WorkflowContextSnapshot,
  WorkflowResumptionPolicy,
} from "../src/shared/workflow.ts";
import {
  workflowRunResumesItself,
  workflowRunWaitsOnOperator,
} from "../src/shared/workflow.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// MISSION_HOME *is* the state dir. Set before anything that resolves it is imported, which is
// why every server import below is dynamic - a static import would be hoisted above this line.
const home = mkdtempSync(join(tmpdir(), "workflow-resumption-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const {
  adoptInspectorPr,
  openDb,
  updateInspectorPr,
  upsertInspectorComment,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { stageAgentWorkflowEvidence } = await import("../src/server/workflows/images.ts");
const { setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
const { setForemanConfig } = await import("../src/server/foreman/config.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { buildApp } = await import("../src/server/routes.ts");
// Browser-safe and imported here on purpose: the notice is only correct if the field the
// DAEMON puts on the detail is the field the browser reads, and asserting the two halves in
// different files is how they drift.
const { runGrantNotice } = await import("../src/web/workflows/run-model.ts");

const db = openDb();

/** Far enough past every `lastActivity` this file writes that `settledIdle` is satisfied. */
const SETTLED = () => Date.now() + 600_000;

const PERSONA_GRAPH = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    {
      id: "persona",
      kind: "persona",
      position: { x: 100, y: 0 },
      persona: {
        sourcePersonaId: "resume-persona",
        sourceRevision: 1,
        name: "Resume reviewer",
        description: "",
        guidanceMarkdown: "Review.",
        runner: "claude" as const,
        model: "fake",
      },
    },
  ],
  edges: [
    { id: "activate", source: "session", sourcePort: "submitted", target: "persona", targetPort: "activate" },
    { id: "repair", source: "persona", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};

const PASS_THROUGH_GRAPH = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 160, y: 0 } },
  ],
  edges: [
    { id: "done", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" },
  ],
};

/** A persona that always fails, so round 1 really parks in `waiting_for_session`. */
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
      summary: "One issue",
      requestedChanges: [{
        title: "Fix it",
        rationale: "The evidence requires it.",
        evidence: [{ kind: "diff", quote: "bad line" }],
      }],
      confidence: 1,
    });
  },
};

function discovered(over: Partial<DiscoveredSession> & { syntheticId: string }): DiscoveredSession {
  return {
    agent: "claude",
    name: over.syntheticId,
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 4000 + over.syntheticId.length,
    tty: `tty-${over.syntheticId}`,
    terminals: [],
    startedAt: 1,
    ...over,
  } as DiscoveredSession;
}

function seedVersion(
  id: string,
  graph: unknown,
  policy: WorkflowCompletionPolicy,
  defaults: WorkflowBindingDefaults,
  resumptionPolicy: WorkflowResumptionPolicy | null,
): void {
  const graphJson = JSON.stringify(graph);
  const policyJson = JSON.stringify(policy);
  const defaultsJson = JSON.stringify(defaults);
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       resumption_policy, binding_defaults_json, draft_revision, current_version_id,
       archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', '{"nodes":[],"edges":[]}', ?, ?, ?, 1, ?, NULL, 1, 1)`,
  ).run(`wf-${id}`, `Resume ${id}`, `resume ${id}`, policyJson, resumptionPolicy, defaultsJson, id);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, resumption_policy, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, 1)`,
  ).run(id, `wf-${id}`, graphJson, policyJson, resumptionPolicy, defaultsJson);
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5_000) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Probe {
  headSha: string | null;
  workingTreeStatus: string[];
  diffFingerprint: string;
}

interface Harness {
  registry: InstanceType<typeof Registry>;
  store: InstanceType<typeof WorkflowStore>;
  manager: InstanceType<typeof WorkflowManager>;
  app: ReturnType<typeof buildApp>;
  injected: string[];
  head: { sha: string };
  probe: Probe;
  duringProbe: { fn: (() => void) | null };
  /**
   * The transcript anchor a CAPTURE would read. Deliberately not on `Probe`: the observer's
   * pre-filter is repository-only, and this exists so a test can move the transcript without
   * moving the work and prove the observer stays put.
   */
  transcript: { anchor: number };
}

/**
 * One daemon-shaped stack: real Registry, real store, real manager, real HTTP app.
 *
 * The two injected seams are the two that leave the process. `readContextRaw` stands in for
 * the git + transcript read a capture does, and `readEvidenceProbe` for the cheap `git
 * rev-parse` / `git status` / `stat` the observer does. They are kept CONSISTENT on purpose:
 * `probe` is what the observer will read next, and moving `head.sha` moves both, exactly as a
 * real commit would.
 */
function harness(
  sessionId: string,
  resumptionIntervalMs?: number,
  cwd = "/repo",
  parkedReminderMs?: number,
): Harness {
  const registry = new Registry();
  registry.applyDiscovery([discovered({
    syntheticId: sessionId,
    cwd,
    gitRoot: cwd,
    repoRoot: cwd,
    terminals: [mkMuxHandle({ paneId: `%${sessionId.length}` })],
  })]);
  const queues = new QueueManager(registry);
  const personas = new PersonaManager(registry);
  const store = new WorkflowStore();
  const injected: string[] = [];
  const head = { sha: "head-1" };
  const probe: Probe = { headSha: "head-1", workingTreeStatus: [], diffFingerprint: "content-1" };
  /** Run once inside the next repository read. See `readEvidenceProbe` below. */
  const duringProbe: { fn: (() => void) | null } = { fn: null };
  const transcript = { anchor: 0 };
  const manager = new WorkflowManager(registry, store, {
    queueManager: queues,
    requireSkill: () => ({ ok: true, command: "/mission-pull-request" }),
    ...(resumptionIntervalMs === undefined ? {} : { resumptionIntervalMs }),
    ...(parkedReminderMs === undefined ? {} : { parkedReminderMs }),
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
    readEvidenceProbe: async () => {
      // Fired INSIDE the read, which is the only place a test can stand in the window the
      // reminder's rechecks exist to cover: two git commands take long enough for a session
      // to pick up its turn, and every gate after this await is asked because of it.
      duringProbe.fn?.();
      return {
        ...probe,
        headSha: head.sha,
        diffFingerprint: `${head.sha}:${probe.diffFingerprint}`,
      };
    },
    readContextRaw: async (_registry, binding) => {
      const raw = {
        primaryGoal: { rawPrompt: "Ship the feature", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude" as const, name: sessionId, cwd, branch: "feature" },
        evidence: {
          headSha: head.sha,
          diffFingerprint: `${head.sha}:${probe.diffFingerprint}`,
          diff: "patch",
          diffTruncated: false,
          workingTreeDirty: probe.workingTreeStatus.length > 0,
          workingTreeStatus: [...probe.workingTreeStatus],
          workingTreeStatusTruncated: false,
          transcript: [],
          transcriptAnchor: transcript.anchor,
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
  const app = buildApp({
    registry,
    reviews: new ReviewManager(registry),
    tasks: new TaskManager(registry),
    queues,
    personas,
    workflows: manager,
  });
  return { registry, store, manager, app, injected, head, probe, transcript, duringProbe };
}

/**
 * Report the session idle, exactly as the harness's Stop hook would.
 *
 * `agentSessionId` is passed so the note key never MOVES: a hook that rebinds the card would
 * pause the binding under the run (`conversation_changed`), which is a different behaviour
 * from the one under test.
 */
function reportIdle(
  h: Harness,
  sessionId: string,
  agentSessionId: string,
  paneId: string,
): void {
  h.registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: agentSessionId,
    cwd: h.registry.getSession(sessionId)?.cwd ?? "/repo",
    transcriptPath: null,
    env: { tmuxPane: paneId },
    prCreated: false,
  });
  assert.equal(h.registry.getSession(sessionId)?.state, "idle", "the Stop hook did not land");
}

// Live delivery consent, so the repair packet is really typed into the pane. Foreman is
// enabled only so the control arms below can create a `foreman_complete` binding at all; every
// AUTO assertion in this file is reached with no Foreman queue and no drain guard whatsoever.
setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] });
setForemanConfig({ enabled: true });

// ---------------------------------------------------------------------------
// Phase 1: `persona_feedback`.
// ---------------------------------------------------------------------------

async function personaFeedbackRun(
  sessionId: string,
  versionId: string,
  resumptionPolicy: WorkflowResumptionPolicy | null,
  resumptionIntervalMs?: number,
  initialProbe?: Partial<Probe>,
  cwd = "/repo",
  over?: { maxRepairRounds?: number; parkedReminderMs?: number },
): Promise<Harness & { runId: string; bindingId: string; agentSessionId: string; paneId: string }> {
  seedVersion(versionId, PERSONA_GRAPH, { kind: "none" }, {
    triggerMode: "manual",
    deliveryMode: "live",
    maxRepairRounds: over?.maxRepairRounds ?? 5,
  }, resumptionPolicy);
  const h = harness(sessionId, resumptionIntervalMs, cwd, over?.parkedReminderMs);
  Object.assign(h.probe, initialProbe);
  const paneId = `%${sessionId.length}`;
  const agentSessionId = `agent-${sessionId}`;
  // Bind the conversation BEFORE the binding exists, so the note key is stable for the rest
  // of the run and a later idle report cannot look like a new conversation.
  h.registry.applyHook({
    agent: "claude",
    event: "PreToolUse",
    sessionId: agentSessionId,
    cwd,
    transcriptPath: null,
    env: { tmuxPane: paneId },
    prCreated: false,
  });
  h.manager.start();
  const bound = h.manager.createBinding({ workflowVersionId: versionId, sessionId });
  assert.equal(bound.ok, true, "binding was refused");
  const bindingId = bound.ok ? bound.value.id : "";
  assert.equal(h.store.getBinding(bindingId)?.triggerMode, "manual");

  const submitted = await h.manager.submit(bindingId, { requestId: "round-1" });
  assert.equal(submitted.ok, true, "round 1 submission failed");
  const runId = submitted.ok ? submitted.value.run.id : "";
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session"
      && h.store.getRun(runId)?.currentPhase === "persona_feedback",
    "round 1 never parked in waiting_for_session/persona_feedback",
  );
  await waitFor(
    () => h.store.listDeliveries(runId)[0]?.state === "delivered",
    "the repair packet was never delivered to the pane",
  );
  return { ...h, runId, bindingId, agentSessionId, paneId };
}

test("auto: a parked persona_feedback round resumes itself once the agent settles", async () => {
  const h = await personaFeedbackRun("auto-persona", "v-auto-persona", "auto");
  assert.equal(h.injected.length, 1);
  // The packet no longer asks the model to signal anything, because nothing listens.
  assert.ok(h.injected[0]!.endsWith("then verify the work."), h.injected[0]);
  assert.doesNotMatch(h.injected[0]!, /signal completion/);
  assert.equal(h.store.listSubmissions(h.runId).length, 1);

  // No Foreman queue, no drain guard, no `foreman_complete` binding: this is exactly the case
  // the Foreman path could never serve, because `retireDrainGuard` needs a `foreman_queues`
  // row with items and this session has never had one.
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM foreman_queues WHERE note_key = ?`)
      .get(h.agentSessionId) as { n: number }).n,
    0,
    "the fixture must not have armed a Foreman queue",
  );

  // The agent did the repair and stopped.
  h.head.sha = "head-2";
  reportIdle(h, "auto-persona", h.agentSessionId, h.paneId);
  await h.manager.sweepResumptions(SETTLED());

  const submissions = h.store.listSubmissions(h.runId);
  assert.equal(submissions.length, 2, "the observer did not open round 2");
  assert.equal(submissions[1]!.round, 2);
  assert.equal(submissions[1]!.triggerSource, "session");
  assert.equal(submissions[1]!.triggerKey, `resume:${h.runId}:${submissions[0]!.evidenceFingerprint}`);
  assert.equal(
    h.store.listEvents(h.runId).some((event) => event.kind === "resumption_started"),
    true,
  );
  await h.manager.stop();
});

test("manual: the identical run still waits for a human", async () => {
  // The whole point of the version-immutable policy. A published version that never opted in
  // behaves exactly as it did, which is what makes upgrading safe.
  const h = await personaFeedbackRun("manual-persona", "v-manual-persona", "manual");
  h.head.sha = "head-2";
  reportIdle(h, "manual-persona", h.agentSessionId, h.paneId);
  await h.manager.sweepResumptions(SETTLED());

  assert.equal(h.store.listSubmissions(h.runId).length, 1);
  assert.equal(h.store.getRun(h.runId)?.status, "waiting_for_session");
  await h.manager.stop();
});

test("legacy: a version row written before the column existed reads as manual", async () => {
  // NULL is not "unset, so pick the new default". It is a version published by a build with
  // no such concept, and reading it as `auto` would start resubmitting runs on machines that
  // merely upgraded.
  const h = await personaFeedbackRun("legacy-persona", "v-legacy-persona", null);
  assert.equal(
    h.store.getWorkflowVersionById("v-legacy-persona")?.resumptionPolicy,
    "manual",
  );
  h.head.sha = "head-2";
  reportIdle(h, "legacy-persona", h.agentSessionId, h.paneId);
  await h.manager.sweepResumptions(SETTLED());

  assert.equal(h.store.listSubmissions(h.runId).length, 1);
  await h.manager.stop();
});

test("the run summary carries the two facts that decide whether anyone is owed a turn", async () => {
  // A parked run is invisible unless a surface can tell "the daemon will reopen this in
  // fifteen seconds" from "only a human ever will". Neither fact was on the summary, so no
  // surface could, and every parked run was silently read as the first kind.
  //
  // Read off the pinned VERSION and the BINDING - the same pair `resumableRun` consults - so
  // the summary cannot promise a resumption the observer will not perform.
  const auto = await personaFeedbackRun("summary-auto", "v-summary-auto", "auto");
  const autoSummary = auto.store.runSummary(auto.runId);
  assert.equal(autoSummary?.status, "waiting_for_session");
  assert.equal(autoSummary?.resumptionPolicy, "auto");
  assert.equal(autoSummary?.deliveryMode, "live");
  assert.equal(workflowRunResumesItself(autoSummary!), true);
  assert.equal(
    workflowRunWaitsOnOperator(autoSummary!),
    false,
    "an auto+live run is the daemon's to reopen, not a person's",
  );
  await auto.manager.stop();

  const manual = await personaFeedbackRun("summary-manual", "v-summary-manual", "manual");
  const manualSummary = manual.store.runSummary(manual.runId);
  assert.equal(manualSummary?.resumptionPolicy, "manual");
  assert.equal(workflowRunResumesItself(manualSummary!), false);
  assert.equal(
    workflowRunWaitsOnOperator(manualSummary!),
    true,
    "nothing but a human Resubmit moves a manual run, so it is owed to a person",
  );
  await manual.manager.stop();

  // NULL reads as `manual` here too, and for the same reason the version row does: a version
  // published before the column existed is standing still, and a summary that reported it as
  // self-resuming would leave it out of the very counts that exist to find it.
  const legacy = await personaFeedbackRun("summary-legacy", "v-summary-legacy", null);
  const legacySummary = legacy.store.runSummary(legacy.runId);
  assert.equal(legacySummary?.resumptionPolicy, "manual");
  assert.equal(workflowRunWaitsOnOperator(legacySummary!), true);
  await legacy.manager.stop();
});

test("unchanged evidence leaves the run WAITING, and never blocks or re-captures", async () => {
  const h = await personaFeedbackRun("idle-persona", "v-idle-persona", "auto");
  let captures = 0;
  const submissionsBefore = h.store.listSubmissions(h.runId).length;
  // Count captures by watching for a new submission row; the probe short-circuit means the
  // capture path must not be entered at all.
  reportIdle(h, "idle-persona", h.agentSessionId, h.paneId);
  for (let tick = 0; tick < 5; tick++) {
    await h.manager.sweepResumptions(SETTLED());
    captures += h.store.listSubmissions(h.runId).length - submissionsBefore;
  }
  assert.equal(captures, 0, "an idle session with unchanged work opened a round");
  const run = h.store.getRun(h.runId)!;
  assert.equal(run.status, "waiting_for_session", "a quiet tick converted waiting into blocked");
  assert.notEqual(run.currentPhase, "unchanged_evidence");
  assert.equal(
    h.store.listEvents(h.runId).some((event) => event.kind === "resubmit_refused_unchanged"),
    false,
    "the observer must not consume a round to discover nothing changed",
  );

  // And a probe that DOES move is what wakes it - here through the working tree alone, with
  // HEAD unchanged, which is the ordinary "repaired but not yet committed" shape.
  h.probe.workingTreeStatus = [" M src/file.ts"];
  await h.manager.sweepResumptions(SETTLED());
  assert.equal(h.store.listSubmissions(h.runId).length, 2);
  await h.manager.stop();
});

test("content changes inside the same dirty paths resume the next repair round", async () => {
  const h = await personaFeedbackRun(
    "content-persona",
    "v-content-persona",
    "auto",
    undefined,
    {
      workingTreeStatus: [" M src/already-dirty.ts"],
      diffFingerprint: "failed-round-bytes",
    },
  );

  // The repair edits bytes in that same file, so HEAD and `git status --porcelain` remain
  // byte-for-byte identical. Only the captured diff fingerprint moves.
  h.probe.diffFingerprint = "repaired-bytes";
  reportIdle(h, "content-persona", h.agentSessionId, h.paneId);
  await h.manager.sweepResumptions(SETTLED());

  const submissions = h.store.listSubmissions(h.runId);
  assert.equal(submissions.length, 2, "the content-only repair did not open a new submission");
  const repair = submissions[1]!;
  assert.equal(repair.round, 2);
  assert.equal(repair.triggerSource, "session");
  assert.equal(repair.triggerKey, `resume:${h.runId}:${submissions[0]!.evidenceFingerprint}`);
  assert.notEqual(repair.evidenceFingerprint, submissions[0]!.evidenceFingerprint);

  // Demonstrate the complete handoff, not only insertion of a submission row: round 2 is
  // captured, reviewed, and its next repair packet reaches the bound live session.
  await waitFor(
    () => h.store.listDeliveries(h.runId).some((delivery) =>
      delivery.submissionId === repair.id && delivery.state === "delivered"),
    "round 2 was not reviewed and delivered back to the bound session",
  );
  assert.equal(h.injected.length, 2);
  assert.equal(h.store.getRun(h.runId)?.status, "waiting_for_session");
  assert.equal(h.store.getRun(h.runId)?.currentPhase, "persona_feedback");
  assert.equal(
    h.store.listEvents(h.runId).some((event) => event.kind === "resumption_started"),
    true,
  );
  await h.manager.stop();
});

test("a paused or orphaned binding is not resumed", async () => {
  const h = await personaFeedbackRun("paused-persona", "v-paused-persona", "auto");
  h.head.sha = "head-2";
  reportIdle(h, "paused-persona", h.agentSessionId, h.paneId);
  const paused = h.store.pauseBinding(h.bindingId, "conversation_changed");
  assert.ok(paused, "the fixture could not pause the binding");
  await h.manager.sweepResumptions(SETTLED());
  assert.equal(h.store.listSubmissions(h.runId).length, 1);
  await h.manager.stop();
});

test("a session that is still working, or needs you, is left alone", async () => {
  const h = await personaFeedbackRun("busy-persona", "v-busy-persona", "auto");
  h.head.sha = "head-2";
  // Never reported idle: the last hook this session sent was a tool call, so it is still
  // acting on the packet that was just typed into it.
  assert.equal(h.registry.getSession("busy-persona")?.state, "working");
  await h.manager.sweepResumptions(SETTLED());
  assert.equal(h.store.listSubmissions(h.runId).length, 1);

  // Idle but parked on a menu. `settledIdle` says "stopped"; `reportBucket` says "stopped
  // ON YOU", and those are different questions - handing this session another round of work
  // would type into a pane that is waiting for someone to answer a prompt.
  reportIdle(h, "busy-persona", h.agentSessionId, h.paneId);
  h.registry.applyDiscovery([discovered({
    syntheticId: "busy-persona",
    terminals: [mkMuxHandle({ paneId: h.paneId })],
    agentSessionId: h.agentSessionId,
    paneDialog: {
      source: "pane",
      prompt: "Do you want to proceed?",
      highlighted: 1,
      options: [
        { number: 1, label: "Yes" },
        { number: 2, label: "No" },
      ],
    },
  })]);
  assert.ok(h.registry.getSession("busy-persona")?.paneDialog, "the dialog did not land");
  await h.manager.sweepResumptions(SETTLED());
  assert.equal(h.store.listSubmissions(h.runId).length, 1);
  await h.manager.stop();
});

test("an undelivered packet is not resumed past", async () => {
  // Preview delivery never types, so the packet sits `prepared` forever. Resuming there would
  // spend the whole repair budget submitting evidence the agent was never asked to change.
  seedVersion("v-preview-persona", PERSONA_GRAPH, { kind: "none" }, {
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
  }, "auto");
  const h = harness("preview-persona");
  const paneId = "%16";
  h.registry.applyHook({
    agent: "claude",
    event: "PreToolUse",
    sessionId: "agent-preview-persona",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: paneId },
    prCreated: false,
  });
  h.manager.start();
  const bound = h.manager.createBinding({
    workflowVersionId: "v-preview-persona",
    sessionId: "preview-persona",
  });
  assert.equal(bound.ok, true);
  const submitted = await h.manager.submit(bound.ok ? bound.value.id : "", { requestId: "pv-1" });
  assert.equal(submitted.ok, true);
  const runId = submitted.ok ? submitted.value.run.id : "";
  await waitFor(
    () => h.store.listDeliveries(runId)[0]?.state === "prepared",
    "the preview packet was never prepared",
  );
  assert.equal(h.injected.length, 0, "preview delivery must not type");

  h.head.sha = "head-2";
  reportIdle(h, "preview-persona", "agent-preview-persona", paneId);
  await h.manager.sweepResumptions(SETTLED());
  assert.equal(h.store.listSubmissions(runId).length, 1);
  await h.manager.stop();
});

test("the repair budget still ends the run through the existing round_limit path", async () => {
  seedVersion("v-limit-persona", PERSONA_GRAPH, { kind: "none" }, {
    triggerMode: "manual",
    deliveryMode: "live",
    maxRepairRounds: 1,
  }, "auto");
  const h = harness("limit-persona");
  const paneId = "%14";
  h.registry.applyHook({
    agent: "claude",
    event: "PreToolUse",
    sessionId: "agent-limit-persona",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: paneId },
    prCreated: false,
  });
  h.manager.start();
  const bound = h.manager.createBinding({
    workflowVersionId: "v-limit-persona",
    sessionId: "limit-persona",
  });
  assert.equal(bound.ok, true);
  const submitted = await h.manager.submit(bound.ok ? bound.value.id : "", { requestId: "lim-1" });
  assert.equal(submitted.ok, true);
  const runId = submitted.ok ? submitted.value.run.id : "";
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session",
    "round 1 never parked",
  );
  await waitFor(
    () => h.store.listDeliveries(runId)[0]?.state === "delivered",
    "the packet never reached the pane",
  );

  // Round 1 of 1: resuming would open round 2, which is over budget.
  h.head.sha = "head-2";
  reportIdle(h, "limit-persona", "agent-limit-persona", paneId);
  await h.manager.sweepResumptions(SETTLED());
  assert.equal(h.store.listSubmissions(runId).length, 2, "round 2 is the last permitted one");

  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session"
      && h.store.latestSubmission(runId)?.round === 2,
    "round 2 never parked",
  );
  h.head.sha = "head-3";
  reportIdle(h, "limit-persona", "agent-limit-persona", paneId);
  await h.manager.sweepResumptions(SETTLED());
  const run = h.store.getRun(runId)!;
  assert.equal(run.status, "blocked");
  assert.equal(run.currentPhase, "round_limit", "the observer invented a new refusal");
  assert.equal(h.store.listSubmissions(runId).length, 2);
  await h.manager.stop();
});

test("auto-resumed rounds surface the member that keeps rejecting the same work", async () => {
  // The alert half of this feature. Burning the budget unattended is the risk auto-resumption
  // introduces, and `repeatOffenders` already knew how to spot it - it was just invisible to
  // anyone who had not opened run detail.
  const h = await personaFeedbackRun("repeat-persona", "v-repeat-persona", "auto");
  // One store, many runs in this file, so read only this one's signals.
  const mine = () => h.manager.repeatOffenderSignals().filter((o) => o.runId === h.runId);
  assert.deepEqual(mine(), [], "one failing round is not a loop");

  h.head.sha = "head-2";
  reportIdle(h, "repeat-persona", h.agentSessionId, h.paneId);
  await h.manager.sweepResumptions(SETTLED());
  await waitFor(
    () => h.store.getRun(h.runId)?.status === "waiting_for_session"
      && h.store.latestSubmission(h.runId)?.round === 2,
    "round 2 never parked",
  );

  const signals = mine();
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.runId, h.runId);
  assert.equal(signals[0]!.personaName, "Resume reviewer");
  assert.equal(signals[0]!.rounds, 2);
  assert.equal(signals[0]!.round, 2);
  assert.equal(signals[0]!.maxRepairRounds, 5);
  assert.equal(signals[0]!.sessionId, "repeat-persona");
  // Memoized on the run row, so the away watcher asking every few seconds does not re-walk
  // every submission and attempt.
  assert.deepEqual(mine(), signals);
  await h.manager.stop();
});

// ---------------------------------------------------------------------------
// Phase 2: `pr_handoff`.
// ---------------------------------------------------------------------------

test("auto: a parked pr_handoff round resumes itself", async () => {
  seedVersion(
    "v-auto-prhandoff",
    PASS_THROUGH_GRAPH,
    { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "offer_prepare_pr" },
    { triggerMode: "manual", deliveryMode: "live", maxRepairRounds: 5 },
    "auto",
  );
  const h = harness("auto-prhandoff");
  const paneId = "%13";
  h.registry.applyHook({
    agent: "claude",
    event: "PreToolUse",
    sessionId: "agent-auto-prhandoff",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: paneId },
    prCreated: false,
  });
  h.manager.start();
  const bound = h.manager.createBinding({
    workflowVersionId: "v-auto-prhandoff",
    sessionId: "auto-prhandoff",
  });
  assert.equal(bound.ok, true);
  const submitted = await h.manager.submit(bound.ok ? bound.value.id : "", { requestId: "pr-1" });
  assert.equal(submitted.ok, true);
  const runId = submitted.ok ? submitted.value.run.id : "";
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_pr",
    "the passed submission never reached waiting_for_pr",
  );
  const prepared = await h.manager.preparePr(runId, "handoff-1");
  assert.equal(prepared.ok, true, "preparePr was refused");
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_session"
      && h.store.getRun(runId)?.currentPhase === "pr_handoff",
    "preparePr never parked the run",
  );
  await waitFor(
    () => h.store.listDeliveries(runId).some((item) =>
      item.kind === "pr_handoff" && item.state === "delivered"),
    "the PR handoff packet was never delivered",
  );
  assert.match(h.injected[0]!, /^\/mission-pull-request/);
  assert.doesNotMatch(h.injected[0]!, /signal completion/);

  h.head.sha = "head-2";
  reportIdle(h, "auto-prhandoff", "agent-auto-prhandoff", paneId);
  await h.manager.sweepResumptions(SETTLED());
  const submissions = h.store.listSubmissions(runId);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1]!.round, 2);
  assert.equal(submissions[1]!.triggerSource, "session");
  await h.manager.stop();
});

// ---------------------------------------------------------------------------
// Phase 3: `inspector_findings`, and the counter-example beside it.
// ---------------------------------------------------------------------------

async function inspectorFindingsRun(
  sessionId: string,
  agentSessionId: string,
  versionId: string,
  prNumber: number,
  onFindings: "restart_workflow" | "inspector_only",
): Promise<Harness & { runId: string; paneId: string; agentSessionId: string }> {
  const key = `owner/repo#${prNumber}`;
  const url = `https://github.com/owner/repo/pull/${prNumber}`;
  const parkedStatus = onFindings === "inspector_only" ? "waiting_for_new_head" : "waiting_for_session";
  seedVersion(
    versionId,
    PASS_THROUGH_GRAPH,
    { kind: "inspector", onFindings, missingPrAction: "wait" },
    { triggerMode: "manual", deliveryMode: "live", maxRepairRounds: 5 },
    "auto",
  );
  const pr: InspectorPr = {
    key,
    url,
    owner: "owner",
    repo: "repo",
    number: prNumber,
    repoRoot: "/repo",
    cwd: "/repo",
    sessionId,
    source: "hook",
    state: "open",
    headSha: null,
    reviewPosture: null,
    round: 0,
    lastReviewedAt: null,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: null,
    mergedAt: null,
    mergeBlock: null,
    observedHeadSha: null,
    observedState: null,
    observedAt: null,
    headRefName: null,
    title: null,
    adoptedAt: 1,
    updatedAt: 1,
  };
  adoptInspectorPr(pr);
  setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });

  const h = harness(sessionId);
  const paneId = `%${sessionId.length}`;
  h.registry.applyHook({
    agent: "claude",
    event: "PostToolUse",
    sessionId: agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: paneId },
    prUrl: url,
    prCreated: false,
  });
  h.manager.start();
  const bound = h.manager.createBinding({ workflowVersionId: versionId, sessionId });
  assert.equal(bound.ok, true, "binding was refused");
  assert.equal(h.store.getBinding(bound.ok ? bound.value.id : "")?.noteKey, agentSessionId);

  const submitted = await h.manager.submit(bound.ok ? bound.value.id : "", { requestId: "insp-1" });
  assert.equal(submitted.ok, true);
  const runId = submitted.ok ? submitted.value.run.id : "";
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_inspector",
    "the passed submission never entered the Inspector gate",
  );

  updateInspectorPr(key, {
    headSha: h.head.sha,
    lastAttemptSha: h.head.sha,
    reviewPosture: "live",
    round: 1,
    lastReviewedAt: Date.now(),
  }, Date.now());
  const finding: InspectorComment = {
    id: `finding-${prNumber}`,
    prKey: key,
    fingerprint: `finding-${prNumber}`,
    path: "src/file.ts",
    line: 5,
    title: "Repair this",
    body: "The pinned head is not safe.",
    severity: "major",
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: 3,
    updatedAt: 3,
  };
  upsertInspectorComment(finding);
  h.registry.inspectionUpdated(key, h.head.sha, "OPEN", Date.now() + 1_000);
  await waitFor(
    () => h.store.getRun(runId)?.status === parkedStatus
      && h.store.getRun(runId)?.currentPhase === "inspector_findings",
    `Inspector findings never parked the run in ${parkedStatus}`,
  );
  await waitFor(
    () => h.store.listDeliveries(runId).some((item) =>
      item.kind === "inspector_feedback" && item.state === "delivered"),
    "the Inspector findings packet was never delivered",
  );
  return { ...h, runId, paneId, agentSessionId };
}

test("auto: parked inspector_findings under restart_workflow resumes itself", async () => {
  const h = await inspectorFindingsRun(
    "auto-inspector",
    "agent-auto-inspector",
    "v-auto-inspector",
    81,
    "restart_workflow",
  );
  assert.ok(h.injected[0]!.endsWith("Fix the findings, verify the work, then commit and push it."), h.injected[0]);
  assert.doesNotMatch(h.injected[0]!, /signal completion/);

  h.head.sha = "head-2";
  reportIdle(h, "auto-inspector", h.agentSessionId, h.paneId);
  await h.manager.sweepResumptions(SETTLED());
  const submissions = h.store.listSubmissions(h.runId);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1]!.triggerSource, "session");
  await h.manager.stop();
});

test("inspector_only findings park in waiting_for_new_head, which the observer NEVER touches", async () => {
  // The load-bearing counter-example. That policy is resolved by pushing a head the GitHub Inspector
  // poller observes; resubmitting there would rerun a review that already passed against a
  // pull request the Inspector has not looked at again. It also keeps its own instruction,
  // which is still literally true.
  const h = await inspectorFindingsRun(
    "only-inspector",
    "agent-only-inspector",
    "v-only-inspector",
    82,
    "inspector_only",
  );
  assert.equal(h.store.getRun(h.runId)?.status, "waiting_for_new_head");
  assert.match(h.injected[0]!, /wait for GitHub Inspector to review that new head\.$/);

  h.head.sha = "head-2";
  reportIdle(h, "only-inspector", h.agentSessionId, h.paneId);
  for (let tick = 0; tick < 3; tick++) await h.manager.sweepResumptions(SETTLED());

  assert.equal(h.store.getRun(h.runId)?.status, "waiting_for_new_head");
  assert.equal(h.store.listSubmissions(h.runId).length, 1);
  await h.manager.stop();
});

test("a transcript that grew but no work that changed does not spend a round", async () => {
  // Delivering the repair packet IS a transcript write - the injected prompt lands as a
  // `UserPromptSubmit`. So the transcript anchor has already moved by the time the agent is
  // asked to do anything, and it is the one probe field that moves for free. If that alone
  // wakes the observer, a session whose hooks have lapsed (still reading `idle` because
  // nothing reported it working) resubmits the SAME code into the SAME personas, fails
  // identically, and does it again - burning the whole repair budget without a line changing.
  const h = await personaFeedbackRun("chatty-persona", "v-chatty-persona", "auto");
  reportIdle(h, "chatty-persona", h.agentSessionId, h.paneId);

  // The transcript grew. HEAD did not move and the working tree is byte-identical.
  h.transcript.anchor += 4096;
  await h.manager.sweepResumptions(SETTLED());

  assert.equal(
    h.store.listSubmissions(h.runId).length,
    1,
    "a transcript-only change opened a repair round with no repair in it",
  );
  assert.equal(h.store.getRun(h.runId)?.status, "waiting_for_session");
  await h.manager.stop();
});

test("new staged text evidence re-arms an auto repair without a commit", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "workflow-evidence-resumption-")));
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".gitignore"), "evidence/\n");
    mkdirSync(join(repo, "evidence"));
    const focusedOutput = "TAP version 13\nok 13 - evidence-only repair\n";
    writeFileSync(join(repo, "evidence", "focused.tap"), focusedOutput);
    setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo", repo] });
    const h = await personaFeedbackRun(
      "evidence-persona",
      "v-evidence-persona",
      "auto",
      undefined,
      undefined,
      repo,
    );
    const binding = h.store.getBinding(h.bindingId)!;
    const staged = await stageAgentWorkflowEvidence({
      store: h.store,
      noteKey: binding.noteKey,
      task: {
        repoRoot: repo,
        worktreePath: repo,
        baseSha: null,
        extraRepos: [],
      },
      fallbackRoot: repo,
      images: [],
      artifacts: [{
        kind: "text",
        clientItemId: "focused-log",
        path: "evidence/focused.tap",
        caption: "Focused regression output",
        repositoryScope: "repo-01",
      }],
    });
    assert.equal(staged.generation, 1);

    reportIdle(h, "evidence-persona", h.agentSessionId, h.paneId);
    await h.manager.sweepResumptions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(h.runId).length === 2,
      "text evidence did not open the next repair submission",
    );
    const submissions = h.store.listSubmissions(h.runId);
    const repair = submissions[1]!;
    await waitFor(
      () => {
        const context = h.store.getSubmission(repair.id)?.context as
          | { evidence?: { artifacts?: unknown[] } }
          | undefined;
        return context?.evidence?.artifacts?.length === 1;
      },
      "the text artifact was not frozen into the repair submission",
    );
    const captured = h.store.getSubmission(repair.id)?.context as unknown as WorkflowContextSnapshot;
    assert.equal(captured.evidence.artifacts?.[0]?.content, focusedOutput);
    assert.equal(captured.evidence.stagedImageGeneration, 1);
    assert.notEqual(repair.evidenceFingerprint, submissions[0]!.evidenceFingerprint);
    await h.manager.stop();
  } finally {
    setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Granting rounds to a run whose loop is supposed to close itself.
// ---------------------------------------------------------------------------

/**
 * Drive a persona run until its budget is gone and the observer has blocked it.
 *
 * The blocked state is produced BY the observer rather than written by hand, because the
 * thing under test is what a grant does to a run the observer stopped - and a hand-written
 * `round_limit` row would not carry the parked phase the real path records.
 */
async function spentPersonaRun(
  sessionId: string,
  versionId: string,
  resumptionPolicy: WorkflowResumptionPolicy | null,
): Promise<Harness & { runId: string; bindingId: string; agentSessionId: string; paneId: string }> {
  const h = await personaFeedbackRun(
    sessionId,
    versionId,
    resumptionPolicy,
    undefined,
    undefined,
    "/repo",
    { maxRepairRounds: 1 },
  );
  // Driven by hand rather than by the sweep, so the same helper reaches the spent state under
  // BOTH resumption policies - a `manual` version is never touched by the observer, and that
  // is the whole point of the counter-example this feeds.
  h.head.sha = "head-2";
  reportIdle(h, sessionId, h.agentSessionId, h.paneId);
  const second = await h.manager.resubmit(h.runId, { requestId: "spend-1", evidence: [] });
  assert.equal(second.ok, true, "round 2 was refused");
  await waitFor(
    () => h.store.latestSubmission(h.runId)?.round === 2
      && h.store.getRun(h.runId)?.status === "waiting_for_session",
    "round 2 never parked",
  );
  // Round 2 of 1, so the next attempt is over budget. Under `auto` the observer is what
  // discovers that; under `manual` the observer never looks at the run at all, so the manual
  // round is. Both go through the one store helper, so both record the parked phase - which
  // is the fact the grant under test reads back.
  h.head.sha = "head-3";
  reportIdle(h, sessionId, h.agentSessionId, h.paneId);
  await h.manager.sweepResumptions(SETTLED());
  if (h.store.getRun(h.runId)?.currentPhase !== "round_limit") {
    const over = await h.manager.resubmit(h.runId, { requestId: "spend-2", evidence: [] });
    assert.equal(over.ok, false, "an over-budget manual round was accepted");
    assert.equal(over.ok === false ? over.reason : "", "round_limit");
  }
  assert.equal(h.store.getRun(h.runId)?.currentPhase, "round_limit", "the run never went spent");
  return h;
}

/**
 * The half of the grant that was missing, and the reason it read as a button that did nothing.
 *
 * `grantRepairRounds` raised the budget and left the run `blocked`, on the documented grounds
 * that "the resumption observer is not involved". That was true of every version published
 * before built-in 7 and false of every one after it: `sweepResumptions` filters on
 * `waiting_for_session` and nothing else, so on precisely the workflows whose posture is
 * "the loop closes itself", the grant was the one place it could not. The operator saw a
 * primary swap label and a run that never moved again without a second click.
 */
test("a grant hands a self-resuming run back to its own observer", async () => {
  const h = await spentPersonaRun("grant-auto", "v-grant-auto", "auto");
  const granted = h.manager.grantRepairRounds(h.runId, { requestId: "grant-1", rounds: 2 });
  assert.equal(granted.ok, true, "the grant was refused");

  const run = h.store.getRun(h.runId)!;
  assert.equal(run.maxRepairRounds, 3, "the budget did not move");
  assert.equal(run.status, "waiting_for_session", "the grant left the run where nothing polls it");
  assert.equal(
    run.currentPhase,
    "persona_feedback",
    "the grant restored a phase the run was never parked in",
  );

  // And the observer now does the rest, with no second click - but only because the session
  // actually did something. That is the safety property the restore inherits for free.
  h.head.sha = "head-4";
  reportIdle(h, "grant-auto", h.agentSessionId, h.paneId);
  await h.manager.sweepResumptions(SETTLED());
  await waitFor(
    () => h.store.latestSubmission(h.runId)?.round === 3,
    "the granted round never opened by itself",
  );
  assert.equal(h.store.latestSubmission(h.runId)?.triggerSource, "session");
  await h.manager.stop();
});

/**
 * The grant has to still be readable on a run long enough to have needed one.
 *
 * The notice was first derived in the browser by scanning `detail.events`, and those are a
 * page - the OLDEST two hundred rows, plus a cursor an operator has to click for the rest. A
 * grant cannot happen until a run has exhausted its repair budget, so it is a late event by
 * construction, and a run that spent five rounds is exactly the run whose first two hundred
 * events are all older than it. The notice would have been missing on every run that had
 * actually been granted anything - the reported silence, restored by the fix for it.
 *
 * The filler is written BEFORE the grant, which is the mechanism rather than a detail of the
 * fixture: the page is `id > 0 ORDER BY id ASC LIMIT 200`, so what hides a grant is the two
 * hundred rounds' worth of history in front of it, not anything that happens afterwards.
 */
test("the grant survives being pushed off the event page", async () => {
  const h = await spentPersonaRun("grant-paged", "v-grant-paged", "auto");
  for (let index = 0; index < 201; index += 1) {
    h.store.appendEvent(h.runId, "resumption_withheld", {
      submissionId: null,
      round: null,
      reason: "session_busy",
    });
  }
  const granted = h.manager.grantRepairRounds(h.runId, { requestId: "grant-paged-1", rounds: 2 });
  assert.equal(granted.ok, true, "the grant was refused");

  const detail = h.store.runDetail(h.runId)!;
  assert.equal(
    detail.events.some((event) => event.kind === "repair_rounds_granted"),
    false,
    "the fixture failed to push the grant off the page, so this proves nothing",
  );
  assert.deepEqual(detail.repairGrant, { round: 2, from: 1, to: 3 });
  assert.equal(
    runGrantNotice(detail),
    "Repair budget raised. Round 4 is now the last this run can reach.",
  );
  await h.manager.stop();
});

/**
 * A replayed grant is that grant, and the route says so.
 *
 * The action store deliberately RETAINS its request id across a failed response, so a network
 * error on a grant that actually committed comes back with the same id. The manager has always
 * answered that with `idempotent: true` off the event ledger; what was missing was the route
 * passing it on, and then anything pinning either half - which is why a reader could
 * reasonably conclude the flag was hard-coded false.
 *
 * Driven through the HTTP route rather than the manager, because the manager's half was never
 * the doubtful one: the question is what a browser is told.
 */
test("a replayed grant is reported as a replay, and grants nothing twice", async () => {
  const h = await spentPersonaRun("grant-replay", "v-grant-replay", "auto");
  const grant = async (): Promise<Response> =>
    await h.app.request(`/api/workflow-runs/${h.runId}/grant-rounds`, {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "grant-replay-1", rounds: 2 }),
    });

  const first = await grant();
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { idempotent: boolean }).idempotent, false);
  assert.equal(h.store.getRun(h.runId)?.maxRepairRounds, 3);

  const replay = await grant();
  assert.equal(replay.status, 200, "a replay must not come back as the run_not_waiting refusal");
  assert.equal(
    (await replay.json() as { idempotent: boolean }).idempotent,
    true,
    "a replay reported as a fresh grant is the distinction this field exists to draw",
  );
  assert.equal(
    h.store.getRun(h.runId)?.maxRepairRounds,
    3,
    "the replay granted a second pair of rounds",
  );
  await h.manager.stop();
});

/**
 * The counter-example, and the reason the restore is conditional rather than unconditional.
 *
 * Nothing is coming for a `manual` run. Restoring its status would replace an honest "this
 * stopped" with a "still working" that no observer is working on - which is the exact trade
 * the Inspector arm of this method already exists to refuse.
 */
test("a grant on a run that does not resume itself leaves it blocked for a human", async () => {
  const h = await spentPersonaRun("grant-manual", "v-grant-manual", "manual");
  const granted = h.manager.grantRepairRounds(h.runId, { requestId: "grant-2", rounds: 2 });
  assert.equal(granted.ok, true);
  const run = h.store.getRun(h.runId)!;
  assert.equal(run.maxRepairRounds, 3, "the budget did not move");
  assert.equal(run.status, "blocked", "a manual run was told it was working again");
  assert.equal(run.currentPhase, "round_limit");

  // The manual round is still available and still opens the next one, exactly as before.
  const resumed = await h.manager.resubmit(h.runId, { requestId: "manual-1", evidence: [] });
  assert.equal(resumed.ok, true, "the granted budget did not reach the manual round");
  assert.equal(h.store.latestSubmission(h.runId)?.round, 3);
  await h.manager.stop();
});

/**
 * A run blocked by a build that never recorded its parked phase must not be guessed at.
 *
 * Restoring one of those into a phase whose branch never ran is worse than leaving it where
 * it is, so absence keeps the behaviour the run was blocked under.
 */
test("a grant leaves a run blocked when the parked phase was never recorded", async () => {
  const h = await spentPersonaRun("grant-legacy", "v-grant-legacy", "auto");
  // Exactly what a pre-feature daemon wrote: the budget, and nothing else.
  h.store.setRunState(h.runId, "blocked", "round_limit", {
    maxRepairRounds: h.store.getRun(h.runId)!.maxRepairRounds,
  });
  const granted = h.manager.grantRepairRounds(h.runId, { requestId: "grant-3", rounds: 2 });
  assert.equal(granted.ok, true);
  assert.equal(h.store.getRun(h.runId)?.status, "blocked");
  assert.equal(h.store.getRun(h.runId)?.maxRepairRounds, 3, "the budget still moved");
  await h.manager.stop();
});

// ---------------------------------------------------------------------------
// Saying why a parked round is standing still.
// ---------------------------------------------------------------------------

function withheldReasons(h: Harness, runId: string): string[] {
  return h.store.listEvents(runId)
    .filter((event) => event.kind === "resumption_withheld")
    .map((event) => {
      const payload = event.payload;
      return payload && typeof payload === "object" && !Array.isArray(payload)
        ? String(payload.reason)
        : "";
    });
}

/**
 * The quietest failure the repair loop had.
 *
 * Every gate in `resumableRun` used to be a bare `return null`. A session that was told what
 * to fix and simply never acted looked exactly like a session that was busy, for as long as
 * it took a human to give up and click - and clicking spent a round to discover the tree was
 * untouched. Runs sat like that for most of a working day.
 */
test("the observer records why it withheld, as a transition rather than a tick", async () => {
  const h = await personaFeedbackRun("withheld", "v-withheld", "auto");
  reportIdle(h, "withheld", h.agentSessionId, h.paneId);

  // Nothing changed in the repository, which is the reason an operator will meet most often -
  // and it is not a fault. It is the observer correctly refusing to spend a round.
  await h.manager.sweepResumptions(SETTLED());
  assert.deepEqual(withheldReasons(h, h.runId), ["repository_unchanged"]);

  // Ticking again does not repeat it. The sweep runs every fifteen seconds and a run can sit
  // parked for hours; a reason that has not changed is not news, and a per-tick event would
  // bury the ledger a person reads to find out what happened.
  await h.manager.sweepResumptions(SETTLED());
  await h.manager.sweepResumptions(SETTLED());
  assert.deepEqual(withheldReasons(h, h.runId), ["repository_unchanged"]);

  // A DIFFERENT reason is news, and lands in order. Together they are the account of the run.
  h.registry.applyHook({
    agent: "claude",
    event: "PreToolUse",
    sessionId: h.agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: h.paneId },
    prCreated: false,
  });
  await h.manager.sweepResumptions(SETTLED());
  assert.deepEqual(withheldReasons(h, h.runId), ["repository_unchanged", "session_busy"]);

  /*
   * And a reason that COMES BACK is recorded again, which is the half that makes the last
   * entry readable as the current one.
   *
   * De-duplicating globally on (submission, reason) would skip this write, because
   * `repository_unchanged` is already in the ledger - and `session_busy` would then stand as
   * the newest entry for the rest of the round. The header reads the newest entry, so it
   * would go on saying "the session is still working" about a session that had been idle for
   * an hour. A chat turn, a hook, or a test run is enough to produce that, so it is the
   * ordinary case rather than a corner of one.
   *
   * What keeps the ledger small is that a new entry costs a real session state change, not a
   * tick: the three sweeps above wrote one entry between them.
   */
  reportIdle(h, "withheld", h.agentSessionId, h.paneId);
  await h.manager.sweepResumptions(SETTLED());
  await h.manager.sweepResumptions(SETTLED());
  assert.deepEqual(
    withheldReasons(h, h.runId),
    ["repository_unchanged", "session_busy", "repository_unchanged"],
    "a reason that returns is the current one and has to be recorded as such",
  );
  assert.equal(
    h.store.runDetail(h.runId)?.resumption?.reason,
    "repository_unchanged",
    "the header must report what holds now, not the newest reason it had never seen before",
  );
  await h.manager.stop();
});

/**
 * Run detail carries the answer, as its own field.
 *
 * Deriving it from `events` would answer correctly on a short run and silently stop answering
 * on a long one, because `events` is a page - which is exactly backwards, since the runs that
 * accumulate hundreds of events are the ones whose history is hardest to read.
 */
test("run detail carries the withheld reason, and drops it once the run moves", async () => {
  const h = await personaFeedbackRun("withheld-detail", "v-withheld-detail", "auto");
  reportIdle(h, "withheld-detail", h.agentSessionId, h.paneId);
  await h.manager.sweepResumptions(SETTLED());

  const parked = h.store.runDetail(h.runId)!;
  assert.equal(parked.resumption?.reason, "repository_unchanged");
  assert.equal(parked.resumption?.round, 1);
  assert.equal(parked.resumption?.resumesItself, true, "an auto/live run must read as self-resuming");

  // Once the run is no longer parked the reason is history, and the ledger already holds it.
  // Repeating it in the header would explain a state the run has left.
  h.head.sha = "head-2";
  await h.manager.sweepResumptions(SETTLED());
  await waitFor(
    () => h.store.latestSubmission(h.runId)?.round === 2,
    "the moved head never opened a round",
  );
  assert.equal(h.store.runDetail(h.runId)?.resumption, null);
  await h.manager.stop();
});

/**
 * The reminder that ends a silent stall.
 *
 * Reached only when every other gate has passed: the version resumes itself, the binding is
 * live, the session is present, settled and not waiting on a human, and its packet was
 * confirmed delivered. What is left is a session that was told what to fix, is not busy, and
 * has not touched the tree. The unchanged-evidence nudge cannot help there - it fires on a
 * capture refusal, which the automatic path never reaches.
 */
test("a parked round with a delivered packet and no work gets exactly one reminder", async () => {
  const h = await personaFeedbackRun(
    "parked-nudge",
    "v-parked-nudge",
    "auto",
    undefined,
    undefined,
    "/repo",
    { parkedReminderMs: 0 },
  );
  assert.equal(h.injected.length, 1, "only the repair packet has been typed so far");
  reportIdle(h, "parked-nudge", h.agentSessionId, h.paneId);

  await h.manager.sweepResumptions(SETTLED());
  await waitFor(
    () => h.store.listDeliveries(h.runId).some((delivery) =>
      delivery.kind === "parked_repair_reminder" && delivery.state === "delivered"),
    "the parked round was never reminded",
  );
  const reminder = h.injected.at(-1)!;
  assert.match(reminder, /This repair round has been open for/);
  assert.match(reminder, /no change to the\nrepository/);
  // It repeats what was asked rather than merely complaining that nothing happened.
  assert.match(reminder, /The review packet you were handed asked for this:/);
  // And it does not accuse: the session never claimed to be finished, so the blunt
  // unchanged-evidence wording would be answering a claim nobody made.
  assert.doesNotMatch(reminder, /reported complete/);

  // Exactly one. A reminder that repeats is a session's context spent on the daemon asking
  // the same question, and the second one has never unstuck anything.
  await h.manager.sweepResumptions(SETTLED());
  await h.manager.sweepResumptions(SETTLED());
  assert.equal(
    h.store.listDeliveries(h.runId).filter((d) => d.kind === "parked_repair_reminder").length,
    1,
  );
  assert.equal(h.injected.length, 2, "the session was reminded more than once");
  await h.manager.stop();
});

/**
 * The reminder is the one delivery nothing is waiting for, so it is the one that must be
 * droppable.
 *
 * Everything the sweep checked can stop being true while the reminder's own two git reads
 * are running - a session picks up its turn, hits a permission prompt, or lands the repair -
 * and the reminder is written to lose that race rather than win it: no row, no packet, and
 * the next sweep reconsiders from nothing. A repair packet cannot behave that way, because
 * the round does not proceed without it. A courtesy reminder typed into a session that has
 * just started working is pure interruption, and one typed after the repair landed is false.
 *
 * Both cases are driven from inside the reminder's OWN repository read - the second of the
 * two the sweep makes, the observer's being the first - because that read is the only window
 * there is. Firing during the observer's read instead would prove only that the reminder
 * rechecks something, and would pass just as happily with every gate asked before the await,
 * where nothing can have changed yet.
 */
/** Fire `fn` on the Nth repository read of this sweep, counting from one. */
function onProbeCall(h: Harness, call: number, fn: () => void): void {
  let seen = 0;
  h.duringProbe.fn = () => {
    seen += 1;
    if (seen === call) fn();
  };
}

test("a reminder loses every race it can be in, and leaves nothing behind", async () => {
  const busy = await personaFeedbackRun(
    "parked-busy", "v-parked-busy", "auto", undefined, undefined, "/repo",
    { parkedReminderMs: 0 },
  );
  reportIdle(busy, "parked-busy", busy.agentSessionId, busy.paneId);
  // The session picks up its turn while the daemon is reading the repository for the reminder.
  onProbeCall(busy, 2, () => {
    busy.registry.applyHook({
      agent: "claude",
      event: "PreToolUse",
      sessionId: busy.agentSessionId,
      cwd: "/repo",
      transcriptPath: null,
      env: { tmuxPane: busy.paneId },
      prCreated: false,
    });
  });
  await busy.manager.sweepResumptions(SETTLED());
  // `stop` awaits every tracked background task, which is what makes an assertion about a
  // delivery that must NOT exist a real one rather than a race the test happens to win.
  await busy.manager.stop();
  assert.deepEqual(
    busy.store.listDeliveries(busy.runId).filter((d) => d.kind === "parked_repair_reminder"),
    [],
    "a session that started working was reminded anyway",
  );
  // Skipped by a gate, not lost to a crash. A thrown reminder also produces no delivery, so
  // without this the assertion above would pass for entirely the wrong reason.
  assert.deepEqual(
    busy.store.listEvents(busy.runId).filter((e) => e.kind === "parked_reminder_failed"),
    [],
  );
  assert.equal(busy.injected.length, 1, "only the repair packet should have been typed");

  const repaired = await personaFeedbackRun(
    "parked-raced", "v-parked-raced", "auto", undefined, undefined, "/repo",
    { parkedReminderMs: 0 },
  );
  reportIdle(repaired, "parked-raced", repaired.agentSessionId, repaired.paneId);
  // And the repair itself lands in the same window. The reminder's whole sentence is "no
  // change to the repository", so sending it here would not be untimely, it would be untrue.
  onProbeCall(repaired, 2, () => { repaired.head.sha = "head-repaired"; });
  await repaired.manager.sweepResumptions(SETTLED());
  await repaired.manager.stop();
  assert.deepEqual(
    repaired.store.listDeliveries(repaired.runId).filter((d) => d.kind === "parked_repair_reminder"),
    [],
    "the reminder claimed nothing had changed about a repository that had",
  );
  assert.deepEqual(
    repaired.store.listEvents(repaired.runId).filter((e) => e.kind === "parked_reminder_failed"),
    [],
  );
});

// ---------------------------------------------------------------------------
// The manual round, and what it refuses to spend.
// ---------------------------------------------------------------------------

/**
 * The button used to spend a round proving what two git reads already knew.
 *
 * The observer has always declined to open a round whose repository is byte-identical to the
 * failed one. `manager.resubmit` never asked, and its capture-time guard could not catch it:
 * that guard compared the submission's identity, which includes the transcript anchor, and
 * typing the repair packet into the pane is itself a transcript write. In the ledger this was
 * measured against, twelve of twenty manually-opened rounds reviewed byte-identical trees.
 */
test("a manual round refuses work that has not moved, and spends nothing", async () => {
  const h = await personaFeedbackRun("manual-unchanged", "v-manual-unchanged", "auto");
  const refused = await h.manager.resubmit(h.runId, { requestId: "same-1", evidence: [] });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false ? refused.reason : "", "unchanged_repository");
  assert.match(
    refused.ok === false ? refused.message : "",
    /repository has not changed since round 1/,
  );
  assert.equal(h.store.listSubmissions(h.runId).length, 1, "the refusal spent a round anyway");
  assert.equal(h.store.getRun(h.runId)?.currentPhase, "unchanged_repository");

  // It is a question, not the observer's refusal. A human sometimes holds evidence the
  // repository cannot - a manual verification recorded in the transcript is the documented
  // case - so confirming proceeds, and the round is spent knowingly.
  const confirmed = await h.manager.resubmit(h.runId, {
    requestId: "same-2",
    evidence: [],
    resubmitUnchanged: true,
  });
  assert.equal(confirmed.ok, true, "the confirmed round was refused");
  assert.equal(h.store.latestSubmission(h.runId)?.round, 2);
  await h.manager.stop();
});

/**
 * The guard that had fired twice in the system's entire history.
 *
 * `evidenceFingerprint` is the submission's IDENTITY and includes the transcript anchor, so
 * it had already moved by the time anyone could resubmit. Comparing the work instead is what
 * lets the refusal mean what it says - and it is the only thing that reaches a Foreman claim,
 * which never passes through the observer's repository probe at all.
 */
test("a transcript that grew is not a repair, even when the capture is reached", async () => {
  const h = await personaFeedbackRun("fingerprint", "v-fingerprint", "auto");
  const first = h.store.latestSubmission(h.runId)!;
  assert.ok(first.repositoryFingerprint, "the capture stored no work-only fingerprint");

  // The transcript moves; the tree does not. This is what delivering the packet alone does.
  h.transcript.anchor += 4096;
  const refused = await h.manager.resubmit(h.runId, {
    requestId: "grew-1",
    evidence: [],
    // Past the pre-capture probe deliberately, so the capture-time guard is the one on trial.
    resubmitUnchanged: false,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false ? refused.reason : "", "unchanged_repository");

  // Move the work, and the same capture runs: the guard is about the tree, not about caution.
  h.head.sha = "head-2";
  const accepted = await h.manager.resubmit(h.runId, { requestId: "grew-2", evidence: [] });
  assert.equal(accepted.ok, true);
  const second = h.store.latestSubmission(h.runId)!;
  assert.notEqual(
    second.repositoryFingerprint,
    first.repositoryFingerprint,
    "a moved head left the work-only fingerprint unchanged",
  );
  await h.manager.stop();
});
