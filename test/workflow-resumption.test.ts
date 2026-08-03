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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { InspectorComment, InspectorPr, Session } from "../src/shared/types.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { InjectDeps, PromptWriteGuard } from "../src/server/actions.ts";
import type {
  WorkflowBindingDefaults,
  WorkflowCompletionPolicy,
  WorkflowResumptionPolicy,
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
const { setWorkflowConfig } = await import("../src/server/workflows/config.ts");
const { setForemanConfig } = await import("../src/server/foreman/config.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { buildApp } = await import("../src/server/routes.ts");

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
function harness(sessionId: string, resumptionIntervalMs?: number): Harness {
  const registry = new Registry();
  registry.applyDiscovery([discovered({
    syntheticId: sessionId,
    terminals: [mkMuxHandle({ paneId: `%${sessionId.length}` })],
  })]);
  const queues = new QueueManager(registry);
  const personas = new PersonaManager(registry);
  const store = new WorkflowStore();
  const injected: string[] = [];
  const head = { sha: "head-1" };
  const probe: Probe = { headSha: "head-1", workingTreeStatus: [], diffFingerprint: "content-1" };
  const transcript = { anchor: 0 };
  const manager = new WorkflowManager(registry, store, {
    queueManager: queues,
    requireSkill: () => ({ ok: true, command: "/mission-pull-request" }),
    ...(resumptionIntervalMs === undefined ? {} : { resumptionIntervalMs }),
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
    readEvidenceProbe: async () => ({
      ...probe,
      headSha: head.sha,
      diffFingerprint: `${head.sha}:${probe.diffFingerprint}`,
    }),
    readContextRaw: async (_registry, binding) => {
      const raw = {
        primaryGoal: { rawPrompt: "Ship the feature", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude" as const, name: sessionId, cwd: "/repo", branch: "feature" },
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
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    queues,
    undefined,
    personas,
    manager,
  );
  return { registry, store, manager, app, injected, head, probe, transcript };
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
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: paneId },
    prCreated: false,
  });
  assert.equal(h.registry.getSession(sessionId)?.state, "idle", "the Stop hook did not land");
}

// Live delivery consent, so the repair packet is really typed into the pane. Foreman is
// enabled only so the control arms below can create a `foreman_complete` binding at all; every
// AUTO assertion in this file is reached with no Foreman queue and no drain guard whatsoever.
setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
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
): Promise<Harness & { runId: string; bindingId: string; agentSessionId: string; paneId: string }> {
  seedVersion(versionId, PERSONA_GRAPH, { kind: "none" }, {
    triggerMode: "manual",
    deliveryMode: "live",
    maxRepairRounds: 5,
  }, resumptionPolicy);
  const h = harness(sessionId, resumptionIntervalMs);
  Object.assign(h.probe, initialProbe);
  const paneId = `%${sessionId.length}`;
  const agentSessionId = `agent-${sessionId}`;
  // Bind the conversation BEFORE the binding exists, so the note key is stable for the rest
  // of the run and a later idle report cannot look like a new conversation.
  h.registry.applyHook({
    agent: "claude",
    event: "PreToolUse",
    sessionId: agentSessionId,
    cwd: "/repo",
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
  // The load-bearing counter-example. That policy is resolved by pushing a head the Inspector
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
  assert.match(h.injected[0]!, /wait for Inspector to review that new head\.$/);

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
