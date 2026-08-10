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

const PROVENANCE = {
  sourcePath: "/plugins/agent-team/references/roles/reviewer.md",
  sourceRepo: "/plugins",
  pluginVersion: "0.1.1",
  contentSha256: "b".repeat(64),
  importedAt: 150,
};

test("provenance round-trips field for field, and an edit that ignores it leaves it alone", () => {
  const created = store.insertPersona({
    id: "p1",
    name: "Imported",
    normalizedName: normalizePersonaName("Imported"),
    description: "",
    guidanceMarkdown: exact,
    runner: null,
    model: null,
    createdAt: 100,
    updatedAt: 100,
    provenance: PROVENANCE,
  });
  assert.equal(created.ok, true);

  const reopened = new DatabaseSync(DB_PATH);
  try {
    // Through a second handle, so this is the STORED record rather than the object handed in.
    assert.deepEqual(new WorkflowStore(reopened, []).getPersona("p1")?.provenance, PROVENANCE);
  } finally {
    reopened.close();
  }

  // An ordinary edit names no provenance, so the column is not in its SET list at all - the
  // failure this pins is a patch builder that writes every column it knows about.
  const edited = store.updatePersonaCas("p1", 1, { description: "Edited" }, 200);
  assert.equal(edited.ok, true);
  if (edited.ok) assert.deepEqual(edited.persona.provenance, PROVENANCE);

  // And an explicit null clears it, which is what "this is not tracking a file any more" is.
  const cleared = store.updatePersonaCas("p1", 2, { provenance: null }, 300);
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.persona.provenance, null);
});

/**
 * The one row-level asymmetry provenance introduces, and the reason it is the right one.
 *
 * Guidance failing its schema fails the ROW - a Persona with unreadable guidance cannot review.
 * A provenance blob is not load-bearing in that way: losing it costs a badge, while failing the
 * row would remove a working reviewer from the library, from every draft that names it, and from
 * Publish. So the blob degrades to null and the Persona is served.
 */
test("a malformed provenance blob degrades to null without dropping the Persona", () => {
  insert("p1");
  for (const blob of [
    "not json at all",
    JSON.stringify({ sourcePath: "relative/path.md", contentSha256: "b".repeat(64), importedAt: 1 }),
    JSON.stringify({ sourcePath: "/role.md", sourceRepo: null, pluginVersion: null, contentSha256: "nope", importedAt: 1 }),
    JSON.stringify({ sourcePath: "/role.md" }),
    JSON.stringify(["not", "an", "object"]),
  ]) {
    db.prepare(`UPDATE personas SET import_provenance_json = ? WHERE id = 'p1'`).run(blob);
    const persona = store.getPersona("p1");
    assert.equal(persona?.guidanceMarkdown, exact, `the row survived: ${blob.slice(0, 24)}`);
    assert.equal(persona?.provenance, null);
    // Still in every listing a surface reads, not merely fetchable by id.
    assert.equal(store.listPersonas().some((row) => row.id === "p1"), true);
    assert.equal(store.personaCatalog().some((row) => row.id === "p1"), true);
  }
});

test("a provenance record too large to read back is refused at the write instead", () => {
  // The one failure mode this column has: a write the reader would then silently degrade to
  // null. Refusing here keeps the stored row as whatever it already was.
  assert.throws(() => store.insertPersona({
    id: "p-huge",
    name: "Huge provenance",
    normalizedName: normalizePersonaName("Huge provenance"),
    description: "",
    guidanceMarkdown: exact,
    runner: null,
    model: null,
    createdAt: 100,
    updatedAt: 100,
    provenance: { ...PROVENANCE, sourcePath: `/${"p".repeat(5000)}.md` },
  }));
  assert.equal(store.getPersona("p-huge"), null);
});
