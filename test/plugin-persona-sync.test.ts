import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: this sync runs unattended on every boot and WRITES to the Persona catalog.
 * Three failures would each be worse than the feature is worth, and each has a test below.
 *
 * 1. Re-importing on every start, or after a plugin upgrade moves the install path. That is why
 *    identity is `sourceKey` and why the upgrade case is exercised explicitly.
 * 2. Resurrecting a Persona an operator archived. Archiving is the only "no" available here, and
 *    a boot that overrode it would make the feature impossible to opt out of.
 * 3. Overwriting an operator's own work - their edits to a supplied role, or their own Persona
 *    that happens to share a plain name like `Reviewer`. Their row wins in both cases.
 *
 * Driven through PersonaManager rather than HTTP because there is no route: this is boot-time
 * reconciliation, and the enumerator is injected so the matrix runs against real files on disk
 * without needing a real installed plugin.
 */

const home = mkdtempSync(join(tmpdir(), "mission-plugin-personas-"));
process.env.HARNESS_HOME = join(home, "state");
for (const prefix of ["MISSION_", "FLEET_", "HARNESS_"]) {
  delete process.env[`${prefix}WORKFLOW_PERSONA_MODEL`];
  delete process.env[`${prefix}LLM_RUNNER`];
}

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const {
  personaDescriptionFromDocument,
  personaFrontmatter,
  personaNameFromDocument,
  personaOriginRank,
} = await import("../src/shared/workflow.ts");
const { parseInstalledPlugins, claudePluginsDir } = await import(
  "../src/server/plugins/installed-plugins.ts"
);
const { enumeratePluginPersonaDocuments } = await import(
  "../src/server/plugins/persona-sources.ts"
);
const { PLUGIN_PERSONA_SOURCES } = await import(
  "../src/server/plugins/persona-source-registry.ts"
);

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

/** A role document shaped exactly like the ones the real catalog ships. */
const ROLE = `---
slug: reviewer
role-title: Reviewer
function:
  Reviews diff for security, correctness, intent-drift, and observability gaps. Posts inline
  findings via The Communications Gatekeeper.
optional: false
---

# The Reviewer

**Speech pattern:** Terse, declarative, verdict first.

## What The Reviewer does

- Reads the PR description first.
`;

function fixture() {
  clearWorkflowTables(db);
  db.exec(`DELETE FROM app_config WHERE key = 'llm'`);
  const registry = new Registry();
  const personas = new PersonaManager(registry, new WorkflowStore(db));
  return { registry, personas };
}

/** A fake installed plugin on disk: `<root>/<plugin>/<version>/references/roles/*.md`. */
function installPlugin(
  root: string,
  version: string,
  documents: Record<string, string>,
): string {
  const dir = join(home, root, version, "references", "roles");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(documents)) {
    writeFileSync(join(dir, name), text, "utf8");
  }
  return join(home, root, version);
}

/** The enumerator the sync would have got from a real install record. */
function enumerator(installPath: string, version: string | null) {
  return async () => await enumeratePluginPersonaDocuments(
    [{ plugin: "agent-team", marketplace: "upstartclaw", version, installPath }],
    PLUGIN_PERSONA_SOURCES,
  );
}

// ---- The registry itself -----------------------------------------------------------------

test("the registry names agent-team's role directory and nothing else", () => {
  // A guard on the plan decision, not a tautology: the eight `agents/*.md` subagents elsewhere in
  // that marketplace are tool-scoped task workers with no review remit, and a future edit that
  // adds them would fill a reviewer library with personas nobody would pick. If that becomes
  // wanted, this assertion is the place it gets argued.
  assert.equal(PLUGIN_PERSONA_SOURCES.length, 1);
  assert.deepEqual(PLUGIN_PERSONA_SOURCES[0], {
    marketplace: "upstartclaw",
    plugin: "agent-team",
    directory: "references/roles",
    catalogLabel: "UpstartClaw",
  });
});

// ---- Reading Claude Code's install record ------------------------------------------------

test("the install record yields one entry per installed scope", () => {
  const parsed = parseInstalledPlugins({
    version: 2,
    plugins: {
      "agent-team@upstartclaw": [
        { scope: "user", installPath: "/cache/upstartclaw/agent-team/0.1.1", version: "0.1.1" },
        { scope: "project", installPath: "/other/agent-team/0.1.0", version: "0.1.0" },
      ],
    },
  });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    plugin: "agent-team",
    marketplace: "upstartclaw",
    version: "0.1.1",
    installPath: "/cache/upstartclaw/agent-team/0.1.1",
  });
  // The second scope survives rather than being collapsed: a project-scoped install may be the
  // only copy an operator has, and dropping it here would hide the plugin entirely.
  assert.equal(parsed[1]?.installPath, "/other/agent-team/0.1.0");
});

test("an entry this build cannot use costs that entry and nothing else", () => {
  const parsed = parseInstalledPlugins({
    version: 2,
    plugins: {
      // No marketplace: this daemon addresses a plugin as plugin-and-marketplace, and half an
      // address is not one.
      "agent-team": [{ installPath: "/cache/a" }],
      // A relative install path would be resolved against the daemon's cwd, reading a directory
      // the record never named.
      "relative@upstartclaw": [{ installPath: "cache/b" }],
      "missing-path@upstartclaw": [{ scope: "user" }],
      "not-an-array@upstartclaw": { installPath: "/cache/c" },
      "good@upstartclaw": [{ installPath: "/cache/d", version: "1.0.0" }],
    },
  });
  assert.deepEqual(parsed.map((one) => one.plugin), ["good"]);
});

test("a record with a shape this build does not recognise reads as nothing installed", () => {
  // "Nothing installed" is by far the most common truth on a real machine, so every unreadable
  // shape has to land on it silently rather than throwing into a boot.
  for (const shape of [null, undefined, 42, "text", {}, { plugins: null }, { plugins: [] }]) {
    assert.deepEqual(parseInstalledPlugins(shape), []);
  }
});

test("a plugin name containing @ splits on the last one", () => {
  const parsed = parseInstalledPlugins({
    plugins: { "@scope/tool@upstartclaw": [{ installPath: "/cache/e" }] },
  });
  assert.equal(parsed[0]?.plugin, "@scope/tool");
  assert.equal(parsed[0]?.marketplace, "upstartclaw");
});

test("CLAUDE_CONFIG_DIR relocates where plugins are looked for", () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = "/elsewhere/config";
    assert.equal(claudePluginsDir("/home/someone"), join("/elsewhere/config", "plugins"));
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(claudePluginsDir("/home/someone"), join("/home/someone", ".claude", "plugins"));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

// ---- Enumerating documents ----------------------------------------------------------------

test("enumeration finds the .md documents, in filename order, one level deep", async () => {
  const installPath = installPlugin("enumerate", "0.1.1", {
    "tester.md": ROLE,
    "reviewer.md": ROLE,
    "themes.md": ROLE,
    "notes.txt": "not a document",
  });
  mkdirSync(join(installPath, "references", "roles", "nested"), { recursive: true });
  writeFileSync(
    join(installPath, "references", "roles", "nested", "buried.md"),
    ROLE,
    "utf8",
  );

  const found = await enumerator(installPath, "0.1.1")();
  assert.deepEqual(
    found.documents.map((one) => one.sourceKey),
    [
      "upstartclaw/agent-team/references/roles/reviewer.md",
      "upstartclaw/agent-team/references/roles/tester.md",
      "upstartclaw/agent-team/references/roles/themes.md",
    ],
  );
  assert.equal(found.truncated.length, 0);
  // The version is recorded as metadata but is deliberately absent from the identity - see the
  // upgrade test below for why that is the whole point.
  assert.equal(found.documents[0]?.pluginVersion, "0.1.1");
  assert.equal(found.documents[0]?.catalogLabel, "UpstartClaw");
  assert.ok(!found.documents[0]?.sourceKey.includes("0.1.1"));
});

test("a plugin that is not installed, or lacks the directory, offers nothing", async () => {
  // Not installed: the registry entry matches no install record entry.
  const none = await enumeratePluginPersonaDocuments([], PLUGIN_PERSONA_SOURCES);
  assert.deepEqual(none.documents, []);

  // Installed, but this version does not ship the directory the entry names. A layout change is
  // not an error an operator can act on, so it is silence rather than a warning.
  const bare = join(home, "bare", "0.2.0");
  mkdirSync(bare, { recursive: true });
  const missing = await enumerator(bare, "0.2.0")();
  assert.deepEqual(missing.documents, []);
});

// ---- Deriving name and description --------------------------------------------------------

test("frontmatter supplies the name and the one-line function, folded onto one line", () => {
  assert.deepEqual(personaFrontmatter(ROLE), {
    "role-title": "Reviewer",
    function:
      "Reviews diff for security, correctness, intent-drift, and observability gaps. Posts inline findings via The Communications Gatekeeper.",
  });
  // Without this, the name would be the heading's "The Reviewer" and the description would be
  // "**Speech pattern:** Terse, declarative, verdict first." - a role nobody named and a summary
  // about prose style.
  assert.equal(personaNameFromDocument(ROLE, "fallback"), "Reviewer");
  assert.ok(personaDescriptionFromDocument(ROLE).startsWith("Reviews diff for security"));
});

test("a document with no frontmatter, or an unclosed block, falls back to the heading rules", () => {
  const plain = "# Risk Judge\n\nJudges risk.\n";
  assert.deepEqual(personaFrontmatter(plain), {});
  assert.equal(personaNameFromDocument(plain, "fallback"), "Risk Judge");
  assert.equal(personaDescriptionFromDocument(plain), "Judges risk.");

  // An opening fence with no closing one is not frontmatter, and must not swallow the document.
  const unclosed = "---\nrole-title: Ignored\n\n# Real Heading\n\nBody.\n";
  assert.deepEqual(personaFrontmatter(unclosed), {});
  assert.equal(personaNameFromDocument(unclosed, "fallback"), "Real Heading");

  // A `---` further down is a horizontal rule, never frontmatter.
  const rule = "# Heading\n\n---\n\nrole-title: not a field\n";
  assert.deepEqual(personaFrontmatter(rule), {});
});

test("an empty or absent frontmatter value does not erase what the heading could supply", () => {
  const empty = "---\nrole-title:\nslug: x\n---\n\n# Heading Wins\n\nBody.\n";
  assert.equal(personaNameFromDocument(empty, "fallback"), "Heading Wins");
  assert.equal(personaDescriptionFromDocument(empty), "Body.");
});

// ---- Ordering ------------------------------------------------------------------------------

test("origin ranks shipped, then catalog-supplied, then the operator's own", () => {
  const provenance = {
    sourcePath: "/p/r.md",
    sourceRepo: null,
    pluginVersion: null,
    contentSha256: "a".repeat(64),
    importedAt: 1,
  };
  assert.equal(personaOriginRank({ builtin: true, provenance: null }), 0);
  assert.equal(
    personaOriginRank({
      builtin: false,
      provenance: { ...provenance, sourceKey: "m/p/r.md", catalogLabel: "UpstartClaw" },
    }),
    1,
  );
  // Imported by hand is the operator's own work, and sorts with it rather than with a catalog.
  assert.equal(
    personaOriginRank({
      builtin: false,
      provenance: { ...provenance, sourceKey: null, catalogLabel: null },
    }),
    2,
  );
  assert.equal(personaOriginRank({ builtin: false, provenance: null }), 2);
});

test("the library lists shipped reviewers first, then the catalog's, then the operator's", async () => {
  const { personas } = fixture();
  const installPath = installPlugin("ordering", "0.1.1", { "reviewer.md": ROLE });
  personas.create({
    name: "Aardvark Auditor",
    description: "",
    guidanceMarkdown: "# Aardvark Auditor\n\nMine.\n",
    runner: null,
    model: null,
  });
  await personas.syncFromPluginCatalogs(1_000, enumerator(installPath, "0.1.1"));

  const listed = personas.list();
  const ranks = listed.map((one) => personaOriginRank(one));
  // Monotonic: a name-alphabetical list would have put "Aardvark Auditor" first, above every
  // built-in, which is exactly the burial this ordering exists to prevent.
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(listed.at(-1)?.name, "Aardvark Auditor");
  assert.equal(listed.find((one) => one.name === "Reviewer")?.provenance?.catalogLabel, "UpstartClaw");
});

// ---- The reconciliation matrix -------------------------------------------------------------

test("the first sync imports the catalog's documents with catalog provenance", async () => {
  const { personas, registry } = fixture();
  const installPath = installPlugin("first", "0.1.1", { "reviewer.md": ROLE, "tester.md": ROLE.replace("role-title: Reviewer", "role-title: Tester") });

  const result = await personas.syncFromPluginCatalogs(5_000, enumerator(installPath, "0.1.1"));
  assert.deepEqual(result.imported.map((one) => one.name).sort(), ["Reviewer", "Tester"]);
  assert.deepEqual(result.skipped, []);

  const imported = personas.list().find((one) => one.name === "Reviewer");
  assert.equal(imported?.provenance?.catalogLabel, "UpstartClaw");
  assert.equal(imported?.provenance?.sourceKey, "upstartclaw/agent-team/references/roles/reviewer.md");
  assert.equal(imported?.provenance?.pluginVersion, "0.1.1");
  assert.equal(imported?.revision, 1);
  // Exact bytes, frontmatter included: the hash a drift check compares is over what is on disk,
  // so stripping the block would make every later drift check disagree with the file.
  assert.equal(imported?.guidanceMarkdown, ROLE);
  // An ordinary Persona from here: streamed like any other.
  assert.ok(registry.snapshot().personas.some((one) => one.id === imported?.id));
});

test("syncing again imports nothing", async () => {
  const { personas } = fixture();
  const installPath = installPlugin("again", "0.1.1", { "reviewer.md": ROLE });
  await personas.syncFromPluginCatalogs(1_000, enumerator(installPath, "0.1.1"));

  const second = await personas.syncFromPluginCatalogs(2_000, enumerator(installPath, "0.1.1"));
  assert.deepEqual(second.imported, []);
  assert.deepEqual(second.skipped, []);
  assert.equal(personas.list().filter((one) => one.name === "Reviewer").length, 1);
});

test("a plugin upgrade does not import the same document again", async () => {
  const { personas } = fixture();
  const before = installPlugin("upgrade", "0.1.1", { "reviewer.md": ROLE });
  await personas.syncFromPluginCatalogs(1_000, enumerator(before, "0.1.1"));

  // The install path changes on every upgrade, which is exactly why identity is not the path.
  const after = installPlugin("upgrade", "0.2.0", { "reviewer.md": `${ROLE}\n- And the tests.\n` });
  const result = await personas.syncFromPluginCatalogs(2_000, enumerator(after, "0.2.0"));

  assert.deepEqual(result.imported, []);
  const rows = personas.list().filter((one) => one.name === "Reviewer");
  assert.equal(rows.length, 1);
  // And the upgrade is NOT silently adopted: the row still holds what was imported, so the
  // change surfaces as drift for a human to adopt rather than as a reviewer whose authority
  // changed while nobody was looking.
  assert.equal(rows[0]?.guidanceMarkdown, ROLE);
  assert.equal(rows[0]?.revision, 1);
});

test("an archived catalog Persona stays archived across a sync", async () => {
  const { personas } = fixture();
  const installPath = installPlugin("archived", "0.1.1", { "reviewer.md": ROLE });
  await personas.syncFromPluginCatalogs(1_000, enumerator(installPath, "0.1.1"));
  const imported = personas.list().find((one) => one.name === "Reviewer");
  assert.ok(imported);
  const archived = personas.archive(imported.id, imported.revision, 1_500);
  assert.equal(archived.ok, true);

  const result = await personas.syncFromPluginCatalogs(2_000, enumerator(installPath, "0.1.1"));

  // Archiving is the only "no" this feature offers. A boot that overrode it would make the
  // whole thing impossible to opt out of.
  assert.deepEqual(result.imported, []);
  assert.equal(personas.list().some((one) => one.name === "Reviewer"), false);
  assert.equal(personas.list(true).filter((one) => one.name === "Reviewer").length, 1);
});

test("an operator's own edits to a supplied Persona survive a sync", async () => {
  const { personas } = fixture();
  const installPath = installPlugin("edited", "0.1.1", { "reviewer.md": ROLE });
  await personas.syncFromPluginCatalogs(1_000, enumerator(installPath, "0.1.1"));
  const imported = personas.list().find((one) => one.name === "Reviewer");
  assert.ok(imported);
  const edited = personas.update(
    imported.id,
    { expectedRevision: imported.revision, guidanceMarkdown: "# Reviewer\n\nMy own rules.\n" },
    1_500,
  );
  assert.equal(edited.ok, true);

  await personas.syncFromPluginCatalogs(2_000, enumerator(installPath, "0.1.1"));

  const after = personas.list().find((one) => one.name === "Reviewer");
  assert.equal(after?.guidanceMarkdown, "# Reviewer\n\nMy own rules.\n");
  assert.equal(after?.revision, 2);
});

test("a name the operator already owns is skipped, with a reason, and their row wins", async () => {
  const { personas } = fixture();
  const installPath = installPlugin("conflict", "0.1.1", { "reviewer.md": ROLE });
  const mine = personas.create({
    name: "Reviewer",
    description: "Mine first.",
    guidanceMarkdown: "# Reviewer\n\nMine first.\n",
    runner: null,
    model: null,
  });
  assert.equal(mine.ok, true);

  const result = await personas.syncFromPluginCatalogs(2_000, enumerator(installPath, "0.1.1"));

  assert.deepEqual(result.imported, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]?.reason ?? "", /already exists/);
  assert.equal(result.skipped[0]?.sourceKey, "upstartclaw/agent-team/references/roles/reviewer.md");
  // Expected in normal use, because these roles carry plain titles. The operator's document is
  // untouched and stays the one Reviewer in the catalog.
  const rows = personas.list().filter((one) => one.name === "Reviewer");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.guidanceMarkdown, "# Reviewer\n\nMine first.\n");
  assert.equal(rows[0]?.provenance, null);

  // And it is retried on the next boot rather than remembered as refused: the operator may have
  // renamed theirs since, and nothing durable recorded the refusal.
  const retried = await personas.syncFromPluginCatalogs(3_000, enumerator(installPath, "0.1.1"));
  assert.equal(retried.skipped.length, 1);
});

test("one unreadable document does not stop the others", async () => {
  const { personas } = fixture();
  const installPath = installPlugin("partial", "0.1.1", {
    "reviewer.md": ROLE,
    // Empty: refused by the reader as having no content to review with.
    "hollow.md": "   \n\n",
    "tester.md": ROLE.replace("role-title: Reviewer", "role-title: Tester"),
  });

  const result = await personas.syncFromPluginCatalogs(1_000, enumerator(installPath, "0.1.1"));

  assert.deepEqual(result.imported.map((one) => one.name).sort(), ["Reviewer", "Tester"]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]?.sourceKey ?? "", /hollow\.md$/);
});

test("a machine with no installed catalogs imports nothing and reports nothing", async () => {
  const { personas } = fixture();
  const before = personas.list().length;

  const result = await personas.syncFromPluginCatalogs(
    1_000,
    async () => await enumeratePluginPersonaDocuments([], PLUGIN_PERSONA_SOURCES),
  );

  // The silent case, and the one every machine outside Upstart is in.
  assert.deepEqual(result, { imported: [], skipped: [], truncated: [] });
  assert.equal(personas.list().length, before);
});
