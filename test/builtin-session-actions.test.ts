import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PULL_REQUEST_SKILL } from "../src/shared/skills.ts";
import {
  normalizeSessionActionName,
  sessionActionDescriptionFromMarkdown,
  sessionActionNameFromMarkdown,
} from "../src/shared/workflow.ts";

// What is at stake: a built-in SessionAction is app data, so "every build serves exactly the
// document it was made from" has to be true rather than aspirational. The prompt is delivered
// verbatim into an operator's session, so a generated module that had drifted from its source
// would type a version of the instruction nobody wrote - and no test elsewhere would notice.

const home = mkdtempSync(join(tmpdir(), "mission-builtin-session-actions-"));
process.env.HARNESS_HOME = join(home, "state");

const root = resolve(import.meta.dirname, "..");
const docsDir = join(root, "docs", "session-actions");
const generatedPath = join(
  root, "src", "server", "workflows", "builtin-session-actions.generated.ts",
);

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const {
  BUILTIN_SESSION_ACTIONS,
  PULL_REQUEST_SESSION_ACTION_ID,
  builtinSessionActionId,
} = await import("../src/server/workflows/builtin-session-actions.ts");
const { BUILTIN_SESSION_ACTION_SOURCES } =
  await import("../src/server/workflows/builtin-session-actions.generated.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

test("the committed module is exactly what regenerating produces", async () => {
  // The GENERATOR is imported rather than re-implemented. A drift check that rendered the
  // module its own way would agree with itself and not with `npm run session-actions`.
  const { builtinSessionActionSources, renderBuiltinSessionActionModule } =
    await import("../scripts/builtin-session-actions.ts");
  assert.equal(
    readFileSync(generatedPath, "utf8"),
    renderBuiltinSessionActionModule(builtinSessionActionSources(docsDir)),
    "run `npm run session-actions` and commit the result",
  );

  const documents = readdirSync(docsDir).filter((entry) => entry.endsWith(".md"));
  assert.ok(documents.length > 0);
  assert.equal(BUILTIN_SESSION_ACTION_SOURCES.length, documents.length);
  for (const source of BUILTIN_SESSION_ACTION_SOURCES) {
    assert.equal(
      source.promptMarkdown,
      readFileSync(join(docsDir, `${source.slug}.md`), "utf8"),
      `${source.slug} is not byte-identical to its document`,
    );
  }
});

test("each shipped action derives its identity from the document it was made from", () => {
  assert.equal(BUILTIN_SESSION_ACTIONS.length, BUILTIN_SESSION_ACTION_SOURCES.length);
  for (const source of BUILTIN_SESSION_ACTION_SOURCES) {
    const action = BUILTIN_SESSION_ACTIONS.find(
      (candidate) => candidate.id === builtinSessionActionId(source.slug),
    );
    assert.ok(action, `${source.slug} is missing from the catalog`);
    assert.equal(action.promptMarkdown, source.promptMarkdown);
    assert.equal(action.name, sessionActionNameFromMarkdown(source.promptMarkdown, source.slug));
    assert.equal(action.normalizedName, normalizeSessionActionName(action.name));
    assert.equal(action.description, sessionActionDescriptionFromMarkdown(source.promptMarkdown));
    assert.equal(action.builtin, true);
    assert.equal(action.archivedAt, null);
    // One revision, because a build has exactly one copy of each document. Zero timestamps
    // because it was not created on this machine and has no edit history to report.
    assert.equal(action.revision, 1);
    assert.equal(action.createdAt, 0);
    assert.equal(action.updatedAt, 0);
  }
});

test("Pull Request ships with the skill and the proof Phase 4 will enforce", () => {
  const action = BUILTIN_SESSION_ACTIONS.find(
    (candidate) => candidate.id === PULL_REQUEST_SESSION_ACTION_ID,
  );
  assert.ok(action, "the shipped Pull Request action must exist");
  // The id is APPEND-ONLY: it reaches a draft's `sessionActionId` and a version's
  // `sourceSessionActionId`, so renaming the file slug repoints an id already in use.
  assert.equal(action.id, "builtin:pull-request");
  assert.equal(action.name, "Pull Request");
  // These two are CONTRACTS the daemon enforces, not prose, which is why they live in a
  // table keyed by slug rather than in the document's frontmatter.
  assert.equal(action.requiredSkillId, PULL_REQUEST_SKILL);
  assert.deepEqual(action.completion, { kind: "pull_request" });
  assert.match(action.description, /pull request/i);
});

test("a shipped action never becomes a row, on a database that has opened", () => {
  clearWorkflowTables(db);
  const store = new WorkflowStore(db);
  assert.ok(store.listSessionActions().some((a) => a.id === PULL_REQUEST_SESSION_ACTION_ID));
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM session_actions`).get() as { n: number }).n,
    0,
    "a built-in must not be seeded into SQLite",
  );
  // Addressable through the catalog and by id, which is what a draft naming it depends on.
  assert.equal(store.getSessionAction(PULL_REQUEST_SESSION_ACTION_ID)?.builtin, true);
  assert.ok(store.sessionActionCatalog().some((a) => a.id === PULL_REQUEST_SESSION_ACTION_ID));
});
