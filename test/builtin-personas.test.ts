import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";

// What is at stake: the eight review roles ship WITH the application, which is a promise about
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
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { BUILTIN_PERSONAS, builtinPersonaId } = await import("../src/server/workflows/builtin-personas.ts");
const { BUILTIN_PERSONA_SOURCES } = await import("../src/server/workflows/builtin-personas.generated.ts");
// The generator itself, not a second implementation of it: a drift check that re-rendered the
// module its own way would agree with itself and say nothing about `npm run personas`.
const { NON_PERSONA_DOCUMENTS, builtinPersonaSources, renderBuiltinPersonaModule } = await import("../scripts/builtin-personas.ts");
const { normalizePersonaName, personasForDisplay } = await import("../src/shared/workflow.ts");

const root = resolve(import.meta.dirname, "..");
const personasDir = join(root, "personas");
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
    renderBuiltinPersonaModule(builtinPersonaSources(personasDir)),
    "run `npm run personas` and commit the result",
  );
  // The same exclusion the generator applies, from the generator, so this count cannot
  // drift into agreeing with a second copy of the rule instead of with the module.
  const excluded = new Set<string>(NON_PERSONA_DOCUMENTS);
  const documents = readdirSync(personasDir)
    .filter((entry) => entry.endsWith(".md") && !excluded.has(entry));
  assert.equal(BUILTIN_PERSONA_SOURCES.length, documents.length);
  for (const source of BUILTIN_PERSONA_SOURCES) {
    assert.equal(
      source.guidanceMarkdown,
      readFileSync(join(personasDir, `${source.slug}.md`), "utf8"),
      `${source.slug} is not byte-identical to its document`,
    );
  }
});

// `personas/` holds prose that is not a review role - the two operator briefs the daemon
// reads as files at runtime, and the directory's own README - and the generator globs the
// whole directory. Both directions of that exclusion are failure modes worth a name. A
// listed document that is gone means the list has gone stale and no longer describes the
// directory; a listed document that compiled in anyway means the Persona catalog is
// offering `builtin:FOREMAN` as a review role nobody wrote and no operator can archive.
test("the operator briefs and the README are in personas/ and are not Personas", () => {
  const slugs = new Set<string>(BUILTIN_PERSONA_SOURCES.map((source) => source.slug));
  for (const document of NON_PERSONA_DOCUMENTS) {
    assert.ok(
      existsSync(join(personasDir, document)),
      `${document} is excluded from the generator but is not in personas/ - update NON_PERSONA_DOCUMENTS`,
    );
    assert.equal(
      slugs.has(document.slice(0, -".md".length)),
      false,
      `${document} compiled in as a built-in Persona`,
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
  const quality = BUILTIN_PERSONAS.find(
    (persona) => persona.id === builtinPersonaId("code-quality-judge"),
  );
  assert.ok(quality, "Code Quality Judge is present in the built-in catalog");
  assert.equal(quality.name, "Code Quality Judge");
  assert.equal(
    quality.description,
    "Judge whether the submitted local change is safe, correct, and ready for its verified Pull Request action.",
  );
  assert.match(quality.guidanceMarkdown, /You have no repository tools and the pull request does not exist yet\./);
  const design = BUILTIN_PERSONAS.find(
    (persona) => persona.id === builtinPersonaId("code-design-reviewer"),
  );
  assert.ok(design, "Code Design Reviewer is present in the built-in catalog");
  assert.equal(design.name, "Code Design Reviewer");
  assert.equal(
    design.description,
    "Reviews the design of the change: whether its abstractions fit the problem, its "
    + "responsibilities sit in one place, its dependencies point the right way, and its behavior "
    + "is composed rather than inherited.",
  );
  // The anti-overreach rule that makes this role safe to put in a BLOCKING stage: it judges
  // the change, not the architecture it landed in. Losing this line turns the flagship
  // built-in's repair loop into an argument about pre-existing code the task never touched.
  assert.match(
    design.guidanceMarkdown,
    /The finding must be in the submitted change, or in code this change directly extends\./,
  );
  // The other half of the same guarantee, and the one that is easy to lose to a rewrite of the
  // requested-change section: `Author decision needed:` names a finding that already survived
  // the anti-overreach rules, never a way past them. Without this line the role can turn a
  // merely different but reasonable design into a blocking repair round by relabelling it.
  assert.match(
    design.guidanceMarkdown,
    /That title is not a route around those rules\./,
  );
  const coverage = BUILTIN_PERSONAS.find(
    (persona) => persona.id === builtinPersonaId("test-coverage-judge"),
  );
  assert.ok(coverage, "Test Coverage Judge is present in the built-in catalog");
  assert.equal(coverage.name, "Test Coverage Judge");
  assert.equal(
    coverage.description,
    "Judges whether the submitted tests genuinely exercise at least 80% of the changed executable "
    + "code, including its happy paths, boundaries, and exception behavior.",
  );
  assert.match(coverage.guidanceMarkdown, /At least 80% of the changed executable lines/);
  assert.match(
    coverage.guidanceMarkdown,
    /whether the test really tests what its name and description say it tests/,
  );
  for (const requiredCase of ["### Happy path", "### Boundaries and branches", "### Exceptions and failures"]) {
    assert.match(coverage.guidanceMarkdown, new RegExp(requiredCase));
  }
  assert.match(
    coverage.guidanceMarkdown,
    /A test whose name describes one branch while its setup reaches another\./,
  );
  const slop = BUILTIN_PERSONAS.find(
    (persona) => persona.id === builtinPersonaId("slop-filter"),
  );
  assert.ok(slop, "Slop Filter is present in the built-in catalog");
  assert.equal(slop.name, "Slop Filter");
  assert.equal(
    slop.description,
    "Rejects low-signal code, tests, comments, and prose that make a change look substantial "
    + "without adding trustworthy behavior or useful explanation.",
  );
  for (const standard of [
    "Redundant comments",
    "Defensive and error-handling cruft",
    "Hallucinated APIs or imports",
    "Tests that only validate mocks",
    "Trivial or tautological tests",
    "Padded, generic AI-style prose",
  ]) {
    assert.match(slop.guidanceMarkdown, new RegExp(`### ${standard}`));
  }
  // These limits keep the blocking role evidence-bound. Without them, unfamiliar APIs and
  // legitimate boundary checks can become speculative repair requests.
  assert.match(slop.guidanceMarkdown, /uncertainty is not proof\./);
  assert.match(
    slop.guidanceMarkdown,
    /Do not call an API hallucinated without supplied evidence that contradicts it\./,
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

  // Archiving that copy retires it, and the built-in it was hiding comes back in both
  // listings. The archived listing has to stay a superset of the active one.
  assert.equal(store.archivePersonaCas("legacy", 4, 900).ok, true);
  const activeIds = new Set(store.listPersonas().map((persona) => persona.id));
  const allIds = new Set(store.listPersonas(true).map((persona) => persona.id));
  assert.equal(activeIds.has(target.id), true);
  assert.equal(activeIds.has("legacy"), false);
  assert.equal(allIds.has(target.id), true);
  assert.equal(allIds.has("legacy"), true);
  for (const id of activeIds) assert.equal(allIds.has(id), true, `${id} vanished from the archived listing`);
});

test("the Registry stays addressable while display shadowing follows the live row", () => {
  const target = BUILTIN_PERSONAS[0]!;
  db.prepare(
    `INSERT INTO personas (id, name, normalized_name, description, guidance_md, runner_id,
       model_id, revision, archived_at, created_at, updated_at)
     VALUES ('legacy', ?, ?, '', '# Mine', NULL, NULL, 3, NULL, 1, 1)`,
  ).run(target.name, target.normalizedName);

  const registry = new Registry();
  const manager = new PersonaManager(registry, store);
  assert.equal(registry.snapshot().personas.some((persona) => persona.id === target.id), true);
  assert.equal(
    personasForDisplay(registry.snapshot().personas).some((persona) => persona.id === target.id),
    false,
  );

  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  const archived = manager.archive("legacy", 3, 900);
  unsubscribe();

  assert.equal(archived.ok, true);
  assert.equal(registry.snapshot().personas.some((persona) => persona.id === target.id), true);
  assert.equal(
    personasForDisplay(registry.snapshot().personas).some((persona) => persona.id === target.id),
    true,
  );
  assert.equal(
    events.some((event) => event.type === "persona_upsert" && event.persona.id === target.id),
    true,
  );
});

test("Publish validates and snapshots a shadowed built-in by id", () => {
  const target = BUILTIN_PERSONAS[0]!;
  db.prepare(
    `INSERT INTO personas (id, name, normalized_name, description, guidance_md, runner_id,
       model_id, revision, archived_at, created_at, updated_at)
     VALUES ('legacy', ?, ?, '', '# Mine', NULL, NULL, 3, NULL, 1, 1)`,
  ).run(target.name, target.normalizedName);
  assert.equal(store.listPersonas().some((persona) => persona.id === target.id), false);
  assert.equal(store.personaCatalog().some((persona) => persona.id === target.id), true);

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
    resumptionPolicy: "manual",
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
