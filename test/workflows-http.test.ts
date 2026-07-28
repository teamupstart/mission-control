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
const { builtinWorkflowId } = await import("../src/server/workflows/builtin-workflows.ts");

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
  const valid = await seedValid(request);
  // By id: the shipped built-in sorts ahead of "Review" in the merged catalog, and this test
  // is about the shape of a summary rather than about which one comes first.
  const summary = registry.snapshot().workflowSummaries
    .find((item) => item.id === valid.workflow.id)!;
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

// A built-in workflow is read through the routes that already exist - there is no built-in
// route, and adding one would be a second way to answer a question the catalog already
// answers. What has to be true is that every read finds it and every write refuses it with a
// sentence naming the way forward, because the refusal lives in the store and the route is
// the only thing that turns it into something a human reads.
const BUILTIN_ID = builtinWorkflowId("no-mistakes-review");

test("the shipped workflow is readable through the existing workflow routes", async () => {
  const { request } = fixture();
  const list = await request("/api/workflows");
  assert.equal(list.status, 200);
  const summaries = await list.json() as Array<{ id: string; builtin: boolean; publishedVersion: number | null }>;
  const shipped = summaries.find((item) => item.id === BUILTIN_ID);
  assert.ok(shipped, "a fresh database lists the built-in with no operator gesture");
  assert.equal(shipped.builtin, true);
  assert.equal(shipped.publishedVersion, 4, "the newest shipped version is the current one");

  const detail = await request(`/api/workflows/${BUILTIN_ID}`);
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as {
    workflow: { builtin: boolean; currentVersionId: string; draft: { nodes: unknown[] } };
    versions: Array<{ version: number }>;
  };
  assert.equal(detailBody.workflow.builtin, true);
  assert.equal(detailBody.workflow.currentVersionId, `${BUILTIN_ID}@4`);
  // Newest first, and prior versions are STILL served: bindings pinned to them resolve
  // through the same route after the catalog gained version 4.
  assert.deepEqual(detailBody.versions.map((version) => version.version), [4, 3, 2, 1]);

  const versions = await request(`/api/workflows/${BUILTIN_ID}/versions`);
  assert.equal(versions.status, 200);
  for (const number of [1, 2, 3, 4]) {
    const version = await request(`/api/workflows/${BUILTIN_ID}/versions/${number}`);
    assert.equal(version.status, 200, `version ${number} is no longer served`);
    const versionBody = await version.json() as {
      id: string;
      graph: { nodes: Array<{ kind: string }> };
    };
    assert.equal(versionBody.id, `${BUILTIN_ID}@${number}`);
    assert.ok(versionBody.graph.nodes.length > 0);
    // Versions 1 and 2 predate the check node and must not acquire one: an operator bound to
    // either never agreed to run commands on their machine.
    assert.equal(
      versionBody.graph.nodes.filter((node) => node.kind === "check").length,
      number < 3 ? 0 : 2,
    );
  }
  const liveVersion = await request(`/api/workflows/${BUILTIN_ID}/versions/2`);
  assert.equal(
    ((await liveVersion.json()) as { bindingDefaults: { deliveryMode: string } })
      .bindingDefaults.deliveryMode,
    "live",
  );
  assert.equal((await request(`/api/workflows/${BUILTIN_ID}/versions/5`)).status, 404);
});

test("the shipped workflow duplicates through the same create boundary as the dashboard", async () => {
  const { request } = fixture();
  const detail = await request(`/api/workflows/${BUILTIN_ID}`);
  assert.equal(detail.status, 200);
  const source = (await detail.json() as {
    workflow: {
      description: string;
      draft: unknown;
      completionPolicy: unknown;
      bindingDefaults: unknown;
    };
  }).workflow;

  const duplicate = await request("/api/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "No-Mistakes Review copy",
      description: source.description,
      draft: source.draft,
      completionPolicy: source.completionPolicy,
      bindingDefaults: source.bindingDefaults,
    }),
  });
  const duplicateBody = await duplicate.text();
  assert.equal(duplicate.status, 201, duplicateBody);
  const copied = JSON.parse(duplicateBody) as {
    workflow: {
      builtin: boolean;
      description: string;
      draft: unknown;
      completionPolicy: unknown;
      bindingDefaults: unknown;
    };
  };
  assert.equal(copied.workflow.builtin, false);
  assert.equal(copied.workflow.description, source.description);
  assert.deepEqual(copied.workflow.draft, source.draft);
  assert.deepEqual(copied.workflow.completionPolicy, source.completionPolicy);
  assert.deepEqual(copied.workflow.bindingDefaults, source.bindingDefaults);
});

test("every mutating workflow route 409s on the shipped workflow and names Duplicate", async () => {
  const { request } = fixture();
  const revision = JSON.stringify({ expectedDraftRevision: 1 });
  const cases: Array<[string, RequestInit]> = [
    [`/api/workflows/${BUILTIN_ID}`, { method: "PATCH", body: JSON.stringify({ expectedDraftRevision: 1, description: "mine" }) }],
    // Archive, publish, restore and hard delete. The last two arrived after this catalog did,
    // which is exactly why the refusal is one store guard rather than a per-route check: a new
    // lifecycle path inherits it instead of having to remember it.
    [`/api/workflows/${BUILTIN_ID}`, { method: "DELETE", body: revision }],
    [`/api/workflows/${BUILTIN_ID}/publish`, { method: "POST", body: revision }],
    [`/api/workflows/${BUILTIN_ID}/unarchive`, { method: "POST", body: revision }],
    [`/api/workflows/${BUILTIN_ID}/delete`, { method: "POST", body: revision }],
  ];
  for (const [path, init] of cases) {
    const response = await request(path, init);
    assert.equal(response.status, 409, `${init.method} ${path}`);
    const body = await response.json() as { code: string; error: string };
    assert.equal(body.code, "workflow_builtin");
    assert.match(body.error, /ships with Mission Control/);
    assert.doesNotMatch(body.error, /already been published|no such workflow/);
    assert.match(body.error, /Duplicate it to make a copy you own/);
  }

  // The name is reserved the way any duplicate name is, so a copy needs its own.
  const taken = await request("/api/workflows", {
    method: "POST",
    body: JSON.stringify({ name: "ＮＯ-ＭＩＳＴＡＫＥＳ   Review" }),
  });
  assert.equal(taken.status, 409);
  assert.equal((await taken.json() as { code: string }).code, "workflow_name_conflict");
  assert.equal(
    (await request("/api/workflows", { method: "POST", body: JSON.stringify({ name: "No-Mistakes Review copy" }) })).status,
    201,
  );
});
