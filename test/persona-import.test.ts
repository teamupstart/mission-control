import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: this is the one path where a Persona's review authority comes from a file
 * the daemon read rather than from text an operator typed, so every refusal has to be a refusal
 * rather than a silent adaptation. A truncated import would still be a valid Persona and would
 * still be pickable as a workflow judge while carrying less than the document it claims. A
 * provenance record that pointed somewhere else would make every later drift check agree with
 * the wrong file. And re-import must be an ordinary CAS write, so a stale tab loses instead of
 * overwriting what landed first.
 *
 * Driven over HTTP because that is the only write boundary the browser has, exactly as
 * `personas-http.test.ts` does for the rest of the Persona catalog.
 */

const home = mkdtempSync(join(tmpdir(), "mission-persona-import-"));
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
const { WORKFLOW_LIMITS } = await import("../src/shared/workflow.ts");
const { readPluginVersion } = await import("../src/server/workflows/persona-import.ts");

const db = openDb();
const sources = join(home, "sources");
mkdirSync(sources, { recursive: true });
after(() => rmSync(home, { recursive: true, force: true }));

const ROLE = "# Reviewer\r\n\r\nJudge the risk of the change.  \r\n\r\n## DO\r\n\r\n- Read the diff.\r\n";

interface ImportedPersona {
  id: string;
  name: string;
  description: string;
  guidanceMarkdown: string;
  revision: number;
  provenance: {
    sourcePath: string;
    sourceRepo: string | null;
    pluginVersion: string | null;
    contentSha256: string;
    importedAt: number;
  } | null;
}

function fixture() {
  clearWorkflowTables(db);
  db.exec(`DELETE FROM app_config WHERE key = 'llm'`);
  const registry = new Registry();
  const personas = new PersonaManager(registry, new WorkflowStore(db));
  const app = buildApp({
    registry,
    reviews: null as never,
    tasks: null as never,
    queues: null as never,
    personas,
  });
  const request = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers },
    });
  return { registry, request };
}

/** One role file, written where the daemon can read it. Returns its absolute path. */
function writeRole(name: string, text = ROLE): string {
  const path = join(sources, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

const importRole = (request: ReturnType<typeof fixture>["request"], path: string) =>
  request("/api/personas/import", { method: "POST", body: JSON.stringify({ path }) });

test("import stores the exact bytes, derives name and description, and records provenance", async () => {
  const { request, registry } = fixture();
  const path = writeRole("reviewer.md");
  const response = await importRole(request, path);
  assert.equal(response.status, 201);
  const persona = (await response.json()) as ImportedPersona;

  // Exact Markdown: CRLF, the trailing double space, every byte. The one thing an imported
  // reviewer's authority rests on.
  assert.equal(persona.guidanceMarkdown, ROLE);
  // The same heading rule the built-in catalog and the browser's Import .md use.
  assert.equal(persona.name, "Reviewer");
  assert.equal(persona.description, "Judge the risk of the change.");
  assert.equal(persona.revision, 1);
  assert.equal(persona.provenance?.sourcePath, path);
  assert.equal(
    persona.provenance?.contentSha256,
    createHash("sha256").update(Buffer.from(ROLE, "utf8")).digest("hex"),
  );
  assert.equal(typeof persona.provenance?.importedAt, "number");
  // Nothing to find above a bare temp directory, and null is the honest answer for both.
  assert.equal(persona.provenance?.pluginVersion, null);
  assert.equal(persona.provenance?.sourceRepo, null);

  // It is an ordinary Persona from here on: durable, streamed, and readable by id.
  const streamed = registry.snapshot().personas.find((row) => row.id === persona.id);
  assert.equal(streamed?.provenance?.sourcePath, path);
  const read = (await (await request(`/api/personas/${persona.id}`)).json()) as ImportedPersona;
  assert.equal(read.guidanceMarkdown, ROLE);
});

test("a document with no heading is named after its file, and its description stays empty", async () => {
  const { request } = fixture();
  const path = writeRole("nested/no-heading.md", "Just a paragraph, no heading at all.\n");
  const persona = (await (await importRole(request, path)).json()) as ImportedPersona;
  assert.equal(persona.name, "no-heading");
  assert.equal(persona.description, "Just a paragraph, no heading at all.");
});

test("the plugin version comes from the nearest .claude-plugin manifest, and the repo from .git", async () => {
  const { request } = fixture();
  const plugin = join(sources, "marketplace", "plugins", "agent-team");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(sources, "marketplace", ".git"), { recursive: true });
  writeFileSync(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "agent-team", version: "0.2.0" }),
    "utf8",
  );
  const path = writeRole("marketplace/plugins/agent-team/references/roles/tester.md");
  const persona = (await (await importRole(request, path)).json()) as ImportedPersona;
  assert.equal(persona.provenance?.pluginVersion, "0.2.0");
  // Compared against the RESOLVED root, because ownership is discovered from where the bytes
  // live. On macOS the temp tree is reached through `/var` -> `/private/var`, so this and
  // `sourcePath` legitimately disagree about their prefix for the very same file.
  assert.equal(persona.provenance?.sourceRepo, realpathSync(join(sources, "marketplace")));

  // A manifest with no usable version is not an answer, and a GRANDPARENT plugin's version is
  // not this document's - so the nearest manifest wins even when it says nothing.
  const inner = join(plugin, "vendored");
  mkdirSync(join(inner, ".claude-plugin"), { recursive: true });
  writeFileSync(join(inner, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x" }), "utf8");
  assert.equal(await readPluginVersion(join(inner, "roles", "any.md")), null);
});

test("a path that cannot become a Persona is refused by name, and nothing is stored", async () => {
  const { request } = fixture();
  const before = ((await (await request("/api/personas")).json()) as unknown[]).length;

  const relative = await importRole(request, "sources/reviewer.md");
  assert.equal(relative.status, 400);
  assert.match(((await relative.json()) as { error: string }).error, /absolute/);

  const missing = await importRole(request, join(sources, "not-here.md"));
  assert.equal(missing.status, 400);
  const missingBody = (await missing.json()) as { error: string; code: string };
  assert.equal(missingBody.code, "persona_source_unreadable");
  assert.match(missingBody.error, /no file at/);

  const directory = await importRole(request, sources);
  assert.equal(directory.status, 400);
  assert.match(((await directory.json()) as { error: string }).error, /not a regular file/);

  // Refused, never truncated: a Persona carrying a prefix of its source would review with less
  // authority than the document it names, and nothing about it would look wrong.
  const oversized = writeRole("huge.md", `# Huge\n\n${"x".repeat(WORKFLOW_LIMITS.personaGuidanceBytes)}`);
  const tooBig = await importRole(request, oversized);
  assert.equal(tooBig.status, 400);
  assert.match(((await tooBig.json()) as { error: string }).error, /limited to 100000 UTF-8 bytes/);

  const binary = join(sources, "binary.md");
  writeFileSync(binary, Buffer.from([0x23, 0x20, 0x48, 0x00, 0x69]));
  const notText = await importRole(request, binary);
  assert.equal(notText.status, 400);
  assert.match(((await notText.json()) as { error: string }).error, /not a text document/);

  const invalid = join(sources, "invalid-utf8.md");
  writeFileSync(invalid, Buffer.from([0x23, 0x20, 0x48, 0xff, 0x69]));
  const notUtf8 = await importRole(request, invalid);
  assert.equal(notUtf8.status, 400);
  assert.match(((await notUtf8.json()) as { error: string }).error, /not valid UTF-8/);

  const empty = writeRole("empty.md", "   \n\n");
  const nothing = await importRole(request, empty);
  assert.equal(nothing.status, 400);
  assert.match(((await nothing.json()) as { error: string }).error, /no content to review with/);

  assert.equal(((await (await request("/api/personas")).json()) as unknown[]).length, before);
});

/**
 * The regular-file check is answered by the DESCRIPTOR, not by a path.
 *
 * A `stat` followed by an `open` proves nothing about what was opened - the name can be pointed
 * at something else in between - so the implementation has no path-based `stat` at all and
 * validates the handle instead. These cases are what that buys, and each one names a way the
 * previous shape failed:
 *
 * - A FIFO would block the whole request inside `open` until somebody wrote to it. If this test
 *   ever hangs rather than fails, `O_NONBLOCK` has been dropped from the open flags.
 * - A character device would pass an `isFile()` taken a moment earlier and then feed the reader
 *   bytes that were never a document.
 *
 * Both are refused by name here, and neither can reach the read: without the `fstat` guard the
 * FIFO would come back "has no content to review with" and `/dev/zero` "is not a text document",
 * which is how this test would report the guard's absence.
 */
test("a FIFO and a character device are refused on the descriptor, not read", async () => {
  const { request } = fixture();
  const fifo = join(sources, "role.fifo");
  execFileSync("mkfifo", [fifo]);
  const blocked = await importRole(request, fifo);
  assert.equal(blocked.status, 400);
  assert.match(((await blocked.json()) as { error: string }).error, /is not a regular file/);

  for (const device of ["/dev/zero", "/dev/null"]) {
    const refused = await importRole(request, device);
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /is not a regular file/);
  }
  assert.deepEqual((await (await request("/api/personas")).json() as Array<{ builtin: boolean }>)
    .filter((row) => !row.builtin), []);
});

/**
 * An unusable NEAREST manifest stops the search rather than deferring to the one above it.
 *
 * The two failure modes are not the same answer. A manifest that is absent means this directory
 * is not a plugin root, so the walk continues. One that exists and cannot be read marks a plugin
 * boundary this build cannot describe - and walking past it records the NEXT plugin up's version
 * on a document that belongs to this one. That is worse than recording nothing: `null` reads as
 * "undeterminable", while `0.2.0` reads as "adapted from agent-team 0.2.0" about a file that never
 * was, and it is the drift badge's own wording that would carry the lie.
 *
 * The outer plugin here is what makes the case real - with nothing above the FIFO, a fall-through
 * and a stop are indistinguishable.
 */
test("an unreadable nearest plugin manifest yields no version, not the outer plugin's", async () => {
  const { request } = fixture();
  const outer = join(sources, "fifo-plugin");
  mkdirSync(join(outer, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(outer, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "outer-marketplace-plugin", version: "9.9.9" }),
    "utf8",
  );
  const plugin = join(outer, "plugins", "role-pack");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  execFileSync("mkfifo", [join(plugin, ".claude-plugin", "plugin.json")]);

  const path = writeRole("fifo-plugin/plugins/role-pack/references/roles/reviewer.md");
  const persona = (await (await importRole(request, path)).json()) as ImportedPersona;
  // The manifest read is best-effort, so its failure mode is a missing version - never a failed
  // or a hanging import.
  assert.equal(persona.guidanceMarkdown, ROLE);
  assert.notEqual(persona.provenance?.pluginVersion, "9.9.9");
  assert.equal(persona.provenance?.pluginVersion, null);

  // Same rule for a manifest that is a regular file but too large to be one worth reading.
  const bigPlugin = join(outer, "plugins", "big-pack");
  mkdirSync(join(bigPlugin, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(bigPlugin, ".claude-plugin", "plugin.json"),
    `{"version":"1.0.0","padding":"${"x".repeat(100_000)}"}`,
    "utf8",
  );
  // Its own heading, or it would be refused as a duplicate of the Persona imported above and the
  // assertion would be reading an error body rather than a provenance record.
  const bigPath = writeRole(
    "fifo-plugin/plugins/big-pack/references/roles/second-reviewer.md",
    "# Second Reviewer\n\nJudge it too.\n",
  );
  const second = (await (await importRole(request, bigPath)).json()) as ImportedPersona;
  assert.equal(second.name, "Second Reviewer");
  assert.equal(second.provenance?.pluginVersion, null);
});

test("a symlinked source is read through the link and remembered as the path that was named", async () => {
  const { request } = fixture();
  const target = writeRole("linked/real-reviewer.md");
  const link = join(sources, "linked-reviewer.md");
  symlinkSync(target, link);
  const persona = (await (await importRole(request, link)).json()) as ImportedPersona;
  assert.equal(persona.guidanceMarkdown, ROLE);
  // The operator's own path, not the resolved target: that is what they pointed at, and a plugin
  // upgrade that re-points the link is upstream CHANGE rather than a stale pin.
  assert.equal(persona.provenance?.sourcePath, link);
});

/**
 * Identity and OWNERSHIP are answered by two different paths, and this is the case that proves
 * they have to be.
 *
 * A role file symlinked out of an installed plugin - the shape an operator gets the moment they
 * keep a tidy directory of the roles they import - has its `.claude-plugin/plugin.json` and its
 * `.git` above the TARGET and nothing whatsoever above the link. Walking the lexical path for
 * those recorded `null` twice over for a file that plainly belongs to a versioned plugin, which
 * is precisely the fact the drift badge is supposed to be able to name.
 */
test("provenance metadata is discovered through the link, while the path stays as named", async () => {
  const { request } = fixture();
  const plugin = join(sources, "linked-marketplace", "plugins", "role-pack");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(sources, "linked-marketplace", ".git"), { recursive: true });
  writeFileSync(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "role-pack", version: "3.1.4" }),
    "utf8",
  );
  const target = writeRole("linked-marketplace/plugins/role-pack/references/roles/auditor.md");
  // The link lives OUTSIDE the plugin, so nothing is discoverable above it.
  const link = join(sources, "my-roles-auditor.md");
  symlinkSync(target, link);

  const persona = (await (await importRole(request, link)).json()) as ImportedPersona;
  assert.equal(persona.provenance?.pluginVersion, "3.1.4");
  assert.equal(
    persona.provenance?.sourceRepo,
    realpathSync(join(sources, "linked-marketplace")),
  );
  // And the path is still the one the operator named, so re-import follows the link they made.
  assert.equal(persona.provenance?.sourcePath, link);
});

test("an import that collides with an existing name is the ordinary name conflict", async () => {
  const { request } = fixture();
  const first = writeRole("first.md");
  assert.equal((await importRole(request, first)).status, 201);
  const second = writeRole("second.md", "# reviewer\n\nA second document, same name.\n");
  const clash = await importRole(request, second);
  assert.equal(clash.status, 409);
  assert.equal(((await clash.json()) as { code: string }).code, "persona_name_conflict");
});

test("drift reports current, changed and missing per request", async () => {
  const { request } = fixture();
  const stable = writeRole("stable.md", "# Stable\n\nUnchanged.\n");
  const edited = writeRole("edited.md", "# Edited\n\nBefore.\n");
  const removed = writeRole("removed.md", "# Removed\n\nWill be deleted.\n");
  const ids = new Map<string, string>();
  for (const [label, path] of [["stable", stable], ["edited", edited], ["removed", removed]] as const) {
    const persona = (await (await importRole(request, path)).json()) as ImportedPersona;
    ids.set(label, persona.id);
  }
  // A Persona authored in the editor has no source file and is absent from the report entirely.
  const authored = (await (await request("/api/personas", {
    method: "POST",
    body: JSON.stringify({ name: "Typed here", guidanceMarkdown: "# Typed here\n\nMine.\n" }),
  })).json()) as ImportedPersona;

  const clean = await request("/api/personas/drift");
  assert.equal(clean.status, 200);
  const before = (await clean.json()) as { personas: Array<{ id: string; upstream: string }> };
  assert.deepEqual(
    before.personas.filter((row) => row.upstream !== "current"),
    [],
    "nothing has been touched on disk yet",
  );
  assert.equal(before.personas.some((row) => row.id === authored.id), false);

  writeFileSync(edited, "# Edited\n\nAfter - the upstream moved on.\n", "utf8");
  rmSync(removed);
  const after = (await (await request("/api/personas/drift")).json()) as {
    personas: Array<{ id: string; upstream: string }>;
  };
  const state = new Map(after.personas.map((row) => [row.id, row.upstream]));
  assert.equal(state.get(ids.get("stable")!), "current");
  assert.equal(state.get(ids.get("edited")!), "changed");
  assert.equal(state.get(ids.get("removed")!), "missing");

  // The stored guidance is untouched by any of it. Drift is a report, never a write.
  const stored = (await (await request(`/api/personas/${ids.get("edited")}`)).json()) as ImportedPersona;
  assert.equal(stored.guidanceMarkdown, "# Edited\n\nBefore.\n");
  assert.equal(stored.revision, 1);
});

test("re-import adopts the new text as a new revision and clears the drift", async () => {
  const { request } = fixture();
  const path = writeRole("adopted.md", "# Adopted\n\nFirst edition.\n");
  const persona = (await (await importRole(request, path)).json()) as ImportedPersona;
  const firstHash = persona.provenance!.contentSha256;

  writeFileSync(path, "# Adopted\r\n\r\nSecond edition, with CRLF.  \r\n", "utf8");
  const reimported = await request(`/api/personas/${persona.id}/reimport`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  assert.equal(reimported.status, 200);
  const updated = (await reimported.json()) as ImportedPersona;
  assert.equal(updated.guidanceMarkdown, "# Adopted\r\n\r\nSecond edition, with CRLF.  \r\n");
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.provenance?.contentSha256, firstHash);
  assert.equal(updated.provenance?.sourcePath, path);

  // The name and description are the operator's from the moment of import: a re-import adopts
  // guidance, and renaming stays an edit a human makes.
  assert.equal(updated.name, "Adopted");
  assert.equal(updated.description, "First edition.");

  const drift = (await (await request("/api/personas/drift")).json()) as {
    personas: Array<{ id: string; upstream: string }>;
  };
  assert.equal(drift.personas.find((row) => row.id === persona.id)?.upstream, "current");
});

test("re-import obeys CAS and refuses a built-in, an archived row, and a Persona with no source", async () => {
  const { request } = fixture();
  const path = writeRole("cas.md", "# Cas\n\nOne.\n");
  const persona = (await (await importRole(request, path)).json()) as ImportedPersona;
  writeFileSync(path, "# Cas\n\nTwo.\n", "utf8");

  const stale = await request(`/api/personas/${persona.id}/reimport`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: 99 }),
  });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, "persona_revision_conflict");
  // The refusal changed nothing: the row still holds what it held.
  const untouched = (await (await request(`/api/personas/${persona.id}`)).json()) as ImportedPersona;
  assert.equal(untouched.guidanceMarkdown, "# Cas\n\nOne.\n");
  assert.equal(untouched.revision, 1);

  const unparsed = await request(`/api/personas/${persona.id}/reimport`, { method: "POST", body: "{}" });
  assert.equal(unparsed.status, 400);

  // A source that has gone missing refuses the whole re-import rather than bumping a revision
  // to the guidance the Persona already had.
  rmSync(path);
  const gone = await request(`/api/personas/${persona.id}/reimport`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  assert.equal(gone.status, 400);
  assert.equal(((await gone.json()) as { code: string }).code, "persona_source_unreadable");
  assert.equal(
    ((await (await request(`/api/personas/${persona.id}`)).json()) as ImportedPersona).revision,
    1,
  );

  const authored = (await (await request("/api/personas", {
    method: "POST",
    body: JSON.stringify({ name: "Hand written", guidanceMarkdown: "# Hand written\n\nMine.\n" }),
  })).json()) as ImportedPersona;
  const notImported = await request(`/api/personas/${authored.id}/reimport`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  assert.equal(notImported.status, 409);
  const notImportedBody = (await notImported.json()) as { code: string; error: string };
  assert.equal(notImportedBody.code, "persona_not_imported");
  // Names the way forward, like the built-in refusal it is modelled on, rather than the state.
  assert.match(notImportedBody.error, /Import from path/);

  const builtin = ((await (await request("/api/personas")).json()) as Array<{
    id: string;
    builtin: boolean;
    revision: number;
  }>).find((row) => row.builtin)!;
  const shipped = await request(`/api/personas/${builtin.id}/reimport`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: builtin.revision }),
  });
  assert.equal(shipped.status, 409);
  assert.equal(((await shipped.json()) as { code: string }).code, "persona_builtin");

  assert.equal((await request("/api/personas/missing/reimport", {
    method: "POST",
    body: JSON.stringify({ expectedRevision: 1 }),
  })).status, 404);
});

test("an archived imported Persona is refused a re-import and drops out of the drift report", async () => {
  const { request } = fixture();
  const path = writeRole("archived.md", "# Archived\n\nOne.\n");
  const persona = (await (await importRole(request, path)).json()) as ImportedPersona;
  assert.equal((await request(`/api/personas/${persona.id}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision: 1 }),
  })).status, 200);
  writeFileSync(path, "# Archived\n\nTwo.\n", "utf8");

  const refused = await request(`/api/personas/${persona.id}/reimport`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: 2 }),
  });
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { code: string }).code, "persona_archived");

  // No badge for work that cannot be done: an archived Persona is read-only.
  const drift = (await (await request("/api/personas/drift")).json()) as {
    personas: Array<{ id: string }>;
  };
  assert.equal(drift.personas.some((row) => row.id === persona.id), false);
});

/**
 * Both new writes are bounded BEFORE Zod ever sees the body, and each on the ceiling its own
 * schema implies rather than on the guidance-shaped one the create route beside them uses.
 *
 * The distinction is the whole point: a ~600 KB cap on a body that can only legally hold one
 * integer, or one 4096-character path, is a body limit in name only - the daemon has already
 * allocated and parsed the abuse by the time the schema rejects it.
 */
test("the import and re-import bodies are bounded on their own schemas before parsing", async () => {
  const { request } = fixture();
  const path = writeRole("bounded.md", "# Bounded\n\nOne.\n");
  const persona = (await (await importRole(request, path)).json()) as ImportedPersona;

  // An integer-only body: 100 KB of it is refused without being parsed.
  const oversizedRevision = await request(`/api/personas/${persona.id}/reimport`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: 1, padding: "x".repeat(100_000) }),
  });
  assert.equal(oversizedRevision.status, 413);
  // Refused before anything ran, so the row is exactly as it was.
  assert.equal(
    ((await (await request(`/api/personas/${persona.id}`)).json()) as ImportedPersona).revision,
    1,
  );
  // Archive carries the same one integer and is bounded identically - its session-action twin
  // always was, and this one was the pair's unguarded half.
  assert.equal((await request(`/api/personas/${persona.id}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision: 1, padding: "x".repeat(100_000) }),
  })).status, 413);

  // A path-only body, likewise: far past the 4096-character path ceiling.
  assert.equal((await importRole(request, `/${"p".repeat(200_000)}.md`)).status, 413);
  // And a legal request of each shape still passes the guard: a cap that refused these would be
  // a regression dressed as hardening.
  assert.equal((await importRole(request, join(sources, `${"d".repeat(200)}.md`))).status, 400);
  const reimported = await request(`/api/personas/${persona.id}/reimport`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  assert.equal(reimported.status, 200);
});

test("a Persona named drift does not shadow the drift route", async () => {
  const { request } = fixture();
  // Route order, asserted rather than assumed: `/api/personas/:id` is registered after this and
  // would happily answer for the literal id "drift".
  const response = await request("/api/personas/drift");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { personas: [] });
});
