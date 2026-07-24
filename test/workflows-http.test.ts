import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-workflows-http-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { buildApp } = await import("../src/server/routes.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

function fixture() {
  clearWorkflowTables(db);
  const registry = new Registry();
  const store = new WorkflowStore(db);
  const personas = new PersonaManager(registry, store);
  const workflows = new WorkflowManager(registry, store);
  const app = buildApp(registry, null as never, null as never, null as never, undefined, personas, workflows);
  const request = (path: string, init?: RequestInit) => app.request(path, {
    ...init,
    headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers },
  });
  return { request, registry, store };
}

async function seedValid(request: ReturnType<typeof fixture>["request"]) {
  const personaResponse = await request("/api/personas", { method: "POST", body: JSON.stringify({ name: "Judge", guidanceMarkdown: "# Judge" }) });
  const persona = await personaResponse.json() as { id: string };
  const draft = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "judge", kind: "persona", personaId: persona.id, position: { x: 200, y: 0 } },
      { id: "end", kind: "end", outcome: "Approved", position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "a", source: "session", sourcePort: "submitted", target: "judge", targetPort: "activate" },
      { id: "b", source: "judge", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "c", source: "judge", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const response = await request("/api/workflows", { method: "POST", body: JSON.stringify({ name: "Review", draft }) });
  return await response.json() as { workflow: { id: string; draftRevision: number }; summary: { id: string } };
}

test("every workflow mutation uses shared parseBody schemas", async () => {
  const { request } = fixture();
  assert.equal((await request("/api/workflows", { method: "POST", body: "{}" })).status, 400);
  const valid = await seedValid(request);
  assert.equal((await request(`/api/workflows/${valid.workflow.id}`, { method: "PATCH", body: JSON.stringify({ expectedDraftRevision: 1 }) })).status, 400);
  assert.equal((await request(`/api/workflows/${valid.workflow.id}/publish`, { method: "POST", body: "{}" })).status, 400);
  assert.equal((await request(`/api/workflows/${valid.workflow.id}`, { method: "DELETE", body: "{}" })).status, 400);
});

test("definition CAS conflicts are 409 and validation failures are 422", async () => {
  const { request } = fixture();
  const invalid = await request("/api/workflows", { method: "POST", body: JSON.stringify({ name: "Incomplete" }) });
  const created = await invalid.json() as { workflow: { id: string } };
  const validation = await request(`/api/workflows/${created.workflow.id}/validate`, { method: "POST", body: JSON.stringify({ expectedDraftRevision: 1 }) });
  assert.equal(validation.status, 422);
  assert.ok((await validation.json() as { diagnostics: Array<{ code: string }> }).diagnostics.some((item) => item.code === "session_submitted_route"));

  const valid = await seedValid(request);
  assert.equal((await request(`/api/workflows/${valid.workflow.id}`, { method: "PATCH", body: JSON.stringify({ expectedDraftRevision: 1, description: "first" }) })).status, 200);
  const stale = await request(`/api/workflows/${valid.workflow.id}`, { method: "PATCH", body: JSON.stringify({ expectedDraftRevision: 1, description: "lost" }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { code: string }).code, "workflow_revision_conflict");
});

test("Publish is idempotent and immutable versions are readable", async () => {
  const { request } = fixture();
  const valid = await seedValid(request);
  const first = await request(`/api/workflows/${valid.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ expectedDraftRevision: 1 }) });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { version: { id: string; version: number; graph: { nodes: Array<{ kind: string; persona?: { guidanceMarkdown: string } }> } }; idempotent: boolean };
  assert.equal(firstBody.idempotent, false);
  assert.equal(firstBody.version.version, 1);
  assert.equal(firstBody.version.graph.nodes.find((node) => node.kind === "persona")?.persona?.guidanceMarkdown, "# Judge");
  const repeated = await request(`/api/workflows/${valid.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ expectedDraftRevision: 1 }) });
  const repeatedBody = await repeated.json() as typeof firstBody;
  assert.equal(repeatedBody.idempotent, true);
  assert.equal(repeatedBody.version.id, firstBody.version.id);
  const list = await request(`/api/workflows/${valid.workflow.id}/versions`);
  const listed = await list.json() as Array<Record<string, unknown>>;
  assert.equal(listed.length, 1);
  assert.equal("graph" in listed[0]!, false);
  const detail = await request(`/api/workflows/${valid.workflow.id}`);
  const detailBody = await detail.json() as { versions: Array<Record<string, unknown>> };
  assert.equal("graph" in detailBody.versions[0]!, false);
  const versionRead = await request(`/api/workflows/${valid.workflow.id}/versions/1`);
  assert.equal(versionRead.status, 200);
  const versionBody = await versionRead.json() as Record<string, unknown>;
  assert.equal("graph" in versionBody, true);
});

test("workflow summaries are bounded SSE projections, not graph blobs", async () => {
  const { request, registry } = fixture();
  await seedValid(request);
  const summary = registry.snapshot().workflowSummaries[0]!;
  assert.equal(summary.nodeCount, 3);
  assert.equal(summary.errorCount, 0);
  assert.equal("draft" in summary, false);
  assert.equal("guidanceMarkdown" in summary, false);
});

test("workflow history query bounds reject malformed cursors, ranges, and oversized filters", async () => {
  const { request } = fixture();
  assert.equal((await request("/api/workflow-runs?cursor=not-opaque")).status, 400);
  assert.equal((await request(`/api/workflow-runs?cursor=${"x".repeat(513)}`)).status, 400);
  assert.equal((await request("/api/workflow-runs?limit=201")).status, 400);
  assert.equal((await request("/api/workflow-runs?status=unknown")).status, 400);
  assert.equal((await request(`/api/workflow-runs?session=${"x".repeat(201)}`)).status, 400);
  assert.equal((await request("/api/workflow-runs/missing/events?after=-1")).status, 400);
  assert.equal((await request("/api/workflow-runs/missing/events?limit=201")).status, 400);
  assert.equal((await request(`/api/workflow-runs/missing/calls?after=${"x".repeat(201)}`)).status, 400);
});

test("run detail distinguishes malformed durable rows from expired history", async () => {
  const { request, store } = fixture();
  const valid = await seedValid(request);
  const publishedResponse = await request(`/api/workflows/${valid.workflow.id}/publish`, {
    method: "POST",
    body: JSON.stringify({ expectedDraftRevision: 1 }),
  });
  const published = await publishedResponse.json() as { version: { id: string } };
  const binding = store.insertBinding({
    id: "corrupt-binding",
    workflowVersionId: published.version.id,
    noteKey: "corrupt-note",
    sessionId: "corrupt-session",
    sessionAgent: "codex",
    sessionName: "Corrupt worker",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission({
    id: "corrupt-run",
    binding,
    triggerSource: "manual",
    triggerKey: "corrupt-run-trigger",
    now: 2,
  }, {
    id: "corrupt-submission",
    triggerSource: "manual",
    triggerKey: "corrupt-submission-trigger",
    context: {},
    evidence: {},
    now: 2,
  });

  const notCaptured = await request("/api/workflow-runs/corrupt-run");
  assert.equal(notCaptured.status, 200);
  assert.equal(
    (await notCaptured.json() as { contextState: string }).contextState,
    "not_captured",
  );

  db.prepare(
    `UPDATE workflow_submissions
        SET context_json = '{"compaction":{}}'
      WHERE id = 'corrupt-submission'`,
  ).run();
  const corruptContext = await request("/api/workflow-runs/corrupt-run");
  assert.equal(corruptContext.status, 200);
  assert.equal(
    (await corruptContext.json() as { contextState: string }).contextState,
    "corrupt",
  );

  db.prepare(
    `UPDATE workflow_runs SET gate_state_json = '{' WHERE id = 'corrupt-run'`,
  ).run();

  const corrupt = await request("/api/workflow-runs/corrupt-run");
  assert.equal(corrupt.status, 500);
  assert.equal(
    (await corrupt.json() as { code: string }).code,
    "workflow_run_corrupt",
  );

  const missing = await request("/api/workflow-runs/expired-run");
  assert.equal(missing.status, 404);
  assert.equal(
    (await missing.json() as { code: string }).code,
    "workflow_run_not_found",
  );
});

test("version exports use a browser-download filename and immutable schema envelope", async () => {
  const { request, store } = fixture();
  const valid = await seedValid(request);
  const publishedResponse = await request(`/api/workflows/${valid.workflow.id}/publish`, {
    method: "POST",
    body: JSON.stringify({ expectedDraftRevision: 1 }),
  });
  const published = await publishedResponse.json() as { version: { id: string } };
  const response = await request(`/api/workflows/${valid.workflow.id}/versions/1/export`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="workflow-version-1.json"',
  );
  const body = await response.json() as { schemaVersion: number; kind: string };
  assert.deepEqual(body, {
    ...body,
    schemaVersion: 1,
    kind: "workflow_version",
  });

  const binding = store.insertBinding({
    id: "browser-binding",
    workflowVersionId: published.version.id,
    noteKey: "browser-note",
    sessionId: "browser-session",
    sessionAgent: "codex",
    sessionName: "Browser worker",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission({
    id: "browser-run",
    binding,
    triggerSource: "manual",
    triggerKey: "browser-run-trigger",
    now: 2,
  }, {
    id: "browser-submission",
    triggerSource: "manual",
    triggerKey: "browser-submission-trigger",
    context: {},
    evidence: {},
    now: 2,
  });
  const runResponse = await request("/api/workflow-runs/browser-run/export");
  assert.equal(runResponse.status, 200);
  assert.equal(
    runResponse.headers.get("content-disposition"),
    'attachment; filename="workflow-run-browser-run.json"',
  );
});
