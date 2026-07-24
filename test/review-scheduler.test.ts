import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { LlmRunner, LlmRunnerId } from "../src/shared/llm.ts";
import type { PersonaExecutionView, WorkflowBinding } from "../src/shared/workflow.ts";
import type { WorkflowRawCaptureRead } from "../src/server/workflows/context.ts";

// What is at stake: the daemon promises ONE ceiling on tool-less review work, and it used to
// be half a promise. `WorkflowEngine` gated Persona attempts at three while context
// compaction called the provider outside that gate, so two submissions capturing at the same
// moment could put more provider children on the machine than the number the engine was
// enforcing - and a later evaluator sharing "the" limit would have inherited the same gap.
//
// These tests pin both halves: the scheduler really is a shared ceiling, and BOTH kinds of
// Workflow review work spend it. They deliberately drive the manager end to end rather than
// asserting the wiring, because the defect being prevented is a call site that skips it.

const home = mkdtempSync(join(tmpdir(), "mission-review-scheduler-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { createReviewScheduler, DEFAULT_REVIEW_CONCURRENCY } = await import(
  "../src/server/llm/review-scheduler.ts"
);

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
    pid: 1,
    tty: `ttys-${id}`,
    terminals: [],
    startedAt: 1,
  } as DiscoveredSession;
}

function seedVersion(): void {
  const db = openDb();
  const graph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      {
        id: "persona",
        kind: "persona",
        position: { x: 200, y: 0 },
        persona: {
          sourcePersonaId: "p1",
          sourceRevision: 1,
          name: "Reviewer",
          description: "",
          guidanceMarkdown: "Review it",
          runner: "claude",
          model: "fake-model",
        },
      },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "s-p", source: "session", sourcePort: "submitted", target: "persona", targetPort: "activate" },
      { id: "p-pass", source: "persona", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "p-fail", source: "persona", sourcePort: "fail", target: "end", targetPort: "terminal" },
    ],
  };
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('w', 'W', 'w', '', ?, '{"kind":"none"}', ?, 1, 'v', NULL, 1, 1)`,
  ).run(JSON.stringify({ nodes: [], edges: [] }), defaults);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('v', 'w', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(JSON.stringify(graph), defaults);
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for workflow review work");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the scheduler is a shared ceiling, not one budget per caller", async () => {
  const schedule = createReviewScheduler(2);
  let active = 0;
  let peak = 0;
  const work = async (): Promise<void> => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
  };
  // Six tasks from three unrelated callers still share one count of two.
  await Promise.all(Array.from({ length: 6 }, () => schedule(work)));
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(DEFAULT_REVIEW_CONCURRENCY, 3);
});

test("context compaction and Persona attempts spend one injected daemon budget", async () => {
  seedVersion();
  const registry = new Registry();
  registry.applyDiscovery([discovered("session-a"), discovered("session-b")]);
  const personas = new PersonaManager(registry);

  // Counted inside the WORK, not inside the scheduler: a call site that forgot to schedule
  // would still increment this, and the peak would exceed the ceiling.
  let active = 0;
  let peak = 0;
  const observed = { compactions: 0, personaCalls: 0 };
  const enter = async <T>(fn: () => Promise<T>): Promise<T> => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return await fn();
    } finally {
      active--;
    }
  };

  const runnerFor = (id: LlmRunnerId): LlmRunner => ({
    id,
    label: id,
    runInThread: null,
    sandbox: null,
    litter: null,
    killLiveRuns() {},
    run: async () => enter(async () => {
      observed.personaCalls++;
      return JSON.stringify({
        verdict: "pass",
        summary: "Intent is met",
        approvalDetails: { reason: "Intent is met", evidence: [] },
        confidence: 0.9,
      });
    }),
  });
  const resolveExecution = (snapshot: {
    runner: LlmRunnerId | null;
    model: string | null;
  }): PersonaExecutionView => ({
    runner: { id: snapshot.runner ?? "claude", source: "config", unknown: null },
    model: { id: snapshot.model ?? "fake-model", source: "config" },
  });

  const workflows = new WorkflowManager(registry, personas.store, {
    reviewScheduler: createReviewScheduler(1),
    engine: { runnerFor, resolveExecution, retryBaseMs: 1 },
    readContextRaw: async (_registry, binding: WorkflowBinding): Promise<WorkflowRawCaptureRead> => {
      const raw = {
        primaryGoal: { rawPrompt: "Review this", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
        evidence: {
          headSha: `head-${binding.noteKey}`,
          diffFingerprint: `diff-${binding.noteKey}`,
          diff: "patch",
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
          headSha: `head-${binding.noteKey}`,
          transcriptPath: null,
          transcriptSize: 1,
          repositoryFingerprint: `repo-${binding.noteKey}`,
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => enter(async () => {
      observed.compactions++;
      return fallbackWorkflowContext(raw, "test fallback");
    }),
  });
  workflows.start();

  const bindings = ["session-a", "session-b"].map((sessionId) => {
    const created = workflows.createBinding({ workflowVersionId: "v", sessionId });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("binding refused");
    return created.value;
  });
  // Both submissions in flight at once: without a shared ceiling, one session's compaction
  // would be free to overlap the other session's Persona call.
  await Promise.all(bindings.map((binding, index) =>
    workflows.submit(binding.id, { requestId: `req-${index}` })));
  await waitFor(() => observed.personaCalls === 2 && active === 0);

  assert.equal(observed.compactions, 2);
  assert.equal(observed.personaCalls, 2);
  assert.equal(peak, 1);
  await workflows.stop();
});
