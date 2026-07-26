import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// What is at stake: the four review roles ship WITH the application, which is a promise about
// two different things. First, that a build serves the exact Markdown it was made from - the
// generated module is the only copy that survives bundling and packaging, so a drifted or
// hand-edited one is a build quietly reviewing with guidance nobody wrote. Second, that they
// are app data rather than operator data: they must be visible to every Persona read without a
// seeding step, refuse edits and archives at the store rather than at each caller, and refuse
// to have their names taken - while an operator who imported the same document before it
// shipped keeps the copy and the name they already own.

const home = mkdtempSync(join(tmpdir(), "mission-builtin-personas-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { BUILTIN_PERSONAS, builtinPersonaId } = await import("../src/server/workflows/builtin-personas.ts");
const { BUILTIN_PERSONA_SOURCES } = await import("../src/server/workflows/builtin-personas.generated.ts");
// The generator itself, not a second implementation of it: a drift check that re-rendered the
// module its own way would agree with itself and say nothing about `npm run personas`.
const { builtinPersonaSources, renderBuiltinPersonaModule } = await import("../scripts/builtin-personas.ts");
const { normalizePersonaName } = await import("../src/shared/workflow.ts");

const root = resolve(import.meta.dirname, "..");
const docsDir = join(root, "docs", "personas");
const generatedPath = join(root, "src", "server", "workflows", "builtin-personas.generated.ts");

const db = openDb();
const store = new WorkflowStore(db);
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearWorkflowTables(db));

function insert(id: string, name: string, guidanceMarkdown = "# Judge\n\nA role.\n") {
  return store.insertPersona({
    id,
    name,
    normalizedName: normalizePersonaName(name),
    description: "",
    guidanceMarkdown,
    runner: null,
    model: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

test("the generated module is exactly what the authored Markdown regenerates", () => {
  assert.equal(
    readFileSync(generatedPath, "utf8"),
    renderBuiltinPersonaModule(builtinPersonaSources(docsDir)),
    "run `npm run personas` and commit the result",
  );
  const documents = readdirSync(docsDir).filter((entry) => entry.endsWith(".md"));
  assert.equal(BUILTIN_PERSONA_SOURCES.length, documents.length);
  for (const source of BUILTIN_PERSONA_SOURCES) {
    assert.equal(
      source.guidanceMarkdown,
      readFileSync(join(docsDir, `${source.slug}.md`), "utf8"),
      `${source.slug} is not byte-identical to its document`,
    );
  }
});

test("each built-in derives its identity from its document and declares itself built-in", () => {
  assert.ok(BUILTIN_PERSONAS.length > 0);
  const names = new Set<string>();
  for (const persona of BUILTIN_PERSONAS) {
    assert.equal(persona.builtin, true);
    assert.equal(persona.archivedAt, null);
    assert.equal(persona.revision, 1);
    // No stored override: a built-in resolves through the app-wide provider ladder.
    assert.equal(persona.runner, null);
    assert.equal(persona.model, null);
    assert.equal(persona.name, /^#\s+(.+)$/m.exec(persona.guidanceMarkdown)![1]!.trim());
    assert.equal(persona.normalizedName, normalizePersonaName(persona.name));
    assert.ok(persona.description.length > 0 && !persona.description.includes("\n"));
    assert.equal(names.has(persona.normalizedName), false, "two built-ins share a name");
    names.add(persona.normalizedName);
  }
  assert.equal(
    BUILTIN_PERSONAS.some((persona) => persona.id === builtinPersonaId("code-risk-reviewer")),
    true,
  );
});

test("the catalog carries built-ins with no row and no seeding step", () => {
  const listed = store.listPersonas();
  for (const persona of BUILTIN_PERSONAS) {
    assert.equal(listed.some((candidate) => candidate.id === persona.id), true);
    assert.deepEqual(store.getPersona(persona.id), persona);
  }
  // Archived listings carry them too: a built-in is never archived, so it belongs in both.
  assert.equal(store.listPersonas(true).length, listed.length);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM personas`).get()!.n,
    0,
    "a built-in must not become a row",
  );
});

test("editing, archiving or re-creating a built-in is refused with the reason and the row", () => {
  const target = BUILTIN_PERSONAS[0]!;
  for (const write of [
    store.updatePersonaCas(target.id, 1, { description: "Mine now" }),
    store.archivePersonaCas(target.id, 1),
    insert(target.id, "Something else"),
  ]) {
    assert.equal(write.ok, false);
    if (write.ok) return;
    assert.equal(write.reason, "builtin");
    assert.deepEqual(write.current, target);
  }
  assert.deepEqual(store.getPersona(target.id), target, "a refused write left the built-in alone");
});

test("a built-in's name cannot be taken by a create or a rename", () => {
  const target = BUILTIN_PERSONAS[0]!;
  const taken = insert("p1", target.name.toUpperCase());
  assert.equal(taken.ok, false);
  if (!taken.ok) {
    assert.equal(taken.reason, "name_conflict");
    assert.deepEqual(taken.current, target);
  }

  assert.equal(insert("p2", "Mine").ok, true);
  const renamed = store.updatePersonaCas("p2", 1, {
    name: target.name,
    normalizedName: target.normalizedName,
  });
  assert.equal(renamed.ok, false);
  if (!renamed.ok) assert.equal(renamed.reason, "name_conflict");
});

test("a Persona imported before it shipped keeps its name and shadows the built-in", () => {
  const target = BUILTIN_PERSONAS[0]!;
  // The unique index is what an older build let this row reserve; the merge honours it.
  db.prepare(
    `INSERT INTO personas (id, name, normalized_name, description, guidance_md, runner_id,
       model_id, revision, archived_at, created_at, updated_at)
     VALUES ('legacy', ?, ?, '', '# Mine', NULL, NULL, 3, NULL, 1, 1)`,
  ).run(target.name, target.normalizedName);

  const listed = store.listPersonas();
  const matching = listed.filter((persona) => persona.normalizedName === target.normalizedName);
  assert.equal(matching.length, 1, "the operator's own copy is the only one under that name");
  assert.equal(matching[0]!.id, "legacy");
  assert.equal(matching[0]!.builtin, false);
  // Still addressable by id, because a draft or a published version may already name it.
  assert.deepEqual(store.getPersona(target.id), target);
  // And their own copy stays editable, including a save that keeps the name it reserved.
  const edited = store.updatePersonaCas("legacy", 3, {
    name: target.name,
    normalizedName: target.normalizedName,
    description: "Still mine",
  });
  assert.equal(edited.ok, true);

  // Archiving that copy retires it, and the built-in it was hiding comes back - in BOTH
  // listings. An archived row that kept shadowing would drop the built-in out of
  // `listPersonas(true)`, which is what the SSE snapshot is built from, while leaving it in
  // the active list: the archived listing has to stay a superset of the active one.
  assert.equal(store.archivePersonaCas("legacy", 4, 900).ok, true);
  const activeIds = new Set(store.listPersonas().map((persona) => persona.id));
  const allIds = new Set(store.listPersonas(true).map((persona) => persona.id));
  assert.equal(activeIds.has(target.id), true);
  assert.equal(activeIds.has("legacy"), false);
  assert.equal(allIds.has(target.id), true);
  assert.equal(allIds.has("legacy"), true);
  for (const id of activeIds) assert.equal(allIds.has(id), true, `${id} vanished from the archived listing`);
});

test("Publish validates and snapshots a built-in without it ever being a row", () => {
  const target = BUILTIN_PERSONAS[0]!;
  const draft = {
    nodes: [
      { id: "session", kind: "session" as const, position: { x: 0, y: 0 } },
      { id: "judge", kind: "persona" as const, personaId: target.id, position: { x: 220, y: 0 } },
      { id: "end", kind: "end" as const, outcome: "Approved", position: { x: 440, y: 0 } },
    ],
    edges: [
      { id: "start", source: "session", sourcePort: "submitted" as const, target: "judge", targetPort: "activate" as const },
      { id: "pass", source: "judge", sourcePort: "pass" as const, target: "end", targetPort: "terminal" as const },
      { id: "fail", source: "judge", sourcePort: "fail" as const, target: "session", targetPort: "return_for_changes" as const },
    ],
  };
  const created = store.insertWorkflow({
    id: "w1",
    name: "Gate",
    normalizedName: "gate",
    description: "",
    draft,
    completionPolicy: { kind: "none" },
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(created.ok, true);
  const saved = store.updateWorkflowCas("w1", 1, { draft }, 2);
  assert.equal(saved.ok, true);
  if (!saved.ok) return;

  const published = store.publishWorkflow("w1", saved.workflow.draftRevision, "v1", 3);
  assert.equal(published.ok, true);
  if (!published.ok) return;
  const node = published.version.graph.nodes.find((candidate) => candidate.kind === "persona");
  assert.equal(node?.kind, "persona");
  if (node?.kind !== "persona") return;
  assert.equal(node.persona.sourcePersonaId, target.id);
  assert.equal(node.persona.guidanceMarkdown, target.guidanceMarkdown);
});
