import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-plan-publication-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { openDb } = await import("../src/server/db.ts");

function fixture(id: string, selected = false) {
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: id, agent: "claude", name: id, nameSource: "process",
    cwd: home, gitBranch: "plan", gitRoot: home, repoRoot: home,
    pid: 1, tty: null, terminals: [], startedAt: 1,
  }]);
  const session = registry.getSession(id)!;
  registry.upsertTask(mkTask({ id: `task-${id}`, kind: "plan", status: "running",
    sessionId: id, repoRoot: home, worktreePath: home, workflowId: selected ? "selected" : null }));
  const personas = new PersonaManager(registry);
  const workflows = new WorkflowManager(registry, personas.store);
  const app = buildApp({ registry, workflows, personas, tasks: new TaskManager(registry),
    reviews: new ReviewManager(registry), queues: new QueueManager(registry) });
  return { registry, session, workflows, app };
}

function bind(f: ReturnType<typeof fixture>, triggerMode: "manual" | "foreman_complete" = "manual") {
  const versionId = `version-${f.session.id}`;
  const db = openDb();
  // Deliberately no Persona. Evidence eligibility cannot stand in for PR ownership.
  const graph = JSON.stringify({ nodes: [
    { id: "s", kind: "session", position: { x: 0, y: 0 } },
    { id: "e", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
  ], edges: [{ id: "se", source: "s", sourcePort: "submitted", target: "e", targetPort: "terminal" }] });
  const defaults = JSON.stringify({ triggerMode, deliveryMode: "preview", maxRepairRounds: 1 });
  db.prepare(`INSERT INTO workflow_definitions
    (id,name,normalized_name,description,draft_graph_json,completion_policy_json,binding_defaults_json,
     draft_revision,current_version_id,created_at,updated_at)
    VALUES (?,?,?,'',?,'{"kind":"none"}',?,1,?,1,1)`)
    .run(versionId, versionId, versionId, graph, defaults, versionId);
  db.prepare(`INSERT INTO workflow_versions
    (id,workflow_id,version,source_draft_revision,graph_json,completion_policy_json,binding_defaults_json,published_at)
    VALUES (?,?,1,1,?,'{"kind":"none"}',?,1)`).run(versionId, versionId, graph, defaults);
  return f.workflows.store.insertBinding({
    id: `binding-${f.session.id}`, workflowVersionId: versionId, noteKey: noteKeyFor(f.session),
    sessionId: f.session.id, sessionAgent: "claude", sessionName: f.session.name,
    sessionCwd: home, sessionRepoRoot: home, triggerMode, deliveryMode: "preview", maxRepairRounds: 1, now: 10,
  });
}

test("the same read-only context serves Foreman and the attributed MCP caller", async () => {
  const f = fixture("read-context");
  const url = `/api/sessions/${f.session.id}/plan-publication`;
  assert.deepEqual(await (await f.app.request(url, { headers: { host: "127.0.0.1:7317" } })).json(), { owner: "skill" });
  const binding = bind(f);
  assert.equal(f.workflows.agentEvidenceBinding(f.session.id), null);
  const expected = { owner: "workflow", bindingId: binding.id,
    workflowVersionId: binding.workflowVersionId, triggerMode: "manual" };
  assert.deepEqual(await (await f.app.request(url, { headers: { host: "127.0.0.1:7317" } })).json(), expected);
  const request = (body: unknown, token = true) => f.app.request("/mcp/plan-publication", {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-harness-token": ensureToken() } : {}) },
    body: JSON.stringify(body),
  });
  const identity = { env: {}, sessionId: f.session.id, cwd: home };
  const response = await request(identity);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal((await request(identity, false)).status, 401);
  assert.equal((await request({ env: {}, sessionId: "missing", cwd: null })).status, 404);
  assert.equal((await request({ ...identity, owner: "skill" })).status, 400);
  assert.deepEqual(f.workflows.store.getBinding(binding.id), binding, "reading cannot mutate the binding");
});

test("missing selected bindings fail closed; explicit archival permits skill publication", () => {
  const f = fixture("selected-context", true);
  assert.equal(f.workflows.planPublicationContext(f.session.id).owner, "unavailable");
  const binding = bind(f, "foreman_complete");
  assert.equal(f.workflows.planPublicationContext(f.session.id).owner, "workflow");
  f.workflows.store.updateBinding(binding.id, { state: "paused" }, 20);
  assert.equal(f.workflows.planPublicationContext(f.session.id).owner, "unavailable");
  f.workflows.archiveBinding(binding.id, 30);
  assert.deepEqual(f.workflows.planPublicationContext(f.session.id), { owner: "skill" });
});
