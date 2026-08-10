import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// What is at stake: a conversation's ARMED workflow is a different fact from its runs, and it
// is the fact every "is a review coming" surface reads. Under the `foreman_complete` trigger a
// binding exists for the whole working life of a session before any run does, so a fleet that
// only streamed runs reported every armed session as unarmed - which is exactly how an
// operator came to believe a dispatch had attached the wrong workflow.

const home = mkdtempSync(join(tmpdir(), "mission-workflow-binding-sse-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { NO_MISTAKES_REVIEW_WORKFLOW_ID, builtinWorkflowVersionId } = await import(
  "../src/shared/builtin-workflow.ts"
);

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const GRAPH = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
  ],
  edges: [],
};
const DEFAULTS = JSON.stringify({
  triggerMode: "manual",
  deliveryMode: "preview",
  maxRepairRounds: 5,
});

function discovered(n: number): DiscoveredSession {
  return {
    syntheticId: `session-${n}`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: n,
    tty: `ttys${n}`,
    terminals: [],
    startedAt: 1,
  } as DiscoveredSession;
}

function seedOperatorWorkflow(): void {
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('w', 'Review', 'review', '', ?, '{"kind":"none"}', ?, 1, 'v', NULL, 1, 1)`,
  ).run(JSON.stringify(GRAPH), DEFAULTS);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('v', 'w', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(JSON.stringify(GRAPH), DEFAULTS);
}

function insertBinding(store: InstanceType<typeof WorkflowStore>, workflowVersionId: string) {
  return store.insertBinding({
    id: "b",
    workflowVersionId,
    noteKey: "note",
    sessionId: "session",
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "foreman_complete",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
}

test("an armed binding rides the snapshot with no run in existence", () => {
  clearWorkflowTables(db);
  seedOperatorWorkflow();
  const store = new WorkflowStore(db);
  insertBinding(store, "v");
  const registry = new Registry();
  new PersonaManager(registry, store);
  new WorkflowManager(registry, store);

  const summaries = registry.snapshot().workflowBindingSummaries;
  assert.equal(summaries.length, 1);
  assert.equal(registry.snapshot().workflowRunSummaries.length, 0, "no run exists yet");
  assert.equal(summaries[0]?.workflowName, "Review");
  assert.equal(summaries[0]?.workflowVersion, 1);
  assert.equal(summaries[0]?.workflowId, "w");
  assert.equal(summaries[0]?.sessionId, "session");
  assert.equal(summaries[0]?.state, "active");
  // Compact: the graph and the binding's captured session facts stay on HTTP.
  assert.equal("graph" in summaries[0]!, false);
  assert.equal("sessionCwd" in summaries[0]!, false);
});

test("a built-in binding names its workflow, which no SQL join can reach", () => {
  clearWorkflowTables(db);
  const store = new WorkflowStore(db);
  // The shipped review workflow has no `workflow_definitions` or `workflow_versions` row, so a
  // join-only resolution reports the workflow every dispatch arms as a deleted version. This
  // is the case that rendered as "builtin-" everywhere it was shown.
  insertBinding(store, builtinWorkflowVersionId("no-mistakes-review", 8));
  const registry = new Registry();
  new PersonaManager(registry, store);
  new WorkflowManager(registry, store);

  const summary = registry.snapshot().workflowBindingSummaries[0];
  assert.equal(summary?.workflowName, "No-Mistakes Review");
  assert.equal(summary?.workflowVersion, 8);
  assert.equal(summary?.workflowId, NO_MISTAKES_REVIEW_WORKFLOW_ID);
  assert.notEqual(summary?.workflowName, "Missing workflow version");
});

test("binding summaries converge through snapshot, incremental SSE, and reconnect", () => {
  clearWorkflowTables(db);
  seedOperatorWorkflow();
  const store = new WorkflowStore(db);
  const registry = new Registry();
  new PersonaManager(registry, store);
  const manager = new WorkflowManager(registry, store);
  registry.applyDiscovery([discovered(3)]);
  // Read the id back rather than assuming it: discovery owns session identity, and a
  // hard-coded synthetic id silently becomes "not live" the moment correlation changes.
  const liveSessionId = registry.snapshot().sessions.find((s) => s.state !== "exited")?.id;
  assert.ok(liveSessionId, "discovery produced a live session");

  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  // Publishing one binding must not re-read the whole table, the same property
  // `workflow-sse.test.ts` pins for runs: this fires on every arm, and a table scan per arm is
  // how a stream stops being compact.
  const listBindingSummaries = store.listBindingSummaries;
  store.listBindingSummaries = () => {
    throw new Error("incremental publication scanned the whole binding table");
  };
  let created;
  try {
    created = manager.createBinding({
      workflowVersionId: "v",
      sessionId: liveSessionId,
      triggerMode: "manual",
      deliveryMode: "preview",
      maxRepairRounds: 5,
    });
  } finally {
    store.listBindingSummaries = listBindingSummaries;
  }
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) return;

  const upserts = events.filter((event) => event.type === "workflow_binding_upsert");
  assert.equal(upserts.length, 1, "arming publishes exactly once");

  // Archiving RETIRES the binding from the stream rather than upserting a dead one: every
  // consumer asks "what is this armed with", and an archived binding is not an answer.
  manager.archiveBinding(created.value.id, 300);
  unsubscribe();
  assert.equal(
    events.some((event) => event.type === "workflow_binding_remove"),
    true,
    "archive removes rather than upserts",
  );
  assert.equal(registry.snapshot().workflowBindingSummaries.length, 0);

  // A browser reconnecting mid-stream must land on the same catalog the events built.
  const reconnect = new Registry();
  new PersonaManager(reconnect, store);
  new WorkflowManager(reconnect, store);
  assert.deepEqual(
    reconnect.snapshot().workflowBindingSummaries,
    registry.snapshot().workflowBindingSummaries,
  );
});
