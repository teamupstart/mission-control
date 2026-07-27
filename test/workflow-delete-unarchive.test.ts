// What is at stake: "delete" must never be able to rewrite the record of what already ran,
// and "archive" must not be a one-way door.
//
// Deleting a workflow row is safe ONLY while the workflow has never been published, and the
// reason is structural rather than careful: the workflow family declares no foreign keys, so
// SQLite will not stop a delete that strands a version, binding, run, submission, attempt,
// receipt, delivery, LLM call or event. The `published` refusal is what makes the single-row
// DELETE in `deleteWorkflowCas` provably total, so these tests pin the refusal AND the claim
// underneath it - that nothing in the family can reference a workflow with no versions.
//
// Unarchive is the other half. Archive reserves its normalized name forever, so a retired
// workflow that could not come back was an operator's name held hostage by a row they could
// not reach.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-delete-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore, clearWorkflowTables, WORKFLOW_TABLES } = await import("../src/server/workflows/store.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { buildApp } = await import("../src/server/routes.ts");
const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

type ServerEvent = { type: string; id?: string };

function fixture() {
  clearWorkflowTables(db);
  const registry = new Registry();
  const store = new WorkflowStore(db);
  const personas = new PersonaManager(registry, store);
  const workflows = new WorkflowManager(registry, store);
  const app = buildApp(registry, null as never, null as never, null as never, undefined, personas, workflows);
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event as ServerEvent));
  const request = (path: string, init?: RequestInit) => app.request(path, {
    ...init,
    headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers },
  });
  return { request, registry, store, events };
}

/** A publishable graph, so the same fixture can produce both a draft and a version. */
async function seed(request: ReturnType<typeof fixture>["request"], name = "Review") {
  const personaResponse = await request("/api/personas", {
    method: "POST",
    body: JSON.stringify({ name: `Judge ${name}`, guidanceMarkdown: "# Judge" }),
  });
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
  const response = await request("/api/workflows", { method: "POST", body: JSON.stringify({ name, draft }) });
  return await response.json() as { workflow: { id: string; draftRevision: number } };
}

const del = (request: ReturnType<typeof fixture>["request"], id: string, revision: number) =>
  request(`/api/workflows/${id}/delete`, { method: "POST", body: JSON.stringify({ expectedDraftRevision: revision }) });

const unarchive = (request: ReturnType<typeof fixture>["request"], id: string, revision: number) =>
  request(`/api/workflows/${id}/unarchive`, { method: "POST", body: JSON.stringify({ expectedDraftRevision: revision }) });

const archive = (request: ReturnType<typeof fixture>["request"], id: string, revision: number) =>
  request(`/api/workflows/${id}`, { method: "DELETE", body: JSON.stringify({ expectedDraftRevision: revision }) });

test("deleting a never-published workflow removes the row and announces it", async () => {
  const { request, store, events } = fixture();
  const { workflow } = await seed(request);
  const response = await del(request, workflow.id, workflow.draftRevision);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, id: workflow.id });
  assert.equal(store.getWorkflow(workflow.id), null);
  // `workflow_remove` and not a `workflow_upsert` carrying an archived flag: the browser has
  // to drop the row from its map, which is the one thing archive must never do.
  assert.ok(events.some((event) => event.type === "workflow_remove" && event.id === workflow.id));
});

test("deleting leaves no row anywhere in the workflow family", async () => {
  const { request } = fixture();
  const { workflow } = await seed(request);
  assert.equal((await del(request, workflow.id, workflow.draftRevision)).status, 200);

  // The claim `deleteWorkflowCas` rests on, asserted rather than reasoned about: with the
  // definition gone, every other table in the family is empty too, so the single-row DELETE
  // could not have stranded anything. `personas` is excluded because a Persona outlives the
  // workflows that reference it by design.
  for (const table of WORKFLOW_TABLES) {
    if (table === "personas") continue;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    assert.equal(row.n, 0, `${table} kept a row after its workflow was deleted`);
  }
});

test("deleting a published workflow is refused and changes nothing", async () => {
  const { request, store } = fixture();
  const { workflow } = await seed(request);
  const published = await request(`/api/workflows/${workflow.id}/publish`, {
    method: "POST",
    body: JSON.stringify({ expectedDraftRevision: workflow.draftRevision }),
  });
  assert.equal(published.status, 200);
  const after = store.getWorkflow(workflow.id);
  assert.ok(after);

  const response = await del(request, workflow.id, after.draftRevision);
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, "workflow_published");
  // The refusal is the point: the version, and anything that could quote it, survives.
  assert.ok(store.getWorkflow(workflow.id));
  assert.equal(store.listWorkflowVersions(workflow.id).length, 1);
});

test("an archived workflow can still be deleted while it has never been published", async () => {
  const { request, store } = fixture();
  const { workflow } = await seed(request);
  assert.equal((await archive(request, workflow.id, workflow.draftRevision)).status, 200);
  const archived = store.getWorkflow(workflow.id);
  assert.ok(archived?.archivedAt);

  // Archive-then-delete is the whole point of the pairing: retire it, then clear it out.
  assert.equal((await del(request, workflow.id, archived.draftRevision)).status, 200);
  assert.equal(store.getWorkflow(workflow.id), null);
});

test("delete refuses a stale revision and a workflow that is not there", async () => {
  const { request, store } = fixture();
  const { workflow } = await seed(request);

  const stale = await del(request, workflow.id, workflow.draftRevision + 7);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { code: string }).code, "workflow_revision_conflict");
  assert.ok(store.getWorkflow(workflow.id));

  assert.equal((await del(request, "no-such-workflow", 1)).status, 404);
});

test("deleting frees the name the archive was still reserving", async () => {
  const { request } = fixture();
  const { workflow } = await seed(request, "Recycled");
  // Archive alone keeps `idx_workflow_definitions_normalized_name` occupied, so the operator
  // cannot reuse the name. This is the concrete difference delete buys them.
  assert.equal((await archive(request, workflow.id, workflow.draftRevision)).status, 200);
  const blocked = await request("/api/workflows", { method: "POST", body: JSON.stringify({ name: "Recycled" }) });
  assert.equal(blocked.status, 409);

  const archived = await request(`/api/workflows/${workflow.id}`);
  const detail = await archived.json() as { workflow: { draftRevision: number } };
  assert.equal((await del(request, workflow.id, detail.workflow.draftRevision)).status, 200);
  assert.equal((await request("/api/workflows", { method: "POST", body: JSON.stringify({ name: "Recycled" }) })).status, 201);
});

test("unarchive restores a workflow to the default listing", async () => {
  const { request, store } = fixture();
  const { workflow } = await seed(request);
  assert.equal((await archive(request, workflow.id, workflow.draftRevision)).status, 200);
  const archived = store.getWorkflow(workflow.id);
  assert.ok(archived?.archivedAt);
  // By id, not by count: the shipped built-in catalog is merged into every listing, so the
  // claim is about THIS workflow leaving and returning, not about how many rows there are.
  const listed = () => store.listWorkflows().some((item) => item.id === workflow.id);
  assert.equal(listed(), false);

  const response = await unarchive(request, workflow.id, archived.draftRevision);
  assert.equal(response.status, 200);
  assert.equal(store.getWorkflow(workflow.id)?.archivedAt, null);
  assert.equal(listed(), true);
});

test("unarchive refuses a workflow that is not archived, and a stale revision", async () => {
  const { request, store } = fixture();
  const { workflow } = await seed(request);

  // A silent success here would bump the revision twice on a double click from two tabs.
  const live = await unarchive(request, workflow.id, workflow.draftRevision);
  assert.equal(live.status, 409);
  assert.equal((await live.json() as { code: string }).code, "workflow_not_archived");

  assert.equal((await archive(request, workflow.id, workflow.draftRevision)).status, 200);
  const archived = store.getWorkflow(workflow.id);
  assert.ok(archived);
  const stale = await unarchive(request, workflow.id, archived.draftRevision + 7);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { code: string }).code, "workflow_revision_conflict");
  assert.ok(store.getWorkflow(workflow.id)?.archivedAt);

  assert.equal((await unarchive(request, workflow.id, archived.draftRevision)).status, 200);
});

test("an unarchived workflow is editable and publishable again", async () => {
  const { request, store } = fixture();
  const { workflow } = await seed(request);
  assert.equal((await archive(request, workflow.id, workflow.draftRevision)).status, 200);
  const archived = store.getWorkflow(workflow.id);
  assert.ok(archived);
  // Archived rows refuse edits, so restoring has to actually clear the flag rather than
  // merely hide it from the listing.
  assert.equal((await request(`/api/workflows/${workflow.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedDraftRevision: archived.draftRevision, description: "nope" }),
  })).status, 409);

  assert.equal((await unarchive(request, workflow.id, archived.draftRevision)).status, 200);
  const restored = store.getWorkflow(workflow.id);
  assert.ok(restored);
  assert.equal((await request(`/api/workflows/${workflow.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedDraftRevision: restored.draftRevision, description: "yes" }),
  })).status, 200);
  assert.equal(store.getWorkflow(workflow.id)?.description, "yes");
});

test("both new routes validate their body through parseBody", async () => {
  const { request } = fixture();
  const { workflow } = await seed(request);
  assert.equal((await request(`/api/workflows/${workflow.id}/delete`, { method: "POST", body: "{}" })).status, 400);
  assert.equal((await request(`/api/workflows/${workflow.id}/unarchive`, { method: "POST", body: "{}" })).status, 400);
});
