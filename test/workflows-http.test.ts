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

test("evidence readiness overrides require explicit risk acknowledgement", async () => {
  const { request } = fixture();
  const path = "/api/workflow-runs/missing/submissions/missing/evidence-readiness/override";
  const override = (body: object) => request(path, {
    method: "POST",
    body: JSON.stringify(body),
  });

  assert.equal((await override({ requestId: "missing-ack", reason: "Accept the gaps" })).status, 400);
  assert.equal((await override({
    requestId: "false-ack",
    reason: "Accept the gaps",
    acknowledgedRisk: false,
  })).status, 400);
  const acceptedShape = await override({
    requestId: "true-ack",
    reason: "Accept the gaps",
    acknowledgedRisk: true,
  });
  assert.equal(acceptedShape.status, 404);
  assert.deepEqual(await acceptedShape.json(), {
    error: "The workflow run or submission was not found.",
    code: "workflow_evidence_readiness_override_not_found",
  });
});

test("evidence readiness mutations reject oversized bodies before parsing", async () => {
  const { request } = fixture();
  const oversized = JSON.stringify({
    requestId: "oversized-readiness-request",
    reason: "Accept the gaps",
    acknowledgedRisk: true,
    padding: "x".repeat(64 * 1024),
  });
  const mutation = (action: "retry" | "override") => request(
    `/api/workflow-runs/missing/submissions/missing/evidence-readiness/${action}`,
    { method: "POST", body: oversized },
  );

  const retry = await mutation("retry");
  assert.equal(retry.status, 413);
  assert.deepEqual(await retry.json(), { error: "Workflow evidence readiness retry is too large" });
  const override = await mutation("override");
  assert.equal(override.status, 413);
  assert.deepEqual(await override.json(), { error: "Workflow evidence readiness override is too large" });
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

test("a configured dispatch default cannot be archived or deleted", async () => {
  const { request } = fixture();
  const valid = await seedValid(request);
  assert.equal(
    (await request(`/api/workflows/${valid.workflow.id}/publish`, {
      method: "POST",
      body: JSON.stringify({ expectedDraftRevision: 1 }),
    })).status,
    200,
  );
  assert.equal(
    (await request("/api/workflows/config", {
      method: "PUT",
      body: JSON.stringify({
        liveEnabled: false,
        repoAllowlist: [],
        defaultWorkflowId: valid.workflow.id,
      }),
    })).status,
    200,
  );

  const archived = await request(`/api/workflows/${valid.workflow.id}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedDraftRevision: 1 }),
  });
  assert.equal(archived.status, 409);
  assert.match((await archived.json() as { error: string }).error, /another dispatch default/);

  const deleted = await request(`/api/workflows/${valid.workflow.id}/delete`, {
    method: "POST",
    body: JSON.stringify({ expectedDraftRevision: 1 }),
  });
  assert.equal(deleted.status, 409);
  assert.match((await deleted.json() as { error: string }).error, /another dispatch default/);

  assert.equal(
    (await request("/api/workflows/config", {
      method: "PUT",
      body: JSON.stringify({
        liveEnabled: false,
        repoAllowlist: [],
        defaultWorkflowId: null,
      }),
    })).status,
    200,
  );
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
  assert.equal(shipped.publishedVersion, 13, "the newest shipped version is the current one");

  const detail = await request(`/api/workflows/${BUILTIN_ID}`);
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as {
    workflow: { builtin: boolean; currentVersionId: string; draft: { nodes: unknown[] } };
    versions: Array<{ version: number }>;
  };
  assert.equal(detailBody.workflow.builtin, true);
  assert.equal(detailBody.workflow.currentVersionId, `${BUILTIN_ID}@13`);
  // Newest first, and prior versions are STILL served: bindings pinned to them resolve
  // through the same route after the catalog gained version 8.
  assert.deepEqual(
    detailBody.versions.map((version) => version.version),
    [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  );

  const versions = await request(`/api/workflows/${BUILTIN_ID}/versions`);
  assert.equal(versions.status, 200);
  assert.deepEqual(
    ((await versions.json()) as Array<{ version: number }>).map((version) => version.version),
    [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  );
  for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
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
    // The same rule for the session action node, which only version 8 authors: a binding
    // pinned to any earlier version never agreed to have a pull request typed at its session
    // as a graph stage.
    assert.equal(
      versionBody.graph.nodes.filter((node) => node.kind === "session_action").length,
      number < 8 ? 0 : 1,
    );
  }
  const liveVersion = await request(`/api/workflows/${BUILTIN_ID}/versions/2`);
  assert.equal(
    ((await liveVersion.json()) as { bindingDefaults: { deliveryMode: string } })
      .bindingDefaults.deliveryMode,
    "live",
  );
  const foremanVersion = await request(`/api/workflows/${BUILTIN_ID}/versions/6`);
  assert.equal(
    ((await foremanVersion.json()) as { bindingDefaults: { triggerMode: string } })
      .bindingDefaults.triggerMode,
    "foreman_complete",
  );
  const resumingVersion = await request(`/api/workflows/${BUILTIN_ID}/versions/7`);
  assert.equal(
    ((await resumingVersion.json()) as { resumptionPolicy: string }).resumptionPolicy,
    "auto",
    "engine-owned resumption arrived in version 7 and stays on",
  );
  const prVersion = await (await request(`/api/workflows/${BUILTIN_ID}/versions/8`)).json() as {
    resumptionPolicy: string;
    completionPolicy: { kind: string; onFindings: string; missingPrAction: string };
  };
  assert.equal(prVersion.resumptionPolicy, "auto");
  assert.deepEqual(prVersion.completionPolicy, {
    kind: "inspector",
    onFindings: "inspector_only",
    // The newest version's own last stage opens the pull request, so a gate that found none
    // must wait rather than type a second handoff asking for one the run already has.
    missingPrAction: "wait",
  });
  const localVersion = await (await request(`/api/workflows/${BUILTIN_ID}/versions/9`)).json() as {
    resumptionPolicy: string;
    completionPolicy: { kind: string };
    graph: { nodes: Array<{ id: string; kind: string }> };
  };
  assert.equal(localVersion.resumptionPolicy, "auto");
  assert.deepEqual(localVersion.completionPolicy, { kind: "none" });
  assert.equal(localVersion.graph.nodes.some((node) => node.id === "nmr-code-quality-judge"), true);
  const reorderedVersion = await (await request(`/api/workflows/${BUILTIN_ID}/versions/10`)).json() as {
    resumptionPolicy: string;
    completionPolicy: { kind: string };
    graph: { nodes: Array<{ id: string; kind: string }> };
  };
  assert.equal(reorderedVersion.resumptionPolicy, "auto");
  assert.deepEqual(reorderedVersion.completionPolicy, { kind: "none" });
  assert.equal(
    reorderedVersion.graph.nodes.some((node) => node.id === "nmr-evidence-documentation-join"),
    true,
  );
  // Version 10 predates the design reviewer, and version 11 is the first to serve it.
  assert.equal(reorderedVersion.graph.nodes.some((node) => node.id === "nmr-code-design"), false);
  const designVersion = await (await request(`/api/workflows/${BUILTIN_ID}/versions/11`)).json() as {
    resumptionPolicy: string;
    completionPolicy: { kind: string };
    graph: { nodes: Array<{ id: string; kind: string }> };
  };
  assert.equal(designVersion.resumptionPolicy, "auto");
  assert.deepEqual(designVersion.completionPolicy, { kind: "none" });
  assert.equal(designVersion.graph.nodes.some((node) => node.id === "nmr-code-design"), true);
  assert.equal(designVersion.graph.nodes.some((node) => node.id === "nmr-slop-filter"), false);
  const slopVersion = await (await request(`/api/workflows/${BUILTIN_ID}/versions/12`)).json() as {
    resumptionPolicy: string;
    completionPolicy: { kind: string };
    graph: { nodes: Array<{ id: string; kind: string }> };
  };
  assert.equal(slopVersion.resumptionPolicy, "auto");
  assert.deepEqual(slopVersion.completionPolicy, { kind: "none" });
  assert.equal(slopVersion.graph.nodes.some((node) => node.id === "nmr-code-design"), true);
  assert.equal(slopVersion.graph.nodes.some((node) => node.id === "nmr-slop-filter"), true);
  const readinessVersion = await (await request(`/api/workflows/${BUILTIN_ID}/versions/13`)).json() as {
    evidenceReadinessPolicy: string;
    graph: { nodes: Array<{ id: string; kind: string }> };
  };
  assert.equal(readinessVersion.evidenceReadinessPolicy, "criterion_mapped_v1");
  assert.deepEqual(readinessVersion.graph, slopVersion.graph);
  assert.equal((await request(`/api/workflows/${BUILTIN_ID}/versions/14`)).status, 404);
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

test("per-run node disable validates ids, replays idempotently, and refuses finished runs", async () => {
  const { request, store } = fixture();
  const valid = await seedValid(request);
  const publishedResponse = await request(`/api/workflows/${valid.workflow.id}/publish`, {
    method: "POST",
    body: JSON.stringify({ expectedDraftRevision: 1 }),
  });
  const published = await publishedResponse.json() as { version: { id: string } };
  const binding = store.insertBinding({
    id: "toggle-binding",
    workflowVersionId: published.version.id,
    noteKey: "toggle-note",
    sessionId: "toggle-session",
    sessionAgent: "codex",
    sessionName: "Toggle worker",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission({
    id: "toggle-run",
    binding,
    triggerSource: "manual",
    triggerKey: "toggle-run-trigger",
    now: 2,
  }, {
    id: "toggle-submission",
    triggerSource: "manual",
    triggerKey: "toggle-submission-trigger",
    context: {},
    evidence: {},
    now: 2,
  });
  const toggle = (body: object) => request("/api/workflow-runs/toggle-run/set-nodes-disabled", {
    method: "POST",
    body: JSON.stringify(body),
  });

  // Shared parseBody schema, unknown run, and non-verdict node all refuse cleanly.
  assert.equal((await toggle({})).status, 400);
  // A repeated id is refused at the boundary: one request drives one event per gate.
  assert.equal(
    (await toggle({ requestId: "r-dup", nodeIds: ["judge", "judge"], disabled: true })).status,
    400,
  );
  assert.equal((await request("/api/workflow-runs/missing/set-nodes-disabled", {
    method: "POST",
    body: JSON.stringify({ requestId: "r-0", nodeIds: ["judge"], disabled: true }),
  })).status, 404);
  const session = await toggle({ requestId: "r-1", nodeIds: ["session"], disabled: true });
  assert.equal(session.status, 404);
  assert.match((await session.json() as { error: string }).error, /Persona or Check/);

  // Disable, and the run row carries the set.
  const disabled = await toggle({ requestId: "r-2", nodeIds: ["judge"], disabled: true });
  assert.equal(disabled.status, 200);
  const disabledBody = await disabled.json() as {
    run: { disabledNodeIds: string[] };
    idempotent: boolean;
  };
  assert.deepEqual(disabledBody.run.disabledNodeIds, ["judge"]);
  assert.equal(disabledBody.idempotent, false);

  // Run detail serves the same set, and the timeline names the gate that was switched.
  const detail = await request("/api/workflow-runs/toggle-run");
  const detailBody = await detail.json() as {
    run: { disabledNodeIds: string[] };
    events: Array<{ kind: string }>;
  };
  assert.deepEqual(detailBody.run.disabledNodeIds, ["judge"]);
  assert.ok(detailBody.events.some((event) => event.kind === "node_disabled"));

  // A replayed request id is acknowledged without a second write.
  const replay = await toggle({ requestId: "r-2", nodeIds: ["judge"], disabled: true });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { idempotent: boolean }).idempotent, true);

  // Enable restores the node with its own request identity.
  const enabled = await toggle({ requestId: "r-3", nodeIds: ["judge"], disabled: false });
  assert.deepEqual((await enabled.json() as { run: { disabledNodeIds: string[] } }).run.disabledNodeIds, []);

  // A finished run can no longer be affected, so the toggle refuses rather than pretending.
  store.cancelRun("toggle-run", "test_cleanup", 30);
  const terminal = await toggle({ requestId: "r-4", nodeIds: ["judge"], disabled: true });
  assert.equal(terminal.status, 409);
  assert.equal((await terminal.json() as { code: string }).code, "workflow_conflict");
});

test("run-scoped Persona feedback validates, persists, edits, and removes idempotently", async () => {
  const { request, store } = fixture();
  const valid = await seedValid(request);
  const publishedResponse = await request(`/api/workflows/${valid.workflow.id}/publish`, {
    method: "POST",
    body: JSON.stringify({ expectedDraftRevision: 1 }),
  });
  const published = await publishedResponse.json() as { version: { id: string } };
  const binding = store.insertBinding({
    id: "directive-binding",
    workflowVersionId: published.version.id,
    noteKey: "directive-note",
    sessionId: "directive-session",
    sessionAgent: "codex",
    sessionName: "Directive worker",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission({
    id: "directive-run",
    binding,
    triggerSource: "manual",
    triggerKey: "directive-run-trigger",
    now: 2,
  }, {
    id: "directive-submission",
    triggerSource: "manual",
    triggerKey: "directive-submission-trigger",
    context: {},
    evidence: {},
    now: 2,
  });
  const set = (body: object) => request("/api/workflow-runs/directive-run/set-persona-directive", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const remove = (body: object) => request("/api/workflow-runs/directive-run/remove-persona-directive", {
    method: "POST",
    body: JSON.stringify(body),
  });

  assert.equal((await set({})).status, 400);
  assert.equal((await set({ requestId: "too-large", nodeId: "judge", feedback: "x".repeat(8_001) })).status, 400);
  const structural = await set({ requestId: "bad-target", nodeId: "session", feedback: "Do this" });
  assert.equal(structural.status, 404);
  assert.match((await structural.json() as { error: string }).error, /only a Persona node/);

  const saved = await set({ requestId: "set-1", nodeId: "judge", feedback: "Honor the human exception" });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as {
    run: { personaDirectives: Array<{ nodeId: string; feedback: string; revision: number }> };
    idempotent: boolean;
  };
  assert.equal(savedBody.run.personaDirectives[0]?.nodeId, "judge");
  assert.equal(savedBody.run.personaDirectives[0]?.feedback, "Honor the human exception");
  assert.equal(savedBody.run.personaDirectives[0]?.revision, 1);
  assert.equal(savedBody.idempotent, false);
  assert.equal((await set({ requestId: "set-1", nodeId: "judge", feedback: "ignored replay" })).status, 200);

  const edited = await set({ requestId: "set-2", nodeId: "judge", feedback: "Honor it and cite it" });
  const editedBody = await edited.json() as {
    directive: { feedback: string; revision: number };
  };
  assert.equal(editedBody.directive.feedback, "Honor it and cite it");
  assert.equal(editedBody.directive.revision, 2);

  const detail = await request("/api/workflow-runs/directive-run");
  const detailBody = await detail.json() as {
    run: { personaDirectives: Array<{ feedback: string; revision: number }> };
    events: Array<{ kind: string }>;
  };
  assert.equal(detailBody.run.personaDirectives[0]?.revision, 2);
  assert.ok(detailBody.events.some((event) => event.kind === "persona_directive_set"));

  const removed = await remove({ requestId: "remove-1", nodeId: "judge" });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json() as { run: { personaDirectives: unknown[] } }).run.personaDirectives, []);
  const replay = await remove({ requestId: "remove-1", nodeId: "judge" });
  assert.equal((await replay.json() as { idempotent: boolean }).idempotent, true);

  store.cancelRun("directive-run", "test_cleanup", 30);
  const terminal = await set({ requestId: "set-terminal", nodeId: "judge", feedback: "Too late" });
  assert.equal(terminal.status, 409);
});
