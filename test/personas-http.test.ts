import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: HTTP is the only write boundary for browser Persona edits. Every mutation
// must pass the shared Zod schema, stale revisions must preserve both tabs' text, and archive must
// remain a durable readable row instead of turning Delete into historical data loss.

const home = mkdtempSync(join(tmpdir(), "mission-personas-http-"));
process.env.HARNESS_HOME = join(home, "state");
for (const prefix of ["MISSION_", "FLEET_", "HARNESS_"]) {
  delete process.env[`${prefix}WORKFLOW_PERSONA_MODEL`];
  delete process.env[`${prefix}LLM_RUNNER`];
}

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { buildApp } = await import("../src/server/routes.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

function fixture() {
  clearWorkflowTables(db);
  db.exec(`DELETE FROM app_config WHERE key = 'llm'`);
  const registry = new Registry();
  const personas = new PersonaManager(registry, new WorkflowStore(db));
  const app = buildApp(registry, null as never, null as never, null as never, undefined, personas);
  const request = (path: string, init?: RequestInit) =>
    app.request(path, { ...init, headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers } });
  return { registry, request };
}

test("create uses parseBody, returns 201, preserves Markdown, and includes effective values", async () => {
  const { request } = fixture();
  const malformed = await request("/api/personas", { method: "POST", body: JSON.stringify({ name: "No guidance" }) });
  assert.equal(malformed.status, 400);

  const guidanceMarkdown = "# Review\r\n\r\nExact trailing space  \r\n";
  const response = await request("/api/personas", {
    method: "POST",
    body: JSON.stringify({ name: "Quality", guidanceMarkdown }),
  });
  assert.equal(response.status, 201);
  const persona = (await response.json()) as {
    id: string;
    guidanceMarkdown: string;
    revision: number;
    execution: { runner: { id: string }; model: { id: string } };
  };
  assert.equal(persona.guidanceMarkdown, guidanceMarkdown);
  assert.equal(persona.revision, 1);
  assert.equal(persona.execution.runner.id, "claude");
  assert.equal(persona.execution.model.id, "claude-sonnet-5");

  const read = await request(`/api/personas/${persona.id}`);
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { guidanceMarkdown: string }).guidanceMarkdown, guidanceMarkdown);
});

test("Persona defaults expose the daemon-resolved environment model", async () => {
  const { request } = fixture();
  process.env.MISSION_WORKFLOW_PERSONA_MODEL = "model-from-daemon-env";
  try {
    const response = await request("/api/personas/defaults");
    assert.equal(response.status, 200);
    const defaults = (await response.json()) as {
      runner: { id: string };
      models: Record<string, { id: string; source: string }>;
    };
    assert.equal(defaults.runner.id, "claude");
    assert.deepEqual(defaults.models.claude, { id: "model-from-daemon-env", source: "env" });
    assert.deepEqual(defaults.models.codex, { id: "model-from-daemon-env", source: "env" });
  } finally {
    delete process.env.MISSION_WORKFLOW_PERSONA_MODEL;
  }
});

test("two tabs editing one revision get a stable 409 with the current row", async () => {
  const { request } = fixture();
  const created = await request("/api/personas", {
    method: "POST",
    body: JSON.stringify({ name: "Quality", guidanceMarkdown: "# Original" }),
  });
  const persona = (await created.json()) as { id: string };
  const first = await request(`/api/personas/${persona.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: 1, guidanceMarkdown: "# First tab" }),
  });
  assert.equal(first.status, 200);

  const stale = await request(`/api/personas/${persona.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: 1, guidanceMarkdown: "# Second tab" }),
  });
  assert.equal(stale.status, 409);
  const conflict = (await stale.json()) as {
    code: string;
    current: { guidanceMarkdown: string; revision: number };
  };
  assert.equal(conflict.code, "persona_revision_conflict");
  assert.equal(conflict.current.guidanceMarkdown, "# First tab");
  assert.equal(conflict.current.revision, 2);
});

test("normalized-name conflicts are 409 and malformed patches remain 400", async () => {
  const { request } = fixture();
  await request("/api/personas", {
    method: "POST",
    body: JSON.stringify({ name: "Code Quality", guidanceMarkdown: "# One" }),
  });
  const duplicate = await request("/api/personas", {
    method: "POST",
    body: JSON.stringify({ name: " ＣODE   quality ", guidanceMarkdown: "# Two" }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal(((await duplicate.json()) as { code: string }).code, "persona_name_conflict");

  const emptyPatch = await request("/api/personas/whatever", {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  assert.equal(emptyPatch.status, 400);
});

test("Persona create and update bodies are bounded before schema parsing", async () => {
  const { request } = fixture();
  const oversizedGuidance = "\u0000".repeat(110_000);
  const create = await request("/api/personas", {
    method: "POST",
    body: JSON.stringify({ name: "Too large", guidanceMarkdown: oversizedGuidance }),
  });
  assert.equal(create.status, 413);

  const update = await request("/api/personas/missing", {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: 1, guidanceMarkdown: oversizedGuidance }),
  });
  assert.equal(update.status, 413);
});

test("DELETE is parsed soft archive: hidden from active list, readable, and immutable", async () => {
  const { request } = fixture();
  const created = await request("/api/personas", {
    method: "POST",
    body: JSON.stringify({ name: "Archive me", guidanceMarkdown: "# Durable" }),
  });
  const persona = (await created.json()) as { id: string };

  const unparsed = await request(`/api/personas/${persona.id}`, { method: "DELETE", body: "{}" });
  assert.equal(unparsed.status, 400);
  const archived = await request(`/api/personas/${persona.id}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  assert.equal(archived.status, 200);
  assert.equal(typeof ((await archived.json()) as { archivedAt: number }).archivedAt, "number");

  assert.deepEqual((await (await request("/api/personas")).json()) as unknown[], []);
  const all = (await (await request("/api/personas?includeArchived=true")).json()) as Array<{ id: string }>;
  assert.equal(all[0]?.id, persona.id);
  assert.equal((await request(`/api/personas/${persona.id}`)).status, 200);

  const edit = await request(`/api/personas/${persona.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: 2, description: "No" }),
  });
  assert.equal(edit.status, 409);
  assert.equal(((await edit.json()) as { code: string }).code, "persona_archived");
});

test("missing ids and invalid archive-list queries are explicit", async () => {
  const { request } = fixture();
  assert.equal((await request("/api/personas/missing")).status, 404);
  assert.equal((await request("/api/personas?includeArchived=maybe")).status, 400);
});

test("changing the app provider refreshes effective Persona values in the SSE snapshot", async () => {
  const { registry, request } = fixture();
  await request("/api/personas", {
    method: "POST",
    body: JSON.stringify({ name: "Follows app", guidanceMarkdown: "# Review" }),
  });
  assert.equal(registry.snapshot().personas[0]?.execution.runner.id, "claude");

  const changed = await request("/api/llm/config", {
    method: "PUT",
    body: JSON.stringify({ runner: "codex" }),
  });
  assert.equal(changed.status, 200);
  const execution = registry.snapshot().personas[0]?.execution;
  assert.equal(execution?.runner.id, "codex");
  assert.equal(execution?.model.id, "gpt-5.6-terra");
});
