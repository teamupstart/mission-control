import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// What is at stake: Persona guidance becomes immutable history inside published workflow
// versions. The mutable catalog must therefore preserve accepted Markdown exactly, reserve names
// across archive, and make two editors conflict instead of letting the last save erase the first.

const home = mkdtempSync(join(tmpdir(), "mission-personas-store-"));
process.env.HARNESS_HOME = join(home, "state");

const { DB_PATH } = await import("../src/server/config.ts");
const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { normalizePersonaName } = await import("../src/shared/workflow.ts");

const db = openDb();
// No built-in catalog here on purpose: these cases are about what a ROW does, and the four
// shipped Personas would put four constants inside every list assertion below. The merge and
// its refusals are `builtin-personas.test.ts`.
const store = new WorkflowStore(db, []);
const exact = "# Code Quality\r\n\r\nKeep trailing spaces.  \r\nNo final newline";

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearWorkflowTables(db));

function insert(id: string, name = "Code Quality", guidanceMarkdown = exact) {
  return store.insertPersona({
    id,
    name,
    normalizedName: normalizePersonaName(name),
    description: "Review correctness",
    guidanceMarkdown,
    runner: null,
    model: null,
    createdAt: 100,
    updatedAt: 100,
  });
}

test("insert and a fresh database handle round-trip Markdown byte-for-byte", () => {
  const created = insert("p1");
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.persona.guidanceMarkdown, exact);
  assert.equal(created.persona.revision, 1);

  const reopened = new DatabaseSync(DB_PATH);
  try {
    assert.equal(new WorkflowStore(reopened).getPersona("p1")?.guidanceMarkdown, exact);
  } finally {
    reopened.close();
  }
});

test("CAS update advances the revision and a stale writer receives the current row", () => {
  insert("p1");
  const first = store.updatePersonaCas("p1", 1, { description: "First tab" }, 200);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.persona.revision, 2);

  const stale = store.updatePersonaCas("p1", 1, { description: "Second tab" }, 300);
  assert.deepEqual(stale, {
    ok: false,
    reason: "revision_conflict",
    current: first.persona,
  });
  assert.equal(store.getPersona("p1")?.description, "First tab");
});

test("normalized names collide across compatibility characters, case, and whitespace", () => {
  assert.equal(insert("p1").ok, true);
  const conflict = insert("p2", "  ＣODE   quality ");
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.reason, "name_conflict");
  assert.equal(conflict.current?.id, "p1");
});

test("archive is soft, revisioned, readable, and reserves the name", () => {
  insert("p1");
  const archived = store.archivePersonaCas("p1", 1, 500);
  assert.equal(archived.ok, true);
  if (!archived.ok) return;
  assert.equal(archived.persona.archivedAt, 500);
  assert.equal(archived.persona.revision, 2);
  assert.deepEqual(store.listPersonas(), []);
  assert.equal(store.listPersonas(true)[0]?.id, "p1");
  assert.equal(store.getPersona("p1")?.guidanceMarkdown, exact);

  const edit = store.updatePersonaCas("p1", 2, { description: "No" }, 600);
  assert.equal(edit.ok, false);
  if (!edit.ok) assert.equal(edit.reason, "archived");
  const reserved = insert("p2", "code quality");
  assert.equal(reserved.ok, false);
  if (!reserved.ok) assert.equal(reserved.reason, "name_conflict");
});

test("a name-changing CAS checks uniqueness in the same transaction", () => {
  insert("p1", "Quality");
  insert("p2", "Design");
  const conflict = store.updatePersonaCas(
    "p2",
    1,
    { name: " QUALITY ", normalizedName: normalizePersonaName(" QUALITY ") },
    200,
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.reason, "name_conflict");
  assert.equal(store.getPersona("p2")?.name, "Design");
});
